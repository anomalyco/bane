// Stripe as Nightmail's payment rail: Checkout top-ups, saved cards, invoice-backed off-session charges and refunds.
// A thin fetch client (no SDK) keeps the Worker bundle small and lets tests point STRIPE_API_BASE at a fake.
//
// The rules every function here follows (billing-build-spec §1):
// - Never call Stripe inside a database transaction. Write the attempt, commit, call Stripe with an idempotency key
//   derived from the attempt, then record the answer with a guarded UPDATE ... WHERE status IN (...).
// - Credit reaches the ledger only through billing_post(..., 'topup', 'attempt:<id>', ...), so the webhook, the inline
//   charge and reconciliation can all try to credit one payment and only the first applies.
// - Lock order for money: billing_accounts, then billing_payment_attempts / billing_refunds, then billing_ledger.
import { createHash } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { ApiError, id, log, notFound, type Database, type DbExecutor, type Runtime } from '../core.js';
import { UC_PER_CENT } from './money.js';
import type { AutoRechargeSettings, PaymentView } from './types.js';
import { productName } from '../brand.js';

/** The Stripe API version Nightmail is written against. Create the webhook endpoint with the same version. */
export const STRIPE_API_VERSION = '2026-10-28.endive';
export type StripeConfig = { secretKey: string; webhookSecret: string; automaticTax: boolean; apiBase: string };
type Params = { [key: string]: unknown };
// Stripe objects are untyped JSON at this edge; each reader picks the fields it needs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type StripeObject = Record<string, any>;

export class StripeError extends Error {
  constructor(readonly status: number, readonly type: string, readonly code?: string, readonly declineCode?: string, readonly paymentIntent?: string, message = 'Stripe refused the request.', readonly param?: string) {
    super(message); this.name = 'StripeError';
  }
  /** No answer, or one Stripe asks us to retry: the request may or may not have taken effect. */
  get uncertain() { return this.status === 0 || this.status === 429 || this.status >= 500; }
  get missing() { return this.code === 'resource_missing'; }
  /** The code Nightmail records and shows: the bank's decline reason when there is one. */
  get reason() { return this.declineCode ?? this.code ?? this.type; }
}
/**
 * What a log line may say about a Stripe error: its status, type, codes, the parameter it names and Stripe's message,
 * so a refusal is diagnosable from the Worker's logs. The message is Stripe's text; anything in it that looks like a
 * key, a webhook secret or an email address is replaced first. Keys never reach a log.
 */
export function stripeErrorFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof StripeError)) return { reason: error instanceof Error ? error.name : 'error' };
  const message = error.message.replace(/\b(?:sk|rk|pk)_(?:test|live)_[A-Za-z0-9_*.]+/g, '[key]').replace(/\bwhsec_[A-Za-z0-9_*.]+/g, '[secret]')
    .replace(/[^\s@'"`<>()]+@[^\s@'"`<>()]+\.[A-Za-z]{2,}/g, '[email]');
  return { status: error.status, type: error.type, reason: error.reason, stripeCode: error.code ?? null, declineCode: error.declineCode ?? null, param: error.param ?? null, message };
}

export const stripeLive = (cfg: Pick<StripeConfig, 'secretKey'>) => /^(?:sk|rk)_live_/.test(cfg.secretKey);
const stripeEnv = (cfg: StripeConfig) => stripeLive(cfg) ? 'prod' : 'dev';
const metadata = (cfg: StripeConfig, workspaceId: string, extra: Record<string, string> = {}) => ({ bane_workspace: workspaceId, bane_env: stripeEnv(cfg), ...extra });

/** Stripe's form encoding: nested objects and arrays as bracketed keys. */
function encode(params: Params, prefix = '', out = new URLSearchParams()) {
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const key = prefix ? `${prefix}[${name}]` : name;
    if (Array.isArray(value)) value.forEach((item, i) => item !== null && typeof item === 'object' ? encode(item as Params, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(item)));
    else if (typeof value === 'object') encode(value as Params, key, out);
    else out.append(key, String(value));
  }
  return out;
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** One Stripe call. Network errors, 429 and 5xx are retried twice with jitter and the same idempotency key. */
export async function stripeRequest<T extends StripeObject = StripeObject>(cfg: StripeConfig, method: 'GET' | 'POST' | 'DELETE', path: string, params: Params = {}, idempotencyKey?: string): Promise<T> {
  const body = encode(params).toString();
  const url = `${cfg.apiBase.replace(/\/+$/, '')}${path}${method !== 'POST' && body ? `?${body}` : ''}`;
  const headers: Record<string, string> = { authorization: `Bearer ${cfg.secretKey}`, 'stripe-version': STRIPE_API_VERSION };
  if (method === 'POST') { headers['content-type'] = 'application/x-www-form-urlencoded'; if (idempotencyKey) headers['idempotency-key'] = idempotencyKey; }
  let last: StripeError | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await pause(200 * attempt + Math.random() * 200);
    let response: Response;
    try { response = await fetch(url, { method, headers, body: method === 'POST' ? body : undefined, signal: AbortSignal.timeout(20_000) }); }
    catch { last = new StripeError(0, 'network', undefined, undefined, undefined, 'Stripe did not answer.'); continue; }
    let json: StripeObject | null = null;
    try { json = await response.json() as StripeObject; } catch { /* An error page: classified by status below. */ }
    if (response.ok && json && typeof json === 'object') return json as T;
    const e = (json?.error ?? {}) as StripeObject;
    const pi = typeof e.payment_intent === 'string' ? e.payment_intent : typeof e.payment_intent?.id === 'string' ? e.payment_intent.id : undefined;
    last = new StripeError(response.ok ? 502 : response.status, typeof e.type === 'string' ? e.type : 'api_error', typeof e.code === 'string' ? e.code : undefined,
      typeof e.decline_code === 'string' ? e.decline_code : undefined, pi, typeof e.message === 'string' ? e.message.slice(0, 500) : 'Stripe refused the request.',
      typeof e.param === 'string' ? e.param.slice(0, 200) : undefined);
    if (!last.uncertain) throw last;
  }
  throw last!;
}

/** Hosted only (404 when self-hosted); 503 BILLING_NOT_CONFIGURED without the Stripe keys. */
export function stripeConfig(runtime: Runtime): StripeConfig {
  if (!runtime.config.multiTenant) notFound('Endpoint');
  const cfg = runtime.config.billing?.stripe;
  if (!cfg) throw new ApiError(503, 'BILLING_NOT_CONFIGURED', 'Payments are not configured on this installation.');
  return cfg;
}

// ---------- attempts ----------
export type AttemptRow = {
  id: string; workspace_id: string; kind: 'checkout' | 'saved_card' | 'recharge' | 'setup'; status: string; amount_uc: string;
  charged_cents: number | null; tax_cents: number | null; idempotency_key: string; stripe_checkout_session: string | null; stripe_payment_intent: string | null;
  stripe_invoice: string | null; stripe_charge: string | null; checkout_url: string | null; expires_at: string | null; invoice_url: string | null; invoice_pdf: string | null;
  receipt_url: string | null; card_brand: string | null; card_last4: string | null; card_fingerprint: string | null; failure_code: string | null; failure_message: string | null;
  refunded_uc: string; created_by: string; created_at: string; updated_at: string; settled_at: string | null; age_s: number;
};
export const OPEN = ['created', 'pending', 'requires_action'];
const open = sql`('created','pending','requires_action')`;
const rows = async <T>(db: Pick<DbExecutor, 'execute'>, query: SQL) => (await db.execute<T & Record<string, unknown>>(query)).rows as T[];
export const readAttempt = async (db: Pick<DbExecutor, 'execute'>, attemptId: string) =>
  (await rows<AttemptRow>(db, sql`SELECT *, extract(epoch FROM now()-created_at)::int AS age_s FROM billing_payment_attempts WHERE id=${attemptId}`))[0];
const cents = (uc: string | bigint) => Number(BigInt(uc) / UC_PER_CENT);
const oneLine = (value: string, max: number) => value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Takes the workspace's account row lock in a statement of its own (creating the row when asked). Read what the
 * decision depends on in the NEXT statement: under READ COMMITTED a statement that waited for the row lock re-reads that
 * row's columns, but its subqueries and functions (billing_position, attempt counts) keep the snapshot from before the
 * wait, so a credit or attempt committed meanwhile would be missed (review finding 1: a second auto-recharge charge).
 */
