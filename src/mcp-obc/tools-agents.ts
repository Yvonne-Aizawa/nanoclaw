import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { ApiJson } from './shared.js';

export function registerAgentTools(server: McpServer, apiJson: ApiJson): void {
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
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(data, null, 2) },
        ],
      };
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
        return {
          content: [{ type: 'text' as const, text: 'No nearby bots.' }],
        };
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
              {
                type: 'text' as const,
                text: `Error fetching own ID: HTTP ${me.status}`,
              },
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
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(data, null, 2) },
        ],
      };
    },
  );

  // ─── World & Navigation ──────────────────────────────

  server.tool(
    'obc_get_heartbeat',
    'Get the current city context: bulletin, quests, nearby agents, mission, trending artifacts, and your location.',
    {},
    async () => {
      const res = await apiJson('GET', '/world/heartbeat');
      if (!res.ok)
        return {
          content: [
            { type: 'text' as const, text: `Error: HTTP ${res.status}` },
          ],
          isError: true,
        };
      const data = (await res.json()) as Record<string, unknown>;
      const lines: string[] = ['[City Context]'];
      if (data.city_bulletin) lines.push(`Bulletin: ${data.city_bulletin}`);
      if (data.owner_mission) {
        const m = data.owner_mission as Record<string, unknown>;
        lines.push(
          `Mission: ${m.description ?? ''} (focus: ${m.focus_type ?? '?'})`,
        );
      }
      if (data.location) {
        const l = data.location as Record<string, unknown>;
        lines.push(`Location: ${l.zone_name ?? l.zoneName ?? '?'}`);
      }
      if (
        Array.isArray(data.needs_attention) &&
        data.needs_attention.length > 0
      ) {
        lines.push('Needs attention:');
        for (const item of (
          data.needs_attention as Array<Record<string, unknown>>
        ).slice(0, 10))
          lines.push(
            `  - ${item.type ?? '?'}: ${item.summary ?? item.from ?? ''}`,
          );
      }
      if (
        Array.isArray(data.active_quests) &&
        data.active_quests.length > 0
      ) {
        const titles = (data.active_quests as Array<Record<string, unknown>>)
          .slice(0, 5)
          .map((q) => q.title ?? '?');
        lines.push(`Active quests: ${titles.join(', ')}`);
      }
      if (
        Array.isArray(data.trending_artifacts) &&
        data.trending_artifacts.length > 0
      ) {
        const trending = (
          data.trending_artifacts as Array<Record<string, unknown>>
        )
          .slice(0, 3)
          .map((a) => `"${a.title ?? '?'}" by ${a.creator_name ?? '?'}`);
        lines.push(`Trending: ${trending.join(', ')}`);
      }
      // Extract building IDs from recent_events so the agent can use obc_enter
      if (Array.isArray(data.recent_events)) {
        const buildings = new Map<string, string>();
        for (const e of data.recent_events as Array<
          Record<string, unknown>
        >) {
          const p = e.payload as Record<string, unknown> | undefined;
          if (p?.building_id) {
            buildings.set(
              String(p.building_id),
              String(p.building_type ?? 'unknown'),
            );
          }
        }
        if (buildings.size > 0) {
          lines.push('\nNearby building IDs (from recent activity):');
          for (const [id, type] of buildings) lines.push(`  ${type}: ${id}`);
        }
      }
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

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
            text: res.ok
              ? `Transferred to zone ${zone_id}.`
              : `Error: HTTP ${res.status}`,
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
        return {
          content: [{ type: 'text' as const, text: 'No zones found.' }],
        };
      const lines = data.map((z) =>
        `[${z.id}] ${z.name ?? z.zone_name ?? '?'} — ${z.description ?? ''}`.trim(),
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
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(data, null, 2) },
        ],
      };
    },
  );
}
