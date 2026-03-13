/**
 * MCP Container Lifecycle Manager
 * Starts and stops sandboxed MCP server containers (brave, caldav).
 * Secrets stay inside these containers and are never passed to the agent container.
 */

import { execSync } from 'child_process';

import { loadAppConfig } from './app-config.js';
import {
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
} from './container-runtime.js';
import { logger } from './logger.js';

interface McpContainerSpec {
  name: string;
  image: string;
  port: number;
  env: Record<string, string>;
}

function buildContainerSpecs(): McpContainerSpec[] {
  const { brave, caldav } = loadAppConfig();
  const specs: McpContainerSpec[] = [];

  if (brave.enabled && brave.token) {
    specs.push({
      name: 'nanoclaw-mcp-brave',
      image: 'nanoclaw-mcp-brave',
      port: 7701,
      env: { BRAVE_API_KEY: brave.token },
    });
  }

  if (caldav.enabled && caldav.url) {
    specs.push({
      name: 'nanoclaw-mcp-caldav',
      image: 'nanoclaw-mcp-caldav',
      port: 7702,
      env: {
        CALDAV_URL: caldav.url,
        CALDAV_USERNAME: caldav.username || '',
        CALDAV_PASSWORD: caldav.password || '',
      },
    });
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
  const envArgs = Object.entries(spec.env)
    .flatMap(([k, v]) => ['-e', `${k}=${v}`]);

  const args = [
    'run', '-d',
    '--name', spec.name,
    '--restart', 'unless-stopped',
    '-p', `${spec.port}:${spec.port}`,
    ...hostGatewayArgs(),
    ...envArgs,
    spec.image,
  ];

  execSync(`${CONTAINER_RUNTIME_BIN} ${args.join(' ')}`, { stdio: 'pipe' });
}

async function waitReady(port: number, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '0' } } }),
        signal: AbortSignal.timeout(1000),
      });
      if (res.status < 500) return; // Any non-5xx means server is up
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`MCP server on port ${port} did not become ready within ${timeoutMs}ms`);
}

export async function startMcpContainers(): Promise<void> {
  const specs = buildContainerSpecs();
  if (specs.length === 0) return;

  for (const spec of specs) {
    stopAndRemove(spec.name);
    try {
      startContainer(spec);
      logger.info({ name: spec.name, port: spec.port }, 'MCP container started');
    } catch (err) {
      logger.error({ err, name: spec.name }, 'Failed to start MCP container');
      continue;
    }

    try {
      await waitReady(spec.port);
      logger.info({ name: spec.name, port: spec.port }, 'MCP container ready');
    } catch (err) {
      logger.warn({ err, name: spec.name }, 'MCP container did not become ready in time');
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
