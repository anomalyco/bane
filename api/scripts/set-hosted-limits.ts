import { parseArgs } from 'node:util';
import { Client } from 'pg';
import { postgresConnection } from '../src/adapters/node.js';
import { log } from '../src/core.js';

function cap(value: string, flag: string, max: number) {
  if (value === 'default') return null;
  if (!/^[1-9]\d*$/.test(value) || Number(value) > max) throw new Error(`${flag} must be an integer from 1 to ${max}, or default.`);
  return Number(value);
}

export async function setHostedLimits(db: Client, args: string[]) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { 'send-cap': { type: 'string' }, 'pending-cap': { type: 'string' }, reason: { type: 'string' } } });
  const [wid] = positionals, reason = values.reason?.trim();
  if (!wid || positionals.length !== 1 || !values['send-cap'] || !values['pending-cap'] || !reason || reason.length < 10) throw new Error('Usage: set-hosted-limits.ts WORKSPACE_ID --send-cap <n|default> --pending-cap <n|default> --reason "why (at least 10 characters)"');
  const next = { sendCap: cap(values['send-cap'], '--send-cap', 10_000_000), pendingCap: cap(values['pending-cap'], '--pending-cap', 4_000_000) };
  // The change and its audit row commit together or not at all.
  const { rows: [old] } = await db.query(`WITH previous AS (
    SELECT w.id, w.send_cap_override, w.pending_cap_override FROM provider_connections c JOIN workspaces w ON w.id=c.workspace_id
    WHERE c.workspace_id = $1 AND c.kind = 'shared' FOR SHARE OF c FOR UPDATE OF w
  ), changed AS (UPDATE workspaces w SET send_cap_override = $2, pending_cap_override = $3 FROM previous p WHERE w.id = p.id
    RETURNING w.id, p.send_cap_override AS "sendCap", p.pending_cap_override AS "pendingCap"
  ), audit AS (INSERT INTO hosted_operator_audit(workspace_id,action,details) SELECT id,'set-hosted-limits',
    jsonb_build_object('old',jsonb_build_object('sendCap',"sendCap",'pendingCap',"pendingCap"),'new',jsonb_build_object('sendCap',$2::int,'pendingCap',$3::int),'reason',$4::text,'via','script') FROM changed)
  SELECT "sendCap","pendingCap" FROM changed`, [wid, next.sendCap, next.pendingCap, reason]);
  if (!old) throw new Error('No Hosted connection for this workspace.');
  log('info', { code: 'HOSTED_LIMITS_CHANGED', workspaceId: wid, old, new: next });
}

if (import.meta.main) {
  const db = new Client(postgresConnection(process.env.DATABASE_URL));
  await db.connect();
  try { await setHostedLimits(db, process.argv.slice(2)); }
  finally { await db.end(); }
}
