import { useLocation } from 'react-router'

// Design pitch switch (Overview, Settings, sidebar report card): `?design=a|b|c` picks a direction, `?design=current`
// returns to today's screens, and the choice sticks for the tab. Only in dev servers and pitch builds
// (VITE_DESIGN_PITCH=1); production builds always render the current design.
export type Design = 'current' | 'a' | 'b' | 'c'
const designs: readonly Design[] = ['current', 'a', 'b', 'c']
const enabled = import.meta.env.DEV || import.meta.env.VITE_DESIGN_PITCH === '1'
const storageKey = 'bane.design-pitch'
const parse = (value: string | null): Design | null => designs.includes(value as Design) ? value as Design : null

export function readDesign(search = window.location.search): Design {
  if (!enabled) return 'current'
  const requested = parse(new URLSearchParams(search).get('design'))
  try {
    if (requested) { sessionStorage.setItem(storageKey, requested); return requested }
    return parse(sessionStorage.getItem(storageKey)) ?? 'current'
  } catch { return requested ?? 'current' }
}
// Re-read on navigation so a new ?design= takes effect without a reload.
export function useDesign(): Design { return readDesign(useLocation().search) }
