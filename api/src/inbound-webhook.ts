import { and, eq, sql } from 'drizzle-orm';
import { ApiError, lazyModule, type Runtime, type ClaimedWebhook } from './core.js';
import { mailMessages, type MailAddress } from './db/mailbox.js';
import { mailboxS3, readableMailboxKey } from './mailbox-setup.js';
import { decrypt, hmac, postWebhook, webhookUrl } from './operations.js';
const s3commands = lazyModule(() => import('@aws-sdk/client-s3'));
const group = (addresses: MailAddress[]) => ({
  text: addresses.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', '),
  addresses,
});
type Event = {
  id: string;
  type: string;
  createdAt: string;
  messageId: string | null;
  addressId: string | null;
  data: { recipients?: string[]; subaddress?: string; route?: string; junk?: boolean };
};
type Part = {
  id: string;
  filename: string;
  contentType: string;
  contentId: string | null;
  size: number;
  contentDisposition: string;
};
type RenderMessage = Pick<
  typeof mailMessages.$inferSelect,
  | 'id'
  | 'messageId'
  | 'threadId'
  | 'direction'
  | 'status'
  | 'snippet'
  | 'subject'
  | 'fromName'
  | 'fromAddress'
  | 'to'
  | 'cc'
  | 'replyTo'
  | 'receivedAt'
  | 'sentAt'
  | 'headers'
  | 'text'
  | 'html'
  | 'inReplyTo'
  | 'references'
  | 'spam'
  | 'envelopeTo'
  | 'bodyTruncated'
