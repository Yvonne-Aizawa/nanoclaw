/**
 * Utility MCP server — runs in-process on the host.
 * Provides general-purpose tools available to all agents.
 */

import { randomUUID } from 'crypto';
import { IncomingMessage, ServerResponse } from 'http';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import { InProcessMcpHandler } from './mcp-brave.js';

const MAX_WAIT_SECONDS = 300;

export function createUtilsHandler(): InProcessMcpHandler {
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  function createServer(): McpServer {
    const server = new McpServer({ name: 'utils', version: '1.0.0' });

    server.tool(
      'wait',
      `Wait for a specified number of seconds (max ${MAX_WAIT_SECONDS}) before continuing.`,
      {
        seconds: z
          .number()
          .min(1)
          .max(MAX_WAIT_SECONDS)
          .describe(`Number of seconds to wait (1–${MAX_WAIT_SECONDS})`),
      },
      async ({ seconds }) => {
        const clamped = Math.min(
          Math.max(Math.round(seconds), 1),
          MAX_WAIT_SECONDS,
        );
        await new Promise<void>((resolve) =>
          setTimeout(resolve, clamped * 1000),
        );
        return {
          content: [
            { type: 'text' as const, text: `Waited ${clamped} seconds.` },
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
