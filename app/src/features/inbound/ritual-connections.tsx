import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { Alert, Button, Checkbox, CopyButton, SecretCode, Dialog, Field, Input, Select, type Tone } from '../../components/ui'
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
export function NewEndpointDialog({ open, onOpenChange, onCreated, types = Object.keys(typeLabel) as EndpointType[] }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (e: Endpoint & { secret?: string }) => void; types?: EndpointType[] }) {
  const boxes = useApiDef(queries.inboundAddressOptions(), { enabled: open })
  const [type, setType] = useState<EndpointType>(types[0]!)
  const [name, setName] = useState('')
  const [target, setTarget] = useState('')
  const [from, setFrom] = useState('')
  const [preverify, setPreverify] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [attempt] = useState({ key: '', body: '' })
  const [tried, setTried] = useState(false)
  useEffect(() => { if (open) { setType(types[0]!); setName(''); setTarget(''); setError(''); setPreverify(false); setTried(false) } }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  // Errors name the field and the fix, as soon as there's something to judge (or on Create).
  const nameValid = /^[a-z0-9][a-z0-9-]{0,62}$/.test(name)
  const value = target.trim()
  const targetError = !value ? (tried ? `Enter the ${targetLabel[type].replace(/^HTTPS URL$/, 'URL').toLowerCase()}.` : '')
    : type === 'forward' ? (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? '' : 'Enter a full email address, like team@example.com.')
    : !/^https:\/\//i.test(value) ? (/^http:\/\//i.test(value) ? 'Use https://: Bane only posts to secure URLs.' : 'Start the URL with https://.')
    : type === 'slack' && !/^https:\/\/hooks\.slack\.com\//i.test(value) ? 'Use the incoming webhook URL from Slack: it starts with https://hooks.slack.com/.'
    : type === 'discord' && !/^https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\//i.test(value) ? 'Use the webhook URL from Discord: it starts with https://discord.com/api/webhooks/.' : ''
  const nameError = name && !nameValid ? `Use lowercase letters, digits and hyphens, like ${name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'support'}.` : !name && tried ? 'Name it, like support. Rituals call it by this name.' : ''
  // Single flight: a second Create before the first answers would post the endpoint again.
  const send = useSingleFlight('endpoints.create', async () => {
    setBusy(true); setError('')
    const body = { type, name: name.trim(), ...(type === 'forward' ? { address: target.trim(), ...(from ? { from } : {}), ...(preverify ? { preverify } : {}) } : { url: target.trim() }) }
    try { onCreated(await request<Endpoint & { secret?: string }>('/v1/endpoints', { method: 'POST', body, idempotencyKey: idempotencyFor(attempt, body) })) }
    catch (e) { setError(errorText(e)) }
    finally { setBusy(false) }
  })
  function submit(event: FormEvent) {
    event.preventDefault(); setTried(true)
    if (!nameValid || !value || targetError) return
    void send()
  }
  return <Dialog open={open} onOpenChange={next => { if (!busy) onOpenChange(next) }} title="New endpoint"
    footer={<><Button disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" type="submit" form="endpoint-create" loading={busy}>Create</Button></>}>
    <form id="endpoint-create" className="stack" onSubmit={submit} noValidate>
      {types.length > 1 && <Field label="Type" hint={typeHint[type]}><Select value={type} onValueChange={v => { setType(v as EndpointType); setTarget(''); setTried(false) }} options={types.map(value => ({ value, label: typeLabel[value] }))} /></Field>}
      <Field label="Name" error={nameError || undefined} hint={<>Rituals call it as <code>endpoints.{nameValid ? name : 'name'}{payloadOf[type]}</code></>}>
        <Input value={name} onChange={e => setName(e.target.value.toLowerCase().replace(/[\s_]+/g, '-'))} placeholder={type === 'forward' ? 'team' : type === 'webhook' ? 'crm' : type === 'discord' ? 'alerts' : 'support'} autoComplete="off" aria-invalid={!!nameError || undefined} />
      </Field>
      <Field label={targetLabel[type]} error={targetError || undefined} hint={type === 'slack' || type === 'discord' ? 'Stored encrypted and never shown again.' : type === 'forward' ? 'They confirm with a link we email them. Nothing is forwarded until they do.' : 'Bane signs each event; the secret is shown once.'}>
        <Input type={type === 'forward' ? 'email' : type === 'webhook' ? 'url' : 'password'} autoComplete="off" value={target} onChange={e => setTarget(e.target.value)} placeholder={type === 'forward' ? 'team@example.com' : 'https://'} />
      </Field>
      {type === 'forward' && <>
        <Field label="Ask from" hint="The receiving address that sends the request and the forwards.">
          <Select value={from} onValueChange={setFrom} options={[{ value: '', label: 'Oldest receiving address' }, ...(boxes.data ?? []).map(a => ({ value: a.id, label: a.address }))]} />
        </Field>
        <Checkbox checked={preverify} onCheckedChange={setPreverify} label="Skip the email: the address is on a domain this workspace verified" />
      </>}
      {error && <Alert tone="danger">{error}</Alert>}
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
      {created.secret && <Field label="Signing secret" hint="Copy it now; it won’t be shown again. Use it to check each request really comes from Bane."><div className="settings-copy-cell"><SecretCode>{created.secret}</SecretCode><CopyButton value={created.secret} label="Copy secret" /></div></Field>}
      {created.status === 'pending' && <p className="muted">{created.nextStep}</p>}
    </div>}
  </Dialog>
}
export const endpointTypeLabel = typeLabel
export { humanStep, statusLabel as endpointStatusLabel, statusTone as endpointStatusTone }
