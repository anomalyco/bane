// Direction 3: inboxes first. Receiving opens like a mail client: the rail lists where mail ends up (inboxes, agent
// inboxes, the places mail is sent elsewhere, and what isn't delivered); each inbox shows what feeds it above its mail.
import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { ChevronRight, Search } from 'lucide-react'
import { Button, DataTable, EmptyState, ErrorState, Input, PageHeader, SkeletonText, StatusBadge } from '../../../components/ui'
import { useApiDef } from '../../../data/context'
import { queries } from '../../../data/queries'
import { number } from '../../../lib/format'
import { CreateAddressDialog } from '../addresses'
import { when } from '../shared'
import { ago, destKindLabel, expiresIn, plural, useReceivingModel, type Dest, type Entry, type Model } from './model'
import { Chain, DestIcon, EntryIcon, Match, RitualIcon } from './parts'
import { GettingStarted, PitchSkeleton } from './shared-views'

type Sel = { type: 'all' } | { type: 'inbox'; id: string } | { type: 'dest'; id: string } | { type: 'group'; id: 'auto' | 'agents' }
const parse = (value: string | null): Sel => !value || value === 'all' ? { type: 'all' } : value === 'auto' || value === 'agents' ? { type: 'group', id: value } : value.startsWith('dest:') ? { type: 'dest', id: value.slice(5) } : { type: 'inbox', id: value }
const encode = (sel: Sel) => sel.type === 'all' ? 'all' : sel.type === 'group' ? sel.id : sel.type === 'dest' ? `dest:${sel.id}` : sel.id

function RailItem({ active, onClick, icon, name, detail, count, muted }: { active: boolean; onClick: () => void; icon?: React.ReactNode; name: React.ReactNode; detail?: React.ReactNode; count?: number; muted?: boolean }) {
  return <li><button type="button" className="pitch-rail__item" aria-current={active || undefined} data-muted={muted || undefined} onClick={onClick}>
    {icon}<span className="pitch-rail__text"><span className="pitch-rail__name">{name}</span>{detail && <span className="pitch-rail__detail">{detail}</span>}</span>
    {count !== undefined && count > 0 && <span className="pitch-rail__count">{number(count)}</span>}
  </button></li>
}
function RailGroup({ title, count, open, onToggle, children }: { title: string; count?: number; open?: boolean; onToggle?: () => void; children?: React.ReactNode }) {
  return <section className="pitch-rail__group">
    {onToggle ? <button type="button" className="pitch-rail__title" aria-expanded={open} onClick={onToggle}><ChevronRight size={12} className="pitch-rail__chev" aria-hidden="true" />{title}{count !== undefined && <span>{number(count)}</span>}</button>
      : <h3 className="pitch-rail__title">{title}{count !== undefined && <span>{number(count)}</span>}</h3>}
    {(open ?? true) && <ul>{children}</ul>}
  </section>
}

const inboxesOf = (model: Model) => model.entries.filter(e => e.kind === 'address' || e.kind === 'temporary')
/** Everything that delivers into an inbox: its own address and aliases, its patterns, and routes or rituals that copy mail in. */
function feeds(model: Model, id: string) {
  const own = model.entries.filter(e => e.owner?.id === id && e.kind !== 'pattern')
  const patterns = model.entries.filter(e => e.owner?.id === id && e.kind === 'pattern')
  const routed = model.entries.filter(e => e.owner?.id !== id && e.to.some(d => d.id === id))
  return { own, patterns, routed }
}

function Feed({ model, entry }: { model: Model; entry: Entry }) {
  const { patterns, routed } = feeds(model, entry.id)
  const elsewhere = entry.to.filter(d => d.kind !== 'inbox' || d.id !== entry.id)
  return <div className="pitch-feed">
    <section><h3>Gets mail to</h3><ul>
      <li><Match value={entry.match} /></li>
      {entry.aliases.map(a => <li key={a}><Match value={a} /><span className="muted">alias</span></li>)}
      {patterns.map(p => <li key={p.id}><Match value={p.match} /><span className="muted">pattern</span></li>)}
      {routed.map(r => <li key={r.id}><Match value={r.match} /><span className="muted">{r.kind === 'route' ? 'routed here' : r.rituals.length ? `via ${r.rituals.at(-1)}` : 'routed here'}</span></li>)}
    </ul></section>
    <section><h3>Runs</h3>{entry.rituals.length ? <ul>{entry.rituals.map(k => <li key={k}><RitualIcon /><code>{k}</code></li>)}</ul> : <p className="muted">No ritual</p>}</section>
    <section><h3>Also goes to</h3>{elsewhere.length ? <ul>{elsewhere.map(d => <li key={d.id}><DestIcon kind={d.kind} /><span>{d.name}</span><span className="muted">{entry.via[d.id] ? `via ${entry.via[d.id]}` : destKindLabel[d.kind]}</span></li>)}</ul> : <p className="muted">Only this inbox</p>}</section>
  </div>
}

