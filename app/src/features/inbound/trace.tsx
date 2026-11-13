// Trace: run an email through routes and rituals with the dry run (testRituals) and step through what happened:
// each condition lights up true or false, omen answers fill in, then the actions and where the mail ends up.
// Nothing is sent or saved. Steps are laid out up front and revealed in place, so the animation never moves the page.
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'
import { Alert, Button, EmptyState, ErrorState, Field, Input, PageHeader, SkeletonText, Tabs, Textarea } from '../../components/ui'
import { PrivateAddress } from '../../components/PrivateAddress'
import { useApiDef, useApiQuery } from '../../data/context'
import { queries } from '../../data/queries'
import { request } from '../../data/live'
import { ApiError } from '../../data/types'
import { concepts, outcomes } from './concepts'
import { useOverview, type Overview } from './overview'
import { ConceptLine, Match, RitualIcon, TargetIcon } from './parts'
import { when } from './shared'
import { ownRecipient, receivedTo, type ReceivedRecipients } from '../../lib/private-address'
import './receiving.css'

export type TimelineStep =
  | { kind: 'condition'; line: number; column: number; endLine: number; endColumn: number; result: boolean }
  | { kind: 'omens'; line: number; scores: Record<string, number | boolean> }
  | { kind: 'action'; line: number; op: string; ref?: string; value?: string }
  | { kind: 'return'; line: number }
export type TraceRow = { recipient: string; kind: string; key: string; scores: Record<string, number | boolean>; steps: number; lines: number[]; error: string | null; actions: { op: string; ref?: string; value?: string }[]; timeline: TimelineStep[] }
export type TraceRecipient = { address: string; tier?: string; route?: string | null; inboxes?: string[]; webhooks?: string[]; labels?: string[]; junk?: boolean; dropped?: boolean; warnings?: string[] }
export type DryRun = { version: number; steps: number; trace: TraceRow[]; recipients: TraceRecipient[] }
export type EmailChoice = { mode: 'recent'; messageId: string | null; to?: string } | { mode: 'sample'; to: string } | { mode: 'paste'; mime: string }

const errorText = (e: unknown) => e instanceof ApiError ? e.text : (e as Error).message
export const sampleMime = (to: string) => [
  'From: Dana Customer <dana@example.net>', `To: ${to}`, 'Subject: Refund for order 4821', 'Message-ID: <sample-4821@example.net>', 'Content-Type: text/plain; charset=utf-8', '',
  'Hi, the blender arrived broken. Could I get a refund? Order 4821.', '', 'Thanks, Dana',
].join('\r\n')
/** The request body testRituals takes for a choice, or null while the choice is incomplete. */
export function traceInput(choice: EmailChoice, to?: string): { messageId?: string; mime?: string; to?: string[] } | null {
  const envelope = to?.trim() ? { to: [to.trim().toLowerCase()] } : {}
  if (choice.mode === 'recent') return choice.messageId ? { messageId: choice.messageId, ...envelope } : null
  if (choice.mode === 'sample') return choice.to.includes('@') ? { mime: sampleMime(choice.to.trim()) } : null
  return choice.mime.trim() ? { mime: choice.mime.replace(/\r?\n/g, '\r\n'), ...envelope } : null
}

type Received = ReceivedRecipients & { id: string; from: { name: string | null; address: string }; subject: string; at: string }
/** The address to trace a message as: ours only (the receiving address or envelope recipient), never the header To. */
const arrivedAt = (m: Received) => ownRecipient(m)
/** The last few received messages, shared by the picker and the pages that wait for it before showing the picker. */
export const useRecentMail = () => useApiQuery(['trace-recent'], (_api, signal) => request<{ data: Received[] }>('/v1/logs?direction=received&limit=6', { signal }).then(r => r.data))
/** The email a picker starts on, from settled data: the newest received message, or the sample when there is none.
 * Chosen while rendering, not in an effect, so the picker never paints one mode and then switches. */
export const defaultChoice = (recent: Received[] | undefined, to: string): EmailChoice =>
  recent?.[0] ? { mode: 'recent', messageId: recent[0].id, to: arrivedAt(recent[0]) } : { mode: 'sample', to }
