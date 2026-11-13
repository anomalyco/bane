import { verifyWebhook } from './webhook.js';
import type { Env } from './env.js';
import { addressHash, chatToken, MissingSecret, newId, readChatToken, readConfirmToken } from './tokens.js';
import { readAttachmentLink, readCapped, serveAttachment } from './attachments.js';
import { MAX_IMAGE_BYTES } from './image.js';
import { staff } from './staff.js';
import { daily } from './limits.js';
import { log, logError } from './log.js';
import { addresses, productName } from '../../api/src/brand.js';
export { SupportConversation } from './conversation.js';
export { SupportIntake, INTAKE, type Mailbox } from './intake.js';
import { INTAKE, type Mailbox } from './intake.js';

// The support Worker (support/README.md): chat starts and resumes, the conversation WebSocket, Nightmail's inbound webhook
// for support@bane.mx, and the "Confirm it's me" page. Every conversation is one SupportConversation Durable Object,
// reached only by ID from this router, never through a client-named route.

const CONVERSATIONS_PER_DAY = 10;
const json = (body: unknown, status = 200, headers: HeadersInit = {}) => Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
// The error code of each refusal, for the request line (read without parsing the body).
const failures = new WeakMap<Response, string>();
const fail = (status: number, code: string, message: string, headers: HeadersInit = {}, extra: Record<string, unknown> = {}) => {
  const response = json({ error: { code, message, ...extra } }, status, headers);
  failures.set(response, code);
  return response;
};
const CONVERSATION_ID = /^conv_[a-z2-7]{26}$/;

