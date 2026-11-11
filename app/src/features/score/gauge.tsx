import type { CSSProperties } from 'react'
import type { SenderGrade, SenderScore } from '../../data/types'

// The sender score as an instrument: the six grade bands on a 40–100 scale and a needle that sweeps in once.
// Two forms: `Dial`, the arc in the sidebar card (56px tall), and `Strip`, a slim horizontal scale for Overview.
const MIN = 40
const BANDS: { grade: SenderGrade; from: number; to: number }[] = [{ grade: 'F', from: 40, to: 60 }, { grade: 'D', from: 60, to: 70 }, { grade: 'C', from: 70, to: 80 }, { grade: 'B', from: 80, to: 90 }, { grade: 'A', from: 90, to: 95 }, { grade: 'A+', from: 95, to: 100 }]
export const gradeKey = (grade: SenderGrade) => grade === 'A+' ? 'aplus' : grade.toLowerCase()
const clampValue = (value: number) => Math.min(100, Math.max(MIN, value))
const share = (value: number) => (clampValue(value) - MIN) / (100 - MIN)
const angle = (value: number) => Math.PI * (1 - share(value))
const at = (cx: number, cy: number, r: number, value: number) => [cx + r * Math.cos(angle(value)), cy - r * Math.sin(angle(value))] as const
const arc = (cx: number, cy: number, r: number, from: number, to: number) => { const [x1, y1] = at(cx, cy, r, from), [x2, y2] = at(cx, cy, r, to); return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}` }
const graded = (report: SenderScore) => report.state === 'graded' && report.score !== null && report.grade !== null
const warmup = (report: SenderScore) => Math.min(1, report.emails.firstEmails / report.needed)

export function Dial({ report }: { report: SenderScore }) {
  const [w, h, cx, cy, r, stroke] = [60, 34, 30, 31, 25, 4], on = graded(report)
  return <svg className="gauge-dial" viewBox={`0 0 ${w} ${h}`} aria-hidden="true" style={{ '--turn': `${on ? 180 * share(report.score!) : 0}deg`, '--hub': `${cx}px ${cy}px` } as CSSProperties}>
    {BANDS.map(band => <path key={band.grade} className="gauge-band" data-grade={on ? gradeKey(band.grade) : 'none'} data-on={on && report.grade === band.grade || undefined} d={arc(cx, cy, r, band.from + .35, band.to - .35)} strokeWidth={stroke} />)}
    {!on && report.emails.firstEmails > 0 && <path className="gauge-progress" d={arc(cx, cy, r, MIN, MIN + (100 - MIN) * warmup(report))} strokeWidth={stroke} />}
    <g className="gauge-needle" data-rest={!on || undefined}><line x1={cx} y1={cy} x2={cx - (r - 3)} y2={cy} /><circle cx={cx} cy={cy} r={2.6} /></g>
  </svg>
}

// The bands laid flat, widths in proportion to their score ranges, with a tick every 2.5 points and the needle sliding
// to the score (transform only). Before the first grade the bands are neutral and fill with warm-up progress.
export function Strip({ report }: { report: SenderScore }) {
  const on = graded(report)
  return <div className="score-strip" aria-hidden="true" data-rest={!on || undefined} style={{ '--pos': `${on ? share(report.score!) * 100 : 0}%`, '--warmup': warmup(report) } as CSSProperties}>
    <div className="score-strip__bands">{BANDS.map(band => <span key={band.grade} data-grade={on ? gradeKey(band.grade) : 'none'} data-on={on && report.grade === band.grade || undefined} style={{ flexGrow: band.to - band.from }} />)}</div>
    {!on && <i className="score-strip__progress" />}
    <span className="score-strip__ticks" />
    <span className="score-strip__track"><span className="score-strip__needle" /></span>
  </div>
}
