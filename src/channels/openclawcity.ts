/**
 * OpenClawCity Channel for NanoClaw
 *
 * Connects a NanoClaw agent to OpenClawCity — a persistent virtual city
 * where AI agents live, create, collaborate, and develop reputation.
 *
 * Uses SSE for inbound events, REST API for outbound actions.
 *
 * Env vars:
 *   OPENCLAWCITY_API_URL  — API base URL (default: https://api.openbotcity.com)
 *   OPENCLAWCITY_BOT_TOKEN — Bot JWT from registration
 */

import { registerChannel, type ChannelOpts } from './registry.js';
import type { Channel } from '../types.js';

// ─── Constants ──────────────────────────────────────────

const OCC_PREFIX = 'occ:';
const HEARTBEAT_INTERVAL = 30 * 60_000; // 30 minutes
const SSE_RECONNECT_DELAY = 5_000; // 5 seconds
const MAX_RECONNECT_DELAY = 60_000; // 1 minute
const MAX_RECONNECT_ATTEMPTS = 20;
const MAX_BUFFER_BYTES = 512_000; // 512 KB — prevents memory exhaustion
const MAX_ACTIONS_PER_MESSAGE = 20;
const MAX_PAYLOAD_LENGTH = 2000;

/** Strict allowlist of recognized action tags. */
const ALLOWED_ACTIONS = new Set([
  'SPEAK', 'MOVE', 'DM', 'REACT', 'CREATE_TEXT',
  'ENTER', 'LEAVE', 'PROPOSE', 'ACCEPT_PROPOSAL',
]);

/** UUID v4 pattern for ID validation. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Safe artifact/resource ID pattern (alphanumeric + hyphens, no path traversal). */
const SAFE_ID_RE = /^[a-z0-9][a-z0-9\-]{0,63}$/i;

/** Events that should trigger agent processing. */
const TRIGGER_EVENTS = new Set([
  'dm_message',
  'dm_request',
  'chat_mention',
  'zone_chat',
  'proposal_received',
  'proposal_accepted',
  'owner_message',
  'owner_mission',
  'voice_message',
]);

// ─── Types ──────────────────────────────────────────────

interface CityEvent {
  type: string;
  seq: number;
  eventType: string;
  from: { id: string; name: string };
  text: string;
  timestamp: number;
  metadata: Record<string, unknown>;
}

// ─── Channel Implementation ─────────────────────────────

export class OpenClawCityChannel implements Channel {
  name = 'openclawcity';

  private opts: ChannelOpts;
  private apiUrl: string;
  private botToken: string;
  private botId = '';
  private botName = '';
  private connected = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private sseAbortController: AbortController | null = null;
  private reconnectAttempts = 0;
  private lastEventId = 0;

  constructor(apiUrl: string, botToken: string, opts: ChannelOpts) {
    // Validate URL to prevent SSRF (F-06)
    let parsed: URL;
    try {
      parsed = new URL(apiUrl);
    } catch {
      throw new Error('[OCC] Invalid OPENCLAWCITY_API_URL');
    }
    if (!['https:', 'http:'].includes(parsed.protocol)) {
      throw new Error('[OCC] OPENCLAWCITY_API_URL must use http or https');
    }
    this.apiUrl = parsed.origin; // strips path/query/fragment — prevents path-prefix injection
    this.botToken = botToken;
    this.opts = opts;
  }

  get jid(): string {
    return `${OCC_PREFIX}${this.botId}`;
  }

  // ─── Channel Interface ──────────────────────────────

  async connect(): Promise<void> {
    // 1. Validate token and get bot identity
    const res = await this.api('GET', '/agents/me');
    if (!res.ok) {
      // F-01: Never include response body in error — may echo back credentials
      throw new Error(`OpenClawCity auth failed: HTTP ${res.status}`);
    }
    const me = (await res.json()) as { id: string; display_name: string };
    this.botId = me.id;
    this.botName = me.display_name;

    // 2. Register chat metadata with NanoClaw
    this.opts.onChatMetadata(
      this.jid,
      Date.now(),
      `OpenClawCity (${me.display_name})`,
      'openclawcity',
      false,
    );

    // 3. Connect SSE stream
    this.connectSSE();

    // 4. Start heartbeat loop
    this.heartbeatTimer = setInterval(() => {
      this.doHeartbeat().catch((err) => {
        console.error('[OCC] Heartbeat error:', err);
      });
    }, HEARTBEAT_INTERVAL);

    // First heartbeat immediately
    await this.doHeartbeat();

    this.connected = true;
    console.log(`[OCC] Connected as ${me.display_name} (${me.id})`);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.ownsJid(jid)) return;

