// tear host for Bane access control and idempotency: drives the real API in-process over an isolated,
// migrated, loopback PostgreSQL. The Rust runner (src/main.rs) owns the reference model and speaks
// JSON Lines to this process: {"v":1,"id":n,"op":"open"|"act"|"close","action":"..."}; each reply is
// {"v":1,"id":n,"ok":true,"value":...} or {"v":1,"id":n,"ok":false,"error":"..."}. One host serves
// many fixtures: open makes a fresh workspace with an owner and a member, close forgets it.
//
// Determinism and faults are this host's job:
// - The Worker clock (Date) is frozen and moves only on tick actions. Each idempotency claim is
//   stamped with that clock, so DB and Worker time agree to the millisecond (no skew).
// - Two request slots (A, B) run concurrently. In a slot, the pg pool parks the request at
//   checkpoints (auth = its first statement, claim, lookup, handler = first statement after a
//   claim, record, release) until the runner steps it. Checkpoints are only taken on autocommit
//   statements or a transaction's BEGIN, so a parked slot never holds a row lock.
// - crash parks a slot forever and destroys its checked-out connection (the server rolls back).
// - lost: after a slot's handler checkpoint, its first COMMIT (or autocommit write) executes on the
//   server and then fails in the client with ECONNRESET: a lost result after commit. (The three
//   creates checked here write in that statement or transaction.)
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { PoolClient } from 'pg';

// ---------- frozen clock (before any app module loads) ----------
const RealDate: DateConstructor = Date;
let clock = Math.floor(RealDate.now() / 1000) * 1000;
const at = (ms: number) => new RealDate(ms);
class FrozenDate extends (RealDate as new (...args: unknown[]) => Date) {
  constructor(...args: unknown[]) { if (args.length === 0) super(clock); else super(...args); }
  static now() { return clock; }
}
globalThis.Date = FrozenDate as DateConstructor;

// The protocol owns stdout; the app's JSON logs go to stderr (or nowhere).
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) console[level] = process.env.TEAR_HOST_LOG === '1' ? (...a: unknown[]) => process.stderr.write(a.map(String).join(' ') + '\n') : () => {};
const url = process.env.DATABASE_URL;
if (!url || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('tear host: DATABASE_URL must point at an isolated loopback database.');
// Loopback is not proof of a disposable database: an SSH tunnel or a proxy to a real one also
// listens there. The database must carry this exact COMMENT ON DATABASE, which whoever creates the
// disposable database sets (tear never sets it), and hold no workspace or user tear did not create.
// Both are checked at startup and before every fixture.
const DISPOSABLE = 'bane-tear: disposable test database, every row may be changed or deleted';
const PUBLIC = 'http://127.0.0.1:8799';
const fixtureIssuer='https://tear-issuer.invalid';
const signer=generateKeyPairSync('ec',{namedCurve:'P-256'});
const originalFetch=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
  const u=new URL(input instanceof Request?input.url:String(input));
  if(u.origin!==fixtureIssuer) return originalFetch(input,init);
  if(u.pathname==='/.well-known/openid-configuration') return Response.json({issuer:fixtureIssuer,jwks_uri:fixtureIssuer+'/keys'});
  if(u.pathname==='/keys') return Response.json({keys:[{...signer.publicKey.export({format:'jwk'}),alg:'ES256',kid:'tear'}]});
  return new Response(null,{status:404});
};
const env: Record<string, string> = {
  DATABASE_URL: url, BANE_ROOT_SECRET: process.env.BANE_ROOT_SECRET ?? 'bane-tear: fixed secret for disposable test databases only', PUBLIC_URL: PUBLIC, API_BASE_URL: PUBLIC,
  MULTI_TENANT: 'true', ACCOUNT_REQUIRED_ACR: 'urn:anomaly:acr:google', ACCOUNT_ISSUER:fixtureIssuer, ACCOUNT_CLIENT_ID:'tear', ACCOUNT_CLIENT_PRIVATE_KEY:'unused-by-session-fixture', AUTH_ALLOWED_EMAILS: '',
  ENABLE_LIVE_SES: 'false', AWS_EC2_METADATA_DISABLED: 'true', S3_BUCKET: 'tear-fixture', S3_ACCESS_KEY_ID: 'tear', S3_SECRET_ACCESS_KEY: 'tear', S3_ENDPOINT: 'http://127.0.0.1:9',
  API_RATE_LIMIT_PER_MINUTE: '100000', DEFAULT_SES_REGION: 'us-east-1', SIMULATED_SES_LATENCY_MS: '0', SIMULATED_SES_DELIVERY_DELAY_MS: '0',
};

