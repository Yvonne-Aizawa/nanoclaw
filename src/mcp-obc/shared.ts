import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, WORKSPACE_DIR } from '../config.js';
import { logger } from '../logger.js';

export const OBC_API_URL = 'https://api.openbotcity.com';

export type ApiJson = (
  method: string,
  urlPath: string,
  body?: unknown,
) => Promise<Response>;

export function readToken(groupFolder: string): string {
  const secretsDir = path.join(WORKSPACE_DIR, 'secrets', groupFolder);
  for (const fileName of ['obc.env', 'openbotcity.env']) {
    const envFile = path.join(secretsDir, fileName);
    if (fs.existsSync(envFile)) {
      const content = fs.readFileSync(envFile, 'utf-8');
      for (const line of content.split('\n')) {
        const match = line.match(
          /^(?:OPENCLAWCITY_BOT_TOKEN|OBC_TOKEN)\s*=\s*(.+)/,
        );
        if (match) return match[1].trim();
      }
    }
  }
  return '';
}

export function readBuildingSessionId(groupFolder: string): string | null {
  const stateFile = path.join(GROUPS_DIR, groupFolder, 'obc-state.json');
  try {
    if (fs.existsSync(stateFile)) {
      const data = JSON.parse(fs.readFileSync(stateFile, 'utf-8')) as {
        buildingSessionId?: string | null;
      };
      return data.buildingSessionId ?? null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function writeBuildingSessionId(
  groupFolder: string,
  sessionId: string | null,
): void {
  const stateFile = path.join(GROUPS_DIR, groupFolder, 'obc-state.json');
  fs.writeFileSync(
    stateFile,
    JSON.stringify({ buildingSessionId: sessionId }),
    'utf-8',
  );
}

export function hasObcToken(groupFolder: string): boolean {
  return readToken(groupFolder) !== '';
}

export function makeApiJson(token: string): ApiJson {
  return async function apiJson(
    method: string,
    urlPath: string,
    body?: unknown,
  ): Promise<Response> {
    const opts: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    };
    if (body !== undefined && method !== 'GET') {
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(`${OBC_API_URL}${urlPath}`, opts);
    if (!res.ok) {
      const text = await res.clone().text();
      logger.warn(
        { method, urlPath, status: res.status, body: text.slice(0, 200) },
        'OBC API error',
      );
    }
    return res;
  };
}
