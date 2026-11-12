// tear product host for SES event processing: drives the real SNS route, feedback-queue consumer,
// recovery job handler and dispatcher result statement over an isolated PostgreSQL, one JSON request
// per stdin line and one JSON reply per stdout line.
//   {"op":"reset"}                    fresh synthetic Hosted workspace: campaign c, emails e1 and e2
//   {"op":"act","action":"q b1"}     one model action; returns {r, woke, view, safety}
// Paths: `q`/`qq` are the feedback-queue consumer (ingestFeedbackBatch), `h` the SNS route without a
// queue (POST /v1/events/ses, recovery jobs), `J`/`K` two job workers running operation.ses, paused
// at statement gates so a step can land between the handler's statements or crash there. `Q` holds a
// consumer batch statement open until `Q commit` or `Q abort`. `old …` runs an action as a Worker
// deployed before migration 153 (its rank table); `repair` runs migration 154's repair.
//
// It runs only on a dedicated, migrated database its creator marked disposable (../disposable.ts,
// the rule every tear host shares): TEAR_DATABASE_URL must be a plain loopback URL, and the marker
// and the foreign-data check pass before the first write and before every fixture. Its workspaces are
// tear_ses_*.
import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createInterface } from 'node:readline';
import { generateKeyPairSync, randomUUID, sign, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const hex = (n: number) => Array.from({ length: Math.ceil(n / 32) }, () => randomUUID().replaceAll('-', '')).join('').slice(0, n);

// The app logs JSON to the console; keep stdout for the protocol.
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) console[level] = (...a: unknown[]) => { if (process.env.TEAR_HOST_LOG) process.stderr.write(a.map(String).join(' ') + '\n'); };
const out = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
const trace = (line: string) => { if (process.env.TEAR_TRACE) process.stderr.write(line + '\n'); };

// Before any module that connects: a loopback URL nothing can redirect, then the marker and the data check.
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

// No network: SNS certificates come from the pinned fixture, webhooks are never delivered here.
globalThis.fetch = (async () => { throw new Error('tear host: network is forbidden'); }) as typeof fetch;

const [{ createApp }, { nodeRuntime }, ops, sending, { dispatchAsActor }] = await Promise.all([
  import('../../src/app.js'), import('../../src/adapters/node.js'), import('../../src/operations.js'), import('../../src/sending.js'), import('../../src/auth.js'),
]);
const REGION = 'us-east-1', ACCOUNT = '111122223333', TOPIC = `arn:aws:sns:${REGION}:${ACCOUNT}:tear-ses-feedback`;
const STRAY = `arn:aws:sns:${REGION}:${ACCOUNT}:tear-ses-unregistered`, PUBLIC = 'http://127.0.0.1:9';
// Another account's (retired) shared feedback topic: verified, but not the topic this workspace's mail is bound to.
const OTHER_ACCOUNT = '222233334444', OTHER = `arn:aws:sns:${REGION}:${OTHER_ACCOUNT}:tear-ses-feedback`;
const instance = nodeRuntime({ DATABASE_URL, BANE_ROOT_SECRET: hex(64), ACCOUNT_CLIENT_ID: 'tear-fixture', ACCOUNT_CLIENT_PRIVATE_KEY: 'tear-fixture',
  AUTH_ALLOWED_EMAILS: 'operator@example.com', PUBLIC_URL: PUBLIC, DEFAULT_SES_REGION: REGION, ENABLE_LIVE_SES: 'false', S3_BUCKET: 'tear-fixture', S3_ACCESS_KEY_ID: 'tear', S3_SECRET_ACCESS_KEY: 'tear' });
const runtime = instance.runtime;
// Hosted (multi-tenant) feedback on a shared pool topic, as production runs it. No feedback queue sink:
// `h` exercises the HTTP path that defers non-routine feedback to its recovery job.
runtime.config.multiTenant = true;
runtime.feedback = undefined;
runtime.wake = async () => {};
const app = createApp();
type Json = any;
type Db = NodePgDatabase<Record<string, unknown>>;

