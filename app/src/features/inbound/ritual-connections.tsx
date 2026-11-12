import { useEffect, useState, type FormEvent } from 'react'
import { Alert, Button, Checkbox, CopyButton, Dialog, Field, Input, Select, Tabs, type Tone } from '../../components/ui'
import { request } from '../../data/live'
import { ApiError } from '../../data/types'
const errorText = (e: unknown): string => e instanceof ApiError ? e.text : (e as Error).message
import { useApiDef } from '../../data/context'
import { queries } from '../../data/queries'
import { idempotencyFor } from './shared'
import '../settings/settings.css'
import './inbound.css'

type EndpointType = 'slack' | 'discord' | 'webhook' | 'forward'
type EndpointStatus = 'ready' | 'pending' | 'expired' | 'declined' | 'paused'
export type Endpoint = { name: string; type: EndpointType; status: EndpointStatus; call: string; target: string; policy: { perMinute: number; retryOnTimeout: boolean; idempotent: boolean }; expiresAt: string | null; nextStep: string; createdAt: string }
const typeLabel: Record<EndpointType, string> = { slack: 'Slack', discord: 'Discord', webhook: 'Webhook', forward: 'Forward' }
const statusTone: Record<EndpointStatus, Tone> = { ready: 'success', pending: 'warning', expired: 'warning', declined: 'danger', paused: 'neutral' }
const statusLabel: Record<EndpointStatus, string> = { ready: 'Ready', pending: 'Awaiting recipient', expired: 'Link expired', declined: 'Declined', paused: 'Paused' }
const targetLabel: Record<EndpointType, string> = { slack: 'Slack incoming webhook URL', discord: 'Discord webhook URL', webhook: 'HTTPS URL', forward: 'Recipient address' }
const payloadOf: Record<EndpointType, string> = { slack: '({ text: … })', discord: '({ content: … })', webhook: '({ … })', forward: '()' }

