/**
 * Heartbeat — proactive per-group agent runs.
 *
 * If a group has a `heartbeat.md` file in its folder, NanoClaw automatically
 * creates a recurring scheduled task for it. At run time the host reads the
 * file; if it is missing or empty the task is skipped with no container or
 * LLM call. The file content becomes the agent's prompt.
 */
import fs from 'fs';
import path from 'path';

import { loadAppConfig } from './app-config.js';
import { GROUPS_DIR } from './config.js';
import { createTask, deleteTask, getTaskById } from './db.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export const HEARTBEAT_TASK_PREFIX = 'heartbeat-';

export function heartbeatFilePath(folder: string): string {
  return path.join(GROUPS_DIR, folder, 'heartbeat.md');
}

/**
 * Returns the heartbeat file content trimmed, or null if the file is
 * missing or empty. Used by the task scheduler to skip the LLM call.
 */
export function readHeartbeatContent(folder: string): string | null {
  const p = heartbeatFilePath(folder);
  if (!fs.existsSync(p)) return null;
  const content = fs.readFileSync(p, 'utf-8').trim();
  return content.length > 0 ? content : null;
}

/**
 * Ensure heartbeat tasks exist for groups that have a heartbeat.md and
 * remove tasks for groups whose file has been deleted.
 */
export function syncHeartbeatTasks(
  groups: Record<string, RegisteredGroup>,
): void {
  const intervalMs =
    loadAppConfig().heartbeat?.intervalMs ?? 30 * 60 * 1000;

  for (const [jid, group] of Object.entries(groups)) {
    const taskId = `${HEARTBEAT_TASK_PREFIX}${group.folder}`;
    const hasFile = fs.existsSync(heartbeatFilePath(group.folder));
    const existing = getTaskById(taskId);

    if (hasFile && !existing) {
      createTask({
        id: taskId,
        group_folder: group.folder,
        chat_jid: jid,
        // Sentinel prompt — replaced at run time with the file contents.
        prompt: '__heartbeat__',
        schedule_type: 'interval',
        schedule_value: String(intervalMs),
        context_mode: 'group',
        next_run: new Date(Date.now() + intervalMs).toISOString(),
        status: 'active',
        created_at: new Date().toISOString(),
      });
      logger.info(
        { folder: group.folder, intervalMs },
        'Heartbeat task created',
      );
    } else if (!hasFile && existing) {
      deleteTask(taskId);
      logger.info(
        { folder: group.folder },
        'Heartbeat task removed (heartbeat.md deleted)',
      );
    }
  }
}

/**
 * Starts a polling loop that calls syncHeartbeatTasks every 60 seconds so
 * heartbeat.md additions and deletions are picked up without a restart.
 */
export function startHeartbeatWatcher(
  getGroups: () => Record<string, RegisteredGroup>,
): void {
  const poll = () => {
    try {
      syncHeartbeatTasks(getGroups());
    } catch (err) {
      logger.warn({ err }, 'Error syncing heartbeat tasks');
    }
    setTimeout(poll, 60_000);
  };
  poll();
  logger.info('Heartbeat watcher started');
}