export async function lockAccount(tx: Pick<DbExecutor, 'execute'>, workspaceId: string, create = true): Promise<boolean> {
  if (create) await tx.execute(sql`INSERT INTO billing_accounts(workspace_id) VALUES (${workspaceId}) ON CONFLICT DO NOTHING`);
  return (await tx.execute(sql`SELECT 1 FROM billing_accounts WHERE workspace_id=${workspaceId} FOR UPDATE`)).rows.length > 0;
}

/** Locks the account, then the attempt (the money lock order). Returns undefined when the attempt does not exist. */
async function lockAttempt(tx: DbExecutor, attemptId: string) {
  const [owner] = await rows<{ workspace_id: string }>(tx, sql`SELECT workspace_id FROM billing_payment_attempts WHERE id=${attemptId}`);
  if (!owner) return undefined;
  await tx.execute(sql`INSERT INTO billing_accounts(workspace_id) VALUES (${owner.workspace_id}) ON CONFLICT DO NOTHING`);
  const [account] = await rows<{ card_last4: string | null; recharge_pending_attempt: string | null }>(tx, sql`SELECT card_last4, recharge_pending_attempt FROM billing_accounts WHERE workspace_id=${owner.workspace_id} FOR UPDATE`);
  const [attempt] = await rows<AttemptRow>(tx, sql`SELECT *, extract(epoch FROM now()-created_at)::int AS age_s FROM billing_payment_attempts WHERE id=${attemptId} FOR UPDATE`);
  return { attempt: attempt!, account: account! };
}

/** What Stripe says was paid for an attempt. creditCents excludes tax and must equal the attempt's amount. */
export type PaidFacts = { creditCents: number; chargedCents?: number | null; taxCents?: number | null; paymentIntent?: string | null; charge?: string | null; invoice?: string | null; invoiceUrl?: string | null; invoicePdf?: string | null; receiptUrl?: string | null };

/**
 * Credits a paid attempt exactly once: pending → succeeded and the 'topup' ledger row commit together. Shared by the
 * webhook, the inline off-session charge and reconciliation. A terminal attempt absorbs the call. Returns its status.
 */
export async function creditAttempt(runtime: Runtime, attemptId: string, paid: PaidFacts): Promise<string> {
  return runtime.db.transaction(async tx => {
    const locked = await lockAttempt(tx, attemptId);
    if (!locked) return 'missing';
    const { attempt: a } = locked;
    if (!OPEN.includes(a.status)) {
      if (a.status !== 'succeeded') log('error', { code: 'BILLING_LATE_PAYMENT', workspaceId: a.workspace_id, attemptId, status: a.status, message: 'Stripe reports a payment for a closed attempt; credit or refund it by hand.' });
      // Checkout creates its invoice after the payment: checkout.session.completed credits with no invoice, and
      // invoice.paid arrives later. Record the invoice then (never replacing one), so the payment has its links and a
      // refund goes through a credit note. Nothing about the credit changes.
      else if (paid.invoice) await tx.execute(sql`UPDATE billing_payment_attempts SET stripe_invoice=${paid.invoice}, invoice_url=coalesce(invoice_url,${paid.invoiceUrl ?? null}),
        invoice_pdf=coalesce(invoice_pdf,${paid.invoicePdf ?? null}), updated_at=now() WHERE id=${attemptId} AND status='succeeded' AND stripe_invoice IS NULL`);
      return a.status;
    }
    const facts = sql`charged_cents=coalesce(${paid.chargedCents ?? null}::int,charged_cents), tax_cents=coalesce(${paid.taxCents ?? null}::int,tax_cents),
      stripe_payment_intent=coalesce(stripe_payment_intent,${paid.paymentIntent ?? null}), stripe_charge=coalesce(${paid.charge ?? null},stripe_charge),
      stripe_invoice=coalesce(stripe_invoice,${paid.invoice ?? null}), invoice_url=coalesce(${paid.invoiceUrl ?? null},invoice_url),
      invoice_pdf=coalesce(${paid.invoicePdf ?? null},invoice_pdf), receipt_url=coalesce(${paid.receiptUrl ?? null},receipt_url), settled_at=now(), updated_at=now()`;
    // Compare excluding tax (Console #3695): the credit is what the customer bought, tax is on top.
    if (!Number.isSafeInteger(paid.creditCents) || BigInt(paid.creditCents) * UC_PER_CENT !== BigInt(a.amount_uc)) {
      await tx.execute(sql`UPDATE billing_payment_attempts SET status='failed', failure_code='amount_mismatch', failure_message='Stripe charged a different amount than this top-up.', ${facts}
        WHERE id=${attemptId} AND status IN ${open}`);
      if (a.kind === 'recharge') await tx.execute(sql`UPDATE billing_accounts SET recharge_pending_attempt=NULL, updated_at=now() WHERE workspace_id=${a.workspace_id} AND recharge_pending_attempt=${attemptId}`);
      log('error', { code: 'BILLING_AMOUNT_MISMATCH', workspaceId: a.workspace_id, attemptId, expectedCents: cents(a.amount_uc), paidCents: paid.creditCents });
      return 'failed';
    }
    await tx.execute(sql`UPDATE billing_payment_attempts SET status='succeeded', failure_code=NULL, failure_message=NULL, ${facts} WHERE id=${attemptId} AND status IN ${open}`);
    const detail = { attemptId, kind: a.kind, invoice: paid.invoice ?? a.stripe_invoice, chargedCents: paid.chargedCents ?? null, taxCents: paid.taxCents ?? null, ...(a.kind === 'recharge' ? { recharge: true } : {}) };
    await tx.execute(sql`SELECT billing_post(${a.workspace_id}, 'topup', ${'attempt:' + attemptId}, ${a.amount_uc}::bigint, 0::bigint, ${JSON.stringify(detail)}::jsonb, 'stripe')`);
    if (a.kind === 'recharge') await tx.execute(sql`UPDATE billing_accounts SET recharge_pending_attempt=NULL, updated_at=now() WHERE workspace_id=${a.workspace_id} AND recharge_pending_attempt=${attemptId}`);
    return 'succeeded';
  });
}

/**
 * Closes an open attempt without credit. A failed recharge ends auto-recharge until the owner turns it back on, and
 * queues exactly one recharge_failed notice (keyed by the attempt). `disable: false` is for failures that are not the
 * card's (a lost or abandoned charge); those only clear the pending recharge.
 */
export async function failAttempt(runtime: Runtime, attemptId: string, code: string, message: string | null, status: 'failed' | 'canceled' | 'expired' = 'failed', disable = status === 'failed'): Promise<string> {
  return runtime.db.transaction(async tx => {
    const locked = await lockAttempt(tx, attemptId);
    if (!locked) return 'missing';
    const { attempt: a, account } = locked;
    if (!OPEN.includes(a.status)) return a.status;
    await tx.execute(sql`UPDATE billing_payment_attempts SET status=${status}, failure_code=${code.slice(0, 100)}, failure_message=${message?.slice(0, 300) ?? null}, settled_at=now(), updated_at=now()
      WHERE id=${attemptId} AND status IN ${open}`);
    if (a.kind !== 'recharge') return status;
    if (!disable) {
      await tx.execute(sql`UPDATE billing_accounts SET recharge_pending_attempt=NULL, updated_at=now() WHERE workspace_id=${a.workspace_id} AND recharge_pending_attempt=${attemptId}`);
      return status;
    }
    await tx.execute(sql`UPDATE billing_accounts SET recharge_pending_attempt=CASE WHEN recharge_pending_attempt=${attemptId} THEN NULL ELSE recharge_pending_attempt END,
      recharge_enabled=false, recharge_disabled_reason=${code.slice(0, 100)}, recharge_disabled_at=now(), updated_at=now() WHERE workspace_id=${a.workspace_id}`);
    const data = { attemptId, code, message: message?.slice(0, 300) ?? null, last4: a.card_last4 ?? account.card_last4 };
    await tx.execute(sql`SELECT billing_notice(${a.workspace_id}, 'recharge_failed', ${'recharge_failed:' + attemptId}, ${JSON.stringify(data)}::jsonb)`);
    log('warn', { code: 'BILLING_RECHARGE_FAILED', workspaceId: a.workspace_id, attemptId, reason: code });
    return status;
  });
}

