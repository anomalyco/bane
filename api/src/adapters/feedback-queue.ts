import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { FeedbackItem, Runtime } from '../core.js';

// The feedback queue is an account-level resource: any Worker in the same Cloudflare account can
// bind it as a producer. Items are therefore tagged with a MAC under the installation secret when
// they leave the request path, and the tagged lane's consumer only ingests items that carry a valid tag.
const macKey = (secret: string, purpose = 'bane:feedback-queue:v1') => hkdfSync('sha256', secret, '', purpose, 32);
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

export type LegacyFeedbackRecovery = { recovery: 'legacy-feedback-v1'; source: { queue: string; id: string; enqueuedAt: string; cutover: string }; body: FeedbackItem; mac: string };
const recoveryMac = (secret: string, source: LegacyFeedbackRecovery['source'], body: FeedbackItem) =>
  createHmac('sha256', macKey(secret, 'bane:feedback-recovery:v1')).update(JSON.stringify([source.queue, source.id, source.enqueuedAt, source.cutover, body])).digest('base64url');
/** Only the consumer may mint this, from platform metadata after the historical gate passed. */
function legacyRecovery(secret: string, source: LegacyFeedbackRecovery['source'], body: FeedbackItem): LegacyFeedbackRecovery {
  if (!source.queue || !source.id) throw new Error('Missing platform feedback provenance');
  return { recovery: 'legacy-feedback-v1', source, body, mac: recoveryMac(secret, source, body) };
}
export function authenticLegacyRecovery(secrets: FeedbackSecrets, value: unknown): value is LegacyFeedbackRecovery {
  try {
    const r = value as LegacyFeedbackRecovery;
    if (r?.recovery !== 'legacy-feedback-v1' || !r.source || typeof r.source.queue !== 'string' || !r.source.queue || typeof r.source.id !== 'string' || !r.source.id ||
      typeof r.mac !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(r.mac)) return false;
    const cutoff = legacyFeedbackCutover(r.source.cutover), stamp = Date.parse(r.source.enqueuedAt);
    if (!cutoff || !Number.isFinite(stamp) || stamp <= 0 || stamp >= cutoff || !unsignedFeedback(r.body)) return false;
    return [secrets.authSecret, secrets.previousAuthSecret].some(secret => !!secret && timingSafeEqual(Buffer.from(r.mac, 'ascii'), Buffer.from(recoveryMac(secret, r.source, r.body), 'ascii')));
  } catch { return false; }
}
export function authenticatedFeedbackItem(secrets: FeedbackSecrets, body: unknown): FeedbackItem | undefined {
  if (authenticLegacyRecovery(secrets, body)) return body.body;
  if (authenticFeedback(secrets, body)) return body;
}
const unsignedFeedback = (body: unknown): body is FeedbackItem => {
  if (!body || typeof body !== 'object' || Array.isArray(body) || 'mac' in body || 'refused' in body || 'recovery' in body) return false;
  const item = body as Partial<FeedbackItem>;
  return typeof item.region === 'string' && typeof item.topicArn === 'string' && typeof item.messageId === 'string' && !!item.message && typeof item.message === 'object' && !Array.isArray(item.message);
};

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
 * The tagged lane (`FEEDBACK_QUEUE`) carries what this installation
 * tagged; anything else on it is refused: wrapped, dead-lettered on its own and acknowledged, so it is kept
 * as evidence, never retried, and a replay of that dead letter is refused again. The legacy lane is the
 * queue the previous Worker version wrote to without tags: only messages the platform enqueued before
 * the fixed deployment cutover may drain unsigned. New or undated items are quarantined for review;
 * no body-supplied date establishes provenance. Tagged items are
 * verified like the tagged lane's. One message's verdict never changes another's; a quarantine or
 * dead-letter write that fails holds only that message for a later attempt.
 */
