import { ChevronRight, Paperclip } from 'lucide-react'
import { StatusBadge, type Column, type SkeletonColumn } from '../../components/ui'
import { PrivateAddress } from '../../components/PrivateAddress'
import type { LogEntry } from '../../data/types'
import { useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import { routeChunks, usePrefetchQueries } from '../../data/prefetch'
import { date, label } from '../../lib/format'
import { receivedTo } from '../../lib/private-address'

// One log row, shared by Logs and Overview's latest emails: the same columns, masking and click-through in both.
// On a phone each row is a card: the subject (the link) and the time, then direction, status and the other party.
export const logColumnDefs: SkeletonColumn[] = [
  { key: 'time', label: 'Time · UTC', width: 140, card: 'aside' }, { key: 'direction', label: <span className="sr-only">Direction</span>, width: 48, card: 'line' },
  { key: 'status', label: 'Status', width: 124, card: 'inline' }, { key: 'from', label: 'From', width: '14%', card: 'inline' }, { key: 'to', label: 'To', width: '14%', card: 'hide' },
  { key: 'subject', label: 'Subject', card: 'title' }, { key: 'stream', label: 'Stream', width: 116, card: 'hide' }, { key: 'open', label: '', width: 28, card: 'hide' },
]

export const logTimestamp = (value: string) => date(value, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'UTC' })
// A card's time: the hour today, the date before that (UTC, like the table).
const cardTime = (value: string) => date(value, value.slice(0, 10) === new Date().toISOString().slice(0, 10) ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' } : { month: 'short', day: 'numeric', timeZone: 'UTC' })
// Sent and received mail open at /logs/:id; received message IDs start with msg_.
export const logHref = (row: Pick<LogEntry, 'id'>) => `/logs/${encodeURIComponent(row.id)}`
export const isReceivedId = (id: string) => id.startsWith('msg_')
// A row about to be opened: warm its detail read (and the Logs code, from Overview).
export function useLogRowIntent() {
  const warm = usePrefetchQueries()
  const { canAdminister } = useWorkspaceAccess()
  return (row: Pick<LogEntry, 'id'>) => { void routeChunks['/logs']?.().catch(() => {}); void warm([isReceivedId(row.id) ? queries.receivedEmail(row.id, canAdminister) : queries.email(row.id)]) }
}

// Who received mail was for (lib/private-address.ts), masked like every address.
function ReceivedTo({ row }: { row: LogEntry }) {
  const to = receivedTo(row)
  return to ? <PrivateAddress value={to} /> : <span className="muted">—</span>
}
function SentTo({ to }: { to: string[] }) {
  if (!to.length) return <span className="muted">—</span>
  return <PrivateAddress value={to[0]!}>{to.length > 1 && <span className="muted">&nbsp;+{to.length - 1}</span>}</PrivateAddress>
}

export const logColumns: Column<LogEntry>[] = [
  { ...logColumnDefs[0]!, render: row => <span className="muted" title={row.at}>{logTimestamp(row.at)}</span>, cardRender: row => <time dateTime={row.at} title={`${logTimestamp(row.at)} UTC`}>{cardTime(row.at)}</time> },
  { ...logColumnDefs[1]!, render: row => <span className="log-direction" data-direction={row.direction} title={row.direction === 'sent' ? 'Sent' : 'Received'}>{row.direction === 'sent' ? 'Out' : 'In'}</span> },
  { ...logColumnDefs[2]!, render: row => row.direction === 'sent' ? <StatusBadge status={row.status} /> : row.status === 'spam' ? <StatusBadge status="Spam" tone="danger" /> : <StatusBadge status="Received" tone="success" /> },
  { ...logColumnDefs[3]!, render: row => <PrivateAddress value={row.from.address} />, cardRender: row => row.direction === 'sent' ? <>To <SentTo to={row.to} /></> : <>From <PrivateAddress value={row.from.address} /></> },
  { ...logColumnDefs[4]!, render: row => row.direction === 'sent' ? <SentTo to={row.to} /> : <ReceivedTo row={row} /> },
  { ...logColumnDefs[5]!, render: row => <span className="log-subject" title={row.subject}>{(row.attachmentCount ?? 0) > 0 && <Paperclip size={12} aria-label={`${row.attachmentCount} attachment${row.attachmentCount === 1 ? '' : 's'}`} />}<span className={row.subject ? undefined : 'muted'}>{row.subject || '(no subject)'}</span></span> },
  { ...logColumnDefs[6]!, render: row => <span className="muted">{row.stream ? label(row.stream) : '—'}</span> },
  { ...logColumnDefs[7]!, render: () => <ChevronRight size={14} aria-hidden /> },
]

// The Logs page gives Status the room its longest label needs ("Acceptance unknown"); Overview keeps the compact column.
const wide = <T extends { key: string; width?: number | string }>(columns: T[]): T[] => columns.map(column => column.key === 'status' ? { ...column, width: 172 } : column)
export const logsPageColumns = wide(logColumns)
export const logsPageColumnDefs = wide(logColumnDefs)

// CSV is an explicit export: addresses in full, like the detail pages.
export function logCsvRows(rows: LogEntry[], regions: boolean): string[][] {
  return [['Direction', 'Time', 'Status', 'From', 'To', 'Subject', 'Stream', ...regions ? ['Region'] : []],
    ...rows.map(row => [row.direction, row.at, row.status, row.from.address, (row.direction === 'received' ? row.envelopeTo ?? row.to : row.to).join(' '), row.subject, row.stream ?? '', ...regions ? [row.regionId ?? ''] : []])]
}
