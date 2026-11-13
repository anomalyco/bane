import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { useInfiniteQuery } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'
import { Button, Checkbox, Dialog, Field, Input, Select } from '../../components/ui'
import { useApi, useApiDef, useApiMutation, useApiQuery, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import type { ApiKeyInput, AppPasswordInput, AppPasswordProtocol, KeyPermission, MailPermission, PageRequest } from '../../data/types'
import { fieldError, MutationError } from './shared'
import '../inbound/inbound.css'
import './api-keys.css'

/** What a new API key can reach: the whole workspace (four permission sets), or only mail at chosen addresses, one
 *  agent inbox, or the inboxes it creates. `/api-keys?create=<purpose>` opens Create key on it. */
export type Purpose = 'manage' | 'send' | 'read_send' | 'read' | 'addresses' | 'inbox' | 'create'
type WorkspacePurpose = Extract<Purpose, 'manage' | 'send' | 'read_send' | 'read'>
const workspacePermissions: Record<WorkspacePurpose, KeyPermission[]> = { manage: ['read', 'send', 'manage'], send: ['send'], read_send: ['read', 'send'], read: ['read'] }
const isWorkspace = (purpose: Purpose): purpose is WorkspacePurpose => purpose in workspacePermissions
const purposes: { value: Purpose; label: string; hint: string }[] = [
  { value: 'manage', label: 'Full access', hint: 'Sends, reads, and manages domains, keys and settings.' },
  { value: 'send', label: 'Sending only', hint: 'Sends email from your app. Can’t read logs or change settings.' },
  { value: 'read_send', label: 'Send and read', hint: 'Sends email and looks up what happened to it in logs and events. Can’t change settings.' },
  { value: 'read', label: 'Read only', hint: 'Reads logs, events and settings. Can’t send.' },
  { value: 'addresses', label: 'Chosen addresses', hint: 'Reads mail at the receiving addresses you choose, and can reply from them. Nothing else.' },
  { value: 'inbox', label: 'One inbox', hint: 'Reads one agent inbox, and nothing else. Stops working when the inbox is deleted.' },
  { value: 'create', label: 'Create inboxes', hint: 'Creates agent inboxes and reads only the ones it created.' },
]
type Kind = 'api' | 'agent' | 'app'
const kinds: { value: Kind; label: string; hint: string }[] = [
  { value: 'api', label: 'API key', hint: 'For your server, a script or an agent: the whole workspace, sending only, or chosen addresses or one inbox.' },
  { value: 'agent', label: 'Agent token', hint: 'An agent such as OpenCode or Claude Code signs in as you over MCP.' },
  { value: 'app', label: 'App password', hint: 'Lets a mail app open a persistent inbox over IMAP or SMTP.' },
]
export type CreatedSecret = { secret: string; title: string; description?: string; sendExample?: boolean }

/** Create key: the type first (API key, agent token, app password), then what it can reach. An agent token is the
 *  Connect an agent flow, so choosing it hands over to that dialog. `initial` opens straight on an API key's form, as
 *  Overview's "Create key" does with the domain it just verified. Render only while open, so form state and the created
 *  secret in mutation state go away on close. */
export function CreateKeyDialog({ open, onOpenChange, onCreated, onConnectAgent, initial }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (created: CreatedSecret) => void; onConnectAgent: () => void; initial?: { purpose?: Purpose; domain?: string } }) {
  const [kind, setKind] = useState<Kind | null>(initial ? 'api' : null)
  const back = () => setKind(null)
  if (kind === 'api') return <ApiKeyForm open={open} onOpenChange={onOpenChange} onBack={back} onCreated={onCreated} initial={initial} />
  if (kind === 'app') return <AppPasswordForm open={open} onOpenChange={onOpenChange} onBack={back} onCreated={onCreated} />
  return <Dialog open={open} onOpenChange={onOpenChange} title="Create key" footer={<Button onClick={() => onOpenChange(false)}>Cancel</Button>}>
    <ul className="keys-types" aria-label="What kind of key?">
      {kinds.map(item => <li key={item.value}>
        <button type="button" className="keys-type" aria-describedby={`key-kind-${item.value}-hint`} onClick={() => { if (item.value === 'agent') { onOpenChange(false); onConnectAgent() } else setKind(item.value) }}>
          <span className="settings-cell-stack"><span className="keys-type__label">{item.label}</span><span id={`key-kind-${item.value}-hint`} className="ui-field__hint">{item.hint}</span></span>
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </li>)}
    </ul>
  </Dialog>
}

