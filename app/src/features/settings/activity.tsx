import { useState, type ReactNode } from 'react'
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query'
import { Button, CopyButton, DataTable, Dialog, EmptyState, ErrorState, SectionHeader, Select, StatusBadge } from '../../components/ui'
import { useApi } from '../../data/context'
import { actionLabel, activityApi, activityAreas, type AuditEntry } from '../../data/activity'
import { relativeTime, shortDateTime } from '../../lib/format'
import { PrivateAddress } from '../../components/PrivateAddress'
import { settingsColumns } from './skeletons'

// Settings → Activity (hosted, owners and admins): what happened in this workspace, newest first, 50 at a time.
// Rows are one line each (53px); a row opens its details (before → after, reason, request ID).
const credential: Partial<Record<AuditEntry['actor']['type'], string>> = { api_key: 'API key', mcp_grant: 'MCP client', agent_token: 'Agent token', inbox_key: 'Inbox key', app_password: 'App password' }
function Who({ actor }: { actor: AuditEntry['actor'] }) {
  if (actor.type === 'member') return actor.email ? <PrivateAddress value={actor.email} /> : <>{actor.label ?? 'A member'}</>
  // Support reading the workspace under a grant stands out from everything the workspace did itself.
  if (actor.type === 'support') return <StatusBadge status="Bane support" tone="info" />
  if (actor.type === 'system' || actor.type === 'operator') return <>Bane</>
  if (actor.type === 'stripe') return <>Stripe</>
  const detail = actor.label ?? actor.id
  return <>{credential[actor.type] ?? actor.type}{detail && <span className="muted"> · {detail}</span>}</>
}
const record = (value: unknown): Record<string, unknown> | null => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
// The object's name from the summary when it has one (a key's name, a domain, an address), else its ID.
function targetName(entry: AuditEntry) {
  const after = record(entry.summary.after), before = record(entry.summary.before)
  for (const source of [after, before, entry.summary]) for (const key of ['name', 'description', 'address', 'domain', 'email']) {
    const value = source?.[key]
    if (typeof value === 'string' && value) return value
  }
  return entry.target?.id ?? null
}
function Target({ entry }: { entry: AuditEntry }) {
  const name = targetName(entry)
  return name ? <PrivateAddress value={name} /> : <span className="muted">—</span>
}
// Where it came from: the client family and network, or, without a client (support, jobs, webhooks), the channel.
const channel: Record<string, string> = { dashboard: 'Dashboard', api: 'API', mcp: 'MCP', imap: 'IMAP', smtp: 'SMTP', console: 'Bane', support: 'Bane support', script: 'Bane', job: 'Bane', webhook: 'Webhook' }
const source = (entry: AuditEntry) => entry.client ?? channel[entry.via] ?? entry.via
const fromText = (entry: AuditEntry) => [source(entry), entry.network].filter(Boolean).join(' · ')
function When({ at }: { at: string }) {
  return <time dateTime={at} title={`${shortDateTime(at)} UTC`}>{relativeTime(at)}</time>
}

