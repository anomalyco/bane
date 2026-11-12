import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate, useLocation } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowUpRight, CreditCard } from 'lucide-react'
import { Alert, Button, ConfirmDialog, ControlSkeleton, DataTable, Dialog, DropdownMenu, EmptyState, ErrorState, Input, Pagination, SectionHeader, Skeleton, StatusBadge, Switch, Tabs, useToast, type Column } from '../../components/ui'
import { useApiDef, useApiQuery, useSession } from '../../data/context'
import { queries } from '../../data/queries'
import { ApiError } from '../../data/types'
import { balanceState, billingApi, cardBrand, centsUsd, declineText, fullDay, monthDay, parseDollars, total, usd, type AutoRechargeInput, type BillingSummary, type LedgerEntry, type Payment } from '../../data/billing'
import { useCursorPagination } from '../../lib/pagination'
import { date, number } from '../../lib/format'
import './billing.css'

type RowProps = { title: ReactNode; hint?: ReactNode; children: ReactNode }
const errorText = (error: unknown) => error instanceof ApiError ? error.text : error instanceof Error ? error.message : 'Something went wrong. Try again.'
const cardLabel = (card: { brand: string; last4: string }) => `${cardBrand(card.brand)}\u00a0••••\u00a0${card.last4}`
const final = (payment: Payment | undefined) => !!payment && !['created', 'pending', 'requires_action'].includes(payment.status)

/** Every billing read refreshes together after money moves, and the session's banner state with them. */
function useBillingRefresh() {
  const client = useQueryClient()
  return () => {
    void client.invalidateQueries({ predicate: query => query.queryKey[0] === 'bane' && String(query.queryKey[2]).startsWith('billing') })
    void client.invalidateQueries({ queryKey: ['identity'] })
  }
}

// Settings → Billing (owners and admins): the balance and Add credit, the saved card, auto-recharge and the history.
// Rows are 53px like every settings row and each value has a skeleton of its own width, so nothing moves as data arrives.
export function BillingSection({ row: Row }: { row: (props: RowProps) => ReactNode }) {
  const query = useApiDef(queries.billing())
  // The state comes with the session (GET /v1/me) on the first frame: the note and which alerts show are decided from
  // it, so the balance arriving fills reserved space instead of inserting lines above the rows.
  const state = useSession()?.identity?.billing
  const [adding, setAdding] = useState(false)
  const b = query.data
  useCheckoutReturn()
  if (query.isError && !b) return <><SectionHeader title="Billing" /><ErrorState error={query.error} onRetry={() => void query.refetch()} /></>
  if (state?.free) return <FreePlan summary={b} Row={Row} />
  const note = state?.enforcement === 'enforce' ? 'Prepaid: usage is taken from your balance hourly. Sending pauses at $0; received mail is accepted for 7 more days. Nothing is deleted.'
    : 'Billing starts soon: nothing is charged yet. Credit you add now is kept for when it starts.'
  return <>
    <SectionHeader title="Billing" actions={<Button variant="primary" disabled={!b?.balance} onClick={() => setAdding(true)}>Add credit</Button>} />
    <p className="muted usage-note">{note}</p>
    {state && <BillingAlerts state={state} summary={b} />}
    <div className="settings-rows billing-rows">
      <div className="billing-balance">
        <span className="billing-balance__label">Balance{b && <StatusBadge status={balanceState(b).label} tone={balanceState(b).tone} />}</span>
        <span className="billing-balance__amount">{b?.balance ? usd(total(b.balance)) : <Skeleton width={136} height={36} />}</span>
        <span className="muted billing-balance__detail">{b?.balance ? balanceDetail(b.balance) : <Skeleton width={220} height={16} />}</span>
      </div>
      <Row title="This month" hint={b ? `${number(b.free.emails.used)} of ${number(b.free.emails.limit)} free emails used` : 'Usage after the free emails'}>{b?.monthToDate ? usd(b.monthToDate.cost) : <Skeleton width={64} height={20} />}</Row>
      <Row title="Payment method" hint="For auto-recharge and one-click top-ups"><CardControl summary={b} /></Row>
    </div>
    <AutoRecharge summary={b} Row={Row} />
    <History />
    {b && <AddCredit open={adding} onOpenChange={setAdding} summary={b} />}
  </>
}

