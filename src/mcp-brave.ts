/**
 * Brave Search MCP server — runs in-process on the host.
 * Secrets stay in the host process and are never visible to agent containers.
 */

import { randomUUID } from 'crypto';
import { IncomingMessage, ServerResponse } from 'http';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export interface InProcessMcpHandler {
  handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

export function createBraveHandler(token: string): InProcessMcpHandler {
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  function createServer(): McpServer {
    const server = new McpServer({ name: 'brave', version: '1.0.0' });

    server.tool(
      'brave_web_search',
      'Search the web using Brave Search. Returns titles, URLs, and descriptions.',
      {
        query: z.string().describe('Search query'),
        count: z
          .number()
          .optional()
          .describe('Number of results to return (1–20, default 10)'),
      },
      async ({ query, count = 10 }) => {
        const url = new URL('https://api.search.brave.com/res/v1/web/search');
        url.searchParams.set('q', query);
        url.searchParams.set('count', String(Math.min(count, 20)));

        const res = await fetch(url.toString(), {
          headers: {
            Accept: 'application/json',
            'Accept-Encoding': 'gzip',
            'X-Subscription-Token': token,
          },
        });

        if (!res.ok) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Brave Search error: ${res.status} ${res.statusText}`,
              },
            ],
            isError: true,
          };
        }

        const data = (await res.json()) as {
          web?: {
            results?: { title: string; url: string; description?: string }[];
          };
        };
        const results = data.web?.results ?? [];

        if (results.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No results found.' }],
          };
        }

        const formatted = results
          .map(
            (r, i) =>
              `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description ?? ''}`,
          )
          .join('\n\n');

        return { content: [{ type: 'text' as const, text: formatted }] };
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

        const server = createServer();
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