/** Recent received mail to trace, or a sample email, or a pasted message. With no mail yet, the sample is the default. */
export function EmailPicker({ value, onChange, addresses, preferredTo }: { value: EmailChoice; onChange: (next: EmailChoice) => void; addresses: string[]; preferredTo?: string }) {
  const recent = useRecentMail()
  const none = recent.data !== undefined && !recent.data.length
  return <div className="trace-picker">
    <Tabs label="Email" value={value.mode} onValueChange={mode => onChange(mode === 'recent' ? { mode, messageId: recent.data?.[0]?.id ?? null, to: recent.data?.[0] ? arrivedAt(recent.data[0]) : undefined } : mode === 'sample' ? { mode, to: preferredTo ?? addresses[0] ?? '' } : { mode: 'paste', mime: '' })}
      items={[{ value: 'recent', label: 'Recent mail' }, { value: 'sample', label: 'Sample email' }, { value: 'paste', label: 'Paste a message' }]} />
    <div className="trace-picker__body">
      {value.mode === 'recent' ? recent.error ? <ErrorState error={recent.error} onRetry={() => void recent.refetch()} />
        : !recent.data ? <div className="trace-recent" aria-hidden="true">{[0, 1, 2].map(i => <div key={i} className="trace-recent__row"><SkeletonText width="70%" /></div>)}</div>
        : !recent.data.length ? <p className="muted trace-picker__empty">No mail received yet. Try the sample email, or paste a message.</p>
        : <ul className="trace-recent" role="radiogroup" aria-label="Recent mail">{recent.data.map(m => <li key={m.id}>
          <button type="button" role="radio" aria-checked={value.messageId === m.id} className="trace-recent__row" onClick={() => onChange({ mode: 'recent', messageId: m.id, to: arrivedAt(m) })}>
            <span className="trace-recent__from"><PrivateAddress value={m.from.address} /></span>
            <span className="trace-recent__subject">{m.subject || '(no subject)'}</span>
            <span className="trace-recent__to">{(to => to ? <Match value={to} /> : <span className="muted">—</span>)(receivedTo(m))}</span>
            <time className="trace-recent__time">{when(m.at)}</time>
          </button></li>)}</ul>
        : value.mode === 'sample' ? <div className="trace-sample">
          <Field label="Send it to" htmlFor="trace-sample-to" hint="Any address on a receiving domain, including one that doesn’t exist yet.">
            <Input id="trace-sample-to" list="trace-addresses" value={value.to} onChange={e => onChange({ mode: 'sample', to: e.target.value })} placeholder="support@acme.com" autoComplete="off" />
          </Field>
          <datalist id="trace-addresses">{addresses.map(a => <option key={a} value={a} />)}</datalist>
          <pre className="trace-sample__mime">{sampleMime(value.to || 'support@acme.com').replace(/\r\n/g, '\n')}</pre>
        </div>
        : <Field label="Message" htmlFor="trace-paste" hint="The full message with its headers. Its To and Cc addresses are traced."><Textarea id="trace-paste" rows={8} spellCheck={false} value={value.mime} onChange={e => onChange({ mode: 'paste', mime: e.target.value })} placeholder={'From: ana@example.org\nTo: support@acme.com\nSubject: Invoice\n\nHello'} /></Field>}
      {none && value.mode === 'sample' && <p className="muted trace-picker__note">No mail yet, so a sample email stands in. Paste a message to trace your own.</p>}
    </div>
  </div>
}

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
const STEP_MS = 560

type Flat = { row: number; step: number }
/** Steps through every ritual's timeline in order, then reveals the result. Reduced motion shows everything at once. */
function usePlayback(total: number, runId: number) {
  const [at, setAt] = useState(-1)
  useEffect(() => {
    if (reduced()) { setAt(total); return }
    setAt(-1)
    let i = -1
    const timer = setInterval(() => { i += 1; setAt(i); if (i >= total) clearInterval(timer) }, STEP_MS)
    return () => clearInterval(timer)
  }, [total, runId])
  return { at, skip: () => setAt(total) }
}