// ---------- customers and cards ----------
/** The workspace's Stripe customer, created on first use (never inside the signup transaction). */
export async function ensureCustomer(runtime: Runtime, workspaceId: string, billingEmail?: string | null): Promise<string> {
  const cfg = stripeConfig(runtime);
  const [row] = await rows<{ customer: string | null; name: string | null }>(runtime.db, sql`SELECT (SELECT stripe_customer FROM billing_accounts WHERE workspace_id=${workspaceId}) AS customer,
    (SELECT name FROM workspaces WHERE id=${workspaceId}) AS name`);
  if (row?.customer) return row.customer;
  const params = { name: oneLine(row?.name || workspaceId, 100), ...(billingEmail ? { email: billingEmail } : {}), metadata: metadata(cfg, workspaceId) };
  // Keyed by the workspace and the exact parameters, so a rename or another admin within Stripe's 24 h key window
  // creates a customer instead of failing on a reused key; only the first one stored is ever used.
  const key = `customer:${workspaceId}:${createHash('sha256').update(JSON.stringify(params)).digest('hex').slice(0, 16)}`;
  const customer = await stripeRequest(cfg, 'POST', '/v1/customers', params, key);
  const [stored] = await rows<{ stripe_customer: string }>(runtime.db, sql`INSERT INTO billing_accounts(workspace_id, stripe_customer) VALUES (${workspaceId}, ${customer.id})
    ON CONFLICT (workspace_id) DO UPDATE SET stripe_customer=excluded.stripe_customer, updated_at=now() WHERE billing_accounts.stripe_customer IS NULL RETURNING stripe_customer`);
  if (stored) return stored.stripe_customer;
  const [current] = await rows<{ stripe_customer: string }>(runtime.db, sql`SELECT stripe_customer FROM billing_accounts WHERE workspace_id=${workspaceId}`);
  return current!.stripe_customer;
}

type Card = { id: string; brand: string | null; last4: string | null; expMonth: number | null; expYear: number | null; fingerprint: string | null };
const cardOf = (pm: StripeObject | null | undefined): Card | null => !pm || typeof pm !== 'object' || typeof pm.id !== 'string' ? null : {
  id: pm.id, brand: pm.card?.brand ?? pm.type ?? null, last4: pm.card?.last4 ?? null, expMonth: pm.card?.exp_month ?? null, expYear: pm.card?.exp_year ?? null, fingerprint: pm.card?.fingerprint ?? null,
};

/**
 * After a paid Checkout or a completed card setup: read the card Stripe saved (outside any transaction), store it on the
 * attempt and, unless its fingerprint is blocked, as the workspace's card for saved-card top-ups and auto-recharge.
 * A setup attempt succeeds here. Idempotent: a webhook redelivery or reconciliation repeats it harmlessly.
 */
export async function saveCard(runtime: Runtime, attemptId: string, source: { paymentIntent?: string | null; setupIntent?: string | null; invoice?: string | null }) {
  const cfg = stripeConfig(runtime);
  const before = await readAttempt(runtime.db, attemptId);
  // Already recorded (a redelivery): never let an old event replace a card saved since.
  if (!before || before.card_brand !== null && !OPEN.includes(before.status)) return;
  const intent = source.setupIntent ? await stripeRequest(cfg, 'GET', `/v1/setup_intents/${encodeURIComponent(source.setupIntent)}`, { expand: ['payment_method'] })
    : source.paymentIntent ? await stripeRequest(cfg, 'GET', `/v1/payment_intents/${encodeURIComponent(source.paymentIntent)}`, { expand: ['payment_method', 'latest_charge'] }) : null;
  const invoice = source.invoice ? await stripeRequest(cfg, 'GET', `/v1/invoices/${encodeURIComponent(source.invoice)}`) : null;
  const card = cardOf(intent?.payment_method);
  const charge = intent?.latest_charge && typeof intent.latest_charge === 'object' ? intent.latest_charge : null;
  const outcome = await runtime.db.transaction(async tx => {
    const locked = await lockAttempt(tx, attemptId);
    if (!locked) return null;
    const { attempt: a } = locked;
    const [{ blocked } = { blocked: false }] = card?.fingerprint ? await rows<{ blocked: boolean }>(tx, sql`SELECT EXISTS (SELECT FROM billing_blocked_cards WHERE fingerprint=${card.fingerprint}) AS blocked`) : [];
    await tx.execute(sql`UPDATE billing_payment_attempts SET card_brand=coalesce(${card?.brand ?? null},card_brand), card_last4=coalesce(${card?.last4 ?? null},card_last4),
      card_fingerprint=coalesce(${card?.fingerprint ?? null},card_fingerprint), receipt_url=coalesce(${charge?.receipt_url ?? null},receipt_url), stripe_charge=coalesce(stripe_charge,${charge?.id ?? null}),
      stripe_invoice=coalesce(stripe_invoice,${invoice?.id ?? null}), invoice_url=coalesce(${invoice?.hosted_invoice_url ?? null},invoice_url), invoice_pdf=coalesce(${invoice?.invoice_pdf ?? null},invoice_pdf), updated_at=now()
      WHERE id=${attemptId}`);
    if (a.kind === 'setup' && OPEN.includes(a.status)) {
      if (!card || blocked) await tx.execute(sql`UPDATE billing_payment_attempts SET status='failed', failure_code=${blocked ? 'card_blocked' : 'card_missing'}, settled_at=now() WHERE id=${attemptId} AND status IN ${open}`);
      else await tx.execute(sql`UPDATE billing_payment_attempts SET status='succeeded', settled_at=now() WHERE id=${attemptId} AND status IN ${open}`);
    }
    // Only a payment that went through (or a completed setup) may become the saved card.
    const usable = card && !blocked && (a.kind === 'setup' ? OPEN.includes(a.status) || a.status === 'succeeded' : a.status === 'succeeded');
    if (!usable) return null;
    const [account] = await rows<{ stripe_customer: string | null; changed: boolean }>(tx, sql`UPDATE billing_accounts SET stripe_payment_method=${card.id}, card_brand=${card.brand}, card_last4=${card.last4},
      card_exp_month=${card.expMonth}, card_exp_year=${card.expYear}, card_fingerprint=${card.fingerprint}, updated_at=now()
      WHERE workspace_id=${a.workspace_id} RETURNING stripe_customer, true AS changed`);
    return account?.stripe_customer ? { customer: account.stripe_customer, pm: card.id } : null;
  });
  // Stripe's default card for the customer follows Nightmail's, so invoices fall back to the card Nightmail shows.
  if (outcome) await stripeRequest(cfg, 'POST', `/v1/customers/${encodeURIComponent(outcome.customer)}`, { invoice_settings: { default_payment_method: outcome.pm } }, `default:${outcome.customer}:${outcome.pm}`);
}

/** Detaches the saved card in Stripe and forgets it; auto-recharge turns off with it. */
export async function removePaymentMethod(runtime: Runtime, workspaceId: string): Promise<void> {
  const cfg = stripeConfig(runtime);
  const [account] = await rows<{ stripe_payment_method: string | null }>(runtime.db, sql`SELECT stripe_payment_method FROM billing_accounts WHERE workspace_id=${workspaceId}`);
  const pm = account?.stripe_payment_method;
  if (!pm) return;
  try { await stripeRequest(cfg, 'POST', `/v1/payment_methods/${encodeURIComponent(pm)}/detach`, {}, `detach:${pm}`); }
  catch (error) { if (!(error instanceof StripeError) || error.uncertain || !(error.missing || error.code === 'payment_method_unexpected_state')) throw providerError(error, { operation: 'detach', workspaceId }); }
  await forgetCard(runtime.db, workspaceId, pm);
}
/** Forgets a saved card (and turns auto-recharge off) wherever it is saved, or only in one workspace. */
export const forgetCard = (db: Pick<DbExecutor, 'execute'>, workspaceId: string | null, pm: string) => db.execute(sql`UPDATE billing_accounts SET stripe_payment_method=NULL, card_brand=NULL, card_last4=NULL,
  card_exp_month=NULL, card_exp_year=NULL, card_fingerprint=NULL, recharge_enabled=false, updated_at=now()
  WHERE stripe_payment_method=${pm} ${workspaceId === null ? sql`` : sql`AND workspace_id=${workspaceId}`}`);

