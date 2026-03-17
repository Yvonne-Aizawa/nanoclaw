/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the AI API.
 * The proxy injects real credentials so containers never see them.
 *
 * Three auth modes (set via config.json ai.type):
 *   api:    Proxy injects x-api-key on every request.
 *   oauth:  Container CLI exchanges its placeholder token for a temp
 *           API key via /api/oauth/claude_cli/create_api_key.
 *           Proxy injects real OAuth token on that exchange request;
 *           subsequent requests carry the temp key which is valid as-is.
 *   token:  Proxy injects Authorization: Bearer on every request
 *           (for non-Anthropic endpoints like z.ai).
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { getActiveAiConfig } from './app-config.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const aiConfig = getActiveAiConfig();
  const authMode: AuthMode = aiConfig.type === 'oauth' ? 'oauth' : 'api-key';

  const upstreamUrl = new URL(aiConfig.endpoint || 'https://api.anthropic.com');
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;
  const basePath = upstreamUrl.pathname.replace(/\/$/, '');

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      // Ollama proxy: forward /ollama/* to localhost:11434/*
      if (req.url?.startsWith('/ollama/')) {
        const ollamaPath = req.url.slice('/ollama'.length);
        const upstream = httpRequest(
          {
            hostname: '127.0.0.1',
            port: 11434,
            path: ollamaPath,
            method: req.method,
            headers: { ...req.headers, host: '127.0.0.1:11434' },
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );
        upstream.on('error', (err) => {
          logger.error({ err, url: req.url }, 'Ollama proxy error');
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });
        req.pipe(upstream);
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        // Strip run-type path prefix and select the appropriate model override.
        // Container runner sets ANTHROPIC_BASE_URL to .../chat or .../cron so
        // the proxy can route each run to a different model without extra infra.
        let reqUrl = req.url ?? '/';
        let overrideModel = aiConfig.model;
        if (reqUrl.startsWith('/chat/')) {
          reqUrl = reqUrl.slice('/chat'.length);
          overrideModel = aiConfig.chatModel;
        } else if (reqUrl.startsWith('/cron/')) {
          reqUrl = reqUrl.slice('/cron'.length);
          overrideModel = aiConfig.cronModel;
        }

        // Rewrite model in request body if a model override is configured
        let body = Buffer.concat(chunks);
        if (reqUrl.includes('/messages') && body.length > 0) {
          try {
            const parsed = JSON.parse(body.toString());
            if (parsed.model !== undefined) {
              if (overrideModel) parsed.model = overrideModel;
              logger.info(
                {
                  model: parsed.model,
                  endpoint: upstreamUrl.origin + basePath,
                },
                'Proxy: model in use',
              );
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

        if (aiConfig.type === 'token') {
          // Bearer token mode: inject Authorization header (e.g. z.ai)
          delete headers['x-api-key'];
          headers['authorization'] = `Bearer ${aiConfig.key}`;
        } else if (aiConfig.type === 'api') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = aiConfig.key;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          if (headers['authorization']) {
            delete headers['authorization'];
            if (aiConfig.key) {
              headers['authorization'] = `Bearer ${aiConfig.key}`;
            }
          }
        }

        const upstreamPath = basePath + reqUrl;

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
  const { type } = getActiveAiConfig();
  return type === 'oauth' ? 'oauth' : 'api-key';
}
