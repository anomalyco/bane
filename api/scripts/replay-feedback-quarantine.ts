// Review and replay untagged items the legacy feedback queue quarantined (operation_feedback_failures,
// reason FEEDBACK_UNTAGGED). Without --apply it lists them; with --apply and reviewed ids it ingests
// those rows as verified feedback and removes the ones that were ingested. Needs the API's environment
// (DATABASE_URL and the hosted configuration), like the other operator scripts in this directory.
import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { postgresConnection } from '../src/adapters/node.js';
import { loadConfig } from '../src/config.js';
import { log, type Runtime } from '../src/core.js';
import { replayQuarantinedFeedback } from '../src/operations.js';

const args = process.argv.slice(2), apply = args.includes('--apply'), ids = args.filter(arg => arg !== '--apply');
if (ids.some(id => !/^untagged:[0-9a-f]{64}$/.test(id))) throw new Error('Pass quarantine ids as printed by the listing (untagged:<64 hex>).');
if (apply && !ids.length) throw new Error('--apply needs the reviewed ids.');
const client = new Client(postgresConnection(process.env.DATABASE_URL));
await client.connect();
const unused = async () => { throw new Error('Replay must not use application storage'); };
const runtime: Runtime = { config: loadConfig(process.env), db: drizzle(client), storage: { get: unused, put: unused, delete: unused } };
try {
  if (!apply) {
    const rows = (await runtime.db.execute<{ id: string; topic_arn: string | null; created_at: string; payload: string }>(sql`SELECT id,topic_arn,created_at::text,payload FROM operation_feedback_failures WHERE reason='FEEDBACK_UNTAGGED' ORDER BY created_at LIMIT 500`)).rows;
    for (const row of rows) {
      let summary: Record<string, unknown> = {};
      try { const v = JSON.parse(row.payload) as { region?: unknown; messageId?: unknown; message?: { eventType?: unknown; notificationType?: unknown; mail?: { messageId?: unknown } } };
        summary = { region: v.region, messageId: v.messageId, event: v.message?.eventType ?? v.message?.notificationType, providerMessageId: v.message?.mail?.messageId }; } catch { summary = { unparsable: true }; }
      log('info', { code: 'FEEDBACK_UNTAGGED_QUARANTINED', id: row.id, topicArn: row.topic_arn, createdAt: row.created_at, ...summary });
    }
    log('info', { code: 'FEEDBACK_UNTAGGED_QUARANTINE_SIZE', rows: rows.length });
  } else {
    for (const result of await replayQuarantinedFeedback(runtime, ids)) log(result.ok ? 'info' : 'warn', { code: result.ok ? 'FEEDBACK_UNTAGGED_REPLAYED' : 'FEEDBACK_UNTAGGED_REPLAY_FAILED', id: result.id, error: result.error });
  }
} finally { await client.end(); }
