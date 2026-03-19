import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import { MountAllowlist } from './types.js';

interface AiEndpointConfig {
  endpoint?: string;
  key: string;
  /** Default model override (used when chatModel/cronModel are not set). */
  model?: string;
  /** Model for chat messages and heartbeat runs. Falls back to model. */
  chatModel?: string;
  /** Model for scheduled cron tasks. Falls back to model. */
  cronModel?: string;
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
  /**
   * Restrict this server to specific agent groups (folder names).
   * If omitted, all groups can access the server.
   */
  groups?: string[];
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
  /**
   * Restrict this server to specific agent groups (folder names).
   * If omitted, all groups can access the server.
   */
  groups?: string[];
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
  /** Grouped tool integrations. */
  tools?: {
    brave?: {
      enabled: boolean;
      token: string;
      /** Restrict brave search to these groups. Omit to allow all groups. */
      groups?: string[];
    };
    caldav?: {
      enabled: boolean;
      url: string;
      username: string;
      password: string;
      /** Restrict CalDAV to these groups. Omit to allow all groups. */
      groups?: string[];
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
     * Ollama integration. Disabled by default.
     * When enabled, agents can call local Ollama models via ollama_generate / ollama_list_models.
     */
    ollama?: {
      enabled: boolean;
      /** Restrict Ollama to these groups. Omit to allow all groups. */
      groups?: string[];
    };
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
   * Heartbeat — proactive scheduled runs per group.
   * If a group has a heartbeat.md file, the agent reads it on this interval
   * and acts on any instructions. No LLM call if the file is missing or empty.
   */
  heartbeat?: {
    /** Interval in ms between heartbeat runs. Defaults to 1800000 (30 min). */
    intervalMs?: number;
  };
  /**
   * Per-group overrides. Keyed by group folder name.
   */
  group?: Record<
    string,
    {
      /** Set false to disable this group's channel. Defaults to true. */
      enabled?: boolean;
      heartbeat?: {
        /** Override the global heartbeat interval for this group (ms). */
        intervalMs?: number;
      };
      service?: {
        /** Set true to start a persistent service container for this group. */
        enabled: boolean;
        /** Docker image to use. Defaults to node:20-alpine. */
        image?: string;
        /** Memory limit, e.g. "256m". Defaults to "256m". */
        memory?: string;
        /** CPU limit (fractional cores). Defaults to 0.5. */
        cpus?: number;
        /**
         * Host ports to expose from the service container.
         * Format: "hostPort:containerPort" e.g. "8080:3000"
         */
        ports?: string[];
      };
      /**
       * MCP server allowlist for this group.
       * If set, the agent can only access the listed servers.
       * If omitted, the group has access to all servers (default behaviour).
       */
      mcp?: {
        allowlist: string[];
      };
    }
  >;
  /**
   * Mount allowlist — controls which host paths can be mounted into agent containers.
   * If omitted, all additional mounts are blocked.
   */
  mountAllowlist?: MountAllowlist;
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
  chatModel: string;
  cronModel: string;
} {
  const config = loadAppConfig();
  const type = config.ai.type;
  const active = config.ai[type];
  const defaultModel = active.model || '';
  return {
    type,
    endpoint: active.endpoint || '',
    key: active.key || '',
    model: defaultModel,
    chatModel: active.chatModel || defaultModel,
    cronModel: active.cronModel || defaultModel,
  };
}
