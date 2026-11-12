// tear product host for admission and rate limits: drives the real API code over an isolated
// PostgreSQL, one JSON request per stdin line and one JSON reply per stdout line.
//   {"op":"reset","profile":"recv","cfg":{...}}   fresh synthetic workspace for one trace
//   {"op":"act","action":"W accept m1 a"}           one model action; returns {r, woke, view, safety}
//
// Profiles
// - recv: the receive-side hourly window and ingest backlog of two hosted workspaces A < B that one
//   SNS message can address together. Notifications run the real acceptInboundNotification (the
//   hosted route statement and its triggers); `legacy-accept` runs the previous Worker's route
//   SQL (its reopen bound counts duplicates) against the same database; budget holds use the
//   real global release_receive_budget_holds(NULL). Ingest claim and settle are fixture steps
//   with the real settle fence (status pending and the claimed recipients unchanged).
// - send: hosted send admission. POST /v1/emails/send and /v1/emails/batch go through the real app
//   with a bearer API key (the single-statement atomic admission, key budget included); operator
//   changes use the real scripts (set-hosted-limits, set-workspace-exemption) and SQL builders
//   (pause/resume); dispatch outcomes change sending_emails.status so the real refund trigger runs.
//
// Connections W, V and X hold their statement's transaction open until a separate commit or abort
// step, so a step can land between a statement's locks and its COMMIT. A statement waiting on
// another of this host's backends is reported as "blocked". Unprefixed actions are autocommit
// requests on a separate connection with a 500 ms lock timeout (the model never lets one wait).
//
// Time moves only on fixture steps, which shift the stored timestamps back (an hour, a minute,
// 23 hours, 70 hours, 7 days). A trace must not cross a real hour or minute boundary: reset waits
// out the last 1.5 s of a minute, and an action that sees a new real minute fails the trace.
//
// It runs only on a dedicated, migrated database its creator marked disposable
// (../disposable.ts, the rule every tear host shares): TEAR_DATABASE_URL must be a plain loopback
// URL, and the marker and the foreign-data check pass before the first write and before every
// fixture. Its workspaces are tear_adm_*.
import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
const hex = (n: number) => Array.from({ length: Math.ceil(n / 32) }, () => randomUUID().replaceAll('-', '')).join('').slice(0, n);

// The app logs JSON to the console; keep stdout for the protocol.
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) console[level] = (...a: unknown[]) => { process.stderr.write(a.map(String).join(' ') + '\n'); };
const out = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');

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

const [{ createApp }, { nodeRuntime }, { acceptInboundNotification, recoverHeldReceipts }, { setHostedLimits }, { setWorkspaceExemption }, { pauseHostedSending, resumeHostedSending }, { digest }, { cleanup, reconcileUploads }, { drainJobs }] = await Promise.all([
  import('../../src/app.js'), import('../../src/adapters/node.js'), import('../../src/mailbox-receipts.js'),
  import('../../scripts/set-hosted-limits.js'), import('../../scripts/set-workspace-exemption.js'), import('../../src/states.js'), import('../../src/core.js'), import('../../src/maintenance.js'),
  import('../../src/dispatch.js'),
]);
const { recoverMailReceipts } = await import('../../src/mailbox-ingest.js');
// No egress: object storage points at a closed loopback port and fetch refuses every call, so an
// unmodelled job or adapter fails locally instead of reaching a real endpoint.
globalThis.fetch = (async (input: unknown) => { throw new Error(`tear host: network access refused (${String(input)})`); }) as typeof fetch;
const instance = nodeRuntime({ DATABASE_URL, BETTER_AUTH_SECRET: hex(64), GOOGLE_CLIENT_ID: 'tear-fixture', GOOGLE_CLIENT_SECRET: 'tear-fixture',
  AUTH_ALLOWED_EMAILS: 'operator@example.com', PUBLIC_URL: 'http://127.0.0.1:9', ENABLE_LIVE_SES: 'false', S3_BUCKET: 'tear-fixture', S3_ACCESS_KEY_ID: 'tear', S3_SECRET_ACCESS_KEY: 'tear',
  S3_ENDPOINT: 'http://127.0.0.1:9' });
const runtime = instance.runtime;
const baseConfig = structuredClone({ ...runtime.config, aws: undefined });
const app = createApp();
const POOL = '210987654321', REGION = 'us-east-1', BUCKET = 'tear-fixture', TOPIC = `arn:aws:sns:${REGION}:${POOL}:tear-inbound`;
const FEEDBACK = `arn:aws:sns:${REGION}:${POOL}:tear-feedback`;
type Json = any;
type Db = NodePgDatabase<Record<string, unknown>>;

async function client() {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  const pid = (await c.query('SELECT pg_backend_pid() pid')).rows[0].pid as number;
  // Count the round trips each request makes (the admission budget is one statement).
  const query = c.query.bind(c) as (...a: unknown[]) => unknown;
  const counted = { n: 0, legacy: false };
  (c as Json).query = (...a: unknown[]) => {
    counted.n++;
    if (counted.legacy) a[0] = legacySql(a[0]);
    return query(...a);
  };
  return { client: c, db: drizzle(c) as unknown as Db, pid, counted };
}
// The previous Worker's route statement (before 96c9c9f and this branch's ordering): the reopen
// bound counted both recipient lists with duplicates, and receipts and jobs were not ordered.
const ROUTE_BOUND = '(SELECT count(DISTINCT a) FROM jsonb_array_elements_text(r.recipients||excluded.recipients) v(a))<=200';
function legacySql(q: unknown): unknown {
  const patch = (text: string) => {
    if (!text.includes('INSERT INTO mail_receipts AS r')) return text;
    if (!text.includes(ROUTE_BOUND)) throw new Error('tear host: the route statement changed; update legacySql');
    return text.replace(ROUTE_BOUND, 'jsonb_array_length(r.recipients||excluded.recipients)<=200').replace(/ ORDER BY g\.workspace_id(,s\.mid)?/g, '').replace(/ ORDER BY workspace_id,ses_message_id/g, '');
  };
  if (typeof q === 'string') return patch(q);
  if (q && typeof q === 'object' && typeof (q as Json).text === 'string') return { ...(q as Json), text: patch((q as Json).text) };
  return q;
}
type Conn = Awaited<ReturnType<typeof client>> & { name: string; open: boolean; pending?: Promise<void>; settled?: { ok: boolean; value: unknown } };
const conns: Record<string, Conn> = {};
for (const name of ['W', 'V', 'X']) conns[name] = { ...(await client()), name, open: false };
const auto = await client(), checker = await client();
await auto.client.query("SET lock_timeout='500ms'");

