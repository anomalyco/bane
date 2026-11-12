import { and, eq, sql } from 'drizzle-orm';
import { ApiError, digest, webhookUrlHint, type Ctx } from './core.js';
import { sendingIdempotency } from './db/sending.js';

/**
 * Every create accepts Idempotency-Key. Sends, uploads, thread starts and replies, campaign drafts and
 * launches and domain creation implement it in their own handlers; this middleware covers the
 * rest with the same table and the same rules: the same key and body return the original result
 * (with Idempotent-Replayed: true), a different body is 409 IDEMPOTENCY_CONFLICT, and a
 * concurrent duplicate gets a retryable conflict. A committed reservation prevents a second
 * create if the worker loses the result after the handler commits. A handler that fails after it
 * attempted a database write may have committed (a lost acknowledgement, a failed read after the
 * write), so its key keeps an unknown outcome instead of being released. No pool slot spans the
 * handler.
 *
 * A result that carries a secret (API key, token, webhook secret, inbox key) is never stored.
 * Replaying it returns 409 IDEMPOTENT_SECRET_WITHHELD naming what was created, so the caller can
 * revoke it and create another instead of getting a duplicate.
 */
const AUTHENTICATED_CREATES = [
  /^\/v1\/(?:contacts|lists|segments|contact-imports|templates|template-assets|webhooks|api-keys|agent-tokens|endpoints|inbox-connections)$/,
  /^\/v1\/template-assets\/import$/,
  /^\/v1\/routing\/routes$/,
];
const MAILBOX_CREATES = [/^\/v1\/inboxes$/, /^\/v1\/inbound\/(?:addresses|keys|webhooks)$/, /^\/v1\/inbound\/domains\/[^/]+\/subdomains$/];
// Field names that hold credentials at any depth (createInbox nests its key under credential.secret).
// "key" is not one: addresses and webhooks use it for their routing key.
const SECRET_FIELDS = new Set(['secret', 'token', 'verificationToken', 'password']);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
function carriesSecret(value: unknown, depth = 0): boolean {
  if (depth > 16) return true;
  if (typeof value === 'string') return /^(?:Bearer |bane_|whsec_)/.test(value);
  if (Array.isArray(value)) return value.some(item => carriesSecret(item, depth + 1));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([k, v]) => (SECRET_FIELDS.has(k) && typeof v === 'string' && v.length > 0) || carriesSecret(v, depth + 1));
}

// The handler's view of the database: every call that can write (or runs raw SQL, which may)
// marks the request as possibly committed before it starts.
const WRITES = new Set<PropertyKey>(['insert', 'update', 'delete', 'execute', 'transaction']);
function attemptedWrites(db: Ctx['env']['db'], mark: () => void): Ctx['env']['db'] {
  return new Proxy(db, { get(target, prop) {
    const value = Reflect.get(target, prop, target);
    if (typeof value !== 'function') return value;
    return WRITES.has(prop) ? (...args: unknown[]) => { mark(); return value.apply(target, args); } : value.bind(target);
  } });
}

