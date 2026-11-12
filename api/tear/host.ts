// tear host for Bane's dispatcher: tear's JSON Lines v1 driver protocol on stdin/stdout.
//
// One long-lived process serves every trace: the Rust runner maps tear's per-trace
// open/close to the `reset` and `end` actions, so the API modules load once. It drives
// the real code (admission, campaign controls and run job, runDispatcher, the
// interrupted-attempt sweep) against a dedicated, migrated PostgreSQL database that its creator
// marked disposable (tear/disposable.ts: the rule every tear host shares).
//
// Determinism:
// - Time is virtual. PostgreSQL's now(), clock_timestamp() and statement_timestamp() are
//   shadowed by tear_clock.* through the connections' search_path, and JS Date uses the
//   same offset. The clock is frozen between actions at <model second>.5 and runs at real
//   speed inside an action, so pacing timers still fire.
// - SES is a fake behind SESv2Client.prototype.send: each recipient's local part names
//   its behaviour (ok, thr = throttled once, rej = permanent refusal, unk = 5xx, so
//   acceptance unknown), and a daily quota can be set per trace.
// - Stepped dispatcher instances (D1, D2) run runDispatcher with one-row leases. A DB
//   proxy parks each instance before its lease, claim and record statements, and the SES
//   fake parks it before the provider call. `D1 step` releases one parked point;
//   `D1 crash` abandons the instance there (the parked statement never runs).
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

// Protocol frames own stdout. Application logs go to stderr (or nowhere).
const quiet = process.env.TEAR_VERBOSE !== '1';
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) console[level] = (...args: unknown[]) => { if (!quiet) process.stderr.write(args.map(String).join(' ') + '\n'); };

// An unhandled rejection or exception would end the host mid-trace. Report it as a violation
// of the trace it happened in (the dispatcher must not leak failures) and keep serving.
const leaked: string[] = [];
const leak = (kind: string) => (error: unknown) => {
  const text = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  process.stderr.write(`host ${kind}: ${text}\n`); leaked.push(`${kind}:${(error instanceof Error ? error.message : String(error)).slice(0, 100)}`);
};
process.on('unhandledRejection', leak('unhandled-rejection'));
process.on('uncaughtException', leak('uncaught-exception'));

// ---- virtual clock -------------------------------------------------------------------
const RealDate = Date;
let clockBase = 0, clockReal = RealDate.now();
const vnow = () => clockBase + (RealDate.now() - clockReal);
class VirtualDate extends RealDate {
  constructor(...args: unknown[]) { if (args.length) super(...(args as [string])); else super(vnow()); }
  static override now() { return vnow(); }
}
globalThis.Date = VirtualDate as DateConstructor;

// Before any module that connects: a loopback URL nothing can redirect, then the marker and
// the data check, before the first write. Refusals exit 1 with the reason on stderr.
const { disposableUrl, assertDisposable } = await import('./disposable.js');
const url = await (async () => {
  try {
    const checked = disposableUrl(process.env.TEAR_DATABASE_URL);
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: checked });
    await client.connect();
    try { await assertDisposable(text => client.query(text)); } finally { await client.end(); }
    return checked;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
})();
const withClock = `${url}?options=${encodeURIComponent('-c search_path=tear_clock,pg_catalog,public')}`;

const env = {
  DATABASE_URL: withClock, BETTER_AUTH_SECRET: 'tear-'.repeat(8), GOOGLE_CLIENT_ID: 'tear', GOOGLE_CLIENT_SECRET: 'tear',
  AUTH_ALLOWED_EMAILS: 'operator@example.com', PUBLIC_URL: 'http://127.0.0.1:9', ENABLE_LIVE_SES: 'false',
  S3_BUCKET: 'tear', S3_ACCESS_KEY_ID: 'tear', S3_SECRET_ACCESS_KEY: 'tear', S3_ENDPOINT: 'http://127.0.0.1:9',
  SIMULATED_SES_LATENCY_MS: '0', SIMULATED_SES_DELIVERY_DELAY_MS: '0', AWS_EC2_METADATA_DISABLED: 'true',
};

const [{ nodeRuntime }, { createApp }, { sql }, { runDispatcher, initialGate }, { dispatchPartitions, drainJobs }, { SESv2Client }, { ensureRegionSettings }] = await Promise.all([
  import('../src/adapters/node.js'), import('../src/app.js'), import('drizzle-orm'), import('../src/dispatcher.js'), import('../src/dispatch.js'),
  import('@aws-sdk/client-sesv2'), import('../src/ses-region-state.js'),
]);
type GateState = import('../src/dispatcher.js').GateState;
type Runtime = import('../src/core.js').Runtime;

