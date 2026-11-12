import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type FocusEvent, type MouseEvent, type PointerEvent, type ReactNode, type RefObject } from 'react'
import { PRIVATE_TITLE, maskedParts, nameParts } from '../lib/private-address'
import { measuredWidth, onRulerChange } from '../lib/text-ruler'

// Renders any address by the dashboard's one rule (lib/private-address.ts): a mailbox address is masked after its first
// two characters until hovered or focused; a domain or domain-only label renders as it is.
//
// Masked, the rest of the address is not in the page: the box holds the two characters and an empty, blurred run. The
// box is given the width of the whole address up front (measured without rendering it, lib/text-ruler.ts) and keeps it
// when the text arrives, so revealing never moves anything.

// What reveals a masked address besides its own hover: keyboard focus on a control or row that holds it, as before.
// A row with a link (DataTable rowHref, or a card on a phone) is focused through that link.
const ROW = '.ui-table__linked, .ui-card', TABBABLE = 'a[href], button, [tabindex]:not([tabindex="-1"]), .ui-table__clickable'
const focusHolds = (element: Element | null) => {
  const focused = document.activeElement
  if (!element || !focused || focused === document.body || focused === element || !focused.matches(':focus-visible')) return false
  return focused.contains(element) || focused.matches('.ui-row-link') && !!focused.closest(ROW)?.contains(element)
}
const focusListeners = new Set<() => void>()
// focusout runs before the next element has focus: look again once it has settled.
const focusMoved = () => queueMicrotask(() => { for (const listener of focusListeners) listener() })
let listening = false
const subscribeFocus = (listener: () => void) => {
  if (!listening) { listening = true; document.addEventListener('focusin', focusMoved, true); document.addEventListener('focusout', focusMoved, true) }
  focusListeners.add(listener)
  return () => { focusListeners.delete(listener) }
}

/**
 * The state of one masked address: the props for its outer element and the ref for the box that holds its text.
 * `text` is everything the box shows once revealed. An address that no control or row can reveal for a keyboard or a
 * touch screen takes focus itself.
 */
export function useMasked(text: string) {
  const root = useRef<HTMLSpanElement>(null), box = useRef<HTMLSpanElement>(null)
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false), [alone, setAlone] = useState(false)
  const held = useSyncExternalStore(subscribeFocus, () => focusHolds(root.current))
  const revealed = hovered || focused || held
  useLayoutEffect(() => {
    const reserve = () => { if (box.current) box.current.style.inlineSize = `${measuredWidth(box.current, text)}px` }
    reserve()
    return onRulerChange(reserve)
  }, [text])
  useEffect(() => {
    if (!hovered) return
    // Revealing replaces what is under the pointer, and some browsers then never report the pointer leaving.
    const check = () => { if (!root.current?.matches(':hover')) setHovered(false) }
    document.addEventListener('pointermove', check, true)
    return () => document.removeEventListener('pointermove', check, true)
  }, [hovered])
  useLayoutEffect(() => {
    const parent = root.current?.parentElement
    setAlone(!parent?.closest(TABBABLE) && !parent?.closest(ROW)?.querySelector('.ui-row-link'))
  }, [])
  return {
    revealed, box: box as RefObject<HTMLSpanElement>,
    root: {
      ref: root as RefObject<HTMLSpanElement>, title: revealed ? undefined : PRIVATE_TITLE, 'data-revealed': revealed || undefined, tabIndex: alone ? 0 : undefined,
      // A mouse or pen reveals by hovering. A finger has no hover: it reveals an address that takes focus by tapping it
      // (not every browser moves focus on a tap, so the click does).
      onPointerEnter: (event: PointerEvent) => { if (event.pointerType !== 'touch') setHovered(true) },
      onPointerLeave: () => setHovered(false),
      onClick: alone ? (event: MouseEvent<HTMLElement>) => event.currentTarget.focus() : undefined,
      onFocus: (event: FocusEvent) => { if (event.target === event.currentTarget) setFocused(true) },
      onBlur: (event: FocusEvent) => { if (event.target === event.currentTarget) setFocused(false) },
    },
  }
}

export function PrivateAddress({ value, children, className }: { value: string; children?: ReactNode; className?: string }) {
  const parts = maskedParts(value)
  if (!parts) return <span className={className}>{value}{children}</span>
  return <Masked value={value} shown={parts.shown} className={className}>{children}</Masked>
}
function Masked({ value, shown, children, className }: { value: string; shown: string; children?: ReactNode; className?: string }) {
  const masked = useMasked(value)
  return <span {...masked.root} className={className ? `private-address ${className}` : 'private-address'}>
    <span ref={masked.box} className="private-address__value">{masked.revealed ? value : <>{shown}<span className="private-address__rest" aria-hidden="true" /></>}</span>
    {children}
  </span>
}
/** A sender-chosen display name (lib/private-address.ts nameParts): an address written inside it is masked like any other. */
export function NameText({ parts }: { parts: { text: string; address: boolean }[] }) {
  return <>{parts.map((part, i) => part.address ? <PrivateAddress key={i} value={part.text} /> : part.text)}</>
}
/** "Name <address>" with the address masked; the display name stays readable. A name that only repeats the address is left out. */
export function NamedAddress({ name, address }: { name?: string | null; address: string }) {
  const parts = nameParts(name, address)
  return parts ? <><NameText parts={parts} /> &lt;<PrivateAddress value={address} />&gt;</> : <PrivateAddress value={address} />
}
/** A list of addresses, each masked. */
export function AddressList({ values }: { values: string[] }) {
  return <>{values.map((value, i) => <span key={`${i}:${value}`}>{i > 0 && ', '}<PrivateAddress value={value} /></span>)}</>
}
