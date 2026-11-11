import type { CSSProperties } from 'react'
import type { SenderGrade, SenderScore } from '../../data/types'

// The sender score as an instrument: the six grade bands as arcs on a 40–100 dial, a needle that sweeps in once,
// faint film grain and a tick ruler. Two sizes: `compact` (the sidebar card, 56px tall) and `full` (Overview).
const MIN = 40
const BANDS: { grade: SenderGrade; from: number; to: number }[] = [{ grade: 'F', from: 40, to: 60 }, { grade: 'D', from: 60, to: 70 }, { grade: 'C', from: 70, to: 80 }, { grade: 'B', from: 80, to: 90 }, { grade: 'A', from: 90, to: 95 }, { grade: 'A+', from: 95, to: 100 }]
export const gradeKey = (grade: SenderGrade) => grade === 'A+' ? 'aplus' : grade.toLowerCase()
const clampValue = (value: number) => Math.min(100, Math.max(MIN, value))
const angle = (value: number) => Math.PI * (1 - (clampValue(value) - MIN) / (100 - MIN))
const at = (cx: number, cy: number, r: number, value: number) => [cx + r * Math.cos(angle(value)), cy - r * Math.sin(angle(value))] as const
const arc = (cx: number, cy: number, r: number, from: number, to: number) => { const [x1, y1] = at(cx, cy, r, from), [x2, y2] = at(cx, cy, r, to); return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}` }

export function Dial({ report, size }: { report: SenderScore; size: 'full' | 'compact' }) {
  const full = size === 'full'
  const [w, h, cx, cy, r, stroke] = full ? [240, 128, 120, 116, 96, 7] : [60, 34, 30, 31, 25, 4]
  const graded = report.state === 'graded' && report.score !== null && report.grade !== null
  const turn = graded ? 180 * (clampValue(report.score!) - MIN) / (100 - MIN) : 0
  const ticks = full ? Array.from({ length: 25 }, (_, i) => MIN + i * 2.5) : []
  return <svg className="gauge-dial" viewBox={`0 0 ${w} ${h}`} aria-hidden="true" style={{ '--turn': `${turn}deg`, '--hub': `${cx}px ${cy}px` } as CSSProperties}>
    {BANDS.map(band => <path key={band.grade} className="gauge-band" data-grade={graded ? gradeKey(band.grade) : 'none'} data-on={graded && report.grade === band.grade || undefined} d={arc(cx, cy, r, band.from + .35, band.to - .35)} strokeWidth={stroke} />)}
    {!graded && report.emails.firstEmails > 0 && <path className="gauge-progress" d={arc(cx, cy, r, MIN, MIN + (100 - MIN) * Math.min(1, report.emails.firstEmails / report.needed))} strokeWidth={stroke} />}
    {ticks.map(tick => { const major = BANDS.some(band => band.from === tick) || tick === 100; const [x1, y1] = at(cx, cy, r - stroke / 2 - 3, tick), [x2, y2] = at(cx, cy, r - stroke / 2 - (major ? 11 : 7), tick); return <line key={tick} className={major ? 'gauge-tick gauge-tick--major' : 'gauge-tick'} x1={x1} y1={y1} x2={x2} y2={y2} /> })}
    {full && BANDS.map(band => { const [x, y] = at(cx, cy, r - 30, (band.from + band.to) / 2); return <text key={band.grade} className="gauge-label" x={x} y={y + 3} textAnchor="middle">{band.grade}</text> })}
    {full && [40, 60, 80, 100].map(tick => { const [x, y] = at(cx, cy, r + 12, tick); return <text key={tick} className="gauge-num" x={x} y={y + 3} textAnchor="middle">{tick}</text> })}
    <g className="gauge-needle" data-rest={!graded || undefined}><line x1={cx} y1={cy} x2={cx - (r - (full ? 6 : 3))} y2={cy} /><circle cx={cx} cy={cy} r={full ? 5 : 2.6} /></g>
  </svg>
}