>;
function inboundPayload(
  m: RenderMessage,
  parts: Part[],
  raw: string | null,
  root: string,
  recipient: string,
  timestamp: string,
  endpoint: { id: string; name: string },
) {
  const from = group([{ name: m.fromName, address: m.fromAddress }]),
    to = group(m.to),
    subject = m.subject,
    receivedAt = new Date(m.receivedAt).toISOString();
  const headers = Object.fromEntries(m.headers.map((h) => [h.name, h.value])),
    attachments = parts.map(({ id, ...part }) => ({ ...part, downloadUrl: `${root}/parts/${encodeURIComponent(id)}` }));
  const messageId = m.messageId ? `<${m.messageId}>` : m.id;
  return {
    event: 'email.received' as const,
    timestamp,
    email: {
      id: m.id,
      messageId,
      from,
      to,
      recipient,
      subject,
      receivedAt,
      spam: { isJunk: m.spam, reason: m.spam ? 'ses_spam' : null },
      parsedData: {
        messageId,
        date: m.sentAt ? new Date(m.sentAt).toISOString() : receivedAt,
        subject,
        from,
        to,
        cc: m.cc.length ? group(m.cc) : null,
        bcc: null,
        replyTo: m.replyTo.length ? group(m.replyTo) : null,
        inReplyTo: m.inReplyTo ?? undefined,
        references: m.references.length ? m.references : undefined,
        textBody: m.text,
        htmlBody: m.html,
        raw,
        ...(raw === null ? { rawUrl: root + '/raw' } : {}),
        attachments,
        headers,
      },
      cleanedContent: { html: m.html, text: m.text, hasHtml: !!m.html, hasText: !!m.text, attachments, headers },
    },
    endpoint: { ...endpoint, type: 'webhook' as const },
  };
}
export async function sendInboundWebhook(runtime: Runtime, w: string, h: ClaimedWebhook, example = false) {
  const event = h.payload as Event,
    binding = `${w}:live:mailbox:${h.webhook_id}`,
    url = webhookUrl(runtime, h.url),
    secret = await decrypt(runtime, h.encrypted_secret, binding);
  const headers: Record<string, string> = { 'User-Agent': 'Bane-Webhooks/1.0' };
  let payload: unknown = event;
  if ((h.format === 'inbound' || h.include?.length) && event.messageId) {
    let m: RenderMessage,
      parts: Part[] = [],
      raw: string | null = null;
    if (example) {
      m = {
        id: 'msg_example',
        threadId: 'thr_example',
        direction: 'inbound',
        status: 'received',
        snippet: 'Test delivery',
        messageId: 'test@example.org',
        subject: 'Test delivery',
        fromName: null,
        fromAddress: 'sender@example.org',
        to: [{ name: null, address: 'recipient@example.org' }],
        cc: [],
        replyTo: [],
        receivedAt: event.createdAt,
        sentAt: null,
        headers: [],
        text: 'Test delivery',
        html: null,
        inReplyTo: null,
        references: [],
        spam: false,
        envelopeTo: ['recipient@example.org'],
        bodyTruncated: false,
      };
      raw = 'Subject: Test delivery\r\n\r\nTest delivery';
    } else {
      const [row] = await runtime.db
        .select({
          message: mailMessages,
          parts: sql<
            Part[]
          >`coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id,'filename',filename,'contentType',content_type,'contentId',content_id,'size',size_bytes,'contentDisposition',disposition) ORDER BY id) FROM mail_attachments a WHERE a.workspace_id=${w} AND a.message_id=${mailMessages.id}),'[]')`,
        })
        .from(mailMessages)
        .where(and(eq(mailMessages.workspaceId, w), eq(mailMessages.id, event.messageId)));
      if (!row) throw new ApiError(410, 'MESSAGE_GONE', 'Source message is no longer available.');
      m = row.message;
      parts = row.parts;
      if (
        (h.format === 'inbound' || h.include?.includes('raw')) &&
        row.message.rawKey &&
        row.message.rawBucket &&
        row.message.region &&
        row.message.verdicts.virus === 'PASS' &&
        (row.message.sizeBytes ?? Infinity) <= 2 * 1024 * 1024
      ) {
        const { region, rawBucket, rawKey } = row.message,
          client = await mailboxS3(runtime, w, region, rawBucket);
        try {
          const key = await readableMailboxKey(runtime, w, region, rawBucket, rawKey, 'raw', runtime.db, client);
          const { GetObjectCommand } = await s3commands();
          const object = await client.send(new GetObjectCommand({ Bucket: rawBucket, Key: key, Range: 'bytes=0-2097151' }));
          raw = (await object.Body?.transformToString()) ?? null;
        } finally {
          client.destroy();
        }
      }
    }
    const root = runtime.config.publicUrl.replace(/\/$/, '') + '/v1/inbound/messages/' + encodeURIComponent(m.id);
    if (h.format === 'inbound') {
      payload = inboundPayload(
        m,
        parts,
        raw,
        root,
        event.data.recipients?.[0] ?? m.envelopeTo[0] ?? m.to[0]?.address ?? '',
        event.createdAt,
        { id: h.webhook_id, name: h.name ?? h.webhook_id },
      );
      Object.assign(headers, {
        'X-Webhook-Verification-Token': await hmac(secret, 'inbound-verification-token'),
        'X-Endpoint-ID': h.webhook_id,
        'X-Webhook-Event': 'email.received',
        'X-Webhook-Timestamp': event.createdAt,
      });
    } else {
      const text = Buffer.from(m.text ?? '').subarray(0, 262144),
        html = Buffer.from(m.html ?? '').subarray(0, 262144 - text.length);
      payload = {
        ...event,
        data: {
          ...event.data,
          ...(h.include?.includes('message')
            ? {
                message: {
                  id: m.id,
                  threadId: m.threadId,
                  direction: m.direction,
                  status: m.status,
                  subject: m.subject,
                  from: { name: m.fromName, address: m.fromAddress },
                  to: m.to,
                  cc: m.cc,
                  replyTo: m.replyTo,
                  receivedAt: m.receivedAt,
                  text: text.toString(),
                  html: html.toString(),
                  bodyTruncated:
                    m.bodyTruncated ||
                    text.length + html.length < Buffer.byteLength(m.text ?? '') + Buffer.byteLength(m.html ?? ''),
                  attachments: parts.map((p) => ({ ...p, url: root + '/parts/' + p.id })),
                },
              }
            : {}),
          ...(h.include?.includes('raw') ? { raw, rawUrl: root + '/raw' } : {}),
        },
      };
    }
  }
  const body = JSON.stringify(payload),
    timestamp = String(Math.floor(Date.now() / 1000));
  Object.assign(headers, {
    'Webhook-Id': event.id,
    'Webhook-Timestamp': timestamp,
    'Webhook-Signature': 'v1,' + (await hmac(secret, `${event.id}.${timestamp}.${body}`)),
  });
  return postWebhook(runtime, url, headers, body, h.encrypted_headers, binding, h.timeout_seconds ?? 5);
}
