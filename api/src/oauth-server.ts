import { Buffer } from 'node:buffer';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError, chargeBudget, digest, id, log, randomSecret, type App, type Ctx, type DbExecutor, type Permission, type PublicGet, type Runtime } from './core.js';
import { auditContext, auditInsert, type AuditContext } from './audit.js';
import { browserSignedIn, currentSession, signInRedirect } from './account-login.js';
import { clientLabel } from './mcp-auth.js';
import { ACCESS_TOKEN, DPOP_ALGS, issuer, mcpGrantActor, mcpResource, MCP_KEY, PERMISSIONS, profileLabel, SCOPES, verifyDpop } from './mcp-resource.js';
import { decrypt, encrypt } from './secret-box.js';

// Bane's OAuth 2.1 authorization server for its own /mcp (MCP authorization, 2025-11-25). The account service
// (ACCOUNT_ISSUER) only signs the person in to the dashboard: a client is sent to /oauth/authorize, the person approves
// it on Bane's consent page (/consent/<request>, or /device for the device grant) as one of the accounts connected in
// that browser, choosing the workspace, the permissions and receiving, and the client gets Bane's own tokens.
//
// Tokens are opaque (bane_at_/bane_rt_/bane_mcp_ and 64 hex characters), stored as SHA-256 hashes. Bane is both the
// authorization server and the only resource server, and every /mcp request reads the approval and the person's
// membership anyway, so a signed token would save no round trip; opaque tokens need no signing keys to rotate, carry
// no claims, and stop the moment their row is deleted.
//
// Lifetimes: access tokens 5 minutes; refresh tokens rotate on every use and each one lasts 30 days, so an approval
// whose client keeps refreshing lasts while it is used (its expires_at follows the newest refresh token). A refresh
// token presented again within 60 seconds of its rotation returns the same new pair (a lost response, or two refreshes
// at once); after that, any reuse revokes the approval. An authorization code lasts 10 minutes after approval (a person
// may paste the redirect back into an app on another machine) and works once; a second use revokes the approval.
const ACCESS_SECONDS = 300, REFRESH_SECONDS = 30 * 86400, REPLAY_SECONDS = 60, CODE_SECONDS = 600, REQUEST_SECONDS = 1200;
const DEVICE_SECONDS = 600, DEVICE_INTERVAL = 5;
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const GRANT_TYPES = ['authorization_code', 'refresh_token', DEVICE_GRANT];
// User codes: 8 characters without vowels (no words) or look-alikes (0/O, 1/I/L, 5/S, 8/B, 2/Z), shown as XXXX-XXXX.
const USER_CODE = 'CDFGHJKLMNPQRTVWX2346789';
const endpoints = (runtime: Pick<Runtime, 'config'>) => {
  const base = `${runtime.config.publicUrl}/oauth`;
  return { authorization: `${base}/authorize`, token: `${base}/token`, registration: `${base}/register`, revocation: `${base}/revoke`, device: `${base}/device_authorization` };
};

export function authorizationServerMetadata(runtime: Runtime) {
  const e = endpoints(runtime), methods = ['none', 'client_secret_basic', 'client_secret_post'];
  return {
    issuer: issuer(runtime), authorization_endpoint: e.authorization, token_endpoint: e.token, registration_endpoint: e.registration,
    revocation_endpoint: e.revocation, device_authorization_endpoint: e.device,
    response_types_supported: ['code'], response_modes_supported: ['query'], grant_types_supported: GRANT_TYPES,
    code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: methods, revocation_endpoint_auth_methods_supported: methods,
    scopes_supported: SCOPES, client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true,
    dpop_signing_alg_values_supported: DPOP_ALGS, service_documentation: `${runtime.config.publicUrl}/docs`,
  };
}

