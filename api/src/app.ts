import { OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { getPath } from 'hono/utils/url';
import { ApiError, id, lazyModule, log, ModuleLoadError, secureResponse, SECURITY_HEADERS, timed, wrapModuleLoad } from './core.js';
import type { App, Runtime } from './core.js';
import type { AppEnv, Ctx } from './core.js';
import { authenticate, registerAuth } from './auth.js';
import { resolveRegionRuntime, withRegionSettings } from './ses-region-state.js';
import { countEnqueued } from './jobs.js';

type RouteGroup = 'auth-ui' | 'mcp' | 'auth' | 'audience' | 'audience-query' | 'templates' | 'sending-emails' | 'sending-other' | 'ops-domains' | 'ops-events' | 'ops-other' | 'ses-regions' | 'mailbox' | 'workspaces' | 'provider-connections';
function routeGroupFor(pathname: string): RouteGroup | null {
  if (pathname === '/v1/me' || pathname === '/v1/mcp-connections' || pathname.startsWith('/v1/mcp-connections/') || pathname === '/api/auth' || pathname.startsWith('/api/auth/') || pathname.startsWith('/.well-known/') || pathname === '/mcp/login' || pathname === '/mcp/consent') return 'auth-ui';
  if (pathname === '/mcp' || pathname.startsWith('/mcp/')) return 'mcp';
  if (pathname === '/v1/api-keys' || pathname.startsWith('/v1/api-keys/') || pathname === '/v1/agent-tokens' || pathname.startsWith('/v1/agent-tokens/')) return 'auth';
  if (pathname === '/v1/events/ses') return 'ops-events';
  if (pathname === '/v1/domains' || pathname.startsWith('/v1/domains/')) return 'ops-domains';
  if (/^\/v1\/(?:settings|webhooks|metrics)(?:\/|$)/.test(pathname) || pathname === '/unsubscribe' || pathname.startsWith('/unsubscribe/')) return 'ops-other';
  if (pathname === '/v1/emails' || pathname.startsWith('/v1/emails/')) return 'sending-emails';
  if (/^\/v1\/(?:attachments|campaigns|campaign-content-guide)(?:\/|$)/.test(pathname)) return 'sending-other';
  if (/^\/v1\/(?:contacts|lists|segments|contact-imports)(?:\/|$)/.test(pathname)) return 'audience';
  if (pathname === '/v1/audience-query' || pathname.startsWith('/v1/audience-query/')) return 'audience-query';
  if (/^\/v1\/(?:templates|template-assets)(?:\/|$)/.test(pathname)) return 'templates';
  if (pathname === '/v1/regions' || pathname.startsWith('/v1/regions/')) return 'ses-regions';
  if (pathname === '/v1/inbound' || pathname.startsWith('/v1/inbound/')) return 'mailbox';
  if (pathname === '/v1/workspaces' || pathname.startsWith('/v1/workspaces/')) return 'workspaces';
  if (pathname === '/v1/connection' || pathname.startsWith('/v1/connection/')) return 'provider-connections';
  return null;
}

function allowPathFor(group: Exclude<RouteGroup, 'mcp'>): ((path: string) => boolean) | undefined {
  switch (group) {
    case 'ops-events': return p => p === '/v1/events/ses';
    case 'ops-domains': return p => p === '/v1/domains' || p.startsWith('/v1/domains/');
    case 'ops-other': return p => p !== '/v1/events/ses' && p !== '/v1/domains' && !p.startsWith('/v1/domains/');
    case 'sending-emails': return p => p === '/v1/emails' || p.startsWith('/v1/emails/');
    case 'sending-other': return p => p !== '/v1/emails' && !p.startsWith('/v1/emails/');
    default: return undefined;
  }
}

const groupRegistrars: Partial<Record<RouteGroup, Promise<(app: App) => void>>> = {};
function loadGroupRegistrar(group: Exclude<RouteGroup, 'mcp'>): Promise<(app: App) => void> {
  return groupRegistrars[group] ??= wrapModuleLoad(async () => {
    switch (group) {
      case 'auth': return registerAuth;
      case 'auth-ui': {
        const [{ registerMcpAuth }, { registerGoogleAuth }] = await Promise.all([import('./mcp-auth.js'), import('./google-auth.js')]);
        return (target: App) => { registerMcpAuth(target); registerGoogleAuth(target); };
      }
      case 'audience': return (await import('./audience.js')).registerAudience;
      case 'audience-query': return (await import('./audience-query.js')).registerAudienceQuery;
      case 'templates': return (await import('./templates.js')).registerTemplates;
      case 'sending-emails':
      case 'sending-other': return (await import('./sending.js')).registerSending;
      case 'ops-domains':
      case 'ops-events':
      case 'ops-other': return (await import('./operations.js')).registerOperations;
      case 'ses-regions': return (await import('./ses-regions.js')).registerSesRegions;
      case 'mailbox': return (await import('./mailbox.js')).registerMailbox;
      case 'workspaces': return (await import('./workspaces.js')).registerWorkspaces;
      case 'provider-connections': return (await import('./provider-connections.js')).registerProviderConnections;
    }
  }).catch(error => { delete groupRegistrars[group]; throw error; });
}

function createShell(loadDocs: () => Promise<{ doc: Record<string, any>; createLlmsText: (doc: Record<string, any>) => string; createMarkdownDocs: (doc: Record<string, any>, operationId?: string) => string | null }>, registerOpenApi = false, allowPath?: (path: string) => boolean): App {
  const app = new OpenAPIHono<AppEnv>({ defaultHook(result) {
    if (!result.success) throw new ApiError(422, 'VALIDATION_FAILED', 'Request fields are invalid.', result.error.issues.map(i => i.path.join('.')).filter(Boolean).join(', '));
  } });
  if (registerOpenApi) {
    app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', { type: 'http', scheme: 'bearer', description: 'A Bane API key. Credentials never belong in URLs.' });
    app.openAPIRegistry.registerComponent('securitySchemes', 'dashboardSession', { type: 'apiKey', in: 'cookie', name: 'bane.session_token', description: 'Google-approved HttpOnly session for local development. Unsafe requests require the canonical dashboard Origin.' });
    app.openAPIRegistry.registerComponent('securitySchemes', 'secureDashboardSession', { type: 'apiKey', in: 'cookie', name: '__Secure-bane.session_token', description: 'Google-approved Secure HttpOnly session in production. Unsafe requests require the canonical dashboard Origin.' });
  } else {
    const rawOpenapi = app.openapi;
    app.openapi = ((route, handler, hook) => allowPath && !allowPath(route.path) ? app : rawOpenapi({ ...route, hide: true }, handler, hook)) as typeof app.openapi;
  }
  app.use('*', async (c, next) => {
    const requestId = `req_${crypto.randomUUID().replaceAll('-', '')}`;
    c.set('requestId', requestId); c.set('serverTimings', []); c.header('x-request-id', requestId); c.header('cache-control', 'no-store');
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.header(name, value);
    if ([c.req.header('X-Bane-Environment'), c.req.header('X-OpenSend-Environment')].some(v => v !== undefined && v.trim().toLowerCase() !== 'live')) throw new ApiError(400, 'ENVIRONMENT_REMOVED', 'Remove X-Bane-Environment. SES simulation is configured for the deployment, not the request.');
    const start = Date.now();
    const enqueued = await countEnqueued(next);
    // Auth handlers return native Responses, so apply correlation/cache policy after dispatch too.
    c.header('x-request-id', requestId); c.header('cache-control', 'no-store');
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) if (!c.res.headers.has(name)) c.header(name, value);
    const timings = c.get('serverTimings');
    if (timings.length) c.header('server-timing', timings.map(item => `${item.name};dur=${item.durationMs.toFixed(1)}`).join(', '));
    log(c.res.status >= 500 ? 'error' : 'info', { requestId, operation: c.req.routePath ?? 'unmatched', method: c.req.method, status: c.res.status, durationMs: Date.now() - start, timings: Object.fromEntries(timings.map(item => [item.name, Number(item.durationMs.toFixed(1))])) });
    // Wake only after this request committed jobs: each wake locks the shared job_schedule row and starts a drain.
    const wakeJobs = c.get('actor')?.wakeJobs;
    const wake = (wakeJobs || (enqueued > 0 && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method))) && c.req.path !== '/v1/events/ses' && !/^\/mcp(?:\/|$)/.test(c.req.path) && c.res.status < 300 ? c.env.wake : undefined;
    const actor = c.get('actor'), targets = actor?.dispatchTargets;
    const dispatch = targets?.size && c.res.status < 300 ? c.env.dispatch : undefined;
    if (!wake && !dispatch) return;
    const nudge = async (runtime: Runtime) => {
      if (wake) try { await runtime.wake?.(wakeJobs, c.req.path.startsWith('/v1/webhooks/') ? 'webhook' : undefined); } catch { log('warn', { requestId, code: 'QUEUE_WAKE_FAILED', message: 'The job is durable in Postgres; scheduler will recover it.' }); }
      if (dispatch && targets) for (const [region, { count, priority }] of targets) {
        try { await runtime.dispatch?.(region, actor.dispatchAccount?.aws_account_id, count, actor.dispatchAccount?.kind, priority); } catch { log('warn', { requestId, code: 'DISPATCH_WAKE_FAILED', message: 'Queued mail is durable; the dispatcher polls and the scheduler pings it.' }); }
      }
    };
    if (c.env.deferNudge) c.env.deferNudge(nudge); else await nudge(c.env);
  });
  const apiLimit = bodyLimit({ maxSize: 12 * 1024 * 1024, onError() { throw new ApiError(413, 'REQUEST_TOO_LARGE', 'Request exceeds the 12 MiB limit.'); } });
  const snsLimit = bodyLimit({ maxSize: 512 * 1024, onError() { throw new ApiError(413, 'REQUEST_TOO_LARGE', 'SNS envelope exceeds the 512 KiB limit.'); } });
  app.use('*', (c, next) => (c.req.method === 'POST' && c.req.path === '/v1/events/ses' ? snsLimit : apiLimit)(c, next));
  app.use('/v1/*', async (c, next) => {
    // Inbound authenticates its own address-scoped keys as well as live administrators.
    if (c.req.path.startsWith('/v1/inbound/')) return next();
    // Joining requires a verified session, not an existing membership. This endpoint
    // authenticates the invitation recipient directly and cannot authorize resource access.
    if (c.req.method === 'POST' && /^\/v1\/workspaces\/invitations\/[^/]+\/accept$/.test(c.req.path)) return next();
    // Provider redirects cannot carry a workspace header. This route authenticates the Google
    // session itself, then authorizes and selects the workspace from the signed return token.
    if (c.req.method === 'GET' && /^\/v1\/domains\/[^/]+\/dns-setup\/return\/[^/]+$/.test(c.req.path)) return next();
    if (c.req.path === '/v1/events/ses') {
      // Only SNS ingress needs trusted topic/account bindings; unknown topics are checked fresh in the handler.
      if (c.req.method === 'POST' && !c.env.config.multiTenant) c.env = await timed(c, 'region-db', () => resolveRegionRuntime(c.env, { cacheMs: 30_000 }));
      return next();
    }
    return authenticate(c, next);
  });
  // These areas have read or send routes as well as manage routes. An MX member's
  // read/send scopes do not confer access to infrastructure or campaign delivery controls.
  const notMember = async (c: Ctx, next: () => Promise<void>) => {
    if (c.get('actor')?.role === 'member') throw new ApiError(403, 'PERMISSION_DENIED', 'This operation requires a workspace owner or admin.');
    await next();
  };
  for (const area of ['domains', 'webhooks', 'agent-tokens']) app.use(`/v1/${area}/*`, notMember);
  app.use('/v1/regions/*', (c, next) => c.req.method === 'GET' && c.req.path === '/v1/regions' ? next() : notMember(c, next));
  app.use('/v1/settings/ses', notMember);
  app.on('POST', ['send', 'schedule', 'pause', 'resume', 'pacing', 'cancel'].map(action => `/v1/campaigns/:id/${action}`), notMember);
  const regions = async (c: Ctx, next: () => Promise<void>) => {
    c.env = await timed(c, 'region-db', () => withRegionSettings(c.env, c.get('actor').workspaceId));
    await next();
  };
  // Discovery, provisioning and the catalog load persisted settings themselves.
  app.on('GET', ['/v1/emails', '/v1/campaigns'], (c, next) => c.req.query('region') ? regions(c, next) : next());
  const selfHostedRegions = (c: Ctx, next: () => Promise<void>) => c.env.config.multiTenant ? next() : regions(c, next);
  app.on('GET', ['/v1/settings/ses', '/v1/domains/:id'], selfHostedRegions);
  app.on('GET', '/v1/domains', (c, next) => c.req.query('region') !== undefined ? regions(c, next) : selfHostedRegions(c, next));
  app.on('POST', ['/v1/domains', '/v1/domains/:id/mail-from', '/v1/domains/:id/verify'], selfHostedRegions);
  app.on('POST', ['/v1/campaigns', ...['test', 'reviews', 'send', 'schedule', 'cancel', 'pause', 'resume', 'pacing'].map(action => `/v1/campaigns/:id/${action}`)], regions);
  app.on('PATCH', ['/v1/campaigns/:id', '/v1/campaigns/:id/archive'], regions);
  app.on('DELETE', '/v1/campaigns/:id', regions);
  app.onError((error, c) => {
    const requestId = c.get('requestId');
    const known = error instanceof ApiError;
    const invalidJson = error instanceof SyntaxError;
    const responseError = known ? error : invalidJson ? new ApiError(400, 'INVALID_JSON', 'Request body is not valid JSON.') : new ApiError(500, 'INTERNAL_ERROR', 'Unexpected server failure. Use the request ID to locate the server log.');
    // Messages and even record-key validation paths can contain caller-supplied addresses.
    const field = responseError.field && /^[\w.]+(?:, [\w.]+)*$/.test(responseError.field) ? responseError.field : undefined;
    const unexpected = !known && responseError.status >= 500;
    log('error', { requestId, operation: c.req.routePath ?? 'unmatched', code: responseError.code, status: responseError.status, field,
      errorType: unexpected ? error.name : undefined, databaseCode: 'code' in error && typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : undefined,
      stack: unexpected ? error.stack?.split('\n').filter(line => /^\s+at /.test(line) && !line.includes('@')).join('\n') : undefined });
    if (responseError.resetAt) c.header('Retry-After', new Date(responseError.resetAt).toUTCString());
    return c.json({ error: { code: responseError.code, message: responseError.message, requestId, retryable: responseError.retryable, ...(responseError.field ? { field: responseError.field } : {}), ...(responseError.resetAt ? { resetAt: responseError.resetAt } : {}) } }, responseError.status as ContentfulStatusCode);
  });
  app.notFound(c => c.json({ error: { code: 'NOT_FOUND', message: 'Route not found.', requestId: c.get('requestId'), retryable: false } }, 404));
  app.get('/health', async c => {const h=await (await import('./receiving-health.js')).health(c.env);return c.json(h,h.status==='ok'?200:503);});
  app.get('/openapi.json', async c => { const { doc } = await loadDocs(); c.header('cache-control', 'public, max-age=300'); return c.json(doc); });
  const markdown = (c: Ctx, value: string) => { c.header('content-type', 'text/markdown; charset=utf-8'); c.header('cache-control', 'public, max-age=300'); return c.body(value); };
  app.get('/llms.txt', async c => { const { doc, createLlmsText } = await loadDocs(); return markdown(c, createLlmsText(doc)); });
  app.get('/docs.md', async c => { const { doc, createMarkdownDocs } = await loadDocs(); return markdown(c, createMarkdownDocs(doc)!); });
  app.get('/docs/operations/*', async c => { const { doc, createMarkdownDocs } = await loadDocs(); const file = c.req.path.slice('/docs/operations/'.length); const operation = /^[A-Za-z][A-Za-z0-9_]{0,63}\.md$/.test(file) ? file.slice(0, -3) : ''; const value = operation ? createMarkdownDocs(doc, operation) : null; return value ? markdown(c, value) : c.json({ error: { code: 'NOT_FOUND', message: 'Documented operation not found.', requestId: c.get('requestId'), retryable: false } }, 404); });
  return app;
}

