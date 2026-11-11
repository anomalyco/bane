import type { S3Client } from '@aws-sdk/client-s3';
import { ApiError, lazyModule, type Runtime } from './core.js';
import { assertMailboxKey } from './mailbox-setup.js';

type Body = Uint8Array | { stream: ReadableStream<Uint8Array>; length: number };
type Range = { offset: number; length: number };
export interface MailObjects {
  put(key: string, body: Body, contentType: string): Promise<void>;
  get(key: string, range?: Range): Promise<ReadableStream<Uint8Array> | null>;
  head(key: string): Promise<number | null>;
  delete(keys: string[]): Promise<void>;
}
const missing = () => new ApiError(404, 'MAILBOX_OBJECT_NOT_FOUND', 'The mail object was not found.');
export function assertMailKey(wid: string, key: string) {
  const parts = key.split('/');
  if (!['d','a','e','k'].includes(parts[0]) || parts[1] !== wid || parts.length < 3 || parts.some(p => !p || p === '.' || p === '..' || /[\\\x00-\x1f]/.test(p))) throw missing();
}
export function r2MailObjects(wid: string, bucket: R2Bucket): MailObjects {
  return {
    async put(key, body, contentType) {
      assertMailKey(wid, key);
      const httpMetadata = { contentType };
      if (body instanceof Uint8Array) {
        const sha256 = await crypto.subtle.digest('SHA-256', body as BufferSource);
        await bucket.put(key, body, {httpMetadata, sha256});
      } else {
        const fixed = new FixedLengthStream(body.length);
        await Promise.all([bucket.put(key, fixed.readable, {httpMetadata}), body.stream.pipeTo(fixed.writable)]);
      }
    },
    async get(key, range) { assertMailKey(wid, key); return (await bucket.get(key, { range }))?.body ?? null; },
    async head(key) { assertMailKey(wid, key); return (await bucket.head(key))?.size ?? null; },
    async delete(keys) { keys.forEach(k => assertMailKey(wid, k)); for(let i=0;i<keys.length;i+=1000) await bucket.delete(keys.slice(i,i+1000)); },
  };
}
const loadS3 = lazyModule(() => import('@aws-sdk/client-s3'));
export function s3MailObjects(wid: string, client: S3Client, bucket: string): MailObjects {
  const loc = (key: string) => { assertMailboxKey(wid,key,key.startsWith(`workspaces/${wid}/raw/`)?'raw':'att'); return { Bucket: bucket, Key: key }; };
  return {
    async put(key, body, contentType) { const s3 = await loadS3(); await client.send(new s3.PutObjectCommand({...loc(key), Body:body instanceof Uint8Array ? body : body.stream, ContentLength:body.length, ContentType:contentType})); },
    async get(key, range) { const s3=await loadS3(); try { const obj=await client.send(new s3.GetObjectCommand({...loc(key), Range:range?`bytes=${range.offset}-${range.offset+range.length-1}`:undefined})); return obj.Body?.transformToWebStream() ?? null; } catch(e) { if(e instanceof Error && e.name==='NoSuchKey') return null; throw e; } },
    async head(key) { const s3=await loadS3(); try {return (await client.send(new s3.HeadObjectCommand(loc(key)))).ContentLength ?? null;} catch(e){if(e instanceof Error && e.name==='NotFound') return null; throw e;} },
    async delete(keys) { const s3=await loadS3(); const objects=keys.map(key=>({Key:loc(key).Key})); for(let i=0;i<objects.length;i+=1000){ const res=await client.send(new s3.DeleteObjectsCommand({Bucket:bucket,Delete:{Objects:objects.slice(i,i+1000),Quiet:true}})); if(res.Errors?.length)throw new Error('Mail object deletion incomplete'); } },
  };
}
export function mailObjectsFor(runtime:Runtime,wid:string,bucket:string,s3?:S3Client) {
  if(bucket.startsWith('r2:')) {
    if(!runtime.mailR2 || bucket!==`r2:${runtime.mailR2.name}`)throw missing();
    return r2MailObjects(wid,runtime.mailR2.bucket);
  }
  if(!s3)throw missing(); return s3MailObjects(wid,s3,bucket);
}
