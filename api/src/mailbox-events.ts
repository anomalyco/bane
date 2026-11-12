import {ActionRetry,ritualDelivery} from './ritual-delivery.js';
import { and, eq, gt, inArray, isNotNull, max, sql, type SQL } from 'drizzle-orm';
import { ApiError, lazyModule, log, ModuleLoadError, type DbExecutor, type JobHandler, type Runtime } from './core.js';
import { mailboxEvents } from './db/mailbox.js';
import { inboundHookClaim,JobDeferred,mailboxWebhookAttempts,retryDatabaseFailures } from './jobs.js';

export const inboundEventTypes = ['message.received', 'message.junk', 'message.stored', 'message.queued', 'message.sent', 'message.delivered', 'message.delayed', 'message.bounced', 'message.complained', 'message.failed', 'thread.updated', 'address.created', 'address.deleted', 'inbox.created', 'inbox.deleted', 'message.held', 'inbox.quota_exceeded'] as const;
type MailboxEventType = typeof inboundEventTypes[number];
export type MailboxEventInput = { type: MailboxEventType; mailboxId: string | null; threadId?: string | null; messageId?: string | null; data?: Record<string, unknown> };

export const eventView = (row: typeof mailboxEvents.$inferSelect) => ({ id: `mev_${row.seq}`, cursor: String(row.seq), type: row.type as MailboxEventType, createdAt: new Date(row.createdAt).toISOString(), addressId: row.mailboxId, threadId: row.threadId, messageId: row.messageId, data: row.data });
export const webhookSecretBinding = (workspaceId: string, webhookId: string) => `${workspaceId}:live:mailbox:${webhookId}`;

// Both ingest and outbound sync append the same immutable event and webhook snapshots. Take the
// workspace lanes in a consistent order before allocating sequence numbers, so cursors never skip a commit.
export function mailboxEventCtes(source:SQL) {
  return sql`items AS MATERIALIZED (${source}), lanes AS (
    INSERT INTO mailbox_write_lanes(workspace_id,lane) SELECT DISTINCT workspace_id,'events' FROM items ORDER BY workspace_id
    ON CONFLICT(workspace_id,lane) DO UPDATE SET lane=excluded.lane RETURNING workspace_id
  ), events AS (INSERT INTO mailbox_events(workspace_id,type,mailbox_id,thread_id,message_id,data)
    SELECT workspace_id,type,mailbox_id,thread_id,message_id,data FROM items JOIN lanes USING(workspace_id) ORDER BY workspace_id,ord RETURNING *
  ), deliveries AS (INSERT INTO mailbox_webhook_deliveries(id,workspace_id,webhook_id,event_seq,payload)
    SELECT 'mwd_'||gen_random_uuid(),e.workspace_id,h.id,e.seq,jsonb_build_object('id','mev_'||e.seq,'cursor',e.seq::text,'type',e.type,'createdAt',to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'addressId',e.mailbox_id,'threadId',e.thread_id,'messageId',e.message_id,'data',e.data)
    FROM events e JOIN mailbox_webhooks h ON h.workspace_id=e.workspace_id AND NOT h.paused
      AND (h.mailbox_ids IS NULL OR (e.type<>'message.stored' AND h.mailbox_ids ? e.mailbox_id))
      AND h.event_types ? e.type RETURNING id,workspace_id
  ), queued AS (INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'job_'||gen_random_uuid(),'mailbox.webhook',workspace_id,jsonb_build_object('deliveryId',id) FROM deliveries RETURNING 1)`;
}