export async function createOpenApiApp(): Promise<App> {
  const full = createShell(lazyModule(() => import('./openapi-docs.js').then(({ createOpenApiDocument, createLlmsText, createMarkdownDocs }) => ({
    doc: createOpenApiDocument(full), createLlmsText, createMarkdownDocs,
  }))), true);
  const [
    { registerMcpAuth }, { registerGoogleAuth }, { registerAudience }, { registerAudienceQuery },
    { registerTemplates }, { registerSending }, { registerOperations }, { registerSesRegions },
    { registerMailbox }, { registerWorkspaces }, { registerProviderConnections }, { registerMcp },
  ] = await wrapModuleLoad(() => Promise.all([
    import('./mcp-auth.js'), import('./google-auth.js'), import('./audience.js'), import('./audience-query.js'),
    import('./templates.js'), import('./sending.js'), import('./operations.js'), import('./ses-regions.js'),
    import('./mailbox.js'), import('./workspaces.js'), import('./provider-connections.js'), import('./mcp.js'),
  ]));
  registerMcpAuth(full); registerGoogleAuth(full); registerAuth(full); registerAudience(full); registerAudienceQuery(full);
  registerTemplates(full); registerSending(full); registerOperations(full); registerSesRegions(full); registerMailbox(full);
  registerWorkspaces(full); registerProviderConnections(full); registerMcp(full);
  return full;
}

