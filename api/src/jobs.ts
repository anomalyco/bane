import { AsyncLocalStorage } from 'node:async_hooks';
import { and, eq, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { ApiError, id, log, ModuleLoadError } from './core.js';
import type { ClaimedWebhook, DbExecutor, JobHandler, Runtime } from './core.js';
import { jobs } from './db/core.js';
import { resolveRegionRuntime } from './ses-region-state.js';
import { failCampaign } from './states.js';
import { ingestInput,type IngestInput } from './mailbox-ingest-input.js';
export const MAX_ATTEMPTS = 6;
export const WEBHOOK_ATTEMPTS = 10;
const LOAD_ERROR_THRESHOLD = 6;
export async function wakeWebhooks(runtime:Runtime,count:number) {
  if (count) try { await runtime.wake?.(count,'webhook'); } catch { log('warn',{code:'QUEUE_WAKE_FAILED',message:'Webhook jobs remain durable.'}); }
}
// Wake messages drain the installation, not a tenant. Reuse the existing singleton reservation on upgrade.
export const WAKE_SCHEDULE_KEY = 'default';

// Keep regional settings and clients invocation-local. Concurrent lanes for one owner share the lookup,
// but never mutate the Node runner's installation config or reuse a different owner's settings.
export function workspaceRuntimes(runtime: Runtime) {
  const runtimes = new Map<string, Promise<Runtime>>();
  return (workspaceId: string) => {
    let resolved = runtimes.get(workspaceId);
    if (!resolved) {
      resolved = resolveRegionRuntime({ ...runtime, config: { ...runtime.config, workspaceId } }, { workspaceId }).catch(error => { runtimes.delete(workspaceId); throw error; });
      runtimes.set(workspaceId, resolved);
    }
    return resolved;
  };
}

// Counts enqueue() calls made while serving one request, so the response path wakes the queue only for new work.
const enqueued = new AsyncLocalStorage<{ count: number }>();
export async function countEnqueued(work: () => Promise<void>) {
  const scope = { count: 0 };
  await enqueued.run(scope, work);
  return scope.count;
}
export async function enqueue(db: DbExecutor, input: { type: string; workspaceId: string; payload: Record<string, unknown>; availableAt?: string }) {
  const jobId = id('job');
  await db.insert(jobs).values({ id: jobId, ...input });
  const scope = enqueued.getStore();
  if (scope) scope.count++;
  return jobId;
}
// Thrown by a handler that is polling (not failing): the runner returns the same row to pending at
// availableAt without consuming an attempt, instead of inserting a new job row per poll.
export class JobDeferred extends Error {
  constructor(readonly availableAt: string, readonly payload?: Record<string, unknown>) { super('Job deferred.'); }
}

export const retryDatabaseFailures = (handler: JobHandler): JobHandler => async (runtime, payload, job) => {
  try { await handler(runtime, payload, job); } catch (error) {
    if (error instanceof ApiError || error instanceof JobDeferred) throw error;
    throw new ApiError(503, 'OPERATION_TEMPORARILY_UNAVAILABLE', 'The background operation could not complete; it will be retried.', undefined, true);
  }
};

// Postgres is the durable queue. CF Queue messages only wake it; cron/polling recovers missed wakeups.
export function jobConcurrency(value: unknown, maximum = 8) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 ? Math.min(number, maximum) : 2;
}
// Input comes only from the actual claimed rows, never a caller-supplied endpoint. Hold the
// endpoint lock until paused deliveries are parked, so a concurrent resume sees and requeues them.
export const webhookClaimCtes = sql`hook_inputs AS MATERIALIZED (
  SELECT j.id AS job_id,d.workspace_id,d.id AS delivery_id,d.generation,d.webhook_id,d.event_id,d.payload,d.synthetic,w.url,w.encrypted_secret,w.encrypted_headers,w.paused
  FROM claimed j JOIN operation_deliveries d ON d.workspace_id=j.workspace_id AND d.id=j.payload->>'deliveryId'
    AND to_jsonb(d.generation)=j.payload->'generation' AND d.status<>'delivered'
  LEFT JOIN LATERAL (SELECT url,encrypted_secret,encrypted_headers,paused FROM operation_webhooks WHERE workspace_id=d.workspace_id AND id=d.webhook_id FOR SHARE) w ON true
  WHERE j.type='operation.webhook'
), parked AS (UPDATE operation_deliveries d SET status=CASE WHEN h.url IS NULL THEN 'failed' ELSE 'paused' END,
  last_error=CASE WHEN h.url IS NULL THEN 'ENDPOINT_DELETED' ELSE 'ENDPOINT_PAUSED' END,updated_at=now()
  FROM hook_inputs h WHERE d.id=h.delivery_id AND d.workspace_id=h.workspace_id AND d.generation=h.generation AND (h.url IS NULL OR (h.paused AND NOT h.synthetic)))`;
