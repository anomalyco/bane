import { Fragment } from 'react'
import { addressParts } from '../lib/private-address'
import { PrivateAddress } from './PrivateAddress'

/** Free text that may hold addresses (a contact property's name or value): each address in it is masked by the same
 *  rule as PrivateAddress, the rest reads as written. */
export function AddressText({ text }: { text: string }) {
  return <>{addressParts(text).map((part, i) => part.address ? <PrivateAddress key={i} value={part.text} /> : <Fragment key={i}>{part.text}</Fragment>)}</>
}
