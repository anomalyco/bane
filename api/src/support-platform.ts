import type { Config } from './core.js';

// The support platform's door into Nightmail (api/README.md "Support integration"): a Cloudflare service binding to the
// `SupportPlatform` entrypoint (src/worker.ts), not a token. Only a Worker in the same account that declares a binding
// to that entrypoint can call it, so the credential is the deploy configuration itself: it cannot leak, needs no
// rotation, and is revoked by removing the binding or the entrypoint.
//
// It answers exactly what the support Worker needs and nothing else (PR #137 review L2): verify a handoff, verify an
// email sender, mint and revoke a support grant, read a handoff, verify a staff sign-in, and the grant-scoped GET
// /v1/support/* reads. Each call runs through the normal routes, so validation, audit rows and budgets are the same as
// for an operator. Operator paths act as `service:bane-support`; /v1/support/* still needs the grant's own bearer.

/** What the entrypoint passes to the app as `Runtime.platformCaller`. HTTP requests can never set it. */
export const SUPPORT_PLATFORM_CALLER = 'bane-support';

const OPERATOR_ROUTES: [method: string, path: RegExp][] = [
  ['POST', /^\/v1\/operator\/support\/verify-email$/],
  ['POST', /^\/v1\/operator\/support\/grants$/],
  ['POST', /^\/v1\/operator\/support\/grants\/sgr_[0-9a-f]{32}\/revoke$/],
  ['GET', /^\/v1\/operator\/support\/handoffs\/sho_[0-9a-f]{32}$/],
  // Never GET staff-sign-in: only an operator's own dashboard session mints a staff token.
  ['POST', /^\/v1\/operator\/support\/staff\/verify$/],
];
const SUPPORT_READ = /^\/v1\/support\/[A-Za-z0-9_./-]{1,200}$/;
const SUPPORT_GRANT = /^nm_support_[0-9a-f]{64}$/;

/** Whether the binding may make this call: the five operator support routes, or a grant's GET under /v1/support. */
export function supportPlatformAllows(method: string, path: string) {
  if (path.includes('..') || path.includes('//')) return false;
  if (method === 'GET' && SUPPORT_READ.test(path)) return true;
  return OPERATOR_ROUTES.some(([m, p]) => m === method && p.test(path));
}

export type PlatformReply<T = unknown> = { status: number; body: T; requestId: string | null; retryAfter: string | null };
export type HandoffClaims = {
  id: string; kind: string; userId: string; email: string; role: string; workspace: { id: string; name: string };
  page: string | null; requestIds: string[]; shareContent: boolean; issuedAt: string; expiresAt: string;
};
export type HandoffCheck =
  | { ok: true; handoff: HandoffClaims & { usedAt: string | null; grantId: string | null; message: string | null } }
  | { ok: false; code: 'HANDOFF_INVALID' | 'HANDOFF_EXPIRED' | 'HANDOFF_NOT_FOUND' | 'SUPPORT_NOT_CONFIGURED' };

export type StaffCheck =
  | { ok: true; staff: { userId: string; email: string; role: string }; jti: string; expiresAt: string }
  | { ok: false; code: 'STAFF_INVALID' | 'STAFF_EXPIRED' | 'NOT_OPERATOR' };

// ---------- the support tokens Nightmail signs: handoffs (aud bane-support) and staff sign-ins (aud bane-support-staff) ----------

type SigningKey = NonNullable<NonNullable<Config['support']>['signingKey']>;
const b64 = (value: string) => Buffer.from(value, 'base64url');
const b64url = (bytes: Uint8Array | string) => Buffer.from(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes).toString('base64url');
/** The key ID of the support signing key, in each token's header and in GET /v1/public/support-keys. */
export async function keyId(x: string) { return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(x)))).slice(0, 16); }
/** A compact JWS (EdDSA) with the support signing key; the support platform verifies it with GET /v1/public/support-keys. */
export async function signSupportToken(key: SigningKey, claims: Record<string, unknown>) {
  const header = b64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: await keyId(key.x) })), payload = b64url(JSON.stringify(claims));
  const signer = await crypto.subtle.importKey('jwk', { ...key, ext: false }, { name: 'Ed25519' }, false, ['sign']);
  return `${header}.${payload}.${b64url(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, signer, new TextEncoder().encode(`${header}.${payload}`))))}`;
}
/** The claims of a JWS this installation signed (its structure, algorithm, key ID and signature), or null. */
async function signedClaims(key: SigningKey, token: unknown): Promise<Record<string, unknown> | null> {
  const parts = typeof token === 'string' && token.length <= 4096 ? token.split('.') : [];
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];
  let head: { alg?: unknown; kid?: unknown }, claims: unknown;
  try { head = JSON.parse(b64(header).toString()); claims = JSON.parse(b64(payload).toString()); } catch { return null; }
  if (!head || head.alg !== 'EdDSA' || head.kid !== await keyId(key.x) || typeof claims !== 'object' || claims === null || Array.isArray(claims)) return null;
  const verifier = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: key.x }, { name: 'Ed25519' }, false, ['verify']);
  return await crypto.subtle.verify({ name: 'Ed25519' }, verifier, b64(signature), new TextEncoder().encode(`${header}.${payload}`)) ? claims as Record<string, unknown> : null;
}

