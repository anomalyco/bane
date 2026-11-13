import { attachmentLink } from './attachments.js';
import type { Env } from './env.js';
import { purposeKey, sign, verify } from './tokens.js';
import { TICKET_TYPES } from './agent/tools.js';
import { TYPE_LABEL } from './tickets.js';
import { log } from './log.js';
import { productName } from '../../api/src/brand.js';

// The internal ticket list (support.<host>/staff). Staff identity is Nightmail's operator check, never a password here:
// "Sign in" sends an operator to Nightmail's GET /v1/operator/support/staff-sign-in (their dashboard session, operators
// only), which redirects back with a 2-minute signed token. This Worker has Nightmail verify it over the SupportPlatform
// binding (verifyStaff: signature, audience, still an active operator), uses it once, and sets its own 8-hour,
// host-only, HttpOnly session cookie. Writes (marking a ticket done) also need the session's CSRF token and Origin.

const COOKIE = '__Host-bane-support-staff';
const SESSION_SECONDS = 8 * 3600;
/** How long one operator check is trusted (review Low): after this, a page load goes back through Nightmail's sign-in. */
const recheckSeconds = (env: Env) => { const v = Number((env as unknown as Record<string, unknown>).STAFF_RECHECK_SECONDS); return Number.isInteger(v) && v > 0 ? v : 3600; };
type Staff = { userId: string; email: string; role: string; exp: number; checked: number };

