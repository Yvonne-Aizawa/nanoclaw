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
            content: [{ type: 'text' as const, text: `Error: HTTP ${res.status}` }],
            isError: true,
          };
        }
        const me = (await res.json()) as Record<string, unknown>;
        const parts: string[] = [];
        if (me.x !== undefined && me.y !== undefined) parts.push(`Position: ${me.x},${me.y}`);
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
          content: [{ type: 'text' as const, text: parts.join('\n') || JSON.stringify(me) }],
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
              text: res.ok ? `Moved to ${x},${y}.` : `Error: HTTP ${res.status}`,
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

    server.tool(
      'obc_leave',
      'Leave the current building.',
      {},
      async () => {
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
      },
    );

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
              text: res.ok ? 'Artifact published.' : `Error: HTTP ${res.status}`,
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
