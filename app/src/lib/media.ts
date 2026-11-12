import { useSyncExternalStore } from 'react'

// The dashboard's three layout breakpoints. The app renders on the client only, so a hook reads the right answer on the
// first render: a phone never paints the desktop layout first, and nothing shifts when it swaps.
/** Below this width the sidebar gives way to a top bar and a bottom tab bar, and the document scrolls (not the page card). */
export const SHELL_COMPACT = '(max-width: 899px)'
/** Phones: tables render as cards, dialogs and menus as bottom sheets. */
export const PHONE = '(max-width: 640px)'
/** Touch screens get native selects and 44 px controls (styles/ui.css matches the same query). */
export const TOUCH = '(pointer: coarse)'

const lists = new Map<string, MediaQueryList>()
const list = (query: string) => { let media = lists.get(query); if (!media) lists.set(query, media = matchMedia(query)); return media }
export const matches = (query: string) => typeof matchMedia === 'function' && list(query).matches

export function useMediaQuery(query: string) {
  return useSyncExternalStore(
    change => { const media = list(query); media.addEventListener('change', change); return () => media.removeEventListener('change', change) },
    () => list(query).matches,
    () => false,
  )
}
export const useCompactShell = () => useMediaQuery(SHELL_COMPACT)
export const usePhone = () => useMediaQuery(PHONE)
export const useTouch = () => useMediaQuery(TOUCH)