class OAuthError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
const respond = (body: object, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', pragma: 'no-cache', 'access-control-allow-origin': '*', ...headers } });
function failure(error: unknown) {
  if (!(error instanceof OAuthError)) throw error;
  return respond({ error: error.code, error_description: error.message }, error.status, error.status === 401 ? { 'www-authenticate': 'Basic realm="Bane"' } : {});
}
// RFC 6749 §3.1/§3.2: a parameter sent without a value is omitted, and none may be repeated.
async function formParams(c: Ctx) {
  if (c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/x-www-form-urlencoded') throw new OAuthError('invalid_request', 'Send the parameters as application/x-www-form-urlencoded.');
  const text = await c.req.text();
  if (text.length > 16384) throw new OAuthError('invalid_request', 'The request is too large.');
  const params = new URLSearchParams(text);
  for (const key of new Set(params.keys())) if (params.getAll(key).length > 1) throw new OAuthError('invalid_request', `The ${key.slice(0, 40)} parameter is repeated.`);
  return params;
}
const value = (params: URLSearchParams, name: string) => params.get(name) || null;
const sameHash = (a: string, b: string) => a.length === b.length && Array.from(a).reduce((diff, ch, i) => diff | (ch.charCodeAt(0) ^ b.charCodeAt(i)), 0) === 0;
const challengeOf = async (verifier: string) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
// Durable per-minute budgets across Worker isolates and processes, per network (or per person), in the API's budget
// table under a workspace ID no workspace has: starting authorizations, registering clients, device requests, and
// guessing device codes.
const BUDGETS = { authorize: 60, register: 20, device: 20, 'device-code': 10, 'device-code-ip': 30 } as const;
const budget = async (runtime: Runtime, lane: keyof typeof BUDGETS, key: string) => chargeBudget(runtime, 'oauth:', `${lane}:${await digest(key)}`, BUDGETS[lane]);

/** bane:read bane:send bane:manage, or every one when none is named (the consent page narrows them). offline_access is
 * accepted and ignored: a client that may refresh gets a refresh token either way. Anything else is refused. */
function parseScopes(scope: string | null): Permission[] | null {
  const words = (scope ?? '').split(' ').filter(word => word && word !== 'offline_access');
  if (!words.length) return [...PERMISSIONS];
  if (words.some(word => !SCOPES.includes(word))) return null;
  return PERMISSIONS.filter(p => words.includes(`bane:${p}`));
}
/** RFC 8707: the resource is /mcp on this origin. Its query (?codemode=, ?toolsets=, ?profile=) is transport detail, not
 * part of the resource, so `https://bane.mx/mcp?codemode=true` names https://bane.mx/mcp; `profile` labels the approval. */
function targetResource(runtime: Runtime, resource: string | null) {
  if (resource === null) return { profile: null };
  let url: URL; try { url = new URL(resource); } catch { return null; }
  if (url.origin !== runtime.config.publicUrl || url.pathname !== '/mcp' || url.hash || url.username || url.password || resource.includes('#')) return null;
  return { profile: profileLabel(url.searchParams.get('profile')) };
}

// ---------- clients ----------

type Client = { id: string; name: string | null; redirectUris: string[]; grantTypes: string[]; document: boolean };
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);
/** web: an https URL, matched exactly. loopback: http on 127.0.0.1, [::1] or localhost, any port (RFC 8252 §7.3).
 * app: a private-use scheme in reverse-domain form (com.example.app:/callback, RFC 8252 §7.1). Nothing else. */
export function redirectKind(uri: string): 'web' | 'loopback' | 'app' | null {
  if (uri.length > 2048 || uri.includes('#')) return null;
  let url: URL; try { url = new URL(uri); } catch { return null; }
  if (url.username || url.password) return null;
  if (url.protocol === 'https:') return 'web';
  if (url.protocol === 'http:') return LOOPBACK.has(url.hostname) ? 'loopback' : null;
  return /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+:$/.test(url.protocol) ? 'app' : null;
}
export function redirectMatches(registered: string, requested: string) {
  if (registered === requested) return true;
  if (redirectKind(registered) !== 'loopback' || redirectKind(requested) !== 'loopback') return false;
  const a = new URL(registered), b = new URL(requested);
  return a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
}

/** A Client ID Metadata Document URL: https on the default port, a DNS name (no IP literal, no local or reserved name),
 * a path that isn't / and has no dot segments, no query, fragment or credentials, already in canonical form. */
export function documentUrl(value: string) {
  if (value.length > 512) return null;
  let url: URL; try { url = new URL(value); } catch { return null; }
  if (url.href !== value || url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash) return null;
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(url.hostname)) return null;
  if (/(?:^|\.)(?:localhost|local|localdomain|internal|intranet|lan|home|corp|private|test|invalid|example|onion|arpa|alt)$/.test(url.hostname)) return null;
  if (url.pathname === '/' || url.pathname.split('/').some(segment => segment === '.' || segment === '..' || /^%2e/i.test(segment))) return null;
  return url;
}
const ClientDocument = z.looseObject({
  client_id: z.string(), client_name: z.string().max(1000).optional(),
  redirect_uris: z.array(z.string().max(2048)).max(20).default([]),
  grant_types: z.array(z.string().max(200)).max(10).default(['authorization_code']),
  response_types: z.array(z.string().max(200)).max(10).default(['code']),
  token_endpoint_auth_method: z.string().max(100).default('none'),
});
// Documents are cached per isolate for 5 minutes, a failure for 30 seconds, at most 256 entries.
const documents = new Map<string, { client: Client | null; expires: number }>();
// Workers can't reach private networks; Node passes runtime.publicGet, which also refuses private addresses at connect.
const fetchPublic: PublicGet = async (url, init) => {
  const response = await fetch(url, { redirect: 'manual', signal: init.signal, headers: { accept: init.accept, 'user-agent': 'Bane' } });
  const contentType = response.headers.get('content-type');
  if (!response.body || Number(response.headers.get('content-length')) > init.limit) { await response.body?.cancel(); return { status: response.status, contentType, text: null }; }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    size += chunk.byteLength;
    if (size > init.limit) { await reader.cancel(); return { status: response.status, contentType, text: null }; }
    chunks.push(chunk);
  }
  return { status: response.status, contentType, text: Buffer.concat(chunks).toString('utf8') };
};
async function clientDocument(runtime: Runtime, clientId: string): Promise<Client | null> {
  const url = documentUrl(clientId);
  if (!url) return null;
  const cached = documents.get(clientId);
  if (cached && cached.expires > Date.now()) return cached.client;
  let client: Client | null = null;
  try {
    // No redirects (a 3xx is refused), HTTPS only, 16 KiB, 5 seconds.
    const response = await (runtime.publicGet ?? fetchPublic)(url.href, { accept: 'application/json', limit: 16384, signal: AbortSignal.timeout(5000) });
    if (response.status === 200 && response.text !== null && /^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(response.contentType ?? '')) {
      const parsed = ClientDocument.safeParse(JSON.parse(response.text));
      const doc = parsed.success ? parsed.data : null;
      const grantTypes = doc?.grant_types.filter(type => GRANT_TYPES.includes(type)) ?? [];
      // The document names itself, holds no secret, and every redirect URI is one Bane accepts.
      if (doc && doc.client_id === clientId && !('client_secret' in doc) && !('client_secret_expires_at' in doc) && doc.token_endpoint_auth_method === 'none'
        && doc.redirect_uris.every(uri => redirectKind(uri)) && (!grantTypes.includes('authorization_code') || (doc.redirect_uris.length > 0 && doc.response_types.includes('code'))))
        client = { id: clientId, name: clientLabel(doc.client_name) || null, redirectUris: doc.redirect_uris, grantTypes, document: true };
    }
    if (!client) log('warn', { code: 'OAUTH_CLIENT_DOCUMENT_REFUSED', host: url.hostname, status: response.status });
  } catch { log('warn', { code: 'OAUTH_CLIENT_DOCUMENT_UNAVAILABLE', host: url.hostname }); }
  if (documents.size >= 256) documents.clear();
  documents.set(clientId, { client, expires: Date.now() + (client ? 300_000 : 30_000) });
  return client;
}
async function resolveClient(runtime: Runtime, clientId: string): Promise<Client | null> {
  if (clientId.startsWith('https://')) return clientDocument(runtime, clientId);
  if (!/^bcl_[0-9a-f]{32}$/.test(clientId)) return null;
  const { rows: [row] } = await runtime.db.execute<{ name: string | null; redirect_uris: string[]; grant_types: string[] }>(sql`SELECT name, redirect_uris, grant_types FROM bane_oauth_clients WHERE id=${clientId}`);
  return row ? { id: clientId, name: row.name, redirectUris: row.redirect_uris, grantTypes: row.grant_types, document: false } : null;
}
/** The calling client at the token, device and revocation endpoints: a public client names itself (a metadata document
 * client is always public); a registered confidential client proves its secret the way it registered. */
