// Verifies Nightmail's Standard Webhooks signature (the same check as `verifyWebhook` in sdk/src/webhooks.ts, which the
// published @nightmail/sdk doesn't ship yet): HMAC-SHA256 over `id.timestamp.body` with the whsec_ secret, within 5 minutes.
const base64 = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0));

export async function verifyWebhook(body: string, headers: Headers, secret: string, toleranceSeconds = 300): Promise<boolean> {
  const id = headers.get('webhook-id'), timestamp = headers.get('webhook-timestamp'), signature = headers.get('webhook-signature');
  if (!id || !timestamp || !/^\d+$/.test(timestamp) || !signature || !secret.startsWith('whsec_')) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSeconds) return false;
  try {
    const raw = base64(secret.slice('whsec_'.length));
    if (raw.length !== 32) return false;
    const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const signed = new TextEncoder().encode(`${id}.${timestamp}.${body}`);
    for (const candidate of signature.split(/\s+/)) if (candidate.startsWith('v1,') && await crypto.subtle.verify('HMAC', key, base64(candidate.slice(3)), signed)) return true;
  } catch { /* a malformed secret or signature never verifies */ }
  return false;
}
