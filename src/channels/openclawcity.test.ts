import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenClawCityChannel } from './openclawcity.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ─── Helpers ────────────────────────────────────────────

function makeOpts() {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({})),
  };
}

// ─── Tests ──────────────────────────────────────────────

describe('OpenClawCityChannel (file relay)', () => {
  let groupDir: string;
  let channel: OpenClawCityChannel;
  let opts: ReturnType<typeof makeOpts>;

  beforeEach(() => {
    vi.clearAllMocks();
    opts = makeOpts();
    groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'occ-test-'));
    channel = new OpenClawCityChannel(groupDir, opts);
  });

  afterEach(async () => {
    await channel.disconnect();
    fs.rmSync(groupDir, { recursive: true, force: true });
  });

  // ─── ownsJid ────────────────────────────────────────

  describe('ownsJid', () => {
    it('pre-activate: matches any occ: prefix', () => {
      expect(channel.ownsJid('occ:abc-123')).toBe(true);
      expect(channel.ownsJid('occ:other')).toBe(true);
    });

    it('rejects non-occ prefixes', () => {
      expect(channel.ownsJid('tg:123')).toBe(false);
      expect(channel.ownsJid('dc:456')).toBe(false);
    });

    it('post-activate: only matches own JID', async () => {
      fs.writeFileSync(
        path.join(groupDir, 'obc-identity.json'),
        JSON.stringify({ id: 'bot-1', display_name: 'Nova' }),
      );
      await channel.connect();
      expect(channel.ownsJid('occ:bot-1')).toBe(true);
      expect(channel.ownsJid('occ:other')).toBe(false);
    });
  });

  // ─── connect ────────────────────────────────────────

  describe('connect', () => {
    it('activates immediately if obc-identity.json exists', async () => {
      fs.writeFileSync(
        path.join(groupDir, 'obc-identity.json'),
        JSON.stringify({ id: 'bot-1', display_name: 'Nova' }),
      );
      await channel.connect();
      expect(channel.isConnected()).toBe(true);
      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'occ:bot-1',
        expect.any(String),
        'OpenClawCity (Nova)',
        'openclawcity',
        false,
      );
    });

    it('stays disconnected if identity file is missing', async () => {
      await channel.connect();
      expect(channel.isConnected()).toBe(false);
    });

    it('creates obc-out/ and obc-in/ directories on connect', async () => {
      await channel.connect();
      expect(fs.existsSync(path.join(groupDir, 'obc-out'))).toBe(true);
      expect(fs.existsSync(path.join(groupDir, 'obc-in'))).toBe(true);
    });
  });

  // ─── sendMessage ────────────────────────────────────

  describe('sendMessage', () => {
    beforeEach(async () => {
      fs.writeFileSync(
        path.join(groupDir, 'obc-identity.json'),
        JSON.stringify({ id: 'bot-1', display_name: 'Nova' }),
      );
      await channel.connect();
    });

    it('writes text to obc-out/ as a .txt file', async () => {
      await channel.sendMessage('occ:bot-1', '[SPEAK] Hello!');
      const files = fs.readdirSync(path.join(groupDir, 'obc-out'));
      expect(files.some((f) => f.endsWith('.txt'))).toBe(true);
      const content = fs.readFileSync(
        path.join(groupDir, 'obc-out', files[0]),
        'utf-8',
      );
      expect(content).toBe('[SPEAK] Hello!');
    });

    it('ignores messages for other JIDs', async () => {
      await channel.sendMessage('tg:123', 'Hello');
      const files = fs.readdirSync(path.join(groupDir, 'obc-out'));
      expect(files).toHaveLength(0);
    });
  });

  // ─── Incoming event processing ──────────────────────

  describe('processIncoming', () => {
    beforeEach(async () => {
      fs.writeFileSync(
        path.join(groupDir, 'obc-identity.json'),
        JSON.stringify({ id: 'bot-1', display_name: 'Nova' }),
      );
      await channel.connect();
    });

    it('calls onMessage for events in obc-in/ and deletes them', async () => {
      const event = {
        id: 'occ-42',
        sender: 'user-abc',
        sender_name: 'Echo',
        content: '[DM from Echo]:\n> Hello!',
        timestamp: new Date().toISOString(),
        is_bot_message: false,
      };
      fs.writeFileSync(
        path.join(groupDir, 'obc-in', '1000-test.json'),
        JSON.stringify(event),
      );

      // Give the in-poll timer a chance to fire
      await new Promise((r) => setTimeout(r, 2500));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'occ:bot-1',
        expect.objectContaining({
          id: 'occ-42',
          content: '[DM from Echo]:\n> Hello!',
          chat_jid: 'occ:bot-1',
        }),
      );
      expect(fs.existsSync(path.join(groupDir, 'obc-in', '1000-test.json'))).toBe(false);
    });

    it('skips files with missing required fields', async () => {
      fs.writeFileSync(
        path.join(groupDir, 'obc-in', '1001-bad.json'),
        JSON.stringify({ content: 'no id here' }),
      );
      await new Promise((r) => setTimeout(r, 2500));
      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // ─── disconnect ─────────────────────────────────────

  describe('disconnect', () => {
    it('sets connected to false and stops polling', async () => {
      fs.writeFileSync(
        path.join(groupDir, 'obc-identity.json'),
        JSON.stringify({ id: 'bot-1', display_name: 'Nova' }),
      );
      await channel.connect();
      expect(channel.isConnected()).toBe(true);
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });
});
