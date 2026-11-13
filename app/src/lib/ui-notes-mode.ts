import { useEffect, useSyncExternalStore } from 'react'

// UI notes mode (Bane staff with the operator role): while it is on, ⌘-click (Ctrl-click off a Mac) or a long press
// on a touch screen leaves a note on whatever is under it (features/ui-notes). Off, nothing of it is on the page and
// every click behaves normally. Remembered per browser; ⇧N or the account menu toggles it.
const KEY = 'bane.ui-notes'
const listeners = new Set<() => void>()
const read = () => { try { return localStorage.getItem(KEY) === 'on' } catch { return false } }
let on = typeof window !== 'undefined' && read()
const emit = () => { for (const listener of listeners) listener() }
const onStorage = (event: StorageEvent) => { if (event.key === KEY || event.key === null) { on = read(); emit() } }
export function setUiNotesMode(next: boolean) {
  on = next
  try { if (next) localStorage.setItem(KEY, 'on'); else localStorage.removeItem(KEY) } catch { /* This tab still follows the toggle. */ }
  emit()
}
export const toggleUiNotesMode = () => setUiNotesMode(!on)
function subscribe(listener: () => void) {
  if (!listeners.size) window.addEventListener('storage', onStorage)
  listeners.add(listener)
  return () => { listeners.delete(listener); if (!listeners.size) window.removeEventListener('storage', onStorage) }
}
export const useUiNotesMode = () => useSyncExternalStore(subscribe, () => on, () => false)

/** ⌘ on a Mac, Ctrl elsewhere: the key held to click an element for a note. */
export const isMac = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test((navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || navigator.userAgent)
export const notesModifier = (event: { metaKey: boolean; ctrlKey: boolean }) => isMac ? event.metaKey : event.ctrlKey
export const notesModifierLabel = isMac ? '⌘' : 'Ctrl'

/** ⇧N toggles the mode, unless you are typing. `onToggle` hears the new state. */
export function useUiNotesShortcut(enabled: boolean, onToggle: (on: boolean) => void) {
  useEffect(() => {
    if (!enabled) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'N' || !event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || event.repeat || event.defaultPrevented) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], .cm-editor')) return
      event.preventDefault()
      toggleUiNotesMode()
      onToggle(on)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [enabled, onToggle])
}
