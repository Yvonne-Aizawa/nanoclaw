/**
 * Email MCP server — runs in-process on the host.
 * Credentials stay in the host process and are never visible to agent containers.
 * Supports IMAP (read, search, move, delete) and SMTP (send).
 */

import { randomUUID } from 'crypto';
import { IncomingMessage, ServerResponse } from 'http';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ImapFlow, MessageAddressObject } from 'imapflow';
import nodemailer from 'nodemailer';
import { z } from 'zod';

import { InProcessMcpHandler } from './brave.js';

export interface EmailImapConfig {
  host: string;
  port?: number;
  tls?: boolean;
  username: string;
  password: string;
}

export interface EmailSmtpConfig {
  host: string;
  port?: number;
  secure?: boolean;
  username: string;
  password: string;
  /** Display name and address used in From header, e.g. "Alice <alice@example.com>" */
  from: string;
}

export interface EmailConfig {
  imap?: EmailImapConfig;
  smtp?: EmailSmtpConfig;
}

function makeImap(cfg: EmailImapConfig): ImapFlow {
  return new ImapFlow({
    host: cfg.host,
    port: cfg.port ?? 993,
    secure: cfg.tls !== false,
    auth: { user: cfg.username, pass: cfg.password },
    tls: { rejectUnauthorized: false },
    logger: false,
  });
}

function makeTransport(cfg: EmailSmtpConfig) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port ?? 587,
    secure: cfg.secure ?? false,
    auth: { user: cfg.username, pass: cfg.password },
    tls: { rejectUnauthorized: false },
  });
}