function Threads({ addressId }: { addressId?: string }) {
  const threads = useApiDef(queries.inboundThreads(addressId, 'inbox', '', undefined))
  if (threads.error) return <ErrorState error={threads.error} onRetry={() => void threads.refetch()} />
  if (threads.isPending) return <div className="pitch-threads" aria-hidden="true">{[0, 1, 2, 3].map(i => <div key={i} className="pitch-thread"><SkeletonText width="60%" /><SkeletonText width="30%" /></div>)}</div>
  if (!threads.data.length) return <EmptyState title="No mail yet" description="New mail shows up here within seconds." />
  return <ul className="pitch-threads">{threads.data.slice(0, 12).map(t => <li key={t.id}><Link className="pitch-thread" to={`/receiving/inbox?thread=${t.id}${addressId ? `&address=${addressId}` : ''}`}>
    <span className="pitch-thread__subject">{t.subject || '(no subject)'}</span><span className="pitch-thread__snippet">{t.snippet}</span><time className="pitch-thread__time">{when(t.lastMessageAt)}</time>
  </Link></li>)}</ul>
}

function InboxPane({ model, entry }: { model: Model; entry: Entry }) {
  return <div className="pitch-pane stack">
    <header className="pitch-pane__head"><div className="settings-cell-stack"><h2>{entry.label || entry.match}</h2><span className="muted"><Match value={entry.match} />{entry.expiresAt && ` · ${expiresIn(entry.expiresAt)}`}</span></div>
      <div className="cluster"><Link className="ui-button ui-button--secondary ui-button--md" to={entry.href}>Settings</Link><Link className="ui-button ui-button--primary ui-button--md" to={`/receiving/inbox?address=${entry.id}`}>Open in Inbox</Link></div></header>
    <Feed model={model} entry={entry} />
    <Threads addressId={entry.id} />
  </div>
}

function DestPane({ model, dest }: { model: Model; dest: Dest }) {
  const navigate = useNavigate()
  const from = model.entries.filter(e => e.to.some(d => d.id === dest.id))
  const explain = dest.kind === 'keep' ? 'Stored and readable over the API by message ID, but in no inbox. An address created later claims it.' : dest.kind === 'drop' ? 'Not stored. The receipt still records that it arrived.' : dest.kind === 'create' ? 'Each new recipient gets an address of its own.' : dest.detail
  return <div className="pitch-pane stack">
    <header className="pitch-pane__head"><div className="settings-cell-stack"><h2><DestIcon kind={dest.kind} size={16} /> {dest.name}</h2><span className="muted receiving-clip">{destKindLabel[dest.kind]} · {explain}</span></div>
      {!['keep', 'drop', 'create'].includes(dest.kind) && <div className="cluster">{(dest.paused || dest.pending) && <StatusBadge status={dest.paused ? 'Paused' : 'Unconfirmed'} tone={dest.paused ? 'neutral' : 'warning'} />}<Link className="ui-button ui-button--secondary ui-button--md" to={dest.href}>Settings</Link></div>}</header>
    <DataTable rows={from} rowKey={e => e.id} onRowClick={e => navigate(e.href)} empty={<EmptyState title="Nothing sends mail here yet" description="Add it to a route, or call it from a ritual." />} columns={[
      { key: 'match', label: 'Gets mail to', width: '44%', render: e => <span className="pitch-cell"><EntryIcon kind={e.kind} /><Match value={e.match} /></span> },
      { key: 'via', label: 'Via', width: '30%', render: e => e.rituals.length && !e.route ? <Chain keys={e.rituals} /> : <span className="muted">{e.kind === 'catchall' ? 'Everything else' : e.route ? 'Route' : 'Webhook subscription'}</span> },
      { key: 'last', label: 'Last mail', align: 'right', render: e => e.last ? ago(e.last) : <span className="muted">—</span> },
    ]} />
  </div>
}

