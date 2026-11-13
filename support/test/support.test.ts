import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { control, FAKE_BANE, fakeGateway, GRANT_TOKEN, recorded } from './fakes.js';

// The support Worker end to end, as it is deployed: the bundle `bun run build` produces (wrangler, workerd conditions),
// driven by Miniflare with a fake Bane (SupportPlatform over RPC + the public API) and a scripted model behind the
// gateway URL. OpenCode really runs inside the Durable Object; only the model and Bane are fakes. No network.

const ORIGIN = 'https://dev.bane.mx', SUPPORT = 'https://support.dev.bane.mx';
const ROOT = randomBytes(32).toString('hex'), WEBHOOK_SECRET = `whsec_${randomBytes(32).toString('base64')}`;
const GATEWAY_KEY = `oc_sk_test_${randomBytes(12).toString('hex')}`;
let mf: Miniflare;
const text = (value: string) => ({ type: 'text' as const, value });

function worker(name: string, env: Record<string, unknown>) {
  const modules: Record<string, { type: string; contents: string }> = {};
  for (const file of readdirSync('dist')) {
    if (file === 'worker.js') modules[file] = { type: 'esm', contents: readFileSync(`dist/${file}`, 'utf8') };
    else if (file.endsWith('.md') && file !== 'README.md') modules[file] = { type: 'text', contents: readFileSync(`dist/${file}`, 'utf8') };
  }
  return { config: { name, compatibilityDate: '2026-09-08', compatibilityFlags: ['nodejs_compat'], manifest: { mainModule: 'worker.js', modules }, env,
    exports: { SupportConversation: { type: 'durable-object' as const, storage: 'sqlite' as const } } } };
}

const baseEnv = (overrides: Record<string, unknown> = {}) => ({
  STAGE: text('dev'), PUBLIC_URL: text(SUPPORT), DASHBOARD_ORIGINS: text(`${ORIGIN},http://localhost:5173`), BANE_ORIGIN: text(ORIGIN),
  SUPPORT_ADDRESS: text('support@dev.bane.mx'), SUPPORT_ADDRESS_ID: text('adr_support'), TICKET_TO: text('ryan@anoma.ly'), GATEWAY_URL: text('https://opencode.ai/inference/anthropic/v1'),
  CONSOLE_GATEWAY_KEY: text(GATEWAY_KEY), SUPPORT_ROOT_SECRET: text(ROOT), BANE_INBOUND_WEBHOOK_SECRET: text(WEBHOOK_SECRET), BANE_SUPPORT_INBOX_KEY: text(`bane_mbx_${'7'.repeat(64)}`),
  CONVERSATION: { type: 'durable-object' as const, worker: 'support', exportName: 'SupportConversation' },
  DB: { type: 'd1' as const, id: 'support-test' },
  BANE: { type: 'worker' as const, worker: 'fake-bane', exportName: 'SupportPlatform' },
  BANE_API: { type: 'worker' as const, worker: 'fake-bane' },
  MODEL_FAKE: { type: 'fetcher' as const, handler: (request: Request) => fakeGateway(request) },
  ...overrides,
});

beforeAll(async () => {
  mf = new Miniflare({
    cf: false, telemetry: { enabled: false },
    workers: [
      worker('support', baseEnv()),
      { config: { name: 'fake-bane', compatibilityDate: '2026-09-08', manifest: { mainModule: 'bane.js', modules: { 'bane.js': { type: 'esm', contents: FAKE_BANE } } }, env: {} } },
    ],
  } as never);
  await migrate(mf);
}, 120_000);
afterAll(() => mf?.dispose());

