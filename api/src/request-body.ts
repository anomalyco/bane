import { ApiError, type Ctx } from './core.js';

// Content-Length is only an early rejection hint. Count the actual bytes before
// handing any of them to JSON, Zod, or the atomic admission fast path.
export async function boundRequestBody(c: Ctx) {
  const raw = c.req.raw;
  if (!raw.body || c.get('boundedBody')) return;
  const max = c.req.path === '/v1/events/ses' ? 512 * 1024 : 12 * 1024 * 1024;
  const tooLarge = () => new ApiError(413, 'REQUEST_TOO_LARGE', `Request exceeds the ${max / 1024} KiB limit.`);
  if (Number(raw.headers.get('content-length')) > max) throw tooLarge();
  const reader = raw.body.getReader();
  const chunks: Uint8Array[] = [];
  let block: Uint8Array | undefined, filled = 0, bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > max) { void reader.cancel().catch(() => {}); throw tooLarge(); }
      // A byte cap alone does not bound millions of one-byte chunk objects.
      for (let offset = 0; offset < value.length;) {
        if (!block) block = new Uint8Array(chunks.length ? 65536 : Math.min(65536, Math.max(1024,value.length)));
        const n = Math.min(value.length-offset,block.length-filled);
        block.set(value.subarray(offset,offset+n),filled); filled+=n; offset+=n;
        if (filled===block.length) { chunks.push(block); block=undefined; filled=0; }
      }
    }
  } finally { reader.releaseLock(); }
  if (block && filled) chunks.push(block.subarray(0,filled));
  c.req.raw = new Request(raw, { body: new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(chunk);
    controller.close();
  } }), duplex: 'half' } as RequestInit);
  c.set('boundedBody', true);
}
