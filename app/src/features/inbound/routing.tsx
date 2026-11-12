// Routes: the route editor ("Goes to"), opened from a route row or an address's page.
import { useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router'
import { Alert, Button, Checkbox, ConfirmDialog, Dialog, Field, Input, Select, Switch } from '../../components/ui'
import { useApiDef, useApiMutation } from '../../data/context'
import { queries } from '../../data/queries'
import type { InboundAddress, InboundWebhook, MailRoute } from '../../data/types'
import { fieldError, MutationError } from '../settings/shared'
import '../settings/settings.css'
import './inbound.css'
type Destination = { id: string; name: string; detail: string; kind: 'inbox' | 'webhook'; paused: boolean; routeOnly: boolean; href: string; webhook?: InboundWebhook }
function destinationsOf(addresses: InboundAddress[], webhooks: InboundWebhook[]): Destination[] {
  return [
    ...addresses.map(a => ({ id: a.id, name: a.displayName || a.address, detail: a.address, kind: 'inbox' as const, paused: false, routeOnly: false, href: `/receiving/addresses/${a.id}` })),
    ...webhooks.map(h => ({ id: h.id, name: h.name || h.description || h.url, detail: h.url, kind: 'webhook' as const, paused: h.paused, routeOnly: !h.eventTypes.length, href: `/receiving/webhooks/${h.id}`, webhook: h })),
  ]
}

// One row per recipient rule, read as "mail to X goes to Y". Address rows are the implicit routes every inbox has.

/** Loads what a route can deliver to (inboxes and webhooks) and opens the editor for one route, or a new one for `match`. */
export function RouteEditor({ match, route, to, onClose }: { match: string; route?: { id: string; enabled: boolean; to: string[] | 'drop' } | null; to?: string[]; onClose: () => void }) {
  const addresses = useApiDef(queries.inboundAddressOptions())
  const webhooks = useApiDef(queries.inboundWebhooks())
  if (!addresses.data || !webhooks.data) return null
  const draft = route ? { match, to: route.to, route: { id: route.id, enabled: route.enabled, match, to: route.to } as MailRoute } : { match, to: to ?? [] }
  return <RouteDialog draft={draft} destinations={destinationsOf(addresses.data, webhooks.data)} owners={addresses.data} onClose={onClose} />
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
    if (action === 'deliver' && !selected.length) return setProblem('Choose at least one inbox or endpoint, or store it without an inbox.')
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
        <Field label="Route" htmlFor="routing-match" error={fieldError(save.error, 'match')} hint={matchHint(match)}>
          <Input id="routing-match" value={match} autoFocus={!draft.match} disabled={save.isPending} placeholder="support@acme.com" onChange={e => { setMatch(e.target.value); setProblem(null) }} />
        </Field>
        <Field label="Goes to" htmlFor="routing-action" error={fieldError(save.error, 'to')}>
          <Select id="routing-action" value={action} disabled={save.isPending} onValueChange={value => { setAction(value as Action); setProblem(null) }}
            options={[{ value: 'deliver', label: 'These inboxes and endpoints' }, { value: 'keep', label: 'Store it, no inbox' }, { value: 'drop', label: 'Drop it' }]} />
        </Field>
        {action === 'deliver' && <>
          {group('inbox', 'Inboxes', <>No addresses yet. <Link to="/receiving">Create one</Link>.</>)}
          {group('webhook', 'Endpoints', <>No webhooks yet. <Link to="/receiving?tab=endpoints">Add an endpoint</Link>.</>)}
        </>}
        {action === 'keep' && <p className="muted routing-explain">Mail is stored and readable through the API by message ID, but appears in no inbox.</p>}
        {action === 'drop' && <Alert tone="warning">Dropped mail is not stored and cannot be recovered. Its receipt still records that it arrived.</Alert>}
        {losesOwner && <Alert tone="warning">Mail to {normalized} will stop reaching {owner.displayName || owner.address}. Tick its inbox to keep it.</Alert>}
        {route && <Switch checked={enabled} disabled={save.isPending} onCheckedChange={setEnabled} label="On. When off, this mail follows the next most specific rule." />}
        {problem && <p className="ui-field__error" role="alert">{problem}</p>}
        {!fieldError(save.error, 'match') && !fieldError(save.error, 'to') && <MutationError error={save.error} />}
      </form>
    </Dialog>
    <ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} danger title="Delete route?" description={`Mail to ${route?.match ?? ''} falls back to the next most specific rule: its own inbox, a pattern or the domain default.`} confirmLabel="Delete route" pending={remove.isPending}
      onConfirm={async () => { try { await remove.mutateAsync(); setConfirmDelete(false); onClose() } catch { /* The dialog stays open. */ } }} />
  </>
}

