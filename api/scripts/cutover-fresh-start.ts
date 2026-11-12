// Operator-only (no API endpoint): hosted production starts fresh at the OIDC cutover (PR #89).
//
//   node --import tsx scripts/cutover-fresh-start.ts --plan
//   node --import tsx scripts/cutover-fresh-start.ts --apply --workspace <kept workspace ID from --plan> [--skip-ses]
//
// Keeps exactly one workspace, the only owner of bane.mx, with all of its data, and the internal 'default'
// namespace (installation SES settings, global jobs). Every other workspace is deleted with its data: the tables are
// read from the schema (every base table with a workspace_id column, or with a connection_id column and no
// workspace_id), so a table added later cannot be missed. Every person and every credential or approval tied to a
// person is wiped (users, sessions, memberships, invitations, legacy OAuth clients/consents/tokens, bane_agent_
// tokens, MCP approvals). The kept workspace's API keys, inbox keys, app passwords, routes and endpoints stay.
// Finally one owner is pre-assigned: their first sign-in at ACCOUNT_ISSUER with Google, asserting this exact verified
// address, claims the prepared user (migration 277).
//
// Env: DATABASE_URL (the migrator role: it owns the tables), ACCOUNT_ISSUER (the issuer the claim is pinned to).
// --apply first tears down the deleted workspaces' shared SES identities (the dashboard's disconnect code) and their
// tenants. That needs the API's runtime env with ENABLE_LIVE_SES=true and the platform AWS credentials; --skip-ses
// leaves them for manual cleanup (--plan lists them). Take a database snapshot before --apply.
//
// The database phase is one REPEATABLE READ transaction. Before committing it checks that no row of the kept
// workspace or of 'default' went missing (apart from memberships, invitations, approvals and agent tokens), and that
// no row of a deleted workspace is left; otherwise it rolls back. Re-running after a successful apply is a no-op.
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { postgresConnection } from '../src/adapters/node.js';

const ANCHOR_DOMAIN = 'bane.mx';
const KEPT_DOMAINS = ['bane.mx', 'opencode.ai', 'console.opencode.ai'];
const INTERNAL = 'default';
const GOOGLE_ACR = 'urn:anomaly:acr:google';
// People, and every credential or approval tied to a person. Wiped whole; FK order is handled by retrying.
const PEOPLE = ['access_requests', 'auth_verification', 'auth_session', 'auth_account', 'oauth_access_token', 'oauth_refresh_token',
  'oauth_consent', 'oauth_client_assertion', 'oauth_client_resource', 'oauth_client', 'agent_tokens', 'bane_sessions', 'bane_login_flows',
  'bane_dpop_proofs', 'bane_resource_grants', 'bane_expired_approvals', 'bane_legacy_claims', 'workspace_invitations', 'workspace_members',
  'bane_oidc_identities', 'auth_user', 'bane_users'];
// Kept-workspace rows the wipe is meant to change: people-scoped rows, and grant objects detached into the audit table.
const PEOPLE_SCOPED = new Set(['agent_tokens', 'bane_resource_grants', 'workspace_invitations', 'workspace_members', 'mail_grant_objects', 'bane_retired_grant_objects']);
const NEVER = new Set(['workspaces', 'bane_migrations', ...PEOPLE]);

type Key = { table: string; column: string; by: 'workspace' | 'connection' };
type Victim = { id: string; name: string; created_at: string; members: number; domains: string[];
  connections: { id: string; kind: string; region: string; aws_account_id: string | null; role_arn: string | null; external_id: string | null; tenant_state: string; claims: string[] }[];
  tenants: { region: string; arn: string }[] };
export type Plan = { anchor: { id: string; name: string; quota_sponsor: string | null }; domains: Record<string, string[]>; victims: Victim[];
  people: Record<string, number>; rows: Record<string, number>; keys: Key[]; owner: string; issuer: string; applied: boolean };

