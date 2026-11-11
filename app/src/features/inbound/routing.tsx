import { useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { Alert, Button, Checkbox, ConfirmDialog, DataTable, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, Select, StatusBadge, Switch, Tabs, Textarea } from '../../components/ui'
import { useApiDef, useApiMutation, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import type { InboundAddress, InboundWebhook, MailboxDomain, MailRoute, RoutedRecipient, RouteTier } from '../../data/types'
import { number } from '../../lib/format'
import { fieldError, MutationError } from '../settings/shared'
import '../settings/settings.css'
import './inbound.css'

type Destination = { id: string; name: string; detail: string; kind: 'inbox' | 'webhook'; paused: boolean; routeOnly: boolean; href: string; webhook?: InboundWebhook }
const hostOf = (url: string) => { try { return new URL(url).host } catch { return url } }
function destinationsOf(addresses: InboundAddress[], webhooks: InboundWebhook[]): Destination[] {
  return [
    ...addresses.map(a => ({ id: a.id, name: a.displayName || a.address, detail: a.address, kind: 'inbox' as const, paused: false, routeOnly: false, href: `/receiving/addresses/${a.id}` })),
    ...webhooks.map(h => ({ id: h.id, name: h.name || h.description || hostOf(h.url), detail: hostOf(h.url), kind: 'webhook' as const, paused: h.paused, routeOnly: !h.eventTypes.length, href: `/receiving/webhooks/${h.id}`, webhook: h })),
  ]
}

// One row per recipient rule, read as "mail to X goes to Y". Address rows are the implicit routes every inbox has.
type Row = { key: string; match: string; to: string[] | 'drop'; kind: 'route' | 'address' | 'pattern' | 'default'; route?: MailRoute; owner?: InboundAddress; domain?: MailboxDomain }
const tierRank = (match: string) => match.startsWith('*@') ? 2 : match.includes('*') ? 1 : 0
function rowsOf(routes: MailRoute[], addresses: InboundAddress[], domains: MailboxDomain[]): Row[] {
  const routed = new Set(routes.map(r => r.match))
  const rows: Row[] = [
    ...routes.map(route => ({ key: route.id, match: route.match, to: route.to, kind: 'route' as const, route })),
    ...addresses.flatMap(owner => [owner.address, ...owner.aliases].filter(m => !routed.has(m)).map(match => ({ key: `${owner.id}:${match}`, match, to: [owner.id], kind: 'address' as const, owner }))),
    ...addresses.flatMap(owner => owner.rules.map(match => ({ key: `${owner.id}:${match}`, match, to: [owner.id], kind: 'pattern' as const, owner }))),
  ]
  const rank = (row: Row) => row.kind === 'default' ? 3 : tierRank(row.match)
  const sorted = (list: Row[]) => list.sort((a, b) => a.match.split('@')[1]!.localeCompare(b.match.split('@')[1]!) || rank(a) - rank(b) || a.match.localeCompare(b.match))
  const defaults = domains.filter(d => d.status === 'active' && !routed.has(`*@${d.name}`)).map(domain => ({ key: `default:${domain.id}`, match: `*@${domain.name}`, to: [], kind: 'default' as const, domain }))
  return sorted([...rows, ...defaults])
}
const kindLabel: Record<Row['kind'], string> = { route: 'Route', address: 'Address', pattern: 'Address pattern', default: 'Domain default' }
const tierLabel: Record<RouteTier, string> = { exact: 'Route for this address', address: 'Its own address', pattern: 'Pattern route', subaddress: 'Plus address, routed by its base', catchall: 'Catch-all route', default: 'Domain default' }

function Destinations({ to, row, byId }: { to: string[] | 'drop'; row?: Row; byId: Map<string, Destination> }) {
  if (to === 'drop') return <span className="muted">Dropped, not stored</span>
  if (row?.kind === 'default') return <span className="muted">{row.domain?.catchAll === 'create_address' ? 'A new address per recipient' : 'Kept, no inbox'}</span>
  if (!to.length) return <span className="muted">Kept, no inbox</span>
  return <span className="routing-destinations">{to.map(id => { const d = byId.get(id); return <span key={id} className={d?.paused ? 'muted' : undefined}>{d ? d.name : id}{d?.paused ? ' (paused)' : ''}</span> })}</span>
}

export function RoutingPage() {
  const { canAdminister } = useWorkspaceAccess()
  const routing = useApiDef(queries.routing(), { enabled: canAdminister })
  const addresses = useApiDef(queries.inboundAddressOptions(), { enabled: canAdminister })
  const webhooks = useApiDef(queries.inboundWebhooks(), { enabled: canAdminister })
  const domains = useApiDef(queries.inboundDomains(), { enabled: canAdminister })
  const [tab, setTab] = useState('addresses')
  const [editing, setEditing] = useState<{ match: string; to: string[] | 'drop'; route?: MailRoute } | null>(null)
  const [testing, setTesting] = useState(false)
  const navigate = useNavigate()
  if (!canAdminister) return <div className="stack inbound-stack"><PageHeader title="Routing" backTo="/receiving" /><EmptyState title="Only owners and admins can manage routing" /></div>
  const routes = routing.data?.routes ?? []
  const destinations = destinationsOf(addresses.data ?? [], webhooks.data ?? [])
  const byId = new Map(destinations.map(d => [d.id, d]))
  const rows = rowsOf(routes, addresses.data ?? [], domains.data ?? [])
  const failure = routing.error ?? addresses.error ?? webhooks.error ?? domains.error
  const loading = routing.isPending || addresses.isPending || webhooks.isPending || domains.isPending
  // Address wildcard rules are edited on their address; every other row opens the route builder, pre-filled.
  const open = (row: Row) => row.kind === 'pattern' && row.owner ? navigate(`/receiving/addresses/${row.owner.id}`)
    : setEditing(row.route ? { match: row.match, to: row.to, route: row.route } : { match: row.match, to: row.kind === 'default' ? [] : row.to })
  const uses = (id: string) => routes.filter(r => Array.isArray(r.to) && r.to.includes(id)).length
  return <div className="stack inbound-stack">
    <PageHeader title="Routing" backTo="/receiving" actions={<><Button onClick={() => setTesting(true)}>Test routing</Button><Button variant="primary" onClick={() => setEditing({ match: '', to: [] })}>Add route</Button></>} />
    <p className="muted inbound-note">Mail to an address goes to the inbox that owns it. A route sends it somewhere else, or to more places: one address, a pattern like <code>reply+*@</code>, or a whole domain with <code>*@</code>. The most specific match wins.</p>
    <Tabs label="Routing views" value={tab} onValueChange={setTab} items={[{ value: 'addresses', label: 'Addresses', count: rows.length }, { value: 'destinations', label: 'Destinations', count: destinations.length }]} />
    {failure ? <ErrorState error={failure} onRetry={() => { void routing.refetch(); void addresses.refetch(); void webhooks.refetch(); void domains.refetch() }} />
      : tab === 'addresses' ? <DataTable loading={loading} skeletonRows={4} rows={rows} rowKey={row => row.key} onRowClick={open}
        empty={<EmptyState title="Nothing receives mail yet" description="Create a receiving address, or add a route for a domain that receives mail." action={<Link to="/receiving">Receiving</Link>} />}
        columns={[
          { key: 'match', label: 'Mail to', width: '36%', render: row => <span className={row.route?.enabled === false ? 'muted receiving-clip' : 'receiving-clip'}>{row.kind === 'default' ? <>Anything else <span className="muted">@{row.domain?.name}</span></> : row.match}</span> },
          { key: 'to', label: 'Goes to', width: '42%', render: row => <Destinations to={row.to} row={row} byId={byId} /> },
          { key: 'kind', label: 'Type', render: row => <span className="muted">{row.route?.enabled === false ? 'Route · off' : kindLabel[row.kind]}</span> },
        ]} />
      : <DataTable loading={loading} skeletonRows={3} rows={destinations} rowKey={d => d.id}
        empty={<EmptyState title="No destinations" description="Create a receiving address or an inbound webhook to route mail to it." />}
        columns={[
          { key: 'name', label: 'Destination', width: '38%', render: d => <div className="settings-cell-stack"><Link to={d.href}>{d.name}</Link>{d.detail !== d.name && <span className="muted receiving-clip">{d.detail}</span>}</div> },
          { key: 'kind', label: 'Type', width: '18%', render: d => d.kind === 'inbox' ? 'Inbox' : d.routeOnly ? 'Webhook · routed only' : 'Webhook' },
          { key: 'format', label: 'Delivers', width: '24%', render: d => d.webhook ? <span className="muted">{d.webhook.format === 'inbound' ? 'inbound.new payload' : 'Bane event'}{d.webhook.junk === 'include' ? ', junk too' : ''}</span> : <span className="muted">Threads</span> },
          { key: 'routes', label: 'Routes', align: 'right', width: '8%', render: d => number(uses(d.id)) },
          { key: 'status', label: 'Status', render: d => <StatusBadge status={d.paused ? 'Paused' : 'Active'} tone={d.paused ? 'neutral' : 'success'} /> },
        ]} />}
    {editing && <RouteDialog key={editing.route?.id ?? editing.match} draft={editing} destinations={destinations} owners={addresses.data ?? []} onClose={() => setEditing(null)} />}
    {testing && <TestDialog byId={byId} routes={routes} onClose={() => setTesting(false)} />}
  </div>
}

const matchHint = (match: string) => {
  const m = match.trim().toLowerCase().replace(/^@/, '*@'), [local, host] = m.split('@')
  if (!local || !host) return 'An address (support@acme.com), a pattern (reply+*@acme.com) or a whole domain (*@acme.com).'
  return local === '*' ? `Every address at ${host} without a more specific route.` : local.includes('*') ? `Addresses at ${host} that fit this pattern, unless an exact route matches.` : `Only ${m}, and its plus addresses such as ${local}+tag@${host}.`
}
type Action = 'deliver' | 'keep' | 'drop'
function RouteDialog({ draft, destinations, owners, onClose }: { draft: { match: string; to: string[] | 'drop'; route?: MailRoute }; destinations: Destination[]; owners: InboundAddress[]; onClose: () => void }) {
  const route = draft.route
  const [match, setMatch] = useState(draft.match)
  const [action, setAction] = useState<Action>(draft.to === 'drop' ? 'drop' : draft.to.length || !route ? 'deliver' : 'keep')
  const [selected, setSelected] = useState<string[]>(Array.isArray(draft.to) ? draft.to : [])
  const [enabled, setEnabled] = useState(route?.enabled ?? true)
  const [problem, setProblem] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const save = useApiMutation((api, input: { match: string; to: string[] | 'drop'; enabled: boolean }) => route ? api.routing.updateRoute(route.id, input) : api.routing.createRoute(input), route ? 'Route saved' : 'Route added')
  const remove = useApiMutation((api, _: void) => api.routing.deleteRoute(route!.id), 'Route deleted')
  const normalized = match.trim().toLowerCase()
  const owner = owners.find(a => a.address === normalized || a.aliases.includes(normalized))
  const losesOwner = owner && (action !== 'deliver' || !selected.includes(owner.id))
  const toggle = (id: string, on: boolean) => { setProblem(null); setSelected(on ? [...selected, id] : selected.filter(value => value !== id)) }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!normalized.includes('@')) return setProblem('Enter an address, a pattern or *@domain.')
    if (action === 'deliver' && !selected.length) return setProblem('Choose at least one destination, or keep the mail without an inbox.')
    const order = new Map(destinations.map((d, i) => [d.id, i]))
    try { await save.mutateAsync({ match: normalized, to: action === 'drop' ? 'drop' : action === 'keep' ? [] : [...selected].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)), enabled }); onClose() } catch { /* Shown in the form. */ }
  }
  const group = (kind: Destination['kind'], label: string, empty: ReactNode) => {
    const items = destinations.filter(d => d.kind === kind)
    return <fieldset className="routing-choices" disabled={save.isPending}>
      <legend className="ui-field__label">{label}</legend>
      {items.length ? <div className="settings-choices">{items.map(d => <Checkbox key={d.id} checked={selected.includes(d.id)} onCheckedChange={on => toggle(d.id, on)} label={<span className="settings-cell-stack"><span>{d.name}{d.paused ? ' (paused)' : ''}</span>{d.detail !== d.name && <span className="ui-field__hint">{d.detail}</span>}</span>} />)}</div> : <p className="muted">{empty}</p>}
    </fieldset>
  }
  return <>
    <Dialog open onOpenChange={next => { if (!next && !save.isPending) onClose() }} title={route ? 'Edit route' : owner && draft.match ? `Route ${owner.address === normalized ? owner.address : normalized}` : 'Add route'}
      footer={<>
        {route && <Button variant="ghost" className="routing-delete" disabled={save.isPending} onClick={() => setConfirmDelete(true)}>Delete route</Button>}
        <Button disabled={save.isPending} onClick={onClose}>Cancel</Button>
        <Button variant="primary" type="submit" form="routing-route" loading={save.isPending}>{route ? 'Save route' : 'Add route'}</Button>
      </>}>
      <form id="routing-route" className="stack" onSubmit={submit} noValidate>
        <Field label="Mail to" htmlFor="routing-match" error={fieldError(save.error, 'match')} hint={matchHint(match)}>
          <Input id="routing-match" value={match} autoFocus={!draft.match} disabled={save.isPending} placeholder="support@acme.com" onChange={e => { setMatch(e.target.value); setProblem(null) }} />
        </Field>
        <Field label="Goes to" htmlFor="routing-action" error={fieldError(save.error, 'to')}>
          <Select id="routing-action" value={action} disabled={save.isPending} onValueChange={value => { setAction(value as Action); setProblem(null) }}
            options={[{ value: 'deliver', label: 'These destinations' }, { value: 'keep', label: 'Keep it, without an inbox' }, { value: 'drop', label: 'Drop it' }]} />
        </Field>
        {action === 'deliver' && <>
          {group('inbox', 'Inboxes', <>No addresses yet. <Link to="/receiving">Create one</Link>.</>)}
          {group('webhook', 'Webhooks', <>No inbound webhooks yet. <Link to="/receiving/webhooks">Add one</Link>.</>)}
        </>}
        {action === 'keep' && <p className="muted routing-explain">Mail is stored and readable through the API by message ID, but appears in no inbox.</p>}
        {action === 'drop' && <Alert tone="warning">Dropped mail is not stored and cannot be recovered. Its receipt still records that it arrived.</Alert>}
        {losesOwner && <Alert tone="warning">Mail to {normalized} will stop reaching {owner.displayName || owner.address}. Check it under Inboxes to keep it.</Alert>}
        {route && <Switch checked={enabled} disabled={save.isPending} onCheckedChange={setEnabled} label="On. When off, this mail follows the next most specific rule." />}
        {problem && <p className="ui-field__error" role="alert">{problem}</p>}
        {!fieldError(save.error, 'match') && !fieldError(save.error, 'to') && <MutationError error={save.error} />}
      </form>
    </Dialog>
    <ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} danger title="Delete route?" description={`Mail to ${route?.match ?? ''} falls back to the next most specific rule: its own inbox, a pattern or the domain default.`} confirmLabel="Delete route" pending={remove.isPending}
      onConfirm={async () => { try { await remove.mutateAsync(); setConfirmDelete(false); onClose() } catch { /* The dialog stays open. */ } }} />
  </>
}

