// tear product host for inbox phase 2: drives the real API routes and SQL routines over an
// isolated PostgreSQL, one JSON request per stdin line and one JSON reply per stdout line.
//   {"op":"reset","quota":2}         fresh synthetic workspace with inboxes A and B
//   {"op":"act","action":"W seen A m1"}  one model action; returns {r, woke, view, safety}
// Connections I and J are ingest workers, W and V are API request handlers. Their statements run
// inside explicit transactions so a step can land between a statement's locks and its COMMIT;
// a statement waiting on another backend's lock is reported as "blocked". Unprefixed actions
// are autocommit requests on a separate connection.
//
// It runs only on a dedicated, migrated database its creator marked disposable
// (../disposable.ts, the rule every tear host shares): TEAR_DATABASE_URL must be a plain loopback
// URL, and the marker and the foreign-data check pass before the first write and before every
// fixture. Its workspaces are tear_inbox_*.
import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
const hex = (n: number) => Array.from({ length: Math.ceil(n / 32) }, () => randomUUID().replaceAll('-', '')).join('').slice(0, n);

// The app logs JSON to the console; keep stdout for the protocol.
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) console[level] = (...a: unknown[]) => { process.stderr.write(a.map(String).join(' ') + '\n'); };
const out = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');

// Before any module that connects: a loopback URL nothing can redirect, then the marker and the
// data check. A refusal exits 1 with the reason on stderr.
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

const [{ createApp }, { dispatchAsMailboxAccess }, { nodeRuntime }, { storeIncoming }, { acceptInboundNotification }, { attachToMailboxes }, { ingestInput }] = await Promise.all([
  import('../../src/app.js'), import('../../src/auth.js'), import('../../src/adapters/node.js'), import('../../src/mailbox-ingest-store.js'),
  import('../../src/mailbox-receipts.js'), import('../../src/mailbox-store.js'), import('../../src/mailbox-ingest-input.js'),
]);
const instance = nodeRuntime({ DATABASE_URL, BANE_ROOT_SECRET: hex(64), ACCOUNT_CLIENT_ID: 'tear-fixture', ACCOUNT_CLIENT_PRIVATE_KEY: 'tear-fixture',
  AUTH_ALLOWED_EMAILS: 'operator@example.com', PUBLIC_URL: 'http://127.0.0.1:9', ENABLE_LIVE_SES: 'false', S3_BUCKET: 'tear-fixture', S3_ACCESS_KEY_ID: 'tear', S3_SECRET_ACCESS_KEY: 'tear' });
const runtime = instance.runtime;
const app = createApp();
const REGION = 'us-east-1', BUCKET = 'tear-fixture', TOPIC = `arn:aws:sns:${REGION}:111122223333:tear-inbound`;
const ROLES = ['archive', 'inbox', 'junk', 'sent', 'trash'] as const;
const BOXES = ['A', 'B'] as const;
type Json = any;
type Db = NodePgDatabase<Record<string, unknown>>;

async function client() {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  const pid = (await c.query('SELECT pg_backend_pid() pid')).rows[0].pid as number;
  return { client: c, db: drizzle(c) as unknown as Db, pid };
}
type Conn = Awaited<ReturnType<typeof client>> & { name: string; open: boolean; pending?: Promise<void>; settled?: { ok: boolean; value: unknown }; claim?: string[]; claimed?: string };
const conns: Record<string, Conn> = {};
for (const name of ['I', 'J', 'W', 'V']) conns[name] = { ...(await client()), name, open: false };
const auto = await client(), checker = await client();
await auto.client.query("SET lock_timeout='500ms'");

let ws = '', ids: Record<string, string> = {}, addr: Record<string, string> = {}, quota: number | null = null;
let track: { validity: Record<string, string>; maxUid: Record<string, number>; uids: Record<string, Set<number>>; next: Record<string, number>; high: Record<string, number>; ms: Record<string, number>; removed: Set<string>; members: Record<string, Set<string>> };
let cursor: Record<string, string> = {}, cache: Record<string, string> = {};
const mid = (m: string) => `${ws}_${m}`, label = (id: string) => id.slice(ws.length + 1);