async function authenticateClient(runtime: Runtime, c: Ctx, params: URLSearchParams) {
  const unauthorized = () => new OAuthError('invalid_client', 'Client authentication failed.', 401);
  const header = c.req.header('authorization');
  let clientId = value(params, 'client_id'), secret = value(params, 'client_secret'), method = secret ? 'client_secret_post' : 'none';
  if (header !== undefined) {
    const basic = /^Basic\s+([A-Za-z0-9+/]+={0,2})$/i.exec(header);
    if (!basic || secret) throw unauthorized();
    const decoded = Buffer.from(basic[1]!, 'base64').toString('utf8'), colon = decoded.indexOf(':');
    let user: string, password: string;
    try { user = decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, ' ')); password = decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, ' ')); } catch { throw unauthorized(); }
    if (colon < 0 || (clientId !== null && clientId !== user)) throw unauthorized();
    clientId = user; secret = password; method = 'client_secret_basic';
  }
  if (!clientId || clientId.length > 512) throw unauthorized();
  if (clientId.startsWith('https://')) {
    if (method !== 'none' || !documentUrl(clientId)) throw unauthorized();
    return { id: clientId };
  }
  const { rows: [client] } = /^bcl_[0-9a-f]{32}$/.test(clientId) ? await runtime.db.execute<{ auth_method: string; secret_hash: string | null }>(sql`
    WITH touched AS (UPDATE bane_oauth_clients SET last_used_at=now() WHERE id=${clientId} AND (last_used_at IS NULL OR last_used_at < now() - interval '1 hour'))
    SELECT auth_method, secret_hash FROM bane_oauth_clients WHERE id=${clientId}`) : { rows: [] };
  if (!client || client.auth_method !== method || (method !== 'none' && !sameHash(await digest(secret!), client.secret_hash!))) throw unauthorized();
  return { id: clientId };
}

