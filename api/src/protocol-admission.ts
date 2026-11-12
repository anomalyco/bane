import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

/** The ingress lane is authenticated, not a trusted header. The handler independently
 * checks the payload against the signed digest before any operation runs. */
export function gatewayLane(method: string, path: string, h: Headers, key: unknown, now = Date.now()): string | null {
  if (method !== 'POST' || path !== '/internal/v1/mail' || typeof key !== 'string' || key.length < 32) return null;
  const ts = h.get('x-bane-timestamp') ?? '',
    hash = h.get('x-bane-content') ?? '',
    sig = h.get('x-bane-signature') ?? '',
    scope = h.get('x-bane-scope') ?? '';
  if (
    !/^\d{10}$/.test(ts) ||
    Math.abs(now / 1000 - Number(ts)) > 60 ||
    ![hash, sig, scope].every((x) => /^[a-f0-9]{64}$/.test(x))
  )
    return null;
  const meta = h.get('x-bane-append');
  if (meta !== null && meta.length > 8192) return null;
  const expected = createHmac('sha256', key)
    .update(
      `POST\n${path}\n${ts}\n${hash}\n${scope}` +
        (meta === null ? '' : '\n' + createHash('sha256').update(meta).digest('hex')),
    )
    .digest();
  return timingSafeEqual(expected, Buffer.from(sig, 'hex')) ? `bane:protocol:${scope}` : null;
}
