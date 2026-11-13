import { sql } from 'drizzle-orm';
import { log, type Runtime } from '../core.js';

const SETTLE_BUDGET_MS = 60_000, SETTLE_CONCURRENCY = 4, SETTLE_PAGE = 500;
const LAG_ALERT_MS = 3 * 3_600_000, BYO_FAIR_USE = 10_000_000;
// Closed hours only, and at least five minutes closed: the Node runner's hourly tick is not aligned to :07 like the
// Worker cron, and a writer that started before the boundary may still be upserting the previous hour's row.
const CLOSED_HOURS = sql`date_trunc('hour', now() - interval '5 minutes', 'UTC')`;

/**
 * Hourly (worker.ts `7 * * * *`, runner.ts hourly), Hosted only: once a UTC day the storage day, the unpaid scan, the
 * drift check and the BYO fair-use report; then settlement of every workspace with unsettled usage in closed hours.
 * Nothing runs while billing_config.mode is 'off' (an operator kill-switch; meters still record).
 */
export async function billingHourly(runtime: Runtime): Promise<void> {
  const { rows: [cfg] } = await runtime.db.execute<{ mode: string }>(sql`SELECT mode FROM billing_config WHERE singleton`);
  if (!cfg || cfg.mode === 'off') return;
  // One runner a day: the same durable election as maintenance:sending-depth, due again at the next 00:05 UTC.
  const { rows: elected } = await runtime.db.execute(sql`INSERT INTO job_schedule(workspace_id,next_wake_at)
    VALUES ('billing:daily', (date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day 5 minutes') AT TIME ZONE 'UTC')
    ON CONFLICT(workspace_id) DO UPDATE SET next_wake_at=excluded.next_wake_at WHERE job_schedule.next_wake_at<=now() RETURNING 1`);
  if (elected.length) await billingDaily(runtime);
  // Free workspaces whose flag expired, or whose free owner changed, are re-evaluated before the hour is priced.
  try {
    const { rows: [r] } = await runtime.db.execute<{ n: number }>(sql`SELECT billing_free_sweep() AS n`);
    if (r?.n) log('info', { code: 'BILLING_FREE_SWEPT', workspaces: r.n });
  } catch (error) { log('error', { code: 'BILLING_FREE_SWEEP_FAILED', message: error instanceof Error ? error.message : String(error) }); }
  await settleClosedHours(runtime);
  // Prepaid credit expires 12 months after purchase: only real money moves, so only under enforce.
  if (cfg.mode === 'enforce') try { await creditExpiry(runtime); } catch (error) { log('error', { code: 'BILLING_CREDIT_EXPIRY_FAILED', message: error instanceof Error ? error.message : String(error) }); }
}

/**
 * Credit lots (migration 300): one 'credit_expiring' notice per top-up 30 days before its remaining credit expires,
 * then the expiry of every lot whose expiry hour has closed (billing_expire_lot settles the workspace first, so usage
 * before the expiry spends that credit). Bounded per run; the rest goes next hour.
 */
export async function creditExpiry(runtime: Runtime, cutoff?: string): Promise<{ notices: number; expired: number; busy: number }> {
  const at = cutoff ? sql`${cutoff}::timestamptz` : CLOSED_HOURS;
  const { rows: [noticed] } = await runtime.db.execute<{ n: number }>(sql`SELECT count(billing_notice(workspace_id, 'credit_expiring', 'credit_expiring:'||workspace_id||':'||source_id,
      jsonb_build_object('lot', source_id, 'remainingUc', remaining_uc::text, 'expiresAt', expires_at)))::int AS n
    FROM (SELECT workspace_id, source_id, remaining_uc, expires_at FROM billing_credit_lots l
      WHERE remaining_uc > 0 AND expires_at IS NOT NULL AND expires_at > now() AND expires_at <= now() + interval '30 days'
        AND NOT EXISTS (SELECT FROM billing_notices n WHERE n.dedupe_key='credit_expiring:'||l.workspace_id||':'||l.source_id)
      ORDER BY expires_at LIMIT ${SETTLE_PAGE}) due`);
  const { rows: due } = await runtime.db.execute<{ workspace_id: string; source_id: string }>(sql`SELECT workspace_id, source_id FROM billing_credit_lots
    WHERE remaining_uc > 0 AND expires_at IS NOT NULL AND date_trunc('hour', expires_at, 'UTC') + interval '1 hour' <= ${at} ORDER BY expires_at LIMIT ${SETTLE_PAGE}`);
  let expired = 0, busy = 0;
  for (const lot of due) {
    const { rows: [r] } = await runtime.db.execute<{ r: { busy?: boolean; expired?: boolean } }>(sql`SELECT billing_expire_lot(${lot.workspace_id}, ${lot.source_id}, ${at}) AS r`);
    if (r?.r.busy) busy++; else if (r?.r.expired) expired++;
  }
  if (noticed?.n || due.length) log('info', { code: 'BILLING_CREDIT_EXPIRY', notices: noticed?.n ?? 0, expired, busy });
  return { notices: noticed?.n ?? 0, expired, busy };
}