const b64url = (s: string) => btoa(unescape(encodeURIComponent(s))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const unb64url = (s: string) => decodeURIComponent(escape(atob(s.replaceAll('-', '+').replaceAll('_', '/'))));
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const key = (env: Env) => purposeKey(env.SUPPORT_ROOT_SECRET, 'staff/v1');

async function session(env: Env, request: Request): Promise<Staff | null> {
  const raw = request.headers.get('cookie')?.split(/;\s*/).find(c => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  const [v, payload, sig] = raw?.split('.') ?? [];
  if (v !== 's1' || !payload || !sig || !(await verify(await key(env), `s1.${payload}`, sig).catch(() => false))) return null;
  try { const staff = JSON.parse(unb64url(payload)) as Staff; return staff.exp * 1000 > Date.now() ? staff : null; } catch { return null; }
}
const csrf = async (env: Env, staff: Staff) => sign(await key(env), `csrf.${staff.userId}.${staff.exp}`);

const page = (title: string, body: string, status = 200, headers: HeadersInit = {}) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{font:14px/1.45 system-ui,sans-serif;margin:2rem auto;max-width:72rem;padding:0 1rem;color:#111}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:.45rem;text-align:left;vertical-align:top}th{font-weight:600}
details pre{white-space:pre-wrap;background:#f6f6f6;padding:.6rem;border-radius:.4rem}.pill{display:inline-block;padding:0 .45rem;border-radius:1rem;background:#eee}.P1{background:#fdd}.P2{background:#fed}form.inline{display:inline}img{max-width:16rem;max-height:10rem;border:1px solid #ddd;margin:.2rem}
nav a{margin-right:.6rem}button,select,input{font:inherit}</style></head><body>${body}</body></html>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', ...headers } });

const signIn = (env: Env, note = '') => page(`${productName} support staff`, `<h1>${productName} support tickets</h1>${note ? `<p>${esc(note)}</p>` : ''}<p>Staff only. Sign in with your ${productName} operator account.</p>
<p><a href="${esc(signInUrl(env))}">Sign in with ${productName}</a></p>`, note ? 403 : 200);
const signInUrl = (env: Env) => `${env.BANE_ORIGIN}/v1/operator/support/staff-sign-in?return=${encodeURIComponent(`${env.PUBLIC_URL}/staff/callback`)}`;

export async function staff(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url), path = url.pathname;
  if (path === '/staff/callback' && request.method === 'GET') return callback(env, url.searchParams.get('staff'));
  const who = await session(env, request);
  if (!who) return path === '/staff' || request.method === 'GET' ? signIn(env) : new Response(null, { status: 403 });
  // Re-check the operator role hourly: a GET goes back through Nightmail's sign-in (silent while their Nightmail session lasts,
  // refused if they're no longer an operator); a write with a stale check is refused.
  if (Date.now() / 1000 - who.checked > recheckSeconds(env)) {
    if (request.method !== 'GET') return page('Check again', '<h1>Your staff session needs a fresh check</h1><p>Reload the ticket page, then try again.</p>', 403);
    return new Response(null, { status: 303, headers: { location: signInUrl(env) } });
  }
  if (request.method === 'POST') {
    // Writes: same-origin form posts only, with the session's CSRF token.
    if (request.headers.get('origin') !== new URL(env.PUBLIC_URL).origin) return new Response(null, { status: 403 });
    const form = await request.formData().catch(() => null);
    if (!form || form.get('csrf') !== await csrf(env, who)) return new Response(null, { status: 403 });
    if (path === '/staff/sign-out') return new Response(null, { status: 303, headers: { location: '/staff', 'set-cookie': `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0` } });
    const resolve = path.match(/^\/staff\/tickets\/(tkt_[a-z2-7]{16})\/resolve$/);
    if (!resolve) return new Response(null, { status: 404 });
    const done = await env.DB.prepare("UPDATE tickets SET status = 'resolved', resolved_at = ?, resolved_by = ?, resolution = ?, updated_at = ? WHERE id = ? AND status <> 'resolved'")
      .bind(Date.now(), who.userId, String(form.get('resolution') ?? '').slice(0, 1000) || null, Date.now(), resolve[1]!).run();
    log('info', { event: 'staff', code: 'TICKET_RESOLVED', ticket: resolve[1], staff: who.userId, changed: done.meta.changes });
    return new Response(null, { status: 303, headers: { location: `/staff/tickets${url.search}` } });
  }
  if (path === '/staff' || path === '/staff/') return new Response(null, { status: 303, headers: { location: '/staff/tickets' } });
  if (path === '/staff/tickets') return list(env, who, url);
  return new Response(null, { status: 404 });
}

async function callback(env: Env, token: string | null): Promise<Response> {
  if (!token || token.length > 4096) return signIn(env, 'That sign-in link is not valid. Sign in again.');
  const checked = await env.BANE.verifyStaff(token);
  if (!checked.ok) return signIn(env, checked.code === 'NOT_OPERATOR' ? `Your account is not a ${productName} operator.` : 'That sign-in link expired or is not valid. Sign in again.');
  // Single use: a sign-in link replayed from history or a log opens nothing.
  const fresh = await env.DB.prepare('INSERT INTO staff_tokens_used (jti, used_at) VALUES (?, ?) ON CONFLICT (jti) DO NOTHING').bind(checked.jti, Date.now()).run();
  if (!fresh.meta.changes) return signIn(env, 'That sign-in link was already used. Sign in again.');
  const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const payload = b64url(JSON.stringify({ userId: checked.staff.userId, email: checked.staff.email, role: checked.staff.role, exp, checked: Math.floor(Date.now() / 1000) } satisfies Staff));
  const cookie = `s1.${payload}.${await sign(await key(env), `s1.${payload}`)}`;
  log('info', { event: 'staff', code: 'STAFF_SIGNED_IN', staff: checked.staff.userId });
  return new Response(null, { status: 303, headers: { location: '/staff/tickets', 'set-cookie': `${COOKIE}=${cookie}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}` } });
}

type Row = { id: string; conversation_id: string; channel: string; status: string; type: string; title: string; category: string; severity: string; due_at: number | null; customer: string; summary: string; ask: string; tried: string;
  recommendation: string; evidence: string; details: string; attachments: string; notes: string; created_at: number; resolved_at: number | null; resolution: string | null };

async function list(env: Env, who: Staff, url: URL): Promise<Response> {
  const type = url.searchParams.get('type'), status = url.searchParams.get('status') ?? 'open', id = url.searchParams.get('id');
  const where: string[] = [], binds: unknown[] = [];
  if (id) { where.push('id = ?'); binds.push(id); }
  else {
    if (type && (TICKET_TYPES as readonly string[]).includes(type)) { where.push('type = ?'); binds.push(type); }
    if (status !== 'all') { where.push(status === 'resolved' ? "status = 'resolved'" : "status <> 'resolved'"); }
  }
  const rows = (await env.DB.prepare(`SELECT * FROM tickets ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY (status = 'resolved'), severity, created_at DESC LIMIT 200`).bind(...binds).all<Row>()).results;
  const token = await csrf(env, who), q = url.search;
  const filter = `<form method="get" action="/staff/tickets"><select name="type"><option value="">All types</option>${TICKET_TYPES.map(t => `<option value="${t}"${t === type ? ' selected' : ''}>${esc(TYPE_LABEL[t])}</option>`).join('')}</select>
<select name="status">${['open', 'resolved', 'all'].map(s => `<option${s === status ? ' selected' : ''}>${s}</option>`).join('')}</select> <button>Filter</button></form>`;
  const body = await Promise.all(rows.map(async r => {
    const customer = JSON.parse(r.customer) as { email?: string; name?: string; role?: string; workspaces?: { id: string; name: string }[]; verified?: string | false; sender?: string; dmarc?: string };
    const details = JSON.parse(r.details) as { topic?: string; bug?: { reproSteps: string[]; affected: string; requestIds: string[]; errorCodes: string[]; expected: string; actual: string }; featureRequest?: { useCase: string }; deliverability?: { affected: string } };
    const shots = await Promise.all((JSON.parse(r.attachments) as string[]).map(async a => `<a href="${esc(await attachmentLink(env, r.conversation_id, { id: a }))}"><img alt="screenshot" src="${esc(await attachmentLink(env, r.conversation_id, { id: a }))}"></a>`));
    const bug = details.bug ? `<p><b>Reproduction</b></p><ol>${details.bug.reproSteps.map(s => `<li>${esc(s)}</li>`).join('')}</ol><p>Affected: <code>${esc(details.bug.affected)}</code><br>Request IDs: ${esc(details.bug.requestIds.join(', ') || '—')}<br>Errors: ${esc(details.bug.errorCodes.join(', ') || '—')}${details.bug.expected ? `<br>Expected: ${esc(details.bug.expected)}` : ''}${details.bug.actual ? `<br>Actual: ${esc(details.bug.actual)}` : ''}</p>` : '';
    const resolve = r.status === 'resolved' ? `<span class="pill">done${r.resolved_at ? ` ${esc(new Date(r.resolved_at).toISOString().slice(0, 10))}` : ''}</span>${r.resolution ? `<br>${esc(r.resolution)}` : ''}`
      : `<form class="inline" method="post" action="/staff/tickets/${esc(r.id)}/resolve${esc(q)}"><input type="hidden" name="csrf" value="${esc(token)}"><input name="resolution" placeholder="Resolution (optional)" maxlength="1000"> <button>Mark done</button></form>`;
    return `<tr><td><code>${esc(r.id)}</code><br>${esc(new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' '))}</td><td><span class="pill">${esc(TYPE_LABEL[r.type as keyof typeof TYPE_LABEL] ?? r.type)}</span> <span class="pill ${esc(r.severity)}">${esc(r.severity)}</span>${details.topic ? `<br>${esc(details.topic.replaceAll('_', ' '))}` : ''}</td>
<td><b>${esc(r.title || r.summary.slice(0, 80))}</b><details><summary>Details</summary><p>${esc(r.summary)}</p>${bug}${details.featureRequest ? `<p>Use case: ${esc(details.featureRequest.useCase)}</p>` : ''}${details.deliverability ? `<p>Affected: ${esc(details.deliverability.affected)}</p>` : ''}
<p><b>Asked</b> (untrusted)</p><pre>${esc(r.ask)}</pre><p><b>Checked</b></p><pre>${esc((JSON.parse(r.tried) as { tool: string; finding: string }[]).map(t => `${t.tool}: ${t.finding}`).join('\n') || '—')}</pre><p><b>Recommendation</b></p><pre>${esc(r.recommendation)}</pre>${shots.join('')}</details></td>
<td>${customer.verified === false ? `<span class="pill P1">${customer.dmarc === 'PASS' ? 'not a customer' : 'UNVERIFIED'}</span><br>${esc(customer.sender ?? '')}<br>DMARC ${esc(customer.dmarc ?? 'none')}` : `${esc(customer.name ?? '')}<br>${esc(customer.email ?? '')}<br>${esc((customer.workspaces ?? []).map(w => w.name).join(', '))}`}</td><td>${r.due_at ? esc(new Date(r.due_at).toISOString().slice(0, 16).replace('T', ' ')) : '—'}</td><td>${resolve}</td></tr>`;
  }));
  return page(`${productName} support tickets`, `<nav><b>${productName} support tickets</b> · ${esc(who.email)} <form class="inline" method="post" action="/staff/sign-out"><input type="hidden" name="csrf" value="${esc(token)}"><button>Sign out</button></form></nav>${filter}
<table><thead><tr><th>Ticket</th><th>Type</th><th>Title</th><th>Customer</th><th>Due (UTC)</th><th>Status</th></tr></thead><tbody>${body.join('') || '<tr><td colspan="6">No tickets.</td></tr>'}</tbody></table>`);
}
