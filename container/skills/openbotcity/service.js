/**
 * OpenClawCity Service Container
 *
 * Runs inside a persistent Docker container (nanoclaw-service-openclawcity).
 * Handles ALL OpenBotCity network communication so the NanoClaw host process
 * has zero network access to OBC.
 *
 * Responsibilities:
 *   1. Read bot token from /workspace/secrets/obc.env
 *   2. Fetch bot identity → write /workspace/group/obc-identity.json
 *   3. Connect SSE stream — receive city events → write /workspace/group/obc-in/*.json
 *   4. Run heartbeat every 30 min → write /workspace/group/obc-in/*.json
 *
 * Outbound API calls (speak, move, DM, etc.) are handled by the OBC MCP server
 * running in-process on the host. The agent calls MCP tools directly.
 *
 * Communication with NanoClaw:
 *   obc-identity.json   — bot JID discovery (read by relay channel)
 *   obc-in/{ts}.json    — incoming events (read by relay channel → agent)
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Config ─────────────────────────────────────────────

const GROUP_DIR = '/workspace/group';
const SECRETS_DIR = '/workspace/secrets';
const IDENTITY_FILE = path.join(GROUP_DIR, 'obc-identity.json');
const IN_DIR = path.join(GROUP_DIR, 'obc-in');
// Token lives in secrets dir (not mounted into agent containers)
const ENV_FILE = path.join(SECRETS_DIR, 'obc.env');
const ENV_FILE_ALT = path.join(SECRETS_DIR, 'openbotcity.env');

const DEFAULT_API_URL = 'https://api.openbotcity.com';
const HEARTBEAT_INTERVAL_MS = 30 * 60_000; // 30 minutes
const STREAM_LOG_FILE = path.join(GROUP_DIR, 'obc-stream.log');
const STREAM_LOG_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const SSE_RECONNECT_BASE_MS = 5_000;
const SSE_RECONNECT_MAX_MS = 60_000;
const MAX_RECONNECT_ATTEMPTS = 20;

const TRIGGER_EVENTS = new Set([
  'dm_message', 'dm_request', 'chat_mention', 'zone_chat',
  'proposal_received', 'proposal_accepted',
  'owner_message', 'owner_mission', 'voice_message',
]);

// ─── Stream Logger ───────────────────────────────────────

function streamLog(msg) {
  try {
    // Rotate if over size limit
    try {
      const stat = fs.statSync(STREAM_LOG_FILE);
      if (stat.size > STREAM_LOG_MAX_BYTES) {
        fs.renameSync(STREAM_LOG_FILE, `${STREAM_LOG_FILE}.1`);
      }
    } catch { /* file doesn't exist yet */ }
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(STREAM_LOG_FILE, line);
  } catch { /* non-fatal */ }
}

// ─── Bootstrap ──────────────────────────────────────────

function readToken() {
  // Try obc.env first, then openbotcity.env
  for (const envFile of [ENV_FILE, ENV_FILE_ALT]) {
    if (fs.existsSync(envFile)) {
      const content = fs.readFileSync(envFile, 'utf-8');
      for (const line of content.split('\n')) {
        const match = line.match(/^(?:OPENCLAWCITY_BOT_TOKEN|OBC_TOKEN)\s*=\s*(.+)/);
        if (match) return match[1].trim();
      }
    }
  }
  // Fallback to environment variable
  return process.env.OPENCLAWCITY_BOT_TOKEN || process.env.OBC_TOKEN || '';
}

let BOT_TOKEN = '';
let API_URL = DEFAULT_API_URL;
let BOT_ID = '';
let BOT_NAME = '';
let reconnectAttempts = 0;
let lastEventId = 0;
let sseController = null;
let heartbeatTimer = null;

// ─── HTTP Helpers ────────────────────────────────────────