// Dynamic client registration (RFC 7591), for clients without a metadata document. Open, and limited per network.
const Registration = z.looseObject({
  redirect_uris: z.array(z.string().max(2048)).max(20).default([]),
  client_name: z.string().max(1000).optional(), client_uri: z.string().max(2048).optional(),
  grant_types: z.array(z.string().max(200)).max(10).default(['authorization_code']),
  response_types: z.array(z.string().max(200)).max(10).default(['code']),
  token_endpoint_auth_method: z.enum(['none', 'client_secret_basic', 'client_secret_post']).default('client_secret_basic'),
});
async function register(c: Ctx) {
  const runtime = c.env, refuse = (error: string, message: string) => respond({ error, error_description: message }, 400);
  if (c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return refuse('invalid_client_metadata', 'Send the client metadata as application/json.');
  const text = await c.req.text();
  let body: unknown = null; try { body = text.length <= 16384 ? JSON.parse(text) : null; } catch { /* refused below */ }
  const parsed = Registration.safeParse(body);
  if (!parsed.success) return refuse('invalid_client_metadata', 'The client metadata is invalid.');
  const meta = parsed.data;
  if (meta.grant_types.some(type => !GRANT_TYPES.includes(type))) return refuse('invalid_client_metadata', `Supported grant types: ${GRANT_TYPES.join(', ')}.`);
  if (meta.grant_types.includes('authorization_code') ? !meta.redirect_uris.length || meta.response_types.join() !== 'code' : meta.redirect_uris.length > 0)
    return refuse('invalid_redirect_uri', 'Register redirect URIs (and response type code) for the authorization code grant, and only then.');
  if (meta.redirect_uris.some(uri => !redirectKind(uri))) return refuse('invalid_redirect_uri', 'Redirect URIs are https, http on a loopback address, or a private-use scheme (com.example.app:/callback).');
  if (meta.client_uri !== undefined && !/^https:\/\//.test(meta.client_uri)) return refuse('invalid_client_metadata', 'client_uri must be an https URL.');
  if (!await budget(runtime, 'register', c.req.header('x-bane-client-ip') ?? 'unknown')) return respond({ error: 'temporarily_unavailable', error_description: 'Too many registrations from this network. Retry in a minute.' }, 429, { 'retry-after': '60' });
  const clientId = id('bcl'), secret = meta.token_endpoint_auth_method === 'none' ? null : randomSecret('bane_cs_'), name = clientLabel(meta.client_name) || null;
  await runtime.db.execute(sql`INSERT INTO bane_oauth_clients(id,auth_method,secret_hash,name,client_uri,redirect_uris,grant_types)
    VALUES (${clientId},${meta.token_endpoint_auth_method},${secret && await digest(secret)},${name},${meta.client_uri ?? null},${sql.param(meta.redirect_uris)}::text[],${sql.param(meta.grant_types)}::text[])`);
  log('info', { code: 'OAUTH_CLIENT_REGISTERED', client: clientId, method: meta.token_endpoint_auth_method });
  return respond({ client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_name: name ?? undefined, client_uri: meta.client_uri, redirect_uris: meta.redirect_uris, grant_types: meta.grant_types,
    response_types: meta.grant_types.includes('authorization_code') ? ['code'] : [], token_endpoint_auth_method: meta.token_endpoint_auth_method }, 201);
}

// ---------- authorization (browser) ----------

async function authorize(c: Ctx) {
  const runtime = c.env, query = new URL(c.req.url).searchParams;
  // Before the redirect URI is known to be the client's, nothing goes back to it: the consent page explains instead.
  const page = (error: 'request' | 'client' | 'redirect' | 'busy') => c.redirect(`${runtime.config.publicUrl}/consent?error=${error}`, 303);
  for (const key of new Set(query.keys())) if (query.getAll(key).length > 1) return page('request');
  const get = (name: string) => query.get(name) || null;
  const clientId = get('client_id'), redirectUri = get('redirect_uri'), state = get('state');
  if (!clientId || clientId.length > 512 || (state?.length ?? 0) > 2048) return page('request');
  const client = await resolveClient(runtime, clientId);
  if (!client || !client.grantTypes.includes('authorization_code')) return page('client');
  if (!redirectUri || !redirectKind(redirectUri) || !client.redirectUris.some(registered => redirectMatches(registered, redirectUri))) return page('redirect');
  // Errors now go back to the client (RFC 6749 §4.1.2.1), with iss (RFC 9207).
  const back = (error: string, description: string) => {
    const url = new URL(redirectUri);
    url.searchParams.set('error', error); url.searchParams.set('error_description', description);
    if (state) url.searchParams.set('state', state);
    url.searchParams.set('iss', issuer(runtime));
    return c.redirect(url.href, 303);
  };
  if (get('response_type') !== 'code') return back('unsupported_response_type', 'Bane supports response_type=code.');
  if (query.has('request') || query.has('request_uri')) return back('request_not_supported', 'Send the parameters in the URL.');
  const challenge = get('code_challenge');
  if (!challenge || get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return back('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
  if (get('prompt')?.split(' ').includes('none')) return back('consent_required', 'A person approves every client on Bane’s consent page.');
  const scopes = parseScopes(get('scope'));
  if (!scopes) return back('invalid_scope', `Request ${SCOPES.join(', ')}.`);
  const target = targetResource(runtime, get('resource'));
  if (!target) return back('invalid_target', `The resource is ${mcpResource(runtime)}.`);
  if (!await budget(runtime, 'authorize', c.req.header('x-bane-client-ip') ?? 'unknown')) return page('busy');
  const requestId = id('oar');
  await runtime.db.execute(sql`INSERT INTO bane_oauth_requests(id,flow,client_id,client_name,redirect_uri,state,code_challenge,scopes,profile,refresh,expires_at)
    VALUES (${requestId},'code',${client.id},${client.name},${redirectUri},${state},${challenge},${sql.param(scopes)}::text[],${target.profile},${client.grantTypes.includes('refresh_token')},now()+${REQUEST_SECONDS}*interval '1 second')`);
  // A browser with a Bane session opens the consent page; one without signs in first and comes back to it.
  const consent = new URL(`/consent/${requestId}`, runtime.config.publicUrl);
  if (await browserSignedIn(runtime, c.req.raw.headers)) return c.redirect(consent.href, 303);
  try { return c.redirect(await signInRedirect(c, consent), 303); }
  catch { return c.redirect(consent.href, 303); }
}

// ---------- device authorization (RFC 8628) ----------

function userCode() {
  let code = '';
  while (code.length < 8) for (const byte of crypto.getRandomValues(new Uint8Array(16))) if (byte < 240 && code.length < 8) code += USER_CODE[byte % 24];
  return code;
}
const formatUserCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;
async function deviceAuthorization(c: Ctx) {
  const runtime = c.env;
  try {
    const params = await formParams(c);
    const caller = await authenticateClient(runtime, c, params);
    const client = await resolveClient(runtime, caller.id);
    if (!client) throw new OAuthError('invalid_client', 'Client authentication failed.', 401);
    if (!client.grantTypes.includes(DEVICE_GRANT)) throw new OAuthError('unauthorized_client', `List ${DEVICE_GRANT} in this client's grant_types.`);
    const scopes = parseScopes(value(params, 'scope'));
    if (!scopes) throw new OAuthError('invalid_scope', `Request ${SCOPES.join(', ')}.`);
    const target = targetResource(runtime, value(params, 'resource'));
    if (!target) throw new OAuthError('invalid_target', `The resource is ${mcpResource(runtime)}.`);
    const ip = c.req.header('x-bane-client-ip') ?? 'unknown';
    if (!await budget(runtime, 'device', ip)) return respond({ error: 'slow_down', error_description: 'Too many device requests from this network. Retry in a minute.' }, 429, { 'retry-after': '60' });
    const deviceCode = randomSecret('bane_dc_'), country = c.req.header('x-bane-client-country')?.slice(0, 2) ?? null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = userCode();
      const created = await runtime.db.execute(sql`INSERT INTO bane_oauth_requests(id,flow,client_id,client_name,scopes,profile,refresh,device_hash,user_code,requested_ip,requested_country,interval_seconds,expires_at)
        VALUES (${id('oar')},'device',${client.id},${client.name},${sql.param(scopes)}::text[],${target.profile},${client.grantTypes.includes('refresh_token')},${await digest(deviceCode)},${code},${ip},${country},${DEVICE_INTERVAL},now()+${DEVICE_SECONDS}*interval '1 second')
        ON CONFLICT (user_code) DO NOTHING RETURNING id`);
      if (!created.rowCount) continue;
      const page = `${runtime.config.publicUrl}/device`;
      return respond({ device_code: deviceCode, user_code: formatUserCode(code), verification_uri: page, verification_uri_complete: `${page}?code=${formatUserCode(code)}`, expires_in: DEVICE_SECONDS, interval: DEVICE_INTERVAL });
    }
    throw new Error('No free device user code');
  } catch (error) { return failure(error); }
}

// ---------- token endpoint ----------

type Issued = { access_token: string; token_type: 'Bearer' | 'DPoP'; expires_in: number; refresh_token?: string; scope: string };
const refreshToken = (family: string) => `bane_rt_${family}${randomSecret('')}`;
const REFRESH_TOKEN = /^bane_rt_([0-9a-f]{32})[0-9a-f]{64}$/;
/**
 * An access token for an approval and, the first time a client may refresh, its refresh token chain. The approval's
 * expiry follows the newest refresh token (or, without one, the access token).
 */
async function issue(db: DbExecutor, grant: { id: string; clientId: string; scopes: Permission[]; jkt: string | null }, refresh: 'new' | string | null) {
  const access = randomSecret('bane_at_'), family = refresh === 'new' ? randomSecret('').slice(0, 32) : refresh;
  const token = family ? refreshToken(family) : null;
  await db.execute(sql`INSERT INTO bane_oauth_tokens(hash,kind,grant_id,client_id,scopes,jkt,expires_at)
    VALUES (${await digest(access)},'access',${grant.id},${grant.clientId},${sql.param(grant.scopes)}::text[],${grant.jkt},now()+${ACCESS_SECONDS}*interval '1 second')`);
  if (refresh === 'new') await db.execute(sql`INSERT INTO bane_oauth_refresh(family,grant_id,client_id,scopes,jkt,current_hash,expires_at)
    VALUES (${family},${grant.id},${grant.clientId},${sql.param(grant.scopes)}::text[],${grant.jkt},${await digest(token!)},now()+${REFRESH_SECONDS}*interval '1 second')`);
  await db.execute(sql`UPDATE bane_resource_grants SET expires_at=now()+${family ? REFRESH_SECONDS : ACCESS_SECONDS}*interval '1 second',
    issued_at=extract(epoch from now())::bigint, updated_at=now() WHERE id=${grant.id}`);
  const body: Issued = { access_token: access, token_type: grant.jkt ? 'DPoP' : 'Bearer', expires_in: ACCESS_SECONDS, ...(token ? { refresh_token: token } : {}), scope: grant.scopes.map(p => `bane:${p}`).join(' ') };
  return body;
}
type Outcome = { issued: Issued } | { error: string; message: string } | { reuse: string };
const invalidGrant = (message: string) => ({ error: 'invalid_grant', message });

async function exchangeCode(runtime: Runtime, clientId: string, params: URLSearchParams, jkt: string | null): Promise<Outcome> {
  const code = value(params, 'code'), redirectUri = value(params, 'redirect_uri'), verifier = value(params, 'code_verifier');
  if (!code || !redirectUri || !verifier) throw new OAuthError('invalid_request', 'Send code, redirect_uri and code_verifier.');
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return invalidGrant('The code verifier is malformed.');
  if (!/^[0-9a-f]{64}$/.test(code)) return invalidGrant('The authorization code is invalid.');
  const challenge = await challengeOf(verifier), hash = await digest(code);
  return runtime.db.transaction(async tx => {
    const { rows: [row] } = await tx.execute<{ id: string; status: string; live: boolean; client_id: string; redirect_uri: string; code_challenge: string; grant_id: string; refresh: boolean; permissions: Permission[] }>(sql`
      SELECT r.id, r.status, r.expires_at > now() AS live, r.client_id, r.redirect_uri, r.code_challenge, r.grant_id, r.refresh, g.permissions
      FROM bane_oauth_requests r JOIN bane_resource_grants g ON g.id = r.grant_id WHERE r.code_hash = ${hash} AND r.flow = 'code' AND NOT g.revoked FOR UPDATE OF r`);
    if (!row) return invalidGrant('The authorization code is invalid.');
    // A second use means someone else may hold it: the approval it created ends (RFC 6749 §4.1.2).
    if (row.status === 'used') return { reuse: row.grant_id };
    if (row.status !== 'approved' || !row.live || row.client_id !== clientId || row.redirect_uri !== redirectUri || row.code_challenge !== challenge)
      return invalidGrant('The authorization code is invalid or expired, or belongs to another client, redirect URI or code verifier.');
    await tx.execute(sql`UPDATE bane_oauth_requests SET status='used' WHERE id=${row.id}`);
    return { issued: await issue(tx, { id: row.grant_id, clientId, scopes: row.permissions, jkt }, row.refresh ? 'new' : null) };
  });
}

async function refreshTokens(runtime: Runtime, clientId: string, params: URLSearchParams, jkt: string | null): Promise<Outcome> {
  const token = value(params, 'refresh_token'), scope = value(params, 'scope');
  if (!token) throw new OAuthError('invalid_request', 'Send the refresh_token.');
  const family = REFRESH_TOKEN.exec(token)?.[1];
  if (!family) return invalidGrant('The refresh token is invalid.');
  const narrowed = scope === null ? null : parseScopes(scope);
  if (scope !== null && !narrowed) throw new OAuthError('invalid_scope', `Request ${SCOPES.join(', ')}.`);
  const hash = await digest(token), binding = `oauth-replay:${family}`;
  return runtime.db.transaction(async tx => {
    const { rows: [row] } = await tx.execute<{ grant_id: string; client_id: string; scopes: Permission[]; jkt: string | null; current_hash: string; previous_hash: string | null; recent: boolean; replay: string | null; live: boolean; workspace_id: string | null }>(sql`
      SELECT f.grant_id, f.client_id, f.scopes, f.jkt, f.current_hash, f.previous_hash, coalesce(f.rotated_at > now() - ${REPLAY_SECONDS}*interval '1 second', false) AS recent,
        f.replay, f.expires_at > now() AS live, g.workspace_id
      FROM bane_oauth_refresh f JOIN bane_resource_grants g ON g.id = f.grant_id WHERE f.family = ${family} AND NOT g.revoked FOR UPDATE OF f`);
    if (!row || row.client_id !== clientId) return invalidGrant('The refresh token is invalid.');
    if (row.jkt && row.jkt !== jkt) return invalidGrant('This refresh token is bound to a DPoP key: send a proof of that key.');
    if (!sameHash(hash, row.current_hash)) {
      // The token just rotated, within the window: the same new pair again. Any other token of this chain is a reuse.
      if (row.previous_hash && sameHash(hash, row.previous_hash) && row.recent && row.replay) {
        const { body, at } = JSON.parse(await decrypt(runtime, row.replay, binding)) as { body: Issued; at: number };
        return { issued: { ...body, expires_in: Math.max(1, ACCESS_SECONDS - Math.floor((Date.now() - at) / 1000)) } };
      }
      return { reuse: row.grant_id };
    }
    if (!row.live) return invalidGrant('The refresh token expired. Sign in again.');
    // Removed from the workspace, a role that no longer covers what was approved, or a revoked approval: sign in again.
    // An approval still waiting for its workspace (none, or its workspace was deleted) refreshes while it waits.
    if (row.workspace_id !== null && !await mcpGrantActor(runtime, row.grant_id, tx)) return invalidGrant('This approval no longer works. Sign in to Bane again.');
    // A narrower scope narrows the access token; the refresh token keeps what was approved (RFC 6749 §6).
    const scopes = narrowed ? row.scopes.filter(p => narrowed.includes(p)) : row.scopes;
    if (!scopes.length) throw new OAuthError('invalid_scope', 'The refresh token has none of those scopes.');
    const issued = await issue(tx, { id: row.grant_id, clientId, scopes, jkt: row.jkt }, family);
    await tx.execute(sql`UPDATE bane_oauth_refresh SET previous_hash=current_hash, current_hash=${await digest(issued.refresh_token!)}, rotated_at=now(),
      replay=${await encrypt(runtime, JSON.stringify({ body: issued, at: Date.now() }), binding)}, expires_at=now()+${REFRESH_SECONDS}*interval '1 second' WHERE family=${family}`);
    return { issued };
  });
}

async function deviceTokens(runtime: Runtime, clientId: string, params: URLSearchParams, jkt: string | null): Promise<Outcome> {
  const code = value(params, 'device_code');
  if (!code) throw new OAuthError('invalid_request', 'Send the device_code.');
  if (!/^bane_dc_[0-9a-f]{64}$/.test(code)) return invalidGrant('The device code is invalid.');
  const hash = await digest(code);
  return runtime.db.transaction(async tx => {
    const { rows: [row] } = await tx.execute<{ id: string; status: string; live: boolean; early: boolean; client_id: string; grant_id: string | null; refresh: boolean; permissions: Permission[] | null; revoked: boolean | null }>(sql`
      SELECT r.id, r.status, r.expires_at > now() AS live, coalesce(r.polled_at > now() - r.interval_seconds * interval '1 second', false) AS early,
        r.client_id, r.grant_id, r.refresh, g.permissions, g.revoked
      FROM bane_oauth_requests r LEFT JOIN bane_resource_grants g ON g.id = r.grant_id WHERE r.device_hash = ${hash} AND r.flow = 'device' FOR UPDATE OF r`);
    if (!row || row.client_id !== clientId || row.status === 'used') return invalidGrant('The device code is invalid or was already used.');
    if (!row.live) return { error: 'expired_token', message: 'The device code expired. Start again.' };
    if (row.status === 'denied') {
      await tx.execute(sql`UPDATE bane_oauth_requests SET status='used' WHERE id=${row.id}`);
      return { error: 'access_denied', message: 'The person denied this request.' };
    }
    if (row.status === 'pending') {
      // Polling faster than the interval adds 5 seconds to it, for this and every later poll (RFC 8628 §3.5).
      await tx.execute(sql`UPDATE bane_oauth_requests SET polled_at=now(), interval_seconds=${row.early ? sql`least(interval_seconds+5, 60)` : sql`interval_seconds`} WHERE id=${row.id}`);
      return row.early ? { error: 'slow_down', message: 'Poll less often.' } : { error: 'authorization_pending', message: 'The person hasn’t approved this request yet.' };
    }
    if (!row.grant_id || row.revoked !== false) return invalidGrant('This approval was revoked.');
    await tx.execute(sql`UPDATE bane_oauth_requests SET status='used' WHERE id=${row.id}`);
    return { issued: await issue(tx, { id: row.grant_id, clientId, scopes: row.permissions!, jkt }, row.refresh ? 'new' : null) };
  });
}

async function tokenEndpoint(c: Ctx) {
  const runtime = c.env;
  try {
    const params = await formParams(c);
    const { id: clientId } = await authenticateClient(runtime, c, params);
    // DPoP is optional: a client that proves a key at the token endpoint gets tokens bound to it (RFC 9449).
    const proof = c.req.header('dpop');
    const jkt = proof ? await verifyDpop(runtime, proof, { htm: 'POST', htu: endpoints(runtime).token }) : null;
    if (proof && !jkt) throw new OAuthError('invalid_dpop_proof', 'The DPoP proof is invalid.');
    if (value(params, 'resource') !== null && !targetResource(runtime, value(params, 'resource'))) throw new OAuthError('invalid_target', `The resource is ${mcpResource(runtime)}.`);
    const grantType = value(params, 'grant_type');
    const outcome = grantType === 'authorization_code' ? await exchangeCode(runtime, clientId, params, jkt)
      : grantType === 'refresh_token' ? await refreshTokens(runtime, clientId, params, jkt)
      : grantType === DEVICE_GRANT ? await deviceTokens(runtime, clientId, params, jkt)
      : null;
    if (!outcome) throw new OAuthError('unsupported_grant_type', `Use authorization_code, refresh_token or ${DEVICE_GRANT}.`);
    if ('reuse' in outcome) {
      await revokeGrant(runtime, outcome.reuse, systemActor(c), grantType === 'refresh_token' ? 'A rotated refresh token was used again.' : 'An authorization code was used again.');
      log('warn', { code: 'OAUTH_TOKEN_REUSE', grant: outcome.reuse, grantType });
      throw new OAuthError('invalid_grant', 'This token was already used. Its approval is revoked: sign in again.');
    }
    if ('error' in outcome) throw new OAuthError(outcome.error, outcome.message);
    return respond(outcome.issued);
  } catch (error) { return failure(error); }
}

// ---------- revocation (RFC 7009) ----------

const systemActor = (c: Ctx): AuditContext => ({ ...auditContext(c), actor: { type: 'system', id: null, via: 'mcp' } });
/** Ends an approval: its tokens, the agent tokens it minted, and what it owns (paused or revoked by the ownership
 * triggers). Settings, the revocation endpoint and token reuse all end an approval this way. */
export async function revokeGrant(runtime: Runtime, grantId: string, context: AuditContext, reason?: string, owner?: { userId: string; workspaceId: string }) {
  const { rows } = await runtime.db.execute<{ id: string }>(sql`WITH revoked AS (UPDATE bane_resource_grants SET revoked=true,updated_at=now()
        WHERE id=${grantId} ${owner ? sql`AND user_id=${owner.userId}` : sql``} RETURNING id,grant_key,client_id,permissions,workspace_id,user_id),
      agents AS (UPDATE agent_tokens SET revoked_at=now() WHERE revoked_at IS NULL AND grant_id IN (SELECT id FROM revoked)),
      removed AS (DELETE FROM mail_grant_objects WHERE grant_id IN (SELECT grant_key FROM revoked)),
      tokens AS (DELETE FROM bane_oauth_tokens WHERE grant_id IN (SELECT id FROM revoked)),
      chains AS (DELETE FROM bane_oauth_refresh WHERE grant_id IN (SELECT id FROM revoked)),
      audit AS (${auditInsert(context, { action: 'mcp_connection.revoke', workspaceId: owner ? sql`coalesce(revoked.workspace_id,${owner.workspaceId})` : sql`revoked.workspace_id`,
        userId: sql`revoked.user_id`, target: { type: 'mcp_connection', id: sql`revoked.id` }, reason, before: sql`jsonb_build_object('clientId',revoked.client_id,'scopes',revoked.permissions)` }, { from: sql`revoked` })})
    SELECT id FROM revoked`);
  return rows.length > 0;
}

async function revokeEndpoint(c: Ctx) {
  const runtime = c.env;
  try {
    const params = await formParams(c);
    const token = value(params, 'token');
    if (!token) throw new OAuthError('invalid_request', 'Send the token to revoke.');
    const auditAs = (grantId: string): AuditContext => ({ ...auditContext(c), actor: { type: 'mcp_grant', id: grantId, via: 'mcp', grantId } });
    // An MCP key belongs to no client: whoever holds it may revoke it (a key that leaked).
    if (MCP_KEY.test(token)) {
      const { rows: [key] } = await runtime.db.execute<{ grant_id: string }>(sql`SELECT grant_id FROM bane_oauth_tokens WHERE hash=${await digest(token)} AND kind='key'`);
      if (key) await revokeGrant(runtime, key.grant_id, auditAs(key.grant_id), 'Revoked with the key.');
      return respond({});
    }
    const { id: clientId } = await authenticateClient(runtime, c, params);
    const hash = await digest(token), family = REFRESH_TOKEN.exec(token)?.[1];
    // Signing out with a refresh token of the chain ends the approval; an access token alone is deleted. Any other
    // token, or another client's, gets the same answer (RFC 7009 §2.2).
    if (family) {
      const { rows: [chain] } = await runtime.db.execute<{ grant_id: string }>(sql`SELECT grant_id FROM bane_oauth_refresh WHERE family=${family} AND client_id=${clientId} AND ${hash} IN (current_hash, previous_hash)`);
      if (chain) await revokeGrant(runtime, chain.grant_id, auditAs(chain.grant_id), 'The client revoked its refresh token.');
    } else if (ACCESS_TOKEN.test(token)) await runtime.db.execute(sql`DELETE FROM bane_oauth_tokens WHERE hash=${hash} AND kind='access' AND client_id=${clientId}`);
    return respond({});
  } catch (error) { return failure(error); }
}

// ---------- approvals: the consent page, the device page and MCP keys ----------

type Session = NonNullable<Awaited<ReturnType<typeof currentSession>>>;
/**
 * Creates an approval for the signed-in session's own account, in a workspace it belongs to, with permissions its role
 * can grant: a member gets read and send only, and receiving needs manage and an owner or admin. When the installation
 * requires an authentication context (hosted: Google), the session must have signed in that way; the approval records it.
 */
export async function createApproval(runtime: Runtime, tx: DbExecutor, session: Session, input: { kind: 'oauth' | 'key'; clientId: string; clientName: string | null; workspaceId: string; permissions: Permission[]; receiving: boolean; profile: string | null; expiresSeconds: number }) {
  const required = runtime.config.accountRequiredAcr;
  if (required && session.acr !== required) throw new ApiError(403, 'REAUTHENTICATION_REQUIRED', required === 'urn:anomaly:acr:google' ? 'Sign in to Bane again with Google to approve this.' : 'Sign in to Bane again to approve this.');
  if (!input.permissions.length) throw new ApiError(422, 'VALIDATION_FAILED', 'Choose at least one permission.');
  if (input.receiving && !input.permissions.includes('manage')) throw new ApiError(422, 'VALIDATION_FAILED', 'Receiving tools need the manage permission.');
  const { rows: [member] } = await tx.execute<{ role: string }>(sql`SELECT m.role FROM workspace_members m JOIN bane_oidc_identities i ON i.user_id=m.user_id
    WHERE m.workspace_id=${input.workspaceId} AND m.user_id=${session.user_id} AND i.issuer=${session.issuer} AND i.subject=${session.subject} AND m.role IN ('owner','admin','member')
      AND (${runtime.config.multiTenant} OR (m.role IN ('owner','admin') AND ${JSON.stringify(runtime.config.allowedSubjects)}::jsonb ? i.subject)) FOR SHARE OF m`);
  if (!member) throw new ApiError(403, 'PERMISSION_DENIED', 'You are not a member of that workspace.');
  if (member.role === 'member' && (input.permissions.includes('manage') || input.receiving)) throw new ApiError(403, 'ADMIN_REQUIRED', 'Manage and receiving need an owner or admin of that workspace.');
  const grantId = `mcp_${id(input.kind === 'key' ? 'mck' : 'oag')}`;
  await tx.execute(sql`INSERT INTO bane_resource_grants(id,kind,issuer,subject,user_id,client_id,client_name,workspace_id,permissions,receiving,acr,profile,expires_at)
    VALUES (${grantId},${input.kind},${session.issuer},${session.subject},${session.user_id},${input.clientId},${input.clientName},${input.workspaceId},${sql.param(input.permissions)}::text[],${input.receiving},${session.acr},${input.profile},now()+${input.expiresSeconds}*interval '1 second')`);
  return grantId;
}
const memberActor = (c: Ctx, userId: string): AuditContext => ({ ...auditContext(c), actor: { type: 'member', id: userId, userId, via: 'dashboard' } });

const Approval = z.object({ workspaceId: z.string().min(1).max(200), scopes: z.array(z.enum(['bane:read', 'bane:send', 'bane:manage'])).min(1).max(3), receiving: z.boolean().default(false) }).strict();
async function approve(c: Ctx, requestId: string, session: Session) {
  const runtime = c.env, input = Approval.safeParse(await c.req.json().catch(() => null));
  if (!input.success) throw new ApiError(422, 'VALIDATION_FAILED', 'Choose a workspace and at least one permission.');
  const permissions = PERMISSIONS.filter(p => input.data.scopes.includes(`bane:${p}`));
  const code = randomSecret('');
  const result = await runtime.db.transaction(async tx => {
    const { rows: [request] } = await tx.execute<{ flow: 'code' | 'device'; client_id: string; client_name: string | null; redirect_uri: string | null; state: string | null; scopes: Permission[]; profile: string | null }>(sql`
      SELECT flow, client_id, client_name, redirect_uri, state, scopes, profile FROM bane_oauth_requests WHERE id=${requestId} AND status='pending' AND expires_at > now() FOR UPDATE`);
    if (!request) throw new ApiError(404, 'NOT_FOUND', 'This request expired or was already answered. Start again from the app.');
    // Consent narrows what the client asked for; it never adds to it.
    if (permissions.some(p => !request.scopes.includes(p))) throw new ApiError(422, 'VALIDATION_FAILED', 'Approve only permissions the app asked for.');
    const grantId = await createApproval(runtime, tx, session, { kind: 'oauth', clientId: request.client_id, clientName: request.client_name, workspaceId: input.data.workspaceId, permissions, receiving: input.data.receiving, profile: request.profile, expiresSeconds: CODE_SECONDS });
    await tx.execute(sql`UPDATE bane_oauth_requests SET status='approved', grant_id=${grantId}, code_hash=${request.flow === 'code' ? await digest(code) : null},
      expires_at=${request.flow === 'code' ? sql`now()+${CODE_SECONDS}*interval '1 second'` : sql`greatest(expires_at, now()+interval '2 minutes')`} WHERE id=${requestId}`);
    await tx.execute(auditInsert(memberActor(c, session.user_id), { action: 'mcp_connection.approve', workspaceId: input.data.workspaceId, userId: session.user_id,
      target: { type: 'mcp_connection', id: grantId }, after: { clientId: request.client_id, scopes: permissions, receiving: input.data.receiving, flow: request.flow } }));
    return { request, grantId };
  });
  log('info', { code: 'MCP_APPROVAL_CREATED', userId: session.user_id, grant: result.grantId, client: result.request.client_id.slice(0, 200), flow: result.request.flow });
  if (result.request.flow === 'device') return { done: true };
  const url = new URL(result.request.redirect_uri!);
  url.searchParams.set('code', code);
  if (result.request.state) url.searchParams.set('state', result.request.state);
  url.searchParams.set('iss', issuer(runtime));
  return { redirect: url.href };
}
async function deny(c: Ctx, requestId: string) {
  const { rows: [request] } = await c.env.db.execute<{ flow: string; redirect_uri: string | null; state: string | null }>(sql`
    UPDATE bane_oauth_requests SET status='denied' WHERE id=${requestId} AND status='pending' AND expires_at > now() RETURNING flow, redirect_uri, state`);
  if (!request) throw new ApiError(404, 'NOT_FOUND', 'This request expired or was already answered.');
  if (request.flow === 'device') return { done: true };
  const url = new URL(request.redirect_uri!);
  url.searchParams.set('error', 'access_denied'); url.searchParams.set('error_description', 'The person denied access.');
  if (request.state) url.searchParams.set('state', request.state);
  url.searchParams.set('iss', issuer(c.env));
  return { redirect: url.href };
}
/** What the consent page shows about a pending request. The device grant adds where it came from, so a code someone
 * else started (and sent you) is easy to spot. */
async function requestView(runtime: Runtime, requestId: string) {
  const { rows: [r] } = await runtime.db.execute<{ id: string; flow: 'code' | 'device'; client_id: string; client_name: string | null; redirect_uri: string | null; scopes: Permission[]; profile: string | null;
    user_code: string | null; requested_ip: string | null; requested_country: string | null; created_at: string; expires_at: string }>(sql`
    SELECT id, flow, client_id, client_name, redirect_uri, scopes, profile, user_code, requested_ip, requested_country, created_at, expires_at
    FROM bane_oauth_requests WHERE id=${requestId} AND status='pending' AND expires_at > now()`);
  if (!r) throw new ApiError(404, 'NOT_FOUND', 'This request expired or was already answered. Start again from the app.');
  const document = documentUrl(r.client_id), redirect = r.redirect_uri ? new URL(r.redirect_uri) : null;
  return {
    id: r.id, flow: r.flow, scopes: r.scopes.map(p => `bane:${p}`), profile: r.profile, expiresAt: new Date(r.expires_at).toISOString(),
    // A metadata-document client is identified by its URL's domain; a registered client only by its own name.
    client: { id: r.client_id, name: r.client_name, domain: document?.hostname ?? null },
    redirect: redirect && { kind: redirectKind(r.redirect_uri!), host: redirect.protocol === 'http:' || redirect.protocol === 'https:' ? redirect.host : redirect.protocol.slice(0, -1) },
    device: r.flow === 'device' ? { userCode: formatUserCode(r.user_code!), ip: r.requested_ip, country: r.requested_country, requestedAt: new Date(r.created_at).toISOString() } : null,
  };
}
async function findDeviceRequest(c: Ctx, session: Session) {
  const input = z.object({ code: z.string().max(40) }).strict().safeParse(await c.req.json().catch(() => null));
  const code = input.success ? input.data.code.toUpperCase().replace(/[\s-]/g, '') : '';
  // Guesses are limited per person and per network: within a code's 10 minutes, a few hundred guesses at most against
  // 24^8 (about 10^11) codes.
  if (!await budget(c.env, 'device-code', session.user_id) || !await budget(c.env, 'device-code-ip', c.req.header('x-bane-client-ip') ?? 'unknown')) {
    c.header('Retry-After', '60');
    throw new ApiError(429, 'RATE_LIMITED', 'Too many codes tried. Wait a minute, then try again.', undefined, true);
  }
  const { rows: [row] } = new RegExp(`^[${USER_CODE}]{8}$`).test(code) ? await c.env.db.execute<{ id: string }>(sql`
    SELECT id FROM bane_oauth_requests WHERE user_code=${code} AND flow='device' AND status='pending' AND expires_at > now()`) : { rows: [] };
  if (!row) throw new ApiError(404, 'DEVICE_CODE_INVALID', 'That code is wrong or expired. Check it on your device, or start again there.');
  return { id: row.id };
}
async function browserRoute(c: Ctx) {
  const runtime = c.env, path = c.req.path;
  c.header('cache-control', 'no-store');
  if (c.req.header('authorization') !== undefined) throw new ApiError(403, 'DASHBOARD_AUTH_REQUIRED', 'Use a signed-in dashboard session.');
  if (c.req.method === 'POST' && c.req.header('origin') !== runtime.config.publicUrl) throw new ApiError(403, 'CSRF_ORIGIN_INVALID', 'Use the dashboard.');
  // The account this tab acts as (X-Bane-Account), else the browser's default: the account picked on the page.
  const session = await currentSession(runtime, c.req.raw.headers);
  if (!session) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to Bane.');
  const match = /^\/api\/oauth\/requests\/(oar_[0-9a-f]{32})(?:\/(approve|deny))?$/.exec(path);
  if (match && c.req.method === 'GET' && !match[2]) return c.json(await requestView(runtime, match[1]!));
  if (match && c.req.method === 'POST' && match[2] === 'approve') return c.json(await approve(c, match[1]!, session));
  if (match && c.req.method === 'POST' && match[2] === 'deny') return c.json(await deny(c, match[1]!));
  if (path === '/api/oauth/device' && c.req.method === 'POST') return c.json(await findDeviceRequest(c, session));
  throw new ApiError(404, 'NOT_FOUND', 'OAuth endpoint was not found.');
}

export function registerOAuthServer(app: App) {
  app.on(['GET', 'HEAD', 'OPTIONS'], '/.well-known/oauth-authorization-server', c => {
    c.header('Access-Control-Allow-Origin', '*');
    return c.req.method === 'OPTIONS' ? c.body(null, 204) : c.json(authorizationServerMetadata(c.env));
  });
  app.get('/oauth/authorize', authorize);
  // Browser-based clients call these across origins without cookies; credentials travel in the body or Authorization.
  for (const [path, handler] of [['/oauth/token', tokenEndpoint], ['/oauth/register', register], ['/oauth/revoke', revokeEndpoint], ['/oauth/device_authorization', deviceAuthorization]] as const) {
    app.options(path, c => new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'Authorization, Content-Type, DPoP', 'access-control-max-age': '600' } }));
    app.post(path, handler);
  }
  app.on(['GET', 'POST'], '/api/oauth/*', browserRoute);
}

