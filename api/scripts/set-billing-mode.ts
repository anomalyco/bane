import { parseArgs } from 'node:util';
import { Client } from 'pg';
import { postgresConnection } from '../src/adapters/node.js';
import { log } from '../src/core.js';

const MODES = ['prepaid', 'invoiced', 'exempt'] as const;

/**
 * Sets a workspace's billing mode: prepaid (the default: usage comes off the balance and sending stops at $0),
 * invoiced (usage is charged, the balance may go negative, nothing stops) or exempt (usage is recorded at $0). The
 * account row, its change and the audit row commit together in one statement, or none of them do.
 */
export async function setBillingMode(db: Client, args: string[]) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { reason: { type: 'string' } } });
  const [wid, mode] = positionals, reason = values.reason?.trim();
  if (positionals.length !== 2 || !wid || !MODES.includes(mode as typeof MODES[number]) || !reason || reason.length < 10)
    throw new Error('Usage: set-billing-mode.ts WORKSPACE_ID prepaid|invoiced|exempt --reason "why (at least 10 characters)"');
  // A missing account row means prepaid. The workspace must exist; the account row outlives it once created.
  const { rows: [audit] } = await db.query(`WITH previous AS (
    SELECT mode FROM billing_accounts WHERE workspace_id=$1 FOR UPDATE
  ), changed AS (
    INSERT INTO billing_accounts(workspace_id,mode) SELECT id,$2 FROM workspaces WHERE id=$1
    ON CONFLICT (workspace_id) DO UPDATE SET mode=excluded.mode,updated_at=now() RETURNING workspace_id,mode
  ) INSERT INTO hosted_operator_audit(workspace_id,action,details)
    SELECT workspace_id,'set-billing-mode',jsonb_build_object('old',coalesce((SELECT mode FROM previous),'prepaid'),'new',mode,'reason',$3::text,'via','script') FROM changed
    RETURNING details`, [wid, mode, reason]);
  if (!audit) throw new Error('No workspace with this ID.');
  log('info', { code: 'BILLING_MODE_CHANGED', workspaceId: wid, ...audit.details });
  return audit.details as { old: string; new: string };
}

if (import.meta.main) {
  const db = new Client(postgresConnection(process.env.DATABASE_URL));
  await db.connect();
  try { await setBillingMode(db, process.argv.slice(2)); } finally { await db.end(); }
}
