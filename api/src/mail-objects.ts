import type { S3Client } from '@aws-sdk/client-s3';
import { ApiError, lazyModule, type Runtime, type Storage } from './core.js';
import type { IngestInput } from './mailbox-ingest-input.js';
import { assertMailboxKey, mailboxS3, receivedAttachmentKey, sentAttachmentKey, workspacePrefix } from './mailbox-setup.js';
import type { ReadyConnection } from './provider-credentials.js';

/**
 * The one store for received and archived mail objects. Ingest, downloads, reply reuse, the GC
 * job and later IMAP all go through `MailObjects`. The bucket column (`mail_messages.raw_bucket`,
 * `mail_attachments.bucket`) says which store holds an object:
 * - `r2:<name>`: the hosted R2 mail bucket (binding `MAIL`), with keys from `mailKey`;
 * - `local:`: the runtime's private object storage (sandbox inboxes on Node only);
 * - anything else: an S3 bucket with `workspaces/<wid>/{raw,att}/` keys (SES pool, BYO, self-hosted).
 * S3 bucket names cannot contain `:`, so the prefixes never collide.
 */
export interface MailObjects {
  put(key: string, body: Uint8Array | { stream: ReadableStream<Uint8Array>; length: number }, contentType: string): Promise<void>;
  get(key: string, range?: { offset: number; length: number }): Promise<ReadableStream<Uint8Array> | null>;
  head(key: string): Promise<number | null>;
  delete(keys: string[]): Promise<void>;
}
/** Kept raw has no lifecycle deadline; membership GC owns its deletion. */
export type MailClass = 'default' | 'ephemeral' | 'kept';

const R2 = 'r2:', LOCAL = 'local:';
export const isS3Bucket = (bucket: string) => !bucket.includes(':');
const missing = () => new ApiError(404, 'MAILBOX_OBJECT_NOT_FOUND', 'The mail object was not found.');

/**
 * R2 key layout. The class prefix comes first so one lifecycle rule matches it (`d/` 90 days, `e/`
 * 45-day backstop); the workspace second for the tenant check; ephemeral keys add the owning inbox
 * so an inbox's objects can be listed or erased together.
 */
export function mailKey(wid: string, cls: MailClass, inboxId: string | null | undefined, messageId: string, file?: { batch: string; id: string }) {
  if (cls === 'ephemeral' && !inboxId) throw new Error('Ephemeral mail keys need the owning inbox');
  const owner = cls === 'ephemeral' ? `e/${wid}/${inboxId}` : cls==='kept'&&!file ? `k/${wid}` : null;
  const key = file ? `${owner ?? `a/${wid}`}/${messageId}/${file.batch}/${file.id}` : `${owner ?? `d/${wid}`}/${messageId}.eml`;
  assertMailKey(wid, key);
  return key;
}
/** The R2 counterpart of `assertMailboxKey`: checked before every R2 or local GET, PUT and delete. */
export function assertMailKey(wid: string, key: string) {
  const parts = key.split('/');
  if (!['d', 'a', 'e', 'k'].includes(parts[0]!) || parts[1] !== wid || parts.length < 3 || parts.some(p => !p || p === '.' || p === '..' || /[\\\x00-\x1f]/.test(p))) throw missing();
}

/**
 * Hosted mail goes to R2 when `BANE_MAIL_STORE=r2`. Inbox mail always goes to R2 when `MAIL` is
 * bound, so erasing it never needs an S3 delete grant, including after a rollback of the switch.
 */
export function hostedMailBucket(runtime: Runtime, cls: MailClass) {
  return runtime.mailR2?.write || cls !== 'default' ? boundMailBucket(runtime) : null;
}
/** The bucket column value of the bound R2 mail bucket, which Bane-signed download links stream from. */
export const boundMailBucket = (runtime: Runtime) => runtime.mailR2 ? `${R2}${runtime.mailR2.name}` : null;
/** Hosted agent inboxes ship with the R2 store; self-hosted installs use their configured S3 bucket. */
export const inboxStoreReady = (runtime: Runtime) => !runtime.config.multiTenant || !!runtime.mailR2?.write;