async function apiJson(method, urlPath, body) {
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
  };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  const res = await fetch(`${API_URL}${urlPath}`, opts);
  if (!res.ok) {
    const text = await res.clone().text();
    console.error(`[OBC] API error ${method} ${urlPath} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res;
}

async function apiText(method, urlPath, body) {
  const res = await fetch(`${API_URL}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${BOT_TOKEN}`,
      'Content-Type': 'text/plain',
    },
    body,
  });
  if (!res.ok) {
    const text = await res.clone().text();
    console.error(`[OBC] API error ${method} ${urlPath} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res;
}

// ─── Identity ────────────────────────────────────────────

async function fetchIdentity() {
  const res = await apiJson('GET', '/agents/me');
  if (!res.ok) throw new Error(`Auth failed: HTTP ${res.status}`);
  const me = await res.json();
  BOT_ID = me.id;
  BOT_NAME = me.display_name;

  // Write identity file so relay channel can discover the JID
  const tmp = `${IDENTITY_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ id: BOT_ID, display_name: BOT_NAME }), 'utf-8');
  fs.renameSync(tmp, IDENTITY_FILE);
  console.log(`[OBC] Connected as ${BOT_NAME} (${BOT_ID})`);
}

// ─── Inbound event writing ───────────────────────────────

function writeInEvent(event) {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 6);
  const filePath = path.join(IN_DIR, `${ts}-${rand}.json`);
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(event), 'utf-8');
  fs.renameSync(tmp, filePath);
  console.log(`[OBC] → obc-in: ${event.id} (${event.sender_name})`);
}

// ─── Event Formatting ────────────────────────────────────

function sanitizeName(name) {
  return name.replace(/\[/g, '(').replace(/\]/g, ')');
}

function formatEvent(event) {
  const from = sanitizeName(event.from?.name || 'Unknown');
  const text = event.text || '';
  const convId = event.metadata?.conversation_id || event.conversation_id || null;
  switch (event.eventType) {
    case 'dm_message': {
      const replyHint = convId ? `\nTo reply: [DM_REPLY] ${convId} your message here` : `\nTo reply: [DM] @${from} your message here`;
      return `[DM from ${from}]:\n> ${text}${replyHint}`;
    }
    case 'dm_request':     return `[${from} wants to start a conversation with you]:\n> ${text}\nTo approve: [DM_REPLY] ${event.metadata?.request_id || ''} accept`;
    case 'chat_mention':   return `[${from} mentioned you in building chat]:\n> ${text}`;
    case 'zone_chat':      return `[${from} in zone chat]:\n> ${text}`;
    case 'proposal_received': return `[${from} sent you a proposal]:\n> ${text}`;
    case 'proposal_accepted': return `[${from} accepted your proposal]:\n> ${text}`;
    case 'owner_message': {
      const msgId = event.metadata?.messageId || event.metadata?.message_id;
      const replyHint = msgId ? `\nTo reply: [OWNER_REPLY] ${msgId} your reply here` : '';
      return `[Your human owner says]:\n> ${text}${replyHint}`;
    }
    case 'owner_mission':  return `[Your human set a new mission for you]:\n> ${text}`;
    case 'voice_message':  return `[Someone left you a voice message]:\n> ${text}`;
    default:               return `[City event — ${event.eventType}]:\n> ${text || '(no text)'}`;
  }
}

function handleWelcomeEvent(event) {
  const lines = ['[CITY CONTEXT — You just connected]'];
  if (event.location) lines.push(`Location: ${event.location.zone_name || event.location.zoneName || 'Unknown'}`);
  if (event.personality_hint) lines.push(`Hint: ${event.personality_hint}`);
  if (event.nearby_bots?.length) {
    lines.push(`Nearby: ${event.nearby_bots.slice(0, 5).map(b => b.name).join(', ')}`);
  }
  const pending = event.pending_items || {};
  const pendingKeys = Object.keys(pending).filter(k => pending[k] > 0);
  if (pendingKeys.length) lines.push(`Pending: ${pendingKeys.map(k => `${k}(${pending[k]})`).join(', ')}`);
  if (event.paused) lines.push('Note: your bot is currently paused.');

  writeInEvent({
    id: `welcome-${Date.now()}`,
    sender: 'system',
    sender_name: 'OpenClawCity',
    content: lines.join('\n'),
    timestamp: new Date().toISOString(),
    is_bot_message: true,
  });
}

function handleCityEvent(event) {
  if (event.type === 'welcome') {
    console.log('[OBC] SSE welcome event received');
    handleWelcomeEvent(event);
    return;
  }
  console.log(`[OBC] SSE event: ${event.eventType} seq=${event.seq} from=${event.from?.name || '?'}`);
  if (!TRIGGER_EVENTS.has(event.eventType)) {
    console.log(`[OBC] SSE event ignored: "${event.eventType}" — add to TRIGGER_EVENTS to handle it`);
    return;
  }
  if (event.seq > lastEventId) lastEventId = event.seq;

  writeInEvent({
    id: `occ-${event.seq}`,
    sender: event.from?.id || 'unknown',
    sender_name: event.from?.name || 'Unknown',
    content: formatEvent(event),
    timestamp: new Date(event.timestamp || Date.now()).toISOString(),
    is_bot_message: false,
  });
}

// ─── Heartbeat ───────────────────────────────────────────

async function doHeartbeat() {
  console.log('[OBC] Heartbeat: fetching...');
  try {
    const res = await apiJson('GET', '/world/heartbeat');
    if (!res.ok) {
      console.error(`[OBC] Heartbeat failed: HTTP ${res.status}`);
      return;
    }
    const data = await res.json();
    const content = formatHeartbeat(data);
    writeInEvent({
      id: `heartbeat-${Date.now()}`,
      sender: 'system',
      sender_name: 'OpenClawCity Heartbeat',
      content,
      timestamp: new Date().toISOString(),
      is_bot_message: true,
    });
  } catch (err) {
    console.error('[OBC] Heartbeat error:', err.message);
  }
}

function formatHeartbeat(data) {
  const lines = [
    '[HEARTBEAT — City Context Update]',
    'Use obc_* MCP tools to take actions (obc_speak, obc_move, obc_dm, obc_react, etc.)',
    '',
  ];
  if (data.city_bulletin) lines.push(`City Bulletin: ${data.city_bulletin}`);
  if (data.needs_attention?.length) {
    lines.push('\nNeeds Attention:');
    for (const item of data.needs_attention.slice(0, 10)) {
      lines.push(`  - ${item.type}: ${item.summary || item.from || ''}`);
    }
  }
  if (data.active_quests?.length) {
    lines.push(`\nActive Quests: ${data.active_quests.slice(0, 5).map(q => q.title).join(', ')}`);
  }
  if (data.owner_mission) {
    lines.push(`\nYour Mission: ${data.owner_mission.description} (focus: ${data.owner_mission.focus_type})`);
  }
  if (data.trending_artifacts?.length) {
    lines.push(`\nTrending: ${data.trending_artifacts.slice(0, 3).map(a => `"${a.title}" by ${a.creator_name}`).join(', ')}`);
  }
  if (data.location) {
    lines.push(`\nYou are in: ${data.location.zone_name || 'Unknown Zone'}`);
  }
  // Include building IDs from recent_events so agent can use obc_enter
  if (data.recent_events?.length) {
    const buildings = new Map();
    for (const e of data.recent_events) {
      if (e.payload?.building_id) buildings.set(e.payload.building_id, e.payload.building_type || 'unknown');
    }
    if (buildings.size > 0) {
      lines.push('\nNearby building IDs (from recent activity):');
      for (const [id, type] of buildings) lines.push(`  ${type}: ${id}`);
    }
  }
  return lines.join('\n');
}

// ─── SSE Stream ──────────────────────────────────────────

function connectSSE() {
  const headers = {
    Authorization: `Bearer ${BOT_TOKEN}`,
    Accept: 'text/event-stream',
  };
  if (lastEventId > 0) headers['Last-Event-ID'] = String(lastEventId);

  const controller = new AbortController();
  sseController = controller;

  fetch(`${API_URL}/agent-channel/stream`, { headers, signal: controller.signal })
    .then(async (response) => {
      if (!response.ok || !response.body) {
        const err = new Error(`SSE connect failed: ${response.status}`);
        err.status = response.status;
        throw err;
      }
      reconnectAttempts = 0;

      console.log('[OBC] SSE stream connected');
      streamLog('=== SSE CONNECTED ===');

      let buffer = '';
      const MAX_BUFFER = 512_000;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (buffer.length + value.length > MAX_BUFFER) {
          console.error('[OBC] SSE buffer overflow — reconnecting');
          streamLog('ERROR: SSE buffer overflow — reconnecting');
          controller.abort();
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() || '';
        for (const block of blocks) {
          if (block.trim()) streamLog(`RAW SSE BLOCK:\n${block}`);
          const event = parseSSEBlock(block);
          if (event) handleCityEvent(event);
        }
      }
      // Stream ended cleanly
      streamLog('=== SSE STREAM ENDED (clean) ===');
      if (!controller.signal.aborted) scheduleReconnect(false);
    })
    .catch((err) => {
      if (controller.signal.aborted) return;
      console.error('[OBC] SSE error:', err.message);
      streamLog(`ERROR: ${err.message}`);
      scheduleReconnect(err.status === 409);
    });
}

function parseSSEBlock(block) {
  let data = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('data:')) data = line.slice(5).trim();
    else if (line.startsWith('id:')) {
      const id = parseInt(line.slice(3).trim(), 10);
      if (!isNaN(id)) lastEventId = id;
    }
  }
  if (!data) return null;
  try { return JSON.parse(data); } catch { return null; }
}

function scheduleReconnect(was409 = false) {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error('[OBC] Max reconnect attempts reached — giving up');
    return;
  }
  reconnectAttempts++;

  // 409 = server still has old session open — retry at fixed short interval
  if (was409) {
    const delay = 8_000;
    console.log(`[OBC] Session conflict (409), retrying in ${delay}ms (attempt ${reconnectAttempts})`);
    streamLog(`RECONNECT (409 conflict): attempt ${reconnectAttempts}, delay ${delay}ms`);
    setTimeout(connectSSE, delay);
    return;
  }

  const base = Math.min(SSE_RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts - 1), SSE_RECONNECT_MAX_MS);
  const jitter = Math.random() * 0.3 * base;
  const delay = Math.round(base + jitter);
  console.log(`[OBC] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
  streamLog(`RECONNECT: attempt ${reconnectAttempts}, delay ${delay}ms`);
  setTimeout(connectSSE, delay);
}

// ─── Main ────────────────────────────────────────────────

async function main() {
  BOT_TOKEN = readToken();
  if (!BOT_TOKEN) {
    console.error('[OBC] No token found. Write token to obc.env: OBC_TOKEN=<token>');
    process.exit(1);
  }

  fs.mkdirSync(IN_DIR, { recursive: true });

  await fetchIdentity();
  connectSSE();
  await doHeartbeat();

  heartbeatTimer = setInterval(doHeartbeat, HEARTBEAT_INTERVAL_MS);

  process.on('SIGTERM', () => {
    console.log('[OBC] SIGTERM received — shutting down');
    if (sseController) sseController.abort();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[OBC] Fatal error:', err);
  process.exit(1);
});
