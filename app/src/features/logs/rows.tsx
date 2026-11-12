import { ChevronRight, Paperclip } from 'lucide-react'
import { StatusBadge, type Column, type SkeletonColumn } from '../../components/ui'
import { PrivateAddress } from '../../components/PrivateAddress'
import type { LogEntry } from '../../data/types'
import { useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import { routeChunks, usePrefetchQueries } from '../../data/prefetch'
import { date, label } from '../../lib/format'
import { receivedTo } from '../../lib/received-to'

// One log row, shared by Logs and Overview's latest emails: the same columns, masking and click-through in both.
export const logColumnDefs: SkeletonColumn[] = [
  { key: 'time', label: 'Time · UTC', width: 140 }, { key: 'direction', label: <span className="sr-only">Direction</span>, width: 48 },
  { key: 'status', label: 'Status', width: 104 }, { key: 'from', label: 'From', width: '14%' }, { key: 'to', label: 'To', width: '14%' },
  { key: 'subject', label: 'Subject' }, { key: 'stream', label: 'Stream', width: 116 }, { key: 'open', label: '', width: 28 },
]

export const logTimestamp = (value: string) => date(value, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'UTC' })
// Sent and received mail open at /logs/:id; received message IDs start with msg_.
export const logHref = (row: Pick<LogEntry, 'id'>) => `/logs/${encodeURIComponent(row.id)}`
export const isReceivedId = (id: string) => id.startsWith('msg_')
// A row about to be opened: warm its detail read (and the Logs code, from Overview).
export function useLogRowIntent() {
  const warm = usePrefetchQueries()
  const { canAdminister } = useWorkspaceAccess()
  return (row: Pick<LogEntry, 'id'>) => { void routeChunks['/logs']?.().catch(() => {}); void warm([isReceivedId(row.id) ? queries.receivedEmail(row.id, canAdminister) : queries.email(row.id)]) }
}

// The receiving address mail arrived at is ours and shows in full; the header To may name other people, so it is masked.
function ReceivedTo({ row }: { row: LogEntry }) {
  const to = receivedTo(row)
  const title = row.addresses?.length ? `Delivered to ${row.addresses.map(a => a.address).join(', ')}` : row.addresses ? 'Unrouted' : undefined
  if (to?.own) return <span title={title}>{to.address}</span>
  return to ? <PrivateAddress value={to.address} /> : <span className="muted">—</span>
}
function SentTo({ to }: { to: string[] }) {
  if (!to.length) return <span className="muted">—</span>
  return <PrivateAddress value={to[0]!}>{to.length > 1 && <span className="muted">&nbsp;+{to.length - 1}</span>}</PrivateAddress>
}

export const logColumns: Column<LogEntry>[] = [
  { ...logColumnDefs[0]!, render: row => <span className="muted" title={row.at}>{logTimestamp(row.at)}</span> },
  { ...logColumnDefs[1]!, render: row => <span className="log-direction" data-direction={row.direction} title={row.direction === 'sent' ? 'Sent' : 'Received'}>{row.direction === 'sent' ? 'Out' : 'In'}</span> },
  { ...logColumnDefs[2]!, render: row => row.direction === 'sent' ? <StatusBadge status={row.status} /> : row.status === 'spam' ? <StatusBadge status="Spam" tone="danger" /> : <StatusBadge status="Received" tone="success" /> },
  // Sent: our From in full. Received: the sender is someone else, so it is masked.
  { ...logColumnDefs[3]!, render: row => row.direction === 'sent' ? <span title={row.from.name ? `${row.from.name} <${row.from.address}>` : row.from.address}>{row.from.address}</span> : <PrivateAddress value={row.from.address} /> },
  { ...logColumnDefs[4]!, render: row => row.direction === 'sent' ? <SentTo to={row.to} /> : <ReceivedTo row={row} /> },
  { ...logColumnDefs[5]!, render: row => <span className="log-subject" title={row.subject}>{(row.attachmentCount ?? 0) > 0 && <Paperclip size={12} aria-label={`${row.attachmentCount} attachment${row.attachmentCount === 1 ? '' : 's'}`} />}<span className={row.subject ? undefined : 'muted'}>{row.subject || '(no subject)'}</span></span> },
  { ...logColumnDefs[6]!, render: row => <span className="muted">{row.stream ? label(row.stream) : '—'}</span> },
  { ...logColumnDefs[7]!, render: () => <ChevronRight size={14} aria-hidden /> },
]

// CSV is an explicit export: addresses in full, like the detail pages.
export function logCsvRows(rows: LogEntry[], regions: boolean): string[][] {
  return [['Direction', 'Time', 'Status', 'From', 'To', 'Subject', 'Stream', ...regions ? ['Region'] : []],
    ...rows.map(row => [row.direction, row.at, row.status, row.from.address, (row.direction === 'received' ? row.envelopeTo ?? row.to : row.to).join(' '), row.subject, row.stream ?? '', ...regions ? [row.regionId ?? ''] : []])]
}
