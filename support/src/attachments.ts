import type { Env } from './env.js';
import { cleanImage, type CleanImage } from './image.js';
import { MissingSecret, purposeKey, sign, verify } from './tokens.js';

// Screenshots in a conversation (support/PROTOCOL.md §5.1): up to five, stored in the stage's private uploads bucket
// (UPLOADS) after image.ts has checked the bytes and removed metadata. The model sees them as images; tickets carry
// links that expire. Retention follows the conversation: deleted with it (closed + 7 days) unless a ticket holds it,
// and the bucket's lifecycle rule (90 days, the transcripts' retention) is the backstop.

export const MAX_ATTACHMENTS = 5;
/** What the model is sent per image. DO SQLite values are capped at 2 MB and OpenCode keeps prompts in it as base64. */
const MODEL_IMAGE_BYTES = 1_400_000;
const LINK_SECONDS = 7 * 86_400;

export type Attachment = { id: string; key: string; type: string; size: number; width: number | null; height: number | null; source: 'chat' | 'email'; name: string };
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export const attachmentKey = (conversationId: string, id: string, type: string) => `conversations/${conversationId}/${id}.${EXT[type] ?? 'bin'}`;
export const safeName = (name: string | null | undefined, fallback: string) => (name ?? '').replace(/[^\w .()-]+/g, '').trim().slice(0, 80) || fallback;

export async function storeImage(env: Env, conversationId: string, id: string, image: CleanImage, source: Attachment['source'], name: string): Promise<Attachment> {
  const key = attachmentKey(conversationId, id, image.type);
  await env.UPLOADS.put(key, image.bytes, { httpMetadata: { contentType: image.type }, customMetadata: { conversation: conversationId, source } });
  return { id, key, type: image.type, size: image.bytes.length, width: image.width, height: image.height, source, name };
}

/** Reads a body up to `limit` bytes; null when it is longer (never buffers more than the limit). */
export async function readCapped(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array();
  const reader = body.getReader(), chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

const b64 = (bytes: Uint8Array) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };

/** The image as the model receives it: a data URI, downscaled with the Images binding when one is bound and it's large. */
export async function modelImage(env: Env, attachment: Attachment): Promise<{ uri: string; name: string } | null> {
  const object = await env.UPLOADS.get(attachment.key);
  if (!object) return null;
  let bytes: Uint8Array = new Uint8Array(await object.arrayBuffer()), type = attachment.type;
  if (bytes.length > MODEL_IMAGE_BYTES && env.IMAGES) {
    try {
      const result = await env.IMAGES.input(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream()).transform({ width: 1568, height: 1568, fit: 'scale-down' }).output({ format: 'image/webp', quality: 82 });
      const smaller = new Uint8Array(await new Response(result.image()).arrayBuffer());
      // The Images output is a new file without metadata; still check it like an upload.
      const checked = cleanImage(smaller);
      bytes = checked.bytes; type = checked.type;
    } catch (error) { console.warn(JSON.stringify({ level: 'warn', code: 'IMAGE_RESIZE_FAILED', message: String(error).slice(0, 200) })); }
  }
  if (bytes.length > MODEL_IMAGE_BYTES) return null;
  return { uri: `data:${type};base64,${b64(bytes)}`, name: attachment.name };
}

/** A link to one attachment that works for 7 days (the team's ticket email and the staff page). */
export async function attachmentLink(env: Env, conversationId: string, attachment: Pick<Attachment, 'id'>, now = Date.now()) {
  const exp = Math.floor(now / 1000) + LINK_SECONDS, payload = `a1.${conversationId}.${attachment.id}.${exp}`;
  return `${env.PUBLIC_URL}/attachments/${conversationId}/${attachment.id}?exp=${exp}&sig=${await sign(await purposeKey(env.SUPPORT_ROOT_SECRET, 'attachment/v1'), payload)}`;
}
export async function readAttachmentLink(env: Env, conversationId: string, id: string, exp: string | null, sig: string | null, now = Date.now()) {
  if (!exp || !sig || !/^\d{10}$/.test(exp) || Number(exp) * 1000 <= now || !/^[A-Za-z0-9_-]{20,64}$/.test(sig)) return false;
  try { return await verify(await purposeKey(env.SUPPORT_ROOT_SECRET, 'attachment/v1'), `a1.${conversationId}.${id}.${exp}`, sig); }
  catch (error) { if (error instanceof MissingSecret) throw error; return false; }
}

/** Serves one stored attachment as a sandboxed image, never as a page. */
export async function serveAttachment(env: Env, conversationId: string, id: string) {
  const listed = await env.UPLOADS.list({ prefix: `conversations/${conversationId}/${id}.`, limit: 1 });
  const key = listed.objects[0]?.key;
  const object = key ? await env.UPLOADS.get(key) : null;
  if (!object) return new Response(null, { status: 404 });
  return new Response(object.body, { headers: { 'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream', 'content-disposition': 'inline', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox", 'cache-control': 'private, max-age=300', 'referrer-policy': 'no-referrer' } });
}

export async function deleteConversationUploads(env: Env, conversationId: string) {
  let cursor: string | undefined;
  do {
    const page = await env.UPLOADS.list({ prefix: `conversations/${conversationId}/`, cursor });
    if (page.objects.length) await env.UPLOADS.delete(page.objects.map(o => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
