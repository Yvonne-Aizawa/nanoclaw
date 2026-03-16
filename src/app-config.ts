import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

interface AiEndpointConfig {
  endpoint?: string;
  key: string;
  model?: string;
}

/** An npx or uvx stdio MCP server wrapped in a container. */
export interface McpStdioServerConfig {
  type: 'npx' | 'uvx';
  /** npm or Python package name to run */
  package: string;
  /** Host port the container listens on — must be unique across all MCP servers */
  port: number;
  /** Extra env vars forwarded to the subprocess (secrets stay in the container) */
  env?: Record<string, string>;
  /**
   * Extra CLI arguments passed to the subprocess after the package name.
   * Example: ["/docs", "/media"] for @modelcontextprotocol/server-filesystem
   */
  args?: string[];
  /**
   * Host paths to mount into the MCP container.
   * Format: "hostPath:containerPath" or "hostPath:containerPath:ro"
   * hostPath supports ~ expansion (resolved on the host).
   */
  mounts?: string[];
  /** CPU limit (fractional cores). Example: 0.5. Defaults to 1. */
  cpus?: number;
  /** Memory limit. Example: "256m", "1g". Defaults to "512m". */
  memory?: string;
}

/** A remote MCP server proxied through a container that injects auth headers. */
export interface McpRemoteServerConfig {
  type: 'remote';
  /** Full URL of the upstream MCP server */
  url: string;
  /** Host port the proxy container listens on — must be unique */
  port: number;
  /**
   * HTTP headers injected into every upstream request.
   * These stay inside the proxy container — the agent never sees them.
   * Example: { "Authorization": "Bearer sk-..." }
   */
  headers?: Record<string, string>;
  /**
   * Host paths to mount into the MCP container.
   * Format: "hostPath:containerPath" or "hostPath:containerPath:ro"
   * hostPath supports ~ expansion (resolved on the host).
   */
  mounts?: string[];
  /** CPU limit (fractional cores). Example: 0.5. Defaults to 1. */
  cpus?: number;
  /** Memory limit. Example: "256m", "1g". Defaults to "512m". */
  memory?: string;
}

export type McpServerConfig = McpStdioServerConfig | McpRemoteServerConfig;

export interface AppConfig {
  ai: {
    type: 'api' | 'oauth' | 'token';
    api: AiEndpointConfig;
    oauth: AiEndpointConfig;
    token: AiEndpointConfig;
  };
  telegram: {
    main_bot_token: string;
    bot_swarm_tokens: string[];
  };
  brave: {
    enabled: boolean;
    token: string;
  };
  caldav: {
    enabled: boolean;
    url: string;
    username: string;
    password: string;
  };
  /** Additional MCP servers to sandbox in containers. */
  mcp?: {
    servers?: Array<{ name: string } & McpServerConfig>;
    /**
     * Single host port for the MCP router. All MCP servers are reachable at
     * host.docker.internal:<routerPort>/<name>/mcp. Defaults to 7700.
     */
    routerPort?: number;
  };
  /**
   * Browser automation via @playwright/mcp in a dedicated container.
   * When enabled, the agent can control a browser via MCP tools.
   */
  browser?: {
    enabled: boolean;
    /** Host port for the Playwright MCP container. Defaults to 7703. */
    port?: number;
    /** Memory limit. Defaults to "1g" (browsers are memory-hungry). */
    memory?: string;
  };
  /**
   * Vision (image) support. Enabled by default.
   * Set enabled: false when using a model that does not support vision.
   */
  vision?: {
    enabled: boolean;
  };
  /**
   * Container image settings.
   * Set registry to pull images from a remote registry on startup instead of using locally built images.
   * Example: "ghcr.io/yourname"
   */
  containers?: {
    registry?: string;
  };
  /**
   * Remote control via /remote-control command from the main chat.
   * Starts a host-level Claude Code session accessible via browser URL.
   * Disabled by default.
   */
  remoteControl?: {
    enabled: boolean;
  };
  /**
   * Status web UI. Disabled by default.
   * Set enabled: true and optionally port (default 3000) in config.json.
   */
  web?: {
    enabled: boolean;
    /** HTTP port for the status UI. Defaults to 3000. */
    port?: number;
  };
  /**
   * Agent run limits. Controls how long a container agent is allowed to run.
   */
  agent?: {
    /**
     * Maximum time in milliseconds an agent container may run before being killed.
     * Defaults to 600000 (10 minutes).
     */
    timeoutMs?: number;
  };
}

let _config: AppConfig | null = null;

export function loadAppConfig(): AppConfig {
  if (_config) return _config;

  const configPath = path.join(process.cwd(), 'config.json');
  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    _config = JSON.parse(content) as AppConfig;
    logger.debug({ type: _config.ai.type }, 'Loaded config.json');
    return _config;
  } catch {
    logger.debug('config.json not found, using empty defaults');
    _config = {
      ai: {
        type: 'oauth',
        api: { key: '' },
        oauth: { key: '' },
        token: { key: '' },
      },
      telegram: { main_bot_token: '', bot_swarm_tokens: [] },
      brave: { enabled: false, token: '' },
      caldav: { enabled: false, url: '', username: '', password: '' },
    };
    return _config;
  }
}

/** Returns the active AI endpoint settings based on the selected type. */
export function getActiveAiConfig(): {
  type: AppConfig['ai']['type'];
  endpoint: string;
  key: string;
  model: string;
} {
  const config = loadAppConfig();
  const type = config.ai.type;
  const active = config.ai[type];
  return {
    type,
    endpoint: active.endpoint || '',
    key: active.key || '',
    model: active.model || '',
  };
}
