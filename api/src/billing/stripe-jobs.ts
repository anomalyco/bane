import { sql } from 'drizzle-orm';
import { id, log, type JobHandler, type Runtime } from '../core.js';
import { chargeSavedCard, insertAttempt, lockAccount, reconcileAttempt, reconcileRefund, StripeError } from './stripe.js';

/** Hosted and configured: the minute sweep and the recharge job do nothing on an installation without Stripe keys. */
const configured = (runtime: Runtime) => runtime.config.multiTenant && !!runtime.config.billing?.stripe;

// The billing_accounts_recharge predicate (240) plus what the job re-checks, so a capped or blocked account is not
// re-queued every minute.
const rechargeDue = sql`a.recharge_enabled AND a.recharge_pending_attempt IS NULL AND a.recharge_disabled_at IS NULL AND a.mode='prepaid'
  AND a.stripe_payment_method IS NOT NULL AND a.stripe_customer IS NOT NULL
  AND NOT EXISTS (SELECT FROM billing_blocked_cards b WHERE b.fingerprint=a.card_fingerprint)
  AND CASE WHEN a.recharge_month=(date_trunc('month',now() AT TIME ZONE 'UTC'))::date THEN a.recharge_month_total_uc ELSE 0 END + a.recharge_amount_uc <= a.recharge_month_cap_uc`;

/**
 * billing.recharge (job ID billing.recharge:<wid>, queued by the gate, the settler and the minute sweep). One pending
 * charge at a time: take the account lock, then (in a new statement, so it sees every credit and attempt committed
 * while this job waited) re-check eligibility against billing_position (balance + promo − unsettled usage), write the
 * attempt only while no other recharge is open, and mark it pending; then charge the saved card outside the
 * transaction. Any refusal (a decline, 3DS, a non-card refusal) turns auto-recharge off with one email; no retry.
 */
export const rechargeJob: JobHandler = async (runtime, _payload, job) => {
  if (!configured(runtime)) { log('warn', { code: 'BILLING_RECHARGE_SKIPPED', workspaceId: job.workspaceId, reason: 'stripe_not_configured' }); return; }
  const attemptId = await runtime.db.transaction(async tx => {
    if (!await lockAccount(tx, job.workspaceId, false)) return null;
    const [a] = (await tx.execute<{ enforce: boolean; eligible: boolean; below: boolean; capped: boolean; amount_uc: string }>(sql`SELECT
        (SELECT mode='enforce' FROM billing_config WHERE singleton) AS enforce,
        a.recharge_enabled AND a.recharge_pending_attempt IS NULL AND a.recharge_disabled_at IS NULL AND a.mode='prepaid'
          AND a.stripe_payment_method IS NOT NULL AND a.stripe_customer IS NOT NULL
          AND NOT EXISTS (SELECT FROM billing_blocked_cards b WHERE b.fingerprint=a.card_fingerprint)
          AND NOT EXISTS (SELECT FROM billing_payment_attempts p WHERE p.workspace_id=a.workspace_id AND p.kind='recharge' AND p.status IN ('created','pending','requires_action')) AS eligible,
        (billing_position(a.workspace_id)->>'availableUc')::bigint < a.recharge_threshold_uc AS below,
        CASE WHEN a.recharge_month=(date_trunc('month',now() AT TIME ZONE 'UTC'))::date THEN a.recharge_month_total_uc ELSE 0 END + a.recharge_amount_uc > a.recharge_month_cap_uc AS capped,
        a.recharge_amount_uc::text AS amount_uc
      FROM billing_accounts a WHERE a.workspace_id=${job.workspaceId}`)).rows;
    if (!a?.enforce || !a.eligible || !a.below) return null;
    if (a.capped) { log('info', { code: 'BILLING_RECHARGE_CAPPED', workspaceId: job.workspaceId }); return null; }
    const attempt = id('bpa');
    if (!await insertAttempt(tx, attempt, job.workspaceId, 'recharge', BigInt(a.amount_uc), 'system')) return null;
    await tx.execute(sql`UPDATE billing_accounts SET recharge_pending_attempt=${attempt}, updated_at=now() WHERE workspace_id=${job.workspaceId}`);
    return attempt;
  });
  if (attemptId) await chargeSavedCard(runtime, attemptId);
};

