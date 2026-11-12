// Receiving: Routes, Rituals and Endpoints, the words the API uses. One read (getInboundOverview) per screen.
import { useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Check } from 'lucide-react'
import { Button, DataTable, DropdownMenu, EmptyState, ErrorState, LoadingRegion, PageHeader, Pagination, SearchField, Select, StatusBadge, Tabs, useToast } from '../../components/ui'
import { useWorkspaceAccess } from '../../data/context'
import { request } from '../../data/live'
import { ApiError } from '../../data/types'
import { number } from '../../lib/format'
import { useCursorPagination } from '../../lib/pagination'
import { CreateAddressDialog } from './addresses'
import { concepts, guides, kindNote, kinds, type KindFilter } from './concepts'
import { NewInboxDialog } from './inboxes'
import { ConnectAgentButton } from '../docs/connect-agent'
import { ago, expiresIn, receivingDomains, useOverview, type Overview, type OverviewEndpoint, type RouteEntry } from './overview'
import { Chain, ConceptLine, Match, RitualIcon, RouteIcon, TargetIcon, Targets } from './parts'
import { CreatedEndpointDialog, endpointStatusLabel, endpointStatusTone, NewEndpointDialog, type Endpoint } from './ritual-connections'
import { RouteEditor } from './routing'
import '../settings/settings.css'
import './inbound.css'
import './receiving.css'
import { AddressList, PrivateAddress } from '../../components/PrivateAddress'

type Tab = 'routes' | 'rituals' | 'endpoints'
const PAGE = 50
const kindQuery: Record<KindFilter, { kind?: string; origin?: 'api' | 'auto' }> = {
  all: {}, address: { kind: 'address,route', origin: 'api' }, pattern: { kind: 'pattern' }, catch_all: { kind: 'catch_all' }, inbox: { kind: 'inbox' }, auto: { kind: 'address', origin: 'auto' },
}
const kindCount = (counts: Overview['counts'], kind: KindFilter) => kind === 'all' ? counts.address + counts.auto + counts.route + counts.pattern + counts.catch_all + counts.inbox
  : kind === 'address' ? counts.address + counts.route : counts[kind]
const errorText = (e: unknown) => e instanceof ApiError ? e.text : (e as Error).message

// Under each route's address: what it is, in a few words.
function note(r: RouteEntry) {
  const a = r.address
  if (r.kind === 'catch_all') return r.catchAll ? (r.catchAll === 'create_address' ? 'Catch-all · creates an address per recipient' : 'Catch-all · unknown addresses') : 'Catch-all route'
  if (r.kind === 'route') return kindNote.route
  if (r.kind === 'pattern') return a ? <>Pattern of <PrivateAddress value={a.address} /></> : kindNote.pattern
  if (r.kind === 'inbox') return [kindNote.inbox, a?.displayName, expiresIn(a?.expiresAt)].filter(Boolean).join(' · ')
  if (a?.origin === 'auto') return kindNote.auto
  const also = a?.aliases.length ? <>also <AddressList values={a.aliases.map(x => x.slice(0, x.indexOf('@') + 1))} /></> : null
  const parts = [a?.displayName, a?.expiresAt ? expiresIn(a.expiresAt) : null, also].filter(Boolean)
  return parts.length ? parts.map((part, i) => <span key={i}>{i > 0 && ' · '}{part}</span>) : 'Address'
}
// Where a row leads: its address or its agent inbox (real links). Every other route, including a domain's default
// catch-all, opens its own route editor here, never the domain's page (Back from there led to Domains, not Receiving).
const hrefOf = (r: RouteEntry) => r.kind === 'inbox' && r.address ? `/receiving/inboxes/${r.address.id}` : r.address ? `/receiving/addresses/${r.address.id}` : null

