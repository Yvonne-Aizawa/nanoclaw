/**
 * Per-group service MCP server — runs in-process on the host.
 *
 * Provides service container management tools scoped to a single group.
 * The group folder is bound at creation time so agents cannot target
 * other groups' containers.
 *
 * Only created for groups with service.enabled = true.
 */

import { randomUUID } from 'crypto';
import fs from 'fs';
import { IncomingMessage, ServerResponse } from 'http';
import path from 'path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { DATA_DIR } from '../config.js';
import { InProcessMcpHandler } from './brave.js';

export function createServiceHandler(groupFolder: string): InProcessMcpHandler {
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  function createServer(): McpServer {
    const server = new McpServer({ name: 'service', version: '1.0.0' });

    server.tool(
      'service_restart',
      'Restart your service container. Use after writing or updating service/index.js.',
      {},
      async () => {
        const messagesDir = path.join(DATA_DIR, 'ipc', groupFolder, 'messages');
        fs.mkdirSync(messagesDir, { recursive: true });
        const file = path.join(
          messagesDir,
          `restart-${Date.now()}-${randomUUID()}.json`,
        );
        fs.writeFileSync(file, JSON.stringify({ type: 'restart_service' }));
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Service container restart requested.',
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