const fanout:JobHandler=retryDatabaseFailures(async(runtime,payload,job)=>{
  // Snapshot endpoint IDs at commit, not at expansion: a new subscription never receives historical mail.
  // A routed ref carries its recipient's junk decision (153); the event's type is only a fallback for older refs.
  const records=sql`deliveries AS (INSERT INTO mailbox_webhook_deliveries(id,workspace_id,webhook_id,event_seq,routed,format,payload)
    SELECT CASE WHEN ref?'ritualAction' THEN 'mwd_'||md5(e.workspace_id||':'||(ref->>'ritualAction')||':'||h.id) ELSE 'mwd_'||gen_random_uuid() END,e.workspace_id,h.id,CASE WHEN NOT ref?'ritualAction' THEN e.seq END,jsonb_typeof(ref)='object' AND NOT ref?'subscription',h.format,jsonb_build_object('id','mev_'||e.seq,'cursor',e.seq::text,'type',CASE WHEN ref?'junk' THEN CASE WHEN (ref->>'junk')::boolean THEN 'message.junk' ELSE 'message.received' END ELSE e.type END,'createdAt',to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'addressId',e.mailbox_id,'threadId',e.thread_id,'messageId',e.message_id,'data',CASE WHEN jsonb_typeof(ref)='object' THEN e.data||jsonb_build_object('recipients',jsonb_build_array(ref->>'recipient'),'route',ref->'route','junk',CASE WHEN ref?'junk' THEN (ref->>'junk')::boolean ELSE e.type='message.junk' END,'subaddress',substring(split_part(ref->>'recipient','@',1) from '[+](.*)')) ELSE e.data END)||CASE WHEN ref?'body' THEN jsonb_build_object('ritualBody',ref->'body') ELSE '{}'::jsonb END||CASE WHEN ref?'ritualAction' THEN jsonb_build_object('ritualAction',ref->'ritualAction') ELSE '{}'::jsonb END||CASE WHEN ref?'grants' THEN jsonb_build_object('grants',ref->'grants') ELSE '{}'::jsonb END
    FROM settled CROSS JOIN jsonb_each(${JSON.stringify(payload)}::jsonb) s(seq,hooks) JOIN mailbox_events e ON e.workspace_id=${job.workspaceId} AND e.seq=s.seq::bigint
    CROSS JOIN jsonb_array_elements(s.hooks) ref JOIN mailbox_webhooks h ON h.workspace_id=e.workspace_id AND h.id=coalesce(ref->>'id',ref#>>'{}')
    ON CONFLICT DO NOTHING RETURNING id,workspace_id),
    queued AS (INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'job_'||gen_random_uuid(),'mailbox.webhook',workspace_id,jsonb_build_object('deliveryId',id) FROM deliveries)`;
  if(job.recordWithSettlement)job.recordWithSettlement(records);else await runtime.db.execute(sql`WITH settled AS (SELECT 1),${records} SELECT 1`);
});

export async function recordEvents(tx: DbExecutor, workspaceId: string, items: MailboxEventInput[]): Promise<number> {
  if (!items.length) return 0;
  const source=sql`SELECT ${workspaceId}::text AS workspace_id,j->>'type' AS type,j->>'mailboxId' AS mailbox_id,j->>'threadId' AS thread_id,j->>'messageId' AS message_id,coalesce(j->'data','{}') AS data,ord FROM jsonb_array_elements(${JSON.stringify(items)}::jsonb) WITH ORDINALITY t(j,ord)`;
  return (await tx.execute<{n:number}>(sql`WITH ${mailboxEventCtes(source)} SELECT count(*)::int AS n FROM queued`)).rows[0]!.n;
}

type EventScope = { mailboxIds: string[] | null; includeStored: boolean };
function visibleEvents(workspaceId: string, { mailboxIds, includeStored }: EventScope) {
  // All mailboxes is not workspace access: mailbox keys cannot see null-mailbox events.
  return and(eq(mailboxEvents.workspaceId, workspaceId),
    mailboxIds !== null ? inArray(mailboxEvents.mailboxId, mailboxIds) : includeStored ? undefined : isNotNull(mailboxEvents.mailboxId));
}
export async function readEvents(db: DbExecutor, workspaceId: string, input: EventScope & { after: number; types?: string[]; limit: number }) {
  return db.select().from(mailboxEvents).where(and(visibleEvents(workspaceId, input), gt(mailboxEvents.seq, input.after),
    inArray(mailboxEvents.type, input.types?.length ? input.types : [...inboundEventTypes]))).orderBy(mailboxEvents.seq).limit(input.limit);
}
export async function latestCursor(db: DbExecutor, workspaceId: string, scope: EventScope) {
  const [result] = await db.select({ seq: max(mailboxEvents.seq) }).from(mailboxEvents).where(visibleEvents(workspaceId, scope));
  return result?.seq ?? 0;
}

