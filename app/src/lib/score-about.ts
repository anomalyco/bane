import { useSyncExternalStore } from 'react'

// Opens the sender score explainer from anywhere (the sidebar gauge, Overview's card and breakdown, Settings), with one
// dialog mounted by the shell. `focus` names a factor to highlight. Kept outside the score chunk so callers stay small.
type State = { open: boolean; focus: string | null }
let state: State = { open: false, focus: null }
const listeners = new Set<() => void>()
const set = (next: State) => { state = next; listeners.forEach(listener => listener()) }
export const openScoreAbout = (focus: string | null = null) => set({ open: true, focus })
export const closeScoreAbout = () => set({ ...state, open: false })
export function useScoreAbout() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => state)
}
