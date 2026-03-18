/**
 * MCP Container Lifecycle Manager
 * Starts and stops sandboxed MCP server containers (brave, caldav, and any
 * user-defined npx/uvx/remote servers from config.json).
 * Secrets stay inside these containers and are never passed to the agent container.
 */

import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import os from 'os';
import path from 'path';

import { loadAppConfig } from './app-config.js';
import { DATA_DIR } from './config.js';
import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import { logger } from './logger.js';
import { createBraveHandler, InProcessMcpHandler } from './mcp-brave.js';
import { createCalDavHandler } from './mcp-caldav.js';
import { createKanbanHandler } from './mcp-kanban.js';
import { createObcHandler, hasObcToken } from './mcp-obc.js';
import { createUtilsHandler } from './mcp-utils.js';

/** Single host-side MCP router server (routes /<name>/mcp to each backend). */
let mcpRouterServer: import('http').Server | null = null;

/** In-process MCP handlers (brave, caldav) — served directly without a proxy hop. */
const inProcessHandlers = new Map<string, InProcessMcpHandler>();

/** Returns true if the named MCP server runs in-process (no container to check). */
export function isInProcessMcpServer(name: string): boolean {
  return inProcessHandlers.has(name) || name.startsWith('kanban-');
}

/**
 * Returns true if the named MCP server is backed by a Docker container.
 * In-process servers (brave, caldav) and remote proxies are not container-backed.
 */
export function isContainerBackedMcpServer(name: string): boolean {
  if (inProcessHandlers.has(name) || name.startsWith('kanban-')) return false;
  const { mcp } = loadAppConfig();
  const srv = (mcp?.servers ?? []).find((s) => s.name === name);
  if (srv) return srv.type !== 'remote';
  // playwright is the only built-in container server
  return name === 'playwright';
}

/** Private Docker network shared by all MCP containers and agent containers. */
export const NANOCLAW_NETWORK = 'nanoclaw-net';

interface McpContainerSpec {
  name: string;
  image: string;
  port: number;
  env: Record<string, string>;
  /** Readiness timeout in ms — npx/uvx need longer for package download */
  readyTimeout?: number;
  /** Host→container volume mounts: "hostPath:containerPath" or "hostPath:containerPath:ro" */
  mounts?: string[];
  /** CPU limit (fractional cores). Passed as --cpus to docker run. */
  cpus?: number;
  /** Memory limit, e.g. "256m" or "1g". Passed as --memory to docker run. */
  memory?: string;
}

/**
 * Prepends the configured registry to an image name.
 * "nanoclaw-mcp-brave" → "ghcr.io/yourname/nanoclaw-mcp-brave" (if registry set)
 */
function resolveImage(localName: string): string {
  const registry = loadAppConfig().containers?.registry;
  return registry ? `${registry}/${localName}` : localName;
}

/**
 * Pull all images used by active MCP containers plus the agent image.
 * No-op if no registry is configured.
 */
export function pullImages(agentImage: string): void {
  const registry = loadAppConfig().containers?.registry;
  if (!registry) return;

  const images = [agentImage, ...buildContainerSpecs().map((s) => s.image)];
  const seen = new Set<string>();
  for (const image of images) {
    if (seen.has(image)) continue;
    seen.add(image);
    logger.info({ image }, 'Pulling image');
    try {
      execFileSync(CONTAINER_RUNTIME_BIN, ['pull', image], {
        stdio: 'inherit',
      });
    } catch (err) {
      logger.error({ err, image }, 'Failed to pull image');
    }
  }
}

/** Expand a leading ~/ to the user's home directory. */
function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return os.homedir() + p.slice(1);
  }
  return p;
}

/**
 * Expand ~ in a mount string (only in the host path segment, before the first colon).
 * e.g. "~/media:/media:ro" → "/home/user/media:/media:ro"
 */
function expandMountHome(mount: string): string {
  const colonIdx = mount.indexOf(':');
  if (colonIdx === -1) return expandHome(mount);
  const hostPart = expandHome(mount.slice(0, colonIdx));
  return hostPart + mount.slice(colonIdx);
}

