// Screenshot uploads (chat and email): the type is decided by the bytes, never by a header or a filename, and every
// metadata block is removed by rebuilding the file from an allow-list of the parts an image needs to render. Nothing is
// decoded or re-encoded, so there is no decoder to attack and no decompression to bomb: only structure is walked.

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type ImageType = typeof IMAGE_TYPES[number];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_SIDE = 8000;

export type CleanImage = { type: ImageType; bytes: Uint8Array; width: number | null; height: number | null; removed: string[] };
export class ImageRejected extends Error {
  constructor(readonly code: 'UNSUPPORTED_TYPE' | 'TOO_LARGE' | 'MALFORMED' | 'TOO_MANY_PIXELS', message: string) { super(message); }
}

export function sniff(bytes: Uint8Array): ImageType | null {
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  return null;
}

/** Validates and strips one image. Throws ImageRejected with a code the caller maps to a status. */
export function cleanImage(bytes: Uint8Array, declared?: string | null): CleanImage {
  if (bytes.length > MAX_IMAGE_BYTES) throw new ImageRejected('TOO_LARGE', 'Images can be up to 5 MB.');
  const type = sniff(bytes);
  if (!type) throw new ImageRejected('UNSUPPORTED_TYPE', 'Only PNG, JPEG and WebP images are accepted.');
  if (declared && declared.split(';')[0]!.trim().toLowerCase() !== type) throw new ImageRejected('UNSUPPORTED_TYPE', `The file is a ${type.slice(6).toUpperCase()}, not ${declared}.`);
  const clean = type === 'image/png' ? png(bytes) : type === 'image/jpeg' ? jpeg(bytes) : webp(bytes);
  if ((clean.width ?? 0) > MAX_SIDE || (clean.height ?? 0) > MAX_SIDE) throw new ImageRejected('TOO_MANY_PIXELS', `Images can be up to ${MAX_SIDE} pixels on each side.`);
  return { type, ...clean };
}

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
const u32be = (b: Uint8Array, at: number) => ((b[at]! << 24) >>> 0) + (b[at + 1]! << 16) + (b[at + 2]! << 8) + b[at + 3]!;
const u16be = (b: Uint8Array, at: number) => (b[at]! << 8) + b[at + 1]!;
const u32le = (b: Uint8Array, at: number) => b[at]! + (b[at + 1]! << 8) + (b[at + 2]! << 16) + ((b[at + 3]! << 24) >>> 0);
const u24le = (b: Uint8Array, at: number) => b[at]! + (b[at + 1]! << 8) + (b[at + 2]! << 16);
const malformed = (what: string) => new ImageRejected('MALFORMED', `The ${what} file is damaged.`);
function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** PNG: keep the chunks needed to render (and colour-manage) it; drop text, EXIF, time and anything unknown. */
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'pHYs']);
function png(b: Uint8Array) {
  const parts = [b.subarray(0, 8)], removed: string[] = [];
  let at = 8, width: number | null = null, height: number | null = null, ended = false;
  while (at + 12 <= b.length) {
    const length = u32be(b, at), type = ascii(b, at + 4, 4), end = at + 12 + length;
    if (length > b.length || end > b.length || !/^[A-Za-z]{4}$/.test(type)) throw malformed('PNG');
    if (at === 8 && type !== 'IHDR') throw malformed('PNG');
    if (type === 'IHDR') { width = u32be(b, at + 8); height = u32be(b, at + 12); }
    if (PNG_KEEP.has(type)) parts.push(b.subarray(at, end)); else removed.push(type);
    at = end;
    if (type === 'IEND') { ended = true; break; }
  }
  if (!ended || width === null) throw malformed('PNG');
  return { bytes: concat(parts), width, height, removed };
}