// A workspace Anomaly made free: the plan instead of a balance, no Add credit, card or auto-recharge, and what its usage
// would cost, since it is still measured. The history keeps its $0 usage rows.
function FreePlan({ summary: b, Row }: { summary: BillingSummary | undefined; Row: (props: RowProps) => ReactNode }) {
  return <>
    <SectionHeader title="Billing" />
    <p className="muted usage-note">Nothing is charged and sending never pauses for a balance. Usage is still measured, so you can see what it would cost.</p>
    <div className="settings-rows billing-rows">
      <div className="billing-balance">
        <span className="billing-balance__label">Plan</span>
        <span className="billing-balance__amount billing-balance__amount--plan">Free plan</span>
        <span className="muted billing-balance__detail">{b ? `Courtesy of Anomaly · ${b.freePlan?.until ? `until ${fullDay(b.freePlan.until)}` : 'no end date'}` : <Skeleton width={220} height={16} />}</span>
      </div>
      <Row title="This month" hint={b ? `${number(b.free.emails.used)} of ${number(b.free.emails.limit)} free emails used` : 'Usage after the free emails'}>{b?.monthToDate ? <span>{usd(b.monthToDate.cost)} <span className="muted">not charged</span></span> : <Skeleton width={120} height={20} />}</Row>
    </div>
    <History />
  </>
}

function balanceDetail(balance: NonNullable<BillingSummary['balance']>) {
  const parts = [BigInt(balance.promo) > 0n ? `incl. ${usd(balance.promo)} promotional credit` : 'Prepaid credit', BigInt(balance.unsettled) !== 0n ? `${usd(balance.unsettled)} of usage not yet settled` : null]
  return parts.filter(Boolean).join(' · ')
}

/** Debt grace and a failed auto-recharge, said once, where the fix is. Which alert shows comes from the session's state;
 *  the amount and the date fill fixed-width slots when the summary arrives. */
function BillingAlerts({ state, summary: b }: { state: NonNullable<ReturnType<typeof useBillingState>>; summary: BillingSummary | undefined }) {
  if (state.enforcement !== 'enforce') return null
  // The date ends its line, so the text replacing the skeleton moves nothing.
  const slot = (ready: string | null | undefined, width: number) => ready ? <span>{ready}</span> : <span className="billing-slot"><Skeleton width={width} height={14} /></span>
  return <>
    {state.receiving === 'held' ? <Alert tone="danger" title="Received mail is being held">Bane stores new received mail but doesn’t deliver it to inboxes, webhooks or IMAP until you add credit. Nothing is deleted.</Alert>
      : state.receiving === 'grace' ? <Alert tone="warning" title={<>Received mail is accepted until {slot(b?.grace.receiveHoldAt ? monthDay(b.grace.receiveHoldAt) : null, 44)}</>}>Then it’s held until you add credit. The balance is below $0; a top-up settles it first. Nothing is deleted.</Alert> : null}
    {state.autoRecharge === 'failed' && <Alert tone="warning" title="Auto-recharge is off">Bane couldn’t charge your card. Update the card, then turn auto-recharge back on.</Alert>}
  </>
}
const useBillingState = () => useSession()?.identity?.billing

function CardControl({ summary: b }: { summary: BillingSummary | undefined }) {
  const refresh = useBillingRefresh(), toast = useToast()
  const [removing, setRemoving] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!b) return <ControlSkeleton width={140} />
  async function setup() {
    setBusy(true)
    try { window.location.assign((await billingApi.setupCard()).checkoutUrl) } catch (error) { toast(errorText(error), 'error'); setBusy(false) }
  }
  const card = b.paymentMethod
  if (!card) return <Button size="sm" loading={busy} onClick={() => void setup()}><CreditCard size={14} aria-hidden="true" />Add a card</Button>
  return <span className="cluster settings-inline">
    <span>{cardLabel(card)}</span><span className="muted">{String(card.expMonth).padStart(2, '0')}/{String(card.expYear).slice(-2)}</span>
    <DropdownMenu label="Card actions" title={cardLabel(card)} items={[{ label: 'Replace card', onSelect: () => void setup() }, { label: 'Remove card', destructive: true, onSelect: () => setRemoving(true) }]} />
    <ConfirmDialog open={removing} onOpenChange={setRemoving} danger title="Remove this card?" description={`${cardLabel(card)} is removed from Stripe. Auto-recharge turns off; add credit with Stripe Checkout until you save another card.`} confirmLabel="Remove card"
      onConfirm={async () => { await billingApi.removeCard(); refresh(); toast('Card removed. Auto-recharge is off.', 'success') }} />
  </span>
}