function conditionText(source: string, s: Extract<TimelineStep, { kind: 'condition' }>) {
  const lines = source.split('\n')
  if (s.line === s.endLine) return lines[s.line - 1]?.slice(s.column - 1, s.endColumn - 1) ?? ''
  return `${lines[s.line - 1]?.slice(s.column - 1) ?? ''} …`
}

/** The ritual's source with the active line marked and each evaluated condition tinted by its result. */
function Code({ source, steps, active, revealed }: { source: string; steps: TimelineStep[]; active: number | null; revealed: number }) {
  const lines = source.replace(/\n$/, '').split('\n')
  const marks = steps.map((s, i) => ({ s, i })).filter((x): x is { s: Extract<TimelineStep, { kind: 'condition' }>; i: number } => x.s.kind === 'condition' && x.s.line === x.s.endLine)
  const activeLine = active === null ? null : steps[active]?.line ?? null
  return <ol className="trace-code" aria-label="Ritual source">{lines.map((text, n) => {
    const line = n + 1, here = marks.filter(m => m.s.line === line).sort((a, b) => a.s.column - b.s.column)
    const parts: React.ReactNode[] = []
    let from = 0
    for (const m of here) {
      const start = m.s.column - 1, end = m.s.endColumn - 1
      if (start < from) continue
      parts.push(text.slice(from, start))
      parts.push(<mark key={m.i} className="trace-cond" data-state={m.i < revealed ? (m.s.result ? 'true' : 'false') : 'idle'}>{text.slice(start, end)}</mark>)
      from = end
    }
    parts.push(text.slice(from))
    return <li key={line} data-active={activeLine === line || undefined}><span className="trace-code__n">{line}</span><code>{parts}</code></li>
  })}</ol>
}

function actionText(a: Extract<TimelineStep, { kind: 'action' }>, endpoints: Overview['endpoints']) {
  if (a.ref?.startsWith('endpoint:')) { const name = a.ref.slice(9), e = endpoints.find(x => x.source === 'endpoint' && x.name === name); return { icon: e?.type ?? 'webhook' as const, text: `${e ? { webhook: 'Webhook', slack: 'Slack', discord: 'Discord', forward: 'Forward' }[e.type] : 'Endpoint'} ${name}` } }
  if (a.ref?.startsWith('inbox:')) return { icon: 'inbox' as const, text: `${a.ref.slice(6)} inbox` }
  const words: Record<string, string> = { label: `label ${a.value ?? ''}`, junk: 'junk', block: 'block', drop: 'drop', allow: 'not junk' }
  return { icon: a.op === 'drop' || a.op === 'block' ? 'drop' as const : a.op === 'junk' ? 'store' as const : null, text: (words[a.op] ?? a.op) + (a.op === 'junk' && a.value ? ` (${a.value})` : '') }
}

