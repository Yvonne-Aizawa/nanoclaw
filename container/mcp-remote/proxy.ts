/**
 * Remote MCP proxy for NanoClaw.
 *
 * Forwards requests to a remote MCP server and injects auth headers from env.
 * The agent container only sees a local URL — credentials never enter it.
 *
 * Required env:
 *   MCP_REMOTE_URL — URL of the upstream MCP server (e.g. https://api.example.com/mcp)
 *
 * Optional env:
 *   MCP_PORT              — local port to listen on (default 7700)
 *   MCP_HEADER_<Name>     — header to inject into every upstream request.
 *                           Underscores in <Name> become hyphens.
 *                           Examples:
 *                             MCP_HEADER_Authorization=Bearer sk-...
 *                             MCP_HEADER_X_Api_Key=secret
 */

import express, { Request, Response } from 'express';

const REMOTE_URL = process.env.MCP_REMOTE_URL;
const PORT = parseInt(process.env.MCP_PORT ?? '7700', 10);

if (!REMOTE_URL) {
  console.error('MCP_REMOTE_URL is required');
  process.exit(1);
}

// Collect injected headers from MCP_HEADER_* env vars
const injectedHeaders: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith('MCP_HEADER_') && v) {
    // MCP_HEADER_Authorization → Authorization
    // MCP_HEADER_X_Api_Key    → X-Api-Key
    const name = k.slice('MCP_HEADER_'.length).replace(/_/g, '-');
    injectedHeaders[name] = v;
  }
}

const injectedNames = new Set(
  Object.keys(injectedHeaders).map((h) => h.toLowerCase()),
);

console.log(
  `Remote proxy → ${REMOTE_URL} | injecting headers: ${Object.keys(injectedHeaders).join(', ') || '(none)'}`,
);

async function proxy(req: Request, res: Response): Promise<void> {
  const upstreamUrl = REMOTE_URL!;

  // Build upstream headers: start with injected auth headers, then add
  // pass-through headers from the agent (excluding any that would conflict).
  const headers: Record<string, string> = { ...injectedHeaders };

  const passThrough = ['content-type', 'accept', 'mcp-session-id'];
  for (const h of passThrough) {
    const val = req.headers[h];
    if (val && !injectedNames.has(h)) {
      headers[h] = Array.isArray(val) ? val.join(', ') : val;
    }
  }

  try {
    const init: RequestInit = { method: req.method, headers };
    if (req.method === 'POST') {
      init.body = JSON.stringify(req.body);
    }

    const upstream = await fetch(upstreamUrl, init);

    // Forward response headers that the MCP client needs
    const forward = ['content-type', 'mcp-session-id'];
    for (const h of forward) {
      const val = upstream.headers.get(h);
      if (val) res.setHeader(h, val);
    }

    const contentType = upstream.headers.get('content-type') ?? '';

    if (contentType.includes('text/event-stream')) {
      // Stream SSE through to the agent
      res.setHeader('Cache-Control', 'no-cache');
      const reader = upstream.body?.getReader();
      if (reader) {
        const dec = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(dec.decode(value, { stream: true }));
        }
      }
      res.end();
    } else {
      res.status(upstream.status).send(await upstream.text());
    }
  } catch (err) {
    res.status(502).json({
      jsonrpc: '2.0',
      error: { code: -32603, message: `Proxy error: ${String(err)}` },
      id: null,
    });
  }
}

const app = express();
app.use(express.json());

app.post('/mcp', (req, res) => void proxy(req, res));
app.get('/mcp', (req, res) => void proxy(req, res));
app.delete('/mcp', (req, res) => void proxy(req, res));

app.listen(PORT, () =>
  console.log(`MCP remote proxy listening on port ${PORT} → ${REMOTE_URL}`),
);
