import type { CSSProperties, ReactNode } from 'react'
import { Link } from 'react-router'
import { ArrowUpRight, Check } from 'lucide-react'
import { ErrorState, SectionHeader, Skeleton, StatusBadge } from '../../components/ui'
import { useApiDef, useSession, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import { monthEstimate } from '../../data/usage'
import { balanceState, total, usd } from '../../data/billing'
import { date, number } from '../../lib/format'
import './usage.css'

const money = (value: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2 }).format(value)

// Plan & usage (hosted): what billing charges and whether it does yet, the free allowance used this month, this month's
// counts and cost, and the daily sending limit with the steps it grows through. Every member can read it; members see
// sent mail only and no amounts (received mail includes messages they can't open), and the note says so before data
// arrives. Each value has a skeleton of its own width in a 53px row, so nothing moves as the three reads land.
export function PlanUsage({ row: Row }: { row: (props: { title: ReactNode; hint?: ReactNode; children: ReactNode }) => ReactNode }) {
  const query = useApiDef(queries.usage(), { interval: 60_000 })
  const billing = useApiDef(queries.billing(), { interval: 60_000 })
  const { canAdminister } = useWorkspaceAccess()
  const omens = useApiDef(queries.billingMonth(), { enabled: canAdminister })
  const usage = query.data, b = billing.data
  // From the session (GET /v1/me), so the note is final on the first frame.
  const enforcement = useSession()?.identity?.billing?.enforcement ?? 'off'
  if (query.isError && !usage) return <><SectionHeader title="Plan & usage" /><ErrorState error={query.error} onRetry={() => void query.refetch()} /></>
  const value = (ready: unknown, render: () => ReactNode, width = 120) => ready ? render() : <Skeleton width={width} height={20} />
  const enforced = b?.enforcement === 'enforce', state = b ? balanceState(b) : null
  const omenCount = Number(omens.data?.data.filter(p => p.meter === 'omen').reduce((sum, p) => sum + BigInt(p.quantity), 0n) ?? 0n)
  const aged = b ? Number(BigInt(b.free.storage.agedBytes)) : 0
  // Three steps reserve their space while loading.
  const steps = usage ? usage.steps : [null, null, null]
  return <>
    <SectionHeader title="Plan & usage" />
    <p className="muted usage-note">{enforcement === 'enforce' ? 'Prepaid: usage is taken from your balance hourly.' : enforcement === 'shadow' ? 'Billing starts soon: nothing is charged yet.' : 'Billing isn’t on yet, so nothing is charged.'} Simulator sends count like any other send.{canAdminister ? '' : ' Received mail counts and amounts are shown to owners and admins.'}</p>
    <div className="settings-rows usage-rows">
      <Row title="Balance" hint={enforced ? 'Usage comes off it hourly' : 'Nothing is charged yet'}>{value(b, () => <span className="cluster settings-inline">
        <StatusBadge status={enforced || b!.mode === 'exempt' ? state!.label : 'Not charged yet'} tone={enforced || b!.mode === 'exempt' ? state!.tone : 'neutral'} />
        {b!.balance && <Link to="/settings#billing" replace className="settings-score"><span>{usd(total(b!.balance))}</span><ArrowUpRight size={14} aria-hidden="true" /></Link>}
      </span>, 160)}</Row>
      <Row title="Free this month" hint="Sent and received, this UTC month">{value(b, () => <Meter used={b!.free.emails.used} cap={b!.free.emails.limit} label="Free emails used this month" />, 160)}</Row>
      <Row title="Stored past 90 days" hint="1 GB free, then $0.25 per GB-month">{value(b, () => `${gigabytes(aged)} of ${gigabytes(b!.free.storage.limitBytes)}`, 140)}</Row>
      <Row title="This month" hint={usage ? `Since ${date(usage.month.from, { month: 'short', day: 'numeric', timeZone: 'UTC' })}${usage.simulated ? ', simulated' : ''}` : 'This calendar month'}>{value(usage && (!canAdminister || omens.data || omens.isError), () => [`${number(usage!.month.sent)} sent`, usage!.month.received === null ? null : `${number(usage!.month.received)} received`, canAdminister && !omens.isError ? `${number(omenCount)} Omens` : null].filter(Boolean).join(' · '), 200)}</Row>
      <Row title="Estimated cost" hint={b?.monthToDate ? 'At $0.20 per 1,000 emails' : usage?.month.received === null ? 'Sent mail only' : 'This month'}>{value(b && usage, () => b!.monthToDate ? usd(b!.monthToDate.cost) : money(monthEstimate(usage!)), 80)}</Row>
      <Row title="Daily limit" hint={usage?.daily?.cap != null && usage.daily.step === null ? 'Custom, set by the Bane team' : 'Recipients, last 24 hours'}>{value(usage, () => !usage!.daily ? <span className="muted">Connect sending first</span> : usage!.daily.cap === null ? 'No daily limit' : <DailyMeter used={usage!.daily.used} cap={usage!.daily.cap} resetAt={usage!.daily.resetAt} />, 160)}</Row>
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

const gigabytes = (bytes: number) => `${(bytes / 1e9).toLocaleString('en-US', { maximumFractionDigits: bytes > 0 && bytes < 1e8 ? 2 : 1 })} GB`
function Meter({ used, cap, label }: { used: number; cap: number; label: string }) {
  const share = Math.min(1, used / Math.max(1, cap))
  return <span className="usage-meter">
    <span className="usage-meter__track" data-full={share >= 0.9 || undefined} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={cap} aria-valuenow={used}><i style={{ transform: `scaleX(${share})` }} /></span>
    <span>{number(used)} / {number(cap)}</span>
  </span>
}

function DailyMeter({ used, cap, resetAt }: { used: number; cap: number; resetAt: string | null }) {
  const share = Math.min(1, used / Math.max(1, cap))
  return <span className="usage-meter" title={resetAt ? `Capacity frees up from ${date(resetAt, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' })} UTC` : undefined}>
    <span className="usage-meter__track" data-full={share >= 0.9 || undefined} role="meter" aria-label="Recipients used in the last 24 hours" aria-valuemin={0} aria-valuemax={cap} aria-valuenow={used}><i style={{ transform: `scaleX(${share})` }} /></span>
    <span>{number(used)} / {number(cap)}</span>
  </span>
}
