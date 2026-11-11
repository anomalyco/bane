import type { CSSProperties, ReactNode } from 'react'
import { Link, useLocation } from 'react-router'
import { useSession } from '../../data/context'
import { readCardOption, type CardOption } from '../../lib/design'
import { gradeFor, gradeKey, nextStep, WARMUP_EMAILS, type FactorResult, type Grade, type ScoreReport } from '../../lib/sender-score'
import { follow, rest, ScoreCard, serial } from './ScoreCard'
import '../../components/grade-badge.css'
import './options.css'

// Pitch round 3: four score card concepts, each in two sizes (`compact` 208×56 for the sidebar, `full` for
// Overview A's detail column). `?card=1|2|3|4` picks one; without it, pass 2's certificate.
//  1 report card: a school report, typographic, subjects with letter grades
//  2 gauge: an instrument dial with the bands and a needle
//  3 sticker: a bold trading card with a die-cut edge, a holo sheen and grain
//  4 terminal: a pixel-art grade in a TUI panel with a pixel sparkline
type Graded = Extract<ScoreReport, { state: 'graded' }>
type Size = 'full' | 'compact'
export function useCardOption(): CardOption { return readCardOption(useLocation().search) }
// Option 1 carries its own subject rows and remarks, so Overview drops the separate breakdown for it.
export const optionHasBreakdown = (option: CardOption) => option !== '1'

const whole = (value: number) => Math.round(value)
const share = (value: number) => ({ '--share': `${Math.round(Math.min(1, Math.max(0, value)) * 1000) / 10}%` }) as CSSProperties
const toNext = (report: Graded) => report.next ? `${Math.ceil(report.next.gap)} to ${report.next.grade}` : 'Top grade'
const trend = (report: Graded) => { const moved = whole(report.score - report.history[0]); return `${moved > 0 ? '+' : moved < 0 ? '−' : '±'}${Math.abs(moved)}` }
const subjectGrade = (factor: FactorResult) => gradeFor(factor.score)
const shortName: Record<FactorResult['key'], string> = { complaints: 'CMP', bounces: 'BNC', content: 'CNT', auth: 'AUTH', hygiene: 'LIST', consistency: 'VOL' }
const labelFor = (report: ScoreReport) => report.state === 'warmup' ? `Sender score: ${report.emails} of ${WARMUP_EMAILS} emails before the first grade` : `Sender score ${whole(report.score)}, grade ${report.grade}`

export function ScoreOption({ report, size, option }: { report: ScoreReport; size: Size; option: CardOption }) {
  if (option === 'cert') return <ScoreCard report={report} size={size} />
  const grade = report.state === 'warmup' ? 'none' : gradeKey(report.grade)
  const body = option === '1' ? <ReportSlip report={report} size={size} /> : option === '2' ? <Gauge report={report} size={size} /> : option === '3' ? <Sticker report={report} size={size} /> : <Terminal report={report} size={size} />
  const className = `score-opt score-opt--${size} score-opt-${option}`
  const motion = option === '3' ? { onPointerMove: follow, onPointerLeave: rest } : {}
  return size === 'compact'
    ? <Link to="/#sender-score" className={className} data-grade={grade} aria-label={labelFor(report)} {...motion}>{body}</Link>
    : <article className={className} data-grade={grade} aria-label={labelFor(report)} {...motion}>{body}</article>
}

