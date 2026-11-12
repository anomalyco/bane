import { sql } from 'drizzle-orm';
import { Buffer } from 'node:buffer';
import { ApiError, type DbExecutor, type Runtime } from './core.js';
import { readMailBytes, withMailObjects } from './mail-objects.js';

const CACHE_BYTES=16*1024, MESSAGE_LIMIT=40*1024*1024;
function headerEnd(b:Buffer) {
  if(b[0]===10)return 1;
  if(b[0]===13 && b[1]===10)return 2;
  for(let i=b.indexOf(10);i>=0;i=b.indexOf(10,i+1)){
    if(b[i+1]===10)return i+2;
    if(b[i+1]===13 && b[i+2]===10)return i+3;
  }
  return 0;
}
// Store a complete small object or an exact root header block. Never present a prefix as a full header.
export function wirePreview(source: Uint8Array, size: number) {
  const b = Buffer.from(source.buffer, source.byteOffset, Math.min(source.byteLength, CACHE_BYTES));
  const complete = size === b.length;
  const length = complete ? size : headerEnd(b);
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
// Read an exact small object or its entire root header. On legacy objects
// without MIME metadata, expand the range only until the separator or EOF.
export async function objectProjection(rt:Runtime, workspace:string, r:Pick<Row,'size'|'header'|'region'|'bucket'|'key'>) {
  if(!Number.isSafeInteger(r.size)||r.size<0||r.size>MESSAGE_LIMIT)throw new ApiError(413,'MESSAGE_LIMIT','Message too large.');
  return withMailObjects(rt,workspace,r.region,r.bucket,async o=>{
    let length=Math.min(r.size,Math.max(CACHE_BYTES,r.header??0));
    for(;;){
      const stream=length?await o.get(r.key,{offset:0,length}):null;
      if(length&&!stream)throw new ApiError(404,'MISSING_BODY','Body unavailable.');
      const bytes=stream?Buffer.from(await readMailBytes(stream,length,MESSAGE_LIMIT)):Buffer.alloc(0);
      const end=headerEnd(bytes);
      if(length===r.size || end){
        const complete=length===r.size && (length<=CACHE_BYTES||!end);
        return {bytes:bytes.subarray(0,complete?length:end||length),complete,end:end||length};
      }
      length=Math.min(r.size,length*2);
    }
  });
}
/** Existing immutable objects need no offline migration. Limit both the concurrent
 * range reads and the total returned bytes; never label an incomplete header as exact. */
export async function previewPage(rt: Runtime, workspace: string, rows: Row[], writer: ReturnType<typeof sql>) {
  if(rows.length>1 && rows.reduce((n,r)=>n+r.size,0)>4*1024*1024)throw new ApiError(413,'PAGE_LIMIT','Request a smaller projection page.');
  const items: { uid: number; raw: string; complete: boolean }[] = [];
  const fill:{mid:string;key:string;prefix:string;complete:boolean}[]=[];
  let next = 0;
  async function worker() {
    while (next < rows.length) {
      const r = rows[next++]!;
      if (r.raw !== null) {
        items.push({ uid: r.uid, raw: r.raw, complete: !!r.complete });
        continue;
      }
      if (!r.key || !r.bucket || !r.size) continue;
      const {bytes,complete}=await objectProjection(rt,workspace,r),raw=bytes.toString('base64');
      items.push({uid:r.uid,raw,complete});
      if(bytes.length<=CACHE_BYTES)fill.push({mid:r.mid,key:r.key,prefix:raw,complete});
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  if(fill.length)await rt.db.execute(sql`WITH a AS MATERIALIZED (${writer}) INSERT INTO mailgw_previews(mid,object_key,prefix,complete)
    SELECT m.id,m.raw_key,x.prefix,x.complete FROM jsonb_to_recordset(${JSON.stringify(fill)}::jsonb) x(mid text,key text,prefix text,complete boolean)
    JOIN mail_messages m ON m.id=x.mid AND m.raw_key=x.key AND m.workspace_id=${workspace} WHERE EXISTS(SELECT FROM a) ORDER BY m.id ON CONFLICT(mid) DO NOTHING`);
  return items;
}