/** Saves auto-recharge settings. Enabling needs a usable saved card and clears the reason it was last turned off. */
export async function setAutoRecharge(runtime: Runtime, workspaceId: string, settings: AutoRechargeSettings): Promise<void> {
  stripeConfig(runtime);
  const { enabled, thresholdCents, amountCents, monthlyCapCents } = settings;
  const whole = (v: number, min: number, max: number) => Number.isInteger(v) && v >= min && v <= max;
  if (!whole(thresholdCents, 500, 100_000) || !whole(amountCents, 2000, 100_000) || !whole(monthlyCapCents, amountCents, 1_000_000))
    throw new ApiError(422, 'TOP_UP_AMOUNT_INVALID', 'Use a threshold of $5–$1,000, an amount of $20–$1,000 and a monthly limit of at least the amount, up to $10,000.');
  await runtime.db.transaction(async tx => {
    await lockAccount(tx, workspaceId);
    const [a] = await rows<{ stripe_payment_method: string | null; blocked: boolean }>(tx, sql`SELECT stripe_payment_method,
      EXISTS (SELECT FROM billing_blocked_cards b WHERE b.fingerprint=a.card_fingerprint) AS blocked FROM billing_accounts a WHERE workspace_id=${workspaceId}`);
    if (enabled && (!a?.stripe_payment_method || a.blocked)) throw new ApiError(409, 'PAYMENT_METHOD_REQUIRED', 'Save a card in Settings → Billing before turning on auto-recharge.');
    await tx.execute(sql`UPDATE billing_accounts SET recharge_enabled=${enabled}, recharge_threshold_uc=${BigInt(thresholdCents) * UC_PER_CENT}, recharge_amount_uc=${BigInt(amountCents) * UC_PER_CENT},
      recharge_month_cap_uc=${BigInt(monthlyCapCents) * UC_PER_CENT},
      recharge_disabled_reason=CASE WHEN ${enabled} THEN NULL ELSE recharge_disabled_reason END, recharge_disabled_at=CASE WHEN ${enabled} THEN NULL ELSE recharge_disabled_at END, updated_at=now()
      WHERE workspace_id=${workspaceId}`);
  });
}

// ---------- top-ups ----------
const MIN_CENTS = 2000, MAX_CENTS = 1_000_000, FIRST_MAX_CENTS = 50_000;
function providerError(error: unknown, context: Record<string, unknown> = {}): unknown {
  if (!(error instanceof StripeError)) return error;
  log('warn', { code: 'BILLING_STRIPE_ERROR', ...context, ...stripeErrorFields(error) });
  return error.uncertain ? new ApiError(503, 'BILLING_PROVIDER_UNAVAILABLE', 'Stripe did not answer. Try again in a minute.', undefined, true)
    : new ApiError(502, 'BILLING_PROVIDER_ERROR', 'Stripe refused the request. Try again or contact support.');
}

/**
 * A new attempt in state created; false when none was written. Off-session charges record the saved card they will use
 * (disputes block it). A recharge is written only while no other recharge for the workspace is open: one charge at a time.
 */
export const insertAttempt = async (tx: Pick<DbExecutor, 'execute'>, attemptId: string, workspaceId: string, kind: AttemptRow['kind'], amountUc: bigint, actor: string) => (await tx.execute(sql`
  INSERT INTO billing_payment_attempts(id,workspace_id,kind,status,amount_uc,idempotency_key,created_by,card_brand,card_last4,card_fingerprint)
  SELECT ${attemptId},${workspaceId},${kind},'created',${amountUc},${'attempt:' + attemptId},${actor},
    CASE WHEN ${kind} IN ('saved_card','recharge') THEN b.card_brand END, CASE WHEN ${kind} IN ('saved_card','recharge') THEN b.card_last4 END,
    CASE WHEN ${kind} IN ('saved_card','recharge') THEN b.card_fingerprint END
  FROM (SELECT 1) one LEFT JOIN billing_accounts b ON b.workspace_id=${workspaceId}
  WHERE ${kind}<>'recharge' OR NOT EXISTS (SELECT FROM billing_payment_attempts p WHERE p.workspace_id=${workspaceId} AND p.kind='recharge' AND p.status IN ${open})
  RETURNING id`)).rows.length > 0;

/** Validates a person's top-up and writes its attempt (state created). Serialized per workspace by the account lock. */
async function openAttempt(runtime: Runtime, input: { workspaceId: string; kind: 'checkout' | 'saved_card' | 'setup'; amountCents: number; actor: string }) {
  const { workspaceId, kind, amountCents } = input;
  if (kind !== 'setup' && (!Number.isInteger(amountCents) || amountCents < MIN_CENTS || amountCents > MAX_CENTS))
    throw new ApiError(422, 'TOP_UP_AMOUNT_INVALID', 'Add between $20 and $10,000 at a time.', 'amountCents');
  return runtime.db.transaction(async tx => {
    // Counted after the lock, in a fresh statement, so concurrent requests can't all count the same five (finding 7).
    await lockAccount(tx, workspaceId);
    const [a] = await rows<{ mode: string; stripe_payment_method: string | null; hour: number; failed: number; funded: boolean; blocked: boolean }>(tx, sql`SELECT mode, stripe_payment_method,
      (SELECT count(*) FROM billing_payment_attempts p WHERE p.workspace_id=a.workspace_id AND p.kind<>'recharge' AND p.created_at>now()-interval '1 hour')::int AS hour,
      (SELECT count(*) FROM billing_payment_attempts p WHERE p.workspace_id=a.workspace_id AND p.kind<>'recharge' AND p.status='failed' AND p.created_at>now()-interval '1 day')::int AS failed,
      EXISTS (SELECT FROM billing_payment_attempts p WHERE p.workspace_id=a.workspace_id AND p.status='succeeded' AND p.amount_uc>0) AS funded,
      EXISTS (SELECT FROM billing_blocked_cards b WHERE b.fingerprint=a.card_fingerprint) AS blocked
      FROM billing_accounts a WHERE workspace_id=${workspaceId}`);
    if (a!.hour >= 5 || a!.failed >= 3) throw new ApiError(429, 'TOP_UP_RATE_LIMITED', 'Too many payment attempts for this workspace. Try again later.', undefined, true);
    if (kind !== 'setup' && !a!.funded && amountCents > FIRST_MAX_CENTS) throw new ApiError(409, 'FIRST_TOP_UP_LIMIT', 'The first top-up is limited to $500. Larger top-ups work after it succeeds.', 'amountCents');
    if (kind === 'saved_card' && (!a!.stripe_payment_method || a!.blocked)) throw new ApiError(409, 'PAYMENT_METHOD_REQUIRED', 'Save a card in Settings → Billing first, or pay with Stripe Checkout.');
    const attemptId = id('bpa');
    await insertAttempt(tx, attemptId, workspaceId, kind, kind === 'setup' ? 0n : BigInt(amountCents) * UC_PER_CENT, input.actor); // never a recharge: always written
    return attemptId;
  });
}

/** A create Stripe refused (4xx) fails the attempt; an unanswered one stays created for reconciliation. */
async function createRefused(runtime: Runtime, attemptId: string, error: unknown): Promise<unknown> {
  if (error instanceof StripeError && !error.uncertain) await runtime.db.execute(sql`UPDATE billing_payment_attempts SET status='failed', failure_code=${error.reason.slice(0, 100)},
    failure_message=${error.message}, settled_at=now(), updated_at=now() WHERE id=${attemptId} AND status='created'`);
  return providerError(error, { operation: 'checkout', attemptId });
}

/**
 * Cards only, for paying and for saving. API 2026-09-30.endive removed `payment_method_types` from Checkout (a 400);
 * `allowed_payment_method_types` limits the dashboard's dynamic payment methods instead. Cards because auto-recharge
 * charges the saved method off-session and settles synchronously, and a card has the fingerprint a dispute blocks.
 */