/** Staff sign-in tokens (GET /v1/operator/support/staff-sign-in): their audience, lifetime and jti shape. */
export const STAFF_AUDIENCE = 'bane-support-staff', STAFF_TOKEN_SECONDS = 120;
export const STAFF_JTI = /^sst_[0-9a-f]{32}$/;
/**
 * Checks a staff sign-in JWS this installation signed: the signature, audience, issuer and the 2-minute lifetime. Whether
 * its subject is still an operator is the verify route's business; single use is the support Worker's (by jti).
 */
export async function verifyStaffToken(config: Pick<Config, 'support' | 'publicUrl'>, token: unknown, now = Date.now()): Promise<{ ok: true; claims: { userId: string; email: string; jti: string; expiresAt: string } } | { ok: false; code: 'STAFF_INVALID' | 'STAFF_EXPIRED' }> {
  const key = config.support?.signingKey, claims = key ? await signedClaims(key, token) : null;
  if (!claims || claims.aud !== STAFF_AUDIENCE || claims.iss !== config.publicUrl || typeof claims.sub !== 'string' || !claims.sub || typeof claims.jti !== 'string' || !STAFF_JTI.test(claims.jti)
    || typeof claims.iat !== 'number' || typeof claims.exp !== 'number' || claims.exp - claims.iat > STAFF_TOKEN_SECONDS || claims.iat * 1000 > now + 60_000) return { ok: false, code: 'STAFF_INVALID' };
  if (claims.exp * 1000 <= now) return { ok: false, code: 'STAFF_EXPIRED' };
  return { ok: true, claims: { userId: claims.sub, email: typeof claims.email === 'string' ? claims.email : '', jti: claims.jti, expiresAt: new Date(claims.exp * 1000).toISOString() } };
}

/**
 * Checks a handoff JWS that this installation signed (POST /v1/contact-support): the signature against its own key, the
 * audience, the issuer and the 10-minute expiry. The signature only proves Nightmail issued it; whether it was already used is
 * the handoff row's business, which minting checks atomically.
 */
export async function verifyHandoffToken(config: Pick<Config, 'support' | 'publicUrl'>, token: string, now = Date.now()): Promise<{ ok: true; claims: HandoffClaims } | { ok: false; code: 'HANDOFF_INVALID' | 'HANDOFF_EXPIRED' | 'SUPPORT_NOT_CONFIGURED' }> {
  const key = config.support?.signingKey;
  if (!key) return { ok: false, code: 'SUPPORT_NOT_CONFIGURED' };
  const claims = await signedClaims(key, token);
  if (!claims) return { ok: false, code: 'HANDOFF_INVALID' };
  const user = claims.user as { id?: unknown; email?: unknown; role?: unknown } | undefined, workspace = claims.workspace as { id?: unknown; name?: unknown } | undefined;
  if (claims.aud !== 'bane-support' || claims.iss !== config.publicUrl || typeof claims.jti !== 'string' || !/^sho_[0-9a-f]{32}$/.test(claims.jti)
    || typeof claims.exp !== 'number' || typeof claims.iat !== 'number' || typeof user?.id !== 'string' || typeof workspace?.id !== 'string') return { ok: false, code: 'HANDOFF_INVALID' };
  if (claims.exp * 1000 <= now) return { ok: false, code: 'HANDOFF_EXPIRED' };
  return { ok: true, claims: {
    id: claims.jti, kind: typeof claims.kind === 'string' ? claims.kind : 'support', userId: user.id, email: typeof user.email === 'string' ? user.email : '',
    role: typeof user.role === 'string' ? user.role : 'member', workspace: { id: workspace.id, name: typeof workspace.name === 'string' ? workspace.name : workspace.id },
    page: typeof claims.page === 'string' ? claims.page : null, requestIds: Array.isArray(claims.requestIds) ? claims.requestIds.filter((r): r is string => typeof r === 'string').slice(0, 5) : [],
    shareContent: claims.shareContent === true, issuedAt: new Date(claims.iat * 1000).toISOString(), expiresAt: new Date(claims.exp * 1000).toISOString(),
  } };
}

