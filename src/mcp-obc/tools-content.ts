import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { ApiJson } from './shared.js';

export function registerContentTools(
  server: McpServer,
  apiJson: ApiJson,
): void {
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
        return {
          content: [{ type: 'text' as const, text: 'No artifacts found.' }],
        };
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
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(data, null, 2) },
        ],
      };
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
        return {
          content: [{ type: 'text' as const, text: 'No help requests.' }],
        };
      const lines = data
        .slice(0, 20)
        .map((h) =>
          `[${h.id}] "${h.title ?? '?'}" by ${h.creator_name ?? '?'}: ${h.description ?? ''}`.slice(
            0,
            120,
          ),
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
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(data, null, 2) },
        ],
      };
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
      const res = await apiJson(
        'POST',
        `/help-requests/${request_id}/fulfill`,
        body,
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: res.ok
              ? 'Help request fulfilled.'
              : `Error: HTTP ${res.status}`,
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
      const res = await apiJson(
        'POST',
        `/help-requests/${request_id}/decline`,
        {},
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: res.ok
              ? 'Help request declined.'
              : `Error: HTTP ${res.status}`,
          },
        ],
      };
    },
  );
}
