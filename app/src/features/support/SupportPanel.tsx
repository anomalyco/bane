import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent, type RefObject } from 'react'
import { ArrowUp, Check, Square, UserRound, X } from 'lucide-react'
import { Button, DropdownMenu, IconButton } from '../../components/ui'
import { SheetOpenEffects, useSheetDrag } from '../../components/ui/sheet'
import { useSession } from '../../data/context'
import { TOUCH, matches, usePhone, useTouch } from '../../lib/media'
import { Markdown, settled } from './markdown'
import { createDemoTransport } from './demo'
import { createSocketTransport, supportOrigin } from './socket'
import { supportStore, type ChatMessage, type ChatState, type Part, type SupportStore } from './store'
import { MAX_MESSAGE } from './protocol'
import './support.css'

const cx = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' ')
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

// The support chat (hosted): Bane's AI support agent in a panel docked at the bottom left on a desktop, where it grows
// out of the Help button and leaves the page readable beside it, and a sheet above the tab bar on a phone. It is not
// modal: on a desktop the page stays usable while the agent works, and the conversation carries on across pages.
export function SupportPanel({ mode, open, onClose, onUnread, resume }: { mode: 'demo' | 'live'; open: boolean; onClose: () => void; onUnread: (unread: boolean) => void; resume: string | null }) {
  const identity = useSession()?.identity ?? null
  const phone = usePhone(), touch = useTouch()
  const workspaceId = identity?.workspaceId ?? 'demo'
  const store = useMemo(() => supportStore(`${mode}:${workspaceId}`, () => {
    const origin = supportOrigin()
    if (mode === 'live' && origin) return createSocketTransport({ origin, workspaceId, resume })
    const workspace = identity?.workspaces?.find(item => item.id === identity.workspaceId)
    return createDemoTransport({ firstName: identity?.name?.trim().split(/\s+/)[0] || 'Ryan', workspace: { id: workspaceId, name: workspace?.name ?? 'Acme' } })
  }), [mode, workspaceId])
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const panel = useRef<HTMLElement>(null), input = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { store.setVisible(open); if (open) store.start() }, [store, open])
  useEffect(() => { onUnread(state.unread) }, [state.unread])
  // Opening moves focus in (to the message box, or the panel itself on a touch screen, so the keyboard doesn't jump up);
  // closing with focus inside returns it to the Help button.
  useEffect(() => {
    const el = panel.current
    if (!el) return
    if (open) { const frame = requestAnimationFrame(() => (touch ? el : input.current ?? el).focus({ preventScroll: true })); return () => cancelAnimationFrame(frame) }
    if (el.contains(document.activeElement)) document.getElementById('support-trigger')?.focus({ preventScroll: true })
  }, [open])
  const close = () => { panel.current?.style.removeProperty('transform'); onClose() }
  const drag = useSheetDrag(close, phone)
  const busy = state.busy || state.messages.some(message => message.streaming)
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    // Escape inside the panel closes it. A menu opened from it lives in a portal and handles its own Escape.
    if (event.key === 'Escape' && !event.defaultPrevented && panel.current?.contains(event.target as Node)) { event.preventDefault(); close() }
  }
  return <>
    {phone && <div className="support-overlay" data-open={open || undefined} aria-hidden="true" onClick={close} />}
    {phone && open && <SheetOpenEffects />}
    <section ref={panel} id="support-panel" className={cx('support-panel', phone && 'support-panel--sheet')} role="dialog" aria-modal="false" aria-labelledby="support-title"
      data-open={open || undefined} data-busy={busy || undefined} tabIndex={-1} onKeyDown={onKeyDown} {...drag}>
      {phone && <div className="ui-sheet__grab" aria-hidden="true"><span /></div>}
      <Header state={state} store={store} onClose={close} />
      <Conversation state={state} store={store} open={open} />
      <Composer state={state} store={store} input={input} busy={busy} />
      <div className="sr-only" role="status" aria-live="polite">{state.announcement}</div>
    </section>
  </>
}