const { runtime, close: closePool } = nodeRuntime(env);
const db = runtime.db;
const app = createApp();
const q = async <T = Record<string, unknown>>(query: ReturnType<typeof sql>) => (await db.execute(query)).rows as T[];

// ---- database preparation (idempotent) ---------------------------------------------
async function prepareDatabase() {
  await db.execute(sql.raw(`
    CREATE SCHEMA IF NOT EXISTS tear_clock;
    CREATE TABLE IF NOT EXISTS tear_clock.state(singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), off interval NOT NULL DEFAULT '0');
    -- The latest virtual time any host has used: a new host starts after it, so region-wide queries
    -- (the tail claim counts every workspace's attempts) never see another run's rows as recent.
    ALTER TABLE tear_clock.state ADD COLUMN IF NOT EXISTS horizon bigint NOT NULL DEFAULT 0;
    INSERT INTO tear_clock.state DEFAULT VALUES ON CONFLICT DO NOTHING;
    CREATE OR REPLACE FUNCTION tear_clock.clock_timestamp() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT pg_catalog.clock_timestamp() + (SELECT off FROM tear_clock.state) $$;
    CREATE OR REPLACE FUNCTION tear_clock.now() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT pg_catalog.now() + (SELECT off FROM tear_clock.state) $$;
    CREATE OR REPLACE FUNCTION tear_clock.statement_timestamp() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT pg_catalog.statement_timestamp() + (SELECT off FROM tear_clock.state) $$;
    DO $$ DECLARE c record; BEGIN
      FOR c IN SELECT table_name, column_name, column_default FROM information_schema.columns
        WHERE table_schema='public' AND column_default ~ '(^|[^.])(now|clock_timestamp|statement_timestamp)\\(\\)' LOOP
        EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I SET DEFAULT %s', c.table_name, c.column_name,
          regexp_replace(c.column_default, '(^|[^.])(now|clock_timestamp|statement_timestamp)\\(\\)', '\\1tear_clock.\\2()', 'g'));
      END LOOP;
    END $$;`));
  // Earlier runs leave their workspaces settled; nothing of theirs is due or attempting.
  await db.execute(sql.raw(`UPDATE sending_emails SET status='canceled' WHERE workspace_id LIKE 'tear\\_%' AND status IN ('queued','attempting');
    UPDATE jobs SET status='completed' WHERE workspace_id LIKE 'tear\\_%' AND status IN ('pending','running');`));
}

// Every action starts at its model second plus 50 ms, or where the previous action in the
// same second stopped. Events therefore happen 50-990 ms into their model second, and any
// two deadlines whole seconds apart compare the same way on every run.
let lastVirtual = 0;
async function setClock(epochMs: number) {
  const start = Math.max(epochMs, lastVirtual);
  if (start - epochMs > 940 && !config.invariants) throw new Error(`clock drift: ${start - epochMs} ms of work in one model second`);
  clockReal = RealDate.now(); clockBase = start;
  await db.execute(sql`UPDATE tear_clock.state SET off = ${clockBase - clockReal} * interval '1 millisecond'`);
}

// ---- trace state ---------------------------------------------------------------------
type Persona = 'ok' | 'thr' | 'rej' | 'unk';
type Mail = { name: string; id: string; persona: Persona; calls: number; accepted: number[] };
type Pending = { kind: 'lease' | 'claim' | 'ses' | 'record'; ids: string[]; release: () => void };
type Instance = { gate: GateState; running?: Promise<unknown>; parked: Pending[]; wake?: () => void; done: boolean; error?: string; generation: number; emptyLease?: boolean; shard?: { index: number; count: number } };
type Config = { quota: number; pace: number | null; seed: number; recipients: Persona[]; shards: boolean; invariants: boolean; owners: number; drainBatch: number };

