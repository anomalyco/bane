import type { CSSProperties, PointerEvent, ReactNode } from 'react'
import { Link } from 'react-router'
import { useSession } from '../../data/context'
import { gradeKey, WARMUP_EMAILS, type ScoreReport } from '../../lib/sender-score'
import './score-card.css'

// The sender score as a collectible: a certificate-like card in the grade's material, with banknote line work,
// a guilloche medallion, film grain and a sheen that follows the pointer. Pure CSS and SVG; the only deliberate
// exception to the dashboard's flat styling. Two sizes: `full` (Overview) and `compact` (sidebar, 56px tall).

// Banknote background: lines across the card, each the sum of two sines drifting in phase.
function wavePaths(width: number, height: number, count: number) {
  return Array.from({ length: count }, (_, i) => {
    const y0 = (i + .5) * height / count, phase = i * .55
    let d = ''
    for (let x = 0; x <= width; x += 3) {
      const y = y0 + height / count * .9 * Math.sin(x / 24 + phase) + height / count * .35 * Math.sin(x / 8.5 - phase * 1.7)
      d += `${x ? 'L' : 'M'}${x} ${y.toFixed(2)}`
    }
    return d
  })
}
// Guilloche ring: interleaved sine-modulated circles between two radii, plus a spirograph star inside.
function ringPaths(r0: number, r1: number, curves: number, lobes: number) {
  return Array.from({ length: curves }, (_, i) => {
    const phase = i / curves * 2 * Math.PI
    let d = ''
    for (let step = 0; step <= 360; step++) {
      const t = step / 360 * 2 * Math.PI, r = (r0 + r1) / 2 + (r1 - r0) / 2 * Math.sin(lobes * t + phase)
      d += `${step ? 'L' : 'M'}${(50 + r * Math.cos(t)).toFixed(2)} ${(50 + r * Math.sin(t)).toFixed(2)}`
    }
    return d + 'Z'
  })
}
function spiroPath(radius: number) {
  const R = 96, r = 36, d = 34, k = (R - r) / r, scale = radius / ((R - r) + d)
  let path = ''
  for (let step = 0; step <= 1080; step++) {
    const t = step / 1080 * 6 * Math.PI
    path += `${step ? 'L' : 'M'}${(50 + scale * ((R - r) * Math.cos(t) + d * Math.cos(k * t))).toFixed(2)} ${(50 + scale * ((R - r) * Math.sin(t) - d * Math.sin(k * t))).toFixed(2)}`
  }
  return path
}
const art = {
  full: { waves: wavePaths(320, 180, 15), ring: ringPaths(37, 48, 12, 15), spiro: spiroPath(27) },
  compact: { waves: wavePaths(208, 56, 6), ring: ringPaths(38, 48, 6, 11), spiro: spiroPath(26) },
}
const micro = 'BANE · SENDER SCORE · '.repeat(12)

// A stable four-digit serial per workspace, for the certificate feel.
function serial(id: string | undefined) {
  let hash = 2166136261
  for (const char of id ?? 'bane') hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return String(1000 + (hash >>> 0) % 9000)
}
const reduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
function follow(event: PointerEvent<HTMLElement>) {
  if (reduceMotion()) return
  const box = event.currentTarget.getBoundingClientRect()
  event.currentTarget.style.setProperty('--sx', ((event.clientX - box.left) / box.width).toFixed(3))
  event.currentTarget.style.setProperty('--sy', ((event.clientY - box.top) / box.height).toFixed(3))
}
function rest(event: PointerEvent<HTMLElement>) { event.currentTarget.style.removeProperty('--sx'); event.currentTarget.style.removeProperty('--sy') }
const share = (value: number) => ({ '--share': `${Math.round(Math.min(1, Math.max(0, value)) * 1000) / 10}%` }) as CSSProperties