export function r2MailObjects(wid: string, bucket: R2Bucket): MailObjects {
  return {
    async put(key, body, contentType) {
      assertMailKey(wid, key);
      const httpMetadata = { contentType };
      if (body instanceof Uint8Array) await bucket.put(key, body, { httpMetadata, sha256: await crypto.subtle.digest('SHA-256', body as BufferSource) });
      else {
        const fixed = new FixedLengthStream(body.length);
        await Promise.all([bucket.put(key, fixed.readable, { httpMetadata }), body.stream.pipeTo(fixed.writable)]);
      }
    },
    async get(key, range) { assertMailKey(wid, key); return (await bucket.get(key, { range }))?.body ?? null; },
    async head(key) { assertMailKey(wid, key); return (await bucket.head(key))?.size ?? null; },
    async delete(keys) {
      keys.forEach(k => assertMailKey(wid, k));
      for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
    },
  };
}
const loadS3 = lazyModule(() => import('@aws-sdk/client-s3'));
export function s3MailObjects(wid: string, client: S3Client, bucket: string): MailObjects {
  const loc = (key: string) => { assertMailboxKey(wid, key, key.startsWith(workspacePrefix(wid, 'raw')) ? 'raw' : 'att'); return { Bucket: bucket, Key: key }; };
  const absent = (e: unknown, ...names: string[]) => e instanceof Error && names.includes(e.name);
  return {
    async put(key, body, contentType) {
      const s3 = await loadS3();
      await client.send(new s3.PutObjectCommand({ ...loc(key), Body: body instanceof Uint8Array ? body : body.stream, ContentLength: body.length, ContentType: contentType,
        ...(key.startsWith(`${workspacePrefix(wid,'raw')}kept/`)?{Tagging:'bane-kind=kept'}:{}) }));
    },
    async get(key, range) {
      const s3 = await loadS3();
      try {
        const obj = await client.send(new s3.GetObjectCommand({ ...loc(key), Range: range ? `bytes=${range.offset}-${range.offset + range.length - 1}` : undefined }));
        return obj.Body?.transformToWebStream() ?? null;
      } catch (e) { if (absent(e, 'NoSuchKey')) return null; throw e; }
    },
    async head(key) {
      const s3 = await loadS3();
      try { return (await client.send(new s3.HeadObjectCommand(loc(key)))).ContentLength ?? null; } catch (e) { if (absent(e, 'NotFound')) return null; throw e; }
    },
    async delete(keys) {
      const s3 = await loadS3(), objects = keys.map(key => ({ Key: loc(key).Key }));
      for (let i = 0; i < objects.length; i += 1000) {
        const res = await client.send(new s3.DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects.slice(i, i + 1000), Quiet: true } }));
        if (res.Errors?.some(e => e.Code === 'AccessDenied')) throw Object.assign(new Error('Mail object deletion denied'), { name: 'AccessDenied' });
        if (res.Errors?.length) throw new Error('Mail object deletion incomplete');
      }
    },
  };
}
/** Small whole objects only: sandbox mail on Node, where no receiving bucket exists. */
function storageMailObjects(wid: string, storage: Storage): MailObjects {
  return {
    async put(key, body, contentType) {
      assertMailKey(wid, key);
      if (!(body instanceof Uint8Array)) throw new Error('Local mail storage accepts whole objects only');
      await storage.put(key, body, contentType);
    },
    async get(key, range) {
      assertMailKey(wid, key);
      const object = await storage.get(key);
      return object && new Blob([range ? object.body.slice(range.offset, range.offset + range.length) : object.body] as BlobPart[]).stream();
    },
    async head(key) { assertMailKey(wid, key); return (await storage.get(key))?.body.length ?? null; },
    async delete(keys) { keys.forEach(k => assertMailKey(wid, k)); for (const k of keys) await storage.delete(k); },
  };
}
/** The store a bucket column names. S3 buckets need the caller's client for that bucket's credentials. */
export function mailObjectsFor(runtime: Runtime, wid: string, bucket: string, s3?: S3Client): MailObjects {
  if (bucket.startsWith(R2)) {
    if (!runtime.mailR2 || bucket !== `${R2}${runtime.mailR2.name}`) throw missing();
    return r2MailObjects(wid, runtime.mailR2.bucket);
  }
  if (bucket === LOCAL) return storageMailObjects(wid, runtime.storage);
  if (!s3 || !isS3Bucket(bucket)) throw missing();
  return s3MailObjects(wid, s3, bucket);
}
/** Run against a bucket's store, creating (and closing) an S3 client only when the bucket is in S3. */
export async function withMailObjects<T>(runtime: Runtime, wid: string, region: string, bucket: string, work: (objects: MailObjects, s3?: S3Client) => Promise<T>, options: { binding?: ReadyConnection | null; client?: S3Client } = {}) {
  const s3 = !isS3Bucket(bucket) ? undefined : options.client ?? await mailboxS3(runtime, wid, region, bucket, runtime.db, options.binding);
  try { return await work(mailObjectsFor(runtime, wid, bucket, s3), s3); } finally { if (!options.client) s3?.destroy(); }
}

