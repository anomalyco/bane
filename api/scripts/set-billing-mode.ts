import { parseArgs } from 'node:util';
import { Client } from 'pg';
import { postgresConnection } from '../src/adapters/node.js';
import { log } from '../src/core.js';

const MODES = ['prepaid', 'invoiced', 'exempt'] as const;

/**
 * Sets a workspace's billing mode: prepaid (the default: usage comes off the balance and sending stops at $0),
 * invoiced (usage is charged, the balance may go negative, nothing stops) or exempt (free: the workspace's free flag,
 * with no end; usage is recorded at $0). prepaid and invoiced clear the workspace's free flag; a free owner's account
 * still keeps it free (set-billing-free.ts). The change and its audit row commit in one statement, or neither does.
 */
export async function setBillingMode(db: Client, args: string[]) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { reason: { type: 'string' } } });
  const [wid, mode] = positionals, reason = values.reason?.trim();
  if (positionals.length !== 2 || !wid || !MODES.includes(mode as typeof MODES[number]) || !reason || reason.length < 10)
    throw new Error('Usage: set-billing-mode.ts WORKSPACE_ID prepaid|invoiced|exempt --reason "why (at least 10 characters)"');
  const { rows: [audit] } = await db.query(`WITH changed AS (SELECT billing_set_mode($1,$2,$3,'script') AS r)
    INSERT INTO hosted_operator_audit(workspace_id,action,details)
    SELECT $1,'set-billing-mode',jsonb_build_object('old',r->>'old','new',r->>'mode','reason',$3::text,'via','script') FROM changed WHERE r IS NOT NULL RETURNING details`, [wid, mode, reason]);
  if (!audit) throw new Error('No workspace with this ID.');
  log('info', { code: 'BILLING_MODE_CHANGED', workspaceId: wid, ...audit.details });
  return audit.details as { old: string; new: string };
}

if (import.meta.main) {
  const db = new Client(postgresConnection(process.env.DATABASE_URL));
  await db.connect();
  try { await setBillingMode(db, process.argv.slice(2)); } finally { await db.end(); }
}
