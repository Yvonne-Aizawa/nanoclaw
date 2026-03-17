/**
 * OpenClawCity MCP server — runs in-process on the host.
 *
 * Provides MCP tools for outbound OBC API calls (speak, move, DM, enter, etc.).
 * The OBC token is read from the group's secrets directory and never passed to
 * agent containers. Building session state is persisted to a small JSON file in
 * the group folder so it survives across agent invocations.
 */

import { randomUUID } from 'crypto';
import fs from 'fs';
import { IncomingMessage, ServerResponse } from 'http';
import path from 'path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import { GROUPS_DIR, WORKSPACE_DIR } from './config.js';
import { logger } from './logger.js';
import { InProcessMcpHandler } from './mcp-brave.js';

const OBC_API_URL = 'https://api.openbotcity.com';

function readToken(groupFolder: string): string {
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

function readBuildingSessionId(groupFolder: string): string | null {
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

function writeBuildingSessionId(
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

export function createObcHandler(groupFolder: string): InProcessMcpHandler {
  const token = readToken(groupFolder);
  if (!token) {
    logger.warn({ groupFolder }, 'OBC MCP: no token found in secrets dir');
  }

  async function apiJson(
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
  }

  const sessions = new Map<string, StreamableHTTPServerTransport>();

  function makeServer(): McpServer {
    const server = new McpServer({ name: 'obc', version: '1.0.0' });

    server.tool(
      'obc_get_position',
      'Get your current position: coordinates, zone, building, and nearby agents.',
      {},
      async () => {
        const res = await apiJson('GET', '/agents/me');
        if (!res.ok) {
          return {
            content: [
              { type: 'text' as const, text: `Error: HTTP ${res.status}` },
            ],
            isError: true,
          };
        }
        const me = (await res.json()) as Record<string, unknown>;
        const parts: string[] = [];
        if (me.x !== undefined && me.y !== undefined)
          parts.push(`Position: ${me.x},${me.y}`);
        if (me.zone_name) parts.push(`Zone: ${me.zone_name}`);
        if (me.building_name) parts.push(`Building: ${me.building_name}`);
        if (Array.isArray(me.nearby_bots) && me.nearby_bots.length > 0) {
          const names = (me.nearby_bots as Array<{ name?: string }>)
            .slice(0, 10)
            .map((b) => b.name)
            .filter(Boolean)
            .join(', ');
          if (names) parts.push(`Nearby: ${names}`);
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: parts.join('\n') || JSON.stringify(me),
            },
          ],
        };
      },
    );

    server.tool(
      'obc_speak',
      'Speak aloud in your current location or building chat.',
      { text: z.string().describe('Text to say') },
      async ({ text }) => {
        const sid = readBuildingSessionId(groupFolder);
        const body: Record<string, unknown> = { type: 'speak', text };
        if (sid) body.session_id = sid;
        const res = await apiJson('POST', '/world/action', body);
        return {
          content: [
            {
              type: 'text' as const,
              text: res.ok ? 'Spoken.' : `Error: HTTP ${res.status}`,
            },
          ],
        };
      },
    );

    server.tool(
      'obc_move',
      'Move to a location on the city map.',
      {
        x: z.number().int().describe('X coordinate'),
        y: z.number().int().describe('Y coordinate'),
      },
      async ({ x, y }) => {
        const res = await apiJson('POST', '/world/action', {
          type: 'move',
          x,
          y,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: res.ok
                ? `Moved to ${x},${y}.`
                : `Error: HTTP ${res.status}`,
            },
          ],
        };
      },
    );

    server.tool(
      'obc_dm',
      'Send a DM (or DM request) to another agent by their display name.',
      {
        target_display_name: z
          .string()
          .describe('Display name of the target agent (no @ prefix)'),
        message: z.string().describe('Message to send'),
      },
      async ({ target_display_name, message }) => {
        const res = await apiJson('POST', '/dm/request', {
          target_display_name,
          message,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: res.ok ? 'DM sent.' : `Error: HTTP ${res.status}`,
            },
          ],
        };
      },
    );

    server.tool(
      'obc_dm_reply',
      'Reply in an existing DM conversation thread.',
      {
        conversation_id: z
          .string()
          .describe('Conversation UUID (shown in dm_message events)'),
        message: z.string().describe('Reply text'),
      },
      async ({ conversation_id, message }) => {
        const res = await apiJson(
          'POST',
          `/dm/conversations/${conversation_id}/send`,
          { message },
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: res.ok ? 'Replied.' : `Error: HTTP ${res.status}`,
            },
          ],
        };
      },
    );

    server.tool(
      'obc_owner_reply',
      'Reply to a message from your human owner.',
      {
        message_id: z
          .string()
          .describe('Owner message UUID (shown in owner_message events)'),
        message: z.string().describe('Reply text'),
      },
      async ({ message_id, message }) => {
        const res = await apiJson('POST', '/owner-messages/reply', {
          message_id,
          message,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: res.ok ? 'Replied to owner.' : `Error: HTTP ${res.status}`,
            },
          ],
        };
      },
    );

    server.tool(
      'obc_enter',
      'Enter a building. Returns session_id for use in subsequent speak calls.',
      {
        building_id: z
          .number()
          .int()
          .positive()
          .describe('Numeric building ID (from heartbeat nearby_buildings)'),
      },
      async ({ building_id }) => {
        const res = await apiJson('POST', '/buildings/enter', { building_id });
        if (res.ok) {
          const data = (await res.json()) as { session_id?: string };
          writeBuildingSessionId(groupFolder, data.session_id ?? null);
          return {
            content: [
              {
                type: 'text' as const,
                text: `Entered building ${building_id}. Session: ${data.session_id ?? 'none'}`,
              },
            ],
          };
        }
        return {
          content: [
            { type: 'text' as const, text: `Error: HTTP ${res.status}` },
          ],
          isError: true,
        };
      },
    );

    server.tool('obc_leave', 'Leave the current building.', {}, async () => {
      const sid = readBuildingSessionId(groupFolder);
      const body = sid ? { session_id: sid } : {};
      const res = await apiJson('POST', '/buildings/leave', body);
      writeBuildingSessionId(groupFolder, null);
      return {
        content: [
          {
            type: 'text' as const,
            text: res.ok ? 'Left building.' : `Error: HTTP ${res.status}`,
          },
        ],
      };
    });

    server.tool(
      'obc_react',
      'React to a gallery artifact.',
      {
        artifact_id: z.string().describe('Artifact ID'),
        reaction: z
          .enum(['upvote', 'love', 'fire', 'mindblown'])
          .describe('Reaction type'),
      },
      async ({ artifact_id, reaction }) => {
        const res = await apiJson('POST', `/gallery/${artifact_id}/react`, {
          reaction_type: reaction,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: res.ok ? 'Reacted.' : `Error: HTTP ${res.status}`,
            },
          ],
        };
      },
    );

    server.tool(
      'obc_create_text',
      'Publish a text artifact to the city gallery.',
      {
        title: z.string().describe('Artifact title'),
        content: z.string().describe('Text content to publish'),
      },
      async ({ title, content }) => {
        const res = await apiJson('POST', '/artifacts/publish-text', {
          title,
          content,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: res.ok
                ? 'Artifact published.'
                : `Error: HTTP ${res.status}`,
            },
          ],
        };
      },
    );

    server.tool(
      'obc_propose',
      'Send a collaboration proposal to another agent.',
      {
        target_display_name: z
          .string()
          .describe('Display name of target agent (no @ prefix)'),
        type: z
          .enum(['collab', 'trade', 'explore', 'perform'])
          .describe('Proposal type'),
        message: z.string().describe('Proposal message'),
      },
      async ({ target_display_name, type, message }) => {
        const res = await apiJson('POST', '/proposals/create', {
          target_display_name,
          type,
          message,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: res.ok ? 'Proposal sent.' : `Error: HTTP ${res.status}`,
            },
          ],
        };
      },
    );

    server.tool(
      'obc_accept_proposal',
      'Accept a pending collaboration proposal.',
      {
        proposal_id: z
          .string()
          .describe('Proposal UUID (from proposal_received event)'),
      },
      async ({ proposal_id }) => {
        const res = await apiJson(
          'POST',
          `/proposals/${proposal_id}/accept`,
          {},
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: res.ok ? 'Proposal accepted.' : `Error: HTTP ${res.status}`,
            },
          ],
        };
      },
    );

    // ─── Identity & Profile ─────────────────────────────

    server.tool(
      'obc_update_profile',
      'Update your bot profile (display name, bio, avatar URL, etc.).',
      {
        display_name: z.string().optional().describe('New display name'),
        bio: z.string().optional().describe('Bio / description'),
        avatar_url: z.string().optional().describe('Avatar image URL'),
      },
      async (params) => {
        const body = Object.fromEntries(
          Object.entries(params).filter(([, v]) => v !== undefined),
        );
        const res = await apiJson('PATCH', '/agents/profile', body);
        return {
          content: [
            {
              type: 'text' as const,
              text: res.ok ? 'Profile updated.' : `Error: HTTP ${res.status}`,
            },
          ],
        };
      },
    );

    server.tool(
      'obc_get_profile',
      "Get another bot's profile.",
      { bot_id: z.string().describe("Target bot's ID") },
      async ({ bot_id }) => {
        const res = await apiJson('GET', `/agents/profile/${bot_id}`);
        if (!res.ok)
          return {
            content: [
              { type: 'text' as const, text: `Error: HTTP ${res.status}` },
            ],
            isError: true,
          };
        const data = (await res.json()) as Record<string, unknown>;
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      },
    );

    server.tool(
      'obc_get_nearby',
      'Find bots near your current position.',
      {},
      async () => {
        const res = await apiJson('GET', '/agents/nearby');
        if (!res.ok)
          return {
            content: [
              { type: 'text' as const, text: `Error: HTTP ${res.status}` },
            ],
            isError: true,
          };
        const data = (await res.json()) as Array<Record<string, unknown>>;
        if (!Array.isArray(data) || data.length === 0)
          return { content: [{ type: 'text' as const, text: 'No nearby bots.' }] };
        const lines = data
          .slice(0, 20)
          .map(
            (b) =>
              `${b.display_name ?? b.name ?? b.id} — pos: ${b.x ?? '?'},${b.y ?? '?'} zone: ${b.zone_name ?? '?'}`,
          );
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      },
    );

    server.tool(
      'obc_get_balance',
      'Get credit balance for yourself or another bot.',
      {
        bot_id: z
          .string()
          .optional()
          .describe('Bot ID (omit to get your own balance)'),
      },
      async ({ bot_id }) => {
        let id = bot_id;
        if (!id) {
          const me = await apiJson('GET', '/agents/me');
          if (!me.ok)
            return {
              content: [
                { type: 'text' as const, text: `Error fetching own ID: HTTP ${me.status}` },
              ],
              isError: true,
            };
          const meData = (await me.json()) as { id?: string };
          id = meData.id;
        }
        const res = await apiJson('GET', `/agents/${id}/balance`);
        if (!res.ok)
          return {
            content: [
              { type: 'text' as const, text: `Error: HTTP ${res.status}` },
            ],
            isError: true,
          };
        const data = (await res.json()) as Record<string, unknown>;
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      },
    );

    // ─── World & Navigation ──────────────────────────────

    server.tool(
      'obc_zone_transfer',
      'Transfer to a different zone on the city map.',
      { zone_id: z.string().describe('Destination zone ID') },
      async ({ zone_id }) => {
        const res = await apiJson('POST', '/world/zone-transfer', { zone_id });
        return {
          content: [
            {
              type: 'text' as const,
              text: res.ok ? `Transferred to zone ${zone_id}.` : `Error: HTTP ${res.status}`,
            },
          ],
        };
      },
    );

    server.tool(
      'obc_get_map',
      'List all open zones on the city map.',
      {},
      async () => {
        const res = await apiJson('GET', '/world/map');
        if (!res.ok)
          return {
            content: [
              { type: 'text' as const, text: `Error: HTTP ${res.status}` },
            ],
            isError: true,
          };
        const data = (await res.json()) as Array<Record<string, unknown>>;
        if (!Array.isArray(data) || data.length === 0)
          return { content: [{ type: 'text' as const, text: 'No zones found.' }] };
        const lines = data.map(
          (z) => `[${z.id}] ${z.name ?? z.zone_name ?? '?'} — ${z.description ?? ''}`.trim(),
        );
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      },
    );

    server.tool(
      'obc_get_ticker',
      'Get the live city news ticker.',
      {},
      async () => {
        const res = await apiJson('GET', '/world/ticker');
        if (!res.ok)
          return {
            content: [
              { type: 'text' as const, text: `Error: HTTP ${res.status}` },
            ],
            isError: true,
          };
        const data = (await res.json()) as Record<string, unknown>;
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      },
    );

    // ─── Buildings ───────────────────────────────────────

    server.tool(
      'obc_building_actions',
      'List available actions inside a building.',
      { building_id: z.number().int().positive().describe('Building numeric ID') },
      async ({ building_id }) => {
        const res = await apiJson('GET', `/buildings/${building_id}/actions`);
        if (!res.ok)
          return {
            content: [
              { type: 'text' as const, text: `Error: HTTP ${res.status}` },
            ],
            isError: true,
          };
        const data = (await res.json()) as Array<Record<string, unknown>>;
        if (!Array.isArray(data) || data.length === 0)
          return { content: [{ type: 'text' as const, text: 'No actions available.' }] };
        const lines = data.map(
          (a) => `[${a.id ?? a.action_id}] ${a.name ?? a.label ?? '?'}: ${a.description ?? ''}`.trim(),
        );
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      },
    );

    server.tool(
      'obc_building_execute',
      'Execute an action inside the current building.',
      {
        building_id: z.number().int().positive().describe('Building numeric ID'),
        action_id: z.string().describe('Action ID (from obc_building_actions)'),
        params: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Optional action parameters as a JSON object'),
      },
      async ({ building_id, action_id, params }) => {
        const res = await apiJson(
          'POST',
          `/buildings/${building_id}/actions/execute`,
          { action_id, ...(params ?? {}) },
        );
        if (!res.ok)
          return {
            content: [
              { type: 'text' as const, text: `Error: HTTP ${res.status}` },
            ],
            isError: true,
          };
        const data = (await res.json()) as Record<string, unknown>;
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      },
    );

    // ─── DM & Social ─────────────────────────────────────

    server.tool(
      'obc_dm_check',
      'Check for pending incoming DM requests.',
      {},
      async () => {
        const res = await apiJson('GET', '/dm/check');
        if (!res.ok)
          return {
            content: [
              { type: 'text' as const, text: `Error: HTTP ${res.status}` },
            ],
            isError: true,
          };
        const data = (await res.json()) as Record<string, unknown>;
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      },
    );

    server.tool(
      'obc_dm_approve',
      'Approve an incoming DM request.',
      { request_id: z.string().describe('DM request ID') },
      async ({ request_id }) => {
        const res = await apiJson('POST', `/dm/requests/${request_id}/approve`, {});
        return {
          content: [
            {
              type: 'text' as const,
              text: res.ok ? 'DM request approved.' : `Error: HTTP ${res.status}`,
            },
          ],
        };
      },
    );

    server.tool(
      'obc_dm_reject',
      'Reject an incoming DM request.',
      { request_id: z.string().describe('DM request ID') },
      async ({ request_id }) => {
        const res = await apiJson('POST', `/dm/requests/${request_id}/reject`, {});
        return {
          content: [
            {
              type: 'text' as const,
              text: res.ok ? 'DM request rejected.' : `Error: HTTP ${res.status}`,
            },
          ],
        };
      },
    );

    server.tool(
      'obc_dm_list',
      'List your DM conversations.',
      {},
      async () => {
        const res = await apiJson('GET', '/dm/conversations');
        if (!res.ok)
          return {
            content: [
              { type: 'text' as const, text: `Error: HTTP ${res.status}` },
            ],
            isError: true,
          };
        const data = (await res.json()) as Array<Record<string, unknown>>;
        if (!Array.isArray(data) || data.length === 0)
          return { content: [{ type: 'text' as const, text: 'No conversations.' }] };
        const lines = data.map(
          (c) =>
            `[${c.id}] with ${c.other_display_name ?? c.other_name ?? '?'} — last: ${c.last_message_preview ?? ''}`.trim(),
        );
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      },
    );

    server.tool(
      'obc_dm_read',
      'Read messages in a DM conversation.',
      { conversation_id: z.string().describe('Conversation UUID') },
      async ({ conversation_id }) => {
        const res = await apiJson('GET', `/dm/conversations/${conversation_id}`);
        if (!res.ok)
          return {
            content: [
              { type: 'text' as const, text: `Error: HTTP ${res.status}` },
            ],
            isError: true,
          };
        const data = (await res.json()) as Record<string, unknown>;
        const messages = Array.isArray(data)
          ? data
          : Array.isArray((data as { messages?: unknown[] }).messages)
            ? (data as { messages: Array<Record<string, unknown>> }).messages
            : [];
        if (messages.length === 0)
          return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
        const lines = (messages as Array<Record<string, unknown>>).map(
          (m) => `${m.sender_name ?? m.from ?? '?'}: ${m.text ?? m.message ?? m.content ?? ''}`,
        );
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      },
    );

    server.tool(
      'obc_follow',
      'Follow another bot.',
      { bot_id: z.string().describe("Target bot's ID") },
      async ({ bot_id }) => {
        const res = await apiJson('POST', `/agents/${bot_id}/follow`, {});
        return {
          content: [
            {
              type: 'text' as const,
              text: res.ok ? `Now following ${bot_id}.` : `Error: HTTP ${res.status}`,
            },
          ],
        };
      },
    );

    server.tool(
      'obc_unfollow',
      'Unfollow a bot.',
      { bot_id: z.string().describe("Target bot's ID") },
      async ({ bot_id }) => {
        const res = await apiJson('DELETE', `/agents/${bot_id}/follow`);
        return {
          content: [
            {
              type: 'text' as const,
              text: res.ok ? `Unfollowed ${bot_id}.` : `Error: HTTP ${res.status}`,
            },
          ],
        };
      },
    );

    server.tool(
      'obc_interact',
      'Interact with a nearby bot.',
      {
        bot_id: z.string().describe("Target bot's ID"),
        interaction_type: z
          .string()
          .optional()
          .describe('Type of interaction (e.g. wave, greet)'),
      },
      async ({ bot_id, interaction_type }) => {
        const body: Record<string, unknown> = {};
        if (interaction_type) body.interaction_type = interaction_type;
        const res = await apiJson('POST', `/agents/${bot_id}/interact`, body);
        if (!res.ok)
          return {
            content: [
              { type: 'text' as const, text: `Error: HTTP ${res.status}` },
            ],
            isError: true,
          };
        const data = (await res.json()) as Record<string, unknown>;
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      },
    );

    // ─── Proposals ───────────────────────────────────────

    server.tool(
      'obc_list_proposals',
      'List your pending collaboration proposals.',
      {},
      async () => {
        const res = await apiJson('GET', '/proposals');
        if (!res.ok)
          return {
            content: [
              { type: 'text' as const, text: `Error: HTTP ${res.status}` },
            ],
            isError: true,
          };
        const data = (await res.json()) as Array<Record<string, unknown>>;
        if (!Array.isArray(data) || data.length === 0)
          return { content: [{ type: 'text' as const, text: 'No proposals.' }] };
        const lines = data.map(
          (p) =>
            `[${p.id}] ${p.type ?? '?'} from ${p.from_display_name ?? p.from ?? '?'}: ${p.message ?? ''}`.trim(),
        );
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      },
    );

    server.tool(
      'obc_reject_proposal',
      'Reject a collaboration proposal.',
      { proposal_id: z.string().describe('Proposal UUID') },
      async ({ proposal_id }) => {
        const res = await apiJson('POST', `/proposals/${proposal_id}/reject`, {});
        return {
          content: [
            {
              type: 'text' as const,
              text: res.ok ? 'Proposal rejected.' : `Error: HTTP ${res.status}`,
            },
          ],
        };
      },
    );

    // ─── Gallery & Artifacts ─────────────────────────────

    server.tool(
      'obc_gallery_browse',
      'Browse published artifacts in the city gallery.',
      {
        limit: z
          .number()
          .int()
          .optional()
          .describe('Max number of results (default 20)'),
      },
      async ({ limit }) => {
        const url = limit ? `/gallery?limit=${limit}` : '/gallery';
        const res = await apiJson('GET', url);
        if (!res.ok)
          return {
            content: [
              { type: 'text' as const, text: `Error: HTTP ${res.status}` },
            ],
            isError: true,
          };
        const data = (await res.json()) as Array<Record<string, unknown>>;
        if (!Array.isArray(data) || data.length === 0)
          return { content: [{ type: 'text' as const, text: 'No artifacts found.' }] };
        const lines = data.map(
          (a) =>
            `[${a.id}] "${a.title ?? '?'}" by ${a.creator_name ?? '?'} — reactions: ${a.reaction_count ?? 0}`,
        );
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      },
    );

    server.tool(
      'obc_gallery_get',
      'Get details of a specific artifact.',
      { artifact_id: z.string().describe('Artifact ID') },
      async ({ artifact_id }) => {
        const res = await apiJson('GET', `/gallery/${artifact_id}`);
        if (!res.ok)
          return {
            content: [
              { type: 'text' as const, text: `Error: HTTP ${res.status}` },
            ],
            isError: true,
          };
        const data = (await res.json()) as Record<string, unknown>;
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      },
    );

    server.tool(
      'obc_gallery_flag',
      'Flag an artifact for moderation.',
      {
        artifact_id: z.string().describe('Artifact ID'),
        reason: z.string().optional().describe('Reason for flagging'),
      },
      async ({ artifact_id, reason }) => {
        const res = await apiJson('POST', `/gallery/${artifact_id}/flag`, {
          ...(reason ? { reason } : {}),
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: res.ok ? 'Artifact flagged.' : `Error: HTTP ${res.status}`,
            },
          ],
        };
      },
    );

    // ─── Help Requests ───────────────────────────────────

    server.tool(
      'obc_help_create',
      'Create a help request asking other bots for assistance.',
      {
        title: z.string().describe('Short title'),
        description: z.string().describe('What you need help with'),
        skill: z.string().optional().describe('Skill category needed'),
      },
      async ({ title, description, skill }) => {
        const body: Record<string, unknown> = { title, description };
        if (skill) body.skill = skill;
        const res = await apiJson('POST', '/help-requests', body);
        if (!res.ok)
          return {
            content: [
              { type: 'text' as const, text: `Error: HTTP ${res.status}` },
            ],
            isError: true,
          };
        const data = (await res.json()) as Record<string, unknown>;
        return {
          content: [
            {
              type: 'text' as const,
              text: `Help request created (id: ${data.id ?? '?'}).`,
            },
          ],
        };
      },
    );

    server.tool(
      'obc_help_list',
      'List open help requests from other bots.',
      {},
      async () => {
        const res = await apiJson('GET', '/help-requests');
        if (!res.ok)
          return {
            content: [
              { type: 'text' as const, text: `Error: HTTP ${res.status}` },
            ],
            isError: true,
          };
        const data = (await res.json()) as Array<Record<string, unknown>>;
        if (!Array.isArray(data) || data.length === 0)
          return { content: [{ type: 'text' as const, text: 'No help requests.' }] };
        const lines = data.slice(0, 20).map(
          (h) => `[${h.id}] "${h.title ?? '?'}" by ${h.creator_name ?? '?'}: ${h.description ?? ''}`.slice(0, 120),
        );
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      },
    );

    server.tool(
      'obc_help_status',
      'Check the fulfillment status of a help request.',
      { request_id: z.string().describe('Help request ID') },
      async ({ request_id }) => {
        const res = await apiJson('GET', `/help-requests/${request_id}/status`);
        if (!res.ok)
          return {
            content: [
              { type: 'text' as const, text: `Error: HTTP ${res.status}` },
            ],
            isError: true,
          };
        const data = (await res.json()) as Record<string, unknown>;
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      },
    );

    server.tool(
      'obc_help_fulfill',
      'Fulfill a help request from another bot.',
      {
        request_id: z.string().describe('Help request ID'),
        artifact_id: z
          .string()
          .optional()
          .describe('Artifact ID you are submitting as fulfillment'),
        message: z.string().optional().describe('Fulfillment message'),
      },
      async ({ request_id, artifact_id, message }) => {
        const body: Record<string, unknown> = {};
        if (artifact_id) body.artifact_id = artifact_id;
        if (message) body.message = message;
        const res = await apiJson('POST', `/help-requests/${request_id}/fulfill`, body);
        return {
          content: [
            {
              type: 'text' as const,
              text: res.ok ? 'Help request fulfilled.' : `Error: HTTP ${res.status}`,
            },
          ],
        };
      },
    );

    server.tool(
      'obc_help_decline',
      'Decline a help request.',
      { request_id: z.string().describe('Help request ID') },
      async ({ request_id }) => {
        const res = await apiJson('POST', `/help-requests/${request_id}/decline`, {});
        return {
          content: [
            {
              type: 'text' as const,
              text: res.ok ? 'Help request declined.' : `Error: HTTP ${res.status}`,
            },
          ],
        };
      },
    );

    // ─── Skills ──────────────────────────────────────────

    server.tool(
      'obc_skill_catalog',
      'List all valid skill categories available in the city.',
      {},
      async () => {
        const res = await apiJson('GET', '/skills/catalog');
        if (!res.ok)
          return {
            content: [
              { type: 'text' as const, text: `Error: HTTP ${res.status}` },
            ],
            isError: true,
          };
        const data = (await res.json()) as Array<Record<string, unknown>>;
        if (!Array.isArray(data) || data.length === 0)
          return { content: [{ type: 'text' as const, text: 'No skills found.' }] };
        const lines = data.map((s) => `${s.id ?? s.name}: ${s.description ?? ''}`.trim());
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      },
    );

    server.tool(
      'obc_skill_register',
      'Declare your bot abilities/skills.',
      {
        skills: z
          .array(z.string())
          .describe('Array of skill IDs to register (from obc_skill_catalog)'),
      },
      async ({ skills }) => {
        const res = await apiJson('POST', '/skills/register', { skills });
        return {
          content: [
            {
              type: 'text' as const,
              text: res.ok ? 'Skills registered.' : `Error: HTTP ${res.status}`,
            },
          ],
        };
      },
    );

    server.tool(
      'obc_skill_search',
      'Find bots that have a specific skill.',
      { skill: z.string().describe('Skill ID to search for') },
      async ({ skill }) => {
        const res = await apiJson('GET', `/skills/search?skill=${encodeURIComponent(skill)}`);
        if (!res.ok)
          return {
            content: [
              { type: 'text' as const, text: `Error: HTTP ${res.status}` },
            ],
            isError: true,
          };
        const data = (await res.json()) as Array<Record<string, unknown>>;
        if (!Array.isArray(data) || data.length === 0)
          return { content: [{ type: 'text' as const, text: 'No bots found with that skill.' }] };
        const lines = data
          .slice(0, 20)
          .map((b) => `${b.display_name ?? b.name ?? b.id} (score: ${b.score ?? '?'})`);
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      },
    );

    server.tool(
      'obc_skill_get',
      "Get a bot's registered skills.",
      { bot_id: z.string().describe("Bot's ID") },
      async ({ bot_id }) => {
        const res = await apiJson('GET', `/skills/bot/${bot_id}`);
        if (!res.ok)
          return {
            content: [
              { type: 'text' as const, text: `Error: HTTP ${res.status}` },
            ],
            isError: true,
          };
        const data = (await res.json()) as Record<string, unknown>;
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      },
    );

    server.tool(
      'obc_skill_scores',
      "View a bot's skill scores.",
      { bot_id: z.string().describe("Bot's ID") },
      async ({ bot_id }) => {
        const res = await apiJson('GET', `/agents/${bot_id}/skill-scores`);
        if (!res.ok)
          return {
            content: [
              { type: 'text' as const, text: `Error: HTTP ${res.status}` },
            ],
            isError: true,
          };
        const data = (await res.json()) as Record<string, unknown>;
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      },
    );

    server.tool(
      'obc_milestones',
      "View a bot's achievements and milestones.",
      { bot_id: z.string().describe("Bot's ID") },
      async ({ bot_id }) => {
        const res = await apiJson('GET', `/agents/${bot_id}/milestones`);
        if (!res.ok)
          return {
            content: [
              { type: 'text' as const, text: `Error: HTTP ${res.status}` },
            ],
            isError: true,
          };
        const data = (await res.json()) as Array<Record<string, unknown>>;
        if (!Array.isArray(data) || data.length === 0)
          return { content: [{ type: 'text' as const, text: 'No milestones yet.' }] };
        const lines = data.map(
          (m) => `${m.title ?? m.name ?? '?'}: ${m.description ?? ''} (${m.achieved_at ?? '?'})`.trim(),
        );
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      },
    );

    // ─── City Memory & Reflection ────────────────────────

    server.tool(
      'obc_reflect',
      'Write a journal/reflection entry about your experiences in the city.',
      { content: z.string().describe('Reflection text to record') },
      async ({ content }) => {
        const res = await apiJson('POST', '/agents/me/reflect', { content });
        return {
          content: [
            {
              type: 'text' as const,
              text: res.ok ? 'Reflection recorded.' : `Error: HTTP ${res.status}`,
            },
          ],
        };
      },
    );

    server.tool(
      'obc_city_memory',
      'Access your full city interaction history.',
      {},
      async () => {
        const res = await apiJson('GET', '/agents/me/city-memory');
        if (!res.ok)
          return {
            content: [
              { type: 'text' as const, text: `Error: HTTP ${res.status}` },
            ],
            isError: true,
          };
        const data = (await res.json()) as Record<string, unknown>;
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      },
    );

    server.tool(
      'obc_city_reflection',
      'Get behavior observations about yourself from the city.',
      {},
      async () => {
        const res = await apiJson('GET', '/agents/me/city-reflection');
        if (!res.ok)
          return {
            content: [
              { type: 'text' as const, text: `Error: HTTP ${res.status}` },
            ],
            isError: true,
          };
        const data = (await res.json()) as Record<string, unknown>;
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      },
    );

    server.tool(
      'obc_identity_shift',
      'Declare an identity change or evolution for your bot.',
      {
        description: z
          .string()
          .describe('Description of how your identity or focus has shifted'),
      },
      async ({ description }) => {
        const res = await apiJson('POST', '/agents/me/identity-shift', {
          description,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: res.ok ? 'Identity shift recorded.' : `Error: HTTP ${res.status}`,
            },
          ],
        };
      },
    );

    // ─── Quests ──────────────────────────────────────────

    server.tool(
      'obc_quests_active',
      'List active quests you can participate in.',
      {},
      async () => {
        const res = await apiJson('GET', '/quests/active');
        if (!res.ok)
          return {
            content: [
              { type: 'text' as const, text: `Error: HTTP ${res.status}` },
            ],
            isError: true,
          };
        const data = (await res.json()) as Array<Record<string, unknown>>;
        if (!Array.isArray(data) || data.length === 0)
          return { content: [{ type: 'text' as const, text: 'No active quests.' }] };
        const lines = data.map(
          (q) => `[${q.id}] "${q.title ?? '?'}": ${q.description ?? ''} (deadline: ${q.deadline ?? 'none'})`.trim(),
        );
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      },
    );

    server.tool(
      'obc_quest_submit',
      'Submit an artifact to a quest.',
      {
        quest_id: z.string().describe('Quest ID'),
        artifact_id: z.string().describe('Artifact ID to submit'),
        message: z.string().optional().describe('Submission note'),
      },
      async ({ quest_id, artifact_id, message }) => {
        const body: Record<string, unknown> = { artifact_id };
        if (message) body.message = message;
        const res = await apiJson('POST', `/quests/${quest_id}/submit`, body);
        return {
          content: [
            {
              type: 'text' as const,
              text: res.ok ? 'Artifact submitted to quest.' : `Error: HTTP ${res.status}`,
            },
          ],
        };
      },
    );

    server.tool(
      'obc_quest_create',
      'Create a new quest for other bots to participate in.',
      {
        title: z.string().describe('Quest title'),
        description: z.string().describe('What participants must do'),
        deadline: z
          .string()
          .optional()
          .describe('Deadline ISO date string (optional)'),
      },
      async ({ title, description, deadline }) => {
        const body: Record<string, unknown> = { title, description };
        if (deadline) body.deadline = deadline;
        const res = await apiJson('POST', '/quests/create', body);
        if (!res.ok)
          return {
            content: [
              { type: 'text' as const, text: `Error: HTTP ${res.status}` },
            ],
            isError: true,
          };
        const data = (await res.json()) as Record<string, unknown>;
        return {
          content: [
            { type: 'text' as const, text: `Quest created (id: ${data.id ?? '?'}).` },
          ],
        };
      },
    );

    server.tool(
      'obc_research_list',
      'List available research quests.',
      {},
      async () => {
        const res = await apiJson('GET', '/quests/research');
        if (!res.ok)
          return {
            content: [
              { type: 'text' as const, text: `Error: HTTP ${res.status}` },
            ],
            isError: true,
          };
        const data = (await res.json()) as Array<Record<string, unknown>>;
        if (!Array.isArray(data) || data.length === 0)
          return { content: [{ type: 'text' as const, text: 'No research quests.' }] };
        const lines = data.map(
          (q) => `[${q.id}] "${q.title ?? '?'}": ${q.description ?? ''}`.trim(),
        );
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      },
    );

    server.tool(
      'obc_research_join',
      'Join a research quest.',
      { quest_id: z.string().describe('Research quest ID') },
      async ({ quest_id }) => {
        const res = await apiJson(
          'POST',
          `/quests/research/${quest_id}/join`,
          {},
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: res.ok ? 'Joined research quest.' : `Error: HTTP ${res.status}`,
            },
          ],
        };
      },
    );

    server.tool(
      'obc_research_submit',
      'Submit findings to a research quest.',
      {
        quest_id: z.string().describe('Research quest ID'),
        findings: z.string().describe('Your research findings'),
      },
      async ({ quest_id, findings }) => {
        const res = await apiJson(
          'POST',
          `/quests/research/${quest_id}/research-submit`,
          { findings },
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: res.ok ? 'Findings submitted.' : `Error: HTTP ${res.status}`,
            },
          ],
        };
      },
    );

    server.tool(
      'obc_research_review',
      'Conduct a peer review for a research quest submission.',
      {
        quest_id: z.string().describe('Research quest ID'),
        submission_id: z.string().describe('Submission ID to review'),
        score: z
          .number()
          .int()
          .min(1)
          .max(5)
          .describe('Score from 1 (poor) to 5 (excellent)'),
        comment: z.string().optional().describe('Review comment'),
      },
      async ({ quest_id, submission_id, score, comment }) => {
        const body: Record<string, unknown> = { submission_id, score };
        if (comment) body.comment = comment;
        const res = await apiJson(
          'POST',
          `/quests/research/${quest_id}/review`,
          body,
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: res.ok ? 'Review submitted.' : `Error: HTTP ${res.status}`,
            },
          ],
        };
      },
    );

    // ─── Feed ─────────────────────────────────────────────

    server.tool(
      'obc_feed_post',
      'Create a post on your public feed.',
      {
        content: z.string().describe('Post text content'),
        artifact_id: z
          .string()
          .optional()
          .describe('Optional artifact to attach'),
      },
      async ({ content, artifact_id }) => {
        const body: Record<string, unknown> = { content };
        if (artifact_id) body.artifact_id = artifact_id;
        const res = await apiJson('POST', '/feed/post', body);
        if (!res.ok)
          return {
            content: [
              { type: 'text' as const, text: `Error: HTTP ${res.status}` },
            ],
            isError: true,
          };
        const data = (await res.json()) as Record<string, unknown>;
        return {
          content: [
            { type: 'text' as const, text: `Feed post created (id: ${data.id ?? '?'}).` },
          ],
        };
      },
    );

    server.tool(
      'obc_feed_mine',
      'Get your own feed posts.',
      {},
      async () => {
        const res = await apiJson('GET', '/feed/my-posts');
        if (!res.ok)
          return {
            content: [
              { type: 'text' as const, text: `Error: HTTP ${res.status}` },
            ],
            isError: true,
          };
        const data = (await res.json()) as Array<Record<string, unknown>>;
        if (!Array.isArray(data) || data.length === 0)
          return { content: [{ type: 'text' as const, text: 'No posts yet.' }] };
        const lines = data
          .slice(0, 20)
          .map((p) => `[${p.id}] ${p.content ?? p.text ?? ''}`.slice(0, 120));
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      },
    );

    server.tool(
      'obc_feed_bot',
      "Get a bot's public feed posts.",
      { bot_id: z.string().describe("Bot's ID") },
      async ({ bot_id }) => {
        const res = await apiJson('GET', `/feed/bot/${bot_id}`);
        if (!res.ok)
          return {
            content: [
              { type: 'text' as const, text: `Error: HTTP ${res.status}` },
            ],
            isError: true,
          };
        const data = (await res.json()) as Array<Record<string, unknown>>;
        if (!Array.isArray(data) || data.length === 0)
          return { content: [{ type: 'text' as const, text: 'No posts.' }] };
        const lines = data
          .slice(0, 20)
          .map((p) => `[${p.id}] ${p.content ?? p.text ?? ''}`.slice(0, 120));
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      },
    );

    server.tool(
      'obc_feed_following',
      'Get the feed timeline from bots you follow.',
      {},
      async () => {
        const res = await apiJson('GET', '/feed/following');
        if (!res.ok)
          return {
            content: [
              { type: 'text' as const, text: `Error: HTTP ${res.status}` },
            ],
            isError: true,
          };
        const data = (await res.json()) as Array<Record<string, unknown>>;
        if (!Array.isArray(data) || data.length === 0)
          return { content: [{ type: 'text' as const, text: 'No posts in following feed.' }] };
        const lines = data
          .slice(0, 20)
          .map(
            (p) =>
              `${p.creator_name ?? p.author ?? '?'}: ${p.content ?? p.text ?? ''}`.slice(0, 120),
          );
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      },
    );

    server.tool(
      'obc_feed_react',
      'React to a feed post.',
      {
        post_id: z.string().describe('Feed post ID'),
        reaction: z
          .enum(['upvote', 'love', 'fire', 'mindblown'])
          .describe('Reaction type'),
      },
      async ({ post_id, reaction }) => {
        const res = await apiJson('POST', `/feed/${post_id}/react`, {
          reaction_type: reaction,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: res.ok ? 'Reacted to post.' : `Error: HTTP ${res.status}`,
            },
          ],
        };
      },
    );

    server.tool(
      'obc_feed_unreact',
      'Remove your reaction from a feed post.',
      { post_id: z.string().describe('Feed post ID') },
      async ({ post_id }) => {
        const res = await apiJson('DELETE', `/feed/${post_id}/react`);
        return {
          content: [
            {
              type: 'text' as const,
              text: res.ok ? 'Reaction removed.' : `Error: HTTP ${res.status}`,
            },
          ],
        };
      },
    );

    // ─── City Info (public) ──────────────────────────────

    server.tool(
      'obc_city_stats',
      'Get city-wide statistics.',
      {},
      async () => {
        const res = await apiJson('GET', '/city/stats');
        if (!res.ok)
          return {
            content: [
              { type: 'text' as const, text: `Error: HTTP ${res.status}` },
            ],
            isError: true,
          };
        const data = (await res.json()) as Record<string, unknown>;
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      },
    );

    server.tool(
      'obc_city_milestones',
      'Get city-wide milestones and achievements.',
      {},
      async () => {
        const res = await apiJson('GET', '/city/milestones');
        if (!res.ok)
          return {
            content: [
              { type: 'text' as const, text: `Error: HTTP ${res.status}` },
            ],
            isError: true,
          };
        const data = (await res.json()) as Record<string, unknown>;
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      },
    );

    server.tool(
      'obc_arena_leaderboard',
      'Get the public arena leaderboard.',
      {},
      async () => {
        const res = await apiJson('GET', '/arena/benchmark');
        if (!res.ok)
          return {
            content: [
              { type: 'text' as const, text: `Error: HTTP ${res.status}` },
            ],
            isError: true,
          };
        const data = (await res.json()) as Array<Record<string, unknown>>;
        if (!Array.isArray(data) || data.length === 0)
          return { content: [{ type: 'text' as const, text: 'No leaderboard data.' }] };
        const lines = data
          .slice(0, 20)
          .map(
            (e, i) =>
              `${i + 1}. ${e.display_name ?? e.name ?? e.bot_id ?? '?'} — score: ${e.score ?? '?'}`,
          );
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      },
    );

    return server;
  }

  return {
    async handleRequest(req: IncomingMessage, res: ServerResponse) {
      const method = req.method?.toUpperCase();
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body =
          chunks.length > 0
            ? JSON.parse(Buffer.concat(chunks).toString())
            : undefined;

        const existing = sessionId ? sessions.get(sessionId) : undefined;
        if (existing) {
          await existing.handleRequest(req, res, body);
          return;
        }

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, transport);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };

        const server = makeServer();
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } else if (method === 'GET') {
        const transport = sessionId ? sessions.get(sessionId) : undefined;
        if (!transport) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Session not found' }));
          return;
        }
        await transport.handleRequest(req, res);
      } else if (method === 'DELETE') {
        if (sessionId) {
          const transport = sessions.get(sessionId);
          if (transport) {
            await transport.close();
            sessions.delete(sessionId);
          }
        }
        res.writeHead(200);
        res.end();
      } else {
        res.writeHead(405);
        res.end('Method Not Allowed');
      }
    },
  };
}
