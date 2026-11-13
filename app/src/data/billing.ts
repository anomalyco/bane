import { request } from './live'

// Billing (hosted only): a prepaid USD balance that usage comes off hourly, the free allowance, auto-recharge and the
// saved card. Money crosses the API as integer micro-cents in strings (1¢ = 1,000,000 µ¢); inputs are whole cents.
// Amounts are null for members and read-only credentials; GET /v1/me carries the state for the app-wide banner.
export type Enforcement = 'off' | 'shadow' | 'enforce'
export type BillingState = { sending: 'ok' | 'low' | 'paused'; receiving: 'ok' | 'grace' | 'held'; autoRecharge: 'off' | 'on' | 'pending' | 'failed' | 'capped' }
export interface BillingSummary {
  enforcement: Enforcement
  mode: 'prepaid' | 'invoiced' | 'exempt'
  state: BillingState
  balance: { paid: string; promo: string; unsettled: string; available: string } | null
  free: { month: string; emails: { limit: number; used: number; left: number }; storage: { limitBytes: number; agedBytes: string } }
  monthToDate: { cost: string } | null
  grace: { unpaidSince: string | null; receiveHoldAt: string | null; writeOffAt: string | null }
  autoRecharge: { enabled: boolean; thresholdCents: number; amountCents: number; monthlyCapCents: number; monthTotalCents: number; disabledReason: string | null; pending: boolean } | null
  paymentMethod: { brand: string; last4: string; expMonth: number; expYear: number } | null
  prices: { emailPerThousand: string; omenPerThousand: string; storagePerGbMonth: string; freeEmails: number; freeStorageBytes: number; topUpMinCents: number; currency: 'USD' }
  topUpUrl: string
  /** Anomaly made this workspace free: nothing is charged; usage is still measured (monthToDate is what it would cost). */
  freePlan: { until: string | null } | null
}
export type LedgerKind = 'topup' | 'usage' | 'grant' | 'refund_hold' | 'refund_release' | 'dispute' | 'dispute_reversal' | 'write_off' | 'adjustment' | 'expire'
export interface LedgerEntry { id: string; at: string; kind: LedgerKind; amount: string; paid: string; promo: string; balanceAfter: string; description: string; detail: Record<string, unknown>; paymentId: string | null; invoiceUrl: string | null; expiresAt: string | null }
export type PaymentStatus = 'created' | 'pending' | 'requires_action' | 'succeeded' | 'failed' | 'canceled' | 'expired'
export interface Payment { id: string; at: string; kind: 'checkout' | 'saved_card' | 'recharge' | 'setup'; status: PaymentStatus; amountCents: number; taxCents: number | null; totalCents: number | null; card: { brand: string; last4: string } | null; invoiceUrl: string | null; invoicePdf: string | null; receiptUrl: string | null; failure: { code: string; message: string } | null }
export interface UsagePoint { start: string; meter: 'send' | 'receive' | 'omen' | 'storage' | 'byo_send' | 'byo_receive'; quantity: string }
export type AutoRechargeInput = { enabled: boolean; thresholdCents: number; amountCents: number; monthlyCapCents: number }
type Page<T> = { data: T[]; nextCursor: string | null }

