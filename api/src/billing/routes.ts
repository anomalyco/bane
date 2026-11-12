import { randomUUID } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { actor, actorMailAccess, ApiError, dashboardSession, errors, json, notFound, response, security, type Actor, type App, type Ctx, type DbExecutor } from '../core.js';
import { mutate, operatorActor } from '../operator.js';
import { MicroCentsJson } from './money.js';
import { readBilling } from './state.js';
import { chargeSavedCardTopUp, createCardSetup, createCheckoutTopUp, getPayment, listPayments, refundTopUp, removePaymentMethod, setAutoRecharge } from './stripe.js';
import type { BillingPosition, LedgerKind, PaymentView } from './types.js';

// The billing API (hosted only): the balance, usage by meter, the ledger and payments for owners, admins and manage
// credentials, and the money routes. Who may do what:
// - Every billing route refuses domain-restricted keys (403 UNRESTRICTED_KEY_REQUIRED), as /v1/usage does.
// - Reads: any credential with read sees GET /v1/billing, with amounts only for manage (owner and admin sessions,
//   manage keys and grants). The ledger and payments need manage.
// - A top-up link (a Stripe Checkout URL a person opens) needs manage: an agent can ask for one but never pays.
// - Charging the saved card, auto-recharge and the payment method need a signed-in owner or admin in the dashboard.
// Stripe itself is package B (stripe.ts); these handlers only authorize, validate and shape.

const MicroCents = MicroCentsJson;
const Prices = z.object({ emailPerThousand: z.string().describe('USD per 1,000 emails, sent (per recipient) or received (per message).'), omenPerThousand: z.string(), storagePerGbMonth: z.string().describe('USD per GB-month for received mail older than 90 days, beyond the free GB.'),
  freeEmails: z.number().int(), freeStorageBytes: z.number().int(), topUpMinCents: z.number().int(), currency: z.literal('USD') });
export const BillingSummarySchema = z.object({
  enforcement: z.enum(['off', 'shadow', 'enforce']).describe('off: nothing is metered for billing. shadow: usage is recorded and priced but nothing is charged. enforce: usage is taken from the balance hourly.'),
  mode: z.enum(['prepaid', 'invoiced', 'exempt']),
  state: z.object({
    sending: z.enum(['ok', 'low', 'paused']).describe('paused: sends get 402 BALANCE_EXHAUSTED until credit is added.'),
    receiving: z.enum(['ok', 'grace', 'held']).describe('grace: the balance is below $0 and received mail is still accepted; held: new received mail is stored but not delivered until a top-up.'),
    autoRecharge: z.enum(['off', 'on', 'pending', 'failed', 'capped']),
  }),
  balance: z.object({ paid: MicroCents, promo: MicroCents.describe('Promotional credit: spent first, never refunded.'), unsettled: MicroCents.describe('Usage not yet taken from the balance (settled hourly).'), available: MicroCents.describe('paid + promo − unsettled.') })
    .nullable().describe('Null unless the caller is an owner or admin session, or a manage key or grant.'),
  free: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), emails: z.object({ limit: z.number().int(), used: z.number().int(), left: z.number().int() }), storage: z.object({ limitBytes: z.number().int(), agedBytes: z.string().describe('Bytes of received mail older than 90 days.') }) }),
  monthToDate: z.object({ cost: MicroCents.describe('This month’s usage cost after the free allowance, settled and unsettled, charged or not.') }).nullable(),
  grace: z.object({ unpaidSince: z.string().nullable(), receiveHoldAt: z.string().nullable(), writeOffAt: z.string().nullable() }),
  autoRecharge: z.object({ enabled: z.boolean(), thresholdCents: z.number().int(), amountCents: z.number().int(), monthlyCapCents: z.number().int(), monthTotalCents: z.number().int(),
    disabledReason: z.string().nullable().describe('Why Bane turned auto-recharge off (a card decline code, dispute or a removed card).'), pending: z.boolean() }).nullable(),
  paymentMethod: z.object({ brand: z.string(), last4: z.string(), expMonth: z.number().int(), expYear: z.number().int() }).nullable(),
  prices: Prices,
  topUpUrl: z.string().describe('Where a person adds credit.'),
}).openapi('BillingSummary');
const LedgerEntry = z.object({
  id: z.string(), at: z.string(), kind: z.enum(['topup', 'usage', 'grant', 'refund_hold', 'refund_release', 'dispute', 'dispute_reversal', 'write_off', 'adjustment']),
  amount: MicroCents.describe('paid + promo; negative takes from the balance.'), paid: MicroCents, promo: MicroCents, balanceAfter: MicroCents.describe('Paid and promotional balance after this entry.'),
  description: z.string(), detail: z.record(z.string(), z.unknown()), paymentId: z.string().nullable(), invoiceUrl: z.string().nullable(),
}).openapi('BillingLedgerEntry');
const Payment = z.object({
  id: z.string(), at: z.string(), kind: z.enum(['checkout', 'saved_card', 'recharge', 'setup']), status: z.enum(['created', 'pending', 'requires_action', 'succeeded', 'failed', 'canceled', 'expired']),
  amountCents: z.number().int().describe('Credit bought, excluding tax.'), taxCents: z.number().int().nullable(), totalCents: z.number().int().nullable(),
  card: z.object({ brand: z.string(), last4: z.string() }).nullable(), invoiceUrl: z.string().nullable(), invoicePdf: z.string().nullable(), receiptUrl: z.string().nullable(),
  failure: z.object({ code: z.string(), message: z.string() }).nullable(),
}).openapi('BillingPayment');
const UsagePoint = z.object({ start: z.string().describe('Start of the period, UTC.'), meter: z.enum(['send', 'receive', 'omen', 'storage', 'byo_send', 'byo_receive']),
  quantity: z.string().describe('send: recipients; receive: messages; omen: evaluations; storage: billable byte-days beyond the free GB; byo_*: reported only, $0.') }).openapi('BillingUsagePoint');
