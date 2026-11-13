import { ApiError, type Config, type Runtime } from './core.js';

// AES-GCM envelopes for secrets Bane must read back (webhook signing secrets and headers, an OAuth refresh's replay
// pair): `v1.<key id>.<iv>.<ciphertext>`, bound to `binding` as additional data. ENCRYPTION_KEY encrypts; it and the
// previous key decrypt, so the key can be rotated (operations.ts reencryptWebhookSecrets).
export async function encryptionKey(value: string) {
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new ApiError(503, 'ENCRYPTION_NOT_CONFIGURED', 'A 32-byte hexadecimal encryption key is required.');
  const bytes = unhex(value);
  return { id: hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).slice(0, 16), key: await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']) };
}
const hex = (value: Uint8Array) => Array.from(value, b => b.toString(16).padStart(2, '0')).join('');
const unhex = (value: string) => Uint8Array.from(value.match(/../g) ?? [], h => parseInt(h, 16));
export async function encrypt(runtime: Pick<Runtime, 'config'>, secret: string, binding: string) {
  const current = await encryptionKey(runtime.config.encryptionKey), iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(binding) }, current.key, new TextEncoder().encode(secret));
  return `v1.${current.id}.${hex(iv)}.${hex(new Uint8Array(encrypted))}`;
}
export async function decrypt(runtime: {config: Pick<Config, 'encryptionKey' | 'previousEncryptionKey'>}, ciphertext: string, binding: string) {
  const parts = ciphertext.split('.'), versioned = parts.length === 4 && parts[0] === 'v1';
  const [iv, value] = versioned ? parts.slice(2) : parts;
  const rotationRequired = () => new ApiError(503, 'KEY_ROTATION_REQUIRED', 'The webhook secret cannot be decrypted with configured keys. Restore its encryption key or rotate the webhook secret.');
  if ((!versioned && parts.length !== 2) || !/^[a-f0-9]{24}$/i.test(iv ?? '') || !/^(?:[a-f0-9]{2}){16,}$/i.test(value ?? '')) throw rotationRequired();
  const keys = [await encryptionKey(runtime.config.encryptionKey)];
  if (runtime.config.previousEncryptionKey) keys.push(await encryptionKey(runtime.config.previousEncryptionKey));
  for (const candidate of keys) {
    if (versioned && candidate.id !== parts[1]) continue;
    try { return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unhex(iv!), additionalData: new TextEncoder().encode(binding) }, candidate.key, unhex(value!))); } catch { /* Legacy envelopes may belong to the previous key. */ }
  }
  throw rotationRequired();
}
