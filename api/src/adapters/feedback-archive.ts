import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { parse, stringifyAsync } from 'devalue';
import type { FeedbackSecrets } from './feedback-queue.js';

export type FeedbackSource = { queue: string; id: string; enqueuedAt: string; attempts: number };
export type FeedbackArchive = { archive: 'feedback-archive-v1'; encoding: 'devalue@6.0.3'; source: FeedbackSource; error: string; payload: string; mac: string };
const mac = (secret: string, value: Omit<FeedbackArchive, 'mac'>) => createHmac('sha256', hkdfSync('sha256', secret, '', 'bane:feedback-archive:v1', 32))
  .update(JSON.stringify([value.encoding, value.source.queue, value.source.id, value.source.enqueuedAt, value.source.attempts, value.error, value.payload])).digest('base64url');

// Queues may contain structured-clone values, not just provider JSON. Keep cycles, bigint, bytes,
// dates, maps and sets rather than replacing an unserializable body with a diagnostic preview.
export async function feedbackArchive(secret: string, source: FeedbackSource, body: unknown, error: string): Promise<FeedbackArchive> {
  if (!source.queue || !source.id || !Number.isFinite(Date.parse(source.enqueuedAt))) throw new Error('Missing platform feedback provenance');
  const payload = await stringifyAsync(body, {
    Error: value => value instanceof Error && [value.name, value.message, value.stack, value.cause, Object.entries(value)],
    Blob: value => typeof Blob !== 'undefined' && value instanceof Blob && [value.type, value.arrayBuffer()],
  });
  const record = { archive: 'feedback-archive-v1' as const, encoding: 'devalue@6.0.3' as const, source, error, payload };
  return { ...record, mac: mac(secret, record) };
}
export function authenticFeedbackArchive(secrets: FeedbackSecrets, value: unknown): value is FeedbackArchive {
  try {
    const r = value as FeedbackArchive;
    if (r?.archive !== 'feedback-archive-v1' || r.encoding !== 'devalue@6.0.3' || typeof r.payload !== 'string' || typeof r.error !== 'string' ||
      !r.source || typeof r.source.queue !== 'string' || !r.source.queue || typeof r.source.id !== 'string' || !r.source.id ||
      !Number.isFinite(Date.parse(r.source.enqueuedAt)) || !Number.isSafeInteger(r.source.attempts) || r.source.attempts < 1 ||
      typeof r.mac !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(r.mac)) return false;
    return [secrets.authSecret, secrets.previousAuthSecret].some(secret => !!secret && timingSafeEqual(Buffer.from(r.mac, 'ascii'), Buffer.from(mac(secret, r), 'ascii')));
  } catch { return false; }
}
/** Call only after checking the archive MAC. Parsing is data-only, never eval. */
export function feedbackArchiveBody(record: FeedbackArchive): unknown {
  return parse(record.payload, {
    Error: ([name, message, stack, cause, entries]: [string, string, string | undefined, unknown, [string, unknown][]]) => {
      const error = new Error(message, { cause }); error.name = name; error.stack = stack;
      for (const [key, value] of entries) Object.defineProperty(error, key, { value, enumerable: true, writable: true, configurable: true });
      return error;
    },
    Blob: ([type, bytes]: [string, ArrayBuffer]) => new Blob([bytes], { type }),
  });
}
