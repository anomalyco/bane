import { drizzle } from 'drizzle-orm/node-postgres';
import { parseArgs } from 'node:util';
import { Client } from 'pg';
import { postgresConnection } from '../src/adapters/node.js';
import { log } from '../src/core.js';
import { pauseHostedByOperator } from '../src/states.js';

// Pauses a Hosted workspace after an operator's review, with the reason in hosted_operator_audit in the same statement.
// The hourly check never pauses an exempt (first-party) workspace; this is how an operator does. Undo it with
// resume-hosted-sending.ts.
//   node --import tsx scripts/pause-hosted-sending.ts WORKSPACE_ID --reason "why"
export async function pauseHosted(db: Client, args: string[]) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { reason: { type: 'string' } } });
  const [wid] = positionals, reason = values.reason?.trim();
  if (positionals.length !== 1 || !wid || !reason || reason.length < 10) throw new Error('Usage: pause-hosted-sending.ts WORKSPACE_ID --reason "why (at least 10 characters)"');
  const result = await drizzle(db).execute(pauseHostedByOperator(wid, reason));
  if (!result.rowCount) throw new Error('No unpaused Hosted connection for this workspace.');
  log('warn', { code: 'HOSTED_SENDING_OPERATOR_PAUSED', workspaceId: wid });
}

if (import.meta.main) {
  const db = new Client(postgresConnection(process.env.DATABASE_URL));
  await db.connect();
  try { await pauseHosted(db, process.argv.slice(2)); } finally { await db.end(); }
}
