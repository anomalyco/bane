// Direction 1: the flow. Receiving is one left-to-right map of the pipeline every message follows:
// Arrives at (domain) → Mail to (address, pattern, route, catch-all) → Then (ritual) → Goes to (destination).
// Selecting anything lights up every path through it; tracing an address runs the real routing test and lights its path.
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router'
import { Globe, Inbox as InboxIcon } from 'lucide-react'
import { Button, ErrorState, Input, PageHeader } from '../../../components/ui'
import { useApiMutation } from '../../../data/context'
import type { RoutedRecipient } from '../../../data/types'
import { number } from '../../../lib/format'
import { CreateAddressDialog } from '../addresses'
import { receivingStatus } from '../status'
import { destKindLabel, expiresIn, plural, useReceivingModel, type Dest, type Entry, type Model } from './model'
import { DestIcon, EntryIcon, Match, RitualIcon, Sentence } from './parts'
import { PitchSkeleton } from './shared-views'

type Col = 0 | 1 | 2 | 3
type FlowNode = { id: string; col: Col; label: ReactNode; meta?: ReactNode; icon?: ReactNode; group?: string; tone?: 'muted' | 'placeholder'; title?: string }
type Path = { nodes: string[]; edges: [string, string][]; entries: Entry[] }
const titles = ['Arrives at', 'Mail to', 'Then', 'Goes to'] as const
const PER_HOST = 6

