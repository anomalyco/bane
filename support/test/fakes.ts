// Test doubles for the support Worker's integration tests: a fake Nightmail (the SupportPlatform entrypoint over RPC and the
// public API it calls with the inbox key) and a scripted Anthropic Messages API standing in for Console's gateway.
// No network, no real model: the model's moves are decided from the request body, so retries and replays stay stable.

import { pngWithMetadata } from './images.js';

export const GRANT_TOKEN = `bane_support_${'5'.repeat(64)}`;
const EMAIL_PNG = Buffer.from(pngWithMetadata(80, 40)).toString('base64');

/** The fake Nightmail, as a Worker module (it must export a real WorkerEntrypoint for RPC). */
export const FAKE_BANE = `
import { WorkerEntrypoint } from 'cloudflare:workers';
const calls = [];
const used = new Set();
const shared = new Set();
let grants = 0;
const ok = (body, status = 200) => ({ status, body, requestId: 'req_' + '0'.repeat(32), retryAfter: null });
const handoff = token => {
  // Test handoffs are "handoff:<id>:<userId>:<workspaceId>:<share>".
  const [kind, id, userId, workspaceId, share] = token.split(':');
  if (kind !== 'handoff') return null;
  return { id, kind: 'support', userId, email: userId === 'usr_ada' ? 'ada@acme.test' : 'bo@other.test', role: 'owner', workspace: { id: workspaceId, name: workspaceId === 'ws_acme' ? 'Acme Prod' : 'Other' },
    page: '/campaigns', requestIds: [], shareContent: share === 'share', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(), usedAt: used.has(id) ? new Date().toISOString() : null, grantId: null, message: null };
};
const READS = {
  '/v1/support/context': { grant: { id: 'sgr_x', ticketRef: 'conv' }, user: { id: 'usr_ada', name: 'Ada Lovelace', email: 'ada@acme.test' },
    workspaces: [{ id: 'ws_acme', name: 'Acme Prod', role: 'owner', sending: { kind: 'shared', region: 'us-east-2', paused: false }, counts: { domains: 1, campaigns: 3 } }],
    domains: [{ workspaceId: 'ws_acme', id: 'dom_1', name: 'news.acme.test', sending: 'verified', dmarc: 'missing' }], recentFailures: { sends: [], bounces: [], webhookDeliveries: [] },
    standing: [], recentActivity: [], openEnforcement: [], handoff: null, links: { requestIds: [] } },
  '/v1/support/campaigns': { data: [{ id: 'cmp_1', name: 'Early access', state: 'sent', launchedAt: new Date(Date.now() - 86400000).toISOString(), tracking: true, audience: { size: 2160 }, pauseReason: null,
    stats: { counts: { total: 2160, byStatus: { delivered: 2140 } }, totals: { accepted: 2152, delivered: 2140, opened: 899, clicked: 64, bounced: 12, complained: 0 }, rates: {} } }] },
  '/v1/support/standing': { data: [{ workspaceId: 'ws_acme', standing: { step: 'normal', score: 93, dailyLimit: 10000 }, last24h: { delivered: 1980, bounced: 20 } }] },
  '/v1/support/requests': { available: true, retention: '3 days', groups: [{ route: '/v1/webhooks/:id/test', method: 'POST', status: 500, code: 'INTERNAL_ERROR', principal: 'apiKey', count: 14,
    firstSeen: new Date(Date.now() - 7200000).toISOString(), lastSeen: new Date().toISOString(), sampleRequestIds: ['req_' + 'a'.repeat(32), 'req_' + 'b'.repeat(32)] }], totals: { errors: 14 } },
  '/v1/support/deliverability/bounces': { data: [{ provider: 'gmail', type: 'bounce', count: 61, diagnostic: 'smtp; 550 5.1.1 user unknown at someone@gmail.com from 203.0.113.9' }], findings: [{ severity: 'serious', code: 'HARD_BOUNCES', message: '6.1% hard bounces at Gmail' }], grant: { token: 'never-shown' }, operatorId: 'op_secret' },
};
export class SupportPlatform extends WorkerEntrypoint {
  async verifyHandoff(token) { calls.push(['verifyHandoff', token]); const h = handoff(token); if (h?.shareContent) shared.add(h.id); return h ? { ok: true, handoff: h } : { ok: false, code: 'HANDOFF_INVALID' }; }
  async verifyEmail(body) {
    calls.push(['verifyEmail', body]);
    // Every @acme.test address is a Nightmail user (Ada, plus the review PoCs' victim@ and vera@).
    const local = body.email.endsWith('@acme.test') ? body.email.split('@')[0] : null;
    return local ? ok({ verified: true, user: { id: local === 'ada' ? 'usr_ada' : 'usr_' + local, name: local === 'ada' ? 'Ada Lovelace' : local[0].toUpperCase() + local.slice(1) }, workspaces: [{ id: 'ws_acme', name: 'Acme Prod', role: 'owner' }] }) : ok({ verified: false, user: null, workspaces: [] });
  }
  async mintGrant(body) {
    calls.push(['mintGrant', body]);
    if (body.handoffId) { if (used.has(body.handoffId)) return ok({ error: { code: 'SUPPORT_HANDOFF_USED' } }, 409); used.add(body.handoffId); }
    grants += 1;
    return ok({ id: 'sgr_' + String(grants).padStart(32, '0'), token: '${GRANT_TOKEN}', userId: body.userId, workspaceIds: body.workspaceIds ?? ['ws_acme'], ticketRef: body.ticketRef,
      contentShared: shared.has(body.handoffId), contentWorkspaceId: shared.has(body.handoffId) ? 'ws_acme' : null, expiresAt: new Date(Date.now() + 7200000).toISOString() }, 201);
  }
  async verifyStaff(token) {
    calls.push(['verifyStaff', token]);
    // Test staff tokens are "staff:<jti>:<userId>:<ok|demoted|expired>".
    const [kind, jti, userId, state] = token.split(':');
    if (kind !== 'staff') return { ok: false, code: 'STAFF_INVALID' };
    if (state === 'demoted') return { ok: false, code: 'NOT_OPERATOR' };
    if (state === 'expired') return { ok: false, code: 'STAFF_EXPIRED' };
    return { ok: true, staff: { userId, email: userId + '@anoma.ly', role: 'operator:read' }, jti, expiresAt: new Date(Date.now() + 120000).toISOString() };
  }
  async revokeGrant(id) { calls.push(['revokeGrant', id]); return ok({ id, revoked: true }); }
  async read(path, grant) {
    calls.push(['read', path, grant === '${GRANT_TOKEN}' ? 'GRANT' : grant]);
    if (grant !== '${GRANT_TOKEN}') return ok({ error: { code: 'SUPPORT_GRANT_REQUIRED' } }, 403);
    const body = READS[path.split('?')[0]];
    return body ? ok(body) : ok({ error: { code: 'NOT_FOUND', message: 'nope' } }, 404);
  }
}
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/__calls') return Response.json(calls);
    const body = request.method === 'POST' ? await request.json() : null;
    calls.push(['api', request.method, url.pathname, body, request.headers.get('authorization'), request.headers.get('idempotency-key')]);
    // Like Nightmail: inbox keys get an attachment as a short-lived signed link (on Nightmail's origin for R2-stored mail), and
    // never the admin-only parts route.
    if (request.method === 'GET' && /^\\/v1\\/inbound\\/messages\\/[^/]+\\/attachments\\/part_png$/.test(url.pathname)) return Response.json({ url: url.origin + '/v1/objects/fixture-png.sig', expiresAt: new Date(Date.now() + 300_000).toISOString() });
    if (request.method === 'GET' && url.pathname === '/v1/objects/fixture-png.sig') return new Response(Uint8Array.from(atob('${EMAIL_PNG}'), c => c.charCodeAt(0)), { headers: { 'content-type': 'image/png' } });
    if (request.method === 'GET' && /^\\/v1\\/inbound\\/messages\\/[^/]+\\/parts\\//.test(url.pathname)) return Response.json({ error: { code: 'ADMIN_REQUIRED' } }, { status: 403 });
    if (request.method === 'GET' && url.pathname.startsWith('/v1/inbound/messages/') && url.searchParams.get('includeDelivery') === 'true') return Response.json({ error: { code: 'ADMIN_REQUIRED' } }, { status: 403 });
    if (request.method === 'GET' && url.pathname.startsWith('/v1/inbound/messages/')) {
      const id = url.pathname.split('/').pop();
      // id → [thread, from, dmarc, to, subject, text]; unknown ids are Ada's Gmail question.
      const table = {
        msg_mail_1: ['thr_mail_1'], msg_mail_2: ['thr_mail_1'], msg_nodmarc_1: ['thr_nodmarc', null, 'FAIL'], msg_auto_1: ['thr_auto'], msg_image_1: ['thr_image'],
        msg_nodmarc_spoof: ['thr_mail_1', null, 'FAIL', null, 'Refund', 'refund my top-up please'], msg_stranger_1: ['thr_mail_1', 'stranger@else.test'],
        msg_phish_1: ['thr_phish', null, 'PASS', null, 'Reset', 'Please send me the reset link'],
        msg_stranger_cap_1: ['thr_cap_1', 'stranger@else.test'], msg_stranger_cap_2: ['thr_cap_2', 'stranger@else.test'], msg_stranger_cap_3: ['thr_cap_3', 'stranger@else.test'],
        msg_nodmarc_c1: ['thr_c1', null, 'FAIL'], msg_nodmarc_c2: ['thr_c2', null, 'FAIL'],
        msg_abuse_1: ['thr_abuse', 'reporter@isp.test', 'PASS', 'abuse@dev.bane.mx', 'Spam from your customer', 'Your customer sends us spam. Headers attached.'],
        msg_abuse_2: ['thr_abuse', 'reporter@isp.test', 'PASS', 'abuse@dev.bane.mx', 'Re: Spam from your customer', 'More of it today.'],
        msg_abuse_auto_1: ['thr_abuse_auto', 'fbl@isp.test', 'PASS', 'abuse@dev.bane.mx', 'Abuse report', 'Feedback loop report'],
        msg_legal_nodmarc_1: ['thr_legal', 'lawyer@firm.test', 'FAIL', 'legal@dev.bane.mx', 'Subpoena', 'Please preserve records for account X.'],
        msg_v1a: ['thr_v1', 'victim@acme.test', 'FAIL'], msg_v1b: ['thr_v1', 'victim@acme.test', 'FAIL'], msg_v2a: ['thr_v2', 'vera@acme.test', 'FAIL'], msg_v2b: ['thr_v3', 'vera@acme.test', 'FAIL'],
        msg_abuse_s1: ['thr_s1', 's1@spoof.test', 'FAIL', 'abuse@dev.bane.mx', 'Spam 1', 'spam'], msg_abuse_s2: ['thr_s2', 's2@spoof.test', 'FAIL', 'abuse@dev.bane.mx', 'Spam 2', 'spam'],
        msg_abuse_s3: ['thr_s3', 's3@spoof.test', 'FAIL', 'abuse@dev.bane.mx', 'Spam 3', 'spam'], msg_legal_pass_1: ['thr_legal_pass', 'counsel@firm.test', 'PASS', 'legal@dev.bane.mx', 'Subpoena 2', 'Preserve records.'],
        msg_privacy_bcc_1: ['thr_privacy', 'dpo@corp.test', 'PASS', 'someone@corp.test', 'Data request', 'Please export my data.'],
      }[id] ?? [];
      const [threadId = 'thr_other', from = 'ada@acme.test', dmarc = 'PASS', to = 'support@dev.bane.mx', subject = 'Bounces from Gmail?', body = 'Why are Gmail bounces up this week?'] = table.map(v => v ?? undefined);
      const auto = id.includes('auto');
      const attachments = id === 'msg_image_1' || id === 'msg_abuse_1' ? [{ id: 'part_png', filename: 'bounce screenshot.png', contentType: 'image/png', size: 300, disposition: 'attachment' }, { id: 'part_pdf', filename: 'invoice.pdf', contentType: 'application/pdf', size: 900, disposition: 'attachment' }] : [];
      const authentication = url.searchParams.get('includeAuthentication') === 'true' ? { authentication: { spf: 'PASS', dkim: null, dmarc }, automated: auto } : {};
      return Response.json({ id, threadId, direction: 'inbound', subject, from: { name: null, address: from }, to: [to], text: body, replyText: body, messageId: '<' + id + '@mail.test>', ...authentication, attachments });
    }
    if (request.method === 'POST' && url.pathname === '/v1/inbound/threads') return Response.json({ id: 'msg_new', threadId: 'thr_new_' + calls.length }, { status: 202 });
    if (request.method === 'POST' && /^\\/v1\\/inbound\\/threads\\/[^/]+\\/reply$/.test(url.pathname)) return Response.json({ id: 'msg_reply', threadId: url.pathname.split('/')[4] }, { status: 202 });
    return Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
  },
};
`;

