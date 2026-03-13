/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_MODEL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken = secrets.CLAUDE_CODE_OAUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;
  const basePath = upstreamUrl.pathname.replace(/\/$/, '');

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        // Rewrite model in request body if ANTHROPIC_MODEL is set and this is a messages request
        let body = Buffer.concat(chunks);
        const overrideModel = secrets.ANTHROPIC_MODEL;
        if (req.url?.includes('/messages') && body.length > 0) {
          try {
            const parsed = JSON.parse(body.toString());
            if (parsed.model !== undefined) {
              if (overrideModel) parsed.model = overrideModel;
              logger.info({ model: parsed.model, endpoint: upstreamUrl.origin + basePath }, 'Proxy: model in use');
              body = Buffer.from(JSON.stringify(parsed));
            }
          } catch {
            // Not JSON or no model field — leave body unchanged
          }
        }

        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (secrets.ANTHROPIC_AUTH_TOKEN && !secrets.CLAUDE_CODE_OAUTH_TOKEN) {
          // Bearer token mode: always inject Authorization header (e.g. z.ai / non-Anthropic endpoints)
          delete headers['x-api-key'];
          headers['authorization'] = `Bearer ${secrets.ANTHROPIC_AUTH_TOKEN}`;
        } else if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        const upstreamPath = basePath + req.url;

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: upstreamPath,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
  ]);
  // ANTHROPIC_AUTH_TOKEN = Bearer token for non-Anthropic endpoints (e.g. z.ai).
  // Use api-key mode so the container skips the OAuth exchange flow.
  // OAuth takes priority when CLAUDE_CODE_OAUTH_TOKEN is explicitly set.
  if (secrets.CLAUDE_CODE_OAUTH_TOKEN) return 'oauth';
  return secrets.ANTHROPIC_API_KEY || secrets.ANTHROPIC_AUTH_TOKEN
    ? 'api-key'
    : 'oauth';
}