/** One dry run, animated: per recipient, each ritual's code and steps, then the result. */
export function TraceView({ result, sources, overview, inboxes, runId }: { result: DryRun; sources: Record<string, string>; overview: Overview | undefined; inboxes: Map<string, string>; runId: number }) {
  const flat: Flat[] = useMemo(() => result.trace.flatMap((row, r) => row.timeline.length ? row.timeline.map((_, step) => ({ row: r, step })) : [{ row: r, step: -1 }]), [result])
  const { at, skip } = usePlayback(flat.length, runId)
  const endpoints = overview?.endpoints ?? []
  const hook = (id: string) => endpoints.find(e => e.id === id)
  const inboxName = (id: string) => inboxes.get(id) ?? overview?.routes.data.find(r => r.address?.id === id)?.address?.address ?? 'Inbox'
  const position = (row: number, step: number) => flat.findIndex(f => f.row === row && f.step === step)
  const done = at >= flat.length
  return <div className="trace-view" data-done={done || undefined}>
    <div className="trace-view__bar"><span className="muted">{result.trace.length ? `Ran ${result.trace.length === 1 ? `the ${result.trace[0]!.key} ritual` : `${result.trace.length} rituals`}: each check lights up true or false, then what it did.` : 'No ritual runs on this mail.'}</span>
      <div className="cluster">{!done && <Button size="sm" variant="ghost" onClick={skip}>Show all</Button>}</div></div>
    {result.recipients.map(rcpt => {
      const rows = result.trace.map((row, r) => ({ row, r })).filter(x => x.row.recipient === rcpt.address)
      const last = rows.length ? Math.max(...rows.map(x => position(x.r, x.row.timeline.length ? x.row.timeline.length - 1 : -1))) : -1
      const shown = at > last || done
      return <section key={rcpt.address} className="trace-recipient">
        <header className="trace-recipient__head"><span className="muted">To</span> <Match value={rcpt.address} /></header>
        {rows.map(({ row, r }) => {
          const reveal = row.timeline.filter((_, i) => position(r, i) <= at).length
          const active = row.timeline.findIndex((_, i) => position(r, i) === at)
          return <article key={`${row.key}-${r}`} className="trace-ritual">
            <h3><RitualIcon /><code>{row.key}</code><span className="muted">{row.error ? 'stopped with an error' : row.actions.length ? `${row.actions.length} ${row.actions.length === 1 ? 'action' : 'actions'}` : 'no actions'}</span></h3>
            <div className="trace-ritual__body">
              {sources[row.key] ? <Code source={sources[row.key]!} steps={row.timeline} active={active < 0 ? null : active} revealed={reveal} /> : <p className="muted">Source not available.</p>}
              <ol className="trace-steps">
                {row.timeline.map((s, i) => {
                  const state = i < reveal ? (i === active ? 'active' : 'done') : 'pending'
                  return <li key={i} className="trace-step" data-kind={s.kind} data-state={state}>
                    <span className="trace-step__line">L{s.line}</span>
                    {s.kind === 'condition' ? <><code className="trace-step__code">{conditionText(sources[row.key] ?? '', s) || 'condition'}</code><span className="trace-bool" data-value={String(s.result)}>{String(s.result)}</span></>
                      : s.kind === 'omens' ? <div className="trace-omens">{Object.entries(s.scores).map(([name, value]) => <div key={name} className="trace-omen"><code>{name}</code>
                        {typeof value === 'number' ? <span className="trace-omen__bar"><span style={{ transform: `scaleX(${state === 'pending' ? 0 : Math.max(0, Math.min(1, value))})` }} /></span> : <span className="trace-bool" data-value={String(value)}>{String(value)}</span>}
                        <span className="trace-omen__value">{typeof value === 'number' ? value.toFixed(2) : ''}</span></div>)}</div>
                      : s.kind === 'action' ? (() => { const a = actionText(s, endpoints); return <span className="trace-action">→ {a.icon && <TargetIcon type={a.icon} size={13} />}{a.text}</span> })()
                      : <span className="muted">Stops here</span>}
                  </li>
                })}
                {!row.timeline.length && <li className="trace-step" data-state={position(r, -1) <= at ? 'done' : 'pending'}><span className="muted">Nothing to evaluate; no actions.</span></li>}
                {row.error && <li className="trace-step trace-step--error" data-state={shown ? 'done' : 'pending'}>{row.error}. The mail is marked junk.</li>}
              </ol>
            </div>
          </article>
        })}
        <footer className="trace-result" data-state={shown ? 'done' : 'pending'}>
          <span className="trace-result__title">Result</span>
          <span className="trace-result__items">
            {rcpt.dropped ? <span className="trace-chip"><TargetIcon type="drop" size={13} />{outcomes.drop}</span> : <>
              {rcpt.junk && <span className="trace-chip" data-tone="warning">Stored as junk</span>}
              {(rcpt.inboxes ?? []).map(id => <span key={id} className="trace-chip"><TargetIcon type="inbox" size={13} /><PrivateAddress value={inboxName(id)} /></span>)}
              {(rcpt.webhooks ?? []).map(id => <span key={id} className="trace-chip"><TargetIcon type={hook(id)?.type ?? 'webhook'} size={13} />{hook(id)?.name ?? 'Webhook'}</span>)}
              {!rcpt.inboxes?.length && !rcpt.webhooks?.length && <span className="trace-chip"><TargetIcon type="store" size={13} />{outcomes.store}</span>}
              {(rcpt.labels ?? []).map(l => <span key={l} className="trace-chip trace-chip--label">{l}</span>)}
            </>}
            {(rcpt.warnings ?? []).map(w => <span key={w} className="trace-warning">{w}</span>)}
          </span>
        </footer>
      </section>
    })}
  </div>
}

