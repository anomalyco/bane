import type { Env } from './env.js';
import { readCapped } from './attachments.js';
import { MissingSecret } from './tokens.js';
import { productName } from '../../api/src/brand.js';

// Nightmail, from the support Worker's side. Two bindings to the same Nightmail Worker in the same account:
//
// - `BANE` → the `SupportPlatform` entrypoint (api/src/support-platform.ts, its source of truth): verify a handoff or an
//   email sender, mint and revoke a support grant, and grant-scoped GET /v1/support/* reads. No token: the binding is
//   the credential.
// - `BANE_API` → the default entrypoint, Nightmail's public API, as a customer of Nightmail would use it: the support@bane.mx
//   inbound address's own API key (BANE_SUPPORT_INBOX_KEY, limited to that address) reads support mail and sends replies and ticket emails.

export type PlatformReply<T = unknown> = { status: number; body: T; requestId: string | null; retryAfter: string | null };
export type Handoff = {
  id: string; kind: string; userId: string; email: string; role: string; workspace: { id: string; name: string };
  page: string | null; requestIds: string[]; shareContent: boolean; issuedAt: string; expiresAt: string;
  usedAt: string | null; grantId: string | null; message: string | null;
};
export type HandoffCheck = { ok: true; handoff: Handoff } | { ok: false; code: 'HANDOFF_INVALID' | 'HANDOFF_EXPIRED' | 'HANDOFF_NOT_FOUND' | 'SUPPORT_NOT_CONFIGURED' };
export type Evidence = { kind: 'dmarc'; result: 'pass'; aligned: true; messageId: string } | { kind: 'magic_link'; confirmedAt: string };
export type Grant = { id: string; token: string; userId: string; workspaceIds: string[]; ticketRef: string; contentShared: boolean; contentWorkspaceId: string | null; expiresAt: string };

/** The methods of Nightmail's SupportPlatform entrypoint, as this Worker calls them over RPC. */
export interface SupportPlatform {
  verifyHandoff(token: string): Promise<HandoffCheck>;
  verifyEmail(body: { email: string; evidence: Evidence; ticketRef?: string }): Promise<PlatformReply<{ verified: boolean; user: { id: string; name: string } | null; workspaces: { id: string; name: string; role: string }[] }>>;
  mintGrant(body: { userId: string; ticketRef: string; reason: string; verification: 'handoff' | 'dmarc' | 'magic_link'; handoffId?: string; workspaceIds?: string[]; ttlMinutes?: number }): Promise<PlatformReply<Grant>>;
  revokeGrant(grantId: string): Promise<PlatformReply<{ id: string; revoked: true }>>;
  read<T = unknown>(path: string, grant: string): Promise<PlatformReply<T>>;
  /** A staff sign-in token from Nightmail's operator check: still an active operator? (staff.ts) */
  verifyStaff(token: string): Promise<{ ok: true; staff: { userId: string; email: string; role: string }; jti: string; expiresAt: string } | { ok: false; code: 'STAFF_INVALID' | 'STAFF_EXPIRED' | 'NOT_OPERATOR' }>;
}

export class BaneError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly requestId: string | null = null) { super(message); }
}

/**
 * Nightmail's public API over the BANE_API binding, with the support address's API key, or (`intake`) the key for the
 * abuse@, privacy@ and legal@ addresses.
 */
