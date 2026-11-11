import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { getPath } from 'hono/utils/url';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { nodeRuntime } from './adapters/node.js';
import { sql } from 'drizzle-orm';
import { dispatchWakeKey } from './dispatcher.js';
import { admissionDenied, admissionPeer, ApiError, digest, log, guardPublicRequest } from './core.js';

try {
  const { runtime, close } = nodeRuntime(process.env);
  runtime.dispatch = async (region, account, _count, _kind, priority) => {
    if (priority) await runtime.db.execute(sql`SELECT pg_notify('bane_priority', ${dispatchWakeKey(region, account)})`);
  };
  const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
  const assets = serveStatic({ root: publicRoot });
  const dashboard = serveStatic({ path: `${publicRoot}index.html` });
  const app = createApp({ fallback: async (c, next) => {
    // API failures must remain JSON, never an apparently successful SPA response.
    if (!['GET', 'HEAD'].includes(c.req.method) || /^\/(?:health|v1|api|mcp|\.well-known|unsubscribe|docs\/operations)(?:\/|$)/.test(c.req.path) || ['/openapi.json', '/docs.md', '/llms.txt'].includes(c.req.path)) return next();
    return assets(c, async () => {
      const response = await dashboard(c, next);
      if (response) c.res = response;
    });
  } });
  // Coarse per-process admission guard; trusted proxy/WAF controls remain necessary for distributed abuse.
  const peers = new Map<string, number>(); let minute = Math.floor(Date.now() / 60000);
  const server = serve({ fetch: async (request, connection) => {
    const current = Math.floor(Date.now() / 60000);
    if (current !== minute) { peers.clear(); minute = current; }
    const address = admissionPeer(connection.incoming.socket.remoteAddress ?? 'unknown');
    if (!(getPath(request)==='/v1/events/ses' && request.method==='POST') && (peers.has(address) || peers.size < 1024)) {
      const count = (peers.get(address) ?? 0) + 1; peers.set(address, count);
      if (count > 6000) return admissionDenied();
    }
    const headers = new Headers(request.headers);
    headers.delete('x-opensend-client-ip');
    headers.set('x-bane-client-ip', address);
    const response = await guardPublicRequest(getPath(request), headers, await digest(address), async () => app.fetch(new Request(request, { headers }), runtime));
    // A size rejection can leave upload bytes unread. Do not offer that HTTP/1 socket for reuse.
    if (response.status === 413 && !connection.incoming.readableEnded && 'shouldKeepAlive' in connection.outgoing) connection.outgoing.shouldKeepAlive = false;
    return response;
  }, port: Number(process.env.PORT ?? 8787), hostname: process.env.HOST ?? '0.0.0.0' }, info => {
    log('info', { code: 'API_READY', port: info.port, liveSesEnabled: runtime.config.liveEnabled });
  });
  server.on('error', error => {
    log('error', { code: 'LISTEN_FAILED', message: 'Unable to bind the API port. Check PORT and HOST.', errorType: error.name });
    void close().then(() => { process.exitCode = 1; });
  });
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
    if (stopping) return; stopping = true;
    server.close(() => { void close().then(() => process.exit(0)); });
  });
} catch (error) {
  log('error', { code: error instanceof ApiError ? error.code : 'STARTUP_FAILED', message: error instanceof ApiError ? error.message : 'API startup failed; check deployment configuration.' });
  process.exitCode = 1;
}
