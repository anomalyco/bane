import type { ConsentRequest, Connection, ConversationStatus, MessageKind, ServerMessage, SupportTransport, TicketFiled, TransportEvent } from './protocol'
import { MAX_MESSAGE } from './protocol'

// One conversation's state, built from the transport's events. It lives outside React (one per workspace, see
// supportStore), so the conversation, the draft and the unread mark survive navigation, a resize that swaps the shell, and
// closing the panel.
export type ToolState = 'running' | 'done' | 'failed'
export type Part =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; label: string; state: ToolState }
  | { kind: 'consent'; request: ConsentRequest; state: 'open' | 'allowing' | 'allow' | 'deny' }
  | { kind: 'ticket'; ticket: TicketFiled }
export interface ChatMessage { id: string; role: 'assistant' | 'user'; kind: MessageKind; parts: Part[]; streaming: boolean; restored: boolean; failed?: string }
type Hello = Extract<ServerMessage, { type: 'hello' }>
export interface ChatState {
  connection: Connection
  retryAt: number | null
  reason: string | null
  hello: Hello | null
  status: ConversationStatus
  messages: ChatMessage[]
  busy: boolean
  closed: 'idle' | 'limit' | 'ended' | null
  /** A conversation-wide limit from the server: RATE_LIMITED (until a time) or BUDGET_EXHAUSTED. */
  limit: { code: string; message: string; until: number | null } | null
  humanRequested: boolean
  draft: string
  unread: boolean
  /** The latest finished message or card, for screen readers (the visible log doesn't announce streaming text). */
  announcement: string
}