// A self-signed SNS signing certificate, pinned in the route's certificate cache (never fetched).
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'tear-ses-cert-'));
  try {
    const file = join(dir, 'key.pem'); writeFileSync(file, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    return execFileSync('openssl', ['req', '-new', '-x509', '-key', file, '-days', '2', '-subj', '/CN=tear-ses'], { encoding: 'utf8' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
})();
const CERT_URL = `https://sns.${REGION}.amazonaws.com/SimpleNotificationService-${hex(32)}.pem`;
const certs = new ops.SnsCertificateState();
certs.candidates.set(CERT_URL, { cert: new X509Certificate(pem), expiresAt: Date.now() + 86_400_000 });
runtime.snsCertificateState = certs;

// ---- connections --------------------------------------------------------------------------------
type Paused = { gate: string; release: () => void };
type Raw = (text: string, values?: unknown[]) => Promise<pg.QueryResult>;
type Conn = { name: string; client: pg.Client; db: Db; pid: number; raw: Raw;
  open: boolean; pending?: Promise<void>; settled?: { ok: boolean; value: unknown };
  // Job workers only: the gate the handler waits at and the claimed job.
  paused?: Paused; notify?: (v: string) => void; gating?: boolean; job?: Json; crashed?: boolean; label?: string; blocked?: boolean; old?: boolean };
// Handler statements a worker pauses before: the dispatcher-style event write, the suppression
// transaction and the receipt's processed mark. Claim and settlement are the host's own.
const GATES: [string, RegExp][] = [['record', /WITH mail AS MATERIALIZED/], ['suppress', /^\s*begin\b/i], ['mark', /update "operation_sns_receipts"/i]];
async function connect(name: string): Promise<Conn> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  const pid = (await client.query('SELECT pg_backend_pid() pid')).rows[0].pid as number;
  const query = client.query.bind(client) as (...args: unknown[]) => Promise<pg.QueryResult>;
  const raw: Raw = (text, values) => query(text, values);
  const c: Conn = { name, client, db: drizzle(client) as unknown as Db, pid, raw, open: false };
  (client as Json).query = (...args: Json[]) => {
    const text = typeof args[0] === 'string' ? args[0] : args[0]?.text;
    const gate = c.gating && typeof text === 'string' ? GATES.find(([, re]) => re.test(text))?.[0] : undefined;
    if (!gate) return query(...args);
    return new Promise<void>(release => { c.paused = { gate, release }; trace(`TEAR_GATE ${name} ${gate}`); signal(c, `at:${gate}`); }).then(() => query(...args));
  };
  return c;
}
const conns: Record<string, Conn> = {};
for (const name of ['Q', 'P', 'J', 'K']) conns[name] = await connect(name);
const auto = await connect('auto'), checker = await connect('checker');

let ws = '', hexId = '', T0 = 0;
const ids: Record<string, string> = {};
const mid = (label: string) => `${ws}-${label}`;
const errOf = (e: any) => `e:${e?.cause?.code ?? e?.code ?? e?.message ?? 'ERROR'}`;

// ---- the synthetic SNS notifications ------------------------------------------------------------
// Labels name one notification each (its SNS MessageId is fixed per trace). e1 is sent to r1 alone;
// e2 to r1 with r2 on Cc. x9 names a provider message no local email has.
type Spec = { email: 'e1' | 'e2' | 'x9'; kind: string; at: number; detail?: Json };
export const SPECS: Record<string, Spec> = {
  s1: { email: 'e1', kind: 'Send', at: 1 },
  y1: { email: 'e1', kind: 'DeliveryDelay', at: 2, detail: { delayType: 'TransientCommunicationFailure', delayedRecipients: [{ emailAddress: 'r1' }] } },
  t1: { email: 'e1', kind: 'Bounce', at: 2, detail: { bounceType: 'Transient', bounceSubType: 'MailboxFull', bouncedRecipients: [{ emailAddress: 'r1' }] } },
  d1: { email: 'e1', kind: 'Delivery', at: 3, detail: { recipients: ['r1'] } },
  b1: { email: 'e1', kind: 'Bounce', at: 4, detail: { bounceType: 'Permanent', bounceSubType: 'General', bouncedRecipients: [{ emailAddress: 'r1' }] } },
  v1: { email: 'e1', kind: 'Bounce', at: 4, detail: { bounceType: 'Permanent', bounceSubType: 'EmailValidationSuppressed', bouncedRecipients: [{ emailAddress: 'r1' }] } },
  c1: { email: 'e1', kind: 'Complaint', at: 5, detail: { complainedRecipients: [{ emailAddress: 'r1' }] } },
  n1: { email: 'e1', kind: 'Complaint', at: 5, detail: { complaintFeedbackType: 'not-spam', complainedRecipients: [{ emailAddress: 'r1' }] } },
  j1: { email: 'e1', kind: 'Reject', at: 1, detail: { reason: 'Bad content' } },
  f1: { email: 'e1', kind: 'Rendering Failure', at: 1, detail: { errorMessage: 'Attribute missing', templateName: 'tear' } },
  o1: { email: 'e1', kind: 'Open', at: 6, detail: { ipAddress: '192.0.2.1', userAgent: 'tear' } },
  d2: { email: 'e2', kind: 'Delivery', at: 3, detail: { recipients: ['r1', 'r2'] } },
  b2: { email: 'e2', kind: 'Bounce', at: 4, detail: { bounceType: 'Permanent', bounceSubType: 'General', bouncedRecipients: [{ emailAddress: 'r2' }] } },
  v2: { email: 'e2', kind: 'Bounce', at: 4, detail: { bounceType: 'Permanent', bounceSubType: 'EmailValidationSuppressed', bouncedRecipients: [{ emailAddress: 'r1' }] } },
  c2: { email: 'e2', kind: 'Complaint', at: 5, detail: { complaintFeedbackType: 'abuse', complainedRecipients: [{ emailAddress: 'R2' }] } },
  x9: { email: 'x9', kind: 'Bounce', at: 4, detail: { bounceType: 'Permanent', bounceSubType: 'General', bouncedRecipients: [{ emailAddress: 'r1' }] } },
};
const host = () => `${ws.replaceAll('_', '-')}.invalid`;
const address = (r: string) => `${r}@${host()}`;
const detailKey = (kind: string) => kind === 'Rendering Failure' ? 'failure' : kind === 'DeliveryDelay' ? 'deliveryDelay' : kind.toLowerCase();
function message(label: string, account = ACCOUNT) {
  const s = SPECS[label];
  if (!s) throw new Error(`unknown notification ${label}`);
  const at = new Date(T0 + s.at * 1000).toISOString();
  const recips = (v: Json): Json => Array.isArray(v) ? v.map(recips) : typeof v === 'string' && /^[rR]\d$/.test(v) ? address(v) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, recips(x)])) : v;
  const provider = mid(s.email === 'x9' ? 'p9' : s.email === 'e1' ? 'p1' : 'p2');
  const mail = { timestamp: new Date(T0).toISOString(), messageId: provider, sendingAccountId: account, source: `sender@${host()}`,
    destination: s.email === 'e2' ? [address('r1'), address('r2')] : [address('r1')], ...(s.email === 'x9' ? {} : { tags: { bane_email_id: [ids[s.email]] } }) };
  return { eventType: s.kind, mail, [detailKey(s.kind)]: { ...recips(s.detail ?? {}), timestamp: at } };
}
const item = (label: string) => ({ region: REGION, topicArn: TOPIC, messageId: mid(label), message: message(label) as Record<string, unknown>, topicKind: 'shared' as const });
function envelope(label: string, topic = TOPIC, account = ACCOUNT) {
  const values: Json = { Message: JSON.stringify(message(label, account)), MessageId: mid(label), Timestamp: new Date(T0).toISOString(), TopicArn: topic, Type: 'Notification' };
  const canonical = Object.entries(values).map(([k, v]) => `${k}\n${v}\n`).join('');
  return { ...values, SigningCertURL: CERT_URL, SignatureVersion: '2', Signature: Buffer.from(sign('RSA-SHA256', Buffer.from(canonical), privateKey)).toString('base64') };
}