const CARD_ONLY = ['card'];
async function startCheckout(runtime: Runtime, attemptId: string, input: { workspaceId: string; amountCents: number; billingEmail: string | null; setup: boolean }) {
  const cfg = stripeConfig(runtime);
  try {
    const customer = await ensureCustomer(runtime, input.workspaceId, input.billingEmail);
    const meta = metadata(cfg, input.workspaceId, { bane_attempt: attemptId });
    const expiresAt = Math.floor(Date.now() / 1000) + 23 * 3600;
    const back = { success_url: `${runtime.config.publicUrl}/settings?billing=success&attempt=${attemptId}#billing`, cancel_url: `${runtime.config.publicUrl}/settings?billing=canceled#billing`, expires_at: expiresAt };
    const params: Params = input.setup
      ? { mode: 'setup', currency: 'usd', customer, client_reference_id: attemptId, allowed_payment_method_types: CARD_ONLY, metadata: meta, setup_intent_data: { metadata: meta }, ...back }
      : { mode: 'payment', customer, client_reference_id: attemptId,
        line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: input.amountCents, tax_behavior: 'exclusive', product_data: { name: `${productName} credit` } } }],
        allowed_payment_method_types: CARD_ONLY, payment_intent_data: { setup_future_usage: 'off_session', metadata: meta }, metadata: meta,
        invoice_creation: { enabled: true, invoice_data: { metadata: meta } },
        custom_text: { submit: { message: `${productName} saves this card so auto-recharge can use it if you turn it on. Remove it any time in Settings → Billing.` } },
        ...(cfg.automaticTax ? { automatic_tax: { enabled: true }, customer_update: { address: 'auto', name: 'auto' }, tax_id_collection: { enabled: true }, billing_address_collection: 'required' } : {}),
        ...back };
    const session = await stripeRequest(cfg, 'POST', '/v1/checkout/sessions', params, `attempt:${attemptId}:checkout`);
    const expires = typeof session.expires_at === 'number' ? session.expires_at : expiresAt;
    await runtime.db.execute(sql`UPDATE billing_payment_attempts SET status='pending', stripe_checkout_session=${session.id}, checkout_url=${session.url}, expires_at=to_timestamp(${expires}), updated_at=now()
      WHERE id=${attemptId} AND status='created'`);
    return { attemptId, url: String(session.url), expiresAt: new Date(expires * 1000).toISOString() };
  } catch (error) { throw await createRefused(runtime, attemptId, error); }
}

/** A Stripe Checkout page for a top-up. Credit is applied only when Stripe reports the payment (webhook or reconciliation). */
export async function createCheckoutTopUp(runtime: Runtime, input: { workspaceId: string; amountCents: number; actor: string; billingEmail: string | null }): Promise<{ attemptId: string; url: string; expiresAt: string }> {
  stripeConfig(runtime);
  const attemptId = await openAttempt(runtime, { ...input, kind: 'checkout' });
  return startCheckout(runtime, attemptId, { ...input, setup: false });
}

/** A Stripe Checkout page in setup mode that saves (or replaces) the workspace's card. No credit. */
export async function createCardSetup(runtime: Runtime, input: { workspaceId: string; actor: string; billingEmail: string | null }): Promise<{ attemptId: string; url: string; expiresAt: string }> {
  stripeConfig(runtime);
  const attemptId = await openAttempt(runtime, { ...input, kind: 'setup', amountCents: 0 });
  return startCheckout(runtime, attemptId, { ...input, amountCents: 0, setup: true });
}

/** Charges the saved card now (dashboard only). The answer is the attempt's status after the inline charge. */
export async function chargeSavedCardTopUp(runtime: Runtime, input: { workspaceId: string; amountCents: number; actor: string }): Promise<{ attemptId: string; status: PaymentView['status'] }> {
  stripeConfig(runtime);
  const attemptId = await openAttempt(runtime, { ...input, kind: 'saved_card' });
  await chargeSavedCard(runtime, attemptId);
  return { attemptId, status: ((await readAttempt(runtime.db, attemptId))?.status ?? 'pending') as PaymentView['status'] };
}

/** The PaymentIntent an invoice was paid with, in either invoice shape (payment_intent before 2025-03, payments after). */
export function invoicePaymentIntent(invoice: StripeObject): string | null {
  const direct = invoice.payment_intent;
  if (typeof direct === 'string') return direct;
  if (direct && typeof direct.id === 'string') return direct.id;
  const payments: StripeObject[] = Array.isArray(invoice.payments?.data) ? invoice.payments.data : [];
  const pi = (payments.find(p => p.status === 'paid') ?? payments[0])?.payment?.payment_intent;
  return typeof pi === 'string' ? pi : typeof pi?.id === 'string' ? pi.id : null;
}
/** Records what an invoice says about its attempt: credit when paid. Returns the attempt's status. */
export async function settleInvoice(runtime: Runtime, attemptId: string, invoice: StripeObject): Promise<string> {
  if (invoice.status !== 'paid') return (await readAttempt(runtime.db, attemptId))?.status ?? 'missing';
  const total = Number(invoice.total ?? invoice.amount_paid ?? 0), excluding = Number(invoice.total_excluding_tax ?? invoice.subtotal_excluding_tax ?? invoice.subtotal ?? total);
  return creditAttempt(runtime, attemptId, { creditCents: excluding, chargedCents: Number(invoice.amount_paid ?? total), taxCents: total - excluding, invoice: invoice.id,
    invoiceUrl: invoice.hosted_invoice_url ?? null, invoicePdf: invoice.invoice_pdf ?? null, paymentIntent: invoicePaymentIntent(invoice) });
}

/**
 * The off-session charge behind saved-card top-ups and auto-recharge, always invoice-first so tax and receipts match
 * Checkout: create a draft invoice, add the credit line, finalize, pay with the saved card. Each step has its own
 * idempotency key, so reconciliation can re-run it within Stripe's key window. A card error voids the invoice and fails
 * the attempt (a recharge then turns auto-recharge off); no answer leaves it pending for reconciliation.
 */
export async function chargeSavedCard(runtime: Runtime, attemptId: string): Promise<string> {
  const cfg = stripeConfig(runtime);
  const [a] = await rows<AttemptRow & { stripe_customer: string | null; stripe_payment_method: string | null }>(runtime.db, sql`SELECT p.*, b.stripe_customer, b.stripe_payment_method
    FROM billing_payment_attempts p LEFT JOIN billing_accounts b ON b.workspace_id=p.workspace_id WHERE p.id=${attemptId}`);
  if (!a || !OPEN.includes(a.status) || (a.kind !== 'saved_card' && a.kind !== 'recharge')) return a?.status ?? 'missing';
  if (!a.stripe_customer || !a.stripe_payment_method) return failAttempt(runtime, attemptId, 'payment_method_missing', 'No card is saved for this workspace.', 'failed', false);
  const key = a.idempotency_key, meta = metadata(cfg, a.workspace_id, { bane_attempt: attemptId }), pm = a.stripe_payment_method;
  let invoiceId = a.stripe_invoice;
  try {
    if (!invoiceId) {
      const invoice = await stripeRequest(cfg, 'POST', '/v1/invoices', { customer: a.stripe_customer, collection_method: 'charge_automatically', auto_advance: false,
        pending_invoice_items_behavior: 'exclude', automatic_tax: { enabled: cfg.automaticTax }, default_payment_method: pm, metadata: meta }, `${key}:invoice`);
      invoiceId = String(invoice.id);
      await runtime.db.execute(sql`UPDATE billing_payment_attempts SET stripe_invoice=${invoiceId}, status='pending', updated_at=now()
        WHERE id=${attemptId} AND status IN ('created','pending') AND (stripe_invoice IS NULL OR stripe_invoice=${invoiceId})`);
    }
    const path = `/v1/invoices/${encodeURIComponent(invoiceId)}`;
    await stripeRequest(cfg, 'POST', '/v1/invoiceitems', { customer: a.stripe_customer, invoice: invoiceId, amount: cents(a.amount_uc), currency: 'usd', description: `${productName} credit`, tax_behavior: 'exclusive', metadata: meta }, `${key}:item`);
    await stripeRequest(cfg, 'POST', `${path}/finalize`, { auto_advance: false }, `${key}:finalize`);
    // The invoice carries the card (default_payment_method), so a retry sends identical parameters under the same key.
    const paid = await stripeRequest(cfg, 'POST', `${path}/pay`, { off_session: true, expand: ['payments'] }, `${key}:pay`);
    return await settleInvoice(runtime, attemptId, paid);
  } catch (error) {
    if (!(error instanceof StripeError)) throw error;
    if (error.uncertain) { log('warn', { code: 'BILLING_CHARGE_UNCONFIRMED', workspaceId: a.workspace_id, attemptId, ...stripeErrorFields(error) }); return 'pending'; }
    log('warn', { code: 'BILLING_STRIPE_ERROR', operation: 'charge', workspaceId: a.workspace_id, attemptId, kind: a.kind, ...stripeErrorFields(error) });
    // Any refusal Stripe won't change its mind about (a decline, 3DS, or a non-card one such as
    // customer_tax_location_invalid) ends the charge the same way: the invoice is voided and a recharge turns
    // auto-recharge off with one notice. Otherwise every trigger would open a new attempt and invoice (finding 2).
    if (invoiceId) await voidInvoice(cfg, invoiceId, key);
    return failAttempt(runtime, attemptId, error.reason, error.message);
  }
}
/** Voids an open invoice, or deletes one still in draft (best effort): neither can be paid later. */
export async function voidInvoice(cfg: StripeConfig, invoiceId: string, key: string) {
  const path = `/v1/invoices/${encodeURIComponent(invoiceId)}`;
  try { await stripeRequest(cfg, 'POST', `${path}/void`, {}, `${key}:void`); return true; }
  catch (error) {
    if (error instanceof StripeError && !error.uncertain) try { await stripeRequest(cfg, 'DELETE', path); return true; } catch { /* Neither open nor draft: reported below. */ }
    log('warn', { code: 'BILLING_INVOICE_VOID_FAILED', invoiceId, ...stripeErrorFields(error) });
    return false;
  }
}