/** A new account: the three steps everything else builds on, each with the one action that starts it. */
function GettingStarted({ overview, onCreate }: { overview: Overview; onCreate: () => void }) {
  const live = overview.domains.filter(d => d.status === 'active'), sendOnly = overview.domains.filter(d => ['off', 'disabled'].includes(d.status))
  const step = (n: number, done: boolean, title: string, body: ReactNode, action: ReactNode) => <li className="rcv-step" data-done={done || undefined}>
    <span className="rcv-step__n" aria-hidden="true">{done ? <Check size={13} /> : n}</span><div className="rcv-step__body"><h3>{title}</h3><p className="muted">{body}</p>{action}</div></li>
  return <ol className="rcv-steps">
    {step(1, live.length > 0, 'Receive on a domain', live.length ? `${live.map(d => d.name).join(', ')} receives mail.` : sendOnly.length ? `${sendOnly.map(d => d.name).join(', ')} only sends. Publish its receiving MX record to get mail too.` : 'Add a domain and publish its receiving MX record.',
      !live.length && <Link className="ui-button ui-button--secondary ui-button--md" to={sendOnly[0] ? `/domains/${sendOnly[0].id}` : '/domains'}>Set up receiving</Link>)}
    {step(2, false, 'Create an address', <>Mail to it lands in the Inbox, where you, the API and agents read it. For example <code>support@{live[0]?.name ?? 'acme.com'}</code>.</>, <Button disabled={!live.length} onClick={onCreate}>New address</Button>)}
    {step(3, false, 'Choose what happens', <>Optional. A ritual labels, filters or sends mail on to an endpoint: Slack, Discord, a webhook or a forward.</>,
      <div className="cluster"><Link className="ui-button ui-button--ghost ui-button--md" to="/receiving/rituals">Write a ritual</Link><Link className="ui-button ui-button--ghost ui-button--md" to="/receiving?tab=endpoints">Add an endpoint</Link></div>)}
    <li className="rcv-steps__aside muted">Testing sign-up mail? An <Link to="/receiving/inboxes">agent inbox</Link> works before any DNS is set up.</li>
  </ol>
}

