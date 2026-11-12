import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { FeedbackItem, Runtime } from '../core.js';

// The feedback queue is an account-level resource: any Worker in the same Cloudflare account can
// bind it as a producer. Items are therefore tagged with a MAC under the installation secret when
// they leave the request path, and the tagged lane's consumer only ingests items that carry a valid tag.
const macKey = (secret: string) => hkdfSync('sha256', secret, '', 'bane:feedback-queue:v1', 32);
const canonical = (item: Omit<FeedbackItem, 'mac'>) => JSON.stringify([item.region, item.topicArn, item.messageId, item.topicKind ?? null, item.message]);
export function feedbackMac(secret: string, item: Omit<FeedbackItem, 'mac'>): string {
  return createHmac('sha256', macKey(secret)).update(canonical(item)).digest('base64url');
}
export type FeedbackSecrets = { authSecret: string; previousAuthSecret?: string };
/**
 * Whether a queued item was tagged by this installation (the current or, during rotation, the previous
 * secret). Total over any queue body: a foreign producer controls every byte, so nothing here throws.
 */
export function authenticFeedback(secrets: FeedbackSecrets, item: unknown): item is FeedbackItem & { mac: string } {
  if (typeof item !== 'object' || item === null) return false;
  const { mac, ...body } = item as FeedbackItem;
  if (typeof mac !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(mac)) return false;
  let given: Buffer; try { given = Buffer.from(mac, 'ascii'); } catch { return false; }
  for (const secret of [secrets.authSecret, secrets.previousAuthSecret]) {
    if (!secret) continue;
    let expected: Buffer; try { expected = Buffer.from(feedbackMac(secret, body), 'ascii'); } catch { return false; }
    if (expected.length === given.length && timingSafeEqual(given, expected)) return true;
  }
  return false;
}

// Verified provider feedback (and simulated callbacks) leave the request path through the
// feedback queue in batches of at most 100 messages; the queue consumer ingests them in bulk.
export function feedbackSink(queue: Queue<FeedbackItem>, secret: string): NonNullable<Runtime['feedback']> {
  return { enqueue: async items => {
    const tagged = items.map(item => { const { mac: _, ...body } = item; return { body: { ...body, mac: feedbackMac(secret, body) } }; });
    for (let i = 0; i < tagged.length; i += 100) await queue.sendBatch(tagged.slice(i, i + 100));
  } };
}

// Signal already-committed jobs immediately. Never coalesce a later commit into a wake
// which may already have drained the queue. Delayed retry reservations are separate.
export function workWake(queue: Queue, concurrency: number): NonNullable<Runtime['wake']> {
  return async (readyJobs = 1) => {
    const count = Math.min(8, Math.max(1, Math.ceil(readyJobs / concurrency)));
    if (count === 1) await queue.send({ kind: 'wake' });
    else await queue.sendBatch(Array.from({ length: count }, () => ({ body: { kind: 'wake' } })));
  };
}

const invalidFeedback = new Set(['SES_INVALID_EVENT', 'SES_UNSUPPORTED_EVENT', 'SES_ACCOUNT_MISMATCH', 'SES_ENVIRONMENT_MISMATCH', 'SIMULATED_FEEDBACK_FORBIDDEN', 'SIMULATED_FEEDBACK_UNSUPPORTED']);
export function settleFeedbackMessage(message: Pick<Message, 'attempts' | 'retry' | 'ack'> & {body?:FeedbackItem}, outcome?: { ok: boolean; error?: string }) {
  if (outcome?.ok || outcome?.error === 'SES_FEEDBACK_QUARANTINED' || (outcome?.error && invalidFeedback.has(outcome.error))) return message.ack();
  // A recent pool event might race the acceptance write. Keep its recovery chain.
  // A missing owner on a customer-controlled topic or beyond detail retention is
  // routine. One short retry covers normal propagation; it must not page the DLQ.
  if(outcome?.error==='SES_FEEDBACK_UNMATCHED' && message.attempts>1 && message.body) {
    const item=message.body,stamp=(item.message.mail as {timestamp?:string}|undefined)?.timestamp;
    if(item.topicKind==='byo' || (stamp && Date.parse(stamp)<Date.now()-30*86400000)) {message.ack();return 'retired_unmatched';}
  }
  message.retry({ delaySeconds: Math.min(300, 15 * 2 ** message.attempts) });
}

/**
 * The tagged lane (`FEEDBACK_QUEUE`) carries only items this installation tagged; the legacy lane is the
 * queue the previous Worker version wrote to without tags and is consumed, untagged items included,
 * until it and its dead letters are drained and the binding is removed. An item that fails the lane's
 * check is dead-lettered on its own and acknowledged, so it is kept for review without a retry and
 * without affecting the other messages in the batch; if the dead-letter send fails it is retried later.
 */
export type FeedbackLane = 'tagged' | 'legacy';
type FeedbackMessage = Pick<Message, 'attempts' | 'retry' | 'ack'> & { body: unknown };
export async function settleFeedbackBatch(options: {
  secrets: FeedbackSecrets; lane: FeedbackLane; messages: readonly FeedbackMessage[];
  ingest: (items: FeedbackItem[]) => Promise<{ ok: boolean; error?: string }[]>; deadLetter: (body: unknown) => Promise<void>;
}) {
  const { secrets, lane, messages, ingest, deadLetter } = options;
  const accepted = messages.map(message => {
    const body = message.body as FeedbackItem | null;
    if (authenticFeedback(secrets, body)) return true;
    // Legacy lane: an untagged item is what the previous version queued. A tagged item that fails is not.
    return lane === 'legacy' && typeof body === 'object' && body !== null && !('mac' in body);
  });
  const ingested = await ingest(messages.filter((_, index) => accepted[index]).map(message => message.body as FeedbackItem));
  const outcomes = accepted.map(ok => ok ? ingested.shift()! : { ok: false, error: 'FEEDBACK_UNAUTHENTICATED' });
  let retiredUnmatched = 0, deadLettered = 0, held = 0;
  for (const [index, message] of messages.entries()) {
    if (accepted[index]) { if (settleFeedbackMessage(message as Pick<Message, 'attempts' | 'retry' | 'ack'> & { body?: FeedbackItem }, outcomes[index]) === 'retired_unmatched') retiredUnmatched++; continue; }
    try { await deadLetter(message.body); message.ack(); deadLettered++; }
    catch { message.retry({ delaySeconds: 60 }); held++; }
  }
  const unauthenticated = accepted.filter(ok => !ok).length;
  return { outcomes, unauthenticated, deadLettered, held, retiredUnmatched, failed: outcomes.filter(outcome => !outcome.ok).length - retiredUnmatched - unauthenticated };
}
