import { ApiError, lazyModule, ModuleLoadError } from '../core.js';
import type { Storage } from '../core.js';
const MAX_OBJECT_BYTES = 8 * 1024 * 1024;
const loadS3Sdk = lazyModule(() => Promise.all([import('@aws-sdk/client-s3'), import('@smithy/fetch-http-handler')]));
export function r2Storage(bucket: R2Bucket): Storage {
  return {
    cacheScope: bucket,
    async put(key, body, contentType) { await bucket.put(key, body, { httpMetadata: { contentType } }); },
    async get(key) {
      const object = await bucket.get(key);
      if (!object) return null;
      if (object.size > MAX_OBJECT_BYTES) throw new ApiError(413, 'ATTACHMENT_TOO_LARGE', 'Stored attachment exceeds the supported size limit.');
      return { body: new Uint8Array(await object.arrayBuffer()), contentType: object.httpMetadata?.contentType ?? 'application/octet-stream' };
    },
    async delete(key) { await bucket.delete(key); },
  };
}
export function s3Storage(env: Record<string, string | undefined>): Storage {
  if (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) throw new ApiError(503, 'CONFIG_INVALID', 'S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required.');
  const bucket = env.S3_BUCKET, accessKeyId = env.S3_ACCESS_KEY_ID, secretAccessKey = env.S3_SECRET_ACCESS_KEY;
  let clientPromise: Promise<{ client: import('@aws-sdk/client-s3').S3Client; s3: typeof import('@aws-sdk/client-s3') }> | undefined;
  const getClient = () => clientPromise ??= loadS3Sdk().then(([s3, { FetchHttpHandler }]) => ({
    s3,
    client: new s3.S3Client({ region: env.S3_REGION ?? 'us-east-1', endpoint: env.S3_ENDPOINT, forcePathStyle: Boolean(env.S3_ENDPOINT), credentials: { accessKeyId, secretAccessKey }, requestHandler: new FetchHttpHandler({ requestTimeout: 15000 }), maxAttempts: 2 }),
  })).catch(error => { clientPromise = undefined; throw error; });
  return {
    async put(key, body, contentType) { const { client, s3 } = await getClient(); await client.send(new s3.PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType })); },
    async get(key) {
      try {
        const { client, s3 } = await getClient();
        const object = await client.send(new s3.GetObjectCommand({ Bucket: bucket, Key: key }));
        if ((object.ContentLength ?? Infinity) > MAX_OBJECT_BYTES) throw new ApiError(413, 'ATTACHMENT_TOO_LARGE', 'Stored attachment exceeds the supported size limit.');
        if (!object.Body) return null;
        return { body: await object.Body.transformToByteArray(), contentType: object.ContentType ?? 'application/octet-stream' };
      } catch (error) {
        if (error instanceof ModuleLoadError) throw error;
        if (error instanceof Error && error.name === 'NoSuchKey') return null;
        throw error;
      }
    },
    async delete(key) { const { client, s3 } = await getClient(); await client.send(new s3.DeleteObjectCommand({ Bucket: bucket, Key: key })); },
  };
}