function idempotentCreates(paths: RegExp[]) {
  return async (c: Ctx, next: () => Promise<void>) => {
    const key = c.req.header('Idempotency-Key');
    const principal = c.get('actor') ?? c.get('mailboxAccess');
    if (key === undefined || c.req.method !== 'POST' || !principal || !paths.some(p => p.test(c.req.path))) return next();
    if (key.length > 200 || !/^[\x21-\x7e]+$/.test(key)) throw new ApiError(422, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must contain 1–200 printable ASCII characters.');
    const text = await c.req.text();
    let parsed: unknown = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* hash the raw body */ }
    // The request's authority is part of its identity: permissions, sender domains or an inbox
    // key's configured scope (not the inboxes a provisioning key has since created, or its own
    // retry would conflict), and receiving consent.
    const inbox = c.get('mailboxAccess'), scope = inbox && (inbox.scopeIds === undefined ? inbox.mailboxIds : inbox.scopeIds);
    const requestHash = await digest(canonical([parsed,principal.permissions,c.get('actor')?.domains??scope,'receivingConsent' in principal?principal.receivingConsent??false:false]));
    const identity = { workspaceId: principal.workspaceId, actorKeyId: c.get('actor')?.tokenId??principal.keyId, path: c.req.path, requestKey: key };
    const where = and(eq(sendingIdempotency.workspaceId, identity.workspaceId), eq(sendingIdempotency.actorKeyId, identity.actorKeyId), eq(sendingIdempotency.path, identity.path), eq(sendingIdempotency.requestKey, identity.requestKey));
    const db=c.env.db;
    const claimed = await db.insert(sendingIdempotency).values({ ...identity, requestHash }).onConflictDoNothing().returning({ claimed: sql`1` });
    if (!claimed.length) {
      const [previous] = await db.select().from(sendingIdempotency).where(where);
      // The request that held the key failed and released it between our claim and this read.
      if (!previous) { c.header('Retry-After','1');throw new ApiError(409,'IDEMPOTENCY_IN_PROGRESS','Another request with this Idempotency-Key just finished without a result. Retry with the same key.',undefined,true); }
      if (previous.requestHash !== requestHash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was already used with a different request. Use a new key for a new create.');
      const stored = previous.result as { status?: number; body?: unknown; withheld?: boolean; unknown?: boolean; id?: string | null } | null;
      if (stored?.unknown) throw new ApiError(409, 'IDEMPOTENCY_OUTCOME_UNKNOWN', 'The original request failed after it may have committed. Check whether the resource was created before starting another request.');
      if (!stored?.status) {
        if (Date.now()-Date.parse(previous.createdAt)>=600_000) throw new ApiError(409,'IDEMPOTENCY_OUTCOME_UNKNOWN','No result was recorded within ten minutes. Check whether the resource was created before starting another request.');
        c.header('Retry-After','1');throw new ApiError(409,'IDEMPOTENCY_IN_PROGRESS','The original request has not recorded a result. Retry with the same key; do not repeat the create with a new key.',undefined,true);
      }
      if (stored.withheld) throw new ApiError(409, 'IDEMPOTENT_SECRET_WITHHELD', `This Idempotency-Key already created ${stored.id ?? 'the resource'}. Its secret was shown once and is not stored; revoke it and create another if it was lost.`);
      c.header('Idempotent-Replayed', 'true');
      // Receipts created before URL masking contain the full outbound webhook URL.
      if (c.req.path === '/v1/webhooks' && stored.body && typeof stored.body === 'object' && 'url' in stored.body && typeof stored.body.url === 'string') {
        return c.json({ ...stored.body, url: webhookUrlHint(stored.body.url) }, stored.status as 201);
      }
      return c.json(stored.body as object, stored.status as 200);
    }
    // A 4xx is a refusal: release the winning request's reservation so the key can be retried.
    // So is a failure before the handler attempted any write. A 5xx or thrown error after a write
    // attempt may follow a commit, so the key keeps an unknown outcome: a retry never creates
    // twice. Once the handler succeeds, a failure recording its result must not permit another.
    let wrote = false;
    c.env = { ...c.env, db: attemptedWrites(db, () => { wrote = true; }) };
    const settle = (status: number) => status < 500 || !wrote ? db.delete(sendingIdempotency).where(where) : db.update(sendingIdempotency).set({ result: { status, unknown: true } }).where(where);
    try { await next(); }
    catch (error) { await settle(500); throw error; }
    finally { c.env = { ...c.env, db }; }
    const status = c.res.status;
    if (status < 200 || status >= 300) {
      if (status >= 400) await settle(status);
      return c.res;
    }
    let body: unknown = null;
    try { body = await c.res.clone().json(); } catch { body = null; }
    const withheld = carriesSecret(body);
    const id = body && typeof body === 'object' && typeof (body as { id?: unknown }).id === 'string' ? (body as { id: string }).id : null;
    await db.update(sendingIdempotency).set({ result: withheld ? { status, withheld: true, id } : { status, body } }).where(where);
    return c.res;
  };
}
export const authenticatedCreates = idempotentCreates(AUTHENTICATED_CREATES);
export const mailboxCreates = idempotentCreates(MAILBOX_CREATES);