// ---------- reading payments ----------
type PaymentRow = Pick<AttemptRow, 'id' | 'kind' | 'status' | 'amount_uc' | 'charged_cents' | 'tax_cents' | 'card_brand' | 'card_last4' | 'invoice_url' | 'invoice_pdf' | 'receipt_url' | 'failure_code' | 'failure_message' | 'created_at'> & { at_text: string };
const paymentView = (r: PaymentRow): PaymentView => ({
  id: r.id, at: new Date(r.created_at).toISOString(), kind: r.kind, status: r.status as PaymentView['status'], amountCents: cents(r.amount_uc),
  taxCents: r.tax_cents, totalCents: r.charged_cents, card: r.card_last4 || r.card_brand ? { brand: r.card_brand ?? 'card', last4: r.card_last4 ?? '' } : null,
  invoiceUrl: r.invoice_url, invoicePdf: r.invoice_pdf, receiptUrl: r.receipt_url, failure: r.failure_code ? { code: r.failure_code, message: r.failure_message ?? r.failure_code } : null,
});
const paymentColumns = sql`id, kind, status, amount_uc, charged_cents, tax_cents, card_brand, card_last4, invoice_url, invoice_pdf, receipt_url, failure_code, failure_message, created_at, created_at::text AS at_text`;
export async function getPayment(db: Database, workspaceId: string, attemptId: string): Promise<PaymentView | null> {
  const [row] = await rows<PaymentRow>(db, sql`SELECT ${paymentColumns} FROM billing_payment_attempts WHERE workspace_id=${workspaceId} AND id=${attemptId}`);
  return row ? paymentView(row) : null;
}
/** Newest first. The cursor is opaque: the last row's time and ID. */
export async function listPayments(db: Database, workspaceId: string, cursor?: string | null, limit = 50): Promise<{ data: PaymentView[]; nextCursor: string | null }> {
  let after: SQL = sql``;
  if (cursor) {
    const [at, last] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!at || !last || Number.isNaN(Date.parse(at))) throw new ApiError(422, 'VALIDATION_FAILED', 'The cursor is invalid.', 'cursor');
    after = sql`AND (created_at, id) < (${at}::timestamptz, ${last})`;
  }
  const size = Math.max(1, Math.min(100, Math.floor(limit)));
  const found = await rows<PaymentRow>(db, sql`SELECT ${paymentColumns} FROM billing_payment_attempts WHERE workspace_id=${workspaceId} ${after} ORDER BY created_at DESC, id DESC LIMIT ${size + 1}`);
  const page = found.slice(0, size), tail = page.at(-1);
  return { data: page.map(paymentView), nextCursor: found.length > size && tail ? Buffer.from(`${tail.at_text}|${tail.id}`).toString('base64url') : null };
}

// ---------- resolving attempts against Stripe (webhook and reconciliation) ----------
const ref = (value: unknown): string | null => typeof value === 'string' ? value : value && typeof (value as StripeObject).id === 'string' ? (value as StripeObject).id : null;
/** Retries of a create stop at 22 h, inside Stripe's 24 h idempotency window; after that Nightmail looks the object up. */
export const RETRY_STOP_S = 22 * 3600;
const RECHARGE_EXPIRY_S = 24 * 3600;

/**
 * Applies a Checkout Session's state to its attempt. `final` (reconciliation) also closes a session Stripe completed
 * without payment; a webhook waits for the async payment events instead. Returns the attempt's status.
 */
export async function applyCheckoutSession(runtime: Runtime, attemptId: string, session: StripeObject, final = false): Promise<string> {
  if (session.mode === 'setup') {
    if (session.status === 'complete') await saveCard(runtime, attemptId, { setupIntent: ref(session.setup_intent) });
    else if (session.status === 'expired') await failAttempt(runtime, attemptId, 'expired', 'The Checkout page expired before the card was saved.', 'expired', false);
  } else if (session.payment_status === 'paid') {
    const status = await creditAttempt(runtime, attemptId, { creditCents: Number(session.amount_subtotal), chargedCents: Number(session.amount_total ?? session.amount_subtotal),
      taxCents: Number(session.total_details?.amount_tax ?? 0), paymentIntent: ref(session.payment_intent), invoice: ref(session.invoice) });
    if (status === 'succeeded') await saveCard(runtime, attemptId, { paymentIntent: ref(session.payment_intent), invoice: ref(session.invoice) });
  } else if (session.status === 'expired' || final && session.status === 'complete') {
    await failAttempt(runtime, attemptId, 'expired', 'The Checkout page closed without a payment.', 'expired', false);
  }
  return (await readAttempt(runtime.db, attemptId))?.status ?? 'missing';
}

const touch = (runtime: Runtime, attemptId: string) => runtime.db.execute(sql`UPDATE billing_payment_attempts SET updated_at=now() WHERE id=${attemptId} AND status IN ${open}`);
async function findInvoice(cfg: StripeConfig, attemptId: string): Promise<StripeObject | null> {
  const found = await stripeRequest(cfg, 'GET', '/v1/invoices/search', { query: `metadata['bane_attempt']:'${attemptId}'`, expand: ['data.payments'] });
  const list: StripeObject[] = Array.isArray(found.data) ? found.data : [];
  return list.find(i => i.status === 'paid') ?? list[0] ?? null;
}
/** Voids an open invoice or deletes a draft so it can never be paid. False when Stripe refused (it may be paid). */
async function closeInvoice(cfg: StripeConfig, invoice: StripeObject, key: string) {
  if (invoice.status === 'draft') {
    try { await stripeRequest(cfg, 'DELETE', `/v1/invoices/${encodeURIComponent(invoice.id)}`); return true; } catch (error) { return error instanceof StripeError && error.missing; }
  }
  return invoice.status === 'open' ? voidInvoice(cfg, invoice.id, key) : invoice.status !== 'paid';
}

/**
 * Reconciliation of one open attempt (every 5 minutes, for attempts unchanged for 5). Never replays webhook events
 * (Console #2666): it asks Stripe for the object itself.
 * - checkout/setup: the session. Paid → credit or save the card; expired or completed unpaid → expired.
 * - saved_card/recharge: without an invoice, re-run the charge with the same keys under 22 h, then search by metadata
 *   (nothing found → failed 'lost', Console #5210); with one, paid → credit, open over 1 h → void → failed.
 * - a recharge still open after 24 h is canceled, which frees auto-recharge for the next trigger.
 */