function RoutesTab({ overview, fetching, filters, setFilter, page, onPage, onCreate, onEditRoute }: { overview: Overview; fetching: boolean; filters: { kind: KindFilter; domain: string; q: string }; setFilter: (patch: Partial<{ kind: KindFilter; domain: string; q: string }>) => void; page: number; onPage: (next: number) => void; onCreate: () => void; onEditRoute: (r: RouteEntry) => void }) {
  const { canAdminister } = useWorkspaceAccess()
  const [newInbox, setNewInbox] = useState(false)
  const hosts = receivingDomains(overview.domains)
  const total = kindCount(overview.counts, 'all')
  if (!overview.manage && !total && !filters.q) return <EmptyState title="No addresses to show" description="Addresses you can read show up here." />
  if (overview.manage && !hosts.length && !total) return <GettingStarted overview={overview} onCreate={onCreate} />
  const rows = overview.routes.data
  const empty = filters.q ? { title: 'Nothing matches', description: `No route at ${filters.domain || 'any domain'} matches “${filters.q}”.` }
    : { title: filters.kind === 'all' ? 'No routes yet' : `No ${kinds[filters.kind].label.toLowerCase()} yet`, description: [kinds[filters.kind].line, kinds[filters.kind].example && `Example: ${kinds[filters.kind].example}`].filter(Boolean).join(' ') }
  const open = (r: RouteEntry) => { if (!hrefOf(r)) onEditRoute(r) }
  return <div className="stack rcv-tab">
    <div className="rcv-toolbar">
      <div className="rcv-filters" role="group" aria-label="Show">{(Object.keys(kinds) as KindFilter[]).filter(k => overview.manage || ['all', 'address', 'inbox', 'auto'].includes(k)).map(k =>
        <button key={k} type="button" className="rcv-filter" aria-pressed={filters.kind === k} onClick={() => setFilter({ kind: k })}>{kinds[k].label}<span>{number(kindCount(overview.counts, k))}</span></button>)}</div>
      <div className="rcv-toolbar__end">
        {hosts.length > 1 && <Select className="rcv-domain" aria-label="Domain" value={filters.domain || 'all'} onValueChange={v => setFilter({ domain: v === 'all' ? '' : v })} options={[{ value: 'all', label: 'All domains' }, ...hosts.map(d => ({ value: d.name, label: d.name }))]} />}
        <SearchField className="search-box--list" aria-label="Search routes" placeholder="Search address or name" value={filters.q} onChange={e => setFilter({ q: e.target.value })} />
      </div>
    </div>
    <div className="rcv-kindline">
      <ConceptLine line={kinds[filters.kind].line} example={kinds[filters.kind].example} guide={filters.kind === 'inbox' ? guides.inboxes : guides.receiving} />
      {canAdminister && filters.kind === 'inbox' && <div className="cluster"><ConnectAgentButton size="sm" /><Button size="sm" onClick={() => setNewInbox(true)}>New agent inbox</Button></div>}
      {canAdminister && filters.kind === 'address' && <Button size="sm" disabled={!hosts.length} onClick={onCreate}>New address</Button>}
    </div>
    <DataTable className="rcv-table" rows={rows} rowKey={r => r.id} rowHref={hrefOf} onRowClick={open} loading={false} minRows={Math.min(8, rows.length)}
      empty={<EmptyState title={empty.title} description={empty.description} action={!filters.q && filters.kind === 'address' && canAdminister ? <Button onClick={onCreate}>New address</Button> : undefined} />}
      columns={[
        // A route's card: the address (its link) and its unread count or last mail, what it is, then where its mail goes.
        { key: 'match', label: 'Route', width: '33%', render: r => <div className="rcv-cell"><RouteIcon entry={r} /><div className="settings-cell-stack"><Match value={r.match} host={!filters.domain} /><span className="muted receiving-clip">{note(r)}</span></div></div>,
          cardRender: r => <span className="rcv-cell"><RouteIcon entry={r} /><Match value={r.match} host={!filters.domain} /></span> },
        { key: 'note', label: 'Kind', table: false, card: 'line', render: r => note(r) },
        { key: 'rituals', label: 'Rituals', width: '17%', card: 'hide', render: r => <Chain keys={r.rituals} empty={overview.manage && r.address && r.kind !== 'pattern'
          ? <Link className="rcv-add" to={`/receiving/addresses/${r.address.id}#rituals`} onClick={e => e.stopPropagation()}>No ritual · add</Link> : <span className="muted">—</span>} /> },
        { key: 'to', label: 'Goes to', width: '32%', card: 'line', render: r => <Targets to={r.to} total={r.toTotal} ownId={r.address?.id} />, cardRender: r => <span className="rcv-card-to">{r.rituals.length > 0 && <><Chain keys={r.rituals} /><span aria-hidden="true">→</span></>}<Targets to={r.to} total={r.toTotal} ownId={r.address?.id} max={2} /></span> },
        { key: 'unread', label: 'Unread', align: 'right', width: '8%', card: 'hide', render: r => r.address && r.kind !== 'pattern' ? (r.address.stats.unreadThreads ? <strong>{number(r.address.stats.unreadThreads)}</strong> : <span className="muted">0</span>) : <span className="muted">—</span> },
        { key: 'last', label: 'Last mail', align: 'right', card: 'aside', render: r => r.address?.stats.lastMessageAt && r.kind !== 'pattern' ? ago(r.address.stats.lastMessageAt) : <span className="muted">—</span>,
          cardRender: r => r.address && r.kind !== 'pattern' ? <>{r.address.stats.unreadThreads > 0 && <strong className="rcv-unread">{number(r.address.stats.unreadThreads)} new</strong>}{r.address.stats.lastMessageAt ? ago(r.address.stats.lastMessageAt) : null}</> : null },
      ]} />
    <div className="rcv-foot" data-busy={fetching || undefined}>
      <span className="muted">{number(kindCount(overview.counts, filters.kind))} {kindCount(overview.counts, filters.kind) === 1 ? 'route' : 'routes'}{filters.domain ? ` at ${filters.domain}` : ''}</span>
      <Pagination page={page} pageSize={PAGE} total={kindCount(overview.counts, filters.kind)} nextCursor={overview.routes.nextCursor} onPageChange={onPage} />
    </div>
    <NewInboxDialog open={newInbox} onOpenChange={setNewInbox} />
  </div>
}

