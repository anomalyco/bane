import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { parseArgs } from 'node:util';
import { Client } from 'pg';
import { postgresConnection } from '../src/adapters/node.js';
import { auditInsert, systemContext } from '../src/audit.js';
import { log } from '../src/core.js';

const usage = `Usage:
  set-billing-free.ts workspace WORKSPACE_ID on|off [--until YYYY-MM-DD] --reason "why (at least 10 characters)"
  ACCOUNT_ISSUER=https://account.anoma.ly set-billing-free.ts account SUBJECT on|off [--until YYYY-MM-DD] --reason "why (at least 10 characters)"`;

/**
 * Marks a workspace, or a person, free (never billed). A person is named by issuer subject, never by address (read it
 * from scripts/list-signin-attempts.ts after they signed in once), and the flag binds to that identity: every workspace
 * they own is free while they own it. Usage is still metered and settled at $0 with its would-be cost. The change and
 * its audit rows (billing.*, kept 7 years) commit in one statement.
 */
export async function setBillingFree(db: Client, args: string[], issuer = process.env.ACCOUNT_ISSUER) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { reason: { type: 'string' }, until: { type: 'string' } } });
  const [kind, target, state] = positionals, reason = values.reason?.trim(), on = state === 'on';
  if (positionals.length !== 3 || !['workspace', 'account'].includes(kind!) || !target || /\s/.test(target) || target.length > 255 || (state !== 'on' && state !== 'off') || !reason || reason.length < 10) throw new Error(usage);
  const until = values.until ?? null;
  if (until !== null && (!on || !/^\d{4}-\d{2}-\d{2}$/.test(until) || !(Date.parse(`${until}T00:00:00Z`) > Date.now()))) throw new Error(`--until takes a future date (YYYY-MM-DD) and only with on.\n${usage}`);
  if (kind === 'account' && (!issuer || !/^https:\/\/[^/]+$/.test(issuer))) throw new Error('Set ACCOUNT_ISSUER to the issuer the subject belongs to (https://account.anoma.ly in production).');
  const context = systemContext('script', { type: 'operator', id: (await db.query<{ who: string }>('SELECT session_user AS who')).rows[0]!.who });
  const d = drizzle(db), till = sql`${until}::date::timestamptz`;
  if (kind === 'workspace') {
    const { rows: [row] } = await d.execute<{ old: Record<string, unknown>; new: Record<string, unknown> }>(sql`WITH ws AS (SELECT id FROM workspaces WHERE id=${target}),
        changed AS (SELECT id, billing_free_state(id) AS before, billing_set_workspace_free(id,${on},${reason},${till},'script') AS after FROM ws),
        audit AS (${auditInsert(context, { action: on ? 'billing.free_on' : 'billing.free_off', workspaceId: sql`changed.id`, target: { type: 'workspace', id: sql`changed.id` },
          before: sql`changed.before`, after: sql`changed.after`, details: { until }, reason, retention: 'billing' }, { from: sql`changed` })})
      SELECT before AS old, after AS new FROM changed`);
    if (!row) throw new Error('No workspace with this ID.');
    log('info', { code: 'BILLING_FREE_CHANGED', workspaceId: target, old: row.old, new: row.new, until });
    return row;
  }
  // One audit row for the person, and one for each workspace they own (its own trail shows why it became free).
  const { rows: [row] } = await d.execute<{ userId: string; workspaces: { workspaceId: string; free: boolean; via: string | null; mode: string }[] }>(sql`WITH u AS (SELECT user_id AS id FROM nightmail_oidc_identities WHERE issuer=${issuer} AND subject=${target}),
      changed AS (SELECT id, billing_set_person_free(id,${on},${reason},${till},'script') AS workspaces FROM u),
      person AS (${auditInsert(context, { action: on ? 'billing.free_account_on' : 'billing.free_account_off', workspaceId: null, userId: sql`changed.id`, target: { type: 'user', id: sql`changed.id` },
        after: sql`jsonb_build_object('workspaces', (SELECT jsonb_agg(w->'workspaceId') FROM jsonb_array_elements(changed.workspaces) w))`, details: { until }, reason, retention: 'billing' }, { from: sql`changed` })}),
      owned AS (${auditInsert(context, { action: on ? 'billing.free_owner_on' : 'billing.free_owner_off', workspaceId: sql`w->>'workspaceId'`, userId: sql`changed.id`, target: { type: 'workspace', id: sql`w->>'workspaceId'` },
        after: sql`w - 'workspaceId'`, reason, retention: 'billing' }, { from: sql`changed CROSS JOIN LATERAL jsonb_array_elements(changed.workspaces) w` })})
    SELECT id AS "userId", workspaces FROM changed`);
  if (!row) throw new Error('No user with that subject has signed in at this issuer.');
  log('info', { code: 'BILLING_FREE_ACCOUNT_CHANGED', userId: row.userId, workspaces: row.workspaces.length });
  return row;
}

if (import.meta.main) {
  const db = new Client(postgresConnection(process.env.DATABASE_URL));
  await db.connect();
  try { await setBillingFree(db, process.argv.slice(2)); } finally { await db.end(); }
}
