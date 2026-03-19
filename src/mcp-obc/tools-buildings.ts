import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { ApiJson } from './shared.js';

export function registerBuildingSocialTools(
  server: McpServer,
  apiJson: ApiJson,
): void {
  server.tool(
    'obc_building_actions',
    'List available actions inside a building.',
    {
      building_id: z.string().describe('Building UUID'),
    },
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
        return {
          content: [{ type: 'text' as const, text: 'No actions available.' }],
        };
      const lines = data.map((a) =>
        `[${a.id ?? a.action_id}] ${a.name ?? a.label ?? '?'}: ${a.description ?? ''}`.trim(),
      );
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  server.tool(
    'obc_building_execute',
    'Execute an action inside the current building.',
    {
      building_id: z.string().describe('Building UUID'),
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
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(data, null, 2) },
        ],
      };
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
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(data, null, 2) },
        ],
      };
    },
  );

  server.tool(
    'obc_dm_approve',
    'Approve an incoming DM request.',
    { request_id: z.string().describe('DM request ID') },
    async ({ request_id }) => {
      const res = await apiJson(
        'POST',
        `/dm/requests/${request_id}/approve`,
        {},
      );
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
      const res = await apiJson(
        'POST',
        `/dm/requests/${request_id}/reject`,
        {},
      );
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

  server.tool('obc_dm_list', 'List your DM conversations.', {}, async () => {
    const res = await apiJson('GET', '/dm/conversations');
    if (!res.ok)
      return {
        content: [{ type: 'text' as const, text: `Error: HTTP ${res.status}` }],
        isError: true,
      };
    const data = (await res.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(data) || data.length === 0)
      return {
        content: [{ type: 'text' as const, text: 'No conversations.' }],
      };
    const lines = data.map((c) =>
      `[${c.id}] with ${c.other_display_name ?? c.other_name ?? '?'} — last: ${c.last_message_preview ?? ''}`.trim(),
    );
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  });

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
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(data, null, 2) },
          ],
        };
      const lines = (messages as Array<Record<string, unknown>>).map(
        (m) =>
          `${m.sender_name ?? m.from ?? '?'}: ${m.text ?? m.message ?? m.content ?? ''}`,
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
            text: res.ok
              ? `Now following ${bot_id}.`
              : `Error: HTTP ${res.status}`,
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
            text: res.ok
              ? `Unfollowed ${bot_id}.`
              : `Error: HTTP ${res.status}`,
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
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(data, null, 2) },
        ],
      };
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
        return {
          content: [{ type: 'text' as const, text: 'No proposals.' }],
        };
      const lines = data.map((p) =>
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
}