function buildContainerSpecs(): McpContainerSpec[] {
  const { tools, mcp } = loadAppConfig();
  const { browser } = tools ?? {};
  const specs: McpContainerSpec[] = [];

  if (browser?.enabled) {
    const port = browser.port ?? 7703;
    const sharedDir = path.join(DATA_DIR, 'playwright-shared');
    fs.mkdirSync(sharedDir, { recursive: true });
    specs.push({
      name: 'nanoclaw-mcp-playwright',
      image: resolveImage('nanoclaw-mcp-playwright'),
      port,
      env: { MCP_PORT: String(port) },
      readyTimeout: 30000,
      memory: browser.memory ?? '1g',
      mounts: [`${sharedDir}:/shared`],
    });
  }

  // User-defined MCP servers from config.json mcp.servers
  for (const srv of mcp?.servers ?? []) {
    const containerName = `nanoclaw-mcp-${srv.name}`;

    if (srv.type === 'npx' || srv.type === 'uvx') {
      specs.push({
        name: containerName,
        image: resolveImage(`nanoclaw-mcp-${srv.type}`),
        port: srv.port,
        env: {
          MCP_PACKAGE: srv.package,
          MCP_PORT: String(srv.port),
          ...(srv.args && srv.args.length > 0
            ? { MCP_ARGS: JSON.stringify(srv.args) }
            : {}),
          ...(srv.env ?? {}),
        },
        readyTimeout: 30000, // npx/uvx may need to download packages
        mounts: srv.mounts,
        cpus: srv.cpus,
        memory: srv.memory,
      });
    }
    // type: 'remote' — handled by startRemoteMcpProxies() on the host, not a container
  }

  return specs;
}

/** Create the private Docker network if it doesn't already exist. */
function ensureNetwork(): void {
  try {
    execFileSync(
      CONTAINER_RUNTIME_BIN,
      ['network', 'inspect', NANOCLAW_NETWORK],
      { stdio: 'pipe' },
    );
  } catch {
    execFileSync(
      CONTAINER_RUNTIME_BIN,
      ['network', 'create', NANOCLAW_NETWORK],
      { stdio: 'pipe' },
    );
    logger.info({ network: NANOCLAW_NETWORK }, 'Created Docker network');
  }
}

function stopAndRemove(name: string): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} rm -f ${name}`, { stdio: 'pipe' });
  } catch {
    // Container wasn't running — fine
  }
}

function startContainer(spec: McpContainerSpec): void {
  const envArgs = Object.entries(spec.env).flatMap(([k, v]) => [
    '-e',
    `${k}=${v}`,
  ]);

  const volumeArgs = (spec.mounts ?? []).flatMap((m) => [
    '-v',
    expandMountHome(m),
  ]);

  const resourceArgs = [
    '--cpus',
    String(spec.cpus ?? 1),
    '--memory',
    spec.memory ?? '512m',
  ];

  const args = [
    'run',
    '-d',
    '--name',
    spec.name,
    '--restart',
    'unless-stopped',
    '--network',
    NANOCLAW_NETWORK,
    // Publish to localhost so the host-side MCP router can reach the container
    '-p',
    `127.0.0.1:${spec.port}:${spec.port}`,
    ...hostGatewayArgs(),
    ...resourceArgs,
    ...envArgs,
    ...volumeArgs,
    spec.image,
  ];

  // Use execFileSync (not execSync) so env values with spaces aren't shell-split
  execFileSync(CONTAINER_RUNTIME_BIN, args, { stdio: 'pipe' });
}

async function waitReady(
  containerName: string,
  port: number,
  timeoutMs = 10000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // Probe the server from inside the container using Node's built-in fetch.
  const nodeScript = [
    `fetch('http://localhost:${port}/mcp',{`,
    `method:'POST',`,
    `headers:{'Content-Type':'application/json','Accept':'application/json, text/event-stream'},`,
    `body:JSON.stringify({jsonrpc:'2.0',method:'initialize',id:1,params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'probe',version:'0'}}})`,
    `}).then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))`,
  ].join('');

  while (Date.now() < deadline) {
    try {
      execFileSync(
        CONTAINER_RUNTIME_BIN,
        ['exec', containerName, 'node', '-e', nodeScript],
        { stdio: 'pipe' },
      );
      return; // exit code 0 → server is up
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `MCP server ${containerName} did not become ready within ${timeoutMs}ms`,
  );
}

interface McpRoute {
  url: string;
  headers?: Record<string, string>;
}

const PASSTHROUGH_HEADERS = ['content-type', 'accept', 'mcp-session-id'];

async function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  route: McpRoute,
): Promise<void> {
  const injectedHeaders = route.headers ?? {};
  const injectedNames = new Set(
    Object.keys(injectedHeaders).map((h) => h.toLowerCase()),
  );

  const headers: Record<string, string> = { ...injectedHeaders };
  for (const h of PASSTHROUGH_HEADERS) {
    const val = req.headers[h];
    if (val && !injectedNames.has(h)) {
      headers[h] = Array.isArray(val) ? val.join(', ') : val;
    }
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

  try {
    const init: RequestInit = { method: req.method, headers };
    if (body && body.length > 0) init.body = body;
    const upstream = await fetch(route.url, init);

    for (const h of ['content-type', 'mcp-session-id']) {
      const val = upstream.headers.get(h);
      if (val) res.setHeader(h, val);
    }

    const contentType = upstream.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      res.setHeader('Cache-Control', 'no-cache');
      const reader = upstream.body?.getReader();
      if (reader) {
        const dec = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(dec.decode(value, { stream: true }));
        }
      }
      res.end();
    } else {
      res.writeHead(upstream.status);
      res.end(await upstream.text());
    }
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32603, message: `Proxy error: ${String(err)}` },
        id: null,
      }),
    );
  }
}

function buildRouteMap(): Map<string, McpRoute> {
  const { tools, mcp } = loadAppConfig();
  const { browser } = tools ?? {};
  const routes = new Map<string, McpRoute>();

  if (browser?.enabled) {
    routes.set('playwright', {
      url: `http://127.0.0.1:${browser.port ?? 7703}/mcp`,
    });
  }
  for (const srv of mcp?.servers ?? []) {
    if (srv.type === 'remote') {
      routes.set(srv.name, { url: srv.url, headers: srv.headers });
    } else {
      routes.set(srv.name, { url: `http://127.0.0.1:${srv.port}/mcp` });
    }
  }

  return routes;
}

