import { sql, eq, and } from 'drizzle-orm';
import { parseInboundMime,SMTP_WIRE_LIMIT } from './mailbox-ingest.js';
import { ApiError, id, type Actor, type Ctx } from './core.js';
import { mailboxes } from './db/mailbox.js';
import { principal } from './mail-gateway.js';
import { boundMailBucket, mailKey, withMailObjects } from './mail-objects.js';
import { mimeIndex } from './mailbox-mime-index.js';
import { sendFromMailbox, resolveAttachments } from './mailbox-send.js';
import { protocolScoreCap } from './sender-score.js';
import {savePreview} from './protocol-preview.js';

type Content = { kid: string; content: string; op: 'submit'; from: string; to: string[] };
/** Preserve raw octets, including the body. Strip folded Bcc header fields only. */
function scrub(input: Uint8Array) {
  const bytes = Buffer.from(input),
    end = bytes.indexOf('\r\n\r\n');
  if (end < 0) return bytes;
  const lines = Buffer.from(bytes.subarray(0, end)).toString('latin1').split('\r\n');
  let skip = false;
  return Buffer.concat([
    Buffer.from(
      lines
        .filter((l: string) => {
          if (!/^[ \t]/.test(l)) skip = /^bcc:/i.test(l);
          return !skip;
        })
        .join('\r\n') + '\r\n\r\n',
      'latin1',
    ),
    bytes.subarray(end + 4),
  ]);
}
export async function contentWrite(c: Ctx, p: Content) {
  const rt = c.env;
  const auth = principal(rt, 'smtp', sql`p.id=${p.kid}`);
  const ownership = sql`ARRAY(SELECT lower(address) FROM mailbox_addresses WHERE workspace_id=a.w AND mailbox_id=a.b)`;
  const who = (await rt.db.execute<{ w: string; b: string; domain: string; owned: string[] }>(
    sql`WITH a AS (${auth}) SELECT a.*,b.domain_id AS domain,${ownership} AS owned FROM a JOIN mailboxes b ON b.id=a.b`,
  )).rows[0];
  if (!who) throw new ApiError(403, 'CREDENTIAL_REVOKED', 'Protocol access denied.');
  const input = Buffer.from(p.content, 'base64');
  if (input.length > SMTP_WIRE_LIMIT) throw new ApiError(413, 'MESSAGE_SIZE', 'Message is too large.');
  const raw = scrub(input);
  const m = await parseInboundMime(raw,'submission');
  if (!m) throw new ApiError(422, 'MIME_LIMIT', 'Message could not be safely parsed.');
  const mid = id('msg'),
    bucket = boundMailBucket(rt) ?? (!rt.config.multiTenant ? 'local:' : null);
  if (!bucket) throw new ApiError(503, 'MAIL_STORE_UNAVAILABLE', 'Kept mail storage unavailable.');
  const key = mailKey(who.w, 'kept', who.b, mid),
    index = mimeIndex(raw);
  const sender = m.from?.address?.toLowerCase();
  const origins = m.headers.filter(h => h.key === 'from'), senders = m.headers.filter(h => h.key === 'sender');
  const required = [sender, p.from.toLowerCase(), ...(senders.length ? [m.sender?.address?.toLowerCase()] : [])];
  const ownsSenders = (addresses: string[]) => required.every(a => a && addresses.includes(a));
  const denied = () => new ApiError(403, 'SENDER_NOT_OWNED', 'Use an address owned by this inbox.');
  if (!sender || origins.length !== 1 || senders.length > 1 || !ownsSenders(who.owned)) throw denied();
  // The shared SES path cannot represent signed or encrypted MIME without breaking it.
  if (/^content-type:\s*(application\/(?:pkcs7|pgp)|multipart\/(?:signed|encrypted))/im.test(raw.subarray(0, 65536).toString('latin1')))
    throw new ApiError(422, 'UNSUPPORTED_MESSAGE', 'This MIME submission cannot be represented by the sending adapter.');
  // Uploads reserve quota and commit immutable objects using their own transactions.
  // Never ask for a second connection while the Worker holds its only one.
  const attachments = await resolveAttachments(rt, {id:who.b, workspaceId:who.w, domainId:who.domain}, m.attachments.map(f => ({
    filename: f.filename ?? 'attachment', contentType: f.mimeType,
    content: Buffer.from(new Uint8Array(f.content as ArrayBuffer)).toString('base64'),
    disposition: f.disposition === 'inline' ? 'inline' : 'attachment', contentId: f.contentId?.replace(/^<|>$/g, ''),
  })), sender);
  const cap = await protocolScoreCap(rt, who.w);
  const persist = () => withMailObjects(rt, who.w, '', bucket, (objects) => objects.put(key, raw, 'message/rfc822'));
  // An uncertain transaction outcome must not remove a committed object. Orphan cleanup
  // must prove no membership references the immutable key before deleting it.
  return rt.db.transaction(async (tx) => {
    const box = (
      await tx
        .select()
        .from(mailboxes)
        .where(and(eq(mailboxes.id, who.b), eq(mailboxes.workspaceId, who.w)))
        .for('no key update')
    )[0];
    // Acquire the issuer/revoker's fence BEFORE taking the statement snapshot used to authorize.
    await tx.execute(sql`SELECT FROM inbox_state WHERE workspace_id=${who.w} AND inbox_id=${who.b} FOR UPDATE`);
    const active = (
      await tx.execute<{ owned: string[]; suppressed: boolean; daily: number; monthly: number }>(
        sql`WITH a AS (${auth}) SELECT ${ownership} AS owned,s.protocol_daily daily,s.protocol_monthly monthly,
          EXISTS(SELECT FROM audience_contacts WHERE workspace_id=a.w AND email=ANY(${sql.param(p.to.map(v=>v.toLowerCase()))}::text[]) AND suppressed) AS suppressed
          FROM a JOIN inbox_state s ON s.inbox_id=a.b FOR UPDATE OF s`,
      )
    ).rows[0];
    if (!box || !active) throw new ApiError(403, 'CREDENTIAL_REVOKED', 'Protocol access denied.');
    if (!ownsSenders(active.owned)) throw denied();
    // SMTP submissions have no reply-author suppression exemption. Don't acknowledge
    // known undeliverable mail; dispatch still rechecks for changes after this commit.
    if (active.suppressed) throw new ApiError(422, 'RECIPIENT_INELIGIBLE', 'Recipient is not eligible for delivery.');
    const stamp = m?.messageId?.trim() ?? null;
    const used = (
      await tx.execute<{ day: number; month: number }>(
        sql`SELECT coalesce(sum(accepted) FILTER(WHERE day=(now() AT TIME ZONE 'UTC')::date),0)::int AS day,coalesce(sum(accepted),0)::int AS month FROM inbox_protocol_sends WHERE inbox_id=${who.b} AND day>=date_trunc('month',now() AT TIME ZONE 'UTC')::date`,
      )
    ).rows[0]!;
    if (used.day + p.to.length > Math.min(active.daily, cap) || used.month + p.to.length > active.monthly)
      throw new ApiError(429, 'INBOX_SEND_LIMIT', 'Inbox send cap reached.');
    const actor: Actor = { workspaceId: who.w, keyId: p.kid, domains: [], permissions: ['send'] };
    c.set('actor', actor);
    const hdrTo = new Set(m.to?.map((x) => x.address?.toLowerCase())),
      hdrCc = new Set(m.cc?.map((x) => x.address?.toLowerCase()));
    const to = p.to.filter((a) => hdrTo.has(a.toLowerCase())),
      cc = p.to.filter((a) => !to.includes(a) && hdrCc.has(a.toLowerCase())),
      bcc = p.to.filter((a) => !to.includes(a) && !cc.includes(a));
    const { message } = await sendFromMailbox(rt, tx, {
      scope: { workspaceId: who.w },
      actor,
      mailbox: box,
      from: sender,
      fromName: m.from?.name,
      to,
      cc,
      bcc,
      replyTo: (m.replyTo ?? []).flatMap((a) => (a.address ? [a.address] : [])),
      subject: m.subject || '(no subject)',
      text: m.text ?? ' ',
      html: m.html,
      attachments,
      inReplyTo: m.inReplyTo && /^<[^<>\s\x00-\x1f]{1,990}>$/.test(m.inReplyTo) ? m.inReplyTo.slice(1, -1) : null,
      references: (m.references ?? '')
        .split(/\s+/)
        .filter((v) => /^<[^<>\s\x00-\x1f]{1,990}>$/.test(v))
        .slice(-64)
        .map((v) => v.slice(1, -1)),
      headers: [],
      screen: true,
      tracking: false,
      protocolArchive: { mid, key, bucket, bytes: raw.length, mime: index, clientId: stamp },
    });
    await tx.execute(
      sql`INSERT INTO inbox_protocol_sends VALUES(${who.b},(now() AT TIME ZONE 'UTC')::date,${p.to.length}) ON CONFLICT(inbox_id,day) DO UPDATE SET accepted=inbox_protocol_sends.accepted+excluded.accepted`,
    );
    await persist();
    await savePreview(tx,mid,key,raw,raw.length);
    return { id: message.sendingEmailId };
  });
}
