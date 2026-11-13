import { sql } from 'drizzle-orm';
import { ApiError, log, type App, type Runtime } from '../core.js';
import {
  applyCheckoutSession, closeDispute, failAttempt, forgetCard, fraudWarning, openDispute, readAttempt, reconcileAttempt, reconcileRefund,
  settleInvoice, settleRefund, stripeConfig, stripeErrorFields, stripeLive, voidInvoice, type AttemptRow, type StripeConfig, type StripeObject,
} from './stripe.js';

const TOLERANCE_S = 300, MAX_BODY = 512 * 1024;
const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
function sameHex(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
/** Stripe-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">[,v1=...]. Any v1 may match (secret rotation). */
export async function verifyStripeSignature(secret: string, body: string, header: string | undefined, nowS = Date.now() / 1000): Promise<boolean> {
  if (!header || header.length > 2048) return false;
  const parts = header.split(',').map(part => part.trim());
  const t = parts.find(part => part.startsWith('t='))?.slice(2);
  const signatures = parts.filter(part => part.startsWith('v1=')).map(part => part.slice(3).toLowerCase());
  if (!t || !/^\d{1,12}$/.test(t) || !signatures.length || Math.abs(nowS - Number(t)) > TOLERANCE_S) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = hex(await crypto.subtle.sign('HMAC', key, encoder.encode(`${t}.${body}`)));
  return signatures.some(signature => sameHex(signature, expected));
}

type Owner = { attempt?: AttemptRow; refund?: string; paymentMethod?: string };
const ref = (value: unknown): string | null => typeof value === 'string' ? value : value && typeof (value as StripeObject).id === 'string' ? (value as StripeObject).id : null;
const meta = (object: StripeObject, key: string) => typeof object.metadata?.[key] === 'string' ? object.metadata[key] as string : null;
async function attemptBy(runtime: Runtime, column: 'id' | 'stripe_payment_intent' | 'stripe_invoice' | 'stripe_checkout_session', value: string | null) {
  if (!value) return undefined;
  const row = (await runtime.db.execute<{ id: string }>(sql`SELECT id FROM billing_payment_attempts WHERE ${sql.identifier(column)}=${value}`)).rows[0];
  return row ? readAttempt(runtime.db, row.id) : undefined;
}
/**
 * Whether an event is Bane's (the Stripe account may be shared with Console): the object carries a bane_attempt or
 * bane_refund this installation wrote, or (charges, disputes, refunds, fraud warnings, payment intents) its payment
 * resolves to one of Bane's attempts. Everything else is ignored.
 */
async function ownerOf(runtime: Runtime, type: string, object: StripeObject): Promise<Owner | null> {
  if (type === 'payment_method.detached') {
    const saved = (await runtime.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM billing_accounts WHERE stripe_payment_method=${ref(object)}`)).rows[0]!.n;
    return saved ? { paymentMethod: ref(object)! } : null;
  }
  const refund = meta(object, 'bane_refund');
  if (refund && type.startsWith('refund.')) {
    const known = (await runtime.db.execute(sql`SELECT 1 FROM billing_refunds WHERE id=${refund}`)).rows.length;
    if (known) return { refund };
  }
  if (type.startsWith('refund.') && ref(object)) {
    const row = (await runtime.db.execute<{ id: string }>(sql`SELECT id FROM billing_refunds WHERE stripe_refund=${ref(object)}`)).rows[0];
    if (row) return { refund: row.id };
  }
  const attempt = await attemptBy(runtime, 'id', meta(object, 'bane_attempt'))
    ?? (type.startsWith('checkout.session.') ? await attemptBy(runtime, 'stripe_checkout_session', ref(object)) : undefined)
    ?? (type.startsWith('invoice.') ? await attemptBy(runtime, 'stripe_invoice', ref(object)) : undefined)
    ?? await attemptBy(runtime, 'stripe_payment_intent', type.startsWith('payment_intent.') ? ref(object) : ref(object.payment_intent));
  return attempt ? { attempt } : null;
}

/** The decline code behind a failed PaymentIntent or invoice, for the attempt and the owner's email. */
const declineOf = (object: StripeObject) => {
  const e = object.last_payment_error ?? object.last_finalization_error ?? {};
  return { code: String(e.decline_code ?? e.code ?? 'payment_failed').slice(0, 100), message: typeof e.message === 'string' ? e.message : 'The payment failed.' };
};

/** Applies one owned event. Every branch is idempotent: a redelivery, or reconciliation having got there first, is a no-op. */
async function apply(runtime: Runtime, cfg: StripeConfig, type: string, object: StripeObject, owner: Owner) {
  const a = owner.attempt;
  if (owner.paymentMethod) { await forgetCard(runtime.db, null, owner.paymentMethod); return; }
  if (owner.refund) {
    const status = object.status;
    if (status === 'succeeded') await settleRefund(runtime, owner.refund, 'succeeded', { stripeRefund: ref(object) });
    else if (status === 'failed' || status === 'canceled') await settleRefund(runtime, owner.refund, 'failed', { stripeRefund: ref(object), reason: object.failure_reason ?? status });
    return;
  }
  if (!a) return;
  switch (type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      if (a.kind === 'checkout' || a.kind === 'setup') await applyCheckoutSession(runtime, a.id, object);
      return;
    case 'checkout.session.async_payment_failed': await failAttempt(runtime, a.id, 'async_payment_failed', 'The payment did not complete.', 'failed', false); return;
    case 'checkout.session.expired': await failAttempt(runtime, a.id, 'expired', 'The Checkout page expired.', 'expired', false); return;
    case 'invoice.paid':
    case 'invoice.payment_succeeded':
      await settleInvoice(runtime, a.id, object); return;
    case 'invoice.payment_failed':
    case 'payment_intent.payment_failed': {
      // A Checkout page stays open after a declined card: the person can try another. Only its expiry ends it.
      if (a.kind === 'checkout' || a.kind === 'setup') return;
      const { code, message } = declineOf(object);
      await failAttempt(runtime, a.id, code, message);
      const invoice = type === 'invoice.payment_failed' ? ref(object) : a.stripe_invoice;
      if (invoice && object.status !== 'void') await voidInvoice(cfg, invoice, a.idempotency_key);
      return;
    }
    case 'payment_intent.succeeded': await reconcileAttempt(runtime, a.id); return;  // Fallback: ask Stripe for the session or invoice.
    case 'payment_intent.canceled':
      await failAttempt(runtime, a.id, 'canceled', 'The payment was canceled.', 'canceled', false);
      if (a.stripe_invoice) await voidInvoice(cfg, a.stripe_invoice, a.idempotency_key);
      return;
    case 'charge.refunded': {
      const pending = (await runtime.db.execute<{ id: string }>(sql`SELECT id FROM billing_refunds WHERE attempt_id=${a.id} AND status IN ('held','pending') AND stripe_refund IS NOT NULL`)).rows;
      for (const row of pending) await reconcileRefund(runtime, row.id);
      return;
    }
    case 'refund.created': case 'refund.updated': return; // A refund Bane did not start (made in the Stripe dashboard): the operator reconciles it.
    case 'charge.dispute.created': await openDispute(runtime, a.id, object); return;
    case 'charge.dispute.closed': await closeDispute(runtime, a.id, object); return;
    case 'radar.early_fraud_warning.created': await fraudWarning(runtime, a.id, object); return;
    default: return;
  }
}

const HANDLED = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'checkout.session.expired',
  'invoice.paid', 'invoice.payment_succeeded', 'invoice.payment_failed', 'payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled',
  'refund.created', 'refund.updated', 'charge.refunded', 'charge.dispute.created', 'charge.dispute.closed', 'radar.early_fraud_warning.created', 'payment_method.detached']);

/**
 * Records and processes one verified event: deduplicated on its ID, filtered to Bane's objects, applied, then marked
 * processed. A failure marks it failed (never a processed one, Console #6533) so the caller answers 500 and Stripe
 * redelivers. Returns what happened.
 */
export async function receiveStripeEvent(runtime: Runtime, event: StripeObject): Promise<'processed' | 'ignored' | 'duplicate' | 'failed'> {
  const cfg = stripeConfig(runtime);
  const eventId = String(event.id), type = String(event.type), object = (event.data?.object ?? {}) as StripeObject;
  const [stored] = (await runtime.db.execute<{ status: string }>(sql`WITH added AS (
      INSERT INTO billing_gateway_events(stripe_event_id, type, livemode, payload) VALUES (${eventId}, ${type}, ${event.livemode === true}, ${JSON.stringify(event)}::jsonb)
      ON CONFLICT (stripe_event_id) DO NOTHING RETURNING status)
    SELECT status FROM added UNION ALL SELECT status FROM billing_gateway_events WHERE stripe_event_id=${eventId} AND NOT EXISTS (SELECT FROM added)`)).rows;
  if (stored?.status === 'processed' || stored?.status === 'ignored') return 'duplicate';
  const mark = (status: 'processed' | 'ignored') => runtime.db.execute(sql`UPDATE billing_gateway_events SET status=${status}, processed_at=now(), failure=NULL
    WHERE stripe_event_id=${eventId} AND status NOT IN ('processed','ignored')`);
  try {
    const owner = HANDLED.has(type) ? await ownerOf(runtime, type, object) : null;
    if (!owner) { await mark('ignored'); return 'ignored'; }
    await apply(runtime, cfg, type, object, owner);
    await mark('processed');
    return 'processed';
  } catch (error) {
    const reason = error instanceof ApiError ? error.code : error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : 'error';
    await runtime.db.execute(sql`UPDATE billing_gateway_events SET status='failed', attempts=attempts+1, failure=${reason}
      WHERE stripe_event_id=${eventId} AND status NOT IN ('processed','ignored')`);
    log('warn', { code: 'BILLING_WEBHOOK_FAILED', eventId, type, ...(error instanceof ApiError ? { reason: error.code } : stripeErrorFields(error)) });
    return 'failed';
  }
}

/** POST /v1/billing/stripe: unauthenticated (the Stripe signature is the credential), hidden from OpenAPI, 512 KB. */
export function registerStripeWebhook(app: App): void {
  app.post('/v1/billing/stripe', async c => {
    // The signature is the credential: a request without one stops here, before the configuration is consulted, so an
    // anonymous caller gets 400 whether or not payments are set up. A signed event without the keys gets 503 (Stripe retries).
    if (c.env.config.multiTenant && !c.req.header('stripe-signature')) throw new ApiError(400, 'STRIPE_SIGNATURE_INVALID', 'The Stripe-Signature header does not match this request.');
    const cfg = stripeConfig(c.env);
    const body = await c.req.text();
    if (body.length > MAX_BODY) throw new ApiError(413, 'REQUEST_TOO_LARGE', 'Request exceeds the 512 KiB limit.');
    if (!await verifyStripeSignature(cfg.webhookSecret, body, c.req.header('stripe-signature'))) throw new ApiError(400, 'STRIPE_SIGNATURE_INVALID', 'The Stripe-Signature header does not match this request.');
    let event: StripeObject;
    try { event = JSON.parse(body) as StripeObject; } catch { throw new ApiError(400, 'INVALID_JSON', 'Request body is not valid JSON.'); }
    if (typeof event?.id !== 'string' || typeof event.type !== 'string' || !event.data || typeof event.data.object !== 'object') throw new ApiError(400, 'STRIPE_EVENT_INVALID', 'Expected a Stripe event.');
    // A test-mode event must never move live money records, and the reverse.
    if (event.livemode !== stripeLive(cfg)) throw new ApiError(400, 'STRIPE_LIVEMODE_MISMATCH', 'The event is from the other Stripe mode than this installation’s key.');
    const outcome = await receiveStripeEvent(c.env, event);
    if (outcome === 'failed') throw new ApiError(500, 'BILLING_WEBHOOK_FAILED', 'The event could not be applied; Stripe will deliver it again.', undefined, true);
    return c.json({ received: true, outcome }, 200);
  });
}