let trace = 0, epoch = 0;
let W = '', R = '', SECRET = '', CAMPAIGN = '', config: Config = { quota: -1, pace: null, seed: 0, recipients: [], shards: false, invariants: false, owners: 1, drainBatch: 24 };
// Every owner of this trace (a second workspace sends with its own key when `owners` is 2).
let OWNERS: string[] = [], SECRET2 = '';
const owned = () => sql`workspace_id = ANY(${sql.param(OWNERS)}::text[])`;
let mails = new Map<string, Mail>(), byName = new Map<string, Mail>(), names = 0;
let gates = new Map<string, GateState>();
let instances = new Map<string, Instance>();
let sesAccepted: number[] = []; // virtual times of accepted sends (the fake's 24-hour quota window)
let safety: string[] = [];
let canceledAt: number | null = null;
// Provider calls and campaign releases since the last observation, for tear's temporal monitor.
type Event = { at: number; kind: 'send'; mail: string; proc: string; out: string; campaign: boolean; since?: number } | { at: number; kind: 'release'; windowStart: number | null; windowN: number; pace: number | null; expanded: number };
let events: Event[] = [];
let lastExpanded = 0;

const ctx = new AsyncLocalStorage<{ instance?: string; generation?: number }>();
const nameOf = (id: string) => mails.get(id)?.name ?? `?${id.slice(-6)}`;

const letters = (n: number) => { let s = ''; do { s = String.fromCharCode(97 + n % 26) + s; n = Math.floor(n / 26); } while (n); return s; };
// Unique across hosts as well as traces: region-wide statements must only ever see this trace.
const regionName = (n: number) => `te-${letters(process.pid)}-${letters(n)}-1`;

async function reset(cfg: Partial<Config>) {
  await assertDisposable(text => db.execute(sql.raw(text)) as Promise<{ rows: Record<string, unknown>[] }>);
  trace++;
  config = { quota: cfg.quota ?? -1, pace: cfg.pace ?? null, seed: cfg.seed ?? 0, recipients: cfg.recipients ?? ['ok', 'thr'], shards: cfg.shards ?? false, invariants: cfg.invariants ?? false, owners: cfg.owners ?? 1, drainBatch: cfg.drainBatch ?? 24 };
  // Each trace starts on a fresh hour, after everything the previous trace wrote.
  if (trace === 1) lastVirtual = Math.max(lastVirtual, Number((await q<{ horizon: string }>(sql`SELECT horizon FROM tear_clock.state`))[0]!.horizon));
  epoch = Math.ceil((Math.max(lastVirtual, RealDate.now()) + 3_600_000) / 3_600_000) * 3_600_000;
  await setClock(epoch + 50);
  W = `tear_${process.pid}_${trace}`; R = regionName(trace); SECRET = 'bane_' + createHash('sha256').update(W).digest('hex');
  mails = new Map(); byName = new Map(); names = 0; gates = new Map(); instances = new Map(); sesAccepted = []; safety = []; canceledAt = null; events = []; lastExpanded = 0; marketingAccepted = []; accountPaused = false; pauseRefusedAt.clear();
  const contacts = config.recipients.map((p, i) => ({ id: `${W}_c${i + 1}`, email: `${p}-c${i + 1}@example.com` }));
  await db.execute(sql`WITH w AS (INSERT INTO workspaces(id,name,slug) VALUES (${W},${W},${W}) RETURNING id),
    k AS (INSERT INTO api_keys(id,workspace_id,name,hash,prefix,permissions,domains) SELECT ${W + '_key'},id,'tear',${createHash('sha256').update(SECRET).digest('hex')},${SECRET.slice(0, 14)},'["read","send","manage"]','[]' FROM w),
    c AS (INSERT INTO audience_contacts(id,workspace_id,email,marketing_consent) SELECT x.id,w.id,x.email,'subscribed' FROM w,jsonb_to_recordset(${JSON.stringify(contacts)}::jsonb) x(id text,email text) RETURNING id),
    l AS (INSERT INTO audience_lists(id,workspace_id,name) SELECT ${W + '_list'},id,'tear' FROM w RETURNING id)
    INSERT INTO audience_list_members(workspace_id,list_id,contact_id) SELECT ${W},l.id,c.id FROM l,c`);
  await ensureRegionSettings(db, { workspaceId: W, regions: [R] });
  OWNERS = [W];
  if (config.owners > 1) {
    // A second owner after the first in id order, with its own send key and region settings.
    const W2 = `${W}_b`; SECRET2 = 'bane_' + createHash('sha256').update(W2).digest('hex'); OWNERS.push(W2);
    await db.execute(sql`WITH w AS (INSERT INTO workspaces(id,name,slug) VALUES (${W2},${W2},${W2}) RETURNING id)
      INSERT INTO api_keys(id,workspace_id,name,hash,prefix,permissions,domains) SELECT ${W2 + '_key'},id,'tear',${createHash('sha256').update(SECRET2).digest('hex')},${SECRET2.slice(0, 14)},'["read","send","manage"]','[]' FROM w`);
    await ensureRegionSettings(db, { workspaceId: W2, regions: [R] });
  }
  if (config.seed) await db.execute(sql`INSERT INTO sending_stream_depth(workspace_id,stripe,marketing,n) VALUES (${W},99,false,${config.seed})`);
  const draft = await api('POST', '/v1/campaigns', { name: 'tear', from: 'sender@example.com', region: R, subject: 'Hello', html: '<p>Hello</p>', audience: { listId: W + '_list' } });
  if (draft.status !== 201) throw new Error(`campaign draft: ${draft.status} ${JSON.stringify(draft.body)}`);
  CAMPAIGN = draft.body.id;
  const value = await observe(null);
  lastVirtual = epoch + 50; // The first action starts at second 0 again: setup is outside model time.
  return value;
}