// ---- fixture ------------------------------------------------------------------------------------
const TABLES = ['sending_email_events', 'operation_events', 'operation_deliveries', 'operation_delivery_attempts', 'jobs', 'operation_sns_receipts', 'operation_feedback_failures',
  'audience_contacts', 'audience_consent_audit', 'sending_emails', 'sending_campaigns', 'operation_webhooks', 'hosted_health_credits', 'hosted_health_hourly', 'hosted_usage_hourly',
  'provider_connections', 'workspaces'];
// Cancel waiting statements first: a ROLLBACK queued behind a blocked statement would wait for a
// transaction that is itself only rolled back later. Paused or crashed workers get a new connection.
async function abortAll() {
  for (const c of Object.values(conns)) if (c.pending && !c.settled && !c.paused) await checker.raw('SELECT pg_cancel_backend($1)', [c.pid]);
  for (const [name, c] of Object.entries(conns)) {
    if (c.paused || c.crashed || c.blocked || ((c.name === 'J' || c.name === 'K') && c.pending && !c.settled)) {
      c.notify = undefined; c.gating = false;
      await c.client.end().catch(() => {});
      conns[name] = await connect(name);
      continue;
    }
    if (c.pending) await c.pending;
    if (c.open) await c.raw('ROLLBACK');
    Object.assign(c, { open: false, pending: undefined, settled: undefined, job: undefined, label: undefined, blocked: false, old: false });
  }
}
async function reset() {
  await abortAll();
  await assertDisposable(text => checker.raw(text));
  const q = (text: string, values?: unknown[]) => auto.raw(text, values);
  if (ws) for (const t of TABLES) await q(`DELETE FROM ${t} WHERE ${t === 'workspaces' ? 'id' : 'workspace_id'}=$1`, [ws]);
  hexId = hex(12); ws = `tear_ses_${hexId}`; T0 = Date.now() - 60_000;
  runtime.config.workspaceId = ws;
  Object.assign(ids, { e1: `email_${hexId}e1`, e2: `email_${hexId}e2`, c: `cmp_${hexId}`, w1: `wh_${hexId}w1`, w2: `wh_${hexId}w2` });
  await q('BEGIN');
  try {
  await q(`INSERT INTO provider_pool_regions(region,aws_account_id,feedback_topic_arn,sending_state) VALUES($1,$2,$3,'ready')
    ON CONFLICT DO NOTHING`, [REGION, ACCOUNT, TOPIC]);
  // A retired shared topic of another account in the same region: still trusted for late feedback.
  await q(`INSERT INTO provider_feedback_history(topic_arn,region,aws_account_id,kind) VALUES($1,$2,$3,'shared') ON CONFLICT DO NOTHING`, [OTHER, REGION, OTHER_ACCOUNT]);
  await q('INSERT INTO workspaces(id,name,slug) VALUES($1,$1,$1)', [ws]);
  await q(`INSERT INTO provider_connections(id,workspace_id,region,state,kind,aws_account_id,tenant_state) VALUES($1,$1,$2,'ready','shared',$3,'ready')`, [ws, REGION, ACCOUNT]);
  await q(`INSERT INTO sending_campaigns(id,workspace_id,draft,state) VALUES($1,$2,$3,'done')`, [ids.c, ws, JSON.stringify({ name: 'tear', from: `sender@${host()}`, subject: 'tear', tracking: true, audience: {}, defaults: {}, replyTo: [], attachments: [], region: REGION })]);
  for (const [e, to, cc] of [['e1', [address('r1')], []], ['e2', [address('r1')], [address('r2')]]] as const)
    await q(`INSERT INTO sending_emails(id,workspace_id,campaign_id,region,actor_key_id,from_address,to_addresses,cc_addresses,bcc_addresses,subject,snapshot,simulated,status,feedback_topic_arn,created_at)
      VALUES($1,$2,$3,$4,'tear',$5,$6,$7,'[]','tear','{"kind":"marketing"}',false,'attempting',$8,now())`, [ids[e], ws, ids.c, REGION, `sender@${host()}`, JSON.stringify(to), JSON.stringify(cc), TOPIC]);
  // r2 is an existing contact; r1 (e1's only recipient, so the one engagement applies to) exists only
  // once feedback suppresses it: an open before that must not create it.
  await q(`INSERT INTO audience_contacts(id,workspace_id,email) VALUES($1,$2,$3)`, [`con_${hexId}r2`, ws, address('r2')]);
  const types = ['email.sent', 'email.delivered', 'email.bounced', 'email.complained', 'email.rejected', 'email.rendering_failed', 'email.delivery_delayed', 'email.opened', 'email.clicked'];
  await q(`INSERT INTO operation_webhooks(id,workspace_id,url,event_types,encrypted_secret) VALUES($1,$2,'https://example.com/w1',$3,'tear'),($4,$2,'https://example.com/w2','["email.bounced","email.complained"]','tear')`,
    [ids.w1, ws, JSON.stringify(types), ids.w2]);
  await q('COMMIT');
  } catch (error) { await q('ROLLBACK'); throw error; }
  track = { removed: new Set() };
}
let track: { removed: Set<string> } = { removed: new Set() };

