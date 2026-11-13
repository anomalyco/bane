// Short-lived capabilities the support Worker hands out, all HMAC-SHA256 under keys derived from one root
// (SUPPORT_ROOT_SECRET) with HKDF and a purpose label, as Nightmail derives its own keys (api/README.md "Secret rotation").
//
// - chat token: lets one person's panel open one conversation's WebSocket for 12 hours;
// - confirm token: the "Confirm it's me" link in an email reply (24 hours, single use, bound to conversation and address).

const encoder = new TextEncoder();
const b64url = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

export type Purpose = 'chat-token/v1' | 'confirm/v1' | 'attachment/v1' | 'staff/v1';
const keys = new Map<string, Promise<CryptoKey>>();

/** The HMAC key for one purpose; the root never leaves this function. Fails closed when the secret is missing or weak. */
export function purposeKey(root: string | undefined, purpose: Purpose): Promise<CryptoKey> {
  if (!root || root.length < 32) throw new MissingSecret('SUPPORT_ROOT_SECRET');
  const cacheKey = `${purpose}:${root.length}:${root.slice(-6)}`;
  let key = keys.get(cacheKey);
  if (!key) {
    key = (async () => {
      const base = await crypto.subtle.importKey('raw', encoder.encode(root), 'HKDF', false, ['deriveKey']);
      return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('bane-support'), info: encoder.encode(purpose) }, base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']);
    })();
    keys.set(cacheKey, key);
  }
  return key;
}

export class MissingSecret extends Error {
  constructor(readonly secret: string) { super(`The support Worker is missing its ${secret} secret.`); }
}

export async function sign(key: CryptoKey, payload: string) { return b64url(await crypto.subtle.sign('HMAC', key, encoder.encode(payload))); }
export async function verify(key: CryptoKey, payload: string, signature: string) {
  const bytes = Uint8Array.from(atob(signature.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - signature.length % 4) % 4)), c => c.charCodeAt(0));
  return crypto.subtle.verify('HMAC', key, bytes, encoder.encode(payload));
}

const SAFE = /^[A-Za-z0-9_@.+-]{1,200}$/;
export const CHAT_TOKEN_HOURS = 12;

export async function chatToken(root: string | undefined, conversationId: string, userId: string, now = Date.now()) {
  const exp = Math.floor(now / 1000) + CHAT_TOKEN_HOURS * 3600, payload = `v1.${conversationId}.${userId}.${exp}`;
  return { token: `${payload}.${await sign(await purposeKey(root, 'chat-token/v1'), payload)}`, expiresAt: new Date(exp * 1000).toISOString() };
}

/** The chat token's conversation and user, or null when it is forged, expired or for another conversation. */
export async function readChatToken(root: string | undefined, token: string | null, conversationId: string, now = Date.now()): Promise<{ userId: string } | null> {
  const parts = token?.split('.') ?? [];
  if (parts.length !== 5 || parts[0] !== 'v1') return null;
  const [, conv, userId, exp, sig] = parts as [string, string, string, string, string];
  if (conv !== conversationId || !SAFE.test(userId) || !/^\d{10}$/.test(exp) || Number(exp) * 1000 <= now) return null;
  try { return await verify(await purposeKey(root, 'chat-token/v1'), `v1.${conv}.${userId}.${exp}`, sig) ? { userId } : null; } catch (error) { if (error instanceof MissingSecret) throw error; return null; }
}

/** A confirm link token: the conversation, a hash of the address (never the address itself in a URL) and an expiry. */
export async function confirmToken(root: string | undefined, conversationId: string, email: string, now = Date.now()) {
  const exp = Math.floor(now / 1000) + 24 * 3600, nonce = b64url(crypto.getRandomValues(new Uint8Array(12)));
  const payload = `c1.${conversationId}.${await addressHash(email)}.${exp}.${nonce}`;
  return `${payload}.${await sign(await purposeKey(root, 'confirm/v1'), payload)}`;
}
export async function readConfirmToken(root: string | undefined, token: string, now = Date.now()): Promise<{ conversationId: string; addressHash: string; nonce: string } | null> {
  const parts = token.split('.');
  if (parts.length !== 6 || parts[0] !== 'c1') return null;
  const [, conv, hash, exp, nonce, sig] = parts as [string, string, string, string, string, string];
  if (!SAFE.test(conv) || !/^[A-Za-z0-9_-]{20,64}$/.test(hash) || !/^\d{10}$/.test(exp) || Number(exp) * 1000 <= now) return null;
  try { return await verify(await purposeKey(root, 'confirm/v1'), `c1.${conv}.${hash}.${exp}.${nonce}`, sig) ? { conversationId: conv, addressHash: hash, nonce } : null; } catch (error) { if (error instanceof MissingSecret) throw error; return null; }
}
export async function addressHash(email: string) { return b64url(await crypto.subtle.digest('SHA-256', encoder.encode(`bane-support:${email.trim().toLowerCase()}`))).slice(0, 32); }

/** `conv_` + 26 base32 characters (130 bits). */
export function newId(prefix: 'conv' | 'tkt' | 'msg' | 'cns' | 'att') {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567', bytes = crypto.getRandomValues(new Uint8Array(prefix === 'conv' ? 26 : 16));
  return `${prefix}_${Array.from(bytes, b => alphabet[b & 31]).join('')}`;
}
