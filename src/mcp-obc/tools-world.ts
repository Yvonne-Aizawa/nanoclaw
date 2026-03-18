import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { ApiJson, readBuildingSessionId, writeBuildingSessionId } from './shared.js';

export function registerWorldTools(
  server: McpServer,
  apiJson: ApiJson,
  groupFolder: string,
): void {
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
        .string()
        .describe(
          'Building UUID (from obc_get_heartbeat recent_events or obc_get_position)',
        ),
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
}
