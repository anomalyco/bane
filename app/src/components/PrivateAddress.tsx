import type { ReactNode } from 'react'

// The dashboard's one rule for other people's email addresses in lists (Logs, Overview, anything that previews mail):
// the person on the other side of a message (a sent email's recipients, a received email's sender, or any address we
// can't show is our own) stays blurred after its first two characters until hovered or focused. Our own addresses (a
// sent email's From, the receiving address mail arrived at) show in full. Pages that open one message, and CSV
// exports, are explicit requests and show addresses in full.
export function PrivateAddress({ value, children }: { value: string; children?: ReactNode }) {
  return <span className="private-address" title="Hidden for privacy. Hover to read."><span aria-hidden="true">{value.slice(0, 2)}</span><span className="private-address__rest" aria-hidden="true">{value.slice(2)}</span><span className="sr-only">{value}</span>{children}</span>
}