function graph(model: Model, query: string) {
  const nodes: FlowNode[] = []
  const paths: Path[] = []
  const needle = query.trim().toLowerCase()
  // Column 1: receiving domains, then the ones that only send.
  for (const d of model.receiving) nodes.push({ id: `d:${d.name}`, col: 0, icon: <Globe className="pitch-icon" size={14} aria-hidden="true" />, label: d.name, meta: d.status === 'active' ? number(d.addressCount) : receivingStatus[d.status].label, tone: d.status === 'active' ? undefined : 'muted' })
  if (model.sendOnly.length) nodes.push({ id: 'd:send-only', col: 0, label: model.sendOnly.length === 1 ? model.sendOnly[0]!.name : `${model.sendOnly.length} more domains`, meta: 'Only sends', tone: 'placeholder' })
  // Column 2: per host, the busiest entries; the rest fold into "more", agent inboxes and auto-created nodes.
  const visible = new Map<string, string>()
  // Hosts in the same order as column 1, so wires cross as little as possible.
  const hosts = [...new Set([...model.receiving.map(d => d.name), ...model.entries.map(e => e.host)])]
  const single = hosts.filter(h => model.entries.some(e => e.host === h)).length === 1
  for (const host of hosts) {
    // An address's own patterns ride on its node (they deliver to it); the address page lists them.
    const here = model.entries.filter(e => e.host === host && !(e.kind === 'pattern' && e.owner) && (!needle || [e.match, e.label ?? '', ...e.aliases].some(v => v.toLowerCase().includes(needle))))
    if (!here.length) continue
    const named = here.filter(e => ['address', 'temporary'].includes(e.kind)).sort((a, b) => b.unread - a.unread || (b.last ?? '').localeCompare(a.last ?? ''))
    const other = here.filter(e => ['pattern', 'route'].includes(e.kind))
    const small = here.length <= 20
    const budget = needle ? 40 : small ? 99 : PER_HOST
    const shown = [...named.slice(0, budget), ...other.slice(0, needle || small ? 40 : 3)]
    for (const e of shown) { visible.set(e.id, `e:${e.id}`); nodes.push({ id: `e:${e.id}`, col: 1, group: single ? undefined : host, icon: <EntryIcon kind={e.kind} />, label: <Match value={e.match} host={false} />, meta: e.aliases.length + (e.owner?.rules.length ?? 0) ? `+${e.aliases.length + (e.owner?.rules.length ?? 0)}` : e.kind === 'pattern' ? 'pattern' : e.kind === 'route' ? 'route' : e.kind === 'temporary' ? expiresIn(e.expiresAt) : e.unread ? `${e.unread} new` : undefined, title: e.match }) }
    const rest = [...named.slice(budget), ...other.slice(shown.length - Math.min(named.length, budget))]
    const group = model.groups.find(g => g.host === host)
    const hiddenNamed = Math.max(0, (group?.total ?? 0) - (group?.auto ?? 0) - (group?.agents ?? 0) - named.slice(0, budget).length)
    if (rest.length || (!needle && hiddenNamed > 0)) { nodes.push({ id: `more:${host}`, col: 1, group: single ? undefined : host, label: `${number(Math.max(rest.length, hiddenNamed))} more`, meta: 'search', tone: 'muted' }); for (const e of rest) visible.set(e.id, `more:${host}`) }
    const agents = here.filter(e => e.kind === 'agent'), auto = here.filter(e => e.kind === 'auto')
    if (agents.length) { nodes.push({ id: `agents:${host}`, col: 1, group: single ? undefined : host, icon: <EntryIcon kind="agent" />, label: 'Agent inboxes', meta: number(needle ? agents.length : Math.max(group?.agents ?? 0, agents.length)) }); for (const e of agents) visible.set(e.id, `agents:${host}`) }
    if (auto.length) { nodes.push({ id: `auto:${host}`, col: 1, group: single ? undefined : host, icon: <EntryIcon kind="auto" />, label: 'Auto-created', meta: number(needle ? auto.length : Math.max((group?.total ?? 0) - (group?.agents ?? 0) - named.length, auto.length)) }); for (const e of auto) visible.set(e.id, `auto:${host}`) }
    for (const e of here.filter(e => e.kind === 'catchall')) { visible.set(e.id, `e:${e.id}`); nodes.push({ id: `e:${e.id}`, col: 1, group: single ? undefined : host, icon: <EntryIcon kind="catchall" />, label: 'Everything else', meta: '*@', title: e.match }) }
  }
  // Column 3: rituals, plus the lane for mail no ritual touches. Column 4: the Inbox, then every other destination.
  const ritualKeys = model.rituals.map(r => r.key)
  for (const k of ritualKeys) nodes.push({ id: `r:${k}`, col: 2, icon: <RitualIcon />, label: <code>{k}</code>, meta: plural(model.entries.filter(e => e.rituals.includes(k) && e.kind !== 'pattern').length, 'address', 'addresses') })
  nodes.push({ id: 'r:none', col: 2, label: 'No ritual', meta: 'straight through', tone: 'muted' })
  const destId = (d: Dest) => d.kind === 'inbox' ? 't:inbox' : `t:${d.id}`
  const used = new Set(model.entries.flatMap(e => e.to.map(destId)))
  nodes.push({ id: 't:inbox', col: 3, icon: <InboxIcon className="pitch-icon" size={14} aria-hidden="true" />, label: 'Inbox', meta: plural(model.totals.addresses, 'address', 'addresses') })
  for (const d of [...model.destinations.filter(d => d.kind !== 'inbox'), model.create, model.keep, model.drop]) if (used.has(destId(d)) || (d.kind !== 'keep' && d.kind !== 'drop' && d.kind !== 'create'))
    nodes.push({ id: destId(d), col: 3, icon: <DestIcon kind={d.kind} />, label: d.name, meta: d.paused ? 'paused' : d.pending ? 'unconfirmed' : ['keep', 'drop', 'create'].includes(d.kind) ? undefined : destKindLabel[d.kind], tone: ['keep', 'drop'].includes(d.kind) || d.paused ? 'muted' : undefined })
  // A new account: placeholders in every column, joined by a dashed path that shows how mail will flow.
  if (!model.entries.some(e => e.owner || e.route)) {
    if (!model.sendOnly.length) nodes.unshift({ id: 'd:none', col: 0, label: 'Your domain', tone: 'placeholder' })
    nodes.push({ id: 'e:none', col: 1, label: 'An address, like support@', tone: 'placeholder' })
    const d = model.sendOnly.length ? 'd:send-only' : 'd:none'
    paths.push({ nodes: [d, 'e:none', 'r:none', 't:inbox'], edges: [[d, 'e:none'], ['e:none', 'r:none'], ['r:none', 't:inbox']], entries: [] })
    return { nodes, paths, empty: true }
  }
  // One path per entry, through the node it shows as (its own, or the folded node it belongs to), so selecting
  // anything lights exactly the mail that passes through it.
  for (const e of model.entries) {
    const at = visible.get(e.id) ?? (e.kind === 'pattern' && e.owner ? visible.get(e.owner.id) : undefined)
    if (!at) continue
    const rituals = e.rituals.length ? e.rituals.map(k => `r:${k}`) : ['r:none']
    const dests = [...new Set(e.to.map(destId))]
    paths.push({ entries: [e], nodes: [`d:${e.host}`, at, ...rituals, ...dests], edges: [[`d:${e.host}`, at], ...rituals.map(r => [at, r] as [string, string]), ...rituals.flatMap(r => dests.map(t => [r, t] as [string, string]))] })
  }
  return { nodes, paths, empty: false }
}

