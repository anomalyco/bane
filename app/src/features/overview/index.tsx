import { useLayoutEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { ArrowUpRight } from 'lucide-react'
import { useApi, useApiDef, useApiQuery, useRegion, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import { useRegionCatalog, useRegionDiscovery } from '../../data/regions'
import { accountStatus, ratePercent, rateStatus } from '../../lib/reputation'
import { campaignEditable, type ChartPoint, type LogEntry, type Overview, type SesDiscovery, type TimeRange } from '../../data/types'
import { Button, DataTable, EmptyState, ErrorState, PageHeader, SectionHeader, Select, StatusBadge, Tabs } from '../../components/ui'
import { useTween } from '../../components/motion'
import { date, label, number, percent, time } from '../../lib/format'
import { NextSteps, ReportCard, useNextSteps, useSenderScore } from '../score'
import { AsideSkeleton, ChartSkeleton, factTitles, FactsSkeleton, recentCampaignColumns, RegionStatus } from './skeletons'
import { logColumns, logHref, useLogRowIntent } from '../logs/rows'
import { usePrefetchQueries } from '../../data/prefetch'
import { composer } from '../campaigns/composer-chunk'
import { SendingLimitRow, SetupRail, useSetupSteps } from './setup'

// Overview: four facts with their own series, the activity chart and the latest emails on the left; a detail column
// on the right with setup (until the first email), the sender score and up to three next steps.
// Every async block reserves its final size, and refetches keep the previous data on screen.
export function OverviewPage() {
  const { regionId } = useRegion()
  const live = useApi().mode === 'live'
  const [range, setRange] = useState<TimeRange>('24h')
  const [searchParams, setSearchParams] = useSearchParams()
  const requested = searchParams.get('stream')
  const stream = requested === 'transactional' || requested === 'marketing' ? requested : 'all'
  // Each refresh runs one created-cohort aggregation; a minute is fresh enough, and a hidden tab stays quiet.
  const query = useApiDef(queries.overview(regionId, range, stream), { interval: 60_000, keepPrevious: previous => previous[1] === regionId })
  const { multiTenant, canAdminister } = useWorkspaceAccess()
  const regions = useRegionCatalog({ enabled: !multiTenant })
  const current = regions.data?.data.find(region => region.region === regionId)
  const discovery = useRegionDiscovery(multiTenant ? undefined : current)
  const controls = <div className="cluster ov-controls">
    {!multiTenant && <><ReputationSummary report={discovery.data} regionId={regionId} />{!canAdminister && <span className="muted">{regionId}</span>}<RegionStatus current={current} /></>}
    <Tabs value={range} onValueChange={value => setRange(value as TimeRange)} items={[{ value: '24h', label: '24h' }, { value: '7d', label: '7d' }, { value: '30d', label: '30d' }]} label="Time range" />
    <Select aria-label="Email stream" value={stream} onValueChange={value => setSearchParams(previous => { const next = new URLSearchParams(previous); if (value === 'all') next.delete('stream'); else next.set('stream', value); return next })} options={[{ value: 'all', label: 'All emails' }, { value: 'transactional', label: 'Transactional' }, { value: 'marketing', label: 'Marketing' }]} />
  </div>
  const data = query.data
  return <>
    <PageHeader title="Overview" actions={controls} />
    <div className="ov-split">
      <div className="ov-split__main">
        {query.isError && !data ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <>
          {data ? <Facts data={data} /> : <FactsSkeleton />}
          {data ? <Chart data={data} range={range} live={live} /> : <ChartSkeleton />}
        </>}
        <LatestEmails />
        {data && data.recentCampaigns.length > 0 && <Campaigns data={data} />}
      </div>
      <Aside />
    </div>
  </>
}

// The detail column renders in one go once setup, the score and the next steps are known, so nothing in it moves.
function Aside() {
  const score = useSenderScore()
  const setup = useSetupSteps()
  const next = useNextSteps(score.data)
  const ready = (score.data || score.isError) && !setup.loading && next.ready
  return <aside className="ov-split__aside" aria-label="Status">{!ready ? <AsideSkeleton /> : <>
    {setup.steps && <SetupRail steps={setup.steps} current={setup.current} />}
    {score.isError && !score.data ? <ErrorState error={score.error} onRetry={() => score.refetch()} /> : <ReportCard report={score.data} />}
    <SendingLimitRow />
    {!setup.steps && <NextSteps items={next.items} />}
  </>}</aside>
}

const rate = (part: number, whole: number) => whole ? percent(part / whole) : '—'
const delta = (data: Overview) => data.previousSent ? `${data.sent >= data.previousSent ? '+' : ''}${percent((data.sent - data.previousSent) / data.previousSent, 0)}` : ''

// Four facts (Console-style): a hairline, a label row with a count or delta, and the value beside its own series.
function Facts({ data }: { data: Overview }) {
  const sent = useTween(data.sent), delivered = useTween(data.sent ? data.delivered / data.sent : 0), bounced = useTween(data.sent ? data.bounced / data.sent : 0), complaints = useTween(data.sent ? data.complaints / data.sent : 0)
  const facts = [
    { title: factTitles[0], value: number(Math.round(sent)), aside: delta(data), series: data.points.map(p => p.sent), tone: 'sent' },
    { title: factTitles[1], value: data.sent ? percent(delivered) : '—', aside: number(data.delivered), series: data.points.map(p => p.delivered), tone: 'delivered' },
    { title: factTitles[2], value: data.sent ? percent(bounced) : '—', aside: number(data.bounced), series: data.points.map(p => p.bounced), tone: 'bounces', warn: data.sent > 0 && data.bounced / data.sent >= 0.05 },
    { title: factTitles[3], value: data.sent ? percent(complaints) : '—', aside: number(data.complaints), series: data.points.map(p => p.complaints), tone: 'complaints', warn: data.sent > 0 && data.complaints / data.sent >= 0.001 },
  ]
  return <dl className="ov-facts">{facts.map(fact => <div key={fact.title}>
    <dt><span>{fact.title}</span><span className="muted">{fact.aside}</span></dt>
    <dd><span className={`ov-facts__value${fact.warn ? ' text-warning' : ''}`}>{fact.value}</span><Spark values={fact.series} tone={fact.tone} /></dd>
  </div>)}</dl>
}
function Spark({ values, tone }: { values: number[]; tone: string }) {
  const max = Math.max(1, ...values), slot = 100 / Math.max(1, values.length)
  return <svg className={`ov-spark ov-spark--${tone}`} viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
    {values.map((value, i) => { const h = Math.max(value ? 2 : 1, value / max * 24); return <rect key={i} className={value ? undefined : 'ov-spark__zero'} x={i * slot + slot * .18} width={slot * .64} y={24 - h} height={h} /> })}
  </svg>
}

function Chart({ data, range, live }: { data: Overview; range: TimeRange; live: boolean }) {
  return <section className="ov-chart" aria-label="Sending activity">
    <div className="ov-chart__head"><h2>Activity</h2><div className="chart-legend"><span><i className="legend-sent" />Emails</span><span><i className="legend-bounces" />Bounces</span><span><i className="legend-complaints" />Complaints</span></div></div>
    <div className="ov-chart__plot">{data.sent ? <ActivityChart key={range} points={data.points} createdOnly={live} range={range} /> : <EmptyState title="No emails in this period" />}</div>
  </section>
}

// The latest mail is the top of Logs: the same rows, columns and masking (features/logs/rows.tsx), compact, seven rows
// always reserved so loading, short and full lists are the same height.
function LatestEmails() {
  const navigate = useNavigate()
  const logs = useApiDef(queries.logs({ direction: 'all', page: 1, pageSize: 7 }), { interval: 60_000, keepPrevious: true }) // warmed with the page (data/prefetch.ts)
  const rowIntent = useLogRowIntent()
  return <section className="ov-latest"><SectionHeader title="Latest emails" actions={<Link className="ui-button ui-button--ghost ui-button--sm" to="/logs">Logs <ArrowUpRight size={16} /></Link>} />
    {logs.isError && !logs.data ? <ErrorState error={logs.error} onRetry={() => logs.refetch()} /> : <DataTable<LogEntry> className="logs-table ov-table" loading={logs.isPending} skeletonRows={7} minRows={7} rows={logs.data?.items ?? []} rowKey={row => `${row.direction}:${row.id}`} onRowClick={row => navigate(logHref(row))} onRowIntent={rowIntent} empty={<EmptyState title="No emails yet" />} columns={logColumns} />}
  </section>
}
function Campaigns({ data }: { data: Overview }) {
  const navigate = useNavigate()
  const warm = usePrefetchQueries()
  return <section className="ov-latest"><SectionHeader title="Campaigns" actions={<Button variant="ghost" size="sm" onClick={() => navigate('/campaigns')}>All <ArrowUpRight size={16} /></Button>} />
    <DataTable className="ov-table" rows={data.recentCampaigns.slice(0, 3)} rowKey={row => row.id} onRowClick={row => navigate(`/campaigns/${row.id}/${campaignEditable(row) ? 'edit' : 'review'}`)} onRowIntent={row => { void warm([queries.campaign(row.id)]); if (campaignEditable(row)) void composer.preload().catch(() => {}) }} columns={[{ ...recentCampaignColumns[0], render: row => <span>{row.name}<span className="muted"> · {['sent', 'done'].includes(row.status) ? date(row.updatedAt) : label(row.status)}</span></span> }, { ...recentCampaignColumns[1], render: row => number(row.recipients), align: 'right' }, { ...recentCampaignColumns[2], render: row => ['sent', 'done'].includes(row.status) ? percent(row.recipients ? row.delivered / row.recipients : 0) : '—', align: 'right' }]} />
  </section>
}

const severity = { neutral: 0, info: 0, success: 1, warning: 2, danger: 3 } as const
// Self-hosted only: the SES account's own reputation, from the region's discovery report.
function ReputationSummary({ report, regionId }: { report: SesDiscovery | undefined; regionId: string }) {
  const reputation = report?.reputation
  if (!report?.account || !reputation?.available) return null
  const worst = [accountStatus(report.account.enforcementStatus), rateStatus('bounceRate', reputation.bounceRate), rateStatus('complaintRate', reputation.complaintRate)].filter(status => status.label !== 'No data' && status.label !== 'Unknown').sort((a, b) => severity[b.tone] - severity[a.tone])[0]
  return <Link className="overview-reputation" to={`/settings?region=${encodeURIComponent(regionId)}`} title="SES account reputation">
    <span className="muted">SES</span>{worst && <StatusBadge status={worst.label} tone={worst.tone} />}<span className="muted">{ratePercent(reputation.bounceRate)} bounce · {ratePercent(reputation.complaintRate)} complaint</span>
  </Link>
}

// Three whole-number steps so every gridline label is a distinct integer.
function niceMax(value: number) { const raw = Math.max(1, value) / 3, base = 10 ** Math.floor(Math.log10(raw)), step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map(m => m * base).find(m => m >= raw && Number.isInteger(m)) ?? Math.ceil(raw); return step * 3 }
export function ActivityChart({ points, range, createdOnly = false }: { points: ChartPoint[]; range: TimeRange; createdOnly?: boolean }) {
  const [active, setActive] = useState<number | null>(null)
  const container = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 1080, height: 196 })
  useLayoutEffect(() => {
    const element = container.current
    if (!element) return
    const measure = ({ width, height }: DOMRectReadOnly) => setSize({ width: Math.max(1, width), height: Math.max(1, height) })
    measure(element.getBoundingClientRect())
    const observer = new ResizeObserver(([entry]) => measure(entry.contentRect))
    observer.observe(element)
    return () => observer.disconnect()
  }, [points.length])
  if (!points.length) return <EmptyState title="No activity" />
  const { width, height } = size
  const left = 52, right = width - 64, top = 30, bottom = height - 42
  const selectedPoint = active === null ? undefined : points[active]
  const hasOutcomes = points.every(point => Number.isFinite(point.bounced) && Number.isFinite(point.complaints))
  const maxSent = niceMax(Math.max(...points.map(p => p.sent)))
  const maxException = niceMax(Math.max(...points.map(p => Math.max(p.bounced ?? 0, p.complaints ?? 0))))
  const slot = (right - left) / points.length
  const x = (i: number) => left + (i + 0.5) * slot
  const barWidth = Math.max(1, Math.min(24, slot * 0.6))
  const y = (value: number, max: number) => bottom - value / max * (bottom - top)
  const line = (key: 'sent' | 'bounced' | 'complaints', max: number) => {
    const values = points.map(p => y(p[key], max))
    const slopes = values.slice(1).map((value, i) => value - values[i])
    // Monotone cubic interpolation passes through every count without overshooting
    // a peak or dipping below zero; opposite/flat slopes keep extrema horizontal.
    const tangents = values.map((_, i) => {
      if (i === 0) return slopes[0] ?? 0
      if (i === values.length - 1) return slopes[i - 1]
      const before = slopes[i - 1], after = slopes[i]
      return before * after <= 0 ? 0 : 2 * before * after / (before + after)
    })
    return values.map((value, i) => i === 0 ? `M ${x(i)} ${value}` : `C ${x(i - 2 / 3)} ${values[i - 1] + tangents[i - 1] / 3} ${x(i - 1 / 3)} ${value - tangents[i] / 3} ${x(i)} ${value}`).join(' ')
  }
  const hourly = range !== '30d'
  const pointLabel = (at: string) => `${date(at, { month: 'short', day: 'numeric', ...(hourly ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' as const } : {}), timeZone: 'UTC' })} UTC`
  // Up to six ticks after the first, fewer when the plot is too narrow for their labels.
  const tickSteps = Math.max(1, Math.min(6, Math.floor((right - left) / 72)))
  const tickIndices = [...new Set([0, ...Array.from({ length: tickSteps }, (_, i) => Math.round((i + 1) * (points.length - 1) / tickSteps))])]
  return <div ref={container} className="activity-chart" onMouseLeave={() => setActive(null)}><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={createdOnly ? `Emails created per ${hourly ? 'hour' : 'day'} on the left scale; outcomes for those emails on the right scale.` : `Email activity per ${hourly ? 'hour' : 'day'}. Sends use the left scale; bounces and complaints use the right scale.`}>
    <text x={0} y={12} className="chart-label">{createdOnly ? 'Created' : 'Sent'}</text>{hasOutcomes && <text x={width - 2} y={12} textAnchor="end" className="chart-label">Exceptions</text>}
    {[0, 1, 2, 3].map(i => <g key={i}><line x1={left} x2={right} y1={top + i * (bottom - top) / 3} y2={top + i * (bottom - top) / 3} className="chart-grid" /><text x={0} y={top + i * (bottom - top) / 3 + 4} className="chart-label">{number(Math.round(maxSent * (1 - i / 3)))}</text>{hasOutcomes && <text x={width - 2} y={top + i * (bottom - top) / 3 + 4} textAnchor="end" className="chart-label">{number(Math.round(maxException * (1 - i / 3)))}</text>}</g>)}
    {points.map((p, i) => p.sent > 0 && <rect key={p.at} x={x(i) - barWidth / 2} y={y(p.sent, maxSent)} width={barWidth} height={bottom - y(p.sent, maxSent)} rx={Math.min(2, barWidth / 2)} className={`chart-bar${active === i ? ' chart-bar--active' : ''}`} />)}{hasOutcomes && <><path d={line('bounced', maxException)} className="chart-line chart-line--bounces" /><path d={line('complaints', maxException)} className="chart-line chart-line--complaints" /></>}
    {tickIndices.map(i => <text key={i} x={x(i)} y={height - (range === '7d' ? 22 : 13)} textAnchor="middle" className="chart-label">{date(points[i].at, range === '24h' ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' } : { month: 'short', day: 'numeric', timeZone: 'UTC' })}{range === '7d' && <tspan x={x(i)} dy={15}>{date(points[i].at, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' })}</tspan>}</text>)}
    {points.map((p, i) => {
      const start = left + i * slot, end = start + slot
      return <rect key={p.at} x={start} y={top} width={Math.max(0, end - start)} height={bottom - top} fill="transparent" tabIndex={0} role="button" aria-label={`${pointLabel(p.at)}: ${number(p.sent)} ${createdOnly ? 'created' : 'sent'}${hasOutcomes ? `, ${p.bounced} bounces, ${p.complaints} complaints` : ''}`} onMouseEnter={() => setActive(i)} onFocus={() => setActive(i)} onBlur={() => setActive(null)} />
    })}
    {selectedPoint && active !== null && <line x1={x(active)} x2={x(active)} y1={top} y2={bottom} className="chart-crosshair" />}
  </svg>{selectedPoint && <div className="chart-tooltip" role="status"><strong>{pointLabel(selectedPoint.at)}</strong><span>{createdOnly ? 'Created' : 'Sent'} <b>{number(selectedPoint.sent)}</b></span>{hasOutcomes && <><span>Bounces <b>{number(selectedPoint.bounced)}</b></span><span>Complaints <b>{number(selectedPoint.complaints)}</b></span></>}</div>}</div>
}