export function startMcpRouter(): void {
  const { mcp } = loadAppConfig();
  const routerPort = mcp?.routerPort ?? 7700;
  const routes = buildRouteMap();

  if (routes.size === 0) return;

  // URL pattern: /<name>/mcp
  const PATH_RE = /^\/([^/]+)\/mcp$/;

  mcpRouterServer = createServer((req, res) => {
    const match = (req.url ?? '').match(PATH_RE);
    if (!match) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const name = match[1];

    // Resolve in-process handler; create kanban handlers lazily per group.
    let inProcess = inProcessHandlers.get(name);
    if (!inProcess && name.startsWith('kanban-')) {
      const group = name.slice('kanban-'.length);
      inProcess = createKanbanHandler(group);
      inProcessHandlers.set(name, inProcess);
      logger.info({ group }, 'Kanban MCP handler created for group');
    }
    if (inProcess) {
      inProcess.handleRequest(req, res).catch((err) => {
        logger.error({ err, name }, 'In-process MCP handler error');
        if (!res.headersSent) {
          res.writeHead(500);
          res.end('Internal MCP error');
        }
      });
      return;
    }

    const route = routes.get(name);
    if (!route) {
      res.writeHead(404);
      res.end(`MCP server '${name}' not configured`);
      return;
    }

    proxyRequest(req, res, route).catch((err) => {
      logger.error({ err, name }, 'MCP router proxy error');
      if (!res.headersSent) {
        res.writeHead(500);
        res.end('Internal proxy error');
      }
    });
  });

  mcpRouterServer.listen(routerPort, PROXY_BIND_HOST, () => {
    logger.info(
      { port: routerPort, servers: [...routes.keys()] },
      'MCP router started',
    );
  });
}

export function stopMcpRouter(): void {
  mcpRouterServer?.close();
  mcpRouterServer = null;
  logger.info('MCP router stopped');
}

function startInProcessMcpServers(): void {
  const { tools } = loadAppConfig();
  const { brave, caldav } = tools ?? {};
  if (brave?.enabled && brave.token) {
    inProcessHandlers.set('brave', createBraveHandler(brave.token));
    logger.info('Brave MCP server started in-process');
  }
  if (caldav?.enabled && caldav.url) {
    inProcessHandlers.set(
      'caldav',
      createCalDavHandler({
        url: caldav.url,
        username: caldav.username || '',
        password: caldav.password || '',
      }),
    );
    logger.info('CalDAV MCP server started in-process');
  }
  inProcessHandlers.set('utils', createUtilsHandler());
  logger.info('Utils MCP server started in-process');

  // OBC — created eagerly for groups that have the service enabled AND an OBC token
  const config = loadAppConfig();
  for (const [folder, groupCfg] of Object.entries(config.group ?? {})) {
    if (groupCfg.service?.enabled && hasObcToken(folder)) {
      inProcessHandlers.set(`obc-${folder}`, createObcHandler(folder));
      logger.info({ folder }, 'OBC MCP handler started in-process');
    }
  }

  // Kanban handlers are created lazily per group in the router (kanban-{folder})
}