/** MCP keys (Settings → Connected apps): a static bearer for an approval, for clients that can't run a browser sign-in. */
export async function createMcpKey(c: Ctx, userId: string, input: { name: string; workspaceId: string; permissions: Permission[]; receiving: boolean; expiresInDays: number }) {
  // The session the dashboard request authenticated with (the tab's account): its sign-in is what the key records.
  const runtime = c.env, session = await currentSession(runtime, c.req.raw.headers);
  if (!session || session.user_id !== userId) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to Bane.');
  const key = randomSecret('bane_mcp_'), seconds = input.expiresInDays * 86400;
  const grantId = await runtime.db.transaction(async tx => {
    const grantId = await createApproval(runtime, tx, session, { kind: 'key', clientId: 'bane:mcp-key', clientName: clientLabel(input.name) || 'MCP key', workspaceId: input.workspaceId,
      permissions: input.permissions, receiving: input.receiving, profile: null, expiresSeconds: seconds });
    await tx.execute(sql`UPDATE bane_resource_grants SET issued_at=extract(epoch from now())::bigint WHERE id=${grantId}`);
    await tx.execute(sql`INSERT INTO bane_oauth_tokens(hash,kind,grant_id,client_id,scopes,expires_at) VALUES (${await digest(key)},'key',${grantId},'bane:mcp-key',${sql.param(input.permissions)}::text[],now()+${seconds}*interval '1 second')`);
    await tx.execute(auditInsert(memberActor(c, session.user_id), { action: 'mcp_connection.create', workspaceId: input.workspaceId, userId: session.user_id,
      target: { type: 'mcp_connection', id: grantId }, after: { name: input.name, scopes: input.permissions, receiving: input.receiving, expiresInDays: input.expiresInDays } }));
    return grantId;
  });
  return { grantId, key };
}