// ---- actions ------------------------------------------------------------------------------------
const runtimeOn = (db: Db) => ({ ...runtime, db, config: { ...runtime.config, workspaceId: ws } }) as Json;
const outcome = (o: { ok: boolean; error?: string }) => o.ok ? 'ok' : `e:${o.error}`;
async function http(db: Db, body: unknown) {
  const res = await app.fetch(new Request(`${PUBLIC}/v1/events/ses`, { method: 'POST', headers: { 'content-type': 'text/plain; charset=UTF-8', 'x-bane-client-ip': '2001:db8::1' }, body: JSON.stringify(body) }), runtimeOn(db));
  const json = await res.json() as Json;
  return res.status === 202 ? 'ok' : `e:${json?.error?.code ?? res.status}`;
}
// The dispatcher's provider outcome: SendEmail answered (accept) or the answer was lost (lost).
async function dispatched(db: Db, e: string, lost: boolean) {
  await sending.recordEmailEvent(runtimeOn(db), { workspaceId: ws, emailId: ids[e]!, type: lost ? 'acceptance_unknown' : 'accepted', providerId: lost ? undefined : mid(e === 'e1' ? 'p1' : 'p2'),
    errorCode: lost ? 'SES_ACCEPTANCE_UNKNOWN' : undefined, externalId: `attempt-result:${ids[e]}:0`, data: lost ? { code: 'SES_ACCEPTANCE_UNKNOWN', status: 'acceptance_unknown' } : {} });
  return 'ok';
}

// Settle a pending statement: done, at a gate, or waiting on another backend's row lock.
async function settle(c: Conn): Promise<unknown> {
  const start = Date.now();
  for (;;) {
    if (c.settled) { const s = c.settled; c.pending = c.settled = undefined; return s.ok ? s.value : errOf(s.value); }
    const own = [...Object.values(conns).map(x => x.pid), auto.pid];
    const w = (await checker.raw("SELECT wait_event_type='Lock' AND pg_blocking_pids($1) && $2::int[] AS blocked,pg_blocking_pids($1) AS by FROM pg_stat_activity WHERE pid=$1", [c.pid, own]) ).rows[0];
    if (w?.blocked && !c.settled) { trace(`TEAR_BLOCKED ${c.name} by ${w.by.map((p: number) => Object.values(conns).find(x => x.pid === p)?.name ?? p).join(',')}`); return 'blocked'; }
    if (Date.now() - start > 10_000) return 'stuck';
    await new Promise(r => setImmediate(r));
  }
}

