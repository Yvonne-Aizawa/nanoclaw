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

/** Host-side proxy servers for remote MCP servers (type: 'remote'). */
const remoteProxyServers = new Map<string, import('http').Server>();

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
  const { brave, caldav, browser, mcp } = loadAppConfig();
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

  if (brave.enabled && brave.token) {
    specs.push({
      name: 'nanoclaw-mcp-brave',
      image: resolveImage('nanoclaw-mcp-brave'),
      port: 7701,
      env: { BRAVE_API_KEY: brave.token },
    });
  }

  if (caldav.enabled && caldav.url) {
    specs.push({
      name: 'nanoclaw-mcp-caldav',
      image: resolveImage('nanoclaw-mcp-caldav'),
      port: 7702,
      env: {
        CALDAV_URL: caldav.url,
        CALDAV_USERNAME: caldav.username || '',
        CALDAV_PASSWORD: caldav.password || '',
      },
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
  // No ports are published to the host, so we can't probe from outside.
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

const PASSTHROUGH_HEADERS = ['content-type', 'accept', 'mcp-session-id'];

async function handleRemoteProxy(
  req: IncomingMessage,
  res: ServerResponse,
  upstreamUrl: string,
  injectedHeaders: Record<string, string>,
): Promise<void> {
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

  // Collect body
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

  try {
    const init: RequestInit = { method: req.method, headers };
    if (body && body.length > 0) init.body = body;
    const upstream = await fetch(upstreamUrl, init);

    // Forward relevant response headers
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

export function startRemoteMcpProxies(): void {
  const { mcp } = loadAppConfig();
  for (const srv of mcp?.servers ?? []) {
    if (srv.type !== 'remote') continue;

    const injectedHeaders: Record<string, string> = { ...(srv.headers ?? {}) };

    const server = createServer((req, res) => {
      handleRemoteProxy(req, res, srv.url, injectedHeaders).catch((err) => {
        logger.error({ err, name: srv.name }, 'Remote MCP proxy error');
        if (!res.headersSent) {
          res.writeHead(500);
          res.end('Internal proxy error');
        }
      });
    });

    server.listen(srv.port, PROXY_BIND_HOST, () => {
      logger.info(
        { name: srv.name, port: srv.port, url: srv.url },
        'Remote MCP proxy started on host',
      );
    });

    remoteProxyServers.set(srv.name, server);
  }
}

export function stopRemoteMcpProxies(): void {
  for (const [name, server] of remoteProxyServers) {
    server.close();
    logger.info({ name }, 'Remote MCP proxy stopped');
  }
  remoteProxyServers.clear();
}

export async function startMcpContainers(): Promise<void> {
  ensureNetwork();
  startRemoteMcpProxies();

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
  stopRemoteMcpProxies();
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
 */
export function getMcpServerUrls(): Array<{
  name: string;
  url: string;
  mounts?: McpMount[];
}> {
  const { brave, caldav, browser, mcp } = loadAppConfig();
  const servers: Array<{ name: string; url: string; mounts?: McpMount[] }> = [];

  // Containers are reachable by name within the shared Docker network.
  // No host ports are published — traffic stays inside nanoclaw-net.
  if (browser?.enabled) {
    const port = browser.port ?? 7703;
    servers.push({
      name: 'playwright',
      url: `http://nanoclaw-mcp-playwright:${port}/mcp`,
      mounts: [{ containerPath: '/shared', readonly: false }],
    });
  }
  if (brave.enabled && brave.token) {
    servers.push({ name: 'brave', url: `http://nanoclaw-mcp-brave:7701/mcp` });
  }
  if (caldav.enabled && caldav.url) {
    servers.push({
      name: 'caldav',
      url: `http://nanoclaw-mcp-caldav:7702/mcp`,
    });
  }
  for (const srv of mcp?.servers ?? []) {
    const mounts = parseMounts(srv.mounts);
    // Remote servers run on the host; reach via host gateway. Others use Docker network DNS.
    const url =
      srv.type === 'remote'
        ? `http://${CONTAINER_HOST_GATEWAY}:${srv.port}/mcp`
        : `http://nanoclaw-mcp-${srv.name}:${srv.port}/mcp`;
    servers.push({
      name: srv.name,
      url,
      ...(mounts.length > 0 ? { mounts } : {}),
    });
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
