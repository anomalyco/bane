import { and, eq, sql } from 'drizzle-orm';
import { ApiError, digest, type Ctx, type Database } from './core.js';
import { sendingIdempotency } from './db/sending.js';

/**
 * Every create accepts Idempotency-Key. Sends, uploads, thread starts and replies, campaign drafts and
 * launches and domain creation implement it in their own handlers; this middleware covers the
 * rest with the same table and the same rules: the same key and body return the original result
 * (with Idempotent-Replayed: true), a different body is 409 IDEMPOTENCY_CONFLICT, and a
 * concurrent duplicate waits for the first request. The claim, the create and the stored result
 * commit in one transaction, so a crash cannot leave a create without its result.
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
const SECRET_FIELDS = ['secret', 'token', 'key', 'verificationToken'];

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
const carriesSecret = (body: unknown) =>
  !!body && typeof body === 'object' && (SECRET_FIELDS.some(k => typeof (body as Record<string, unknown>)[k] === 'string') || /"Authorization":"Bearer /.test(JSON.stringify((body as Record<string, unknown>).config ?? null)));
class Discard extends Error {}

function idempotentCreates(paths: RegExp[]) {
  return async (c: Ctx, next: () => Promise<void>) => {
    const key = c.req.header('Idempotency-Key');
    const principal = c.get('actor') ?? c.get('mailboxAccess');
    if (key === undefined || c.req.method !== 'POST' || !principal || !paths.some(p => p.test(c.req.path))) return next();
    if (key.length > 200 || !/^[\x21-\x7e]+$/.test(key)) throw new ApiError(422, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must contain 1–200 printable ASCII characters.');
    const text = await c.req.text();
    let parsed: unknown = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* hash the raw body */ }
    const requestHash = await digest(canonical(parsed));
    const identity = { workspaceId: principal.workspaceId, actorKeyId: principal.keyId, path: c.req.path, requestKey: key };
    const where = and(eq(sendingIdempotency.workspaceId, identity.workspaceId), eq(sendingIdempotency.actorKeyId, identity.actorKeyId), eq(sendingIdempotency.path, identity.path), eq(sendingIdempotency.requestKey, identity.requestKey));
    const env = c.env;
    try {
      return await env.db.transaction(async tx => {
        // A concurrent first attempt holds the unique row; this insert waits for it to commit or roll back.
        const claimed = await tx.insert(sendingIdempotency).values({ ...identity, requestHash }).onConflictDoNothing().returning({ claimed: sql`1` });
        if (!claimed.length) {
          const [previous] = await tx.select().from(sendingIdempotency).where(where);
          if (!previous || previous.requestHash !== requestHash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was already used with a different request. Use a new key for a new create.');
          const stored = previous.result as { status?: number; body?: unknown; withheld?: boolean; id?: string | null } | null;
          if (!stored?.status) throw new ApiError(409, 'IDEMPOTENCY_RESULT_MISSING', 'The original request with this key has no stored result.');
          if (stored.withheld) throw new ApiError(409, 'IDEMPOTENT_SECRET_WITHHELD', `This Idempotency-Key already created ${stored.id ?? 'the resource'}. Its secret was shown once and is not stored; revoke it and create another if it was lost.`);
          c.header('Idempotent-Replayed', 'true');
          return c.json(stored.body as object, stored.status as 200);
        }
        c.env = { ...env, db: tx as unknown as Database };
        try { await next(); } finally { c.env = env; }
        const status = c.res.status;
        if (status < 200 || status >= 300) throw new Discard();
        let body: unknown = null;
        try { body = await c.res.clone().json(); } catch { body = null; }
        const withheld = carriesSecret(body);
        const id = body && typeof body === 'object' && typeof (body as { id?: unknown }).id === 'string' ? (body as { id: string }).id : null;
        await tx.update(sendingIdempotency).set({ result: withheld ? { status, withheld: true, id } : { status, body } }).where(where);
        return c.res;
      });
    } catch (e) {
      // The create failed: its claim rolls back with it, so the caller may retry with the same key.
      if (e instanceof Discard) return c.res;
      throw e;
    }
  };
}
export const authenticatedCreates = idempotentCreates(AUTHENTICATED_CREATES);
export const mailboxCreates = idempotentCreates(MAILBOX_CREATES);