function formatAddress(a: MessageAddressObject): string {
  return a.name ? `${a.name} <${a.address ?? ''}>` : (a.address ?? '(unknown)');
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createEmailHandler(config: EmailConfig): InProcessMcpHandler {
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  function createServer(): McpServer {
    const server = new McpServer({ name: 'email', version: '1.0.0' });

    // ── IMAP tools ──────────────────────────────────────────────────────────

    if (config.imap) {
      const imapCfg = config.imap;

      server.tool(
        'email_list_folders',
        'List all IMAP mailbox folders.',
        {},
        async () => {
          const client = makeImap(imapCfg);
          try {
            await client.connect();
            const folders = await client.list();
            return {
              content: [
                {
                  type: 'text' as const,
                  text: folders.length
                    ? `Folders:\n${folders.map((f) => `- ${f.path}`).join('\n')}`
                    : 'No folders found.',
                },
              ],
            };
          } catch (e) {
            return {
              content: [{ type: 'text' as const, text: `Error: ${errMsg(e)}` }],
              isError: true,
            };
          } finally {
            await client.logout().catch(() => {});
          }
        },
      );

      server.tool(
        'email_list',
        'List emails in a mailbox folder. Returns uid, from, subject, date, and whether it is read.',
        {
          folder: z
            .string()
            .default('INBOX')
            .describe('Mailbox folder (default: INBOX)'),
          limit: z
            .number()
            .int()
            .min(1)
            .max(100)
            .default(20)
            .describe('Max messages to return (1–100)'),
          offset: z
            .number()
            .int()
            .min(0)
            .default(0)
            .describe('Skip this many messages from newest'),
          unread_only: z
            .boolean()
            .default(false)
            .describe('Only return unread messages'),
        },
        async (args) => {
          const client = makeImap(imapCfg);
          try {
            await client.connect();
            const lock = await client.getMailboxLock(args.folder);
            try {
              const query = args.unread_only
                ? { seen: false }
                : { all: true as const };
              const result = await client.search(query, { uid: true });
              const uids = result === false ? [] : result;
              const end = uids.length - args.offset;
              const slice = uids.slice(Math.max(0, end - args.limit), end);
              slice.reverse();

              if (slice.length === 0) {
                return {
                  content: [
                    { type: 'text' as const, text: 'No messages found.' },
                  ],
                };
              }

              const rows: string[] = [];
              for await (const msg of client.fetch(
                slice,
                { envelope: true, flags: true },
                { uid: true },
              )) {
                const from = msg.envelope?.from?.[0];
                const fromStr = from ? formatAddress(from) : '(unknown)';
                const isRead = msg.flags?.has('\\Seen') ?? false;
                rows.push(
                  `[${msg.uid}] ${isRead ? '✓' : '●'} ${msg.envelope?.date?.toISOString().slice(0, 10) ?? '?'} | ${fromStr} | ${msg.envelope?.subject ?? '(no subject)'}`,
                );
              }

              return {
                content: [{ type: 'text' as const, text: rows.join('\n') }],
              };
            } finally {
              lock.release();
            }
          } catch (e) {
            return {
              content: [{ type: 'text' as const, text: `Error: ${errMsg(e)}` }],
              isError: true,
            };
          } finally {
            await client.logout().catch(() => {});
          }
        },
      );

      server.tool(
        'email_search',
        'Search emails by subject, sender, or body keyword.',
        {
          folder: z
            .string()
            .default('INBOX')
            .describe('Mailbox folder to search'),
          subject: z.string().optional().describe('Subject contains'),
          from: z
            .string()
            .optional()
            .describe('Sender address or name contains'),
          body: z.string().optional().describe('Body text contains'),
          since: z
            .string()
            .optional()
            .describe('Only emails since this date (ISO format)'),
          limit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .default(10)
            .describe('Max results'),
        },
        async (args) => {
          const client = makeImap(imapCfg);
          try {
            await client.connect();
            const lock = await client.getMailboxLock(args.folder);
            try {
              type SearchQuery = {
                subject?: string;
                from?: string;
                body?: string;
                since?: Date;
                all?: true;
              };
              const query: SearchQuery = {};
              if (args.subject) query.subject = args.subject;
              if (args.from) query.from = args.from;
              if (args.body) query.body = args.body;
              if (args.since) query.since = new Date(args.since);
              if (Object.keys(query).length === 0) query.all = true;

              const result = await client.search(query, { uid: true });
              const uids = result === false ? [] : result;
              const slice = uids.slice(-args.limit);
              slice.reverse();

              if (slice.length === 0) {
                return {
                  content: [
                    { type: 'text' as const, text: 'No matching messages.' },
                  ],
                };
              }

              const rows: string[] = [];
              for await (const msg of client.fetch(
                slice,
                { envelope: true, flags: true },
                { uid: true },
              )) {
                const from = msg.envelope?.from?.[0];
                const fromStr = from ? formatAddress(from) : '(unknown)';
                const isRead = msg.flags?.has('\\Seen') ?? false;
                rows.push(
                  `[${msg.uid}] ${isRead ? '✓' : '●'} ${msg.envelope?.date?.toISOString().slice(0, 10) ?? '?'} | ${fromStr} | ${msg.envelope?.subject ?? '(no subject)'}`,
                );
              }

              return {
                content: [{ type: 'text' as const, text: rows.join('\n') }],
              };
            } finally {
              lock.release();
            }
          } catch (e) {
            return {
              content: [{ type: 'text' as const, text: `Error: ${errMsg(e)}` }],
              isError: true,
            };
          } finally {
            await client.logout().catch(() => {});
          }
        },
      );

      server.tool(
        'email_read',
        'Read the full content of an email by its UID.',
        {
          folder: z.string().default('INBOX').describe('Mailbox folder'),
          uid: z.number().int().describe('UID of the message to read'),
          mark_read: z
            .boolean()
            .default(true)
            .describe('Mark message as read after fetching'),
        },
        async (args) => {
          const client = makeImap(imapCfg);
          try {
            await client.connect();
            const lock = await client.getMailboxLock(args.folder);
            try {
              const msgs: string[] = [];
              for await (const msg of client.fetch(
                [args.uid],
                { envelope: true, bodyParts: ['1', 'TEXT', '1.1', '1.2'] },
                { uid: true },
              )) {
                const fromAddr = msg.envelope?.from?.[0];
                const fromStr = fromAddr
                  ? formatAddress(fromAddr)
                  : '(unknown)';
                const toStr = (msg.envelope?.to ?? [])
                  .map(formatAddress)
                  .join(', ');

                let body = '';
                if (msg.bodyParts) {
                  for (const [, buf] of msg.bodyParts) {
                    body += buf.toString();
                  }
                }

                msgs.push(
                  [
                    `From: ${fromStr}`,
                    `To: ${toStr}`,
                    `Date: ${msg.envelope?.date?.toISOString() ?? '?'}`,
                    `Subject: ${msg.envelope?.subject ?? '(no subject)'}`,
                    '',
                    body.trim() || '(no body)',
                  ].join('\n'),
                );

                if (args.mark_read) {
                  await client.messageFlagsAdd([args.uid], ['\\Seen'], {
                    uid: true,
                  });
                }
              }

              if (msgs.length === 0) {
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: `Message UID ${args.uid} not found.`,
                    },
                  ],
                  isError: true,
                };
              }
              return { content: [{ type: 'text' as const, text: msgs[0] }] };
            } finally {
              lock.release();
            }
          } catch (e) {
            return {
              content: [{ type: 'text' as const, text: `Error: ${errMsg(e)}` }],
              isError: true,
            };
          } finally {
            await client.logout().catch(() => {});
          }
        },
      );

      server.tool(
        'email_move',
        'Move an email to another folder.',
        {
          folder: z.string().describe('Source folder'),
          uid: z.number().int().describe('UID of the message'),
          destination: z.string().describe('Destination folder'),
        },
        async (args) => {
          const client = makeImap(imapCfg);
          try {
            await client.connect();
            const lock = await client.getMailboxLock(args.folder);
            try {
              await client.messageMove([args.uid], args.destination, {
                uid: true,
              });
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Message moved to ${args.destination}.`,
                  },
                ],
              };
            } finally {
              lock.release();
            }
          } catch (e) {
            return {
              content: [{ type: 'text' as const, text: `Error: ${errMsg(e)}` }],
              isError: true,
            };
          } finally {
            await client.logout().catch(() => {});
          }
        },
      );

      server.tool(
        'email_delete',
        'Delete an email (moves to Trash or expunges if already in Trash).',
        {
          folder: z.string().default('INBOX').describe('Mailbox folder'),
          uid: z.number().int().describe('UID of the message to delete'),
        },
        async (args) => {
          const client = makeImap(imapCfg);
          try {
            await client.connect();
            const lock = await client.getMailboxLock(args.folder);
            try {
              await client.messageDelete([args.uid], { uid: true });
              return {
                content: [{ type: 'text' as const, text: 'Message deleted.' }],
              };
            } finally {
              lock.release();
            }
          } catch (e) {
            return {
              content: [{ type: 'text' as const, text: `Error: ${errMsg(e)}` }],
              isError: true,
            };
          } finally {
            await client.logout().catch(() => {});
          }
        },
      );

      server.tool(
        'email_mark',
        'Mark an email as read, unread, flagged, or unflagged.',
        {
          folder: z.string().default('INBOX').describe('Mailbox folder'),
          uid: z.number().int().describe('UID of the message'),
          mark: z
            .enum(['read', 'unread', 'flagged', 'unflagged'])
            .describe('Mark to apply'),
        },
        async (args) => {
          const client = makeImap(imapCfg);
          try {
            await client.connect();
            const lock = await client.getMailboxLock(args.folder);
            try {
              const flagMap: Record<string, [string, boolean]> = {
                read: ['\\Seen', true],
                unread: ['\\Seen', false],
                flagged: ['\\Flagged', true],
                unflagged: ['\\Flagged', false],
              };
              const [flag, add] = flagMap[args.mark];
              if (add) {
                await client.messageFlagsAdd([args.uid], [flag], { uid: true });
              } else {
                await client.messageFlagsRemove([args.uid], [flag], {
                  uid: true,
                });
              }
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Message marked as ${args.mark}.`,
                  },
                ],
              };
            } finally {
              lock.release();
            }
          } catch (e) {
            return {
              content: [{ type: 'text' as const, text: `Error: ${errMsg(e)}` }],
              isError: true,
            };
          } finally {
            await client.logout().catch(() => {});
          }
        },
      );
    }

    // ── SMTP tools ───────────────────────────────────────────────────────────

    if (config.smtp) {
      const smtpCfg = config.smtp;

      server.tool(
        'email_send',
        'Send an email via SMTP.',
        {
          to: z
            .string()
            .describe(
              'Recipient(s) — comma-separated addresses or "Name <addr>" format',
            ),
          subject: z.string().describe('Email subject'),
          body: z.string().describe('Plain-text body'),
          html: z
            .string()
            .optional()
            .describe('Optional HTML body (supplements plain-text)'),
          cc: z.string().optional().describe('CC recipients — comma-separated'),
          bcc: z
            .string()
            .optional()
            .describe('BCC recipients — comma-separated'),
          reply_to: z.string().optional().describe('Reply-To address'),
        },
        async (args) => {
          try {
            const transport = makeTransport(smtpCfg);
            const info = await transport.sendMail({
              from: smtpCfg.from,
              to: args.to,
              subject: args.subject,
              text: args.body,
              html: args.html,
              cc: args.cc,
              bcc: args.bcc,
              replyTo: args.reply_to,
            });
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Email sent. Message ID: ${info.messageId}`,
                },
              ],
            };
          } catch (e) {
            return {
              content: [{ type: 'text' as const, text: `Error: ${errMsg(e)}` }],
              isError: true,
            };
          }
        },
      );
    }

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

        const srv = createServer();
        await srv.connect(transport);
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
