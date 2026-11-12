import { parseArgs } from 'node:util';
import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { postgresConnection } from '../src/adapters/node.js';
import { resumeHostedSending } from '../src/states.js';
import { log } from '../src/core.js';

// Resumes a paused or marketing-held Hosted workspace after review, in one statement with its audit row. The limit is
// min(current limit, 50% of the limit before the resume) for 48 hours (--restore 100 opts out, audited). A pause whose
// SES tenants were disabled restarts once the tenant job has enabled them again.
// The installation's limit tiers, as the API reads them (HOSTED_SEND_CAP_*), so the restore is a share of the same limit.
export const hostedCaps = (env: Record<string, string | undefined>) => ({ firstWeek: Number(env.HOSTED_SEND_CAP_FIRST_WEEK ?? 100), secondWeek: Number(env.HOSTED_SEND_CAP_SECOND_WEEK ?? 1000), mature: Number(env.HOSTED_SEND_CAP_MATURE ?? 10000) });
export async function resumeHosted(db: Client, args: string[], env: Record<string, string | undefined> = process.env) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { reason: { type: 'string' }, restore: { type: 'string', default: '50' } } });
  const [wid] = positionals, reason = values.reason?.trim();
  if (positionals.length !== 1 || !wid || !reason || reason.length < 10 || !['50', '100'].includes(values.restore!)) throw new Error('Usage: resume-hosted-sending.ts WORKSPACE_ID --reason "why (at least 10 characters)" [--restore 50|100]');
  const result = await drizzle(db).execute<{ pending: boolean }>(resumeHostedSending(wid, { reason, percent: Number(values.restore) as 50 | 100, caps: hostedCaps(env) }));
  if (!result.rowCount) throw new Error('No paused or marketing-held Hosted connection for this workspace.');
  log('info', { code: 'HOSTED_SENDING_RESUMED', workspaceId: wid, restorePercent: Number(values.restore), waitsForTenants: result.rows[0]!.pending });
}

if (import.meta.main) {
  const db = new Client(postgresConnection(process.env.DATABASE_URL));
  await db.connect();
  try { await resumeHosted(db, process.argv.slice(2)); } finally { await db.end(); }
}