// Auto-recharge: the switch and Save in the section header, three amounts in dollars as rows. Without a card the switch
// is off and says why. Save keeps its place whether or not it shows, so editing never moves anything.
const RECHARGE_NOTE = 'Bane charges your saved card when the balance falls below the threshold, up to the monthly limit. A failed charge turns it off.'
const RECHARGE_ROWS = [['threshold', 'When balance falls below', '$5 to $1,000'], ['amount', 'Add', '$20 to $1,000 each time'], ['cap', 'Monthly limit', '']] as const
function AutoRecharge({ summary: b, Row }: { summary: BillingSummary | undefined; Row: (props: RowProps) => ReactNode }) {
  const settings = b?.autoRecharge
  if (settings) return <RechargeForm key={JSON.stringify(settings)} settings={settings} hasCard={!!b?.paymentMethod} capped={b?.state.autoRecharge === 'capped'} Row={Row} />
  return <section className="billing-section" aria-busy="true">
    <SectionHeader title="Auto-recharge" actions={<ControlSkeleton width={36} />} />
    <p className="muted usage-note">{RECHARGE_NOTE}</p>
    <div className="settings-rows billing-rows">{RECHARGE_ROWS.map(([key, title, hint]) => <Row key={key} title={title} hint={hint || 'Added this month'}><ControlSkeleton width={112} /></Row>)}</div>
  </section>
}
function RechargeForm({ settings, hasCard, capped, Row }: { settings: NonNullable<BillingSummary['autoRecharge']>; hasCard: boolean; capped: boolean; Row: (props: RowProps) => ReactNode }) {
  const refresh = useBillingRefresh(), toast = useToast()
  const initial = { enabled: settings.enabled, threshold: (settings.thresholdCents / 100).toString(), amount: (settings.amountCents / 100).toString(), cap: (settings.monthlyCapCents / 100).toString() }
  const [form, setForm] = useState(initial)
  const [pending, setPending] = useState(false)
  const cents = { threshold: parseDollars(form.threshold), amount: parseDollars(form.amount), cap: parseDollars(form.cap) }
  const invalid = { threshold: cents.threshold === null || cents.threshold < 500 || cents.threshold > 100_000, amount: cents.amount === null || cents.amount < 2000 || cents.amount > 100_000,
    cap: cents.cap === null || cents.cap < (cents.amount ?? 0) || cents.cap > 1_000_000 }
  const valid = !invalid.threshold && !invalid.amount && !invalid.cap
  const changed = form.threshold !== initial.threshold || form.amount !== initial.amount || form.cap !== initial.cap
  async function save(next = form) {
    const input: AutoRechargeInput = { enabled: next.enabled, thresholdCents: parseDollars(next.threshold)!, amountCents: parseDollars(next.amount)!, monthlyCapCents: parseDollars(next.cap)! }
    setPending(true)
    try { await billingApi.autoRecharge(input); refresh(); toast(input.enabled === settings.enabled ? 'Auto-recharge saved' : input.enabled ? 'Auto-recharge is on' : 'Auto-recharge is off', 'success') }
    catch (cause) { toast(errorText(cause), 'error'); setForm(initial) } finally { setPending(false) }
  }
  function submit(event: FormEvent) { event.preventDefault(); if (valid && changed) void save() }
  return <form className="billing-section" onSubmit={submit} aria-label="Auto-recharge">
    <SectionHeader title="Auto-recharge" actions={<>
      <Button type="submit" size="sm" variant="primary" loading={pending && changed} disabled={!changed || !valid || !hasCard} data-hidden={!changed || undefined} tabIndex={changed ? undefined : -1} aria-hidden={!changed || undefined} className="billing-save">Save</Button>
      <span title={hasCard ? undefined : 'Save a card first'}><Switch label={<span className="sr-only">Auto-recharge</span>} checked={form.enabled} disabled={pending || !hasCard || !valid} onCheckedChange={enabled => { const next = { ...form, enabled }; setForm(next); void save(next) }} /></span>
    </>} />
    <p className="muted usage-note">{RECHARGE_NOTE}</p>
    <div className="settings-rows billing-rows">{RECHARGE_ROWS.map(([key, title, range]) => <Row key={key} title={title} hint={key === 'cap' ? `${centsUsd(settings.monthTotalCents)} added this month${capped ? ' · limit reached' : settings.pending ? ' · adding credit now' : ''}` : range}>
      <span className="billing-dollars"><span aria-hidden="true">$</span><Input aria-label={`${title}, in dollars`} aria-invalid={invalid[key] || undefined} inputMode="decimal" value={form[key]} disabled={pending || !hasCard} onChange={event => setForm({ ...form, [key]: event.target.value })} /></span>
    </Row>)}</div>
  </form>
}

