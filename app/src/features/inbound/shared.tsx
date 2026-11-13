import { useId, useState } from 'react'
import * as SelectPrimitive from '@radix-ui/react-select'
import { Check, ChevronDown } from 'lucide-react'
import { Sheet } from '../../components/ui'
import { useTouch } from '../../lib/media'
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

/** A choice in an AddressSelect: an address (with its display name, if any) is masked like every address; a label is plain text. */
export type AddressOption = { value: string; address?: string; name?: string; label?: string }
const OptionText = ({ option }: { option: AddressOption }) => option.address ? <>{option.name ? `${option.name} ` : ''}<PrivateAddress value={option.address} /></> : <>{option.label ?? ''}</>
/**
 * ui/Select for addresses: its trigger and list hold PrivateAddress, so a picked or listed address is blurred until
 * hover or focus. A touch screen gets a bottom sheet of the same rows (a native picker could only show them in the clear).
 */
export function AddressSelect({ value, onValueChange, options, placeholder = 'Select…', id, disabled, 'aria-label': ariaLabel }: { value: string; onValueChange: (value: string) => void; options: AddressOption[]; placeholder?: string; id?: string; disabled?: boolean; 'aria-label'?: string }) {
  const empty = useId(), touch = useTouch(), [open, setOpen] = useState(false)
  const current = options.find(option => option.value === value)
  const trigger = <SelectPrimitive.Trigger data-component="Select" id={id} aria-label={ariaLabel} className="ui-input ui-select-trigger address-select-trigger" data-placeholder={current ? undefined : ''}><SelectPrimitive.Value placeholder={placeholder} /><SelectPrimitive.Icon><ChevronDown size={14} aria-hidden="true" /></SelectPrimitive.Icon></SelectPrimitive.Trigger>
  if (touch) return <>
    <button type="button" data-component="Select" id={id} aria-label={ariaLabel} aria-haspopup="dialog" aria-expanded={open} disabled={disabled} className="ui-input ui-select-trigger address-select-trigger" data-placeholder={current ? undefined : ''} onClick={() => setOpen(true)}>
      <span>{current ? <OptionText option={current} /> : placeholder}</span><span aria-hidden="true"><ChevronDown size={14} /></span>
    </button>
    <Sheet open={open} onOpenChange={setOpen} title={ariaLabel ?? placeholder} className="ui-action-sheet">
      <div className="ui-action-sheet__items address-select" role="listbox" aria-label={ariaLabel ?? placeholder}>{options.map(option => <button key={option.value} type="button" role="option" aria-selected={option.value === value} className="ui-action-sheet__item" onClick={() => { setOpen(false); onValueChange(option.value) }}>
        <span className="ui-action-sheet__label"><OptionText option={option} /></span>{option.value === value && <Check size={14} aria-hidden="true" />}
      </button>)}</div>
      <button type="button" className="ui-action-sheet__item ui-action-sheet__cancel" onClick={() => setOpen(false)}>Cancel</button>
    </Sheet>
  </>
  return <SelectPrimitive.Root value={value === '' && options.some(option => option.value === '') ? empty : value} onValueChange={next => onValueChange(next === empty ? '' : next)} disabled={disabled}>
    {trigger}
    <SelectPrimitive.Portal><SelectPrimitive.Content className="ui-popover ui-select-content address-select" position="popper" sideOffset={4}><SelectPrimitive.Viewport>{options.map(option => <SelectPrimitive.Item key={option.value} value={option.value === '' ? empty : option.value} className="ui-select-item"><SelectPrimitive.ItemText><OptionText option={option} /></SelectPrimitive.ItemText><SelectPrimitive.ItemIndicator><Check size={14} /></SelectPrimitive.ItemIndicator></SelectPrimitive.Item>)}</SelectPrimitive.Viewport></SelectPrimitive.Content></SelectPrimitive.Portal>
  </SelectPrimitive.Root>
}
