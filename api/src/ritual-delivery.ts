import { sql } from 'drizzle-orm';
import { ApiError, type DbExecutor, type Runtime, type ClaimedWebhook } from './core.js';
import { JobDeferred } from './jobs.js';
import { ActionRetry, endpointPolicy, replaySafe, retryAfterMs } from './ritual-retry.js';
import type { EndpointType } from './ritual-schema.js';
export { ActionRetry } from './ritual-retry.js';

type Sent = { status: number; retryAfter?: string | null; parked?: true };
type Gate = { type: EndpointType | null; per_minute: number | null; retry_on_timeout: boolean | null; idempotent: boolean | null; paused: boolean; current: boolean };
/**
 * The fence every delivery passes before it may send, in one statement: it holds the endpoint and
 * the delivery row FOR SHARE, so a pause, a delete or another runner's settle either commits first
 * and is seen, or waits for this decision. It parks a delivery whose endpoint is paused (unpause
 * resumes it), and `current` is false when the claim went stale: its job lease expired (another
 * runner may claim or already claimed it), or the delivery settled or was resumed as a new
 * generation. No row: the endpoint is gone.
 */
type Claim = { id: string; attempts: number; leaseFence?: string };
const gate = async (db: DbExecutor, w: string, h: ClaimedWebhook, claim?: Claim) => (await db.execute<Gate>(sql`WITH g AS MATERIALIZED (
    SELECT nullif(split_part(d.ref,':',1),'') AS type,p.per_minute,p.retry_on_timeout,p.idempotent,h.paused,(q.status='pending' AND q.generation=${h.generation}
      AND (${claim?.leaseFence ?? null}::text IS NULL OR EXISTS(SELECT FROM jobs j WHERE j.id=${claim?.id ?? ''} AND j.attempts=${claim?.attempts ?? 0} AND j.status='running' AND j.lease_until=${claim?.leaseFence ?? null}::timestamptz))) AS current
    FROM mailbox_webhooks h JOIN mailbox_webhook_deliveries q ON q.workspace_id=h.workspace_id AND q.id=${h.delivery_id} AND q.webhook_id=h.id
    LEFT JOIN mail_endpoints d ON d.workspace_id=h.workspace_id AND d.hook_id=h.id
    LEFT JOIN mail_action_policies p ON p.workspace_id=h.workspace_id AND p.hook_id=h.id
    WHERE h.workspace_id=${w} AND h.id=${h.webhook_id} FOR SHARE OF h,q),
  parked AS (UPDATE mailbox_webhook_deliveries x SET status='paused',last_error='ENDPOINT_PAUSED',updated_at=now() FROM g
    WHERE g.paused AND g.current AND x.workspace_id=${w} AND x.id=${h.delivery_id} AND x.generation=${h.generation} AND x.status='pending')
  SELECT * FROM g`)).rows[0];
/** Node's errors for a connection that never carried the request: refused, no route, a failed name lookup or TLS handshake.
 * Nothing left, so the outcome is known and a retry cannot duplicate. A reset or a timeout may follow a sent request and
 * stays unknown; a Worker's fetch reports none of these codes, and an unreachable origin answers it with a 52x instead. */
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID']);
const notSent = (e: unknown) => e instanceof Error && NOT_SENT.has(String((e as { code?: unknown }).code));
/** A transport deferral (the timeout breaker) happens before anything leaves: it keeps the attempts already spent. */
const keepAttempts = (e: unknown) => e instanceof JobDeferred ? new JobDeferred(e.availableAt, e.payload, true) : e;
/**
 * The one delivery path for every mailbox delivery: ritual endpoint calls (Slack, Discord, webhook,
 * forward), routed webhooks and plain event subscriptions.
 * Order: grant still active → the gate (pause, stale claim) → per-action fence → per-endpoint rate slot → send.
 * The claim checks the pause too, but a pause can commit between the claim and the send; every
 * delivery passes the gate just before it sends.
 * Retries all leave through ActionRetry, so backoff, jitter and Retry-After are identical for
 * every endpoint type. An attempt with an unknown outcome is replayed only when the endpoint is
 * idempotent or opted in to retryOnTimeout. Plain event subscriptions keep their webhook semantics
 * (at-least-once with Webhook-Id, no attempt row or rate slot), so their gate is one autocommit statement.
 */
