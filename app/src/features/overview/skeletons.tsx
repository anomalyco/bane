import { ArrowUpRight } from 'lucide-react'
import { useRegion, useSession, useWorkspaceAccess } from '../../data/context'
import type { RegionCatalogEntry } from '../../data/types'
import { label } from '../../lib/format'
import { LoadingRegion, PageHeader, SectionHeader, Select, Skeleton, StatusBadge, TableSkeleton, Tabs, type Column, type SkeletonColumn } from '../../components/ui'
import type { LogEntry } from '../../data/types'
import { logColumnDefs, logColumns } from '../logs/rows'
import { useLatestRowCount } from './latest'
import './overview.css'

// Hosted mail manages its region, so it shows no status; a bring-your-own connection shows its own state,
// and self-hosted SES shows the region's discovery status.
export function RegionStatus({ current }: { current?: RegionCatalogEntry }) {
  const { multiTenant } = useWorkspaceAccess()
  const connection = useSession()?.identity?.connection
  if (multiTenant) return connection?.kind === 'byo' ? <StatusBadge status={label(connection.state)} tone={connection.state === 'ready' ? 'success' : connection.state === 'failed' ? 'danger' : 'warning'} /> : null
  return current ? <StatusBadge status={label(current.discoveryStatus)} tone={current.discoveryStatus === 'ready' ? 'success' : current.discoveryStatus === 'blocked' ? 'danger' : 'warning'} /> : <Skeleton width={84} height={20} />
}

export const factTitles = ['Emails', 'Delivered', 'Bounced', 'Complaints'] as const
// Latest emails are Logs' rows in a 790px column, so the table says what Logs says in fewer columns: the other party
// is one column (who it went to, or who it came from; received mail is the one with the Received status), and the
// direction and stream columns stay for phone cards only. Every address then gets room to read in full.
const logColumn = (key: string) => logColumns.find(column => column.key === key)!
export const latestColumnDefs: SkeletonColumn[] = logColumnDefs.map(column => column.key === 'direction' || column.key === 'from' || column.key === 'stream' ? { ...column, table: false as const }
  : column.key === 'status' ? { ...column, width: 124 } : column.key === 'to' ? { ...column, key: 'contact', label: 'To · from', width: '32%' } : column)
export const latestColumns: Column<LogEntry>[] = latestColumnDefs.map(column => ({ ...logColumn(column.key === 'contact' ? 'to' : column.key), ...column, render: column.key === 'contact' ? (row: LogEntry) => (row.direction === 'sent' ? logColumn('to') : logColumn('from')).render(row) : logColumn(column.key).render }))

// Each skeleton has exactly the loaded block's dimensions (see overview.css), so swapping in the data moves nothing.
export function FactsSkeleton() {
  return <dl className="ov-facts" aria-hidden="true">{factTitles.map(title => <div key={title}><dt><span>{title}</span></dt><dd><span className="ov-facts__value"><Skeleton width={72} height={22} /></span><span className="ov-spark ov-spark--skeleton" /></dd></div>)}</dl>
}
export function ChartSkeleton() {
  return <section className="ov-chart" aria-hidden="true"><div className="ov-chart__head"><h2>Activity</h2></div><div className="ov-chart__plot ov-chart__plot--loading" /></section>
}
export function AsideSkeleton() {
  return <div className="ov-aside-skeleton" aria-hidden="true"><span /><span /></div>
}
// The route-level placeholder while the Overview code loads: the same header, columns and blocks, and as many latest
// email rows as the page will reserve (latest.ts).
export function OverviewRouteSkeleton() {
  const { regionId } = useRegion()
  const { multiTenant, canAdminister } = useWorkspaceAccess()
  const count = useLatestRowCount()
  return <>
    <PageHeader title="Overview" actions={<div className="cluster ov-controls">{!multiTenant && <>{!canAdminister && <span className="muted">{regionId}</span>}<RegionStatus /></>}<Tabs value="24h" onValueChange={() => {}} disabled items={[{ value: '24h', label: '24h' }, { value: '7d', label: '7d' }, { value: '30d', label: '30d' }]} label="Time range" /><Select aria-label="Email stream" value="all" onValueChange={() => {}} disabled options={[{ value: 'all', label: 'All emails' }]} /></div>} />
    <LoadingRegion label="Loading overview"><div className="ov-split">
      <div className="ov-split__main"><FactsSkeleton /><ChartSkeleton /><section className="ov-latest"><SectionHeader title="Latest emails" actions={<span className="ui-button ui-button--ghost ui-button--sm" aria-disabled="true">Logs <ArrowUpRight size={16} /></span>} /><TableSkeleton className="logs-table ov-table" columns={latestColumnDefs} rows={count} /></section></div>
      <aside className="ov-split__aside"><AsideSkeleton /></aside>
    </div></LoadingRegion>
  </>
}
