import { randomUUID } from 'crypto';
import { IncomingMessage, ServerResponse } from 'http';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { logger } from '../logger.js';
import { InProcessMcpHandler } from '../mcp-brave.js';
import { hasObcToken, makeApiJson, readToken } from './shared.js';
import { registerAgentTools } from './tools-agents.js';
import { registerBuildingSocialTools } from './tools-buildings.js';
import { registerContentTools } from './tools-content.js';
import { registerQuestsFeedTools } from './tools-quests-feed.js';
import { registerSkillsTools } from './tools-skills.js';
import { registerWorldTools } from './tools-world.js';

export { hasObcToken };

export function createObcHandler(groupFolder: string): InProcessMcpHandler {
  const token = readToken(groupFolder);
  if (!token) {
    logger.warn({ groupFolder }, 'OBC MCP: no token found in secrets dir');
  }

  const apiJson = makeApiJson(token);

  const sessions = new Map<string, StreamableHTTPServerTransport>();

  function makeServer(): McpServer {
    const server = new McpServer({ name: 'obc', version: '1.0.0' });

    registerWorldTools(server, apiJson, groupFolder);
    registerAgentTools(server, apiJson);
    registerBuildingSocialTools(server, apiJson);
    registerContentTools(server, apiJson);
    registerSkillsTools(server, apiJson);
    registerQuestsFeedTools(server, apiJson);

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