const hookJoin = sql`LEFT JOIN hook_inputs h ON h.job_id=j.id AND h.url IS NOT NULL AND (NOT h.paused OR h.synthetic)`;
export const inboundHookClaim=sql`inbound_hooks AS MATERIALIZED (SELECT j.id AS job_id,d.id AS delivery_id,d.generation,d.webhook_id,d.payload,d.payload->>'id' AS event_id,d.format,w.name,w.include,w.retry_attempts,w.timeout_seconds,w.url,w.encrypted_secret,w.encrypted_headers,
  CASE WHEN w.paused THEN 'ENDPOINT_PAUSED' WHEN d.payload->>'type'='message.junk' AND w.junk<>'include' THEN 'SUBSCRIPTION_CHANGED' WHEN NOT d.routed AND NOT((w.event_types ? (d.payload->>'type') OR (d.payload->>'type'='message.junk' AND w.event_types ? 'message.received')) AND (w.mailbox_ids IS NULL OR (d.payload->>'type'<>'message.stored' AND w.mailbox_ids ? (d.payload->>'addressId')))) THEN 'SUBSCRIPTION_CHANGED' END AS blocked
  FROM claimed j JOIN mailbox_webhook_deliveries d ON j.type='mailbox.webhook' AND d.workspace_id=j.workspace_id AND d.id=j.payload->>'deliveryId' AND d.status='pending' AND d.generation=coalesce((j.payload->>'generation')::int,0)
  JOIN LATERAL (SELECT h.url,h.encrypted_secret,h.encrypted_headers,h.paused,h.event_types,h.mailbox_ids,h.name,h.include,h.retry_attempts,h.timeout_seconds,h.junk FROM mailbox_webhooks h WHERE h.workspace_id=d.workspace_id AND h.id=d.webhook_id FOR SHARE) w ON true),
  inbound_parked AS (UPDATE mailbox_webhook_deliveries d SET status=CASE WHEN h.blocked='ENDPOINT_PAUSED' THEN 'paused' ELSE 'failed' END,last_error=h.blocked,updated_at=now() FROM inbound_hooks h WHERE h.blocked IS NOT NULL AND d.id=h.delivery_id AND d.generation=h.generation AND d.status='pending')`;
