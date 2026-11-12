import type { ReactNode } from 'react'
import { maskedParts } from '../lib/private-address'

// Renders any address by the dashboard's one rule (lib/private-address.ts): a mailbox address is masked after its first
// two characters until hovered or focused; a domain or domain-only label renders as it is. Blurred and revealed are
// the same width (only a filter changes), so revealing never moves anything.
export const PRIVATE_TITLE = 'Hidden for privacy. Hover to read.'
export function PrivateAddress({ value, children, className }: { value: string; children?: ReactNode; className?: string }) {
  const parts = maskedParts(value)
  if (!parts) return <span className={className}>{value}{children}</span>
  return <span className={className ? `private-address ${className}` : 'private-address'} title={PRIVATE_TITLE}><span aria-hidden="true">{parts.shown}</span><span className="private-address__rest" aria-hidden="true">{parts.hidden}</span><span className="sr-only">{value}</span>{children}</span>
}
/** "Name <address>" with the address masked; the display name stays readable. */
export function NamedAddress({ name, address }: { name?: string | null; address: string }) {
  return name ? <>{name} &lt;<PrivateAddress value={address} />&gt;</> : <PrivateAddress value={address} />
}
/** A list of addresses, each masked. */
export function AddressList({ values }: { values: string[] }) {
  return <>{values.map((value, i) => <span key={`${i}:${value}`}>{i > 0 && ', '}<PrivateAddress value={value} /></span>)}</>
}