// Cancel every waiting statement first: a ROLLBACK queued behind a blocked statement on the same
// connection would wait for a transaction that is itself only rolled back later.
async function abortAll() {
  for (const c of Object.values(conns)) if (c.pending && !c.settled) await checker.client.query('SELECT pg_cancel_backend($1)', [c.pid]);
  for (const c of Object.values(conns)) {
    if (c.pending) await c.pending;
    if (c.open) await c.client.query('ROLLBACK');
    Object.assign(c, { open: false, pending: undefined, settled: undefined, claim: undefined, claimed: undefined });
  }
}
async function reset(q: number | null) {
  await abortAll();
  await assertDisposable(text => checker.client.query(text));
  if (ws) await auto.client.query('DELETE FROM mailboxes WHERE workspace_id=$1', [ws]);
  ws = 'tear_inbox_' + hex(12); quota = q;
  runtime.config.workspaceId = ws;
  const host = `${ws.replaceAll('_', '-')}.invalid`, domain = `${ws}_dom`;
  ids = { A: `${ws}_a`, B: `${ws}_b` }; addr = { A: `a@${host}`, B: `b@${host}` };
  const c = auto.client;
  await c.query('BEGIN');
  await c.query('INSERT INTO workspaces(id,name,slug) VALUES($1,$1,$1)', [ws]);
  await c.query("INSERT INTO mailbox_domains(id,workspace_id,domain_id,name,region,status,catch_all) VALUES($1,$2,$1,$3,$4,'active','store')", [domain, ws, host, REGION]);
  await c.query('INSERT INTO mailbox_regions(workspace_id,region,bucket,topic_arn) VALUES($1,$2,$3,$4)', [ws, REGION, BUCKET, TOPIC]);
  for (const x of BOXES) {
    await c.query("INSERT INTO mailboxes(id,workspace_id,domain_id,address,kind,retention_mode,quota_messages,create_request) VALUES($1,$2,$3,$4,'inbox','forever',$5,'{\"type\":\"persistent\"}')", [ids[x], ws, domain, addr[x], x === 'A' ? q : null]);
    await c.query("INSERT INTO mailbox_addresses(workspace_id,address,mailbox_id,kind) VALUES($1,$2,$3,'primary')", [ws, addr[x], ids[x]]);
    await c.query('INSERT INTO inbox_state(inbox_id,workspace_id) VALUES($1,$2)', [ids[x], ws]);
  }
  await c.query('COMMIT');
  track = { validity: {}, maxUid: {}, uids: {}, next: {}, high: {}, ms: {}, removed: new Set(), members: { A: new Set(), B: new Set() } };
  cursor = { A: '0', B: '0' }; cache = {};
  await view([]);
}

// The stored row a client addresses as m1 (from its listing): d1's row when d1 was stored first.
async function resolveId(m: string) {
  if (m !== 'm1') return mid(m);
  const rows = (await checker.client.query('SELECT id FROM mail_messages WHERE id=ANY($1)', [[mid('m1'), mid('d1')]])).rows.map(r => r.id);
  return rows.includes(mid('d1')) && !rows.includes(mid('m1')) ? mid('d1') : mid('m1');
}
const recipients = (r: string) => [...r].map(ch => addr[ch.toUpperCase()]!).sort();
const recipName = (list: string[] | null | undefined) => list ? ['a', 'b'].filter(x => list.includes(addr[x.toUpperCase()]!)).join('') : null;
const errOf = (e: any) => `e:${e?.cause?.code ?? e?.code ?? e?.message ?? 'ERROR'}`;

