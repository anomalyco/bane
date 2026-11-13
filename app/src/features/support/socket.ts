import { supportApi } from '../../data/support'
import { ApiError } from '../../data/types'
import { parseServerMessage, sniff, type ClientMessage, type Connection, type SupportTransport, type TransportEvent } from './protocol'

// The live transport (support/PROTOCOL.md §1–2, §5): a handoff from Bane, then /chat/start or /chat/resume on the support
// Worker, then one WebSocket. The conversation ID is kept per workspace in sessionStorage, so a reload reconnects to the
// same conversation; a lost connection retries with backoff and again as soon as the browser is back online.
type Started = { conversationId: string; chatToken: string; socketUrl: string; expiresAt: string }
class StartError extends Error { constructor(readonly status: number, readonly code: string, readonly retryAfter?: number) { super(code) } }

// What a reload needs to rejoin the conversation (PROTOCOL.md §1): its ID, and the socket URL until it expires.
type Saved = { conversationId: string; socketUrl?: string; expiresAt?: string }
const storageKey = (workspaceId: string) => `bane.support.conversation.${workspaceId}`
function load(key: string): Saved | null {
  let raw: string | null = null
  try { raw = sessionStorage.getItem(key) } catch { return null }
  if (!raw) return null
  try { const saved = JSON.parse(raw) as Saved; return typeof saved?.conversationId === 'string' ? saved : null } catch { return null }
}
const save = (key: string, value: Saved | null) => { try { if (value) sessionStorage.setItem(key, JSON.stringify(value)); else sessionStorage.removeItem(key) } catch { /* Session-only. */ } }
const fresh = (expiresAt?: string) => Boolean(expiresAt && Date.parse(expiresAt) - Date.now() > 60_000)

// A screenshot upload (§5.1) over XHR, which reports upload progress (fetch doesn't).
const UPLOAD_ERRORS: Record<string, string> = {
  TOO_MANY_ATTACHMENTS: 'Up to 5 screenshots per conversation.',
  CONVERSATION_CLOSED: 'This conversation has ended.',
  ATTACHMENT_TOO_LARGE: 'Screenshots can be up to 5 MB.',
  UNSUPPORTED_TYPE: 'Only PNG, JPEG or WebP images.',
  INVALID_IMAGE: 'The image is damaged or over 8,000 pixels on a side.',
}
function postImage(url: string, token: string, type: string, file: File, onProgress: (fraction: number) => void, signal: AbortSignal) {
  return new Promise<{ status: number; body: { attachment?: { id?: string }; error?: { code?: string } } | null }>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const abort = () => { xhr.abort(); reject(new DOMException('The upload was cancelled.', 'AbortError')) }
    xhr.open('POST', url)
    xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.setRequestHeader('Content-Type', type)
    if (file.name) xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name))
    // Held under 100% until the server has stored it.
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.min(.95, event.loaded / event.total)) }
    xhr.onload = () => { let body = null; try { body = JSON.parse(xhr.responseText) } catch { /* No JSON body. */ } resolve({ status: xhr.status, body }) }
    xhr.onerror = () => reject(new Error('Couldn’t reach Bane support. Try again.'))
    xhr.onloadend = () => signal.removeEventListener('abort', abort)
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    xhr.send(file)
  })
}

async function post(origin: string, path: string, body: unknown): Promise<Started> {
  let response: Response
  try { response = await fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }
  catch { throw new StartError(0, 'NETWORK') }
  const data = await response.json().catch(() => null) as (Started & { error?: { code?: string; retryAfter?: number } }) | null
  if (!response.ok || !data?.socketUrl) throw new StartError(response.status, data?.error?.code ?? 'UNAVAILABLE', data?.error?.retryAfter)
  return data
}
// The handoff from Bane. No token means support signing isn't configured here; a refusal (not a lost network) is final too.
const handoff = async (shareContent: boolean) => {
  let token: string | null
  try { ({ token } = await supportApi.contact({ shareContent })) }
  catch (error) { throw error instanceof ApiError && error.code !== 'NETWORK_UNAVAILABLE' ? new StartError(error.status ?? 400, error.code) : new StartError(0, 'NETWORK') }
  if (!token) throw new StartError(503, 'NO_HANDOFF')
  return token
}