/** Runs testRituals for a choice, with optional unsaved config and omen answers. */
export function useDryRun() {
  const [result, setResult] = useState<DryRun | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [runId, setRunId] = useState(0)
  async function run(body: Record<string, unknown>) {
    setPending(true); setError(null)
    try { setResult(await request<DryRun>('/v1/rituals/test', { method: 'POST', body })); setRunId(n => n + 1) }
    catch (e) { setError(errorText(e)); setResult(null) }
    finally { setPending(false) }
  }
  return { result, error, pending, runId, run, clear: () => { setResult(null); setError(null) } }
}

export function TracePage() {
  const [params] = useSearchParams()
  const options = useApiDef(queries.inboundAddressOptions())
  // An address page hands its address over in the navigation state, so a link never spells it out; ?to= still works.
  const preferred = (useLocation().state as { to?: string } | null)?.to ?? params.get('to') ?? undefined
  const overview = useOverview({ limit: 100 })
  const saved = useApiQuery(['ritual-config'], (_api, signal) => request<{ config: { rituals: { key: string; source: string }[] } }>('/v1/rituals', { signal }))
  const addresses = (overview.data?.routes.data ?? []).filter(r => r.kind === 'address' && r.address).map(r => r.match)
  const recent = useRecentMail()
  const [picked, setChoice] = useState<EmailChoice | null>(null)
  const choice = picked ?? defaultChoice(recent.data, preferred ?? addresses[0] ?? '')
  // The form shows once recent mail and the routes are known, so its first paint is its final layout. Gated on the first
  // answer (isFetched), not data or error: the picker retries a failed read when it mounts, and that retry clears the
  // error, so a gate on the error unmounted the picker and remounted it in a loop of requests.
  const ready = recent.isFetched && (overview.data !== undefined || !!overview.error)
  const [to, setTo] = useState(preferred ?? '')
  const dry = useDryRun()
  const view = useRef<HTMLDivElement>(null)
  // Recent mail is traced as mail to the address it arrived at, unless another address is given.
  const input = traceInput(choice, choice.mode === 'sample' ? undefined : to || (choice.mode === 'recent' ? choice.to : undefined))
  const sources = Object.fromEntries((saved.data?.config.rituals ?? []).map(r => [r.key, r.source]))
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!input) return
    await dry.run(input)
    requestAnimationFrame(() => view.current?.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' }))
  }
  return <div className="stack inbound-stack">
    <PageHeader title={concepts.trace.title} backTo="/receiving" />
    <ConceptLine line={concepts.trace.line} />
    {ready && <>
    <form className="trace-form" onSubmit={submit}>
      <EmailPicker value={choice} onChange={next => { setChoice(next); dry.clear() }} addresses={addresses} preferredTo={preferred} />
      {choice.mode !== 'sample' && <Field label="Trace it as mail to" htmlFor="trace-to" hint="Optional. Leave empty to use the message’s own recipients.">
        <Input id="trace-to" list="trace-addresses" value={to} onChange={e => { setTo(e.target.value); dry.clear() }} placeholder="The message’s own recipients" autoComplete="off" />
      </Field>}
      <div className="cluster"><Button variant="primary" type="submit" loading={dry.pending} disabled={!input}>Trace</Button><span className="muted">Rituals run as saved. Omens (questions for Bane’s AI) give their default answer; to set answers, try a ritual in its editor.</span></div>
    </form>
    <div ref={view} className="trace-out">
      {dry.error ? <Alert tone="danger" title="The trace didn’t run">{dry.error}</Alert>
        : dry.result ? <TraceView result={dry.result} sources={sources} overview={overview.data} inboxes={new Map((options.data ?? []).map(a => [a.id, a.address]))} runId={dry.runId} />
        : <EmptyState title="Pick an email and trace it" description="See which route it takes, which ritual conditions are true or false, and where it ends up." action={<Link to="/receiving?tab=rituals">Rituals</Link>} />}
    </div>
    </>}
  </div>
}
