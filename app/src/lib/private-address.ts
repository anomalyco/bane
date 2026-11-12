// The dashboard's one rule for email addresses: every mailbox address it shows (in lists, tables, detail headers and
// search results, ours included) is masked after its first two characters until hovered or focused, by
// components/PrivateAddress.tsx. Domain names and domain-only labels (bane.mx, @bane.mx, *@bane.mx) are not mailbox
// addresses and stay readable. Forms where an address is typed or chosen, one-time dialogs with a copy button and CSV
// exports show addresses in full. No React here, so the API acceptance suite can test it.

/** A mailbox address or address pattern: something before the @ other than wildcards. */
export function isMailbox(value: string) {
  const at = value.lastIndexOf('@')
  return at > 0 && value.slice(0, at).replace(/\*/g, '') !== ''
}

/** How an address renders masked: the first two characters stay readable, the rest is blurred. Null when readable. */
export function maskedParts(value: string): { shown: string; hidden: string } | null {
  return isMailbox(value) ? { shown: value.slice(0, 2), hidden: value.slice(2) } : null
}

/** Free text split around the addresses written in it (a contact property, a note), so each can be masked in place. */
export function splitAddresses(text: string): { text: string; address: boolean }[] {
  const parts: { text: string; address: boolean }[] = []
  let last = 0
  for (const match of text.matchAll(/[A-Za-z0-9._%+*-]*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g)) {
    if (!isMailbox(match[0])) continue
    if (match.index > last) parts.push({ text: text.slice(last, match.index), address: false })
    parts.push({ text: match[0], address: true })
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push({ text: text.slice(last), address: false })
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
