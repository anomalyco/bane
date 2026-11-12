import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError, id, type Ctx } from './core.js';
import { principal } from './mail-gateway.js';
import { boundMailBucket, mailKey, withMailObjects, readMailBytes } from './mail-objects.js';
import { parseInboundMime } from './mailbox-ingest.js';

const MAX = 8 * 1024 * 1024;
const metadata = z
  .object({
    kid: z.string().max(120),
    folder: z.string().max(255),
    date: z.iso.datetime({ offset: true }),
    flags: z.array(z.string().max(64)).max(64),
    size: z.number().int().min(0).max(MAX),
  })
  .strict();
/** Authenticated before reading. Hold at most a 64KiB index prefix while R2 consumes
 * raw octets; verify size and digest in the stream before publishing any UID. */
export async function streamedAppend(c: Ctx, encoded: string, digest: string) {
  const p = metadata.parse(JSON.parse(Buffer.from(encoded, 'base64').toString())),
    rt = c.env;
  if (Number(c.req.header('content-length')) !== p.size)
    throw new ApiError(422, 'INVALID_LENGTH', 'Invalid append length.');
  const auth = principal(rt, 'imap', sql`p.id=${p.kid}`),
    who = (await rt.db.execute<{ w: string; b: string }>(auth)).rows[0];
  if (!who) throw new ApiError(403, 'CREDENTIAL_REVOKED', 'Protocol access denied.');
  const mid = id('msg'),
    key = mailKey(who.w, 'kept', who.b, mid),
    bucket = boundMailBucket(rt) ?? (!rt.config.multiTenant ? 'local:' : null);
  if (!bucket) throw new ApiError(503, 'MAIL_STORE_UNAVAILABLE', 'Mail store unavailable.');
  const prefix = new Uint8Array(Math.min(p.size, 65536)),
    hash = createHash('sha256');
  let bytes = 0;
  const input = c.req.raw.body ?? new Blob([]).stream();
  const stream = input.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        if (bytes + chunk.length > p.size) throw new ApiError(413, 'TOO_LARGE', 'Size exceeded.');
        if (bytes < prefix.length) prefix.set(chunk.subarray(0, prefix.length - bytes), bytes);
        bytes += chunk.length;
        hash.update(chunk);
        ctl.enqueue(chunk);
      },
      flush() {
        if (bytes !== p.size || hash.digest('hex') !== digest)
          throw new ApiError(422, 'INVALID_CONTENT', 'Invalid append content.');
      },
    }),
  );
  return rt.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT FROM inbox_state WHERE workspace_id=${who.w} AND inbox_id=${who.b} FOR UPDATE`);
    if (!(await tx.execute(auth)).rowCount) throw new ApiError(403, 'CREDENTIAL_REVOKED', 'Protocol access denied.');
    const available = await tx.execute(
      sql`SELECT FROM inbox_state s JOIN mailboxes b ON b.id=s.inbox_id WHERE s.inbox_id=${who.b} AND s.messages<coalesce(b.quota_messages,100000) AND s.bytes+${p.size}<=coalesce(b.quota_bytes,1073741824)`,
    );
    if (!available.rowCount) throw new ApiError(409, 'OVERQUOTA', 'Append quota exceeded.');
    await withMailObjects(rt, who.w, '', bucket, async (o) => {
      if (bucket === 'local:') {
        await o.put(key, await readMailBytes(stream, p.size, MAX), 'message/rfc822');
      } else {
        await o.put(key, { stream, length: p.size }, 'message/rfc822');
      }
    });
    const cut = Buffer.from(prefix).indexOf('\r\n\r\n'),
      header = cut < 0 ? null : cut + 4;
    const m = header !== null ? await parseInboundMime(prefix.subarray(0, header)) : null;
    const row = (
      await tx.execute<{ r: { pairs: number[][]; validity: number; error?: string } }>(
        sql`SELECT mailgw_append(${who.w},${who.b},${p.folder},${mid},${id('thr')},${m?.messageId ?? null},${m?.subject ?? ''},${m?.from?.address ?? ''},'',${p.date}::timestamptz,${p.size},${bucket},${key},${header === null ? null : JSON.stringify({ headerLength: header })}::jsonb,${sql.param(p.flags)}::text[]) r`,
      )
    ).rows[0]!.r;
    if (row.error || row.pairs[0]?.[0] === 1) await withMailObjects(rt, who.w, '', bucket, (o) => o.delete([key]));
    if (row.error) throw new ApiError(409, 'APPEND_REFUSED', 'Append refused.');
    return row;
  });
}