function RitualsTab({ overview }: { overview: Overview }) {
  const byName = new Map(overview.endpoints.filter(e => e.source === 'endpoint').map(e => [e.name, e]))
  return <div className="stack rcv-tab">
    <div className="rcv-kindline"><ConceptLine line={concepts.rituals.line} example={concepts.rituals.example} guide={guides.rituals} /><Link className="ui-button ui-button--secondary ui-button--sm" to="/receiving/rituals?new=1">New ritual</Link></div>
    <DataTable className="rcv-table" rows={overview.rituals} rowKey={r => r.key} rowHref={r => `/receiving/rituals?key=${encodeURIComponent(r.key)}`}
      empty={<EmptyState title="No rituals yet" description="A ritual is a short script that runs on a route’s mail. For example: if the subject mentions a refund, label it and post it to Slack." action={<Link className="ui-button ui-button--secondary ui-button--md" to="/receiving/rituals?new=1">Write a ritual</Link>} />}
      columns={[
        { key: 'key', label: 'Ritual', width: '20%', render: r => <span className="rcv-cell"><RitualIcon /><code>{r.key}</code></span> },
        { key: 'on', label: 'Runs on', width: '20%', card: 'line', render: r => r.attachedTo.length ? `${number(r.attachedTo.length)} ${r.attachedTo.length === 1 ? 'route' : 'routes'}` : <Link className="rcv-add" to={`/receiving/rituals?key=${encodeURIComponent(r.key)}#attach`} onClick={e => e.stopPropagation()}>Not attached · attach</Link> },
        { key: 'calls', label: 'Can send to', width: '34%', card: 'line', render: r => r.calls.length || r.delivers.length ? <span className="rcv-targets">{r.calls.map(c => { const e = byName.get(c); return <span key={c} className="rcv-target"><TargetIcon type={e?.type ?? 'webhook'} size={13} /><span>{c}</span></span> })}{r.delivers.map(k => <span key={k} className="rcv-target"><TargetIcon type="inbox" size={13} /><span>{k} inbox</span></span>)}</span> : <span className="muted">Labels and filters only</span> },
        { key: 'omens', label: <span title={concepts.omens.line}>Omens</span>, width: '12%', card: 'hide', render: r => r.omens.length ? <span title={concepts.omens.line}>{`${r.omens.length} AI ${r.omens.length === 1 ? 'question' : 'questions'}`}</span> : <span className="muted">None</span> },
        { key: 'try', label: '', align: 'right', render: r => <Link className="ui-button ui-button--ghost ui-button--sm" to={`/receiving/rituals?key=${encodeURIComponent(r.key)}#try`} onClick={e => e.stopPropagation()}>Try it</Link> },
      ]} />
  </div>
}

