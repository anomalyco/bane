/** Verify the original HTTP body before parsing JSON. A legacy token alone is not a signature. */
export async function verifyWebhook(
  body: string,
  headers: Headers,
  secret: string,
  verificationToken?: string,
): Promise<boolean> {
  const id = headers.get('Webhook-Id'),
    timestamp = headers.get('Webhook-Timestamp'),
    signature = headers.get('Webhook-Signature');
  if (
    !id ||
    !timestamp ||
    !/^\d+$/.test(timestamp) ||
    !signature ||
    Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 ||
    !secret.startsWith('whsec_')
  )
    return false;
  if (verificationToken !== undefined && headers.get('X-Webhook-Verification-Token') !== verificationToken) return false;
  try {
    const bytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
      rawKey = bytes(secret.slice(6));
    if (rawKey.length !== 32) return false;
    const key = await crypto.subtle.importKey('raw', rawKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const data = new TextEncoder().encode(`${id}.${timestamp}.${body}`);
    for (const sig of signature.split(/\s+/))
      if (sig.startsWith('v1,') && (await crypto.subtle.verify('HMAC', key, bytes(sig.slice(3)), data))) return true;
  } catch {
    /* malformed signature */
  }
  return false;
}
type AddressGroup = { text: string; addresses: { name: string | null; address: string }[] };
type Attachment = {
  filename: string;
  contentType: string;
  size: number;
  contentId: string | null;
  contentDisposition: string;
  downloadUrl: string;
};
export interface InboundWebhookPayload {
  event: 'email.received';
  timestamp: string;
  endpoint: { id: string; name: string; type: 'webhook' };
  email: {
    id: string;
    messageId: string;
    from: AddressGroup;
    to: AddressGroup;
    recipient: string;
    subject: string;
    receivedAt: string;
    spam: { isJunk: boolean; reason: 'ses_spam' | null };
    parsedData: {
      messageId: string;
      date: string;
      subject: string;
      from: AddressGroup;
      to: AddressGroup;
      cc: AddressGroup | null;
      bcc: null;
      replyTo: AddressGroup | null;
      inReplyTo?: string;
      references?: string[];
      textBody: string | null;
      htmlBody: string | null;
      raw: string | null;
      rawUrl?: string;
      attachments: Attachment[];
      headers: Record<string, string>;
    };
    cleanedContent: {
      html: string | null;
      text: string | null;
      hasHtml: boolean;
      hasText: boolean;
      attachments: Attachment[];
      headers: Record<string, string>;
    };
  };
}
