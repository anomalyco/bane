import { createContext, createElement, useContext, useEffect, useReducer, type ComponentType, type ReactNode } from 'react'

// What a page shows while its chunk downloads: the route skeleton in the dashboard, a loader elsewhere.
export const ChunkFallback = createContext<ReactNode>(null)

// A deploy since this page loaded removes the chunks it hasn't fetched yet, and the server answers one with the
// dashboard's HTML, so the import fails (a teammate joining from an invitation link met it: Overview's code was first
// needed after Join). Load the page again for the current build, once a minute at most: a failure right after a reload
// isn't a stale build and goes to the error boundary. 'bane:reloading' lets the toasts on screen survive it.
const RELOADED = 'bane.chunk-reload'
let reloading = false
function reloadForNewBuild() {
  if (reloading) return true
  if (!navigator.onLine) return false
  try {
    if (Date.now() - Number(sessionStorage.getItem(RELOADED)) < 60_000) return false
    sessionStorage.setItem(RELOADED, String(Date.now()))
  } catch { return false }
  reloading = true
  window.dispatchEvent(new Event('bane:reloading'))
  window.location.reload()
  return true
}

// A route chunk whose pages never suspend. React holds a revealed Suspense fallback for at least 300 ms,
// so a page that suspended on a cold load (its chunk still downloading) showed its skeleton, and held back
// its first requests, until that window ended even when the chunk arrived sooner. A page here renders the
// nearest ChunkFallback until its chunk is in, then itself at once. A failed load reloads the page for a new build
// (above), else throws to the error boundary, as React.lazy would; the next render retries.
export function chunk<Module>(load: () => Promise<Module>) {
  let loaded: Module | undefined
  let failure: unknown
  let pending: Promise<Module> | undefined
  const listeners = new Set<() => void>()
  const settle = () => listeners.forEach(listener => listener())
  const preload = () => pending ??= load().then(module => { loaded = module; failure = undefined; settle(); return module }, error => { pending = undefined; failure = error; settle(); throw error })
  const page = <Props extends object>(pick: (module: Module) => ComponentType<Props>) => function ChunkPage(props: Props) {
    const fallback = useContext(ChunkFallback)
    const [, rerender] = useReducer((n: number) => n + 1, 0)
    useEffect(() => {
      if (loaded) return
      listeners.add(rerender)
      preload().catch(() => {})
      if (loaded || failure !== undefined) rerender() // settled between this render and the subscription
      return () => { listeners.delete(rerender) }
    }, [])
    if (loaded) return createElement(pick(loaded), props)
    if (failure !== undefined) { if (reloadForNewBuild()) return fallback; throw failure }
    return fallback
  }
  return { preload, page }
}
