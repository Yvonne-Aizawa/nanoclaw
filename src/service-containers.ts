/**
 * Per-group service container lifecycle manager.
 *
 * A service container is a persistent, group-scoped Node.js process that
 * connects outbound to external services (e.g. a WebSocket server) and
 * triggers the group agent via the IPC mechanism when events arrive.
 *
 * The agent writes the service code to `groups/{folder}/service/index.js`
 * and can restart the container via an IPC `restart_service` message.
 */

import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { loadAppConfig } from './app-config.js';
import {
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  GROUPS_DIR,
  TIMEZONE,
  WORKSPACE_DIR,
} from './config.js';
import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
} from './container-runtime.js';
import { NANOCLAW_NETWORK } from './mcp/containers.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export const SERVICE_CONTAINER_PREFIX = 'nanoclaw-service-';
const DEFAULT_IMAGE = 'node:20-alpine';

function containerName(groupFolder: string): string {
  return `${SERVICE_CONTAINER_PREFIX}${groupFolder}`;
}

function serviceEntrypoint(groupFolder: string): string {
  return path.join(GROUPS_DIR, groupFolder, 'service', 'index.js');
}

function stopAndRemoveService(groupFolder: string): void {
  const name = containerName(groupFolder);
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} rm -f ${name}`, { stdio: 'pipe' });
  } catch {
    // Not running — fine
  }
}

function startServiceContainer(
  groupFolder: string,
  image: string,
  memory: string,
  cpus: number,
  ports: string[],
): void {
  const name = containerName(groupFolder);
  const ipcInputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');
  fs.mkdirSync(ipcInputDir, { recursive: true });

  // Secrets dir lives outside the group folder so agent containers can't read it
  const secretsDir = path.join(WORKSPACE_DIR, 'secrets', groupFolder);
  fs.mkdirSync(secretsDir, { recursive: true });

  const args = [
    'run',
    '-d',
    '--name',
    name,
    '--restart',
    'unless-stopped',
    '--network',
    NANOCLAW_NETWORK,
    ...hostGatewayArgs(),
    '--cpus',
    String(cpus),
    '--memory',
    memory,
    '-v',
    `${path.join(GROUPS_DIR, groupFolder)}:/workspace/group`,
    '-v',
    `${secretsDir}:/workspace/secrets:ro`,
    '-v',
    `${ipcInputDir}:/workspace/ipc/input`,
    '-e',
    `NANOCLAW_GROUP_FOLDER=${groupFolder}`,
    '-e',
    `TZ=${TIMEZONE}`,
    '-e',
    `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}/chat`,
    ...ports.flatMap((p) => ['-p', p]),
    image,
    'node',
    '/workspace/group/service/index.js',
  ];

  execFileSync(CONTAINER_RUNTIME_BIN, args, { stdio: 'pipe' });
  logger.info({ groupFolder, image }, 'Service container started');
}

/**
 * Start service containers for all groups that have service.enabled = true
 * and a service/index.js file in their group folder.
 *
 * Checks both registered groups AND config groups so that service containers
 * can start before their channel is activated (e.g. openclawcity needs the
 * container running before the relay channel can discover the identity file).
 */
export function startServiceContainers(
  groups: Record<string, RegisteredGroup>,
): void {
  const config = loadAppConfig();

  // Collect all folder names to check: registered groups + config group keys
  const registeredFolders = new Set(Object.values(groups).map((g) => g.folder));
  const configFolders = new Set(Object.keys(config.group ?? {}));
  const allFolders = new Set([...registeredFolders, ...configFolders]);

  for (const folder of allFolders) {
    const svcConfig = config.group?.[folder]?.service;
    if (!svcConfig?.enabled) continue;

    const entrypoint = serviceEntrypoint(folder);
    if (!fs.existsSync(entrypoint)) {
      logger.info(
        { folder },
        'Service container skipped — service/index.js not found',
      );
      continue;
    }

    const image = svcConfig.image ?? DEFAULT_IMAGE;
    const memory = svcConfig.memory ?? '256m';
    const cpus = svcConfig.cpus ?? 0.5;
    const ports = svcConfig.ports ?? [];

    stopAndRemoveService(folder);
    try {
      startServiceContainer(folder, image, memory, cpus, ports);
    } catch (err) {
      logger.error({ err, folder }, 'Failed to start service container');
    }
  }
}

/**
 * Stop and restart the service container for a single group.
 * Called when the agent writes a restart_service IPC message.
 */
export function restartServiceContainer(groupFolder: string): void {
  const config = loadAppConfig();
  const svcConfig = config.group?.[groupFolder]?.service;
  if (!svcConfig?.enabled) {
    logger.warn(
      { groupFolder },
      'restart_service IPC received but service not enabled for group',
    );
    return;
  }

  const entrypoint = serviceEntrypoint(groupFolder);
  if (!fs.existsSync(entrypoint)) {
    logger.warn(
      { groupFolder },
      'restart_service IPC received but service/index.js not found',
    );
    return;
  }

  const image = svcConfig.image ?? DEFAULT_IMAGE;
  const memory = svcConfig.memory ?? '256m';
  const cpus = svcConfig.cpus ?? 0.5;
  const ports = svcConfig.ports ?? [];

  stopAndRemoveService(groupFolder);
  try {
    startServiceContainer(groupFolder, image, memory, cpus, ports);
    logger.info({ groupFolder }, 'Service container restarted');
  } catch (err) {
    logger.error({ err, groupFolder }, 'Failed to restart service container');
  }
}

/** Stop all running service containers. */
export function stopAllServiceContainers(
  groups: Record<string, RegisteredGroup>,
): void {
  const config = loadAppConfig();
  for (const group of Object.values(groups)) {
    if (config.group?.[group.folder]?.service?.enabled) {
      stopAndRemoveService(group.folder);
    }
  }
}
