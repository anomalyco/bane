import { sql, type SQL } from 'drizzle-orm';
import type { DbExecutor } from './core.js';

// The one link between a Bane platform operator role and a user identity. The role is a row in platform_operators,
// keyed by platform_operators.user_id, which references auth_user(id) (migration 231). Every lookup and grant goes
// through this file: the operator API (operatorActor), GET /v1/me (sessionMemberships) and scripts/set-operator.ts.
// When sign-in moves users to another table (#89, bane_users), port the foreign key and this file; nothing else.

export type OperatorRole = 'operator' | 'operator:read';

/** The user's platform role as a scalar subquery, for a caller that reads it inside a larger statement. */
export const operatorRoleOf = (userId: string | SQL) => sql`(SELECT role FROM platform_operators WHERE user_id=${userId})`;

/** The user's platform role, or null. One indexed read. */
export async function operatorRole(db: DbExecutor, userId: string) {
  return (await db.execute<{ role: OperatorRole | null }>(sql`SELECT ${operatorRoleOf(userId)} AS role`)).rows[0]?.role ?? null;
}

/**
 * Grants, changes or removes (role 'off') the role of the user who signed in with this email, with its audit row, in
 * one statement. Returns the user and the previous role; no user when nobody with that email has signed in.
 */
export const setOperatorRole = (email: string, role: OperatorRole | 'off', reason: string) => sql`WITH u AS (SELECT id FROM auth_user WHERE lower(email)=lower(${email})),
    previous AS (SELECT p.role FROM platform_operators p JOIN u ON u.id=p.user_id),
    removed AS (DELETE FROM platform_operators p USING u WHERE p.user_id=u.id AND ${role}='off' RETURNING p.user_id),
    granted AS (INSERT INTO platform_operators(user_id,role,reason) SELECT id,${role},${reason} FROM u WHERE ${role}<>'off'
      ON CONFLICT(user_id) DO UPDATE SET role=excluded.role,reason=excluded.reason,granted_at=now() RETURNING user_id),
    audit AS (INSERT INTO hosted_operator_audit(workspace_id,action,details,operator_id,via,reason,before,after)
      SELECT 'platform','set-operator',jsonb_build_object('userId',u.id),u.id,'script',${reason},to_jsonb((SELECT role FROM previous)),to_jsonb(nullif(${role}::text,'off')) FROM u)
  SELECT (SELECT id FROM u) AS user_id,(SELECT role FROM previous) AS previous`;