function Header({ state, store, onClose }: { state: ChatState; store: SupportStore; onClose: () => void }) {
  const hello = state.hello
  const [tone, subtitle] = state.closed ? ['neutral', 'Conversation ended']
    : state.connection === 'offline' ? ['warning', 'Offline · reconnecting']
    : state.connection === 'unavailable' ? ['danger', 'Unavailable']
    : !hello ? ['neutral', 'Connecting…']
    : ['success', `${hello.agent.ai ? 'AI support agent' : 'Support'} · ${hello.workspace.name}`]
  const ticketed = state.status === 'ticketed' || state.humanRequested
  return <header className="support-panel__header">
    <span className="wordmark-square support-panel__mark" aria-hidden="true" />
    <div className="support-panel__heading">
      <h2 id="support-title">{hello?.agent.name ?? 'Bane support'}</h2>
      <p className="support-panel__subtitle" data-tone={tone}><span className="support-panel__dot" aria-hidden="true" /><span key={subtitle} className="support-panel__subtitle-text">{subtitle}</span></p>
    </div>
    <div className="support-panel__actions">
      <DropdownMenu label="Conversation options" title="Conversation" items={[
        { label: ticketed ? 'Passed to the Bane team' : 'Talk to a person', icon: <UserRound size={16} />, disabled: ticketed || state.connection !== 'open' || Boolean(state.closed), onSelect: () => store.requestHuman() },
        { label: 'End conversation', icon: <X size={16} />, disabled: Boolean(state.closed) || state.connection !== 'open', onSelect: () => store.end() },
      ]} />
      <IconButton label="Close" onClick={onClose}><X size={16} /></IconButton>
    </div>
  </header>
}

