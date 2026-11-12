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

// Addresses in free text (a contact property, a note), by a deliberately simple rule that never leaves part of one
// readable: every run of non-space characters with an @ in it is masked whole, together with any quoted string
// ("mary smith"@…) or parenthesised comment (bob(work)@…) it touches, which may hold spaces. More is masked than an
// exact parser would (mailto:, a bracket or a sentence's full stop) and nothing of an address is shown beyond the first
// two characters. Text around it stays readable, and so do runs with no mailbox in them: @team, *@bane.mx.
const QUOTE = /(?<!\\)"/g
const runAt = (text: string, at: number) => {
  let start = at, end = at
  while (start > 0 && !/\s/.test(text[start - 1]!)) start--
  while (end < text.length && !/\s/.test(text[end]!)) end++
  return [start, end] as const
}
const lineStart = (text: string, at: number) => text.lastIndexOf('\n', at - 1) + 1
const lineEnd = (text: string, at: number) => { const end = text.indexOf('\n', at); return end === -1 ? text.length : end }
/** The masked span grown over the quoted string or comment that an unbalanced quote or bracket in it opens or closes. */
function grow(text: string, [start, end]: readonly [number, number]): readonly [number, number] {
  for (let changed = true; changed;) {
    changed = false
    const span = text.slice(start, end), at = span.indexOf('@')
    const quotes = (part: string) => part.match(QUOTE)?.length ?? 0
    // A quote with no partner in the span pairs with the nearest one outside it on the same line: before the @ most
    // likely to the left ("mary smith"@…), after it to the right, else the other way ("a@b c"@…).
    const left = () => { const open = text.slice(lineStart(text, start), start).search(/(?<!\\)"[^"]*$/); if (open === -1) return false; [start] = runAt(text, lineStart(text, start) + open); return true }
    const right = () => { const close = text.slice(end, lineEnd(text, end)).search(/(?<!\\)"/); if (close === -1) return false; [, end] = runAt(text, end + close); return true }
    if (quotes(span.slice(0, at)) % 2 && (left() || right())) changed = true
    else if (quotes(span.slice(at)) % 2 && (right() || left())) changed = true
    let depth = 0, lowest = 0
    for (const c of span) { if (c === '(') depth++; else if (c === ')') { depth--; lowest = Math.min(lowest, depth) } }
    if (lowest < 0) { // A ) with its ( further left.
      let need = -lowest, i = start - 1
      for (const floor = lineStart(text, start); i >= floor && need; i--) { if (text[i] === ')') need++; else if (text[i] === '(') need-- }
      if (!need) { [start] = runAt(text, i + 1); changed = true }
    }
    if (depth - lowest > 0) { // A ( with its ) further right.
      let need = depth - lowest, i = end
      for (const ceiling = lineEnd(text, end); i < ceiling && need; i++) { if (text[i] === '(') need++; else if (text[i] === ')') need-- }
      if (!need) { [, end] = runAt(text, i - 1); changed = true }
    }
  }
  return [start, end]
}
/** Free text as pieces to show: text, and each run holding an address (see above), which is masked like every other. */
export function addressParts(text: string): { text: string; address: boolean }[] {
  const parts: { text: string; address: boolean }[] = []
  let from = 0, last = 0
  for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', Math.max(at + 1, from))) {
    const [start, end] = grow(text, runAt(text, at))
    if (start < from) { parts[parts.length - 1] = { text: text.slice(last, end), address: true }; from = end; continue } // Reaches back into the span before: one span.
    if (!isMailbox(text.slice(start, end))) continue
    if (start > from) parts.push({ text: text.slice(from, start), address: false })
    parts.push({ text: text.slice(start, end), address: true })
    last = start; from = end
  }
  if (from < text.length) parts.push({ text: text.slice(from), address: false })
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