type Geo = Record<string, { l: number; r: number; y: number; clipped: boolean }>
function Wires({ geo, paths, lit, dashed }: { geo: Geo; paths: Path[]; lit: Set<string> | null; dashed: boolean }) {
  const edges = new Map<string, [string, string]>()
  for (const p of paths) for (const edge of p.edges) edges.set(`${edge[0]}>${edge[1]}`, edge)
  // Lit wires draw last, on top.
  return <svg className="flow__wires" aria-hidden="true" data-dashed={dashed || undefined}>
    {[...edges.entries()].sort((x, y) => Number(lit?.has(x[0]) ?? 0) - Number(lit?.has(y[0]) ?? 0)).map(([key, [a, b]]) => {
      const s = geo[a], t = geo[b]
      if (!s || !t) return null
      const on = !!lit?.has(key)
      const x1 = s.r, x2 = t.l, dx = Math.max(24, (x2 - x1) / 2)
      return <path key={key + (on ? ':on' : '')} d={`M${x1} ${s.y} C${x1 + dx} ${s.y} ${x2 - dx} ${t.y} ${x2} ${t.y}`} pathLength={1} data-on={on || undefined} data-dim={(!!lit && !on) || s.clipped || t.clipped || undefined} />
    })}
  </svg>
}

function detailFor(model: Model, id: string | null, paths: Path[], trace: { result: RoutedRecipient; entry: Entry | null } | null): ReactNode {
  if (trace) {
    const r = trace.result
    return <div className="flow__detail-body"><p className="flow__eyebrow">Trace · {r.address}</p>{trace.entry ? <Sentence entry={{ ...trace.entry, match: r.address, aliases: [] }} /> : <p className="pitch-sentence">{r.dropped ? 'Dropped.' : 'Kept without an inbox.'}</p>}
      <p className="muted">Matched {r.tier === 'exact' ? 'a route for this address' : r.tier === 'address' ? 'its own address' : r.tier === 'pattern' ? `the pattern ${trace.entry?.match ?? ''}` : r.tier === 'subaddress' ? `its base address ${trace.entry?.match ?? ''}` : r.tier === 'catchall' ? 'the domain’s catch-all route' : 'the domain default'}. Nothing was delivered.</p></div>
  }
  if (!id) return <div className="flow__detail-body"><p className="pitch-sentence">Select a domain, address, ritual or destination to follow its mail.</p><p className="muted">Mail to an address lands in the Inbox. A route sends it somewhere else; a ritual can label it, filter it or copy it to Slack, Discord, a webhook or a forward.</p></div>
  const lit = paths.filter(p => p.nodes.includes(id))
  const entries = lit.flatMap(p => p.entries)
  const own = id.startsWith('e:') ? entries.find(e => `e:${e.id}` === id) : null
  if (own) { const e = own; return <div className="flow__detail-body"><Sentence entry={e} /><div className="cluster"><Link className="ui-button ui-button--secondary ui-button--sm" to={e.href}>{e.owner ? 'Open address' : e.kind === 'catchall' ? 'Domain settings' : 'Edit route'}</Link>{e.owner && <Link className="ui-button ui-button--ghost ui-button--sm" to={`/receiving/inbox?address=${e.owner.id}`}>Open in Inbox</Link>}</div></div> }
  const names = (list: Entry[]) => { const main = list.filter(e => e.kind !== 'pattern'), shown = main.slice(0, 4).map(e => e.match); return `${shown.join(', ')}${main.length > 4 ? ` and ${number(main.length - 4)} more` : ''}` }
  if (id.startsWith('d:')) { const d = model.receiving.find(x => `d:${x.name}` === id); if (!d) return <div className="flow__detail-body"><p className="pitch-sentence">{model.sendOnly.map(x => x.name).join(', ')} only {model.sendOnly.length === 1 ? 'sends' : 'send'}.</p><Link className="ui-button ui-button--secondary ui-button--sm" to="/domains">Set up receiving in Domains</Link></div>
    return <div className="flow__detail-body"><p className="pitch-sentence"><strong>{d.name}</strong> {d.status === 'active' ? 'receives mail' : 'is waiting for its MX record'} for {plural(d.addressCount, 'address', 'addresses')}. Anything else is {d.catchAll === 'create_address' ? 'given a new address' : 'kept without an inbox'}.</p><Link className="ui-button ui-button--secondary ui-button--sm" to={`/domains/${d.id}`}>Domain settings</Link></div> }
  if (id.startsWith('r:')) { const key = id.slice(2); return <div className="flow__detail-body"><p className="pitch-sentence">{key === 'none' ? <>Mail to <strong>{names(entries)}</strong> goes straight to its destinations.</> : <><code>{key}</code> runs on mail to <strong>{names(entries)}</strong>.</>}</p>{key !== 'none' && <Link className="ui-button ui-button--secondary ui-button--sm" to="/receiving/rituals">Edit ritual</Link>}</div> }
  if (id.startsWith('t:')) { const name = id === 't:inbox' ? 'The Inbox' : model.destinations.concat(model.keep, model.drop, model.create).find(d => `t:${d.id}` === id)?.name; return <div className="flow__detail-body"><p className="pitch-sentence"><strong>{name}</strong> gets mail to <strong>{names(entries)}</strong>.</p><Link className="ui-button ui-button--secondary ui-button--sm" to={id === 't:inbox' ? '/receiving/inbox' : id.startsWith('t:endpoint:') ? '/receiving/endpoints' : `/receiving/webhooks/${id.slice(2)}`}>{id === 't:inbox' ? 'Open Inbox' : 'Settings'}</Link></div> }
  return <div className="flow__detail-body"><p className="pitch-sentence">{plural(entries.length, 'address', 'addresses')}: <strong>{names(entries)}</strong>.</p><p className="muted">Search the column to see each one.</p></div>
}