const TopUpAmount = z.number().int().min(2000).max(1_000_000).describe('Whole US cents, $20 to $10,000, excluding tax.');
const Cursor = z.string().regex(/^\d{1,19}$/).optional();

/** Hosted only, and workspace-wide: a key restricted to domains never reads or moves money. */
function billingActor(c: Ctx, permission: 'read' | 'manage') {
  if (!c.env.config.multiTenant) notFound('Endpoint');
  const a = actor(c, permission);
  if (a.domains.length) throw new ApiError(403, 'UNRESTRICTED_KEY_REQUIRED', 'Workspace-wide operations require a key without domain restrictions.');
  return a;
}
const seesMoney = (a: Actor) => a.permissions.includes('manage');
/** Who started a payment, for billing_payment_attempts.created_by. */
const createdBy = (a: Actor) => a.credential === 'dashboard' && a.keyId.startsWith('user_') ? `user:${a.keyId.slice(5)}` : `key:${a.keyId}`;
/** A signed-in owner or admin of a Hosted workspace. Keys, grants and agent tokens get 403 DASHBOARD_AUTH_REQUIRED. */
function moneySession(c: Ctx) {
  const session = dashboardSession(c, true);
  return { ...session, actor: `user:${session.userId}` };
}
const summary = (c: Ctx, workspaceId: string, amounts: boolean) => readBilling(c.env.db, workspaceId, { amounts, publicUrl: c.env.config.publicUrl.replace(/\/$/, '') });

