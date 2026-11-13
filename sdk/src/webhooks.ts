/** Fetch `Headers`, or a Node/Express-style object such as `req.headers`. */
export type WebhookHeaders = Headers | Record<string, string | string[] | undefined>;
export interface VerifyWebhookOptions {
  /** Largest accepted clock difference, in seconds. Default 300. */
  toleranceSeconds?: number;
}
const header = (headers: WebhookHeaders, name: string) => {
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name);
  const record = headers as Record<string, string | string[] | undefined>;
  const value = record[name] ?? record[name.toLowerCase()] ?? Object.entries(record).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  return (Array.isArray(value) ? value[0] : value) ?? null;
};
const base64 = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

/**
 * Verifies a Bane webhook delivery, in either format, before you parse it: the Standard Webhooks
 * HMAC-SHA256 signature over the exact request body, and a timestamp within five minutes.
 * Pass the unparsed body, the request headers and the `whsec_…` secret returned when the webhook
 * was created or rotated. Returns false instead of throwing. Deduplicate deliveries by `Webhook-Id`.
 *
 * ```ts
 * const body = await request.text();
 * if (!(await verifyWebhook(body, request.headers, process.env.NIGHTMAIL_WEBHOOK_SECRET!))) return new Response(null, { status: 401 });
 * const payload: InboundWebhookPayload = JSON.parse(body);
 * ```
 */
export async function verifyWebhook(
  body: string | Uint8Array,
  headers: WebhookHeaders,
  secret: string,
  { toleranceSeconds = 300 }: VerifyWebhookOptions = {},
): Promise<boolean> {
  const id = header(headers, 'webhook-id'),
    timestamp = header(headers, 'webhook-timestamp'),
    signature = header(headers, 'webhook-signature');
  if (!id || !timestamp || !/^\d+$/.test(timestamp) || !signature || !secret.startsWith('whsec_')) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSeconds) return false;
  try {
    const rawKey = base64(secret.slice('whsec_'.length));
    if (rawKey.length !== 32) return false;
    const key = await crypto.subtle.importKey('raw', rawKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const encoder = new TextEncoder(),
      prefix = encoder.encode(`${id}.${timestamp}.`),
      content = typeof body === 'string' ? encoder.encode(body) : body;
    const signed = new Uint8Array(prefix.length + content.length);
    signed.set(prefix);
    signed.set(content, prefix.length);
    // Several space-separated signatures can be present while a secret is being rotated.
    for (const candidate of signature.split(/\s+/))
      if (candidate.startsWith('v1,') && (await crypto.subtle.verify('HMAC', key, base64(candidate.slice(3)), signed))) return true;
  } catch {
    // A malformed secret or signature never verifies.
  }
  return false;
}

export interface InboundAddressGroup {
  text: string;
  addresses: { name: string | null; address: string }[];
}
export interface InboundAttachment {
  filename: string;
  contentType: string;
  size: number;
  contentId: string | null;
  contentDisposition: 'attachment' | 'inline';
  /** GET with an admin API key; redirects to a short-lived download. */
  downloadUrl: string;
}
/**
 * The body of an `inbound`-format webhook: inbound.new's `email.received`, so receivers written
 * for it keep working. Bane also sends its Standard Webhooks headers; verify those with
 * `verifyWebhook` rather than relying on `X-Webhook-Verification-Token`.
 */
export interface InboundWebhookPayload {
  event: 'email.received';
  timestamp: string;
  endpoint: { id: string; name: string; type: 'webhook' };
  email: {
    /** Bane's message ID (msg_…). */
    id: string;
    messageId: string;
    from: InboundAddressGroup;
    to: InboundAddressGroup;
    /** The recipient this delivery was routed for. */
    recipient: string;
    /** Every envelope recipient in this workspace, including Bcc. */
    envelopeRecipients: string[];
    subject: string;
    receivedAt: string;
    threadId: string | null;
    spam: { isJunk: boolean; reason: 'ses_spam' | 'guard_rule' | 'user' | 'classifier' | null };
    parsedData: {
      messageId: string;
      date: string;
      subject: string;
      from: InboundAddressGroup;
      to: InboundAddressGroup;
      cc: InboundAddressGroup | null;
      bcc: null;
      replyTo: InboundAddressGroup | null;
      inReplyTo?: string;
      references?: string[];
      textBody: string | null;
      htmlBody: string | null;
      /** The original MIME up to 2 MiB; otherwise null, and rawUrl downloads it. */
      raw: string | null;
      rawUrl?: string;
      attachments: InboundAttachment[];
      /** Header values keyed by lowercase name; the first occurrence of repeated headers. */
      headers: Record<string, string>;
      priority?: 'high' | 'normal' | 'low';
    };
    cleanedContent: {
      /** HTML reduced to an allow-list of tags and attributes; null if too large to sanitize. */
      html: string | null;
      text: string | null;
      hasHtml: boolean;
      hasText: boolean;
      attachments: InboundAttachment[];
      headers: Record<string, string>;
    };
  };
}
