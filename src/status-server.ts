import { execSync } from 'child_process';
import { createServer, Server } from 'http';

import { getMcpServerUrls } from './mcp-containers.js';
import { logger } from './logger.js';

interface AgentEntry {
  groupJid: string;
  groupFolder: string | null;
  containerName: string | null;
  state: 'active' | 'idle' | 'waiting';
  isTask: boolean;
  taskId: string | null;
}

interface QueueStatus {
  agents: AgentEntry[];
  activeCount: number;
  maxConcurrent: number;
}

interface PoolStatus {
  size: number;
  assignments: number;
}

function getMcpStatus(): Array<{ name: string; url: string; running: boolean }> {
  const servers = getMcpServerUrls();

  let runningNames: string[] = [];
  try {
    const out = execSync(
      "docker ps --filter name=nanoclaw-mcp --format '{{.Names}}'",
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' },
    );
    runningNames = out.trim().split('\n').filter(Boolean);
  } catch {
    // docker not available or no containers — treat all as unknown
  }

  return servers.map((s) => ({
    name: s.name,
    url: s.url,
    running: runningNames.length > 0
      ? runningNames.some((n) => n.includes(s.name))
      : true, // if docker ps failed, assume running (containers started at boot)
  }));
}

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NanoClaw Status</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0f1117; color: #e2e8f0; padding: 24px; }
    h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 6px; color: #fff; }
    h2 { font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em;
         color: #475569; margin: 28px 0 12px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
    .card { background: #161b27; border: 1px solid #1e2535; border-radius: 8px; padding: 14px; }
    .badge { display: inline-block; font-size: 0.65rem; font-weight: 700; border-radius: 4px;
             padding: 2px 7px; text-transform: uppercase; letter-spacing: 0.05em; }
    .badge-active  { background: #0d2b1a; color: #34d399; }
    .badge-idle    { background: #2b2100; color: #fbbf24; }
    .badge-waiting { background: #1a1535; color: #818cf8; }
    .badge-up      { background: #0d2b1a; color: #34d399; }
    .badge-down    { background: #2b0d0d; color: #f87171; }
    .row { display: flex; justify-content: space-between; align-items: center;
           padding: 7px 0; border-bottom: 1px solid #1e2535; }
    .row:last-child { border-bottom: none; }
    .lbl  { font-size: 0.8rem; color: #64748b; }
    .val  { font-size: 0.8rem; font-weight: 500; }
    .mono { font-family: ui-monospace, monospace; font-size: 0.75rem; color: #64748b; }
    .stats { display: flex; gap: 20px; margin-bottom: 4px; }
    .stat { text-align: center; }
    .stat-num { font-size: 1.75rem; font-weight: 700; color: #fff; line-height: 1; }
    .stat-lbl { font-size: 0.7rem; color: #475569; margin-top: 3px; }
    .empty { color: #334155; font-size: 0.85rem; padding: 10px 0; }
    #ts { font-size: 0.7rem; color: #334155; margin-bottom: 28px; margin-top: 2px; }
  </style>
</head>
<body>
  <h1>NanoClaw</h1>
  <div id="ts">Loading...</div>

  <h2>Agents</h2>
  <div id="stats" class="stats"></div>
  <div style="margin-top:12px;" id="agents" class="grid"></div>

  <h2>Telegram Swarm</h2>
  <div id="swarm"></div>

  <h2>MCP Servers</h2>
  <div id="mcp" class="grid"></div>

  <script>
    function esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function stat(n, label) {
      return '<div class="stat"><div class="stat-num">' + n + '</div>' +
             '<div class="stat-lbl">' + esc(label) + '</div></div>';
    }

    async function refresh() {
      try {
        const d = await fetch('/api/status').then(r => r.json());

        document.getElementById('ts').textContent =
          'Last updated ' + new Date().toLocaleTimeString();

        const waiting = d.agents.filter(a => a.state === 'waiting').length;
        document.getElementById('stats').innerHTML =
          stat(d.activeCount, 'Active') +
          stat(waiting, 'Waiting') +
          stat(d.maxConcurrent, 'Limit');

        const agentEl = document.getElementById('agents');
        if (!d.agents.length) {
          agentEl.innerHTML = '<p class="empty">No active agents</p>';
        } else {
          agentEl.innerHTML = d.agents.map(a => \`
            <div class="card">
              <div class="row">
                <span class="lbl">Group</span>
                <span class="val">\${esc(a.groupFolder || a.groupJid)}</span>
              </div>
              <div class="row">
                <span class="lbl">Container</span>
                <span class="mono">\${esc(a.containerName || '—')}</span>
              </div>
              <div class="row">
                <span class="lbl">State</span>
                <span class="badge badge-\${esc(a.state)}">\${esc(a.state)}\${a.isTask ? ' · task' : ''}</span>
              </div>
              \${a.taskId ? '<div class="row"><span class="lbl">Task ID</span><span class="mono">' + esc(a.taskId) + '</span></div>' : ''}
            </div>\`).join('');
        }

        const swarmEl = document.getElementById('swarm');
        if (d.swarm.size === 0) {
          swarmEl.innerHTML = '<p class="empty">No bot pool configured</p>';
        } else {
          swarmEl.innerHTML = \`<div class="card" style="max-width:280px;">
            <div class="row"><span class="lbl">Pool bots</span><span class="val">\${d.swarm.size}</span></div>
            <div class="row"><span class="lbl">Active assignments</span><span class="val">\${d.swarm.assignments}</span></div>
          </div>\`;
        }

        const mcpEl = document.getElementById('mcp');
        if (!d.mcpServers.length) {
          mcpEl.innerHTML = '<p class="empty">No MCP servers configured</p>';
        } else {
          mcpEl.innerHTML = d.mcpServers.map(s => \`
            <div class="card">
              <div class="row">
                <span class="val">\${esc(s.name)}</span>
                <span class="badge \${s.running ? 'badge-up' : 'badge-down'}">\${s.running ? 'up' : 'down'}</span>
              </div>
              <div class="row"><span class="mono">\${esc(s.url)}</span></div>
            </div>\`).join('');
        }
      } catch {
        document.getElementById('ts').textContent = 'Connection error — retrying...';
      }
    }

    refresh();
    setInterval(refresh, 3000);
  </script>
</body>
</html>`;

export function startStatusServer(
  port: number,
  getQueueStatus: () => QueueStatus,
  getPoolStatus: () => PoolStatus,
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/status') {
        const q = getQueueStatus();
        const p = getPoolStatus();
        const body = JSON.stringify({
          agents: q.agents,
          activeCount: q.activeCount,
          maxConcurrent: q.maxConcurrent,
          swarm: p,
          mcpServers: getMcpStatus(),
        });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
        });
        res.end(body);
        return;
      }

      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(HTML_PAGE);
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    server.listen(port, '127.0.0.1', () => {
      logger.info({ port }, 'Status server started at http://127.0.0.1:' + port);
      resolve(server);
    });
    server.on('error', reject);
  });
}
