// Direction 2: addresses first. Every "mail to" (address, alias, pattern, route, catch-all, agent inbox) is one row that
// reads left to right: Mail to → Then (rituals) → Goes to. Rituals and destinations are libraries beside it.
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { Button, DataTable, EmptyState, ErrorState, Input, PageHeader, Pagination, Select, StatusBadge, Tabs } from '../../../components/ui'
import { useWorkspaceAccess } from '../../../data/context'
import { number } from '../../../lib/format'
import { CreateAddressDialog } from '../addresses'
import { ago, destKindLabel, entryKindLabel, expiresIn, plural, useReceivingModel, type Entry, type EntryKind, type Model } from './model'
import { Chain, DestIcon, DestNames, EntryIcon, Match, RitualIcon } from './parts'
import { GettingStarted, PitchSkeleton } from './shared-views'

const filters: { value: 'all' | EntryKind | 'patterns'; label: string; kinds?: EntryKind[] }[] = [
  { value: 'all', label: 'All' }, { value: 'address', label: 'Addresses', kinds: ['address', 'temporary'] }, { value: 'patterns', label: 'Patterns and routes', kinds: ['pattern', 'route'] },
  { value: 'catchall', label: 'Everything else', kinds: ['catchall'] }, { value: 'agent', label: 'Agent inboxes', kinds: ['agent'] }, { value: 'auto', label: 'Auto-created', kinds: ['auto'] },
]
const PAGE = 50

function detail(e: Entry) {
  if (e.kind === 'catchall') return e.to[0]?.kind === 'create' ? 'Unknown recipients get a new address' : 'Unknown recipients at this domain'
  if (e.kind === 'pattern') return e.owner ? `Pattern of ${e.owner.address}` : 'Pattern'
  if (e.kind === 'route') return 'Route, no inbox of its own'
  if (e.kind === 'agent') return [e.label, expiresIn(e.expiresAt)].filter(Boolean).join(' · ')
  if (e.kind === 'temporary') return [e.label, expiresIn(e.expiresAt)].filter(Boolean).join(' · ')
  if (e.kind === 'auto') return 'Created by the catch-all'
  return [e.label, e.aliases.length ? `also ${e.aliases.map(a => a.slice(0, a.indexOf('@') + 1)).join(', ')}` : null].filter(Boolean).join(' · ')
}

function AddressesTab({ model }: { model: Model }) {
  const navigate = useNavigate()
  const { canAdminister } = useWorkspaceAccess()
  const [filter, setFilter] = useState<(typeof filters)[number]['value']>('all')
  const [host, setHost] = useState('all')
  const [q, setQ] = useState('')
  const [pageNo, setPage] = useState(1)
  const [creating, setCreating] = useState(false)
  const base = model.entries.filter(e => host === 'all' || e.host === host)
  const count = (f: (typeof filters)[number]) => f.kinds ? base.filter(e => f.kinds!.includes(e.kind)).length : base.length
  const kinds = filters.find(f => f.value === filter)?.kinds
  const needle = q.trim().toLowerCase()
  const rows = base.filter(e => (!kinds || kinds.includes(e.kind)) && (!needle || [e.match, e.label ?? '', ...e.aliases, ...e.rituals, ...e.to.map(d => d.name)].some(v => v.toLowerCase().includes(needle))))
  const shown = rows.slice((pageNo - 1) * PAGE, pageNo * PAGE)
  const hosts = model.groups.filter(g => g.total > 0 || g.domain)
  const truncated = (filter === 'auto' && model.more.autos) || (filter === 'agent' && model.more.agents) || (filter === 'all' && (model.more.autos || model.more.agents || model.more.named))
  if (!model.receiving.length && !model.entries.length) return <GettingStarted model={model} onCreate={() => setCreating(true)} />
  return <div className="stack">
    <div className="pitch-toolbar">
      <div className="pitch-filters" role="group" aria-label="Show">{filters.map(f => { const n = count(f); return (f.value === 'all' || n > 0) && <button key={f.value} type="button" className="pitch-filter" aria-pressed={filter === f.value} onClick={() => { setFilter(f.value); setPage(1) }}>{f.label}<span>{number(n)}</span></button> })}</div>
      <div className="cluster">
        {hosts.length > 1 && <Select className="pitch-domain-select" aria-label="Domain" value={host} onValueChange={v => { setHost(v); setPage(1) }} options={[{ value: 'all', label: 'All domains' }, ...hosts.map(g => ({ value: g.host, label: g.host }))]} />}
        <Input className="receiving-search" type="search" aria-label="Search" placeholder="Search address, ritual or destination" value={q} onChange={e => { setQ(e.target.value); setPage(1) }} />
      </div>
    </div>
    <DataTable rows={shown} rowKey={e => e.id} onRowClick={e => navigate(e.href)} minRows={Math.min(8, rows.length)}
      empty={<EmptyState title={needle ? 'Nothing matches' : 'Nothing here yet'} />}
      columns={[
        { key: 'match', label: 'Mail to', width: '34%', render: e => <div className="pitch-cell"><EntryIcon kind={e.kind} /><div className="settings-cell-stack"><Match value={e.match} host={host === 'all'} /><span className="muted receiving-clip">{detail(e) || entryKindLabel[e.kind]}</span></div></div> },
        { key: 'then', label: 'Then', width: '16%', render: e => <Chain keys={e.rituals} /> },
        { key: 'to', label: 'Goes to', width: '30%', render: e => <DestNames to={e.to} /> },
        { key: 'unread', label: 'Unread', align: 'right', width: '8%', render: e => e.unread ? <strong>{number(e.unread)}</strong> : <span className="muted">{e.owner ? 0 : '—'}</span> },
        { key: 'last', label: 'Last mail', align: 'right', render: e => e.last ? ago(e.last) : <span className="muted">—</span> },
      ]} />
    <div className="pitch-foot">
      <span className="muted">{truncated ? `Showing the first 100 of each kind; ${plural(model.totals.addresses, 'address', 'addresses')} in total. Search finds the rest.` : `${plural(rows.length, 'entry', 'entries')}`}</span>
      <Pagination page={pageNo} pageSize={PAGE} total={rows.length} onPageChange={setPage} />
    </div>
    {canAdminister && <CreateAddressDialog open={creating} onOpenChange={setCreating} domains={model.domains} />}
  </div>
}

