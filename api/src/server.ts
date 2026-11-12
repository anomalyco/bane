import {gatewayLane} from './protocol-admission.js';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { getPath } from 'hono/utils/url';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { nodeRuntime } from './adapters/node.js';
import { sql } from 'drizzle-orm';
import { dispatchWakeKey } from './dispatcher.js';
import { admissionDenied, admissionPeer, ApiError, digest, log, logError, guardPublicRequest, setLogContext } from './core.js';
import { brotliCompress, constants, gzip } from 'node:zlib';
import { promisify } from 'node:util';

// The dashboard's files on Node/Docker. Cloudflare serves them itself, with app/public/_headers and compression;
// here every response would otherwise be uncompressed and no-store, so each visit re-downloaded the whole app.
// Hashed /assets/* are immutable and compressed once per process; fonts follow _headers; the HTML shell revalidates.
const encoders = { br: (raw: Buffer) => promisify(brotliCompress)(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }), gzip: (raw: Buffer) => promisify(gzip)(raw, { level: 9 }) };
const encoded = new Map<string, Promise<Buffer>>();
async function dashboardFile(request: Request, path: string, response: Response) {
  if (!['GET', 'HEAD'].includes(request.method) || response.status !== 200) return response;
  // The public docs (the Docs page reads the 1.7 MB OpenAPI document) are the same for every reader: compress them too.
  // Exactly these paths: a longer one that only starts like them is a dashboard route, with its own answer below.
  if (/^\/(?:openapi\.json|llms\.txt|docs\.md|docs\/operations\/[^/]+)$/.test(path)) return encode(request, path, response, new Headers(response.headers), response.headers.get('content-length') ?? '');
  if (/^\/(?:health|v1|api|mcp|\.well-known|unsubscribe|docs\/operations)(?:\/|$)/.test(path)) return response;
  const html = response.headers.get('content-type')?.startsWith('text/html');
  const asset = path.startsWith('/assets/') && !html, font = path.startsWith('/fonts/') && !html;
  if (!html && !asset && !font) return response;
  const headers = new Headers(response.headers);
  // A missing /assets/ file falls back to the HTML shell: never cache that answer.
  headers.set('cache-control', asset ? 'public, max-age=31536000, immutable' : font ? 'public, max-age=86400, stale-while-revalidate=604800' : 'no-cache');
  if (!asset || !/\.(?:js|css|svg|json|map)$/.test(path)) return new Response(response.body, { status: 200, headers });
  return encode(request, path, response, headers, '');
}
// Brotli (or gzip) once per file per process; `version` separates bodies that can change under one path.
async function encode(request: Request, path: string, response: Response, headers: Headers, version: string) {
  const accept = request.headers.get('accept-encoding') ?? '';
  const encoding = /\bbr\b/.test(accept) ? 'br' : /\bgzip\b/.test(accept) ? 'gzip' : null;
  if (!encoding || response.headers.has('content-encoding')) return new Response(response.body, { status: response.status, headers });
  headers.append('vary', 'accept-encoding');
  const key = `${encoding} ${path} ${version}`;
  let body = encoded.get(key);
  if (!body) {
    // Only a GET has the file's bytes. A HEAD before the first GET answers without a length rather than
    // compressing its empty body, which would then be remembered as the file for every later GET.
    if (request.method !== 'GET') { headers.delete('content-length'); return new Response(null, { status: 200, headers }); }
    body = response.arrayBuffer().then(raw => encoders[encoding](Buffer.from(raw)));
    body.catch(() => encoded.delete(key));
    if (encoded.size < 1000) encoded.set(key, body);
  } else void response.body?.cancel();
  const bytes = await body;
  headers.set('content-encoding', encoding); headers.set('content-length', String(bytes.length));
  return new Response(request.method === 'HEAD' ? null : new Uint8Array(bytes), { status: 200, headers });
}

setLogContext({ service: 'api', deploy: process.env.DEPLOY_SHA });
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
  const peers = new Map<string, number>(), protocol = new Map<string,number>(); let minute = Math.floor(Date.now() / 60000);
  const server = serve({ fetch: async (request, connection) => {
    const current = Math.floor(Date.now() / 60000);
    if (current !== minute) { peers.clear(); protocol.clear(); minute = current; }
    const address = admissionPeer(connection.incoming.socket.remoteAddress ?? 'unknown');
    const lane = gatewayLane(request.method,getPath(request),request.headers,runtime.config.mailGatewayToken);
    const buckets = lane ? protocol : peers;
    if (!(getPath(request)==='/v1/events/ses' && request.method==='POST')) {
      const key = lane ?? address;
      const bucket = buckets.size < 1024 || buckets.has(key) ? key : 'overflow';
      const count = (buckets.get(bucket) ?? 0) + 1; buckets.set(bucket, count);
      if (count > 6000) return admissionDenied();
    }
    const headers = new Headers(request.headers);
    headers.delete('x-opensend-client-ip');
    headers.set('x-bane-client-ip', address);
    const path = getPath(request);
    const response = await dashboardFile(request, path, await guardPublicRequest(path, headers, await digest(address), async () => app.fetch(new Request(request, { headers }), runtime)));
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
  logError(error, { code: error instanceof ApiError ? error.code : 'STARTUP_FAILED', message: error instanceof ApiError ? error.message : 'API startup failed; check deployment configuration.' });
  process.exitCode = 1;
}
