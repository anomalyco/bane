import { number } from '../../lib/format'
import './limits.css'

// How sending limits work: the published score → limit table, the warning ladder and the campaign list probe. The
// public docs (/docs#sending-limits) and Overview's score explainer render this one copy. Detection internals stay out.
const perMinute = (limit: number) => Math.min(500, Math.max(50, Math.floor(limit / 20)))
const bands: [score: string, grade: string, limit: number | string][] = [
  ['Calibrating, first 100 sent', '–', 100], ['Under 65', 'D, F', 100], ['65–69', 'D', 200], ['70–74', 'C', 500], ['75–79', 'C', 1_000],
  ['80–84', 'B', 2_000], ['85–89', 'B', 5_000], ['90 and up', 'A, A+', 10_000], ['On request', '–', '25,000 · 50,000 · 100,000'],
]
const ladder: { step: string; mark: string; tone: string; when: string[]; does: string; recovery: string }[] = [
  { step: 'Notice', mark: '·', tone: 'neutral', when: ['A first spam complaint or a few bounces'], does: 'A note on the dashboard. Nothing else changes.', recovery: 'Clears once nothing triggers it.' },
  { step: 'Warn', mark: '1', tone: 'warning', when: ['Complaints ≥ 0.05% and ≥ 2 in 24 hours, or ≥ 3 in 7 days', 'Hard bounces ≥ 2% and ≥ 10 in 24 hours, or ≥ 1.5% and ≥ 10 in 7 days', 'Spam-screen rejections ≥ 2% and ≥ 3 in 24 hours'],
    does: 'The daily limit stops rising and owners and admins are emailed. All mail still sends.', recovery: 'Clears by itself after 24 hours under 80% of the line.' },
  { step: 'Restrict', mark: '2', tone: 'warning', when: ['Complaints ≥ 0.1% and ≥ 3 in 24 hours', 'Marketing hard bounces ≥ 4% and ≥ 25', 'Hard bounces on any mail ≥ 8% and ≥ 50', 'Spam-screen rejections ≥ 5% and ≥ 10'],
    does: 'Marketing is held; transactional mail such as receipts and resets keeps sending.', recovery: 'After 24 hours an owner or admin can release it from Overview, once every 14 days: marketing resumes at 50% for 48 hours.' },
  { step: 'Pause', mark: '3', tone: 'danger', when: ['Complaints ≥ 0.3% and ≥ 5 in 24 hours, or ≥ 0.15% and ≥ 10 in 7 days', 'Transactional hard bounces ≥ 5% and ≥ 50', 'Spam-screen rejections ≥ 10% and ≥ 25', 'AWS paused the sending tenant', 'Confirmed abuse'],
    does: 'All sending stops. Receiving, inboxes and the dashboard keep working. Queued mail is held for 72 hours, then canceled.', recovery: 'A pause caused only by transactional bounces can be resumed by an owner once every 30 days, at 50% for 48 hours. Anything else needs a review.' },
]

export function SendingLimitsGuide({ headings = 'h3' }: { headings?: 'h2' | 'h3' }) {
  const H = headings
  return <div className="limits-guide">
    <section aria-label="Score and daily limit">
      <H>Score and daily limit</H>
      <p>A Hosted workspace sends up to a daily limit, counted in recipients over a rolling 24 hours. The sender score sets it.</p>
      <div className="limits-table-scroll"><table className="limits-table">
        <thead><tr><th scope="col">Score</th><th scope="col">Grade</th><th scope="col">Daily limit</th><th scope="col">Per minute</th></tr></thead>
        <tbody>{bands.map(([score, grade, limit]) => <tr key={score}><td>{score}</td><td>{grade}</td><td>{typeof limit === 'number' ? number(limit) : limit}</td><td>{typeof limit === 'number' ? number(perMinute(limit)) : number(500)}</td></tr>)}</tbody>
      </table></div>
      <ul className="limits-notes">
        <li>Per minute: the daily limit ÷ 20, at least 50 and at most 500.</li>
        <li>Marketing may use the limit minus a reserve of 100 or 10%, whichever is more, so receipts and resets always go out.</li>
        <li>The score rises at most 5 points and falls at most 10 points a day. A limit drops a band only once the score is 2 points under the band’s floor.</li>
        <li>Grades: A+ from 95, A from 90, B from 80, C from 70, D from 60, F below 60.</li>
      </ul>
    </section>
    <section aria-label="Warnings and holds">
      <H>Warnings and holds</H>
      <p>Bane checks every 10 minutes. Each line needs the rate and the count together, so a few events never trip a small sender. Crossing any one line is enough.</p>
      <ol className="limits-ladder">{ladder.map(step => <li key={step.step} className={`ui-tone--${step.tone}`}>
        <div className="limits-ladder__head"><span className="limits-ladder__mark" aria-hidden="true">{step.mark}</span><strong>{step.step}</strong></div>
        <ul>{step.when.map(line => <li key={line}>{line}</li>)}</ul>
        <p>{step.does}</p>
        <p className="muted">{step.recovery}</p>
      </li>)}</ol>
    </section>
    <section aria-label="Campaign list probe">
      <H>Campaign list probe</H>
      <p>A campaign to more than 100 recipients sends to a probe first: 10% of its recipients, at least 100 and at most 500. More than 3% hard bounces or 2 complaints in the probe quarantine the campaign: it pauses and the bounced addresses are suppressed. Clean the list, then resume it; a second quarantine needs a review.</p>
    </section>
  </div>
}
