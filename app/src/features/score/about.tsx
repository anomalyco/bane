import { useEffect, useRef, type CSSProperties } from 'react'
import { Link } from 'react-router'
import { Button, Dialog, ErrorState, SkeletonText } from '../../components/ui'
import type { SenderScore, SenderScoreFactor } from '../../data/types'
import { closeScoreAbout, useScoreAbout } from '../../lib/score-about'
import { number } from '../../lib/format'
import { gradeKey } from './gauge'

const percent = (digits: number) => (value: number) => `${(value * 100).toFixed(digits)}%`
// Engagement is the marketing unsubscribe rate.
export const factorFormats: Record<SenderScoreFactor['key'], (value: number) => string> = { complaints: percent(2), content: percent(1), bounces: percent(1), hygiene: percent(1), auth: value => `${Math.round(value * 100)}%`, engagement: percent(2) }
// One plain line per part, where the score shows it; the API's `basis` gives the exact rule underneath.
export const factorPlain: Record<SenderScoreFactor['key'], string> = {
  complaints: 'How often recipients mark your mail as spam.',
  bounces: 'How often mail can’t be delivered, such as to addresses that don’t exist.',
  content: 'How often Bane’s content check stops a message as spam.',
  auth: 'Whether your domains sign mail (DKIM), align the sender (SPF) and publish DMARC.',
  hygiene: 'How often new contacts bounce, and how often you send to addresses already on the suppression list.',
  engagement: 'How often marketing recipients unsubscribe; tracked clicks help.',
}
const grades = 'A+ from 95, A from 90, B from 80, C from 70, D from 60, F below 60.'

// What the sender score is, what counts, how it is graded and where each part stands: one dialog for the whole app,
// opened from every place the score appears (lib/score-about.ts).
export function ScoreAbout({ report, error, onRetry }: { report: SenderScore | undefined; error: unknown; onRetry: () => void }) {
  const { open, focus } = useScoreAbout()
  const list = useRef<HTMLUListElement>(null)
  // Opened from a breakdown row: that part is in view and marked.
  useEffect(() => { if (open && focus) requestAnimationFrame(() => list.current?.querySelector(`[data-key="${focus}"]`)?.scrollIntoView({ block: 'nearest' })) }, [open, focus])
  const graded = report?.state === 'graded'
  return <Dialog open={open} onOpenChange={next => { if (!next) closeScoreAbout() }} className="score-about" title="Sender score"
    description="A 0–100 grade for how healthy your sending looks, weighted towards your most recent email. Mailbox providers watch the same signals, so a high score helps your mail reach the inbox. On Hosted it also sets your daily limit."
    footer={<><Link className="ui-button ui-button--ghost ui-button--md" to="/docs/api/getSenderScore" onClick={closeScoreAbout}>API reference</Link><Button variant="primary" onClick={closeScoreAbout}>Done</Button></>}>
    {!report ? error ? <ErrorState error={error} onRetry={onRetry} /> : <div className="score-about__status"><SkeletonText width="60%" /></div> : <>
      <div className="score-about__status" data-grade={graded && report.grade ? gradeKey(report.grade) : undefined}>
        <b>{graded ? Math.round(report.score!) : '—'}</b>
        <div className="score-about__status-text">
          <span>{graded ? <>Grade <strong className="score-about__grade">{report.grade}</strong> · {report.next ? `${Math.ceil(report.next.at - report.score!)} points to ${report.next.grade}` : 'Top grade'}</> : 'Not graded yet'}</span>
          <span className="muted">{graded ? `From ${number(report.emails.last30Days)} real emails in the last 30 days.` : `${number(report.emails.firstEmails)} of ${number(report.needed)} real emails. Your first grade comes after ${number(report.needed)}${report.limit ? ', plus a day' : ''}.`}</span>
        </div>
        {!graded && <span className="score-about__progress" role="meter" aria-label="Real emails before the first grade" aria-valuemin={0} aria-valuemax={report.needed} aria-valuenow={report.emails.firstEmails} style={{ '--share': `${Math.min(100, report.emails.firstEmails / Math.max(1, report.needed) * 100)}%` } as CSSProperties}><i /></span>}
      </div>
      <section className="score-about__section" aria-labelledby="score-about-counts">
        <h3 id="score-about-counts">What counts</h3>
        <p>Every email you send, except simulated sends and emails only to the SES mailbox simulator (<code>…@simulator.amazonses.com</code>). Simulator sends still use your daily limit, but they never change your score.</p>
      </section>
      <section className="score-about__section" aria-labelledby="score-about-graded">
        <h3 id="score-about-graded">How it’s graded</h3>
        <p>Each part below scores 0–100 between a healthy and a risky rate; a part with no data yet is left out and the rest count for more. Recent days count most (a 30-day half-life). The score starts at 65, or lower if your mail already scores lower, and moves towards your result by at most 5 points up or 10 down a day, so a bad day shows quickly and recovery is gradual. With little mail it stays close to 60.</p>
        <p className="muted">{grades}</p>
      </section>
      <ul ref={list} className="score-about__factors" aria-label="The six parts">{report.factors.map(factor => <li key={factor.key} data-key={factor.key} data-focus={focus === factor.key || undefined}>
        <div className="score-about__factor-name"><span>{factor.label}</span><span className="muted">{factor.weight}%</span></div>
        <span className="score-about__factor-now">{graded && factor.source === 'measured' ? <>{factorFormats[factor.key](factor.value!)}<span className="muted"> · {Math.round(factor.score!)}/100</span></> : <span className="muted">{graded ? 'No data, left out' : '—'}</span>}</span>
        <p>{factorPlain[factor.key]}</p>
        <p className="muted">{factor.basis}</p>
      </li>)}</ul>
    </>}
  </Dialog>
}
