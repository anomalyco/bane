import { sql, type SQL } from 'drizzle-orm';
import { ApiError, type Runtime } from './core.js';
import { log } from './core.js';
import { enqueue } from './jobs.js';
import { campaignActive, pauseHostedSending } from './states.js';
import { expireDomainClaims } from './operations.js';

// Rows per delete statement: small enough to finish well inside Hyperdrive's 60 s statement limit on 1 vCPU.
const RETENTION_BATCH = 5000;
const DAY_MS = 24 * 3600_000;

/**
 * Storage reconciliation, hourly after cleanup (the only retention step that calls storage). A put can
 * land at any time (see Storage.put): after its reservation expired, after the sweeper's deletion ran
 * and after the reservation's tombstone (158) was spent. The reconciler lists only the upload prefix
 * (uploadKey), takes only keys of its exact grammar (uploads/<existing workspace>/attachment_<32 hex>)
 * that are a day old and that no row references (storage_key_in_use), and queues their deletion; the
 * same object found again later is queued again. The deletion job checks the key once more when it
 * runs. Each run continues from a stored cursor and starts over at the end, so a large bucket is
 * covered over several runs. Tombstones remain the fast path, and the only one for keys of the earlier
 * layout (<workspace>/attachments/<id>), which this never lists.
 */
const UPLOAD_PREFIX = 'uploads/', UPLOAD_KEY = /^uploads\/[^/]+\/attachment_[0-9a-f]{32}$/, RECONCILE_PAGES = 20;
export async function reconcileUploads(runtime: Runtime, budgetMs = 60_000) {
  if (!runtime.storage.list) return 0;
  try { return await reconcilePages(runtime, Date.now() + budgetMs); }
  catch { log('warn', { code: 'UPLOAD_RECONCILE_FAILED', message: 'The next hourly run resumes the storage listing.' }); return 0; }
}
async function reconcilePages(runtime: Runtime, deadline: number) {
  let queued = 0, after = (await runtime.db.execute<{ after: string }>(sql`SELECT after FROM sending_upload_reconcile WHERE id='uploads'`)).rows[0]?.after ?? '';
  for (let page = 0; page < RECONCILE_PAGES && Date.now() < deadline; page++) {
    const listed = await runtime.storage.list!(UPLOAD_PREFIX, after || undefined), old = Date.now() - DAY_MS, next = listed.cursor ?? '';
    const keys = listed.objects.filter(o => UPLOAD_KEY.test(o.key) && o.uploaded.getTime() <= old).map(o => o.key);
    const { rows: [r] } = await runtime.db.execute<{ moved: boolean; n: number }>(sql`WITH moved AS (
        INSERT INTO sending_upload_reconcile(id,after) VALUES('uploads',${next}) ON CONFLICT(id) DO UPDATE SET after=excluded.after WHERE sending_upload_reconcile.after=${after} RETURNING 1),
      orphans AS (SELECT key,split_part(key,'/',2) AS wid FROM unnest(${sql.param(keys)}::text[]) key WHERE EXISTS(SELECT FROM moved)
        AND EXISTS(SELECT FROM workspaces w WHERE w.id=split_part(key,'/',2)) AND NOT storage_key_in_use(key)),
      queued AS (INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'upload-orphan:'||key,'maintenance.deleteAttachment',wid,jsonb_build_object('key',key) FROM orphans
        ON CONFLICT(id) DO UPDATE SET status='pending',attempts=0,lease_until=NULL,last_error=NULL,available_at=now() WHERE jobs.status IN ('completed','failed') RETURNING 1)
      SELECT EXISTS(SELECT FROM moved) AS moved,(SELECT count(*)::int FROM queued) AS n`);
    // Another reconciler moved the cursor: it owns this page.
    if (!r?.moved) break;
    queued += r.n; after = next;
    if (!next) break;
  }
  return queued;
}
// Hourly cron invocations may run up to 15 minutes; stop starting new batches after this and continue next hour.
const RETENTION_BUDGET_MS = 4 * 60_000;