let profile: 'recv' | 'send' | 'upload' = 'recv', cfg: Json = {}, ws: string[] = [], hours = 0, minute = '';
const errOf = (e: any) => `e:${e?.cause?.code ?? e?.code ?? e?.message ?? 'ERROR'}`;

async function abortAll() {
  for (const slot of Object.values(slots)) if (slot.response) { slot.put?.reject(new Error('tear host: reset')); await slot.response.catch(() => {}); slot.response = undefined; slot.put = undefined; }
  for (const c of Object.values(conns)) if (c.pending && !c.settled) await checker.client.query('SELECT pg_cancel_backend($1)', [c.pid]);
  for (const c of Object.values(conns)) {
    if (c.pending) await c.pending;
    if (c.open) await c.client.query('ROLLBACK');
    Object.assign(c, { open: false, pending: undefined, settled: undefined });
  }
}

// ---------- time ----------
async function realMinute() { return (await checker.client.query("SELECT date_trunc('minute',now())::text m")).rows[0].m as string; }
async function guardClock() {
  // Stay clear of a real minute (and so hour) boundary for the length of one trace.
  // ... and of the hour by 15 s: a release moves a busy hold ten seconds ahead.
  const ms = Date.now() % 60_000, hourMs = Date.now() % 3_600_000;
  if (hourMs > 3_585_000) await new Promise(r => setTimeout(r, 3_600_000 - hourMs + 50));
  else if (ms > 58_500) await new Promise(r => setTimeout(r, 60_000 - ms + 50));
  minute = await realMinute();
}
async function checkClock() { if (await realMinute() !== minute) throw new Error('tear host: the trace crossed a real minute boundary; rerun it'); }

// ---------- fixtures ----------
let tableSet: Set<string> | undefined;
const tables_ = async () => tableSet ??= new Set((await auto.client.query('SELECT tablename FROM pg_tables WHERE schemaname=current_schema()')).rows.map(r => r.tablename as string));
async function dropWorkspaces() {
  if (!ws.length) return;
  // One round trip: the ids are this host's own tear_adm_<hex> names.
  if (ws.some(w => !/^tear_adm_[0-9a-f]{12}(_[ab])?$/.test(w))) throw new Error('tear host: refusing to drop an unexpected workspace id');
  const list = ws.map(w => `'${w}'`).join(',');
  const tables = ['mail_receipts', 'mail_receive_windows', 'mail_receive_limits', 'mail_ingest_turns', 'jobs', 'mailbox_domains', 'mailbox_regions', 'sending_emails',
    'sending_idempotency', 'hosted_usage_hourly', 'hosted_health_hourly', 'api_request_budgets', 'api_keys', 'domain_sending_bindings', 'domain_claims', 'operation_domains',
    'sending_stream_depth', 'job_schedule', 'hosted_operator_audit', 'ses_installation_settings', 'operation_unsubscribe_tokens',
    'sending_upload_reservations', 'sending_upload_tombstones', 'sending_attachments', 'sending_asset_usage', 'provider_connections'];
  const existing = await tables_();
  await auto.client.query(['BEGIN', ...tables.filter(t => existing.has(t)).map(t => `DELETE FROM ${t} WHERE workspace_id IN (${list})`),
    `DELETE FROM mail_ignored_staging WHERE ses_message_id LIKE '${ws[0]}%'`, `DELETE FROM mail_receipt_holds WHERE ses_message_id LIKE '${ws[0]}%'`, `DELETE FROM workspaces WHERE id IN (${list})`, 'COMMIT'].join(';\n'));
  ws = [];
}

async function reset(p: 'recv' | 'send' | 'upload', c: Json) {
  await abortAll();
  await assertDisposable(text => checker.client.query(text));
  await dropWorkspaces();
  profile = p; cfg = c; hours = 0;
  await guardClock();
  try { if (p === 'recv') await resetRecv(); else if (p === 'send') await resetSend(); else await resetUpload(); }
  catch (e) { await auto.client.query('ROLLBACK').catch(() => {}); throw e; }
  await view([]);
}

// recv: hosted workspaces A and B (ids sort A < B), each receiving for its own domain through the
// shared pool, with the configured limits. Recipients a and c (and the numbered h001...h101) are
// A's, b is B's, so one message can create receipts in both.
let hosts: string[] = [];
const claims = new Map<string, string>();
async function resetRecv() {
  const base = 'tear_adm_' + hex(12);
  ws = [`${base}_a`, `${base}_b`];
  Object.assign(runtime.config, structuredClone(baseConfig), { workspaceId: ws[0], multiTenant: true });
  hosts = ws.map(w => `${w.replaceAll('_', '-')}.invalid`);
  claims.clear();
  const c = auto.client;
  await c.query('BEGIN');
  await c.query(`INSERT INTO provider_pool_regions(region,aws_account_id,feedback_topic_arn,sending_state,pool_tier,legacy_names,inbound_topic_arn,inbound_bucket,receiving_state)
    VALUES($1,$2,$3,'ready','trusted',false,$4,$5,'ready') ON CONFLICT(region) DO UPDATE SET inbound_topic_arn=excluded.inbound_topic_arn,inbound_bucket=excluded.inbound_bucket,receiving_state='ready'`, [REGION, POOL, FEEDBACK, TOPIC, BUCKET]);
  for (const [i, w] of ws.entries()) {
    const host = hosts[i]!, limit = cfg.limits[i];
    await c.query('INSERT INTO workspaces(id,name,slug) VALUES($1,$1,$1)', [w]);
    await c.query(`INSERT INTO provider_connections(id,workspace_id,region,state,kind,aws_account_id,tenant_state) VALUES($1,$1,$2,'ready','shared',$3,'ready')`, [w, REGION, POOL]);
    await c.query(`INSERT INTO domain_claims(name,workspace_id,connection_id,sending_state,receiving_state,receiving_host,receiving_proved_at,receiving_identity_at)
      VALUES($1,$2,$2,'verified','active',$1,now(),now())`, [host, w]);
    await c.query('INSERT INTO operation_domains(id,name,workspace_id,region) VALUES($1,$2,$3,$4)', [`${w}_dom`, host, w, REGION]);
    await c.query(`INSERT INTO mailbox_domains(id,workspace_id,domain_id,name,region,status,catch_all,receiving_host) VALUES($1,$2,$3,$4,$5,'active','store',$4)`, [`${w}_mdom`, w, `${w}_dom`, host, REGION]);
    await c.query('INSERT INTO mail_receive_limits(workspace_id,message_limit,backlog_limit) VALUES($1,$2,$3)', [w, limit[0], limit[1]]);
  }
  await c.query('COMMIT');
}
const sesId = (m: string) => `${ws[0]}_${m}`;
const recipients = (r: string): string[] => {
  if (r === '0') return [];
  if (r === 'h' || r === 'x') return Array.from({ length: r === 'h' ? 100 : 101 }, (_, i) => `h${String(i + 1).padStart(3, '0')}@${hosts[0]}`);
  return [...r].map(ch => `${ch}@${hosts[ch === 'b' ? 1 : 0]}`).sort();
};
const wsOf = (x: string) => ws[x === 'A' ? 0 : 1]!;

