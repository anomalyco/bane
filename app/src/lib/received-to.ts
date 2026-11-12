// Who a received message was for, and whether that address may show in full: the dashboard's one rule for the To of
// received mail in lists (Logs, Trace, anything that previews it). The receiving address it was delivered to, or its
// SMTP envelope recipient, is ours and shows in full. Otherwise only the header To is known; the sender wrote it and it
// may name someone else, so it is masked (PrivateAddress). No React here, so the API acceptance suite can test it.
export type ReceivedRecipients = { to: string[]; addresses?: { address: string }[] | null; envelopeTo?: string[] | null }
export type ReceivedTo = { address: string; own: boolean }

export function receivedTo(row: ReceivedRecipients): ReceivedTo | null {
  const own = row.addresses?.[0]?.address ?? row.envelopeTo?.[0]
  if (own) return { address: own, own: true }
  return row.to[0] ? { address: row.to[0], own: false } : null
}