export async function checkHostedHealth(runtime: Runtime) {
  if (!runtime.config.multiTenant) return;
  await runtime.db.execute(sql`SELECT refresh_hosted_minute_tiers()`);
  const result = await runtime.db.execute(pauseHostedSending(sql`WITH counts AS (
    SELECT pc.id,pc.workspace_id,pc.resumed_at,sum(h.accepted) AS sends,
      sum(h.bounces) FILTER (WHERE h.hour>=date_trunc('hour',now(),'UTC')-interval '23 hours') AS bounces,
      sum(h.complaints) FILTER (WHERE h.hour>=date_trunc('hour',now(),'UTC')-interval '23 hours') AS complaints
    FROM provider_connections pc JOIN hosted_health_hourly h ON h.workspace_id=pc.workspace_id AND h.epoch=coalesce(pc.resumed_at,'-infinity')
    WHERE pc.kind='shared' AND pc.paused_at IS NULL AND h.hour BETWEEN date_trunc('hour',now(),'UTC')-interval '47 hours' AND date_trunc('hour',now(),'UTC')
    GROUP BY pc.id,pc.workspace_id,pc.resumed_at)
  SELECT *,CASE WHEN (sends<200 AND bounces>=10) OR (sends>=200 AND bounces>sends*0.03) THEN 'Hosted sending paused: high hard-bounce volume in the last 24 hours.'
    WHEN (sends<200 AND complaints>=2) OR (sends>=200 AND complaints>sends*0.0005) THEN 'Hosted sending paused: high spam-complaint volume in the last 24 hours.' END AS reason FROM counts`));
  for (const row of result.rows) log('warn', { code: 'HOSTED_SENDING_AUTO_PAUSED', workspaceId: row.workspace_id, reason: row.pause_reason, sends: Number(row.sends), bounces: Number(row.bounces), complaints: Number(row.complaints) });
}

/** Independent bounded slice, before other hourly drains. A poison batch must not
 * abort ordinary retention, MX checks or receipt recovery. Alternate deletion
 * and GC so a backlog or failure in either phase doesn't starve the other. */
export async function sweepInboxes(runtime:Runtime, budgetMs:number,clock=Date.now){
  const until=clock()+budgetMs;
  const phases=[{name:'leases',batch:sql`SELECT inbox_retention_batch(25) n`,done:false,failed:false},
    {name:'content',batch:sql`SELECT mail_gc_batch(1000) n`,done:false,failed:false},
    {name:'expunge history',batch:sql`SELECT inbox_prune_vanished() n`,done:false,failed:false},
    {name:'reservations',batch:sql`WITH pruned AS (DELETE FROM mail_retired_addresses WHERE (workspace_id,address) IN (SELECT workspace_id,address FROM mail_retired_addresses WHERE until<=now() ORDER BY until LIMIT 5000) RETURNING 1) SELECT count(*)::int n FROM pruned`,done:false,failed:false}];
  while(clock()<until && phases.some(p=>!p.done&&!p.failed))for(const p of phases){
    if(p.done||p.failed||clock()>=until)continue;
    try{const {rows}=await runtime.db.execute<{n:number}>(p.batch);p.done=Number(rows[0]?.n)===0;if(p.name==='leases'&&!p.done)phases[1].done=false;}
    catch{p.failed=true;log('error',{code:'INBOX_RETENTION_FAILED',phase:p.name});}
  }
  const pending=phases.filter(p=>!p.done).map(p=>p.name);
  log(pending.length?'warn':'info',{code:pending.length?'INBOX_RETENTION_PARTIAL':'INBOX_RETENTION_COMPLETED',pending});
  return pending.length===0;
}

/**
 * Retention runs one table at a time in bounded batches, each its own transaction. It used to be one transaction
 * of unbounded deletes: a single statement over the 60 s limit (e.g. the 2M consent events of a bulk import all
 * crossing 30 days in the same hour) rolled back the whole run every hour, so nothing was ever retired again.
 */