function GroupPane({ model, id }: { model: Model; id: 'auto' | 'agents' }) {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const kind = id === 'auto' ? 'auto' : 'agent'
  const rows = model.entries.filter(e => e.kind === kind && (!q || e.match.includes(q.toLowerCase()) || e.label?.toLowerCase().includes(q.toLowerCase())))
  const total = id === 'auto' ? model.groups.reduce((n, g) => n + g.auto, 0) : model.totals.agents
  return <div className="pitch-pane stack">
    <header className="pitch-pane__head"><div className="settings-cell-stack"><h2>{id === 'auto' ? 'Auto-created' : 'Agent inboxes'}</h2><span className="muted">{id === 'auto' ? 'A catch-all creates an inbox for each new recipient.' : 'Expiring inboxes agents and tests create over the API or MCP.'}</span></div>
      <Input className="receiving-search" type="search" aria-label="Search" placeholder="Search" value={q} onChange={e => setQ(e.target.value)} /></header>
    <DataTable rows={rows.slice(0, 50)} rowKey={e => e.id} onRowClick={e => navigate(e.href)} columns={[
      { key: 'match', label: 'Address', width: '46%', render: e => <div className="settings-cell-stack"><Match value={e.match} />{e.label && <span className="muted">{e.label}</span>}</div> },
      { key: 'then', label: 'Runs', width: '18%', render: e => <Chain keys={e.rituals} /> },
      { key: 'state', label: id === 'auto' ? 'Threads' : 'Expires', width: '18%', render: e => id === 'auto' ? number(e.threads) : expiresIn(e.expiresAt) },
      { key: 'unread', label: 'Unread', align: 'right', render: e => e.unread ? <strong>{e.unread}</strong> : <span className="muted">0</span> },
    ]} />
    <p className="muted">{rows.length > 50 ? `50 of ${plural(rows.length, 'match', 'matches')} shown. ` : ''}{model.more[id === 'auto' ? 'autos' : 'agents'] ? `The first 100 of ${number(total)} are loaded here; search reaches every one.` : ''}</p>
  </div>
}