const encode = (text: string) => { const bytes = new TextEncoder().encode(text.replace(/\r?\n/g, '\r\n')); let binary = ''; for (const b of bytes) binary += String.fromCharCode(b); return btoa(binary) }
function TestDialog({ byId, routes, onClose }: { byId: Map<string, Destination>; routes: MailRoute[]; onClose: () => void }) {
  const [mode, setMode] = useState<'address' | 'message'>('address')
  const [recipients, setRecipients] = useState('')
  const [message, setMessage] = useState('')
  const [junk, setJunk] = useState(false)
  const test = useApiMutation((api, input: Parameters<typeof api.routing.test>[0]) => api.routing.test(input), undefined, false, false)
  const ready = mode === 'address' ? recipients.trim().length > 0 : message.trim().length > 0
  function run(event: FormEvent) {
    event.preventDefault()
    if (!ready) return
    test.mutate(mode === 'address' ? { to: recipients.split(/[\s,;]+/).map(v => v.trim().toLowerCase()).filter(Boolean), junk } : { raw: encode(message), junk })
  }
  const reset = () => test.reset()
  return <Dialog open onOpenChange={next => { if (!next) onClose() }} title="Test routing" description="Nothing is delivered or saved."
    footer={<><Button onClick={onClose}>Close</Button><Button variant="primary" type="submit" form="routing-test" disabled={!ready} loading={test.isPending}>Test</Button></>}>
    <form id="routing-test" className="stack" onSubmit={run} noValidate>
      <Tabs label="Test with" value={mode} onValueChange={value => { setMode(value as 'address' | 'message'); reset() }} items={[{ value: 'address', label: 'Recipients' }, { value: 'message', label: 'Pasted message' }]} />
      {mode === 'address'
        ? <Field label="Recipients" htmlFor="routing-test-to" hint="One or more addresses, separated by commas."><Input id="routing-test-to" autoFocus value={recipients} placeholder="support+billing@acme.com" onChange={e => { setRecipients(e.target.value); reset() }} /></Field>
        : <Field label="Message" htmlFor="routing-test-raw" hint="The full message with its headers. Its To and Cc addresses are tested."><Textarea id="routing-test-raw" rows={7} value={message} placeholder={'From: ana@example.org\nTo: support@acme.com\nSubject: Invoice\n\nHello'} onChange={e => { setMessage(e.target.value); reset() }} /></Field>}
      <Checkbox checked={junk} onCheckedChange={on => { setJunk(on); reset() }} label="Treat it as junk (spam verdict not PASS)" />
      <MutationError error={test.error} />
      {test.data && <div className="stack routing-results" aria-live="polite">
        {test.data.message && <p className="muted routing-explain">{test.data.message.subject || '(no subject)'}{test.data.message.from ? ` · from ${test.data.message.from}` : ''}</p>}
        {test.data.recipients.map(r => <Result key={r.address} result={r} byId={byId} routes={routes} />)}
      </div>}
    </form>
  </Dialog>
}
function Result({ result, byId, routes }: { result: RoutedRecipient; byId: Map<string, Destination>; routes: MailRoute[] }) {
  // Name the rule that decided: the route's match, or the base address a plus address followed.
  const rule = routes.find(r => r.id === result.route)?.match ?? (result.tier === 'subaddress' ? result.address.replace(/\+[^@]*@/, '@') : null)
  const names = [...result.inboxes, ...result.webhooks].map(id => byId.get(id)?.name ?? id)
  const goes = result.dropped ? 'Dropped, not stored' : names.length ? names.join(', ') : result.tier === 'default' && result.domainDefault === 'create_address' ? 'A new address for this recipient' : 'Kept, no inbox'
  return <dl className="routing-result">
    <dt>Mail to</dt><dd>{result.address}</dd>
    <dt>Matched</dt><dd>{tierLabel[result.tier]}{rule && rule !== result.address && <span className="muted"> · {rule}</span>}</dd>
    <dt>Goes to</dt><dd>{goes}</dd>
    {result.warnings.length > 0 && <><dt>Skipped</dt><dd className="muted">{result.warnings.map(w => <span key={w} className="routing-warning">{w.replace(/^(\S+)/, id => byId.get(id)?.name ?? id)}</span>)}</dd></>}
  </dl>
}
