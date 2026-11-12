// The dashboard's one rule for email addresses: every mailbox address it shows (in lists, tables, detail headers and
// search results, ours included) is masked after its first two characters until hovered or focused, by
// components/PrivateAddress.tsx. Masked means absent: the rest of the address is not in the page's text, a title or
// a label until it is revealed, so reading, copying or listening to the page gives only what is shown. Domain names
// and domain-only labels (bane.mx, @bane.mx, *@bane.mx) are not mailbox addresses and stay readable. Forms where an
// address is typed or chosen, one-time dialogs with a copy button and CSV exports show addresses in full. No React
// here, so the API acceptance suite can test it.

/** A mailbox address or address pattern: something before the @ other than wildcards. */
export function isMailbox(value: string) {
  const at = value.lastIndexOf('@')
  return at > 0 && value.slice(0, at).replace(/\*/g, '') !== ''
}

/** How an address renders masked: the first two characters stay readable, the rest is kept out. Null when readable. */
export function maskedParts(value: string): { shown: string; hidden: string } | null {
  if (!isMailbox(value)) return null
  // Two characters, not two UTF-16 units: a split pair would render as a broken glyph.
  const shown = [...value].slice(0, 2).join('')
  return { shown, hidden: value.slice(shown.length) }
}
/** A masked address's hint. It says how to read the address, never the address. */
export const PRIVATE_TITLE = 'Hidden for privacy. Hover or focus to read.'
/** All of an address that the page holds: its first two characters until it is revealed, then the whole of it. */
export function addressText(value: string, revealed: boolean) {
  return (!revealed && maskedParts(value)?.shown) || value
}
/** The width `text` takes when each character advances by `advance(character)`: what a masked address reserves, so
 * that revealing it moves nothing. The same sum whether the text is measured whole or in parts. */
export function textWidth(text: string, advance: (character: string) => number) {
  let width = 0
  for (const character of text) width += advance(character)
  return width
}

// Bidi overrides, isolates and zero-width marks in a sender-chosen display name can make
// "evil@x.example" read as another address (L17). Names are shown without them.
const INVISIBLE = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g
export const cleanName = (name: string | null | undefined) => name?.replace(INVISIBLE, '').trim() || null
const ADDRESS_IN_TEXT = /[^\s<>()[\]"',;:]+@[^\s<>()[\]"',;:]+\.[^\s<>()[\]"',;:]+/g
/**
 * A sender-chosen display name as the pieces to show: text, and any mailbox address written inside it, which is
 * masked like every other. Null when there is no name, or the name is only the sender's own address again.
 */
export function nameParts(name: string | null | undefined, address: string): { text: string; address: boolean }[] | null {
  const clean = cleanName(name)
  if (!clean || clean.replace(/^[\s<"']+|[\s>"']+$/g, '').toLowerCase() === address.trim().toLowerCase()) return null
  const parts: { text: string; address: boolean }[] = []
  let from = 0
  for (const match of clean.matchAll(ADDRESS_IN_TEXT)) {
    if (!isMailbox(match[0])) continue
    if (match.index > from) parts.push({ text: clean.slice(from, match.index), address: false })
    parts.push({ text: match[0], address: true })
    from = match.index + match[0].length
  }
  if (from < clean.length) parts.push({ text: clean.slice(from), address: false })
  return parts
}

// Which address a received message was for: the receiving address it was delivered to, then its SMTP envelope
// recipient, then (older mail stored without an envelope) the sender-written header To. All of them are masked.
export type ReceivedRecipients = { to: string[]; addresses?: { address: string }[] | null; envelopeTo?: string[] | null }
/** Ours only: the receiving address or envelope recipient (what Trace traces a message as), never the header To. */
export const ownRecipient = (row: ReceivedRecipients): string | undefined => row.addresses?.[0]?.address ?? row.envelopeTo?.[0]
export function receivedTo(row: ReceivedRecipients): string | null {
  return ownRecipient(row) ?? row.to[0] ?? null
}
