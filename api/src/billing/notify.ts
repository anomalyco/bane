import { sql } from 'drizzle-orm';
import { isSimulatedSes, log, type JobHandler } from '../core.js';
import { retryDatabaseFailures } from '../jobs.js';
import { formatUsd, microCents, RATES, type MicroCents } from './money.js';
import type { NoticeKind } from './types.js';

// Owner emails about money (job billing.notify, one per billing_notices row). The notice row is the dedupe: A's
// billing_notice() inserts it once per episode (its dedupe_key is unique) with this job. Here a 5-minute lease
// makes one runner send it, the idempotency key makes a retried send one email, and the status ends sent,
// suppressed (shadow mode, or the account is not prepaid) or failed (nobody to tell). Each email says what
// happened, what Bane did and what to do, ending with the Billing link.


export type NoticeContext = {
  workspace: string;
  link: string;
  /** Paid + promotional credit, after settlement. */
  totalUc: MicroCents;
  /** Free emails left this month, from billing_position. */
  freeLeft: number;
  unpaidSince: Date | null;
  data: Record<string, unknown>;
};

const DAY = 86_400_000;
const day = (value: Date) => value.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const count = (value: number | bigint) => value.toLocaleString('en-US');
const steps = (items: string[]) => items.map((item, index) => `${index + 1}. ${item}`).join('\n');
// Stripe decline codes in plain words. Anything else falls back to Stripe's own message.
const DECLINES: Record<string, string> = {
  card_declined: 'the bank declined it', generic_decline: 'the bank declined it', do_not_honor: 'the bank declined it', lost_card: 'the bank declined it', stolen_card: 'the bank declined it',
  insufficient_funds: 'the card has insufficient funds', expired_card: 'the card has expired', incorrect_cvc: 'the card’s security code was wrong',
  authentication_required: 'the bank asked for confirmation (3-D Secure), which needs you present', processing_error: 'the card processor had an error',
  card_velocity_exceeded: 'the card reached its spending limit', withdrawal_count_limit_exceeded: 'the card reached its spending limit',
};
export const declineWords = (code: unknown, message: unknown) => (typeof code === 'string' && DECLINES[code]) || (typeof message === 'string' && message.trim() ? message.trim().replace(/\.$/, '') : 'the bank declined it');

/** The subject and plain-text body for one notice. Pure: the acceptance tests and the job share it. */
export function noticeEmail(kind: NoticeKind, n: NoticeContext) {
  const total = formatUsd(n.totalUc), debt = formatUsd(microCents(n.totalUc < 0n ? -n.totalUc : 0n));
  const holdAt = n.unpaidSince ? new Date(n.unpaidSince.getTime() + 7 * DAY) : null;
  const body = (what: string, did: string, todo: string[]) => `What happened\n${what}\n\nWhat Bane did\n${did}\n\nWhat to do\n${steps(todo)}\n\nSettings → Billing: ${n.link}\n`;
  switch (kind) {
    case 'low_balance': {
      const emails = (n.totalUc > 0n ? n.totalUc / RATES.emailUc : 0n) + BigInt(Math.max(0, n.freeLeft));
      return { subject: `Bane: ${n.workspace} balance is low (${total})`,
        text: body(`The prepaid balance of ${n.workspace} is ${total}. That covers about ${count(emails)} more emails at $0.20 per 1,000.`,
          'Nothing yet: sending and receiving continue. When the balance reaches $0, Bane pauses sending.',
          ['Add credit in Settings → Billing.', 'Or turn on auto-recharge there, so Bane adds credit from your saved card before the balance runs out.']) };
    }
    case 'recharge_failed': {
      const last4 = typeof n.data.last4 === 'string' && /^\d{4}$/.test(n.data.last4) ? ` ending ${n.data.last4}` : '';
      return { subject: `Bane couldn't add credit to ${n.workspace}`,
        text: body(`Auto-recharge tried to charge the card${last4} and the charge failed: ${declineWords(n.data.code, n.data.message)}.`,
          `Bane turned auto-recharge off until the card is updated, and won't retry the charge. The balance is ${total}; sending continues until it reaches $0.`,
          ['Update the card in Settings → Billing (Replace).', 'Turn auto-recharge back on.', 'Or add credit with Stripe Checkout now.']) };
    }
    case 'sends_paused':
      return { subject: `Bane paused sending for ${n.workspace}`,
        text: body(`The prepaid balance of ${n.workspace} reached ${total}, and this month's ${count(RATES.freeEmails)} free emails are used.`,
          `Bane paused sending. The API answers 402 BALANCE_EXHAUSTED, campaigns wait and resume on their own, and SMTP submissions get a temporary 451, so mail clients keep the message and retry. ${holdAt ? `Received mail is still accepted until ${day(holdAt)}.` : 'Received mail is still accepted; if the balance stays below $0 for 7 days, Bane holds new received mail.'} Nothing is deleted.`,
          ['Add credit in Settings → Billing. Sending resumes within a minute, and any amount owed is settled from the top-up.', 'Turn on auto-recharge so it doesn’t happen again.']) };
    case 'receive_hold_soon':
      return { subject: `Received mail for ${n.workspace} will be held on ${holdAt ? day(holdAt) : 'day 7'}`,
        text: body(`${n.workspace} has owed ${debt} since ${n.unpaidSince ? day(n.unpaidSince) : 'its balance went below $0'}.`,
          `Sending is paused. Received mail is still accepted and delivered${holdAt ? ` until ${day(holdAt)}` : ''}. From then on Bane holds new received mail: it's stored safely but not delivered to inboxes, webhooks or IMAP. Nothing is deleted.`,
          [`Add credit in Settings → Billing to settle the ${debt}. Sending resumes and nothing is held.`]) };
    case 'receive_held':
      return { subject: `Bane is holding received mail for ${n.workspace}`,
        text: body(`${n.workspace} has owed ${debt} since ${n.unpaidSince ? day(n.unpaidSince) : 'its balance went below $0'}, for more than 7 days.`,
          `Bane is holding new received mail. It's stored safely but not delivered to inboxes, webhooks or IMAP until a top-up; mail received earlier stays readable. Nothing is deleted. After 60 days the debt is written off, but the hold stays until a top-up.`,
          ['Add credit in Settings → Billing. Held mail is then delivered in the order it arrived.']) };
  }
}

