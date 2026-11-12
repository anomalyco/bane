import { Fragment } from 'react'
import { splitAddresses } from '../lib/private-address'
import { PrivateAddress } from './PrivateAddress'

/** Free text that may hold addresses (a contact property's name or value): each address in it is masked by the same
 *  rule as PrivateAddress, the rest reads as written. */
export function AddressText({ text }: { text: string }) {
  return <>{splitAddresses(text).map((part, i) => part.address ? <PrivateAddress key={i} value={part.text} /> : <Fragment key={i}>{part.text}</Fragment>)}</>
}