export async function reconcileAttempt(runtime: Runtime, attemptId: string): Promise<string> {
  const cfg = stripeConfig(runtime);
  const a = await readAttempt(runtime.db, attemptId);
  if (!a || !OPEN.includes(a.status)) return a?.status ?? 'missing';
  if (a.kind === 'checkout' || a.kind === 'setup') {
    if (!a.stripe_checkout_session) return a.age_s < 300 ? a.status : failAttempt(runtime, a.id, 'create_unconfirmed', 'Stripe did not confirm the Checkout page.', 'failed', false);
    let session: StripeObject;
    try { session = await stripeRequest(cfg, 'GET', `/v1/checkout/sessions/${encodeURIComponent(a.stripe_checkout_session)}`); }
    catch (error) { if (error instanceof StripeError && error.missing) return failAttempt(runtime, a.id, 'session_missing', 'Stripe has no such Checkout page.', 'failed', false); throw error; }
    // Stripe expires sessions itself; one still open well past its expiry is closed here so the attempt can end.
    if (session.status === 'open' && typeof session.expires_at === 'number' && session.expires_at * 1000 < Date.now() - 3600_000) {
      try { session = await stripeRequest(cfg, 'POST', `/v1/checkout/sessions/${encodeURIComponent(session.id)}/expire`, {}, `${a.idempotency_key}:expire`); }
      catch (error) { if (!(error instanceof StripeError) || error.uncertain) throw error; session = await stripeRequest(cfg, 'GET', `/v1/checkout/sessions/${encodeURIComponent(session.id)}`); }
    }
    const status = await applyCheckoutSession(runtime, a.id, session, true);
    if (OPEN.includes(status)) await touch(runtime, a.id);
    return status;
  }
  const invoice = a.stripe_invoice ? await stripeRequest(cfg, 'GET', `/v1/invoices/${encodeURIComponent(a.stripe_invoice)}`, { expand: ['payments'] })
    : a.age_s >= RETRY_STOP_S ? await findInvoice(cfg, a.id) : null;
  if (invoice?.status === 'paid') return settleInvoice(runtime, a.id, invoice);
  if (a.kind === 'recharge' && a.age_s >= RECHARGE_EXPIRY_S) {
    if (invoice && !await closeInvoice(cfg, invoice, a.idempotency_key)) { await touch(runtime, a.id); return a.status; }
    return failAttempt(runtime, a.id, 'stale', 'The charge did not finish within a day.', 'canceled', false);
  }
  if (!invoice) return a.age_s < RETRY_STOP_S ? chargeSavedCard(runtime, a.id) : failAttempt(runtime, a.id, 'lost', 'Stripe has no invoice for this charge.', 'failed', false);
  if (!a.stripe_invoice) await runtime.db.execute(sql`UPDATE billing_payment_attempts SET stripe_invoice=${invoice.id}, status='pending' WHERE id=${a.id} AND status IN ${open} AND stripe_invoice IS NULL`);
  if (invoice.status === 'void' || invoice.status === 'uncollectible') return failAttempt(runtime, a.id, `invoice_${invoice.status}`, 'Stripe closed the invoice without a payment.', 'failed', false);
  const invoiceAge = Date.now() / 1000 - Number(invoice.created ?? 0);
  if (a.age_s < RETRY_STOP_S && (invoice.status === 'draft' || invoiceAge < 3600)) return chargeSavedCard(runtime, a.id);
  if (!await closeInvoice(cfg, invoice, a.idempotency_key)) {
    const again = await stripeRequest(cfg, 'GET', `/v1/invoices/${encodeURIComponent(invoice.id)}`, { expand: ['payments'] });
    if (again.status === 'paid') return settleInvoice(runtime, a.id, again);
    await touch(runtime, a.id); return a.status;
  }
  return failAttempt(runtime, a.id, 'abandoned', 'Stripe did not complete the charge.', 'failed', false);
}

// ---------- refunds (operator only) ----------
type RefundRow = { id: string; workspace_id: string; attempt_id: string; amount_uc: string; status: string; stripe_refund: string | null; stripe_credit_note: string | null };
/** Ends a refund: succeeded counts it against the payment; failed returns the held amount to the balance. Idempotent. */
export async function settleRefund(runtime: Runtime, refundId: string, outcome: 'succeeded' | 'failed', facts: { stripeRefund?: string | null; reason?: string } = {}): Promise<string> {
  return runtime.db.transaction(async tx => {
    const [owner] = await rows<{ workspace_id: string }>(tx, sql`SELECT workspace_id FROM billing_refunds WHERE id=${refundId}`);
    if (!owner) return 'missing';
    await tx.execute(sql`SELECT 1 FROM billing_accounts WHERE workspace_id=${owner.workspace_id} FOR UPDATE`);
    const [r] = await rows<RefundRow>(tx, sql`SELECT * FROM billing_refunds WHERE id=${refundId} FOR UPDATE`);
    if (!r || !['held', 'pending'].includes(r.status)) return r?.status ?? 'missing';
    await tx.execute(sql`UPDATE billing_refunds SET status=${outcome}, stripe_refund=coalesce(stripe_refund,${facts.stripeRefund ?? null}), settled_at=now() WHERE id=${refundId}`);
    if (outcome === 'succeeded') await tx.execute(sql`UPDATE billing_payment_attempts SET refunded_uc=refunded_uc+${r.amount_uc}::bigint, updated_at=now() WHERE id=${r.attempt_id}`);
    else await tx.execute(sql`SELECT billing_post(${r.workspace_id}, 'refund_release', ${'refund:' + r.id}, ${r.amount_uc}::bigint, 0::bigint,
      ${JSON.stringify({ refundId: r.id, attemptId: r.attempt_id, reason: facts.reason ?? null })}::jsonb, 'stripe')`);
    return outcome;
  });
}
const refundOutcome = (status: unknown) => status === 'succeeded' ? 'succeeded' as const : status === 'failed' || status === 'canceled' ? 'failed' as const : null;

/** Sends a held refund to Stripe: a credit note when the payment has an invoice (tax comes back in proportion), else a refund. */
async function sendRefund(runtime: Runtime, refundId: string): Promise<string> {
  const cfg = stripeConfig(runtime);
  const [r] = await rows<RefundRow & { stripe_invoice: string | null; stripe_payment_intent: string | null }>(runtime.db, sql`SELECT r.*, p.stripe_invoice, p.stripe_payment_intent
    FROM billing_refunds r JOIN billing_payment_attempts p ON p.id=r.attempt_id WHERE r.id=${refundId}`);
  if (!r || r.status !== 'held') return r?.status ?? 'missing';
  const meta = metadata(cfg, r.workspace_id, { bane_refund: r.id, bane_attempt: r.attempt_id }), amount = cents(r.amount_uc), key = `refund:${r.id}`;
  try {
    let refund: StripeObject | null = null, note: StripeObject | null = null;
    if (r.stripe_invoice) {
      const invoice = await stripeRequest(cfg, 'GET', `/v1/invoices/${encodeURIComponent(r.stripe_invoice)}`);
      const line = ref(invoice.lines?.data?.[0]);
      if (!line) throw new StripeError(400, 'invalid_request_error', 'invoice_line_missing', undefined, undefined, 'The invoice has no line to credit.');
      const lines = [{ type: 'invoice_line_item', invoice_line_item: line, amount }];
      const preview = await stripeRequest(cfg, 'GET', '/v1/credit_notes/preview', { invoice: r.stripe_invoice, lines });
      // No reason: credit notes take only duplicate, fraudulent, order_change or product_unsatisfactory, none of which is
      // a refund of unused credit; requested_by_customer (a Refund's reason) is refused with a 400 here.
      note = await stripeRequest(cfg, 'POST', '/v1/credit_notes', { invoice: r.stripe_invoice, lines, refund_amount: preview.total, metadata: meta }, key);
      const refunds: StripeObject[] = Array.isArray(note.refunds) ? note.refunds : [];
      const id = ref(note.refund) ?? ref(refunds[0]?.refund);
      refund = id ? await stripeRequest(cfg, 'GET', `/v1/refunds/${encodeURIComponent(id)}`) : null;
    } else {
      if (!r.stripe_payment_intent) throw new StripeError(400, 'invalid_request_error', 'payment_intent_missing', undefined, undefined, 'The payment has no PaymentIntent.');
      refund = await stripeRequest(cfg, 'POST', '/v1/refunds', { payment_intent: r.stripe_payment_intent, amount, reason: 'requested_by_customer', metadata: meta }, key);
    }
    await runtime.db.execute(sql`UPDATE billing_refunds SET status='pending', stripe_refund=coalesce(stripe_refund,${ref(refund)}), stripe_credit_note=coalesce(stripe_credit_note,${ref(note)})
      WHERE id=${r.id} AND status='held'`);
    const outcome = refundOutcome(refund?.status);
    return outcome ? settleRefund(runtime, r.id, outcome, { stripeRefund: ref(refund) }) : 'pending';
  } catch (error) {
    if (!(error instanceof StripeError) || error.uncertain) throw error;
    await settleRefund(runtime, r.id, 'failed', { reason: error.reason });
    throw providerError(error, { operation: 'refund', refundId: r.id });
  }
}

/**
 * Refunds paid credit from a succeeded top-up (operator only). The amount is held in the ledger before Stripe is
 * called (#4224), so the balance can't be spent twice; promotional credit is never refundable (#3991).
 */
/** `onHeld` runs inside the transaction that holds the refund (the refund_hold ledger row), so a caller's own record
 *  of it (the operator audit) commits or rolls back with the money. */
/** Why a top-up is refunded. Unused credit is not refundable except for a billing error, an account Anomaly closes
 *  without cause, or where the law requires it (Ryan, 2026-11-12). */
