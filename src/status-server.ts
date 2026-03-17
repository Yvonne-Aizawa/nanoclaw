import { execSync } from 'child_process';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { fileURLToPath } from 'url';
import path from 'path';

import ejs from 'ejs';

import {
  addKanbanCard,
  createKanbanColumn,
  deleteKanbanCard,
  deleteKanbanColumn,
  getAllRegisteredGroups,
  getKanbanBoard,
  moveKanbanCard,
  renameKanbanColumn,
  updateKanbanCard,
} from './db.js';
import {
  getMcpServerUrls,
  isContainerBackedMcpServer,
} from './mcp-containers.js';
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

function getMcpStatus(): Array<{
  name: string;
  url: string;
  running: boolean;
}> {
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
    // Only container-backed servers need a docker ps health check
    running: isContainerBackedMcpServer(s.name)
      ? runningNames.length > 0
        ? runningNames.some((n) => n.includes(s.name))
        : true // docker ps failed — assume running
      : true, // in-process or remote proxy — no container to check
  }));
}

const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function jsonOk(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

function jsonErr(res: ServerResponse, status: number, msg: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: msg }));
}

/** Match /api/kanban/<group>[/<rest>] */
const KANBAN_RE = /^\/api\/kanban(?:\/([^/]+)(?:\/(.+))?)?$/;

async function handleKanban(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method?.toUpperCase() ?? 'GET';
  const url = req.url ?? '';
  const m = url.match(KANBAN_RE);
  if (!m) {
    jsonErr(res, 404, 'Not found');
    return;
  }

  const group = m[1] ? decodeURIComponent(m[1]) : undefined;
  const rest = m[2] ?? '';

  // GET /api/kanban/groups
  if (!group) {
    if (method !== 'GET') {
      jsonErr(res, 405, 'Method Not Allowed');
      return;
    }
    const groups = getAllRegisteredGroups();
    const list = Object.values(groups).map((g) => ({
      folder: g.folder,
      name: g.name,
    }));
    jsonOk(res, list);
    return;
  }

  // GET /api/kanban/:group  → full board
  if (!rest) {
    if (method !== 'GET') {
      jsonErr(res, 405, 'Method Not Allowed');
      return;
    }
    jsonOk(res, getKanbanBoard(group));
    return;
  }

  // /api/kanban/:group/columns[/:colId]
  const colMatch = rest.match(/^columns(?:\/([^/]+))?$/);
  if (colMatch) {
    const colId = colMatch[1] ? decodeURIComponent(colMatch[1]) : undefined;
    const body =
      method !== 'GET' && method !== 'DELETE'
        ? ((await readBody(req)) as Record<string, string>)
        : {};

    if (!colId) {
      // POST /columns
      if (method !== 'POST') {
        jsonErr(res, 405, 'Method Not Allowed');
        return;
      }
      const col = createKanbanColumn(group, String(body.name ?? ''));
      jsonOk(res, col, 201);
    } else if (method === 'PATCH') {
      renameKanbanColumn(colId, group, String(body.name ?? ''));
      jsonOk(res, { ok: true });
    } else if (method === 'DELETE') {
      deleteKanbanColumn(colId, group);
      res.writeHead(204);
      res.end();
    } else {
      jsonErr(res, 405, 'Method Not Allowed');
    }
    return;
  }

  // /api/kanban/:group/cards[/:cardId[/move]]
  const cardMatch = rest.match(/^cards(?:\/([^/]+)(?:\/(move))?)?$/);
  if (cardMatch) {
    const cardId = cardMatch[1] ? decodeURIComponent(cardMatch[1]) : undefined;
    const action = cardMatch[2];
    const body =
      method !== 'GET' && method !== 'DELETE'
        ? ((await readBody(req)) as Record<string, unknown>)
        : {};

    if (!cardId) {
      // POST /cards
      if (method !== 'POST') {
        jsonErr(res, 405, 'Method Not Allowed');
        return;
      }
      const pri = ['high', 'medium', 'low'].includes(
        String(body.priority ?? ''),
      )
        ? (body.priority as 'high' | 'medium' | 'low')
        : undefined;
      const card = addKanbanCard(
        group,
        String(body.column_id ?? ''),
        String(body.title ?? ''),
        body.description != null ? String(body.description) : undefined,
        pri,
      );
      jsonOk(res, card, 201);
    } else if (action === 'move') {
      // POST /cards/:id/move
      if (method !== 'POST') {
        jsonErr(res, 405, 'Method Not Allowed');
        return;
      }
      const position =
        body.position != null ? Number(body.position) : undefined;
      moveKanbanCard(cardId, group, String(body.column_id ?? ''), position);
      jsonOk(res, { ok: true });
    } else if (method === 'PATCH') {
      const patchPri =
        body.priority === null
          ? null
          : ['high', 'medium', 'low'].includes(String(body.priority ?? ''))
            ? (body.priority as 'high' | 'medium' | 'low')
            : undefined;
      updateKanbanCard(
        cardId,
        group,
        body.title != null ? String(body.title) : undefined,
        body.description != null ? String(body.description) : undefined,
        patchPri,
      );
      jsonOk(res, { ok: true });
    } else if (method === 'DELETE') {
      deleteKanbanCard(cardId, group);
      res.writeHead(204);
      res.end();
    } else {
      jsonErr(res, 405, 'Method Not Allowed');
    }
    return;
  }

  jsonErr(res, 404, 'Not found');
}

export function startStatusServer(
  port: number,
  getQueueStatus: () => QueueStatus,
  getPoolStatus: () => PoolStatus,
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      handleRequest(req, res).catch((err) => {
        logger.error({ err }, 'Status server error');
        if (!res.headersSent) { res.writeHead(500); res.end('Internal Server Error'); }
      });
    });

    async function handleRequest(req: IncomingMessage, res: ServerResponse) {
      const url = req.url ?? '';

      if (url.startsWith('/api/kanban')) {
        handleKanban(req, res).catch((err) => {
          logger.error({ err }, 'Kanban API error');
          if (!res.headersSent) jsonErr(res, 500, String(err));
        });
        return;
      }

      if (req.method === 'GET' && url === '/api/status') {
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

      if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
        const html = await ejs.renderFile(path.join(webDir, 'status.ejs'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (req.method === 'GET' && (url === '/kanban' || url === '/kanban/')) {
        const html = await ejs.renderFile(path.join(webDir, 'kanban.ejs'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    }

    server.listen(port, '127.0.0.1', () => {
      logger.info(
        { port },
        'Status server started at http://127.0.0.1:' + port,
      );
      resolve(server);
    });
    server.on('error', reject);
  });
}
