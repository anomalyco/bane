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

// Addresses in free text (a contact property, a note). A mailbox address is found from its @ outwards, so a name
// ahead of it stays readable and none of the address does. The local part is RFC 5322 atext (' and / included) and
// dots, plus any non-ASCII character other than spaces, brackets and quotation marks (RFC 6532), or a quoted string
// ("mary smith"). The domain is labels of letters, digits and hyphens in any script (例子.公司, also split by 。) or
// a [literal]. Where the text before an @ can't be read as either, all of it back to a space or bracket is masked
// rather than shown. "@team" and "*@bane.mx" have no mailbox and stay readable. Each character is looked at a bounded
// number of times, so long text stays fast.
const ATEXT = /[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~.]|[^\x00-\x7f\s\p{Ps}\p{Pe}\p{Pi}\p{Pf}]/u
const LABEL = /[A-Za-z0-9.\-\p{L}\p{N}\p{M}\u3002\uff0e\uff61]/u
const DOT = /[.\-\u3002\uff0e\uff61]/
const BOUNDARY = /[\s<>()[\],;:"@]/u
const before = (text: string, at: number) => { const code = text.codePointAt(at - 2); return code !== undefined && code > 0xffff ? at - 2 : at - 1 }
const after = (text: string, at: number) => at + ((text.codePointAt(at) ?? 0) > 0xffff ? 2 : 1)
/** Free text as pieces to show: text, and each mailbox address written in it, which is masked like every other. */
export function addressParts(text: string): { text: string; address: boolean }[] {
  const parts: { text: string; address: boolean }[] = []
  // Quoted local parts first ("a@b"@x.example holds an @ of its own): where each one's @ is, and the @s inside it.
  const quoted = new Map<number, number>(), inside = new Set<number>()
  for (const match of text.matchAll(/"(?:[^"\\\n]|\\.){0,256}"@/g)) {
    const at = match.index + match[0].length - 1
    quoted.set(at, match.index)
    for (let i = text.indexOf('@', match.index); i !== -1 && i < at; i = text.indexOf('@', i + 1)) inside.add(i)
  }
  let from = 0
  for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', at + 1)) {
    if (at < from || inside.has(at)) continue
    let start = at
    if (quoted.has(at) && quoted.get(at)! >= from) start = quoted.get(at)!
    else if (text[at - 1] === '"') {
      // A quote with no opening one: from it back to the nearest boundary, all of it masked.
      start = Math.max(from, at - 1)
      while (start > from && !BOUNDARY.test(text.slice(before(text, start), start))) start = before(text, start)
    } else {
      while (start > from && ATEXT.test(text.slice(before(text, start), start))) start = before(text, start)
    }
    let end = at + 1
    const close = text[end] === '[' ? text.indexOf(']', end) : -1
    if (close !== -1 && !/\s/.test(text.slice(end, close))) end = close + 1
    else {
      while (end < text.length && LABEL.test(text.slice(end, after(text, end)))) end = after(text, end)
      while (end > at + 1 && DOT.test(text[end - 1]!)) end-- // the sentence's full stop
    }
    // 'quoted in prose'@… keeps its opening quote out of the address when the same quote closes it.
    if ((text[start] === "'" || text[start] === '`') && text[end] === text[start]) start++
    if (!text.slice(start, at).replace(/[*"]/g, '')) continue
    if (start > from) parts.push({ text: text.slice(from, start), address: false })
    parts.push({ text: text.slice(start, end), address: true })
    from = end
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