async function end() {
  // Nothing of this trace stays due, running or attempting for a later trace's global sweeps.
  for (const inst of instances.values()) inst.done = true;
  await db.execute(sql`WITH e AS (UPDATE sending_emails SET status='canceled' WHERE ${owned()} AND status IN ('queued','attempting') RETURNING 1),
    j AS (UPDATE jobs SET status='completed' WHERE ${owned()} AND status IN ('pending','running') RETURNING 1)
    UPDATE sending_campaigns SET state='canceled',paused_at=NULL,pause_reason=NULL WHERE workspace_id=${W} AND state IN ('preparing','scheduled','sending','paused','failed')`);
  lastVirtual = vnow();
  await db.execute(sql`UPDATE tear_clock.state SET horizon = greatest(horizon, ${Math.ceil(lastVirtual)})`);
  return null;
}

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, secret = SECRET) {
  const response = await app.fetch(new Request('http://127.0.0.1:9' + path, { method, headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), runtime);
  const text = await response.text();
  let parsed: any = null; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, body: parsed };
}

// ---- fake SES ------------------------------------------------------------------------
const providerError = (status: number, name: string, message: string) => Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status } });
const withinDay = () => sesAccepted.filter(at => at > vnow() - 86_400_000).length;
// GetAccount and SendEmail, for this trace's region only. A stepped instance parks before the call.
(SESv2Client.prototype as any).send = async function (command: any) {
  const name = command.constructor.name, input = command.input;
  if (name === 'GetAccountCommand') return { SendingEnabled: !accountPaused, SendQuota: { MaxSendRate: 1000, Max24HourSend: config.quota, SentLast24Hours: config.quota < 0 ? 0 : withinDay() } };
  if (name !== 'SendEmailCommand') throw new Error(`unexpected SES call ${name}`);
  const id = (input.EmailTags as { Name: string; Value: string }[]).find(t => t.Name === 'bane_email_id')!.Value;
  const store = ctx.getStore();
  if (store?.instance) {
    const inst = instances.get(store.instance)!;
    if (inst.generation !== store.generation) return new Promise(() => {}); // A crashed process calls nothing.
    await park(inst, 'ses', [id]);
  }
  const mail = mails.get(id);
  if (!mail) { safety.push(`ses:unknown-email:${id}`); throw providerError(400, 'MessageRejected', 'unknown'); }
  mail.calls++;
  const campaign = mail.name.startsWith('c');
  const event = (out: string) => events.push({ at: vnow(), kind: 'send', mail: mail.name, proc: store?.instance ? `${store.instance}#${store.generation}` : 'runner', out, campaign });
  if (canceledAt !== null && campaign && !preCancel.has(mail.name)) safety.push(`sent-after-cancel:${mail.name}`);
  if (accountPaused) {
    event('paused'); if (!pauseRefusedAt.has(mail.name)) pauseRefusedAt.set(mail.name, vnow());
    throw providerError(400, 'SendingPausedException', 'Sending is paused for this account.');
  }
  if (config.quota >= 0 && withinDay() >= config.quota) { event('quota'); throw providerError(400, 'MessageRejected', 'Daily message quota exceeded.'); }
  const outcome = mail.persona === 'thr' && mail.calls === 1 ? 'throttle' : mail.persona === 'thr' ? 'ok' : mail.persona;
  event(outcome === 'throttle' ? 'throttled' : outcome === 'rej' ? 'refused' : outcome === 'unk' ? 'unknown' : 'accepted');
  if (outcome === 'throttle') {
    // Sends already started in this pump turn are in flight; the brake binds the ones that start
    // after the dispatcher has handled this response (its microtasks run before setImmediate).
    const at = vnow(), proc = store?.instance ? `${store.instance}#${store.generation}` : 'runner';
    setImmediate(() => events.push({ at: vnow(), kind: 'send', mail: '', proc, out: 'braked', campaign: false, since: at } as Event));
    throw providerError(429, 'TooManyRequestsException', 'Maximum sending rate exceeded.');
  }
  if (outcome === 'rej') throw providerError(400, 'MessageRejected', 'Email address is not verified.');
  // A 5xx may or may not have been accepted: count it as a possible delivery.
  mail.accepted.push(vnow());
  sesAccepted.push(vnow());
  if (campaign) marketingAccepted.push(vnow());
  if (outcome === 'unk') throw providerError(500, 'InternalFailure', 'Service unavailable.');
  return { MessageId: 'tear-' + randomUUID() };
};
let preCancel = new Set<string>();
let marketingAccepted: number[] = [];
// Account-wide sending pause (SES SendingPausedException; GetAccount reports SendingEnabled false).
let accountPaused = false;
const pauseRefusedAt = new Map<string, number>(); // first pause refusal per message