const loadWebhookOps = lazyModule(() => import('./inbound-webhook.js'));
const webhookJob: JobHandler = async (runtime, payload, job) => {
  const delivery=job.webhook!==undefined?job.webhook:(await runtime.db.execute<import('./core.js').ClaimedWebhook>(sql`WITH claimed AS (SELECT ${job.id}::text AS id,${job.workspaceId}::text AS workspace_id,'mailbox.webhook' AS type,${JSON.stringify(payload)}::jsonb AS payload),${inboundHookClaim} SELECT * FROM inbound_hooks WHERE blocked IS NULL`)).rows[0];
  if(!delivery)return;
  const {deliverInboundWebhook}=await loadWebhookOps();
  let statusCode: number | null = null, error: string | null = null, retryable = true;
  let actionError:ActionRetry|undefined;try {
    const result=await ritualDelivery(runtime,job.workspaceId,delivery,()=>deliverInboundWebhook(runtime,job.workspaceId,delivery));
    // Paused after the claim: the fence parked the delivery for resume; nothing was sent.
    if(result.parked)return;
    if(result.status===410)retryable=false;
    statusCode = result.status; if (statusCode < 200 || statusCode >= 300) error = 'WEBHOOK_HTTP_ERROR';
  } catch (e) { if(e instanceof ActionRetry)actionError=e;if (e instanceof ModuleLoadError || e instanceof JobDeferred) throw e; error = e instanceof ApiError ? e.code : 'WEBHOOK_NETWORK_ERROR'; retryable = !(e instanceof ApiError) || e.retryable; }
  const retry = Boolean(error) && retryable && job.attempts < mailboxWebhookAttempts(delivery);
  const record=sql`recorded AS (UPDATE mailbox_webhook_deliveries d SET attempt_count=attempt_count+1,status=${!error?'delivered':retry?'pending':'failed'},last_status_code=${statusCode}::int,last_error=${error}::text,updated_at=now() FROM settled WHERE d.id=${delivery.delivery_id} AND d.workspace_id=${job.workspaceId} AND d.generation=${delivery.generation} AND d.status='pending')`;
  if(job.recordWithSettlement)job.recordWithSettlement(record);else await runtime.db.execute(sql`WITH settled AS (SELECT 1),${record} SELECT 1`);
  if(actionError&&retry)throw actionError;
  if (error) throw new ApiError(503, error, 'Mailbox webhook delivery failed; it will be retried.', undefined, retry);
};

export async function pruneMailboxEvents(runtime: Runtime) {
  await runtime.db.execute(sql`WITH expired AS (DELETE FROM mailbox_events WHERE seq IN (SELECT seq FROM mailbox_events WHERE created_at<now()-interval '30 days' ORDER BY created_at LIMIT 5000 FOR UPDATE SKIP LOCKED)),
    ignored AS (DELETE FROM mail_ignored_staging WHERE (bucket,ses_message_id) IN (SELECT bucket,ses_message_id FROM mail_ignored_staging WHERE created_at<now()-interval '3 days' ORDER BY created_at LIMIT 5000 FOR UPDATE SKIP LOCKED))
    DELETE FROM mailbox_webhook_deliveries WHERE id IN (SELECT id FROM mailbox_webhook_deliveries WHERE created_at<now()-interval '30 days' AND status IN ('delivered','failed','paused') ORDER BY created_at LIMIT 5000 FOR UPDATE SKIP LOCKED)`);
  log('info', { code: 'MAILBOX_EVENTS_PRUNED' });
}

// A resumed delivery keeps the attempts it already made: a pause holds the retries, it does not refill them.
const resumeDeliveries:JobHandler=async(runtime,payload,job)=>{
  const result=await runtime.db.execute(sql`WITH hook AS MATERIALIZED (SELECT id FROM mailbox_webhooks WHERE workspace_id=${job.workspaceId} AND id=${String(payload.hook)} AND NOT paused FOR SHARE),
    page AS (SELECT d.id FROM mailbox_webhook_deliveries d JOIN hook ON hook.id=d.webhook_id WHERE d.workspace_id=${job.workspaceId} AND d.status='paused' AND d.created_at>=now()-interval '30 days' ORDER BY d.id LIMIT 100 FOR UPDATE OF d),
    resumed AS (UPDATE mailbox_webhook_deliveries d SET status='pending',generation=generation+1,last_error=NULL,updated_at=now() FROM page WHERE d.id=page.id RETURNING d.*)
    INSERT INTO jobs(id,type,workspace_id,payload,attempts) SELECT 'job_'||gen_random_uuid(),'mailbox.webhook',workspace_id,jsonb_build_object('deliveryId',id,'generation',generation),attempt_count FROM resumed`);
  if(result.rowCount===100)throw new JobDeferred(new Date().toISOString());
};
export const mailboxEventJobs: Record<string, JobHandler> = { 'mailbox.webhook': retryDatabaseFailures(webhookJob),'mailbox.fanout':fanout,'mailbox.resumeDeliveries':retryDatabaseFailures(resumeDeliveries) };
