import { parseArgs } from 'node:util';
import { Client } from 'pg';
import { postgresConnection } from '../src/adapters/node.js';
import { log } from '../src/core.js';

// Grants or removes a Bane platform operator role (the /operator area and /v1/operator/*). Operators are Anomaly staff,
// never a workspace role: nobody can grant it from the dashboard. The user must have signed in once.
//   node --import tsx scripts/set-operator.ts EMAIL operator|operator:read|off --reason "why"
export async function setOperator(db: Client, args: string[]) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { reason: { type: 'string' } } });
  const [email, role] = positionals, reason = values.reason?.trim();
  if (positionals.length !== 2 || !email?.includes('@') || !['operator', 'operator:read', 'off'].includes(role!) || !reason || reason.length < 10)
    throw new Error('Usage: set-operator.ts EMAIL operator|operator:read|off --reason "why (at least 10 characters)"');
  const { rows: [row] } = await db.query(`WITH u AS (SELECT id FROM auth_user WHERE lower(email)=lower($1)),
    previous AS (SELECT p.role FROM platform_operators p JOIN u ON u.id=p.user_id),
    removed AS (DELETE FROM platform_operators p USING u WHERE p.user_id=u.id AND $2='off' RETURNING p.user_id),
    granted AS (INSERT INTO platform_operators(user_id,role,reason) SELECT id,$2,$3 FROM u WHERE $2<>'off'
      ON CONFLICT(user_id) DO UPDATE SET role=excluded.role,reason=excluded.reason,granted_at=now() RETURNING user_id),
    audit AS (INSERT INTO hosted_operator_audit(workspace_id,action,details,operator_id,via,reason,before,after)
      SELECT 'platform','set-operator',jsonb_build_object('userId',u.id),u.id,'script',$3,to_jsonb((SELECT role FROM previous)),to_jsonb(nullif($2,'off')) FROM u)
    SELECT (SELECT id FROM u) AS user_id,(SELECT role FROM previous) AS previous`, [email, role, reason]);
  if (!row?.user_id) throw new Error('No user with that email has signed in.');
  log('info', { code: 'OPERATOR_ROLE_CHANGED', userId: row.user_id, from: row.previous ?? null, to: role === 'off' ? null : role });
}

if (import.meta.main) {
  const db = new Client(postgresConnection(process.env.DATABASE_URL));
  await db.connect();
  try { await setOperator(db, process.argv.slice(2)); } finally { await db.end(); }
}