/** JPEG: keep JFIF (APP0), the ICC profile (APP2) and Adobe (APP14); drop EXIF/XMP (APP1), comments and other APPn. */
function jpeg(b: Uint8Array) {
  const parts = [b.subarray(0, 2)], removed: string[] = [];
  let at = 2, width: number | null = null, height: number | null = null;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) throw malformed('JPEG');
    const marker = b[at + 1]!;
    if (marker === 0xff) { at += 1; continue; } // fill byte
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { parts.push(b.subarray(at, at + 2)); at += 2; continue; }
    if (marker === 0xd9) { parts.push(b.subarray(at, at + 2)); return { bytes: concat(parts), width, height, removed }; }
    const length = u16be(b, at + 2), end = at + 2 + length;
    if (length < 2 || end > b.length) throw malformed('JPEG');
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) { height = u16be(b, at + 5); width = u16be(b, at + 7); }
    if (marker === 0xda) {
      // Start of scan: the scans run to the first EOI (inside entropy-coded data 0xFF is always followed by 0x00 or a
      // restart marker, and the markers between progressive scans are never EOI). Anything after EOI is not the image
      // and is dropped, so nothing can ride along in the stored file.
      let eoi = -1;
      for (let i = end; i + 1 < b.length; i++) if (b[i] === 0xff && b[i + 1] === 0xd9) { eoi = i; break; }
      if (width === null || eoi < 0) throw malformed('JPEG');
      parts.push(b.subarray(at, eoi + 2));
      if (eoi + 2 < b.length) removed.push('trailing data');
      return { bytes: concat(parts), width, height, removed };
    }
    const keep = !(marker >= 0xe0 && marker <= 0xef) && marker !== 0xfe
      || marker === 0xe0 || marker === 0xee || (marker === 0xe2 && ascii(b, at + 4, 11) === 'ICC_PROFILE');
    if (keep) parts.push(b.subarray(at, end)); else removed.push(marker === 0xfe ? 'COM' : `APP${marker - 0xe0}`);
    at = end;
  }
  throw malformed('JPEG');
}

/** WebP: keep only image, alpha, animation and ICC chunks; drop EXIF, XMP and anything unknown, and clear the VP8X flags. */
const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);
function webp(b: Uint8Array) {
  if (u32le(b, 4) + 8 > b.length) throw malformed('WebP');
  const chunks: Uint8Array[] = [], removed: string[] = [];
  let at = 12, width: number | null = null, height: number | null = null, vp8x: Uint8Array | null = null;
  const end = Math.min(b.length, u32le(b, 4) + 8);
  while (at + 8 <= end) {
    const type = ascii(b, at, 4), size = u32le(b, at + 4), next = at + 8 + size + (size & 1);
    if (at + 8 + size > end) throw malformed('WebP');
    if (!WEBP_KEEP.has(type)) { removed.push(type.trim()); at = next; continue; }
    const chunk = b.slice(at, Math.min(next, end));
    if (type === 'VP8X') { vp8x = chunk; width = u24le(b, at + 12) + 1; height = u24le(b, at + 15) + 1; }
    else if (type === 'VP8 ' && width === null && size >= 10) { width = u16le14(b, at + 14); height = u16le14(b, at + 16); }
    else if (type === 'VP8L' && width === null && size >= 5 && b[at + 8] === 0x2f) {
      const bits = u32le(b, at + 9); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
    }
    chunks.push(chunk);
    at = next;
  }
  if (!chunks.length || width === null) throw malformed('WebP');
  if (vp8x) vp8x[8] = vp8x[8]! & ~0x0c; // the EXIF (0x08) and XMP (0x04) flags
  const body = concat(chunks), header = new Uint8Array(12);
  header.set(b.subarray(0, 4)); new DataView(header.buffer).setUint32(4, body.length + 4, true); header.set(b.subarray(8, 12), 8);
  return { bytes: concat([header, body]), width, height, removed };
}
const u16le14 = (b: Uint8Array, at: number) => (b[at]! + (b[at + 1]! << 8)) & 0x3fff;