const hours = (iso: string | null) => iso ? Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 3600000)) : 0
/** The API's nextStep is written for agents; people get the same fact with the dashboard's own controls. */
function humanStep(e: Endpoint) {
  if (e.status === 'pending') return `Waiting for the recipient to confirm by email · link expires in ${hours(e.expiresAt)} h`
  if (e.status === 'expired') return 'Confirmation link expired · resend it from the menu'
  if (e.status === 'declined') return 'The recipient declined or stopped forwards'
  return 'Paused · calls wait until you resume'
}
/** Agent connection limited to chosen inboxes: an inbox-only key in a ready config, or a human OAuth approval. */
export function ConnectAgent({ id }: { id: string }) {
  const [open, setOpen] = useState(false)
  const [client, setClient] = useState<'opencode' | 'claude' | 'generic'>('opencode')
  const [auth, setAuth] = useState<'key' | 'oauth'>('key')
  const [reply, setReply] = useState(false)
  const [result, setResult] = useState<{ config: object; nextStep: string } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [attempt] = useState({ key: '', body: '' })
  useEffect(() => { if (open) { setResult(null); setError('') } }, [open])
  async function create() {
    setBusy(true); setError('')
    const body = { inboxes: [id], client, auth, reply }
    try { setResult(await request<{ config: object; nextStep: string }>('/v1/inbox-connections', { method: 'POST', body, idempotencyKey: idempotencyFor(attempt, body) })) }
    catch (e) { setError(errorText(e)) }
    finally { setBusy(false) }
  }
  const config = result ? JSON.stringify(result.config, null, 2) : ''
  const where = client === 'opencode' ? 'opencode.json' : client === 'claude' ? '.mcp.json or Claude Desktop settings' : 'your MCP client'
  return <>
    <Button onClick={() => setOpen(true)}>Connect an agent</Button>
    <Dialog open={open} onOpenChange={next => { if (!busy) setOpen(next) }} title="Connect an agent" description="The agent can read this inbox and nothing else in the workspace."
      footer={result ? <><Button onClick={() => setOpen(false)}>Done</Button><CopyButton label="Copy config" value={config} /></> : <><Button disabled={busy} onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" disabled={busy} onClick={() => void create()}>Create connection</Button></>}>
      {!result ? <div className="stack">
        <Tabs label="Client" value={client} onValueChange={v => setClient(v as typeof client)} items={[{ value: 'opencode', label: 'OpenCode' }, { value: 'claude', label: 'Claude' }, { value: 'generic', label: 'Other MCP client' }]} />
        <Field label="Sign-in" hint={auth === 'key' ? 'A bearer key limited to this inbox, shown once inside the config.' : 'The person approving the agent picks this inbox on the consent screen.'}>
          <Select value={auth} onValueChange={v => setAuth(v as typeof auth)} options={[{ value: 'key', label: 'Inbox key' }, { value: 'oauth', label: 'Approve in the browser (OAuth)' }]} />
        </Field>
        <Checkbox checked={reply} onCheckedChange={setReply} label="Allow replies, if this inbox has sending on" />
        {error && <Alert tone="danger">{error}</Alert>}
      </div> : <div className="stack">
        <p className="muted">Add this to {where}. {result.nextStep}</p>
        <pre className="endpoint-config">{config}</pre>
      </div>}
    </Dialog>
  </>
}

export function NewEndpointDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (e: Endpoint & { secret?: string }) => void }) {
  const boxes = useApiDef(queries.inboundAddressOptions(), { enabled: open })
  const [type, setType] = useState<EndpointType>('slack')
  const [name, setName] = useState('')
  const [target, setTarget] = useState('')
  const [from, setFrom] = useState('')
  const [preverify, setPreverify] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [attempt] = useState({ key: '', body: '' })
  useEffect(() => { if (open) { setName(''); setTarget(''); setError(''); setPreverify(false) } }, [open])
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    const body = { type, name: name.trim(), ...(type === 'forward' ? { address: target.trim(), ...(from ? { from } : {}), ...(preverify ? { preverify } : {}) } : { url: target.trim() }) }
    try { onCreated(await request<Endpoint & { secret?: string }>('/v1/endpoints', { method: 'POST', body, idempotencyKey: idempotencyFor(attempt, body) })) }
    catch (e) { setError(errorText(e)) }
    finally { setBusy(false) }
  }
  const nameValid = /^[a-z0-9][a-z0-9-]{0,62}$/.test(name)
  return <Dialog open={open} onOpenChange={next => { if (!busy) onOpenChange(next) }} title="New endpoint"
    footer={<><Button disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" type="submit" form="endpoint-create" disabled={busy || !nameValid || !target.trim()}>Create</Button></>}>
    <form id="endpoint-create" className="stack" onSubmit={submit} noValidate>
      <Field label="Type"><Select value={type} onValueChange={v => { setType(v as EndpointType); setTarget('') }} options={(Object.keys(typeLabel) as EndpointType[]).map(value => ({ value, label: typeLabel[value] }))} /></Field>
      <Field label="Name" hint={name && !nameValid ? 'Lowercase letters, digits and hyphens.' : <>Rituals call it as <code>endpoints.{name || 'name'}{payloadOf[type]}</code></>}>
        <Input value={name} onChange={e => setName(e.target.value.toLowerCase())} placeholder={type === 'forward' ? 'team' : type === 'webhook' ? 'crm' : 'support'} autoComplete="off" />
      </Field>
      <Field label={targetLabel[type]} hint={type === 'slack' || type === 'discord' ? 'Stored encrypted and never shown again.' : type === 'forward' ? 'They confirm with a link we email them. Nothing is forwarded until they do.' : 'Bane signs each event; the secret is shown once.'}>
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
export function CreatedEndpointDialog({ created, onClose }: { created: (Endpoint & { secret?: string }) | null; onClose: () => void }) {
  return <Dialog open={!!created} onOpenChange={next => { if (!next) onClose() }} title={created?.status === 'pending' ? 'Confirmation sent' : 'Endpoint created'} footer={<Button onClick={onClose}>Done</Button>}>
    {created && <div className="stack">
      <Field label="Call it from a ritual"><div className="settings-copy-cell"><code>{created.call}{payloadOf[created.type]}</code><CopyButton value={`${created.call}${created.type === 'slack' ? '({ text: `` })' : created.type === 'discord' ? '({ content: `` })' : '()'}`} label="Copy call" /></div></Field>
      {created.secret && <Field label="Signing secret" hint="Copy it now; it won’t be shown again."><div className="settings-copy-cell"><code>{created.secret}</code><CopyButton value={created.secret} label="Copy secret" /></div></Field>}
      <p className="muted">{created.nextStep}</p>
    </div>}
  </Dialog>
}
export const endpointTypeLabel = typeLabel
export { humanStep, statusLabel as endpointStatusLabel, statusTone as endpointStatusTone }
