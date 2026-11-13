import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { useToast, type Tone } from './ui'
import './motion.css'

const cx = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' ')

// A labelled copy button whose icon morphs to a check and whose label rolls Copy → Copied.
export function CopyAction({ value, label, variant = 'secondary', size = 'md', compact = false, className }: { value: string; label: string; variant?: 'secondary' | 'ghost' | 'primary'; size?: 'sm' | 'md'; compact?: boolean; className?: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const toast = useToast()
  useEffect(() => () => clearTimeout(timer.current), [])
  async function copy() {
    try { await navigator.clipboard.writeText(value) } catch { toast('Couldn’t copy to clipboard.', 'error'); return }
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1800)
  }
  return <>
    <button type="button" className={cx('ui-button', `ui-button--${variant}`, `ui-button--${size}`, 'copy-action', compact && 'copy-action--compact', className)} data-copied={copied || undefined} aria-label={label} title={label} onClick={() => void copy()}>
      <span className="copy-action__icon" aria-hidden="true"><Copy size={14} /><Check size={14} strokeWidth={2.5} /></span>
      {!compact && <span className="copy-action__text" aria-hidden="true">Cop<span className="copy-action__roll"><span>y</span><span>ied</span></span></span>}
    </button>
    <span className="sr-only" role="status">{copied ? 'Copied to clipboard' : ''}</span>
  </>
}

export type LiveState = 'pending' | 'verified' | 'failed'
const liveTone: Record<LiveState, Tone> = { pending: 'warning', verified: 'success', failed: 'danger' }
const liveLabels: Record<LiveState, string> = { pending: 'Pending', verified: 'Verified', failed: 'Failed' }
const liveStates = Object.keys(liveLabels) as LiveState[]

// Status that pulses while pending and morphs its dot into a check once verified. Plain drops the pill.
// Every label is laid out in one cell, so the width never changes between states.
export function LiveStatus({ state, labels, plain = false }: { state: LiveState; labels?: Partial<Record<LiveState, string>>; plain?: boolean }) {
  return <span className={cx(!plain && 'ui-status', `ui-tone--${liveTone[state]}`, 'live-status', plain && 'live-status--plain')} data-state={state}>
    <span className="live-status__mark" aria-hidden="true"><span className="live-status__dot" /><Check className="live-status__check" size={11} strokeWidth={3} /></span>
    <span className="live-status__label">{liveStates.map(key => <span key={key} data-active={key === state || undefined} aria-hidden={key === state ? undefined : true}>{labels?.[key] ?? liveLabels[key]}</span>)}</span>
  </span>
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches
// cubic-bezier(.2, .8, .2, 1), the curve CSS uses for the same changes (--ease-swap), for tweens driven from JS.
function ease(t: number) {
  const curve = (u: number, a: number, b: number) => 3 * a * u * (1 - u) ** 2 + 3 * b * u * u * (1 - u) + u ** 3
  let u = t
  for (let i = 0; i < 8; i++) { const x = curve(u, .2, .2) - t, slope = 3 * .2 * (1 - u) ** 2 + 3 * (1 - .2) * u * u; if (Math.abs(x) < 1e-5 || !slope) break; u = Math.min(1, Math.max(0, u - x / slope)) }
  return curve(u, .8, 1)
}
// Runs `frame(progress)` on every animation frame for `duration` ms with the shared curve; returns the cancel.
function tween(duration: number, frame: (progress: number) => void) {
  const start = performance.now()
  let id = 0
  const step = (now: number) => { const t = Math.min(1, (now - start) / duration); frame(ease(t)); if (t < 1) id = requestAnimationFrame(step) }
  id = requestAnimationFrame(step)
  return () => cancelAnimationFrame(id)
}

// Eases a number from its previous value to the next one (240 ms by default). The first defined value shows at once,
// so loading never animates; later changes (a new range, a refetch) tween from where the number is. Instant under
// reduced motion.
export function useTween(target: number | undefined, duration = 240): number {
  const [shown, setShown] = useState(target ?? 0)
  const current = useRef<number | undefined>(target)
  useEffect(() => {
    if (target === undefined) return
    const from = current.current
    if (from === undefined || from === target || reducedMotion()) { current.current = target; setShown(target); return }
    return tween(duration, progress => { current.current = from + (target - from) * progress; setShown(current.current) })
  }, [target, duration])
  return target === undefined ? shown : current.current === undefined ? target : shown
}

// The same for a series (a chart's bars and lines): when it keeps its length, every value moves from where it is to
// its next value; a different length, the first values and reduced motion apply at once (a Crossfade swaps those).
export function useMorph(target: readonly number[], duration = 200): readonly number[] {
  const [shown, setShown] = useState(target)
  const current = useRef(target)
  const signature = target.join(',')
  useEffect(() => {
    const from = current.current
    if (from.length !== target.length || from.every((value, i) => Object.is(value, target[i])) || reducedMotion()) { current.current = target; setShown(target); return }
    return tween(duration, progress => { current.current = target.map((value, i) => Number.isFinite(from[i]) && Number.isFinite(value) ? from[i] + (value - from[i]) * progress : value); setShown(current.current) })
  }, [signature, duration])
  return shown.length === target.length ? shown : target
}

type Layer = { id: string; node: ReactNode }
const pending = '\u0000pending'
// Swaps content that changed as a whole (a chart over a new period, a refreshed list) by fading the outgoing layer out
// while the incoming one fades in over it (200 ms). Content that changes under the same id updates in place. The
// layers share one grid cell (or overlap in SVG), so the box never resizes and nothing moves. An undefined id is
// content still loading: its swap to the first real id is instant, like any first paint, and so is every swap under
// reduced motion.
export function Crossfade({ id, children, className, as = 'div' }: { id: string | undefined; children: ReactNode; className?: string; as?: 'div' | 'g' }) {
  const key = id ?? pending
  const [state, setState] = useState<{ key: string; leaving: Layer[]; entering: string | null }>({ key, leaving: [], entering: null })
  const last = useRef<ReactNode>(children)
  useLayoutEffect(() => { last.current = children })
  if (state.key !== key) {
    const instant = state.key === pending || reducedMotion()
    setState({ key, leaving: instant ? [] : [...state.leaving.filter(layer => layer.id !== key).slice(-1), { id: state.key, node: last.current }], entering: instant ? null : key })
  }
  const Tag = as
  const leave = (gone: string) => setState(previous => ({ ...previous, leaving: previous.leaving.filter(layer => layer.id !== gone) }))
  return <Tag className={cx('crossfade', className)}>
    {state.leaving.filter(layer => layer.id !== key).map(layer => <Tag key={layer.id} className="crossfade__layer crossfade__layer--out" aria-hidden="true" inert onAnimationEnd={event => { if (event.target === event.currentTarget) leave(layer.id) }}>{layer.node}</Tag>)}
    <Tag key={key} className={cx('crossfade__layer', state.entering === key && 'crossfade__layer--in')}>{children}</Tag>
  </Tag>
}