export type RefundBasis = 'billing_error' | 'account_closure' | 'legal';
export async function refundTopUp(runtime: Runtime, input: { workspaceId: string; attemptId: string; amountCents?: number; basis: RefundBasis; reason: string; operator: string;
  onHeld?: (tx: DbExecutor, held: { refundId: string; amountUc: bigint }) => Promise<void> }): Promise<{ refundId: string; status: string }> {
  stripeConfig(runtime);
  if (input.amountCents !== undefined && (!Number.isInteger(input.amountCents) || input.amountCents < 1)) throw new ApiError(422, 'REFUND_AMOUNT_INVALID', 'Refund a whole number of cents.', 'amountCents');
  if (!['billing_error', 'account_closure', 'legal'].includes(input.basis)) throw new ApiError(422, 'REFUND_BASIS_REQUIRED', 'Unused credit is refunded only for a billing error, an account Anomaly closes, or a legal requirement.', 'basis');
  const refundId = await runtime.db.transaction(async tx => {
    await lockAccount(tx, input.workspaceId);
    // Usage not settled yet is owed too (finding 3): settlement takes promotional credit first, so the paid credit
    // that will be left is min(balance, balance + promo − unsettled) = min(balance_uc, availableUc).
    const [account] = await rows<{ balance_uc: string; available_uc: string }>(tx, sql`SELECT balance_uc::text AS balance_uc,
      billing_position(workspace_id)->>'availableUc' AS available_uc FROM billing_accounts WHERE workspace_id=${input.workspaceId}`);
    const [a] = await rows<AttemptRow>(tx, sql`SELECT *, 0 AS age_s FROM billing_payment_attempts WHERE id=${input.attemptId} AND workspace_id=${input.workspaceId} FOR UPDATE`);
    if (!a) notFound('Payment');
    if (a.status !== 'succeeded' || BigInt(a.amount_uc) === 0n) throw new ApiError(409, 'REFUND_NOT_ALLOWED', 'Only a completed top-up can be refunded.');
    const [{ held }] = await rows<{ held: string }>(tx, sql`SELECT coalesce(sum(amount_uc),0)::text AS held FROM billing_refunds WHERE attempt_id=${a.id} AND status IN ('held','pending')`) as [{ held: string }];
    const balance = BigInt(account!.balance_uc), available = BigInt(account!.available_uc), unspent = balance < available ? balance : available;
    const left = BigInt(a.amount_uc) - BigInt(a.refunded_uc) - BigInt(held), paid = unspent > 0n ? unspent : 0n;
    const refundable = ((left < paid ? left : paid) / UC_PER_CENT) * UC_PER_CENT;
    const amount = input.amountCents === undefined ? refundable : BigInt(input.amountCents) * UC_PER_CENT;
    if (amount <= 0n || amount > refundable) throw new ApiError(409, 'REFUND_EXCEEDS_BALANCE', `At most ${cents(refundable)}¢ of this payment can be refunded: refunds come only from paid credit not yet spent, including usage that is not settled yet.`, 'amountCents');
    const refund = id('brf');
    await tx.execute(sql`INSERT INTO billing_refunds(id,workspace_id,attempt_id,amount_uc,status,reason,operator) VALUES (${refund},${input.workspaceId},${a.id},${amount},'held',${`${input.basis}: ${input.reason}`.slice(0, 500)},${input.operator})`);
    await tx.execute(sql`SELECT billing_post(${input.workspaceId}, 'refund_hold', ${'refund:' + refund}, ${-amount}::bigint, 0::bigint, ${JSON.stringify({ refundId: refund, attemptId: a.id, basis: input.basis, reason: input.reason.slice(0, 500) })}::jsonb, ${input.operator})`);
    await input.onHeld?.(tx, { refundId: refund, amountUc: amount });
    return refund;
  });
  try { return { refundId, status: await sendRefund(runtime, refundId) }; }
  catch (error) {
    if (error instanceof StripeError && error.uncertain) { log('warn', { code: 'BILLING_REFUND_UNCONFIRMED', refundId }); return { refundId, status: 'held' }; }
    throw error;
  }
}

/** Reconciliation of a refund: a held one is sent again with the same key; a pending one is read back from Stripe. */
export async function reconcileRefund(runtime: Runtime, refundId: string): Promise<string> {
  const cfg = stripeConfig(runtime);
  const [r] = await rows<RefundRow>(runtime.db, sql`SELECT * FROM billing_refunds WHERE id=${refundId}`);
  if (!r) return 'missing';
  if (r.status === 'held') return sendRefund(runtime, r.id).catch(error => { if (error instanceof ApiError) return 'failed'; throw error; });
  if (r.status !== 'pending' || !r.stripe_refund) return r.status;
  const refund = await stripeRequest(cfg, 'GET', `/v1/refunds/${encodeURIComponent(r.stripe_refund)}`);
  const outcome = refundOutcome(refund.status);
  return outcome ? settleRefund(runtime, r.id, outcome, { reason: refund.failure_reason }) : r.status;
}

// ---------- disputes and fraud warnings ----------
/** Blocks the card behind an attempt and turns auto-recharge off. Runs inside the caller's transaction (account locked). */
async function blockCard(tx: DbExecutor, a: AttemptRow, reason: 'dispute' | 'early_fraud_warning') {
  if (a.card_fingerprint) await tx.execute(sql`INSERT INTO billing_blocked_cards(fingerprint, reason) VALUES (${a.card_fingerprint}, ${reason}) ON CONFLICT DO NOTHING`);
  await tx.execute(sql`UPDATE billing_accounts SET recharge_enabled=false, recharge_disabled_reason=${reason}, recharge_disabled_at=now(), updated_at=now() WHERE workspace_id=${a.workspace_id}`);
}
/** A dispute debits what the payment credited (at most the disputed amount), blocks the card and stops auto-recharge. */
export async function openDispute(runtime: Runtime, attemptId: string, dispute: StripeObject) {
  await runtime.db.transaction(async tx => {
    const locked = await lockAttempt(tx, attemptId);
    if (!locked) return;
    const { attempt: a } = locked;
    const disputed = BigInt(Math.max(0, Number(dispute.amount) || 0)) * UC_PER_CENT, credited = BigInt(a.amount_uc);
    const debit = disputed < credited ? disputed : credited;
    await tx.execute(sql`SELECT billing_post(${a.workspace_id}, 'dispute', ${'dispute:' + dispute.id}, ${-debit}::bigint, 0::bigint,
      ${JSON.stringify({ attemptId, disputeId: dispute.id, reason: dispute.reason ?? null })}::jsonb, 'stripe')`);
    await blockCard(tx, a, 'dispute');
    log('error', { code: 'BILLING_DISPUTE_OPENED', workspaceId: a.workspace_id, attemptId, disputeId: dispute.id, amountCents: Number(dispute.amount) || 0 });
  });
}
/** A won dispute gives back exactly what the dispute debited; a lost one changes nothing more. */
export async function closeDispute(runtime: Runtime, attemptId: string, dispute: StripeObject) {
  if (dispute.status !== 'won') return;
  await runtime.db.transaction(async tx => {
    const locked = await lockAttempt(tx, attemptId);
    if (!locked) return;
    const [debited] = await rows<{ paid_uc: string }>(tx, sql`SELECT paid_uc FROM billing_ledger WHERE kind='dispute' AND source_id=${'dispute:' + dispute.id}`);
    if (!debited || BigInt(debited.paid_uc) === 0n) return;
    await tx.execute(sql`SELECT billing_post(${locked.attempt.workspace_id}, 'dispute_reversal', ${'dispute:' + dispute.id}, ${-BigInt(debited.paid_uc)}::bigint, 0::bigint,
      ${JSON.stringify({ attemptId, disputeId: dispute.id })}::jsonb, 'stripe')`);
  });
}
/** Radar's early fraud warning: block the card and stop auto-recharge. The operator decides on a refund. */
export async function fraudWarning(runtime: Runtime, attemptId: string, warning: StripeObject) {
  await runtime.db.transaction(async tx => {
    const locked = await lockAttempt(tx, attemptId);
    if (!locked) return;
    await blockCard(tx, locked.attempt, 'early_fraud_warning');
    log('error', { code: 'BILLING_EARLY_FRAUD_WARNING', workspaceId: locked.attempt.workspace_id, attemptId, warningId: warning.id, fraudType: warning.fraud_type ?? null });
  });
}
