// tear product host for received-mail delivery: drives the real ingest, fan-out, job runner,
// ritualDelivery fence and endpoint code over an isolated PostgreSQL, one JSON request per stdin
// line and one JSON reply per stdout line.
//   {"op":"reset","retries":1}     fresh synthetic workspace (endpoints, routes, no rituals)
//   {"op":"act","action":"ingest m1 a"}  one model action; returns {r, sends, view, safety}
//
// The host owns everything nondeterministic:
// - Workers K and L each run the real processJobs on their own connection pool and their own
//   transport. A webhook POST parks in the transport until the runner answers it (reply K 503,
//   reply K 429 120, reply K timeout, ...), so other actions can interleave with a request in
//   flight. `claim K d` parks the worker right after its claim commits, before the handler runs.
// - crash K kills a parked worker: its request reached the endpoint (or, for drop K, never left)
//   and every later statement of that worker hangs; its server connections are terminated.
// - Due time is explicit. After every step each pending job of the workspace is moved a day
//   out (its delay is reported first); `claim/run K d` makes d's job due. `expire d` ends d's lease.
//   `tick` starts a new rate-limit minute. Math.random is 0.5, so backoff jitter is exactly 1.
//
// It runs only on a dedicated, migrated database its creator marked disposable
// (../disposable.ts): TEAR_DATABASE_URL must be a plain loopback URL, and the marker and the
// foreign-data check pass before the first write and before every fixture. Workspaces are tear_dlv_*.
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createInterface } from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';
const hex = (n: number) => Array.from({ length: Math.ceil(n / 32) }, () => randomUUID().replaceAll('-', '')).join('').slice(0, n);