function EndpointsTab({ overview, refresh }: { overview: Overview; refresh: () => void }) {
  const toast = useToast()
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<(Endpoint & { secret?: string }) | null>(null)
  async function act(e: OverviewEndpoint, path: string, method: string, body: unknown, done: string) {
    try {
      const result = await request<{ ok?: boolean; error?: string | null }>(`/v1/endpoints/${encodeURIComponent(e.name)}${path}`, { method, ...(body === undefined ? {} : { body }) })
      toast(result.ok === false ? `${e.name} answered ${result.error ?? 'an error'}.` : done, result.ok === false ? 'error' : 'success')
      refresh()
    } catch (error) { toast(errorText(error), 'error') }
  }
  const used = (e: OverviewEndpoint) => [e.routes ? `${number(e.routes)} ${e.routes === 1 ? 'route' : 'routes'}` : null, e.rituals.length ? `ritual ${e.rituals.join(', ')}` : null, e.eventTypes.length ? `${e.eventTypes.length === 1 ? e.eventTypes[0] : `${e.eventTypes.length} events`}` : null].filter(Boolean).join(' · ')
  return <div className="stack rcv-tab">
    <div className="rcv-kindline"><ConceptLine line={concepts.endpoints.line} example={concepts.endpoints.example} guide={guides.endpoints} />
      <div className="cluster"><Link className="ui-button ui-button--ghost ui-button--sm" to="/receiving/webhooks">Event webhooks</Link><Button size="sm" onClick={() => setCreating(true)}>New endpoint</Button></div></div>
    <DataTable className="rcv-table" rows={overview.endpoints} rowKey={e => e.id} rowHref={e => e.source === 'inbound_webhook' ? `/receiving/webhooks/${e.id}` : null}
      empty={<EmptyState title="No endpoints yet" description="An endpoint is a named place rituals and routes send mail: Slack, Discord, a webhook or a forward. For example, a ritual calls endpoints.support({ text: email.subject })." action={<Button onClick={() => setCreating(true)}>New endpoint</Button>} />}
      columns={[
        { key: 'name', label: 'Endpoint', width: '30%', render: e => <div className="rcv-cell"><TargetIcon type={e.type} /><div className="settings-cell-stack"><span>{e.call ? <code>{e.call}</code> : e.name}</span><span className="muted receiving-clip"><PrivateAddress value={e.target} /></span></div></div>,
          cardRender: e => <span className="rcv-cell"><TargetIcon type={e.type} />{e.call ? <code>{e.call}</code> : e.name}</span> },
        { key: 'target', label: 'Target', table: false, card: 'line', render: e => <PrivateAddress value={e.target} /> },
        { key: 'type', label: 'Type', width: '14%', card: 'hide', render: e => e.source === 'inbound_webhook' ? 'Inbound webhook' : { webhook: 'Webhook', slack: 'Slack', discord: 'Discord', forward: 'Forward' }[e.type] },
        { key: 'used', label: 'Used by', width: '30%', card: 'line', render: e => used(e) || <span className="muted">Nothing yet</span> },
        { key: 'status', label: 'Status', width: '16%', card: 'aside', render: e => <StatusBadge status={endpointStatusLabel[e.status]} tone={endpointStatusTone[e.status]} /> },
        { key: 'actions', label: '', width: 52, align: 'right', render: e => e.source === 'inbound_webhook' ? <span /> : <DropdownMenu label={`Actions for ${e.name}`} items={[
          ...(e.type !== 'forward' ? [{ label: 'Send a test message', onSelect: () => void act(e, '/test', 'POST', undefined, `Test posted to ${e.call}.`) }] : []),
          ...(e.type === 'forward' && e.status !== 'ready' ? [{ label: 'Resend confirmation', onSelect: () => void act(e, '/verification', 'POST', {}, 'Confirmation email queued.') }] : []),
          { label: e.status === 'paused' ? 'Resume' : 'Pause', onSelect: () => void act(e, '', 'PATCH', { paused: e.status !== 'paused' }, e.status === 'paused' ? 'Resumed.' : 'Paused. Calls wait until you resume.') },
          { label: 'Delete', destructive: true, onSelect: () => void act(e, '', 'DELETE', undefined, `${e.name} deleted.`) },
        ]} /> },
      ]} />
    {overview.endpointsTruncated && <p className="muted rcv-truncated">Showing the first 100 endpoints and 100 inbound webhooks. <Link to="/receiving/webhooks">Event webhooks</Link> lists every inbound webhook.</p>}
    <NewEndpointDialog open={creating} onOpenChange={setCreating} onCreated={e => { setCreating(false); setCreated(e); refresh() }} />
    <CreatedEndpointDialog created={created} onClose={() => setCreated(null)} />
  </div>
}