// ---- stepped instances ---------------------------------------------------------------
function classify(text: string): Pending['kind'] | undefined {
  if (text.includes('WITH RECURSIVE queued_owners')) return 'lease';
  if (text.includes('key_state AS MATERIALIZED')) return 'claim';
  if (text.includes('simulated_callbacks AS')) return 'record';
  return undefined;
}
function park(inst: Instance, kind: Pending['kind'], ids: string[]) {
  return new Promise<void>(release => { inst.parked.push({ kind, ids, release }); inst.wake?.(); });
}
function barrierDb(inst: Instance, generation: number): Runtime['db'] {
  const dialect = (db as any).dialect;
  return new Proxy(db, { get(target, prop, receiver) {
    if (prop === 'execute') return async (query: any) => {
      if (inst.generation !== generation) return new Promise(() => {}); // A crashed process issues nothing more.
      const rendered = dialect.sqlToQuery(query.getSQL ? query.getSQL() : query);
      const kind = classify(rendered.sql);
      // A lease that found nothing changes nothing: the same step keeps going until the
      // process leases a row or its run ends, however many empty leases it issues.
      if (kind && !(kind === 'lease' && inst.emptyLease)) await park(inst, kind, kind === 'lease' ? [] : idsIn(rendered.params));
      const result = await target.execute(query);
      if (kind === 'lease') inst.emptyLease = !(result.rows as { id?: string }[]).some(row => row.id);
      if (process.env.TEAR_DEBUG === '1') process.stderr.write(`[${(vnow() - epoch) / 86_400_000}d] ${kind ?? rendered.sql.slice(0, 60).replace(/\s+/g, ' ')} rows=${(result.rows as { id?: string }[]).filter(r => r.id !== null).length} gate=${JSON.stringify(inst.gate)}\n`);
      return result;
    };
    const value = Reflect.get(target, prop, receiver);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as Runtime['db'];
}
function idsIn(params: unknown[]) {
  const ids: string[] = [];
  for (const p of params) if (typeof p === 'string' && p.startsWith('[')) {
    try { for (const row of JSON.parse(p)) { const id = row.id ?? row.email_id; if (typeof id === 'string' && mails.has(id) && !ids.includes(id)) ids.push(id); } } catch { /* not a row list */ }
  }
  return ids;
}
// Start an idle instance, or release its parked point; then run until it parks again or its run ends.
async function step(name: string) {
  const inst = instance(name);
  inst.emptyLease = false;
  if (!inst.running) {
    const generation = inst.generation;
    const scoped: Runtime = { ...runtime, db: barrierDb(inst, generation) };
    inst.done = false; inst.error = undefined;
    inst.running = ctx.run({ instance: name, generation }, () => runDispatcher(scoped, {
      region: R, lanes: 1, batchSize: 1, sendConcurrency: 1, gate: inst.gate, schedulePartialFlush: () => () => {}, ...(inst.shard ? { shard: inst.shard } : {}),
    })).then(() => undefined, (error: Error) => error.message).then(error => {
      if (inst.generation !== generation) return;
      inst.done = true; inst.running = undefined; inst.error = error; inst.wake?.();
      // A paused account makes the quota refresh fail with a retryable 503; the Durable Object
      // retries in 15 s. Anything else is a dispatcher failure.
      if (error && config.invariants && !/SES sending is disabled/.test(error)) safety.push(`dispatcher-error:${error.slice(0, 120)}`);
    });
  } else {
    const next = inst.parked.shift();
    if (!next) throw new Error(`${name} is running but not parked`);
    next.release();
  }
  const deadline = RealDate.now() + 30_000;
  while (!inst.done && !inst.parked.length) {
    if (RealDate.now() > deadline) throw new Error(`${name} did not park or finish within 30 s`);
    await new Promise<void>(resolve => { inst.wake = resolve; setTimeout(resolve, 20); });
  }
}
function instance(name: string) {
  let inst = instances.get(name);
  if (!inst) {
    inst = { gate: initialGate(), parked: [], done: true, generation: 0, shard: config.shards ? { index: name === 'D1' ? 0 : 1, count: 2 } : undefined };
    instances.set(name, inst);
  }
  return inst;
}
function crash(name: string) {
  const inst = instance(name);
  // The parked statement or provider call never happens; the process and its gate are gone.
  inst.generation++; inst.parked = []; inst.running = undefined; inst.done = true; inst.error = undefined; inst.gate = initialGate();
}
function phase(name: string) {
  const inst = instances.get(name);
  if (!inst) return 'off';
  if (inst.error) return 'error:' + inst.error.slice(0, 80);
  const p = inst.parked[0];
  if (p) return p.kind === 'lease' ? 'lease' : `${p.kind} ${p.ids.map(nameOf).join(',')}`;
  return inst.done ? 'off' : 'busy';
}

// Campaign rows are named in lease order (creation, then id), which is the order the model uses.
function nameRows(rows: { id: string; campaign_id: string | null; to: string[] }[]) {
  let released = [...mails.values()].filter(m => m.name.startsWith('c')).length;
  for (const row of rows) if (!mails.has(row.id)) {
    if (row.campaign_id) { const mail: Mail = { name: `c${++released}`, id: row.id, persona: row.to[0]!.split('-')[0] as Persona, calls: 0, accepted: [] }; mails.set(row.id, mail); byName.set(mail.name, mail); }
    else newMail(row.id, row.to[0]!.split('-')[0] as Persona, 'x');
  }
}
async function nameReleased() {
  nameRows(await q<{ id: string; campaign_id: string | null; to: string[] }>(sql`SELECT id,campaign_id,to_addresses AS "to" FROM sending_emails WHERE ${owned()} ORDER BY created_at,id`));
}

// Liveness: let a day pass at a time and run every process to completion, the run job and
// the sweep, until nothing is queued or attempting; whatever remains after a week is stuck.
async function settle() {
  accountPaused = false; // Liveness is promised once the provider accepts mail again.
  for (const name of ['D1', 'D2']) crash(name); // Parked work is abandoned, as on a restart.
  for (let day = 0; day < 7; day++) {
    clockBase = vnow() + 86_400_000 + 60_000; clockReal = RealDate.now();
    await db.execute(sql`UPDATE tear_clock.state SET off = ${clockBase - clockReal} * interval '1 millisecond'`);
    await dispatchPartitions(runtime, true);
    await drainJobs(runtime, 20, 1, 15_000, 'work');
    await nameReleased();
    for (const name of ['D1', 'D2']) { await step(name); while (!instances.get(name)!.done) await step(name); }
    const [left] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM sending_emails WHERE ${owned()} AND status IN ('queued','attempting')`);
    if (!left!.n) return;
  }
  for (const r of await q<{ id: string; status: string }>(sql`SELECT id,status FROM sending_emails WHERE ${owned()} AND status IN ('queued','attempting')`)) safety.push(`stuck:${nameOf(r.id)}:${r.status}`);
}

// ---- actions ---------------------------------------------------------------------------
function newMail(id: string, persona: Persona, prefix: string) {
  const mail: Mail = { name: `${prefix}${++names}`, id, persona, calls: 0, accepted: [] };
  mails.set(id, mail); byName.set(mail.name, mail); return mail;
}
const sendBody = (persona: Persona, kind = 'transactional') => ({ from: 'sender@example.com', to: `${persona}-${kind[0]}@example.com`, subject: 'Tear', text: 'Synthetic tear message.', kind });
async function send(persona: Persona, key?: string, concurrent = false, secret = SECRET) {
  const headers: Record<string, string> = key ? { 'idempotency-key': `${W}-${key}` } : {};
  const one = () => api('POST', '/v1/emails/send', sendBody(persona), headers, secret);
  const replies = concurrent ? await Promise.all([one(), one()]) : [await one()];
  return replies.map(reply => {
    if (reply.status !== 202) return [reply.status, reply.body?.error?.code ?? null];
    const id = reply.body.id as string;
    return [reply.status, (mails.get(id) ?? newMail(id, persona, 'e')).name];
  });
}
async function campaignAction(action: string) {
  const path = `/v1/campaigns/${CAMPAIGN}`;
  let reply;
  if (action === 'launch' || action === 'schedule') {
    const current = await api('GET', path);
    reply = await api('POST', `${path}/${action === 'launch' ? 'send' : 'schedule'}`, { revision: current.body.revision, ...(action === 'schedule' ? { scheduledAt: new Date(vnow() - 500 + 60_000).toISOString() } : {}) });
    // The API's minimum daily cap is 100; the release step itself takes any positive cap.
    if (reply.status === 202 && config.pace !== null) await db.execute(sql`UPDATE sending_campaigns SET pace_per_day=${config.pace} WHERE workspace_id=${W} AND id=${CAMPAIGN}`);
  } else reply = await api('POST', `${path}/${action}`, action === 'cancel' ? undefined : {});
  if (action === 'cancel' && reply.status === 200) {
    canceledAt = vnow();
    preCancel = new Set((await q<{ id: string }>(sql`SELECT id FROM sending_emails WHERE workspace_id=${W} AND campaign_id=${CAMPAIGN} AND status<>'queued' AND status<>'canceled'`)).map(r => nameOf(r.id)));
    return [reply.status, reply.body.canceled, reply.body.inFlight];
  }
  return [reply.status, reply.status < 300 ? null : reply.body?.error?.code ?? null];
}

async function act(label: string) {
  const [verb, ...args] = label.split(' ');
  let result: unknown = null;
  if (verb === 'wait') return result;
  switch (verb) {
    case 'send': result = await send(args[0] as Persona); break;
    case 'send2': result = await send(args[0] as Persona, undefined, false, SECRET2); break;
    case 'sendk': result = await send(args[1] as Persona, args[0]); break;
    case 'dupk': result = await send(args[1] as Persona, args[0], true); break;
    case 'launch': case 'schedule': case 'pause': case 'resume': case 'cancel': result = await campaignAction(verb); break;
    case 'jobs': await drainJobs(runtime, 20, 1, 15_000, 'work'); break;
    case 'drain': {
      const gate = gates.get('runner') ?? initialGate(); gates.set('runner', gate);
      await ctx.run({}, () => runDispatcher(runtime, { region: R, lanes: 1, batchSize: config.drainBatch, gate, schedulePartialFlush: () => () => {} }));
      break;
    }
    case 'recover': await dispatchPartitions(runtime, true); break;
    case 'settle': await settle(); break;
    case 'ses': accountPaused = args[0] === 'pause'; break;
    case 'D1': case 'D2':
      if (args[0] === 'step') await step(verb); else crash(verb);
      break;
    default: throw new Error(`unknown action ${label}`);
  }
  return result;
}

// Expected and observed: every logical email's status and provider-call count, the campaign,
// each stepped instance's parked point, and property violations the host can see directly.
async function observe(result: unknown) {
  type Row = { id: string; status: string; campaign_id: string | null; to: string[] };
  const [state] = await q<{ rows: Row[] | null; campaign: [string, number, number, number | null, number | null]; depth: number; queued: number }>(sql`SELECT
    (SELECT jsonb_agg(jsonb_build_object('id',id,'status',status,'campaign_id',campaign_id,'to',to_addresses) ORDER BY created_at,id) FROM sending_emails WHERE ${owned()}) AS rows,
    (SELECT jsonb_build_array(state,expanded,window_expanded,floor(extract(epoch FROM window_started_at)*1000),pace_per_day) FROM sending_campaigns WHERE workspace_id=${W} AND id=${CAMPAIGN}) AS campaign,
    (SELECT coalesce(sum(n),0)::int FROM sending_stream_depth WHERE ${owned()}) AS depth,
    (SELECT count(*)::int FROM sending_emails WHERE ${owned()} AND review_id IS NULL AND status IN ('queued','attempting')) AS queued`);
  const rows = state!.rows ?? [];
  nameRows(rows);
  const mail: Record<string, unknown> = {};
  for (const row of rows) { const m = mails.get(row.id)!; mail[m.name] = [row.status, m.calls]; }
  const d: Record<string, string> = {};
  for (const name of ['D1', 'D2']) if (instances.has(name)) d[name] = phase(name);
  // Properties checked against the real state, independent of the model's prediction.
  for (const m of mails.values()) if (m.accepted.length > 1) safety.push(`double-send:${m.name}`);
  safety.push(...leaked.splice(0));
  if (state!.depth !== state!.queued + config.seed) safety.push(`depth:${state!.depth}!=${state!.queued}+${config.seed}`);
  if (config.quota >= 0 && withinDay() > config.quota) safety.push(`quota:${withinDay()}>${config.quota}`);
  // Campaign mail never spends the 10% reserve kept for transactional mail (rounded up).
  // A row is given up as pause-expired only 24 h after its first pause refusal (or later).
  for (const r of await q<{ id: string }>(sql`SELECT id FROM sending_emails WHERE ${owned()} AND error_code='SES_ACCOUNT_PAUSE_EXPIRED'`)) {
    const first = pauseRefusedAt.get(nameOf(r.id));
    if (first !== undefined && vnow() < first + 86_400_000) safety.push(`pause-expired-early:${nameOf(r.id)}`);
  }
  if (config.quota > 0) {
    const reserve = Math.ceil(config.quota * 10 / 100), marketing = marketingAccepted.filter(at => at > vnow() - 86_400_000).length;
    if (marketing > config.quota - reserve) safety.push(`reserve:${marketing}>${config.quota - reserve}`);
  }
  const [cstate, expanded, windowN, windowStart, pace] = state!.campaign;
  if (expanded > lastExpanded) events.push({ at: vnow(), kind: 'release', windowStart, windowN, pace, expanded });
  lastExpanded = expanded;
  const log = events; events = [];
  if (process.env.TEAR_EVENTS === '1') for (const e of log) process.stderr.write(JSON.stringify({ ...e, at: e.at - epoch }) + '\n');
  if (config.invariants) return { safety: [...new Set(safety)], log };
  return { r: result ?? null, mail, campaign: [cstate, expanded, windowN], d, safety: [...new Set(safety)], log };
}

// ---- JSON Lines v1 -------------------------------------------------------------------
const timing = new Map<string, [number, number, number, number]>();
await prepareDatabase();
const lines = createInterface({ input: process.stdin });
const reply = (frame: object) => new Promise<void>(resolve => process.stdout.write(JSON.stringify(frame) + '\n', () => resolve()));
for await (const line of lines) {
  const request = JSON.parse(line) as { v: number; id: number; op: string; action?: any };
  try {
    let value: unknown = null;
    if (request.op === 'act') {
      const a = request.action;
      if (a && typeof a === 'object' && a.reset) { const began = performance.now(); value = await reset(a.reset); const e = timing.get('reset') ?? [0, 0, 0, 0]; e[0]++; e[1] += performance.now() - began; e[3] = Math.max(e[3], performance.now() - began); timing.set('reset', e); }
      else if (a && typeof a === 'object' && a.end) value = await end();
      else {
        // { at: <model second>, action: <label> }
        const began = performance.now();
        await setClock(epoch + a.at * 1000 + 50);
        const result = await act(a.action);
        const acted = performance.now();
        value = await observe(result);
        lastVirtual = vnow();
        const verb = String(a.action).split(' ').slice(0, 2).join(' ').replace(/ (ok|thr|rej|unk)$/, '');
        const entry = timing.get(verb) ?? [0, 0, 0, 0]; entry[0]++; entry[1] += acted - began; entry[2] += performance.now() - acted; entry[3] = Math.max(entry[3], acted - began); timing.set(verb, entry);
      }
    }
    await reply({ v: 1, id: request.id, ok: true, value });
    if (request.op === 'close') break;
  } catch (error) {
    const cause = (error as { cause?: { message?: string; code?: string } }).cause;
    await reply({ v: 1, id: request.id, ok: false, error: error instanceof Error ? `${cause ? `${cause.code}: ${cause.message} <- ` : ''}${error.message}\n${error.stack ?? ''}`.slice(0, 2000) : String(error) });
  }
}
if (process.env.TEAR_PROFILE === '1') for (const [verb, [n, actMs, observeMs, max]] of timing) process.stderr.write(`${verb.padEnd(12)} ${String(n).padStart(6)}  act ${(actMs / n).toFixed(2)} ms (max ${max.toFixed(0)})  observe ${(observeMs / n).toFixed(2)} ms\n`);
if (process.env.TEAR_PROFILE === '1') process.stderr.write(`heap ${(process.memoryUsage().heapUsed / 1e6).toFixed(0)} MB\n`);
await closePool();
process.exit(0);