// Job workers. A step runs the handler to its next gate, to completion (then settles the job like the
// runner: completed, or pending/failed by the error's retryability), or to a lock wait.
const MAX_ATTEMPTS = 6;
async function claim(c: Conn, label: string) {
  const r = await c.raw(`UPDATE jobs SET status='running',attempts=attempts+1,lease_until=clock_timestamp()+interval '3 minutes'
    WHERE id=(SELECT id FROM jobs WHERE workspace_id=$1 AND type='operation.ses' AND payload->>'messageId'=$2
      AND (status='pending' OR (status='running' AND lease_until<now() AND attempts<$3)) ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING id,payload,attempts,lease_until::text AS fence`, [ws, mid(label), MAX_ATTEMPTS]) as pg.QueryResult;
  return r.rows[0];
}
// Resolves at the worker's next gate, at completion, or when its statement waits on a lock.
function waitWorker(c: Conn): Promise<string> {
  if (c.paused) return Promise.resolve(`at:${c.paused.gate}`);
  if (c.settled) return Promise.resolve(`done:${c.settled.value}`);
  return new Promise<string>(resolve => {
    c.notify = resolve;
    (async () => {
      while (c.notify === resolve) {
        await new Promise(r => setTimeout(r, 3));
        if (c.notify === resolve && await lockWait(c) && c.notify === resolve) { c.notify = undefined; resolve('blocked'); }
      }
    })();
  });
}
function signal(c: Conn, v: string) { const n = c.notify; c.notify = undefined; n?.(v); }
async function stepWorker(c: Conn): Promise<string> {
  const p = c.paused!; c.paused = undefined;
  const wait = waitWorker(c);
  p.release();
  return wait;
}
async function lockWait(c: Conn) {
  const own = [...Object.values(conns).map(x => x.pid), auto.pid];
  const w = (await checker.raw("SELECT wait_event_type='Lock' AND pg_blocking_pids($1) && $2::int[] AS blocked FROM pg_stat_activity WHERE pid=$1", [c.pid, own]) ).rows[0];
  return !!w?.blocked && !c.paused;
}
async function runJob(c: Conn, label: string): Promise<string> {
  const job = await claim(c, label);
  if (!job) return 'none';
  c.job = job; c.label = label; c.gating = true; c.settled = undefined;
  const wait = waitWorker(c);
  const handler = ops.operationJobs['operation.ses']!;
  c.pending = (async () => {
    let state: string;
    try {
      await handler(runtimeOn(c.db), job.payload, { id: job.id, attempts: job.attempts, workspaceId: ws });
      c.gating = false;
      await c.raw(`UPDATE jobs SET status='completed',lease_until=NULL,last_error=NULL WHERE id=$1 AND attempts=$2 AND status='running' AND lease_until=$3::timestamptz`, [job.id, job.attempts, job.fence]);
      state = 'done';
    } catch (error: any) {
      c.gating = false;
      // retryDatabaseFailures turns anything else into a retryable 503 ApiError, as the runner sees it.
      const retryable = (error as Json)?.retryable === true, code = String((error as Json)?.code ?? 'JOB_INTERNAL_ERROR');
      const retry = retryable && job.attempts < MAX_ATTEMPTS;
      await c.raw(`UPDATE jobs SET status=$4,lease_until=NULL,last_error=$5 WHERE id=$1 AND attempts=$2 AND status='running' AND lease_until=$3::timestamptz`, [job.id, job.attempts, job.fence, retry ? 'pending' : 'failed', code]);
      state = `${retry ? 'retry' : 'failed'}:${code}`;
    }
    c.settled = { ok: true, value: state };
    c.job = undefined; c.label = undefined;
    signal(c, `done:${state}`);
  })();
  return wait;
}
function finishWorker(c: Conn, v: string) {
  if (v.startsWith('done:')) { c.pending = c.settled = undefined; return v.slice(5); }
  return v;
}

async function finish(c: Conn, commit: boolean) {
  let r: unknown = 'ok';
  try { await c.raw(commit ? 'COMMIT' : 'ROLLBACK'); } catch (e) { r = errOf(e); }
  c.open = false;
  return { r, woke: await wake() };
}
// After a commit, report every statement it unblocked.
async function wake() {
  const woke: Record<string, unknown> = {};
  for (const other of Object.values(conns)) {
    if (other.name === 'Q' || other.name === 'P') { if (other.pending) { const v = await settle(other); if (v !== 'blocked') woke[other.name] = v; } continue; }
    if (other.blocked) {
      const v = await waitWorker(other);
      if (v !== 'blocked') { other.blocked = false; woke[other.name] = finishWorker(other, v); }
    }
  }
  return woke;
}

