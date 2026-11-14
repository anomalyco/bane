import { sql, type SQL } from 'drizzle-orm';
import type { DbExecutor } from './core.js';

// The one link between a Nightmail platform operator role and a user identity. The role is a row in platform_operators,
// keyed by platform_operators.user_id, which references nightmail_users(id) (migration 278; it referenced auth_user before
// #89). Every lookup and grant goes through this file: the operator API (operatorActor), GET /v1/me
// (sessionMemberships) and scripts/set-operator.ts. A grant names the person by issuer subject, never by address.

export type OperatorRole = 'operator' | 'operator:read';

/** The user's platform role as a scalar subquery, for a caller that reads it inside a larger statement. */
export const operatorRoleOf = (userId: string | SQL) => sql`(SELECT role FROM platform_operators WHERE user_id=${userId})`;

/**
 * Whether this user may use staff UI notes (src/ui-notes.ts): the operator role and an identity whose issuer subject
 * is in UI_NOTES_SUBJECTS. False, without a query, when the list is empty (the feature is off).
 */
export async function uiNotesAllowed(db: DbExecutor, subjects: { issuer: string; subject: string }[] | undefined, userId: string) {
  if (!subjects?.length) return false;
  const pairs = sql.join(subjects.map(s => sql`(${s.issuer}, ${s.subject})`), sql`, `);
  return (await db.execute<{ ok: boolean }>(sql`SELECT EXISTS (SELECT FROM nightmail_oidc_identities i JOIN platform_operators p ON p.user_id = i.user_id AND p.role = 'operator'
    WHERE i.user_id = ${userId} AND (i.issuer, i.subject) IN (${pairs})) AS ok`)).rows[0]?.ok === true;
}

/** The user's platform role, or null. One indexed read. */
export async function operatorRole(db: DbExecutor, userId: string) {
  return (await db.execute<{ role: OperatorRole | null }>(sql`SELECT ${operatorRoleOf(userId)} AS role`)).rows[0]?.role ?? null;
}

/**
 * Grants, changes or removes (role 'off') the role of the user bound to this issuer subject, with its audit row, in
 * one statement. Returns the user and the previous role; no user when that subject has never signed in.
 */
export const setOperatorRole = (issuer: string, subject: string, role: OperatorRole | 'off', reason: string) => sql`WITH u AS (SELECT user_id AS id FROM nightmail_oidc_identities WHERE issuer=${issuer} AND subject=${subject}),
    previous AS (SELECT p.role FROM platform_operators p JOIN u ON u.id=p.user_id),
    removed AS (DELETE FROM platform_operators p USING u WHERE p.user_id=u.id AND ${role}='off' RETURNING p.user_id),
    granted AS (INSERT INTO platform_operators(user_id,role,reason) SELECT id,${role},${reason} FROM u WHERE ${role}<>'off'
      ON CONFLICT(user_id) DO UPDATE SET role=excluded.role,reason=excluded.reason,granted_at=now() RETURNING user_id),
    audit AS (INSERT INTO hosted_operator_audit(workspace_id,action,details,operator_id,via,reason,before,after)
      SELECT 'platform','set-operator',jsonb_build_object('userId',u.id),u.id,'script',${reason},to_jsonb((SELECT role FROM previous)),to_jsonb(nullif(${role}::text,'off')) FROM u)
  SELECT (SELECT id FROM u) AS user_id,(SELECT role FROM previous) AS previous`;