export async function ritualDelivery(runtime: Runtime, w: string, h: ClaimedWebhook, send: () => Promise<Sent>, claim?: Claim): Promise<Sent> {
  const grants = (h.payload as { grants?: string[] }).grants;
  if (grants?.length) {
    const { getMcpGrantActor } = await import('./mcp-auth.js');
    for (const id of grants) {
      const grant = await getMcpGrantActor(runtime, 'mcp_' + id, w);
      if (!grant?.receivingConsent || grant.workspaceId !== w || !grant.permissions.includes('manage')) throw new ApiError(403, 'GRANT_REVOKED', 'The receiving grant is no longer active.');
    }
  }
  const action = (h.payload as { ritualAction?: string }).ritualAction;
  if (!action && !h.routed) {
    const row = await gate(runtime.db, w, h, claim);
    if (!row?.current || row.paused) return { status: 0, parked: true };
    try { return await send(); } catch (e) { throw keepAttempts(e); }
  }
  const fence = await runtime.db.transaction(async tx => {
    const row = await gate(tx, w, h, claim);
    if (!row) throw new ApiError(422, 'UNKNOWN_DESTINATION', 'Endpoint no longer exists.');
    const policy = endpointPolicy(row.type ?? 'webhook', row);
    // Paused (the gate parked it), or the claim went stale: the delivery is no longer this runner's to attempt.
    if (!row.current || row.paused) return { policy, done: true, parked: true as const };
    // The action ID (the delivery ID) is stable across retries: it fences replays here and is the Idempotency-Key a webhook receives.
    const inserted = await tx.execute(sql`INSERT INTO mail_action_attempts VALUES(${w},${h.delivery_id},'sending') ON CONFLICT(delivery_id,workspace_id) DO NOTHING RETURNING state`);
    const prior = inserted.rowCount ? null : (await tx.execute<{ state: string }>(sql`SELECT state FROM mail_action_attempts WHERE workspace_id=${w} AND delivery_id=${h.delivery_id} FOR UPDATE`)).rows[0]!.state;
    if (prior === 'delivered') return { policy, done: true };
    if ((prior === 'unknown' || prior === 'sending') && !replaySafe(policy)) throw new ApiError(422, 'ACTION_UNKNOWN', 'A previous attempt may have succeeded. This endpoint does not replay unknown outcomes; set retryOnTimeout or idempotent to allow it.');
    const slot = await tx.execute(sql`INSERT INTO api_request_budgets AS b(workspace_id,key_id,window_start,used) VALUES(${w},${'ritual:' + h.webhook_id},date_trunc('minute',now()),1)
      ON CONFLICT(workspace_id,key_id) DO UPDATE SET used=CASE WHEN b.window_start=excluded.window_start THEN b.used+1 ELSE 1 END,window_start=excluded.window_start
      WHERE b.window_start<>excluded.window_start OR b.used<${policy.perMinute} RETURNING 1`);
    // Waiting for the next minute is not an attempt, and does not erase the attempts already made.
    if (!slot.rowCount) throw new JobDeferred(new Date((Math.floor(Date.now() / 60000) + 1) * 60000).toISOString(), undefined, true);
    if (prior) await tx.execute(sql`UPDATE mail_action_attempts SET state='sending',attempts=attempts+1 WHERE workspace_id=${w} AND delivery_id=${h.delivery_id}`);
    return { policy, done: false };
  });
  if ('parked' in fence) return { status: 0, parked: true };
  if (fence.done) return { status: 200 };
  const mark = (state: 'retry' | 'unknown' | 'delivered') => runtime.db.execute(sql`UPDATE mail_action_attempts SET state=${state} WHERE workspace_id=${w} AND delivery_id=${h.delivery_id}`);
  let result: Sent;
  try {
    result = await send();
  } catch (e) {
    // Deferred or refused before anything left: the outcome is known, so a retry cannot duplicate.
    // The breaker deferred it: nothing left, so the fence's count of attempts goes back down.
    if (e instanceof JobDeferred) { await runtime.db.execute(sql`UPDATE mail_action_attempts SET state='retry',attempts=greatest(attempts-1,0) WHERE workspace_id=${w} AND delivery_id=${h.delivery_id}`); throw keepAttempts(e); }
    if (e instanceof ApiError) { await mark('retry'); throw e.retryable ? new ActionRetry(e.code) : e; }
    if (notSent(e)) { await mark('retry'); throw new ActionRetry('DESTINATION_UNREACHABLE'); }
    await mark('unknown');
    if (replaySafe(fence.policy)) throw new ActionRetry('ACTION_UNKNOWN');
    throw new ApiError(422, 'ACTION_UNKNOWN', 'No response; this endpoint does not replay unknown outcomes.');
  }
  if (result.status >= 200 && result.status < 300) { await mark('delivered'); return result; }
  await mark('retry');
  if (result.status === 429 || result.status === 408 || result.status >= 500)
    throw new ActionRetry(result.status === 429 ? 'DESTINATION_THROTTLED' : 'DESTINATION_UNAVAILABLE', retryAfterMs(result.retryAfter));
  throw new ApiError(422, 'DESTINATION_REFUSED', `Endpoint returned HTTP ${result.status}.`);
}