// History: the balance's ledger and the card payments, a page at a time. Both are cursor lists with card slots on phones.
const ledgerColumns: Column<LedgerEntry>[] = [
  { key: 'description', label: 'Description', render: e => <span className="billing-desc" title={e.description}>{e.description}</span>, card: 'title' },
  { key: 'at', label: 'Date', width: 132, render: e => date(e.at, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }), card: 'line' },
  { key: 'amount', label: 'Amount', width: 112, align: 'right', render: e => <span className="billing-amount" data-sign={BigInt(e.amount) < 0n ? 'out' : 'in'}>{usd(e.amount, { sign: true })}</span>, card: 'aside' },
  { key: 'after', label: 'Balance after', width: 128, align: 'right', render: e => usd(e.balanceAfter), cardRender: e => <>{usd(e.balanceAfter)}{e.invoiceUrl && <> · <InvoiceLink href={e.invoiceUrl} label="Invoice" /></>}</>, card: 'field' },
  { key: 'invoice', label: '', width: 88, align: 'right', render: e => e.invoiceUrl ? <InvoiceLink href={e.invoiceUrl} label="Invoice" /> : null, card: 'hide' },
]
function InvoiceLink({ href, label }: { href: string; label: string }) {
  return <a className="billing-link" href={href} target="_blank" rel="noreferrer">{label}<ArrowUpRight size={12} aria-hidden="true" /></a>
}
const PaymentLinks = ({ payment: p }: { payment: Payment }) => <>{p.invoiceUrl && <InvoiceLink href={p.invoiceUrl} label="Invoice" />}{p.receiptUrl && <InvoiceLink href={p.receiptUrl} label="Receipt" />}</>
const PaymentStatusBadge = ({ payment: p }: { payment: Payment }) => <StatusBadge status={p.status === 'succeeded' ? 'Paid' : p.status === 'requires_action' ? 'Needs action' : p.status}
  tone={p.status === 'succeeded' ? 'success' : p.status === 'failed' ? 'danger' : ['canceled', 'expired'].includes(p.status) ? 'neutral' : 'warning'} />
const KIND: Record<Payment['kind'], string> = { checkout: 'Top-up · Checkout', saved_card: 'Top-up · saved card', recharge: 'Auto-recharge', setup: 'Card saved' }
const paymentColumns: Column<Payment>[] = [
  { key: 'kind', label: 'Payment', render: p => KIND[p.kind], card: 'title' },
  { key: 'at', label: 'Date', width: 132, render: p => date(p.at, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }), card: 'line' },
  { key: 'amount', label: 'Amount', width: 112, align: 'right', render: p => p.kind === 'setup' ? '—' : centsUsd(p.totalCents ?? p.amountCents), card: 'aside' },
  { key: 'status', label: 'Status', width: 120, render: p => <PaymentStatusBadge payment={p} />, cardRender: p => <span className="cluster billing-links"><PaymentStatusBadge payment={p} /><PaymentLinks payment={p} /></span>, card: 'line' },
  { key: 'links', label: '', width: 136, align: 'right', render: p => <span className="cluster billing-links"><PaymentLinks payment={p} /></span>, card: 'hide' },
]
function History() {
  const [view, setView] = useState<'ledger' | 'payments'>('ledger')
  return <section className="billing-section" aria-labelledby="billing-history-title">
    <SectionHeader title={<span id="billing-history-title">History</span>} />
    <Tabs label="History" value={view} onValueChange={value => setView(value as typeof view)} items={[{ value: 'ledger', label: 'Balance' }, { value: 'payments', label: 'Payments' }]} />
    {view === 'ledger' ? <LedgerTable /> : <PaymentsTable />}
  </section>
}
function LedgerTable() {
  const pagination = useCursorPagination(), query = useApiDef(queries.billingLedger(pagination.cursorForPage(pagination.page)), { keepPrevious: true })
  return <HistoryList query={query} pagination={pagination} columns={ledgerColumns} rowKey={e => e.id} empty={<EmptyState title="No balance changes yet" description="Top-ups and hourly usage appear here." />} />
}
function PaymentsTable() {
  const pagination = useCursorPagination(), query = useApiDef(queries.billingPayments(pagination.cursorForPage(pagination.page)), { keepPrevious: true })
  return <HistoryList query={query} pagination={pagination} columns={paymentColumns} rowKey={p => p.id} empty={<EmptyState title="No payments yet" description="Card payments for credit appear here, with their invoices." />} />
}
type PageQuery<T> = { data?: { data: T[]; nextCursor: string | null }; isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown }
function HistoryList<T>({ query, pagination, columns, rowKey, empty }: { query: PageQuery<T>; pagination: ReturnType<typeof useCursorPagination>; columns: Column<T>[]; rowKey: (row: T) => string; empty: ReactNode }) {
  if (query.isError && !query.data) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />
  return <>
    <DataTable className="billing-table" columns={columns} rows={query.data?.data ?? []} rowKey={rowKey} loading={query.isPending} skeletonRows={5} minRows={5} empty={empty} />
    {query.data && <Pagination page={pagination.page} pageSize={20} count={query.data.data.length} nextCursor={query.data.nextCursor} onPageChange={next => pagination.onPageChange(next, query.data?.nextCursor)} />}
  </>
}

