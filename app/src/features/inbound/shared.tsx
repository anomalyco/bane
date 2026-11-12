import type { InboundAddress, MailAddress } from '../../data/types'
import { PrivateAddress } from '../../components/PrivateAddress'

// Bidi overrides, isolates and zero-width marks in a sender-chosen display name can make
// "evil@x.example" read as another address (L17). Names are shown without them.
const INVISIBLE = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g
export const cleanName = (name: string | null | undefined) => name?.replace(INVISIBLE, '').trim() || null
export const nameOf = (value: MailAddress) => cleanName(value.name) || value.address.split('@')[0]!
/** A sender in a list: the cleaned display name, or the masked address when there is none. */
export function Sender({ value }: { value: MailAddress }) { const name = cleanName(value.name); return name ? <>{name}</> : <PrivateAddress value={value.address} /> }
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