function FlowMap({ model }: { model: Model }) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [trace, setTrace] = useState<{ result: RoutedRecipient; entry: Entry | null } | null>(null)
  const [traceInput, setTraceInput] = useState('')
  const test = useApiMutation((api, to: string) => api.routing.test({ to: [to] }), undefined, false, false)
  const { nodes, paths, empty } = useMemo(() => graph(model, query), [model, query])
  const map = useRef<HTMLDivElement>(null)
  const refs = useRef(new Map<string, HTMLElement>())
  const [geo, setGeo] = useState<Geo>({})
  const measure = useCallback(() => {
    const root = map.current; if (!root) return
    const box = root.getBoundingClientRect(), next: Geo = {}
    for (const [id, el] of refs.current) {
      const r = el.getBoundingClientRect(), col = el.closest('.flow__list')!.getBoundingClientRect()
      const y = r.top + r.height / 2
      next[id] = { l: r.left - box.left, r: r.right - box.left, y: Math.min(Math.max(y, col.top + 4), col.bottom - 4) - box.top, clipped: y < col.top || y > col.bottom }
    }
    setGeo(prev => JSON.stringify(prev) === JSON.stringify(next) ? prev : next)
  }, [])
  useLayoutEffect(() => {
    measure()
    const ro = new ResizeObserver(measure); if (map.current) ro.observe(map.current)
    return () => ro.disconnect()
  }, [measure, nodes])
  const focus = trace ? (trace.entry ? (paths.find(p => p.entries.includes(trace.entry!))?.nodes.find(n => !n.startsWith('d:') && !n.startsWith('r:') && !n.startsWith('t:')) ?? null) : null) : hover ?? selected
  const { active, lit } = useMemo(() => {
    if (!focus) return { active: null, lit: null }
    const on = paths.filter(p => p.nodes.includes(focus))
    return { active: new Set(on.flatMap(p => p.nodes)), lit: new Set(on.flatMap(p => p.edges.map(([a, b]) => `${a}>${b}`))) }
  }, [focus, paths])
  async function run(event: FormEvent) {
    event.preventDefault()
    const to = traceInput.trim().toLowerCase(); if (!to.includes('@')) return
    try {
      const r = (await test.mutateAsync(to)).recipients[0]!
      const entry = (r.route ? model.entries.find(e => e.route?.id === r.route) : null)
        ?? (r.tier === 'pattern' ? model.entries.find(e => e.kind === 'pattern' && e.owner && r.inboxes.includes(e.owner.id) && new RegExp(`^${e.match.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(to)) : null)
        ?? (r.inboxes[0] ? model.entries.find(e => e.owner?.id === r.inboxes[0] && e.kind !== 'pattern') : null)
        ?? (r.tier === 'default' ? model.entries.find(e => e.kind === 'catchall' && e.host === to.split('@')[1]) : null) ?? null
      setSelected(null); setTrace({ result: r, entry })
    } catch { /* Shown under the field. */ }
  }
  const columns = ([0, 1, 2, 3] as Col[]).map(col => nodes.filter(n => n.col === col))
  const count = [model.receiving.length, model.entries.filter(e => e.kind !== 'pattern').length, model.rituals.length, nodes.filter(n => n.col === 3).length]
  return <div className="flow pitch-enter">
    <form className="flow__bar" onSubmit={run}>
      <Input aria-label="Trace an address" placeholder={`Trace an address, such as ${model.entries.find(e => e.kind === 'pattern')?.match.replace('*', '4821') ?? `hello@${model.receiving[0]?.name ?? 'example.com'}`}`} value={traceInput} onChange={e => { setTraceInput(e.target.value); if (trace) setTrace(null) }} disabled={!model.receiving.length} />
      <Button type="submit" loading={test.isPending} disabled={!traceInput.includes('@')}>Trace</Button>
      {trace && <Button variant="ghost" onClick={() => { setTrace(null); setTraceInput('') }}>Clear</Button>}
      {test.error && <span className="ui-field__error">{(test.error as Error).message}</span>}
    </form>
    <div className="flow__map" ref={map} data-empty={empty || undefined} onMouseLeave={() => setHover(null)}>
      <Wires geo={geo} paths={paths} lit={lit} dashed={empty} />
      {columns.map((list, col) => <section key={col} className="flow__col" aria-labelledby={`flow-col-${col}`}>
        <header className="flow__head"><h3 id={`flow-col-${col}`}><span>{col + 1}</span>{titles[col]}</h3><span className="muted">{count[col] ? number(count[col]!) : ''}</span></header>
        {col === 1 && !empty && <input className="flow__search" type="search" placeholder="Filter" aria-label="Filter addresses" value={query} onChange={e => setQuery(e.target.value)} />}
        <ul className="flow__list" onScroll={measure}>
          {list.map((n, i) => <li key={n.id}>
            {n.group && list[i - 1]?.group !== n.group && <p className="flow__group">{n.group}</p>}
            <button type="button" ref={el => { if (el) refs.current.set(n.id, el); else refs.current.delete(n.id) }} className="flow__node" title={n.title}
              data-tone={n.tone} data-selected={(focus === n.id) || undefined} data-dim={(!!active && !active.has(n.id)) || undefined} data-lit={(!!active && active.has(n.id)) || undefined}
              onMouseEnter={() => !trace && !empty && setHover(n.id)} onFocus={() => !trace && !empty && setHover(n.id)} onBlur={() => setHover(null)}
              onClick={() => { if (empty) return; setTrace(null); setSelected(selected === n.id ? null : n.id) }}>
              {n.icon}<span className="flow__label">{n.label}</span>{n.meta && <span className="flow__meta">{n.meta}</span>}
            </button>
          </li>)}
        </ul>
      </section>)}
    </div>
    <div className="flow__detail" aria-live="polite">{empty && !hover && !selected ? <FlowStart model={model} /> : detailFor(model, hover ?? selected, paths, trace)}</div>
  </div>
}

export function FlowDirection() {
  const { model, error, retry } = useReceivingModel()
  const [creating, setCreating] = useState(false)
  return <div className="stack inbound-stack">
    <PageHeader title="Receiving" actions={<>
      <Button disabled={!model?.receiving.length} onClick={() => setCreating(true)}>New address</Button>
      <Link className="ui-button ui-button--primary ui-button--md" to="/receiving/inbox">Inbox</Link>
    </>} />
    {error ? <ErrorState error={error} onRetry={retry} /> : !model ? <PitchSkeleton variant="flow" /> : <>
      <FlowMap model={model} />
      <CreateAddressDialog open={creating} onOpenChange={setCreating} domains={model.domains} />
    </>}
  </div>
}

function FlowStart({ model }: { model: Model }) {
  const receives = model.receiving.some(d => d.status === 'active')
  return <div className="flow__detail-body">
    <p className="pitch-sentence">{receives ? <>Mail to <strong>{model.receiving[0]!.name}</strong> arrives. Create an address and the map fills in.</> : <>Mail starts at a domain. {model.sendOnly.length ? <><strong>{model.sendOnly.map(d => d.name).join(', ')}</strong> only sends today; publish its MX record and the map fills in.</> : 'Add one and publish its MX record; the map fills in.'}</>}</p>
    <div className="cluster"><Link className="ui-button ui-button--primary ui-button--md" to="/domains">Set up receiving</Link><Link className="ui-button ui-button--ghost ui-button--md" to="/receiving/inboxes">Try an agent inbox first</Link></div>
  </div>
}