async function migrate(instance: Miniflare) {
  const db = await instance.getD1Database('DB', 'support');
  const statements = readFileSync('migrations/0001_init.sql', 'utf8').replace(/--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean);
  for (const statement of statements) await db.prepare(statement).run();
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  mf.dispatchFetch(`${SUPPORT}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers }, body: JSON.stringify(body) })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => null) as any, headers: r.headers }));
const fakeCalls = async () => (await (await (await mf.getWorker('fake-bane')).fetch('http://fake-bane/__calls')).json()) as any[];
let handoffs = 0;
const handoff = (user = 'usr_ada', share = false) => `handoff:sho_${String(++handoffs).padStart(32, '0')}:${user}:ws_acme:${share ? 'share' : 'no'}`;

/** A live socket: collects frames and waits for one matching a predicate. */
async function connect(socketUrl: string) {
  const response = await mf.dispatchFetch(socketUrl.replace('wss:', 'https:'), { headers: { upgrade: 'websocket', origin: ORIGIN } } as never);
  assert.equal(response.status, 101);
  const ws = (response as unknown as { webSocket: WebSocket & { accept(): void } }).webSocket;
  ws.accept();
  const frames: any[] = [], waiters: { match: (f: any) => boolean; resolve: (f: any) => void }[] = [];
  ws.addEventListener('message', event => {
    const frame = JSON.parse(String(event.data));
    frames.push(frame);
    for (const w of [...waiters]) if (w.match(frame)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(frame); }
  });
  const until = (match: (f: any) => boolean, ms = 30_000) => new Promise<any>((resolve, reject) => {
    const found = frames.find(match);
    if (found) return resolve(found);
    const timer = setTimeout(() => reject(new Error(`no frame in ${ms} ms; got ${frames.map(f => f.type).join(', ')}`)), ms);
    waiters.push({ match, resolve: f => { clearTimeout(timer); resolve(f); } });
  });
  return { ws, frames, until, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}

describe('support Worker', () => {
  test('health, origin and handoff checks on /chat/start', async () => {
    const health = await mf.dispatchFetch(`${SUPPORT}/health`);
    assert.deepEqual(await health.json(), { status: 'ok', service: 'bane-support', stage: 'dev' });
    assert.equal((await post('/chat/start', { handoff: handoff() }, { origin: 'https://evil.test' })).status, 403);
    assert.equal((await post('/chat/start', {})).status, 400);
    assert.equal((await post('/chat/start', { handoff: 'forged' })).status, 401);
    const preflight = await mf.dispatchFetch(`${SUPPORT}/chat/start`, { method: 'OPTIONS', headers: { origin: ORIGIN } });
    assert.equal(preflight.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal((await mf.dispatchFetch(`${SUPPORT}/agents/support-conversation/x`)).status, 404, 'No client-named route to a Durable Object.');
  });

  test('a chat: the agent greets first, answers with a tool, and the grant never leaves the Durable Object', async () => {
    const token = handoff();
    const started = await post('/chat/start', { handoff: token });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.match(started.body.conversationId, /^conv_[a-z2-7]{26}$/);
    assert.equal((await post('/chat/start', { handoff: token })).status, 409, 'A handoff opens one conversation.');
    // A chat token is bound to its conversation.
    const wrong = await mf.dispatchFetch(`${SUPPORT}/c/conv_${'a'.repeat(26)}?token=${encodeURIComponent(started.body.chatToken)}`, { headers: { upgrade: 'websocket', origin: ORIGIN } });
    assert.equal(wrong.status, 401);
    const noOrigin = await mf.dispatchFetch(started.body.socketUrl.replace('wss:', 'https:'), { headers: { upgrade: 'websocket', origin: 'https://evil.test' } });
    assert.equal(noOrigin.status, 403);

    const before = recorded.length;
    const chat = await connect(started.body.socketUrl);
    const hello = await chat.until(f => f.type === 'hello');
    assert.deepEqual([hello.v, hello.agent, hello.workspace, hello.channel], [1, { name: 'Bane support', ai: true }, { id: 'ws_acme', name: 'Acme Prod' }, 'chat']);
    await chat.until(f => f.type === 'history');
    const first = await chat.until(f => f.type === 'message.start' && f.kind === 'first');
    const greeting = await chat.until(f => f.type === 'message.end' && f.messageId === first.messageId, 60_000);
    assert.equal(greeting.text, 'Hi Ada, I see you sent "Early access" yesterday with 42% opens. What are we working on today?');
    const deltas = chat.frames.filter(f => f.type === 'text.delta' && f.messageId === first.messageId).map(f => f.delta).join('');
    assert.equal(deltas, greeting.text, 'The greeting streams as deltas.');
    // The greeting is built from the context bundle, with the pinned model, the gateway key and our tools only.
    const greetingRequest = recorded[before]!;
    assert.equal(greetingRequest.headers.authorization, `Bearer ${GATEWAY_KEY}`);
    assert.equal(greetingRequest.headers['x-api-key'], undefined);
    assert.equal(greetingRequest.body.model, 'claude-opus-5-5');
    assert.deepEqual(greetingRequest.body.output_config, { effort: 'medium' });
    assert.ok(greetingRequest.url.startsWith('https://opencode.ai/inference/anthropic/v1/messages'));
    const tools = greetingRequest.body.tools.map((t: any) => t.name).sort();
    assert.ok(tools.includes('bounce_reasons') && tools.includes('file_ticket') && !tools.some((n: string) => ['bash', 'read', 'edit', 'write', 'skill', 'task', 'webfetch', 'execute'].includes(n)), tools.join());
    const system = JSON.stringify(greetingRequest.body.system);
    assert.ok(system.includes('Early access') && system.includes('Acme Prod') && system.includes('How Bane support writes'), 'Context bundle and VOICE.md reach the system prompt.');
    assert.ok(!system.includes('<env>'), 'No host filesystem context.');

    chat.send({ type: 'user.message', clientMessageId: 'c1', text: 'Why are Gmail bounces up?' });
    chat.send({ type: 'user.message', clientMessageId: 'c1', text: 'Why are Gmail bounces up?' });
    const toolStart = await chat.until(f => f.type === 'tool.start' && f.tool === 'bounce_reasons', 60_000);
    assert.equal(toolStart.label, 'Checking your Gmail bounces…');
    const toolEnd = await chat.until(f => f.type === 'tool.end' && f.toolCallId === toolStart.toolCallId);
    assert.deepEqual([toolEnd.ok, toolEnd.label], [true, 'Checked your Gmail bounces']);
    const answer = await chat.until(f => f.type === 'message.end' && f.messageId === toolStart.messageId, 60_000);
    assert.match(answer.text, /^Gmail hard-bounced 61 of 1,000/);
    assert.equal(chat.frames.filter(f => f.type === 'message.start' && f.kind === 'reply').length, 1, 'A resent clientMessageId is ignored.');
    // The tool result the model read was projected: untrusted text fenced, operator fields and grant gone, addresses kept out.
    const toolTurn = recorded.slice(before).find(r => JSON.stringify(r.body.messages).includes('tool_result'))!;
    const fed = JSON.stringify(toolTurn.body.messages);
    assert.ok(fed.includes('<untrusted>') && !fed.includes('op_secret') && !fed.includes('never-shown'), fed.slice(-600));
    // The grant token is in no model request and no frame.
    assert.ok(!recorded.some(r => JSON.stringify(r).includes(GRANT_TOKEN)), 'The grant never reaches the model.');
    assert.ok(!chat.frames.some(f => JSON.stringify(f).includes(GRANT_TOKEN) || JSON.stringify(f).includes('bane_support_')), 'The grant never reaches the panel.');
    const calls = await fakeCalls();
    assert.ok(calls.some(c => c[0] === 'read' && c[1].startsWith('/v1/support/deliverability/bounces?') && c[1].includes('workspaceId=ws_acme') && c[1].includes('provider=gmail') && c[2] === 'GRANT'));
    assert.ok(calls.some(c => c[0] === 'mintGrant' && c[1].verification === 'handoff' && c[1].ticketRef === started.body.conversationId && c[1].ttlMinutes === 120));
    // Reconnecting replays the transcript.
    chat.ws.close();
    const again = await connect(started.body.socketUrl);
    const history = await again.until(f => f.type === 'history');
    assert.deepEqual(history.messages.map((m: any) => [m.role, m.kind ?? null]), [['assistant', 'first'], ['user', null], ['assistant', 'reply']]);
    assert.deepEqual(history.messages[2].tools.map((t: any) => t.label), ['Checked your Gmail bounces']);
    again.ws.close();
  }, 180_000);

  test('a refund request files one ticket, emails the team and opens the customer’s follow-up thread', async () => {
    const started = await post('/chat/start', { handoff: handoff() });
    const chat = await connect(started.body.socketUrl);
    await chat.until(f => f.type === 'message.end' && f.text?.startsWith('Hi Ada'), 60_000);
    chat.send({ type: 'user.message', clientMessageId: 'r1', text: 'Can I get a refund of my duplicate top-up?' });
    const filed = await chat.until(f => f.type === 'ticket.filed', 60_000);
    assert.match(filed.ticketId, /^tkt_[a-z2-7]{16}$/);
    assert.deepEqual([filed.category, filed.replyTo, filed.expect], ['refund', 'a…@acme.test', 'usually within one business day']);
    const tool = chat.frames.find(f => f.type === 'tool.start' && f.tool === 'file_ticket');
    assert.equal(tool.label, 'Passing this to the Bane team…');
    await chat.until(f => f.type === 'message.end' && f.messageId === tool.messageId, 60_000);
    const db = await mf.getD1Database('DB', 'support');
    const row = await db.prepare('SELECT * FROM tickets WHERE id = ?').bind(filed.ticketId).first<any>();
    assert.deepEqual([row.category, row.severity, row.conversation_id, row.channel], ['refund', 'P3', started.body.conversationId, 'chat']);
    assert.ok(row.recommendation.includes('Refund the second $25'));
    assert.equal((await db.prepare('SELECT status, ticket_id FROM conversations WHERE id = ?').bind(started.body.conversationId).first<any>()).status, 'ticketed');
    const sends = (await fakeCalls()).filter(c => c[0] === 'api' && c[1] === 'POST' && c[2] === '/v1/inbound/threads');
    const team = sends.find(c => c[3].to[0] === 'ryan@anoma.ly'), customer = sends.find(c => c[3].to[0] === 'ada@acme.test');
    assert.ok(team && customer, JSON.stringify(sends));
    assert.equal(team[3].addressId, 'adr_support'); assert.match(team[3].subject, new RegExp(`^\\[Bane support\\] ${filed.ticketId}: refund \\(P3\\)$`));
    assert.ok(team[3].text.includes('Recommendation\nRefund the second $25') && team[3].text.includes('Customer: ') && team[3].text.includes('> Please refund my duplicate top-up'));
    assert.equal(team[5], `ticket-${filed.ticketId}`, 'Idempotent per ticket.');
    assert.equal(team[4], `Bearer bane_mbx_${'7'.repeat(64)}`);
    assert.match(customer[3].text, new RegExp(`passed your request to the Bane team as ${filed.ticketId}`));
    chat.ws.close();
  }, 180_000);

  test('content consent: the agent asks, the panel allows with a fresh handoff, the grant is re-minted', async () => {
    const started = await post('/chat/start', { handoff: handoff() });
    const chat = await connect(started.body.socketUrl);
    await chat.until(f => f.type === 'message.end' && f.text?.startsWith('Hi Ada'), 60_000);
    chat.send({ type: 'user.message', clientMessageId: 'k1', text: 'Can you look at the content of my promo?' });
    const consent = await chat.until(f => f.type === 'consent.request', 60_000);
    assert.match(consent.requestId, /^cns_/);
    assert.deepEqual([consent.workspace, consent.why], [{ id: 'ws_acme', name: 'Acme Prod' }, 'To check why the screen rejected your promo, I need to read its HTML.']);
    await chat.until(f => f.type === 'message.end' && f.text?.includes('asked for access'), 60_000);
    const mints = (await fakeCalls()).filter(c => c[0] === 'mintGrant').length;
    chat.send({ type: 'consent.respond', requestId: consent.requestId, decision: 'allow', handoff: handoff('usr_ada', true) });
    const resolved = await chat.until(f => f.type === 'consent.resolved');
    assert.deepEqual([resolved.requestId, resolved.decision], [consent.requestId, 'allow']);
    const calls = await fakeCalls();
    assert.equal(calls.filter(c => c[0] === 'mintGrant').length, mints + 1);
    assert.ok(calls.some(c => c[0] === 'revokeGrant'), 'The old grant is revoked before the new one.');
    chat.ws.close();
  }, 180_000);

  test('the output gate replaces a leaking answer and files a ticket', async () => {
    const started = await post('/chat/start', { handoff: handoff() });
    const chat = await connect(started.body.socketUrl);
    await chat.until(f => f.type === 'message.end' && f.text?.startsWith('Hi Ada'), 60_000);
    chat.send({ type: 'user.message', clientMessageId: 'l1', text: 'leak please' });
    const end = await chat.until(f => f.type === 'message.end' && f.redacted === true, 60_000);
    assert.match(end.text, /sent this one to the Bane team/);
    await chat.until(f => f.type === 'ticket.filed');
    chat.ws.close();
  }, 180_000);

  test('email: a signed webhook, DMARC-verified sender, a grant, and a reply only to that sender', async () => {
    const body = JSON.stringify({ type: 'message.received', data: { messageId: 'msg_mail_1', message: { id: 'msg_mail_1', threadId: 'thr_mail_1', direction: 'inbound', from: { address: 'ada@acme.test' } } } });
    const id = `wh_${randomBytes(8).toString('hex')}`, ts = String(Math.floor(Date.now() / 1000));
    const signature = `v1,${createHmac('sha256', Buffer.from(WEBHOOK_SECRET.slice(6), 'base64')).update(`${id}.${ts}.${body}`).digest('base64')}`;
    const unsigned = await mf.dispatchFetch(`${SUPPORT}/hooks/bane-inbound`, { method: 'POST', body, headers: { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': 'v1,AAAA' } });
    assert.equal(unsigned.status, 401);
    const hooked = await mf.dispatchFetch(`${SUPPORT}/hooks/bane-inbound`, { method: 'POST', body, headers: { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': signature } });
    assert.equal(hooked.status, 200);
    assert.equal((await mf.dispatchFetch(`${SUPPORT}/hooks/bane-inbound`, { method: 'POST', body, headers: { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': signature } })).status, 200, 'A redelivery is accepted and ignored.');
    let reply: any;
    for (let i = 0; i < 120 && !reply; i++) { reply = (await fakeCalls()).find(c => c[0] === 'api' && c[2] === '/v1/inbound/threads/thr_mail_1/reply'); if (!reply) await new Promise(r => setTimeout(r, 250)); }
    assert.ok(reply, 'The agent replied in the thread.');
    assert.deepEqual([reply[3].to, reply[3].expectedRecipients, reply[3].replyToMessageId, reply[5]], [['ada@acme.test'], { to: ['ada@acme.test'], cc: [], bcc: [] }, 'msg_mail_1', 'reply-msg_mail_1']);
    assert.equal(reply[3].text, 'Hi Ada,\n\nGmail hard-bounced 61 of 1,000 sends this week.\n\nBane support (AI)');
    const calls = await fakeCalls();
    const verify = calls.find(c => c[0] === 'verifyEmail' && c[1].email === 'ada@acme.test');
    assert.deepEqual(verify[1].evidence, { kind: 'dmarc', result: 'pass', aligned: true, messageId: '<m1@acme.test>' });
    assert.ok(calls.some(c => c[0] === 'mintGrant' && c[1].verification === 'dmarc' && JSON.stringify(c[1].workspaceIds) === '["ws_acme"]'));
    assert.equal(calls.filter(c => c[0] === 'api' && c[2] === '/v1/inbound/threads/thr_mail_1/reply').length, 1, 'One reply per inbound message.');
  }, 180_000);

  test('fails closed without the gateway key', async () => {
    // The same bundle without CONSOLE_GATEWAY_KEY: the chat opens, and the first turn refuses loudly without calling a model.
    const nokey = new Miniflare({ cf: false, telemetry: { enabled: false }, workers: [worker('support', baseEnv({ CONSOLE_GATEWAY_KEY: text('') })),
      { config: { name: 'fake-bane', compatibilityDate: '2026-09-08', manifest: { mainModule: 'bane.js', modules: { 'bane.js': { type: 'esm', contents: FAKE_BANE } } }, env: {} } }] } as never);
    try {
      await migrate(nokey);
      const before = recorded.length;
      const start = await nokey.dispatchFetch(`${SUPPORT}/chat/start`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ handoff: handoff() }) });
      const opened = await start.json() as any;
      assert.equal(start.status, 200, JSON.stringify(opened));
      const socket = await nokey.dispatchFetch(opened.socketUrl.replace('wss:', 'https:'), { headers: { upgrade: 'websocket', origin: ORIGIN } });
      const ws = (socket as any).webSocket; ws.accept();
      const frames: any[] = [];
      ws.addEventListener('message', (e: MessageEvent) => frames.push(JSON.parse(String(e.data))));
      for (let i = 0; i < 100 && !frames.some(f => f.type === 'error'); i++) await new Promise(r => setTimeout(r, 100));
      const failure = frames.find(f => f.type === 'error');
      assert.deepEqual([failure?.code, failure?.retryable], ['TURN_FAILED', false], JSON.stringify(frames));
      assert.match(failure.message, /isn’t fully set up/);
      assert.equal(recorded.length, before, 'No model request without the key.');
      ws.close();
    } finally { await nokey.dispose(); }
  }, 60_000);
});
void control;