const RECONCILE_BATCH = 100, RECONCILE_BUDGET_MS = 40_000;
/** Reconciliation of open attempts and refunds unchanged for 5 minutes, oldest first, within a time budget. */
export async function reconcilePayments(runtime: Runtime, budgetMs = RECONCILE_BUDGET_MS) {
  const deadline = Date.now() + budgetMs;
  const attempts = (await runtime.db.execute<{ id: string }>(sql`SELECT id FROM billing_payment_attempts
    WHERE status IN ('created','pending','requires_action') AND updated_at < now()-interval '5 minutes' ORDER BY updated_at LIMIT ${RECONCILE_BATCH}`)).rows;
  const refunds = (await runtime.db.execute<{ id: string }>(sql`SELECT id FROM billing_refunds
    WHERE status IN ('held','pending') AND created_at < now()-interval '5 minutes' ORDER BY created_at LIMIT ${RECONCILE_BATCH}`)).rows;
  let done = 0, failed = 0;
  for (const [kind, rows, work] of [['attempt', attempts, reconcileAttempt], ['refund', refunds, reconcileRefund]] as const) {
    for (const { id: rowId } of rows) {
      if (Date.now() > deadline) break;
      try { await work(runtime, rowId); done++; }
      catch (error) {
        failed++;
        log('warn', { code: 'BILLING_RECONCILE_FAILED', kind, id: rowId, reason: error instanceof StripeError ? error.reason : error instanceof Error ? error.name : 'error' });
        // Move it behind the rest of the backlog so one stubborn row can't hold up the others.
        if (kind === 'attempt') await runtime.db.execute(sql`UPDATE billing_payment_attempts SET updated_at=now() WHERE id=${rowId} AND status IN ('created','pending','requires_action')`);
      }
    }
  }
  if (attempts.length || refunds.length) log(failed ? 'warn' : 'info', { code: 'BILLING_RECONCILED', attempts: attempts.length, refunds: refunds.length, done, failed });
}

/**
 * Every minute (Worker cron and Node runner). The recharge sweep runs only when billing is enforced; reconciliation
 * is elected once per 5 minutes across processes through job_schedule ('billing:reconcile').
 */
export async function billingMinute(runtime: Runtime): Promise<void> {
  if (!configured(runtime)) return;
  const swept = await runtime.db.execute<{ id: string }>(sql`WITH due AS (
      SELECT a.workspace_id FROM billing_accounts a, billing_config c
      WHERE c.singleton AND c.mode='enforce' AND ${rechargeDue} AND a.balance_uc+a.promo_uc < a.recharge_threshold_uc ORDER BY a.workspace_id LIMIT 50)
    INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'billing.recharge:'||workspace_id, 'billing.recharge', workspace_id, '{}' FROM due
    ON CONFLICT (id) DO UPDATE SET status='pending', attempts=0, available_at=now(), lease_until=NULL, last_error=NULL WHERE jobs.status IN ('completed','failed')
    RETURNING id`);
  if (swept.rows.length) try { await runtime.wake?.(swept.rows.length); } catch { log('warn', { code: 'QUEUE_WAKE_FAILED', message: 'Recharge jobs are durable; the scheduler will run them.' }); }
  const elected = await runtime.db.execute(sql`INSERT INTO job_schedule(workspace_id, next_wake_at) VALUES ('billing:reconcile', now()+interval '5 minutes')
    ON CONFLICT (workspace_id) DO UPDATE SET next_wake_at=excluded.next_wake_at WHERE job_schedule.next_wake_at<=now() RETURNING 1`);
  if (elected.rows.length) await reconcilePayments(runtime);
}