const pg = (await import('pg')).default;
const { drizzle } = await import('drizzle-orm/node-postgres');
const { createApp, createOpenApiApp } = await import('../src/app.js');
const { loadConfig } = await import('../src/config.js');
const { s3Storage } = await import('../src/adapters/storage.js');
const { resourceInventory } = await import('../src/mcp-resources.js');
const { buildMcpCatalog } = await import('../src/mcp-catalog.js');
const { dispatchAsActor } = await import('../src/auth.js');
const { getMcpGrantActor } = await import('../src/mcp-auth.js');

// ---------- gated pool ----------
type Label = 'auth' | 'claim' | 'lookup' | 'handler' | 'record' | 'release';
type Event = { at: Label } | { done: true };
type Slot = {
  name: string; gating: boolean; fault: 'lost' | null; crashed: boolean; first: boolean; claimed: boolean; handler: boolean; lostArmed: boolean;
  pending: (() => void) | null; at: Label | null; next: ((e: Event) => void) | null; clients: Set<PoolClient>; result: Promise<Obs> | null; obs: Obs | null;
};
type Obs = Record<string, unknown>;
const als = new AsyncLocalStorage<Slot>();
const hang = () => new Promise<never>(() => {});
const textOf = (q: unknown) => typeof q === 'string' ? q : (q as { text?: string })?.text ?? '';
function classify(text: string): Label | null {
  const t = text.trimStart().toLowerCase();
  if (t.startsWith('insert into "sending_idempotency"')) return 'claim';
  if (t.startsWith('select') && t.includes('from "sending_idempotency"')) return 'lookup';
  if (t.startsWith('update "sending_idempotency"')) return 'record';
  if (t.startsWith('delete from "sending_idempotency"')) return 'release';
  return null;
}
const traceSql = process.env.TEAR_HOST_SQL === '1';
async function checkpoint(slot: Slot, label: Label) {
  if (slot.crashed) return hang();
  if (!slot.gating) return;
  await new Promise<void>(resolve => { slot.pending = resolve; slot.at = label; const n = slot.next; slot.next = null; n?.({ at: label }); });
  if (slot.crashed) return hang();
}
// Decide this statement's checkpoint (if any) from the slot's progress.
function labelFor(slot: Slot, text: string, begin: boolean): Label | null {
  const kind = classify(text);
  if (!slot.first) { slot.first = true; return 'auth'; }
  if (kind === 'claim') { slot.claimed = true; return 'claim'; }
  if (kind) return kind;
  if (slot.claimed && !slot.handler) { slot.handler = true; if (slot.fault === 'lost') slot.lostArmed = true; return 'handler'; }
  return begin ? null : null;
}
const lostError = () => Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' });
class GatedPool extends pg.Pool {
  // Autocommit statements.
  override query(...args: any[]): any {
    const slot = als.getStore();
    if (!slot || typeof args.at(-1) === 'function') return (super.query as any)(...args);
    const text = textOf(args[0]);
    return (async () => {
      if (slot.crashed) return hang();
      const label = labelFor(slot, text, false);
      if (traceSql) process.stderr.write(`[${slot.name}] ${label ?? '-'} ${text.slice(0, 120).replace(/\s+/g, ' ')}\n`);
      if (label) await checkpoint(slot, label);
      const result = await (super.query as any)(...args);
      if (label === 'claim' && result.rowCount) await stampClaim(args);
      // The handler's own autocommit statement ran; its acknowledgement is lost.
      if (slot.lostArmed && label === 'handler') { slot.lostArmed = false; throw lostError(); }
      return result;
    })();
  }
  override connect(...args: any[]): any {
    if (typeof args[0] === 'function') return (super.connect as any)(...args);
    const slot = als.getStore();
    return (super.connect() as Promise<PoolClient>).then(client => {
      const c = client as PoolClient & { __tear?: true };
      if (!c.__tear) {
        c.__tear = true;
        const query = c.query.bind(c), release = c.release.bind(c);
        (c as any).query = (...q: any[]) => {
          const s = als.getStore();
          if (!s || typeof q.at(-1) === 'function') return (query as any)(...q);
          const text = textOf(q[0]);
          return (async () => {
            if (s.crashed) return hang();
            if (traceSql) process.stderr.write(`[${s.name}] tx ${text.slice(0, 120).replace(/\s+/g, ' ')}\n`);
            if (/^\s*begin\b/i.test(text)) { const label = labelFor(s, text, true); if (label) await checkpoint(s, label); }
            const result = await (query as any)(...q);
            if (s.lostArmed && /^\s*commit\b/i.test(text)) { s.lostArmed = false; throw lostError(); }
            return result;
          })();
        };
        (c as any).release = (err?: unknown) => { als.getStore()?.clients.delete(c); return release(err as Error); };
      }
      slot?.clients.add(c);
      return c;
    });
  }
}
const pool = new GatedPool({ connectionString: url, max: 20, idleTimeoutMillis: 30000 });
pool.on('error', () => {});
const admin = new pg.Pool({ connectionString: url, max: 4 });
async function assertDisposable() {
  const { rows: [r] } = await admin.query(`SELECT shobj_description(d.oid, 'pg_database') AS marker, current_database() AS name,
    (SELECT count(*)::int FROM workspaces WHERE id <> 'default' AND id NOT LIKE 'tear\\_%') AS workspaces,
    (SELECT count(*)::int FROM bane_users WHERE id NOT LIKE 'tear-user-%') AS users
    FROM pg_database d WHERE d.datname = current_database()`);
  if (r?.marker !== DISPOSABLE) throw new Error(`tear host: refusing database ${r?.name ?? '(unknown)'}: it is not marked disposable. Create a dedicated, migrated database and mark it with COMMENT ON DATABASE ... IS '${DISPOSABLE}' (see tear/README.md).`);
  if (r.workspaces || r.users) throw new Error(`tear host: refusing database ${r.name}: it holds ${r.workspaces} workspaces and ${r.users} users that tear did not create.`);
}
await assertDisposable();
// The claim was stamped by the DB clock; restamp it with the Worker clock so both agree exactly.
async function stampClaim(args: any[]) {
  const values = (args[0]?.values ?? args[1]) as unknown[] | undefined;
  if (!values || values.length < 4) return;
  const [workspace, actor, path, key] = values;
  await admin.query('UPDATE sending_idempotency SET created_at=to_timestamp($5::float8/1000) WHERE workspace_id=$1 AND actor_key_id=$2 AND path=$3 AND request_key=$4 AND result IS NULL', [workspace, actor, path, key, clock]);
}
const config = loadConfig(env);
// Hosted (multi-tenant) inboxes need an R2 mail bucket; an in-memory one is enough for these flows.
const objects = new Map<string, Uint8Array>();
const bucket = {
  async put(key: string, value: ArrayBuffer | Uint8Array | string) { objects.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value as ArrayBuffer)); return { key }; },
  async get(key: string) { const v = objects.get(key); return v ? { body: new Blob([new Uint8Array(v)]).stream(), size: v.byteLength, async arrayBuffer() { return new Uint8Array(v).buffer; } } : null; },
  async head(key: string) { const v = objects.get(key); return v ? { key, size: v.byteLength } : null; },
  async delete(keys: string | string[]) { for (const k of [keys].flat()) objects.delete(k); },
  async list() { return { objects: [...objects.keys()].map(key => ({ key })), truncated: false }; },
};
const runtime: any = { db: drizzle(pool), storage: s3Storage(env), config, mailR2: { bucket, name: 'tear-mail', write: true }, webhookFetch: async () => { throw new Error('tear: no network'); } };
const app = createApp();
const INVENTORY = new Map(resourceInventory().map(x => [`${x.name}.${x.action}`, x.operation]));
// Every GET in the catalog, with dummy path parameters that pass validation, for the REST audit.
const GETS = [...buildMcpCatalog(await createOpenApiApp()).entries()].filter(([, op]) => op.method === 'get').map(([name, op]) => {
  const params = (op.tool.inputSchema.properties ?? {}) as Record<string, { enum?: string[]; format?: string; type?: string | string[]; pattern?: string }>;
  const value = (field: string) => { const p = params[field] ?? {}; return p.enum?.[0] ?? (p.format === 'email' ? 'tear@example.com' : [p.type].flat().includes('integer') ? '1' : p.pattern?.includes('-\\d') ? 'us-east-1' : 'tear-missing'); };
  const aliases: Record<string, string> = { connectionId: 'id', tokenId: 'id', keyId: 'id', contactId: 'id', listId: 'id', segmentId: 'id', importId: 'id', templateId: 'id', assetId: 'id', emailId: 'id', attachmentId: 'id', campaignId: 'id', domainId: 'id', webhookId: 'id', routeId: 'id', inboxId: 'id', version: 'v' };
  const path = op.path.replace(/\{([^}]+)\}/g, (_, field: string) => { const mcp = Object.entries(aliases).find(([m, api]) => api === field && params[m])?.[0] ?? field; return encodeURIComponent(value(mcp)); });
  return { name, path: op.path === '/v1/inboxes/{id}/changes' ? `${path}?since=0` : path };
});

