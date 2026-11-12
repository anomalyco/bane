import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { Alert, Button, Checkbox, ConfirmDialog, DataTable, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, Pagination, SectionHeader, Select, SkeletonText, StatusBadge } from '../../components/ui'
import { useApiDef, useApiMutation, useApiQuery, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import { inboundEventTypes, type InboundAddress, type InboundWebhook, type InboundWebhookInput, type MailboxEventType } from '../../data/types'
import { date, time } from '../../lib/format'
import { useCursorPagination } from '../../lib/pagination'
import { fieldError, MutationError, SecretDialog } from '../settings/shared'
import { headerDraftErrors, HeaderNames, headerPayload, headersChanged, WebhookHeadersField, type HeaderDraft } from '../settings/webhook-headers'
import '../settings/settings.css'
import './inbound.css'
import { AddressList, NamedAddress, PrivateAddress } from '../../components/PrivateAddress'

const eventInfo: Partial<Record<MailboxEventType, string>> = {
  'message.junk': 'Received mail whose spam verdict isn’t PASS, when junk delivery is on',
  'message.stored': 'Every new inbound message, including unrouted mail. Requires Every address.', 'message.sent': 'SES accepted an outgoing message',
  'message.delivered': 'The recipient server accepted it', 'message.delayed': 'Delivery is being retried',
  'message.complained': 'The recipient reported spam', 'message.failed': 'The message was rejected, suppressed or canceled',
  'thread.updated': 'A conversation was archived, starred, trashed or relabeled', 'address.created': 'An address was created (including automatically)',
  'inbox.created': 'An agent inbox was created', 'inbox.deleted': 'An agent inbox was erased', 'message.held': 'Mail was stored but held: over an inbox’s limits or after it expired',
  'inbox.quota_exceeded': 'An agent inbox reached its message or byte limit',
}
// routeOnly is form state: a webhook that subscribes to no events and only gets mail a route sends to it.
type Draft = InboundWebhookInput & { routeOnly: boolean }
const blank: Draft = { url: '', description: '', eventTypes: ['message.received'], addressIds: null, format: 'bane', routeOnly: false }
const draftOf = (webhook: InboundWebhook): Draft => ({ url: '', description: webhook.description, eventTypes: [...webhook.eventTypes].sort(), addressIds: webhook.addressIds, format: webhook.format ?? 'bane', junk: webhook.junk, routeOnly: !webhook.eventTypes.length })
const payloadOf = ({ routeOnly, ...input }: Draft): InboundWebhookInput => ({ ...input, url: input.url.trim(), description: input.description.trim(), eventTypes: routeOnly ? [] : input.eventTypes })
// The inbound.new payload describes received mail only.
const receivedOnly = (types: MailboxEventType[]) => types.filter(type => type === 'message.received' || type === 'message.junk')
function validate(input: Draft, editing = false) {
  const errors: Record<string, string> = {}
  if (!editing || input.url.trim()) {
    try { const url = new URL(input.url.trim()); if (url.protocol !== 'https:' || url.username || url.password) errors.url = 'Enter an HTTPS URL without embedded credentials.' } catch { errors.url = 'Enter a valid HTTPS endpoint URL.' }
  }
  if (!input.routeOnly && !input.eventTypes.length) errors.eventTypes = 'Choose at least one event.'
  if (input.addressIds && !input.addressIds.length) errors.addressIds = 'Choose at least one address, or send events for every address.'
  return errors
}
const scopeText = (webhook: InboundWebhook, addresses?: InboundAddress[]) => !webhook.eventTypes.length ? 'Routed mail only' : webhook.addressIds ? <AddressList values={webhook.addressIds.map(id => addresses?.find(item => item.id === id)?.address ?? id)} /> : 'All addresses'

function WebhookFields({ input, urlHint, onChange, addresses, errors, apiError, disabled, headers }: { input: Draft; urlHint?: string; onChange: (input: Draft) => void; addresses?: InboundAddress[]; errors: Record<string, string>; apiError: unknown; disabled: boolean; headers: { current: InboundWebhook['headers']; draft: HeaderDraft; onChange: (draft: HeaderDraft) => void } }) {
  return <div className="stack">
    <div className="form-grid">
      <Field label="Description" htmlFor="mailbox-webhook-description"><Input id="mailbox-webhook-description" value={input.description} onChange={event => onChange({ ...input, description: event.target.value })} disabled={disabled} placeholder="Support agent runtime" /></Field>
      <Field label="Endpoint URL" htmlFor="mailbox-webhook-url" error={errors.url || fieldError(apiError, 'url')} hint={urlHint ? 'Leave blank to keep the saved URL, or enter a replacement.' : 'A public HTTPS URL. Signed with Standard Webhooks headers.'}><Input id="mailbox-webhook-url" type="url" value={input.url} onChange={event => onChange({ ...input, url: event.target.value })} disabled={disabled} placeholder={urlHint ?? 'https://agents.acme.com/hooks/mail'} /></Field>
    </div>
    <div className="form-grid">
      <Field label="Addresses" htmlFor="mailbox-webhook-scope" error={errors.addressIds || fieldError(apiError, 'addressIds')} hint={input.routeOnly ? <>Send mail to it from an address’s <Link to="/receiving">Goes to</Link>.</> : input.addressIds === null ? 'Includes addresses created later.' : undefined}>
        <Select id="mailbox-webhook-scope" value={input.routeOnly ? 'routed' : input.addressIds === null ? 'all' : 'selected'} disabled={disabled}
          onValueChange={value => onChange({ ...input, routeOnly: value === 'routed', addressIds: value === 'selected' ? [] : null, eventTypes: value === 'selected' ? input.eventTypes.filter(type => type !== 'message.stored') : input.eventTypes.length ? input.eventTypes : ['message.received'] })}
          options={[{ value: 'all', label: 'Every address' }, { value: 'selected', label: 'Selected addresses' }, { value: 'routed', label: 'Only mail a route sends here' }]} />
      </Field>
      <Field label="Payload" htmlFor="mailbox-webhook-format" hint={input.format === 'inbound' ? 'inbound.new’s email.received, for receivers moved from inbound.new. Signed like Bane events too.' : 'Bane’s signed event. Read the message with its messageId.'}>
        <Select id="mailbox-webhook-format" value={input.format ?? 'bane'} disabled={disabled} onValueChange={value => onChange({ ...input, format: value as Draft['format'], junk: undefined, eventTypes: value === 'inbound' ? receivedOnly(input.eventTypes).length ? receivedOnly(input.eventTypes) : ['message.received'] : input.eventTypes })} options={[{ value: 'bane', label: 'Bane event' }, { value: 'inbound', label: 'inbound.new email.received' }]} />
      </Field>
    </div>
    <Checkbox disabled={disabled} checked={(input.junk ?? (input.format === 'inbound' ? 'include' : 'skip')) === 'include'} onCheckedChange={checked => onChange({ ...input, junk: checked ? 'include' : 'skip' })} label={<span className="settings-cell-stack"><span>Deliver junk mail too</span><span className="ui-field__hint">Mail whose spam verdict isn’t PASS, as message.junk or with spam.isJunk.</span></span>} />
    {!input.routeOnly && input.addressIds !== null && <div className="settings-choices" role="group" aria-label="Addresses">{!addresses?.length ? <p className="muted">No addresses yet.</p> : addresses.map(address => <Checkbox key={address.id} label={address.address} disabled={disabled} checked={input.addressIds!.includes(address.id)} onCheckedChange={checked => onChange({ ...input, addressIds: checked ? [...input.addressIds!, address.id] : input.addressIds!.filter(id => id !== address.id) })} />)}</div>}
    {!input.routeOnly && <fieldset className="mailbox-webhook-events" disabled={disabled}>
      <legend className="ui-field__label">Events</legend>
      {inboundEventTypes.map(type => <Checkbox key={type} disabled={(type === 'message.stored' && input.addressIds !== null) || (input.format === 'inbound' && !receivedOnly([type]).length)} label={<span className="settings-cell-stack"><code>{type}</code>{eventInfo[type] && <span className="ui-field__hint">{eventInfo[type]}</span>}</span>} checked={input.eventTypes.includes(type)} onCheckedChange={checked => onChange({ ...input, eventTypes: checked ? [...input.eventTypes, type] : input.eventTypes.filter(value => value !== type) })} />)}
      {(errors.eventTypes || fieldError(apiError, 'eventTypes')) && <p className="ui-field__error" role="alert">{errors.eventTypes || fieldError(apiError, 'eventTypes')}</p>}
    </fieldset>}
    <WebhookHeadersField current={headers.current} draft={headers.draft} onChange={headers.onChange} errors={errors} apiError={apiError} disabled={disabled} />
  </div>
}

// Inbound webhooks are admin-only; members get a calm notice instead of requests that would be refused.
function AdminOnly({ title, backTo }: { title: string; backTo: string }) {
  return <div className="stack inbound-stack"><PageHeader title={title} backTo={backTo} /><EmptyState title="Only owners and admins can manage webhooks" /></div>
}
export function InboundWebhooksPage() { return useWorkspaceAccess().canAdminister ? <WebhooksList /> : <AdminOnly title="Inbound webhooks" backTo="/receiving" /> }
export function InboundWebhookDetailPage() { return useWorkspaceAccess().canAdminister ? <WebhookDetail /> : <AdminOnly title="Inbound webhook" backTo="/receiving" /> }

function WebhooksList() {
  const navigate = useNavigate()
  // ?address= keeps the webhooks that get that address's received mail: the full list a route's "Goes to" links to.
  const [params] = useSearchParams()
  const addressId = params.get('address') ?? undefined
  const pagination = useCursorPagination()
  const webhooks = useApiQuery(['inbound-webhooks', 'page', addressId ?? '', pagination.cursor ?? ''], (api, signal) => api.inbound.webhookPage({ cursor: pagination.cursor, addressId }, signal), { keepPrevious: true })
  const addresses = useApiDef(queries.inboundAddressOptions())
  const create = useApiMutation((api, input: InboundWebhookInput) => api.inbound.createWebhook(input), 'Webhook created')
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState<Draft>(blank)
  const [headers, setHeaders] = useState<HeaderDraft>([])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [secret, setSecret] = useState<{ value: string; id: string } | null>(null)
  function openCreate() { create.reset(); setInput(blank); setHeaders([]); setErrors({}); setOpen(true) }
  async function submit(event: FormEvent) {
    event.preventDefault()
    const next = { ...validate(input), ...headerDraftErrors(headers) }; setErrors(next)
    if (Object.keys(next).length) return
    try { const result = await create.mutateAsync({ ...payloadOf(input), headers: headerPayload(headers) }); setOpen(false); setSecret({ value: result.secret, id: result.webhook.id }) } catch { /* Shown in the form. */ }
  }
  return <div className="stack inbound-stack">
    <PageHeader title="Inbound webhooks" backTo="/receiving?tab=endpoints" actions={<Button variant="primary" onClick={openCreate}>Add webhook</Button>} />
    <p className="muted inbound-note">Signed POST requests (Standard Webhooks) for mail on inbound addresses: received messages and the replies you send from them. Without a public URL, long-poll <code>GET /v1/inbound/events</code>. For email sent through the send API, use <Link to="/settings#webhooks">Settings webhooks</Link>.</p>
    {addressId && <p className="muted inbound-note">The active and paused webhooks that get this address’s mail. <Link to="/receiving/webhooks">Show all webhooks</Link></p>}
    {webhooks.error ? <ErrorState error={webhooks.error} onRetry={() => void webhooks.refetch()} /> : <DataTable loading={webhooks.isPending || (addresses.isPending && !addresses.error)} skeletonRows={2} minRows={2} rows={webhooks.data?.data ?? []} rowKey={row => row.id} onRowClick={row => navigate(`/receiving/webhooks/${row.id}`)}
      empty={addressId ? <EmptyState title="No webhook gets this address’s mail" description="Webhooks subscribed to message.received for it, or for every address, show up here." /> : <EmptyState title="No inbound webhooks" description="Get a POST when mail arrives or a sent message is delivered." action={<Button onClick={openCreate}>Add webhook</Button>} />}
      columns={[
        { key: 'endpoint', label: 'Endpoint', width: '34%', render: row => <div className="settings-cell-stack"><Link to={`/receiving/webhooks/${row.id}`}>{row.description || row.url}</Link>{row.description && <span className="muted settings-break">{row.url}</span>}</div> },
        { key: 'addresses', label: 'Addresses', width: '20%', render: row => <span className="settings-break">{scopeText(row, addresses.data)}</span> },
        { key: 'events', label: 'Events', width: '14%', render: row => <span title={row.eventTypes.join(', ')}>{!row.eventTypes.length ? <span className="muted">None</span> : row.eventTypes.length === 1 ? row.eventTypes[0] : row.eventTypes.length}</span> },
        { key: 'headers', label: 'Headers', width: '16%', render: row => <HeaderNames headers={row.headers} /> },
        { key: 'status', label: 'Status', render: row => <StatusBadge status={row.paused ? 'Paused' : 'Active'} tone={row.paused ? 'neutral' : 'success'} /> },
      ]} />}
    {webhooks.data && <Pagination page={pagination.page} pageSize={50} nextCursor={webhooks.data.nextCursor} onPageChange={next => pagination.onPageChange(next, webhooks.data?.nextCursor)} />}
    <Dialog open={open} onOpenChange={next => { if (!create.isPending) setOpen(next) }} title="Add inbound webhook" footer={<><Button disabled={create.isPending} onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={create.isPending} type="submit" form="create-mailbox-webhook">Add webhook</Button></>}>
      <form id="create-mailbox-webhook" className="stack" onSubmit={submit} noValidate>
        <MutationError error={create.error} />
        <WebhookFields input={input} onChange={setInput} addresses={addresses.data} errors={errors} apiError={create.error} disabled={create.isPending} headers={{ current: [], draft: headers, onChange: setHeaders }} />
      </form>
    </Dialog>
    <SecretDialog secret={secret?.value ?? null} title="Signing secret" onClose={() => { const target = secret?.id; setSecret(null); if (target) navigate(`/receiving/webhooks/${target}`) }} />
  </div>
}

function WebhookDetail() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const webhook = useApiQuery(['inbound-webhook', id], (api, signal) => api.inbound.webhook(id, signal))
  const deliveries = useApiQuery(['inbound-webhook-deliveries', id], (api, signal) => api.inbound.webhookDeliveries(id, undefined, signal))
  const addresses = useApiDef(queries.inboundAddressOptions())
  const save = useApiMutation((api, patch: Parameters<typeof api.inbound.updateWebhook>[1]) => api.inbound.updateWebhook(id, patch), 'Webhook saved')
  const rotate = useApiMutation((api, _: void) => api.inbound.rotateWebhookSecret(id))
  const remove = useApiMutation((api, _: void) => api.inbound.deleteWebhook(id), 'Webhook deleted')
  const [input, setInput] = useState<Draft | null>(null)
  const [headers, setHeaders] = useState<HeaderDraft>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [secret, setSecret] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<'rotate' | 'delete' | null>(null)
  useEffect(() => { if (webhook.data && !input) setInput(draftOf(webhook.data)) }, [webhook.data, input])
  if (webhook.error) return <><PageHeader title="Inbound webhook" backTo="/receiving/webhooks" /><ErrorState error={webhook.error} onRetry={() => void webhook.refetch()} /></>
  const current = webhook.data
  // The saved response is newer than the cached endpoint until the refetch lands.
  const currentHeaders = save.data?.headers ?? current?.headers ?? []
  const dirty = !!current && !!input && (headersChanged(headers, currentHeaders) || JSON.stringify(draftOf(current)) !== JSON.stringify({ ...input, eventTypes: [...input.eventTypes].sort() }))
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!input) return
    const next = { ...validate(input, true), ...headerDraftErrors(headers) }; setErrors(next)
    if (Object.keys(next).length) return
    const { url, ...patch } = payloadOf(input)
    try { const saved = await save.mutateAsync({ ...patch, ...(url ? { url } : {}), headers: headerPayload(headers, currentHeaders) }); setInput(draftOf(saved)); setHeaders(null) } catch { /* Shown in the form. */ }
  }
  return <div className="stack inbound-stack">
    <PageHeader title={current ? current.description || current.url : <SkeletonText width={220} lineHeight={28} />} backTo="/receiving/webhooks" actions={current && <>
      <Button onClick={() => void save.mutateAsync({ paused: !current.paused }).catch(() => undefined)} loading={save.isPending && !dirty}>{current.paused ? 'Resume' : 'Pause'}</Button>
      <Button onClick={() => setConfirm('rotate')}>Rotate secret</Button>
      <Button variant="danger" onClick={() => setConfirm('delete')}>Delete</Button>
    </>} />
    {!current || addresses.isPending || deliveries.isPending ? <SkeletonText width="60%" /> : <>
      <dl className="settings-facts">
        <div><dt>Status</dt><dd><StatusBadge status={current.paused ? 'Paused' : 'Active'} tone={current.paused ? 'neutral' : 'success'} /></dd></div>
        <div><dt>Created</dt><dd>{date(current.createdAt)}</dd></div>
      </dl>
      {current.paused && <Alert tone="info">No new deliveries are queued. Events keep recording and stay readable through the events API.</Alert>}
      <section className="section section--bordered stack">
        <SectionHeader title="Recent deliveries" />
        {deliveries.error ? <ErrorState error={deliveries.error} onRetry={() => void deliveries.refetch()} /> : <DataTable skeletonRows={3} minRows={3} rows={deliveries.data ?? []} rowKey={row => row.id} empty={<EmptyState title="No deliveries yet" />}
          columns={[
            { key: 'time', label: 'Time (UTC)', width: 200, render: row => <span className="muted mailbox-nowrap">{date(row.createdAt, { month: 'short', day: 'numeric', timeZone: 'UTC' })} · {time(row.createdAt)}</span> },
            { key: 'status', label: 'Status', width: 120, render: row => <StatusBadge status={row.status === 'delivered' ? 'Delivered' : row.status === 'failed' ? 'Failed' : 'Retrying'} tone={row.status === 'delivered' ? 'success' : row.status === 'failed' ? 'danger' : 'warning'} /> },
            { key: 'code', label: 'Response', width: 100, render: row => row.lastStatusCode ?? '—' },
            { key: 'attempts', label: 'Attempts', width: 90, render: row => row.attemptCount },
            { key: 'event', label: 'Event', render: row => <code className="settings-break">{row.eventId}</code> },
          ]} />}
      </section>
      <section className="section section--bordered stack">
        <SectionHeader title="Settings" />
        {!input ? <SkeletonText width="60%" /> : <form className="stack" onSubmit={submit} noValidate>
          <MutationError error={save.error} />
          <WebhookFields input={input} urlHint={save.data?.url ?? current.url} onChange={setInput} addresses={addresses.data} errors={errors} apiError={save.error} disabled={save.isPending} headers={{ current: currentHeaders, draft: headers, onChange: setHeaders }} />
          <div className="cluster"><Button variant="primary" type="submit" loading={save.isPending && dirty} disabled={!dirty}>Save changes</Button>{dirty && <Button onClick={() => { setInput(null); setHeaders(null); setErrors({}) }}>Discard</Button>}</div>
        </form>}
      </section>
    </>}
    <ConfirmDialog open={confirm === 'rotate'} onOpenChange={open => { if (!open) setConfirm(null) }} title="Rotate signing secret?" description="The old secret stops working immediately. Update your endpoint with the new secret right away." confirmLabel="Rotate secret" pending={rotate.isPending} onConfirm={async () => { setSecret((await rotate.mutateAsync()).secret) }} />
    <ConfirmDialog open={confirm === 'delete'} onOpenChange={open => { if (!open) setConfirm(null) }} title="Delete this webhook?" description="Pending deliveries are dropped, and routes that deliver to it stop doing so. Events stay available through the events API." confirmLabel="Delete webhook" danger pending={remove.isPending} onConfirm={async () => { await remove.mutateAsync(); navigate('/receiving/webhooks') }} />
    <SecretDialog secret={secret} title="New signing secret" onClose={() => setSecret(null)} />
  </div>
}