function Conversation({ state, store, open }: { state: ChatState; store: SupportStore; open: boolean }) {
  const scroller = useRef<HTMLDivElement>(null), inner = useRef<HTMLDivElement>(null), pinned = useRef(true), touched = useRef(0)
  // The log grows downward from the top, so new text never moves what is already on screen; while the reader is at the
  // bottom it follows the newest line by scrolling. Only the reader's own scrolling (wheel, touch, keys, the scrollbar)
  // lets go of the bottom; the browser clamping or re-anchoring the scroll position never does.
  useLayoutEffect(() => {
    const el = scroller.current, content = inner.current
    if (!el || !content) return
    const follow = () => { if (pinned.current) el.scrollTop = el.scrollHeight }
    const observer = new ResizeObserver(follow)
    observer.observe(content)
    follow()
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => { if (open && scroller.current) { pinned.current = true; scroller.current.scrollTop = scroller.current.scrollHeight } }, [open])
  const last = state.messages.at(-1)
  useLayoutEffect(() => { if (last?.role === 'user') pinned.current = true }, [last?.id])
  const streaming = state.messages.some(message => message.streaming)
  // Before the greeting starts, and while an answer is being thought about, a caret holds the agent's place.
  const typing = !state.closed && state.connection !== 'unavailable' && !streaming && (state.messages.length === 0 ? state.connection !== 'offline' : state.busy && last?.role === 'user')
  const touch = () => { touched.current = performance.now() }
  return <div ref={scroller} className="support-log" tabIndex={0} aria-label="Conversation" onWheel={touch} onTouchMove={touch} onKeyDown={touch} onPointerDown={touch}
    onScroll={event => {
      const el = event.currentTarget, atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      if (atBottom) pinned.current = true
      else if (performance.now() - touched.current < 600) pinned.current = false
    }}>
    <div ref={inner} className="support-log__inner">
      {state.messages.map(message => message.role === 'user' ? <UserMessage key={message.id} message={message} onRetry={() => store.retry()} /> : <AgentMessage key={message.id} message={message} store={store} />)}
      {typing && <p className="support-message support-typing" aria-label="Bane support is writing"><Caret /></p>}
      <InlineStatus state={state} store={store} />
    </div>
  </div>
}

function UserMessage({ message, onRetry }: { message: ChatMessage; onRetry: () => void }) {
  const text = message.parts.map(part => part.kind === 'text' ? part.text : '').join('')
  return <div className="support-message support-message--user" data-restored={message.restored || undefined}>
    <p className="support-user">{text}</p>
    {message.failed && <p className="support-failed"><span>{message.failed}</span><Button variant="ghost" size="sm" onClick={onRetry}>Try again</Button></p>}
  </div>
}

// An answer as it arrived: text, the quiet progress lines of what the agent checked, and the cards it asked for.
function AgentMessage({ message, store }: { message: ChatMessage; store: SupportStore }) {
  const groups: Array<{ key: string; tools: Extract<Part, { kind: 'tool' }>[] } | { key: string; part: Exclude<Part, { kind: 'tool' }>; index: number }> = []
  message.parts.forEach((part, index) => {
    const previous = groups.at(-1)
    if (part.kind === 'tool') { if (previous && 'tools' in previous) previous.tools.push(part); else groups.push({ key: `t${index}`, tools: [part] }) }
    else groups.push({ key: `p${index}`, part, index })
  })
  const lastPart = message.parts.at(-1)
  const waiting = message.streaming && lastPart?.kind !== 'text' && !message.parts.some(part => part.kind === 'tool' && part.state === 'running' || part.kind === 'consent' && (part.state === 'open' || part.state === 'allowing'))
  return <article className={cx('support-message', 'support-message--agent', message.kind === 'notice' && 'support-message--notice')} data-restored={message.restored || undefined}>
    {groups.map(group => 'tools' in group
      ? <ul key={group.key} className="support-tools">{group.tools.map(tool => <ToolLine key={tool.id} label={tool.label} state={tool.state} />)}</ul>
      : group.part.kind === 'text' ? <StreamText key={group.key} text={group.part.text} live={message.streaming} last={group.index === message.parts.length - 1} restored={message.restored} />
      : group.part.kind === 'consent' ? <ConsentCard key={group.key} part={group.part} onDecide={decision => { if (group.part.kind === 'consent') decide(store, group.part.request.requestId, decision) }} />
      : <TicketCard key={group.key} ticket={group.part.ticket} />)}
    {waiting && <p className="support-typing"><Caret /></p>}
  </article>
}

// A decision on the consent card hands the keyboard back to the message box (the card's buttons go away).
function decide(store: SupportStore, requestId: string, decision: 'allow' | 'deny') {
  store.consent(requestId, decision)
  if (!matches(TOUCH)) requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('#support-panel .support-composer__input')?.focus({ preventScroll: true }))
}