type FormProps = { open: boolean; onOpenChange: (open: boolean) => void; onBack: () => void; onCreated: (created: CreatedSecret) => void }

function ApiKeyForm({ open, onOpenChange, onBack, onCreated, initial }: FormProps & { initial?: { purpose?: Purpose; domain?: string } }) {
  const api = useApi()
  const create = useApiMutation((api, input: ApiKeyInput) => api.keys.create(input), 'API key created')
  const addresses = useApiDef(queries.inboundAddressOptions())
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState<Purpose>(initial?.purpose ?? 'send')
  const [allDomains, setAllDomains] = useState(!initial?.domain)
  const [selectedDomains, setSelectedDomains] = useState<string[]>(initial?.domain ? [initial.domain.toLowerCase()] : [])
  const [allAddresses, setAllAddresses] = useState(false)
  const [addressIds, setAddressIds] = useState<string[]>([])
  const [inboxId, setInboxId] = useState('')
  const [reply, setReply] = useState(false)
  const [organize, setOrganize] = useState(true)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const workspace = isWorkspace(purpose)
  const pending = create.isPending
  const domainOptions = useInfiniteQuery({
    queryKey: ['bane', api.mode, 'domains', 'key-options'],
    enabled: open && workspace,
    initialPageParam: { page: 1 } as Pick<PageRequest, 'page' | 'cursor'>,
    queryFn: ({ pageParam, signal }) => api.domains.list({ ...pageParam, pageSize: 10 }, signal),
    getNextPageParam: last => last.nextCursor ? { cursor: last.nextCursor } : api.mode === 'demo' && last.total !== undefined && last.page * last.pageSize < last.total ? { page: last.page + 1 } : undefined,
    staleTime: 60_000,
    retry: false,
  })
  const inboxes = useApiQuery(['agent-inboxes', 'key-options'], (api, signal) => api.inboxes.list({ status: 'active' }, signal), { enabled: open && purpose === 'inbox' })
  const options = new Map((domainOptions.data?.pages.flatMap(page => page.items) ?? []).map(domain => [domain.name.toLowerCase(), domain.status === 'verified']))
  const domains = [...new Set([...options.keys(), ...selectedDomains])].sort()
  // Inboxes have their own choice; this list is the receiving addresses.
  const receiving = (addresses.data ?? []).filter(item => item.kind !== 'inbox')
  const activeInboxes = (inboxes.data ?? []).filter(box => box.status === 'active')
  const chosenInbox = inboxId || activeInboxes[0]?.id || ''
  const nameError = errors.name || fieldError(create.error, 'name')
  const domainError = errors.domains || fieldError(create.error, 'domains')
  const addressError = errors.addressIds || fieldError(create.error, 'access.addressIds')
  const inboxError = errors.inboxId || fieldError(create.error, 'access.inboxId')
  const mailError = fieldError(create.error, 'access.mail')

  const clearError = (field: string) => setErrors(current => { const next = { ...current }; delete next[field]; return next })
  function toggleDomain(domain: string, checked: boolean) {
    clearError('domains')
    setAllDomains(false)
    setSelectedDomains(current => checked ? [...new Set([...current, domain])] : current.filter(item => item !== domain))
  }
  function toggleAddress(id: string, checked: boolean) {
    clearError('addressIds')
    setAllAddresses(false)
    setAddressIds(current => checked ? [...new Set([...current, id])] : current.filter(item => item !== id))
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    const next: Record<string, string> = {}
    if (!name.trim()) next.name = 'Enter a name for this key.'
    if (workspace && !allDomains && !selectedDomains.length) next.domains = 'Select at least one domain, or choose All domains.'
    else if (workspace && !allDomains && selectedDomains.length > 50) next.domains = 'Select up to 50 domains.'
    if (purpose === 'addresses' && !allAddresses && !addressIds.length) next.addressIds = 'Choose an address, or Every address.'
    if (purpose === 'inbox' && !chosenInbox) next.inboxId = 'Choose an inbox.'
    setErrors(next)
    if (Object.keys(next).length) return
    const mail: MailPermission[] = ['read', ...(reply ? ['send' as const] : []), ...(organize ? ['modify' as const] : [])]
    const input: ApiKeyInput = isWorkspace(purpose) ? { name: name.trim(), permissions: workspacePermissions[purpose], domains: allDomains ? [] : selectedDomains }
      : purpose === 'addresses' ? { name: name.trim(), access: { type: 'addresses', ...(allAddresses ? {} : { addressIds }), mail } }
      : purpose === 'inbox' ? { name: name.trim(), access: { type: 'inbox', inboxId: chosenInbox, mail: mail.filter(p => p !== 'create') as Exclude<MailPermission, 'create'>[] } }
      : { name: name.trim(), access: { type: 'addresses', addressIds: [], mail: ['create', 'read', 'modify'] } }
    try {
      const result = await create.mutateAsync(input)
      onOpenChange(false)
      onCreated({ secret: result.secret, title: 'API key created', sendExample: workspace })
    } catch { /* Shown in the form. */ }
  }

  // A sending domain covers its subdomains (SENDER_DOMAIN_FORBIDDEN names "this domain or its parent domain").
  const example = selectedDomains[0] ?? domains[0]
  const placeholder = workspace ? 'Order notifications' : purpose === 'create' ? 'End-to-end tests' : purpose === 'inbox' ? 'Sign-up test' : 'Support agent'
  const where = purpose === 'inbox' ? 'this inbox' : 'these addresses'

  return <Dialog open={open} onOpenChange={next => { if (!pending) onOpenChange(next) }} title="Create API key" footer={<><Button disabled={pending} onClick={onBack}>Back</Button><Button variant="primary" loading={pending} type="submit" form="create-key">Create key</Button></>}>
    <form id="create-key" className="stack" onSubmit={submit} noValidate>
      <MutationError error={create.error} />
      <Field label="Name" htmlFor="key-name" error={nameError}><Input id="key-name" value={name} onChange={event => setName(event.target.value)} autoFocus required disabled={pending} placeholder={placeholder} /></Field>
      <fieldset className="keys-purpose" disabled={pending}>
        <legend className="ui-field__label">What it can reach</legend>
        {purposes.map(item => <label key={item.value} className="keys-choice">
          <input type="radio" name="key-purpose" value={item.value} checked={purpose === item.value} onChange={() => { setPurpose(item.value); setErrors({}); create.reset() }} aria-labelledby={`key-purpose-${item.value}`} aria-describedby={`key-purpose-${item.value}-hint`} />
          <span className="settings-cell-stack"><span id={`key-purpose-${item.value}`}>{item.label}</span><span id={`key-purpose-${item.value}-hint`} className="ui-field__hint">{item.hint}</span></span>
        </label>)}
      </fieldset>
      {workspace && <fieldset className="settings-key-domains" disabled={pending} aria-describedby={domainError ? 'key-domain-error' : 'key-domain-hint'}>
        <legend className="ui-field__label">Domains it can send from</legend>
        <Checkbox label={<span className="settings-key-all-domains">All domains <span className="ui-field__hint">Includes domains you add later.</span></span>} checked={allDomains} onCheckedChange={checked => { setAllDomains(checked); setSelectedDomains([]); clearError('domains') }} disabled={pending} />
        <div className="settings-key-domain-options">
          {domainOptions.isPending ? <p className="muted" role="status">Loading domains…</p> : domains.length === 0 && !domainOptions.isError ? <p className="muted">No domains yet. <Link to="/domains">Add one</Link>, or keep All domains.</p> : domains.map(domain => <Checkbox key={domain} label={<span>{domain}{options.get(domain) === false && <span className="ui-field__hint"> · not verified yet</span>}</span>} checked={!allDomains && selectedDomains.includes(domain)} onCheckedChange={checked => toggleDomain(domain, checked)} disabled={pending || !selectedDomains.includes(domain) && selectedDomains.length >= 50} />)}
        </div>
        {domainOptions.isError && <div className="stack"><MutationError error={domainOptions.error} /><Button onClick={() => { void (domainOptions.isFetchNextPageError ? domainOptions.fetchNextPage() : domainOptions.refetch()) }}>Retry loading domains</Button></div>}
        {domainOptions.hasNextPage && !domainOptions.isError && <Button variant="ghost" loading={domainOptions.isFetchingNextPage} onClick={() => void domainOptions.fetchNextPage()}>Load more domains</Button>}
        <p id="key-domain-hint" className="ui-field__hint">{allDomains ? 'Sends from any domain in this workspace.' : `Sends and email logs are limited to these domains and their subdomains${example ? `: ${example} also covers mail from news.${example}` : ''}. Contacts, lists, templates and campaigns stay workspace-wide.`}</p>
        {purpose === 'manage' && !allDomains && <p className="ui-field__hint">Limited to domains, it can’t manage keys, inbound or settings.</p>}
        {!allDomains && selectedDomains.length >= 50 && <p className="ui-field__hint">50-domain limit reached.</p>}
        {domainError && <p id="key-domain-error" className="ui-field__error" role="alert">{domainError}</p>}
      </fieldset>}
      {purpose === 'addresses' && <fieldset className="settings-key-domains" disabled={pending} aria-describedby={addressError ? 'key-address-error' : undefined}>
        <legend className="ui-field__label">Addresses</legend>
        <Checkbox label="Every address, including new ones" checked={allAddresses} onCheckedChange={checked => { setAllAddresses(checked); setAddressIds([]); clearError('addressIds') }} disabled={pending} />
        <div className="settings-key-domain-options">
          {addresses.isPending ? <p className="muted" role="status">Loading addresses…</p> : !receiving.length ? <p className="muted">No receiving addresses yet. <Link to="/receiving">Create one</Link>, or choose Every address.</p>
            : receiving.map(item => <Checkbox key={item.id} label={item.address} checked={!allAddresses && addressIds.includes(item.id)} disabled={pending} onCheckedChange={checked => toggleAddress(item.id, checked)} />)}
        </div>
        {addressError && <p id="key-address-error" className="ui-field__error" role="alert">{addressError}</p>}
      </fieldset>}
      {purpose === 'inbox' && <Field label="Inbox" htmlFor="key-inbox" error={inboxError} hint={inboxes.isPending ? 'Loading inboxes…' : !activeInboxes.length ? undefined : 'It stops working when the inbox is deleted.'}>
        {inboxes.isPending || activeInboxes.length ? <Select id="key-inbox" value={chosenInbox} onValueChange={value => { if (value) { setInboxId(value); clearError('inboxId') } }} disabled={pending || inboxes.isPending} placeholder="Choose an inbox"
          options={activeInboxes.map(box => ({ value: box.id, label: box.name ? `${box.name} · ${box.address}` : box.address }))} />
          : <p className="muted keys-form-note">No active agent inboxes. <Link to="/receiving/inboxes" onClick={() => onOpenChange(false)}>Create one in Receiving</Link>.</p>}
      </Field>}
      {(purpose === 'addresses' || purpose === 'inbox') && <fieldset className="keys-purpose" disabled={pending}>
        <legend className="ui-field__label">What it can do with the mail</legend>
        {[{ value: false, label: 'Read', hint: 'Lists and reads mail, events and attachments.' }, { value: true, label: 'Read and reply', hint: `Also replies and starts conversations, from ${where} only.${purpose === 'inbox' ? ' Needs replies on for the inbox.' : ''}` }].map(item => <label key={item.label} className="keys-choice">
          <input type="radio" name="key-mail" checked={reply === item.value} onChange={() => setReply(item.value)} aria-describedby={`key-mail-${item.value}-hint`} />
          <span className="settings-cell-stack"><span>{item.label}</span><span id={`key-mail-${item.value}-hint`} className="ui-field__hint">{item.hint}</span></span>
        </label>)}
        <Checkbox checked={organize} onCheckedChange={setOrganize} disabled={pending} label={<span className="settings-cell-stack"><span>Organize</span><span className="ui-field__hint">Marks read, archives, stars and labels.</span></span>} />
        {mailError && <p className="ui-field__error" role="alert">{mailError}</p>}
      </fieldset>}
    </form>
  </Dialog>
}