export async function billingDaily(runtime: Runtime): Promise<void> {
  const step = async (code: string, work: () => Promise<unknown>) => {
    try { await work(); } catch (error) { log('error', { code, message: error instanceof Error ? error.message : String(error) }); }
  };
  // Yesterday (UTC): its aged-storage rollup and meter. The settle below prices it.
  await step('BILLING_STORAGE_DAY_FAILED', async () => {
    const { rows: [r] } = await runtime.db.execute<{ day: unknown }>(sql`SELECT billing_storage_day(((now() AT TIME ZONE 'UTC')::date - 1)) AS day`);
    log('info', { code: 'BILLING_STORAGE_DAY', result: r?.day });
  });
  await step('BILLING_UNPAID_SCAN_FAILED', async () => {
    const { rows: [r] } = await runtime.db.execute<{ scan: unknown }>(sql`SELECT billing_unpaid_scan() AS scan`);
    log('info', { code: 'BILLING_UNPAID_SCAN', result: r?.scan });
  });
  // Drift: each workspace with new ledger rows must hold exactly the sum of its ledger. One snapshot, so a balance and
  // its ledger row (committed together by billing_post) are always seen together. Nothing is fixed automatically.
  await step('BILLING_DRIFT_CHECK_FAILED', async () => {
    const { rows } = await runtime.db.execute<{ workspace_id: string | null; balance_uc: string; promo_uc: string; paid_sum: string; promo_sum: string; through: string }>(sql`
      WITH cfg AS (SELECT drift_cursor FROM billing_config WHERE singleton), top AS (SELECT coalesce(max(id),0) AS id FROM billing_ledger),
      touched AS (SELECT DISTINCT workspace_id FROM billing_ledger, cfg WHERE id > cfg.drift_cursor),
      bad AS (SELECT a.workspace_id, a.balance_uc::text, a.promo_uc::text, s.paid::text AS paid_sum, s.promo::text AS promo_sum
        FROM touched t JOIN billing_accounts a USING (workspace_id)
        CROSS JOIN LATERAL (SELECT coalesce(sum(paid_uc),0) AS paid, coalesce(sum(promo_uc),0) AS promo FROM billing_ledger l WHERE l.workspace_id=t.workspace_id) s
        WHERE a.balance_uc<>s.paid OR a.promo_uc<>s.promo),
      moved AS (UPDATE billing_config SET drift_cursor=(SELECT id FROM top) WHERE singleton AND drift_cursor<(SELECT id FROM top))
      SELECT bad.*, (SELECT id FROM top)::text AS through FROM (SELECT 1) one LEFT JOIN bad ON true`);
    for (const row of rows) if (row.workspace_id) log('error', { code: 'BILLING_DRIFT', workspaceId: row.workspace_id, balanceUc: row.balance_uc, ledgerPaidUc: row.paid_sum, promoUc: row.promo_uc, ledgerPromoUc: row.promo_sum });
  });
  await step('BILLING_BYO_REPORT_FAILED', async () => {
    const { rows } = await runtime.db.execute<{ workspace_id: string; n: string }>(sql`SELECT workspace_id, sum(quantity)::text AS n FROM billing_usage_hourly
      WHERE meter IN ('byo_send','byo_receive') AND hour >= date_trunc('month', now(), 'UTC') GROUP BY 1 HAVING sum(quantity) > ${BYO_FAIR_USE}`);
    for (const row of rows) log('warn', { code: 'BYO_FAIR_USE_EXCEEDED', workspaceId: row.workspace_id, emails: row.n });
  });
  // Stripe's processed or ignored webhook events (package B's table) are kept 90 days.
  await step('BILLING_EVENTS_PRUNE_FAILED', () => runtime.db.execute(sql`DO $$ BEGIN
    IF to_regclass('billing_gateway_events') IS NOT NULL THEN
      DELETE FROM billing_gateway_events WHERE status IN ('processed','ignored') AND received_at < now() - interval '90 days';
    END IF; END $$`));
}

/** Settles every workspace with unsettled usage before the current hour, four at a time, within a 60 s budget. */
export async function settleClosedHours(runtime: Runtime, cutoff?: string): Promise<{ workspaces: number; entries: number; busy: number }> {
  const started = Date.now(), deadline = started + SETTLE_BUDGET_MS;
  const at = cutoff ? sql`${cutoff}::timestamptz` : CLOSED_HOURS;
  let workspaces = 0, entries = 0, busy = 0;
  const seen = new Set<string>();
  while (Date.now() < deadline) {
    const { rows } = await runtime.db.execute<{ workspace_id: string }>(sql`SELECT DISTINCT workspace_id FROM billing_usage_hourly
      WHERE quantity<>settled_quantity AND hour<${at} LIMIT ${SETTLE_PAGE}`);
    const queue = rows.map(r => r.workspace_id).filter(w => !seen.has(w));
    if (!queue.length) break;
    await Promise.all(Array.from({ length: Math.min(SETTLE_CONCURRENCY, queue.length) }, async () => {
      for (let wid = queue.shift(); wid !== undefined && Date.now() < deadline; wid = queue.shift()) {
        seen.add(wid);
        try {
          const { rows: [r] } = await runtime.db.execute<{ s: { busy?: boolean; entries?: number } }>(sql`SELECT billing_settle(${wid}, ${at}) AS s`);
          if (r?.s.busy) busy++; else { workspaces++; entries += r?.s.entries ? 1 : 0; }
        } catch (error) { log('error', { code: 'BILLING_SETTLE_FAILED', workspaceId: wid, message: error instanceof Error ? error.message : String(error) }); }
      }
    }));
  }
  log('info', { code: 'BILLING_SETTLED', workspaces, entries, busy, ms: Date.now() - started });
  const { rows: [lag] } = await runtime.db.execute<{ oldest: string | null }>(sql`SELECT (extract(epoch FROM min(hour))*1000)::bigint::text AS oldest FROM billing_usage_hourly WHERE quantity<>settled_quantity`);
  if (lag?.oldest && Date.now() - Number(lag.oldest) > LAG_ALERT_MS) log('error', { code: 'BILLING_SETTLE_LAG', oldestOpenHour: new Date(Number(lag.oldest)).toISOString() });
  return { workspaces, entries, busy };
}
