import { parseArgs } from 'node:util';
import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { postgresConnection } from '../src/adapters/node.js';
import { resumeHostedSending } from '../src/states.js';
import { log } from '../src/core.js';

// Resumes a paused Hosted workspace after review. The resume keeps the sender's history, restores 50% of the limit for
// 48 hours (--restore 100 for all of it), re-enables the SES tenants and writes hosted_operator_audit, in one statement.
export async function resumeHosted(db: Client, args: string[]) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { reason: { type: 'string' }, restore: { type: 'string', default: '50' } } });
  const [wid] = positionals, reason = values.reason?.trim();
  if (positionals.length !== 1 || !wid || !reason || reason.length < 10 || !['50', '100'].includes(values.restore!)) throw new Error('Usage: resume-hosted-sending.ts WORKSPACE_ID --reason "why (at least 10 characters)" [--restore 50|100]');
  const result = await drizzle(db).execute(resumeHostedSending(wid, { reason, percent: Number(values.restore) as 50 | 100 }));
  if (!result.rowCount) throw new Error('No paused Hosted connection for this workspace.');
  log('info', { code: 'HOSTED_SENDING_RESUMED', workspaceId: wid, restorePercent: Number(values.restore) });
}

if (import.meta.main) {
  const db = new Client(postgresConnection(process.env.DATABASE_URL));
  await db.connect();
  try { await resumeHosted(db, process.argv.slice(2)); } finally { await db.end(); }
}