export function createSocketTransport({ origin, workspaceId, resume }: { origin: string; workspaceId: string; resume?: string | null }): SupportTransport {
  const key = storageKey(workspaceId)
  if (resume) save(key, { conversationId: resume })
  const listeners = new Set<(event: TransportEvent) => void>()
  const emit = (event: TransportEvent) => { for (const listener of listeners) listener(event) }
  // After a reload, the saved socket URL reconnects directly while it is still valid.
  const saved = load(key)
  let socket: WebSocket | null = null, state: Connection = 'idle'
  let started: Started | null = saved?.socketUrl && fresh(saved.expiresAt) ? { conversationId: saved.conversationId, chatToken: '', socketUrl: saved.socketUrl, expiresAt: saved.expiresAt! } : null
  let attempt = 0, retry: ReturnType<typeof setTimeout> | undefined, ping: ReturnType<typeof setInterval> | undefined
  let disposed = false, generation = 0
  const setState = (next: Connection, extra: Omit<Extract<TransportEvent, { type: 'connection' }>, 'type' | 'state'> = {}) => { state = next; emit({ type: 'connection', state: next, ...extra }) }

  // /chat/resume for a known conversation (a fresh handoff each time), else /chat/start. One retry on a rejected handoff.
  async function open(): Promise<Started> {
    const conversationId = load(key)?.conversationId
    for (let tries = 0; ; tries++) {
      try {
        const token = await handoff(false)
        return conversationId ? await post(origin, '/chat/resume', { conversationId, handoff: token }) : await post(origin, '/chat/start', { handoff: token })
      } catch (error) {
        if (!(error instanceof StartError)) throw error
        if (conversationId && error.status === 404) { save(key, null); return open() }
        if (tries === 0 && (error.code === 'HANDOFF_INVALID' || error.code === 'HANDOFF_USED')) continue
        throw error
      }
    }
  }
  function schedule() {
    if (disposed) return
    const delay = Math.min(30_000, 1000 * 2 ** attempt++)
    setState('offline', { retryAt: Date.now() + delay })
    clearTimeout(retry)
    retry = setTimeout(connect, delay)
  }
  function teardown() {
    clearInterval(ping); ping = undefined
    if (socket) { socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null; socket.close(1000); socket = null }
  }
  async function connect() {
    if (disposed || state === 'connecting' || (state === 'open' && socket)) return
    clearTimeout(retry)
    const current = ++generation
    setState('connecting')
    teardown()
    try {
      // A chat token that hasn't expired reconnects directly; otherwise renew it through /chat/resume.
      if (!started || !fresh(started.expiresAt)) started = await open()
    } catch (error) {
      if (current !== generation) return
      if (error instanceof StartError && error.code === 'RATE_LIMITED') { setState('unavailable', { reason: 'RATE_LIMITED', retryAt: Date.now() + (error.retryAfter ?? 60) * 1000 }); return }
      if (error instanceof StartError && (error.code === 'NO_HANDOFF' || error.status >= 400 && error.status < 500 && error.status !== 408)) { setState('unavailable', { reason: error.code }); return }
      schedule()
      return
    }
    if (current !== generation || disposed) return
    save(key, { conversationId: started.conversationId, socketUrl: started.socketUrl, expiresAt: started.expiresAt })
    let opened = false
    const ws = socket = new WebSocket(started.socketUrl)
    ws.onopen = () => {
      opened = true; attempt = 0
      setState('open')
      ping = setInterval(() => send({ type: 'ping' }), 30_000)
    }
    ws.onmessage = event => {
      const message = parseServerMessage(event.data)
      if (!message) return
      // GRANT_EXPIRED: account access ended; a fresh handoff renews it and the agent carries on.
      if (message.type === 'error' && message.code === 'GRANT_EXPIRED') { started = null; teardown(); state = 'idle'; void connect(); return }
      if (message.type === 'error' && message.code === 'BAD_MESSAGE') console.warn('[support] the server refused a message from the panel', message.message)
      emit({ type: 'server', message })
    }
    ws.onclose = event => {
      if (socket !== ws) return
      teardown()
      // 1000: the conversation ended (a closed message came first); nothing to reconnect to.
      if (opened && event.code === 1000) { setState('idle'); return }
      // Refused before opening (an expired or revoked token), or closed for an expired token: renew, then reconnect. An
      // expired token renews at once, without showing the conversation as offline.
      if (!opened || event.code === 4401 || event.code === 1008) started = null
      state = 'idle'
      if (opened && event.code === 4401) void connect()
      else schedule()
    }
  }
  function send(message: ClientMessage) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(message))
    return true
  }
  const online = () => { if (state === 'offline') { attempt = 0; void connect() } }
  window.addEventListener('online', online)
  return {
    kind: 'live',
    connect: () => { attempt = 0; void connect() },
    send,
    async allowContent(requestId) {
      try { if (send({ type: 'consent.respond', requestId, decision: 'allow', handoff: await handoff(true) })) return } catch { /* Not allowed: answer no. */ }
      send({ type: 'consent.respond', requestId, decision: 'deny' })
    },
    uploads: true,
    // POST /c/<conversationId>/attachments with the chat token (the one in the socket URL after a reload). A rejected
    // token renews through /chat/resume, then the upload is tried once more.
    async upload(file, onProgress, signal) {
      const type = await sniff(file)
      if (!type) throw new Error(UPLOAD_ERRORS.UNSUPPORTED_TYPE)
      for (let tries = 0; ; tries++) {
        if (!started) throw new Error('Not connected to Bane support yet. Try again in a moment.')
        const token = started.chatToken || new URL(started.socketUrl).searchParams.get('token') || ''
        const { status, body } = await postImage(`${origin}/c/${encodeURIComponent(started.conversationId)}/attachments`, token, type, file, onProgress, signal)
        if (status === 201 && body?.attachment?.id) return { id: body.attachment.id }
        if (status === 401 && tries === 0) { started = null; generation++; teardown(); state = 'idle'; await connect(); continue }
        throw new Error(UPLOAD_ERRORS[body?.error?.code ?? ''] ?? 'The upload failed. Try again.')
      }
    },
    restart() { save(key, null); started = null; generation++; teardown(); state = 'idle'; attempt = 0; void connect() },
    dispose() { disposed = true; generation++; clearTimeout(retry); teardown(); window.removeEventListener('online', online); listeners.clear() },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}

/** The support Worker for this dashboard: VITE_SUPPORT_ORIGIN, else support.<host> for bane.mx and dev.bane.mx. */
export function supportOrigin(): string | null {
  const configured = import.meta.env.VITE_SUPPORT_ORIGIN as string | undefined
  if (configured) return configured.replace(/\/$/, '')
  const host = window.location.hostname
  return host === 'bane.mx' || host === 'dev.bane.mx' ? `https://support.${host}` : null
}