// Text that streams in: revealed at a steady pace that catches up when the stream runs ahead, with a caret at its end.
function StreamText({ text, live, last, restored }: { text: string; live: boolean; last: boolean; restored: boolean }) {
  // Only the message's last part can still grow; text followed by a step or a card is complete.
  const growing = live && last && !restored
  const shown = useSmoothText(text, growing)
  const revealing = shown.length < text.length
  return <div className="support-text"><Markdown text={growing || revealing ? settled(shown) : shown} tail={last && (growing || revealing) ? <Caret /> : null} /></div>
}
function useSmoothText(text: string, live: boolean) {
  const [count, setCount] = useState(() => live ? 0 : text.length)
  const position = useRef(count), previous = useRef(text)
  useEffect(() => {
    const before = previous.current
    previous.current = text
    // Replaced text (the output gate, or a final text that differs) shows at once; so does everything under reduced motion.
    if (!text.startsWith(before.slice(0, Math.floor(position.current))) || reducedMotion()) { position.current = text.length; setCount(text.length); return }
    if (position.current >= text.length) return
    let frame = 0, at = performance.now()
    const step = (now: number) => {
      const seconds = Math.min(64, now - at) / 1000
      at = now
      const backlog = text.length - position.current
      position.current = Math.min(text.length, position.current + Math.max(live ? 60 : 180, backlog * (live ? 4 : 9)) * seconds)
      setCount(Math.floor(position.current))
      if (position.current < text.length) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [text, live])
  // Whole words only, and a word still arriving waits for its end: a word that grows letter by letter can outgrow its
  // line and jump to the next, which moves text already on screen (a layout shift). A whole word lands where it stays.
  if (count >= text.length && !live) return text
  const shown = text.slice(0, count)
  const boundary = count >= text.length ? Math.max(shown.lastIndexOf(' '), shown.lastIndexOf('\n')) : Math.max(shown.lastIndexOf(' '), shown.lastIndexOf('\n'), /\s/.test(text[count] ?? '') ? count - 1 : -1)
  return shown.slice(0, boundary + 1)
}
// The caret is an empty inline box (no text, no inline-block), so moving along with the text never counts as a layout shift.
function Caret() { return <span className="support-caret" aria-hidden="true" /> }

function ToolLine({ label, state }: { label: string; state: 'running' | 'done' | 'failed' }) {
  const [previous, setPrevious] = useState<string | null>(null)
  const last = useRef(label)
  useEffect(() => {
    if (last.current === label) return
    setPrevious(last.current)
    last.current = label
    const timer = setTimeout(() => setPrevious(null), 260)
    return () => clearTimeout(timer)
  }, [label])
  return <li className="support-tool" data-state={state}>
    <span className="support-tool__mark" aria-hidden="true"><span className="support-tool__dot" /><Check className="support-tool__check" size={12} strokeWidth={2.5} /><X className="support-tool__fail" size={12} strokeWidth={2.5} /></span>
    <span className="support-tool__label" title={label}>
      {previous && <span key={`was:${previous}`} className="support-tool__text" data-leaving="" aria-hidden="true">{previous}</span>}
      <span key={label} className="support-tool__text" data-entering={previous ? '' : undefined}>{label}</span>
    </span>
  </li>
}

function ConsentCard({ part, onDecide }: { part: Extract<Part, { kind: 'consent' }>; onDecide: (decision: 'allow' | 'deny') => void }) {
  const decided = part.state === 'allow' || part.state === 'deny'
  return <div className="support-card support-consent" data-state={part.state} role="group" aria-label="Allow access to email content">
    <p className="support-card__title">Let Bane support read the content of your emails in <strong>{part.request.workspace.name}</strong> for this conversation.</p>
    <p className="support-card__body">{part.request.why}</p>
    <div className="support-card__actions">
      <div className="support-card__choice" data-active={!decided || undefined} aria-hidden={decided || undefined}>
        <Button variant="primary" size="sm" loading={part.state === 'allowing'} disabled={decided} tabIndex={decided ? -1 : undefined} onClick={() => onDecide('allow')}>Allow</Button>
        <Button size="sm" disabled={decided || part.state === 'allowing'} tabIndex={decided ? -1 : undefined} onClick={() => onDecide('deny')}>Not now</Button>
      </div>
      <p className="support-card__resolved" data-active={decided || undefined} data-decision={decided ? part.state : undefined} aria-hidden={!decided || undefined}>
        {part.state === 'deny' ? 'Not shared. Bane support won’t read your emails.' : <><Check size={14} strokeWidth={2.5} aria-hidden="true" />Allowed for this conversation</>}
      </p>
    </div>
  </div>
}

function TicketCard({ ticket }: { ticket: Extract<Part, { kind: 'ticket' }>['ticket'] }) {
  return <div className="support-card support-ticket" role="group" aria-label="Ticket filed">
    <span className="support-ticket__mark" aria-hidden="true"><Check size={12} strokeWidth={2.75} /></span>
    <div className="support-ticket__text">
      <p className="support-ticket__title"><span>Passed to the Bane team</span><code>{ticket.ticketId}</code></p>
      <p className="support-card__body">Someone will reply by email to <MaskedAddress value={ticket.replyTo} />, {ticket.expect}.</p>
    </div>
  </div>
}
// The reply address arrives masked ("a…@acme.com"). It reads like every address in the dashboard: its first characters,
// then a blurred run; the rest is never in the page.
function MaskedAddress({ value }: { value: string }) {
  const shown = [...value.split(/…|@/)[0]].slice(0, 2).join('')
  return <span className="support-masked" title="Hidden for privacy"><span>{shown}</span><span className="support-masked__rest" aria-hidden="true" /><span className="sr-only"> (address hidden)</span></span>
}

function InlineStatus({ state, store }: { state: ChatState; store: SupportStore }) {
  if (state.closed) return null
  if (state.connection === 'offline') return <div className="support-inline" data-tone="warning"><span className="support-inline__dot" aria-hidden="true" /><span>Can’t reach Bane support. Reconnecting when you’re back online.</span><Button variant="ghost" size="sm" onClick={() => store.reconnect()}>Try now</Button></div>
  if (state.connection === 'unavailable') return <div className="support-inline" data-tone="danger"><span className="support-inline__dot" aria-hidden="true" /><span>{state.reason === 'RATE_LIMITED' ? 'You’ve started a lot of conversations today. Try again later.' : 'Support chat isn’t available right now.'}</span>{state.reason !== 'RATE_LIMITED' && <Button variant="ghost" size="sm" onClick={() => store.reconnect()}>Try again</Button>}</div>
  if (state.limit) return <div className="support-inline" data-tone="warning"><span className="support-inline__dot" aria-hidden="true" /><span>{state.limit.message}</span></div>
  return null
}

function Composer({ state, store, input, busy }: { state: ChatState; store: SupportStore; input: RefObject<HTMLTextAreaElement | null>; busy: boolean }) {
  const [now, setNow] = useState(() => Date.now())
  const until = state.limit?.until ?? null
  useEffect(() => { if (until && until > Date.now()) { const timer = setTimeout(() => setNow(Date.now()), until - Date.now() + 50); return () => clearTimeout(timer) } }, [until])
  const limited = Boolean(state.limit && (state.limit.until === null || state.limit.until > now))
  // The box grows with what is typed, up to six lines, then scrolls.
  useLayoutEffect(() => { const el = input.current; if (!el) return; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 132)}px` }, [state.draft])
  if (state.closed) return <div className="support-composer support-composer--closed">
    <span>This conversation ended.</span>
    <Button size="sm" onClick={() => store.restart()}>Start a new conversation</Button>
  </div>
  const online = state.connection === 'open' && Boolean(state.hello)
  const empty = !state.draft.trim()
  const stop = busy && empty && online
  function submit(event?: FormEvent) {
    event?.preventDefault()
    if (stop) { store.cancel(); return }
    if (online && !limited) store.send()
  }
  return <form className="support-composer" onSubmit={submit}>
    <div className="support-composer__box" data-disabled={!online || limited || undefined}>
      <textarea ref={input} className="support-composer__input" rows={1} value={state.draft} maxLength={MAX_MESSAGE} aria-label="Message Bane support"
        placeholder={!online ? state.connection === 'offline' ? 'Waiting for the connection…' : 'Connecting…' : limited ? 'Messages are paused for now' : 'Ask anything about your sending'}
        onChange={event => store.setDraft(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit() } }} />
      <IconButton type="submit" variant={stop ? 'secondary' : 'primary'} size="sm" className="support-composer__send" label={stop ? 'Stop answering' : 'Send'} data-stop={stop || undefined} disabled={stop ? false : empty || !online || limited}>
        <span className="support-composer__icons" aria-hidden="true"><ArrowUp size={14} strokeWidth={2.25} /><Square size={9} strokeWidth={0} fill="currentColor" /></span>
      </IconButton>
    </div>
  </form>
}

