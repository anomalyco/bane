import { sql } from 'drizzle-orm';
import { ApiError, lazyModule, log, ModuleLoadError, wrapModuleLoad, type Runtime, type JobHandler } from './core.js';
import { sendingConnections } from './domain-claims.js';
import { processJobs, wakeWebhooks } from './jobs.js';
import type { GateState } from './dispatcher.js';
import { finishCampaigns, terminalColumns, terminalEvents } from './states.js';
const loadDispatcher = lazyModule(() => import('./dispatcher.js'));
const deleteAttachment: JobHandler = async (runtime, payload, job) => {
  if (typeof payload.key !== 'string') throw new ApiError(500, 'JOB_PAYLOAD_INVALID', 'Attachment deletion job is missing its object key.');
  if (!payload.key.startsWith(`${job.workspaceId}/attachments/`) && !payload.key.startsWith(`${job.workspaceId}/live/attachments/`) && !payload.key.startsWith(`${job.workspaceId}/templates/assets/`)) throw new ApiError(500, 'JOB_PAYLOAD_INVALID', 'Attachment deletion key is outside the job scope.');
  try { await runtime.storage.delete(payload.key); }
  catch (error) {
    if (error instanceof ModuleLoadError) throw error;
    throw new ApiError(503, 'STORAGE_DELETE_FAILED', 'Attachment deletion failed; retrying the retained object key.', undefined, true);
  }
};
function resolveJobHandler(type: string): Promise<JobHandler | undefined> {
  return wrapModuleLoad(async () => {
    if (type === 'maintenance.deleteAttachment') return deleteAttachment;
    if (type === 'email.dispatch' || type.startsWith('sending.') || type.startsWith('campaign.')) return (await import('./sending.js')).jobHandlers[type];
    if (type.startsWith('operation.') || type.startsWith('domain.')) return (await import('./operations.js')).operationJobs[type];
    if (type === 'ses.provision' || type === 'ses.discover') return (await import('./ses-regions.js')).sesRegionJobs[type];
    if (type === 'reputation.alert') return (await import('./reputation-alerts.js')).reputationAlertJobs[type];
    if (type === 'mailbox.webhook' || type==='mailbox.fanout') return (await import('./mailbox-events.js')).mailboxEventJobs[type];
    if (type === 'mailbox.reconcile' || type === 'maintenance.domainDns') return (await import('./mailbox-setup.js')).mailboxSetupJobs[type];
    if (type.startsWith('mailbox.')) return (await import('./mailbox-ingest.js')).mailboxIngestJobs[type];
    if (type === 'hosted.trusted') return (await import('./trusted-pool.js')).trustedProvision;
    if (type === 'byo.verify') return (await import('./provider-connections.js')).byoVerifyJob;
    if (type === 'tenant.provision') return (await import('./provider-connections.js')).tenantJob;
    if (type.startsWith('byo.')) return (await import('./byo-regional.js')).regionalByoJobs[type];
    return undefined;
  });
}
/** Background jobs only (campaign orchestration, feedback recovery, webhooks, maintenance). Cloudflare's queue consumer uses this; mail is dispatched by Durable Objects. */
export async function drainJobs(runtime: Runtime, limit = 20, concurrency = 2, maxDurationMs = 20000) { return processJobs(runtime, resolveJobHandler, limit, concurrency, maxDurationMs); }
type Partition = { region: string; accountId?: string; kind?: 'shared' | 'byo' };
export async function dispatchPartitions(runtime: Runtime, recoverInterrupted = false): Promise<Partition[]> {
  // Recover once per sweep, even if a disconnected account has no queued mail. A stale attempt may
  // already have reached SES: record uncertainty atomically; never put it back on the send queue. The same
  // sweep completes any sending campaign whose last row left the queue without finishing it inline.
  // A disabled region has no dispatcher by design. Settle pinned, not-yet-attempted mail
  // in bounded batches in the minute recovery sweep, even on flag rollback. Never acquire
  // credentials, consume quota, or reinterpret an attempting/unknown send as unsent.
  // Match cancel/claim: lock the parent before locking any of its envelopes, skipping a
  // busy campaign as well as busy mail. Direct mail has no parent. Commit cancellation
  // before the global finisher below so it never waits on another campaign with these locks.
  if (recoverInterrupted && runtime.config.multiTenant) {
    const canceled=await runtime.db.execute<{n:number}>(sql`WITH disabled AS MATERIALIZED (
    SELECT q.id FROM provider_connection_regions r JOIN provider_connections c ON c.id=r.connection_id
    CROSS JOIN LATERAL (SELECT e.id FROM sending_emails e WHERE e.workspace_id=c.workspace_id AND e.region=r.region AND e.status='queued'
      AND e.snapshot#>>'{binding,connection}'=r.connection_id AND (e.campaign_id IS NULL OR EXISTS (
        SELECT 1 FROM sending_campaigns p WHERE p.workspace_id=e.workspace_id AND p.id=e.campaign_id FOR NO KEY UPDATE OF p SKIP LOCKED))
      LIMIT 1000 FOR UPDATE OF e SKIP LOCKED) q
    WHERE NOT r.legacy AND r.sending_state='disabled' LIMIT 1000
  ), canceled AS (UPDATE sending_emails e SET status='canceled',error_code='SENDER_BINDING_CHANGED',lease_until=NULL,updated_at=clock_timestamp()
    WHERE EXISTS (SELECT FROM disabled) AND e.id IN (SELECT id FROM disabled) AND e.status='queued' RETURNING ${terminalColumns}
  ), ${terminalEvents(sql`SELECT * FROM canceled`)} SELECT count(*)::int AS n FROM webhook_jobs`);
    await wakeWebhooks(runtime,canceled.rows[0]!.n);
  }
  const recovery = recoverInterrupted ? sql`WITH stale AS (
    UPDATE sending_emails SET status='acceptance_unknown', error_code='INTERRUPTED_PROVIDER_ATTEMPT', lease_until=NULL, updated_at=now()
    WHERE status='attempting' AND attempt_started_at < now() - interval '3 minutes' RETURNING ${terminalColumns}
  ), ${terminalEvents(sql`SELECT * FROM stale`)}, finished AS (${finishCampaigns(sql`SELECT workspace_id, id AS campaign_id FROM sending_campaigns WHERE state='sending' AND expanded=total`, sql`SELECT id FROM stale`)})` : sql``;
  const due = sql`e.status='queued' AND (e.scheduled_at IS NULL OR e.scheduled_at <= now()) AND (e.lease_until IS NULL OR e.lease_until < now())`;
  const partitions = runtime.config.multiTenant ? sql`
    SELECT DISTINCT c.aws_account_id AS "accountId", c.region, c.kind FROM ${sendingConnections(runtime)} c
    WHERE c.paused_at IS NULL AND EXISTS (SELECT 1 FROM sending_emails e WHERE e.workspace_id=c.workspace_id AND e.region=c.region AND e.status='queued'
      AND e.scheduled_at IS NULL AND (e.lease_until IS NULL OR e.lease_until < now()) UNION ALL
      SELECT 1 FROM sending_emails e WHERE e.workspace_id=c.workspace_id AND e.region=c.region AND e.status='queued'
      AND e.scheduled_at <= now() AND (e.lease_until IS NULL OR e.lease_until < now()))` : sql`
    SELECT DISTINCT e.region FROM sending_emails e JOIN ses_installation_settings s ON s.workspace_id=e.workspace_id
    WHERE ${due} AND s.enabled_regions ? e.region`;
  if (!recoverInterrupted) return (await runtime.db.execute<Partition>(partitions)).rows;
  const {rows:[result]}=await runtime.db.execute<{n:number;partitions:Partition[]}>(sql`${recovery} SELECT (SELECT count(*)::int FROM webhook_jobs) AS n,
    coalesce((SELECT jsonb_agg(to_jsonb(p)) FROM (${partitions}) p),'[]') AS partitions`);
  await wakeWebhooks(runtime,result!.n); return result!.partitions;
}
/** Jobs plus due mail for every account/region, in this process. Node runners and tests use this. */
export async function drain(runtime: Runtime, limit = 20, concurrency = 2, maxDurationMs = 20000, gates = new Map<string, GateState>(), recoverInterrupted = true, priorityWake?: EventTarget) {
  let processed = await drainJobs(runtime, limit, concurrency, maxDurationMs);
  const partitions = await dispatchPartitions(runtime, recoverInterrupted);
  if (!partitions.length) return processed;
  const { initialGate, runDispatcher } = await loadDispatcher();
  const dispatch = async ({ accountId, region }: Partition) => {
    const key = `${accountId ? `${accountId}:` : ''}${region}`;
    const gate = gates.get(key) ?? initialGate(); gates.set(key, gate);
    try { return (await runDispatcher(runtime, { accountId, region, gate, priorityWake, lanes: 1, until: Date.now() + Math.max(1, maxDurationMs) })).claimed; }
    catch (error) {
      log('warn', { code: error instanceof ApiError ? error.code : 'DISPATCHER_RUN_FAILED', accountId, region, message: error instanceof ApiError ? error.message : 'Dispatcher run failed; retrying next cycle.' });
      return 0;
    }
  };
  const width = runtime.config.multiTenant ? Math.max(2, concurrency) : 1;
  for (let i = 0; i < partitions.length; i += width) {
    const counts = await Promise.all(partitions.slice(i, i + width).map(dispatch));
    processed += counts.reduce((sum, count) => sum + count, 0);
  }
  return processed;
}