export function ReceivingPage() {
  const [params, setParams] = useSearchParams()
  const { canAdminister } = useWorkspaceAccess()
  const tab = (['routes', 'rituals', 'endpoints'].includes(params.get('tab') ?? '') ? params.get('tab') : 'routes') as Tab
  const kind = (params.get('kind') ?? 'all') as KindFilter
  const filters = { kind: kind in kinds ? kind : 'all' as KindFilter, domain: params.get('domain') ?? '', q: params.get('q') ?? '' }
  const pagination = useCursorPagination()
  const overview = useOverview({ ...kindQuery[filters.kind], domain: filters.domain || undefined, q: filters.q.trim() || undefined, cursor: pagination.cursor, limit: PAGE }, true)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<RouteEntry | null>(null)
  function update(patch: Record<string, string | null | undefined>) {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) { if (v === null || v === undefined || v === '' || (k === 'kind' && v === 'all') || (k === 'tab' && v === 'routes')) next.delete(k); else next.set(k, v) }
    setParams(next, { replace: true })
    pagination.reset()
  }
  const data = overview.data
  const manage = data?.manage ?? canAdminister
  const firstAddress = manage && !!data && data.counts.address + data.counts.route === 0
  const counts = data && { routes: kindCount(data.counts, 'all'), rituals: data.rituals.length, endpoints: data.endpoints.length }
  return <div className="stack inbound-stack">
    <PageHeader title="Receiving" actions={<>
      {manage && <Link className="ui-button ui-button--secondary ui-button--md" to="/receiving/trace">Trace</Link>}
      {/* The first address is the next thing to do until there is one; after that, reading mail is. */}
      {manage && <Button variant={firstAddress ? 'primary' : 'secondary'} disabled={!data || !receivingDomains(data.domains).length} onClick={() => setCreating(true)}>New address</Button>}
      <Link className={`ui-button ui-button--${firstAddress ? 'secondary' : 'primary'} ui-button--md`} to="/receiving/inbox">Inbox</Link>
    </>} />
    {overview.error && !data ? <ErrorState error={overview.error} onRetry={() => void overview.refetch()} /> : !data || !counts ? <LoadingRegion label="Loading receiving"><div className="rcv-skeleton" aria-hidden="true"><span /><span /><span /><span /></div></LoadingRegion> : <div className="rcv-page">
      <Tabs label="Receiving" value={tab} onValueChange={value => update({ tab: value, kind: null })}
        items={[{ value: 'routes', label: concepts.routes.title, count: counts.routes }, ...(data.manage ? [{ value: 'rituals', label: concepts.rituals.title, count: counts.rituals }, { value: 'endpoints', label: concepts.endpoints.title, count: counts.endpoints }] : [])]} />
      {tab === 'rituals' && data.manage ? <RitualsTab overview={data} />
        : tab === 'endpoints' && data.manage ? <EndpointsTab overview={data} refresh={() => void overview.refetch()} />
        : <RoutesTab overview={data} fetching={overview.isFetching} filters={filters} onCreate={() => setCreating(true)} onEditRoute={setEditing}
          page={pagination.page} onPage={next => pagination.onPageChange(next, data.routes.nextCursor)} setFilter={patch => update(patch)} />}
    </div>}
    {data && <CreateAddressDialog open={creating} onOpenChange={setCreating} domains={data.domains} />}
    {editing && <RouteEditor match={editing.match} route={editing.route} onClose={() => { setEditing(null); void overview.refetch() }} />}
  </div>
}