// ---------- the scripted model ----------

export type Recorded = { url: string; headers: Record<string, string>; body: any };
export const recorded: Recorded[] = [];
export const control = { failStatus: 0 };

const sse = (events: Array<[string, unknown]>) => new Response(events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const start = (id: string): [string, unknown] => ['message_start', { message: { id, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, usage: { input_tokens: 1200, output_tokens: 1 } } }];
const toolUse = (id: string, name: string, input: object) => sse([
  start('msg_tool'), ['content_block_start', { index: 0, content_block: { type: 'tool_use', id, name, input: {} } }],
  ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }], ['content_block_stop', { index: 0 }],
  ['message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } }], ['message_stop', {}],
]);
const text = (chunks: string[]) => sse([
  start('msg_text'), ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
  ...chunks.map(chunk => ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: chunk } }] as [string, unknown]),
  ['content_block_stop', { index: 0 }], ['message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 60 } }], ['message_stop', {}],
]);

const blocks = (message: any): any[] => Array.isArray(message?.content) ? message.content : [{ type: 'text', text: String(message?.content ?? '') }];
/** The latest thing the customer (or the harness) said, ignoring tool results. */
function lastUserText(body: any): string {
  for (const message of [...(body?.messages ?? [])].reverse()) {
    if (message.role !== 'user') continue;
    const said = blocks(message).filter(b => b.type === 'text').map(b => b.text).join('\n');
    if (said) return said;
  }
  return '';
}

