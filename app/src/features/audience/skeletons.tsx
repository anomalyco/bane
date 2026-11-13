import { Fragment } from 'react'
import { SearchField, ControlSkeleton, FieldSkeleton, LoadingRegion, PageHeader, SectionHeader, Select, SkeletonText, TableSkeleton, Tabs, type SkeletonColumn } from '../../components/ui'
import { AudienceHeader } from './header'
import { ConsentLegend, consentTitle, statusOptions } from './consent'
import './audience.css'

export function AudienceCellSkeleton({ secondary = false }: { secondary?: boolean }) {
  return <div><SkeletonText width="78%" />{secondary && <SkeletonText width="48%" lineHeight={18} />}</div>
}
// A column heading whose hover title says what the consent state means.
const consentLabel = (status: string, label = statusOptions.find(option => option.value === status)?.label ?? status) => <span title={consentTitle(status)}>{label}</span>
// Cards on a phone: a contact's address and status, then name, lists and when it was added.
export const contactColumns: SkeletonColumn[] = [
  { key: 'email', label: 'Email', width: '28%', skeleton: <AudienceCellSkeleton />, card: 'title' },
  { key: 'status', label: 'Status', width: '17%', skeleton: <SkeletonText width={92} />, card: 'aside' },
  { key: 'name', label: 'Name', width: '18%', card: 'line' },
  { key: 'lists', label: 'Lists', width: '20%', card: 'inline' },
  { key: 'created', label: 'Added', width: '17%', skeleton: <SkeletonText width={95} />, card: 'inline' },
]
export const memberColumns: SkeletonColumn[] = [contactColumns[0], contactColumns[1], { key: 'suppression', label: 'Suppression reason', width: '38%', card: 'line' }, contactColumns[4]]
export const listColumns: SkeletonColumn[] = [
  { key: 'name', label: 'Name', width: '24%', card: 'title' },
  // A phone card gives consent two lines, two counts each, so all four fit at any width a count reaches.
  { key: 'subscribed', label: consentLabel('subscribed'), width: '12%', align: 'right', card: 'line' },
  { key: 'unknown', label: consentLabel('unknown'), width: '11%', align: 'right', card: 'inline' },
  { key: 'unsubscribed', label: consentLabel('unsubscribed'), width: '13%', align: 'right', card: 'line' },
  { key: 'suppressed', label: consentLabel('suppressed'), width: '12%', align: 'right', card: 'inline' },
  { key: 'total', label: 'Total', width: '11%', align: 'right', card: 'aside' },
  { key: 'created', label: 'Created', width: '17%', card: 'hide' },
]
export const segmentColumns: SkeletonColumn[] = [
  { key: 'name', label: 'Name', width: '30%', card: 'title' },
  { key: 'rules', label: 'Rules', width: '22%', card: 'line' },
  { key: 'matched', label: 'Matched', width: '14%', align: 'right', card: 'hide' },
  { key: 'eligible', label: 'Eligible', width: '14%', align: 'right', card: 'hide' },
  { key: 'updated', label: 'Updated', width: '20%', card: 'inline' },
]
export const activityColumns: SkeletonColumn[] = [
  { key: 'subject', label: 'Email', width: '55%' },
  { key: 'status', label: 'Latest event', width: '23%', skeleton: <SkeletonText width={90} /> },
  { key: 'time', label: 'Sent', width: '22%' },
]
export const consentColumns: SkeletonColumn[] = [
  { key: 'status', label: 'Status', width: '15%', card: 'title' },
  { key: 'source', label: 'Source', width: '17%', card: 'line' },
  { key: 'evidence', label: 'How', width: '38%', card: 'inline' },
  { key: 'policy', label: 'Policy version', width: '14%', card: 'field' },
  { key: 'at', label: 'When', width: '16%', card: 'aside' },
]
export function AudienceSummarySkeleton() {
  return <div className="audience-summary cluster">{[100, 115, 110, 125].map(width => <SkeletonText key={width} width={width} />)}</div>
}
export function AudienceMembersSkeleton() {
  return <><Tabs value="" onValueChange={() => {}} items={[{ value: '', label: 'All members' }, ...statusOptions]} /><div className="data-toolbar"><ControlSkeleton width={320} /></div><ConsentLegend /><TableSkeleton columns={memberColumns} rows={8} pagination /></>
}
export function ListDetailBodySkeleton() {
  return <LoadingRegion label="Loading list"><AudienceMembersSkeleton /></LoadingRegion>
}
export function AudiencePreviewSkeleton() {
  return <LoadingRegion label="Loading audience preview"><AudienceSummarySkeleton /><TableSkeleton columns={memberColumns} rows={8} /></LoadingRegion>
}
export function ContactDetailBodySkeleton() {
  return <><div className="audience-summary cluster"><SkeletonText width={240} /><SkeletonText width={94} /></div>
    <div className="section form-grid audience-properties">{[{ title: 'Properties', labels: ['Full name', 'Country', 'Created', 'Last opened'], notes: false }, { title: 'Marketing consent', labels: ['Status', 'Suppression'], notes: true }].map(group => <section key={group.title}><SectionHeader title={group.title} /><dl>{group.labels.map(label => <Fragment key={label}><dt>{label}</dt><dd><SkeletonText width="65%" />{group.notes && <span className="audience-dd-note"><SkeletonText width="80%" /></span>}</dd></Fragment>)}</dl></section>)}</div>
    <section className="section"><SectionHeader title="Lists" actions={<ControlSkeleton width={111} />} /><SkeletonText width={170} /></section>
    <ConsentHistorySkeleton />
  </>
}
// Consent history renders before Matching emails; Matching emails waits until the history's height is known.
export function ConsentHistorySkeleton() {
  return <section className="section"><SectionHeader title="Consent history" /><p className="muted">Every consent change, and how it was given or withdrawn.</p><TableSkeleton columns={consentColumns} rows={1} /></section>
}
export function SegmentEditorBodySkeleton() {
  return <div className="stack audience-editor"><div className="audience-name"><FieldSkeleton label="Segment name" /></div>
    <section className="section stack"><SectionHeader title="Conditions" actions={<ControlSkeleton width={104} />} /><p className="muted">A segment narrows a campaign’s list to the people who match these conditions.</p><div className="cluster"><span>Match</span><ControlSkeleton width={220} /></div><div className="audience-rules"><div className="audience-rule audience-rule--head" aria-hidden="true"><span>Field</span><span>Condition</span><span>Value</span><span /></div><div className="audience-rule"><ControlSkeleton /><ControlSkeleton /><ControlSkeleton /><ControlSkeleton width={34} /></div></div><div className="cluster"><ControlSkeleton width={133} /></div></section>
    <section className="section stack"><SectionHeader title="Matching contacts" actions={<ControlSkeleton width={220} />} /><AudienceSummarySkeleton /></section></div>
}
export function AudienceRouteSkeleton({ kind, isNew = false }: { kind: 'contacts' | 'contact' | 'lists' | 'list' | 'segments' | 'segment'; isNew?: boolean }) {
  if (kind === 'contact') return <LoadingRegion className="audience-page" label="Loading contact"><PageHeader title={<SkeletonText width={200} lineHeight={24} />} backTo="/audience" actions={<><ControlSkeleton width={109} /><ControlSkeleton width={111} /></>} /><ContactDetailBodySkeleton /></LoadingRegion>
  if (kind === 'list') return <LoadingRegion className="audience-page" label="Loading list"><PageHeader title={<SkeletonText width={96} lineHeight={24} />} backTo="/audience/lists" actions={<><ControlSkeleton width={85} /><ControlSkeleton width={120} /></>} /><AudienceMembersSkeleton /></LoadingRegion>
  if (kind === 'segment') return <LoadingRegion className="audience-page" label="Loading segment"><PageHeader title={isNew ? 'Create segment' : 'Edit segment'} backTo="/audience/segments" actions={<ControlSkeleton width={121} />} /><SegmentEditorBodySkeleton /></LoadingRegion>
  const contacts = kind === 'contacts'
  return <LoadingRegion className="audience-page" label={`Loading ${kind}`}><AudienceHeader actions={<>{contacts && <ControlSkeleton width={120} />}<ControlSkeleton width={contacts ? 98 : kind === "lists" ? 85 : 121} /></>} />
    <div className="data-toolbar"><div className="cluster">{contacts ? <><SearchField className="search-box--list" aria-label="Search contacts" placeholder="Search email or name" disabled /><Select className="audience-status-filter" aria-label="Filter by consent" value="" onValueChange={() => {}} options={[{ value: '', label: 'All contacts' }]} disabled /><ControlSkeleton width={220} /></> : <ControlSkeleton width={320} />}</div></div>
    {kind !== 'segments' && <ConsentLegend />}
    <TableSkeleton columns={contacts ? contactColumns : kind === 'lists' ? listColumns : segmentColumns} rows={contacts ? 8 : 5} pagination />
  </LoadingRegion>
}
