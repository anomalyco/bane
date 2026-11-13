import { sql, type SQL } from 'drizzle-orm';
import { ApiError, type Runtime } from './core.js';
import { log } from './core.js';
import { campaignActive } from './states.js';
import { expireDomainClaims } from './operations.js';

// Rows per delete statement: small enough to finish well inside Hyperdrive's 60 s statement limit on 1 vCPU.
const RETENTION_BATCH = 5000;
const UPLOAD_BATCH = 1000;
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

/**
 * The hourly backstop for the ten-minute standing job (src/standing.ts): runs the ladder now, which also re-queues any
 * workspace whose SES tenants differ from what Bane wants. The ladder, not this check, decides pauses (docs/sending-limits.md).
 */
export async function checkHostedHealth(runtime: Runtime) {
  if (!runtime.config.multiTenant) return;
  const { refreshStanding } = await import('./standing.js');
  const result = await refreshStanding(runtime);
  if (result.changed) log('info', { code: 'STANDING_REFRESHED', ...result });
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
  // Refused sign-ins an operator has not acted on in 30 days (one row per subject).
  await drain('bane_signin_attempts', batch(sql`bane_signin_attempts`, sql`last_at < now() - interval '30 days'`));
  for (const table of ['auth_state_slots','bane_dpop_proofs','bane_sessions','bane_login_flows','bane_oauth_requests','bane_oauth_tokens','bane_oauth_refresh']) {
    await drain(table,batch(sql`${sql.identifier(table)}`,sql`expires_at <= now()`));
  }
  // MCP approvals whose client never collected its tokens (approved, then abandoned), and registered clients unused for
  // 90 days that no live approval names (oauth-server.ts).
  await drain('bane_resource_grants',batch(sql`bane_resource_grants`,sql`kind='oauth' AND issued_at=0 AND expires_at <= now()`));
  // A rotated refresh token's replay pair is needed for a minute; don't keep a live refresh token, even encrypted, longer.
  await runtime.db.execute(sql`UPDATE bane_oauth_refresh SET replay=NULL WHERE replay IS NOT NULL AND rotated_at < now() - interval '5 minutes'`);
  await drain('bane_oauth_clients',batch(sql`bane_oauth_clients`,sql`coalesce(last_used_at,created_at) < now() - interval '90 days'
    AND NOT EXISTS(SELECT FROM bane_resource_grants g WHERE g.client_id=bane_oauth_clients.id AND NOT g.revoked AND g.expires_at > now())`));
  await runtime.db.execute(sql`SELECT mail_prune_route_versions()`);
  await drain('mail_receipts',batch(sql`mail_receipts`,sql`status IN ('processed','failed') AND coalesce(processed_at,created_at)<${cutoff}`));
  await drain('mail_receipt_holds',batch(sql`mail_receipt_holds`,sql`status<>'held' AND expires_at<${cutoff}`));
  if (runtime.config.multiTenant) {
    // The score's daily evidence decays with a 30-day half-life; past 400 days it no longer moves the score or the card.
    await drain('sender_score_daily', batch(sql`sender_score_daily`, sql`day < (now() AT TIME ZONE 'UTC')::date-400`));
    await drain('operator_idempotency', batch(sql`operator_idempotency`, sql`created_at < now()-interval '1 day'`));
    for (const table of ['hosted_usage_hourly','hosted_health_hourly','hosted_health_credits','hosted_screen_hourly'])
      // Keep only aggregate workspace evidence long enough to observe a 30-day clean span.
      await drain(table, batch(sql`${sql.identifier(table)}`, table==='hosted_health_hourly' || table==='hosted_screen_hourly' ? sql`hour < now()-interval '32 days'` : sql`hour < now()-interval '2 days'`));
  }
  await drain('agent_tokens', batch(sql`agent_tokens`, sql`expires_at < ${cutoff}`));
  // The audit trail past its retention (src/audit.ts RETENTION); the table refuses to delete anything earlier.
  await drain('audit_events', () => sql`WITH gone AS (DELETE FROM audit_events WHERE id IN (SELECT id FROM audit_events WHERE retain_until <= now() ORDER BY retain_until LIMIT ${RETENTION_BATCH}) RETURNING 1)
    SELECT count(*)::int AS n FROM gone`);
  // Support grants live two hours; their trail is in audit_events. Handoffs expire after a week.
  await drain('support_grants', batch(sql`support_grants`, sql`expires_at < ${cutoff}`));
  await drain('support_handoffs', batch(sql`support_handoffs`, sql`expires_at < ${cutoff}`));
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
  await drain('operation_feedback_failures', batch(sql`operation_feedback_failures`, sql`created_at < ${cutoff} AND reason NOT IN ('FEEDBACK_UNTAGGED','FEEDBACK_LEGACY_RECOVERY','FEEDBACK_QUEUE_RECOVERY')`));
  await drain('jobs', batch(sql`jobs`, sql`status IN ('completed','failed') AND type NOT IN ('maintenance.deleteAttachment','mail.deleteObjects') AND created_at < ${cutoff}`));
  // Delete metadata only when no draft or message references it. The outbox retains the object key until deletion succeeds.
  // A fixed 50 rows an hour fell behind any installation retiring more than about 1,200 uploads a day, so their objects and
  // the workspace's stored-attachment usage were never released. Up to 5,000 a run now (120,000 a day), 1,000 per
  // transaction in workspace order: each queues an object deletion that shares the 'other' job class with domain checks and
  // alerts, and each row's usage trigger holds its workspace's usage row until the batch commits.
  const uploads = async (name: string, statement: () => SQL) => {
    for (let i = 0; i < 5 && Date.now() < deadline; i++) {
      const n = Number((await runtime.db.execute<{ n: number }>(statement())).rows[0]?.n ?? 0);
      deleted[name] = (deleted[name] ?? 0) + n;
      if (n < UPLOAD_BATCH) return;
    }
  };
  await uploads('unused_attachments', () => sql`WITH old AS (
      SELECT a.id FROM sending_attachments a WHERE a.created_at < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM sending_attachment_links l WHERE l.workspace_id = a.workspace_id AND l.attachment_id = a.id)
      ORDER BY a.workspace_id, a.id LIMIT ${UPLOAD_BATCH} FOR UPDATE SKIP LOCKED
    ), gone AS (DELETE FROM sending_attachments a USING old WHERE a.id = old.id RETURNING a.storage_key, a.workspace_id, a.source_template_asset_id
    ), queued AS (INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'job_'||replace(gen_random_uuid()::text,'-',''),'maintenance.deleteAttachment',workspace_id,jsonb_build_object('key',storage_key)
      FROM gone WHERE source_template_asset_id IS NULL
    ) SELECT count(*)::int AS n FROM gone`);
  await uploads('unused_template_assets', () => sql`WITH old AS (
      SELECT a.id FROM template_assets a WHERE a.created_at < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM template_asset_links l WHERE l.workspace_id = a.workspace_id AND l.asset_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM sending_attachments s WHERE s.workspace_id = a.workspace_id AND s.source_template_asset_id = a.id)
      ORDER BY a.workspace_id, a.id LIMIT ${UPLOAD_BATCH} FOR UPDATE SKIP LOCKED
    ), gone AS (DELETE FROM template_assets a USING old WHERE a.id = old.id RETURNING a.storage_key, a.workspace_id
    ), queued AS (INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'job_'||replace(gen_random_uuid()::text,'-',''),'maintenance.deleteAttachment',workspace_id,jsonb_build_object('key',storage_key) FROM gone
    ) SELECT count(*)::int AS n FROM gone`);
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
    // Billing settles the closed hours (and once a UTC day its storage, unpaid, drift and expiry work).
    ['BILLING_HOURLY_FAILED', async () => { if (runtime.config.multiTenant) await (await import('./billing/cron.js')).billingHourly(runtime); }],
  ] as const) {
    try { await step(); } catch (error) { failed.push(code); log('warn', { code: error instanceof ApiError ? error.code : code, step: code }); }
  }
  return failed;
}