function RitualsTab({ model }: { model: Model }) {
  const navigate = useNavigate()
  const runsOn = (key: string) => model.entries.filter(e => e.rituals.includes(key) && e.kind !== 'pattern')
  if (!model.rituals.length) return <EmptyState title="No rituals yet" description="A ritual is a short script that runs on an address’s mail: label it, junk it, post it to Slack or a webhook, or deliver it to another inbox." action={<Link to="/receiving/rituals">Write a ritual</Link>} />
  return <DataTable rows={model.rituals} rowKey={r => r.key} onRowClick={() => navigate('/receiving/rituals')} columns={[
    { key: 'key', label: 'Ritual', width: '18%', render: r => <span className="pitch-cell"><RitualIcon /><code>{r.key}</code></span> },
    { key: 'on', label: 'Runs on', width: '38%', render: r => { const on = runsOn(r.key); return on.length ? <span className="receiving-clip">{on.slice(0, 3).map(e => e.match).join(', ')}{on.length > 3 && <span className="muted"> +{on.length - 3}</span>}</span> : <span className="muted">Not attached</span> } },
    { key: 'calls', label: 'Sends to', width: '30%', render: r => r.calls.length || r.delivers.length ? <DestNames to={[...r.calls.map(c => model.destinations.find(d => d.id === `endpoint:${c}`)).filter(Boolean), ...r.delivers.map(k => model.entries.find(e => e.owner?.key === k)?.owner).filter(Boolean).map(a => model.inboxDest(a!))] as never} /> : <span className="muted">Labels and filters only</span> },
    { key: 'jev', label: 'Asks Jev', align: 'right', render: r => r.omens ? 'Yes' : <span className="muted">No</span> },
  ]} />
}