function AppPasswordForm({ open, onOpenChange, onBack, onCreated }: FormProps) {
  const { multiTenant } = useWorkspaceAccess()
  const create = useApiMutation((api, input: AppPasswordInput) => api.credentials.createAppPassword(input), 'App password created')
  const inboxes = useApiQuery(['agent-inboxes', 'app-password-options'], (api, signal) => api.inboxes.list({ type: 'persistent', status: 'active' }, signal), { enabled: open })
  const [inboxId, setInboxId] = useState('')
  const [name, setName] = useState('')
  const [protocols, setProtocols] = useState<AppPasswordProtocol[]>(['imap', 'smtp'])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const pending = create.isPending
  const persistent = (inboxes.data ?? []).filter(box => box.status === 'active')
  const chosen = inboxId || persistent[0]?.id || ''
  const toggle = (protocol: AppPasswordProtocol, checked: boolean) => { setErrors(current => ({ ...current, protocols: '' })); setProtocols(current => checked ? [...new Set([...current, protocol])] : current.filter(item => item !== protocol)) }
  async function submit(event: FormEvent) {
    event.preventDefault()
    const next: Record<string, string> = {}
    if (!chosen) next.inboxId = 'Choose a persistent inbox.'
    if (!name.trim()) next.name = 'Enter a name, such as the mail app it’s for.'
    if (!protocols.length) next.protocols = 'Choose IMAP, SMTP or both.'
    setErrors(next)
    if (Object.values(next).some(Boolean)) return
    try {
      const result = await create.mutateAsync({ inboxId: chosen, name: name.trim(), protocols })
      onOpenChange(false)
      onCreated({ secret: result.password, title: 'App password created', description: 'Shown once. Copy it now and enter it as the password in your mail app.' })
    } catch { /* Shown in the form. */ }
  }
  const protocolError = errors.protocols || fieldError(create.error, 'protocols')
  return <Dialog open={open} onOpenChange={next => { if (!pending) onOpenChange(next) }} title="Create app password" footer={<><Button disabled={pending} onClick={onBack}>Back</Button><Button variant="primary" loading={pending} type="submit" form="create-app-password">Create password</Button></>}>
    <form id="create-app-password" className="stack" onSubmit={submit} noValidate>
      <MutationError error={create.error} />
      <Field label="Inbox" htmlFor="app-password-inbox" error={errors.inboxId} hint={inboxes.isPending ? 'Loading inboxes…' : !persistent.length ? undefined : 'Persistent inboxes keep their mail until they’re deleted.'}>
        {inboxes.isPending || persistent.length ? <Select id="app-password-inbox" value={chosen} onValueChange={value => { if (value) setInboxId(value) }} disabled={pending || inboxes.isPending} placeholder="Choose an inbox"
          options={persistent.map(box => ({ value: box.id, label: box.name ? `${box.name} · ${box.address}` : box.address }))} />
          : <p className="muted keys-form-note">No persistent inboxes yet. A mail app can only open an inbox that keeps its mail; create one over the API with createInbox.</p>}
      </Field>
      <Field label="Name" htmlFor="app-password-name" error={errors.name || fieldError(create.error, 'name')}><Input id="app-password-name" value={name} maxLength={100} onChange={event => setName(event.target.value)} autoFocus required disabled={pending} placeholder="Apple Mail" autoComplete="off" /></Field>
      <fieldset className="keys-purpose" disabled={pending}>
        <legend className="ui-field__label">What the mail app can do</legend>
        <Checkbox checked={protocols.includes('imap')} onCheckedChange={checked => toggle('imap', checked)} disabled={pending} label={<span className="settings-cell-stack"><span>IMAP</span><span className="ui-field__hint">Reads and files the inbox’s mail.</span></span>} />
        <Checkbox checked={protocols.includes('smtp')} onCheckedChange={checked => toggle('smtp', checked)} disabled={pending} label={<span className="settings-cell-stack"><span>SMTP</span><span className="ui-field__hint">Sends mail from the inbox’s address.</span></span>} />
        {multiTenant && <p className="ui-field__hint">Mail app access is billed by the day while the inbox has an app password.</p>}
        {protocolError && <p className="ui-field__error" role="alert">{protocolError}</p>}
      </fieldset>
    </form>
  </Dialog>
}
