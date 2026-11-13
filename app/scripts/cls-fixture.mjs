// A throwaway hosted Bane for the CLS gate: a fresh Postgres database, the Node API serving the production dashboard
// build (app/dist) and synthetic workspaces. Nothing touches a real deployment, SES or real mail.
// Postgres comes from CLS_PG_URL (an admin connection, as the CI service provides), else a container of the CI image
// when Docker is running, else a temporary initdb cluster. The database and role are created here and removed on stop().
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { Agent, createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const freePort = () => new Promise((resolve, reject) => { const s = createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

const PG_IMAGE = 'postgres:17.11-alpine';
const hasDocker = () => { try { execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 }); return true; } catch { return false; } };
// Postgres binaries for a local run without CLS_PG_URL or Docker: PATH first, then pg_config's bindir.
function pgBin(name) {
  try { execFileSync('which', [name], { stdio: 'ignore' }); return name; } catch {}
  try { return join(execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim(), name); } catch {}
  throw new Error(`CLS gate: set CLS_PG_URL to a Postgres admin URL, or install Postgres so ${name} is on PATH.`);
}

export async function start(repo, { log = () => {}, servers = 1, delay = null, fontDelay = 0 } = {}) {
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
      const id = execFileSync('docker', ['run', '-d', '--rm', '--tmpfs', '/var/lib/postgresql/data:rw', '-e', `POSTGRES_PASSWORD=${password}`, '-p', `127.0.0.1:${port}:5432`, PG_IMAGE, ...fast], { encoding: 'utf8' }).trim();
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
    const envFor = (port, publicOrigin = `http://127.0.0.1:${port}`) => ({
      PATH: process.env.PATH, HOME: home, DATABASE_URL: url.href, PUBLIC_URL: publicOrigin, API_BASE_URL: publicOrigin, HOST: '127.0.0.1', PORT: String(port),
      MULTI_TENANT: 'true', ACCOUNT_REQUIRED_ACR: 'urn:anomaly:acr:google', API_RATE_LIMIT_PER_MINUTE: '100000',
      // Dana (an operator) may use staff UI notes; nobody else in the fixture can.
      UI_NOTES_SUBJECTS: 'https://account.anoma.ly user_dana', BANE_HOSTED_SCREEN: 'false', ENABLE_LIVE_SES: 'false', AWS_EC2_METADATA_DISABLED: 'true',
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

    // Shaper servers in front of the API: they apply the gate's per-route API delay, serve web fonts from memory
    // (or after fontDelay for CLS_FONTS=late) and cache immutable /assets/* responses across runs, so the browser needs
    // no CDP Fetch interception (context.route) and one or two API processes stay well inside the 6000/min peer budget.
    const fontDir = join(repo, 'app/dist/fonts');
    const fonts = new Map(readdirSync(fontDir).filter(f => f.endsWith('.woff2')).map(f => [f, readFileSync(join(fontDir, f))]));
    const assetCache = new Map();
    const agent = new Agent({ keepAlive: true, maxSockets: 128 });
    cleanups.push(() => agent.destroy());
    let serverLog = '';
    const serve = async () => {
      const apiPort = await freePort(), proxyPort = await freePort();
      const apiOrigin = `http://127.0.0.1:${apiPort}`, origin = `http://127.0.0.1:${proxyPort}`;
      const server = spawn('node', ['--import', 'tsx', 'src/server.ts'], { cwd: api, env: envFor(apiPort, origin), stdio: ['ignore', 'ignore', 'pipe'] });
      server.stderr.on('data', chunk => { serverLog = (serverLog + chunk).slice(-20_000); });
      const exited = new Promise(resolve => server.once('exit', code => resolve(code)));
      cleanups.push(async () => { server.kill(); await exited; });
      // Ready once the lazily imported auth router rejects an anonymous /v1/me.
      for (let ready = false; !ready;) {
        if (server.exitCode !== null) throw new Error(`CLS gate: the API exited (${server.exitCode}).\n${serverLog}`);
        ready = await fetch(apiOrigin + '/v1/me').then(r => r.status === 401, () => false);
        if (!ready) await Promise.race([exited, new Promise(r => setTimeout(r, 100))]);
      }
      const proxy = createHttpServer(async (req, res) => {
        const rawUrl = req.url || '/', q = rawUrl.indexOf('?'), pathname = q === -1 ? rawUrl : rawUrl.slice(0, q);
        const sleep = ms => new Promise(done => { const t = setTimeout(done, ms); res.once('close', () => { clearTimeout(t); done(); }); });
        if (pathname.startsWith('/fonts/')) {
          if (fontDelay > 0) { await sleep(fontDelay); if (res.destroyed || res.writableEnded) return; }
          else {
            const buf = fonts.get(basename(pathname));
            if (buf) {
              res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'public, max-age=31536000, immutable', 'content-length': String(buf.length) });
              res.end(req.method === 'HEAD' ? undefined : buf);
              return;
            }
          }
        }
        if ((req.method === 'GET' || req.method === 'HEAD') && pathname.startsWith('/assets/')) {
          const accept = String(req.headers['accept-encoding'] ?? '');
          const enc = /\bbr\b/.test(accept) ? 'br' : /\bgzip\b/.test(accept) ? 'gzip' : 'raw';
          const key = `${enc}:${pathname}`;
          let entry = assetCache.get(key);
          if (!entry) {
            entry = new Promise(resolve => {
              const up = httpRequest({ hostname: '127.0.0.1', port: apiPort, method: 'GET', path: rawUrl, headers: enc === 'raw' ? {} : { 'accept-encoding': enc }, agent }, upRes => {
                const chunks = [];
                upRes.on('data', chunk => chunks.push(chunk));
                upRes.on('end', () => {
                  const body = Buffer.concat(chunks);
                  const ok = upRes.statusCode === 200 && String(upRes.headers['cache-control'] ?? '').includes('immutable');
                  if (!ok) { assetCache.delete(key); resolve(null); return; }
                  const headers = { ...upRes.headers, 'content-length': String(body.length) };
                  delete headers.connection; delete headers['keep-alive']; delete headers['transfer-encoding'];
                  resolve({ status: 200, headers, body });
                });
                upRes.on('error', () => { assetCache.delete(key); resolve(null); });
              });
              up.on('error', () => { assetCache.delete(key); resolve(null); });
              up.end();
            });
            assetCache.set(key, entry);
          }
          const cached = await entry;
          if (res.destroyed || res.writableEnded) return;
          if (cached) { res.writeHead(cached.status, cached.headers); res.end(req.method === 'HEAD' ? undefined : cached.body); return; }
        }
        if (pathname.startsWith('/v1/') && delay) { await sleep(delay(rawUrl)); if (res.destroyed || res.writableEnded) return; }
        const up = httpRequest({ hostname: '127.0.0.1', port: apiPort, method: req.method, path: rawUrl, headers: req.headers, agent }, upRes => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          if (req.method === 'HEAD') { upRes.resume(); res.end(); return; }
          upRes.pipe(res);
        });
        up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.destroy(); });
        res.on('close', () => { if (!res.writableEnded) up.destroy(); });
        req.on('error', () => up.destroy());
        req.pipe(up);
      });
      await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(proxyPort, '127.0.0.1', resolve); });
      cleanups.push(async () => { proxy.closeAllConnections(); await new Promise(r => proxy.close(r)); });
      return { origin, apiOrigin };
    };
    const started = await Promise.all(Array.from({ length: Math.max(1, servers) }, serve));
    const origins = started.map(s => s.origin), origin = origins[0], apiOrigin = started[0].apiOrigin;
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
        const r = await fetch(apiOrigin + path, { method, headers: { origin, cookie: `nightmail.session_token=${encodeURIComponent(cookie)}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
        const text = await r.text();
        if (status ? r.status !== status : !r.ok) throw new Error(`CLS seed: ${method} ${path} → ${r.status} ${text.slice(0, 400)}`);
        return text ? JSON.parse(text) : null;
      };
      return (sessions[key] = { cookie, api: call });
    }
    return { origin, origins, apiOrigin, db, signIn, sessions, stop, serverLog: () => serverLog };
  } catch (error) { await stop(); throw error; }
}

// ---------------------------------------------------------------- synthetic data
// Northwind: an established hosted sender with sending history, receiving set up and audience content.
// Lumen Labs: a verified domain and nothing else (Overview's setup state). Field Notes: no connection (onboarding).
// Harbor Supply: restricted, so its pages carry the standing banner.
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

const RECEIPT_TEXT = 'Northwind\n\nThanks for your order.\n\nOrder 4821 is confirmed and ships within two business days.\n\nWalnut desk organizer  $48.00\nShipping  $6.00\nTotal  $54.00\n\nView your order: https://northwind.example/orders/4821\n\nNorthwind, 120 Harbor Street, Portland, OR 97209';
const RECEIPT_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Your receipt</title></head><body style="margin:0;background:#f4f4f5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;background:#ffffff;border-radius:8px;font-family:Arial,Helvetica,sans-serif;color:#18181b">
<tr><td style="padding:28px 32px 8px;font-size:15px;font-weight:bold;letter-spacing:.02em">Northwind</td></tr>
<tr><td style="padding:8px 32px 0"><h1 style="margin:0;font-size:22px;line-height:30px">Thanks for your order.</h1><p style="margin:8px 0 0;font-size:15px;line-height:22px;color:#52525b">Order 4821 is confirmed and ships within two business days.</p></td></tr>
<tr><td style="padding:24px 32px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px;line-height:22px">
<tr><td style="padding:10px 0;border-top:1px solid #e4e4e7">Walnut desk organizer</td><td align="right" style="padding:10px 0;border-top:1px solid #e4e4e7">$48.00</td></tr>
<tr><td style="padding:10px 0;border-top:1px solid #e4e4e7">Shipping</td><td align="right" style="padding:10px 0;border-top:1px solid #e4e4e7">$6.00</td></tr>
<tr><td style="padding:10px 0;border-top:1px solid #e4e4e7;font-weight:bold">Total</td><td align="right" style="padding:10px 0;border-top:1px solid #e4e4e7;font-weight:bold">$54.00</td></tr></table></td></tr>
<tr><td style="padding:24px 32px"><a href="https://northwind.example/orders/4821" style="display:inline-block;padding:12px 20px;border-radius:6px;background:#18181b;color:#ffffff;font-size:15px;font-weight:bold;text-decoration:none">View your order</a></td></tr>
<tr><td style="padding:0 32px 28px;font-size:12px;line-height:18px;color:#71717a">Northwind, 120 Harbor Street, Portland, OR 97209</td></tr>
</table></td></tr></table></body></html>`;
const JUNK_SUBJECT = 'FINAL NOTICE: YOU ARE A WINNER!!!';
const JUNK_HTML = `<html><head><style>.wrap{display:flex;gap:12px}.hero{background:#fde047}</style></head><body>
<div class="wrap"><div class="hero"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGN4KOsBAAMpAUf+vsNwAAAAAElFTkSuQmCC" width="600" height="420"></div></div>
<p style="font-size:1px;color:#ffffff">you are a winner you are a winner you are a winner you are a winner</p>
<p><a href="https://bit.ly/3claim">CLAIM YOUR PRIZE NOW</a> or <a href="http://203.0.113.7/claim">https://northwind.example/claim</a></p>
<form action="https://203.0.113.7/claim"><input type="text" name="card"><button>Claim</button></form>
</body></html>`;

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

// Sender standing as the ten-minute standing job stores it (the gate runs no job worker), 14 published days of score
// and the standing events the operator timeline reads.
const factor = (key, label, weight, value, score) => ({ key, label, weight, value, score, points: score === null ? null : Math.round(weight * score) / 100, source: score === null ? 'neutral' : 'measured', basis: 'CLS fixture.' });
async function standing(db, workspaceId, { score, limit, step, reasons = [], since, factors, events = [] }) {
  await db.query(`INSERT INTO sender_standing(workspace_id,phase,first_recipients,calibrated_at,score,day_score,score_day,target,quality,factors,band_limit,daily_limit,step,reasons,since,computed_at,version,sequence)
    VALUES($1,'graded',100,now()-interval '20 days',$2,$2,(now() AT TIME ZONE 'UTC')::date,$2::numeric+1.5,$2::numeric+4,$3::jsonb,$4,$4,$5,$6::jsonb,$7,now(),$8::int,$8::int)
    ON CONFLICT (workspace_id) DO UPDATE SET phase=excluded.phase,first_recipients=100,calibrated_at=excluded.calibrated_at,score=excluded.score,target=excluded.target,quality=excluded.quality,factors=excluded.factors,
      band_limit=excluded.band_limit,daily_limit=excluded.daily_limit,step=excluded.step,reasons=excluded.reasons,since=excluded.since,computed_at=now(),version=excluded.version,sequence=excluded.sequence`,
    [workspaceId, score, JSON.stringify(factors), limit, step, JSON.stringify(reasons), since, events.length + 1]);
  await db.query(`INSERT INTO sender_score_daily(workspace_id,day,emails,accepted,delivered,bounced,complained,score,quality,target,daily_limit,step)
    SELECT $1,(now() AT TIME ZONE 'UTC')::date-g,300,296,292,3,0,round(($2::numeric-g*0.6),2),$2::numeric+4,$2::numeric+1.5,$3,'ok' FROM generate_series(1,14) g ON CONFLICT DO NOTHING`, [workspaceId, score, limit]);
  for (const [i, event] of events.entries()) await db.query(`INSERT INTO standing_events(id,workspace_id,sequence,at,kind,from_step,to_step,reasons,actor,details) VALUES($1,$2,$3,$4,'step',$5,$6,$7::jsonb,'{"kind":"system"}'::jsonb,'{}'::jsonb)`,
    [rid('stev'), workspaceId, i + 1, event.at, event.from, event.to, JSON.stringify(event.reasons ?? [])]);
}

// Billing, enforced: Northwind is funded (top-ups, a welcome credit, hourly usage, a saved card and auto-recharge on);
// Harbor owes $12.40 after its free allowance, so sending is paused and received mail is in its 7-day grace.
async function billing(db) {
  const post = (wid, kind, source, paid, promo = 0n, detail = {}, who = 'system') => db.query('SELECT billing_post($1,$2,$3,$4::bigint,$5::bigint,$6::jsonb,$7)', [wid, kind, source, String(paid), String(promo), JSON.stringify(detail), who]);
  const usage = (wid, i, send, receive, omen = 0) => {
    const from = new Date(Math.floor(Date.now() / 3600_000) * 3600_000 - (i + 2) * 3600_000), cost = BigInt(send + receive) * 20_000n + BigInt(omen) * 10_000n;
    return post(wid, 'usage', `usage:cls:${wid}:${i}`, -cost, 0n, { meters: { send: { quantity: send }, receive: { quantity: receive }, ...(omen ? { omen: { quantity: omen } } : {}) }, costUc: String(cost), charged: true, from: from.toISOString(), to: new Date(from.getTime() + 3600_000).toISOString() });
  };
  await db.query("UPDATE billing_config SET mode='enforce',enforced_at=now()");
  await post('ws_northwind', 'topup', 'attempt:bpa_cls_first', 5_000_000_000n, 0n, {}, 'stripe');
  await post('ws_northwind', 'grant', 'grant:cls-welcome', 0n, 1_000_000_000n, { reason: 'Welcome credit' }, 'operator:user_dana');
  for (const [i, [send, receive, omen]] of [[412, 38, 12], [1260, 75, 30], [96, 12, 0], [884, 41, 9], [57, 3, 0], [2210, 120, 44]].entries()) await usage('ws_northwind', i, send, receive, omen);
  await post('ws_northwind', 'topup', 'attempt:bpa_cls_recharge', 2_500_000_000n, 0n, { recharge: true }, 'stripe');
  await db.query(`UPDATE billing_accounts SET stripe_customer='cus_cls_northwind',stripe_payment_method='pm_cls_northwind',card_brand='visa',card_last4='4242',card_exp_month=4,card_exp_year=2028,card_fingerprint='fp_cls',
    recharge_enabled=true,free_month=date_trunc('month',now() AT TIME ZONE 'UTC')::date,free_emails_used=2140,month_spend_uc=104000000 WHERE workspace_id='ws_northwind'`);
  await db.query(`INSERT INTO billing_usage_hourly(workspace_id,hour,meter,quantity,settled_quantity) SELECT 'ws_northwind',date_trunc('hour',now())-make_interval(hours=>g),m.meter,m.q,m.q
    FROM generate_series(2,7) g CROSS JOIN (VALUES ('send',820),('receive',48),('omen',16)) m(meter,q)`);
  await db.query("INSERT INTO mail_storage_aged(workspace_id,aged_bytes,aged_through) VALUES ('ws_northwind',214000000,(now() AT TIME ZONE 'UTC')::date-91)");
  await post('ws_harbor', 'topup', 'attempt:bpa_cls_harbor', 2_000_000_000n, 0n, {}, 'stripe');
  await usage('ws_harbor', 0, 158_000, 4000);
  await db.query(`UPDATE billing_accounts SET unpaid_since=now()-interval '2 days',empty_since=now()-interval '2 days',free_month=date_trunc('month',now() AT TIME ZONE 'UTC')::date,free_emails_used=3000,month_spend_uc=3240000000 WHERE workspace_id='ws_harbor'`);
}

/** Driftwood's triage ritual, version `n`: each agent save in a live job changes one line in place, so the line count
 *  (and the editor's height) stays the same. A longer script grows the editor, which is the content changing. */
export const liveSource = n => `export default function route(email, ctx) {\n  if (email.headers.has("list-unsubscribe")) return junk("newsletter")\n  label(${JSON.stringify(n ? `refund-${n}` : 'support')})\n  endpoints.support({ text: \`\${email.from.address}: \${email.subject}\` })\n}\n`;

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
  // Settings → Activity: the calls above write their own audit rows; a teammate joining and a support grant's read go
  // in as SQL (once the audit table exists on this branch).
  if ((await db.query("SELECT to_regclass('audit_events') IS NOT NULL AS ok")).rows[0].ok) await db.query(`INSERT INTO audit_events
    (workspace_id,user_id,actor_type,actor_id,actor_label,via,action,target_type,target_id,summary,reason,request_id,ip_network,user_agent,internal,at,retain_until) VALUES
    ('ws_northwind','user_sam','member','user_sam',NULL,'dashboard','member.join','member','user_sam','{"after":{"role":"admin"}}',NULL,'req_fixture_join','198.51.100.0/24','Safari 18 on macOS',false,now()-interval '6 days',now()+interval '1 year'),
    ('ws_northwind','user_sam','support','sgr_fixture','Bane support','support','support.view','workspace','ws_northwind','{"ticket":"T-1042","member":"user_sam"}',NULL,'req_fixture_support',NULL,NULL,false,now()-interval '2 days',now()+interval '1 year')`);
  const email = await mail(db, 'ws_northwind', 30);
  // The newest receipt as a well-made transactional email, and a junk-like one sent a minute ago (EmailInsight's two cases).
  // Neither links a remote image: the sent-mail preview loads those, and the gate allows no external request.
  await db.query('UPDATE sending_emails SET snapshot = snapshot || $2::jsonb WHERE id = $1', [email, JSON.stringify({ fromName: 'Northwind', html: RECEIPT_HTML, text: RECEIPT_TEXT })]);
  const junkEmail = rid('email');
  await db.query(`INSERT INTO sending_emails (id, workspace_id, region, actor_key_id, from_address, to_addresses, cc_addresses, bcc_addresses, subject, snapshot, simulated, status, provider_id, event_outcomes, created_at)
    VALUES ($1,'ws_northwind','${REGION}','fixture','deals@mail.northwind.example','["customer@example.net"]','[]','[]',$2,$3::jsonb,false,'delivered','provider-'||$1,3,now()-interval '1 minute')`,
    [junkEmail, JUNK_SUBJECT, JSON.stringify({ kind: 'marketing', region: REGION, subject: JUNK_SUBJECT, html: JUNK_HTML, attachments: [] })]);
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
  // An API key limited to several addresses: API keys' Access column lists each of them, masked.
  await dana.api('POST', '/v1/api-keys', { name: 'Triage agent', access: { type: 'addresses', addressIds: [A.support.id, A.billing.id, A.sales.id], mail: ['read', 'send'] } }, 201);
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

  // Northwind's standing: graded B with a notice (a first complaint). Dana is also a Bane operator, so the operator
  // console has a signed-in user.
  await standing(db, 'ws_northwind', { score: 86.4, limit: 5000, step: 'notice', since: ago(90), factors: [factor('complaints', 'Complaints', 30, 0.0003, 93.1), factor('content', 'Spam screen', 20, null, null), factor('bounces', 'Bounces', 15, 0.009, 91.1), factor('hygiene', 'List quality', 15, 0.012, 97.5), factor('auth', 'Authentication', 10, 0.85, 85), factor('engagement', 'Engagement', 10, 0.0031, 93.9)],
    reasons: [{ code: 'COMPLAINT_NOTICE', metric: 'complaints', value: 0.0011, count: 1, threshold: 0, minimum: 1, window: '24h', step: 'notice', message: '1 accepted email was marked as spam in 24 hours.' }] });
  await db.query("INSERT INTO platform_operators(user_id,role,reason) VALUES('user_dana','operator','CLS fixture')");
  // Dana's UI notes (features/ui-notes): one on Overview's title and one whose element is gone (a pin and the tray's
  // moved entry in notes mode), and others for the notes list. No screenshots: there is no object store here.
  const note = (id, body, kind, status, path, selector, minutes) => db.query(`INSERT INTO ui_notes(id,author_id,updated_by,body,kind,severity,status,url,path,route,context,element,created_at,resolved_at)
    VALUES($1,'user_dana','user_dana',$2,$3,NULL,$4,$5,$6,$6,$7::jsonb,$8::jsonb,$9::timestamptz,CASE WHEN $4 IN ('fixed','wontfix') THEN now() END)`, [id, body, kind, status, `${fx.origin}${path}`, path,
    JSON.stringify({ viewport: { width: 1440, height: 900 }, dpr: 2, theme: 'light', device: 'desktop', pointer: 'fine', build: 'cls' }),
    JSON.stringify({ selector, alternatives: [], testId: null, component: 'PageHeader', components: ['PageHeader'], tag: 'h1', role: 'heading', label: null, text: null, box: { x: 0, y: 0, width: 120, height: 24, scrollX: 0, scrollY: 0 }, styles: {} }), ago(minutes)]);
  await note('uin_' + '1'.repeat(32), 'Title sits 2px below the period tabs.', 'alignment', 'open', '/', '#main-content > header.ui-page-header > div.cluster:nth-of-type(1) > h1', 50);
  await note('uin_' + '2'.repeat(32), 'Empty state copy is too long.', 'copy', 'open', '/', '#main-content .cls-element-that-moved', 40);
  await note('uin_' + '3'.repeat(32), 'Filters wrap at 1280 px.', 'spacing', 'in_progress', '/logs', '#main-content > header.ui-page-header > div.cluster:nth-of-type(1) > h1', 30);
  await note('uin_' + '4'.repeat(32), 'Members table jumps on load.', 'bug', 'fixed', '/settings', '#main-content h2', 20);

  // Harbor Supply: restricted (marketing held) after complaints, with a quarantined campaign: the banner on every
  // page, Overview's standing card and the operator's workspace page.
  const rae = await fx.signIn('rae', 'rae@harborsupply.example', 'Rae Lind', { id: 'ws_harbor', name: 'Harbor Supply' });
  // Rae is an operator too, but not in UI_NOTES_SUBJECTS: no UI notes anywhere for her (cls.mjs checks).
  await db.query("INSERT INTO platform_operators(user_id,role,reason) VALUES('user_rae','operator','CLS fixture: an operator without UI notes')");
  const harborConn = await hosted(db, 'ws_harbor');
  await domain(db, 'ws_harbor', harborConn, 'harborsupply.example', { mailFrom: true });
  await rae.api('POST', '/v1/api-keys', { name: 'Production', permissions: ['send'], domains: [] }, 201);
  await mail(db, 'ws_harbor', 3);
  const springCatalog = await rae.api('POST', '/v1/campaigns', { name: 'Spring catalog', subject: 'New for spring', from: 'news@harborsupply.example', html: '<p>Hello</p>' });
  await db.query('UPDATE sending_campaigns SET quarantines=1 WHERE id=$1', [springCatalog.id]);
  const complaints = { code: 'COMPLAINTS_RESTRICT', metric: 'complaints', value: 0.0021, count: 4, threshold: 0.001, minimum: 3, window: '24h', step: 'restrict', message: '4 of 1,912 accepted emails were marked as spam in 24 hours (0.21%; the restrict line is 0.1% and 3).' };
  await standing(db, 'ws_harbor', { score: 72.4, limit: 500, step: 'restrict', since: ago(2 * 24 * 60), reasons: [complaints], factors: [factor('complaints', 'Complaints', 30, 0.0021, 31.2), factor('content', 'Spam screen', 20, null, null), factor('bounces', 'Bounces', 15, 0.011, 86.7), factor('hygiene', 'List quality', 15, 0.034, 79.1), factor('auth', 'Authentication', 10, 0.7, 70), factor('engagement', 'Engagement', 10, 0.006, 77.8)],
    events: [{ at: ago(3 * 24 * 60), from: 'ok', to: 'warn', reasons: [{ ...complaints, code: 'COMPLAINTS_WARN', step: 'warn', count: 2, message: '2 of 1,830 accepted emails were marked as spam in 24 hours (0.11%; the warn line is 0.05% and 2).' }] }, { at: ago(2 * 24 * 60), from: 'warn', to: 'restrict', reasons: [complaints] }] });

  await billing(db);

  // Lumen Labs: verified domain, no key, no mail. Field Notes: no sending connection yet.
  const nia = await fx.signIn('nia', 'nia@lumenlabs.example', 'Nia Moreau', { id: 'ws_fresh', name: 'Lumen Labs' });
  await domain(db, 'ws_fresh', await hosted(db, 'ws_fresh'), 'lumenlabs.example');
  await fx.signIn('ona', 'ona@fieldnotes.example', 'Ona Field', { id: 'ws_new', name: 'Field Notes' });
  void nia;
  // Lumen Labs is a design partner: free (not billed) for 60 days, so its Billing page shows the free plan.
  await db.query("SELECT billing_set_workspace_free('ws_fresh', true, 'Design partner', now()+interval '60 days', 'operator:user_dana')");
  // An MCP client dana connected as a labelled profile, waiting for its workspace (its page is /settings/mcp/<id>).
  const mcp = 'mcp_at_cls_fixture';
  await db.query("INSERT INTO bane_resource_grants(id,issuer,subject,user_id,client_id,workspace_id,permissions,expires_at,issued_at,profile) VALUES($1,'https://account.anoma.ly','user_dana','user_dana','opencode',NULL,'{read,send}',now()+interval '1 day',0,'work')", [mcp]);
  // API keys' agent tokens: that agent with two short-lived tokens it made in Northwind, and Sam's agent with one (an
  // owner sees another member's agent once it has made tokens here).
  await db.query("INSERT INTO bane_resource_grants(id,issuer,subject,user_id,client_id,workspace_id,permissions,expires_at,issued_at) VALUES('mcp_at_cls_sam','https://account.anoma.ly','user_sam','user_sam','claude-code',NULL,'{read}',now()+interval '1 day',0)");
  await db.query(`INSERT INTO agent_tokens(id,workspace_id,grant_id,permissions,domains,purpose,expires_at,created_at) VALUES
    ('agt_cls_import','ws_northwind',$1,'["read","send"]','[]','Import October contacts',now()+interval '50 minutes',now()-interval '10 minutes'),
    ('agt_cls_digest','ws_northwind',$1,'["send"]','["mail.northwind.example"]','Send the weekly digest',now()+interval '5 hours',now()-interval '1 hour'),
    ('agt_cls_sam','ws_northwind','mcp_at_cls_sam','["read"]','[]','Check bounce rates',now()+interval '2 hours',now()-interval '30 minutes')`, [mcp]);
  // Driftwood: the rituals page while an agent edits beside it (cls.mjs `live` jobs). Kai's OpenCode approval can change
  // rituals here (the page says it is connected), and the agent's own API key saves the ritual while a job watches.
  const kai = await fx.signIn('kai', 'kai@driftwood.example', 'Kai Moana', { id: 'ws_live', name: 'Driftwood' });
  await domain(db, 'ws_live', await hosted(db, 'ws_live'), 'driftwood.example', { receiving: true });
  const desk = await kai.api('POST', '/v1/inbound/addresses', { address: 'support@driftwood.example', key: 'support', displayName: 'Support' }, 201);
  await kai.api('POST', '/v1/endpoints', { type: 'slack', name: 'support', url: 'https://hooks.slack.com/services/T0SYNTH/B0SYNTH/driftwoodfixture0a1' }, 201);
  await kai.api('PUT', '/v1/rituals', { rituals: [{ key: 'triage', source: liveSource(0) }], attachments: [{ ritual: 'triage', target: desk.id, continue: false }] }, 200);
  const agent = await kai.api('POST', '/v1/api-keys', { name: 'Refund agent', permissions: ['read', 'send', 'manage'], domains: [] }, 201);
  await db.query("INSERT INTO bane_resource_grants(id,issuer,subject,user_id,client_id,workspace_id,permissions,expires_at,issued_at,profile,receiving) VALUES('mcp_at_cls_live','https://account.anoma.ly','user_kai','user_kai','opencode','ws_live','{read,send,manage}',now()+interval '1 day',0,'work',true)");
  fx.liveKey = agent.secret;
  return {
    mcp, restricted: 'ws_harbor', email, junkEmail, receivedEmail: 'msg_northwind_invoice', domain: nw.id, sendingDomain: sendingDomain.id, address: A.support.id, inbox, inboundWebhook: crmId,
    webhook: hook.webhook?.id ?? hook.id, list: list.id, contact: contact.id, campaign: campaign.id, template: template.id ?? template.template?.id, segment: segment.id,
  };
}