export function InboxesDirection() {
  const { model, error, retry } = useReceivingModel()
  const [params, setParams] = useSearchParams()
  const sel = parse(params.get('box'))
  const select = (next: Sel) => { const p = new URLSearchParams(params); p.set('box', encode(next)); setParams(p, { replace: true }) }
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [creating, setCreating] = useState(false)
  return <div className="stack inbound-stack pitch-mail-page">
    <PageHeader title="Receiving" actions={<Button disabled={!model?.receiving.length} onClick={() => setCreating(true)}>New inbox</Button>} />
    {error ? <ErrorState error={error} onRetry={retry} /> : !model ? <PitchSkeleton variant="rail" /> : (() => {
      const needle = q.trim().toLowerCase()
      const hit = (e: Entry) => !needle || [e.match, e.label ?? '', ...e.aliases].some(v => v.toLowerCase().includes(needle))
      const inboxes = inboxesOf(model).filter(hit)
      const agents = model.entries.filter(e => e.kind === 'agent' && hit(e))
      const autoCount = model.groups.reduce((n, g) => n + g.auto, 0)
      const hosts = [...new Set([...model.receiving.map(d => d.name), ...inboxes.map(e => e.host)])].filter(h => inboxes.some(e => e.host === h)).sort((a, b) => inboxes.filter(e => e.host === b).length - inboxes.filter(e => e.host === a).length)
      const elsewhere = model.destinations.filter(d => d.kind !== 'inbox' && (!needle || d.name.toLowerCase().includes(needle)))
      const undelivered = [model.keep, model.drop, model.create].filter(d => model.entries.some(e => e.to.some(x => x.id === d.id)))
      const unread = model.entries.reduce((n, e) => n + (e.kind === 'pattern' ? 0 : e.unread), 0)
      const current = sel.type === 'inbox' ? model.entries.find(e => e.id === sel.id) : null
      const dest = sel.type === 'dest' ? [...model.destinations, model.keep, model.drop, model.create].find(d => d.id === sel.id) : null
      const empty = !model.entries.some(e => e.owner) && !model.receiving.length
      return <div className="pitch-mail pitch-enter">
        <aside className="pitch-rail" aria-label="Inboxes">
          <label className="pitch-rail__search"><Search size={14} aria-hidden="true" /><input type="search" placeholder="Find an inbox or address" value={q} onChange={e => setQ(e.target.value)} aria-label="Find an inbox or address" /></label>
          <nav className="pitch-rail__scroll">
            <ul className="pitch-rail__top"><RailItem active={sel.type === 'all'} onClick={() => select({ type: 'all' })} name="All inboxes" count={unread} /></ul>
            {hosts.map(host => { const all = inboxes.filter(e => e.host === host), long = !needle && all.length > 12 && !open[host]; return <RailGroup key={host} title={hosts.length > 1 ? host : 'Inboxes'} count={all.length}>
              {(long ? all.slice(0, 10) : all).map(e => <RailItem key={e.id} active={current?.id === e.id} onClick={() => select({ type: 'inbox', id: e.id })} name={e.label || e.local} detail={[e.local + '@', ...e.aliases.map(a => a.slice(0, a.indexOf('@') + 1))].slice(0, 3).join(' · ') + (e.aliases.length > 2 ? ` +${e.aliases.length - 2}` : '')} count={e.unread} />)}
              {long && <li><button type="button" className="pitch-rail__more" onClick={() => setOpen({ ...open, [host]: true })}>Show {number(all.length - 10)} more</button></li>}
            </RailGroup> })}
            {!inboxes.length && !needle && <p className="pitch-rail__empty muted">No inboxes yet</p>}
            {(agents.length > 0 || model.totals.agents > 0) && <RailGroup title="Agent inboxes" count={model.more.agents ? undefined : agents.length} open={!!open.agents} onToggle={() => setOpen({ ...open, agents: !open.agents })}>
              <RailItem active={sel.type === 'group' && sel.id === 'agents'} onClick={() => select({ type: 'group', id: 'agents' })} name="All agent inboxes" detail={plural(model.totals.agents, 'inbox', 'inboxes')} />
              {agents.slice(0, 8).map(e => <RailItem key={e.id} active={current?.id === e.id} onClick={() => select({ type: 'inbox', id: e.id })} name={e.label || e.local} detail={expiresIn(e.expiresAt) ?? undefined} count={e.unread} />)}
            </RailGroup>}
            {autoCount > 0 && <RailGroup title="Auto-created" count={autoCount}>
              <RailItem active={sel.type === 'group' && sel.id === 'auto'} onClick={() => select({ type: 'group', id: 'auto' })} name={`${number(autoCount)} addresses`} detail={model.groups.filter(g => g.auto).map(g => `*@${g.host}`).join(', ')} count={model.entries.filter(e => e.kind === 'auto').reduce((n, e) => n + e.unread, 0)} />
            </RailGroup>}
            {elsewhere.length > 0 && <RailGroup title="Sent elsewhere" count={elsewhere.length}>
              {elsewhere.map(d => <RailItem key={d.id} active={dest?.id === d.id} onClick={() => select({ type: 'dest', id: d.id })} icon={<DestIcon kind={d.kind} />} name={d.name} detail={destKindLabel[d.kind]} muted={d.paused} />)}
            </RailGroup>}
            {undelivered.length > 0 && <RailGroup title="Not in an inbox">
              {undelivered.map(d => <RailItem key={d.id} active={dest?.id === d.id} onClick={() => select({ type: 'dest', id: d.id })} icon={<DestIcon kind={d.kind} />} name={d.name} muted />)}
            </RailGroup>}
          </nav>
        </aside>
        <section className="pitch-mail__main">
          {empty ? <div className="pitch-pane stack"><header className="pitch-pane__head"><div className="settings-cell-stack"><h2>Inboxes collect the mail sent to your addresses</h2><span className="muted">Set up receiving once; every inbox, agent inbox and destination then shows here.</span></div></header><GettingStarted model={model} onCreate={() => setCreating(true)} /></div>
            : current ? <InboxPane key={current.id} model={model} entry={current} />
            : dest ? <DestPane key={dest.id} model={model} dest={dest} />
            : sel.type === 'group' ? <GroupPane key={sel.id} model={model} id={sel.id} />
            : <div className="pitch-pane stack"><header className="pitch-pane__head"><div className="settings-cell-stack"><h2>All inboxes</h2><span className="muted">{plural(inboxesOf(model).length, 'inbox', 'inboxes')}{model.totals.agents ? ` · ${plural(model.totals.agents, 'agent inbox', 'agent inboxes')}` : ''}{autoCount ? ` · ${number(autoCount)} auto-created` : ''} · {plural(elsewhere.length, 'other destination')}</span></div>
                <Link className="ui-button ui-button--primary ui-button--md" to="/receiving/inbox">Open in Inbox</Link></header><Threads /></div>}
        </section>
      </div>
    })()}
    {model && <CreateAddressDialog open={creating} onOpenChange={setCreating} domains={model.domains} />}
  </div>
}