// send: hosted (multi-tenant, regional, trusted pool) workspaces W1 and W2 that share a quota
// sponsor, each with a ready shared connection, a verified sender domain and one send key.
const keys: Record<string, string> = {}, keyIds: Record<string, string> = {};
const KEY_WS: Record<string, string> = { 1: '1', 2: '2', 3: '1' };
const domainOf = (x: string) => `${ws[Number(x) - 1]!.replaceAll('_', '-')}.invalid`;
async function resetSend() {
  const sponsor = 'tear-sponsor-' + hex(8);
  ws = ['tear_adm_' + hex(12), 'tear_adm_' + hex(12)];
  Object.assign(runtime.config, structuredClone(baseConfig), {
    workspaceId: ws[0], multiTenant: true, liveEnabled: true, aws: { accessKeyId: 'tear-fixture', secretAccessKey: 'tear-fixture' },
    regionalSending: true, trustedPool: true, requireDmarcForBulk: true, apiRateLimitPerMinute: cfg.rate,
    hostedSendCaps: { firstWeek: cfg.caps[0], secondWeek: cfg.caps[1], mature: cfg.caps[2] }, dispatch: { ...baseConfig.dispatch, dailyHeadroomPercent: cfg.headroom },
  });
  const c = auto.client;
  await c.query('BEGIN');
  await c.query("INSERT INTO provider_pool_regions(region,aws_account_id,feedback_topic_arn,sending_state,pool_tier,legacy_names) VALUES($1,$2,$3,'ready','trusted',false) ON CONFLICT DO NOTHING", [REGION, POOL, FEEDBACK]);
  const identity = { dmarc: { status: 'reject', checkedAt: Date.now() + 365 * 86_400_000 }, ses: { DkimAttributes: { SigningEnabled: true, Status: 'SUCCESS' } } };
  for (const [i, w] of ws.entries()) {
    const x = String(i + 1), d = domainOf(x);
    await c.query('INSERT INTO workspaces(id,name,slug,quota_sponsor) VALUES($1,$1,$1,$2)', [w, sponsor]);
    await c.query(`INSERT INTO provider_connections(id,workspace_id,region,state,kind,aws_account_id,tenant_state,created_at,pool_tenant_name) VALUES($1,$1,$2,'ready','shared',$3,'ready',now(),$4)`, [w, REGION, POOL, `bane-trusted-${w}`]);
    // The connection row creates its region row; make it a ready trusted-pool tenant.
    await c.query(`INSERT INTO provider_connection_regions(connection_id,region) VALUES($1,$2) ON CONFLICT DO NOTHING`, [w, REGION]);
    await c.query(`UPDATE provider_connection_regions SET sending_state='ready',tenant_state='ready',pool_tenant_name=$3 WHERE connection_id=$1 AND region=$2`, [w, REGION, `bane-trusted-${w}`]);
    await c.query(`INSERT INTO domain_claims(name,workspace_id,connection_id,sending_state,identity) VALUES($1,$2,$2,'verified',$3)`, [d, w, JSON.stringify(identity)]);
    await c.query(`INSERT INTO operation_domains(id,name,workspace_id,region) VALUES($1,$2,$3,$4)`, [`${w}_dom`, d, w, REGION]);
    await c.query(`INSERT INTO domain_sending_bindings(workspace_id,name,domain_id,connection_id,region) VALUES($1,$2,$3,$1,$4) ON CONFLICT DO NOTHING`, [w, d, `${w}_dom`, REGION]);
    await c.query(`INSERT INTO ses_installation_settings(workspace_id,installation_id,default_region,enabled_regions) VALUES($1,$1,$2,jsonb_build_array($2::text))`, [w, REGION]);
  }
  for (const [k, x] of Object.entries(KEY_WS)) {
    const token = 'bane_' + hex(64);
    keys[k] = token; keyIds[k] = `key${k}_${hex(12)}`;
    await c.query(`INSERT INTO api_keys(id,workspace_id,name,hash,prefix,permissions,domains) VALUES($1,$2,'tear',$3,'bane_',$4,'[]')`, [keyIds[k], ws[Number(x) - 1], await digest(token), JSON.stringify(['read', 'send'])]);
  }
  await c.query('COMMIT');
  // Warm each key's verified fingerprint (sends then take the one-statement path) and forget the charge.
  for (const x of Object.keys(KEY_WS)) {
    const r = await request(auto.db, 'GET', '/v1/me', x);
    if (r.status !== 200) throw new Error(`tear host: fixture key ${x} is not usable: ${JSON.stringify(r.body)}`);
  }
  await c.query('DELETE FROM api_request_budgets WHERE workspace_id=ANY($1)', [ws]);
}

