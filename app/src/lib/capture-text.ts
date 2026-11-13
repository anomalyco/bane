import { addressParts, maskedParts } from './private-address.js'

// What a UI note may keep of the page's text (features/ui-notes): addresses masked by the dashboard's one rule
// (lib/private-address.ts), and anything that looks like a credential removed. Secret-bearing screens are also marked
// data-sensitive, and a note can't be left inside one; this is the second line, for a secret shown anywhere else.
// No React here, so the API acceptance suite can test it. The API runs the same patterns again before storing
// (api/src/ui-notes.ts).

// Bane's own credentials (API, inbox, notes, support and agent keys), webhook signing secrets, Stripe keys and object
// IDs, app passwords, JWTs, AWS access keys and bearer headers.
const SECRET = [
  /\b(?:bane|os)_[A-Za-z0-9_.-]{20,}/g,
  /\bwhsec_[A-Za-z0-9+/=_-]{12,}/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /\b(?:sk|rk)_[A-Za-z0-9]{20,}/g,
  /\b(?:cus|pi|pm|seti|sub|in|ch|cs|acct|price|prod|si|txn|re|po|evt)_(?=[A-Za-z0-9]*[A-Z])[A-Za-z0-9]{14,}/g,
  /\b(?:[0-9a-f]{4}-){7}[0-9a-f]{4}\b/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
]
// A Bane resource ID (cmp_ + 32 hex) names a thing; it is not a secret.
const RESOURCE_ID = /^[a-z]{2,8}_[0-9a-f]{32}$/
const entropy = (text: string) => {
  const counts = new Map<string, number>()
  for (const character of text) counts.set(character, (counts.get(character) ?? 0) + 1)
  let bits = 0
  for (const count of counts.values()) { const p = count / text.length; bits -= p * Math.log2(p) }
  return bits
}
/** Long random-looking runs: 32+ characters with letters and digits, hex or high entropy. */
const highEntropy = (run: string) => run.length >= 32 && /\d/.test(run) && /[A-Za-z]/.test(run) && !RESOURCE_ID.test(run) && (/^[0-9a-f]+$/i.test(run) || entropy(run) >= 3.5)

/** The [start, end) spans of `text` that look like credentials. */
export function secretSpans(text: string): [number, number][] {
  const spans: [number, number][] = []
  for (const pattern of SECRET) for (const match of text.matchAll(pattern)) spans.push([match.index, match.index + match[0].length])
  for (const match of text.matchAll(/[A-Za-z0-9_+=-]{32,}/g)) if (highEntropy(match[0])) spans.push([match.index, match.index + match[0].length])
  return spans.sort((a, b) => a[0] - b[0])
}
/** Text with every credential-looking run replaced. */
export function redactSecrets(text: string) {
  let out = '', from = 0
  for (const [start, end] of secretSpans(text)) { if (end <= from) continue; out += text.slice(from, Math.max(from, start)) + '[secret]'; from = end }
  return out + text.slice(from)
}
/** Text with secrets removed and every address masked: its first two characters, then dots. */
export function maskText(text: string) {
  const clean = redactSecrets(text)
  if (!clean.includes('@')) return clean
  return addressParts(clean).map(part => part.address ? `${maskedParts(part.text)?.shown ?? part.text.slice(0, 2)}•••` : part.text).join('')
}

/**
 * The rendered text of a region, given as its text nodes in order, masked as a whole: an address or a secret split
 * across inline elements (<strong>alice</strong>@example.net) is found in the joined text and masked in every node it
 * spans. An address keeps its first two characters and a secret none; each masked character becomes a dot, so every
 * node keeps its length.
 */
export function maskRuns(texts: string[]): string[] {
  const joined = texts.join('')
  const hide = new Uint8Array(joined.length)
  let at = 0
  for (const part of addressParts(joined)) {
    if (part.address) for (let i = at + [...part.text].slice(0, 2).join('').length; i < at + part.text.length; i++) hide[i] = 1
    at += part.text.length
  }
  for (const [start, end] of secretSpans(joined)) hide.fill(1, start, end)
  if (!hide.includes(1)) return texts
  let offset = 0
  return texts.map(text => {
    let out = ''
    for (let i = 0; i < text.length; i++) out += hide[offset + i] && !/\s/.test(text[i]!) ? '•' : text[i]
    offset += text.length
    return out
  })
}
