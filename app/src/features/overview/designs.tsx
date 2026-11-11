import { useState, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { ArrowUpRight, Check } from 'lucide-react'
import { useApi, useApiDef, useApiQuery, useRegion } from '../../data/context'
import { queries } from '../../data/queries'
import { useRouteIntent } from '../../data/prefetch'
import { campaignEditable, type Overview, type TimeRange } from '../../data/types'
import { Button, DataTable, EmptyState, ErrorState, PageHeader, SectionHeader, Select, StatusBadge, Tabs } from '../../components/ui'
import type { Design } from '../../lib/design'
import { date, label, number, percent, time } from '../../lib/format'
import { NextSteps, ReportCard, useNextSteps } from '../score'
import { ActivityChart } from './index'
import { OverviewBodySkeleton, recentCampaignColumns } from './skeletons'
import { useSetupSteps, type SetupStep } from './setup'
import './designs.css'

// Three proposed Overview layouts. All read the same metrics query as today's page; the sender score is derived
// in the browser (features/score). Hard sending limits give way to the score, so the limit bar is not shown.
//  a: split — numbers and chart on the left, a detail column (setup, score, next) on the right
//  b: destinations — numbers you can click, then the score as one band, then the chart
//  c: report first — the grade leads; setup is a split panel above it
export function PitchOverview({ design }: { design: Exclude<Design, 'current'> }) {
  const view = useOverviewData()
  const header = <PageHeader title="Overview" actions={view.controls} />
  if (design === 'a') return <>{header}<OverviewA view={view} /></>
  if (design === 'b') return <>{header}<OverviewB view={view} /></>
  return <>{header}<OverviewC view={view} /></>
}

type View = ReturnType<typeof useOverviewData>
function useOverviewData() {
  const { regionId } = useRegion()
  const live = useApi().mode === 'live'
  const [range, setRange] = useState<TimeRange>('24h')
  const [searchParams, setSearchParams] = useSearchParams()
  const requested = searchParams.get('stream')
  const stream = requested === 'transactional' || requested === 'marketing' ? requested : 'all'
  const query = useApiDef(queries.overview(regionId, range, stream), { interval: 60_000, keepPrevious: previous => previous[1] === regionId })
  const controls = <div className="cluster ov-controls">
    <Tabs value={range} onValueChange={value => setRange(value as TimeRange)} items={[{ value: '24h', label: '24h' }, { value: '7d', label: '7d' }, { value: '30d', label: '30d' }]} label="Time range" />
    <Select aria-label="Email stream" value={stream} onValueChange={value => setSearchParams(previous => { const next = new URLSearchParams(previous); if (value === 'all') next.delete('stream'); else next.set('stream', value); return next })} options={[{ value: 'all', label: 'All emails' }, { value: 'transactional', label: 'Transactional' }, { value: 'marketing', label: 'Marketing' }]} />
  </div>
  return { range, live, query, controls }
}
const rate = (part: number, whole: number) => whole ? percent(part / whole) : '—'
const delta = (data: Overview) => data.previousSent ? `${data.sent >= data.previousSent ? '+' : ''}${percent((data.sent - data.previousSent) / data.previousSent, 0)}` : null

// Four numbers, labels only: Emails, Delivered, Bounced, Complaints.
function Numbers({ data, link }: { data: Overview; link?: boolean }) {
  const intent = useRouteIntent()
  const cells = [
    { key: 'emails', title: 'Emails', value: number(data.sent), note: delta(data) },
    { key: 'delivered', title: 'Delivered', value: rate(data.delivered, data.sent) },
    { key: 'bounced', title: 'Bounced', value: rate(data.bounced, data.sent), tone: data.sent && data.bounced / data.sent >= 0.05 ? 'warning' : undefined },
    { key: 'complaints', title: 'Complaints', value: rate(data.complaints, data.sent), tone: data.sent && data.complaints / data.sent >= 0.001 ? 'danger' : undefined },
  ]
  return <div className={`ov-numbers${link ? ' ov-numbers--links' : ''}`}>{cells.map(cell => {
    const body = <><span className="ov-numbers__label">{cell.title}{cell.note && <span className="muted">{cell.note}</span>}</span><span className={`ov-numbers__value${cell.tone ? ` text-${cell.tone}` : ''}`}>{cell.value}</span>{link && <span className="ov-numbers__go muted">Logs <ArrowUpRight size={12} /></span>}</>
    return link ? <Link key={cell.key} to="/logs" className="ov-numbers__cell" {...intent('/logs')}>{body}</Link> : <div key={cell.key} className="ov-numbers__cell">{body}</div>
  })}</div>
}
function Chart({ view, data, title = true }: { view: View; data: Overview; title?: boolean }) {
  return <section className="chart-section ov-chart" aria-label="Sending activity">
    <div className="ov-chart__head">{title && <h2 className="ov-chart__title">Activity</h2>}<div className="chart-legend"><span><i className="legend-sent" />Emails</span><span><i className="legend-bounces" />Bounces</span><span><i className="legend-complaints" />Complaints</span></div></div>
    {data.sent ? <ActivityChart key={view.range} points={data.points} createdOnly={view.live} range={view.range} /> : <EmptyState title="No emails yet" />}
  </section>
}
function Body({ view, children }: { view: View; children: (data: Overview) => ReactNode }) {
  const { query } = view
  if (query.isPending) return <OverviewBodySkeleton range={view.range} live={view.live} />
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />
  return <>{query.data && children(query.data)}</>
}
function Campaigns({ data }: { data: Overview }) {
  const navigate = useNavigate()
  if (!data.recentCampaigns.length) return null
  return <section className="ov-campaigns"><SectionHeader title="Campaigns" actions={<Button variant="ghost" size="sm" onClick={() => navigate('/campaigns')}>All <ArrowUpRight size={16} /></Button>} />
    <DataTable className="ov-table" rows={data.recentCampaigns.slice(0, 3)} rowKey={row => row.id} onRowClick={row => navigate(`/campaigns/${row.id}/${campaignEditable(row) ? 'edit' : 'review'}`)} columns={[{ ...recentCampaignColumns[0], render: row => <span>{row.name}<span className="muted"> · {['sent', 'done'].includes(row.status) ? date(row.updatedAt) : label(row.status)}</span></span> }, { ...recentCampaignColumns[1], render: row => number(row.recipients), align: 'right' }, { ...recentCampaignColumns[2], render: row => ['sent', 'done'].includes(row.status) ? percent(row.recipients ? row.delivered / row.recipients : 0) : '—', align: 'right' }]} />
  </section>
}

// The latest emails, each a link into Logs.
function LatestEmails({ count = 5 }: { count?: number }) {
  const navigate = useNavigate()
  const emails = useApiQuery(['emails', 'overview-latest', count], (api, signal) => api.emails.list({ page: 1, pageSize: count }, signal), { interval: 60_000 })
  if (!emails.data?.items.length) return null
  return <section className="ov-campaigns ov-latest"><SectionHeader title="Latest emails" actions={<Button variant="ghost" size="sm" onClick={() => navigate('/logs')}>Logs <ArrowUpRight size={16} /></Button>} />
    <DataTable className="ov-table" rows={emails.data.items} rowKey={row => row.id} onRowClick={row => navigate(`/logs/${encodeURIComponent(row.id)}`)} columns={[
      { key: 'status', label: 'Status', width: 116, render: row => <StatusBadge status={row.status} /> },
      { key: 'subject', label: 'Subject', render: row => <span className="ov-latest__subject">{row.subject}<span className="muted"> · {row.to}</span></span> },
      { key: 'stream', label: 'Stream', width: 116, render: row => <span className="muted">{label(row.stream)}</span> },
      { key: 'time', label: 'UTC', width: 88, align: 'right', render: row => <span className="muted">{time(row.sentAt)}</span> },
    ]} />
  </section>
}

// Direction A, pass 2: four compact facts (Console's hero facts), each with its own series as tiny bars.
function Spark({ values, tone }: { values: number[]; tone: 'sent' | 'delivered' | 'bounces' | 'complaints' }) {
  const max = Math.max(1, ...values), slot = 100 / Math.max(1, values.length)
  return <svg className={`ov-spark ov-spark--${tone}`} viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
    {values.map((value, i) => <rect key={i} className={value ? undefined : 'ov-spark__zero'} x={i * slot + slot * .18} width={slot * .64} y={24 - Math.max(value ? 2 : 1, value / max * 24)} height={Math.max(value ? 2 : 1, value / max * 24)} />)}
  </svg>
}
function Facts({ data }: { data: Overview }) {
  const points = data.points
  const facts = [
    { key: 'emails', title: 'Emails', value: number(data.sent), aside: delta(data) ?? '', series: points.map(p => p.sent), tone: 'sent' as const },
    { key: 'delivered', title: 'Delivered', value: rate(data.delivered, data.sent), aside: number(data.delivered), series: points.map(p => p.delivered), tone: 'delivered' as const },
    { key: 'bounced', title: 'Bounced', value: rate(data.bounced, data.sent), aside: number(data.bounced), series: points.map(p => p.bounced), tone: 'bounces' as const, warn: data.sent > 0 && data.bounced / data.sent >= 0.05 },
    { key: 'complaints', title: 'Complaints', value: rate(data.complaints, data.sent), aside: number(data.complaints), series: points.map(p => p.complaints), tone: 'complaints' as const, warn: data.sent > 0 && data.complaints / data.sent >= 0.001 },
  ]
  return <dl className="ov-facts">{facts.map(fact => <div key={fact.key}>
    <dt><span>{fact.title}</span><span className="muted">{fact.aside}</span></dt>
    <dd><span className={`ov-facts__value${fact.warn ? ' text-warning' : ''}`}>{fact.value}</span><Spark values={fact.series} tone={fact.tone} /></dd>
  </div>)}</dl>
}

// A: split. The right column holds what to do: setup while it's unfinished, then the score and next steps.
function OverviewA({ view }: { view: View }) {
  const setup = useSetupSteps()
  const next = useNextSteps()
  return <div className="ov-split ov-split--dense">
    <div className="ov-split__main"><Body view={view}>{data => <><Facts data={data} /><Chart view={view} data={data} /><LatestEmails count={7} />{data.recentCampaigns.length > 0 && <Campaigns data={data} />}</>}</Body></div>
    <aside className="ov-split__aside" aria-label="Status">
      {setup && <SetupRail steps={setup.steps} current={setup.current} />}
      <ReportCard variant="column" />
      {!setup && <NextSteps items={next} />}
    </aside>
  </div>
}
// Numbered steps, one open at a time, in the detail column.
function SetupRail({ steps, current }: { steps: SetupStep[]; current?: SetupStep }) {
  const required = steps.filter(step => !step.optional)
  return <section className="setup-rail" aria-label="Get started">
    <div className="setup-rail__head"><h2>Get started</h2><span className="muted">{required.filter(step => step.done).length} of {required.length}</span></div>
    <ol>{steps.map((step, index) => {
      const open = step === current
      return <li key={step.key} data-done={step.done || undefined} data-open={open || undefined}>
        <span className="setup-rail__mark" aria-hidden="true">{step.done ? <Check size={12} strokeWidth={2.75} /> : index + 1}</span>
        <div className="setup-rail__body"><span>{step.title}{step.optional && <span className="muted"> · optional</span>}{step.done && <span className="sr-only"> (done)</span>}</span>
          {open && <><span className="muted">{step.detail}</span>{step.action && <div className="setup-rail__action">{step.action}</div>}</>}
        </div>
      </li>
    })}</ol>
  </section>
}

// B: destinations. Every number opens the logs; setup lives in the sidebar (see AppShell).
function OverviewB({ view }: { view: View }) {
  const next = useNextSteps()
  return <Body view={view}>{data => <div className="ov-stack">
    <Numbers data={data} link />
    <ReportCard variant="band" />
    {next.length > 0 && <nav className="ov-next-row" aria-label="Next">{next.map(item => <Link key={item.key} to={item.to}><span>{item.text}</span>{item.meta && <span className="muted">{item.meta}</span>}<ArrowUpRight size={14} aria-hidden="true" /></Link>)}</nav>}
    <Chart view={view} data={data} />
  </div>}</Body>
}

// C: report first. While setup is unfinished it sits above the grade as one split panel.
function OverviewC({ view }: { view: View }) {
  const setup = useSetupSteps()
  return <div className="ov-stack">
    {setup && <SetupSplit steps={setup.steps} current={setup.current} />}
    <ReportCard variant="hero" />
    <Body view={view}>{data => <><Numbers data={data} /><Chart view={view} data={data} title={false} /></>}</Body>
  </div>
}
function SetupSplit({ steps, current }: { steps: SetupStep[]; current?: SetupStep }) {
  const [selected, setSelected] = useState(current?.key ?? steps[0].key)
  const step = steps.find(item => item.key === selected) ?? steps[0]
  const index = steps.indexOf(step)
  return <section className="setup-split" aria-label="Get started">
    <ol className="setup-split__steps">{steps.map((item, i) => <li key={item.key}>
      <button type="button" aria-current={item.key === step.key || undefined} data-done={item.done || undefined} onClick={() => setSelected(item.key)}>
        <span className="setup-rail__mark" aria-hidden="true">{item.done ? <Check size={12} strokeWidth={2.75} /> : i + 1}</span>
        <span>{item.title}</span>{item.optional && <span className="muted">Optional</span>}
      </button>
    </li>)}</ol>
    <div className="setup-split__detail">
      <span className="muted">Step {index + 1} of {steps.length}{step.done ? ' · done' : ''}</span>
      <h2>{step.title}</h2>
      <p className="muted">{step.detail}</p>
      {step.action && <div className="setup-split__action">{step.action}</div>}
    </div>
  </section>
}
