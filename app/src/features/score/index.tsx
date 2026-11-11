import type { CSSProperties, ReactNode } from 'react'
import { Link } from 'react-router'
import { ArrowUpRight } from 'lucide-react'
import { GradeBadge } from '../../components/GradeBadge'
import { useApiDef } from '../../data/context'
import { queries } from '../../data/queries'
import type { Domain } from '../../data/types'
import { number } from '../../lib/format'
import { gradeBands, gradeFor, gradeKey, nextStep, WARMUP_EMAILS, type ScoreReport } from '../../lib/sender-score'
import { useSenderScore } from './use-score'
import './score.css'

type Graded = Extract<ScoreReport, { state: 'graded' }>
const ladder = [...gradeBands].reverse()
const within = (report: Graded) => Math.min(1, Math.max(0, (report.score - report.band.min) / Math.max(1, report.band.max - report.band.min)))
const whole = (value: number) => Math.round(value)
const width = (share: number) => ({ '--share': `${Math.round(share * 1000) / 10}%` }) as CSSProperties

// Compact card for the bottom of the sidebar, full width and two units tall. Three takes:
//  a: tile — badge, score and a meter towards the next grade
//  b: ladder — the six grades as segments, filled up to yours
//  c: report — badge, score and one mark per factor, like subjects on a report card
export function SidebarScore({ variant }: { variant: 'a' | 'b' | 'c' }) {
  const { report } = useSenderScore()
  if (!report) return <div className={`score-side score-side--${variant}`} aria-hidden="true" />
  const warmup = report.state === 'warmup'
  const label = warmup ? `Sender score: ${report.emails} of ${WARMUP_EMAILS} emails before your first grade` : `Sender score ${whole(report.score)}, grade ${report.grade}`
  if (variant === 'b') return <Link to="/#sender-score" className="score-side score-side--b" aria-label={label}>
    <span className="score-side__row"><span className="muted">Sender score</span>{warmup ? <span className="score-side__value">{report.emails}<span className="muted">/{WARMUP_EMAILS}</span></span> : <span className="score-side__value"><b className="score-side__letter">{report.grade}</b> {whole(report.score)}</span>}</span>
    <span className="score-ladder" aria-hidden="true">{ladder.map((band, index) => {
      const reached = !warmup && report.score >= band.min, next = !warmup && report.next?.grade === band.grade
      const fill = warmup ? Math.min(1, Math.max(0, report.emails / WARMUP_EMAILS * ladder.length - index)) : reached ? 1 : next ? within(report) : 0
      return <span key={band.grade} className="score-ladder__step" data-grade={warmup ? 'none' : gradeKey(report.grade)} data-filled={fill >= 1 || undefined} data-next={next || undefined} data-current={!warmup && report.grade === band.grade || undefined} style={width(fill)}><i />{band.grade}</span>
    })}</span>
  </Link>
  if (variant === 'c') return <Link to="/#sender-score" className="score-side score-side--c" aria-label={label}>
    <GradeBadge grade={warmup ? null : report.grade} size="md" label={label} progress={warmup ? report.emails / WARMUP_EMAILS : 0} />
    <span className="score-side__stack">
      <span className="score-side__row"><span className="score-side__value">{warmup ? <>{report.emails}<span className="muted">/{WARMUP_EMAILS}</span></> : whole(report.score)}</span><span className="muted">{warmup ? 'First emails' : 'Sender score'}</span></span>
      <span className="score-marks" aria-hidden="true">{warmup ? ladder.map((band, index) => <span key={band.grade} className="score-mark" data-grade="none" data-filled={report.emails / WARMUP_EMAILS * ladder.length >= index + 1 || undefined} />) : report.factors.map(factor => { const grade = gradeFor(factor.score); return <span key={factor.key} className="score-mark" data-grade={gradeKey(grade)} title={`${factor.label}: ${grade}`}>{grade[0]}</span> })}</span>
    </span>
  </Link>
  return <Link to="/#sender-score" className="score-side score-side--a" aria-label={label}>
    <GradeBadge grade={warmup ? null : report.grade} size="md" label={label} progress={warmup ? report.emails / WARMUP_EMAILS : 0} />
    <span className="score-side__stack">
      <span className="score-side__row"><span className="muted">{warmup ? 'First 100 emails' : 'Sender score'}</span><span className="score-side__value">{warmup ? <>{report.emails}<span className="muted">/{WARMUP_EMAILS}</span></> : whole(report.score)}</span></span>
      <span className="score-meter" data-grade={warmup ? 'none' : gradeKey(report.grade)} style={width(warmup ? report.emails / WARMUP_EMAILS : within(report))}><i /></span>
    </span>
  </Link>
}