export function ActivitySection() {
  const api = useApi()
  const [area, setArea] = useState('')
  const [open, setOpen] = useState<AuditEntry | null>(null)
  const activity = useInfiniteQuery({
    queryKey: ['bane', api.mode, 'activity', area],
    queryFn: ({ pageParam, signal }) => activityApi.list({ action: area || undefined, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  })
  const rows = activity.data?.pages.flatMap(page => page.data) ?? []
  const [when, who, action, target, from] = settingsColumns.activity
  return <section className="section stack activity">
    <SectionHeader title="Activity" actions={<Select className="activity-filter" aria-label="Show activity for" value={area} onValueChange={setArea} options={[{ value: '', label: 'All activity' }, ...activityAreas]} />} />
    {activity.error && !activity.data ? <ErrorState error={activity.error} onRetry={() => void activity.refetch()} /> : <DataTable className="activity-table" loading={activity.isPending} skeletonRows={8} minRows={3} rows={rows} rowKey={entry => entry.id} onRowClick={setOpen}
      empty={<EmptyState title={area ? 'No matching activity' : 'No activity yet'} description={area ? undefined : 'Changes to members, keys, domains, webhooks and settings appear here.'} />} columns={[
        { ...when, render: entry => <When at={entry.at} /> },
        { ...who, render: entry => <span className="activity-cell"><Who actor={entry.actor} /></span>, cardRender: entry => <Who actor={entry.actor} /> },
        { ...action, render: entry => <span className="activity-cell" title={entry.action}>{actionLabel(entry.action)}</span>, cardRender: entry => actionLabel(entry.action) },
        { ...target, render: entry => <span className="activity-cell"><Target entry={entry} /></span>, cardRender: entry => <Target entry={entry} /> },
        { ...from, render: entry => <div className="settings-cell-stack activity-from"><span title={source(entry)}>{source(entry)}</span><span title={entry.network ?? undefined}>{entry.network ?? ''}</span></div>, cardRender: fromText },
      ]} />}
    {activity.hasNextPage && <div className="activity-more"><Button loading={activity.isFetchingNextPage} onClick={() => void activity.fetchNextPage()}>Load more</Button></div>}
    {activity.isFetchNextPageError ? <ErrorState error={activity.error} onRetry={() => void activity.fetchNextPage()} /> : null}
    <ActivityDetails entry={open} onClose={() => setOpen(null)} />
  </section>
}

// A summary value as one short line: strings as they are, everything else as compact JSON.
const show = (value: unknown) => value === undefined ? '—' : typeof value === 'string' ? value : JSON.stringify(value)
function Changes({ summary }: { summary: Record<string, unknown> }) {
  const before = record(summary.before), after = record(summary.after)
  const rows: { key: string; value: ReactNode }[] = []
  if (before || after) for (const key of [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])]) {
    const was = before?.[key], now = after?.[key]
    if (JSON.stringify(was) === JSON.stringify(now)) continue
    rows.push({ key, value: before && after ? <><span className="muted">{show(was)}</span> → {show(now)}</> : show(after ? now : was) })
  }
  else for (const key of ['before', 'after'].filter(key => key in summary)) rows.push({ key, value: show(summary[key]) })
  for (const [key, value] of Object.entries(summary)) if (key !== 'before' && key !== 'after') rows.push({ key, value: show(value) })
  if (!rows.length) return <p className="muted activity-none">No details recorded.</p>
  return <dl className="activity-changes">{rows.map(row => <div key={row.key}><dt>{row.key}</dt><dd>{row.value}</dd></div>)}</dl>
}
function ActivityDetails({ entry, onClose }: { entry: AuditEntry | null; onClose: () => void }) {
  return <Dialog open={entry !== null} onOpenChange={open => { if (!open) onClose() }} title={entry ? actionLabel(entry.action) : ''} description={entry ? `${shortDateTime(entry.at)} UTC · via ${channel[entry.via] ?? entry.via}` : undefined} footer={<Button onClick={onClose}>Close</Button>}>
    {entry && <div className="stack">
      <dl className="settings-facts activity-facts">
        <div><dt>Who</dt><dd><Who actor={entry.actor} /></dd></div>
        <div><dt>Target</dt><dd>{entry.target ? <><Target entry={entry} />{targetName(entry) !== entry.target.id && entry.target.id && <span className="muted"> · <code>{entry.target.id}</code></span>}</> : '—'}</dd></div>
        <div><dt>From</dt><dd>{fromText(entry)}</dd></div>
        {entry.reason && <div className="settings-fact-wide"><dt>Reason</dt><dd>{entry.reason}</dd></div>}
        <div className="settings-fact-wide"><dt>Request ID</dt><dd>{entry.requestId ? <span className="cluster settings-inline"><code>{entry.requestId}</code><CopyButton value={entry.requestId} label="Copy request ID" /></span> : '—'}</dd></div>
      </dl>
      <div className="stack activity-summary"><h3>Changes</h3><Changes summary={entry.summary} /></div>
    </div>}
  </Dialog>
}
