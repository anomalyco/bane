import { createContext, createElement, useContext, useEffect, useReducer, type ComponentType, type ReactNode } from 'react'

// What a page shows while its chunk downloads: the route skeleton in the dashboard, a loader elsewhere.
export const ChunkFallback = createContext<ReactNode>(null)

// A route chunk whose pages never suspend. React holds a revealed Suspense fallback for at least 300 ms,
// so a page that suspended on a cold load (its chunk still downloading) showed its skeleton, and held back
// its first requests, until that window ended even when the chunk arrived sooner. A page here renders the
// nearest ChunkFallback until its chunk is in, then itself at once. A failed load throws to the error
// boundary, as React.lazy would; the next render retries.
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
    if (failure !== undefined) throw failure
    return fallback
  }
  return { preload, page }
}