// Add credit: an amount, then how to pay. The saved card is charged now; otherwise Stripe Checkout opens. Above $200
// a second step confirms the amount.
const PRESETS = [2000, 5000, 10_000, 25_000]
function AddCredit({ open, onOpenChange, summary: b }: { open: boolean; onOpenChange: (open: boolean) => void; summary: BillingSummary }) {
  const card = b.paymentMethod, toast = useToast(), refresh = useBillingRefresh()
  const [preset, setPreset] = useState<number | 'custom'>(5000)
  const [custom, setCustom] = useState('')
  const [method, setMethod] = useState<'saved_card' | 'checkout'>(card ? 'saved_card' : 'checkout')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [charging, setCharging] = useState<string | null>(null)
  useEffect(() => { if (open) { setConfirming(false); setError(null); setMethod(card ? 'saved_card' : 'checkout') } }, [open, card])
  const amount = preset === 'custom' ? parseDollars(custom) : preset
  const invalid = amount === null || amount < 2000 || amount > 1_000_000
  const charge = usePaymentPoll(charging, payment => {
    setCharging(null); setBusy(false); refresh()
    if (payment?.status === 'succeeded') { toast(`${centsUsd(payment.amountCents)} added to your balance`, 'success'); onOpenChange(false) }
    else setError(new Error(payment?.failure ? `${declineText(payment.failure.code)}. Nothing was charged.` : 'The charge didn’t finish. Check Payments in a minute.'))
  })
  async function pay() {
    if (invalid) return
    if (amount! > 20_000 && !confirming) { setConfirming(true); return }
    setBusy(true); setError(null)
    try {
      const result = await billingApi.topUp({ amountCents: amount!, method })
      if (result.checkoutUrl) { window.location.assign(result.checkoutUrl); return }
      if (result.status === 'succeeded' || result.status === 'failed') { setCharging(null); setBusy(false); refresh(); if (result.status === 'succeeded') { toast(`${centsUsd(amount!)} added to your balance`, 'success'); onOpenChange(false) } else setError(new Error('The card was declined. Nothing was charged.')); return }
      setCharging(result.attemptId)
    } catch (cause) { setError(cause); setBusy(false) }
  }
  const working = busy || charge.waiting
  return <Dialog open={open} onOpenChange={next => { if (!working) onOpenChange(next) }} title="Add credit" className="billing-add"
    description="Credit pays for email you send and receive at $0.20 per 1,000. Prices exclude any tax."
    footer={<><Button disabled={working} onClick={() => confirming ? setConfirming(false) : onOpenChange(false)}>{confirming ? 'Back' : 'Cancel'}</Button>
      <Button variant="primary" loading={working} disabled={invalid} onClick={() => void pay()}>{confirming ? `Add ${centsUsd(amount ?? 0)}` : method === 'checkout' ? 'Continue to Stripe' : `Charge ${amount !== null && !invalid ? centsUsd(amount) : ''}`.trim()}</Button></>}>
    {confirming ? <p className="billing-add__confirm">Add <b>{centsUsd(amount ?? 0)}</b> to this workspace’s balance? {method === 'saved_card' && card ? `${cardLabel(card)} is charged now.` : 'You pay in Stripe Checkout, where any tax is added.'}</p> : <>
      <div className="billing-choice" role="radiogroup" aria-label="Amount">
        {[...PRESETS, 'custom' as const].map(value => <button key={value} type="button" role="radio" aria-checked={preset === value} className="billing-choice__item" disabled={working} onClick={() => setPreset(value)}>{value === 'custom' ? 'Custom' : centsUsd(value).replace('.00', '')}</button>)}
      </div>
      {preset === 'custom' && <span className="billing-dollars billing-add__custom"><span aria-hidden="true">$</span><Input autoFocus aria-label="Amount in dollars, $20 to $10,000" inputMode="decimal" placeholder="75" value={custom} disabled={working} onChange={event => setCustom(event.target.value)} /></span>}
      {preset === 'custom' && custom && invalid && <p className="muted">Add $20 to $10,000 at a time.</p>}
      <div className="billing-methods" role="radiogroup" aria-label="Pay with">
        {card && <button type="button" role="radio" aria-checked={method === 'saved_card'} className="billing-method" disabled={working} onClick={() => setMethod('saved_card')}><CreditCard size={16} aria-hidden="true" /><span>Charge {cardLabel(card)}</span></button>}
        <button type="button" role="radio" aria-checked={method === 'checkout'} className="billing-method" disabled={working} onClick={() => setMethod('checkout')}><ArrowUpRight size={16} aria-hidden="true" /><span>Pay with Stripe Checkout</span></button>
      </div>
    </>}
    {charge.waiting && <p className="muted" role="status">Charging {card ? cardLabel(card) : 'your card'}…</p>}
    {error ? <Alert tone="danger">{errorText(error)}</Alert> : null}
  </Dialog>
}

