import { sql } from 'drizzle-orm';
import { ApiError, type Runtime, type ClaimedWebhook } from './core.js';
import { JobDeferred } from './jobs.js';
import { ActionRetry, endpointPolicy, replaySafe, retryAfterMs } from './ritual-retry.js';
import type { EndpointType } from './ritual-schema.js';
export { ActionRetry } from './ritual-retry.js';

type Sent = { status: number; retryAfter?: string | null; parked?: true };
/**
 * The one delivery path for every ritual endpoint call (Slack, Discord, webhook, forward).
 * Order: grant still active → endpoint policy and pause → per-action fence → per-endpoint rate slot → send.
 * The claim checks the pause too, but a pause can commit between the claim and this fence: the
 * fence holds the endpoint row (FOR SHARE) and parks the delivery, so unpause resumes it.
 * Retries all leave through ActionRetry, so backoff, jitter and Retry-After are identical for
 * every endpoint type. An attempt with an unknown outcome is replayed only when the endpoint is
 * idempotent or opted in to retryOnTimeout. Plain event subscriptions keep their webhook semantics.
 */
export async function ritualDelivery(runtime: Runtime, w: string, h: ClaimedWebhook, send: () => Promise<Sent>): Promise<Sent> {
  const grants = (h.payload as { grants?: string[] }).grants;
  if (grants?.length) {
    const { getMcpGrantActor } = await import('./mcp-auth.js');
    for (const id of grants) {
      const grant = await getMcpGrantActor(runtime, 'mcp_' + id);
      if (!grant?.receivingConsent || grant.workspaceId !== w || !grant.permissions.includes('manage')) throw new ApiError(403, 'GRANT_REVOKED', 'The receiving grant is no longer active.');
    }
  }
  const action = (h.payload as { ritualAction?: string }).ritualAction;
  if (!action && !h.routed) return send();
  const fence = await runtime.db.transaction(async tx => {
    const row = (await tx.execute<{ type: EndpointType | null; per_minute: number | null; retry_on_timeout: boolean | null; idempotent: boolean | null; paused: boolean }>(sql`
      SELECT nullif(split_part(d.ref,':',1),'') AS type,p.per_minute,p.retry_on_timeout,p.idempotent,h.paused
      FROM mailbox_webhooks h LEFT JOIN mail_endpoints d ON d.workspace_id=h.workspace_id AND d.hook_id=h.id
      LEFT JOIN mail_action_policies p ON p.workspace_id=h.workspace_id AND p.hook_id=h.id
      WHERE h.workspace_id=${w} AND h.id=${h.webhook_id} FOR SHARE OF h`)).rows[0];
    if (!row) throw new ApiError(422, 'UNKNOWN_DESTINATION', 'Endpoint no longer exists.');
    const policy = endpointPolicy(row.type ?? 'webhook', row);
    if (row.paused) {
      await tx.execute(sql`UPDATE mailbox_webhook_deliveries SET status='paused',last_error='ENDPOINT_PAUSED',updated_at=now() WHERE workspace_id=${w} AND id=${h.delivery_id} AND generation=${h.generation} AND status='pending'`);
      return { policy, done: true, parked: true as const };
    }
    // The action ID (the delivery ID) is stable across retries: it fences replays here and is the Idempotency-Key a webhook receives.
    const inserted = await tx.execute(sql`INSERT INTO mail_action_attempts VALUES(${w},${h.delivery_id},'sending') ON CONFLICT(delivery_id,workspace_id) DO NOTHING RETURNING state`);
    const prior = inserted.rowCount ? null : (await tx.execute<{ state: string }>(sql`SELECT state FROM mail_action_attempts WHERE workspace_id=${w} AND delivery_id=${h.delivery_id} FOR UPDATE`)).rows[0]!.state;
    if (prior === 'delivered') return { policy, done: true };
    if ((prior === 'unknown' || prior === 'sending') && !replaySafe(policy)) throw new ApiError(422, 'ACTION_UNKNOWN', 'A previous attempt may have succeeded. This endpoint does not replay unknown outcomes; set retryOnTimeout or idempotent to allow it.');
    const slot = await tx.execute(sql`INSERT INTO api_request_budgets AS b(workspace_id,key_id,window_start,used) VALUES(${w},${'ritual:' + h.webhook_id},date_trunc('minute',now()),1)
      ON CONFLICT(workspace_id,key_id) DO UPDATE SET used=CASE WHEN b.window_start=excluded.window_start THEN b.used+1 ELSE 1 END,window_start=excluded.window_start
      WHERE b.window_start<>excluded.window_start OR b.used<${policy.perMinute} RETURNING 1`);
    if (!slot.rowCount) throw new JobDeferred(new Date((Math.floor(Date.now() / 60000) + 1) * 60000).toISOString());
    if (prior) await tx.execute(sql`UPDATE mail_action_attempts SET state='sending' WHERE workspace_id=${w} AND delivery_id=${h.delivery_id}`);
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
    if (e instanceof JobDeferred) { await mark('retry'); throw e; }
    if (e instanceof ApiError) { await mark('retry'); throw e.retryable ? new ActionRetry(e.code) : e; }
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
