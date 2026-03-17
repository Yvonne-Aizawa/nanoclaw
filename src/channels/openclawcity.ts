/**
 * OpenClawCity Channel — File Relay
 *
 * This channel does NOT make any network connections to OpenClawCity.
 * All OBC communication (SSE stream, REST API calls) happens inside
 * an isolated service container (workspace/groups/openclawcity/service/).
 *
 * This relay:
 *   - Reads obc-identity.json (written by the service container) to discover
 *     the bot's JID and register with NanoClaw
 *   - Writes agent responses to obc-out/ (the service container picks them
 *     up, parses action tags, and calls the OBC REST API)
 *
 * No token. No network. No host access.
 */

import fs from 'fs';
import path from 'path';

import { loadAppConfig } from '../app-config.js';
import { GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';
import { registerChannel, type ChannelOpts } from './registry.js';
import type { Channel } from '../types.js';

const OCC_PREFIX = 'occ:';
const IDENTITY_FILE = 'obc-identity.json';
const OUT_DIR = 'obc-out';
const IN_DIR = 'obc-in';
const POLL_INTERVAL_MS = 5_000;
const IN_POLL_INTERVAL_MS = 2_000;

export class OpenClawCityChannel implements Channel {
  name = 'openclawcity';

  private opts: ChannelOpts;
  private groupDir: string;
  private botId = '';
  private botName = '';
  private connected = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private inPollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(groupDir: string, opts: ChannelOpts) {
    this.groupDir = groupDir;
    this.opts = opts;
  }

  get jid(): string {
    return `${OCC_PREFIX}${this.botId}`;
  }

  // ─── Channel Interface ──────────────────────────────

  async connect(): Promise<void> {
    fs.mkdirSync(path.join(this.groupDir, OUT_DIR), { recursive: true });
    fs.mkdirSync(path.join(this.groupDir, IN_DIR), { recursive: true });

    const identity = this.readIdentity();
    if (identity) {
      this.activate(identity);
    } else {
      logger.info(
        'OpenClawCity: waiting for service container to write obc-identity.json...',
      );
      this.schedulePoll();
    }
    // Returns immediately — activation happens in background if identity not yet available
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.ownsJid(jid)) return;
    const outDir = path.join(this.groupDir, OUT_DIR);
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(
      outDir,
      `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`,
    );
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, text, 'utf-8');
    fs.renameSync(tmp, file);
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    if (!this.botId) return jid.startsWith(OCC_PREFIX);
    return jid === `${OCC_PREFIX}${this.botId}`;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.inPollTimer) {
      clearTimeout(this.inPollTimer);
      this.inPollTimer = null;
    }
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {}

  // ─── Identity polling ───────────────────────────────

  private readIdentity(): { id: string; display_name: string } | null {
    const identityPath = path.join(this.groupDir, IDENTITY_FILE);
    if (!fs.existsSync(identityPath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
      if (data.id && data.display_name) return data;
    } catch {
      /* bad file */
    }
    return null;
  }

  private activate(identity: { id: string; display_name: string }): void {
    this.botId = identity.id;
    this.botName = identity.display_name;
    this.connected = true;
    this.opts.onChatMetadata(
      this.jid,
      new Date().toISOString(),
      `OpenClawCity (${identity.display_name})`,
      'openclawcity',
      false,
    );
    logger.info(
      { botId: this.botId, name: this.botName },
      'OpenClawCity relay channel activated',
    );
    this.scheduleInPoll();
  }

  // ─── Incoming event polling (obc-in/) ───────────────

  private scheduleInPoll(): void {
    this.inPollTimer = setTimeout(() => {
      this.processIncoming();
    }, IN_POLL_INTERVAL_MS);
  }

  private processIncoming(): void {
    const inDir = path.join(this.groupDir, IN_DIR);
    try {
      if (!fs.existsSync(inDir)) {
        if (this.connected) this.scheduleInPoll();
        return;
      }
      const files = fs
        .readdirSync(inDir)
        .filter((f) => f.endsWith('.json'))
        .sort();
      for (const file of files) {
        const filePath = path.join(inDir, file);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          fs.unlinkSync(filePath);
          if (data.id && data.content) {
            logger.info(
              { id: data.id, sender: data.sender_name, bot: data.is_bot_message },
              'OpenClawCity: delivering event to agent',
            );
            this.opts.onMessage(this.jid, {
              id: data.id,
              chat_jid: this.jid,
              sender: data.sender || 'system',
              sender_name: data.sender_name || 'OpenClawCity',
              content: data.content,
              timestamp: data.timestamp || new Date().toISOString(),
              is_from_me: false,
              is_bot_message: data.is_bot_message || false,
            });
          } else {
            logger.warn({ file }, 'OpenClawCity: obc-in file missing id or content, skipping');
          }
        } catch {
          /* bad file — skip */
        }
      }
    } catch {
      /* dir unreadable */
    }
    if (this.connected) this.scheduleInPoll();
  }

  private schedulePoll(): void {
    this.pollTimer = setTimeout(() => {
      const identity = this.readIdentity();
      if (identity) {
        this.activate(identity);
      } else {
        this.schedulePoll();
      }
    }, POLL_INTERVAL_MS);
  }
}

// ─── Self-Registration ───────────────────────────────

registerChannel('openclawcity', (opts: ChannelOpts) => {
  const cfg = loadAppConfig().openclawcity;
  if (cfg?.enabled === false) return null;
  // Only activate if service container is configured for this group
  if (!loadAppConfig().group?.['openclawcity']?.service?.enabled) return null;
  const groupDir = path.join(GROUPS_DIR, 'openclawcity');
  return new OpenClawCityChannel(groupDir, opts);
});
