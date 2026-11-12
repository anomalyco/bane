import { sql, eq, and } from 'drizzle-orm';
import {parseInboundMime} from './mailbox-ingest.js';
import { ApiError, id, type Actor, type Ctx } from './core.js';
import { mailboxes } from './db/mailbox.js';
import { principal } from './mail-gateway.js';
import { boundMailBucket, mailKey, withMailObjects } from './mail-objects.js';
import { mimeIndex } from './mailbox-mime-index.js';
import { sendFromMailbox, resolveAttachments } from './mailbox-send.js';
import { protocolScoreCap } from './sender-score.js';

type Content = { kid: string; content: string } & (
  { op: 'append'; flags: string[]; date: string; folder: string } | { op: 'submit'; from: string; to: string[] }
);
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
  const rt = c.env,
    sending = p.op === 'submit';
  const protocol = sending ? 'smtp' : 'imap';
  const auth = principal(rt, protocol, sql`p.id=${p.kid}`);
  const who = (await rt.db.execute<{ w: string; b: string }>(auth)).rows[0];
  if (!who) throw new ApiError(403, 'CREDENTIAL_REVOKED', 'Protocol access denied.');
  const input = Buffer.from(p.content, 'base64'),
    raw = sending ? scrub(input) : input;
  if (raw.length > (sending ? 16 : 40) * 1024 * 1024) throw new ApiError(413, 'MESSAGE_SIZE', 'Message is too large.');
  const m=await parseInboundMime(raw);
  if(!m && sending)throw new ApiError(422,'MIME_LIMIT','Message could not be safely parsed.');
  const
    mid = id('msg'),
    tid = id('thr'),
    bucket = boundMailBucket(rt) ?? (!rt.config.multiTenant ? 'local:' : null);
  if (!bucket) throw new ApiError(503, 'MAIL_STORE_UNAVAILABLE', 'Kept mail storage unavailable.');
  const key = mailKey(who.w, 'kept', who.b, mid),
    index = mimeIndex(raw);
  const cap = sending ? await protocolScoreCap(rt, who.w) : 0;
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
      await tx.execute<{ w: string; b: string; daily: number; monthly: number }>(
        sql`WITH a AS (${auth}) SELECT a.*,s.protocol_daily daily,s.protocol_monthly monthly FROM a JOIN inbox_state s ON s.inbox_id=a.b FOR UPDATE OF s`,
      )
    ).rows[0];
    if (!box || !active) throw new ApiError(403, 'CREDENTIAL_REVOKED', 'Protocol access denied.');
    const stamp = m?.messageId?.trim() ?? null;
    if (p.op === 'submit') {
      if(!m)throw new ApiError(422,'MIME_LIMIT','Message could not be safely parsed.');
      const owned = (
        await tx.execute<{ address: string }>(
          sql`SELECT address FROM mailbox_addresses WHERE workspace_id=${who.w} AND mailbox_id=${who.b}`,
        )
      ).rows.map((a) => a.address.toLowerCase());
      const sender = m.from?.address?.toLowerCase();
      const origins = m.headers.filter((h) => h.key === 'from');
      const senders = m.headers.filter((h) => h.key === 'sender');
      if (
        !sender ||
        !owned.includes(sender) ||
        !owned.includes(p.from.toLowerCase()) ||
        origins.length !== 1 ||
        senders.length > 1 ||
        (senders.length && (!m.sender?.address || !owned.includes(m.sender.address.toLowerCase())))
      )
        throw new ApiError(403, 'SENDER_NOT_OWNED', 'Use an address owned by this inbox.');
      const used = (
        await tx.execute<{ day: number; month: number }>(
          sql`SELECT coalesce(sum(accepted) FILTER(WHERE day=(now() AT TIME ZONE 'UTC')::date),0)::int AS day,coalesce(sum(accepted),0)::int AS month FROM inbox_protocol_sends WHERE inbox_id=${who.b} AND day>=date_trunc('month',now() AT TIME ZONE 'UTC')::date`,
        )
      ).rows[0]!;
      if (used.day >= Math.min(active.daily, cap) || used.month >= active.monthly)
        throw new ApiError(429, 'INBOX_SEND_LIMIT', 'Inbox send cap reached.');
      // Do not silently drop attachments or break MIME signatures on shared SES: use
      // the structured sending path, refusing types not representable by this adapter.
      if (
        /^content-type:\s*(application\/(?:pkcs7|pgp)|multipart\/(?:signed|encrypted))/im.test(
          raw.subarray(0, 65536).toString('latin1'),
        )
      )
        throw new ApiError(
          422,
          'UNSUPPORTED_MESSAGE',
          'This MIME submission cannot be represented by the sending adapter.',
        );
      const attachments = await resolveAttachments(
        rt,
        box,
        m.attachments.map((f) => ({
          filename: f.filename ?? 'attachment',
          contentType: f.mimeType,
          content: Buffer.from(new Uint8Array(f.content as ArrayBuffer)).toString('base64'),
          disposition: f.disposition === 'inline' ? 'inline' : 'attachment',
          contentId: f.contentId?.replace(/^<|>$/g, ''),
        })),
        sender,
      );
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
        inReplyTo: null,
        references: [],
        headers: [],
        screen: true,
        tracking: false,
        protocolArchive: { mid, key, bucket, bytes: raw.length, mime: index, clientId: stamp },
      });
      await tx.execute(
        sql`INSERT INTO inbox_protocol_sends VALUES(${who.b},(now() AT TIME ZONE 'UTC')::date,1) ON CONFLICT(inbox_id,day) DO UPDATE SET accepted=inbox_protocol_sends.accepted+1`,
      );
      await persist();
      return { id: message.sendingEmailId };
    }
    const r = (
      await tx.execute<{ r: { pairs: [number, number][]; validity: number; error?: string } }>(
        sql`SELECT mailgw_append(${who.w},${who.b},${p.folder},${mid},${tid},${stamp},${m?.subject ?? ''},${m?.from?.address ?? ''},${m?.text?.slice(0, 65536) ?? ''},${p.date}::timestamptz,${raw.length},${bucket},${key},${JSON.stringify(index)}::jsonb,${sql.param(p.flags)}::text[]) r`,
      )
    ).rows[0]!.r;
    if (r.error) throw new ApiError(409, 'APPEND_REFUSED', 'Append refused.');
    if (r.pairs[0]?.[0] !== 1) await persist();
    return r;
  });
}