// ---------- fixture ----------
type Fixture = {
  w: string; owner: User; member: User; creds: Map<string, Cred>; slots: Record<string, Slot>; firstIds: Map<string, string>; box?: string;
  grants: Map<string, Grant>; start: number;
};
type User = { id: string; cookie: string; memberId: string };
type Cred = { id: string; secret: string };
type Grant = { access: string; refresh: string; clientId: string; consentId: string; keyId: string };
let fx: Fixture | null = null;

async function seedUser(w: string, role: 'owner' | 'member'): Promise<User> {
  const id = `tear-user-${randomUUID()}`, token = randomBytes(32).toString('base64url'), memberId = randomUUID();
  const email = `${id}@example.com`;
  await admin.query(`INSERT INTO bane_users (id,name,email,email_verified) VALUES ($1,'tear',$2,true)`, [id, email]);
  await admin.query(`INSERT INTO bane_oidc_identities VALUES ($1,$2,$2)`, [fixtureIssuer,id]);
  await admin.query(`INSERT INTO bane_sessions(token_hash,user_id,issuer,subject,expires_at) VALUES ($1,$2,$3,$2,$4)`, [createHash('sha256').update(token).digest('hex'),id,fixtureIssuer,at(RealDate.now()+86_400_000)]);
  await admin.query(`INSERT INTO workspace_members (id,workspace_id,user_id,role) VALUES ($1,$2,$3,$4)`, [memberId, w, id, role]);
  return { id, memberId, cookie: `bane.session_token=${token}` };
}
async function open() {
  await assertDisposable();
  const w = `tear_${randomBytes(8).toString('hex')}`;
  clock = Math.floor(RealDate.now() / 1000) * 1000;
  await admin.query('INSERT INTO workspaces (id,name,slug) VALUES ($1,$1,$1)', [w]);
  const owner = await seedUser(w, 'owner'), member = await seedUser(w, 'member');
  const slots: Record<string, Slot> = {};
  fx = { w, owner, member, creds: new Map(), slots, firstIds: new Map(), grants: new Map(), start: clock };
}
async function close() {
  if (!fx) return;
  for (const slot of Object.values(fx.slots)) crash(slot);
  await admin.query('DELETE FROM bane_users WHERE id = ANY($1)', [[fx.owner.id, fx.member.id]]);
  fx = null;
}

