import { useState, type CSSProperties } from 'react'
import { Link } from 'react-router'
import { ArrowUpRight } from 'lucide-react'
import { useApiDef, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import type { Domain, SenderLimit, SenderScore, SenderScoreFactor } from '../../data/types'
import { number, shortDateTime } from '../../lib/format'
import { standingTitle, standingTone, stepAtLeast, type RaisedStep } from '../../lib/standing'
import { useTween } from '../../components/motion'
import { Dialog } from '../../components/ui'
import { Dial, Strip } from './gauge'
import { SendingLimitsGuide } from './limits'
import './score.css'
export { StandingCard } from './standing'
import { ScoreAbout } from './about'

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
  // A dot from Warn up; the Overview card says what happened.
  const raised = stepAtLeast(report.standing?.step, 'warn') ? report.standing!.step as RaisedStep : null
  const label = (graded ? `Sender score ${whole(report.score!)}, grade ${report.grade}` : `Sender score: ${report.emails.firstEmails} of ${report.needed} emails before the first grade`) + (raised ? `. ${standingTitle[raised]}` : '')
  return <Link to={raised ? '/#standing' : '/#sender-score'} className="gauge-card gauge-card--compact" aria-label={label}>
    <Texture />
    {raised && <span className={`gauge-alert ui-tone--${standingTone(raised)}`} aria-hidden="true" />}
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
// Engagement is the marketing unsubscribe rate.
export const factorFormats: Record<SenderScoreFactor['key'], (value: number) => string> = { complaints: percent(2), content: percent(1), bounces: percent(1), hygiene: percent(1), auth: value => `${Math.round(value * 100)}%`, engagement: percent(2) }
const formats = factorFormats
const share = (value: number) => ({ '--share': `${Math.round(Math.min(1, Math.max(0, value)) * 1000) / 10}%` }) as CSSProperties

// Overview's detail column: the score card, the limit it sets (Hosted), then the 14-day trend and the six factors as
// compact rows. Fixed heights in every state.
export function ReportCard({ report }: { report: SenderScore | undefined }) {
  const [explaining, setExplaining] = useState(false)
  if (!report) return <section id="sender-score" className="score-report" aria-busy="true"><div className="gauge-card score-card"><span className="gauge-skeleton" /></div><div className="score-breakdown score-breakdown--loading" /></section>
  const graded = report.state === 'graded'
  // The newest days sit at the right; a score graded today may have no published day yet.
  const days = graded ? report.history.slice(-14) : [], offset = 14 - days.length
  const low = days.length ? Math.min(...days.map(day => day.score)) - 4 : 0, high = days.length ? Math.max(...days.map(day => day.score)) : 1
  return <section id="sender-score" className="score-report" aria-label="Sender score">
    <ScoreCard report={report} />
    {report.limit && <ScoreLimit report={report} limit={report.limit} />}
    <div className="score-breakdown">
      <div className="score-breakdown__head"><h2>Breakdown</h2><span className="score-breakdown__aside"><span className="muted">{graded ? '14 days' : 'After 100 emails'}</span>{report.limit && <button type="button" className="score-explain" onClick={() => setExplaining(true)}>How limits work</button>}</span></div>
      <div className="score-history" role="img" aria-label={days.length ? `Daily score over ${days.length} days, from ${whole(days[0].score)} to ${whole(report.score!)}.` : 'No history yet.'}>
        {Array.from({ length: 14 }, (_, i) => { const day = days[i - offset]; return <span key={i} data-last={i === 13 || undefined} style={{ transform: `scaleY(${day ? Math.max(.1, (day.score - low) / Math.max(1, high - low)) : .1})` }} /> })}
      </div>
      <ul className="score-factors">{report.factors.map(factor => <li key={factor.key} title={factor.basis}>
        <span>{factor.label}</span>
        {graded && factor.source === 'measured' ? <><span className="score-bar" data-low={factor.score! < 60 || undefined}><i style={share(factor.score! / 100)} /></span><span className="muted">{formats[factor.key](factor.value!)}</span></>
          : <><span className="score-bar" data-empty /><span className="muted">{graded ? 'Neutral' : '—'}</span></>}
      </li>)}</ul>
    </div>
    {report.limit && <Dialog open={explaining} onOpenChange={setExplaining} title="How sending limits work" className="limits-dialog">
      <SendingLimitsGuide />
      <Link className="limits-dialog__docs" to="/docs#sending-limits">Open in the docs</Link>
    </Dialog>}
  </section>
}

// Hosted: the limit the score sets, any adjustment, the factor that would help most and the standing, four fixed
// lines in every state (calibrating, graded, override, notice, warn and above).
function ScoreLimit({ report, limit }: { report: SenderScore; limit: SenderLimit }) {
  const graded = report.state === 'graded' && report.score !== null
  const daily = limit.daily === null ? 'No daily limit' : `Limit ${number(limit.daily)}/day${limit.source === 'override' ? ' (override)' : ''}`
  const headline = !graded ? `Calibrating ${report.emails.firstEmails}/${report.needed} · ${daily.toLowerCase()}`
    : [daily, `score ${whole(report.score!)} (${report.grade})`, limit.next ? `next ${number(limit.next.limit)} at ${limit.next.atScore}` : limit.source === 'score' ? 'top band' : null].filter(Boolean).join(' · ')
  const adjustments = [
    limit.override && (limit.override.expiresAt ? `Override until ${shortDateTime(limit.override.expiresAt)} UTC` : 'Override with no expiry'),
    limit.restore && `${limit.restore.daily.toLocaleString('en-US')} a day after a resume, until ${shortDateTime(limit.restore.until)} UTC`,
    limit.strikeCapUntil && `Strike cap at 50% until ${shortDateTime(limit.strikeCapUntil)} UTC`,
  ].filter(Boolean).join(' · ')
  const bursts = `${number(limit.perMinute)} a minute · ${number(limit.transactionalReserve)} kept for receipts`
  const weakest = graded ? report.factors.filter(f => f.source === 'measured' && f.score !== null && f.value !== null).sort((a, b) => a.score! - b.score!)[0] : undefined
  const helps = !graded ? 'Factors count from the first grade' : !weakest ? 'No factor measured yet' : weakest.score! >= 100 ? 'Every measured factor is at full marks' : `Helps most: ${weakest.label} (${formats[weakest.key](weakest.value!)})`
  const standing = report.standing, step = standing?.step ?? 'ok'
  const raised = stepAtLeast(step, 'warn') ? step as RaisedStep : null
  const note = raised ? `${standingTitle[raised]} · see above` : step === 'notice' ? `Note: ${standing!.reasons[0]?.message ?? 'Bane noticed a first problem.'}` : standing?.marketingRelease ? `Marketing at ${standing.marketingRelease.percent}% until ${shortDateTime(standing.marketingRelease.until)} UTC` : 'No sending issues'
  return <div className="score-limit" aria-label="Daily limit">
    <p className="score-limit__headline" title={headline}>{headline}</p>
    <p title={adjustments || bursts}>{adjustments || bursts}</p>
    <p title={helps}>{helps}</p>
    <p className="score-limit__note" data-tone={raised ? standingTone(raised) : step === 'notice' ? 'warning' : 'ok'} title={note}><span aria-hidden="true" /><span>{note}</span></p>
  </div>
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
/** The explainer, mounted once by the shell: the same cached score as every other view of it. */
export function ScoreAboutHost() {
  const score = useSenderScore()
  return <ScoreAbout report={score.data} error={score.error} onRetry={() => void score.refetch()} />
}