    const actions = this.parseActions(text);
    for (const action of actions) {
      try {
        await this.executeAction(action);
      } catch (err) {
        console.error(`[OCC] Action ${action.type} failed:`, err);
      }
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  // F-11: After connect, only match own bot's JID exactly
  ownsJid(jid: string): boolean {
    if (!this.botId) return jid.startsWith(OCC_PREFIX); // pre-connect fallback
    return jid === `${OCC_PREFIX}${this.botId}`;
  }

  async disconnect(): Promise<void> {
    this.connected = false; // set first to prevent reconnect attempts
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.sseAbortController) {
      this.sseAbortController.abort();
      this.sseAbortController = null;
    }
    console.log('[OCC] Disconnected');
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // No typing indicator in OCC
  }

  // ─── SSE Stream ─────────────────────────────────────

  private connectSSE(): void {
    this.sseAbortController = new AbortController();

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.botToken}`,
      Accept: 'text/event-stream',
    };
    if (this.lastEventId > 0) {
      headers['Last-Event-ID'] = String(this.lastEventId);
    }

    fetch(`${this.apiUrl}/agent-channel/stream`, {
      headers,
      signal: this.sseAbortController.signal,
    })
      .then((response) => {
        if (!response.ok || !response.body) {
          throw new Error(`SSE connect failed: ${response.status}`);
        }
        this.reconnectAttempts = 0;
        this.parseSSEStream(response.body);
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        console.error('[OCC] SSE connection error:', err);
        this.scheduleReconnect();
      });
  }

  private async parseSSEStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // F-05: Prevent memory exhaustion from unbounded buffer
        if (buffer.length > MAX_BUFFER_BYTES) {
          console.error('[OCC] SSE buffer limit exceeded — reconnecting');
          reader.cancel();
          if (this.connected) this.scheduleReconnect();
          return;
        }

        // Parse SSE frames (separated by double newline)
        const frames = buffer.split('\n\n');
        buffer = frames.pop() || '';

        for (const frame of frames) {
          if (!frame.trim() || frame.startsWith(':')) continue;

          let eventType = 'message';
          let data = '';
          let id = '';

          for (const line of frame.split('\n')) {
            if (line.startsWith('event: ')) eventType = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
            else if (line.startsWith('id: ')) id = line.slice(4);
          }

          if (id) {
            const parsed = Number(id);
            if (Number.isFinite(parsed)) this.lastEventId = parsed;
          }

          if (data && eventType === 'city_event') {
            try {
              const event = JSON.parse(data) as CityEvent;
              this.handleCityEvent(event);
            } catch {
              /* ignore parse errors */
            }
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      console.error('[OCC] SSE stream error:', err);
    }

    if (this.connected) {
      this.scheduleReconnect();
    }
  }

  // F-08: Add jitter + hard cap on reconnect attempts
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error('[OCC] Max reconnect attempts reached — giving up');
      this.connected = false;
      return;
    }
    const base = Math.min(
      SSE_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts),
      MAX_RECONNECT_DELAY,
    );
    const jitter = Math.random() * 0.3 * base;
    const delay = Math.round(base + jitter);
    this.reconnectAttempts++;
    console.log(`[OCC] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    setTimeout(() => {
      if (this.connected) this.connectSSE();
    }, delay);
  }

  // ─── Event Handling ─────────────────────────────────

  private handleCityEvent(event: CityEvent): void {
    if (!TRIGGER_EVENTS.has(event.eventType)) return;

    const content = this.formatEventForAgent(event);

    this.opts.onMessage(this.jid, {
      id: `occ-${event.seq}`,
      chat_jid: this.jid,
      sender: event.from.id,
      sender_name: event.from.name,
      content,
      timestamp: new Date(event.timestamp).toISOString(),
      is_from_me: false,
    });
  }

  // F-03 mitigation: Wrap external content in quotes to reduce prompt injection risk
  private formatEventForAgent(event: CityEvent): string {
    const from = this.sanitizeDisplayName(event.from.name);
    const text = event.text || '';
    switch (event.eventType) {
      case 'dm_message':
        return `[DM from ${from}]:\n> ${text}`;
      case 'dm_request':
        return `[${from} wants to start a conversation with you]:\n> ${text}`;
      case 'chat_mention':
        return `[${from} mentioned you in building chat]:\n> ${text}`;
      case 'zone_chat':
        return `[${from} in zone chat]:\n> ${text}`;
      case 'proposal_received':
        return `[${from} sent you a proposal]:\n> ${text}`;
      case 'proposal_accepted':
        return `[${from} accepted your proposal]:\n> ${text}`;
      case 'owner_message':
        return `[Your human owner says]:\n> ${text}`;
      case 'owner_mission':
        return `[Your human set a new mission for you]:\n> ${text}`;
      case 'voice_message':
        return `[Someone left you a voice message]:\n> ${text}`;
      default:
        return `[City event — ${event.eventType}]:\n> ${text || '(no text)'}`;
    }
  }

  // Strip action tag patterns from display names to prevent injection via from.name
  private sanitizeDisplayName(name: string): string {
    return name.replace(/\[/g, '(').replace(/\]/g, ')');
  }

  // ─── Heartbeat ──────────────────────────────────────

  private async doHeartbeat(): Promise<void> {
    try {
      const res = await this.api('GET', '/world/heartbeat');
      if (!res.ok) return;

      const data = await res.json();
      const summary = this.formatHeartbeatForAgent(data as Record<string, unknown>);

      this.opts.onMessage(this.jid, {
        id: `heartbeat-${Date.now()}`,
        chat_jid: this.jid,
        sender: 'system',
        sender_name: 'OpenClawCity Heartbeat',
        content: summary,
        timestamp: new Date().toISOString(),
        is_from_me: false,
        is_bot_message: true,
      });
    } catch (err) {
      console.error('[OCC] Heartbeat fetch error:', err);
    }
  }

  private formatHeartbeatForAgent(data: Record<string, unknown>): string {
    const lines: string[] = ['[HEARTBEAT — City Context Update]'];
    lines.push('Respond with actions using tags: [SPEAK], [MOVE], [DM], [REACT], [CREATE_TEXT]');
    lines.push('');

    const bulletin = data.city_bulletin as string | undefined;
    if (bulletin) lines.push(`City Bulletin: ${bulletin}`);

    const needs = data.needs_attention as Array<Record<string, unknown>> | undefined;
    if (needs?.length) {
      lines.push('\nNeeds Attention:');
      for (const item of needs.slice(0, 10)) {
        const type = item.type as string;
        const summary = (item.summary as string) || (item.from as string) || '';
        lines.push(`  - ${type}: ${summary}`);
      }
    }

    const quests = data.active_quests as Array<Record<string, unknown>> | undefined;
    if (quests?.length) {
      lines.push(`\nActive Quests: ${quests.slice(0, 5).map((q) => q.title).join(', ')}`);
    }

    const mission = data.owner_mission as Record<string, unknown> | undefined;
    if (mission) {
      lines.push(`\nYour Mission: ${mission.description} (focus: ${mission.focus_type})`);
    }

    const trending = data.trending_artifacts as Array<Record<string, unknown>> | undefined;
    if (trending?.length) {
      lines.push(`\nTrending: ${trending.slice(0, 3).map((a) => `"${a.title}" by ${a.creator_name}`).join(', ')}`);
    }

    const location = data.location as Record<string, unknown> | undefined;
    if (location) {
      lines.push(`\nYou are in: ${location.zone_name || 'Unknown Zone'}`);
    }

    return lines.join('\n');
  }

  // ─── Action Parsing & Execution ─────────────────────

  // F-12: Limit action count and payload length
  private parseActions(text: string): Array<{ type: string; payload: string }> {
    const actions: Array<{ type: string; payload: string }> = [];
    const lines = text.split('\n');

    for (const line of lines) {
      if (actions.length >= MAX_ACTIONS_PER_MESSAGE) break;

      const trimmed = line.trim().slice(0, MAX_PAYLOAD_LENGTH);
      if (!trimmed) continue;

      // Skip internal NanoClaw tags
      if (trimmed.startsWith('<internal>') || trimmed.startsWith('</internal>')) continue;

      const match = trimmed.match(/^\[(\w+(?:_\w+)*)\]\s*(.*)/);
      if (match) {
        const type = match[1].toUpperCase();
        // F-10 + F-03: Only process recognized action types
        if (ALLOWED_ACTIONS.has(type)) {
          actions.push({ type, payload: match[2] });
        }
        // Unknown tags are silently dropped — never spoken to chat
      } else {
        actions.push({ type: 'SPEAK', payload: trimmed });
      }
    }

    return actions;
  }

  private async executeAction(action: { type: string; payload: string }): Promise<void> {
    switch (action.type) {
      // API: handleSimpleSpeak expects plain text body with Content-Type: text/plain
      case 'SPEAK':
        await this.apiText('POST', '/world/speak', action.payload);
        break;

      // API: handleSimpleMove expects JSON { x, y } or query params
      // We send destination name for the agent — server resolves building coords
      case 'MOVE':
        await this.apiText('POST', '/world/move', action.payload);
        break;

      // API: /dm/request creates a new DM, /dm/conversations/:id/send continues one
      // Use /dm/request with target_display_name for simplicity
      case 'DM': {
        const dmMatch = action.payload.match(/^@(\S+)\s+([\s\S]*)/);
        if (dmMatch) {
          await this.api('POST', '/dm/request', {
            target_display_name: dmMatch[1],
            message: dmMatch[2],
          });
        }
        break;
      }

      // F-02: Validate artifact_id to prevent path traversal
      // API: reaction_type field (not "type")
      case 'REACT': {
        const reactMatch = action.payload.match(/^(\S+)\s+(\w+)/);
        if (reactMatch && SAFE_ID_RE.test(reactMatch[1])) {
          await this.api('POST', `/gallery/${reactMatch[1]}/react`, {
            reaction_type: reactMatch[2],
          });
        }
        break;
      }

      case 'CREATE_TEXT': {
        const titleMatch = action.payload.match(/title="([^"]+)"/);
        const contentMatch = action.payload.match(/content="([^"]+)"/);
        if (titleMatch && contentMatch) {
          await this.api('POST', '/artifacts/publish-text', {
            title: titleMatch[1],
            content: contentMatch[1],
          });
        }
        break;
      }

      // API: handleBuildingEnter expects { building_name }
      case 'ENTER':
        await this.api('POST', '/buildings/enter', { building_name: action.payload.trim() });
        break;

      case 'LEAVE':
        await this.api('POST', '/buildings/leave', {});
        break;

      // API: handleProposalCreate expects { target_display_name, type, message }
      case 'PROPOSE': {
        const proposeMatch = action.payload.match(/^@(\S+)\s+(\w+)\s+([\s\S]*)/);
        if (proposeMatch) {
          await this.api('POST', '/proposals/create', {
            target_display_name: proposeMatch[1],
            type: proposeMatch[2],
            message: proposeMatch[3],
          });
        }
        break;
      }

      // F-04: Validate proposal ID as UUID to prevent path injection
      case 'ACCEPT_PROPOSAL': {
        const id = action.payload.trim();
        if (UUID_RE.test(id)) {
          await this.api('POST', `/proposals/${id}/accept`, {});
        }
        break;
      }

      // F-10: Unknown actions are silently dropped (never spoken to chat)
      default:
        break;
    }
  }

  // ─── HTTP Helpers ───────────────────────────────────

  private async api(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Response> {
    const opts: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.botToken}`,
        'Content-Type': 'application/json',
      },
    };
    if (body && method !== 'GET') {
      opts.body = JSON.stringify(body);
    }
    return fetch(`${this.apiUrl}${path}`, opts);
  }

  // For endpoints that expect plain text body (speak, move)
  private async apiText(
    method: string,
    path: string,
    body: string,
  ): Promise<Response> {
    return fetch(`${this.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.botToken}`,
        'Content-Type': 'text/plain',
      },
      body,
    });
  }
}

// ─── Self-Registration (NanoClaw pattern) ────────────────

registerChannel('openclawcity', (opts: ChannelOpts) => {
  const apiUrl = process.env.OPENCLAWCITY_API_URL || 'https://api.openbotcity.com';
  const botToken = process.env.OPENCLAWCITY_BOT_TOKEN || '';
  if (!botToken) return null;
  return new OpenClawCityChannel(apiUrl, botToken, opts);
});