function Medal({ size, letter, progress }: { size: 'full' | 'compact'; letter: ReactNode; progress?: number }) {
  const shape = art[size], circumference = 2 * Math.PI * 47
  return <span className="score-card__medal" aria-hidden="true">
    <svg viewBox="0 0 100 100">
      <g className="score-card__ring">{shape.ring.map((d, i) => <path key={i} d={d} />)}</g>
      <circle className="score-card__disc" cx="50" cy="50" r="33" />
      <path className="score-card__spiro" d={shape.spiro} />
      <circle className="score-card__rim" cx="50" cy="50" r="34.5" />
      {progress !== undefined && <circle className="score-card__track" cx="50" cy="50" r="47" />}
      {progress !== undefined && progress > 0 && <circle className="score-card__progress" cx="50" cy="50" r="47" strokeDasharray={`${circumference * progress} ${circumference}`} transform="rotate(-90 50 50)" />}
    </svg>
    <span className="score-card__letter">{letter}</span>
  </span>
}
function Layers({ size }: { size: 'full' | 'compact' }) {
  return <>
    <svg className="score-card__lines" viewBox={size === 'full' ? '0 0 320 180' : '0 0 208 56'} preserveAspectRatio="none" aria-hidden="true">{art[size].waves.map((d, i) => <path key={i} d={d} />)}</svg>
    <span className="score-card__grain" aria-hidden="true" />
    <span className="score-card__sheen" aria-hidden="true" />
  </>
}
const letterOf = (grade: string) => <>{grade[0]}{grade.length > 1 && <span className="score-card__plus">+</span>}</>

export function ScoreCard({ report, size, to }: { report: ScoreReport; size: 'full' | 'compact'; to?: string }) {
  const workspaceId = useSession()?.identity?.workspaceId
  const warmup = report.state === 'warmup'
  const grade = warmup ? 'none' : gradeKey(report.grade)
  const label = warmup ? `Sender score: ${report.emails} of ${WARMUP_EMAILS} emails before the first grade` : `Sender score ${Math.round(report.score)}, grade ${report.grade}`
  const within = warmup ? report.emails / WARMUP_EMAILS : (report.score - report.band.min) / Math.max(1, report.band.max - report.band.min)
  const medal = <Medal size={size} letter={warmup ? '?' : letterOf(report.grade)} progress={warmup ? report.emails / WARMUP_EMAILS : undefined} />
  if (size === 'compact') return <Link to={to ?? '/#sender-score'} className="score-card score-card--compact" data-grade={grade} aria-label={label} onPointerMove={follow} onPointerLeave={rest}>
    <Layers size="compact" />
    {medal}
    <span className="score-card__stack">
      <span className="score-card__row"><span className="score-card__eyebrow">Sender score</span><span className="score-card__value">{warmup ? <>{report.emails}<span className="score-card__of">/{WARMUP_EMAILS}</span></> : Math.round(report.score)}</span></span>
      <span className="score-card__meter" style={share(within)}><i /></span>
    </span>
  </Link>
  return <article className="score-card score-card--full" data-grade={grade} aria-label={label} onPointerMove={follow} onPointerLeave={rest}>
    <Layers size="full" />
    <div className="score-card__top"><span>Sender score</span><span>Nº {serial(workspaceId)}</span></div>
    <div className="score-card__main">
      {medal}
      <div className="score-card__figures">
        <span className="score-card__score">{warmup ? <>{report.emails}<span className="score-card__of">/{WARMUP_EMAILS}</span></> : Math.round(report.score)}</span>
        <span className="score-card__sub">{warmup ? 'Graded after 100 emails' : report.next ? `Grade ${report.grade} · ${Math.ceil(report.next.gap)} to ${report.next.grade}` : `Grade ${report.grade} · top grade`}</span>
      </div>
    </div>
    <span className="score-card__meter" style={share(within)}><i /></span>
    <div className="score-card__ends"><span>{warmup ? '0' : report.band.min}</span><span>{warmup ? `${WARMUP_EMAILS} emails` : report.next ? `${report.next.grade} at ${report.next.at}` : '100'}</span></div>
    <div className="score-card__micro" aria-hidden="true">{micro}</div>
  </article>
}
