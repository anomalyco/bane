import { verifyWebhook } from './webhook.js';
import type { Env } from './env.js';
import { addressHash, chatToken, MissingSecret, newId, readChatToken, readConfirmToken } from './tokens.js';
export { SupportConversation } from './conversation.js';

// The support Worker (support/README.md): chat starts and resumes, the conversation WebSocket, Bane's inbound webhook
// for support@bane.mx, and the "Confirm it's me" page. Every conversation is one SupportConversation Durable Object,
// reached only by ID from this router, never through a client-named route.

const CONVERSATIONS_PER_DAY = 10;
const json = (body: unknown, status = 200, headers: HeadersInit = {}) => Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
const fail = (status: number, code: string, message: string, headers: HeadersInit = {}, extra: Record<string, unknown> = {}) => json({ error: { code, message, ...extra } }, status, headers);
const CONVERSATION_ID = /^conv_[a-z2-7]{26}$/;

function allowedOrigin(env: Env, request: Request) {
  const origin = request.headers.get('origin');
  return origin && env.DASHBOARD_ORIGINS.split(',').map(o => o.trim()).includes(origin) ? origin : null;
}
function cors(env: Env, request: Request): Record<string, string> {
  const origin = allowedOrigin(env, request);
  return origin ? { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600', vary: 'origin' } : {};
}
const socketUrl = (env: Env, conversationId: string, token: string) => `${env.PUBLIC_URL.replace(/^http/, 'ws')}/c/${conversationId}?token=${encodeURIComponent(token)}`;
const conversation = (env: Env, id: string) => env.CONVERSATION.get(env.CONVERSATION.idFromName(id));

async function readHandoff(request: Request): Promise<{ handoff?: string; conversationId?: string } | null> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return null;
  const text = await request.text();
  if (text.length > 8192) return null;
  try { const body = JSON.parse(text) as Record<string, unknown>; return { handoff: typeof body.handoff === 'string' ? body.handoff : undefined, conversationId: typeof body.conversationId === 'string' ? body.conversationId : undefined }; } catch { return null; }
}

async function startChat(request: Request, env: Env): Promise<Response> {
  const headers = cors(env, request);
  if (!allowedOrigin(env, request)) return fail(403, 'ORIGIN_NOT_ALLOWED', 'Open support from the Bane dashboard.');
  const body = await readHandoff(request);
  if (!body?.handoff) return fail(400, 'INVALID_REQUEST', 'Send { "handoff": "<token from /v1/contact-support>" }.', headers);
  const checked = await env.BANE.verifyHandoff(body.handoff);
  if (!checked.ok) return checked.code === 'SUPPORT_NOT_CONFIGURED' ? fail(503, 'SUPPORT_UNAVAILABLE', 'Support chat is not configured on this installation.', headers)
    : fail(401, 'HANDOFF_INVALID', 'That handoff is not valid or has expired. Get a fresh one and retry.', headers);
  const { handoff } = checked;
  if (handoff.usedAt) return fail(409, 'HANDOFF_USED', 'This handoff already opened a conversation. Get a fresh one.', headers);
  if (env.CHAT_START && !(await env.CHAT_START.limit({ key: `user:${handoff.userId}` })).success) return fail(429, 'RATE_LIMITED', 'Too many conversations started. Try again in a minute.', { ...headers, 'retry-after': '60' }, { retryAfter: 60 });
  const now = Date.now(), dayAgo = now - 86_400_000;
  const today = await env.DB.prepare('SELECT count(*) AS n FROM conversations WHERE user_id = ? AND created_at > ?').bind(handoff.userId, dayAgo).first<{ n: number }>();
  if ((today?.n ?? 0) >= CONVERSATIONS_PER_DAY) return fail(429, 'RATE_LIMITED', `You can start ${CONVERSATIONS_PER_DAY} support conversations a day. Continue an earlier one, or email support@bane.mx.`, { ...headers, 'retry-after': '3600' }, { retryAfter: 3600 });
  const conversationId = newId('conv');
  // The handoff's jti opens one conversation; the unique key makes a concurrent replay lose.
  const claimed = await env.DB.batch([
    env.DB.prepare('INSERT INTO handoffs_used (jti, conversation_id, used_at) VALUES (?, ?, ?) ON CONFLICT (jti) DO NOTHING').bind(handoff.id, conversationId, now),
    env.DB.prepare(`INSERT INTO conversations (id, channel, user_id, email, workspace_id, workspace_name, created_at, updated_at)
      SELECT ?, 'chat', ?, ?, ?, ?, ?, ? WHERE (SELECT conversation_id FROM handoffs_used WHERE jti = ?) = ?`).bind(conversationId, handoff.userId, handoff.email, handoff.workspace.id, handoff.workspace.name, now, now, handoff.id, conversationId),
  ]);
  if (!claimed[1]?.meta.changes) return fail(409, 'HANDOFF_USED', 'This handoff already opened a conversation. Get a fresh one.', headers);
  const opened = await conversation(env, conversationId).openChat({ conversationId, handoff });
  if (!opened.ok) {
    await env.DB.prepare("UPDATE conversations SET status = 'closed', closed_at = ? WHERE id = ?").bind(Date.now(), conversationId).run();
    return opened.code === 'HANDOFF_USED' ? fail(409, 'HANDOFF_USED', 'This handoff already opened a conversation. Get a fresh one.', headers)
      : fail(503, 'SUPPORT_UNAVAILABLE', 'Support could not open your account just now. Try again in a minute.', headers);
  }
  const chat = await chatToken(env.SUPPORT_ROOT_SECRET, conversationId, handoff.userId);
  return json({ conversationId, chatToken: chat.token, socketUrl: socketUrl(env, conversationId, chat.token), expiresAt: chat.expiresAt }, 200, headers);
}