// 1 · Report card ---------------------------------------------------------------------------------------------
function ReportSlip({ report, size }: { report: ScoreReport; size: Size }) {
  const warmup = report.state === 'warmup'
  const box = <span className="o1-grade">{warmup ? 'INC' : report.grade}</span>
  if (size === 'compact') return <>
    {box}
    <span className="o1-stack">
      <span className="o1-row"><span className="o1-eyebrow">Sender report</span><b className="o1-value">{warmup ? <>{report.emails}<small>/{WARMUP_EMAILS}</small></> : whole(report.score)}</b></span>
      <span className="o1-marks">{warmup ? <span className="o1-muted">Incomplete</span> : report.factors.map(factor => { const g = subjectGrade(factor); return <span key={factor.key} data-low={g === 'F' || g === 'D' || undefined}>{g}</span> })}</span>
    </span>
  </>
  const factors = warmup ? null : report.factors
  return <>
    <div className="o1-head"><span>Sender report</span><span>Term · 30 days</span></div>
    <div className="o1-summary">
      <div className="o1-overall">
        <span className="o1-eyebrow">Overall</span>
        <span className="o1-score">{warmup ? report.emails : whole(report.score)}<small>/100{warmup ? ' emails' : ''}</small></span>
        <span className="o1-muted">{warmup ? `Graded after ${WARMUP_EMAILS} emails` : toNext(report)}</span>
      </div>
      {box}
    </div>
    <table className="o1-subjects">
      <thead><tr><th>Subject</th><th>Grade</th><th>Result</th></tr></thead>
      <tbody>{(factors ?? []).map(factor => { const g = subjectGrade(factor); return <tr key={factor.key} title={factor.source}><td><span>{factor.label}</span><i /></td><td data-low={g === 'F' || g === 'D' || undefined}>{g}</td><td>{factor.format(factor.value)}</td></tr> })}
        {!factors && ['Complaints', 'Bounces', 'Content', 'Authentication', 'List hygiene', 'Consistency'].map(name => <tr key={name}><td><span>{name}</span><i /></td><td className="o1-muted">—</td><td className="o1-muted">—</td></tr>)}</tbody>
    </table>
    <p className="o1-remarks"><span>Remarks</span>{warmup ? `Incomplete. Your first grade comes after ${WARMUP_EMAILS} emails.` : nextStep(report).text}</p>
  </>
}