export type FeedbackLane = 'tagged' | 'legacy';
export type FeedbackVerdict = 'ingest' | 'legacy' | 'untagged' | 'refused';
/** Missing, malformed or future cutovers fail closed. Never derive this from a queued body. */
export function legacyFeedbackCutover(value: unknown, now = Date.now()): number | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return undefined;
  const cutover = Date.parse(value);
  return Number.isFinite(cutover) && cutover > 0 && cutover <= now ? cutover : undefined;
}
export function feedbackVerdict(secrets: FeedbackSecrets, lane: FeedbackLane, body: unknown, provenance?: { timestamp?: Date; cutover?: number }): FeedbackVerdict {
  if (authenticatedFeedbackItem(secrets, body)) return 'ingest';
  if (lane === 'legacy' && typeof body === 'object' && body !== null && !Array.isArray(body) && !('mac' in body) && !('refused' in body) && !('recovery' in body)) {
    const timestamp = provenance?.timestamp?.getTime(), cutover = provenance?.cutover;
    if (timestamp !== undefined && Number.isFinite(timestamp) && timestamp > 0 && cutover !== undefined && Number.isFinite(cutover) && cutover <= Date.now() && timestamp < cutover &&
      unsignedFeedback(body)) return 'legacy';
    return 'untagged';
  }
  return 'refused';
}
/** What a refused item looks like in the dead-letter queue: never a feedback item, whichever lane replays it. */
export type RefusedFeedback = { refused: 'FEEDBACK_UNAUTHENTICATED'; lane: FeedbackLane; source: { queue: string; id: string; enqueuedAt?: string }; body: unknown };
type FeedbackMessage = Pick<Message, 'id' | 'attempts' | 'retry' | 'ack'> & { body: unknown; timestamp?: Date };
export async function settleFeedbackBatch(options: {
  secrets: FeedbackSecrets; lane: FeedbackLane; sourceQueue: string; messages: readonly FeedbackMessage[]; legacyCutover?: number;
  ingest: (items: FeedbackItem[]) => Promise<{ ok: boolean; error?: string }[]>;
  /** Durably retain the complete signed envelope before enqueue/ack. A failed enqueue may stay archived. */
  promoteLegacy: (item: LegacyFeedbackRecovery) => Promise<void>;
  completeLegacy: (item: LegacyFeedbackRecovery) => Promise<void>;
  /** Stores an untagged legacy item for review; false when the quarantine is full, so it is dead-lettered instead. */
  quarantine: (body: unknown) => Promise<boolean>;
  deadLetter: (item: RefusedFeedback) => Promise<void>;
}) {
  const { secrets, lane, messages, ingest, quarantine, deadLetter } = options;
  const verdicts = messages.map(message => feedbackVerdict(secrets, lane, message.body, { timestamp: message.timestamp, cutover: options.legacyCutover }));
  let retiredUnmatched = 0, quarantined = 0, deadLettered = 0, held = 0, promoted = 0;
  // Preserve provenance before any unrelated ingestion can throw and retry the entire batch.
  for (const [index, message] of messages.entries()) if (verdicts[index] === 'legacy') {
    try {
      await options.promoteLegacy(legacyRecovery(secrets.authSecret, { queue: options.sourceQueue, id: message.id, enqueuedAt: message.timestamp!.toISOString(), cutover: new Date(options.legacyCutover!).toISOString() }, message.body as FeedbackItem));
      promoted++; message.ack();
    } catch { message.retry({ delaySeconds: 60 }); held++; }
  }
  const ingested = await ingest(messages.filter((_, index) => verdicts[index] === 'ingest').map(message => authenticatedFeedbackItem(secrets, message.body)!));
  const outcomes = verdicts.map(verdict => verdict === 'ingest' ? ingested.shift()! : verdict === 'legacy' ? { ok: true } : { ok: false, error: verdict === 'untagged' ? 'FEEDBACK_UNTAGGED' : 'FEEDBACK_UNAUTHENTICATED' });
  for (const [index, message] of messages.entries()) {
    const verdict = verdicts[index]!;
    if (verdict === 'legacy') continue;
    if (verdict === 'ingest') {
      if (outcomes[index]?.ok && authenticLegacyRecovery(secrets, message.body)) {
        try { await options.completeLegacy(message.body); } catch { message.retry({ delaySeconds: 60 }); held++; continue; }
      }
      if (settleFeedbackMessage({ attempts: message.attempts, ack: () => message.ack(), retry: options => message.retry(options), body: authenticatedFeedbackItem(secrets, message.body) }, outcomes[index]) === 'retired_unmatched') retiredUnmatched++;
      continue;
    }
    try {
      if (verdict === 'untagged' && await quarantine(message.body)) quarantined++;
      else { await deadLetter({ refused: 'FEEDBACK_UNAUTHENTICATED', lane, source: { queue: options.sourceQueue, id: message.id, enqueuedAt: message.timestamp && Number.isFinite(message.timestamp.getTime()) ? message.timestamp.toISOString() : undefined }, body: message.body }); deadLettered++; }
      message.ack();
    } catch { message.retry({ delaySeconds: 60 }); held++; }
  }
  const untagged = verdicts.filter(v => v === 'untagged').length, unauthenticated = verdicts.filter(v => v === 'refused').length;
  return { outcomes, untagged, unauthenticated, quarantined, deadLettered, held, promoted, retiredUnmatched, failed: outcomes.filter(outcome => !outcome.ok).length - retiredUnmatched - untagged - unauthenticated };
}
