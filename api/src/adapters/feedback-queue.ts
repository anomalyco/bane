import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { FeedbackItem, Runtime } from '../core.js';

// The feedback queue is an account-level resource: any Worker in the same Cloudflare account can
// bind it as a producer. Items are therefore tagged with a MAC under the installation secret when
// they leave the request path, and the consumer only ingests items that carry a valid tag.
const macKey = (secret: string) => hkdfSync('sha256', secret, '', 'bane:feedback-queue:v1', 32);
const canonical = (item: Omit<FeedbackItem, 'mac'>) => JSON.stringify([item.region, item.topicArn, item.messageId, item.topicKind ?? null, item.message]);
export function feedbackMac(secret: string, item: Omit<FeedbackItem, 'mac'>): string {
  return createHmac('sha256', macKey(secret)).update(canonical(item)).digest('base64url');
}
/** Whether a queued item was tagged by this installation (the current or, during rotation, the previous secret). */
export function authenticFeedback(secrets: { authSecret: string; previousAuthSecret?: string }, item: FeedbackItem): boolean {
  if (typeof item?.mac !== 'string' || item.mac.length !== 43) return false;
  const { mac, ...body } = item;
  const given = Buffer.from(mac);
  for (const secret of [secrets.authSecret, secrets.previousAuthSecret]) {
    if (secret && timingSafeEqual(given, Buffer.from(feedbackMac(secret, body)))) return true;
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

const invalidFeedback = new Set(['SES_INVALID_EVENT', 'SES_UNSUPPORTED_EVENT', 'SES_ACCOUNT_MISMATCH', 'SES_ENVIRONMENT_MISMATCH', 'SIMULATED_FEEDBACK_FORBIDDEN', 'SIMULATED_FEEDBACK_UNSUPPORTED', 'FEEDBACK_UNAUTHENTICATED']);
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
