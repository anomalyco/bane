import { and, eq, sql } from 'drizzle-orm';
import { ApiError, id, lazyModule, type ClaimedWebhook, type Runtime } from './core.js';
import { mailMessages, type mailboxWebhooks, type MailAddress } from './db/mailbox.js';
import { webhookSecretBinding } from './mailbox-events.js';
import { safeForwardHtml } from './mailbox-send.js';
import { mailboxS3, readableMailboxKey } from './mailbox-setup.js';
import { decrypt, hmac, postWebhook, webhookSecret, webhookUrl } from './operations.js';

const s3commands = lazyModule(() => import('@aws-sdk/client-s3'));
const POST_LIMIT=512*1024, RAW_INLINE_LIMIT = POST_LIMIT,
  BODY_INLINE_LIMIT = 256 * 1024;

/** The static inbound-format token, derived from the signing secret so rotating the secret rotates it too. */
export const verificationToken = (secret: string) => hmac(secret, 'inbound-verification-token');

type Event = {
  id: string;
  type: string;
  createdAt: string;
  messageId: string | null;
  addressId: string | null;
  data: { recipients?: string[]; subaddress?: string; route?: string; junk?: boolean };
};
type Part = { id: string; filename: string; contentType: string; contentId: string | null; size: number; contentDisposition: 'attachment' | 'inline' };
type RenderMessage = Pick<
  typeof mailMessages.$inferSelect,
  | 'id'
  | 'messageId'
  | 'threadId'
  | 'direction'
  | 'status'
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
const EXAMPLE: { message: RenderMessage; raw: string } = {
  message: {
    id: 'msg_example',
    threadId: 'thr_example',
    direction: 'inbound',
    status: 'received',
    messageId: 'test@example.org',
    subject: 'Test delivery',
    fromName: 'Bane',
    fromAddress: 'sender@example.org',
    to: [{ name: null, address: 'recipient@example.org' }],
    cc: [],
    replyTo: [],
    receivedAt: new Date(0).toISOString(),
    sentAt: null,
    headers: [{ name: 'Subject', value: 'Test delivery' }],
    text: 'Test delivery',
    html: null,
    inReplyTo: null,
    references: [],
    spam: false,
    envelopeTo: ['recipient@example.org'],
    bodyTruncated: false,
  },
  raw: 'From: Bane <sender@example.org>\r\nTo: recipient@example.org\r\nSubject: Test delivery\r\n\r\nTest delivery',
};

