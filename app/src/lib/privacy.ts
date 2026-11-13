import { useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'

// Privacy mode: whether the dashboard masks email addresses (components/PrivateAddress.tsx). It is on by default and
// remembered per browser; off, every address renders in full at once, everywhere. The root element carries
// data-privacy="off" while it is off. Anything that leaves the browser (a UI note's capture) calls forceMask(), which
// masks again whatever this browser's setting, until it is released.
const storageKey = 'bane.privacy'
const listeners = new Set<() => void>()
const saved = () => { try { return localStorage.getItem(storageKey) !== 'off' } catch { return true } }
let preference = saved(), forced = 0

const masking = () => preference || forced > 0
function publish() {
  if (masking()) delete document.documentElement.dataset.privacy
  else document.documentElement.dataset.privacy = 'off'
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
if (typeof window !== 'undefined') {
  publish()
  window.addEventListener('storage', event => { if (event.key === storageKey || event.key === null) { preference = saved(); publish() } })
}

export function setPrivacy(on: boolean) {
  preference = on
  try { if (on) localStorage.removeItem(storageKey); else localStorage.setItem(storageKey, 'off') } catch { /* Kept for this page only. */ }
  publish()
}
export const togglePrivacy = () => setPrivacy(!preference)
/** This browser's setting, for the switch. */
export const usePrivacy = () => useSyncExternalStore(subscribe, () => preference)
/** Whether addresses are masked now: the setting, or a capture holding forceMask(). */
export const useMasking = () => useSyncExternalStore(subscribe, masking)
/**
 * Masks every address until the returned release is called, whatever the setting. The page is re-rendered masked
 * before this returns, so a capture can read the DOM straight away. Call it from an event handler, not during render.
 */
export function forceMask(): () => void {
  forced++
  flushSync(publish)
  let released = false
  return () => { if (released) return; released = true; forced--; publish() }
}
