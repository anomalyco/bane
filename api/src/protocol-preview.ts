import { sql } from 'drizzle-orm';
import type { DbExecutor, Runtime } from './core.js';
import { readMailBytes, withMailObjects } from './mail-objects.js';

// Store a complete small object or an exact root header block. Never present a prefix as a full header.
export function wirePreview(source: Uint8Array, size: number) {
  const b = Buffer.from(source.buffer, source.byteOffset, Math.min(source.byteLength, 2048));
  const complete = size === b.length,
    cut = b.indexOf('\r\n\r\n');
  const length = complete ? size : b[0] === 13 && b[1] === 10 ? 2 : cut >= 0 ? cut + 4 : 0;
  if (!length) return;
  return {prefix:b.subarray(0,length).toString('base64'),complete};
}
export async function savePreview(db: DbExecutor, mid: string, key: string, source: Uint8Array, size: number) {
  const preview=wirePreview(source,size);if(!preview)return;
  await db.execute(
    sql`INSERT INTO mailgw_previews(mid,object_key,prefix,complete) SELECT id,raw_key,${preview.prefix},${preview.complete} FROM mail_messages WHERE id=${mid} AND raw_key=${key} ON CONFLICT(mid) DO NOTHING`,
  );
}

type Row = {
  uid: number;
  mid: string;
  key: string;
  bucket: string;
  region: string;
  size: number;
  header: number | null;
  raw: string | null;
  complete: boolean | null;
};
/** Existing immutable objects need no offline migration. Limit both the concurrent
 * range reads and the total returned bytes; never label an incomplete header as exact. */
export async function previewPage(rt: Runtime, workspace: string, rows: Row[]) {
  const items: { uid: number; raw: string; complete: boolean }[] = [];
  let next = 0;
  async function worker() {
    while (next < rows.length) {
      const r = rows[next++]!;
      if (r.raw !== null) {
        items.push({ uid: r.uid, raw: r.raw, complete: !!r.complete });
        continue;
      }
      if (!r.key || !r.bucket || !r.size) continue;
      const length = Math.min(r.size, r.header !== null && r.size > 2048 ? r.header : 2048, 2048);
      if (length <= 0) continue;
      const bytes = await withMailObjects(rt, workspace, r.region, r.bucket, async (o) => {
        const stream = await o.get(r.key, { offset: 0, length });
        return stream ? Buffer.from(await readMailBytes(stream, length, 2048)) : null;
      });
      if (!bytes) continue;
      const complete = length === r.size,
        cut = bytes.indexOf('\r\n\r\n');
      const n = complete ? length : bytes[0] === 13 && bytes[1] === 10 ? 2 : cut >= 0 ? cut + 4 : 0;
      if (n) items.push({ uid: r.uid, raw: bytes.subarray(0, n).toString('base64'), complete });
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  return items;
}