export async function cleanup(runtime: Runtime, budgetMs = RETENTION_BUDGET_MS) {
  const inboxComplete=await sweepInboxes(runtime,Math.min(60_000,Math.floor(budgetMs/4)));
  try { await checkHostedHealth(runtime); } catch { log('error', { code: 'HOSTED_HEALTH_CHECK_FAILED', message: 'Continuing retention; the next hourly check will retry.' }); }
  const deadline = Date.now() + budgetMs, deleted: Record<string, number> = {};
  // A durable daily election prevents two reconcilers from applying the same
  // snapshot difference. Dispatch continues adding deltas while this runs.
  await runtime.db.execute(sql`WITH elected AS (INSERT INTO job_schedule(workspace_id,next_wake_at)
    VALUES ('maintenance:sending-depth',now()+interval '1 day') ON CONFLICT(workspace_id) DO UPDATE SET next_wake_at=excluded.next_wake_at
    WHERE job_schedule.next_wake_at<=now() RETURNING 1) SELECT reconcile_sending_depth(),reconcile_asset_usage(),reconcile_ingest_turns() FROM elected`);
  if (runtime.config.multiTenant) deleted.domain_claims=await expireDomainClaims(runtime,Math.min(deadline,Date.now()+60_000));
  const cutoff = sql`now() - interval '30 days'`;
  // Repeats one bounded statement until it deletes less than a full batch or the budget runs out.
  const drain = async (name: string, statement: () => SQL) => {
    while (Date.now() < deadline) {
      const result = await runtime.db.execute<{ n: number }>(statement());
      const n = Number(result.rows[0]?.n ?? 0);
      deleted[name] = (deleted[name] ?? 0) + n;
      if (n < RETENTION_BATCH) return;
    }
  };
  const batch = (table: SQL, where: SQL) => () => sql`WITH gone AS (DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${where} LIMIT ${RETENTION_BATCH}) RETURNING 1) SELECT count(*)::int AS n FROM gone`;
  // Never erase contacts, consent, suppression, drafts, idempotency keys or active scheduled work.
  await drain('expired_uploads',()=>sql`WITH expired AS (DELETE FROM sending_upload_reservations WHERE id IN
    (SELECT id FROM sending_upload_reservations WHERE expires_at<=now() ORDER BY expires_at LIMIT ${RETENTION_BATCH} FOR UPDATE SKIP LOCKED) RETURNING *),
    cleanup AS (INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'upload-cleanup:'||id,'maintenance.deleteAttachment',workspace_id,jsonb_build_object('key',storage_key) FROM expired)
    SELECT count(*)::int AS n FROM expired`);
  // A day after a reservation ended without its attachment (158), delete its object once more: a late
  // put may have landed after the first deletion. An attachment that holds the object is never touched.
  await drain('upload_tombstones',()=>sql`WITH due AS (DELETE FROM sending_upload_tombstones WHERE id IN
    (SELECT id FROM sending_upload_tombstones WHERE delete_after<=now() ORDER BY delete_after LIMIT ${RETENTION_BATCH} FOR UPDATE SKIP LOCKED) RETURNING *),
    cleanup AS (INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'upload-tombstone:'||d.id,'maintenance.deleteAttachment',d.workspace_id,jsonb_build_object('key',d.storage_key) FROM due d
      WHERE NOT EXISTS(SELECT FROM sending_attachments a WHERE a.id=d.id AND a.storage_key=d.storage_key) ON CONFLICT(id) DO NOTHING)
    SELECT count(*)::int AS n FROM due`);
  await drain('api_request_budgets', batch(sql`api_request_budgets`, sql`window_start < now() - interval '1 day'`));
  // Denied sign-ins operators haven't acted on in 90 days (the table is otherwise capped at 10,000 identities).
  await drain('access_requests', batch(sql`access_requests`, sql`last_requested_at < now() - interval '90 days'`));
  for (const table of ['auth_state_slots','auth_verification','oauth_client_assertion','oauth_access_token','auth_session']) {
    await drain(table,batch(sql`${sql.identifier(table)}`,sql`expires_at <= now()`));
  }
  // Do not cascade away an unexpired access token when its refresh token expires first.
  await drain('oauth_refresh_token',batch(sql`oauth_refresh_token`,sql`expires_at <= now() AND NOT EXISTS
    (SELECT FROM oauth_access_token a WHERE a.refresh_id=oauth_refresh_token.id AND a.expires_at>now())`));
  await runtime.db.execute(sql`SELECT mail_prune_route_versions()`);
  await drain('mail_receipts',batch(sql`mail_receipts`,sql`status IN ('processed','failed') AND coalesce(processed_at,created_at)<${cutoff}`));
  await drain('mail_receipt_holds',batch(sql`mail_receipt_holds`,sql`status<>'held' AND expires_at<${cutoff}`));
  if (runtime.config.multiTenant) {
    for (const table of ['hosted_usage_hourly','hosted_health_hourly','hosted_health_credits'])
      // Keep only aggregate workspace evidence long enough to observe a 30-day clean span.
      await drain(table, batch(sql`${sql.identifier(table)}`, table==='hosted_health_hourly' ? sql`hour < now()-interval '32 days'` : sql`hour < now()-interval '2 days'`));
  }
  // Do not cascade-delete a consent/token committed as we pick candidates: lock the parent first,
  // then check its indexed references again in a fresh statement while FK inserts are fenced.
  const unusedClient = sql`NOT EXISTS (SELECT FROM oauth_consent WHERE client_id=c.client_id)
    AND NOT EXISTS (SELECT FROM oauth_access_token WHERE client_id=c.client_id)
    AND NOT EXISTS (SELECT FROM oauth_refresh_token WHERE client_id=c.client_id)`;
  while (Date.now() < deadline) {
    const count = await runtime.db.transaction(async tx => {
      const { rows } = await tx.execute<{id:string}>(sql`SELECT c.id FROM oauth_client c WHERE c.created_at < now()-interval '7 days'
        AND c.user_id IS NULL AND c.reference_id IS NULL AND c.client_discovery_id IS NULL AND ${unusedClient} LIMIT ${RETENTION_BATCH} FOR UPDATE SKIP LOCKED`);
      if (!rows.length) return 0;
      return (await tx.execute(sql`DELETE FROM oauth_client c WHERE c.id=ANY(${sql.param(rows.map(row => row.id))}::text[]) AND ${unusedClient}`)).rowCount ?? 0;
    });
    deleted.oauth_client = (deleted.oauth_client ?? 0) + count;
    if (count < RETENTION_BATCH) break;
  }
  await drain('agent_tokens', batch(sql`agent_tokens`, sql`expires_at < ${cutoff}`));
  await drain('audience_operation_plans', batch(sql`audience_operation_plans`, sql`expires_at < now() - interval '1 day'`));
  await drain('sending_email_events', batch(sql`sending_email_events`, sql`created_at < ${cutoff}`));
  // An email and its attachment links leave in the same statement, so no link can outlive its email.
  await drain('sending_emails', () => sql`WITH gone AS (
      DELETE FROM sending_emails WHERE ctid IN (SELECT ctid FROM sending_emails WHERE created_at < ${cutoff} AND status NOT IN ('queued','attempting') LIMIT ${RETENTION_BATCH})
      RETURNING id, workspace_id
    ), links AS (
      DELETE FROM sending_attachment_links l USING gone e WHERE l.owner_type = 'email' AND l.owner_id = e.id AND l.workspace_id = e.workspace_id
    ) SELECT count(*)::int AS n FROM gone`);
  // Retire lightweight preparation rows after terminal/obsolete work ages out. Never purge a campaign's current
  // snapshot or one with an outstanding reservation (including a failed launch).
  await drain('sending_review_recipients', () => sql`WITH expired AS (
      SELECT r.review_id, r.ordinal FROM sending_review_recipients r
      JOIN sending_campaign_reviews v ON v.id = r.review_id
      WHERE v.created_at < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM sending_emails e WHERE (e.review_id,e.review_ordinal)=(r.review_id,r.ordinal))
        AND NOT EXISTS (SELECT 1 FROM sending_campaigns c WHERE c.id = v.campaign_id AND c.workspace_id = v.workspace_id
          AND (c.updated_at >= ${cutoff} OR ${campaignActive()} OR c.review_id = v.id))
      LIMIT ${RETENTION_BATCH}
    ), gone AS (DELETE FROM sending_review_recipients r USING expired e WHERE r.review_id = e.review_id AND r.ordinal = e.ordinal RETURNING 1)
    SELECT count(*)::int AS n FROM gone`);
  await runtime.db.execute(sql`DELETE FROM sending_attachment_links l USING sending_campaign_reviews v
    WHERE l.owner_type = 'review' AND l.owner_id = v.id AND l.workspace_id = v.workspace_id
      AND v.created_at < ${cutoff}
      AND NOT EXISTS (SELECT 1 FROM sending_review_recipients r WHERE r.review_id = v.id)
      AND NOT EXISTS (SELECT 1 FROM sending_emails e WHERE e.review_id = v.id)
      AND NOT EXISTS (SELECT 1 FROM sending_campaigns c WHERE c.id = v.campaign_id AND c.workspace_id = v.workspace_id
        AND (${campaignActive()} OR c.review_id = v.id))`);
  await drain('operation_delivery_attempts', batch(sql`operation_delivery_attempts`, sql`created_at < ${cutoff}`));
  await drain('operation_deliveries', batch(sql`operation_deliveries`, sql`created_at < ${cutoff} AND status NOT IN ('pending','paused')`));
  await drain('operation_events', batch(sql`operation_events`, sql`created_at < ${cutoff}`));
  await drain('operation_sns_receipts', batch(sql`operation_sns_receipts`, sql`created_at < ${cutoff}`));
  await drain('operation_feedback_failures', batch(sql`operation_feedback_failures`, sql`created_at < ${cutoff}`));
  await drain('jobs', batch(sql`jobs`, sql`status IN ('completed','failed') AND type NOT IN ('maintenance.deleteAttachment','mail.deleteObjects') AND created_at < ${cutoff}`));
  // Delete metadata only when no draft or message references it. The outbox retains the object key until deletion succeeds.
  await runtime.db.transaction(async tx => {
    const unused = await tx.execute<{ id: string; storage_key: string; workspace_id: string; source_template_asset_id: string | null }>(sql`WITH old AS (
      SELECT a.id FROM sending_attachments a WHERE a.created_at < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM sending_attachment_links l WHERE l.attachment_id = a.id)
      LIMIT 50 FOR UPDATE SKIP LOCKED
    ) DELETE FROM sending_attachments a USING old WHERE a.id = old.id RETURNING a.id, a.storage_key, a.workspace_id, a.source_template_asset_id`);
    for (const object of unused.rows) if (!object.source_template_asset_id) await enqueue(tx, { type: 'maintenance.deleteAttachment', workspaceId: object.workspace_id, payload: { key: object.storage_key } });
    const unusedTemplateAssets = await tx.execute<{ storage_key: string; workspace_id: string }>(sql`WITH old AS (
      SELECT a.id FROM template_assets a WHERE a.created_at < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM template_asset_links l WHERE l.workspace_id = a.workspace_id AND l.asset_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM sending_attachments s WHERE s.workspace_id = a.workspace_id AND s.source_template_asset_id = a.id)
      LIMIT 50 FOR UPDATE SKIP LOCKED
    ) DELETE FROM template_assets a USING old WHERE a.id = old.id RETURNING a.storage_key, a.workspace_id`);
    for (const object of unusedTemplateAssets.rows) await enqueue(tx, { type: 'maintenance.deleteAttachment', workspaceId: object.workspace_id, payload: { key: object.storage_key } });
  });
  await drain('jobs_attachment_deletes', batch(sql`jobs`, sql`status = 'completed' AND type IN ('maintenance.deleteAttachment','mail.deleteObjects') AND created_at < ${cutoff}`));
  const complete=inboxComplete && Date.now()<deadline;
  log('info', { code: complete ? 'RETENTION_COMPLETED' : 'RETENTION_PARTIAL', deleted });
}
/** The hourly upkeep. Every step is best-effort: a failing step (a retention statement that keeps timing out) must not
 * skip the steps after it, and on Node, where this used to run inside the dispatch loop, it must not stop job processing
 * and mail dispatch. Returns the codes of the steps that failed. */
export async function hourlyUpkeep(runtime: Runtime, mailboxRuntime: () => Promise<Runtime> = async () => runtime) {
  const failed: string[] = [];
  for (const [code, step] of [
    ['MAINTENANCE_CLEANUP_FAILED', () => cleanup(runtime)],
    ['UPLOAD_RECONCILE_FAILED', () => reconcileUploads(runtime)],
    ['REPUTATION_ALERT_CHECK_FAILED', async () => (await import('./reputation-alerts.js')).checkReputationAlerts(runtime)],
    ['MAILBOX_HOURLY_FAILED', async () => (await import('./mailbox-ingest.js')).mailboxHourly(await mailboxRuntime())],
  ] as const) {
    try { await step(); } catch (error) { failed.push(code); log('warn', { code: error instanceof ApiError ? error.code : code, step: code }); }
  }
  return failed;
}