/** Polls a payment every 2 seconds for up to a minute, then calls done once with its final state (or undefined). */
function usePaymentPoll(id: string | null, done: (payment: Payment | undefined) => void) {
  const started = useRef(0), finished = useRef<string | null>(null)
  const [expired, setExpired] = useState(false)
  useEffect(() => { started.current = Date.now(); finished.current = null; setExpired(false) }, [id])
  const query = useApiQuery(['billing-payment', id], (_api, signal) => billingApi.payment(id!, signal), { enabled: !!id && !expired, interval: data => final(data) ? false : 2000 })
  useEffect(() => {
    if (!id || finished.current === id) return
    const timedOut = Date.now() - started.current > 60_000
    if (final(query.data) || timedOut || (query.isError && query.error instanceof ApiError && query.error.status === 404)) {
      finished.current = id
      if (timedOut) setExpired(true)
      done(final(query.data) ? query.data : undefined)
    }
  })
  return { waiting: !!id && finished.current !== id, payment: query.data }
}

// Back from Stripe Checkout (?billing=success&attempt=… or ?billing=canceled): say so, wait for the payment to settle,
// then refresh. The query string is cleared so a reload doesn't repeat it.
function useCheckoutReturn() {
  const { search } = useLocation(), navigate = useNavigate(), toast = useToast(), refresh = useBillingRefresh()
  const params = new URLSearchParams(search), outcome = params.get('billing'), attempt = params.get('attempt')
  const [watching, setWatching] = useState<string | null>(null)
  useEffect(() => {
    if (!outcome) return
    if (outcome === 'success' && attempt && /^[\w-]{1,100}$/.test(attempt)) { toast('Payment received; your credit appears in a few seconds.', 'info'); setWatching(attempt) }
    else if (outcome === 'canceled') toast('Checkout canceled. Nothing was charged.', 'info')
    navigate({ pathname: '/settings', search: '', hash: '#billing' }, { replace: true })
  }, [outcome, attempt, navigate, toast])
  usePaymentPoll(watching, payment => {
    setWatching(null); refresh()
    if (payment?.status === 'succeeded') toast(payment.kind === 'setup' ? 'Card saved.' : `${centsUsd(payment.amountCents)} added to your balance.`, 'success')
    else if (payment) toast(payment.failure ? `${declineText(payment.failure.code)}. Nothing was charged.` : 'The payment didn’t finish. Nothing was charged.', 'error')
  })
}