export async function fakeGateway(request: Request): Promise<Response> {
  const body = request.method === 'POST' ? await request.json().catch(() => undefined) as any : undefined;
  recorded.push({ url: request.url, headers: Object.fromEntries(request.headers), body });
  if (!new URL(request.url).pathname.endsWith('/messages')) return new Response('not found', { status: 404 });
  if (control.failStatus) return Response.json({ type: 'error', error: { type: 'overloaded_error', message: 'fake failure' } }, { status: control.failStatus });
  const said = lastUserText(body), answered = blocks(body?.messages?.at(-1)).some(b => b.type === 'tool_result');
  const lastUser = [...(body?.messages ?? [])].reverse().find((m: any) => m.role === 'user' && blocks(m).some(b => b.type === 'text'));
  const sawImage = blocks(lastUser).some(b => b.type === 'image');
  if (said.includes('A support email arrived') && said.includes('reset link')) return text(['Hi Ada,\n\nReset it here: https://bane-mx-security.example/reset\n\nNightmail support (AI)']);
  if (said.includes('A support email arrived') && sawImage) return text(['Hi Ada,\n\nI can see your screenshot: it shows a Gmail bounce.\n\nNightmail support (AI)']);
  if (said.includes('screenshot')) return text([sawImage ? 'I can see your screenshot.' : 'I can’t see a screenshot.']);
  if (said.includes('webhook test fails')) {
    // api_errors, then a bug ticket without its reproduction (refused), then the full one, then the answer.
    const used = (body?.messages ?? []).slice((body?.messages ?? []).indexOf(lastUser) + 1).flatMap((m: any) => blocks(m)).filter((b: any) => b.type === 'tool_use').map((b: any) => b.name);
    const lastResult = JSON.stringify(blocks(body?.messages?.at(-1)).filter(b => b.type === 'tool_result'));
    if (!used.length) return toolUse('toolu_e1', 'api_errors', { hours: 24 });
    if (used.length === 1) return toolUse('toolu_e2', 'file_ticket', { type: 'bug', title: 'Webhook test returns 500 for every endpoint', severity: 'P2', summary: 'Webhook tests fail with 500.', ask: 'My webhook test fails', tried: ['api_errors: 14 × 500 INTERNAL_ERROR'], recommendation: 'Look at the webhook test handler.' });
    if (used.length === 2 && lastResult.includes('needs reproSteps')) return toolUse('toolu_e3', 'file_ticket', { type: 'bug', title: 'Webhook test returns 500 for every endpoint', severity: 'P2',
      summary: 'Every POST /v1/webhooks/{id}/test returns 500 since this morning. 14 failures in 2 hours, all INTERNAL_ERROR. The customer wants their webhooks tested.', ask: 'My webhook test fails',
      tried: ['api_errors: 14 × 500 INTERNAL_ERROR on POST /v1/webhooks/:id/test'], recommendation: 'Check the webhook test handler against req_' + 'a'.repeat(32) + '.',
      reproSteps: ['Open Webhooks', 'Press Send test on any endpoint'], affected: 'POST /v1/webhooks/{id}/test', requestIds: ['req_' + 'a'.repeat(32), 'req_' + 'b'.repeat(32)], errorCodes: ['500 INTERNAL_ERROR'],
      expected: 'A test delivery', actual: 'HTTP 500' });
    return text(['That’s a Nightmail bug: I’ve passed it to the Nightmail team.']);
  }
  if (said.includes('just opened the support chat')) return text(['Hi Ada, I see you sent ', '"Early access" yesterday', ' with 42% opens. What are we working on today?']);
  if (said.includes('A support email arrived')) return answered ? text(['Hi Ada,\n\nGmail hard-bounced 61 of 1,000 sends this week.\n\nNightmail support (AI)']) : toolUse('toolu_e', 'bounce_reasons', { provider: 'gmail' });
  if (said.includes('Gmail bounces')) return answered ? text(['Gmail hard-bounced 61 of 1,000 sends (6.1%). Here’s what I’d do:\n\n1. Remove the import from Oct 25.']) : toolUse('toolu_b', 'bounce_reasons', { provider: 'gmail', days: 7 });
  if (said.includes('refund')) return answered ? text(['I’ve passed this to the Nightmail team. Someone will reply by email.']) : toolUse('toolu_t', 'file_ticket', {
    type: 'billing', topic: 'refund', title: 'Duplicate $25 top-up', severity: 'P3', summary: 'Ada asks for a refund of a duplicate top-up. The ledger shows two identical top-ups. She wants one refunded.', ask: 'Please refund my duplicate top-up',
    tried: ['get_billing: two $25 top-ups 40 s apart'], recommendation: 'Refund the second $25 top-up (billing error).', evidence: ['req_1'] });
  if (said.includes('look at the content')) return answered ? text(['I’ve asked for access to read that email.']) : toolUse('toolu_c', 'request_content_access', { why: 'To check why the screen rejected your promo, I need to read its HTML.' });
  if (said.includes('leak please')) return text([`Sure: bane_ops_${'a'.repeat(64)}`]);
  return text(['OK.']);
}
