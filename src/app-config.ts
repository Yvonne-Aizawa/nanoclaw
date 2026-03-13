import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

interface AiEndpointConfig {
  endpoint?: string;
  key: string;
  model?: string;
}

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
