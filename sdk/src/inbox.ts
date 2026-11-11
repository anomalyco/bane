import type { Client } from './client/index.js';
import { listInboxMessages } from './sdk.gen.js';
import type { InboxMessage } from './types.gen.js';

export class InboxWaitTimeout extends Error {
  override name = 'InboxWaitTimeout';
}
export interface WaitForMessageOptions {
  /** The authenticated client; omit to use the default client. */
  client?: Client;
  inboxId: string;
  /** A message's `cursor`: wait for the next message after it. Omit to start at the first message. */
  after?: string;
  /** Only messages from this sender address. */
  from?: string;
  /** Only messages whose subject contains this text, ignoring case. */
  subjectContains?: string;
  /** Fills `message.extract`; both by default. */
  extract?: 'codes' | 'links' | 'codes,links';
  /** Give up after this long and throw `InboxWaitTimeout`. Default two minutes. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Resolve with the oldest matching message, including mail that arrived before the call, with
 * one-time codes and links already extracted from its visible text. Long-polls in 30-second calls.
 * Pass `message.cursor` as `after` to wait for the next one.
 */
export async function waitForMessage({ client, inboxId, timeoutMs = 120_000, signal, extract = 'codes,links', ...filters }: WaitForMessageOptions): Promise<InboxMessage> {
  const deadline = Date.now() + timeoutMs, timeout = AbortSignal.timeout(timeoutMs), bounded = signal ? AbortSignal.any([timeout, signal]) : timeout;
  let after = filters.after;
  try {
    while (Date.now() < deadline) {
      const wait = Math.min(30, Math.ceil((deadline - Date.now()) / 1000));
      const { data } = await listInboxMessages({ client, path: { id: inboxId }, query: { ...filters, after, extract, wait, limit: 1 }, signal: bounded, throwOnError: true });
      if (data.data[0]) return data.data[0];
      after = data.cursor;
    }
  } catch (e) {
    if (signal?.aborted) throw signal.reason;
    if (!timeout.aborted) throw e;
  }
  throw new InboxWaitTimeout(`No matching message in inbox ${inboxId} within ${Math.round(timeoutMs / 1000)} seconds.`);
}
