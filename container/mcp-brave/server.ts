/**
 * Brave Search MCP Server for NanoClaw
 * Provides brave_web_search tool over StreamableHTTP transport.
 * BRAVE_API_KEY is injected via environment — never passed to the agent container.
 */

import { randomUUID } from 'crypto';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
if (!BRAVE_API_KEY) {
  console.error('BRAVE_API_KEY is required');
  process.exit(1);
}

const PORT = 7701;

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
          'X-Subscription-Token': BRAVE_API_KEY!,
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
        web?: { results?: { title: string; url: string; description?: string }[] };
      };
      const results = data.web?.results ?? [];

      if (results.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No results found.' }] };
      }

      const formatted = results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description ?? ''}`)
        .join('\n\n');

      return { content: [{ type: 'text' as const, text: formatted }] };
    },
  );

  return server;
}

const app = express();
app.use(express.json());

// Session ID → transport map for stateful sessions
const transports = new Map<string, StreamableHTTPServerTransport>();

app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  const existing = sessionId ? transports.get(sessionId) : undefined;

  if (existing) {
    await existing.handleRequest(req, res, req.body);
    return;
  }

  // New session
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      transports.set(id, transport);
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) transports.delete(transport.sessionId);
  };

  const server = createServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  await transport.handleRequest(req, res);
});

app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (sessionId) {
    const transport = transports.get(sessionId);
    if (transport) {
      await transport.close();
      transports.delete(sessionId);
    }
  }
  res.status(200).send();
});

app.listen(PORT, () => {
  console.log(`Brave MCP server listening on port ${PORT}`);
});