// The rank table a Worker deployed before migration 153 embeds (974e0c9). Old and new statements
// differ only in this table; the database enforces the rest. Statements read it when they are built.
const OLD_RANK = { queued: 0, attempting: 1, acceptance_unknown: 2, accepted: 3, sent: 4, delayed: 4, delivered: 5, bounced: 6, complained: 7, rejected: 6, rendering_failed: 6, suppressed: 6, canceled: 6, simulated: 6 };
const NEW_RANK = { ...sending.rank };
async function ranked<T>(old: boolean, fn: () => Promise<T>): Promise<T> {
  if (!old) return fn();
  Object.assign(sending.rank, OLD_RANK);
  try { return await fn(); } finally { Object.assign(sending.rank, NEW_RANK); }
}

async function act(action: string) {
  const old = action.startsWith('old ');
  const result = await ranked(old, () => step(old ? action.slice(4) : action, old));
  const safety: string[] = [];
  return { ...result, view: await view(safety), safety };
}
async function step(action: string, old: boolean) {
  const words = action.split(' ');
  const c = conns[words[0]!];
  let r: unknown, woke: Record<string, unknown> = {};
  if (c && (c.name === 'Q' || c.name === 'P')) {
    const verb = words[1]!;
    if (verb === 'commit' || verb === 'abort') ({ r, woke } = await finish(c, verb === 'commit'));
    else {
      await c.raw('BEGIN'); c.open = true; c.settled = undefined;
      c.pending = ops.ingestFeedbackBatch(runtimeOn(c.db), [item(verb)]).then(v => { c.settled = { ok: true, value: v.map(outcome) }; }, e => { c.settled = { ok: false, value: e }; });
      r = await settle(c);
    }
  } else if (c) {
    const verb = words[1]!;
    if (verb === 'crash') {
      // The worker process dies at its gate: its connection closes and the job keeps its lease.
      c.crashed = true; c.notify = undefined; c.gating = false; c.paused = undefined;
      await c.client.end().catch(() => {});
      conns[c.name] = await connect(c.name);
      r = 'ok';
    } else {
      // A worker keeps the version it claimed the job with.
      if (verb !== 'go') c.old = old;
      const v = verb === 'go' ? await ranked(!!c.old, () => stepWorker(c)) : await runJob(c, verb);
      if (v === 'blocked') c.blocked = true;
      r = finishWorker(c, v);
    }
  } else r = await autoAct(words);
  return { r, woke };
}

async function autoAct(words: string[]): Promise<unknown> {
  const [verb, a, b] = words as [string, string, string];
  const db = auto.db;
  switch (verb) {
    case 'q': return (await ops.ingestFeedbackBatch(runtimeOn(db), [item(a)])).map(outcome);
    case 'qq': return (await ops.ingestFeedbackBatch(runtimeOn(db), [item(a), item(b)])).map(outcome);
    case 'h': return http(db, envelope(a));
    case 'forge': return http(db, { ...envelope(a), Message: JSON.stringify({ ...message(a), mail: { ...message(a).mail, messageId: mid('p2') } }) });
    case 'stray': return http(db, envelope(a, STRAY));
    case 'alien': return http(db, envelope(a, TOPIC, '444455556666'));
    case 'qx': return (await ops.ingestFeedbackBatch(runtimeOn(db), [{ ...item(a), topicArn: OTHER, message: message(a, OTHER_ACCOUNT) as Record<string, unknown> }])).map(outcome);
    case 'hx': return http(db, envelope(a, OTHER, OTHER_ACCOUNT));
    case 'accept': return dispatched(db, a, false);
    case 'lost': return dispatched(db, a, true);
    case 'expire': await auto.raw("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE workspace_id=$1 AND status='running'", [ws]); return 'ok';
    case 'repair': { let cursor: string | null = ''; while (cursor !== null) cursor = (await auto.raw('SELECT repair_feedback_status($1,$2) AS c', [cursor, ws])).rows[0].c; return 'ok'; }
    case 'pause': case 'resume': await auto.raw('UPDATE operation_webhooks SET paused=$2 WHERE id=$1', [ids.w2, verb === 'pause']); return 'ok';
  }
  throw new Error(`unknown action ${words.join(' ')}`);
}

// ---- observation ---------------------------------------------------------------------------------
const actor = () => ({ workspaceId: ws, permissions: ['read'], domains: [], keyId: 'mcp_tear', credential: 'mcp' }) as Json;
async function route(path: string) {
  const res = await dispatchAsActor(app, new Request(`${PUBLIC}${path}`, { headers: { accept: 'application/json' } }), runtimeOn(checker.db), actor());
  return res.status === 200 ? await res.json() as Json : { error: res.status };
}
// Label of a sending_email_events external id: SNS notification label, or A:<email> for the dispatcher.
const labelOf = (external: string | null) => {
  if (!external) return '?';
  if (external.startsWith(`${TOPIC}:${ws}-`)) return external.slice(`${TOPIC}:${ws}-`.length);
  const m = /^attempt-result:email_[0-9a-f]+(e\d):0$/.exec(external);
  return m ? `A:${m[1]}` : external;
};
const BITS: Record<string, number> = { 'email.sent': 1, 'email.delivered': 3, 'email.complained': 9, 'email.delivery_delayed': 129, 'email.opened': 16, 'email.clicked': 32, 'email.rendering_failed': 64 };
const bitsOf = (type: string, data: Json) => type === 'email.bounced' ? (data.bounceSubType === 'EmailValidationSuppressed' ? 0 : data.bounceType === 'Permanent' ? 5 : 129)
  : type === 'email.rejected' ? (['suppressed', 'canceled', 'acceptance_unknown'].includes(data.status) ? 0 : 64) : BITS[type] ?? 0;