function allowedOrigin(env: Env, request: Request) {
  const origin = request.headers.get('origin');
  return origin && env.DASHBOARD_ORIGINS.split(',').map(o => o.trim()).includes(origin) ? origin : null;
}
function cors(env: Env, request: Request): Record<string, string> {
  const origin = allowedOrigin(env, request);
  return origin ? { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization, x-filename', 'access-control-max-age': '600', vary: 'origin' } : {};
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
  if (!allowedOrigin(env, request)) return fail(403, 'ORIGIN_NOT_ALLOWED', `Open support from the ${productName} dashboard.`);
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
  if ((today?.n ?? 0) >= CONVERSATIONS_PER_DAY) return fail(429, 'RATE_LIMITED', `You can start ${CONVERSATIONS_PER_DAY} support conversations a day. Continue an earlier one, or email ${addresses.support}.`, { ...headers, 'retry-after': '3600' }, { retryAfter: 3600 });
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
  if (!allowedOrigin(env, request)) return fail(403, 'ORIGIN_NOT_ALLOWED', `Open support from the ${productName} dashboard.`);
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

/** A screenshot from the panel: the chat token in Authorization, the raw image as the body (support/PROTOCOL.md §5.1). */
async function upload(request: Request, env: Env, conversationId: string): Promise<Response> {
  const headers = cors(env, request);
  if (!allowedOrigin(env, request)) return fail(403, 'ORIGIN_NOT_ALLOWED', `Upload from the ${productName} dashboard.`);
  const token = request.headers.get('authorization')?.match(/^Bearer (\S+)$/)?.[1] ?? null;
  const reader = await readChatToken(env.SUPPORT_ROOT_SECRET, token, conversationId);
  if (!reader) return fail(401, 'CHAT_TOKEN_INVALID', 'Renew the conversation through /chat/resume.', headers);
  const tooLarge = async () => {
    // Read and drop a modestly oversized body so the client sees the 413 instead of a reset connection; give up past 12 MB.
    const reader = request.body?.getReader();
    for (let seen = 0; reader && seen < 12 * 1024 * 1024;) { const { done, value } = await reader.read(); if (done) break; seen += value.length; }
    await reader?.cancel().catch(() => {});
    return fail(413, 'ATTACHMENT_TOO_LARGE', 'Images can be up to 5 MB.', headers);
  };
  if (Number(request.headers.get('content-length') ?? 0) > MAX_IMAGE_BYTES) return tooLarge();
  const bytes = await readCapped(request.body, MAX_IMAGE_BYTES);
  if (!bytes) return tooLarge();
  if (!bytes.length) return fail(400, 'INVALID_REQUEST', 'Send the image bytes as the request body.', headers);
  let name: string | null = null; try { name = decodeURIComponent(request.headers.get('x-filename') ?? '') || null; } catch { name = null; }
  const added = await conversation(env, conversationId).addAttachment({ userId: reader.userId, bytes, declared: request.headers.get('content-type'), name });
  return added.ok ? json({ attachment: added.attachment }, 201, headers) : fail(added.status, added.code, added.message, headers);
}

type Hook = { type?: string; data?: { messageId?: string; recipients?: string[]; message?: { id?: string; threadId?: string | null; direction?: string; from?: { address?: string }; to?: unknown } } };

/** A verified, parsed Nightmail webhook delivery, deduplicated by webhook-id (after parsing, so a malformed one is retried). */
async function delivery(request: Request, env: Env, secret: string | undefined, name: string): Promise<{ event: Hook; deliveryId: string } | Response> {
  if (!secret) throw new MissingSecret(name);
  const body = await request.text();
  if (body.length > 1_000_000 || !(await verifyWebhook(body, request.headers, secret))) return new Response(null, { status: 401 });
  let event: Hook;
  try { event = JSON.parse(body); } catch { return new Response(null, { status: 400 }); }
  // A global brake before anything is recorded: Nightmail retries a 503 later (review M5).
  if (env.EMAIL_IN_GLOBAL && !(await env.EMAIL_IN_GLOBAL.limit({ key: 'global' })).success) return new Response(null, { status: 503, headers: { 'retry-after': '60' } });
  const deliveryId = request.headers.get('webhook-id')!;
  const fresh = await env.DB.prepare('INSERT INTO webhook_deliveries (id, received_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING').bind(deliveryId, Date.now()).run();
  if (!fresh.meta.changes) return new Response(null, { status: 200 });
  return { event, deliveryId };
}

/** Nightmail's signed webhook for mail received at support@bane.mx (route → webhook:support-agent, bane format, include message). */
async function inbound(request: Request, env: Env): Promise<Response> {
  const got = await delivery(request, env, env.BANE_INBOUND_WEBHOOK_SECRET, 'BANE_INBOUND_WEBHOOK_SECRET');
  if (got instanceof Response) return got;
  const { event, deliveryId } = got, message = event.data?.message, messageId = message?.id ?? event.data?.messageId;
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
  // The Durable Object stores the message and arms its alarm before this returns, so Nightmail's retry is never needed
  // once we answer 200: the DO is the durable inbox.
  await conversation(env, row.id).enqueueInbound({ conversationId: row.id, threadId, messageId, deliveryId });
  return new Response(null, { status: 200 });
}

/** abuse@, privacy@, legal@ (route → webhook:support-intake): tickets only, never the agent (intake.ts). */
async function intake(request: Request, env: Env): Promise<Response> {
  const got = await delivery(request, env, env.BANE_INTAKE_WEBHOOK_SECRET, 'BANE_INTAKE_WEBHOOK_SECRET');
  if (got instanceof Response) return got;
  const { event } = got, message = event.data?.message, messageId = message?.id ?? event.data?.messageId;
  if (event.type !== 'message.received' || !messageId || message?.direction === 'outbound') return new Response(null, { status: 200 });
  // The envelope recipients Nightmail matched (so Bcc counts), else the To header.
  const recipients = (event.data?.recipients?.length ? event.data.recipients : [JSON.stringify(message?.to ?? '')]).join(' ').toLowerCase();
  const mailbox = env.INTAKE_ADDRESSES.split(',').map(a => a.trim().toLowerCase()).filter(a => a && recipients.includes(a)).map(a => a.split('@')[0] as Mailbox).find(m => m in INTAKE);
  if (!mailbox) return new Response(null, { status: 200 });
  const threadId = message?.threadId ?? messageId;
  await env.INTAKE.get(env.INTAKE.idFromName(threadId)).enqueue({ threadId, messageId, mailbox });
  return new Response(null, { status: 200 });
}

const page = (title: string, body: string, status = 200) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.25rem;color:#111}button{font:inherit;padding:.6rem 1.1rem;border-radius:.5rem;border:1px solid #111;background:#111;color:#fff;cursor:pointer}p.muted{color:#666;font-size:.9rem}</style></head><body>${body}</body></html>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'", 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' } });
const escape = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/** "Confirm it's me": GET shows a button (mail scanners prefetch links, so GET never confirms); POST confirms once. */
async function confirm(request: Request, env: Env, token: string): Promise<Response> {
  const read = await readConfirmToken(env.SUPPORT_ROOT_SECRET, token);
  if (!read) return page('Link expired', `<h1>This link has expired</h1><p>Reply to the support email again and we’ll send a new one, or sign in to ${productName} and press Help.</p>`, 410);
  if (request.method === 'GET') {
    // Nothing from the email (its subject or text) is shown here: the sender may not be who they say (review M4).
    if (!(await conversation(env, read.conversationId).confirmationPending(read.addressHash))) return page('Link expired', `<h1>This link has expired</h1><p>Sign in to ${productName} and press Help instead.</p>`, 410);
    return page('Confirm it’s you', `<h1>Confirm it’s you</h1><p>${productName} support will read your ${productName} account to answer the email you sent to ${productName} support. Only press this if you wrote to ${productName} support yourself.</p>
<form method="post"><button type="submit">Confirm it’s me</button></form><p class="muted">Didn’t write to ${productName} support? Close this page; nothing happens.</p>`);
  }
  const used = await env.DB.prepare('INSERT INTO confirmations (nonce, conversation_id, used_at) VALUES (?, ?, ?) ON CONFLICT (nonce) DO NOTHING').bind(read.nonce, read.conversationId, Date.now()).run();
  if (!used.meta.changes) return page('Already confirmed', '<h1>Already confirmed</h1><p>You can close this page. We’ll reply by email.</p>');
  const result = await conversation(env, read.conversationId).confirmEmail({ addressHash: read.addressHash });
  return result.ok ? page('Confirmed', '<h1>Thanks, that’s confirmed</h1><p>We’ll reply to your email shortly. You can close this page.</p>')
    : page('Couldn’t confirm', `<h1>We couldn’t confirm this</h1><p>Sign in to ${productName} and press Help, or reply to the email from your account address.</p>`, 409);
}

// Route templates for the request line, never the raw path: paths carry conversation and ticket IDs and confirm tokens,
// and queries carry chat tokens and attachment signatures.
const STAFF_ROUTES = new Set(['/staff', '/staff/', '/staff/callback', '/staff/sign-out', '/staff/tickets', '/staff/tickets/:ticketId/resolve']);
function staffRoute(path: string) {
  const route = path.replace(/^\/staff\/tickets\/tkt_[a-z2-7]{16}\/resolve$/, '/staff/tickets/:ticketId/resolve');
  return STAFF_ROUTES.has(route) ? route : '/staff/*';
}

async function route(request: Request, env: Env, url: URL, at: { route: string }): Promise<Response> {
  const path = url.pathname, name = (route: string) => { at.route = route; };
  if (path === '/health') { name('/health'); return json({ status: 'ok', service: 'bane-support', stage: env.STAGE }); }
  if (request.method === 'OPTIONS' && (path.startsWith('/chat/') || /^\/c\/conv_[a-z2-7]{26}\/attachments$/.test(path))) {
    name(path.startsWith('/chat/') ? '/chat/*' : '/c/:conversationId/attachments');
    return new Response(null, { status: allowedOrigin(env, request) ? 204 : 403, headers: cors(env, request) });
  }
  if (request.method === 'POST' && path === '/chat/start') { name('/chat/start'); return startChat(request, env); }
  if (request.method === 'POST' && path === '/chat/resume') { name('/chat/resume'); return resumeChat(request, env); }
  const chat = path.match(/^\/c\/(conv_[a-z2-7]{26})$/);
  if (chat && request.method === 'GET') { name('/c/:conversationId'); return socket(request, env, chat[1]!); }
  const uploads = path.match(/^\/c\/(conv_[a-z2-7]{26})\/attachments$/);
  if (uploads && request.method === 'POST') { name('/c/:conversationId/attachments'); return upload(request, env, uploads[1]!); }
  const file = path.match(/^\/attachments\/(conv_[a-z2-7]{26})\/(att_[a-z2-7]{16})$/);
  if (file && request.method === 'GET') {
    name('/attachments/:conversationId/:attachmentId');
    return await readAttachmentLink(env, file[1]!, file[2]!, url.searchParams.get('exp'), url.searchParams.get('sig')) ? serveAttachment(env, file[1]!, file[2]!) : new Response(null, { status: 403 });
  }
  if (path === '/staff' || path.startsWith('/staff/')) { name(staffRoute(path)); return staff(request, env); }
  if (request.method === 'POST' && path === '/hooks/bane-inbound') { name('/hooks/bane-inbound'); return inbound(request, env); }
  if (request.method === 'POST' && path === '/hooks/bane-intake') { name('/hooks/bane-intake'); return intake(request, env); }
  const link = path.match(/^\/confirm\/([A-Za-z0-9_.-]{20,400})$/);
  if (link && (request.method === 'GET' || request.method === 'POST')) { name('/confirm/:token'); return confirm(request, env, link[1]!); }
  return new Response(null, { status: 404 });
}

export default {
  async fetch(request, env): Promise<Response> {
    const started = Date.now(), at = { route: 'unmatched' };
    let response: Response, failed: { error: unknown; code: string } | null = null;
    try { response = await route(request, env, new URL(request.url), at); }
    catch (error) {
      // Fail closed, loudly: a missing secret is a deploy mistake, never a reason to run without it.
      const missing = error instanceof MissingSecret ? error.secret : null;
      failed = { error, code: missing ? 'SECRET_MISSING' : 'UNHANDLED' };
      response = fail(503, 'SUPPORT_UNAVAILABLE', missing ? `Support is not fully configured (${missing} is missing).` : 'Support is unavailable right now. Try again in a minute.', cors(env, request));
    }
    // One line per request, like Nightmail's (api/src/app.ts): what answered, how, and how long it took; a crash adds its
    // error class, the missing secret's name and the stack to that same line.
    const status = response.status, line = { event: 'request', requestId: request.headers.get('cf-ray') ?? undefined, route: at.route, method: request.method, status, durationMs: Date.now() - started };
    if (failed) logError(failed.error, { ...line, code: failed.code });
    else log(status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info', { ...line, code: failures.get(response) });
    return response;
  },
  /** Daily at 00:10 UTC: the team's over-cap digest for yesterday, and the retention sweep. */
  async scheduled(controller, env, ctx) {
    const started = Date.now();
    ctx.waitUntil(daily(env, controller.scheduledTime).then(
      result => log('info', { event: 'scheduled', code: 'SUPPORT_DAILY', durationMs: Date.now() - started, ...result }),
      error => logError(error, { event: 'scheduled', code: 'SUPPORT_DAILY_FAILED', durationMs: Date.now() - started })));
  },
} satisfies ExportedHandler<Env>;
