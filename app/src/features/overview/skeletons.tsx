import { ArrowUpRight } from 'lucide-react'
import { useRegion, useSession, useWorkspaceAccess } from '../../data/context'
import type { RegionCatalogEntry } from '../../data/types'
import { label } from '../../lib/format'
import { LoadingRegion, PageHeader, SectionHeader, Select, Skeleton, StatusBadge, TableSkeleton, Tabs } from '../../components/ui'
import { logColumnDefs } from '../logs/rows'
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
export const recentCampaignColumns = [{ key: 'name', label: 'Campaign', width: '60%' }, { key: 'sent', label: 'Recipients', width: '20%', align: 'right' as const }, { key: 'delivered', label: 'Delivered', width: '20%', align: 'right' as const }]

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
// The route-level placeholder while the Overview code loads: the same header, columns and blocks.
export function OverviewRouteSkeleton() {
  const { regionId } = useRegion()
  const { multiTenant, canAdminister } = useWorkspaceAccess()
  return <>
    <PageHeader title="Overview" actions={<div className="cluster ov-controls">{!multiTenant && <>{!canAdminister && <span className="muted">{regionId}</span>}<RegionStatus /></>}<Tabs value="24h" onValueChange={() => {}} disabled items={[{ value: '24h', label: '24h' }, { value: '7d', label: '7d' }, { value: '30d', label: '30d' }]} label="Time range" /><Select aria-label="Email stream" value="all" onValueChange={() => {}} disabled options={[{ value: 'all', label: 'All emails' }]} /></div>} />
    <LoadingRegion label="Loading overview"><div className="ov-split">
      <div className="ov-split__main"><FactsSkeleton /><ChartSkeleton /><section className="ov-latest"><SectionHeader title="Latest emails" actions={<span className="ui-button ui-button--ghost ui-button--sm" aria-disabled="true">Logs <ArrowUpRight size={16} /></span>} /><TableSkeleton className="logs-table ov-table" columns={logColumnDefs} rows={7} /></section></div>
      <aside className="ov-split__aside"><AsideSkeleton /></aside>
    </div></LoadingRegion>
  </>
}
