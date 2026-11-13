import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { PrivateAddress } from '../../components/PrivateAddress'
import { Alert, Button, Checkbox, CopyButton, SecretCode, Dialog, Field, Input, SecretInput, Select, type Tone } from '../../components/ui'
import { request } from '../../data/live'
import { ApiError } from '../../data/types'
const errorText = (e: unknown): string => e instanceof ApiError ? e.text : (e as Error).message
import { useApiDef } from '../../data/context'
import { queries } from '../../data/queries'
import { idempotencyFor } from './shared'
import '../settings/settings.css'
import './inbound.css'
import { useSingleFlight } from '../../lib/single-flight'

type EndpointType = 'slack' | 'discord' | 'webhook' | 'forward'
type EndpointStatus = 'ready' | 'pending' | 'expired' | 'declined' | 'paused'
export type Endpoint = { name: string; type: EndpointType; status: EndpointStatus; call: string; target: string; policy: { perMinute: number; retryOnTimeout: boolean; idempotent: boolean }; expiresAt: string | null; nextStep: string; createdAt: string }
const typeLabel: Record<EndpointType, string> = { slack: 'Slack', discord: 'Discord', webhook: 'Webhook', forward: 'Forward' }
const statusTone: Record<EndpointStatus, Tone> = { ready: 'success', pending: 'warning', expired: 'warning', declined: 'danger', paused: 'neutral' }
const statusLabel: Record<EndpointStatus, string> = { ready: 'Ready', pending: 'Awaiting recipient', expired: 'Link expired', declined: 'Declined', paused: 'Paused' }
const targetLabel: Record<EndpointType, string> = { slack: 'Slack incoming webhook URL', discord: 'Discord webhook URL', webhook: 'HTTPS URL', forward: 'Recipient address' }
const payloadOf: Record<EndpointType, string> = { slack: '({ text: … })', discord: '({ content: … })', webhook: '(payload?)', forward: '()' }
const typeHint: Record<EndpointType, string> = { slack: 'Posts a message to a Slack channel.', discord: 'Posts a message to a Discord channel.', webhook: 'Posts signed JSON to your server. Routes can send whole messages here too.', forward: 'Forwards the email to another address, once its owner agrees.' }

const hours = (iso: string | null) => iso ? Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 3600000)) : 0
/** The API's nextStep is written for agents; people get the same fact with the dashboard's own controls. */
function humanStep(e: Endpoint) {
  if (e.status === 'pending') return `Waiting for the recipient to confirm by email · link expires in ${hours(e.expiresAt)} h`
  if (e.status === 'expired') return 'Confirmation link expired · resend it from the menu'
  if (e.status === 'declined') return 'The recipient declined or stopped forwards'
  return 'Paused · calls wait until you resume'
}
/** The endpoint as the edit form needs it: what it is and whether it's paused. Its URL is write-only and never here. */
export type EditableEndpoint = { name: string; type: EndpointType; status: EndpointStatus; target: string }
const chat = (type: EndpointType) => type === 'slack' || type === 'discord'
/**
 * Creates an endpoint, or with `editing` edits one in place (PATCH, only what changed). Editing never shows the stored
 * URL: the field starts empty as "Replace URL", and left empty the endpoint keeps its URL.
 */
