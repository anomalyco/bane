import { forwardRef, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { useLocation } from 'react-router'
import { useSession } from '../../data/context'
import { Button, type ButtonProps, LoadingRegion, PageHeader, SearchField, SectionHeader, Select, Skeleton, TableSkeleton, Tabs, type SkeletonColumn } from '../../components/ui'
import './operator.css'

// The operator console's column definitions (card slots included), shared by the route skeleton and the loaded tables.
export const queueColumnDefs: SkeletonColumn[] = [
  { key: 'name', label: 'Workspace', width: '22%' },
  { key: 'step', label: 'Step', width: 112, card: 'aside' },
  { key: 'reason', label: 'Why', card: 'line' },
  { key: 'score', label: 'Score', width: 72, align: 'right', card: 'line' },
  { key: 'limit', label: 'Daily limit', width: 104, align: 'right', card: 'inline' },
  { key: 'since', label: 'Since', width: 160, card: 'inline' },
]
export const actionColumnDefs: SkeletonColumn[] = [
  { key: 'action', label: 'Action', width: '20%' },
  { key: 'at', label: 'When', width: 160, card: 'aside' },
  { key: 'workspace', label: 'Workspace', width: '18%', card: 'line' },
  { key: 'reason', label: 'Reason', card: 'line' },
  { key: 'ticket', label: 'Ticket', width: 140, card: 'inline' },
]
export const factorColumnDefs: SkeletonColumn[] = [
  { key: 'factor', label: 'Factor', width: '30%' },
  { key: 'score', label: 'Score', width: 80, align: 'right', card: 'aside' },
  { key: 'value', label: 'Value', width: 96, align: 'right', card: 'line' },
  { key: 'weight', label: 'Weight', width: 80, align: 'right', card: 'inline' },
  { key: 'points', label: 'Points', width: 80, align: 'right', card: 'inline' },
]
export const domainColumnDefs: SkeletonColumn[] = [
  { key: 'name', label: 'Domain', width: '30%' },
  { key: 'pool', label: 'Pool', width: 112, card: 'aside' },
  { key: 'region', label: 'Region', width: 112, card: 'line' },
  { key: 'dkim', label: 'DKIM', width: 80, card: 'inline' },
  { key: 'mailFrom', label: 'MAIL FROM', width: 104, card: 'inline' },
  { key: 'dmarc', label: 'DMARC', width: 112, card: 'inline' },
]
export const memberColumnDefs: SkeletonColumn[] = [
  { key: 'email', label: 'Email', width: '40%' },
  { key: 'role', label: 'Role', width: 120, card: 'aside' },
  { key: 'user', label: 'User', card: 'line' },
  { key: 'billing', label: 'Billing', width: 180, card: 'line' },
  { key: 'actions', label: '', width: 48, card: 'end' },
]
export const campaignColumnDefs: SkeletonColumn[] = [
  { key: 'name', label: 'Campaign', width: '30%' },
  { key: 'state', label: 'State', width: 112, card: 'aside' },
  { key: 'pause', label: 'Pause reason', card: 'line' },
  { key: 'quarantines', label: 'Quarantines', width: 112, align: 'right', card: 'inline' },
  { key: 'actions', label: '', width: 56, align: 'right', card: 'end' },
]
export const timelineColumnDefs: SkeletonColumn[] = [
  { key: 'title', label: 'Event', width: '40%' },
  { key: 'kind', label: 'Kind', width: 112, card: 'aside' },
  { key: 'detail', label: 'Detail', card: 'line' },
  { key: 'at', label: 'When', width: 160, card: 'line' },
]

// UI notes (/operator/notes): staff's design and bug notes on the dashboard. The screenshot and selection columns are
// for the table; a phone's card shows the note, its status, page, type and age.
export const noteColumnDefs: SkeletonColumn[] = [
  { key: 'select', label: '', width: 40, card: 'hide' },
  { key: 'shot', label: 'Screenshot', width: 96, card: 'hide' },
  { key: 'note', label: 'Note', card: 'title' },
  { key: 'status', label: 'Status', width: 124, card: 'aside' },
  { key: 'page', label: 'Page', width: '20%', card: 'line' },
  { key: 'kind', label: 'Type', width: 104, card: 'inline' },
  { key: 'created', label: 'Left', width: 168, card: 'inline' },
  { key: 'actions', label: '', width: 48, align: 'right', card: 'end' },
]
export const noteStatusOptions = [{ value: '', label: 'Open and in progress' }, { value: 'open', label: 'Open' }, { value: 'in_progress', label: 'In progress' }, { value: 'fixed', label: 'Fixed' }, { value: 'wontfix', label: 'Won’t fix' }, { value: 'all', label: 'All notes' }]
export const noteKindOptions = [{ value: '', label: 'All types' }, ...['alignment', 'spacing', 'copy', 'bug', 'motion', 'mobile', 'other'].map(kind => ({ value: kind, label: kind[0]!.toUpperCase() + kind.slice(1) }))]
export function NotesToolbar({ search = '', status = '', kind = '', onSearch, onStatus, onKind, actions, disabled = false }: { search?: string; status?: string; kind?: string; onSearch?: (value: string) => void; onStatus?: (value: string) => void; onKind?: (value: string) => void; actions?: ReactNode; disabled?: boolean }) {
  return <div className="data-toolbar"><div className="cluster">
    <SearchField className="search-box--list" aria-label="Search notes and pages" placeholder="Search notes and pages" value={search} disabled={disabled} onChange={event => onSearch?.(event.target.value)} />
    <Select aria-label="Filter by status" value={status} onValueChange={value => onStatus?.(value)} disabled={disabled} options={noteStatusOptions} />
    <Select aria-label="Filter by type" value={kind} onValueChange={value => onKind?.(value)} disabled={disabled} options={noteKindOptions} />
  </div>{actions ?? <Button className="op-bulk" disabled>Select notes <ChevronDown size={14} aria-hidden="true" /></Button>}</div>
}
export function OperatorNotesSkeleton() {
  return <>
    <PageHeader title="Operator" actions={<Button disabled>Agent keys</Button>} />
    <LoadingRegion label="Loading UI notes"><div className="op-page">
      <Tabs value="notes" onValueChange={() => {}} disabled items={notesTabs} label="Operator views" />
      <NotesToolbar disabled />
      <TableSkeleton className="op-notes" columns={noteColumnDefs} rows={6} />
    </div></LoadingRegion>
  </>
}

const baseTabs = [{ value: 'queue', label: 'Review queue' }, { value: 'actions', label: 'Actions' }]
const notesTabs = [...baseTabs, { value: 'notes', label: 'UI notes' }]
/** UI notes has a tab only for the people the API allows (GET /v1/me uiNotes). */
export const useOperatorTabs = () => useSession()?.identity?.uiNotes === true ? notesTabs : baseTabs
export const facts = ['Step', 'Score', 'Daily limit', 'Since', 'Strikes', 'Connection'] as const

export const stepOptions = [{ value: '', label: 'Needs review' }, { value: 'pause', label: 'Paused' }, { value: 'restrict', label: 'Restricted' }, { value: 'warn', label: 'Warned' }, { value: 'notice', label: 'Notice' }]
// Search spans every workspace (by ID or name); the step filter narrows the queue.
export function QueueToolbar({ search = '', step = '', onSearch, onStep, disabled = false }: { search?: string; step?: string; onSearch?: (value: string) => void; onStep?: (value: string) => void; disabled?: boolean }) {
  return <div className="data-toolbar"><div className="cluster">
    <SearchField className="search-box--list" aria-label="Search all workspaces" placeholder="Search all workspaces" value={search} disabled={disabled} onChange={event => onSearch?.(event.target.value)} />
    <Select aria-label="Filter by step" value={step} onValueChange={value => onStep?.(value)} disabled={disabled || search.trim() !== ''} options={stepOptions} />
  </div></div>
}
export function OperatorQueueSkeleton({ view = 'queue' }: { view?: string }) {
  return <>
    <PageHeader title="Operator" />
    <LoadingRegion label="Loading the review queue"><div className="op-page">
      <Tabs value={view} onValueChange={() => {}} disabled items={useOperatorTabs()} label="Operator views" />
      {view === 'queue' && <QueueToolbar disabled />}
      <TableSkeleton columns={view === 'queue' ? queueColumnDefs : actionColumnDefs} rows={6} />
    </div></LoadingRegion>
  </>
}
export function WorkspaceBodySkeleton() {
  return <div className="op-page" aria-hidden="true">
    <dl className="op-facts">{facts.map(title => <div key={title}><dt>{title}</dt><dd><Skeleton width={88} height={14} /></dd></div>)}</dl>
    <div className="op-grid"><section className="op-section"><SectionHeader title="Standing" /><Skeleton height={168} /></section><section className="op-section"><SectionHeader title="Limit" /><Skeleton height={168} /></section></div>
    <section className="op-section"><SectionHeader title="Factors" /><TableSkeleton columns={factorColumnDefs} rows={6} /></section>
  </div>
}
// The workspace's actions menu trigger. It forwards its props and ref, so the menu (or a phone's action sheet) can open from it.
export const ActionsTrigger = forwardRef<HTMLButtonElement, ButtonProps>(function ActionsTrigger(props, ref) {
  return <Button {...props} ref={ref}>Actions <ChevronDown size={14} aria-hidden="true" /></Button>
})
export function OperatorWorkspaceSkeleton({ actions }: { actions: boolean }) {
  return <>
    <PageHeader title="Workspace" backTo="/operator" actions={actions ? <ActionsTrigger disabled /> : undefined} />
    <LoadingRegion label="Loading the workspace"><WorkspaceBodySkeleton /></LoadingRegion>
  </>
}
// The route-level placeholder while the operator chunk loads.
export function OperatorRouteSkeleton({ operator }: { operator: 'operator' | 'operator:read' | null | undefined }) {
  const { pathname, search } = useLocation(), uiNotes = useSession()?.identity?.uiNotes === true
  if (!operator) return null
  if (pathname === '/operator/notes') return uiNotes ? <OperatorNotesSkeleton /> : null
  return pathname.startsWith('/operator/workspaces/') ? <OperatorWorkspaceSkeleton actions={operator === 'operator'} /> : <OperatorQueueSkeleton view={new URLSearchParams(search).get('view') === 'actions' ? 'actions' : 'queue'} />
}
