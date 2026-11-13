import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { parseArgs } from 'node:util';
import { Client } from 'pg';
import { postgresConnection } from '../src/adapters/node.js';
import { auditInsert, systemContext } from '../src/audit.js';
import { log } from '../src/core.js';

const MODES = ['prepaid', 'invoiced', 'exempt'] as const;

/**
 * Sets a workspace's billing mode: prepaid (the default: usage comes off the balance and sending stops at $0),
 * invoiced (usage is charged, the balance may go negative, nothing stops) or exempt (free: the workspace's free flag,
 * with no end; usage is recorded at $0). prepaid and invoiced clear the workspace's free flag; a free owner's account
 * still keeps it free (set-billing-free.ts). The change and its audit row (billing.mode, kept 7 years) commit in one
 * statement, or neither does.
 */
export async function setBillingMode(db: Client, args: string[]) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { reason: { type: 'string' } } });
  const [wid, mode] = positionals, reason = values.reason?.trim();
  if (positionals.length !== 2 || !wid || !MODES.includes(mode as typeof MODES[number]) || !reason || reason.length < 10)
    throw new Error('Usage: set-billing-mode.ts WORKSPACE_ID prepaid|invoiced|exempt --reason "why (at least 10 characters)"');
  const context = systemContext('script', { type: 'operator', id: (await db.query<{ who: string }>('SELECT session_user AS who')).rows[0]!.who });
  const { rows: [row] } = await drizzle(db).execute<{ old: string; new: string }>(sql`WITH changed AS (SELECT billing_set_mode(${wid},${mode},${reason},'script') AS r),
      audit AS (${auditInsert(context, { action: 'billing.mode', workspaceId: wid, target: { type: 'workspace', id: wid }, before: sql`jsonb_build_object('mode', r->>'old')`,
        after: sql`jsonb_build_object('mode', r->>'mode')`, reason, retention: 'billing' }, { from: sql`changed`, where: sql`r IS NOT NULL` })})
    SELECT r->>'old' AS old, r->>'mode' AS new FROM changed WHERE r IS NOT NULL`);
  if (!row) throw new Error('No workspace with this ID.');
  log('info', { code: 'BILLING_MODE_CHANGED', workspaceId: wid, ...row, reason, via: 'script' });
  return { ...row, reason, via: 'script' as const };
}

if (import.meta.main) {
  const db = new Client(postgresConnection(process.env.DATABASE_URL));
  await db.connect();
  try { await setBillingMode(db, process.argv.slice(2)); } finally { await db.end(); }
}