/**
 * The binding's methods, over a dispatcher that runs one request through the app as the support platform. Kept free of
 * `cloudflare:workers` so the acceptance suite drives exactly this on Node; src/worker.ts wraps it in the entrypoint.
 */
export function supportPlatform(dispatch: (request: Request) => Promise<Response>, config: () => Pick<Config, 'support' | 'publicUrl'>) {
  const origin = () => config().publicUrl.replace(/\/$/, '');
  async function call<T>(method: string, path: string, body?: unknown, grant?: string): Promise<PlatformReply<T>> {
    const url = new URL(path, 'https://internal.invalid');
    const refuse = (status: number, code: string, message: string) => {
      const requestId = `req_${crypto.randomUUID().replaceAll('-', '')}`;
      return { status, body: { error: { code, message, requestId, retryable: false } } as T, requestId, retryAfter: null };
    };
    if (!supportPlatformAllows(method, url.pathname)) return refuse(404, 'NOT_FOUND', 'The support platform cannot call this route.');
    const onSupport = url.pathname.startsWith('/v1/support/');
    if (onSupport !== (grant !== undefined) || (grant !== undefined && !SUPPORT_GRANT.test(grant))) return refuse(403, onSupport ? 'SUPPORT_GRANT_REQUIRED' : 'OPERATOR_REQUIRED', 'Use a support grant for /v1/support reads, and only there.');
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'bane-support (service binding)' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (grant) headers.authorization = `Bearer ${grant}`;
    const response = await dispatch(new Request(origin() + url.pathname + url.search, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
    const text = await response.text();
    let parsed: unknown = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { error: { code: 'INVALID_RESPONSE', message: text.slice(0, 200) } }; }
    return { status: response.status, body: parsed as T, requestId: response.headers.get('x-request-id'), retryAfter: response.headers.get('retry-after') };
  }
  return {
    /** A handoff JWS from the dashboard: its signed claims plus the stored row (used or not, the person's message). */
    async verifyHandoff(token: string): Promise<HandoffCheck> {
      const checked = await verifyHandoffToken(config(), token);
      if (!checked.ok) return checked;
      const stored = await call<{ userId: string; workspaceId: string; usedAt: string | null; grantId: string | null; message: string | null; shareContent: boolean }>('GET', `/v1/operator/support/handoffs/${checked.claims.id}`);
      if (stored.status === 404) return { ok: false, code: 'HANDOFF_NOT_FOUND' };
      if (stored.status !== 200) throw new Error(`Handoff lookup failed with ${stored.status}`);
      const row = stored.body;
      if (row.userId !== checked.claims.userId || row.workspaceId !== checked.claims.workspace.id) return { ok: false, code: 'HANDOFF_INVALID' };
      return { ok: true, handoff: { ...checked.claims, shareContent: row.shareContent, usedAt: row.usedAt, grantId: row.grantId, message: row.message } };
    },
    verifyEmail: (body: { email: string; evidence: { kind: 'dmarc'; result: 'pass'; aligned: true; messageId: string } | { kind: 'magic_link'; confirmedAt: string }; ticketRef?: string }) =>
      call<{ verified: boolean; user: { id: string; name: string } | null; workspaces: { id: string; name: string; role: string }[] }>('POST', '/v1/operator/support/verify-email', body),
    mintGrant: (body: { userId: string; ticketRef: string; reason: string; verification: 'handoff' | 'dmarc' | 'magic_link'; handoffId?: string; workspaceIds?: string[]; ttlMinutes?: number }) =>
      call<{ id: string; token: string; userId: string; workspaceIds: string[]; ticketRef: string; contentShared: boolean; contentWorkspaceId: string | null; expiresAt: string }>('POST', '/v1/operator/support/grants', body),
    revokeGrant: (grantId: string) => call<{ id: string; revoked: true }>('POST', `/v1/operator/support/grants/${grantId}/revoke`, {}),
    /**
     * A staff sign-in token from the staff-sign-in redirect: Nightmail's own signature, audience, issuer and expiry, and that its
     * subject is still an operator now. Returns its jti and expiry: the support Worker accepts each jti once.
     */
    async verifyStaff(token: string): Promise<StaffCheck> {
      if (typeof token !== 'string' || !token || token.length > 4096) return { ok: false, code: 'STAFF_INVALID' };
      const reply = await call<StaffCheck>('POST', '/v1/operator/support/staff/verify', { token });
      if (reply.status !== 200) throw new Error(`Staff verification failed with ${reply.status}`);
      return reply.body;
    },
    /** A grant-scoped read: `path` under /v1/support/, with its query. */
    read: <T = unknown>(path: string, grant: string) => call<T>('GET', path, undefined, grant),
    call,
  };
}
export type SupportPlatformApi = ReturnType<typeof supportPlatform>;
