import type { CSSProperties } from 'react'
import { Link } from 'react-router'
import { ArrowUpRight } from 'lucide-react'
import { useApiDef, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import type { Domain, SenderScore, SenderScoreFactor } from '../../data/types'
import { number } from '../../lib/format'
import { useTween } from '../../components/motion'
import { Dial, Strip } from './gauge'
import './score.css'

// The sender score, from GET /v1/sender-score: a 56px sidebar card on every page, and the report card with its
// breakdown in Overview's detail column. Every block keeps one height in every state, so nothing shifts when it loads.
export function useSenderScore() { return useApiDef(queries.senderScore(), { interval: 60_000 }) }
const whole = (value: number) => Math.round(value)

export function SidebarScore() {
  const { data: report, isError } = useSenderScore()
  const shown = useTween(!report ? undefined : report.state === 'graded' ? report.score ?? 0 : report.emails.firstEmails)
  // A failed read keeps the card's frame and says so, instead of an empty box.
  if (!report && isError) return <Link to="/" className="gauge-card gauge-card--compact" aria-label="Sender score unavailable"><Texture /><span className="gauge-stack"><span className="gauge-eyebrow">Sender score</span><span className="gauge-readout"><b>—</b><small>&nbsp;unavailable</small></span></span></Link>
  if (!report) return <div className="gauge-card gauge-card--compact" aria-hidden="true"><span className="gauge-skeleton" /></div>
  const graded = report.state === 'graded'
  const label = graded ? `Sender score ${whole(report.score!)}, grade ${report.grade}` : `Sender score: ${report.emails.firstEmails} of ${report.needed} emails before the first grade`
  return <Link to="/#sender-score" className="gauge-card gauge-card--compact" aria-label={label}>
    <Texture />
    <Dial report={report} />
    <span className="gauge-stack">
      <span className="gauge-eyebrow">{graded ? 'Sender score' : 'Calibrating'}</span>
      <span className="gauge-readout"><b>{whole(shown)}</b>{graded ? <span className="gauge-grade">{report.grade}</span> : <small>/{report.needed}</small>}</span>
    </span>
  </Link>
}
// Faint film grain and a tick ruler: texture, never content.
function Texture({ ruler = true }: { ruler?: boolean }) { return <><span className="gauge-grain" aria-hidden="true" />{ruler && <span className="gauge-ruler" aria-hidden="true" />}</> }

// Overview's score: one line with the number, the grade and the band strip, then where it goes next. 96px tall.
function ScoreCard({ report }: { report: SenderScore }) {
  const graded = report.state === 'graded'
  const shown = useTween(graded ? report.score ?? 0 : report.emails.firstEmails)
  const moved = graded && report.history.length ? whole(report.score! - report.history[0].score) : 0
  return <article className="gauge-card score-card" aria-label={graded ? `Sender score ${whole(report.score!)}, grade ${report.grade}` : `Calibrating: ${report.emails.firstEmails} of ${report.needed} emails`}>
    <Texture ruler={false} />
    <div className="gauge-head"><span>Sender score</span><span>{graded ? '30 days' : 'Calibrating'}</span></div>
    <div className="score-card__main">
      <span className="score-card__value"><b>{whole(shown)}</b>{graded ? <span className="gauge-grade">{report.grade}</span> : <small>/{report.needed}</small>}</span>
      <Strip report={report} />
    </div>
    <div className="score-card__foot">{graded
      ? <><span>{report.next ? `${Math.ceil(report.next.at - report.score!)} to ${report.next.grade}` : 'Top grade'}</span><span>{moved > 0 ? '+' : moved < 0 ? '−' : '±'}{Math.abs(moved)} in 14 days</span></>
      : <><span>Graded after {report.needed} emails</span><span /></>}</div>
  </article>
}

const percent = (digits: number) => (value: number) => `${(value * 100).toFixed(digits)}%`
const formats: Record<SenderScoreFactor['key'], (value: number) => string> = { complaints: percent(2), bounces: percent(1), content: percent(1), auth: value => `${Math.round(value * 100)}%`, hygiene: percent(1), consistency: value => `${value.toFixed(1)}×` }
const share = (value: number) => ({ '--share': `${Math.round(Math.min(1, Math.max(0, value)) * 1000) / 10}%` }) as CSSProperties

// Overview's detail column: the score card, then the 14-day trend and the six factors as compact rows. Fixed heights in every state.
export function ReportCard({ report }: { report: SenderScore | undefined }) {
  if (!report) return <section id="sender-score" className="score-report" aria-busy="true"><div className="gauge-card score-card"><span className="gauge-skeleton" /></div><div className="score-breakdown score-breakdown--loading" /></section>
  const graded = report.state === 'graded'
  const low = graded ? Math.min(...report.history.map(day => day.score)) - 4 : 0, high = graded ? Math.max(...report.history.map(day => day.score)) : 1
  return <section id="sender-score" className="score-report" aria-label="Sender score">
    <ScoreCard report={report} />
    <div className="score-breakdown">
      <div className="score-breakdown__head"><h2>Breakdown</h2><span className="muted">{graded ? '14 days' : 'After 100 emails'}</span></div>
      <div className="score-history" role="img" aria-label={graded ? `Daily score over 14 days, from ${whole(report.history[0].score)} to ${whole(report.score!)}.` : 'No history yet.'}>
        {Array.from({ length: 14 }, (_, i) => { const day = graded ? report.history[i] : undefined; return <span key={i} data-last={i === 13 || undefined} style={{ transform: `scaleY(${day ? Math.max(.1, (day.score - low) / Math.max(1, high - low)) : .1})` }} /> })}
      </div>
      <ul className="score-factors">{report.factors.map(factor => <li key={factor.key} title={factor.basis}>
        <span>{factor.label}</span>
        {graded && factor.source === 'measured' ? <><span className="score-bar" data-low={factor.score! < 60 || undefined}><i style={share(factor.score! / 100)} /></span><span className="muted">{formats[factor.key](factor.value!)}</span></>
          : <><span className="score-bar" data-empty /><span className="muted">{graded ? 'Neutral' : '—'}</span></>}
      </li>)}</ul>
    </div>
  </section>
}

// The step worth most points, as a place to go: a measured factor's lost points in the re-weighted raw score.
function bestStep(report: SenderScore | undefined, domains: Domain[]) {
  if (report?.state !== 'graded') return null
  const measured = report.factors.filter(f => f.source === 'measured'), weight = measured.reduce((sum, f) => sum + f.weight, 0)
  const worst = [...measured].sort((a, b) => (b.weight - b.points!) - (a.weight - a.points!))[0]
  if (!worst || !weight) return null
  const gain = (worst.weight - worst.points!) / weight * 100
  if (gain < 1) return null
  const weak = domains.find(d => d.status === 'verified' && !(d.dmarc && ['quarantine', 'reject'].includes(d.dmarc.status))) ?? domains[0]
  const target = worst.key === 'auth' && weak ? { text: `Add DMARC to ${weak.name}`, to: `/domains/${weak.id}` }
    : worst.key === 'auth' ? { text: 'Authenticate your domains', to: '/domains' }
    : worst.key === 'content' ? { text: 'Review rejected messages', to: '/logs' }
    : worst.key === 'hygiene' ? { text: 'Clean suppressed addresses from lists', to: '/audience' }
    : { text: `Review ${worst.label.toLowerCase()} in Logs`, to: '/logs' }
  return { key: 'score', ...target, meta: `+${whole(gain)} pts` }
}
export type NextItem = { key: string; text: string; meta?: string; to: string }
// Domains, webhooks and invitations come from Overview's one setup read, shared with the setup steps.
export function useNextSteps(report: SenderScore | undefined): { items: NextItem[]; ready: boolean } {
  const { canAdminister } = useWorkspaceAccess()
  const setup = useApiDef(queries.overviewSetup(), { enabled: canAdminister })
  if (!canAdminister) return { items: [], ready: true }
  const ready = !setup.isPending
  const list = setup.data?.domains ?? [], items: NextItem[] = []
  const step = bestStep(report, list); if (step) items.push(step)
  const candidate = list.find(d => d.status === 'verified')
  if (candidate && !list.some(d => d.receiving === 'verified')) items.push({ key: 'receive', text: `Receive replies on ${candidate.name}`, to: `/domains/${candidate.id}` })
  if (setup.data?.webhooks?.total === 0) items.push({ key: 'webhook', text: 'Get bounce events by webhook', to: '/settings/webhooks/new' })
  const pending = setup.data?.invitations?.pending ?? 0
  if (pending) items.push({ key: 'invite', text: `${number(pending)} ${pending === 1 ? 'invitation' : 'invitations'} pending`, to: '/settings#members' })
  return { items: items.slice(0, 3), ready }
}
export function NextSteps({ items }: { items: NextItem[] }) {
  if (!items.length) return null
  return <nav className="next-steps" aria-label="Next"><h2 className="next-steps__title">Next</h2><ul>{items.map((item, i) => <li key={item.key} style={{ '--i': i } as CSSProperties}><Link to={item.to}><span>{item.text}</span>{item.meta && <span className="muted">{item.meta}</span>}<ArrowUpRight size={14} aria-hidden="true" /></Link></li>)}</ul></nav>
}
