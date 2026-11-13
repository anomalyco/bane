// Small synthetic images with metadata to strip: the bytes the upload and email tests send. Not decodable pictures
// (nothing here decodes them), but structurally valid files of each type.
import { crc32 } from 'node:zlib';

const be32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const le32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const pngChunk = (type: string, data: Buffer) => Buffer.concat([be32(data.length), Buffer.from(type), data, be32(crc32(Buffer.concat([Buffer.from(type), data])))]);

export const SECRET_TEXT = 'GPS 52.37N 4.89E Ada iPhone';
export function pngWithMetadata(width = 64, height = 32, idatBytes = 64, tail = '') {
  const ihdr = Buffer.concat([be32(width), be32(height), Buffer.from([8, 6, 0, 0, 0])]);
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('tEXt', Buffer.from(`Comment\0${SECRET_TEXT}`)),
    pngChunk('eXIf', Buffer.from(`MM\0*${SECRET_TEXT}`)), pngChunk('sRGB', Buffer.from([0])), pngChunk('IDAT', Buffer.alloc(idatBytes, 7)), pngChunk('tIME', Buffer.alloc(7, 1)), pngChunk('IEND', Buffer.alloc(0)), Buffer.from(tail)]));
}
export function jpegWithMetadata(width = 40, height = 20, tail = '') {
  const seg = (marker: number, data: Buffer) => Buffer.concat([Buffer.from([0xff, marker]), Buffer.from([(data.length + 2) >> 8, (data.length + 2) & 0xff]), data]);
  const sof = Buffer.from([8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0]);
  return new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'binary')), seg(0xe1, Buffer.from(`Exif\0\0${SECRET_TEXT}`)), seg(0xfe, Buffer.from(SECRET_TEXT)),
    seg(0xdb, Buffer.alloc(65, 1)), seg(0xc0, sof), seg(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])), Buffer.alloc(32, 0x55), Buffer.from([0xff, 0xd9]), Buffer.from(tail)]));
}
export function webpWithMetadata(width = 30, height = 10, extra = '') {
  const chunk = (type: string, data: Buffer) => Buffer.concat([Buffer.from(type), le32(data.length), data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  const vp8x = Buffer.concat([Buffer.from([0x0c, 0, 0, 0]), Buffer.from([(width - 1) & 0xff, (width - 1) >> 8, 0, (height - 1) & 0xff, (height - 1) >> 8, 0])]);
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  const vp8l = Buffer.concat([Buffer.from([0x2f]), le32(bits), Buffer.alloc(11, 3)]);
  const body = Buffer.concat([Buffer.from('WEBP'), chunk('VP8X', vp8x), chunk('VP8L', vp8l), chunk('EXIF', Buffer.from(`MM\0*${SECRET_TEXT}`)), chunk('XMP ', Buffer.from(`<x>${SECRET_TEXT}</x>`)), ...(extra ? [chunk('ZZZZ', Buffer.from(extra))] : [])]);
  return new Uint8Array(Buffer.concat([Buffer.from('RIFF'), le32(body.length), body]));
}