// Every MCP grant shape the model mints (src/model.rs SHAPES): who approves it and its scopes.
const SHAPES: Record<string, ['owner' | 'member', string]> = {
  grant: ['owner', 'bane:read bane:send bane:manage'], grant2: ['member', 'bane:read bane:send'], grant3: ['owner', 'bane:read'],
  'g-s': ['owner', 'bane:send'], 'g-m': ['owner', 'bane:manage'], 'g-rm': ['owner', 'bane:read bane:manage'], 'g-sm': ['owner', 'bane:send bane:manage'],
  'm-r': ['member', 'bane:read'], 'm-s': ['member', 'bane:send'],
};

// ---------- requests ----------
type Reply = { status: number; body: any; headers: Headers };
function newSlot(name: string, gating: boolean, fault: Slot['fault'] = null): Slot {
  return { name, gating, fault, crashed: false, first: false, claimed: false, handler: false, lostArmed: false, pending: null, at: null, next: null, clients: new Set(), result: null, obs: null };
}
async function send(slot: Slot | null, method: string, path: string, auth: { cookie?: string; bearer?: string }, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const h = new Headers({ ...headers });
  if (auth.cookie) { h.set('cookie', auth.cookie); h.set('origin', PUBLIC); h.set('x-bane-workspace', fx!.w); }
  if (auth.bearer) h.set('authorization', `Bearer ${auth.bearer}`);
  if (body !== undefined && !h.has('content-type')) h.set('content-type', 'application/json');
  const request = new Request(PUBLIC + path, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), redirect: 'manual' });
  // A fresh JWKS cache per request keeps "the first statement" deterministic for MCP slots.
  const run = async () => { const r = await app.fetch(request, slot ? { ...runtime, jwksCacheScope: {} } : runtime); const text = await r.text(); let parsed: any = text; try { parsed = JSON.parse(text); } catch { /* HTML */ } return { status: r.status, body: parsed, headers: r.headers }; };
  return slot ? als.run(slot, run) : run();
}
const owner = () => ({ cookie: fx!.owner.cookie });
async function rpc(bearer: string, method: string, params: object, codemode: boolean, slot: Slot | null = null): Promise<Reply> {
  return send(slot, 'POST', `/mcp?codemode=${codemode}`, { bearer }, { jsonrpc: '2.0', id: 1, method, params }, { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' });
}
// One normalized observation for a tool call: the API status (or null) and error code.
function toolObs(r: Reply) {
  // HTTP-level refusals (OAuth, origin) carry no API error code.
  if (r.status !== 200 || r.body?.error) return { status: r.status === 200 ? 500 : r.status, code: null, mcp: true };
  const res = r.body.result;
  return { status: res?._meta?.status ?? null, code: res?.isError ? res.structuredContent?.error?.code ?? 'MCP_ERROR' : null, body: res?.structuredContent, mcp: true };
}
async function callTool(g: string, name: string, args: object, slot: Slot | null = null) {
  const grant = fx!.grants.get(g)!;
  return toolObs(await rpc(grant.access, 'tools/call', { name, arguments: args }, true, slot));
}

async function mintGrant(name: string, user: User, scope: string) {
  const jti=randomUUID(), clientId='tear-'+randomUUID(), now=Math.floor(clock/1000);
  const claims={iss:fixtureIssuer,sub:user.id,aud:PUBLIC+'/mcp',client_id:clientId,scope,jti,iat:now,exp:now+300};
  const body=[{alg:'ES256',typ:'at+jwt',kid:'tear'},claims].map(p=>Buffer.from(JSON.stringify(p)).toString('base64url')).join('.');
  const access=body+'.'+Buffer.from(sign('sha256',Buffer.from(body),{key:signer.privateKey,dsaEncoding:'ieee-p1363'})).toString('base64url');
  const consentId='at_'+createHash('sha256').update(JSON.stringify([user.id,clientId])).digest('hex');
  const result=await rpc(access,'tools/list',{},true);
  if(result.status!==200)return {status:result.status};
  fx!.grants.set(name,{access,refresh:'',clientId,consentId,keyId:'mcp_'+consentId});
  return { status: 'ok' };
}
async function refreshGrant(name: string) {
  const g = fx!.grants.get(name)!;
  const claims=JSON.parse(Buffer.from(g.access.split('.')[1]!,'base64url').toString());
  const user=[fx!.member,fx!.owner].find(u=>u.id===claims.sub);
  if(!user || !(await admin.query('SELECT FROM bane_resource_grants WHERE id=$1 AND NOT revoked',[g.keyId])).rowCount)return {status:'denied'};
  return mintGrant(name,user,claims.scope);
}
// A v3 agent token, as signed by a release before the HKDF key (v4): still verified during overlap.
async function legacyToken(grant: Grant) {
  const id = `agt_${randomBytes(16).toString('hex')}`, exp = clock + 60_000, permissions = ['read', 'send', 'manage'];
  await admin.query('INSERT INTO agent_tokens (id,workspace_id,grant_id,permissions,domains,purpose,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, fx!.w, grant.keyId, JSON.stringify(permissions), '[]', 'tear legacy', at(exp).toISOString()]);
  const payload = Buffer.from(JSON.stringify({ v: 3, id, grant: grant.keyId, permissions, domains: [], exp, nonce: randomBytes(16).toString('hex') })).toString('base64url');
  const signature = createHmac('sha256', env.BANE_ROOT_SECRET!).update(`opensend-agent-token-v1:${payload}`).digest('base64url');
  return { id, secret: `os_agent_${payload}.${signature}` };
}
async function legacyKey() {
  const secret = `os_live_${randomBytes(32).toString('hex')}`, id = `key_${randomBytes(12).toString('hex')}`;
  await admin.query(`INSERT INTO api_keys (id,workspace_id,name,permissions,domains,hash,prefix) VALUES ($1,$2,'tear legacy',$3,'[]',$4,$5)`, [id, fx!.w, JSON.stringify(['read', 'send', 'manage']), createHash('sha256').update(secret).digest('hex'), secret.slice(0, 14)]);
  return { id, secret };
}

// ---------- observations ----------
const counts = async () => {
  const { rows: [r] } = await admin.query(`SELECT (SELECT count(*)::int FROM audience_lists WHERE workspace_id=$1) AS lists, (SELECT count(*)::int FROM api_keys WHERE workspace_id=$1) AS keys, (SELECT count(*)::int FROM mailboxes WHERE workspace_id=$1 AND kind='inbox') AS inboxes`, [fx!.w]);
  return r as { lists: number; keys: number; inboxes: number };
};
const SECRET = /(?:bane|os)_(?:live_|mbx_|agent_)?[0-9a-f]{20,}|whsec_|Bearer bane/;
function createObs(r: Reply, idem: string, mcp = false) {
  const body = mcp ? r.body : r.body;
  const id = typeof body?.id === 'string' ? body.id : null;
  let same: boolean | null = null;
  if (id && r.status < 300) { const first = fx!.firstIds.get(idem); if (first) same = first === id; else fx!.firstIds.set(idem, id); }
  return { status: r.status, code: r.status >= 400 ? (body?.error?.code ?? null) : null, replayed: mcp ? null : r.headers?.get('idempotent-replayed') === 'true', same, secret: SECRET.test(JSON.stringify(body ?? null)) };
}
const KEYS: Record<string, string> = { k1: 'tear-key-1', k2: 'tear-key-2', kmax: 'k'.repeat(200), klong: 'k'.repeat(201), kbad: 'tear key', kempty: '' };
const BODIES: Record<string, unknown> = { b1: { name: 'tear list one' }, b2: { name: 'tear list two' }, bad: { name: '' } };
function bearer(name: string) {
  const c = fx!.creds.get(name);
  if (!c) throw new Error(`credential ${name} was not minted`);
  return c.secret;
}

// Run one idempotent create, in a slot (for concurrency/faults) or directly.
async function create(slot: Slot | null, what: string, cred: string, key: string, bodyName: string): Promise<Obs> {
  const idem = `${what}|${cred}|${key}`;
  const k = KEYS[key]!, headers = { 'idempotency-key': k };
  if (what === 'list') {
    const body = BODIES[bodyName];
    if (cred === 'grant') {
      const r = await callToolObs(slot, 'grant', 'createContactList', { confirm: true, idempotencyKey: k, body });
      return { ...r, ...(await countsFor('lists')) };
    }
    const r = await send(slot, 'POST', '/v1/lists', { bearer: bearer(cred) }, body, headers);
    return { ...createObs(r, idem), ...(await countsFor('lists')) };
  }
  if (what === 'apikey') {
    const body = { name: 'tear derived', permissions: ['read'] };
    if (cred === 'grant') return { ...(await callToolObs(slot, 'grant', 'createApiKey', { confirm: true, idempotencyKey: k, body })), ...(await countsFor('keys')) };
    const r = await send(slot, 'POST', '/v1/api-keys', { bearer: bearer(cred) }, body, headers);
    return { ...createObs(r, idem), ...(await countsFor('keys')) };
  }
  if (what === 'inbox') {
    const r = await send(slot, 'POST', '/v1/inboxes', { bearer: bearer(cred) }, { type: 'sandbox', name: 'tear' }, headers);
    return { ...createObs(r, idem), ...(await countsFor('inboxes')) };
  }
  throw new Error(`unknown create ${what}`);
  async function callToolObs(s: Slot | null, g: string, name: string, args: object) {
    const o = await callTool(g, name, args, s);
    const r = { status: o.status ?? 0, body: o.body ?? { error: { code: o.code } }, headers: new Headers() } as Reply;
    const base = createObs(r, idem, true);
    return { ...base, status: o.status, code: o.code };
  }
}
async function countsFor(kind: 'lists' | 'keys' | 'inboxes') { const c = await counts(); return { [kind]: c[kind] }; }

// ---------- MCP listings: the sampled operations visible to an actor in each catalog ----------
async function listing(bearerToken: string, codemode: boolean) {
  const r = await rpc(bearerToken, 'tools/list', {}, codemode);
  if (r.status !== 200 || !Array.isArray(r.body?.result?.tools)) return { status: r.status };
  const tools = r.body.result.tools as { name: string; inputSchema?: { properties?: { action?: { enum?: string[] } } } }[];
  const ops = new Set<string>();
  for (const t of tools) {
    if (codemode) ops.add(t.name);
    else for (const action of t.inputSchema?.properties?.action?.enum ?? []) { const op = INVENTORY.get(`${t.name}.${action}`); if (op) ops.add(op); }
  }
  return { status: 200, visible: Object.fromEntries([...ops].sort().map(op => [op, true])) };
}

// REST's own decision for every GET, as the actor: an MCP grant dispatched with its MCP actor,
// an inbox key over plain REST. 401/403 is a refusal; anything else passed authorization.
async function audit(who: string) {
  const f = fx!;
  let call: (path: string) => Promise<number>;
  if (f.grants.has(who)) {
    const actor = await getMcpGrantActor(runtime, f.grants.get(who)!.keyId);
    if (!actor) return { status: 401 };
    call = async path => (await dispatchAsActor(app, new Request(PUBLIC + path, { headers: { accept: 'application/json' } }), runtime, actor)).status;
  } else {
    const secret = bearer(who);
    if ((await send(null, 'GET', '/v1/inboxes', { bearer: secret })).status === 401) return { status: 401 };
    call = async path => (await send(null, 'GET', path, { bearer: secret })).status;
  }
  const rest: Record<string, boolean> = {};
  for (const { name, path } of GETS) { const status = await call(path); rest[name] = status !== 401 && status !== 403; }
  return { status: 200, rest };
}

// ---------- actions ----------
async function revokeKey(name: string) {
  const c = fx!.creds.get(name)!;
  return { status: (await send(null, 'POST', `/v1/api-keys/${c.id}/revoke`, owner())).status };
}
async function act(action: string): Promise<Obs> {
  const f = fx!; const w = action.split(' ');
  const [verb, a1, a2, a3, a4] = w;
  switch (verb) {
    case 'mint': switch (a1) {
      case 'key': case 'dkey': {
        const r = await send(null, 'POST', '/v1/api-keys', owner(), { name: `tear ${a1}`, permissions: ['read', 'send', 'manage'], domains: a1 === 'dkey' ? ['allowed.example'] : [] });
        if (r.status === 201) f.creds.set(a1, { id: r.body.id, secret: r.body.secret });
        return { status: r.status };
      }
      case 'legacy': { f.creds.set('legacy', await legacyKey()); return { status: 201 }; }
      case 'grant': case 'grant2': case 'grant3': case 'g-s': case 'g-m': case 'g-rm': case 'g-sm': case 'm-r': case 'm-s': {
        const [by, scopes] = SHAPES[a1]!;
        return mintGrant(a1, by === 'member' ? f.member : f.owner, `${scopes} offline_access`);
      }
      case 'token': {
        const o = await callTool('grant', 'createAgentToken', { confirm: true, body: { permissions: ['read', 'send', 'manage'], expiresInSeconds: 60, purpose: 'tear' } });
        if (o.status === 201) { f.creds.set('token', { id: o.body.id, secret: o.body.token }); }
        return { status: o.status, code: o.code };
      }
      case 'token3': { f.creds.set('token3', await legacyToken(f.grants.get('grant')!)); return { status: 201 }; }
      case 'gkey': {
        const o = await callTool('grant', 'createApiKey', { confirm: true, body: { name: 'tear gkey', permissions: ['read', 'send', 'manage'] } });
        if (o.status === 201) f.creds.set('gkey', { id: o.body.id, secret: o.body.secret });
        return { status: o.status, code: o.code };
      }
      case 'ikey': {
        const r = await send(null, 'POST', '/v1/inbound/keys', { bearer: bearer('key') }, { name: 'tear provisioning', permissions: ['read', 'create'], addressIds: [] });
        if (r.status === 201) f.creds.set('ikey', { id: r.body.id, secret: r.body.secret });
        return { status: r.status, code: r.body?.error?.code ?? null };
      }
      case 'gikey': {
        const o = await callTool('grant', 'createInboundKey', { confirm: true, body: { name: 'tear gikey', permissions: ['read', 'create'], addressIds: [] } });
        if (o.status === 201) f.creds.set('gikey', { id: o.body.id, secret: o.body.secret });
        return { status: o.status, code: o.code };
      }
      case 'box': {
        const r = await send(null, 'POST', '/v1/inboxes', { bearer: bearer('key') }, { type: 'sandbox', name: 'tear box', credential: { name: 'tear bkey', permissions: ['read'] } });
        if (r.status === 201) { f.box = r.body.id; f.creds.set('bkey', { id: r.body.credential.id, secret: r.body.credential.secret }); }
        return { status: r.status, code: r.body?.error?.code ?? null };
      }
    } break;
    case 'revoke': switch (a1) {
      case 'key': case 'dkey': case 'legacy': case 'gkey': return revokeKey(a1);
      case 'token': case 'token3': return { status: (await send(null, 'POST', `/v1/agent-tokens/${f.creds.get(a1)!.id}/revoke`, owner())).status };
      case 'grant': case 'grant2': case 'grant3': case 'g-s': case 'g-m': case 'g-rm': case 'g-sm': case 'm-r': case 'm-s': return { status: (await send(null, 'POST', `/v1/mcp-connections/${f.grants.get(a1)!.keyId}/revoke`, owner())).status };
      case 'ikey': case 'gikey': return { status: (await send(null, 'POST', `/v1/inbound/keys/${f.creds.get(a1)!.id}/revoke`, owner())).status };
    } break;
    case 'delete': return { status: (await send(null, 'DELETE', `/v1/inboxes/${f.box}`, owner())).status };
    case 'receiving': await admin.query('UPDATE bane_resource_grants SET receiving=true WHERE grant_key=$1', [f.grants.get(a1 ?? 'grant')!.consentId]); return {};
    case 'refresh': return refreshGrant(a1!);
    case 'remove': return { status: (await send(null, 'DELETE', `/v1/workspaces/current/members/${f.member.memberId}`, owner())).status };
    case 'promote': return { status: (await send(null, 'PATCH', `/v1/workspaces/current/members/${f.member.memberId}`, owner(), { role: 'admin' })).status };
    case 'probe': {
      const [, who, how] = w;
      if (how === 'audit') return audit(who!);
      if (f.grants.has(who!)) {
        const g = f.grants.get(who)!;
        if (how === 'call') { const o = await callTool(who, 'getCurrentIdentity', {}); return { status: o.status, code: o.code }; }
        // Read-level operations: read-only delegation and an AudienceQL read.
        if (how === 'delegate') { const o = await callTool(who, 'createAgentToken', { confirm: true, body: { permissions: ['read'], expiresInSeconds: 60, purpose: 'tear read delegation' } }); return { status: o.status, code: o.code }; }
        if (how === 'query') { const o = await callTool(who, 'queryAudience', { body: { statement: 'SELECT count(*) FROM contacts' } }); return { status: o.status, code: o.code }; }
        return listing(g.access, how === 'code');
      }
      const secret = bearer(who!);
      if (how === 'mcp') return listing(secret, true);
      if (how === 'lists') { const r = await send(null, 'GET', '/v1/lists', { bearer: secret }); return { status: r.status, code: r.body?.error?.code ?? null }; }
      if (who === 'bkey') { const r = await send(null, 'GET', `/v1/inboxes/${f.box}`, { bearer: secret }); return { status: r.status }; }
      if (who === 'ikey' || who === 'gikey') { const r = await send(null, 'GET', '/v1/inboxes', { bearer: secret }); return { status: r.status }; }
      return { status: (await send(null, 'GET', '/v1/me', { bearer: secret })).status };
    }
    case 'tick': {
      // tick <ms>: set the Worker clock to an exact offset from this fixture's start (the model computes boundaries).
      clock = f.start + Number(a1);
      return {};
    }
    case 'create': return create(null, a1!, a2!, a3!, a4 ?? 'b1');
    case 'lost': return create(newSlot('lost', false, 'lost'), a1!, a2!, a3!, a4 ?? 'b1');
    case 'A': case 'B': {
      const slot = f.slots[verb];
      if (a1 === 'begin') {
        const s = newSlot(verb, true, w[6] === 'lost' ? 'lost' : null);
        f.slots[verb] = s;
        const events = new Promise<Event>(resolve => { s.next = resolve; });
        s.result = create(s, a2!, a3!, a4!, w[5]!).then(o => { s.obs = o; const n = s.next; s.next = null; n?.({ done: true }); return o; });
        return report(s, await within(events));
      }
      if (!slot) throw new Error(`slot ${verb} is idle`);
      if (a1 === 'crash') { crash(slot); delete f.slots[verb]; return { crashed: true }; }
      if (a1 === 'step') {
        if (!slot.pending) throw new Error(`slot ${verb} is not parked`);
        const events = new Promise<Event>(resolve => { slot.next = resolve; });
        const release = slot.pending; slot.pending = null; slot.at = null; release();
        return report(slot, await within(events));
      }
    }
  }
  throw new Error(`unknown action ${action}`);
}
async function within(p: Promise<Event>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Event>((_, reject) => { timer = setTimeout(() => reject(new Error('slot did not reach a checkpoint within 5 s')), 5000); });
  try { return await Promise.race([p, timeout]); } finally { clearTimeout(timer); }
}
function report(slot: Slot, e: Event): Obs {
  if ('at' in e) return { at: e.at };
  delete fx!.slots[slot.name];
  return { at: 'done', ...slot.obs };
}
function crash(slot: Slot) {
  slot.crashed = true;
  for (const c of slot.clients) { try { c.release(new Error('tear: crashed slot')); } catch { /* already gone */ } }
  slot.clients.clear();
  slot.pending?.();
}

// ---------- JSON Lines driver ----------
// A parked or crashed request must never take the host down with it.
process.on('unhandledRejection', error => process.stderr.write(`tear host: unhandled rejection: ${error instanceof Error ? error.stack : String(error)}\n`));
const out = (v: object) => process.stdout.write(JSON.stringify({ v: 1, ...v }) + '\n');
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (!line.trim()) continue;
  const msg = JSON.parse(line) as { id: number; op: string; action?: string };
  try {
    let value: unknown = null;
    if (msg.op === 'open') await open();
    else if (msg.op === 'close') await close();
    else if (msg.op === 'act') value = await act(String(msg.action));
    else if (msg.op === 'exit') { out({ id: msg.id, ok: true, value: null }); break; }
    else throw new Error(`unknown op ${msg.op}`);
    out({ id: msg.id, ok: true, value });
  } catch (error) {
    out({ id: msg.id, ok: false, error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}`.slice(0, 4000) : String(error) });
  }
}
await pool.end(); await admin.end();
process.exit(0);
