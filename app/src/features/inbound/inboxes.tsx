import { ConnectAgentButton, ConnectAgentDialog, McpClientSetup, useMcpUrl } from '../docs/connect-agent'
import type { McpClient } from '../../../../api/src/mcp-clients'
import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { request } from '../../data/live'
import { Alert, Button, Checkbox, ConfirmDialog, DropdownMenu, CopyButton, SecretCode, DataTable, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, Pagination, PaginationSkeleton, SectionHeader, Select, SkeletonText, StatusBadge, type Tone } from '../../components/ui'
import { useApiDef, useApiMutation, useApiQuery, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import type { CreatedInbox, Inbox, InboxInput, InboxMessage, InboxStatus, MailboxDomain, MailboxKey } from '../../data/types'
import { date, number } from '../../lib/format'
import { useCursorPagination } from '../../lib/pagination'
import { fieldError, MutationError } from '../settings/shared'
import { when, Sender } from './shared'
import { nameParts } from '../../lib/private-address'
import '../settings/settings.css'
import './inbound.css'
import { PrivateAddress } from '../../components/PrivateAddress'

const route = '/receiving/inboxes'
const lifetimes = [{ value: '3600', label: '1 hour' }, { value: '86400', label: '24 hours' }, { value: '604800', label: '7 days' }, { value: '2592000', label: '30 days' }]
const statusTone: Record<InboxStatus, Tone> = { active: 'success', expired: 'warning', deleting: 'neutral' }
const statusLabel: Record<InboxStatus, string> = { active: 'Active', expired: 'Expired', deleting: 'Deleting' }
const size = (bytes: number) => bytes < 1024 ? `${number(bytes)} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1048576).toFixed(1)} MiB`
// The MX record's host is the receiving host: reply.example.com on hosted Bane, the domain itself otherwise.
const receivingHosts = (domains: MailboxDomain[] = []) => domains.filter(domain => domain.status === 'active').map(domain => domain.dns[0]?.name ?? domain.name)

function messageState(message: InboxMessage): { label: string; tone: Tone } {
  if (message.held) return { label: message.held === 'quota' ? 'Held: over limit' : 'Held: expired', tone: 'warning' }
  if (message.junk) return { label: 'Junk', tone: 'danger' }
  if (message.simulated) return { label: 'Simulated', tone: 'info' }
  return message.read ? { label: 'Read', tone: 'neutral' } : { label: 'Unread', tone: 'info' }
}

export function NewInboxDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate()
  const domains = useApiDef(queries.inboundDomains(), { enabled: open })
  const hosts = receivingHosts(domains.data)
  const [type, setType] = useState<InboxInput['type']>('ephemeral')
  const [host, setHost] = useState('')
  const [name, setName] = useState('')
  const [lifetime, setLifetime] = useState('86400')
  const [withKey, setWithKey] = useState(true)
  const [replies, setReplies] = useState(false)
  const [client, setClient] = useState<McpClient>('opencode')
  const [connecting, setConnecting] = useState(false)
  const url = useMcpUrl()
  // No toast: the dialog itself turns into "Agent inbox created".
  const create = useApiMutation((api, input: InboxInput) => api.inboxes.create(input))
  const created: CreatedInbox | undefined = create.data
  const noHost = !domains.isPending && !hosts.length
  useEffect(() => { if (open) { create.reset(); setHost(''); setName(''); setLifetime('86400'); setWithKey(true); setReplies(false); setClient('opencode') } }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  // Without an active receiving host the only inbox that works is a sandbox.
  useEffect(() => { if (open) setType(noHost ? 'sandbox' : 'ephemeral') }, [open, noHost])
  async function submit(event: FormEvent) {
    event.preventDefault()
    try { await create.mutateAsync({ type, ...(type === 'ephemeral' ? { domain: host || hosts[0] } : {}), ...(name.trim() ? { name: name.trim() } : {}), ttlSeconds: Number(lifetime), ...(type === 'ephemeral' && replies ? { send: { enabled: true } } : {}), ...(withKey ? { credential: { name: `${name.trim() || 'Agent inbox'} key`.slice(0, 100), permissions: replies && type === 'ephemeral' ? ['read', 'modify', 'send'] : ['read', 'modify'] } } : {}) }) } catch { /* Shown in the form. */ }
  }
  const close = () => onOpenChange(false)
  // Created: the address, its key (shown once) already set up for each MCP client, so nothing more has to be minted.
  if (created) return <>
    <Dialog sensitive={Boolean(created.credential)} open={open && !connecting} onOpenChange={next => { if (!next) close() }} title="Agent inbox created" className="connect-agent-dialog" footer={<><Button onClick={close}>Done</Button>{!created.credential && <Button onClick={() => setConnecting(true)}>Connect an agent</Button>}<Button variant="primary" onClick={() => { close(); navigate(`${route}/${created.id}`) }}>Open inbox</Button></>}>
      <div className="stack">
        <Field label="Address" hint={`Receives until ${date(created.expiresAt)}. ${created.type === 'sandbox' ? 'A sandbox address only gets test mail: use Send test mail on its page, or POST /v1/inboxes/{id}/simulate.' : 'Mail sent to it shows up on its page and through the API.'}`}><div className="settings-copy-cell"><code><PrivateAddress value={created.address} /></code><CopyButton value={created.address} label="Copy address" /></div></Field>
        {created.credential && <>
          <Field label="Inbox key" hint="Copy it now; it won’t be shown again. It reads and manages only this inbox, over the API or MCP, and stops working when the inbox is deleted.">
            <div className="settings-copy-cell"><SecretCode>{created.credential.secret}</SecretCode><CopyButton value={created.credential.secret} label="Copy inbox key" /></div>
          </Field>
          <div className="stack"><strong className="connect-agent__title">Use it with an agent</strong><McpClientSetup client={client} onClient={setClient} url={url} auth={{ bearer: created.credential.secret }} label="Agent" /></div>
        </>}
      </div>
    </Dialog>
    <ConnectAgentDialog open={open && connecting} onOpenChange={next => { if (!next) { setConnecting(false); close() } }} inboxId={created.id} />
  </>
  return <Dialog open={open} onOpenChange={next => { if (!create.isPending) onOpenChange(next) }} title="New agent inbox" description="An expiring address where an agent or test receives mail, like sign-up codes." footer={<><Button disabled={create.isPending} onClick={close}>Cancel</Button><Button variant="primary" type="submit" form="agent-inbox-create" loading={create.isPending} disabled={domains.isPending}>Create inbox</Button></>}>
    <form id="agent-inbox-create" className="stack" onSubmit={submit} noValidate>
      <MutationError error={create.error} />
      {noHost && <Alert tone="info">No domain receives mail yet, so this is a sandbox inbox for test mail only. For a real address, add a domain in <Link to="/domains">Domains</Link> and publish its receiving MX record.</Alert>}
      <Field label="Address" htmlFor="agent-inbox-type" error={fieldError(create.error, 'domain')} hint={type === 'sandbox' ? 'Sandbox: a made-up .invalid address that only gets test mail you send from its page or the API.' : 'A random address on this domain that nobody can guess.'}>
        <Select id="agent-inbox-type" value={type === 'sandbox' ? 'sandbox' : host || hosts[0] || ''} disabled={create.isPending} onValueChange={value => { if (value === 'sandbox') setType('sandbox'); else { setType('ephemeral'); setHost(value) } }}
          options={[...hosts.map(value => ({ value, label: `…@${value}` })), { value: 'sandbox', label: 'Sandbox: test mail only' }]} />
      </Field>
      <Field label="Name" htmlFor="agent-inbox-name" hint="Optional. Shown in lists and as the sender name on replies.">
        <Input id="agent-inbox-name" value={name} maxLength={200} onChange={event => setName(event.target.value)} disabled={create.isPending} placeholder="Sign-up test" autoComplete="off" />
      </Field>
      <Field label="Receives mail for" htmlFor="agent-inbox-lifetime" hint="Then it holds new mail for 1 more day without delivering it, and the inbox and its mail are deleted. You can extend it from its page.">
        <Select id="agent-inbox-lifetime" value={lifetime} onValueChange={setLifetime} disabled={create.isPending} options={lifetimes} />
      </Field>
      <Checkbox checked={withKey} onCheckedChange={setWithKey} disabled={create.isPending} label="Create an inbox key: lets an agent or test read this inbox, and nothing else, over the API or MCP" />
      {type === 'ephemeral' && <Checkbox checked={replies} onCheckedChange={setReplies} disabled={create.isPending} label="Allow replies: up to 20 a day, only to people who wrote to it" />}
    </form>
  </Dialog>
}

export function AgentInboxesPage() {
  const { canAdminister } = useWorkspaceAccess()
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const pagination = useCursorPagination()
  const q = search.trim(), cursor = pagination.cursor
  const inboxes = useApiQuery(['agent-inboxes', q, cursor ?? null], (api, signal) => api.inboxes.list({ search: q || undefined, cursor }, signal), { interval: 30_000, keepPrevious: true })
  return <div className="stack inbound-stack">
    <PageHeader title="Agent inboxes" backTo="/receiving?kind=inbox" actions={<>
      <Input className="receiving-search" type="search" aria-label="Search inboxes" placeholder="Search address or name" value={search} onChange={event => { setSearch(event.target.value); pagination.reset() }} />
      {canAdminister && <ConnectAgentButton />}
      {canAdminister && <Button variant="primary" onClick={() => setCreating(true)}>New agent inbox</Button>}
    </>} />
    {inboxes.error ? <ErrorState error={inboxes.error} onRetry={() => void inboxes.refetch()} /> : <>
      <DataTable loading={inboxes.isPending} skeletonRows={4} rows={inboxes.data ?? []} rowKey={row => row.id} rowHref={row => `${route}/${row.id}`}
        empty={<EmptyState title={q ? 'No matching inboxes' : 'No agent inboxes yet'} description={q ? undefined : 'Expiring addresses for agents and end-to-end tests. Create one here, or let an agent create its own with an inbox key over the API or MCP.'} action={!q && canAdminister ? <Button onClick={() => setCreating(true)}>New inbox</Button> : undefined} />}
        columns={[
          // An inbox's card: its address and status, its name or type, then expiry and mail counts.
          { key: 'address', label: 'Address', width: '40%', render: row => <div className="settings-cell-stack"><span className="mailbox-address"><span className="receiving-clip"><PrivateAddress value={row.address} /></span>{row.type === 'sandbox' && <StatusBadge status="Sandbox" tone="neutral" />}</span>{row.name && <span className="muted receiving-clip">{row.name}</span>}</div>, cardRender: row => <PrivateAddress value={row.address} /> },
          { key: 'name', label: 'Name', table: false, card: 'line', render: row => [row.name, row.type === 'sandbox' ? 'Sandbox' : null].filter(Boolean).join(' · ') || 'Agent inbox' },
          { key: 'status', label: 'Status', width: '14%', card: 'aside', render: row => <StatusBadge status={statusLabel[row.status]} tone={statusTone[row.status]} /> },
          { key: 'expires', label: 'Expires', width: '16%', card: 'line', render: row => row.status === 'deleting' ? <span className="muted">Now</span> : date(row.expiresAt), cardRender: row => row.status === 'deleting' ? 'Deleting now' : `Expires ${date(row.expiresAt)}` },
          { key: 'messages', label: 'Messages', align: 'right', card: 'inline', render: row => number(row.usage.messages), cardRender: row => `${number(row.usage.messages)} ${row.usage.messages === 1 ? 'message' : 'messages'}` },
          { key: 'unread', label: 'Unread', align: 'right', card: 'inline', render: row => row.usage.unread ? <strong>{number(row.usage.unread)}</strong> : <span className="muted">0</span>, cardRender: row => `${number(row.usage.unread)} unread` },
          { key: 'held', label: 'Held', align: 'right', card: 'hide', render: row => row.usage.held ? number(row.usage.held) : <span className="muted">0</span> },
        ]} />
      {inboxes.isPending ? <PaginationSkeleton /> : <Pagination page={pagination.page} pageSize={50} nextCursor={inboxes.data?.nextCursor} onPageChange={next => pagination.onPageChange(next, inboxes.data?.nextCursor)} />}
    </>}
    <NewInboxDialog open={creating} onOpenChange={setCreating} />
  </div>
}

function MessageDialog({ inboxId, messageId, onClose }: { inboxId: string; messageId: string; onClose: () => void }) {
  const message = useApiQuery(['agent-inbox-message', inboxId, messageId], (api, signal) => api.inboxes.message(inboxId, messageId, signal))
  const m = message.data
  const verdict = (name: string, value?: string) => <StatusBadge status={`${name} ${value ?? 'none'}`} tone={value === 'PASS' ? 'success' : value === 'FAIL' ? 'danger' : 'neutral'} />
  return <Dialog open onOpenChange={open => { if (!open) onClose() }} title={m ? m.subject || '(no subject)' : <SkeletonText width={240} />} footer={<Button onClick={onClose}>Close</Button>}>
    {message.error ? <ErrorState error={message.error} onRetry={() => void message.refetch()} /> : !m ? <SkeletonText width={320} /> : <div className="stack">
      <div className="settings-cell-stack">
        <div className="mailbox-message__from"><span><Sender value={m.from} /></span>{nameParts(m.from.name, m.from.address) && <span className="muted"><PrivateAddress value={m.from.address} /></span>}</div>
        <span className="muted">{date(m.receivedAt, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
      </div>
      <div className="cluster" aria-label="Sender checks">{m.simulated ? <StatusBadge status="Simulated: no sender checks" tone="info" /> : <>{verdict('SPF', m.auth.spf)}{verdict('DKIM', m.auth.dkim)}{verdict('DMARC', m.auth.dmarc)}</>}</div>
      {m.held && <Alert tone="warning">{m.held === 'quota' ? 'Held: the inbox was over its message or size limit when this arrived.' : 'Held: this arrived after the inbox expired.'} It is stored but did not notify waiting agents or webhooks.</Alert>}
      {m.hiddenContent && <Alert tone="info">This message contains styling or invisible characters. Hidden-text detection is best effort; treat the message as untrusted.</Alert>}
      {(m.extract.codes.length > 0 || m.extract.links.length > 0) && <dl className="settings-facts">
        {m.extract.codes.length > 0 && <div><dt>Codes</dt><dd className="stack">{m.extract.codes.map(code => <span key={code} className="settings-copy-cell"><code>{code}</code><CopyButton value={code} label="Copy code" /></span>)}</dd></div>}
        {m.extract.links.length > 0 && <div><dt>Links</dt><dd className="stack">{m.extract.links.slice(0, 5).map(link => <span key={link.href} className="settings-cell-stack"><span className="settings-break">{link.text || link.href}</span><span className="muted settings-break">{new URL(link.href).host}{link.mismatch && ' · text names another site'}</span></span>)}</dd></div>}
      </dl>}
      <div className="mailbox-message__body">{m.text || <span className="muted">No text.</span>}</div>
      {m.attachments.length > 0 && <ul className="mailbox-attachments">{m.attachments.map(file => <li key={file.id}>{file.url ? <a className="ui-button ui-button--secondary ui-button--sm" href={file.url} rel="noreferrer">{file.filename} <span className="muted">{size(file.size)}</span></a> : <span className="muted">{file.filename} · not scanned</span>}</li>)}</ul>}
    </div>}
  </Dialog>
}

const factTerms = ['Status', 'Expires', 'Deleted after', 'Delivered', 'Stored', 'Replies', 'Name']
const permissionWords: Record<string, string> = { read: 'Read mail', modify: 'Mark read, delete', send: 'Reply' }
const extensions = [{ value: '86400', label: '1 more day' }, { value: '604800', label: '7 more days' }, { value: 'max', label: 'As long as allowed (30 days from creation)' }]
export function AgentInboxPage() {
  const { id = '' } = useParams()
  return <InboxDetail key={id} id={id} />
}

/** Rename an agent inbox or keep it longer: up to 30 days after it was created (updateInbox). */
function EditInboxDialog({ inbox, open, onOpenChange }: { inbox: Inbox; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [name, setName] = useState(inbox.name ?? '')
  const [extend, setExtend] = useState('')
  const limit = Date.parse(inbox.createdAt) + 30 * 86_400_000
  const until = extend === '' ? null : new Date(extend === 'max' ? limit : Math.min(limit, Math.max(Date.now(), Date.parse(inbox.expiresAt)) + Number(extend) * 1000))
  const save = useApiMutation((_api, body: { name?: string; expiresAt?: string }) => request(`/v1/inboxes/${encodeURIComponent(inbox.id)}`, { method: 'PATCH', body }), 'Inbox updated', false, true, inbox.id)
  useEffect(() => { if (open) { save.reset(); setName(inbox.name ?? ''); setExtend('') } }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const canExtend = inbox.status === 'active' && Date.parse(inbox.expiresAt) < limit - 60_000
  async function submit(event: FormEvent) {
    event.preventDefault()
    try { await save.mutateAsync({ ...(name.trim() !== (inbox.name ?? '') ? { name: name.trim() } : {}), ...(until ? { expiresAt: until.toISOString() } : {}) }); onOpenChange(false) } catch { /* Shown in the form. */ }
  }
  return <Dialog open={open} onOpenChange={next => { if (!save.isPending) onOpenChange(next) }} title="Edit agent inbox" footer={<><Button disabled={save.isPending} onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" type="submit" form="agent-inbox-edit" loading={save.isPending}>Save</Button></>}>
    <form id="agent-inbox-edit" className="stack" onSubmit={submit} noValidate>
      <MutationError error={save.error} />
      <Field label="Name" htmlFor="agent-inbox-edit-name" error={fieldError(save.error, 'name')} hint="Shown in lists and as the sender name on replies."><Input id="agent-inbox-edit-name" value={name} maxLength={200} onChange={event => setName(event.target.value)} disabled={save.isPending} autoComplete="off" /></Field>
      <Field label="Keep it longer" htmlFor="agent-inbox-edit-extend" error={fieldError(save.error, 'expiresAt')} hint={!canExtend ? `It already lasts the maximum: 30 days from creation (${date(new Date(limit).toISOString())}).` : until ? `It will receive until ${date(until.toISOString())}, then be deleted a day later.` : `It receives until ${date(inbox.expiresAt)}.`}>
        <Select id="agent-inbox-edit-extend" value={extend} onValueChange={setExtend} disabled={save.isPending || !canExtend} options={[{ value: '', label: 'Keep the current expiry' }, ...extensions]} />
      </Field>
    </form>
  </Dialog>
}

function InboxDetail({ id }: { id: string }) {
  const navigate = useNavigate()
  const { canAdminister } = useWorkspaceAccess()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editing, setEditing] = useState(false)
  const [revoking, setRevoking] = useState<MailboxKey | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const pagination = useCursorPagination()
  const inbox = useApiQuery(['agent-inbox', id], (api, signal) => api.inboxes.get(id, signal), { interval: 15_000 })
  const [folder,setFolder]=useState('')
  const folders=useApiQuery(['agent-inbox-folders',id],(api,signal)=>api.inboxes.folders(id,signal),{interval:15_000})
  const messages = useApiQuery(['agent-inbox-messages', id, folder, pagination.cursor ?? null], (api, signal) => api.inboxes.messages(id, { after: pagination.cursor,folder:folder||undefined }, signal), { interval: 15_000 })
  const keys = useApiQuery(['agent-inbox-keys', id], async (api, signal) => (await api.mailboxes.keys(false, signal)).filter(key => key.addressIds?.length === 1 && key.addressIds[0] === id), { enabled: canAdminister })
  const remove = useApiMutation((api, _: void) => api.inboxes.remove(id), 'Inbox deleted', false, true, id)
  const revoke = useApiMutation((api, keyId: string) => api.mailboxes.revokeKey(keyId), 'Inbox key revoked')
  const b: Inbox | undefined = inbox.data
  if (inbox.error) return <><PageHeader title="Agent inbox" backTo={route} /><ErrorState error={inbox.error} onRetry={() => void inbox.refetch()} /></>
  const next = messages.data?.hasMore ? messages.data.cursor : null
  // The empty state depends on the inbox, and a single page drops the pagination: the messages stay in their loading
  // shape until both are known, and the keys section only joins below them once they have, so nothing moves.
  const settled = Boolean(b) && !messages.isPending
  return <div className="stack inbound-stack">
    <PageHeader title={b ? <PrivateAddress value={b.address} /> : <SkeletonText width={260} lineHeight={28} />} backTo={route} actions={b && <>
      {b.type === 'ephemeral' && <Link className="ui-button ui-button--secondary ui-button--md" to={`/receiving/inbox?address=${encodeURIComponent(b.id)}`}>Open in inbox</Link>}
      {canAdminister && b.status !== 'deleting' && <Button onClick={() => setEditing(true)}>Edit</Button>}
      {canAdminister && b.status==='active' && <ConnectAgentButton inboxId={id} />}
      {canAdminister && b.status !== 'deleting' && <Button variant="danger" onClick={() => setConfirmDelete(true)}>Delete</Button>}
    </>} />
    {/* The facts hold their place while the inbox loads, so the sections below never move. Name always shows, keeping
        the grid at three rows whatever the inbox. */}
    {!b && <dl className="settings-facts" aria-hidden="true">{factTerms.map(term => <div key={term}><dt>{term}</dt><dd><SkeletonText width={120} /></dd></div>)}</dl>}
    {b && <>
      <dl className="settings-facts">
        <div><dt>Status</dt><dd><StatusBadge status={statusLabel[b.status]} tone={statusTone[b.status]} /></dd></div>
        <div><dt>{b.status === 'active' ? 'Expires' : 'Expired'}</dt><dd>{date(b.expiresAt)}</dd></div>
        <div><dt>Deleted after</dt><dd>{date(b.deleteAfter)}</dd></div>
        <div><dt>Delivered</dt><dd>{number(b.usage.messages - b.usage.held)} of {number(b.limits.messages)}{b.usage.unread > 0 && <span className="muted"> · {number(b.usage.unread)} unread</span>}</dd></div>
        <div><dt>Stored</dt><dd>{size(b.usage.bytes)} of {size(b.limits.bytes)}</dd></div>
        <div><dt>Replies</dt><dd>{b.type === 'sandbox' ? 'Never (sandbox)' : b.send.enabled ? `To senders only, ${number(b.send.perDay)} a day` : 'Off'}</dd></div>
        <div><dt>Name</dt><dd className="settings-break">{b.name || <span className="muted">—</span>}</dd></div>
        {b.type === 'sandbox' && <div><dt>Type</dt><dd>Sandbox · test mail only</dd></div>}
      </dl>
      {b.status === 'deleting' && <Alert tone="info">This inbox was deleted. Its address no longer receives mail, and its messages are erased within the hour.</Alert>}
      {b.status === 'expired' && <Alert tone="info">This inbox expired. New mail is still stored but held until it is erased on {date(b.deleteAfter)}.</Alert>}
      {b.usage.held > 0 && b.status !== 'deleting' && <Alert tone="warning">{number(b.usage.held)} {b.usage.held === 1 ? 'message is' : 'messages are'} held: stored and listed below, but not delivered to waiting agents or webhooks.</Alert>}
    </>}
    <p className="muted inbox-facts-note">It receives mail until it expires. For 1 more day, new mail is held (stored and listed, not delivered), then the inbox and its mail are deleted. Over its message or size limit, new mail is held the same way. Replies go only to people who wrote to it and are turned on at creation.</p>
    <section className="section stack" aria-labelledby="agent-inbox-messages">
      <SectionHeader title={<span id="agent-inbox-messages">Messages</span>} />
      {folders.error ? <ErrorState error={folders.error} onRetry={()=>void folders.refetch()}/> : <Field label="Folder" htmlFor="inbox-folder" hint="All deliveries lists every message; folders are where a mail client or agent filed them."><Select id="inbox-folder" value={folder||'deliveries'} onValueChange={value=>{setFolder(value==='deliveries'?'':value);pagination.reset()}} options={[{value:'deliveries',label:'All deliveries'},...(folders.data?.data??[]).map(f=>({value:f.id,label:`${f.path} · ${number(f.total)}${f.subscribed?' · subscribed':''}`}))]}/></Field>}
      {messages.error ? <ErrorState error={messages.error} onRetry={() => void messages.refetch()} /> : <>
        <DataTable loading={!settled} skeletonRows={3} minRows={3} rows={messages.data?.data ?? []} rowKey={row => row.id} onRowClick={row => setSelected(row.id)}
          empty={<EmptyState title="No mail yet" description={b?.type === 'sandbox' ? 'Send test mail with POST /v1/inboxes/{id}/simulate.' : b ? 'Mail sent to this inbox shows up here within seconds.' : undefined} />}
          columns={[
            // A message's card: its subject and status, then the sender and any code it carries.
            { key: 'from', label: 'From', width: '24%', card: 'line', render: row => <span className="receiving-clip"><Sender value={row.from} /></span> },
            { key: 'subject', label: 'Subject', width: '40%', card: 'title', render: row => <div className="settings-cell-stack"><span className="receiving-clip">{row.subject || '(no subject)'}</span>{row.snippet && <span className="muted receiving-clip">{row.snippet}</span>}</div>, cardRender: row => row.subject || '(no subject)' },
            { key: 'code', label: <span title="A one-time code Bane found in the message, such as a sign-up code">Code found</span>, card: 'inline', render: row => row.extract.codes[0] ? <code>{row.extract.codes[0]}</code> : <span className="muted">—</span> },
            { key: 'state', label: 'Status', card: 'aside', render: row => { const state = messageState(row); return <StatusBadge status={state.label} tone={state.tone} /> } },
            { key: 'received', label: 'Received', align: 'right', render: row => when(row.receivedAt) },
          ]} />
        {!settled ? <PaginationSkeleton /> : <Pagination page={pagination.page} pageSize={50} nextCursor={next} onPageChange={page => pagination.onPageChange(page, next)} />}
      </>}
    </section>
    {canAdminister && settled && <section className="section stack" aria-labelledby="agent-inbox-keys">
      <SectionHeader title={<span id="agent-inbox-keys">Keys for this inbox</span>} actions={b?.status === 'active' && <ConnectAgentButton inboxId={id} size="sm" />} />
      <p className="muted inbox-facts-note">Inbox keys read only this inbox, over the API or MCP. They stop working when it is deleted.</p>
      {keys.error ? <ErrorState error={keys.error} onRetry={() => void keys.refetch()} /> : <DataTable loading={keys.isPending} skeletonRows={1} rows={keys.data ?? []} rowKey={key => key.id}
        empty={<EmptyState title="No keys" description="Create one with Connect an agent. It comes with a ready setup for OpenCode, Claude Code or Cursor." />}
        columns={[
          // A key's card: its name and when it was last used, what it can do, and Revoke in the row menu.
          { key: 'name', label: 'Name', width: '30%', card: 'title', render: key => key.name },
          { key: 'prefix', label: 'Key', width: '18%', card: 'line', render: key => <code>{key.prefix}…</code> },
          { key: 'permissions', label: 'Can', card: 'field', render: key => key.permissions.map(p => permissionWords[p] ?? p).join(' · ') },
          { key: 'used', label: 'Last used', align: 'right', card: 'aside', render: key => key.lastUsedAt ? date(key.lastUsedAt) : <span className="muted">Never</span> },
          { key: 'revoke', label: '', align: 'right', width: 100, card: 'end', render: key => <Button variant="danger" size="sm" aria-label={`Revoke ${key.name}`} onClick={() => setRevoking(key)}>Revoke</Button>,
            cardRender: key => <DropdownMenu label={`Actions for ${key.name}`} title={key.name} items={[{ label: 'Revoke key', destructive: true, onSelect: () => setRevoking(key) }]} /> },
        ]} />}
    </section>}
    {selected && <MessageDialog inboxId={id} messageId={selected} onClose={() => setSelected(null)} />}
    {b && <EditInboxDialog inbox={b} open={editing} onOpenChange={setEditing} />}
    <ConfirmDialog open={revoking !== null} onOpenChange={value => { if (!value) setRevoking(null) }} title={`Revoke ${revoking?.name ?? 'this key'}?`} description="Agents using it lose access to this inbox right away. The inbox and its mail stay." confirmLabel="Revoke key" danger pending={revoke.isPending} onConfirm={async () => { if (revoking) await revoke.mutateAsync(revoking.id) }} />
    <ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} title={`Delete ${b?.address ?? 'this inbox'}?`} description="This inbox stops receiving now. Its real address returns to normal domain routing. Keys created with the inbox stop working, and its messages are erased within the hour." confirmLabel="Delete inbox" danger pending={remove.isPending} onConfirm={async () => { await remove.mutateAsync(); navigate(route) }} />
  </div>
}
