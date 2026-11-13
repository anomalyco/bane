// Test doubles for the support Worker's integration tests: a fake Bane (the SupportPlatform entrypoint over RPC and the
// public API it calls with the inbox key) and a scripted Anthropic Messages API standing in for Console's gateway.
// No network, no real model: the model's moves are decided from the request body, so retries and replays stay stable.

export const GRANT_TOKEN = `bane_support_${'5'.repeat(64)}`;

/** The fake Bane, as a Worker module (it must export a real WorkerEntrypoint for RPC). */
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
  '/v1/support/deliverability/bounces': { data: [{ provider: 'gmail', type: 'bounce', count: 61, diagnostic: 'smtp; 550 5.1.1 user unknown at someone@gmail.com from 203.0.113.9' }], findings: [{ severity: 'serious', code: 'HARD_BOUNCES', message: '6.1% hard bounces at Gmail' }], grant: { token: 'never-shown' }, operatorId: 'op_secret' },
};
export class SupportPlatform extends WorkerEntrypoint {
  async verifyHandoff(token) { calls.push(['verifyHandoff', token]); const h = handoff(token); if (h?.shareContent) shared.add(h.id); return h ? { ok: true, handoff: h } : { ok: false, code: 'HANDOFF_INVALID' }; }
  async verifyEmail(body) {
    calls.push(['verifyEmail', body]);
    return body.email === 'ada@acme.test' ? ok({ verified: true, user: { id: 'usr_ada', name: 'Ada Lovelace' }, workspaces: [{ id: 'ws_acme', name: 'Acme Prod', role: 'owner' }] }) : ok({ verified: false, user: null, workspaces: [] });
  }
  async mintGrant(body) {
    calls.push(['mintGrant', body]);
    if (body.handoffId) { if (used.has(body.handoffId)) return ok({ error: { code: 'SUPPORT_HANDOFF_USED' } }, 409); used.add(body.handoffId); }
    grants += 1;
    return ok({ id: 'sgr_' + String(grants).padStart(32, '0'), token: '${GRANT_TOKEN}', userId: body.userId, workspaceIds: body.workspaceIds ?? ['ws_acme'], ticketRef: body.ticketRef,
      contentShared: shared.has(body.handoffId), contentWorkspaceId: shared.has(body.handoffId) ? 'ws_acme' : null, expiresAt: new Date(Date.now() + 7200000).toISOString() }, 201);
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
    if (request.method === 'GET' && url.pathname.startsWith('/v1/inbound/messages/')) {
      const id = url.pathname.split('/').pop();
      const auto = id.includes('auto');
      const threadId = ({ msg_mail_1: 'thr_mail_1', msg_nodmarc_1: 'thr_nodmarc', msg_auto_1: 'thr_auto' })[id] ?? 'thr_other';
      return Response.json({ id, threadId, direction: 'inbound', subject: 'Bounces from Gmail?', from: { name: 'Ada', address: id.includes('stranger') ? 'stranger@else.test' : 'ada@acme.test' },
        text: 'Why are Gmail bounces up this week?', replyText: 'Why are Gmail bounces up this week?', messageId: '<m1@acme.test>',
        headers: auto ? [{ name: 'Auto-Submitted', value: 'auto-replied' }] : [{ name: 'Subject', value: 'Bounces from Gmail?' }], verdicts: { dmarc: id.includes('nodmarc') ? 'FAIL' : 'PASS', spf: 'PASS' } });
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
  if (said.includes('just opened the support chat')) return text(['Hi Ada, I see you sent ', '"Early access" yesterday', ' with 42% opens. What are we working on today?']);
  if (said.includes('A support email arrived')) return answered ? text(['Hi Ada,\n\nGmail hard-bounced 61 of 1,000 sends this week.\n\nBane support (AI)']) : toolUse('toolu_e', 'bounce_reasons', { provider: 'gmail' });
  if (said.includes('Gmail bounces')) return answered ? text(['Gmail hard-bounced 61 of 1,000 sends (6.1%). Here’s what I’d do:\n\n1. Remove the import from Oct 25.']) : toolUse('toolu_b', 'bounce_reasons', { provider: 'gmail', days: 7 });
  if (said.includes('refund')) return answered ? text(['I’ve passed this to the Bane team. Someone will reply by email.']) : toolUse('toolu_t', 'file_ticket', {
    category: 'refund', severity: 'P3', summary: 'Ada asks for a refund of a duplicate top-up. The ledger shows two identical top-ups. She wants one refunded.', ask: 'Please refund my duplicate top-up',
    tried: ['get_billing: two $25 top-ups 40 s apart'], recommendation: 'Refund the second $25 top-up (billing error).', evidence: ['req_1'] });
  if (said.includes('look at the content')) return answered ? text(['I’ve asked for access to read that email.']) : toolUse('toolu_c', 'request_content_access', { why: 'To check why the screen rejected your promo, I need to read its HTML.' });
  if (said.includes('leak please')) return text([`Sure: bane_ops_${'a'.repeat(64)}`]);
  return text(['OK.']);
}