async function resumeChat(request: Request, env: Env): Promise<Response> {
  const headers = cors(env, request);
  if (!allowedOrigin(env, request)) return fail(403, 'ORIGIN_NOT_ALLOWED', 'Open support from the Bane dashboard.');
  const body = await readHandoff(request);
  if (!body?.handoff || !body.conversationId || !CONVERSATION_ID.test(body.conversationId)) return fail(400, 'INVALID_REQUEST', 'Send { "conversationId", "handoff" }.', headers);
  const checked = await env.BANE.verifyHandoff(body.handoff);
  if (!checked.ok) return fail(401, 'HANDOFF_INVALID', 'That handoff is not valid or has expired. Get a fresh one and retry.', headers);
  if (checked.handoff.usedAt) return fail(409, 'HANDOFF_USED', 'This handoff was already used. Get a fresh one.', headers);
  const row = await env.DB.prepare('SELECT user_id, status FROM conversations WHERE id = ?').bind(body.conversationId).first<{ user_id: string | null; status: string }>();
  if (!row || row.status === 'closed') return fail(404, 'CONVERSATION_NOT_FOUND', 'That conversation has ended. Start a new one.', headers);
  if (row.user_id !== checked.handoff.userId) return fail(403, 'NOT_YOUR_CONVERSATION', 'This conversation belongs to someone else.', headers);
  const claimed = await env.DB.prepare('INSERT INTO handoffs_used (jti, conversation_id, used_at) VALUES (?, ?, ?) ON CONFLICT (jti) DO NOTHING').bind(checked.handoff.id, body.conversationId, Date.now()).run();
  if (!claimed.meta.changes) return fail(409, 'HANDOFF_USED', 'This handoff was already used. Get a fresh one.', headers);
  const renewed = await conversation(env, body.conversationId).renewGrant({ handoff: checked.handoff });
  if (!renewed.ok) return fail(503, 'SUPPORT_UNAVAILABLE', 'Support could not renew access just now. Try again in a minute.', headers);
  const chat = await chatToken(env.SUPPORT_ROOT_SECRET, body.conversationId, checked.handoff.userId);
  return json({ conversationId: body.conversationId, chatToken: chat.token, socketUrl: socketUrl(env, body.conversationId, chat.token), expiresAt: chat.expiresAt }, 200, headers);
}

async function socket(request: Request, env: Env, conversationId: string): Promise<Response> {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response(null, { status: 426 });
  if (!allowedOrigin(env, request)) return new Response(null, { status: 403 });
  const reader = await readChatToken(env.SUPPORT_ROOT_SECRET, new URL(request.url).searchParams.get('token'), conversationId);
  if (!reader) return new Response(null, { status: 401 });
  const row = await env.DB.prepare('SELECT user_id, status FROM conversations WHERE id = ?').bind(conversationId).first<{ user_id: string | null; status: string }>();
  if (!row || row.user_id !== reader.userId) return new Response(null, { status: 404 });
  // The DO trusts this header only from this router: the Durable Object has no public route of its own.
  const forwarded = new Request(request.url, request);
  forwarded.headers.set('x-support-user', reader.userId);
  return conversation(env, conversationId).fetch(forwarded);
}

