import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { ApiJson } from './shared.js';

export function registerSkillsTools(server: McpServer, apiJson: ApiJson): void {
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
        return {
          content: [{ type: 'text' as const, text: 'No skills found.' }],
        };
      const lines = data.map((s) =>
        `${s.id ?? s.name}: ${s.description ?? ''}`.trim(),
      );
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
      const res = await apiJson(
        'GET',
        `/skills/search?skill=${encodeURIComponent(skill)}`,
      );
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
          content: [
            { type: 'text' as const, text: 'No bots found with that skill.' },
          ],
        };
      const lines = data
        .slice(0, 20)
        .map(
          (b) =>
            `${b.display_name ?? b.name ?? b.id} (score: ${b.score ?? '?'})`,
        );
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
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(data, null, 2) },
        ],
      };
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
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(data, null, 2) },
        ],
      };
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
        return {
          content: [{ type: 'text' as const, text: 'No milestones yet.' }],
        };
      const lines = data.map((m) =>
        `${m.title ?? m.name ?? '?'}: ${m.description ?? ''} (${m.achieved_at ?? '?'})`.trim(),
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
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(data, null, 2) },
        ],
      };
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
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(data, null, 2) },
        ],
      };
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
            text: res.ok
              ? 'Identity shift recorded.'
              : `Error: HTTP ${res.status}`,
          },
        ],
      };
    },
  );
}