function DestinationsTab({ model }: { model: Model }) {
  const navigate = useNavigate()
  // Every address keeps its own inbox, so the Inbox is one destination here; the rest are where mail is sent elsewhere.
  const inboxes = model.entries.filter(e => e.owner && e.kind !== 'pattern').length
  const rows = [{ id: 'inbox', kind: 'inbox' as const, name: 'Inbox', detail: `Each address keeps its own threads · ${plural(inboxes, 'address', 'addresses')}`, href: '/receiving/inbox' }, ...model.destinations.filter(d => d.kind !== 'inbox')]
  return <DataTable rows={rows} rowKey={d => d.id} onRowClick={d => navigate(d.href)} empty={<EmptyState title="No destinations" />} columns={[
    { key: 'name', label: 'Destination', width: '34%', render: d => <div className="pitch-cell"><DestIcon kind={d.kind} /><div className="settings-cell-stack"><span>{d.name}</span><span className="muted receiving-clip">{d.detail}</span></div></div> },
    { key: 'kind', label: 'Type', width: '14%', render: d => destKindLabel[d.kind] },
    { key: 'used', label: 'Gets mail from', width: '34%', render: d => { if (d.id === 'inbox') return <span className="muted">Every address, unless a route sends its mail elsewhere</span>; const from = model.used(d); const rituals = model.rituals.filter(r => r.calls.some(c => `endpoint:${c}` === d.id)); return from.length || rituals.length ? <span className="receiving-clip">{[...rituals.map(r => `ritual ${r.key}`), ...from.filter(e => !(e.kind === 'pattern' && e.owner?.id === d.id)).map(e => e.match)].slice(0, 3).join(', ')}{from.length + rituals.length > 3 && <span className="muted"> +{from.length + rituals.length - 3}</span>}</span> : <span className="muted">Nothing yet</span> } },
    { key: 'status', label: 'Status', render: d => <StatusBadge status={d.paused ? 'Paused' : d.pending ? 'Unconfirmed' : 'Active'} tone={d.paused ? 'neutral' : d.pending ? 'warning' : 'success'} /> },
  ]} />
}

export function AddressesDirection() {
  const { model, error, retry } = useReceivingModel()
  const [tab, setTab] = useState('addresses')
  const [creating, setCreating] = useState(false)
  const counts = useMemo(() => model && { addresses: model.entries.length, rituals: model.rituals.length, destinations: 1 + model.destinations.filter(d => d.kind !== 'inbox').length }, [model])
  return <div className="stack inbound-stack">
    <PageHeader title="Receiving" actions={<>
      <Button disabled={!model?.receiving.length} onClick={() => setCreating(true)}>New address</Button>
      <Link className="ui-button ui-button--primary ui-button--md" to="/receiving/inbox">Inbox</Link>
    </>} />
    {error ? <ErrorState error={error} onRetry={retry} /> : !model || !counts ? <PitchSkeleton /> : <div className="pitch-enter stack">
      <Tabs label="Receiving" value={tab} onValueChange={setTab} items={[{ value: 'addresses', label: 'Addresses', count: counts.addresses }, { value: 'rituals', label: 'Rituals', count: counts.rituals }, { value: 'destinations', label: 'Destinations', count: counts.destinations }]} />
      {tab === 'addresses' ? <AddressesTab model={model} /> : tab === 'rituals' ? <RitualsTab model={model} /> : <DestinationsTab model={model} />}
      <CreateAddressDialog open={creating} onOpenChange={setCreating} domains={model.domains} />
    </div>}
  </div>
}

/** The address page's path, left to right: what it receives, what runs, where it goes. */
export function AddressPath({ id }: { id: string }) {
  const { model } = useReceivingModel()
  const entry = model?.entries.find(e => e.id === id)
  const patterns = model?.entries.filter(e => e.kind === 'pattern' && e.owner?.id === id) ?? []
  return <div className="pitch-path" aria-label="Where this address’s mail goes">
    <section className="pitch-path__step"><h3>Mail to</h3>{!entry ? <span className="ui-skeleton" /> : <ul>
      <li><Match value={entry.match} /></li>
      {entry.aliases.map(a => <li key={a}><Match value={a} /><span className="muted">alias</span></li>)}
      {patterns.map(p => <li key={p.id}><Match value={p.match} /><span className="muted">pattern</span></li>)}
    </ul>}</section>
    <span className="pitch-path__arrow" aria-hidden="true">→</span>
    <section className="pitch-path__step"><h3>Then</h3>{!entry ? <span className="ui-skeleton" /> : entry.rituals.length ? <ul>{entry.rituals.map((k, i) => <li key={k}><RitualIcon /><code>{k}</code>{i < entry.rituals.length - 1 && <span className="muted">then</span>}</li>)}</ul> : <p className="muted">No ritual. <Link to="/receiving/rituals">Attach one</Link></p>}</section>
    <span className="pitch-path__arrow" aria-hidden="true">→</span>
    <section className="pitch-path__step"><h3>Goes to</h3>{!entry ? <span className="ui-skeleton" /> : <ul>{entry.to.map(d => <li key={d.id}><DestIcon kind={d.kind} /><span>{d.kind === 'inbox' && d.id === id ? 'Its inbox' : d.name}</span><span className="muted">{entry.via[d.id] ? `via ${entry.via[d.id]}` : destKindLabel[d.kind]}</span></li>)}</ul>}</section>
  </div>
}
