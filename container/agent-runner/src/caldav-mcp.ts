/**
 * CalDAV MCP Server for NanoClaw
 * Provides calendar read/write tools to the agent.
 * Credentials are injected via environment variables by the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createDAVClient, DAVCalendar, DAVCalendarObject } from 'tsdav';
import pkg from 'rrule';
const { rrulestr } = pkg;
import { z } from 'zod';

const CALDAV_URL = process.env.CALDAV_URL!;
const CALDAV_USERNAME = process.env.CALDAV_USERNAME!;
const CALDAV_PASSWORD = process.env.CALDAV_PASSWORD!;
const TIMEZONE = process.env.TZ || 'Europe/Amsterdam';

function formatLocalDate(isoOrRaw: string): string {
  if (!isoOrRaw) return '';
  // All-day events (YYYY-MM-DD) — no conversion needed
  if (/^\d{4}-\d{2}-\d{2}$/.test(isoOrRaw)) return isoOrRaw;
  try {
    const d = new Date(isoOrRaw);
    if (isNaN(d.getTime())) return isoOrRaw;
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: TIMEZONE,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
      hour12: false,
    }).formatToParts(d);
    const p: Record<string, string> = {};
    for (const part of parts) p[part.type] = part.value;
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
  } catch {
    return isoOrRaw;
  }
}

// Simple iCal field parser — extracts top-level properties and VEVENT blocks
function parseIcalField(ical: string, field: string): string {
  const match = ical.match(new RegExp(`(?:^|\\n)${field}(?:;[^:]*)?:([^\\r\\n]*)`, 'm'));
  return match ? match[1].trim() : '';
}

function parseIcalDate(value: string): string {
  if (!value) return '';
  // Handle VALUE=DATE (date only) and TZID formats
  const clean = value.replace(/^TZID=[^:]+:/, '');
  if (/^\d{8}$/.test(clean)) {
    return `${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}`;
  }
  if (/^\d{8}T\d{6}Z?$/.test(clean)) {
    return `${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}T${clean.slice(9, 11)}:${clean.slice(11, 13)}:${clean.slice(13, 15)}${clean.endsWith('Z') ? 'Z' : ''}`;
  }
  return clean;
}

interface CalEvent {
  uid: string;
  summary: string;
  start: string;
  end: string;
  description: string;
  location: string;
  url?: string;
  isRecurring?: boolean;
}

function parseVEvents(icalStr: string, rangeStart?: Date, rangeEnd?: Date): CalEvent[] {
  const events: CalEvent[] = [];
  const eventBlocks = icalStr.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];
  for (const block of eventBlocks) {
    // Handle folded lines (lines continued with a space/tab)
    const unfolded = block.replace(/\r?\n[ \t]/g, '');

    const rawStart = unfolded.match(/DTSTART(?:;[^:]*)?:([^\r\n]*)/m)?.[1] || '';
    const rawEnd = unfolded.match(/DTEND(?:;[^:]*)?:([^\r\n]*)/m)?.[1] || '';
    const rruleStr = parseIcalField(unfolded, 'RRULE');
    const uid = parseIcalField(unfolded, 'UID');
    const summary = parseIcalField(unfolded, 'SUMMARY');
    const description = parseIcalField(unfolded, 'DESCRIPTION').replace(/\\n/g, '\n').replace(/\\,/g, ',');
    const location = parseIcalField(unfolded, 'LOCATION');

    if (rruleStr && rangeStart && rangeEnd) {
      // Expand recurring event — find occurrences within the queried range
      try {
        const dtstart = parseIcalDate(rawStart);
        const originalStart = new Date(dtstart);
        const duration = rawEnd
          ? new Date(parseIcalDate(rawEnd)).getTime() - originalStart.getTime()
          : 0;

        const rule = rrulestr(`DTSTART:${rawStart}\nRRULE:${rruleStr}`);
        const occurrences = rule.between(rangeStart, rangeEnd, true);

        for (const occ of occurrences) {
          const occEnd = duration > 0 ? new Date(occ.getTime() + duration) : occ;
          events.push({
            uid,
            summary,
            start: occ.toISOString(),
            end: occEnd.toISOString(),
            description,
            location,
            isRecurring: true,
          });
        }
        continue;
      } catch {
        // Fall through to plain parse if rrule expansion fails
      }
    }

    events.push({
      uid,
      summary,
      start: parseIcalDate(rawStart),
      end: parseIcalDate(rawEnd),
      description,
      location,
      isRecurring: !!rruleStr,
    });
  }
  return events;
}

function formatIcalDate(iso: string): string {
  // Convert ISO date/datetime to iCal format
  const clean = iso.replace(/[-:]/g, '');
  if (clean.includes('T')) return clean.replace('Z', '') + (iso.endsWith('Z') ? 'Z' : '');
  return clean.slice(0, 8);
}

function generateIcal(event: {
  uid: string;
  summary: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
}): string {
  const now = new Date().toISOString().replace(/[-:]/g, '').replace('.', '').slice(0, 15) + 'Z';
  const isAllDay = !event.start.includes('T');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//NanoClaw//CalDAV MCP//EN',
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    `DTSTAMP:${now}`,
    isAllDay ? `DTSTART;VALUE=DATE:${formatIcalDate(event.start)}` : `DTSTART:${formatIcalDate(event.start)}`,
    isAllDay ? `DTEND;VALUE=DATE:${formatIcalDate(event.end)}` : `DTEND:${formatIcalDate(event.end)}`,
    `SUMMARY:${event.summary}`,
  ];
  if (event.description) lines.push(`DESCRIPTION:${event.description.replace(/\n/g, '\\n')}`);
  if (event.location) lines.push(`LOCATION:${event.location}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n');
}

async function getClient() {
  return createDAVClient({
    serverUrl: CALDAV_URL,
    credentials: { username: CALDAV_USERNAME, password: CALDAV_PASSWORD },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
  });
}

const server = new McpServer({ name: 'caldav', version: '1.0.0' });

server.tool(
  'list_calendars',
  'List all available calendars on the CalDAV server.',
  {},
  async () => {
    try {
      const client = await getClient();
      const calendars: DAVCalendar[] = await client.fetchCalendars();
      if (calendars.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No calendars found.' }] };
      }
      const list = calendars
        .map((c) => `- ${c.displayName || '(unnamed)'} [${c.url}]`)
        .join('\n');
      return { content: [{ type: 'text' as const, text: `Calendars:\n${list}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'get_events',
  'Get calendar events within a date range. The range is half-open [start, end) — end is exclusive. To get all events on a single day, set start=that day and end=next day (e.g. start=2026-03-13, end=2026-03-14). Dates should be ISO format (e.g. 2026-03-13 or 2026-03-13T09:00:00Z).',
  {
    start: z.string().describe('Start of range (ISO date/datetime)'),
    end: z.string().describe('End of range (ISO date/datetime)'),
    calendar_url: z.string().optional().describe('Specific calendar URL (omit to search all calendars)'),
  },
  async (args) => {
    try {
      const client = await getClient();
      const calendars: DAVCalendar[] = args.calendar_url
        ? [{ url: args.calendar_url } as DAVCalendar]
        : await client.fetchCalendars();

      const startDate = new Date(args.start);
      const endDate = new Date(args.end);
      const allEvents: (CalEvent & { calendar: string })[] = [];

      for (const cal of calendars) {
        const objects: DAVCalendarObject[] = await client.fetchCalendarObjects({
          calendar: cal,
          timeRange: { start: startDate.toISOString(), end: endDate.toISOString() },
        });
        for (const obj of objects) {
          if (!obj.data) continue;
          const events = parseVEvents(obj.data, startDate, endDate);
          for (const ev of events) {
            allEvents.push({ ...ev, calendar: String(cal.displayName || cal.url || '') });
          }
        }
      }

      if (allEvents.length === 0) {
        return { content: [{ type: 'text' as const, text: `No events found between ${args.start} and ${args.end}.` }] };
      }

      allEvents.sort((a, b) => a.start.localeCompare(b.start));
      const formatted = allEvents.map((e) => {
        const start = formatLocalDate(e.start);
        const end = formatLocalDate(e.end);
        let line = `• ${start}${end ? ` → ${end}` : ''}: ${e.summary}${e.isRecurring ? ' (recurring)' : ''}`;
        if (e.location) line += ` @ ${e.location}`;
        if (e.description) line += `\n  ${e.description.slice(0, 100)}`;
        line += `\n  [UID: ${e.uid}] [Calendar: ${e.calendar}]`;
        return line;
      }).join('\n\n');

      return { content: [{ type: 'text' as const, text: `${allEvents.length} event(s):\n\n${formatted}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'create_event',
  'Create a new calendar event.',
  {
    calendar_url: z.string().describe('URL of the calendar to add the event to'),
    summary: z.string().describe('Event title'),
    start: z.string().describe('Start date/time in ISO format (e.g. 2026-03-15T10:00:00Z or 2026-03-15 for all-day)'),
    end: z.string().describe('End date/time in ISO format (e.g. 2026-03-15T11:00:00Z or 2026-03-16 for all-day)'),
    description: z.string().optional().describe('Event description/notes'),
    location: z.string().optional().describe('Event location'),
  },
  async (args) => {
    try {
      const client = await getClient();
      const uid = `nanoclaw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@nanoclaw`;
      const ical = generateIcal({
        uid,
        summary: args.summary,
        start: args.start,
        end: args.end,
        description: args.description,
        location: args.location,
      });

      await client.createCalendarObject({
        calendar: { url: args.calendar_url } as DAVCalendar,
        filename: `${uid}.ics`,
        iCalString: ical,
      });

      return { content: [{ type: 'text' as const, text: `Event "${args.summary}" created (UID: ${uid}).` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'update_event',
  'Update an existing calendar event. Fetch the event first with get_events to get its UID.',
  {
    calendar_url: z.string().describe('URL of the calendar containing the event'),
    uid: z.string().describe('UID of the event to update'),
    summary: z.string().optional().describe('New event title'),
    start: z.string().optional().describe('New start date/time (ISO format)'),
    end: z.string().optional().describe('New end date/time (ISO format)'),
    description: z.string().optional().describe('New description'),
    location: z.string().optional().describe('New location'),
  },
  async (args) => {
    try {
      const client = await getClient();
      const calendars: DAVCalendarObject[] = await client.fetchCalendarObjects({
        calendar: { url: args.calendar_url } as DAVCalendar,
      });

      const existing = calendars.find((obj) => obj.data && obj.data.includes(`UID:${args.uid}`));
      if (!existing) {
        return { content: [{ type: 'text' as const, text: `Event with UID "${args.uid}" not found.` }], isError: true };
      }

      const current = parseVEvents(existing.data || '')[0];
      if (!current) {
        return { content: [{ type: 'text' as const, text: 'Failed to parse existing event.' }], isError: true };
      }

      const updated = {
        uid: args.uid,
        summary: args.summary ?? current.summary,
        start: args.start ?? current.start,
        end: args.end ?? current.end,
        description: args.description ?? current.description,
        location: args.location ?? current.location,
      };

      await client.updateCalendarObject({
        calendarObject: { ...existing, data: generateIcal(updated) },
      });

      return { content: [{ type: 'text' as const, text: `Event "${updated.summary}" updated.` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'delete_event',
  'Delete a calendar event by UID.',
  {
    calendar_url: z.string().describe('URL of the calendar containing the event'),
    uid: z.string().describe('UID of the event to delete'),
  },
  async (args) => {
    try {
      const client = await getClient();
      const objects: DAVCalendarObject[] = await client.fetchCalendarObjects({
        calendar: { url: args.calendar_url } as DAVCalendar,
      });

      const target = objects.find((obj) => obj.data && obj.data.includes(`UID:${args.uid}`));
      if (!target) {
        return { content: [{ type: 'text' as const, text: `Event with UID "${args.uid}" not found.` }], isError: true };
      }

      await client.deleteCalendarObject({ calendarObject: target });

      return { content: [{ type: 'text' as const, text: `Event deleted.` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