for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) console[level] = (...a: unknown[]) => { process.stderr.write(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') + '\n'); };
const out = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
Math.random = () => 0.5;

const { disposableUrl, assertDisposable } = await import('../disposable.js');
const DATABASE_URL = await (async () => {
  try {
    const checked = disposableUrl(process.env.TEAR_DATABASE_URL, 'TEAR_DATABASE_URL');
    const c = new pg.Client({ connectionString: checked });
    await c.connect();
    try { await assertDisposable(text => c.query(text)); } finally { await c.end(); }
    return checked;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
})();

const { S3Client } = await import('@aws-sdk/client-s3');
const [{ createApp }, { nodeRuntime }, { acceptInboundNotification, mailboxIngestJobs }, { mailboxEventJobs, pruneMailboxEvents }, { processJobs }] = await Promise.all([
  import('../../src/app.js'), import('../../src/adapters/node.js'), import('../../src/mailbox-ingest.js'), import('../../src/mailbox-events.js'), import('../../src/jobs.js'),
]);
const ENCRYPTION = hex(64), REGION_DEFAULT = 'us-east-1';
const { ensureRegionSettings } = await import('../../src/ses-region-state.js');
const instance = nodeRuntime({ DATABASE_URL, BANE_ROOT_SECRET: hex(64), ENCRYPTION_KEY: ENCRYPTION, ACCOUNT_CLIENT_ID: 'tear-fixture', ACCOUNT_CLIENT_PRIVATE_KEY: 'tear-fixture',
  AUTH_ALLOWED_EMAILS: 'operator@example.com', PUBLIC_URL: 'http://127.0.0.1:9', ENABLE_LIVE_SES: 'false', S3_BUCKET: 'tear-fixture', S3_ACCESS_KEY_ID: 'tear', S3_SECRET_ACCESS_KEY: 'tear', S3_ENDPOINT: 'http://127.0.0.1:9', AWS_EC2_METADATA_DISABLED: 'true', DEFAULT_SES_REGION: REGION_DEFAULT, SIMULATED_SES_LATENCY_MS: '0' });
const runtime = instance.runtime;
runtime.config.aws = { accessKeyId: 'tear-synthetic', secretAccessKey: 'tear-synthetic' } as Json;
const app = createApp();
const REGION = 'us-east-1', BUCKET = 'tear-fixture', TOPIC = `arn:aws:sns:${REGION}:111122223333:tear-inbound`;
type Json = any;

// ---------- synthetic S3: raw MIME per staging key ----------
const raw = new Map<string, Buffer>();
(S3Client.prototype as Json).send = async (cmd: Json) => {
  const i = cmd.input, name = cmd.constructor.name, key = String(i.Key ?? i.CopySource ?? '');
  const mid = key.split('/').at(-1)!;
  switch (name) {
    case 'HeadObjectCommand': { const b = raw.get(mid); if (!b) throw Object.assign(new Error('missing'), { name: 'NotFound' }); return { ContentLength: b.length, ETag: '"tear"' }; }
    case 'GetObjectCommand': { const b = raw.get(mid); if (!b) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' }); return { Body: { transformToByteArray: async () => b, transformToString: async () => b.toString() } }; }
    default: return {};
  }
};

// ---------- workers: own pool, own transport, crash = every later statement hangs ----------
const hang = () => new Promise<never>(() => {});
const textOf = (q: unknown) => typeof q === 'string' ? q : (q as { text?: string })?.text ?? '';
type Send = { ep: string; key: string | null; delivery: string | null; body: Json };
type Worker = {
  name: string; app: string; target: string | null; pool: pg.Pool; dead: boolean; gate: boolean; claimed: boolean; parked: (() => void) | null;
  inflight: { send: Send; resolve: (v: Json) => void; reject: (e: unknown) => void } | null;
  task: Promise<void> | null; done: boolean; error: unknown; wake: (() => void) | null;
};
const workers: Record<string, Worker> = {};
let generation = 0;
function makePool(w: Worker) {
  w.app = `tear-dlv-${process.pid}-${w.name}-${++generation}`;
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4, application_name: w.app });
  pool.on('error', () => {});
  const gateFor = async (text: string) => {
    if (w.dead) return hang();
    // The claim is one statement; park before the handler's first statement after it.
    if (w.gate && w.claimed) { w.gate = false; await new Promise<void>(resolve => { w.parked = resolve; w.wake?.(); }); if (w.dead) return hang(); }
    if (/^\s*WITH RECURSIVE/.test(text)) w.claimed = true;
  };
  const query = pool.query.bind(pool);
  (pool as Json).query = (...args: Json[]) => { if (typeof args.at(-1) === 'function') return (query as Json)(...args); return (async () => { await gateFor(textOf(args[0])); return (query as Json)(...args); })(); };
  const connect = pool.connect.bind(pool);
  (pool as Json).connect = async (...args: Json[]) => {
    if (typeof args[0] === 'function') return (connect as Json)(...args);
    if (w.dead) return hang();
    const client = await connect();
    const cq = (client as Json).__tearQuery ??= client.query.bind(client);
    (client as Json).query = (...qa: Json[]) => { if (typeof qa.at(-1) === 'function') return cq(...qa); return (async () => { await gateFor(textOf(qa[0])); return cq(...qa); })(); };
    return client;
  };
  return pool;
}
function makeWorker(name: string): Worker {
  const w: Worker = { name, app: '', target: null, pool: null as unknown as pg.Pool, dead: false, gate: false, claimed: false, parked: null, inflight: null, task: null, done: false, error: null, wake: null };
  w.pool = makePool(w);
  return w;
}
for (const name of ['K', 'L']) workers[name] = makeWorker(name);
const checker = new pg.Client({ connectionString: DATABASE_URL });
await checker.connect();
const q = (text: string, params: unknown[] = []) => checker.query(text, params);

// ---------- fixture ----------
let ws = '', host = '', key = '', ids: Record<string, string> = {}, epOf: Record<string, string> = {}, retries = 1;
let sends: Send[] = [];
let seen: Record<string, Json> = {};
const mid = (m: string) => `${ws}_${m}`;
const URLS: Record<string, string> = { W: 'https://w.example.com/hook', V: 'https://v.example.com/hook', U: 'https://u.example.com/hook' };
const errOf = (e: any) => `e:${e?.code ?? e?.cause?.code ?? e?.name ?? 'ERROR'}`;

async function rest(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { authorization: `Bearer ${key}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.fetch(new Request(`http://127.0.0.1:9${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), runtime);
  const json = await res.json().catch(() => null) as Json;
  if (res.status >= 300) return { error: `e:${json?.error?.code ?? res.status}`, status: res.status, json };
  return { body: json, status: res.status };
}
const must = async (method: string, path: string, body?: unknown) => { const r = await rest(method, path, body); if (r.error) throw new Error(`${method} ${path}: ${r.error} ${JSON.stringify(r.json)}`); return r.body; };

async function retire(w: Worker) {
  // Abandon a dead worker: terminate its server sessions (rolling back anything open) and start fresh.
  await q("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1", [w.app]);
  void w.pool.end().catch(() => {});
  const fresh = makeWorker(w.name);
  workers[w.name] = fresh;
}

async function reset(r: number) {
  for (const w of Object.values(workers)) {
    if (w.dead || w.inflight || w.parked || (w.task && !w.done)) { w.dead = true; w.parked?.(); w.inflight?.reject(new Error('reset')); await retire(w); }
  }
  for (const w of Object.values(workers)) Object.assign(w, { gate: false, claimed: false, parked: null, inflight: null, task: null, done: false, error: null });
  await assertDisposable(text => q(text));
  if (ws) await cleanup(ws);
  ws = 'tear_dlv_' + hex(12); retries = r; sends = []; seen = {}; raw.clear();
  runtime.config.workspaceId = ws;
  host = `${ws.replaceAll('_', '-')}.example.org`;
  const domain = `${ws}_dom`;
  key = 'bane_' + hex(64);
  await q('BEGIN');
  await q('INSERT INTO workspaces(id,name,slug) VALUES($1,$1,$1)', [ws]);
  await q("INSERT INTO mailbox_domains(id,workspace_id,domain_id,name,region,status,catch_all) VALUES($1,$2,$1,$3,$4,'active','store')", [domain, ws, host, REGION]);
  await q('INSERT INTO mailbox_regions(workspace_id,region,bucket,topic_arn) VALUES($1,$2,$3,$4)', [ws, REGION, BUCKET, TOPIC]);
  await q("INSERT INTO mailboxes(id,workspace_id,domain_id,address,kind) VALUES($1,$2,$3,$4,'address')", [`${ws}_box`, ws, domain, `box@${host}`]);
  await q("INSERT INTO mailbox_addresses(workspace_id,address,mailbox_id,kind) VALUES($1,$2,$3,'primary')", [ws, `box@${host}`, `${ws}_box`]);
  await q("INSERT INTO operation_domains(id,workspace_id,name,region) VALUES($1,$2,'example.net',$3),($4,$2,$5,$3)", [`${ws}_od`, ws, REGION, `${ws}_oh`, host]);
  await q(`INSERT INTO api_keys(id,workspace_id,name,permissions,domains,hash,prefix) VALUES($1,$2,'tear',$3,'[]',$4,$5)`, [`${ws}_key`, ws, JSON.stringify(['read', 'send', 'manage']), createHash('sha256').update(key).digest('hex'), key.slice(0, 14)]);
  await q('COMMIT');
  await ensureRegionSettings(runtime.db, runtime.config);
  await must('POST', '/v1/endpoints', { type: 'webhook', name: 'w', url: URLS.W, retryAttempts: r });
  await must('POST', '/v1/endpoints', { type: 'webhook', name: 'v', url: URLS.V, retryAttempts: r });
  await must('PATCH', '/v1/endpoints/v', { idempotent: true });
  await must('POST', '/v1/endpoints', { type: 'slack', name: 's', url: `https://hooks.slack.com/services/T0/B0/${hex(16)}` });
  await must('POST', '/v1/endpoints', { type: 'forward', name: 'f', address: 'team@example.net', preverify: true });
  // U: a plain event subscription to box@'s received mail (no routes, no rituals).
  await must('POST', '/v1/inbound/webhooks', { url: URLS.U, key: 'u', addressIds: [`${ws}_box`], eventTypes: ['message.received'], retryAttempts: r });
  const rows = (await q(`SELECT id,key FROM mailbox_webhooks WHERE workspace_id=$1 AND key IS NOT NULL UNION ALL SELECT hook_id,split_part(ref,':',2) FROM mail_endpoints WHERE workspace_id=$1`, [ws])).rows;
  ids = Object.fromEntries(rows.map(x => [x.key.toUpperCase(), x.id]));
  epOf = Object.fromEntries(rows.map(x => [x.id, x.key.toUpperCase()]));
  await must('POST', '/v1/routing/routes', { key: 'r1', match: `a@${host}`, to: ['webhook:w'] });
  await must('POST', '/v1/routing/routes', { key: 'r2', match: `x-*@${host}`, to: ['webhook:w', 'webhook:v'] });
  await must('POST', '/v1/routing/routes', { key: 'r3', match: `*@${host}`, to: ['webhook:v'] });
  await settleJobs();
  await view([]);
}
async function cleanup(old: string) {
  await q('DELETE FROM jobs WHERE workspace_id=$1', [old]);
  await q('DELETE FROM mailbox_webhooks WHERE workspace_id=$1', [old]);
}

// ---------- actions ----------
const RITUALS: Record<string, string> = {
  slack: 'export default function route(email){endpoints.s({text:email.subject})}',
  forward: 'export default function route(email){endpoints.f()}',
  both: 'export default function route(email){endpoints.s({text:email.subject});endpoints.f()}',
  four: 'export default function route(email){endpoints.s({text:"n0"});endpoints.s({text:"n1"});endpoints.s({text:"n2"});endpoints.s({text:"n3"})}',
  // 32 intents is the per-run action budget: one call and 31 labels run; one more label fails the ritual.
  max: `export default function route(email){endpoints.s({text:"max"});${'label("l");'.repeat(31)}}`,
  over: `export default function route(email){endpoints.s({text:"over"});${'label("l");'.repeat(32)}}`,
};
const RCPT: Record<string, string> = { a: 'a', x: 'x-1', z: 'z', b: 'box' };
// dN is the same email as mN (same Message-ID and content) under another SES receipt id.
function mime(label: string, variant: string) {
  const m = label.startsWith('d') ? 'm' + label.slice(1) : label;
  const extra = variant === 'loop' ? 'X-Bane-Loop: v1.1.synthetic\r\n' : variant === 'auto' ? 'Auto-Submitted: auto-replied\r\n'
    : variant.startsWith('recv') ? Array.from({ length: Number(variant.slice(4)) }, (_, i) => `Received: from relay${i}.example.org by mx.example.org; Wed, 11 Nov 2026 00:00:00 +0000\r\n`).join('') : '';
  return Buffer.from(`${extra}From: Sender <sender@example.org>\r\nTo: team@${host}\r\nSubject: Synthetic ${m}\r\nMessage-ID: <${m}.${ws}@example.org>\r\nDate: Wed, 11 Nov 2026 00:00:00 +0000\r\n\r\nHello ${m}`);
}
async function ingest(m: string, to: string[], variant: string) {
  raw.set(mid(m), mime(m, variant));
  const recipients = to.map(t => `${RCPT[t] ?? t}@${host}`);
  const message = { notificationType: 'Received', mail: { messageId: mid(m), timestamp: new Date().toISOString(), source: 'sender@example.org', destination: recipients, commonHeaders: { subject: `Synthetic ${m}` } },
    receipt: { timestamp: new Date().toISOString(), recipients, spamVerdict: { status: 'PASS' }, virusVerdict: { status: 'PASS' }, dmarcVerdict: { status: 'PASS' }, spfVerdict: { status: 'PASS' }, dkimVerdict: { status: 'PASS' },
      action: { type: 'S3', bucketName: BUCKET, objectKey: `staging/${mid(m)}`, topicArn: TOPIC } } };
  await acceptInboundNotification(runtime, { topicArn: TOPIC, region: REGION, message } as Json);
  await q("DELETE FROM jobs WHERE workspace_id=$1 AND type='mailbox.ingest'", [ws]);
  await mailboxIngestJobs['mailbox.ingest']!(runtime, { sesMessageId: mid(m) }, { id: 'job_tear_' + hex(8), workspaceId: ws, attempts: 1 });
  // The fan-out job, inline: its rows commit as one statement.
  const fan = (await q("UPDATE jobs SET status='completed' WHERE workspace_id=$1 AND type='mailbox.fanout' AND status='pending' RETURNING id,payload", [ws])).rows;
  for (const row of fan) await mailboxEventJobs['mailbox.fanout']!(runtime, row.payload, { id: row.id, workspaceId: ws, attempts: 1 });
  const r = (await q('SELECT status,error,routing FROM mail_receipts WHERE workspace_id=$1 AND ses_message_id=$2', [ws, mid(m)])).rows[0];
  return r?.status === 'processed' ? 'ok' : `e:${r?.error ?? r?.status ?? 'missing'}`;
}

// The job of a delivery label, and making it the only due job.
async function jobOf(d: string) {
  const id = deliveryIds[d];
  if (!id) return undefined;
  return (await q("SELECT id,status,attempts,lease_until<now() AS expired FROM jobs WHERE workspace_id=$1 AND type='mailbox.webhook' AND payload->>'deliveryId'=$2 AND status IN ('pending','running') ORDER BY created_at DESC LIMIT 1", [ws, id])).rows[0];
}
let deliveryIds: Record<string, string> = {};

function startWorker(w: Worker, gate: boolean) {
  Object.assign(w, { gate, claimed: false, parked: null, inflight: null, done: false, error: null });
  const wr = { ...runtime, db: drizzle(w.pool), webhookFetch: async (url: string, init: Json) => {
    const h = new Headers(init.headers), u = new URL(url);
    const ep = u.hostname === 'hooks.slack.com' ? 'S' : u.hostname.startsWith('w.') ? 'W' : u.hostname.startsWith('v.') ? 'V' : u.hostname.startsWith('u.') ? 'U' : u.hostname;
    const send: Send = { ep, key: h.get('idempotency-key'), delivery: null, body: JSON.parse(String(init.body)) };
    return new Promise((resolve, reject) => { w.inflight = { send, resolve, reject }; w.wake?.(); });
  } } as Json;
  w.task = processJobs(wr, mailboxEventJobs, 1, 1, 20000, 'webhooks').then(() => { w.done = true; }, e => { w.done = true; w.error = e; }).finally(() => w.wake?.());
}
// Wait until the worker parks (claim gate), has a request in flight, or finishes.
async function settleWorker(w: Worker) {
  const start = Date.now();
  while (!w.done && !w.inflight && !w.parked) {
    await new Promise<void>(resolve => { w.wake = resolve; setTimeout(resolve, 50); });
    w.wake = null;
    if (Date.now() - start > 10_000) return 'stuck';
  }
  if (w.inflight) {
    const s = w.inflight.send;
    s.delivery = labelOfDelivery(s.key) ?? w.target;
    return { sending: s.ep, d: s.delivery };
  }
  if (w.parked) return 'claimed';
  return null;
}
const labelOfDelivery = (k: string | null) => k ? Object.entries(deliveryIds).find(([, id]) => id === k)?.[0] ?? null : null;

async function run(name: string, d: string, gate: boolean) {
  const w = workers[name]!;
  const job = await jobOf(d);
  if (job?.status === 'pending') await q('UPDATE jobs SET available_at=now() WHERE id=$1', [job.id]);
  // Only d may be claimed: other expired leases wait (their holders are already fenced out).
  const hidden = (await q("UPDATE jobs SET lease_until='infinity' WHERE workspace_id=$1 AND status='running' AND lease_until<now() AND id<>$2 RETURNING id", [ws, job?.id ?? ''])).rows.map(r => r.id);
  w.target = d;
  startWorker(w, gate);
  const r = await settleWorker(w);
  if (hidden.length) await q("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=ANY($1) AND lease_until='infinity'", [hidden]);
  return r ?? await finished(w);
}
async function finished(w: Worker) {
  if (w.error) return errOf(w.error);
  return 'done';
}
async function go(name: string) {
  const w = workers[name]!;
  const p = w.parked; w.parked = null; p?.();
  return (await settleWorker(w)) ?? await finished(w);
}
async function reply(name: string, words: string[]) {
  const w = workers[name]!, f = w.inflight!;
  w.inflight = null;
  sends.push(f.send);
  const [kind, arg] = words;
  if (kind === 'timeout') f.reject(Object.assign(new Error('synthetic timeout'), { name: 'TimeoutError' }));
  else if (kind === 'reset') f.reject(new Error('synthetic connection reset'));
  else f.resolve({ status: Number(kind), retryAfter: arg ?? null });
  return (await settleWorker(w)) ?? await finished(w);
}
async function crash(name: string, sent: boolean) {
  const w = workers[name]!;
  const f = w.inflight;
  if (sent && f) sends.push(f.send);
  w.dead = true; w.inflight = null; w.parked?.(); w.parked = null;
  await retire(w);
  return 'ok';
}

// Rate-limit windows are wall-clock minutes. Never start a step in a minute's last 1.5 s, and keep
// every endpoint window in the current minute until a tick: time passes only when the model says.
async function pinMinute() {
  const into = Date.now() % 60_000;
  if (into > 58_500) await new Promise(resolve => setTimeout(resolve, 60_000 - into + 50));
  await q("UPDATE api_request_budgets SET window_start=date_trunc('minute',now()) WHERE workspace_id=$1 AND key_id LIKE 'ritual:%' AND window_start<>date_trunc('minute',now())", [ws]);
}
async function act(action: string) {
  await pinMinute();
  const words = action.split(' ');
  const [verb] = words as [string];
  let r: unknown;
  const before = sends.length;
  try {
    switch (verb) {
      case 'ingest': r = await ingest(words[1]!, words[2]!.split('+'), words[3] ?? 'plain'); break;
      case 'run': r = await run(words[1]!, words[2]!, false); break;
      case 'claim': r = await run(words[1]!, words[2]!, true); break;
      case 'go': r = await go(words[1]!); break;
      case 'reply': r = await reply(words[1]!, words.slice(2)); break;
      case 'crash': r = await crash(words[1]!, true); break;
      case 'drop': r = await crash(words[1]!, false); break;
      case 'expire': { const job = await jobOf(words[1]!); if (job) await q("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [job.id]); r = job ? 'ok' : null; break; }
      case 'tick': await q("DELETE FROM api_request_budgets WHERE workspace_id=$1 AND key_id LIKE 'ritual:%'", [ws]); r = 'ok'; break;
      case 'pause': case 'unpause': {
        // U is a subscription (its own PATCH); the others are endpoints.
        const e = words[1] === 'U' ? rest('PATCH', `/v1/inbound/webhooks/${ids.U}`, { paused: verb === 'pause' }) : rest('PATCH', `/v1/endpoints/${words[1]!.toLowerCase()}`, { paused: verb === 'pause' });
        const res = await e; r = res.error ?? 'ok';
        if (verb === 'unpause') { const jobs = (await q("UPDATE jobs SET status='completed' WHERE workspace_id=$1 AND type='mailbox.resumeDeliveries' AND status='pending' RETURNING id,payload", [ws])).rows; for (const j of jobs) await mailboxEventJobs['mailbox.resumeDeliveries']!(runtime, j.payload, { id: j.id, workspaceId: ws, attempts: 1 }); }
        break;
      }
      case 'delete': {
        // Detach the endpoint from routes and rituals, then delete it (deleteEndpoint refuses one in use).
        const e = words[1]!.toLowerCase();
        if (e === 'w' || e === 'v' || e === 'u') r = (await rest('DELETE', `/v1/inbound/webhooks/${ids[words[1]!]}?detach=true`)).error ?? 'ok';
        else { await rest('PUT', '/v1/rituals', {}); r = (await rest('DELETE', `/v1/endpoints/${e}`)).error ?? 'ok'; }
        break;
      }
      case 'rituals': r = words[1] === 'none' ? (await rest('PUT', '/v1/rituals', {})).error ?? 'ok' : (await rest('PUT', '/v1/rituals', { rituals: [{ key: 'triage', source: RITUALS[words[1]!] }], attachments: [{ ritual: 'triage', target: `box@${host}` }] })).error ?? 'ok'; break;
      case 'route': {
        const [, k, state] = words as [string, string, string];
        r = (await rest('PATCH', `/v1/routing/routes/${k}`, state === 'drop' ? { to: 'drop' } : { enabled: state === 'on' })).error ?? 'ok';
        break;
      }
      case 'rate': r = (await rest('PATCH', `/v1/endpoints/${words[1]!.toLowerCase()}`, { perMinute: Number(words[2]) })).error ?? 'ok'; break;
      case 'decline': {
        // The recipient's stop link (signed, no login): the forward is declined.
        const { forwardStopUrl } = await import('../../src/ritual-endpoints.js');
        const url = new URL(await forwardStopUrl(runtime, ids.F!));
        const res = await app.fetch(new Request(`http://127.0.0.1:9${url.pathname}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://127.0.0.1:9' }, body: 'choice=decline' }), runtime);
        r = res.status === 200 ? 'ok' : `e:${res.status}`;
        break;
      }
      case 'age': { const id = deliveryIds[words[1]!]; r = id ? ((await q("UPDATE mailbox_webhook_deliveries SET created_at=created_at-interval '31 days' WHERE id=$1", [id])).rowCount ? 'ok' : null) : null; break; }
      case 'prune': await pruneMailboxEvents(runtime); r = 'ok'; break;
      // A row stored before ingest recorded forward verdicts.
      case 'strip': await q("UPDATE mail_messages SET verdicts=verdicts-'forwardSafe'-'ritualVerified' WHERE workspace_id=$1 AND ses_message_id=$2", [ws, mid(words[1]!)]); r = 'ok'; break;
      default: throw new Error(`unknown action ${action}`);
    }
  } catch (e) { r = errOf(e); if (process.env.TEAR_TRACE) process.stderr.write(`TEAR_ERROR ${action}: ${(e as Error)?.stack}\n`); }
  await settleJobs();
  const safety: string[] = [];
  const v = await view(safety);
  return { r, sends: sends.slice(before).map(s => [s.ep, s.delivery, s.key !== null && s.key === deliveryIds[s.delivery ?? '']]), view: v, safety };
}

// Park every pending job of the workspace (available_at = infinity), reporting the delay it was given first.
const delays: Record<string, number | string> = {};
async function settleJobs() {
  const rows = (await q("UPDATE jobs j SET available_at='infinity' FROM (SELECT id,available_at,payload,last_error FROM jobs WHERE workspace_id=$1 AND status='pending' AND available_at<>'infinity' FOR UPDATE) o WHERE j.id=o.id RETURNING o.payload->>'deliveryId' AS d,o.last_error AS e,extract(epoch FROM o.available_at-now())*1000 AS ms", [ws])).rows;
  for (const r of rows) {
    // New work is due now; a deferral (no error, wall-clock minute or breaker window) is 'd';
    // a retry reports its backoff in whole seconds.
    const ms = Number(r.ms);
    delays[r.d] = ms <= 1000 ? 0 : r.e === null ? 'd' : Math.round(ms / 1000);
  }
}

async function view(safety: string[]) {
  const { rows } = await q(`SELECT d.id,d.webhook_id,d.status,d.attempt_count,d.last_error,d.generation,d.payload->>'messageId' AS message,d.payload->>'ritualAction' AS action,m.ses_message_id AS ses,
      a.state AS fence,(SELECT jsonb_build_object('status',j.status,'attempts',j.attempts) FROM jobs j WHERE j.workspace_id=d.workspace_id AND j.type='mailbox.webhook' AND j.payload->>'deliveryId'=d.id ORDER BY j.created_at DESC LIMIT 1) AS job
    FROM mailbox_webhook_deliveries d LEFT JOIN mail_messages m ON m.id=d.payload->>'messageId' LEFT JOIN mail_action_attempts a ON a.delivery_id=d.id WHERE d.workspace_id=$1 ORDER BY d.created_at,d.id`, [ws]);
  const deliveries: Record<string, Json> = {};
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const m = String(row.ses ?? '').slice(ws.length + 1) || '?';
    const ep = epOf[row.webhook_id] ?? '?';
    const index = row.action ? Number(String(row.action).split(':')[4]) : 0;
    const base = `${m}:${ep}${ep === 'S' && index > 0 ? index : ''}`;
    // A second row for the same message, endpoint and call is a duplicate action: label it base#2.
    const n = counts[base] = (counts[base] ?? 0) + 1;
    const label = n > 1 ? `${base}#${n}` : base;
    deliveryIds[label] = row.id;
    const job = row.job ? [row.job.status, row.job.attempts] : null;
    deliveries[label] = [row.status, row.attempt_count, row.last_error, row.fence, job, delays[row.id] ?? null];
  }
  const endpoints = (await q(`SELECT h.id,h.paused,e.verified,e.declined_at IS NOT NULL AS declined FROM mailbox_webhooks h LEFT JOIN mail_endpoints e ON e.hook_id=h.id WHERE h.workspace_id=$1`, [ws])).rows;
  const forwards = (await q(`SELECT f.message_id,f.endpoint,m.ses_message_id AS ses FROM mail_forward_once f JOIN mail_messages m ON m.id=f.message_id WHERE f.workspace_id=$1`, [ws])).rows.map(r => String(r.ses).slice(ws.length + 1)).sort();
  const sent = (await q(`SELECT count(*)::int AS n FROM sending_emails WHERE workspace_id=$1 AND to_addresses @> '["team@example.net"]'`, [ws]).catch(() => ({ rows: [{ n: -1 }] }))).rows[0].n;
  const box = (await q(`SELECT m.ses_message_id AS ses,l.labels FROM mailbox_messages l JOIN mail_messages m ON m.id=l.message_id WHERE l.mailbox_id=$1 AND l.direction='inbound'`, [`${ws}_box`])).rows;
  return { b: Object.fromEntries(box.map(r => [String(r.ses).slice(ws.length + 1), [...r.labels].sort()])), d: deliveries, e: Object.fromEntries(endpoints.map(e => [epOf[e.id] ?? e.id, [e.paused, e.declined]])), f: forwards, fs: sent };
}

process.stdin.on('close', () => setTimeout(() => process.exit(1), 3000).unref());
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const req = JSON.parse(line);
  try {
    if (req.op === 'reset') { await reset(req.retries ?? 1); out({ ok: true }); }
    else if (req.op === 'act') {
      if (process.env.TEAR_TRACE) process.stderr.write(`TEAR_ACT ${req.action}\n`);
      out({ ok: true, value: await act(req.action) });
    }
    else if (req.op === 'quit') break;
  } catch (e: any) { out({ ok: false, error: String(e?.stack ?? e) }); }
}
if (ws) await cleanup(ws).catch(() => {});
await checker.end();
process.exit(0);