export const billingApi = {
  get: (signal?: AbortSignal) => request<BillingSummary>('/v1/billing', { signal }),
  usage: (query: { from?: string; to?: string; granularity?: 'hour' | 'day' | 'month'; meter?: UsagePoint['meter'] }, signal?: AbortSignal) =>
    request<{ data: UsagePoint[] }>(`/v1/billing/usage?${new URLSearchParams(Object.entries(query).filter(([, v]) => v) as [string, string][])}`, { signal }),
  ledger: (cursor: string | undefined, signal?: AbortSignal) => request<Page<LedgerEntry>>(`/v1/billing/ledger?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { signal }),
  payments: (cursor: string | undefined, signal?: AbortSignal) => request<Page<Payment>>(`/v1/billing/payments?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { signal }),
  payment: (id: string, signal?: AbortSignal) => request<Payment>(`/v1/billing/payments/${encodeURIComponent(id)}`, { signal }),
  topUp: (input: { amountCents: number; method: 'checkout' | 'saved_card' }) => request<{ attemptId: string; status: PaymentStatus; checkoutUrl: string | null; expiresAt: string | null }>('/v1/billing/top-ups', { method: 'POST', body: input, idempotencyKey: crypto.randomUUID() }),
  autoRecharge: (input: AutoRechargeInput) => request<BillingSummary>('/v1/billing/auto-recharge', { method: 'PUT', body: input }),
  setupCard: () => request<{ checkoutUrl: string; expiresAt: string }>('/v1/billing/payment-method', { method: 'POST' }),
  removeCard: () => request<BillingSummary>('/v1/billing/payment-method', { method: 'DELETE' }),
}

// ---------- money for people ----------
const UC_PER_CENT = 1_000_000n
/** "$12.34", "−$0.50"; four decimals below a cent ("$0.0002"), as the API's own formatter does. */
export function usd(uc: string | bigint, options: { sign?: boolean } = {}) {
  const v = typeof uc === 'bigint' ? uc : BigInt(uc), neg = v < 0n, abs = neg ? -v : v
  const digits = abs > 0n && abs < UC_PER_CENT ? 4 : 2
  const scale = 10n ** BigInt(8 - digits), units = (abs + scale / 2n) / scale
  const whole = units / 10n ** BigInt(digits), frac = (units % 10n ** BigInt(digits)).toString().padStart(digits, '0')
  return `${neg ? '−' : options.sign && v > 0n ? '+' : ''}$${whole.toLocaleString('en-US')}.${frac}`
}
export const centsUsd = (cents: number) => usd(BigInt(cents) * UC_PER_CENT)
export const total = (b: NonNullable<BillingSummary['balance']>) => BigInt(b.paid) + BigInt(b.promo)
/** Whole dollars typed by a person ("25", "$25", "25.50") as cents, or null. */
export function parseDollars(text: string) {
  const match = /^\s*\$?\s*(\d{1,7})(?:\.(\d{1,2}))?\s*$/.exec(text)
  return match ? Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0')) : null
}
const CARD_BRANDS: Record<string, string> = { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover', jcb: 'JCB', diners: 'Diners Club', unionpay: 'UnionPay', link: 'Link' }
export const cardBrand = (brand: string) => CARD_BRANDS[brand.toLowerCase()] ?? brand.charAt(0).toUpperCase() + brand.slice(1)
// Stripe decline codes in plain words, for the auto-recharge banner (the owner email says the same).
const DECLINES: Record<string, string> = {
  card_declined: 'Your card was declined', generic_decline: 'Your card was declined', do_not_honor: 'Your card was declined', insufficient_funds: 'Your card has insufficient funds',
  expired_card: 'Your card has expired', authentication_required: 'Your bank asked to confirm the charge (3-D Secure)', incorrect_cvc: 'The card’s security code was wrong',
  processing_error: 'The card processor had an error', dispute: 'A payment was disputed', early_fraud_warning: 'The card was flagged by the bank', payment_method_detached: 'The saved card was removed',
}
export const declineText = (code: string) => DECLINES[code] ?? 'The last charge failed'

/** The one-word state of the balance, for Plan & usage and the Billing header. */
export function balanceState(b: Pick<BillingSummary, 'mode' | 'state'>): { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' } {
  if (b.mode === 'exempt') return { label: 'Free plan', tone: 'success' }
  if (b.state.receiving === 'held') return { label: 'Receiving held', tone: 'danger' }
  if (b.state.sending === 'paused') return { label: 'Sending paused', tone: 'danger' }
  if (b.state.sending === 'low') return { label: 'Low', tone: 'warning' }
  return { label: 'Funded', tone: 'success' }
}
export const monthDay = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
export const fullDay = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
