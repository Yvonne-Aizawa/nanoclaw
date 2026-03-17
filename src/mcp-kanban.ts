/**
 * Kanban MCP server — runs in-process on the host.
 * Group isolation is enforced server-side: the group folder is bound at
 * handler creation time from the URL, not trusted from tool parameters.
 */

import { randomUUID } from 'crypto';
import { IncomingMessage, ServerResponse } from 'http';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import { InProcessMcpHandler } from './mcp-brave.js';
import {
  addKanbanCard,
  createKanbanColumn,
  deleteKanbanCard,
  deleteKanbanColumn,
  getKanbanBoard,
  moveKanbanCard,
  renameKanbanColumn,
  updateKanbanCard,
} from './db.js';

/**
 * Create a kanban handler bound to a specific group.
 * The group folder is set by the host — agents never supply it as a parameter.
 */
export function createKanbanHandler(groupFolder: string): InProcessMcpHandler {
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  function createServer(): McpServer {
    const server = new McpServer({ name: 'kanban', version: '1.0.0' });

    server.tool(
      'kanban_get_board',
      'Get the full Kanban board — all columns and cards in order.',
      {},
      async () => {
        const board = getKanbanBoard(groupFolder);
        const text = board.columns
          .map((col) => {
            const cards = col.cards.length
              ? col.cards
                  .map((c) => {
                    const pri = c.priority ? ` [${c.priority}]` : '';
                    const desc = c.description ? `: ${c.description}` : '';
                    return `  - [${c.id}]${pri} ${c.title}${desc}`;
                  })
                  .join('\n')
              : '  (empty)';
            return `## ${col.name} [${col.id}]\n${cards}`;
          })
          .join('\n\n');
        return {
          content: [{ type: 'text' as const, text: text || 'No columns yet.' }],
        };
      },
    );

    server.tool(
      'kanban_add_column',
      'Add a new column to the board at the end.',
      { name: z.string().describe('Column name') },
      async ({ name }) => {
        const col = createKanbanColumn(groupFolder, name);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Column "${col.name}" created (id: ${col.id}).`,
            },
          ],
        };
      },
    );

    server.tool(
      'kanban_rename_column',
      'Rename an existing column.',
      {
        column_id: z.string().describe('Column ID'),
        name: z.string().describe('New name'),
      },
      async ({ column_id, name }) => {
        renameKanbanColumn(column_id, groupFolder, name);
        return {
          content: [
            { type: 'text' as const, text: `Column renamed to "${name}".` },
          ],
        };
      },
    );

    server.tool(
      'kanban_delete_column',
      'Delete a column. Cards in the column are moved to the first remaining column. Deleting the last column also deletes all its cards.',
      {
        column_id: z.string().describe('Column ID to delete'),
      },
      async ({ column_id }) => {
        deleteKanbanColumn(column_id, groupFolder);
        return {
          content: [
            { type: 'text' as const, text: `Column ${column_id} deleted.` },
          ],
        };
      },
    );

    server.tool(
      'kanban_add_card',
      'Add a new card to a column.',
      {
        column_id: z.string().describe('Column ID to add the card to'),
        title: z.string().describe('Card title'),
        description: z.string().optional().describe('Optional description'),
        priority: z
          .enum(['high', 'medium', 'low'])
          .optional()
          .describe('Priority level'),
      },
      async ({ column_id, title, description, priority }) => {
        const card = addKanbanCard(
          groupFolder,
          column_id,
          title,
          description,
          priority,
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: `Card "${card.title}" added (id: ${card.id}).`,
            },
          ],
        };
      },
    );

    server.tool(
      'kanban_update_card',
      "Update a card's title, description, and/or priority.",
      {
        card_id: z.string().describe('Card ID'),
        title: z.string().optional().describe('New title'),
        description: z.string().optional().describe('New description'),
        priority: z
          .enum(['high', 'medium', 'low', 'none'])
          .optional()
          .describe('Priority level, or "none" to clear'),
      },
      async ({ card_id, title, description, priority }) => {
        const pri =
          priority === 'none'
            ? null
            : (priority as 'high' | 'medium' | 'low' | undefined);
        updateKanbanCard(card_id, groupFolder, title, description, pri);
        return {
          content: [
            { type: 'text' as const, text: `Card ${card_id} updated.` },
          ],
        };
      },
    );

    server.tool(
      'kanban_move_card',
      'Move a card to a different column, optionally at a specific position (0-based).',
      {
        card_id: z.string().describe('Card ID'),
        column_id: z.string().describe('Destination column ID'),
        position: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Position in column (0 = top). Omit to append.'),
      },
      async ({ card_id, column_id, position }) => {
        moveKanbanCard(card_id, groupFolder, column_id, position);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Card ${card_id} moved to column ${column_id}.`,
            },
          ],
        };
      },
    );

    server.tool(
      'kanban_delete_card',
      'Delete a card permanently.',
      {
        card_id: z.string().describe('Card ID'),
      },
      async ({ card_id }) => {
        deleteKanbanCard(card_id, groupFolder);
        return {
          content: [
            { type: 'text' as const, text: `Card ${card_id} deleted.` },
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
