// The support chat protocol, v1 (support/PROTOCOL.md on the support Worker's side): one conversation over one
// WebSocket. Unknown fields are ignored and unknown types skipped, so the server can add both without breaking an older
// panel. The scripted demo transport (demo.ts) speaks the same messages.

export type MessageKind = 'first' | 'reply' | 'notice'
export type ConversationStatus = 'open' | 'ticketed' | 'closed'
export type Decision = 'allow' | 'deny'

export interface ConsentRequest { requestId: string; workspace: { id: string; name: string }; why: string }
export interface TicketFiled {
  ticketId: string
  /** refund, billing_dispute, account_closure, limit_increase, enforcement_review, legal, security, abuse_report, bug, human_requested or other. */
  category: string
  replyTo: string
  expect: string
  /** Provisional (not in v1 yet): screenshots attached to the ticket, and the person it went to. */
  attachments?: number
  assignee?: { name: string } | null
}
export interface HistoryMessage { id: string; role: 'assistant' | 'user'; kind?: MessageKind; text: string; at: string; tools?: { id: string; label: string; ok: boolean }[] }
export type ErrorCode = 'GRANT_EXPIRED' | 'RATE_LIMITED' | 'TURN_FAILED' | 'BAD_MESSAGE' | 'BUDGET_EXHAUSTED' | (string & {})

type Server<T> = T & { v: 1; seq: number }
export type ServerMessage =
  | Server<{ type: 'hello'; conversationId: string; channel: 'chat' | 'email'; status: ConversationStatus; agent: { name: string; ai: boolean }; customer: { firstName: string | null }; workspace: { id: string; name: string }; contentAccess: boolean; busy: boolean }>
  | Server<{ type: 'history'; messages: HistoryMessage[]; pending: { consent: ConsentRequest | null; ticket: TicketFiled | null } }>
  | Server<{ type: 'status'; busy: boolean }>
  | Server<{ type: 'message.start'; messageId: string; kind: MessageKind }>
  | Server<{ type: 'text.delta'; messageId: string; delta: string }>
  | Server<{ type: 'message.end'; messageId: string; text: string; redacted: boolean }>
  | Server<{ type: 'tool.start'; messageId: string; toolCallId: string; tool: string; label: string }>
  | Server<{ type: 'tool.end'; toolCallId: string; ok: boolean; label: string }>
  | Server<{ type: 'consent.request' } & ConsentRequest>
  | Server<{ type: 'consent.resolved'; requestId: string; decision: Decision }>
  | Server<{ type: 'ticket.filed' } & TicketFiled>
  | Server<{ type: 'error'; code: ErrorCode; message: string; retryable: boolean; retryAfter?: number }>
  | Server<{ type: 'closed'; reason: 'idle' | 'limit' | 'ended' }>
  | { type: 'pong' }

export type ClientMessage =
  | { type: 'user.message'; clientMessageId: string; text: string; images?: string[] }
  | { type: 'consent.respond'; requestId: string; decision: 'allow'; handoff: string }
  | { type: 'consent.respond'; requestId: string; decision: 'deny' }
  | { type: 'human.request' }
  | { type: 'cancel' }
  | { type: 'feedback'; rating: 'up' | 'down' }
  | { type: 'end' }
  | { type: 'ping' }

/** The longest message the server accepts. */
export const MAX_MESSAGE = 8000
// Screenshots. Provisional until the upload section of support/PROTOCOL.md lands: the limits are the Worker's
// (support/src/image.ts), which checks the bytes again and strips their metadata. The panel checks first, so a wrong file
// is refused before it is sent anywhere.
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_IMAGES = 5

const known = new Set(['hello', 'history', 'status', 'message.start', 'text.delta', 'message.end', 'tool.start', 'tool.end', 'consent.request', 'consent.resolved', 'ticket.filed', 'error', 'closed', 'pong'])
/** A frame from the socket, or null when it isn't a v1 message this panel knows (skipped, as the protocol asks). */
export function parseServerMessage(data: unknown): ServerMessage | null {
  if (typeof data !== 'string') return null
  let value: unknown
  try { value = JSON.parse(data) } catch { return null }
  if (!value || typeof value !== 'object') return null
  const message = value as { type?: unknown; v?: unknown }
  if (typeof message.type !== 'string' || !known.has(message.type)) return null
  if (message.type !== 'pong' && message.v !== 1) return null
  return value as ServerMessage
}

// Connection state, from the transport (not part of the wire protocol).
export type Connection = 'idle' | 'connecting' | 'open' | 'offline' | 'unavailable'
export type TransportEvent =
  | { type: 'server'; message: ServerMessage }
  | { type: 'connection'; state: Connection; retryAt?: number; reason?: string }

/** What the panel talks to: the support Worker's socket (socket.ts) or the scripted demo (demo.ts). */
export interface SupportTransport {
  readonly kind: 'live' | 'demo'
  /** Opens (or resumes) the conversation. Safe to call again after going offline. */
  connect(): void
  send(message: ClientMessage): boolean
  /** Allow on a consent card: gets a handoff that shares content, then answers the request with it (deny if that fails). */
  allowContent(requestId: string): Promise<void>
  /** Forgets this conversation and opens a new one. */
  restart(): void
  /** Whether this transport takes screenshots (the live Worker will once its upload flow lands). */
  readonly uploads: boolean
  /** Uploads one screenshot, reporting progress from 0 to 1; the returned ID goes in user.message's images. */
  upload(file: Blob, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<{ imageId: string }>
  /** Closes the socket for good (a workspace switch). */
  dispose(): void
  subscribe(listener: (event: TransportEvent) => void): () => void
}
