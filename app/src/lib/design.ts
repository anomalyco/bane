import { useLocation } from 'react-router'

// Design pitch switch (Overview, Settings, sidebar report card): `?design=a|b|c` picks a direction (A by default),
// `?design=current` returns to today's screens, and the choice sticks for the tab. Only in dev servers and pitch builds
// (VITE_DESIGN_PITCH=1); production builds always render the current design.
export type Design = 'current' | 'a' | 'b' | 'c'
const designs: readonly Design[] = ['current', 'a', 'b', 'c']
const enabled = import.meta.env.DEV || import.meta.env.VITE_DESIGN_PITCH === '1'
const storageKey = 'bane.design-pitch'
const parse = (value: string | null): Design | null => designs.includes(value as Design) ? value as Design : null

// With the pitch on, A (the chosen direction) is the default; `?design=current` shows today's screens.
export function readDesign(search = window.location.search): Design {
  if (!enabled) return 'current'
  const requested = parse(new URLSearchParams(search).get('design'))
  try {
    if (requested) { sessionStorage.setItem(storageKey, requested); return requested }
    return parse(sessionStorage.getItem(storageKey)) ?? 'a'
  } catch { return requested ?? 'a' }
}
// `?score=0-100` pins the sender score, to review every grade band against real data.
export function readScoreOverride(search = window.location.search): number | null {
  if (!enabled) return null
  const value = Number(new URLSearchParams(search).get('score') ?? NaN)
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null
}
// Re-read on navigation so a new ?design= takes effect without a reload.
export function useDesign(): Design { return readDesign(useLocation().search) }
// `?card=1|2|3|4` picks a score card option (sticks for the tab); without it, pass 2's certificate.
export type CardOption = 'cert' | '1' | '2' | '3' | '4'
const cardKey = 'bane.card-pitch'
export function readCardOption(search = window.location.search): CardOption {
  if (!enabled) return 'cert'
  const value = new URLSearchParams(search).get('card')
  const parse = (raw: string | null) => (['cert', '1', '2', '3', '4'] as const).find(option => option === raw) ?? null
  try {
    if (parse(value)) { sessionStorage.setItem(cardKey, value!); return parse(value)! }
    return parse(sessionStorage.getItem(cardKey)) ?? 'cert'
  } catch { return parse(value) ?? 'cert' }
}