// One REST request through the real app, on the given database connection.
async function rest(db: Db, method: string, path: string, body?: unknown, permissions: string[] = ['read', 'modify']) {
  const access = { keyId: 'tear', workspaceId: ws, admin: false, mailboxIds: [ids.A!, ids.B!], permissions } as Json;
  const req = new Request(`http://127.0.0.1:9${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await dispatchAsMailboxAccess(app, req, { ...runtime, db } as Json, access);
  const json = await res.json() as Json;
  if (res.status >= 300) return { error: `e:${json?.error?.code ?? res.status}` };
  return { body: json };
}
const mutationResult = (r: { error?: string; body?: Json }) => r.error ?? { modseq: Number(r.body.modseq), uid: r.body.uid ?? null, read: r.body.read, removed: r.body.removed };

const base = (x: string) => `/v1/inboxes/${ids[x]}`;
// The request each mutation verb sends.
async function mutation(words: string[]): Promise<[string, string, unknown?]> {
  const [verb, x, m, r, dst] = words as [string, string, string, string, string];
  const msg = `${base(x)}/messages/${verb === 'purge' || verb === 'delete' || verb === 'subscribe' ? '' : await resolveId(m)}`;
  switch (verb) {
    case 'seen': return ['PATCH', msg, { read: true }];
    case 'unseen': return ['PATCH', msg, { read: false }];
    case 'flag': return ['PATCH', msg, { flagged: true }];
    case 'del': return ['PATCH', msg, { deleted: true, source: r }];
    case 'undel': return ['PATCH', msg, { deleted: false, source: r }];
    case 'move': return ['POST', `${msg}/move`, { source: r, folder: dst }];
    case 'copy': return ['POST', `${msg}/copy`, { source: r, folder: dst }];
    case 'trash': return ['DELETE', `${msg}?source=${r}`];
    case 'expunge': return ['DELETE', `${msg}?source=${r}&permanent=true`];
    case 'purge': return ['POST', `${base(x)}/folders/${m}/expunge`, {}];
    case 'subscribe': return ['PATCH', `${base(x)}/folders/inbox`, { subscribed: true }];
    case 'delete': return ['DELETE', base(x)];
  }
  throw new Error(`unknown mutation ${verb}`);
}

// d1 is the same email as m1 (same Message-ID and content) under another SES message id.
function incoming(m: string, envelope: string[]) {
  const same = m === 'd1' ? 'm1' : m;
  return { id: mid(m), workspaceId: ws, direction: 'inbound', region: REGION, sesMessageId: mid(m), messageId: `<${same}.${ws}@example.invalid>`,
    inReplyTo: m === 'm2' ? `<m1.${ws}@example.invalid>` : null, references: m === 'm2' ? [`<m1.${ws}@example.invalid>`] : [],
    subject: `Synthetic ${same}`, fromAddress: 'sender@example.invalid', fromName: null, to: [], cc: [], bcc: [], replyTo: [], envelopeFrom: 'sender@example.invalid', envelopeTo: envelope,
    receivedAt: new Date(Date.parse('2026-11-01T00:00:00Z') + 60_000 * Number(same.slice(1))).toISOString(), text: 'synthetic', html: null, bodyTruncated: false, snippet: 'synthetic', headers: [], attachmentCount: 0, sizeBytes: 42,
    rawBucket: BUCKET, rawKey: `raw/${mid(m)}`, verdicts: {}, spam: false, automated: false, status: 'received', lifecycle: 'kept' } as Json;
}

// The statement each held or autocommit action runs.
function statement(words: string[], c: { db: Db }, claim?: string[]): () => Promise<unknown> {
  const verb = words[0]!;
  if (verb === 'accept') {
    const [, m, r] = words as [string, string, string];
    const message = { notificationType: 'Received', mail: { messageId: mid(m), timestamp: '2026-11-01T00:00:00.000Z', source: 'sender@example.invalid', destination: recipients(r) },
      receipt: { timestamp: '2026-11-01T00:00:00.000Z', recipients: recipients(r), action: { type: 'S3', bucketName: BUCKET, objectKey: `staging/${mid(m)}`, topicArn: TOPIC } } };
    return async () => ({ queued: await acceptInboundNotification({ ...runtime, db: c.db } as Json, { topicArn: TOPIC, region: REGION, message }) });
  }
  if (verb === 'store') {
    const m = words[1]!;
    return async () => { await storeIncoming(c.db as Json, incoming(m, claim!), [], false, false, false, null, undefined); return 'ok'; };
  }
  return async () => {
    const [method, path, body] = await mutation(words);
    const r = await rest(c.db, method, path, body);
    if (verb === 'subscribe') return r.error ?? Number(r.body.state);
    if (words[0] === 'purge') return r.error ?? { expunged: r.body.expunged };
    if (words[0] === 'delete') return r.error ?? r.body.status;
    return mutationResult(r);
  };
}

// Settle a pending statement: done, or waiting on another backend's row lock.
async function settle(c: Conn): Promise<unknown> {
  const start = Date.now();
  for (;;) {
    if (c.settled) { const s = c.settled; c.pending = c.settled = undefined; return s.ok ? s.value : errOf(s.value); }
    // Only a lock one of this host's transactions holds counts; autovacuum's brief truncation
    // lock (after the bulk deletes between traces) is waited out.
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
  c.open = false; c.claim = undefined;
  const woke: Record<string, unknown> = {};
  for (const other of Object.values(conns)) if (other.pending) { const v = await settle(other); if (v !== 'blocked') woke[other.name] = v; }
  return { r, woke };
}

async function act(action: string) {
  const words = action.split(' ');
  const c = conns[words[0]!];
  const rest_ = c ? words.slice(1) : words;
  const verb = rest_[0]!;
  let r: unknown, woke: Record<string, unknown> = {};
  if (c) {
    if (verb === 'commit' || verb === 'abort') ({ r, woke } = await finish(c, verb === 'commit'));
    else if (verb === 'claim') {
      const row = (await c.db.execute<{ i: Json }>(sql`SELECT ${ingestInput(runtime.config, ws, mid(rest_[1]!))} AS i`)).rows[0]?.i;
      c.claim = row?.recipients ?? undefined; c.claimed = rest_[1]; r = recipName(row?.recipients);
    } else if (verb === 'store') r = await run(c, statement(['store', c.claimed!], c, c.claim));
    else r = await run(c, statement(rest_, c));
  } else r = await autoAct(rest_);
  const safety: string[] = [];
  return { r, woke, view: await view(safety), safety };
}

async function autoTxn<T>(fn: () => Promise<T>): Promise<unknown> {
  await auto.client.query('BEGIN');
  try { const v = await fn(); await auto.client.query('COMMIT'); return v; } catch (e) { await auto.client.query('ROLLBACK'); return errOf(e); }
}

async function autoAct(words: string[]): Promise<unknown> {
  const [verb, x, m] = words as [string, string, string];
  const db = auto.db;
  switch (verb) {
    case 'store': {
      // One ingest job without interleaving: claim, then store and commit.
      const row = (await db.execute<{ i: Json }>(sql`SELECT ${ingestInput(runtime.config, ws, mid(x))} AS i`)).rows[0]?.i;
      if (!row) return null;
      const v = await autoTxn(() => statement(['store', x], auto, row.recipients)());
      return typeof v === 'string' && v.startsWith('e:') ? v : recipName(row.recipients);
    }
    case 'accept': case 'seen': case 'unseen': case 'flag': case 'del': case 'undel': case 'move': case 'copy': case 'trash': case 'expunge': case 'purge': case 'delete': case 'subscribe':
      return autoTxn(statement(words, auto));
    case 'send': return autoTxn(async () => {
      const id = mid(`s${x}`), thread = `${ws}_thr_s${x}`;
      await auto.client.query('INSERT INTO mail_threads(id,workspace_id) VALUES($1,$2)', [thread, ws]);
      const row = (await auto.client.query("INSERT INTO mail_messages(id,workspace_id,thread_id,direction,lifecycle,subject,from_address,size_bytes,received_at) VALUES($1,$2,$3,'outbound','kept','Re: synthetic',$4,100,now()) RETURNING id,thread_id AS \"threadId\",direction,received_at AS \"receivedAt\",spam", [id, ws, thread, addr[x]])).rows[0];
      await attachToMailboxes(db as Json, { workspaceId: ws } as Json, row, [ids[x]!]);
      return 'ok';
    });
    case 'folders': {
      const f = await rest(db, 'GET', `${base(x)}/folders`);
      if (f.error) return f.error;
      const folders = ROLES.map(role => f.body.data.find((d: Json) => d.role === role)).map((d: Json) => [d.uidNext, Number(d.highestModseq), d.total, d.unseen]);
      const lists = [];
      for (const role of ROLES) {
        const l = await rest(db, 'GET', `${base(x)}/messages?folder=${role}&limit=50`);
        if (l.error) return l.error;
        lists.push(l.body.data.map((e: Json) => [e.uid, label(e.id), e.read, e.flags.includes('flagged'), e.folders.find((p: Json) => p.folder === role && p.uid === e.uid)?.deleted]));
      }
      return { state: Number(f.body.state), folders, lists };
    }
    case 'sync': {
      const r = await rest(db, 'GET', `${base(x)}/changes?since=${cursor[x]}`);
      if (r.error === 'e:CHANGES_EXPIRED') { const f = await rest(db, 'GET', `${base(x)}/folders`); cursor[x] = f.body.state; return r.error; }
      if (r.error) return r.error;
      cursor[x] = r.body.state;
      return { changed: r.body.changed.map(label).sort(), removed: r.body.removed.map(label).sort(), state: Number(r.body.state) };
    }
    case 'sync-ahead': {
      const f = await rest(db, 'GET', `${base(x)}/folders`);
      if (f.error) return f.error;
      return (await rest(db, 'GET', `${base(x)}/changes?since=${BigInt(f.body.state) + 1n}`)).error ?? 'accepted';
    }
    case 'get': {
      const r = await rest(db, 'GET', `${base(x)}/messages/${await resolveId(m)}`);
      if (r.error) return r.error;
      cache[`${x}:${m}`] = r.body.modseq;
      return { modseq: Number(r.body.modseq), read: r.body.read, flagged: r.body.flags.includes('flagged'), held: r.body.held !== null, folders: r.body.folders.map((p: Json) => [p.folder, p.uid, p.deleted]) };
    }
    case 'cas': return autoTxn(async () => mutationResult(await rest(db, 'PATCH', `${base(x)}/messages/${await resolveId(m)}`, { flagged: true, ifModseq: cache[`${x}:${m}`] })));
    case 'ro': return (await rest(db, 'PATCH', `${base(x)}/messages/${await resolveId(m)}`, { read: true }, ['read'])).error ?? 'accepted';
    case 'legacy-read': return autoTxn(async () => {
      // The pre-folder Worker's PATCH /v1/inboxes/{id}/messages/{messageId} statement (74de881^).
      const r = await auto.client.query(`WITH old AS MATERIALIZED(SELECT l.* FROM mailbox_messages l JOIN mailboxes b ON b.id=l.mailbox_id WHERE b.workspace_id=$1 AND b.kind='inbox' AND (b.delete_after IS NULL OR b.delete_after>statement_timestamp()) AND b.id=$2 AND l.message_id=$3 FOR UPDATE OF l),
        changed AS (UPDATE mailbox_messages l SET read=true FROM old WHERE l.mailbox_id=old.mailbox_id AND l.message_id=old.message_id AND l.read<>true RETURNING old.*),
        refreshed AS (UPDATE mailbox_threads t SET unread_count=greatest(0,t.unread_count-1) FROM changed ch WHERE t.mailbox_id=ch.mailbox_id AND t.thread_id=ch.thread_id AND ch.held_reason IS NULL) SELECT 1 FROM old`, [ws, ids[x], await resolveId(m)]);
      return r.rowCount ? 'ok' : 'e:NOT_FOUND';
    });
    case 'thread': {
      // Conversation PATCH through the real route (it opens its own transaction).
      const t = (await auto.client.query('SELECT thread_id FROM mail_messages WHERE id=$1', [await resolveId(m)])).rows[0]?.thread_id ?? 'thr_missing';
      const k = words[3]!, body = { addressId: ids[x], ...(k.endsWith('archive') ? { archived: k === 'archive' } : k.endsWith('trash') ? { trashed: k === 'trash' } : { read: k === 'read' }) };
      const r = await rest(db, 'PATCH', `/v1/inbound/threads/${t}`, body);
      return r.error ?? 'ok';
    }
    case 'legacy-unread': return autoTxn(async () => {
      // The pre-folder Worker's conversation PATCH {read:false} (mailbox.ts patchThread, 74de881^).
      const live = (await auto.client.query('SELECT 1 FROM mailboxes WHERE id=$1 AND (delete_after IS NULL OR delete_after>now())', [ids[x]])).rowCount;
      const t = (await auto.client.query('SELECT thread_id FROM mail_messages WHERE id=$1', [await resolveId(m)])).rows[0]?.thread_id;
      const row = live && t ? (await auto.client.query('SELECT labels FROM mailbox_threads WHERE mailbox_id=$1 AND thread_id=$2 FOR UPDATE', [ids[x], t])).rows[0] : undefined;
      if (!row) return 'e:NOT_FOUND';
      const latest = (await auto.client.query("SELECT message_id FROM mailbox_messages WHERE mailbox_id=$1 AND thread_id=$2 AND direction='inbound' ORDER BY received_at DESC LIMIT 1", [ids[x], t])).rows[0];
      if (latest) await auto.client.query('UPDATE mailbox_messages SET read=false WHERE mailbox_id=$1 AND message_id=$2', [ids[x], latest.message_id]);
      await auto.client.query('UPDATE mailbox_threads SET labels=$3 WHERE mailbox_id=$1 AND thread_id=$2', [ids[x], t, row.labels]);
      await auto.client.query("UPDATE mailbox_threads SET unread_count=(SELECT count(*) FROM mailbox_messages WHERE mailbox_id=$1 AND thread_id=$2 AND NOT read AND direction='inbound') WHERE mailbox_id=$1 AND thread_id=$2", [ids[x], t]);
      return 'ok';
    });
    case 'legacy-thread': return autoTxn(async () => {
      // The pre-folder Worker's thread PATCH: lock the summary row, then rewrite its labels.
      const t = (await auto.client.query(`SELECT t.thread_id FROM mailbox_threads t JOIN mailboxes b ON b.id=t.mailbox_id JOIN mail_messages m ON m.thread_id=t.thread_id AND m.id=$3
        WHERE b.workspace_id=$1 AND b.id=$2 AND (b.delete_after IS NULL OR b.delete_after>now()) FOR UPDATE OF t`, [ws, ids[x], await resolveId(m)])).rows[0];
      if (!t) return 'e:NOT_FOUND';
      await auto.client.query("UPDATE mailbox_threads SET labels=array_append(labels,'legacy') WHERE mailbox_id=$1 AND thread_id=$2", [ids[x], t.thread_id]);
      return 'ok';
    });
    case 'sweep': while ((await auto.client.query('SELECT inbox_retention_batch(25) n')).rows[0].n > 0); return 'ok';
    case 'age': await auto.client.query("UPDATE inbox_vanished SET vanished_at=vanished_at-interval '31 days' WHERE inbox_id=ANY($1)", [[ids.A, ids.B]]); return 'ok';
    case 'prune': while ((await auto.client.query('SELECT inbox_prune_vanished() n')).rows[0].n > 0); return 'ok';
  }
  throw new Error(`unknown action ${words.join(' ')}`);
}

// Committed state of both inboxes in one snapshot, plus recount and monotonicity checks.
async function view(safety: string[]) {
  const { rows: [v] } = await checker.client.query(`SELECT jsonb_build_object(
    'boxes',(SELECT coalesce(jsonb_object_agg(b.id,jsonb_build_object('ended',b.delete_after<=now(),'ms',s.modseq,'fl',s.changes_floor,'n',s.messages,'by',s.bytes,'h',s.held)),'{}') FROM mailboxes b LEFT JOIN inbox_state s ON s.inbox_id=b.id WHERE b.id=ANY($1)),
    'folders',(SELECT coalesce(jsonb_agg(jsonb_build_array(inbox_id,role,uid_validity::text,uid_next,highest_modseq,total,unseen)),'[]') FROM inbox_folders WHERE inbox_id=ANY($1)),
    'entries',(SELECT coalesce(jsonb_agg(jsonb_build_array(inbox_id,role,uid,message_id,modseq,deleted) ORDER BY inbox_id,role,uid),'[]') FROM inbox_entries WHERE inbox_id=ANY($1)),
    'members',(SELECT coalesce(jsonb_agg(jsonb_build_array(l.mailbox_id,l.message_id,l.read,(l.flags&1)<>0,l.modseq,l.held_reason IS NOT NULL,m.thread_id,m.size_bytes)),'[]') FROM mailbox_messages l JOIN mail_messages m ON m.id=l.message_id WHERE l.mailbox_id=ANY($1)),
    'vanished',(SELECT coalesce(jsonb_agg(jsonb_build_array(inbox_id,role,uid,message_id,modseq) ORDER BY inbox_id,role,uid),'[]') FROM inbox_vanished WHERE inbox_id=ANY($1)),
    'threads',(SELECT coalesce(jsonb_agg(jsonb_build_array(mailbox_id,thread_id,message_count,unread_count)),'[]') FROM mailbox_threads WHERE mailbox_id=ANY($1)),
    'labels',(SELECT coalesce(jsonb_object_agg(thread_id,first),'{}') FROM (SELECT thread_id,min(id) first FROM mail_messages WHERE workspace_id=$2 GROUP BY thread_id) t),
    'receipts',(SELECT coalesce(jsonb_object_agg(ses_message_id,jsonb_build_array(status='pending',recipients)),'{}') FROM mail_receipts WHERE workspace_id=$2)) v`, [[ids.A, ids.B], ws]);
  const d = v.v;
  const result: Json = {};
  for (const x of BOXES) {
    const id = ids[x]!, b = d.boxes[id];
    if (!b) { result[x] = { st: 2 }; continue; }
    const folders = ROLES.map(role => d.folders.find((f: Json) => f[0] === id && f[1] === role));
    const entries = d.entries.filter((e: Json) => e[0] === id), vanished = d.vanished.filter((e: Json) => e[0] === id);
    const members = d.members.filter((e: Json) => e[0] === id), threads = d.threads.filter((e: Json) => e[0] === id);
    const memberOf = (m: string) => members.find((e: Json) => e[1] === m);
    result[x] = {
      st: b.ended ? 1 : 0, ms: b.ms, fl: b.fl, n: b.n, by: b.by, h: b.h,
      f: folders.map((f: Json) => f ? [f[3], f[4], f[5], f[6]] : null),
      e: entries.map((e: Json) => [e[1], e[2], label(e[3]), e[4], e[5]]),
      m: Object.fromEntries(members.map((e: Json) => [label(e[1]), [e[2], e[3], e[4], e[5]]])),
      v: vanished.map((e: Json) => [e[1], e[2], label(e[3]), e[4]]),
      t: Object.fromEntries(threads.map((e: Json) => [label(d.labels[e[1]] ?? '?_?'), [e[2], e[3]]])),
    };
    // Invariants on the committed state, independent of the model.
    const p = `${x}:`;
    for (const [i, role] of ROLES.entries()) {
      const f = folders[i];
      if (!f) { safety.push(`${p}${role}: folder missing`); continue; }
      const es = entries.filter((e: Json) => e[1] === role), vs = vanished.filter((e: Json) => e[1] === role);
      if (f[5] !== es.length) safety.push(`${p}${role}: total ${f[5]} != recount ${es.length}`);
      const unseen = es.filter((e: Json) => memberOf(e[3]) && !memberOf(e[3])[2]).length;
      if (f[6] !== unseen) safety.push(`${p}${role}: unseen ${f[6]} != recount ${unseen}`);
      const uids = [...es, ...vs].map((e: Json) => e[2]);
      if (uids.some((u: number) => u >= f[3])) safety.push(`${p}${role}: uidNext ${f[3]} not above every uid`);
      if ([...es, ...vs].some((e: Json) => e[4] > f[4])) safety.push(`${p}${role}: highestModseq ${f[4]} below an entry`);
      if (es.some((e: Json) => vs.some((u: Json) => u[2] === e[2]))) safety.push(`${p}${role}: uid both live and vanished`);
      const key = `${x}/${role}`;
      if (!b.ended) {
        if (track.validity[key] && track.validity[key] !== f[2]) safety.push(`${p}${role}: UIDVALIDITY changed`);
        track.validity[key] = f[2];
      }
      if (f[3] < (track.next[key] ?? 0)) safety.push(`${p}${role}: uidNext decreased`);
      if (f[4] < (track.high[key] ?? 0)) safety.push(`${p}${role}: highestModseq decreased`);
      track.next[key] = f[3]; track.high[key] = f[4];
      // A newly visible UID must exceed every UID already visible at this UIDVALIDITY.
      const known = track.uids[key] ??= new Set<number>();
      for (const e of es) if (!known.has(e[2])) {
        if (e[2] < (track.maxUid[key] ?? 0)) safety.push(`${p}${role}: uid ${e[2]} committed below visible ${track.maxUid[key]}`);
        known.add(e[2]);
      }
      track.maxUid[key] = Math.max(track.maxUid[key] ?? 0, ...es.map((e: Json) => e[2]));
    }
    const stamps = [...entries.map((e: Json) => e[4]), ...vanished.map((e: Json) => e[4]), ...members.map((e: Json) => e[4] ?? 0)];
    if (stamps.some((s: number) => s > b.ms)) safety.push(`${p}inbox modseq below a stamp`);
    if (b.ms < (track.ms[x] ?? 0)) safety.push(`${p}inbox modseq decreased`);
    track.ms[x] = b.ms;
    if (b.n !== members.length) safety.push(`${p}messages ${b.n} != recount ${members.length}`);
    if (b.h !== members.filter((e: Json) => e[5]).length) safety.push(`${p}held ${b.h} != recount`);
    if (Number(b.by) !== members.reduce((s: number, e: Json) => s + e[7], 0)) safety.push(`${p}bytes ${b.by} != recount`);
    for (const e of members) {
      const n = entries.filter((x: Json) => x[3] === e[1]).length;
      if (e[5] ? n > 0 : n === 0) safety.push(`${p}${label(e[1])}: ${e[5] ? 'held message filed' : 'membership without a folder entry'}`);
    }
    const counts = new Map<string, [number, number]>();
    for (const e of members.filter((e: Json) => !e[5])) { const c = counts.get(e[6]) ?? [0, 0]; counts.set(e[6], [c[0] + 1, c[1] + (e[2] ? 0 : 1)]); }
    for (const t of threads) { const c = counts.get(t[1]) ?? [0, 0]; if (c[0] !== t[2] || c[1] !== t[3]) safety.push(`${p}thread ${label(d.labels[t[1]] ?? '?_?')}: summary ${t[2]}/${t[3]} != recount ${c[0]}/${c[1]}`); }
    for (const [t] of counts) if (!threads.some((s: Json) => s[1] === t)) safety.push(`${p}thread ${label(d.labels[t] ?? '?_?')}: messages without a summary`);
    // No resurrection: a membership that was removed never comes back to the same inbox.
    const now = new Set<string>(members.map((e: Json) => label(e[1])));
    for (const m of track.members[x]!) if (!now.has(m)) track.removed.add(`${x}:${m}`);
    for (const m of now) if (track.removed.has(`${x}:${m}`)) safety.push(`${p}${m}: resurrected after removal`);
    track.members[x] = now;
  }
  result.r = Object.fromEntries(Object.entries(d.receipts).map(([k, [pending, r]]: Json) => [label(k), [pending, recipName(r)]]));
  return result;
}

// If the driver goes away while a statement is stuck, exit so PostgreSQL releases its locks.
process.stdin.on('close', () => setTimeout(() => process.exit(1), 3000).unref());
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const req = JSON.parse(line);
  try {
    if (req.op === 'reset') { await reset(req.quota ?? null); out({ ok: true }); }
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
if (ws) await auto.client.query('DELETE FROM mailboxes WHERE workspace_id=$1', [ws]).catch(() => {});
for (const c of [...Object.values(conns), auto, checker]) await c.client.end();
await instance.close();
process.exit(0);