type Row = { id: string; kind: NoticeKind; data: Record<string, unknown>; enforcement: string; mode: string; name: string | null; position: { availableUc?: string; balanceUc?: string; promoUc?: string; freeEmailsLeft?: number } | null; unpaid_since: Date | string | null; recipients: string[] };

export const notifyJob: JobHandler = retryDatabaseFailures(async (runtime, payload, job) => {
  const noticeId = typeof payload.noticeId === 'string' ? payload.noticeId : '';
  // The lease: one runner at a time, and a crashed send is retried after 5 minutes. Everything the email needs comes
  // back with it: the enforcement, the account's mode and position, and up to 20 owners and admins.
  const { rows: [notice] } = await runtime.db.execute<Row>(sql`WITH leased AS (
      UPDATE billing_notices SET status='sending',lease_until=now()+interval '5 minutes'
      WHERE id=${noticeId} AND workspace_id=${job.workspaceId} AND (status='pending' OR (status='sending' AND lease_until<now())) RETURNING id,kind,data,workspace_id)
    SELECT l.id,l.kind,l.data,c.mode AS enforcement,coalesce(a.mode,'prepaid') AS mode,a.unpaid_since,w.name,billing_position(l.workspace_id) AS position,
      ARRAY(SELECT u.email FROM workspace_members m JOIN auth_user u ON u.id=m.user_id WHERE m.workspace_id=l.workspace_id AND m.role IN ('owner','admin') ORDER BY u.email LIMIT 20) AS recipients
    FROM leased l CROSS JOIN billing_config c LEFT JOIN billing_accounts a ON a.workspace_id=l.workspace_id LEFT JOIN workspaces w ON w.id=l.workspace_id WHERE c.singleton`);
  if (!notice) return;
  const settle = (status: 'sent' | 'suppressed' | 'failed') => runtime.db.execute(sql`UPDATE billing_notices SET status=${status},lease_until=NULL,sent_at=CASE WHEN ${status}='sent' THEN now() END
    WHERE id=${notice.id} AND status='sending'`);
  if (!runtime.config.multiTenant || notice.enforcement !== 'enforce' || notice.mode !== 'prepaid') {
    await settle('suppressed');
    log('info', { code: 'BILLING_NOTICE_SUPPRESSED', workspaceId: job.workspaceId, kind: notice.kind, enforcement: notice.enforcement, mode: notice.mode });
    return;
  }
  if (!notice.recipients.length) { await settle('failed'); log('warn', { code: 'BILLING_NOTIFY_NO_RECIPIENTS', workspaceId: job.workspaceId, kind: notice.kind }); return; }
  const from = runtime.config.notifyFrom, sender = runtime.config.platformDomainWorkspace;
  if (!from || !sender) {
    await settle('failed');
    log('info', { code: 'BILLING_NOTIFY_SKIPPED', workspaceId: job.workspaceId, kind: notice.kind, reason: 'BANE_NOTIFY_FROM or the platform workspace is not configured' });
    return;
  }
  // Workspace names are the customer's: one line, bounded, so the subject is always a valid header.
  const oneLine = (v: string) => v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 100) || 'your workspace';
  const position = notice.position ?? {};
  const totalUc = microCents(BigInt(position.balanceUc ?? '0') + BigInt(position.promoUc ?? '0'));
  const email = noticeEmail(notice.kind, { workspace: oneLine(notice.name ?? ''), link: `${runtime.config.publicUrl.replace(/\/$/, '')}/settings#billing`, totalUc,
    freeLeft: Number(position.freeEmailsLeft ?? 0), unpaidSince: notice.unpaid_since ? new Date(notice.unpaid_since) : null, data: notice.data ?? {} });
  const { sendSystemEmail } = await import('../sending.js');
  await sendSystemEmail(runtime, sender, { from, to: notice.recipients, subject: email.subject, text: email.text, idempotencyKey: `billing:${notice.id}` });
  await settle('sent');
  log('info', { code: 'BILLING_NOTIFIED', workspaceId: job.workspaceId, kind: notice.kind, recipients: notice.recipients.length, simulated: isSimulatedSes(runtime) });
});
