/**
 * MCP Container Lifecycle Manager
 * Starts and stops sandboxed MCP server containers (brave, caldav, and any
 * user-defined npx/uvx/remote servers from config.json).
 * Secrets stay inside these containers and are never passed to the agent container.
 */

import { execFileSync, execSync } from 'child_process';
import os from 'os';

import { loadAppConfig } from './app-config.js';
import { CONTAINER_RUNTIME_BIN, hostGatewayArgs } from './container-runtime.js';
import { logger } from './logger.js';

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

  const images = [
    agentImage,
    ...buildContainerSpecs().map((s) => s.image),
  ];
  const seen = new Set<string>();
  for (const image of images) {
    if (seen.has(image)) continue;
    seen.add(image);
    logger.info({ image }, 'Pulling image');
    try {
      execFileSync(CONTAINER_RUNTIME_BIN, ['pull', image], { stdio: 'inherit' });
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
  const { brave, caldav, mcp } = loadAppConfig();
  const specs: McpContainerSpec[] = [];

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
    } else if (srv.type === 'remote') {
      const env: Record<string, string> = {
        MCP_REMOTE_URL: srv.url,
        MCP_PORT: String(srv.port),
      };
      // Inject headers as MCP_HEADER_<Name> env vars
      for (const [header, value] of Object.entries(srv.headers ?? {})) {
        const envKey = `MCP_HEADER_${header.replace(/-/g, '_')}`;
        env[envKey] = value;
      }
      specs.push({
        name: containerName,
        image: resolveImage('nanoclaw-mcp-remote'),
        port: srv.port,
        env,
        mounts: srv.mounts,
        cpus: srv.cpus,
        memory: srv.memory,
      });
    }
  }

  return specs;
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
    '--cpus', String(spec.cpus ?? 1),
    '--memory', spec.memory ?? '512m',
  ];

  const args = [
    'run',
    '-d',
    '--name',
    spec.name,
    '--restart',
    'unless-stopped',
    '-p',
    `${spec.port}:${spec.port}`,
    ...hostGatewayArgs(),
    ...resourceArgs,
    ...envArgs,
    ...volumeArgs,
    spec.image,
  ];

  // Use execFileSync (not execSync) so env values with spaces aren't shell-split
  execFileSync(CONTAINER_RUNTIME_BIN, args, { stdio: 'pipe' });
}

async function waitReady(port: number, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'initialize',
          id: 1,
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'probe', version: '0' },
          },
        }),
        signal: AbortSignal.timeout(1000),
      });
      if (res.status < 500) return; // Any non-5xx means server is up
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `MCP server on port ${port} did not become ready within ${timeoutMs}ms`,
  );
}

export async function startMcpContainers(): Promise<void> {
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
      await waitReady(spec.port, spec.readyTimeout);
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
  const { brave, caldav, mcp } = loadAppConfig();
  const GATEWAY = 'host.docker.internal';
  const servers: Array<{ name: string; url: string; mounts?: McpMount[] }> = [];

  if (brave.enabled && brave.token) {
    servers.push({ name: 'brave', url: `http://${GATEWAY}:7701/mcp` });
  }
  if (caldav.enabled && caldav.url) {
    servers.push({ name: 'caldav', url: `http://${GATEWAY}:7702/mcp` });
  }
  for (const srv of mcp?.servers ?? []) {
    const mounts = parseMounts(srv.mounts);
    servers.push({
      name: srv.name,
      url: `http://${GATEWAY}:${srv.port}/mcp`,
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