// The last 14 daily scores; the score climbs at most 2 points a day, so this is the incremental progress.
function History({ report, caption = true }: { report: Graded; caption?: boolean }) {
  const low = Math.min(...report.history) - 4, high = Math.max(...report.history)
  const moved = whole(report.score - report.history[0])
  return <div className="score-trend">
    <div className="score-history" role="img" aria-label={`Score over 14 days: from ${whole(report.history[0])} to ${whole(report.score)}.`}>
      {report.history.map((value, index) => <span key={index} data-last={index === report.history.length - 1 || undefined} style={{ height: `${Math.max(8, (value - low) / Math.max(1, high - low) * 100)}%` }} />)}
    </div>
    {caption && <span className="score-trend__caption"><span>14 days</span><span>{moved > 0 ? `+${moved}` : moved}</span></span>}
  </div>
}
function BandMeter({ report }: { report: Graded }) {
  return <div className="score-band">
    <span className="score-meter" data-grade={gradeKey(report.grade)} style={width(within(report))}><i /></span>
    <span className="score-band__ends"><span>{report.band.min}</span><span>{report.next ? `${report.next.grade} at ${report.next.at}` : '100'}</span></span>
  </div>
}
function FactorBar({ score }: { score: number }) {
  return <span className="score-bar" data-low={score < 60 || undefined} style={width(score / 100)}><i /></span>
}
const nextLine = (report: Graded) => report.next ? `${report.grade} · ${Math.ceil(report.next.gap)} to ${report.next.grade}` : `${report.grade} · top grade`

function Warmup({ report }: { report: Extract<ScoreReport, { state: 'warmup' }> }) {
  return <div className="score-warmup">
    <span className="score-meter" data-grade="none" style={width(report.emails / report.needed)}><i /></span>
    <p className="muted">Graded after your first {report.needed} emails.</p>
  </div>
}

// The full report card on Overview, in three layouts.
export function ReportCard({ variant }: { variant: 'column' | 'band' | 'hero' }) {
  const { report, domains } = useSenderScore()
  if (!report) return <section id="sender-score" className={`score-report score-report--${variant}`} aria-busy="true" />
  const heading = <h2 className="score-report__title">Sender score</h2>
  if (report.state === 'warmup') return <section id="sender-score" className={`score-report score-report--${variant} score-report--warmup`} aria-label="Sender score">
    <div className="score-report__side">
      <div className="score-report__lead"><GradeBadge grade={null} size={variant === 'hero' ? 'xl' : 'lg'} progress={report.emails / report.needed} /><div className="score-report__numbers">{heading}<span className="score-number">{report.emails}<span className="score-number__of">/{report.needed}</span></span></div></div>
      <Warmup report={report} />
    </div>
    {variant !== 'column' && <ul className="score-factors score-factors--pending">{['Complaints', 'Bounces', 'Content', 'Authentication', 'List hygiene', 'Consistency'].map(label => <li key={label}><span>{label}</span><span className="muted">—</span></li>)}</ul>}
  </section>
  const step = nextStep(report)
  const target = stepTarget(step.factor.key, domains)
  const summary = <div className="score-report__lead">
    <GradeBadge grade={report.grade} size={variant === 'hero' ? 'xl' : 'lg'} />
    <div className="score-report__numbers">{heading}<span className="score-number">{whole(report.score)}</span><span className="muted">{nextLine(report)}</span></div>
  </div>
  if (variant === 'band') return <section id="sender-score" className="score-report score-report--band" aria-label="Sender score">
    {summary}
    <div className="score-report__progress"><BandMeter report={report} /><History report={report} /></div>
    <ul className="score-factors score-factors--grid">{report.factors.map(factor => <li key={factor.key} title={factor.source}><span className="muted">{factor.label}</span><span>{factor.format(factor.value)}</span><FactorBar score={factor.score} /></li>)}</ul>
  </section>
  if (variant === 'hero') return <section id="sender-score" className="score-report score-report--hero" aria-label="Sender score">
    <div className="score-report__side">
      {summary}
      <BandMeter report={report} />
      <Link className="score-next" to={target.to}><span>{target.text}</span><span className="muted">+{whole(step.points)} pts</span><ArrowUpRight size={14} /></Link>
    </div>
    <table className="score-table"><tbody>{report.factors.map(factor => <tr key={factor.key} title={factor.source}><th scope="row">{factor.label}</th><td><FactorBar score={factor.score} /></td><td>{factor.format(factor.value)}</td><td className="muted">{factor.lost >= .5 ? `−${whole(factor.lost)}` : ''}</td></tr>)}</tbody></table>
    <div className="score-report__trend"><History report={report} /></div>
  </section>
  return <section id="sender-score" className="score-report score-report--column" aria-label="Sender score">
    {summary}
    <BandMeter report={report} />
    <History report={report} />
    <ul className="score-factors">{report.factors.map(factor => <li key={factor.key} title={factor.source}><span>{factor.label}</span><FactorBar score={factor.score} /><span className="muted">{factor.format(factor.value)}</span></li>)}</ul>
  </section>
}

