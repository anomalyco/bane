import { isIP } from 'node:net';
import { ApiError, type PublicImage } from '../core.js';

const MAX_BYTES = 8 * 1024 * 1024;
const types = new Set<PublicImage['contentType']>(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function publicImageUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new ApiError(422, 'PUBLIC_IMAGE_URL_INVALID', 'Provide a public HTTPS image URL.', 'url'); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') || isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example|onion|arpa)$/.test(host) || host === 'metadata.google.internal') throw new ApiError(422, 'PUBLIC_IMAGE_URL_INVALID', 'Image imports require a public HTTPS DNS name without credentials, fragments, IP literals or custom ports.', 'url');
  return url.toString();
}

export function publicImageImporter() {
  return async (value: string): Promise<PublicImage> => {
    let response: Response;
    try { response = await fetch(publicImageUrl(value), { redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: { accept: 'image/png,image/jpeg,image/gif,image/webp' } }); }
    catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(503, 'PUBLIC_IMAGE_FETCH_FAILED', 'The public image could not be downloaded.', undefined, true); }
    return readPublicImage(response);
  };
}
/** The image type its leading bytes identify, or undefined. */
function imageType(data: Uint8Array): PublicImage['contentType'] | undefined {
  const ascii = (from: number, to: number) => String.fromCharCode(...data.subarray(from, to));
  if (data[0] === 0x89 && ascii(1, 8) === 'PNG\r\n\x1a\n') return 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(ascii(0, 6))) return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
}
/**
 * Bounded read of an image download: status, type and the 8 MiB limit. `fromBytes` takes the type
 * from the image's own bytes instead of the Content-Type header, for Nightmail's own mail-object links,
 * which serve every attachment as application/octet-stream.
 */
export async function readPublicImage(response: Response, fromBytes = false): Promise<PublicImage> {
  if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new ApiError(422, 'PUBLIC_IMAGE_REDIRECT_NOT_ALLOWED', 'Use the image’s final HTTPS URL; redirects are not followed.', 'url'); }
  if (!response.ok) { await response.body?.cancel(); throw new ApiError(422, 'PUBLIC_IMAGE_FETCH_FAILED', `The public image returned HTTP ${response.status}.`, 'url'); }
  const unsupported = () => new ApiError(422, 'PUBLIC_IMAGE_TYPE_UNSUPPORTED', 'The URL must return PNG, JPEG, GIF or WebP image bytes.', 'url');
  const declared = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() as PublicImage['contentType'] | undefined;
  if (!fromBytes && (!declared || !types.has(declared))) { await response.body?.cancel(); throw unsupported(); }
  if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body?.cancel(); throw new ApiError(413, 'PUBLIC_IMAGE_TOO_LARGE', 'Imported images must be at most 8 MiB.'); }
  if (!response.body) throw new ApiError(422, 'PUBLIC_IMAGE_EMPTY', 'The public image response was empty.', 'url');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const { done, value: chunk } = await reader.read(); if (done) break; size += chunk.byteLength; if (size > MAX_BYTES) { await reader.cancel(); throw new ApiError(413, 'PUBLIC_IMAGE_TOO_LARGE', 'Imported images must be at most 8 MiB.'); } chunks.push(chunk); }
  } finally { reader.releaseLock(); }
  if (!size) throw new ApiError(422, 'PUBLIC_IMAGE_EMPTY', 'The public image response was empty.', 'url');
  const data = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  const contentType = fromBytes ? imageType(data) : declared;
  if (!contentType) throw unsupported();
  return { data, contentType };
}