/** Bane's signed webhook for mail received at support@bane.mx (route → webhook:support-agent, bane format, include message). */
async function inbound(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!env.BANE_INBOUND_WEBHOOK_SECRET) throw new MissingSecret('BANE_INBOUND_WEBHOOK_SECRET');
  const body = await request.text();
  if (body.length > 1_000_000 || !(await verifyWebhook(body, request.headers, env.BANE_INBOUND_WEBHOOK_SECRET))) return new Response(null, { status: 401 });
  const deliveryId = request.headers.get('webhook-id')!;
  const fresh = await env.DB.prepare('INSERT INTO webhook_deliveries (id, received_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING').bind(deliveryId, Date.now()).run();
  if (!fresh.meta.changes) return new Response(null, { status: 200 });
  let event: { type?: string; data?: { messageId?: string; message?: { id?: string; threadId?: string | null; direction?: string; from?: { address?: string } } } };
  try { event = JSON.parse(body); } catch { return new Response(null, { status: 400 }); }
  const message = event.data?.message, messageId = message?.id ?? event.data?.messageId;
  if (event.type !== 'message.received' || !messageId || message?.direction === 'outbound') return new Response(null, { status: 200 });
  const threadId = message?.threadId ?? messageId, sender = message?.from?.address?.toLowerCase() ?? 'unknown';
  if (env.EMAIL_IN && !(await env.EMAIL_IN.limit({ key: `sender:${await addressHash(sender)}` })).success) return new Response(null, { status: 200 });
  const now = Date.now();
  let row = await env.DB.prepare('SELECT id, status FROM conversations WHERE thread_id = ?').bind(threadId).first<{ id: string; status: string }>();
  if (!row) {
    const id = newId('conv');
    await env.DB.prepare("INSERT INTO conversations (id, channel, thread_id, created_at, updated_at) VALUES (?, 'email', ?, ?, ?) ON CONFLICT (thread_id) DO NOTHING").bind(id, threadId, now, now).run();
    row = await env.DB.prepare('SELECT id, status FROM conversations WHERE thread_id = ?').bind(threadId).first<{ id: string; status: string }>();
  }
  if (!row) return new Response(null, { status: 503 });
  // The Durable Object stores the message and arms its alarm before this returns, so Bane's retry is never needed
  // once we answer 200: the DO is the durable inbox.
  await conversation(env, row.id).enqueueInbound({ conversationId: row.id, threadId, messageId, deliveryId });
  return new Response(null, { status: 200 });
}

const page = (title: string, body: string, status = 200) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.25rem;color:#111}button{font:inherit;padding:.6rem 1.1rem;border-radius:.5rem;border:1px solid #111;background:#111;color:#fff;cursor:pointer}p.muted{color:#666;font-size:.9rem}</style></head><body>${body}</body></html>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'", 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' } });
const escape = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/** "Confirm it's me": GET shows a button (mail scanners prefetch links, so GET never confirms); POST confirms once. */
async function confirm(request: Request, env: Env, token: string): Promise<Response> {
  const read = await readConfirmToken(env.SUPPORT_ROOT_SECRET, token);
  if (!read) return page('Link expired', '<h1>This link has expired</h1><p>Reply to the support email again and we’ll send a new one, or sign in to Bane and press Help.</p>', 410);
  if (request.method === 'GET') {
    const subject = await conversation(env, read.conversationId).confirmationSubject(read.addressHash);
    if (subject === null) return page('Link expired', '<h1>This link has expired</h1><p>Sign in to Bane and press Help instead.</p>', 410);
    return page('Confirm it’s you', `<h1>Confirm it’s you</h1><p>Bane support will read your account to answer your email${subject ? ` “${escape(subject)}”` : ''}. Only press this if you sent it.</p>
<form method="post"><button type="submit">Confirm it’s me</button></form><p class="muted">Didn’t write to Bane support? Close this page; nothing happens.</p>`);
  }
  const used = await env.DB.prepare('INSERT INTO confirmations (nonce, conversation_id, used_at) VALUES (?, ?, ?) ON CONFLICT (nonce) DO NOTHING').bind(read.nonce, read.conversationId, Date.now()).run();
  if (!used.meta.changes) return page('Already confirmed', '<h1>Already confirmed</h1><p>You can close this page. We’ll reply by email.</p>');
  const result = await conversation(env, read.conversationId).confirmEmail({ addressHash: read.addressHash });
  return result.ok ? page('Confirmed', '<h1>Thanks, that’s confirmed</h1><p>We’ll reply to your email shortly. You can close this page.</p>')
    : page('Couldn’t confirm', '<h1>We couldn’t confirm this</h1><p>Sign in to Bane and press Help, or reply to the email from your account address.</p>', 409);
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url), path = url.pathname;
    try {
      if (path === '/health') return json({ status: 'ok', service: 'bane-support', stage: env.STAGE });
      if (request.method === 'OPTIONS' && path.startsWith('/chat/')) return new Response(null, { status: allowedOrigin(env, request) ? 204 : 403, headers: cors(env, request) });
      if (request.method === 'POST' && path === '/chat/start') return await startChat(request, env);
      if (request.method === 'POST' && path === '/chat/resume') return await resumeChat(request, env);
      const chat = path.match(/^\/c\/(conv_[a-z2-7]{26})$/);
      if (chat && request.method === 'GET') return await socket(request, env, chat[1]!);
      if (request.method === 'POST' && path === '/hooks/bane-inbound') return await inbound(request, env, ctx);
      const link = path.match(/^\/confirm\/([A-Za-z0-9_.-]{20,400})$/);
      if (link && (request.method === 'GET' || request.method === 'POST')) return await confirm(request, env, link[1]!);
      return new Response(null, { status: 404 });
    } catch (error) {
      // Fail closed, loudly: a missing secret is a deploy mistake, never a reason to run without it.
      const missing = error instanceof MissingSecret ? error.secret : null;
      console.error(JSON.stringify({ level: 'error', code: missing ? 'SECRET_MISSING' : 'UNHANDLED', secret: missing, route: path, message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) }));
      return fail(503, 'SUPPORT_UNAVAILABLE', missing ? `Support is not fully configured (${missing} is missing).` : 'Support is unavailable right now. Try again in a minute.', cors(env, request));
    }
  },
} satisfies ExportedHandler<Env>;