export async function startMcpContainers(): Promise<void> {
  startInProcessMcpServers();
  ensureNetwork();
  startMcpRouter();

  const specs = buildContainerSpecs();
  if (specs.length === 0) return;

  for (const spec of specs) {
    stopAndRemove(spec.name);
    try {
      startContainer(spec);
      logger.info(
        { name: spec.name, port: spec.port },
        'MCP container started',
      );
    } catch (err) {
      logger.error({ err, name: spec.name }, 'Failed to start MCP container');
      continue;
    }

    try {
      await waitReady(spec.name, spec.port, spec.readyTimeout);
      logger.info({ name: spec.name, port: spec.port }, 'MCP container ready');
    } catch (err) {
      logger.warn(
        { err, name: spec.name },
        'MCP container did not become ready in time',
      );
    }
  }
}

export function stopMcpContainers(): void {
  stopMcpRouter();
  const specs = buildContainerSpecs();
  for (const spec of specs) {
    stopAndRemove(spec.name);
    logger.info({ name: spec.name }, 'MCP container stopped');
  }
}

/** Parsed representation of a single mount entry for the agent. */
export interface McpMount {
  containerPath: string;
  readonly: boolean;
}

/**
 * Returns the list of active MCP server URLs to pass to agent containers.
 * Each entry is { name, url, mounts? } where url points to host.docker.internal:<port>.
 * mounts describes paths accessible inside the MCP container (no host paths exposed).
 *
 * If groupFolder is provided, servers that have a `groups` restriction are only
 * included when the group is listed. Servers without a `groups` field are always
 * included (default: accessible by all agents).
 */
export function getMcpServerUrls(groupFolder?: string): Array<{
  name: string;
  url: string;
  mounts?: McpMount[];
}> {
  const config = loadAppConfig();
  const { tools, mcp } = config;
  const { brave, caldav, browser } = tools ?? {};
  const allowlist = groupFolder
    ? config.group?.[groupFolder]?.mcp?.allowlist
    : undefined;
  const routerPort = mcp?.routerPort ?? 7700;
  const base = `http://${CONTAINER_HOST_GATEWAY}:${routerPort}`;
  const servers: Array<{ name: string; url: string; mounts?: McpMount[] }> = [];

  function allowed(groups?: string[]): boolean {
    if (!groups || groups.length === 0) return true;
    return groupFolder !== undefined && groups.includes(groupFolder);
  }

  // All servers are routed through the host MCP router at /<name>/mcp
  servers.push({ name: 'utils', url: `${base}/utils/mcp` });
  // Each group gets its own kanban endpoint — the group is bound server-side, not by the agent.
  if (groupFolder) {
    servers.push({
      name: 'kanban',
      url: `${base}/kanban-${groupFolder}/mcp`,
    });
  }
  if (browser?.enabled) {
    servers.push({
      name: 'playwright',
      url: `${base}/playwright/mcp`,
      mounts: [{ containerPath: '/shared', readonly: false }],
    });
  }
  // OBC — only for groups that have service.enabled AND an OBC token
  if (groupFolder && config.group?.[groupFolder]?.service?.enabled && hasObcToken(groupFolder)) {
    servers.push({ name: 'obc', url: `${base}/obc-${groupFolder}/mcp` });
  }

  if (brave?.enabled && brave.token && allowed(brave.groups)) {
    servers.push({ name: 'brave', url: `${base}/brave/mcp` });
  }
  if (caldav?.enabled && caldav.url && allowed(caldav.groups)) {
    servers.push({ name: 'caldav', url: `${base}/caldav/mcp` });
  }
  for (const srv of mcp?.servers ?? []) {
    if (!allowed(srv.groups)) continue;
    const mounts = parseMounts(srv.mounts);
    servers.push({
      name: srv.name,
      url: `${base}/${srv.name}/mcp`,
      ...(mounts.length > 0 ? { mounts } : {}),
    });
  }

  if (allowlist) {
    return servers.filter((s) => allowlist.includes(s.name));
  }
  return servers;
}

/**
 * Parse mount strings into { containerPath, readonly } objects.
 * Format: "hostPath:containerPath" or "hostPath:containerPath:ro"
 */
function parseMounts(mounts?: string[]): McpMount[] {
  if (!mounts || mounts.length === 0) return [];
  return mounts.map((m) => {
    const parts = m.split(':');
    // parts[0] = hostPath, parts[1] = containerPath, parts[2]? = "ro"
    const containerPath = parts[1] ?? parts[0];
    const readonly = parts[2] === 'ro';
    return { containerPath, readonly };
  });
}