/** Where ingest writes one received message: R2 under its class prefix on hosted, else the receipt's S3 bucket. */
export function receivedMailStore(runtime: Runtime, wid: string, receipt: Pick<IngestInput, 'bucket' | 'binding' | 'delivery'>, s3: S3Client, ids: { messageId: string; sesMessageId: string }, forceInboxStore=false) {
  const lifecycle: MailClass = receipt.delivery?.lifecycle==='kept'?'kept':receipt.delivery?.lifecycle === 'ephemeral' ? 'ephemeral' : 'default', inbox = receipt.delivery?.prefixInbox;
  const r2 = runtime.config.multiTenant && receipt.binding?.kind === 'shared' ? hostedMailBucket(runtime, forceInboxStore?'kept':lifecycle) : null;
  if (r2) return { lifecycle, bucket: r2, r2: true, objects: mailObjectsFor(runtime, wid, r2), rawKey: mailKey(wid, lifecycle, inbox, ids.messageId), fileKey: (batch: string, id: string) => mailKey(wid, lifecycle, inbox, ids.messageId, { batch, id }) };
  return { lifecycle, bucket: receipt.bucket, r2: false, objects: s3MailObjects(wid, s3, receipt.bucket), rawKey: `${workspacePrefix(wid, 'raw')}${lifecycle==='kept'?`kept/${ids.messageId}`:ids.sesMessageId}.eml`, fileKey: (batch: string, id: string) => receivedAttachmentKey(wid, ids.messageId, batch, id) };
}
/** Archive key for a file sent from an address or inbox; the bucket comes from the sending domain's store. */
export const sentMailKey = (wid: string, bucket: string, inboxId: string | null, messageId: string, attachmentId: string) =>
  isS3Bucket(bucket) ? sentAttachmentKey(wid, messageId, attachmentId) : mailKey(wid, inboxId ? 'ephemeral' : 'default', inboxId, messageId, { batch: 'sent', id: attachmentId });
/** Synthetic sandbox mail: R2 when bound, else the runtime's private storage. It never touches SES or S3. */
export function sandboxMailStore(runtime: Runtime, wid: string) {
  const bucket = boundMailBucket(runtime) ?? LOCAL;
  return { bucket, objects: mailObjectsFor(runtime, wid, bucket) };
}

/** A BYO bucket is not trusted to honor Content-Length or byte ranges. */
export async function readMailBytes(body: ReadableStream<Uint8Array>, size: number, limit: number) {
  if (!Number.isSafeInteger(size) || size < 0 || size > limit) {
    await body.cancel();
    throw new ApiError(413, 'ATTACHMENT_LIMIT_EXCEEDED', 'The attachment exceeds the byte limit.');
  }
  const reader = body.getReader(), bytes = new Uint8Array(size);
  let at = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (at + chunk.value.length > size) throw new Error('Mail object length changed');
      bytes.set(chunk.value, at);
      at += chunk.value.length;
    }
    if (at !== size) throw new Error('Incomplete mail object');
    return bytes;
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  } finally {
    reader.releaseLock();
  }
}