const ident = (name: string) => '"' + name.replace(/"/g, '""') + '"';
const exists = async (db: pg.Client, table: string) => !!(await db.query('SELECT to_regclass($1) AS t', ['public.' + table])).rows[0].t;

async function keys(db: pg.Client): Promise<Key[]> {
  // Every base table (partitions through their parent) keyed by a workspace or, without one, by a provider connection.
  const { rows } = await db.query<{ table_name: string; column_name: string }>(`
    SELECT c.table_name, c.column_name FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name AND t.table_type='BASE TABLE'
    JOIN pg_class k ON k.oid=format('%I.%I',c.table_schema,c.table_name)::regclass AND NOT k.relispartition
    WHERE c.table_schema='public' AND c.data_type IN ('text','character varying')
      AND (c.column_name='workspace_id' OR c.column_name ~ '_workspace(_id)?$'
        OR (c.column_name='connection_id' AND NOT EXISTS (SELECT FROM information_schema.columns w
          WHERE w.table_schema=c.table_schema AND w.table_name=c.table_name AND w.column_name='workspace_id')))
    ORDER BY 1, 2`);
  // information_schema lists only tables this role may use; the catalog lists all. A difference would leave rows behind.
  const { rows: catalog } = await db.query<{ table_name: string; column_name: string }>(`
    SELECT c.relname AS table_name, a.attname AS column_name FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE c.relkind IN ('r','p') AND NOT c.relispartition AND a.atttypid IN ('text'::regtype,'varchar'::regtype)
      AND (a.attname='workspace_id' OR a.attname ~ '_workspace(_id)?$' OR (a.attname='connection_id' AND NOT EXISTS (SELECT FROM pg_attribute w
        WHERE w.attrelid=c.oid AND w.attname='workspace_id' AND NOT w.attisdropped)))
    ORDER BY 1, 2`);
  const listed = (list: typeof rows) => list.map(r => `${r.table_name}.${r.column_name}`).join();
  if (listed(rows) !== listed(catalog)) throw new Error(`Refusing: this role cannot see every workspace-keyed table (${listed(catalog)} vs ${listed(rows)}). Use the migrator role.`);
  return rows.filter(r => !NEVER.has(r.table_name))
    .map(r => ({ table: r.table_name, column: r.column_name, by: r.column_name === 'connection_id' ? 'connection' as const : 'workspace' as const }));
}

export async function inspect(db: pg.Client, owner: string, issuer: string): Promise<Plan> {
  const name = (d: string) => d.toLowerCase();
  const ownersOf = async (domain: string) => (await db.query<{ workspace_id: string }>(`
    SELECT DISTINCT workspace_id FROM (SELECT workspace_id FROM operation_domains WHERE lower(name)=$1
      UNION SELECT workspace_id FROM mailbox_domains WHERE lower(name)=$1
      UNION SELECT workspace_id FROM domain_claims WHERE lower(name)=$1 AND NOT superseded) o ORDER BY 1`, [name(domain)])).rows.map(r => r.workspace_id);
  const anchors = await ownersOf(ANCHOR_DOMAIN);
  if (anchors.length !== 1) throw new Error(`Refusing: ${anchors.length} workspaces own ${ANCHOR_DOMAIN} (${anchors.join(', ') || 'none'}); exactly one must.`);
  const anchorId = anchors[0]!;
  if (anchorId === INTERNAL) throw new Error(`Refusing: ${ANCHOR_DOMAIN} belongs to the internal '${INTERNAL}' namespace.`);
  const { rows: [anchor] } = await db.query<{ id: string; name: string; quota_sponsor: string | null }>('SELECT id,name,quota_sponsor FROM workspaces WHERE id=$1', [anchorId]);
  if (!anchor) throw new Error(`Refusing: ${ANCHOR_DOMAIN} points at workspace ${anchorId}, which does not exist.`);
  const domains: Record<string, string[]> = {};
  for (const d of KEPT_DOMAINS) domains[d] = await ownersOf(d);
  const { rows: victimRows } = await db.query<{ id: string; name: string; created_at: string; members: number }>(`
    SELECT w.id,w.name,w.created_at::text,(SELECT count(*)::int FROM workspace_members m WHERE m.workspace_id=w.id) members
    FROM workspaces w WHERE w.id<>ALL($1) ORDER BY w.created_at,w.id`, [[anchorId, INTERNAL]]);
  const victims: Victim[] = [];
  for (const v of victimRows) {
    const domainRows = (await db.query<{ name: string }>(`SELECT name FROM (SELECT name FROM operation_domains WHERE workspace_id=$1
      UNION SELECT name FROM mailbox_domains WHERE workspace_id=$1 UNION SELECT name FROM domain_claims WHERE workspace_id=$1) d ORDER BY 1`, [v.id])).rows;
    const connections = (await db.query<Victim['connections'][number]>(`SELECT id,kind,region,aws_account_id,role_arn,external_id::text,tenant_state,
      ARRAY(SELECT name FROM domain_claims dc WHERE dc.connection_id=pc.id ORDER BY 1) claims FROM provider_connections pc WHERE workspace_id=$1`, [v.id])).rows;
    const tenants = (await db.query<{ region: string; arn: string }>('SELECT region,arn FROM hosted_tenant_ownership WHERE workspace_id=$1 ORDER BY 1', [v.id])).rows;
    victims.push({ ...v, domains: domainRows.map(r => r.name), connections, tenants });
  }
  const people: Record<string, number> = {};
  for (const table of PEOPLE) if (await exists(db, table)) people[table] = (await db.query(`SELECT count(*)::int n FROM ${ident(table)}`)).rows[0].n;
  const ids = victims.map(v => v.id), connectionIds = victims.flatMap(v => v.connections.map(c => c.id));
  const keyList = await keys(db), rows: Record<string, number> = {};
  for (const k of keyList) {
    const n = (await db.query(`SELECT count(*)::int n FROM ${ident(k.table)} WHERE ${ident(k.column)}=ANY($1)`, [k.by === 'connection' ? connectionIds : ids])).rows[0].n;
    if (n) rows[`${k.table}.${k.column}`] = n;
  }
  const users = await db.query<{ email: string | null }>('SELECT email FROM bane_users');
  const member = await db.query("SELECT FROM workspace_members m JOIN bane_users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.role='owner' AND u.email=$2", [anchorId, owner]);
  const applied = !victims.length && users.rows.length === 1 && users.rows[0]!.email === owner && member.rowCount === 1
    && people.workspace_members === 1 && !people.auth_user && !people.oauth_client && !people.agent_tokens;
  return { anchor, domains, victims, people, rows, keys: keyList, owner, issuer, applied };
}

export function describe(plan: Plan) {
  const out: string[] = [];
  out.push(`Kept workspace: ${plan.anchor.id} "${plan.anchor.name}" (the only owner of ${ANCHOR_DOMAIN})`);
  for (const [d, owners] of Object.entries(plan.domains)) out.push(`  ${d}: ${owners.length === 1 && owners[0] === plan.anchor.id ? 'kept' : owners.length ? `owned by ${owners.join(', ')} (CHECK)` : 'not found (CHECK)'}`);
  if (plan.anchor.quota_sponsor) out.push(`  quota sponsor: ${plan.anchor.quota_sponsor}${plan.victims.some(v => v.id === plan.anchor.quota_sponsor) ? ' (DELETED below: CHECK)' : ''}`);
  out.push(`Internal namespace kept: ${INTERNAL}`);
  out.push(`Workspaces to delete: ${plan.victims.length}`);
  for (const v of plan.victims) {
    out.push(`  ${v.id} "${v.name}" created ${v.created_at.slice(0, 10)}, ${v.members} member(s)${v.domains.length ? `, domains: ${v.domains.join(', ')}` : ''}`);
    for (const c of v.connections) out.push(`    connection ${c.id} ${c.kind} ${c.region}${c.kind === 'shared' ? `: delete SES identities ${c.claims.join(', ') || '(none)'}` : `: identities stay in AWS account ${c.aws_account_id ?? '?'}`}`);
    for (const t of v.tenants) out.push(`    tenant ${t.arn}: delete`);
  }
  out.push('People and credentials to wipe:');
  for (const [table, n] of Object.entries(plan.people)) if (n) out.push(`  ${table}: ${n}`);
  out.push(`Workspace data to delete (${plan.keys.length} keyed tables scanned):`);
  for (const [key, n] of Object.entries(plan.rows)) out.push(`  ${key}: ${n}`);
  out.push(`Bootstrap: ${plan.owner} becomes the only member (owner) of ${plan.anchor.id}; the claim needs ${plan.issuer} and ${GOOGLE_ACR}.`);
  if (plan.applied) out.push('Already applied: nothing to do.');
  return out.join('\n');
}

async function releaseSes(plan: Plan) {
  const shared = plan.victims.flatMap(v => v.connections.filter(c => c.kind === 'shared').map(c => ({ wid: v.id, c })));
  const tenants = plan.victims.flatMap(v => v.tenants);
  if (!shared.length && !tenants.length) return;
  const [{ nodeRuntime }, { isSimulatedSes }, { releaseConnectionDomains }, { platformCredentials }, { SESv2Client, DeleteTenantCommand }] = await Promise.all([
    import('../src/adapters/node.js'), import('../src/core.js'), import('../src/operations.js'), import('../src/provider-credentials.js'), import('@aws-sdk/client-sesv2')]);
  const { runtime, close } = nodeRuntime(process.env);
  try {
    if (isSimulatedSes(runtime)) throw new Error('SES teardown needs the API runtime env with ENABLE_LIVE_SES=true and the platform AWS credentials. Rerun with --skip-ses only to leave the listed identities and tenants for manual cleanup.');
    // The dashboard's disconnect path: tenant disassociation, then DeleteEmailIdentity, guarded by each claim's token.
    for (const { wid, c } of shared) {
      await runtime.db.transaction(db => releaseConnectionDomains(runtime, db, wid, { id: c.id, kind: c.kind as 'shared', region: c.region, aws_account_id: c.aws_account_id!, role_arn: c.role_arn!, external_id: c.external_id!, tenant_state: c.tenant_state as never }));
      console.log(`released SES identities of ${wid} (${c.claims.join(', ') || 'none'})`);
    }
    for (const t of tenants) {
      const ses = new SESv2Client({ region: t.region, credentials: await platformCredentials(runtime) });
      const tenantName = t.arn.split(':tenant/')[1]?.split('/')[0];
      if (!tenantName) throw new Error(`Unexpected tenant ARN ${t.arn}`);
      try { await ses.send(new DeleteTenantCommand({ TenantName: tenantName })); }
      catch (e) { if ((e as { name?: string }).name !== 'NotFoundException') throw e; }
      console.log(`deleted tenant ${t.arn}`);
    }
  } finally { await close(); }
}

// Runs each statement until it succeeds. A foreign-key violation means a row elsewhere still points at it: retry after
// the others. A pass without progress means a real problem, so it stops.
async function drain(db: pg.Client, statements: { label: string; sql: string; params: unknown[] }[]) {
  let pending = statements, deleted: Record<string, number> = {};
  while (pending.length) {
    const failed: typeof pending = [];
    for (const s of pending) {
      await db.query('SAVEPOINT step');
      try { const r = await db.query(s.sql, s.params); deleted[s.label] = (deleted[s.label] ?? 0) + (r.rowCount ?? 0); await db.query('RELEASE SAVEPOINT step'); }
      catch (e) { await db.query('ROLLBACK TO SAVEPOINT step'); if ((e as { code?: string }).code !== '23503') throw e; failed.push(s); }
    }
    if (failed.length === pending.length) throw new Error(`Foreign keys still block: ${failed.map(s => s.label).join(', ')}`);
    pending = failed;
  }
  return deleted;
}

async function anchorCounts(db: pg.Client, list: Key[], wids: string[]) {
  const counts: Record<string, number> = {};
  for (const k of list) if (k.column === 'workspace_id')
    for (const wid of wids) counts[`${k.table}@${wid}`] = (await db.query(`SELECT count(*)::int n FROM ${ident(k.table)} WHERE workspace_id=$1`, [wid])).rows[0].n;
  return counts;
}

export async function apply(db: pg.Client, plan: Plan) {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try {
    await db.query("SET LOCAL lock_timeout='5s'");
    const fresh = await inspect(db, plan.owner, plan.issuer);
    if (fresh.anchor.id !== plan.anchor.id || fresh.victims.map(v => v.id).join() !== plan.victims.map(v => v.id).join())
      throw new Error('The workspaces changed since the SES teardown; run --plan again.');
    const anchorId = plan.anchor.id, ids = plan.victims.map(v => v.id), connectionIds = plan.victims.flatMap(v => v.connections.map(c => c.id));
    const before = await anchorCounts(db, fresh.keys, [anchorId, INTERNAL]);
    // Keep what MCP approvals created in the kept workspaces: detach their ownership rows with the triggers that would
    // revoke keys, pause endpoints and disable routes turned off (as migration 276 does for legacy approvals).
    await db.query(`INSERT INTO bane_retired_grant_objects(grant_id,workspace_id,kind,resource)
      SELECT grant_id,workspace_id,kind,resource FROM mail_grant_objects WHERE workspace_id=ANY($1) ON CONFLICT DO NOTHING`, [[anchorId, INTERNAL]]);
    await db.query('ALTER TABLE mail_grant_objects DISABLE TRIGGER USER');
    await db.query('DELETE FROM mail_grant_objects WHERE workspace_id=ANY($1)', [[anchorId, INTERNAL]]);
    await db.query('ALTER TABLE mail_grant_objects ENABLE TRIGGER USER');
    const present: string[] = [];
    for (const t of PEOPLE) if (await exists(db, t)) present.push(t);
    const people = await drain(db, present.map(t => ({ label: t, sql: `DELETE FROM ${ident(t)}`, params: [] })));
    const data = await drain(db, [
      ...fresh.keys.map(k => ({ label: `${k.table}.${k.column}`, sql: `DELETE FROM ${ident(k.table)} WHERE ${ident(k.column)}=ANY($1)`, params: [k.by === 'connection' ? connectionIds : ids] })),
      { label: 'workspaces', sql: 'DELETE FROM workspaces WHERE id=ANY($1)', params: [ids] },
    ]);
    // Triggers can write follow-up rows (jobs, routing state) for a deleted workspace: sweep until none is left.
    for (let pass = 0; ; pass++) {
      let left = 0;
      for (const k of fresh.keys) left += (await db.query(`SELECT count(*)::int n FROM ${ident(k.table)} WHERE ${ident(k.column)}=ANY($1)`, [k.by === 'connection' ? connectionIds : ids])).rows[0].n as number;
      if (!left) break;
      if (pass === 5) throw new Error(`${left} rows of deleted workspaces remain after ${pass} sweeps.`);
      await drain(db, fresh.keys.map(k => ({ label: `${k.table}.${k.column}`, sql: `DELETE FROM ${ident(k.table)} WHERE ${ident(k.column)}=ANY($1)`, params: [k.by === 'connection' ? connectionIds : ids] })));
    }
    const after = await anchorCounts(db, fresh.keys, [anchorId, INTERNAL]);
    const lost = Object.keys(before).filter(key => !PEOPLE_SCOPED.has(key.split('@')[0]!) && after[key]! < before[key]!);
    if (lost.length) throw new Error(`Refusing: rows of a kept workspace would be lost: ${lost.map(k => `${k} ${before[k]}->${after[k]}`).join(', ')}`);
    const userId = randomUUID();
    await db.query('INSERT INTO bane_users(id,name,email,email_verified,selected_workspace_id) VALUES($1,$2,$2,true,$3)', [userId, plan.owner, anchorId]);
    await db.query("INSERT INTO workspace_members(id,user_id,workspace_id,role) VALUES($1,$2,$3,'owner')", [randomUUID(), userId, anchorId]);
    await db.query("INSERT INTO bane_legacy_claims(user_id,issuer,email,source,required_acr) VALUES($1,$2,$3,'bootstrap',$4)", [userId, plan.issuer, plan.owner, GOOGLE_ACR]);
    await db.query(`INSERT INTO hosted_operator_audit(workspace_id,action,details) VALUES($1,'cutover-fresh-start',$2)`,
      [anchorId, JSON.stringify({ deletedWorkspaces: ids, people, data, owner: plan.owner, issuer: plan.issuer, requiredAcr: GOOGLE_ACR })]);
    await db.query('COMMIT');
    return { userId, people, data };
  } catch (e) { await db.query('ROLLBACK'); throw e; }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { plan: { type: 'boolean' }, apply: { type: 'boolean' }, workspace: { type: 'string' }, 'skip-ses': { type: 'boolean' }, owner: { type: 'string', default: 'ryan@anoma.ly' } } });
  if (values.plan === values.apply) throw new Error('Usage: cutover-fresh-start.ts --plan | --apply --workspace <id> [--skip-ses]');
  const issuer = process.env.ACCOUNT_ISSUER;
  if (!issuer || !/^https:\/\/[^/]+$/.test(issuer)) throw new Error('Set ACCOUNT_ISSUER to the issuer origin the owner will sign in at (https://account.anoma.ly in production).');
  const owner = values.owner!;
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(owner) || owner !== owner.toLowerCase()) throw new Error('--owner must be the exact lowercase address the issuer asserts.');
  const db = new pg.Client(postgresConnection(process.env.DATABASE_URL));
  await db.connect();
  try {
    await db.query('BEGIN READ ONLY');
    const plan = await inspect(db, owner, issuer);
    await db.query('ROLLBACK');
    console.log(describe(plan));
    if (values.apply && !plan.applied) {
      if (values.workspace !== plan.anchor.id) throw new Error(`Refusing: pass --workspace ${plan.anchor.id} after reviewing --plan.`);
      if (!values['skip-ses']) await releaseSes(plan);
      const result = await apply(db, plan);
      console.log(`Applied. ${plan.owner} is the owner of ${plan.anchor.id} (user ${result.userId}); deleted ${plan.victims.length} workspace(s).`);
    }
  } finally { await db.end(); }
}
