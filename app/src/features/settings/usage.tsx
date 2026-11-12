import type { CSSProperties, ReactNode } from 'react'
import { Check } from 'lucide-react'
import { ErrorState, SectionHeader, Skeleton } from '../../components/ui'
import { useApiDef, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import { monthEstimate, type Usage } from '../../data/usage'
import { date, number } from '../../lib/format'
import './usage.css'

const money = (value: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2 }).format(value)

// Plan & usage (hosted): the published price and free allowance, this month's counts, and the daily sending limit with
// the steps it grows through. Information only: billing isn't on, and the page says so first. Every member can read it;
// members see sent mail only (received mail includes messages they can't open), and the note says so before data arrives.
export function PlanUsage({ row: Row }: { row: (props: { title: ReactNode; hint?: ReactNode; children: ReactNode }) => ReactNode }) {
  const query = useApiDef(queries.usage(), { interval: 60_000 })
  const { canAdminister } = useWorkspaceAccess()
  const usage = query.data
  if (query.isError && !usage) return <><SectionHeader title="Plan & usage" /><ErrorState error={query.error} onRetry={() => void query.refetch()} /></>
  const value = (render: (usage: Usage) => ReactNode, width = 120) => usage ? render(usage) : <Skeleton width={width} height={20} />
  const estimate = usage ? monthEstimate(usage) : 0
  // Three steps reserve their space while loading.
  const steps = usage ? usage.steps : [null, null, null]
  return <>
    <SectionHeader title="Plan & usage" />
    <p className="muted usage-note">Billing isn’t on yet, so nothing is charged. These are the published prices, what you’ve used this month and your sending limit today. Simulator sends count like any other send.{canAdminister ? '' : ' Received mail counts are shown to owners and admins.'}</p>
    <div className="settings-rows usage-rows">
      <Row title="Price" hint="Sent or received">{value(u => `${money(u.pricing.perThousand)} per 1,000 emails`, 160)}</Row>
      <Row title="Free every month" hint="Resets on the 1st, UTC">{value(u => `${number(u.pricing.freeSent)} sent · ${number(u.pricing.freeReceived)} received`, 180)}</Row>
      <Row title="This month" hint={usage ? `Since ${date(usage.month.from, { month: 'short', day: 'numeric', timeZone: 'UTC' })}${usage.simulated ? ', simulated' : ''}` : 'This calendar month'}>{value(u => u.month.received === null ? `${number(u.month.sent)} sent` : `${number(u.month.sent)} sent · ${number(u.month.received)} received`, 160)}</Row>
      <Row title="Estimated cost" hint={usage?.month.received === null ? 'Sent mail only' : usage && estimate === 0 ? 'Within the free allowance' : 'If billing were on today'}>{value(() => money(estimate), 80)}</Row>
      <Row title="Daily limit" hint={usage?.daily?.cap != null && usage.daily.step === null ? 'Custom, set by the Bane team' : 'Recipients, last 24 hours'}>{value(u => !u.daily ? <span className="muted">Connect sending first</span> : u.daily.cap === null ? 'No daily limit' : <DailyMeter used={u.daily.used} cap={u.daily.cap} resetAt={u.daily.resetAt} />, 160)}</Row>
    </div>
    <section className="usage-steps-section" aria-labelledby="usage-steps-title">
      <SectionHeader title={<span id="usage-steps-title">How the daily limit grows</span>} />
      <p className="muted usage-note">New workspaces start small so a mistake can’t hurt everyone’s delivery. The limit rises on its own as your mail proves healthy. Only real email accepted by SES counts: simulator sends use the limit but never raise it.</p>
      <ol className="usage-steps">{steps.map((step, index) => {
        const current = usage?.daily?.step === index, done = usage?.daily?.step != null && index < usage.daily.step
        return <li key={index} data-current={current || undefined} data-done={done || undefined} style={{ '--i': index } as CSSProperties}>
          <span className="usage-steps__mark" aria-hidden="true">{done ? <Check size={12} strokeWidth={2.75} /> : index + 1}</span>
          {step ? <span className="usage-steps__body"><span><b>{number(step.cap)}</b> recipients a day{current && <span className="usage-steps__badge">You’re here</span>}</span><span className="muted">{step.requires}</span></span> : <span className="usage-steps__body"><Skeleton width={160} height={20} /><Skeleton width={280} height={16} /><Skeleton width={200} height={16} /></span>}
        </li>
      })}</ol>
    </section>
  </>
}

function DailyMeter({ used, cap, resetAt }: { used: number; cap: number; resetAt: string | null }) {
  const share = Math.min(1, used / Math.max(1, cap))
  return <span className="usage-meter" title={resetAt ? `Capacity frees up from ${date(resetAt, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' })} UTC` : undefined}>
    <span className="usage-meter__track" data-full={share >= 0.9 || undefined} role="meter" aria-label="Recipients used in the last 24 hours" aria-valuemin={0} aria-valuemax={cap} aria-valuenow={used}><i style={{ transform: `scaleX(${share})` }} /></span>
    <span>{number(used)} / {number(cap)}</span>
  </span>
}
