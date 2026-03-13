/**
 * Generic stdio→HTTP bridge for NanoClaw MCP containers.
 *
 * Spawns an MCP server subprocess (npx or uvx) and exposes it over HTTP
 * so the agent container can connect via type:'http' without ever seeing
 * the subprocess's credentials/env vars.
 *
 * Required env:
 *   MCP_PACKAGE  — npm package or uvx package name to run
 *   MCP_COMMAND  — "npx" (default) or "uvx"
 *   MCP_PORT     — port to listen on (default 7700)
 *
 * All other env vars are forwarded to the subprocess as-is.
 */

import { randomUUID } from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import readline from 'readline';
import express from 'express';

const MCP_PACKAGE = process.env.MCP_PACKAGE;
const MCP_COMMAND = process.env.MCP_COMMAND ?? 'npx';
const PORT = parseInt(process.env.MCP_PORT ?? '7700', 10);

if (!MCP_PACKAGE) {
  console.error('MCP_PACKAGE is required');
  process.exit(1);
}

// Forward all env vars to subprocess except our own control vars
const subEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (!['MCP_PACKAGE', 'MCP_COMMAND', 'MCP_PORT'].includes(k) && v !== undefined) {
    subEnv[k] = v;
  }
}

type RpcCallback = (msg: Record<string, unknown>) => void;
const pending = new Map<string | number, RpcCallback>();
let child: ChildProcess | null = null;

function startProcess(): void {
  const args = MCP_COMMAND === 'npx' ? ['-y', MCP_PACKAGE!] : [MCP_PACKAGE!];
  child = spawn(MCP_COMMAND, args, {
    env: subEnv,
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  const rl = readline.createInterface({ input: child.stdout! });
  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line) as Record<string, unknown>;
      const id = msg.id as string | number | undefined;
      if (id !== undefined && pending.has(id)) {
        pending.get(id)!(msg);
        pending.delete(id);
      }
    } catch {
      /* ignore non-JSON lines (e.g. startup messages) */
    }
  });

  child.on('exit', (code) => {
    console.error(`Subprocess exited (code ${code ?? '?'}), restarting in 2s...`);
    child = null;
    setTimeout(startProcess, 2000);
  });

  console.log(`Spawned: ${MCP_COMMAND} ${args.join(' ')}`);
}

function rpc(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (!child?.stdin?.writable) {
      reject(new Error('Subprocess not ready'));
      return;
    }
    const id = (request.id as string | number | undefined) ?? randomUUID();
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ ...request, id }) + '\n', (err) => {
      if (err) {
        pending.delete(id);
        reject(err);
      }
    });
  });
}

startProcess();

const app = express();
app.use(express.json());

const sessions = new Set<string>();

app.post('/mcp', async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const sessionId =
    (req.headers['mcp-session-id'] as string | undefined) ?? randomUUID();

  try {
    const result = await rpc(body);

    if (body.method === 'initialize') {
      sessions.add(sessionId);
      res.setHeader('mcp-session-id', sessionId);
    }

    res.setHeader('Content-Type', 'application/json');
    res.json(result);
  } catch (err) {
    res.status(500).json({
      jsonrpc: '2.0',
      error: { code: -32603, message: String(err) },
      id: body.id ?? null,
    });
  }
});

// SSE endpoint — not needed since agent SDK uses POST for all requests
app.get('/mcp', (_req, res) => res.status(405).send());

app.delete('/mcp', (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (sessionId) sessions.delete(sessionId);
  res.status(200).send();
});

app.listen(PORT, () =>
  console.log(`MCP bridge [${MCP_COMMAND} ${MCP_PACKAGE}] listening on port ${PORT}`),
);