async function view(safety: string[]) {
  const q = (text: string, values: unknown[]) => checker.raw(text, values);
  const { rows: [v] } = await q(`SELECT jsonb_build_object(
    'emails',(SELECT jsonb_object_agg(id,jsonb_build_array(status,provider_id IS NOT NULL,event_outcomes,error_code,suppression_reason)) FROM sending_emails WHERE workspace_id=$1),
    'contacts',(SELECT coalesce(jsonb_object_agg(email,jsonb_build_array(suppressed,suppression_reason,last_open_at IS NOT NULL)),'{}') FROM audience_contacts WHERE workspace_id=$1),
    'events',(SELECT coalesce(jsonb_agg(jsonb_build_array(external_id,type,email_id,id,data,recipient_hashes IS NOT NULL,coalesce(cardinality(recipient_hashes),0)) ORDER BY external_id),'[]') FROM sending_email_events WHERE workspace_id=$1),
    'published',(SELECT coalesce(jsonb_agg(jsonb_build_array(id,type,data) ORDER BY id),'[]') FROM operation_events WHERE workspace_id=$1),
    'deliveries',(SELECT coalesce(jsonb_agg(jsonb_build_array(webhook_id,event_id,payload)),'[]') FROM operation_deliveries WHERE workspace_id=$1),
    'receipts',(SELECT coalesce(jsonb_object_agg(message_id,processed_at IS NOT NULL),'{}') FROM operation_sns_receipts WHERE workspace_id=$1),
    'jobs',(SELECT coalesce(jsonb_agg(jsonb_build_array(type,payload->>'messageId',status,attempts) ORDER BY created_at,id),'[]') FROM jobs WHERE workspace_id=$1),
    'quarantined',(SELECT count(*) FROM operation_feedback_failures WHERE workspace_id=$1 OR topic_arn=$2),
    'hosted',(SELECT jsonb_build_array(coalesce(sum(accepted),0),coalesce(sum(bounces),0),coalesce(sum(complaints),0)) FROM hosted_health_hourly WHERE workspace_id=$1),
    'credits',(SELECT coalesce(jsonb_agg(jsonb_build_array(email_id,epoch,hour,accepted,bounces,complaints) ORDER BY email_id,epoch,hour),'[]') FROM hosted_health_credits WHERE workspace_id=$1),
    'projection',(SELECT coalesce(jsonb_agg(jsonb_build_array(email_id,epoch,hour,accepted,bounces,complaints) ORDER BY email_id,epoch,hour),'[]') FROM hosted_health_projection WHERE workspace_id=$1),
    'hourly',(SELECT coalesce(jsonb_agg(jsonb_build_array(epoch,hour,accepted,bounces,complaints) ORDER BY epoch,hour),'[]') FROM hosted_health_hourly WHERE workspace_id=$1)) v`, [ws, TOPIC]);
  const d = v.v;
  const emailLabel = (id: string) => Object.entries(ids).find(([, x]) => x === id)?.[0] ?? id;
  const addrLabel = (a: string) => a.split('@')[0]!;
  const eventById = new Map<string, Json>(d.events.map((e: Json) => [e[3], e]));
  const result: Json = {
    emails: Object.fromEntries(Object.entries(d.emails ?? {}).map(([id, e]: Json) => [emailLabel(id), e])),
    contacts: Object.fromEntries(Object.entries(d.contacts).map(([a, c]: Json) => [addrLabel(a), c])),
    events: d.events.map((e: Json) => [labelOf(e[0]), e[1], emailLabel(e[2]), e[6]]).sort((a: Json, b: Json) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    published: d.published.map((p: Json) => [labelOf(eventById.get(p[0])?.[0] ?? null), p[1]]).sort((a: Json, b: Json) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    deliveries: (['w1', 'w2'] as const).map(w => d.deliveries.filter((x: Json) => x[0] === ids[w]).map((x: Json) => labelOf(eventById.get(x[1])?.[0] ?? null)).sort()),
    receipts: Object.fromEntries(Object.entries(d.receipts).map(([k, p]) => [k.slice(ws.length + 1), p])),
    jobs: d.jobs.map((j: Json) => [j[0] === 'operation.ses' ? 'ses' : j[0], j[1]?.slice(ws.length + 1) ?? null, j[2], j[3]]).filter((j: Json) => j[0] === 'ses').sort((a: Json, b: Json) => a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0),
    hosted: d.hosted.map(Number),
  };
  const stats = await route(`/v1/campaigns/${ids.c}/stats`);
  result.stats = stats.error ? stats : [stats.totals.accepted, stats.totals.delivered, stats.totals.bounced, stats.totals.complained, stats.totals.failed, stats.totals.deliveryDelayed];
  const score = await route('/v1/sender-score');
  result.score = score.error ? score : ['bounces', 'complaints', 'hygiene'].map(k => score.factors.find((f: Json) => f.key === k)?.value ?? null);
  // Invariants on the committed state, independent of the model.
  for (const [label, e] of Object.entries(result.emails) as [string, Json][]) {
    const want = d.published.filter((p: Json) => p[2]?.emailId === ids[label]).reduce((s: number, p: Json) => s | bitsOf(p[1], p[2]), 0);
    if (e[2] !== want) safety.push(`${label}: event_outcomes ${e[2]} != recount ${want}`);
  }
  const seen = new Map<string, number>();
  for (const e of d.events) seen.set(e[0], (seen.get(e[0]) ?? 0) + 1);
  for (const [k, n] of seen) if (n > 1) safety.push(`${labelOf(k)}: ${n} email events`);
  for (const p of d.published) {
    const ev = eventById.get(p[0]);
    if (!ev) safety.push(`${p[0]}: published without an email event`);
    else if (p[2]?.emailId !== ev[2]) safety.push(`${labelOf(ev[0])}: published for another email`);
  }
  const byEndpoint = new Map<string, number>();
  for (const x of d.deliveries) {
    const key = `${x[0]}:${x[1]}`; byEndpoint.set(key, (byEndpoint.get(key) ?? 0) + 1);
    const p = d.published.find((p: Json) => p[0] === x[1]);
    if (!p) safety.push(`delivery for unpublished event ${x[1]}`);
    else if (x[2]?.type !== p[1] || JSON.stringify(x[2]?.data) !== JSON.stringify(p[2])) safety.push(`${labelOf(eventById.get(p[0])?.[0] ?? null)}: delivery payload differs from its event`);
  }
  for (const [k, n] of byEndpoint) if (n > 1) safety.push(`${k}: ${n} deliveries`);
  if (JSON.stringify(d.credits) !== JSON.stringify(d.projection)) safety.push(`hosted credits ${JSON.stringify(d.credits)} != projection ${JSON.stringify(d.projection)}`);
  const sums = new Map<string, number[]>();
  for (const c of d.credits) { const k = `${c[1]}|${c[2]}`; const s = sums.get(k) ?? [0, 0, 0]; sums.set(k, [s[0]! + c[3], s[1]! + c[4], s[2]! + c[5]]); }
  const hourly = d.hourly.filter((h: Json) => h[2] || h[3] || h[4]).map((h: Json) => `${h[0]}|${h[1]}:${[h[2], h[3], h[4]].map(Number).join(',')}`).sort();
  const recount = [...sums].filter(([, s]) => s.some(Boolean)).map(([k, s]) => `${k}:${s.join(',')}`).sort();
  if (JSON.stringify(hourly) !== JSON.stringify(recount)) safety.push(`hosted hourly ${JSON.stringify(hourly)} != credits ${JSON.stringify(recount)}`);
  if (Number(d.quarantined)) safety.push(`${d.quarantined} quarantined feedback items`);
  // A suppression, once committed, is never lifted by feedback.
  for (const [r, c] of Object.entries(result.contacts) as [string, Json][]) {
    if (c[0]) track.removed.add(r);
    else if (track.removed.has(r)) safety.push(`${r}: suppression lifted`);
  }
  return result;
}

// If the driver goes away while a statement is stuck, exit so PostgreSQL releases its locks.
process.stdin.on('close', () => setTimeout(() => process.exit(1), 3000).unref());
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const req = JSON.parse(line);
  try {
    if (req.op === 'reset') { await reset(); out({ ok: true }); }
    else if (req.op === 'act') {
      trace(`TEAR_ACT ${req.action}`);
      const t0 = performance.now(), value = await act(req.action), ms = performance.now() - t0;
      if (ms > 250) process.stderr.write(`TEAR_SLOW ${ms.toFixed(0)}ms ${req.action} -> ${JSON.stringify(value.r)}\n`);
      out({ ok: true, value });
    }
    else if (req.op === 'quit') break;
  } catch (e: any) { out({ ok: false, error: String(e?.stack ?? e) }); }
}
await abortAll().catch(() => {});
if (ws) for (const t of TABLES) await auto.raw(`DELETE FROM ${t} WHERE ${t === 'workspaces' ? 'id' : 'workspace_id'}=$1`, [ws]).catch(() => {});
for (const c of [...Object.values(conns), auto, checker]) await c.client.end().catch(() => {});
await instance.close();
process.exit(0);
