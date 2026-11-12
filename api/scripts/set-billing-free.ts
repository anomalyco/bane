import { parseArgs } from 'node:util';
import { Client } from 'pg';
import { postgresConnection } from '../src/adapters/node.js';
import { log } from '../src/core.js';

const usage = `Usage:
  set-billing-free.ts workspace WORKSPACE_ID on|off [--until YYYY-MM-DD] --reason "why (at least 10 characters)"
  set-billing-free.ts account EMAIL on|off [--until YYYY-MM-DD] --reason "why (at least 10 characters)"`;

/**
 * Marks a workspace, or a person, free (never billed). A person is found by the email they signed in with, but the
 * flag binds to their sign-in identity (issuer + subject): every workspace they own is free while they own it. Usage
 * is still metered and settled at $0 with its would-be cost. The change and its audit rows commit in one statement.
 */
export async function setBillingFree(db: Client, args: string[]) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { reason: { type: 'string' }, until: { type: 'string' } } });
  const [kind, target, state] = positionals, reason = values.reason?.trim(), on = state === 'on';
  if (positionals.length !== 3 || !['workspace', 'account'].includes(kind!) || !target || (state !== 'on' && state !== 'off') || !reason || reason.length < 10) throw new Error(usage);
  const until = values.until ?? null;
  if (until !== null && (!on || !/^\d{4}-\d{2}-\d{2}$/.test(until) || !(Date.parse(`${until}T00:00:00Z`) > Date.now()))) throw new Error(`--until takes a future date (YYYY-MM-DD) and only with on.\n${usage}`);
  if (kind === 'workspace') {
    const { rows: [audit] } = await db.query(`WITH ws AS (SELECT id FROM workspaces WHERE id=$1),
        changed AS (SELECT billing_free_state(id) AS before, billing_set_workspace_free(id,$2,$3,$4::date::timestamptz,'script') AS after FROM ws)
      INSERT INTO hosted_operator_audit(workspace_id,action,details)
      SELECT $1,$5,jsonb_build_object('old',before,'new',after,'until',$4::text,'reason',$3::text,'via','script') FROM changed RETURNING details`,
      [target, on, reason, until, on ? 'set-billing-free-on' : 'set-billing-free-off']);
    if (!audit) throw new Error('No workspace with this ID.');
    log('info', { code: 'BILLING_FREE_CHANGED', workspaceId: target, ...audit.details });
    return audit.details as { old: Record<string, unknown>; new: Record<string, unknown> };
  }
  const { rows: [audit] } = await db.query(`WITH u AS (SELECT id FROM auth_user WHERE lower(email)=lower($1)),
      bound AS (SELECT u.id,(SELECT count(*) FROM billing_user_identities(u.id)) AS n FROM u),
      changed AS (SELECT id, billing_set_person_free(id,$2,$3,$4::date::timestamptz,'script') AS workspaces FROM bound WHERE n>0 OR NOT $2)
    INSERT INTO hosted_operator_audit(workspace_id,action,details)
    SELECT 'platform',$5,jsonb_build_object('userId',id,'workspaces',workspaces,'until',$4::text,'reason',$3::text,'via','script') FROM changed RETURNING details`,
    [target, on, reason, until, on ? 'set-billing-free-account-on' : 'set-billing-free-account-off']);
  if (!audit) throw new Error('No signed-in person with this email and a sign-in identity to bind to.');
  log('info', { code: 'BILLING_FREE_ACCOUNT_CHANGED', userId: audit.details.userId, workspaces: audit.details.workspaces.length });
  return audit.details as { userId: string; workspaces: { workspaceId: string; free: boolean; via: string | null; mode: string }[] };
}

if (import.meta.main) {
  const db = new Client(postgresConnection(process.env.DATABASE_URL));
  await db.connect();
  try { await setBillingFree(db, process.argv.slice(2)); } finally { await db.end(); }
}
