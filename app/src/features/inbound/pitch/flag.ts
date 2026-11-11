// Pitch only: ?receiving=1|2|3 picks a Receiving direction for this tab (kept across navigation); ?receiving=0 clears it.
import { useLocation } from 'react-router'

export type Direction = 0 | 1 | 2 | 3
const KEY = 'bane.pitch.receiving'
export function useReceivingPitch(): Direction {
  const { search } = useLocation()
  const value = new URLSearchParams(search).get('receiving')
  if (value !== null) {
    const n = Number(value)
    if ([1, 2, 3].includes(n)) sessionStorage.setItem(KEY, String(n))
    else sessionStorage.removeItem(KEY)
  }
  const stored = Number(sessionStorage.getItem(KEY))
  return ([1, 2, 3].includes(stored) ? stored : 0) as Direction
}