export function baneApi(env: Env, which: 'support' | 'intake' = 'support') {
  const key = which === 'intake' ? env.BANE_INTAKE_INBOX_KEY : env.BANE_SUPPORT_INBOX_KEY, secret = which === 'intake' ? 'BANE_INTAKE_INBOX_KEY' : 'BANE_SUPPORT_INBOX_KEY';
  async function call<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    if (!key) throw new MissingSecret(secret);
    const headers: Record<string, string> = { authorization: `Bearer ${key}`, accept: 'application/json', 'user-agent': 'bane-support' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    const response = await env.BANE_API.fetch(`${env.BANE_ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let parsed: unknown = null; try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!response.ok) {
      const error = (parsed as { error?: { code?: string; message?: string; requestId?: string } } | null)?.error;
      throw new BaneError(response.status, error?.code ?? 'BANE_ERROR', error?.message ?? `${productName} answered ${response.status}`, error?.requestId ?? response.headers.get('x-request-id'));
    }
    return parsed as T;
  }
  return {
    /**
     * A received message with the sender's authentication results (SPF, DKIM, DMARC) and Nightmail's automated-mail flag, for
     * sender checks. Address-limited API keys can't read the delivery projection (envelopes, headers), and don't need it.
     */
    message: (messageId: string) => call<InboundMessage>('GET', `/v1/inbound/messages/${encodeURIComponent(messageId)}?includeAuthentication=true`),
    /** One attachment's bytes (≤ limit, else null), through the short-lived signed link Nightmail returns for it. */
    async part(messageId: string, partId: string, limit: number): Promise<Uint8Array | null> {
      const { url } = await call<{ url: string }>('GET', `/v1/inbound/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(partId)}`);
      // Mail stored in R2 is served by Nightmail itself: stay on the binding for Nightmail's origin, and fetch other storage directly.
      // Workers have no redirect: 'error'; a redirect is not followed, and fails the ok check below.
      const response = new URL(url).origin === new URL(env.BANE_ORIGIN).origin ? await env.BANE_API.fetch(url, { redirect: 'manual' }) : await fetch(url, { redirect: 'manual' });
      if (!response.ok) throw new BaneError(response.status, 'ATTACHMENT_UNAVAILABLE', `Storage answered ${response.status} for an attachment`);
      if (Number(response.headers.get('content-length') ?? 0) > limit) { await response.body?.cancel(); return null; }
      return readCapped(response.body, limit);
    },
    /** A new conversation from the support address (ticket emails, the chat follow-up thread). */
    startThread: (input: { to: string[]; subject: string; text: string; replyTo?: string[] }, idempotencyKey: string) =>
      call<{ id: string; threadId: string }>('POST', '/v1/inbound/threads', { addressId: env.SUPPORT_ADDRESS_ID, ...input }, idempotencyKey),
    /** A reply in an email conversation, only to the reviewed recipients (Nightmail refuses a reply whose recipients changed). */
    /** addressId null: the address the message came in on (the intake key sees three). */
    reply: (threadId: string, input: { replyToMessageId: string; text: string; to: string; subject?: string; addressId?: string | null }, idempotencyKey: string) =>
      call<{ id: string; threadId: string }>('POST', `/v1/inbound/threads/${encodeURIComponent(threadId)}/reply`, {
        ...(input.addressId === null ? {} : { addressId: input.addressId ?? env.SUPPORT_ADDRESS_ID }), replyToMessageId: input.replyToMessageId, text: input.text, to: [input.to], cc: [], expectedRecipients: { to: [input.to], cc: [], bcc: [] },
        ...(input.subject ? { subject: input.subject } : {}),
      }, idempotencyKey),
  };
}
export type BaneApi = ReturnType<typeof baneApi>;

export type InboundMessage = {
  id: string; threadId: string | null; direction: 'inbound' | 'outbound'; subject: string | null;
  from: { name: string | null; address: string } | string | null; fromAddress?: string;
  to?: unknown; cc?: unknown; replyTo?: unknown; text?: string | null;
  replyText?: string | null; messageId?: string | null; inReplyTo?: string | null; references?: unknown;
  attachments?: { id: string; filename: string | null; contentType: string; size: number; disposition?: string }[];
  /** With includeAuthentication=true. dmarc is PASS when the From domain aligns with a passing SPF or DKIM result. */
  authentication?: { spf: string | null; dkim: string | null; dmarc: string | null };
  /** Nightmail's flag for auto-replies, bounces, delivery reports, and bulk or list mail. */
  automated?: boolean;
};

/** The sender address of a received message, whichever shape the API returns. */
export function senderOf(message: Pick<InboundMessage, 'from' | 'fromAddress'>): string | null {
  const from = message.from;
  const value = typeof from === 'string' ? from : from?.address ?? message.fromAddress ?? null;
  return value ? value.trim().toLowerCase() : null;
}
