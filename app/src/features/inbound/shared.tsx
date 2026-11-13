import type { InboundAddress, MailAddress } from '../../data/types'
import { NameText, PrivateAddress } from '../../components/PrivateAddress'
import { cleanName, nameParts } from '../../lib/private-address'

export { cleanName }
/** A sender in a list: the display name, or the masked address when there is none (or it only repeats the address). */
export function Sender({ value }: { value: MailAddress }) { const parts = nameParts(value.name, value.address); return parts ? <NameText parts={parts} /> : <PrivateAddress value={value.address} /> }
/** A sender in words, for a label or a title: the display name, never a piece of the address. */
export const nameOf = (value: MailAddress) => { const parts = nameParts(value.name, value.address); return parts && parts.every(part => !part.address) ? parts.map(part => part.text).join('') : 'this sender' }
export const full = (value: MailAddress) => cleanName(value.name) ? `${cleanName(value.name)} <${value.address}>` : value.address
export const addressName = (addresses: Map<string, InboundAddress>, id: string) => addresses.get(id)?.address ?? id
export function when(value: string) {
  const at = new Date(value), now = new Date()
  if (at.toDateString() === now.toDateString()) return at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) })
}

/** Reuse one Idempotency-Key while the operator retries the same payload; a changed payload gets a new key. */
export function idempotencyFor(state: { key: string; body: string }, body: unknown) {
  const next = JSON.stringify(body)
  if (state.body !== next) { state.key = crypto.randomUUID(); state.body = next }
  return state.key
}