const group = (addresses: MailAddress[]) => ({
  text: addresses.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', '),
  addresses,
});
const bracketed = (messageId: string) => `<${messageId}>`;
// mailparser's priority: X-Priority 1–2 or Importance/Priority high or urgent is high; 4–5, low or non-urgent is low.
function priority(headers: Record<string, string>) {
  const value = (headers['x-priority'] ?? headers['x-msmail-priority'] ?? headers['importance'] ?? headers['priority'])?.trim().toLowerCase();
  if (!value) return undefined;
  return /^[12]\b|^high|^urgent/.test(value) ? 'high' : /^[45]\b|^low|^non-urgent/.test(value) ? 'low' : 'normal';
}
/** inbound.new's documented email.received body, field for field. Bane adds rawUrl when raw is too large to inline. */
function inboundPayload(m: RenderMessage, parts: Part[], raw: string | null, root: string, recipient: string, endpoint: { id: string; name: string }) {
  const from = group([{ name: m.fromName, address: m.fromAddress }]),
    to = group(m.to),
    receivedAt = new Date(m.receivedAt).toISOString(),
    messageId = m.messageId ? bracketed(m.messageId) : m.id;
  const headers: Record<string, string> = Object.create(null);
  for (const h of m.headers) headers[h.name.toLowerCase()] ??= h.value;
  const attachments = parts.map(({ id, ...part }) => ({ ...part, downloadUrl: `${root}/parts/${encodeURIComponent(id)}` }));
  // inbound strips scripts, handlers and javascript: URLs; Bane's quote sanitizer is an allow-list, so it is at least as strict.
  const cleaned = m.html ? safeForwardHtml(m.html) : null;
  return {
    event: 'email.received' as const,
    timestamp: new Date().toISOString(),
    email: {
      id: m.id,
      messageId,
      from,
      to,
      recipient,
      envelopeRecipients: m.envelopeTo,
      subject: m.subject,
      receivedAt,
      threadId: m.threadId,
      spam: { isJunk: m.spam, reason: m.spam ? ('ses_spam' as const) : null },
      parsedData: {
        messageId,
        date: m.sentAt ? new Date(m.sentAt).toISOString() : receivedAt,
        subject: m.subject,
        from,
        to,
        cc: m.cc.length ? group(m.cc) : null,
        bcc: null,
        replyTo: m.replyTo.length ? group(m.replyTo) : null,
        inReplyTo: m.inReplyTo ? bracketed(m.inReplyTo) : undefined,
        references: m.references.length ? m.references.map(bracketed) : undefined,
        textBody: m.text,
        htmlBody: m.html,
        raw,
        ...(raw === null ? { rawUrl: root + '/raw' } : {}),
        attachments,
        headers,
        priority: priority(headers),
      },
      cleanedContent: { html: cleaned, text: m.text, hasHtml: cleaned !== null, hasText: !!m.text, attachments, headers },
    },
    endpoint: { ...endpoint, type: 'webhook' as const },
  };
}
/** Bane's event, plus the message (text and HTML capped at 256 KiB together) and raw MIME when the webhook includes them. */
function banePayload(event: Event, m: RenderMessage, parts: Part[], raw: string | null, root: string, include: string[]) {
  const text = Buffer.from(m.text ?? '').subarray(0, BODY_INLINE_LIMIT),
    html = Buffer.from(m.html ?? '').subarray(0, BODY_INLINE_LIMIT - text.length);
  const message = {
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
    bodyTruncated: m.bodyTruncated || text.length + html.length < Buffer.byteLength(m.text ?? '') + Buffer.byteLength(m.html ?? ''),
    attachments: parts.map((p) => ({ ...p, url: `${root}/parts/${encodeURIComponent(p.id)}` })),
  };
  return {
    ...event,
    data: { ...event.data, ...(include.includes('message') ? { message } : {}), ...(include.includes('raw') ? { raw, rawUrl: root + '/raw' } : {}) },
  };
}
/** The immutable message row, its attachments and (bounded by the POST cap, virus-clean only) its raw MIME. One indexed read plus at most one GET. */
async function loadMessage(runtime: Runtime, w: string, messageId: string, withRaw: boolean) {
  const [row] = await runtime.db
    .select({
      message: mailMessages,
      parts: sql<Part[]>`coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id,'filename',filename,'contentType',content_type,'contentId',content_id,'size',size_bytes,'contentDisposition',disposition) ORDER BY id) FROM mail_attachments a WHERE a.workspace_id=${w} AND a.message_id=${mailMessages.id}),'[]')`,
    })
    .from(mailMessages)
    .where(and(eq(mailMessages.workspaceId, w), eq(mailMessages.id, messageId)));
  if (!row) throw new ApiError(410, 'MESSAGE_GONE', 'The message was deleted before this delivery.');
  const { region, rawBucket, rawKey, verdicts, sizeBytes } = row.message;
  let raw: string | null = null;
  if (withRaw && region && rawBucket && rawKey && verdicts.virus === 'PASS' && (sizeBytes ?? Infinity) <= RAW_INLINE_LIMIT) {
    const client = await mailboxS3(runtime, w, region, rawBucket);
    try {
      const key = await readableMailboxKey(runtime, w, region, rawBucket, rawKey, 'raw', runtime.db, client);
      const { GetObjectCommand } = await s3commands();
      const object = await client.send(new GetObjectCommand({ Bucket: rawBucket, Key: key, Range: `bytes=0-${RAW_INLINE_LIMIT - 1}` }));
      raw = (await object.Body?.transformToString()) ?? null;
    } finally {
      client.destroy();
    }
  }
  return { message: row.message as RenderMessage, parts: row.parts, raw };
}
async function send(runtime: Runtime, w: string, h: ClaimedWebhook, secret: string, example?: typeof EXAMPLE) {
  const event = h.payload as Event,
    format = h.format ?? 'bane',
    include = h.include ?? [];
  const headers: Record<string, string> = { 'User-Agent': 'Bane-Webhooks/1.0' };
  let payload: unknown = event;
  if ((format === 'inbound' || include.length) && event.messageId) {
    const { message, parts, raw } = example
      ? { message: { ...EXAMPLE.message, receivedAt: event.createdAt }, parts: [], raw: EXAMPLE.raw }
      : await loadMessage(runtime, w, event.messageId, format === 'inbound' || include.includes('raw'));
    const root = `${runtime.config.publicUrl.replace(/\/$/, '')}/v1/inbound/messages/${encodeURIComponent(message.id)}`;
    if (format === 'inbound') {
      const text=Buffer.from(message.text??'').subarray(0,BODY_INLINE_LIMIT), html=Buffer.from(message.html??'').subarray(0,BODY_INLINE_LIMIT-text.length);
      const truncated=text.length+html.length<Buffer.byteLength(message.text??'')+Buffer.byteLength(message.html??'');
      const compact={...message,text:message.text===null?null:text.toString(),html:message.html===null?null:html.toString()};
      const body = inboundPayload(compact, parts, raw, root, event.data.recipients?.[0] ?? message.envelopeTo[0] ?? message.to[0]?.address ?? '', {
        id: h.webhook_id,
        name: h.name ?? h.webhook_id,
      });
      if(truncated)Object.assign(body.email,{bodyTruncated:true,messageUrl:root});
      if(Buffer.byteLength(JSON.stringify(body))>POST_LIMIT){
        Object.assign(body.email.parsedData,{raw:null,rawUrl:root+'/raw'});
        if(Buffer.byteLength(JSON.stringify(body))>POST_LIMIT){
          Object.assign(body.email.parsedData,{textBody:null,htmlBody:null,headers:{}});
          Object.assign(body.email.cleanedContent,{text:null,html:null,hasText:false,hasHtml:false,headers:{}});
          Object.assign(body.email,{bodyTruncated:true,messageUrl:root});
        }
      }
      payload = body;
      Object.assign(headers, {
        'X-Webhook-Verification-Token': await verificationToken(secret),
        'X-Endpoint-ID': h.webhook_id,
        'X-Webhook-Event': body.event,
        'X-Webhook-Timestamp': body.timestamp,
        'X-Email-ID': message.id,
        ...(/^[\x21-\x7e]+$/.test(body.email.messageId)?{'X-Message-ID':body.email.messageId}:{}),
      });
    } else {const body=banePayload(event,message,parts,raw,root,include);if(Buffer.byteLength(JSON.stringify(body))>POST_LIMIT){if(body.data.raw)body.data.raw=null;if(body.data.message && Buffer.byteLength(JSON.stringify(body))>POST_LIMIT)Object.assign(body.data.message,{text:'',html:'',bodyTruncated:true});}payload=body;}
  }
  const body = JSON.stringify(payload),
    timestamp = String(Math.floor(Date.now() / 1000));
  if(Buffer.byteLength(body)>POST_LIMIT)throw new ApiError(413,'WEBHOOK_BODY_TOO_LARGE','Webhook metadata exceeds 512 KiB. Read the stored message instead.');
  Object.assign(headers, {
    'Webhook-Id': event.id,
    'Webhook-Timestamp': timestamp,
    'Webhook-Signature': 'v1,' + (await hmac(secret, `${event.id}.${timestamp}.${body}`)),
  });
  return postWebhook(runtime, h.url, headers, body, h.encrypted_headers, webhookSecretBinding(w, h.webhook_id), h.timeout_seconds ?? 5);
}
/** Renders a claimed delivery in its webhook's format, signs it and posts it through the SSRF-guarded transport. */
export async function deliverInboundWebhook(runtime: Runtime, w: string, h: ClaimedWebhook) {
  const url = webhookUrl(runtime, h.url);
  return send(runtime, w, { ...h, url }, await decrypt(runtime, h.encrypted_secret, webhookSecretBinding(w, h.webhook_id)));
}
/** A synthetic message.received for the example message. An override URL gets a throwaway secret and none of the endpoint's custom headers. */
export async function sendTestWebhook(runtime: Runtime, hook: typeof mailboxWebhooks.$inferSelect, input: { format?: 'bane' | 'inbound'; overrideUrl?: string }) {
  const url = webhookUrl(runtime, input.overrideUrl ?? hook.url),
    override = url !== hook.url,
    eventId = id('mev');
  const secret = override ? webhookSecret() : await decrypt(runtime, hook.encryptedSecret, webhookSecretBinding(hook.workspaceId, hook.id));
  const delivery: ClaimedWebhook = {
    delivery_id: 'test',
    generation: 0,
    event_id: eventId,
    synthetic: true,
    webhook_id: hook.id,
    url,
    name: hook.name ?? hook.id,
    format: input.format ?? hook.format,
    include: hook.include,
    timeout_seconds: hook.timeoutSeconds,
    encrypted_secret: hook.encryptedSecret,
    encrypted_headers: override ? null : hook.encryptedHeaders,
    payload: { id: eventId, type: 'message.received', cursor: '0', createdAt: new Date().toISOString(), addressId: null, threadId: EXAMPLE.message.threadId, messageId: EXAMPLE.message.id, data: { test: true } },
  };
  return send(runtime, hook.workspaceId, delivery, secret, EXAMPLE);
}