async function request(db: Db, method: string, path: string, key: string, body?: unknown, headers: Record<string, string> = {}) {
  const req = new Request(`http://127.0.0.1:9${path}`, { method, headers: { authorization: `Bearer ${keys[key]}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await app.fetch(req, { ...runtime, db } as Json);
  return { status: res.status, body: await res.json() as Json };
}

// upload: one single-tenant workspace whose stored-attachment quota has room for `room` more
// uploads of SIZE bytes (a seed reservation holds the rest). Each slot (U1-U3) uploads through
// POST /v1/attachments on its own connection with its own storage adapter, which suspends the
// R2 put until `Ux ok` or `Ux fail`, so steps can land between reserve, put and finish.
const LIMIT = 1024 * 1024 * 1024, SIZE = 3, SLOTS = ['U1', 'U2', 'U3'];
type Slot = { db: Awaited<ReturnType<typeof client>>; object?: string; put?: { resolve: () => void; reject: (e: Error) => void; reached: () => void }; atPut?: Promise<void>; response?: Promise<unknown> };
const slots: Record<string, Slot> = {};
for (const n of SLOTS) slots[n] = { db: await client() };
// Objects stored and not deleted, labelled o1, o2, ... in the order their uploads reserved, with
// the day they landed (`day` moves every object a day into the past).
const written = new Map<string, number>(), objectLabel = new Map<string, string>();
let today = 0;
// What the hourly cleanup and the job runner see of storage: a listing, and their deletions.
const listing = { put: async () => {}, get: async () => null, delete: async (key: string) => { written.delete(key); },
  list: async (prefix: string, cursor?: string) => {
    const keys = [...written.keys()].filter(k => k.startsWith(prefix)).sort().filter(k => !cursor || k > cursor).slice(0, 1000);
    return { objects: keys.map(key => ({ key, uploaded: new Date(Date.now() - (today - written.get(key)!) * 86_400_000 - 60_000) })), cursor: keys.length === 1000 ? keys.at(-1) : undefined };
  } };
let attachments: Record<string, string> = {};
async function resetUpload() {
  const w = 'tear_adm_' + hex(12); ws = [w];
  Object.assign(runtime.config, structuredClone(baseConfig), { workspaceId: w, multiTenant: false });
  written.clear(); objectLabel.clear(); attachments = {}; today = 0;
  const c = auto.client, token = 'bane_' + hex(64);
  keys['1'] = token; keyIds['1'] = `key1_${hex(12)}`;
  await c.query('BEGIN');
  await c.query('INSERT INTO workspaces(id,name,slug) VALUES($1,$1,$1)', [w]);
  await c.query(`INSERT INTO api_keys(id,workspace_id,name,hash,prefix,permissions,domains) VALUES($1,$2,'tear',$3,'bane_',$4,'[]')`, [keyIds['1'], w, await digest(token), JSON.stringify(['read', 'send'])]);
  await c.query(`INSERT INTO sending_upload_reservations(id,workspace_id,storage_key,size,expires_at) VALUES($1,$2,'tear-seed',$3,now()+interval '100 years')`, [`${w}_seed`, w, LIMIT - cfg.room * SIZE]);
  await c.query('COMMIT');
}
function slotRuntime(name: string) {
  const slot = slots[name]!;
  const storage = {
    put: (key: string) => new Promise<void>((resolve, reject) => {
      objectLabel.set(key, `o${objectLabel.size + 1}`); slot.object = objectLabel.get(key);
      slot.put!.reached();
      slot.put = { ...slot.put!, resolve: () => { written.set(key, today); resolve(); }, reject };
    }),
    get: async () => null, delete: async () => {},
  };
  return { ...runtime, db: slot.db.db, storage } as Json;
}
const uploadBody = (key?: string, other = false) => ({ filename: key ? `keyed-${key}${other ? '-other' : ''}.txt` : `upload-${counter++}.txt`, contentType: 'text/plain', content: Buffer.from(other ? 'xyz' : 'abc').toString('base64') });
async function uploadResult(r: Promise<unknown>) {
  const res = await r as Response;
  const body = await res.json() as Json;
  if (res.status !== 201) return `${res.status}:${body?.error?.code ?? '?'}`;
  let label = Object.keys(attachments).find(k => attachments[k] === body.id);
  if (!label) { label = `a${Object.keys(attachments).length + 1}`; attachments[label] = body.id; }
  return label;
}
// Start an upload; it returns at the suspended R2 put, or with the response if it ended before.
async function upload(name: string, key?: string, other = false) {
  const slot = slots[name]!;
  let reached!: () => void;
  slot.atPut = new Promise<void>(r => { reached = r; });
  slot.put = { resolve: () => {}, reject: () => {}, reached };
  const req = new Request('http://127.0.0.1:9/v1/attachments', { method: 'POST', headers: { authorization: `Bearer ${keys['1']}`, 'content-type': 'application/json', ...(key ? { 'Idempotency-Key': `${ws[0]}-${key}` } : {}) }, body: JSON.stringify(uploadBody(key, other)) });
  slot.response = Promise.resolve(app.fetch(req, slotRuntime(name)));
  const first = await Promise.race([slot.atPut.then(() => 'at-put'), slot.response.then(() => 'done')]);
  if (first === 'at-put') return 'at-put';
  const r = await uploadResult(slot.response); slot.response = undefined; slot.put = undefined; return r;
}
// The put lands and the Worker dies before finish or its refund: the request never continues.
function crash(name: string) {
  const slot = slots[name]!;
  if (!slot.response || !slot.put) throw new Error(`tear host: ${name} is not at its put`);
  for (const key of objectLabel.keys()) if (!written.has(key) && objectLabel.get(key) === slot.object) written.set(key, today);
  slot.response = undefined; slot.put = undefined;
  return 'crashed';
}
async function resolvePut(name: string, ok: boolean) {
  const slot = slots[name]!;
  if (!slot.response || !slot.put) throw new Error(`tear host: ${name} is not at its put`);
  if (ok) slot.put.resolve(); else slot.put.reject(Object.assign(new Error('R2 put failed (tear fixture)'), { name: 'InternalError' }));
  const r = await uploadResult(slot.response); slot.response = undefined; slot.put = undefined; return r;
}

// ---------- recv actions ----------
function notification(m: string, r: string) {
  const id = sesId(m), to = recipients(r);
  return { notificationType: 'Received', mail: { messageId: id, timestamp: new Date().toISOString(), source: 'sender@example.invalid', destination: to },
    receipt: { timestamp: new Date().toISOString(), recipients: to, action: { type: 'S3', bucketName: BUCKET, objectKey: `staging/${id}`, topicArn: TOPIC } } };
}
const accept = (c: Awaited<ReturnType<typeof client>>, m: string, r: string, legacy = false) => async () => {
  c.counted.legacy = legacy;
  try { return { queued: await acceptInboundNotification({ ...runtime, db: c.db } as Json, { topicArn: TOPIC, region: REGION, message: notification(m, r) }) }; }
  finally { c.counted.legacy = false; }
};

// ---------- send actions ----------
let emails: Record<string, string> = {}, counter = 0;
const mailBody = (x: string, n: number, kind: string, i = 0) => ({ from: `sender@${domainOf(x)}`, to: Array.from({ length: n }, (_, k) => `r${k}-${i}@example.net`), subject: 'Synthetic admission', text: 'No SES send happens here.', kind });
// The statement each held or autocommit send action runs, with its round trips counted.
// send K N t|m: N recipients through key K; batch K: two one-recipient emails; idem K k: the same
// keyed request each time; idem-other K k: a different body under the same Idempotency-Key.
function sendStatement(words: string[], c: Awaited<ReturnType<typeof client>>): () => Promise<unknown> {
  const [verb, k, a, b] = words as [string, string, string, string];
  const x = KEY_WS[k]!;
  return async () => {
    const before = c.counted.n;
    let r;
    if (verb === 'send') r = await request(c.db, 'POST', '/v1/emails/send', k, mailBody(x, Number(a), b === 'm' ? 'marketing' : 'transactional', counter++));
    else if (verb === 'batch') r = await request(c.db, 'POST', '/v1/emails/batch', k, { emails: [mailBody(x, 1, 'transactional', counter++), mailBody(x, 1, 'transactional', counter++)] });
    else if (verb === 'idem') r = await request(c.db, 'POST', '/v1/emails/send', k, { ...mailBody(x, 1, 'transactional', 0), subject: `Keyed ${a}` }, { 'Idempotency-Key': `${ws[0]}-${a}` });
    else if (verb === 'idem-other') r = await request(c.db, 'POST', '/v1/emails/send', k, { ...mailBody(x, 1, 'transactional', 9), subject: `Other ${a}` }, { 'Idempotency-Key': `${ws[0]}-${a}` });
    else throw new Error(`unknown send verb ${verb}`);
    const statements = c.counted.n - before;
    if (r.status === 202) {
      const ids = r.body.data ? r.body.data.map((e: Json) => e.id) : [r.body.id];
      const labels = [];
      for (const id of ids) {
        let label = Object.keys(emails).find(k => emails[k] === id);
        if (!label) { label = `e${Object.keys(emails).length + 1}`; emails[label] = id; }
        labels.push(label);
      }
      return { ok: labels, statements };
    }
    return { error: `${r.status}:${r.body?.error?.code ?? '?'}`, statements };
  };
}

async function operator(words: string[], c: Awaited<ReturnType<typeof client>>): Promise<unknown> {
  const [verb, x, v, p] = words as [string, string, string, string];
  const w = ws[Number(x) - 1]!;
  switch (verb) {
    case 'limits': await setHostedLimits(c.client, [w, '--send-cap', v, '--pending-cap', p]); return 'ok';
    case 'exempt': await setWorkspaceExemption(c.client, [w, v, '--reason', 'tear fixture']); return 'ok';
    case 'pause': return (await c.db.execute(pauseHostedSending(sql`SELECT ${w}::text AS id,(SELECT resumed_at FROM provider_connections WHERE id=${w}) AS resumed_at,'tear fixture hold'::text AS reason,0 AS sends,0 AS bounces,0 AS complaints`))).rowCount ? 'ok' : 'noop';
    case 'resume': return (await c.db.execute(resumeHostedSending(w))).rowCount ? 'ok' : 'noop';
  }
  throw new Error(`unknown operator verb ${verb}`);
}

// ---------- transactions ----------
async function settle(c: Conn): Promise<unknown> {
  const start = Date.now();
  for (;;) {
    if (c.settled) { const s = c.settled; c.pending = c.settled = undefined; return s.ok ? s.value : errOf(s.value); }
    const own = [...Object.values(conns).map(x => x.pid), auto.pid];
    const w = (await checker.client.query("SELECT wait_event_type='Lock' AND pg_blocking_pids($1) && $2::int[] AS blocked,pg_blocking_pids($1) AS by FROM pg_stat_activity WHERE pid=$1", [c.pid, own])).rows[0];
    if (w?.blocked && !c.settled) {
      if (process.env.TEAR_TRACE) process.stderr.write(`TEAR_BLOCKED ${c.name} by ${w.by.map((p: number) => Object.values(conns).find(x => x.pid === p)?.name ?? p).join(',')}\n`);
      return 'blocked';
    }
    if (Date.now() - start > 10_000) return 'stuck';
  }
}
async function run(c: Conn, fn: () => Promise<unknown>) {
  await c.client.query('BEGIN'); c.open = true;
  c.settled = undefined;
  c.pending = fn().then(value => { c.settled = { ok: true, value }; }, value => { c.settled = { ok: false, value }; });
  return settle(c);
}
async function finish(c: Conn, commit: boolean) {
  let r: unknown = 'ok';
  try { await c.client.query(commit ? 'COMMIT' : 'ROLLBACK'); } catch (e) { r = errOf(e); }
  c.open = false;
  const woke: Record<string, unknown> = {};
  for (const other of Object.values(conns)) if (other.pending) { const v = await settle(other); if (v !== 'blocked') woke[other.name] = v; }
  return { r, woke };
}
async function autoTxn<T>(fn: () => Promise<T>): Promise<unknown> {
  await auto.client.query('BEGIN');
  try { const v = await fn(); await auto.client.query('COMMIT'); return v; } catch (e) { await auto.client.query('ROLLBACK'); return errOf(e); }
}

// The statement a held or autocommit action runs.
function statement(words: string[], c: Awaited<ReturnType<typeof client>>): () => Promise<unknown> {
  const verb = words[0]!;
  if (verb === 'accept' || verb === 'legacy-accept') return accept(c, words[1]!, words[2]!, verb === 'legacy-accept');
  if (verb === 'release') return async () => (await c.client.query('SELECT release_receive_budget_holds(NULL) n')).rows[0].n;
  if (verb === 'replay') return async () => recoverHeldReceipts({ ...runtime, db: c.db } as Json);
  if (['send', 'batch', 'idem', 'idem-other'].includes(verb)) return sendStatement(words, c);
  if (['limits', 'exempt', 'pause', 'resume'].includes(verb)) return () => operator(words, c);
  throw new Error(`unknown statement ${words.join(' ')}`);
}

async function act(action: string) {
  await checkClock();
  const words = action.split(' ');
  if (slots[words[0]!]) {
    const [name, verb, key] = words as [string, string, string];
    const r = verb === 'upload' ? await upload(name, key) : verb === 'upload-other' ? await upload(name, key, true) : verb === 'crash' ? crash(name) : await resolvePut(name, verb === 'ok');
    const safety: string[] = [];
    return { r, woke: {}, view: await view(safety), safety };
  }
  const c = conns[words[0]!];
  const rest = c ? words.slice(1) : words;
  const verb = rest[0]!;
  let r: unknown, woke: Record<string, unknown> = {};
  if (c) {
    if (verb === 'commit' || verb === 'abort') ({ r, woke } = await finish(c, verb === 'commit'));
    else r = await run(c, statement(rest, c));
  } else r = await autoAct(rest);
  const safety: string[] = [];
  return { r, woke, view: await view(safety), safety };
}

// Move stored timestamps back, as if the time passed. Moving created_at would fire the refund
// trigger (it moves usage between hours), so it is off for this one transaction only.
const shift = async (interval: string, targets: [string, string][]) => {
  await auto.client.query('BEGIN');
  try {
    await auto.client.query('ALTER TABLE sending_emails DISABLE TRIGGER hosted_adjust');
    for (const [table, column] of targets) await auto.client.query(`UPDATE ${table} SET ${column}=${column}-$2::interval WHERE workspace_id=ANY($1)`, [ws, interval]);
    await auto.client.query('ALTER TABLE sending_emails ENABLE TRIGGER hosted_adjust');
    await auto.client.query('COMMIT');
  } catch (e) { await auto.client.query('ROLLBACK'); throw e; }
};
async function autoAct(words: string[]): Promise<unknown> {
  const [verb, a, b] = words as [string, string, string];
  switch (verb) {
    case 'accept': case 'legacy-accept': return autoTxn(accept(auto, a, b, verb === 'legacy-accept'));
    case 'claim': return autoTxn(async () => {
      // An ingest runner claims the oldest pending job (skipping locked ones) and reads the
      // receipt's recipients for it.
      const w = wsOf(a), mid = sesId(b);
      const { rows } = await auto.client.query(`WITH j AS (SELECT id FROM jobs WHERE workspace_id=$1 AND type='mailbox.ingest' AND payload->>'sesMessageId'=$2 AND status='pending' ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED)
        UPDATE jobs SET status='running',attempts=attempts+1,lease_until=now()+interval '10 minutes' FROM j WHERE jobs.id=j.id
        RETURNING jobs.id,(SELECT recipients FROM mail_receipts WHERE workspace_id=$1 AND ses_message_id=$2) AS recipients`, [w, mid]);
      if (!rows[0]) return 0;
      claims.set(rows[0].id, JSON.stringify(rows[0].recipients));
      return 1;
    });
    case 'fail': case 'lose': return autoTxn(async () => {
      // The oldest running job stops. fail: its final attempt failed permanently; the handler's
      // terminal write (mailbox-ingest.ts) fails the receipt as claimed. lose: the job ended
      // without touching its receipt (a dropped or crashed attempt).
      const w = wsOf(a), mid = sesId(b);
      const job = (await auto.client.query(`SELECT id FROM jobs WHERE workspace_id=$1 AND type='mailbox.ingest' AND payload->>'sesMessageId'=$2 AND status='running' ORDER BY created_at,id LIMIT 1`, [w, mid])).rows[0];
      if (!job) return 'e:no-running-job';
      const failed = verb === 'fail' ? (await auto.client.query("UPDATE mail_receipts SET status='failed',error='MAILBOX_INGEST_FAILED',processed_at=now() WHERE workspace_id=$1 AND ses_message_id=$2 AND status='pending' AND recipients=$3::jsonb", [w, mid, claims.get(job.id)])).rowCount : 0;
      await auto.client.query(`UPDATE jobs SET status=$2 WHERE id=$1`, [job.id, verb === 'fail' ? 'failed' : 'completed']);
      return failed;
    });
    case 'recover': {
      // Half an hour passes for pending receipts, then the real lost-receipt recovery runs.
      await auto.client.query("UPDATE mail_receipts SET last_recovered_at=now()-interval '31 minutes' WHERE workspace_id=ANY($1) AND status='pending'", [ws]);
      await recoverMailReceipts(runtime);
      return Number((await auto.client.query("SELECT count(*) n FROM mail_receipts WHERE workspace_id=ANY($1) AND last_recovered_at>now()-interval '1 minute'", [ws])).rows[0].n);
    }
    case 'stash': {
      // An envelope held for a host that was not routable yet, due for replay now (again, after a replay
      // released an earlier one for the message).
      const to = recipients(b), owners = Object.fromEntries(to.map(addr => [addr, [wsOf(addr.includes(hosts[1]!) ? 'B' : 'A')]]));
      await auto.client.query(`INSERT INTO mail_receipt_holds(bucket,ses_message_id,region,topic_arn,binding_workspace,owners,recipients,notification,received_at,expires_at,next_check,status)
        VALUES($1,$2,$3,$4,NULL,$5,$6,'{}',now(),now()+interval '48 hours',now()-interval '1 second','held')
        ON CONFLICT(bucket,ses_message_id) DO UPDATE SET owners=excluded.owners,recipients=excluded.recipients,expires_at=excluded.expires_at,next_check=excluded.next_check,status='held',error=NULL`, [BUCKET, sesId(a), REGION, TOPIC, JSON.stringify(owners), JSON.stringify(to)]);
      return 'ok';
    }
    case 'replay': return autoTxn(statement(words, auto));
    case 'done': return autoTxn(async () => {
      // The oldest running job finishes: it settles the receipt only if it is still pending with the
      // recipients this job claimed (the store's fence), then completes.
      const w = wsOf(a), mid = sesId(b);
      const job = (await auto.client.query(`SELECT id FROM jobs WHERE workspace_id=$1 AND type='mailbox.ingest' AND payload->>'sesMessageId'=$2 AND status='running' ORDER BY created_at,id LIMIT 1`, [w, mid])).rows[0];
      if (!job) return 'e:no-running-job';
      const settled = (await auto.client.query("UPDATE mail_receipts SET status='processed',processed_at=now() WHERE workspace_id=$1 AND ses_message_id=$2 AND status='pending' AND recipients=$3::jsonb", [w, mid, claims.get(job.id)])).rowCount;
      await auto.client.query("UPDATE jobs SET status='completed' WHERE id=$1", [job.id]);
      return settled;
    });
    case 'release': return autoTxn(statement(words, auto));
    case 'hour': hours++; await shift('1 hour', [['mail_receive_windows', 'window_at'], ['mail_receipts', 'budget_retry_at'], ['mail_receipts', 'created_at'], ['hosted_usage_hourly', 'hour'], ['sending_emails', 'created_at'], ['api_request_budgets', 'window_start']]); return 'ok';
    case 'days': await shift('70 hours', [['mail_receipts', 'created_at']]); return 'ok';
    case 'h23': hours += 23; await shift('23 hours', [['hosted_usage_hourly', 'hour'], ['sending_emails', 'created_at'], ['api_request_budgets', 'window_start']]); return 'ok';
    case 'minute': await shift('1 minute', [['api_request_budgets', 'window_start']]); return 'ok';
    case 'send': case 'batch': case 'idem': case 'idem-other': return autoTxn(sendStatement(words, auto));
    case 'limits': case 'exempt': case 'pause': case 'resume': return autoTxn(statement(words, auto));
    case 'week': {
      // Seven days pass for the connection's age; the health history (if any) ages with it.
      await auto.client.query("UPDATE provider_connections SET created_at=created_at-interval '7 days' WHERE workspace_id=ANY($1)", [ws]);
      return 'ok';
    }
    case 'history': {
      // history X N: N clean accepted recipients a day ago in workspace X's current health epoch.
      const w = ws[Number(a) - 1]!;
      await auto.client.query(`INSERT INTO hosted_health_hourly(workspace_id,epoch,hour,accepted,bounces,complaints)
        SELECT $1,coalesce(resumed_at,'-infinity'),date_trunc('hour',now())-interval '25 hours',$2,0,0 FROM provider_connections WHERE id=$1
        ON CONFLICT(workspace_id,epoch,hour) DO UPDATE SET accepted=hosted_health_hourly.accepted+excluded.accepted`, [w, Number(b)]);
      return 'ok';
    }
    case 'outcome': return autoTxn(async () => {
      // A dispatcher outcome for one admitted email: sent (SES accepted), suppressed, rejected
      // before SES, or canceled. The real refund trigger adjusts the hourly usage.
      const id = emails[a];
      if (!id) return 'e:unknown';
      const set = b === 'sent' ? "status='sent',provider_id='tear-'||id" : b === 'suppressed' ? "status='suppressed'" : b === 'rejected' ? "status='rejected'" : "status='canceled'";
      return (await auto.client.query(`UPDATE sending_emails SET ${set} WHERE id=$1 AND status='queued'`, [id])).rowCount;
    });
    case 'day': {
      // A day passes for reservations, cleanup obligations and stored objects; the hourly cleanup runs.
      await auto.client.query("UPDATE sending_upload_reservations SET expires_at=expires_at-interval '24 hours' WHERE workspace_id=$1 AND storage_key<>'tear-seed'", [ws[0]]);
      if ((await tables_()).has('sending_upload_tombstones')) await auto.client.query("UPDATE sending_upload_tombstones SET delete_after=delete_after-interval '24 hours' WHERE workspace_id=$1", [ws[0]]);
      today++;
      await cleanup({ ...runtime, storage: listing } as Json, 5_000);
      await reconcileUploads({ ...runtime, storage: listing } as Json);
      return 'ok';
    }
    case 'expire': await auto.client.query("UPDATE sending_upload_reservations SET expires_at=expires_at-interval '1 hour' WHERE workspace_id=$1 AND storage_key<>'tear-seed'", [ws[0]]); return 'ok';
    case 'sweep': await cleanup({ ...runtime, storage: listing } as Json, 5_000); await reconcileUploads({ ...runtime, storage: listing } as Json); return 'ok';
    case 'purge': {
      // Run the queued object deletions through the real job handler.
      await drainJobs({ ...runtime, storage: listing } as Json, 50, 1, 10_000);
      return 'ok';
    }
    case 'delete': {
      const r = await request(auto.db, 'DELETE', `/v1/attachments/${attachments[a] ?? 'missing'}`, '1');
      return r.status === 200 ? 'ok' : `${r.status}:${r.body?.error?.code}`;
    }
    case 'me': {
      const r = await request(auto.db, 'GET', '/v1/me', a);
      if (r.status !== 200) return `e:${r.status}:${r.body?.error?.code}`;
      const l = r.body.connection?.sendingLimit;
      return l ? { cap: l.cap, used: l.used } : null;
    }
  }
  throw new Error(`unknown action ${words.join(' ')}`);
}

// ---------- committed view ----------
const hourIndex = (offset: number | null) => offset === null ? null : hours + Math.round(offset);
async function view(safety: string[]) {
  if (profile === 'recv') {
    const out: Json = {};
    for (const [i, w] of ws.entries()) {
      const x = i ? 'B' : 'A', [limit, backlog] = cfg.limits[i];
      const { rows: [v] } = await checker.client.query(`SELECT
        (SELECT jsonb_build_array(extract(epoch FROM window_at-date_trunc('hour',now()))/3600,messages) FROM mail_receive_windows WHERE workspace_id=$1) AS window,
        (SELECT coalesce(jsonb_object_agg(ses_message_id,jsonb_build_array(status,jsonb_array_length(recipients),floor(extract(epoch FROM budget_retry_at-date_trunc('hour',now()))/3600),budget_retry_at<=now(),error)),'{}') FROM mail_receipts WHERE workspace_id=$1) AS receipts,
        (SELECT active FROM mail_ingest_turns WHERE workspace_id=$1) AS active,
        (SELECT coalesce(jsonb_object_agg(m,n),'{}') FROM (SELECT payload->>'sesMessageId' m,jsonb_build_array(count(*) FILTER (WHERE status='pending'),count(*) FILTER (WHERE status='running')) n
          FROM jobs WHERE workspace_id=$1 AND type='mailbox.ingest' AND status IN ('pending','running') GROUP BY 1) j) AS jobs`, [w]);
      const label = (id: string) => id.slice(ws[0]!.length + 1);
      const window = v.window ? [hourIndex(v.window[0]), Number(v.window[1])] : null;
      const receipts = Object.fromEntries(Object.entries(v.receipts).map(([k, [st, n, retry, due, e]]: Json) => [label(k), [st, n, hourIndex(retry), due, e]]));
      const jobs = Object.fromEntries(Object.entries(v.jobs).map(([k, n]) => [label(k), n]));
      const active = Number(v.active ?? 0), recount = Object.values(jobs).reduce((t: number, n: Json) => t + n[0] + n[1], 0);
      if (active !== recount) safety.push(`${x}: backlog counter ${active} != ${recount} active ingest jobs`);
      if (active > Math.max(backlog, 0)) safety.push(`${x}: ${active} active ingest jobs above the backlog of ${backlog}`);
      for (const [m, n] of Object.entries(jobs) as [string, number[]][]) if (n[0]! + n[1]! > 1) safety.push(`${x}: ${n[0]! + n[1]!} active ingest jobs for ${m}`);
      if (window && window[0] === hours && window[1]! > Math.max(limit, 0)) safety.push(`${x}: window ${window[1]} above the ${limit}-message limit`);
      out[x] = { window: window && window[0] === hours ? window[1] : 0, receipts, active, jobs };
    }
    out.stash = (await checker.client.query("SELECT coalesce(jsonb_agg(substr(ses_message_id,length($1)+2) ORDER BY ses_message_id),'[]') s FROM mail_receipt_holds WHERE ses_message_id LIKE $1||'\\_%' AND status='held'", [ws[0]])).rows[0].s;
    return out;
  }
  if (profile === 'upload') {
    const w = ws[0]!;
    const { rows: [v] } = await checker.client.query(`SELECT (SELECT bytes FROM sending_asset_usage WHERE workspace_id=$1) AS usage,
      (SELECT coalesce(sum(size),0) FROM sending_upload_reservations WHERE workspace_id=$1) + (SELECT coalesce(sum(size),0) FROM sending_attachments WHERE workspace_id=$1) AS recount,
      (SELECT coalesce(jsonb_agg(storage_key),'[]') FROM sending_upload_reservations WHERE workspace_id=$1 AND storage_key<>'tear-seed') AS reserved,
      (SELECT coalesce(jsonb_agg(jsonb_build_array(id,storage_key)),'[]') FROM sending_attachments WHERE workspace_id=$1) AS stored,
      (SELECT coalesce(jsonb_agg(payload->>'key'),'[]') FROM jobs WHERE workspace_id=$1 AND type='maintenance.deleteAttachment' AND status IN ('pending','running')) AS deletes,
      ${(await tables_()).has('sending_upload_tombstones') ? "(SELECT coalesce(jsonb_agg(storage_key),'[]') FROM sending_upload_tombstones WHERE workspace_id=$1 AND storage_key<>'tear-seed')" : "'[]'::jsonb"} AS tombstones`, [w]);
    const usage = Number(v.usage ?? 0), seed = LIMIT - cfg.room * SIZE;
    if (usage !== Number(v.recount)) safety.push(`asset usage ${usage} != recount ${v.recount}`);
    if (usage > LIMIT) safety.push(`asset usage ${usage} above the ${LIMIT}-byte quota`);
    // Every stored object has an owner or a durable deletion obligation (a queued job or a tombstone).
    const keysKept = new Set<string>([...v.reserved, ...v.stored.map((x: Json) => x[1]), ...v.deletes, ...v.tombstones]);
    // An object younger than a day may be unowned: reconciliation is due a day after it landed.
    for (const [k, day] of written) if (!keysKept.has(k) && today - day >= 1) safety.push(`stored object ${objectLabel.get(k)} has had no attachment, reservation, pending deletion or tombstone for a day`);
    const byId = Object.fromEntries(Object.entries(attachments).map(([l, id]) => [id, l]));
    return { used: (usage - seed) / SIZE, reservations: v.reserved.length, attachments: v.stored.map((x: Json) => byId[x[0]] ?? '?').sort(), deletes: new Set(v.deletes).size, tombstones: v.tombstones.length, objects: written.size };
  }
  const { rows: [v] } = await checker.client.query(`SELECT
    (SELECT coalesce(jsonb_object_agg(workspace_id,u),'{}') FROM (SELECT workspace_id,jsonb_object_agg(round(extract(epoch FROM hour-date_trunc('hour',now()))/3600)::int,recipients) u FROM hosted_usage_hourly WHERE workspace_id=ANY($1) AND recipients<>0 GROUP BY 1) h) AS usage,
    (SELECT coalesce(jsonb_object_agg(id,jsonb_build_array(status,jsonb_array_length(to_addresses||cc_addresses||bcc_addresses),workspace_id,snapshot->>'kind')),'{}') FROM sending_emails WHERE workspace_id=ANY($1)) AS emails,
    (SELECT coalesce(jsonb_object_agg(key_id,used),'{}') FROM api_request_budgets WHERE workspace_id=ANY($1) AND window_start=date_trunc('minute',now())) AS budgets,
    (SELECT coalesce(jsonb_object_agg(workspace_id,n),'{}') FROM (SELECT workspace_id,sum(n)::int n FROM sending_stream_depth WHERE workspace_id=ANY($1) GROUP BY 1) d) AS depth,
    (SELECT count(*)::int FROM sending_idempotency WHERE workspace_id=ANY($1)) AS idem`, [ws]);
  const x = (w: string) => String(ws.indexOf(w) + 1);
  const byLabel = Object.fromEntries(Object.entries(emails).map(([l, id]) => [id, l]));
  const mails = Object.fromEntries(Object.entries(v.emails).map(([id, [s, n, w]]: Json) => [byLabel[id] ?? '?', [s, n, x(w)]]).sort());
  const usage: Json = {}, depth: Json = {}, budgets: Json = {};
  for (const [w, u] of Object.entries(v.usage)) usage[x(w)] = Object.fromEntries(Object.entries(u as Json).map(([k, n]) => [String(hours + Number(k)), Number(n)]));
  for (const [w, n] of Object.entries(v.depth)) if (n) depth[x(w)] = n;
  for (const [id, n] of Object.entries(v.budgets)) budgets[Object.keys(keyIds).find(k => keyIds[k] === id) ?? '?'] = n;
  // Refunds are exact: the live usage equals the cost of the charged envelopes admitted in the window.
  for (const w of ws) {
    const live = Object.entries(usage[x(w)] ?? {}).filter(([h]) => Number(h) > hours - 24).reduce((s, [, n]) => s + Number(n), 0);
    const { rows: [r] } = await checker.client.query(`SELECT coalesce(sum(jsonb_array_length(to_addresses||cc_addresses||bcc_addresses)),0)::int n FROM sending_emails
      WHERE workspace_id=$1 AND hosted_charged(status,provider_id) AND created_at>=date_trunc('hour',now())-interval '23 hours'`, [w]);
    if (live !== r.n) safety.push(`${x(w)}: usage ${live} != ${r.n} charged recipients in the window`);
  }
  return { usage, mails, budgets, depth, idem: v.idem };
}

process.stdin.on('close', () => setTimeout(() => process.exit(1), 3000).unref());
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const req = JSON.parse(line);
  try {
    if (req.op === 'reset') { emails = {}; counter = 0; await reset(req.profile, req.cfg ?? {}); out({ ok: true }); }
    else if (req.op === 'act') {
      if (process.env.TEAR_TRACE) process.stderr.write(`TEAR_ACT ${req.action}\n`);
      const t0 = performance.now(), value = await act(req.action), ms = performance.now() - t0;
      if (ms > 250) process.stderr.write(`TEAR_SLOW ${ms.toFixed(0)}ms ${req.action} -> ${JSON.stringify(value.r)} ${JSON.stringify(value.woke)}\n`);
      out({ ok: true, value });
    }
    else if (req.op === 'quit') break;
  } catch (e: any) { out({ ok: false, error: String(e?.stack ?? e) }); }
}
await abortAll().catch(() => {});
await dropWorkspaces().catch(() => {});
for (const c of [...Object.values(conns), ...Object.values(slots).map(s => s.db), auto, checker]) await c.client.end();
await instance.close();
process.exit(0);
