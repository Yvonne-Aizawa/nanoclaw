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