export function EndpointDialog({ open, onOpenChange, onCreated, onSaved, editing, types = Object.keys(typeLabel) as EndpointType[] }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated?: (e: Endpoint & { secret?: string }) => void; onSaved?: (e: Endpoint) => void; editing?: EditableEndpoint | null; types?: EndpointType[] }) {
  const boxes = useApiDef(queries.inboundAddressOptions(), { enabled: open && !editing })
  const [type, setType] = useState<EndpointType>(types[0]!)
  const [name, setName] = useState('')
  const [target, setTarget] = useState('')
  const [from, setFrom] = useState('')
  const [preverify, setPreverify] = useState(false)
  const [enabled, setEnabled] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [attempt] = useState({ key: '', body: '' })
  const [tried, setTried] = useState(false)
  useEffect(() => {
    if (!open) return
    setType(editing?.type ?? types[0]!); setName(editing?.name ?? ''); setTarget(''); setError(null); setPreverify(false); setTried(false); setEnabled(editing ? editing.status !== 'paused' : true)
  }, [open, editing]) // eslint-disable-line react-hooks/exhaustive-deps
  // Errors name the field and the fix, as soon as there's something to judge (or on Create).
  const nameValid = /^[a-z0-9][a-z0-9-]{0,62}$/.test(name)
  const value = target.trim()
  const retyped = !!editing && type !== editing.type
  // Editing keeps the URL when the field is left empty, unless the type changed (a Discord endpoint needs a Discord URL).
  const targetRequired = !editing || retyped
  const targetError = !value ? (tried && targetRequired && !(editing?.type === 'forward') ? (retyped ? `Enter the ${typeLabel[type]} webhook URL to switch to ${typeLabel[type]}.` : `Enter the ${targetLabel[type].replace(/^HTTPS URL$/, 'URL').toLowerCase()}.`) : '')
    : type === 'forward' ? (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? '' : 'Enter a full email address, like team@example.com.')
    : !/^https:\/\//i.test(value) ? (/^http:\/\//i.test(value) ? 'Use https://: Bane only posts to secure URLs.' : 'Start the URL with https://.')
    : type === 'slack' && !/^https:\/\/hooks\.slack\.com\//i.test(value) ? 'Use Slack’s incoming webhook URL, starting https://hooks.slack.com/.'
    : type === 'discord' && !/^https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\//i.test(value) ? 'Use Discord’s webhook URL, starting https://discord.com/api/webhooks/.' : ''
  const nameError = name && !nameValid ? `Use lowercase letters, digits and hyphens, like ${name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'support'}.` : !name && tried ? 'Name it, like support. Rituals call it by this name.' : ''
  // Only what changed goes to the API; an empty URL field is left out, so the stored URL stays.
  const changes = editing ? {
    ...(name.trim() !== editing.name ? { name: name.trim() } : {}),
    ...(retyped ? { type } : {}),
    ...(value && editing.type !== 'forward' ? { url: value } : {}),
    ...(enabled !== (editing.status !== 'paused') ? { paused: !enabled } : {}),
  } : null
  const serverError = (field: string) => error instanceof ApiError ? error.fields[field] : undefined
  const generalError = error && !(error instanceof ApiError && ['name', 'url', 'type', 'paused'].some(f => error.fields[f])) ? errorText(error) : ''
  // Single flight: a second Create before the first answers would post the endpoint again.
  const send = useSingleFlight(editing ? 'endpoints.update' : 'endpoints.create', async () => {
    setBusy(true); setError(null)
    try {
      if (editing) onSaved?.(await request<Endpoint>(`/v1/endpoints/${encodeURIComponent(editing.name)}`, { method: 'PATCH', body: changes }))
      else {
        const body = { type, name: name.trim(), ...(type === 'forward' ? { address: value, ...(from ? { from } : {}), ...(preverify ? { preverify } : {}) } : { url: value }) }
        onCreated?.(await request<Endpoint & { secret?: string }>('/v1/endpoints', { method: 'POST', body, idempotencyKey: idempotencyFor(attempt, body) }))
      }
    }
    catch (e) { setError(e) }
    finally { setBusy(false) }
  }, editing?.name)
  function submit(event: FormEvent) {
    event.preventDefault(); setTried(true)
    if (!nameValid || targetError || (targetRequired && !value && editing?.type !== 'forward')) return
    if (editing && !Object.keys(changes!).length) { onOpenChange(false); return }
    void send()
  }
  // Editing: Slack and Discord switch between each other; webhooks and forwards keep their type.
  const typeOptions = editing ? (chat(editing.type) ? types.filter(chat) : [editing.type]) : types
  const formId = editing ? 'endpoint-edit' : 'endpoint-create'
  const urlHint = editing
    ? retyped ? `Required to switch: ${typeLabel[editing.type]} URLs don’t work with ${typeLabel[type]}.` : `Stored encrypted and never shown. Leave it empty to keep the current URL.${type === 'webhook' ? ' A new URL drops custom headers set over the API.' : ''}`
    : type === 'slack' || type === 'discord' ? 'Stored encrypted and never shown again.' : type === 'forward' ? 'We email them a confirmation link. Nothing is forwarded until they confirm.' : 'Bane signs each event; the secret is shown once.'
  return <Dialog open={open} onOpenChange={next => { if (!busy) onOpenChange(next) }} title={editing ? `Edit ${editing.name}` : 'New endpoint'}
    footer={<><Button disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" type="submit" form={formId} loading={busy}>{editing ? 'Save' : 'Create'}</Button></>}>
    <form id={formId} className="stack" onSubmit={submit} noValidate>
      {typeOptions.length > 1 || editing ? <Field label="Type" hint={editing && typeOptions.length === 1 ? `${typeLabel[editing.type]} endpoints keep their type. Create a new endpoint for another kind.` : typeHint[type]}>
        <Select value={type} disabled={typeOptions.length === 1} onValueChange={v => { setType(v as EndpointType); setTarget(''); setTried(false); setError(null) }} options={typeOptions.map(value => ({ value, label: typeLabel[value] }))} />
      </Field> : null}
      <Field label="Name" error={nameError || serverError('name') || undefined} hint={<>Rituals call it as <code>endpoints.{nameValid ? name : 'name'}{payloadOf[type]}</code></>}>
        <Input value={name} onChange={e => { setName(e.target.value.toLowerCase().replace(/[\s_]+/g, '-')); if (serverError('name')) setError(null) }} placeholder={type === 'forward' ? 'team' : type === 'webhook' ? 'crm' : type === 'discord' ? 'alerts' : 'support'} autoComplete="off" aria-invalid={!!(nameError || serverError('name')) || undefined} />
      </Field>
      {editing?.type === 'forward'
        ? <Field label="Recipient address" hint="Its recipient confirmed this address, so it can’t change. Create a new forward for another one."><p className="endpoint-recipient"><PrivateAddress value={editing.target} /></p></Field>
        : <Field label={editing ? 'Replace URL' : targetLabel[type]} error={targetError || serverError('url') || undefined} hint={urlHint}>
          <SecretInput type={type === 'forward' ? 'email' : type === 'webhook' ? 'url' : 'password'} autoComplete="off" value={target} onChange={e => { setTarget(e.target.value); if (serverError('url')) setError(null) }}
            placeholder={type === 'forward' ? 'team@example.com' : editing && !retyped ? 'Keep the current URL' : 'https://'} aria-invalid={!!(targetError || serverError('url')) || undefined} />
        </Field>}
      {!editing && type === 'forward' && <>
        <Field label="Ask from" hint="The receiving address that sends the request and the forwards.">
          <Select mask value={from} onValueChange={setFrom} options={[{ value: '', label: 'Oldest receiving address' }, ...(boxes.data ?? []).map(a => ({ value: a.id, label: a.address }))]} />
        </Field>
        <Checkbox checked={preverify} onCheckedChange={setPreverify} label="Skip the email: the address is on a domain this workspace verified" />
      </>}
      {editing && <Checkbox checked={enabled} onCheckedChange={setEnabled} label="Enabled: rituals and routes can deliver to it" />}
      {(generalError || serverError('type') || serverError('paused')) && <Alert tone="danger">{generalError || serverError('type') || serverError('paused')}</Alert>}
    </form>
  </Dialog>
}

/** Shown once after creating an endpoint: how rituals call it, and a webhook's signing secret, which is never shown again. */
export function CreatedEndpointDialog({ created, onClose, writeRitual = true }: { created: (Endpoint & { secret?: string }) | null; onClose: () => void; writeRitual?: boolean }) {
  const call = created ? `${created.call}${created.type === 'slack' ? '({ text: `New mail from ${email.from.address}` })' : created.type === 'discord' ? '({ content: `New mail from ${email.from.address}` })' : created.type === 'webhook' ? '({ subject: email.subject })' : '()'}` : ''
  return <Dialog sensitive={Boolean(created?.secret)} open={!!created} onOpenChange={next => { if (!next) onClose() }} title={created?.status === 'pending' ? 'Confirmation sent' : 'Endpoint created'}
    footer={<><Button onClick={onClose}>Done</Button>{writeRitual && created?.status !== 'pending' && <Link className="ui-button ui-button--primary ui-button--md" to="/receiving/rituals?new=1" onClick={onClose}>Write a ritual that uses it</Link>}</>}>
    {created && <div className="stack">
      <Field label="Call it from a ritual" hint={created.type === 'webhook' ? 'The payload is optional; without one it gets the whole message event.' : undefined}><div className="settings-copy-cell"><code>{call}</code><CopyButton value={call} label="Copy call" /></div></Field>
      {created.secret && <Field label="Signing secret" hint="Copy it now; it won’t be shown again. Use it to verify requests come from Bane."><div className="settings-copy-cell"><SecretCode>{created.secret}</SecretCode><CopyButton value={created.secret} label="Copy secret" /></div></Field>}
      {created.status === 'pending' && <p className="muted">{created.nextStep}</p>}
    </div>}
  </Dialog>
}
export const endpointTypeLabel = typeLabel
export { humanStep, statusLabel as endpointStatusLabel, statusTone as endpointStatusTone }