// 2 · Gauge ---------------------------------------------------------------------------------------------------
const MIN = 40
const bands: { grade: Grade; from: number; to: number }[] = [{ grade: 'F', from: 40, to: 60 }, { grade: 'D', from: 60, to: 70 }, { grade: 'C', from: 70, to: 80 }, { grade: 'B', from: 80, to: 90 }, { grade: 'A', from: 90, to: 95 }, { grade: 'A+', from: 95, to: 100 }]
const angle = (value: number) => Math.PI * (1 - (Math.min(100, Math.max(MIN, value)) - MIN) / (100 - MIN))
const at = (cx: number, cy: number, r: number, value: number) => [cx + r * Math.cos(angle(value)), cy - r * Math.sin(angle(value))] as const
const arc = (cx: number, cy: number, r: number, from: number, to: number) => { const [x1, y1] = at(cx, cy, r, from), [x2, y2] = at(cx, cy, r, to); return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}` }
function Dial({ report, size }: { report: ScoreReport; size: Size }) {
  const full = size === 'full'
  const [w, h, cx, cy, r, stroke] = full ? [240, 128, 120, 116, 96, 7] : [60, 34, 30, 31, 25, 4]
  const warmup = report.state === 'warmup'
  const value = warmup ? MIN : report.score
  const turn = 180 * (Math.min(100, Math.max(MIN, value)) - MIN) / (100 - MIN)
  const ticks = full ? Array.from({ length: 25 }, (_, i) => MIN + i * 2.5) : []
  return <svg className="o2-dial" viewBox={`0 0 ${w} ${h}`} aria-hidden="true" style={{ '--turn': `${turn}deg`, '--hub': `${cx}px ${cy}px` } as CSSProperties}>
    {bands.map(band => <path key={band.grade} className="o2-band" data-grade={warmup ? 'none' : gradeKey(band.grade)} data-on={!warmup && report.grade === band.grade || undefined} d={arc(cx, cy, r, band.from + .35, band.to - .35)} strokeWidth={stroke} />)}
    {warmup && report.emails > 0 && <path className="o2-progress" d={arc(cx, cy, r, MIN, MIN + (100 - MIN) * report.emails / WARMUP_EMAILS)} strokeWidth={stroke} />}
    {ticks.map(tick => { const major = bands.some(band => band.from === tick) || tick === 100; const [x1, y1] = at(cx, cy, r - stroke / 2 - 3, tick), [x2, y2] = at(cx, cy, r - stroke / 2 - (major ? 11 : 7), tick); return <line key={tick} className={major ? 'o2-tick o2-tick--major' : 'o2-tick'} x1={x1} y1={y1} x2={x2} y2={y2} /> })}
    {full && bands.map(band => { const [x, y] = at(cx, cy, r - 30, (band.from + band.to) / 2); return <text key={band.grade} className="o2-label" x={x} y={y + 3} textAnchor="middle">{band.grade}</text> })}
    {full && [40, 60, 80, 100].map(tick => { const [x, y] = at(cx, cy, r + 12, tick); return <text key={tick} className="o2-num" x={x} y={y + 3} textAnchor="middle">{tick}</text> })}
    <g className="o2-needle" data-rest={warmup || undefined}><line x1={cx} y1={cy} x2={cx - (r - (full ? 6 : 3))} y2={cy} /><circle cx={cx} cy={cy} r={full ? 5 : 2.6} /></g>
  </svg>
}
function Gauge({ report, size }: { report: ScoreReport; size: Size }) {
  const warmup = report.state === 'warmup'
  if (size === 'compact') return <>
    <Dial report={report} size="compact" />
    <span className="o2-stack">
      <span className="o2-eyebrow">{warmup ? 'Calibrating' : 'Sender score'}</span>
      <span className="o2-readout"><b>{warmup ? report.emails : whole(report.score)}</b>{warmup ? <small>/{WARMUP_EMAILS}</small> : <span className="o2-grade">{report.grade}</span>}</span>
    </span>
  </>
  return <>
    <div className="o2-head"><span>Sender score</span><span>{warmup ? 'Calibrating' : '30 days'}</span></div>
    <Dial report={report} size="full" />
    <div className="o2-center"><b>{warmup ? report.emails : whole(report.score)}</b>{warmup ? <small>/{WARMUP_EMAILS} emails</small> : <span className="o2-grade">Grade {report.grade}</span>}</div>
    <div className="o2-foot">{warmup ? <><span>Needle moves after {WARMUP_EMAILS} emails</span><span /></> : <><span>{toNext(report)}</span><span>{trend(report)} in 14 days</span></>}</div>
  </>
}

// 3 · Sticker -------------------------------------------------------------------------------------------------
function Sticker({ report, size }: { report: ScoreReport; size: Size }) {
  const warmup = report.state === 'warmup'
  const workspaceId = useSession()?.identity?.workspaceId
  const letter = <span className="o3-letter">{warmup ? '?' : <>{report.grade[0]}{report.grade.length > 1 && <sup>+</sup>}</>}</span>
  const layers = <><span className="o3-grain" aria-hidden="true" /><span className="o3-sheen" aria-hidden="true" /></>
  if (size === 'compact') return <>{layers}{letter}<span className="o3-stack"><span className="o3-eyebrow">{warmup ? 'Unopened' : 'Sender score'}</span><b className="o3-value">{warmup ? <>{report.emails}<small>/{WARMUP_EMAILS}</small></> : whole(report.score)}</b></span></>
  return <>
    {layers}
    <div className="o3-top"><span className="o3-eyebrow">Sender score</span><span className="o3-hp">{warmup ? report.emails : whole(report.score)}<small>{warmup ? `/${WARMUP_EMAILS}` : 'pts'}</small></span></div>
    <div className="o3-art">{letter}</div>
    <dl className="o3-stats">{warmup ? Object.values(shortName).map(name => <div key={name}><dt>{name}</dt><dd>??</dd></div>) : report.factors.map(factor => <div key={factor.key} title={`${factor.label}: ${factor.format(factor.value)}`}><dt>{shortName[factor.key]}</dt><dd>{whole(factor.score)}</dd></div>)}</dl>
    <div className="o3-foot"><span>{warmup ? `Opens at ${WARMUP_EMAILS} emails` : toNext(report)}</span><span>Nº {serial(workspaceId)}</span></div>
  </>
}

// 4 · Terminal ------------------------------------------------------------------------------------------------
const glyphs: Record<string, string[]> = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  '?': ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'],
}
const plus = ['.#.', '###', '.#.']
function Pixels({ grade, px }: { grade: Grade | null; px: number }) {
  const rows = glyphs[grade ? grade[0] : '?'], extra = grade === 'A+'
  const cells: ReactNode[] = []
  rows.forEach((row, y) => [...row].forEach((c, x) => { if (c === '#') cells.push(<rect key={`${x}-${y}`} x={x * px} y={y * px} width={px - .5} height={px - .5} />) }))
  // A+: a smaller plus to the upper right of the letter.
  const small = Math.max(2, Math.round(px * .6)), left = 5 * px + Math.round(px / 2)
  if (extra) plus.forEach((row, y) => [...row].forEach((c, x) => { if (c === '#') cells.push(<rect key={`p${x}-${y}`} x={left + x * small} y={y * small} width={small - .5} height={small - .5} />) }))
  const width = extra ? left + 3 * small : 5 * px
  return <svg className="o4-pixels" viewBox={`0 0 ${width} ${7 * px}`} width={width} height={7 * px} aria-hidden="true">{cells}</svg>
}
function PixelSpark({ values, bars, px = 3, height = 14 }: { values: number[]; bars: number; px?: number; height?: number }) {
  const low = Math.min(...values) - 3, high = Math.max(...values)
  return <svg className="o4-spark" viewBox={`0 0 ${bars * (px + 1)} ${height}`} width={bars * (px + 1)} height={height} aria-hidden="true">
    {values.slice(-bars).map((value, i) => { const h = Math.max(2, Math.round((value - low) / Math.max(1, high - low) * height / 2) * 2); return <rect key={i} x={i * (px + 1)} y={height - h} width={px} height={h} /> })}
  </svg>
}
function Blocks({ share: fraction, count }: { share: number; count: number }) {
  const filled = Math.round(fraction * count)
  return <span className="o4-blocks" aria-hidden="true">{Array.from({ length: count }, (_, i) => <i key={i} data-on={i < filled || undefined} />)}</span>
}
function Terminal({ report, size }: { report: ScoreReport; size: Size }) {
  const warmup = report.state === 'warmup'
  if (size === 'compact') return <>
    <Pixels grade={warmup ? null : report.grade} px={4} />
    <span className="o4-stack">
      <span className="o4-dim">sender-score</span>
      <span className="o4-line">{warmup ? <><Blocks share={report.emails / WARMUP_EMAILS} count={10} /><span>{report.emails}/{WARMUP_EMAILS}</span></> : <><b>{whole(report.score)}</b><PixelSpark values={report.history} bars={14} px={3} height={12} /></>}<span className="o4-cursor" /></span>
    </span>
  </>
  const step = warmup ? null : nextStep(report)
  return <>
    <div className="o4-title">sender-score</div>
    <div className="o4-body">
      <Pixels grade={warmup ? null : report.grade} px={8} />
      <dl className="o4-kv">
        {warmup ? <>
          <div><dt>status</dt><dd>warming up</dd></div>
          <div><dt>emails</dt><dd><Blocks share={report.emails / WARMUP_EMAILS} count={16} /> {report.emails}/{WARMUP_EMAILS}</dd></div>
          <div><dt>grade</dt><dd className="o4-dim">pending</dd></div>
        </> : <>
          <div><dt>score</dt><dd><b>{whole(report.score)}</b><span className="o4-dim">/100</span></dd></div>
          <div><dt>grade</dt><dd><b className="o4-grade">{report.grade}</b> <span className="o4-dim">· {toNext(report)}</span></dd></div>
          <div><dt>14d</dt><dd><PixelSpark values={report.history} bars={14} /> <span>{trend(report)}</span></dd></div>
        </>}
      </dl>
    </div>
    <div className="o4-prompt"><span className="o4-dim">›</span> {warmup ? `graded after ${WARMUP_EMAILS} emails` : `${step!.factor.label.toLowerCase()}: ${step!.text[0].toLowerCase()}${step!.text.slice(1)}`}<span className="o4-cursor" /></div>
  </>
}