// ---------- ledger wording ----------
const count = (n: unknown) => Number(n ?? 0).toLocaleString('en-US');
type MeterDetail = { quantity?: number | string };
const when = (at: Date, day: boolean) => at.toLocaleString('en-US', { ...(day ? { month: 'short', day: 'numeric' } : {}), hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' });
/** " Nov 12, 13:00–15:00 UTC" for the closed hours a settlement covered (billing_settle's detail.from/to). */
function period(from: unknown, to: unknown) {
  const a = typeof from === 'string' ? new Date(from) : null, b = typeof to === 'string' ? new Date(to) : null;
  if (!a || !b || Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return '';
  return a.toISOString().slice(0, 10) === new Date(b.getTime() - 1).toISOString().slice(0, 10) ? ` ${when(a, true)}–${when(b, false)} UTC` : ` ${when(a, true)} – ${when(b, true)} UTC`;
}
/** A ledger row in plain words. Operator notes (reason, ticket) stay internal. */
function describe(kind: LedgerKind, detail: Record<string, unknown>) {
  switch (kind) {
    case 'usage': {
      const meters = (typeof detail.meters === 'object' && detail.meters ? detail.meters : detail) as Record<string, MeterDetail | undefined>;
      const q = (m: string) => Number(meters[m]?.quantity ?? 0);
      const parts = [q('send') + q('receive') ? `${count(q('send') + q('receive'))} emails` : '', q('omen') ? `${count(q('omen'))} Omens` : '', q('storage') ? 'stored mail' : '',
        q('byo_send') + q('byo_receive') ? `${count(q('byo_send') + q('byo_receive'))} emails on your AWS` : ''].filter(Boolean);
      return `Usage${period(detail.from, detail.to)}: ${parts.join(', ') || 'none'}${detail.charged === false ? ' (not charged)' : ''}`;
    }
    case 'topup': return detail.recharge === true ? 'Auto-recharge' : 'Credit added';
    case 'grant': return 'Promotional credit from Bane';
    case 'adjustment': return 'Adjustment by Bane';
    case 'refund_hold': return 'Refund';
    case 'refund_release': return 'Refund canceled: credit restored';
    case 'dispute': return 'Card payment disputed';
    case 'dispute_reversal': return 'Dispute closed in your favor: credit restored';
    case 'write_off': return 'Unpaid balance written off';
  }
}
const INTERNAL = new Set(['reason', 'ticketRef', 'operator', 'operatorId', 'note']);
const publicDetail = (detail: Record<string, unknown>) => Object.fromEntries(Object.entries(detail ?? {}).filter(([key]) => !INTERNAL.has(key)));

type LedgerRow = { id: string; at: string; kind: LedgerKind; source_id: string; paid_uc: string; promo_uc: string; balance_after_uc: string; promo_after_uc: string; detail: Record<string, unknown> };
async function ledgerPage(db: DbExecutor, workspaceId: string, cursor: string | undefined, limit: number) {
  const { rows } = await db.execute<LedgerRow>(sql`SELECT id::text,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,kind,source_id,paid_uc::text,promo_uc::text,balance_after_uc::text,promo_after_uc::text,detail
    FROM billing_ledger WHERE workspace_id=${workspaceId} ${cursor ? sql`AND id<${cursor}::bigint` : sql``} ORDER BY id DESC LIMIT ${limit + 1}`);
  const page = rows.slice(0, limit);
  return { rows: page, nextCursor: rows.length > limit ? page.at(-1)!.id : null };
}
const paymentOf = (row: LedgerRow) => row.source_id.startsWith('attempt:') ? row.source_id.slice(8) : typeof row.detail?.attemptId === 'string' ? row.detail.attemptId : null;

export function registerBilling(app: App) {
  app.openapi(createRoute({ method: 'get', path: '/v1/billing', operationId: 'getBilling', tags: ['Billing'], security, summary: 'Balance, free allowance and billing state',
    description: 'Hosted only. The prepaid balance, this month’s free allowance and cost, whether sending or receiving is paused for an empty balance, auto-recharge and the saved card, and the prices. Amounts are null unless the caller is an owner or admin session, or a manage key or grant. Keys restricted to domains get 403.',
    responses: { 200: response(BillingSummarySchema), ...errors } }), async c => {
    const a = billingActor(c, 'read');
    return c.json(await summary(c, a.workspaceId, seesMoney(a)), 200);
  });

  app.openapi(createRoute({ method: 'get', path: '/v1/billing/usage', operationId: 'getBillingUsage', tags: ['Billing'], security, summary: 'Metered usage by day, hour or month',
    description: 'Hosted only. Metered quantities per meter and period, UTC, the same counts billing prices (sent recipients, received messages, Omen evaluations, stored bytes). Received mail and Omens are listed only for credentials that may read every received message (owners, admins and manage credentials). At most 400 days, or 31 days by the hour.',
    request: { query: z.object({ from: z.iso.date().optional().describe('First day, UTC (default: the first of this month).'), to: z.iso.date().optional().describe('Last day, inclusive (default: today).'),
      granularity: z.enum(['hour', 'day', 'month']).default('day'), meter: z.enum(['send', 'receive', 'omen', 'storage', 'byo_send', 'byo_receive']).optional() }) },
    responses: { 200: response(z.object({ data: z.array(UsagePoint) })), ...errors } }), async c => {
    const a = billingActor(c, 'read'), q = c.req.valid('query'), today = new Date().toISOString().slice(0, 10);
    const from = q.from ?? `${today.slice(0, 7)}-01`, to = q.to ?? today, days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    if (days < 0) throw new ApiError(422, 'VALIDATION_FAILED', 'from must be on or before to.', 'from');
    if (days >= (q.granularity === 'hour' ? 31 : 400)) throw new ApiError(422, 'VALIDATION_FAILED', q.granularity === 'hour' ? 'By the hour, ask for at most 31 days.' : 'Ask for at most 400 days.', 'from');
    // Received volume (and the Omens it triggers) belongs to whoever may list every received message, the same rule
    // as GET /v1/usage: anyone else could poll it around a probe to learn which addresses take mail.
    const hidden = actorMailAccess(a)?.admin === true ? [] : ['receive', 'byo_receive', 'omen'];
    if (q.meter && hidden.includes(q.meter)) return c.json({ data: [] }, 200);
    const unit = q.granularity;
    const { rows } = await c.env.db.execute<z.infer<typeof UsagePoint>>(sql`SELECT to_char(date_trunc(${unit},hour,'UTC') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS start,meter,sum(quantity)::text AS quantity
      FROM billing_usage_hourly WHERE workspace_id=${a.workspaceId} AND hour>=(${from}::date)::timestamp AT TIME ZONE 'UTC' AND hour<(${to}::date+1)::timestamp AT TIME ZONE 'UTC'
        ${q.meter ? sql`AND meter=${q.meter}` : sql``} ${hidden.length ? sql`AND meter NOT IN ('receive','byo_receive','omen')` : sql``}
      GROUP BY 1,2 HAVING sum(quantity)<>0 ORDER BY 1,2`);
    return c.json({ data: rows }, 200);
  });

  app.openapi(createRoute({ method: 'get', path: '/v1/billing/ledger', operationId: 'listBillingLedger', tags: ['Billing'], security, summary: 'Balance history',
    description: 'Hosted only; owners, admins and manage credentials. Every change to the balance, newest first: top-ups, hourly usage, promotional credit, refunds and adjustments, with the balance after each.',
    request: { query: z.object({ cursor: Cursor.describe('nextCursor from the previous page.'), limit: z.coerce.number().int().min(1).max(100).default(50) }) },
    responses: { 200: response(z.object({ data: z.array(LedgerEntry), nextCursor: z.string().nullable() })), ...errors } }), async c => {
    const a = billingActor(c, 'manage'), q = c.req.valid('query');
    const page = await ledgerPage(c.env.db, a.workspaceId, q.cursor, q.limit);
    // Invoice links live on the payment (package B); one read per distinct payment on the page.
    const ids = [...new Set(page.rows.map(paymentOf).filter((id): id is string => !!id))];
    const payments = new Map<string, PaymentView | null>();
    for (const id of ids) payments.set(id, await getPayment(c.env.db, a.workspaceId, id));
    return c.json({ data: page.rows.map(row => {
      const paid = BigInt(row.paid_uc), promo = BigInt(row.promo_uc), paymentId = paymentOf(row);
      return { id: row.id, at: row.at, kind: row.kind, amount: (paid + promo).toString(), paid: row.paid_uc, promo: row.promo_uc, balanceAfter: (BigInt(row.balance_after_uc) + BigInt(row.promo_after_uc)).toString(),
        description: describe(row.kind, row.detail ?? {}), detail: publicDetail(row.detail), paymentId, invoiceUrl: paymentId ? payments.get(paymentId)?.invoiceUrl ?? null : null };
    }), nextCursor: page.nextCursor }, 200);
  });

  app.openapi(createRoute({ method: 'get', path: '/v1/billing/payments', operationId: 'listBillingPayments', tags: ['Billing'], security, summary: 'Payments and their invoices',
    description: 'Hosted only; owners, admins and manage credentials. Card payments for credit, newest first, with status, tax and invoice and receipt links.',
    request: { query: z.object({ cursor: z.string().max(200).optional().describe('nextCursor from the previous page.'), limit: z.coerce.number().int().min(1).max(100).default(50) }) },
    responses: { 200: response(z.object({ data: z.array(Payment), nextCursor: z.string().nullable() })), ...errors } }), async c => {
    const a = billingActor(c, 'manage'), q = c.req.valid('query');
    return c.json(await listPayments(c.env.db, a.workspaceId, q.cursor ?? null, q.limit), 200);
  });

  app.openapi(createRoute({ method: 'get', path: '/v1/billing/payments/{id}', operationId: 'getBillingPayment', tags: ['Billing'], security, summary: 'One payment',
    description: 'Hosted only; owners, admins and manage credentials. The dashboard polls this after Stripe Checkout returns, until the status is final.',
    request: { params: z.object({ id: z.string().min(1).max(100) }) }, responses: { 200: response(Payment), ...errors } }), async c => {
    const a = billingActor(c, 'manage');
    const payment = await getPayment(c.env.db, a.workspaceId, c.req.valid('param').id);
    return payment ? c.json(payment, 200) : notFound('Payment');
  });

  app.openapi(createRoute({ method: 'post', path: '/v1/billing/top-ups', operationId: 'createBillingTopUp', tags: ['Billing'], security, summary: 'Add credit',
    description: 'Hosted only; a signed-in owner or admin in the dashboard. checkout returns a Stripe Checkout URL to open; saved_card charges the saved card now and returns its status. Credit appears when Stripe confirms the payment.',
    request: { body: json(z.object({ amountCents: TopUpAmount, method: z.enum(['checkout', 'saved_card']) }).strict()) },
    responses: { 201: response(z.object({ attemptId: z.string(), status: Payment.shape.status, checkoutUrl: z.string().nullable(), expiresAt: z.string().nullable() })), ...errors } }), async c => {
    const session = moneySession(c), body = c.req.valid('json');
    if (body.method === 'checkout') {
      const r = await createCheckoutTopUp(c.env, { workspaceId: session.workspaceId, amountCents: body.amountCents, actor: session.actor, billingEmail: session.email ?? null });
      return c.json({ attemptId: r.attemptId, status: 'pending' as const, checkoutUrl: r.url, expiresAt: r.expiresAt }, 201);
    }
    const r = await chargeSavedCardTopUp(c.env, { workspaceId: session.workspaceId, amountCents: body.amountCents, actor: session.actor });
    return c.json({ attemptId: r.attemptId, status: r.status, checkoutUrl: null, expiresAt: null }, 201);
  });

  app.openapi(createRoute({ method: 'post', path: '/v1/billing/top-up-links', operationId: 'createBillingTopUpLink', tags: ['Billing'], security, summary: 'Create a link to add credit',
    description: 'Hosted only; owners, admins and manage credentials. Returns a Stripe Checkout link for a person to open and pay; the caller never handles card details. The link expires in 23 hours.',
    request: { body: json(z.object({ amountCents: TopUpAmount }).strict()) },
    responses: { 201: response(z.object({ attemptId: z.string(), url: z.string(), expiresAt: z.string() })), ...errors } }), async c => {
    const a = billingActor(c, 'manage'), body = c.req.valid('json');
    const r = await createCheckoutTopUp(c.env, { workspaceId: a.workspaceId, amountCents: body.amountCents, actor: createdBy(a), billingEmail: a.credential === 'dashboard' ? a.email ?? null : null });
    return c.json({ attemptId: r.attemptId, url: r.url, expiresAt: r.expiresAt }, 201);
  });

  const AutoRecharge = z.object({
    enabled: z.boolean(),
    thresholdCents: z.number().int().min(500).max(100_000).describe('Recharge when the balance falls below this ($5 to $1,000).'),
    amountCents: z.number().int().min(2000).max(100_000).describe('Credit to add each time ($20 to $1,000).'),
    monthlyCapCents: z.number().int().min(2000).max(1_000_000).describe('At most this much auto-recharge per calendar month (UTC), at least amountCents.'),
  }).strict().refine(v => v.monthlyCapCents >= v.amountCents, { message: 'monthlyCapCents must be at least amountCents.', path: ['monthlyCapCents'] }).openapi('BillingAutoRecharge');
  app.openapi(createRoute({ method: 'put', path: '/v1/billing/auto-recharge', operationId: 'updateBillingAutoRecharge', tags: ['Billing'], security, summary: 'Set auto-recharge',
    description: 'Hosted only; a signed-in owner or admin in the dashboard. Bane charges the saved card when the balance falls below the threshold, up to the monthly limit. Turning it on needs a saved card (409 PAYMENT_METHOD_REQUIRED) and clears a previous decline.',
    request: { body: json(AutoRecharge) }, responses: { 200: response(BillingSummarySchema), ...errors } }), async c => {
    const session = moneySession(c);
    await setAutoRecharge(c.env, session.workspaceId, c.req.valid('json'));
    return c.json(await summary(c, session.workspaceId, true), 200);
  });

  app.openapi(createRoute({ method: 'post', path: '/v1/billing/payment-method', operationId: 'createBillingCardSetup', tags: ['Billing'], security, summary: 'Save or replace the card',
    description: 'Hosted only; a signed-in owner or admin in the dashboard. Returns a Stripe Checkout URL that saves a card for auto-recharge and one-click top-ups. Nothing is charged.',
    responses: { 201: response(z.object({ checkoutUrl: z.string(), expiresAt: z.string() })), ...errors } }), async c => {
    const session = moneySession(c);
    const r = await createCardSetup(c.env, { workspaceId: session.workspaceId, actor: session.actor, billingEmail: session.email ?? null });
    return c.json({ checkoutUrl: r.url, expiresAt: r.expiresAt }, 201);
  });

  app.openapi(createRoute({ method: 'delete', path: '/v1/billing/payment-method', operationId: 'deleteBillingPaymentMethod', tags: ['Billing'], security, summary: 'Remove the saved card',
    description: 'Hosted only; a signed-in owner or admin in the dashboard. Removes the card from Stripe and turns auto-recharge off.',
    responses: { 200: response(BillingSummarySchema), ...errors } }), async c => {
    const session = moneySession(c);
    await removePaymentMethod(c.env, session.workspaceId);
    return c.json(await summary(c, session.workspaceId, true), 200);
  });

  registerOperatorBilling(app);
}

// ---------- operator tools (hidden from the public OpenAPI document) ----------
// Each change goes through the operator API's mutate(): Idempotency-Key, and a hosted_operator_audit row with the
// reason, before and after, in the same transaction as the money (billing_post). Refunds call Stripe, which never
// runs inside a transaction: package B holds the amount first, and the audit row commits right after.
const Reason = z.string().trim().min(10).max(1000).describe('Why, for the audit log (at least 10 characters).');
const WorkspaceParam = z.object({ wid: z.string().min(1).max(100) });
const Mutation = z.object({ 'Idempotency-Key': z.string().min(1).max(200).optional() });
type Account = { mode: string; balance_uc: string; promo_uc: string; unpaid_since: string | null };
const accountOf = async (tx: DbExecutor, wid: string, lock = false) => (await tx.execute<Account>(sql`SELECT mode,balance_uc::text,promo_uc::text,unpaid_since::text FROM billing_accounts
  WHERE workspace_id=${wid} ${lock ? sql`FOR UPDATE` : sql``}`)).rows[0] ?? { mode: 'prepaid', balance_uc: '0', promo_uc: '0', unpaid_since: null };
async function existingWorkspace(db: DbExecutor, wid: string) {
  const { rows: [row] } = await db.execute<{ id: string }>(sql`SELECT id FROM workspaces WHERE id=${wid}`);
  if (!row) notFound('Workspace');
}
type Posted = { applied: boolean; entryId?: string; balanceUc: string; promoUc: string };
const post = async (tx: DbExecutor, wid: string, kind: LedgerKind, source: string, paid: bigint, promo: bigint, detail: Record<string, unknown>, who: string) =>
  (await tx.execute<{ r: Posted }>(sql`SELECT billing_post(${wid}::text,${kind}::text,${source}::text,${paid.toString()}::bigint,${promo.toString()}::bigint,${JSON.stringify(detail)}::jsonb,${who}::text) AS r`)).rows[0]!.r;
const sourceKey = (c: Ctx, operatorId: string) => { const key = c.req.header('Idempotency-Key'); return key ? `${operatorId}:${key}` : randomUUID(); };

function registerOperatorBilling(app: App) {
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'get', path: '/v1/operator/billing/{wid}', operationId: 'operatorGetBilling', request: { params: WorkspaceParam },
    responses: { 200: response(z.object({ account: z.unknown().nullable(), position: z.unknown(), ledger: z.array(z.unknown()), payments: z.array(z.unknown()), refunds: z.array(z.unknown()), notices: z.array(z.unknown()) })), ...errors } }), async c => {
    await operatorActor(c, 'operator:read');
    const wid = c.req.valid('param').wid;
    await existingWorkspace(c.env.db, wid);
    const { rows: [row] } = await c.env.db.execute<{ account: unknown; position: BillingPosition; ledger: unknown[]; notices: unknown[]; refunds: boolean }>(sql`SELECT
      (SELECT to_jsonb(a) FROM billing_accounts a WHERE a.workspace_id=${wid}) AS account, billing_position(${wid}) AS position,
      coalesce((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id DESC) FROM (SELECT * FROM billing_ledger WHERE workspace_id=${wid} ORDER BY id DESC LIMIT 50) l),'[]') AS ledger,
      coalesce((SELECT jsonb_agg(to_jsonb(n) ORDER BY n.created_at DESC) FROM (SELECT * FROM billing_notices WHERE workspace_id=${wid} ORDER BY created_at DESC LIMIT 50) n),'[]') AS notices,
      to_regclass('billing_refunds') IS NOT NULL AS refunds`);
    // Refunds are package B's table (migration 250); read it only once it exists.
    const refunds = row!.refunds ? (await c.env.db.execute(sql`SELECT * FROM billing_refunds WHERE workspace_id=${wid} ORDER BY created_at DESC LIMIT 50`)).rows : [];
    const payments = (await listPayments(c.env.db, wid, null, 50)).data;
    return c.json({ account: row!.account, position: row!.position, ledger: row!.ledger, payments, refunds, notices: row!.notices }, 200);
  });

  const moneyChange = async (c: Ctx, wid: string, body: { reason: string; ticketRef?: string }, action: string, change: (tx: DbExecutor, before: Account, who: string, operatorId: string) => Promise<Posted | Account>) => {
    const operator = await operatorActor(c, 'operator');
    await existingWorkspace(c.env.db, wid);
    return mutate(c, operator, wid, body, async tx => {
      // Lock order: the account first (billing_post locks it again, then writes the ledger).
      await tx.execute(sql`INSERT INTO billing_accounts(workspace_id) VALUES (${wid}) ON CONFLICT DO NOTHING`);
      const before = await accountOf(tx, wid, true);
      const posted = await change(tx, before, `operator:${operator.userId}`, operator.userId);
      const after = await accountOf(tx, wid);
      return { result: { ok: true as const, ...('applied' in posted ? { applied: posted.applied, entryId: posted.entryId ?? null } : {}), account: after },
        audit: { action, before, after, reason: body.reason, ticketRef: body.ticketRef } };
    });
  };
  const Done = z.object({ ok: z.literal(true), applied: z.boolean().optional(), entryId: z.string().nullable().optional(), account: z.unknown() });

  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'post', path: '/v1/operator/billing/{wid}/credits', operationId: 'operatorGrantBillingCredit',
    request: { params: WorkspaceParam, headers: Mutation, body: json(z.object({ amountCents: z.number().int().min(1).max(100_000), bucket: z.enum(['promo', 'paid']).default('promo'), reason: Reason,
      ticketRef: z.string().trim().min(1).max(200).optional() }).strict()) }, responses: { 200: response(Done), ...errors } }), async c => {
    const wid = c.req.valid('param').wid, body = c.req.valid('json'), uc = BigInt(body.amountCents) * 1_000_000n;
    return c.json(await moneyChange(c, wid, body, `billing-credit-${body.bucket}`, (tx, _before, who, operatorId) => {
      const key = sourceKey(c, operatorId), detail = { reason: body.reason, ...(body.ticketRef ? { ticketRef: body.ticketRef } : {}) };
      // Promotional credit is a grant (spent first, never refunded); paid credit is an adjustment to the paid bucket.
      return body.bucket === 'promo' ? post(tx, wid, 'grant', `grant:${key}`, 0n, uc, detail, who) : post(tx, wid, 'adjustment', `adjustment:${key}`, uc, 0n, detail, who);
    }), 200);
  });

  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'post', path: '/v1/operator/billing/{wid}/adjustments', operationId: 'operatorAdjustBilling',
    request: { params: WorkspaceParam, headers: Mutation, body: json(z.object({ amountCents: z.number().int().min(-1_000_000).max(1_000_000).refine(v => v !== 0, 'Use a non-zero amount.'), reason: Reason,
      ticketRef: z.string().trim().min(1).max(200).optional() }).strict()) }, responses: { 200: response(Done), ...errors } }), async c => {
    const wid = c.req.valid('param').wid, body = c.req.valid('json');
    return c.json(await moneyChange(c, wid, body, 'billing-adjustment', (tx, _before, who, operatorId) =>
      post(tx, wid, 'adjustment', `adjustment:${sourceKey(c, operatorId)}`, BigInt(body.amountCents) * 1_000_000n, 0n, { reason: body.reason, ...(body.ticketRef ? { ticketRef: body.ticketRef } : {}) }, who)), 200);
  });

  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'post', path: '/v1/operator/billing/{wid}/write-off', operationId: 'operatorWriteOffBilling',
    request: { params: WorkspaceParam, headers: Mutation, body: json(z.object({ reason: Reason, ticketRef: z.string().trim().min(1).max(200).optional() }).strict()) }, responses: { 200: response(Done), ...errors } }), async c => {
    const wid = c.req.valid('param').wid, body = c.req.valid('json');
    return c.json(await moneyChange(c, wid, body, 'billing-write-off', (tx, before, who, operatorId) => {
      const owed = -BigInt(before.balance_uc);
      if (owed <= 0n) throw new ApiError(409, 'NOTHING_OWED', 'This workspace owes nothing.');
      // A write-off is not a payment: unpaid_since stays, so a receive hold lasts until a real top-up.
      return post(tx, wid, 'write_off', `write_off:${wid}:manual:${sourceKey(c, operatorId)}`, owed, 0n, { reason: body.reason, manual: true }, who);
    }), 200);
  });

  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'put', path: '/v1/operator/billing/{wid}/mode', operationId: 'operatorSetBillingMode',
    request: { params: WorkspaceParam, headers: Mutation, body: json(z.object({ mode: z.enum(['prepaid', 'invoiced', 'exempt']), reason: Reason, ticketRef: z.string().trim().min(1).max(200).optional() }).strict()) },
    responses: { 200: response(Done), ...errors } }), async c => {
    const wid = c.req.valid('param').wid, body = c.req.valid('json');
    return c.json(await moneyChange(c, wid, body, 'billing-mode', async (tx, before) => {
      await tx.execute(sql`UPDATE billing_accounts SET mode=${body.mode},updated_at=now() WHERE workspace_id=${wid}`);
      return before;
    }), 200);
  });

  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'post', path: '/v1/operator/billing/{wid}/refunds', operationId: 'operatorRefundTopUp',
    request: { params: WorkspaceParam, headers: Mutation, body: json(z.object({ attemptId: z.string().min(1).max(100), amountCents: z.number().int().min(1).max(1_000_000).optional(), reason: Reason,
      ticketRef: z.string().trim().min(1).max(200).optional() }).strict()) }, responses: { 200: response(z.object({ refundId: z.string(), status: z.string() })), ...errors } }), async c => {
    const operator = await operatorActor(c, 'operator'), wid = c.req.valid('param').wid, body = c.req.valid('json'), key = c.req.header('Idempotency-Key');
    await existingWorkspace(c.env.db, wid);
    if (key) {
      const { rows: [prior] } = await c.env.db.execute<{ response: { refundId: string; status: string } }>(sql`SELECT response FROM operator_idempotency WHERE operator_id=${operator.userId} AND key=${key}`);
      if (prior) return c.json(prior.response, 200);
    }
    const before = await accountOf(c.env.db, wid);
    const refund = await refundTopUp(c.env, { workspaceId: wid, attemptId: body.attemptId, amountCents: body.amountCents, reason: body.reason, operator: `operator:${operator.userId}` });
    return c.json(await mutate(c, operator, wid, body, async tx => ({ result: refund,
      audit: { action: 'billing-refund', before, after: { ...(await accountOf(tx, wid)), refund }, reason: body.reason, ticketRef: body.ticketRef } })), 200);
  });
}