export const claimedWithWebhooks = sql`SELECT j.*,to_jsonb(h) AS webhook FROM claimed j ${hookJoin}`;
// Reserve before awaiting the claim, so overlapping drains in one isolate cannot both lease MIME work.
const ingestSlots=3;
let ingestReserved=0;
let hookCursor='';
export type JobHandlerResolver = Record<string, JobHandler> | ((type: string) => Promise<JobHandler | undefined> | JobHandler | undefined);
export type JobPool = 'all' | 'work' | 'webhooks';
const classes = (pool: JobPool) => pool === 'webhooks' ? ['hook'] : ['feedback','campaign','other','publish', ...(pool === 'all' ? ['hook'] : [])];
const jobDue = sql`CASE WHEN j.status='running' THEN j.lease_until ELSE j.available_at END`;
export async function processJobs(runtime: Runtime, handlers: JobHandlerResolver, limit = 1, concurrency = 1, maxDurationMs = 20000, pool: JobPool = 'all') {
  const started = Date.now(); let processed = 0, claims = 0, claimRequests = 0, activeJobs = 0, peakActiveJobs = 0;
  const effectiveConcurrency = jobConcurrency(concurrency);
  const laneJobs = Array<number>(effectiveConcurrency).fill(0);
  const freeLanes = new Set(laneJobs.map((_, index) => index));
  const active = new Set<Promise<void>>();
  const failures: unknown[] = [];
  let activeFeedback = 0;
  // Hold each class preference for four claims so it cannot line up with alternating feedback reservations.
  const rotation = Math.floor(Math.random() * 8);
  const budgetMs = Math.min(20000, Math.max(1, maxDurationMs));
  const maximumClaims = Math.min(Math.max(1, limit), 100);
  const regionalRuntime = workspaceRuntimes(runtime);
  type Claimed = { id: string; workspace_id: string; type: string; payload: Record<string, unknown>; attempts: number; lease_fence: string; webhook: ClaimedWebhook | null;ingest:IngestInput|null };
  const handle = async (job: Claimed, index: number, claimMs: number, claimBatchSize: number) => {
    const jobStarted = Date.now();
    processed++; laneJobs[index]!++;
    peakActiveJobs = Math.max(peakActiveJobs, ++activeJobs);
    // A job row that is requeued under the same id (campaign runs) carries a fresh payload.run token; fencing on it keeps
    // a worker that still holds the retired run from completing or requeueing the row the new run now owns.
    const fence = and(eq(jobs.id, job.id), eq(jobs.attempts, job.attempts), eq(jobs.status, 'running'), sql`${jobs.leaseUntil}=${job.lease_fence}::timestamptz`, typeof job.payload.run === 'string' ? sql`${jobs.payload}->>'run' = ${job.payload.run}` : undefined);
    const context = { jobId: job.id, operation: job.type, attempt: job.attempts, workspaceId: job.workspace_id, requestId: typeof job.payload.requestId === 'string' ? job.payload.requestId : undefined };
    let records: SQL | undefined, settling = false;
    const settle = (update: SQLWrapper) => {
      settling = true;
      return runtime.db.execute(records ? sql`WITH settled AS (${update.getSQL()} RETURNING id), ${records} SELECT 1` : update.getSQL());
    };
    const handlerPayload = '_loadFailures' in job.payload ? (() => { const { _loadFailures: _, ...rest } = job.payload; return rest; })() : job.payload;
    try {
      let handler: JobHandler | undefined;
      try { handler = typeof handlers === 'function' ? await handlers(job.type) : handlers[job.type]; }
      catch (error) { throw error instanceof ModuleLoadError ? error : new ModuleLoadError(error); }
      if (!handler) throw new ApiError(500, 'JOB_HANDLER_MISSING', 'No handler is registered for this job type.');
      const ownerRuntime = job.type.startsWith('campaign.') || job.type.startsWith('ses.') || job.type === 'mailbox.reconcile' || job.type === 'operation.ses'
        ? await regionalRuntime(job.workspace_id) : { ...runtime, config: { ...runtime.config, workspaceId: job.workspace_id } };
      await handler(ownerRuntime, handlerPayload, { id: job.id, attempts: job.attempts, workspaceId: job.workspace_id,
        webhook: job.webhook,ingest:job.ingest, recordWithSettlement: ctes => { records = ctes; } });
      await settle(runtime.db.update(jobs).set({ status: 'completed', leaseUntil: null, lastError: null, ...(handlerPayload !== job.payload ? { payload: handlerPayload } : {}) }).where(fence));
      log('info', { ...context, code: 'JOB_COMPLETED', claimMs, claimBatchSize, jobMs: Date.now() - jobStarted });
    } catch (error) {
      if (settling) throw error; // Outcome and job settle atomically. Let the durable lease recover a failed commit.
      if (error instanceof ModuleLoadError) {
        const priorLoadFailures = typeof job.payload._loadFailures === 'number' && Number.isInteger(job.payload._loadFailures) && job.payload._loadFailures >= 0 ? job.payload._loadFailures : 0;
        const loadFailures = priorLoadFailures + 1;
        const refundedAttempts = Math.max(0, job.attempts - 1);
        const delay = Math.min(15 * 60_000, 15_000 * 4 ** (loadFailures - 1));
        const nextPayload = { ...handlerPayload, _loadFailures: loadFailures };
        await runtime.db.update(jobs).set({ status: 'pending', attempts: refundedAttempts, leaseUntil: null, lastError: error.code, availableAt: new Date(Date.now() + delay).toISOString(), payload: nextPayload }).where(fence);
        log(loadFailures >= LOAD_ERROR_THRESHOLD ? 'error' : 'warn', { ...context, jobType: job.type, attempt: refundedAttempts, loadFailures, code: error.code, retryable: true, claimMs, claimBatchSize, jobMs: Date.now() - jobStarted, message: error.message });
        return;
      }
      if (error instanceof JobDeferred) {
        // A successful polling turn breaks a streak of failures/evictions.
        const nextPayload = error.payload ?? (handlerPayload !== job.payload ? handlerPayload : undefined);
        await runtime.db.update(jobs).set({ status: 'pending', attempts: 0, leaseUntil: null, lastError: null, availableAt: error.availableAt, ...(nextPayload ? { payload: nextPayload } : {}) }).where(fence);
        log('info', { ...context, code: 'JOB_DEFERRED', availableAt: error.availableAt, claimMs, claimBatchSize, jobMs: Date.now() - jobStarted });
        return;
      }
      const code = error instanceof ApiError ? error.code : 'JOB_INTERNAL_ERROR';
      // Domain failure-state persistence must eventually commit; stopping at the
      // ordinary attempt ceiling would strand a campaign in pending forever.
      const hook=job.type==='operation.webhook' || job.type==='mailbox.webhook';
      const retry = error instanceof ApiError && error.retryable && (job.attempts < (job.type==='mailbox.webhook'?1+(job.webhook?.retry_attempts??(WEBHOOK_ATTEMPTS-1)):hook?WEBHOOK_ATTEMPTS:MAX_ATTEMPTS) || error.code === 'JOB_FINALIZATION_FAILED');
      const delay=Math.min(hook ? 12*3600000 : 3600000,15000 * 4 ** (job.attempts - 1));
      await settle(runtime.db.update(jobs).set({ status: retry ? 'pending' : 'failed', leaseUntil: null, lastError: code, availableAt: new Date(Date.now() + delay).toISOString(), ...(job.type==='mailbox.webhook' && job.webhook?{payload:{...handlerPayload,maxAttempts:1+(job.webhook.retry_attempts??9)}}:handlerPayload!==job.payload?{payload:handlerPayload}:{}) }).where(fence));
      log('error', { ...context, code, retryable: retry, claimMs, claimBatchSize, jobMs: Date.now() - jobStarted, message: error instanceof ApiError ? error.message : 'Unexpected background failure; inspect stack frames.', stack: error instanceof ApiError ? undefined : error instanceof Error ? error.stack?.split('\n').slice(1).join('\n') : undefined });
    } finally {
      activeJobs--;
    }
  };
  try {
    while (!failures.length && claims < maximumClaims && Date.now() - started < budgetMs) {
      if (!freeLanes.size) {
        await Promise.race(active);
        continue;
      }
      const claimBatchSize = Math.min(freeLanes.size, maximumClaims - claims);
      const activeAtClaim = active.size;
      const claimStarted = Date.now();
      // The claim already charged the attempt before the isolate died. Retire exhausted
      // leases separately from this batch's slots so healthy jobs can run in the same claim.
      const exhausted=sql`j.attempts >= CASE WHEN j.type='mailbox.webhook' THEN coalesce((j.payload->>'maxAttempts')::int,${WEBHOOK_ATTEMPTS}::int) WHEN j.type='operation.webhook' THEN ${WEBHOOK_ATTEMPTS}::int ELSE ${MAX_ATTEMPTS}::int END AND j.last_error IS DISTINCT FROM 'JOB_FINALIZATION_FAILED'`;
      const due = sql`((j.status='pending' AND j.available_at <= now()) OR (j.status='running' AND j.lease_until < now() AND NOT (${exhausted})))`;
      const slots=pool==='webhooks'?0:Math.min(claimBatchSize,ingestSlots-ingestReserved);
      // Only the head of each class enters the preference sort. The expression matches
      // jobs_ready_page, even for an expired running lease (no OR/BitmapOr + wide sort).
      // Seek over distinct queued hook owners (not over their backlog). Each gets
      // one slot before anyone gets two; a single tenant can borrow idle slots.
      const hookOwners=sql`public.job_class(type)='hook' AND status IN ('pending','running')`;
      // Bound owner probes even if every job belongs to a different owner in
      // backoff. Include the due-index head so a cold cursor never reports
      // idle while work exists beyond this fair page.
      const hookPage=pool==='work'?sql``:sql`owners(wid,step) AS (
        (SELECT workspace_id,1 FROM jobs WHERE ${hookOwners} AND workspace_id>${hookCursor} ORDER BY workspace_id LIMIT 1) UNION ALL
        SELECT h.workspace_id,step+1 FROM owners CROSS JOIN LATERAL (SELECT workspace_id FROM jobs WHERE ${hookOwners} AND workspace_id>wid ORDER BY workspace_id LIMIT 1) h WHERE step<${4*claimBatchSize}
      ),`;
      const head = (kind:string, n:number) => kind==='hook' ? sql`WITH probe AS (SELECT wid FROM owners UNION
        (SELECT j.workspace_id FROM jobs j WHERE ${hookOwners} AND ${jobDue}<=now() AND (j.status='pending' OR NOT (${exhausted})) ORDER BY ${jobDue},j.id LIMIT 1)),
        picks AS (SELECT h.*,t.served_at,row_number() OVER(PARTITION BY wid ORDER BY h.due,h.id) AS slot FROM probe
        LEFT JOIN webhook_turns t ON t.workspace_id=wid CROSS JOIN LATERAL (SELECT j.id,${jobDue} AS due FROM jobs j WHERE ${hookOwners}
          AND j.workspace_id=wid AND ${jobDue}<=now() AND (j.status='pending' OR NOT (${exhausted})) ORDER BY ${jobDue},j.id LIMIT ${n}) h)
      SELECT j.id,j.type,j.available_at FROM picks p JOIN jobs j USING(id) WHERE ${due}
        ORDER BY p.slot,p.served_at NULLS FIRST,p.due,p.id LIMIT ${n} FOR UPDATE OF j SKIP LOCKED` : sql`SELECT j.id,j.type,j.available_at FROM jobs j
        WHERE public.job_class(j.type)=${kind} AND j.status IN ('pending','running') AND ${jobDue}<=now()
        AND (j.status='pending' OR NOT (${exhausted})) ORDER BY ${jobDue},j.id LIMIT ${n} FOR UPDATE SKIP LOCKED`;
      ingestReserved+=slots;
      let claimed:{rows:(Claimed & {hook_cursor?:string})[]}|undefined;
      try { claimed = await runtime.db.execute<Claimed>(sql`WITH RECURSIVE ${hookPage} exhausted AS (
        SELECT j.id,j.workspace_id,CASE WHEN starts_with(j.type,'campaign.') THEN j.payload->>'campaignId' END AS campaign_id
        FROM jobs j WHERE j.status='running' AND j.lease_until < now() AND ${exhausted} ORDER BY j.lease_until,j.id LIMIT 100 FOR UPDATE SKIP LOCKED
      ), parents AS MATERIALIZED (
        SELECT c.workspace_id,c.id FROM sending_campaigns c WHERE (c.workspace_id,c.id) IN (SELECT workspace_id,campaign_id FROM exhausted)
        ORDER BY c.id FOR NO KEY UPDATE SKIP LOCKED
      ), failed AS (UPDATE jobs j SET status='failed',last_error='JOB_LEASE_EXHAUSTED',lease_until=NULL FROM exhausted x WHERE j.id=x.id AND
        (x.campaign_id IS NULL OR EXISTS(SELECT FROM parents p WHERE (p.workspace_id,p.id)=(x.workspace_id,x.campaign_id)) OR NOT EXISTS(SELECT FROM sending_campaigns c WHERE (c.workspace_id,c.id)=(x.workspace_id,x.campaign_id)))
        RETURNING j.workspace_id,j.type,j.payload,x.campaign_id), campaigns_failed AS (${failCampaign(sql`(workspace_id,id) IN (SELECT workspace_id,campaign_id FROM failed WHERE campaign_id IS NOT NULL)`,{code:'JOB_LEASE_EXHAUSTED',message:'The campaign worker exhausted its leases.'})}),
      deliveries_failed AS (UPDATE operation_deliveries d SET status='failed',last_error='JOB_LEASE_EXHAUSTED',updated_at=now() FROM failed f
        WHERE f.type='operation.webhook' AND d.workspace_id=f.workspace_id AND d.id=f.payload->>'deliveryId' AND to_jsonb(d.generation)=f.payload->'generation' AND d.status='pending'), mailbox_failed AS (
        UPDATE mailbox_webhook_deliveries d SET status='failed',last_error='JOB_LEASE_EXHAUSTED',updated_at=now() FROM failed f WHERE f.type='mailbox.webhook' AND d.id=f.payload->>'deliveryId' AND d.workspace_id=f.workspace_id AND d.status='pending' AND d.generation=coalesce((f.payload->>'generation')::int,0)), feedback AS (
        SELECT id FROM (${head('feedback', pool!=='webhooks' && effectiveConcurrency > 1 && activeFeedback === 0 ? 1 : 0)}) f
      ), ingest_head AS MATERIALIZED (
        SELECT t.workspace_id FROM mail_ingest_turns t WHERE t.active>0 AND EXISTS(
          SELECT FROM jobs j WHERE j.workspace_id=t.workspace_id AND j.type='mailbox.ingest' AND j.status IN ('pending','running') AND ${jobDue}<=now() AND (j.status='pending' OR NOT (${exhausted})))
        ORDER BY t.served_at,t.workspace_id LIMIT (SELECT least(${slots}::int,${claimBatchSize}-count(*)) FROM feedback) FOR UPDATE OF t SKIP LOCKED
      ), ingest AS (
        SELECT h.id FROM ingest_head t CROSS JOIN LATERAL (SELECT j.id FROM jobs j WHERE j.workspace_id=t.workspace_id AND j.type='mailbox.ingest' AND j.status IN ('pending','running') AND ${jobDue}<=now() AND (j.status='pending' OR NOT (${exhausted})) ORDER BY ${jobDue},j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED) h
      ), regular AS (
        SELECT j.id FROM (${sql.join(classes(pool).map(kind=>sql`SELECT * FROM (${head(kind,claimBatchSize)}) page`),sql` UNION ALL `)}) j
        WHERE NOT EXISTS (SELECT 1 FROM feedback f WHERE f.id = j.id)
        ORDER BY CASE WHEN j.type IN ('operation.ses','operation.simulatedFeedback','operation.simulatedFeedbackRecovery','operation.publish','operation.publishBatch') THEN 1 ELSE 0 END,
          CASE WHEN ${Math.floor((rotation + claimRequests) / 4) % 2}::int = CASE WHEN starts_with(j.type, 'campaign.') THEN 1 ELSE 0 END THEN 0 ELSE 1 END,
          CASE WHEN starts_with(j.type, 'campaign.') THEN 1 WHEN j.type IN ('operation.ses','operation.simulatedFeedback','operation.simulatedFeedbackRecovery') THEN 2 WHEN j.type IN ('operation.publish','operation.publishBatch') THEN 3 ELSE 4 END,
          j.available_at, j.id LIMIT (${claimBatchSize} - (SELECT count(*) FROM feedback) - (SELECT count(*) FROM ingest))
      ), due AS (
        SELECT id FROM feedback UNION ALL SELECT id FROM ingest UNION ALL SELECT id FROM regular
      ), claimed AS (UPDATE jobs SET status = 'running', attempts = jobs.attempts + 1, lease_until = clock_timestamp() + interval '3 minutes'
        FROM due WHERE jobs.id = due.id RETURNING jobs.*,jobs.lease_until::text AS lease_fence), served AS (INSERT INTO mail_ingest_turns(workspace_id,served_at) SELECT workspace_id,clock_timestamp() FROM claimed WHERE type='mailbox.ingest'
          ON CONFLICT(workspace_id) DO UPDATE SET served_at=excluded.served_at), ${pool==='work'?sql``:sql`hook_served AS (INSERT INTO webhook_turns SELECT DISTINCT workspace_id,statement_timestamp() FROM claimed WHERE public.job_class(type)='hook' ORDER BY 1
          ON CONFLICT(workspace_id) DO UPDATE SET served_at=excluded.served_at),`} ${webhookClaimCtes},${inboundHookClaim}
        SELECT j.id,j.workspace_id,j.type,j.payload,j.attempts,j.lease_fence,${pool==='work'?sql`NULL`:sql`(SELECT wid FROM owners WHERE step=${claimBatchSize*4})`} AS hook_cursor,coalesce(to_jsonb(h),to_jsonb(mh)) AS webhook,CASE WHEN j.type='mailbox.ingest' THEN ${ingestInput(runtime.config.multiTenant,sql`j.workspace_id`,sql`j.payload->>'sesMessageId'`)} END AS ingest FROM claimed j ${hookJoin} LEFT JOIN inbound_hooks mh ON mh.job_id=j.id AND mh.blocked IS NULL`); }
      finally { ingestReserved-=slots-(claimed?.rows.filter(j=>j.type==='mailbox.ingest').length??0); }
      claimRequests++;
      if(pool!=='work')hookCursor=claimed.rows[0]?.hook_cursor??'';
      const claimMs = Date.now() - claimStarted;
      if (!claimed.rows.length) {
        // A finishing handler can enqueue more work after the claim's snapshot.
        if (active.size < activeAtClaim) continue;
        if (!active.size) break;
        await Promise.race(active);
        continue;
      }
      claims += claimed.rows.length;
      for (const job of claimed.rows) {
        const index = freeLanes.values().next().value!;
        freeLanes.delete(index);
        const feedback = job.type === 'operation.ses' || job.type === 'operation.simulatedFeedback' || job.type === 'operation.simulatedFeedbackRecovery';
        if (feedback) activeFeedback++;
        const task = handle(job, index, claimMs, claimed.rows.length).catch(error => {
          // Observe failures immediately, but keep the database alive for siblings.
          if (!failures.length) failures.push(error);
        }).finally(() => {
          active.delete(task);
          freeLanes.add(index);
          if (feedback) activeFeedback--;
          if (job.type==='mailbox.ingest') ingestReserved--;
        });
        active.add(task);
      }
    }
  } finally {
    // The time budget stops new claims, not already leased work or persistence.
    await Promise.all(active);
    log('info', { code: 'JOB_DRAIN', processed, claims, claimRequests, concurrency: effectiveConcurrency, peakActiveJobs, laneJobs, budgetMs, durationMs: Date.now() - started });
  }
  if (failures.length) throw failures[0];
  return processed;
}
// Keep short quota deferrals moving without spinning wakeups or waiting for the next minute's cron.
export async function nextWakeDelay(runtime: Runtime, pool: JobPool='all') {
  const result = await runtime.db.execute<{ delay: number | null }>(sql`SELECT CASE WHEN due IS NULL THEN NULL ELSE greatest(0, ceil(extract(epoch FROM due - now())))::int END AS delay
    FROM (SELECT min(first.due) AS due FROM unnest(${sql.param([...classes(pool),...(pool==='webhooks'?[]:['ingest'])])}::text[]) kind
      CROSS JOIN LATERAL (SELECT ${jobDue} AS due FROM jobs j WHERE public.job_class(j.type)=kind AND j.status IN ('pending','running') ORDER BY ${jobDue},j.id LIMIT 1) first) upcoming`);
  const delay = result.rows[0]?.delay;
  return delay !== null && delay !== undefined && delay <= 60 ? delay : null;
}
// Reserve the next delayed wake: only the caller that moves next_wake_at earlier (or past an expired reservation)
// may schedule it. Without this every queue invocation scheduled its own follow-up, so each wake burst and each
// completed job added a chain that never merged, and the duplicates crowded out the wakes that mattered.
export async function reserveNextWake(runtime: Runtime, delaySeconds: number, pool: JobPool='all'): Promise<boolean> {
  const reserved = await runtime.db.execute(sql`INSERT INTO job_schedule (workspace_id, next_wake_at)
    VALUES (${pool==='webhooks'?'scheduler:webhooks':WAKE_SCHEDULE_KEY}, clock_timestamp() + (${delaySeconds} * interval '1 second'))
    ON CONFLICT (workspace_id) DO UPDATE SET next_wake_at = excluded.next_wake_at
    WHERE job_schedule.next_wake_at IS NULL OR job_schedule.next_wake_at <= clock_timestamp()
      OR job_schedule.next_wake_at > excluded.next_wake_at + interval '1 second'
    RETURNING 1`);
  return reserved.rows.length > 0;
}
// Drain, then make sure exactly one continuation covers the next due job. A queue invocation may wait in place for a
// job due within keepAliveMs (paced campaigns release every 10-20 s) instead of relying on a delayed message; if it
// is interrupted, its reservation expires and the next drain or the minute cron schedules again.
export async function followDueJobs(runtime: Runtime, drain: () => Promise<unknown>, sendWake: (delaySeconds: number) => Promise<unknown>, keepAliveMs = 0, pool: JobPool='all'): Promise<'idle' | 'covered' | 'scheduled'> {
  const deadline = Date.now() + keepAliveMs;
  for (;;) {
    await drain();
    const delaySeconds = await nextWakeDelay(runtime,pool);
    if (delaySeconds === null) return 'idle';
    if (!await reserveNextWake(runtime, delaySeconds,pool)) return 'covered';
    const waitMs = Math.max(1000, delaySeconds * 1000) + 150;
    if (Date.now() + waitMs + 2000 <= deadline) { await new Promise(resolve => setTimeout(resolve, waitMs)); continue; }
    await sendWake(delaySeconds);
    return 'scheduled';
  }
}