export type HttpApp = Pick<App, 'fetch'>;

export function createApp(options: { fallback?: MiddlewareHandler<AppEnv> } = {}): HttpApp {
  const getFullApp = lazyModule(() => createOpenApiApp());
  const loadDocs = lazyModule(() => Promise.all([getFullApp(), import('./openapi-docs.js')]).then(([full, { createOpenApiDocument, createLlmsText, createMarkdownDocs }]) => ({
    doc: createOpenApiDocument(full), createLlmsText, createMarkdownDocs,
  })));
  let base: App | undefined;
  const getBase = () => {
    if (!base) {
      base = createShell(loadDocs);
      if (options.fallback) base.use('*', options.fallback);
    }
    return base;
  };
  const groupApps = new Map<RouteGroup, Promise<App>>();
  const getGroupApp = (group: RouteGroup): Promise<App> => {
    if (group === 'mcp') return getFullApp();
    let pending = groupApps.get(group);
    if (!pending) {
      pending = loadGroupRegistrar(group).then(register => {
        const sub = createShell(loadDocs, false, allowPathFor(group));
        register(sub);
        return sub;
      }).catch(error => { groupApps.delete(group); throw error; });
      groupApps.set(group, pending);
    }
    return pending;
  };
  return {
    fetch: (async (request: Request, env?: Runtime, executionCtx?: import('hono').ExecutionContext) => {
      const pathname = getPath(request);
      const group = routeGroupFor(pathname);
      if (!group) return getBase().fetch(request, env, executionCtx);
      let target: App;
      try { target = await getGroupApp(group); }
      catch (error) {
        if (!(error instanceof ModuleLoadError)) throw error;
        const requestId = id('req');
        // Log the route group, never the path: paths can carry bearer tokens (e.g. /unsubscribe/{token}).
        log('error', { requestId, operation: `route-group:${group}`, code: error.code, status: 503, message: error.message });
        return secureResponse(Response.json(
          { error: { code: error.code, message: 'Server runtime is unavailable; use the request ID to inspect logs.', requestId, retryable: true } },
          { status: 503, headers: { 'x-request-id': requestId, 'cache-control': 'no-store' } },
        ));
      }
      return target.fetch(request, env, executionCtx);
    }) as App['fetch'],
  };
}
export const app: HttpApp = createApp();
