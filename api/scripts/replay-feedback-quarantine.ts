// Review and replay untagged items the legacy feedback queue quarantined (operation_feedback_failures,
// reason FEEDBACK_UNTAGGED). Without --apply it lists them; with --apply and reviewed ids it ingests
// only rows carrying a currently valid installation tag and removes those ingested. Recover unsigned
// rows from the original signed SNS evidence through /v1/events/ses, not by trusting an operator ID list.
// Needs the API's environment
// (DATABASE_URL and the hosted configuration), like the other operator scripts in this directory.
import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { postgresConnection } from '../src/adapters/node.js';
import { loadConfig } from '../src/config.js';
import { log, type Runtime } from '../src/core.js';
import { readFeedbackQuarantine, replayQuarantinedFeedback } from '../src/operations.js';
import { authenticFeedbackArchive, feedbackArchiveBody } from '../src/adapters/feedback-archive.js';

const args = process.argv.slice(2), apply = args.includes('--apply'), afterIndex = args.indexOf('--after');
const after = afterIndex < 0 ? undefined : args[afterIndex + 1];
if (afterIndex >= 0 && (!after || apply)) throw new Error('--after needs a listing cursor and cannot be combined with --apply');
const ids = args.filter((arg,index) => arg !== '--apply' && (afterIndex < 0 || index !== afterIndex && index !== afterIndex + 1));
if (after && !/^(?:untagged|legacy|queue):[0-9a-f]{64}$/.test(after)) throw new Error('Invalid recovery listing cursor');
if (ids.some(id => !/^(?:untagged|legacy|queue):[0-9a-f]{64}$/.test(id))) throw new Error('Pass recovery ids as printed by the listing (untagged:, legacy: or queue: followed by 64 hex characters).');
if (apply && !ids.length) throw new Error('--apply needs the reviewed ids.');
const client = new Client(postgresConnection(process.env.DATABASE_URL));
await client.connect();
const unused = async () => { throw new Error('Replay must not use application storage'); };
const runtime: Runtime = { config: loadConfig(process.env), db: drizzle(client), storage: { get: unused, put: unused, delete: unused } };
try {
  if (!apply) {
    const rows = await readFeedbackQuarantine(runtime,ids.length?ids:undefined,after);
    for (const row of rows) {
      let summary: Record<string, unknown> = {};
      try { const raw = JSON.parse(row.payload), body = authenticFeedbackArchive(runtime.config,raw) ? feedbackArchiveBody(raw) : raw, v = body?.recovery === 'legacy-feedback-v1' ? body.body : body;
        summary = { source: raw.source, reason: row.reason, region: v?.region, messageId: v?.messageId, event: v?.message?.eventType ?? v?.message?.notificationType, providerMessageId: v?.message?.mail?.messageId }; } catch { summary = { unparsable: true }; }
      log('info', { code: 'FEEDBACK_UNTAGGED_QUARANTINED', id: row.id, topicArn: row.topic_arn, createdAt: row.created_at, ...summary });
    }
    log('info', { code: 'FEEDBACK_UNTAGGED_QUARANTINE_SIZE', rows: rows.length, next: rows.length===500?rows.at(-1)?.id:undefined });
  } else {
    for (const result of await replayQuarantinedFeedback(runtime, ids)) log(result.ok ? 'info' : 'warn', { code: result.ok ? 'FEEDBACK_UNTAGGED_REPLAYED' : 'FEEDBACK_UNTAGGED_REPLAY_FAILED', id: result.id, error: result.error });
  }
} finally { await client.end(); }
