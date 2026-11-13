// Live view of rituals, routes and endpoints: while one of their pages is open, it learns of a save made elsewhere
// (an agent over MCP, an API key, another tab) without a reload. One long poll on GET /v1/rituals/version
// (api/src/ritual-version.ts), paused while the tab is hidden; if long requests are cut short on the way, it polls
// every 4 s instead.
import { useEffect, useRef } from 'react'
import { request } from '../../data/live'
import { ApiError } from '../../data/types'

export type ChangeActor = { type: 'member' | 'api_key' | 'mcp'; name: string | null; self: boolean }
export type LiveVersion = { version: number; endpoints: string; changed: boolean; actor: ChangeActor | null }
/** What the page learns: the server's version and who saved it, whether this is the first answer (the baseline), and
 *  whether the version or an endpoint changed since the last one. */
export type LiveChange = LiveVersion & { first: boolean; versionMoved: boolean; endpointsMoved: boolean }

const POLL_MS = 4000, WAIT_S = 25

/** Who made a change, for “Updated by …”: a member’s name, an API key’s name or an MCP client and its profile label. */
export function actorText(actor: ChangeActor | null): string {
  if (!actor) return 'someone else'
  if (actor.self) return actor.type === 'member' ? 'you, in another tab' : 'this key'
  if (actor.name) return actor.type === 'api_key' ? `the ${actor.name} key` : actor.name
  return actor.type === 'mcp' ? 'an agent' : actor.type === 'api_key' ? 'an API key' : 'a teammate'
}

/**
 * Calls onChange with the first answer and then with every version or endpoint change, until the page closes or
 * enabled turns false. With endpoints, endpoint changes wake it too.
 */
export function useLiveVersion(enabled: boolean, onChange: (change: LiveChange) => void, { endpoints = false }: { endpoints?: boolean } = {}) {
  const latest = useRef(onChange)
  latest.current = onChange
  useEffect(() => {
    if (!enabled) return
    let stopped = false, controller: AbortController | null = null, timer: ReturnType<typeof setTimeout> | undefined
    let wake: (() => void) | null = null
    let known: { version: number; endpoints: string } | null = null, failures = 0, cut = 0, polling = false
    const hidden = () => document.visibilityState === 'hidden'
    const pause = (ms: number) => new Promise<void>(resolve => { wake = resolve; timer = setTimeout(resolve, ms) })
    // Hidden: stop asking (the request in flight is dropped). Shown again: catch up at once, then wait again.
    const onVisibility = () => { if (hidden()) controller?.abort(); else { clearTimeout(timer); wake?.() } }
    document.addEventListener('visibilitychange', onVisibility)
    void (async () => {
      while (!stopped) {
        if (hidden()) { await new Promise<void>(resolve => { wake = resolve }); continue }
        const wait = known && !polling ? WAIT_S : 0, started = Date.now()
        const query: string = known ? `?after=${known.version}${endpoints ? `&endpoints=${known.endpoints}` : ''}&wait=${wait}` : ''
        controller = new AbortController()
        try {
          const next: LiveVersion = await request<LiveVersion>(`/v1/rituals/version${query}`, { signal: controller.signal })
          if (stopped) return
          const versionMoved = !!known && next.version !== known.version, endpointsMoved = !!known && next.endpoints !== known.endpoints
          if (!known || versionMoved || endpointsMoved) latest.current({ ...next, first: !known, versionMoved, endpointsMoved })
          known = { version: next.version, endpoints: next.endpoints }
          failures = 0
          // A wait that keeps coming back early with nothing means something on the way cuts long requests: poll.
          if (wait && !next.changed && Date.now() - started < 2000) { if (++cut >= 3) polling = true } else cut = 0
          if (polling || !wait) await pause(POLL_MS)
        } catch (error) {
          if (stopped) return
          if (error instanceof DOMException && error.name === 'AbortError') continue
          // 401 and 403 end it: the page shows the sign-in or the refusal itself.
          if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return
          failures++
          await pause(error instanceof ApiError && error.status === 429 ? 60_000 : Math.min(30_000, POLL_MS * 2 ** (failures - 1)))
        }
      }
    })()
    return () => { stopped = true; controller?.abort(); clearTimeout(timer); wake?.(); document.removeEventListener('visibilitychange', onVisibility) }
  }, [enabled, endpoints])
}

export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string; line: number }
/**
 * A line diff (longest common subsequence after trimming the common head and tail), for the conflict view and to
 * mark the lines a remote save changed. `line` is the line's number in the side it comes from (b for same and add,
 * a for del). Scripts are at most 64 KiB; a middle beyond 2,000 lines on either side is shown as replaced whole.
 */
export function diffLines(a: string, b: string): DiffLine[] {
  const x = a.split('\n'), y = b.split('\n')
  let head = 0
  while (head < x.length && head < y.length && x[head] === y[head]) head++
  let tail = 0
  while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++
  const xs = x.slice(head, x.length - tail), ys = y.slice(head, y.length - tail)
  const out: DiffLine[] = x.slice(0, head).map((text, i) => ({ kind: 'same', text, line: i + 1 }))
  if (xs.length > 2000 || ys.length > 2000) {
    out.push(...xs.map((text, i) => ({ kind: 'del' as const, text, line: head + i + 1 })), ...ys.map((text, i) => ({ kind: 'add' as const, text, line: head + i + 1 })))
  } else {
    // lengths[i][j]: the longest common subsequence of xs[i..] and ys[j..].
    const lengths = Array.from({ length: xs.length + 1 }, () => new Uint16Array(ys.length + 1))
    for (let i = xs.length - 1; i >= 0; i--) for (let j = ys.length - 1; j >= 0; j--)
      lengths[i]![j] = xs[i] === ys[j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!)
    let i = 0, j = 0
    while (i < xs.length || j < ys.length) {
      if (i < xs.length && j < ys.length && xs[i] === ys[j]) { out.push({ kind: 'same', text: ys[j]!, line: head + j + 1 }); i++; j++ }
      else if (j < ys.length && (i === xs.length || lengths[i]![j + 1]! >= lengths[i + 1]![j]!)) { out.push({ kind: 'add', text: ys[j]!, line: head + j + 1 }); j++ }
      else { out.push({ kind: 'del', text: xs[i]!, line: head + i + 1 }); i++ }
    }
  }
  out.push(...y.slice(y.length - tail).map((text, i) => ({ kind: 'same' as const, text, line: y.length - tail + i + 1 })))
  return out
}
/** The lines of b that are new or changed compared with a, for marking a remote save in the editor. */
export const changedLines = (a: string, b: string) => diffLines(a, b).filter(d => d.kind === 'add').map(d => d.line)