const initial = (): ChatState => ({ connection: 'idle', retryAt: null, reason: null, hello: null, status: 'open', messages: [], busy: false, closed: null, limit: null, humanRequested: false, draft: '', unread: false, announcement: '' })
const flat = (text: string) => text.replace(/\s+/g, ' ').trim()
const textOf = (message: ChatMessage) => message.parts.flatMap(part => part.kind === 'text' ? [part.text] : []).join('\n\n')
const id = () => `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

export class SupportStore {
  private state: ChatState = initial()
  private listeners = new Set<() => void>()
  private visible = false
  private lastUserMessage: { clientMessageId: string; text: string } | null = null
  private readonly unsubscribe: () => void

  constructor(readonly transport: SupportTransport) {
    this.unsubscribe = transport.subscribe(event => this.handle(event))
  }
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  readonly getSnapshot = () => this.state
  private set(patch: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>)) {
    this.state = { ...this.state, ...typeof patch === 'function' ? patch(this.state) : patch }
    for (const listener of this.listeners) listener()
  }
  private update(messageId: string, change: (message: ChatMessage) => ChatMessage) {
    this.set(state => ({ messages: state.messages.map(message => message.id === messageId ? change(message) : message) }))
  }
  // The assistant message a tool step, card or ticket belongs to: the one being written, else the last one.
  private current() { return [...this.state.messages].reverse().find(message => message.role === 'assistant' && message.streaming) ?? [...this.state.messages].reverse().find(message => message.role === 'assistant') }
  private append(part: Part, messageId?: string) {
    const target = (messageId && this.state.messages.find(message => message.id === messageId)) || this.current()
    if (target) this.update(target.id, message => ({ ...message, parts: [...message.parts, part] }))
    else this.set(state => ({ messages: [...state.messages, { id: `local_${state.messages.length}`, role: 'assistant', kind: 'reply', parts: [part], streaming: false, restored: false }] }))
  }

  setVisible(visible: boolean) { this.visible = visible; if (visible && this.state.unread) this.set({ unread: false }) }
  start() { if (this.state.connection === 'idle' && !this.state.hello) this.transport.connect() }
  reconnect() { this.transport.connect() }
  setDraft(draft: string) { this.set({ draft: draft.slice(0, MAX_MESSAGE) }) }
  send() {
    const text = this.state.draft.trim()
    if (!text) return false
    const clientMessageId = id()
    // In the log before it goes out: an answer can start the moment the server has it.
    const before = this.state
    this.set(state => ({ draft: '', messages: [...state.messages, { id: clientMessageId, role: 'user', kind: 'reply', parts: [{ kind: 'text', text }], streaming: false, restored: false }] }))
    if (!this.transport.send({ type: 'user.message', clientMessageId, text })) { this.set({ draft: before.draft, messages: before.messages }); return false }
    this.lastUserMessage = { clientMessageId, text }
    return true
  }
  /** TURN_FAILED: resend the same message (the server ignores a clientMessageId it already accepted). */
  retry() {
    const last = this.lastUserMessage
    if (!last || !this.transport.send({ type: 'user.message', ...last })) return
    this.update(last.clientMessageId, message => ({ ...message, failed: undefined }))
  }
  consent(requestId: string, decision: 'allow' | 'deny') {
    this.setConsent(requestId, decision === 'allow' ? 'allowing' : 'deny')
    if (decision === 'deny') this.transport.send({ type: 'consent.respond', requestId, decision: 'deny' })
    else void this.transport.allowContent(requestId)
  }
  private setConsent(requestId: string, state: 'open' | 'allowing' | 'allow' | 'deny') {
    this.set(current => ({ messages: current.messages.map(message => message.parts.some(part => part.kind === 'consent' && part.request.requestId === requestId)
      ? { ...message, parts: message.parts.map(part => part.kind === 'consent' && part.request.requestId === requestId ? { ...part, state } : part) } : message) }))
  }
  cancel() { this.transport.send({ type: 'cancel' }) }
  requestHuman() { if (this.transport.send({ type: 'human.request' })) this.set({ humanRequested: true }) }
  end() { this.transport.send({ type: 'end' }) }
  restart() { this.lastUserMessage = null; this.set({ ...initial(), draft: this.state.draft }); this.transport.restart() }
  dispose() { this.unsubscribe(); this.transport.dispose(); this.listeners.clear() }

  private handle(event: TransportEvent) {
    if (event.type === 'connection') { this.set({ connection: event.state, retryAt: event.retryAt ?? null, reason: event.reason ?? null }); return }
    const message = event.message
    switch (message.type) {
      case 'hello':
        this.set({ hello: message, status: message.status, busy: message.busy, closed: message.status === 'closed' ? 'ended' : null })
        break
      case 'history': {
        // History replaces what the panel shows; an open consent card or a filed ticket comes back with it.
        const messages: ChatMessage[] = message.messages.map(item => ({ id: item.id, role: item.role, kind: item.kind ?? 'reply', restored: true, streaming: false,
          parts: [...(item.tools ?? []).map(tool => ({ kind: 'tool' as const, id: tool.id, label: tool.label, state: tool.ok ? 'done' as const : 'failed' as const })), ...item.text ? [{ kind: 'text' as const, text: item.text }] : []] }))
        this.set({ messages })
        if (message.pending.consent) this.append({ kind: 'consent', request: message.pending.consent, state: 'open' })
        if (message.pending.ticket) this.append({ kind: 'ticket', ticket: message.pending.ticket })
        break
      }
      case 'status': this.set({ busy: message.busy }); break
      case 'message.start':
        if (this.state.messages.some(item => item.id === message.messageId)) break
        this.set(state => ({ messages: [...state.messages, { id: message.messageId, role: 'assistant', kind: message.kind, parts: [], streaming: true, restored: false }] }))
        break
      case 'text.delta':
        this.update(message.messageId, item => {
          const last = item.parts.at(-1)
          return { ...item, parts: last?.kind === 'text' ? [...item.parts.slice(0, -1), { kind: 'text', text: last.text + message.delta }] : [...item.parts, { kind: 'text', text: message.delta.replace(/^\n+/, '') }] }
        })
        break
      case 'message.end': {
        // The final text is what counts: when the output gate replaced it, or it differs from what streamed, it replaces
        // the streamed text (tool steps and cards stay where they were).
        const item = this.state.messages.find(entry => entry.id === message.messageId)
        if (!item) break
        const replace = message.redacted || flat(textOf(item)) !== flat(message.text)
        const first = item.parts.findIndex(part => part.kind === 'text')
        const parts: Part[] = !replace ? item.parts : [...item.parts.filter(part => part.kind !== 'text')]
        if (replace && message.text) parts.splice(first < 0 ? parts.length : Math.min(first, parts.length), 0, { kind: 'text', text: message.text })
        this.update(item.id, entry => ({ ...entry, parts, streaming: false }))
        this.set({ announcement: `${this.state.hello?.agent.name ?? 'Bane support'}: ${message.text}`, unread: this.state.unread || !this.visible })
        break
      }
      case 'tool.start': this.append({ kind: 'tool', id: message.toolCallId, label: message.label, state: 'running' }, message.messageId); break
      case 'tool.end':
        this.set(state => ({ messages: state.messages.map(item => item.parts.some(part => part.kind === 'tool' && part.id === message.toolCallId)
          ? { ...item, parts: item.parts.map(part => part.kind === 'tool' && part.id === message.toolCallId ? { ...part, label: message.label, state: message.ok ? 'done' : 'failed' } : part) } : item) }))
        break
      case 'consent.request':
        this.append({ kind: 'consent', request: { requestId: message.requestId, workspace: message.workspace, why: message.why }, state: 'open' })
        this.set({ announcement: `Bane support asks to read the content of your emails in ${message.workspace.name}. ${message.why}`, unread: this.state.unread || !this.visible })
        break
      case 'consent.resolved': this.setConsent(message.requestId, message.decision); break
      case 'ticket.filed':
        this.append({ kind: 'ticket', ticket: { ticketId: message.ticketId, category: message.category, replyTo: message.replyTo, expect: message.expect } })
        this.set({ status: 'ticketed', humanRequested: true, announcement: `Passed to the Bane team as ${message.ticketId}. Someone will reply by email, ${message.expect}.` })
        break
      case 'error':
        if (message.code === 'TURN_FAILED') {
          const last = this.lastUserMessage
          if (last) this.update(last.clientMessageId, item => ({ ...item, failed: message.message || 'Couldn’t answer that.' }))
          this.set(state => ({ busy: false, messages: state.messages.map(item => item.streaming ? { ...item, streaming: false } : item) }))
        } else if (message.code === 'RATE_LIMITED') this.set({ limit: { code: message.code, message: message.message, until: Date.now() + (message.retryAfter ?? 60) * 1000 } })
        else if (message.code === 'BUDGET_EXHAUSTED') this.set({ limit: { code: message.code, message: message.message, until: null } })
        break
      case 'closed':
        this.set(state => ({ closed: message.reason, status: 'closed', busy: false, messages: state.messages.map(item => item.streaming ? { ...item, streaming: false } : item) }))
        break
    }
  }
}

// One store per workspace (and mode). Switching workspace starts a new conversation, as the protocol asks.
let current: { key: string; store: SupportStore } | null = null
export function supportStore(key: string, create: () => SupportTransport) {
  if (current?.key !== key) { current?.store.dispose(); current = { key, store: new SupportStore(create()) } }
  return current.store
}