// What raises the score most, as a place to go.
function stepTarget(key: string, domains: Domain[]) {
  const weak = domains.find(domain => domain.status === 'verified' && !(domain.dmarc && ['quarantine', 'reject'].includes(domain.dmarc.status))) ?? domains[0]
  if (key === 'auth' && weak) return { text: `Add DMARC to ${weak.name}`, to: `/domains/${weak.id}` }
  if (key === 'bounces' || key === 'complaints') return { text: 'Review bounces in Logs', to: '/logs' }
  if (key === 'content') return { text: 'Review flagged messages', to: '/logs' }
  return { text: 'See what counts', to: '/docs' }
}

export type NextItem = { key: string; text: ReactNode; meta?: ReactNode; to: string }
// Up to three places to go next, from state the dashboard already has.
export function useNextSteps(): NextItem[] {
  const { report, domains } = useSenderScore()
  const invitations = useApiDef(queries.workspaceInvitations())
  const webhooks = useApiDef(queries.webhooks())
  const items: NextItem[] = []
  if (report?.state === 'graded') {
    const step = nextStep(report)
    if (step.points >= 1) { const target = stepTarget(step.factor.key, domains); items.push({ key: 'score', text: target.text, meta: `+${whole(step.points)} pts`, to: target.to }) }
  }
  const receiving = domains.find(domain => domain.receiving === 'verified')
  const candidate = domains.find(domain => domain.status === 'verified')
  if (!receiving && candidate) items.push({ key: 'receive', text: `Receive replies on ${candidate.name}`, to: `/domains/${candidate.id}` })
  if (webhooks.data && webhooks.data.length === 0) items.push({ key: 'webhook', text: 'Get bounce events by webhook', to: '/settings/webhooks/new' })
  const pending = invitations.data?.length ?? 0
  if (pending) items.push({ key: 'invite', text: `${number(pending)} ${pending === 1 ? 'invitation' : 'invitations'} pending`, to: '/settings#members' })
  return items.slice(0, 3)
}
export function NextSteps({ items, title = 'Next' }: { items: NextItem[]; title?: string }) {
  if (!items.length) return null
  return <nav className="next-steps" aria-label={title}><h2 className="next-steps__title">{title}</h2><ul>{items.map(item => <li key={item.key}><Link to={item.to}><span>{item.text}</span>{item.meta && <span className="muted">{item.meta}</span>}<ArrowUpRight size={14} aria-hidden="true" /></Link></li>)}</ul></nav>
}
