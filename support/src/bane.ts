import type { Env } from './env.js';
import { MissingSecret } from './tokens.js';

// Bane, from the support Worker's side. Two bindings to the same Bane Worker in the same account:
//
// - `BANE` → the `SupportPlatform` entrypoint (api/src/support-platform.ts, its source of truth): verify a handoff or an
//   email sender, mint and revoke a support grant, and grant-scoped GET /v1/support/* reads. No token: the binding is
//   the credential.
// - `BANE_API` → the default entrypoint, Bane's public API, as a customer of Bane would use it: the support@bane.mx
//   inbound address's own inbox key (BANE_SUPPORT_INBOX_KEY) reads support mail and sends replies and ticket emails.

export type PlatformReply<T = unknown> = { status: number; body: T; requestId: string | null; retryAfter: string | null };
export type Handoff = {
  id: string; kind: string; userId: string; email: string; role: string; workspace: { id: string; name: string };
  page: string | null; requestIds: string[]; shareContent: boolean; issuedAt: string; expiresAt: string;
  usedAt: string | null; grantId: string | null; message: string | null;
};
export type HandoffCheck = { ok: true; handoff: Handoff } | { ok: false; code: 'HANDOFF_INVALID' | 'HANDOFF_EXPIRED' | 'HANDOFF_NOT_FOUND' | 'SUPPORT_NOT_CONFIGURED' };
export type Evidence = { kind: 'dmarc'; result: 'pass'; aligned: true; messageId: string } | { kind: 'magic_link'; confirmedAt: string };
export type Grant = { id: string; token: string; userId: string; workspaceIds: string[]; ticketRef: string; contentShared: boolean; contentWorkspaceId: string | null; expiresAt: string };

/** The methods of Bane's SupportPlatform entrypoint, as this Worker calls them over RPC. */
export interface SupportPlatform {
  verifyHandoff(token: string): Promise<HandoffCheck>;
  verifyEmail(body: { email: string; evidence: Evidence; ticketRef?: string }): Promise<PlatformReply<{ verified: boolean; user: { id: string; name: string } | null; workspaces: { id: string; name: string; role: string }[] }>>;
  mintGrant(body: { userId: string; ticketRef: string; reason: string; verification: 'handoff' | 'dmarc' | 'magic_link'; handoffId?: string; workspaceIds?: string[]; ttlMinutes?: number }): Promise<PlatformReply<Grant>>;
  revokeGrant(grantId: string): Promise<PlatformReply<{ id: string; revoked: true }>>;
  read<T = unknown>(path: string, grant: string): Promise<PlatformReply<T>>;
}

export class BaneError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly requestId: string | null = null) { super(message); }
}

/** Bane's public API with the support address's inbox key, over the BANE_API binding. */
export function baneApi(env: Env) {
  const key = env.BANE_SUPPORT_INBOX_KEY;
  async function call<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    if (!key) throw new MissingSecret('BANE_SUPPORT_INBOX_KEY');
    const headers: Record<string, string> = { authorization: `Bearer ${key}`, accept: 'application/json', 'user-agent': 'bane-support' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    const response = await env.BANE_API.fetch(`${env.BANE_ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let parsed: unknown = null; try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!response.ok) {
      const error = (parsed as { error?: { code?: string; message?: string; requestId?: string } } | null)?.error;
      throw new BaneError(response.status, error?.code ?? 'BANE_ERROR', error?.message ?? `Bane answered ${response.status}`, error?.requestId ?? response.headers.get('x-request-id'));
    }
    return parsed as T;
  }
  return {
    /** A received message with its headers and verdicts (SPF, DKIM, DMARC), for sender checks. */
    message: (messageId: string) => call<InboundMessage>('GET', `/v1/inbound/messages/${encodeURIComponent(messageId)}?includeDelivery=true`),
    /** A new conversation from the support address (ticket emails, the chat follow-up thread). */
    startThread: (input: { to: string[]; subject: string; text: string; replyTo?: string[] }, idempotencyKey: string) =>
      call<{ id: string; threadId: string }>('POST', '/v1/inbound/threads', { addressId: env.SUPPORT_ADDRESS_ID, ...input }, idempotencyKey),
    /** A reply in an email conversation, only to the reviewed recipients (Bane refuses a reply whose recipients changed). */
    reply: (threadId: string, input: { replyToMessageId: string; text: string; to: string }, idempotencyKey: string) =>
      call<{ id: string; threadId: string }>('POST', `/v1/inbound/threads/${encodeURIComponent(threadId)}/reply`, {
        addressId: env.SUPPORT_ADDRESS_ID, replyToMessageId: input.replyToMessageId, text: input.text, to: [input.to], cc: [], expectedRecipients: { to: [input.to], cc: [], bcc: [] },
      }, idempotencyKey),
  };
}
export type BaneApi = ReturnType<typeof baneApi>;

export type InboundMessage = {
  id: string; threadId: string | null; direction: 'inbound' | 'outbound'; subject: string | null;
  from: { name: string | null; address: string } | string | null; fromAddress?: string;
  to?: unknown; cc?: unknown; replyTo?: unknown; text?: string | null;
  replyText?: string | null; messageId?: string | null; inReplyTo?: string | null; references?: unknown;
  headers?: { name: string; value: string }[]; verdicts?: Record<string, string | boolean>;
};

/** The sender address of a received message, whichever shape the API returns. */
export function senderOf(message: Pick<InboundMessage, 'from' | 'fromAddress'>): string | null {
  const from = message.from;
  const value = typeof from === 'string' ? from : from?.address ?? message.fromAddress ?? null;
  return value ? value.trim().toLowerCase() : null;
}
