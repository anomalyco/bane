// A throwaway hosted Bane for the CLS gate: a fresh Postgres database, the Node API serving the production dashboard
// build (app/dist) and synthetic workspaces. Nothing touches a real deployment, SES or real mail.
// Postgres comes from CLS_PG_URL (an admin connection, as the CI service provides), else a container of the CI image
// when Docker is running, else a temporary initdb cluster. The database and role are created here and removed on stop().
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const freePort = () => new Promise((resolve, reject) => { const s = createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

const PG_IMAGE = 'postgres:17.11-alpine';
const hasDocker = () => { try { execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 }); return true; } catch { return false; } };
// Postgres binaries for a local run without CLS_PG_URL or Docker: PATH first, then pg_config's bindir.
function pgBin(name) {
  try { execFileSync('which', [name], { stdio: 'ignore' }); return name; } catch {}
  try { return join(execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim(), name); } catch {}
  throw new Error(`CLS gate: set CLS_PG_URL to a Postgres admin URL, or install Postgres so ${name} is on PATH.`);
}

export async function start(repo, { log = () => {}, servers = 1 } = {}) {
  const api = join(repo, 'api');
  const require = createRequire(join(api, 'package.json'));
  const pg = require('pg');
  const home = mkdtempSync(join(tmpdir(), 'bane-cls-'));
  const cleanups = [];
  let stopped = false;
  const stop = async () => {
    if (stopped) return; stopped = true;
    for (const fn of cleanups.reverse()) { try { await fn(); } catch {} }
    rmSync(home, { recursive: true, force: true });
  };
  try {
    let adminUrl = process.env.CLS_PG_URL;
    const fast = ['-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off'];
    if (!adminUrl && hasDocker()) {
      // The same image as the CI service.
      const port = await freePort(), password = randomBytes(12).toString('hex');
      const id = execFileSync('docker', ['run', '-d', '--rm', '-e', `POSTGRES_PASSWORD=${password}`, '-p', `127.0.0.1:${port}:5432`, PG_IMAGE, ...fast], { encoding: 'utf8' }).trim();
      cleanups.push(() => execFileSync('docker', ['rm', '-f', id], { stdio: 'ignore' }));
      adminUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`;
      // The image's init server listens on a socket only: the first TCP connection is the real server.
      for (let tries = 0; ; tries++) {
        const probe = new pg.Client({ connectionString: adminUrl });
        try { await probe.connect(); await probe.end(); break; } catch (error) { if (tries > 300) throw error; await new Promise(r => setTimeout(r, 100)); }
      }
      log(`postgres: ${PG_IMAGE} on ${port}`);
    } else if (!adminUrl) {
      const data = join(home, 'pg'), port = await freePort();
      execFileSync(pgBin('initdb'), ['-A', 'trust', '-U', 'postgres', '--no-locale', '-E', 'UTF8', '-D', data], { stdio: 'ignore' });
      execFileSync(pgBin('pg_ctl'), ['-D', data, '-o', `-h 127.0.0.1 -p ${port} -k ${home} ${fast.join(' ')}`, '-l', join(home, 'postgres.log'), '-w', 'start'], { stdio: 'ignore' });
      cleanups.push(() => execFileSync(pgBin('pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' }));
      adminUrl = `postgresql://postgres@127.0.0.1:${port}/postgres`;
      log(`postgres: temporary cluster on ${port}`);
    }
    // A non-superuser owner, as the acceptance fixture runs the API.
    const name = 'cls_' + randomBytes(5).toString('hex'), password = randomBytes(18).toString('hex');
    const admin = new pg.Client({ connectionString: adminUrl }); await admin.connect();
    await admin.query(`CREATE ROLE ${name} LOGIN NOSUPERUSER PASSWORD '${password}'`);
    await admin.query(`CREATE DATABASE ${name} OWNER ${name}`);
    await admin.query(`ALTER ROLE ${name} SET jit = off`);
    cleanups.push(async () => { await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.query(`DROP ROLE IF EXISTS ${name}`); await admin.end(); });
    const url = new URL(adminUrl); url.username = name; url.password = password; url.pathname = '/' + name;

    const secret = randomBytes(36).toString('hex');
    const envFor = port => ({
      PATH: process.env.PATH, HOME: home, DATABASE_URL: url.href, PUBLIC_URL: `http://127.0.0.1:${port}`, API_BASE_URL: `http://127.0.0.1:${port}`, HOST: '127.0.0.1', PORT: String(port),
      MULTI_TENANT: 'true', ACCOUNT_REQUIRED_ACR: 'urn:anomaly:acr:google', BANE_HOSTED_SCREEN: 'false', ENABLE_LIVE_SES: 'false', AWS_EC2_METADATA_DISABLED: 'true',
      ACCOUNT_CLIENT_ID: 'fixture', ACCOUNT_CLIENT_PRIVATE_KEY: 'unused-in-session-fixture', BANE_ROOT_SECRET: secret,
      WEBHOOK_ALLOWED_HOSTS: 'northwind.example', S3_ACCESS_KEY_ID: 'fixture', S3_SECRET_ACCESS_KEY: 'fixture', S3_BUCKET: 'fixture', S3_ENDPOINT: 'http://127.0.0.1:9',
      SIMULATED_SES_LATENCY_MS: '0', SIMULATED_SES_DELIVERY_DELAY_MS: '0',
    });
    execFileSync('node', ['--import', 'tsx', 'src/migrate.ts'], { cwd: api, env: envFor(0), stdio: ['ignore', 'ignore', 'inherit'] });
    log('postgres: migrated');

    // The Node API serves api/public: point it at the build without copying it into the tree.
    const pub = join(api, 'public');
    if (!existsSync(join(repo, 'app/dist/index.html'))) throw new Error('CLS gate: build the dashboard first (bun run build in app/).');
    if (existsSync(pub) || (() => { try { return lstatSync(pub).isSymbolicLink(); } catch { return false; } })()) {
      if (!lstatSync(pub).isSymbolicLink()) throw new Error(`CLS gate: ${pub} exists; remove it so the gate can serve app/dist.`);
      rmSync(pub);
    }
    symlinkSync(join(repo, 'app/dist'), pub, 'dir');
    cleanups.push(() => rmSync(pub, { force: true }));

    // Several API processes on the one database: each keeps its own per-peer admission budget (6000 requests a
    // minute), which parallel cold page loads from 127.0.0.1 would otherwise exhaust.
    let serverLog = '';
    const serve = async () => {
      const port = await freePort(), origin = `http://127.0.0.1:${port}`;
      const server = spawn('node', ['--import', 'tsx', 'src/server.ts'], { cwd: api, env: envFor(port), stdio: ['ignore', 'ignore', 'pipe'] });
      server.stderr.on('data', chunk => { serverLog = (serverLog + chunk).slice(-20_000); });
      const exited = new Promise(resolve => server.once('exit', code => resolve(code)));
      cleanups.push(async () => { server.kill(); await exited; });
      // Ready once the lazily imported auth router rejects an anonymous /v1/me.
      for (let ready = false; !ready;) {
        if (server.exitCode !== null) throw new Error(`CLS gate: the API exited (${server.exitCode}).\n${serverLog}`);
        ready = await fetch(origin + '/v1/me').then(r => r.status === 401, () => false);
        if (!ready) await Promise.race([exited, new Promise(r => setTimeout(r, 100))]);
      }
      return origin;
    };
    const origins = await Promise.all(Array.from({ length: Math.max(1, servers) }, serve));
    const origin = origins[0];
    log(`api: ${origins.join(' ')}`);

    const db = new pg.Client({ connectionString: url.href }); await db.connect();
    cleanups.push(() => db.end());
    const sessions = {};
    // One signed-in member per workspace, inserted as the acceptance suite seeds sessions.
    async function signIn(key, email, fullName, workspace) {
      const token = randomBytes(32).toString('base64url'), userId = 'user_' + key;
      await db.query('INSERT INTO bane_users(id,name,email,email_verified) VALUES($1,$2,$3,true)',[userId,fullName,email]);
      await db.query("INSERT INTO bane_oidc_identities VALUES('https://account.anoma.ly',$1,$1)",[userId]);
      await db.query('INSERT INTO workspaces (id,name,slug) VALUES ($1,$2,$1) ON CONFLICT DO NOTHING', [workspace.id, workspace.name]);
      await db.query('INSERT INTO workspace_members (id,workspace_id,user_id,role) VALUES ($1,$2,$3,$4)', ['wm_' + key, workspace.id, userId, workspace.role ?? 'owner']);
      await db.query("INSERT INTO bane_sessions(token_hash,user_id,issuer,subject,expires_at) VALUES($1,$2,'https://account.anoma.ly',$2,now()+interval '2 hours')",[createHash('sha256').update(token).digest('hex'),userId]);
      const cookie = token;
      const call = async (method, path, body, status) => {
        const r = await fetch(origin + path, { method, headers: { origin, cookie: `bane.session_token=${encodeURIComponent(cookie)}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
        const text = await r.text();
        if (status ? r.status !== status : !r.ok) throw new Error(`CLS seed: ${method} ${path} → ${r.status} ${text.slice(0, 400)}`);
        return text ? JSON.parse(text) : null;
      };
      return (sessions[key] = { cookie, api: call });
    }
    return { origin, origins, db, signIn, sessions, stop, serverLog: () => serverLog };
  } catch (error) { await stop(); throw error; }
}

// ---------------------------------------------------------------- synthetic data
// Northwind: an established hosted sender with sending history, receiving set up and audience content.
// Lumen Labs: a verified domain and nothing else (Overview's setup state). Field Notes: no connection (onboarding).
// Connections, domain claims, mail and inbox rows go in as SQL because there is no SES or mail store here.
const REGION = 'us-east-2';
const ago = minutes => new Date(Date.now() - minutes * 60_000).toISOString();
let counter = 0;
const rid = prefix => `${prefix}_${(++counter).toString(36).padStart(6, '0')}${randomBytes(4).toString('hex')}`;

async function hosted(db, workspaceId) {
  const conn = 'conn_' + workspaceId;
  await db.query("INSERT INTO provider_pool_regions(region,aws_account_id,sending_state,feedback_topic_arn) VALUES($1,'111122223333','ready',$2) ON CONFLICT DO NOTHING", [REGION, `arn:aws:sns:${REGION}:111122223333:bane-feedback`]);
  await db.query("INSERT INTO ses_installation_settings(workspace_id,installation_id,default_region,enabled_regions) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING", [workspaceId, 'install_' + workspaceId, REGION, JSON.stringify([REGION])]);
  await db.query("INSERT INTO provider_connections(id,workspace_id,kind,region,state,aws_account_id,tenant_state) VALUES($1,$2,'shared',$3,'ready','111122223333','ready')", [conn, workspaceId, REGION]);
  await db.query("INSERT INTO provider_connection_regions(connection_id,region,sending_state,tenant_state) VALUES($1,$2,'ready','ready') ON CONFLICT (connection_id,region) DO UPDATE SET sending_state='ready',tenant_state='ready'", [conn, REGION]);
  return conn;
}

// A domain claim as the hosted DNS checks leave it; `receiving` turns on an active receiving host.
async function domain(db, workspaceId, conn, name, { receiving = false, mailFrom = false, dmarc = 'quarantine' } = {}) {
  const id = 'dom_' + name.replace(/\W/g, '_');
  const tokens = [0, 1, 2].map(i => `${name.replace(/\W/g, '').slice(0, 10)}${i}k7q2m9dkim`);
  const identity = { ses: { DkimAttributes: { Status: 'SUCCESS', SigningEnabled: true, SigningAttributesOrigin: 'AWS_SES', SigningHostedZone: 'dkim.amazonses.com', Tokens: tokens }, ...(mailFrom ? { MailFromAttributes: { MailFromDomain: 'bounce.' + name, MailFromDomainStatus: 'SUCCESS' } } : {}) }, proven: true, mx: null, note: null,
    dmarc: { status: dmarc, record: `v=DMARC1; p=${dmarc}`, source: name, adkim: 'r', aspf: 'r', checkedAt: Date.now(), recommend: false, alignedMailFrom: null } };
  await db.query("INSERT INTO domain_claims(workspace_id,name,connection_id,sending_state,receiving_state,receiving_host,identity,ever_proven) VALUES($1,$2,$3,'verified',$4,$5,$6::jsonb,true)",
    [workspaceId, name, conn, receiving ? 'active' : 'off', receiving ? name : null, JSON.stringify(identity)]);
  await db.query('INSERT INTO operation_domains(id,workspace_id,name,region) VALUES($1,$2,$3,$4)', [id, workspaceId, name, REGION]);
  if (!receiving) return { id };
  await db.query('UPDATE domain_claims SET receiving_proved_at=now(),receiving_identity_at=now() WHERE workspace_id=$1 AND name=$2', [workspaceId, name]);
  const mdom = 'mdom_' + name.replace(/\W/g, '_');
  const mx = { state: 'active', message: `MX for ${name} points to Amazon SES.`, providers: ['amazonses.com'], checkedAt: ago(12) };
  await db.query("INSERT INTO mailbox_domains(id,workspace_id,domain_id,name,region,receiving_host,status,catch_all,enabled_at,mx,checked_at) VALUES($1,$2,$3,$4,$5,$4,'active','store',now()-interval '20 days',$6::jsonb,now()-interval '12 minutes')",
    [mdom, workspaceId, id, name, REGION, JSON.stringify(mx)]);
  return { id, mdom, host: name };
}

// Hourly sending volume with a weekday rhythm from a fixed seed; bounces ~0.9%, complaints ~0.03%. Returns the newest.
async function mail(db, workspaceId, days) {
  const now = Date.now(), rows = [];
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let h = days * 24; h >= 1; h--) {
    const at = new Date(now - h * 3600_000 - Math.floor(rnd() * 3000_000));
    const hour = at.getUTCHours(), dow = at.getUTCDay();
    const base = (dow === 0 || dow === 6 ? 9 : 22) * (0.35 + Math.sin(Math.PI * Math.max(0, Math.min(1, (hour - 6) / 16))));
    const n = Math.max(0, Math.round(base * (0.7 + rnd() * 0.6)));
    for (let i = 0; i < n; i++) {
      const r = rnd(), kind = rnd() < 0.78 ? 'transactional' : 'marketing';
      rows.push([rid('email'), new Date(at.getTime() - i * 13_000).toISOString(), r < 0.009 ? 'bounced' : r < 0.0093 ? 'complained' : 'delivered', kind]);
    }
  }
  for (let i = 0; i < rows.length; i += 500) {
    const params = [], values = [];
    rows.slice(i, i + 500).forEach(([id, at, status, kind], j) => {
      params.push(id, at, status, JSON.stringify({ kind, region: REGION, subject: 'Your receipt', html: '<p>Thanks for your order.</p>', text: 'Thanks for your order.', attachments: [] }), status === 'delivered' ? 3 : status === 'bounced' ? 5 : 11);
      const b = j * 5;
      values.push(`($${b + 1},'${workspaceId}','${REGION}','fixture','receipts@mail.northwind.example','["customer@example.net"]','[]','[]','Your receipt',$${b + 4}::jsonb,false,$${b + 3},'provider-'||$${b + 1},$${b + 5},$${b + 2}::timestamptz)`);
    });
    await db.query(`INSERT INTO sending_emails (id, workspace_id, region, actor_key_id, from_address, to_addresses, cc_addresses, bcc_addresses, subject, snapshot, simulated, status, provider_id, event_outcomes, created_at) VALUES ${values.join(',')}`, params);
  }
  return rows.reduce((newest, row) => row[1] > newest[1] ? row : newest)[0];
}

// One received message per thread, with the summary rows address stats and thread lists read.
async function threads(db, workspaceId, box, list) {
  for (const { id = rid('msg'), subject, snippet, unread, minutes, from = ['Customer', 'customer@example.net'], files = 0 } of list) {
    const thread = rid('thr'), at = ago(minutes);
    await db.query('INSERT INTO mail_threads(id,workspace_id,subject,message_count,last_message_at) VALUES($1,$2,$3,1,$4)', [thread, workspaceId, subject, at]);
    await db.query(`INSERT INTO mail_messages(id,workspace_id,direction,thread_id,region,subject,from_address,from_name,"to",envelope_to,received_at,text,snippet,attachment_count,verdicts) VALUES($1,$2,'inbound',$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$11,$12,'{"virus":"PASS","spam":"PASS"}')`,
      [id, workspaceId, thread, REGION, subject, from[1], from[0], JSON.stringify([{ name: null, address: box.address }]), JSON.stringify([box.address]), at, snippet, files]);
    // inbox_seq as delivery assigns it: agent inboxes list by it.
    await db.query("INSERT INTO mailbox_messages(mailbox_id,message_id,workspace_id,thread_id,direction,read,received_at,inbox_seq) VALUES($1,$2,$3,$4,'inbound',$5,$6,nextval(pg_get_serial_sequence('mailbox_events','seq')))", [box.id, id, workspaceId, thread, !unread, at]);
    await db.query('INSERT INTO mailbox_threads(mailbox_id,thread_id,workspace_id,subject,snippet,participants,message_count,unread_count,last_message_at,last_inbound_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,1,$7,$8,$8)',
      [box.id, thread, workspaceId, subject, snippet, JSON.stringify([{ name: from[0], address: from[1] }]), unread ? 1 : 0, at]);
  }
}
const people = ['Ana Ruiz', 'Ben Cho', 'Cleo Park', 'Dev Shah', 'Eli Moss', 'Fay Lin', 'Gus Ito', 'Hana Ode'];
const subjects = [['Refund for order 4821', 'Hi, the blender arrived broken. I would like a refund.'], ['Can’t sign in', 'I reset my password twice and still get an error.'], ['Invoice INV-2209', 'Attached is the invoice for October.'],
  ['Partnership idea', 'We run a 40k-member community and would love to talk.'], ['Question about the API', 'Is there a limit on attachments per message?'], ['Re: Shipping delay', 'Thanks, that works for us.']];
const mix = (n, offset = 0) => Array.from({ length: n }, (_, i) => {
  const [subject, snippet] = subjects[(i + offset) % subjects.length], p = people[(i * 3 + offset) % people.length];
  return { subject, snippet, unread: i < Math.ceil(n / 3), minutes: 20 + i * 97 + offset * 13, from: [p, p.toLowerCase().replace(' ', '.') + '@example.net'] };
});

// Agent inboxes need the mail store on hosted, so they go in as the rows createInbox writes.
async function agentInbox(db, workspaceId, { mdom, host }, name, hoursLeft, messages) {
  const id = rid('mbx'), address = `${name.toLowerCase().replace(/\W+/g, '-')}@${host}`;
  await db.query(`INSERT INTO mailboxes(id,workspace_id,domain_id,address,display_name,kind,retention_mode,expires_at,delete_after,quota_messages,quota_bytes,created_at)
    VALUES($1,$2,$3,$4,$5,'inbox','ephemeral',now()+make_interval(hours=>$6),now()+make_interval(hours=>$6+24),200,26214400,now()-interval '2 hours')`, [id, workspaceId, mdom, address, name, hoursLeft]);
  await db.query("INSERT INTO mailbox_addresses(workspace_id,address,mailbox_id,kind) VALUES($1,$2,$3,'primary')", [workspaceId, address, id]);
  await db.query('INSERT INTO inbox_state(inbox_id,workspace_id,messages) VALUES($1,$2,$3)', [id, workspaceId, messages.length]);
  await threads(db, workspaceId, { id, address }, messages);
  return id;
}

export async function seed(fx) {
  const { db } = fx;
  const dana = await fx.signIn('dana', 'dana@northwind.example', 'Dana Rivera', { id: 'ws_northwind', name: 'Northwind' });
  const conn = await hosted(db, 'ws_northwind');
  const nw = await domain(db, 'ws_northwind', conn, 'northwind.example', { receiving: true });
  const sendingDomain = await domain(db, 'ws_northwind', conn, 'mail.northwind.example', { mailFrom: true, dmarc: 'none' });
  await db.query("INSERT INTO bane_users (id,name,email,email_verified) VALUES ('user_sam','Sam Okafor','sam@northwind.example',true),('user_lee','Lee Park','lee@northwind.example',true)");
  await db.query("INSERT INTO workspace_members (id,workspace_id,user_id,role) VALUES ('wm_sam','ws_northwind','user_sam','admin'),('wm_lee','ws_northwind','user_lee','member')");
  await dana.api('POST', '/v1/api-keys', { name: 'Production', permissions: ['send'], domains: ['mail.northwind.example'] }, 201);
  await dana.api('POST', '/v1/api-keys', { name: 'Billing worker', permissions: ['send'], domains: [] }, 201);
  const hook = await dana.api('POST', '/v1/webhooks', { description: 'Delivery events', url: 'https://hooks.northwind.example/bane', eventTypes: ['email.delivered', 'email.bounced', 'email.complained'] }, 201);
  await dana.api('POST', '/v1/workspaces/current/invitations', { email: 'ops@northwind.example', role: 'member' }, 201);
  const email = await mail(db, 'ws_northwind', 30);
  // The signed-out homepage's figures, as the minute job publishes them.
  const hourly = Array.from({ length: 24 }, (_, i) => 1200 + (i * 7919) % 900);
  await db.query('INSERT INTO public_stats (singleton, stats, generated_at) VALUES (true, $1::jsonb, now())', [JSON.stringify({
    generatedAt: new Date(Math.floor(Date.now() / 3600_000) * 3600_000).toISOString(), available: true, acceptedLast30Days: 1_200_000, acceptedLastHour: hourly[23],
    acceptedHourly: hourly, deliveryRate: 0.991, medianSendLatencyMs: 140, regions: [REGION] })]);

  // Receiving: addresses with aliases, routes, endpoints, rituals, webhooks, agent inboxes and threads.
  const make = input => dana.api('POST', '/v1/inbound/addresses', input, 201);
  const A = {
    support: await make({ address: 'support@northwind.example', key: 'support', displayName: 'Support', aliases: ['help@northwind.example', 'hello@northwind.example'], rules: ['reply+*@northwind.example'] }),
    billing: await make({ address: 'billing@northwind.example', key: 'billing', displayName: 'Billing', aliases: ['invoices@northwind.example'] }),
    sales: await make({ address: 'sales@northwind.example', key: 'sales', displayName: 'Sales' }),
    security: await make({ address: 'security@northwind.example', key: 'security', displayName: 'Security' }),
    dana: await make({ address: 'dana@northwind.example', displayName: 'Dana Rivera' }),
  };
  const crm = await dana.api('POST', '/v1/inbound/webhooks', { description: 'CRM intake', url: 'https://hooks.northwind.example/crm', eventTypes: [], addressIds: null, format: 'bane' }, 201);
  await dana.api('POST', '/v1/inbound/webhooks', { description: 'Helpdesk', url: 'https://helpdesk.northwind.example/inbound', eventTypes: ['message.received'], addressIds: [A.support.id], format: 'bane' }, 201);
  const crmId = crm.webhook?.id ?? crm.id;
  await dana.api('POST', '/v1/routing/routes', { match: 'refunds@northwind.example', to: [A.billing.id, crmId] }, 201);
  await dana.api('POST', '/v1/routing/routes', { match: 'noreply@northwind.example', to: 'drop' }, 201);
  await dana.api('POST', '/v1/endpoints', { type: 'slack', name: 'support', url: 'https://hooks.slack.com/services/T0SYNTH/B0SYNTH/northwindfixture0a1' }, 201);
  await dana.api('POST', '/v1/endpoints', { type: 'webhook', name: 'crm', url: 'https://hooks.northwind.example/crm-ritual' }, 201);
  await dana.api('POST', '/v1/endpoints', { type: 'forward', name: 'founders', address: 'founders@mail.northwind.example', preverify: true }, 201);
  await dana.api('PUT', '/v1/rituals', {
    rituals: [
      { key: 'triage', source: 'export default function route(email, ctx) {\n  if (email.headers.has("list-unsubscribe")) return junk("newsletter")\n  label("support")\n  endpoints.support({ text: `${email.from.address}: ${email.subject}` })\n}\n' },
      { key: 'invoices', source: 'export default function route(email, ctx) {\n  if (email.attachments.length > 0) {\n    label("invoice")\n    endpoints.crm({ subject: email.subject, from: email.from.address })\n  }\n}\n' },
    ],
    attachments: [{ ritual: 'triage', target: A.support.id, continue: false }, { ritual: 'invoices', target: A.billing.id, continue: false }],
    senderLists: { vip: ['ceo@example.net'] }, evaluateDomains: ['northwind.example'], evaluateRoutes: [],
  }, 200);
  await threads(db, 'ws_northwind', A.support, [{ id: 'msg_northwind_invoice', subject: 'Invoice for October', snippet: 'Please find the October invoice attached.', unread: true, minutes: 9, from: ['Margaret Ode', 'margaret@example.com'], files: 1 }, ...mix(6, 0)]);
  await threads(db, 'ws_northwind', A.billing, mix(4, 2));
  await threads(db, 'ws_northwind', A.sales, mix(3, 3));
  await threads(db, 'ws_northwind', A.dana, mix(2, 4));
  const inbox = await agentInbox(db, 'ws_northwind', nw, 'Sign-up e2e', 20, mix(3, 1));
  await agentInbox(db, 'ws_northwind', nw, 'Password reset e2e', 3, []);

  // Audience and campaigns.
  const list = await dana.api('POST', '/v1/lists', { name: 'Customers' });
  const contacts = [];
  for (const who of ['ada', 'grace', 'linus', 'margaret', 'ken']) contacts.push(await dana.api('POST', '/v1/contacts', { email: `${who}@example.net`, name: who[0].toUpperCase() + who.slice(1), properties: { plan: who.length > 4 ? 'pro' : 'free' } }));
  await dana.api('POST', `/v1/lists/${list.id}/members`, { contactIds: contacts.map(c => c.id) });
  const segment = await dana.api('POST', '/v1/segments', { name: 'Pro plan', rule: { field: 'plan', operator: 'eq', value: 'pro' } });
  const template = await dana.api('POST', '/v1/templates', { name: 'Receipt' });
  const campaign = await dana.api('POST', '/v1/campaigns', { name: 'November product update', subject: 'What shipped in November', from: 'news@mail.northwind.example', html: '<p>Hello</p>' });
  const contact = contacts[0];

  // Lumen Labs: verified domain, no key, no mail. Field Notes: no sending connection yet.
  const nia = await fx.signIn('nia', 'nia@lumenlabs.example', 'Nia Moreau', { id: 'ws_fresh', name: 'Lumen Labs' });
  await domain(db, 'ws_fresh', await hosted(db, 'ws_fresh'), 'lumenlabs.example');
  await fx.signIn('ona', 'ona@fieldnotes.example', 'Ona Field', { id: 'ws_new', name: 'Field Notes' });
  void nia;
  // An MCP client dana connected as a labelled profile, waiting for its workspace (its page is /settings/mcp/<id>).
  const mcp = 'mcp_at_cls_fixture';
  await db.query("INSERT INTO bane_resource_grants(id,issuer,subject,user_id,client_id,workspace_id,permissions,expires_at,issued_at,profile) VALUES($1,'https://account.anoma.ly','user_dana','user_dana','opencode',NULL,'{read,send}',now()+interval '1 day',0,'work')", [mcp]);
  return {
    mcp, email, receivedEmail: 'msg_northwind_invoice', domain: nw.id, sendingDomain: sendingDomain.id, address: A.support.id, inbox, inboundWebhook: crmId,
    webhook: hook.webhook?.id ?? hook.id, list: list.id, contact: contact.id, campaign: campaign.id, template: template.id ?? template.template?.id, segment: segment.id,
  };
}
