import { useEffect, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import { Button, Checkbox, ConfirmDialog, DataTable, Dialog, DropdownMenu, EmptyState, ErrorState, PageHeader, Pagination, Tabs, useToast } from '../../components/ui'
import { useApiMutation, useApiDef, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import type { Agent, AgentTokenSummary, ApiKey, AppPassword } from '../../data/types'
import { date, shortDateTime } from '../../lib/format'
import { useCursorPagination } from '../../lib/pagination'
import { SecretDialog } from './shared'
import { AdminOnlyPage } from './admin-only'
import { KeySendExample } from '../docs/first-send'
import { CreateKeyDialog, type CreatedSecret, type Purpose } from './create-key'
import { accessLabel, agentAccess, connectionTitle, domainScope, mailLabel, protocolLabel } from './key-labels'
import { keyTypes, settingsColumns, type KeyTypeFilter } from './skeletons'
import { KeysGuide } from './keys-guide'
import './api-keys.css'
import { AddressList, PrivateAddress } from '../../components/PrivateAddress'
import { ConnectAgentButton, ConnectAgentDialog } from '../docs/connect-agent'

// One table for the three credential types: API keys, agent tokens (a connected agent, with the short-lived tokens it
// made nested under it) and app passwords.
type Row =
  | { kind: 'key'; id: string; key: ApiKey }
  | { kind: 'agent'; id: string; agent: Agent }
  | { kind: 'token'; id: string; token: AgentTokenSummary }
  | { kind: 'app'; id: string; password: AppPassword }
const typeName: Record<Row['kind'], string> = { key: 'API key', agent: 'Agent token', token: 'Agent token', app: 'App password' }
const lastUsed = (value: string | null) => value ? date(value) : 'Never'
const usedLine = (value: string | null) => value ? `Used ${date(value)}` : 'Never used'
const newestFirst = <T extends { createdAt: string }>(items: T[]) => [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
const past = (value: string | null) => value !== null && Date.parse(value) <= Date.now()
/** Revoked, ended (an inbox key whose inbox is gone), or null while it works. */
const keyState = (key: ApiKey) => key.revokedAt ? 'Revoked' : past(key.expiresAt) ? 'Ended' : null
const tokenState = (token: AgentTokenSummary) => token.revokedAt ? 'Revoked' : past(token.expiresAt) ? 'Expired' : null
const agentState = (agent: Agent) => agent.status === 'revoked' ? 'Revoked' : agent.status === 'expired' ? 'Expired' : null
// Another member's agent can only lose the tokens it made here, so once none is active there is nothing to revoke.
const rowState = (row: Row): ReactNode => {
  const state = row.kind === 'key' ? keyState(row.key) : row.kind === 'token' ? tokenState(row.token) : row.kind === 'app' ? null : agentState(row.agent)
  return state ? <span className="muted">{state}</span> : row.kind === 'agent' && !row.agent.own && !row.agent.tokens.some(token => !tokenState(token)) ? <span className="muted">—</span> : null
}
const rowName = (row: Row) => row.kind === 'key' ? row.key.name : row.kind === 'agent' ? connectionTitle(row.agent) : row.kind === 'token' ? row.token.purpose : row.password.name
const revokeLabel = (row: Row) => row.kind === 'key' ? 'Revoke key' : row.kind === 'agent' ? (row.agent.own ? 'Revoke agent' : 'Revoke its tokens') : row.kind === 'token' ? 'Revoke token' : 'Revoke password'
const expiry = (token: AgentTokenSummary) => tokenState(token) ?? `Expires ${shortDateTime(token.expiresAt)} UTC`

export function ApiKeysPage() {
  // /api-keys?connect=1 (from Overview and Docs) opens Connect an agent. Members connect one as themselves too, so
  // their locked page keeps the button.
  const [connectLink] = useState(() => new URLSearchParams(window.location.search).has('connect'))
  return useWorkspaceAccess().canAdminister ? <ApiKeys connectLink={connectLink} /> : <AdminOnlyPage title="API keys" button="Create key" action="create, list and revoke API keys, agent tokens and app passwords" actions={<ConnectAgentButton initiallyOpen={connectLink} />} />
}
function ApiKeys({ connectLink }: { connectLink: boolean }) {
  const toast = useToast()
  const [showRevoked, setShowRevoked] = useState(false)
  const [type, setType] = useState<KeyTypeFilter>('all')
  const pagination = useCursorPagination()
  const cursor = pagination.cursor
  const keys = useApiDef(queries.keys(cursor, showRevoked), { keepPrevious: true })
  const agents = useApiDef(queries.agents(showRevoked), { keepPrevious: true })
  const passwords = useApiDef(queries.appPasswords())
  const addresses = useApiDef(queries.inboundAddressOptions())
  const revokeKey = useApiMutation((api, id: string) => api.keys.revoke(id), 'API key revoked')
  // Your own agent loses its sign-in and every token; another member's loses the tokens it made here.
  const revokeAgent = useApiMutation(async (api, id: string) => { const result = await api.credentials.revokeAgent(id); toast(result.scope === 'agent' ? 'Agent revoked' : 'Agent tokens revoked', 'success') })
  const revokeToken = useApiMutation((api, id: string) => api.credentials.revokeAgentToken(id), 'Agent token revoked')
  const revokePassword = useApiMutation((api, password: AppPassword) => api.credentials.revokeAppPassword(password.inboxId, password.id), 'App password revoked')
  // /api-keys?create=send&domain=acme.com opens Create key on an API key, filled in (Overview's setup step links here);
  // the parameters then leave the URL, so Back and reload don't open it again.
  const [params, setParams] = useSearchParams()
  const [initial] = useState(() => {
    if (!params.has('create')) return undefined
    const asked = params.get('create') === 'inbound' ? 'addresses' : params.get('create')
    return { purpose: (['send', 'read_send', 'read', 'manage', 'addresses', 'inbox', 'create'] as Purpose[]).find(value => value === asked) ?? 'send', domain: params.get('domain') || undefined }
  })
  const [open, setOpen] = useState(Boolean(initial))
  const [connecting, setConnecting] = useState(connectLink)
  useEffect(() => { if (params.has('create')) setParams(previous => { const next = new URLSearchParams(previous); next.delete('create'); next.delete('domain'); return next }, { replace: true }) }, [params, setParams])
  const [secret, setSecret] = useState<CreatedSecret | null>(null)
  const [revoking, setRevoking] = useState<Row | null>(null)
  const [viewing, setViewing] = useState<Row | null>(null)
  const address = (id: string) => addresses.data?.find(item => item.id === id)?.address ?? id

  // API keys page by cursor; agents and app passwords aren't paginated, so they join the first page. Each source fails
  // on its own: the others still list, with one error and a retry for every source that failed.
  const firstPage = !cursor
  const sources = [
    ...(type === 'all' || type === 'api' ? [{ query: keys }] : []),
    ...((type === 'all' && firstPage) || type === 'agent' ? [{ query: agents }] : []),
    ...((type === 'all' && firstPage) || type === 'app' ? [{ query: passwords }] : []),
  ]
  const failed = sources.filter(source => source.query.error)
  const keysShown = type === 'all' || type === 'api'
  // Addresses name a limited key's scope; without them the key would list IDs, so it waits for them (not their failure).
  const listLoading = sources.some(source => source.query.isPending) || keysShown && addresses.isPending
  const listFailed = failed.length === sources.length
  const included = (query: typeof keys | typeof agents | typeof passwords) => sources.some(source => source.query === query) && !query.error
  const rows: Row[] = [
    ...(included(keys) ? newestFirst(keys.data ?? []).map(key => ({ kind: 'key' as const, id: key.id, key })) : []),
    ...(included(agents) ? newestFirst(agents.data ?? []).flatMap(agent => [{ kind: 'agent' as const, id: agent.id, agent }, ...newestFirst(agent.tokens).map(token => ({ kind: 'token' as const, id: token.id, token }))]) : []),
    // App passwords are active only: revoking one removes it.
    ...(included(passwords) ? newestFirst(passwords.data ?? []).map(password => ({ kind: 'app' as const, id: password.id, password })) : []),
  ]
  const active = showRevoked ? '' : 'active '
  const empty = failed.length ? <EmptyState title="Nothing else to show" />
    : cursor && keysShown ? <EmptyState title="No keys on this page" />
    : type === 'api' ? <EmptyState title={`No ${active}API keys`} description={showRevoked ? undefined : 'An API key lets your server, a script or an agent send email or read mail.'} />
    : type === 'agent' ? <EmptyState title="No agents connected" description="Connect an agent to let OpenCode, Claude Code or Cursor work with Bane as you. It shows up here once it signs in, with the tokens it makes." action={<Button onClick={() => setConnecting(true)}>Connect an agent</Button>} />
    : type === 'app' ? <EmptyState title="No app passwords" description="An app password lets a mail app such as Apple Mail or Thunderbird open a persistent inbox over IMAP or SMTP." />
    : <EmptyState title={`No ${active}keys`} description={showRevoked ? undefined : 'Create a key to send from your app, connect an agent or open an inbox in a mail app.'} />

  const keyAccess = (key: ApiKey): { first: ReactNode; second: string } => {
    const { access } = key
    if (access.type === 'workspace') return { first: accessLabel(key.permissions, key.domains.length === 0), second: domainScope(key.domains) }
    if (access.type === 'inbox') return { first: <>Inbox: <PrivateAddress value={address(access.inboxId ?? '')} /></>, second: mailLabel(access.mail) }
    if (access.addressIds?.length === 0) return { first: 'Creates inboxes', second: 'Reads only the inboxes it created' }
    return { first: access.addressIds ? <>Addresses: <AddressList values={access.addressIds.map(address)} /></> : 'Every address', second: mailLabel(access.mail) }
  }
  const name = (row: Row): { first: ReactNode; second: ReactNode } => {
    if (row.kind === 'key') return { first: row.key.name, second: `Created ${date(row.key.createdAt)}${row.key.expiresAt && !keyState(row.key) ? ` · ends ${date(row.key.expiresAt)}` : ''}` }
    if (row.kind === 'agent') return { first: connectionTitle(row.agent), second: row.agent.own ? row.agent.clientId : <PrivateAddress value={row.agent.userEmail} /> }
    if (row.kind === 'token') return { first: row.token.purpose, second: expiry(row.token) }
    return { first: row.password.name, second: `Created ${date(row.password.createdAt)}` }
  }
  const access = (row: Row): { first: ReactNode; second: ReactNode } => {
    if (row.kind === 'key') return keyAccess(row.key)
    if (row.kind === 'agent') return { first: agentAccess(row.agent.permissions), second: `Signed in ${date(row.agent.createdAt)}` }
    if (row.kind === 'token') return { first: accessLabel(row.token.permissions, false), second: domainScope(row.token.domains) }
    return { first: protocolLabel(row.password.protocols), second: <PrivateAddress value={row.password.inboxAddress} /> }
  }
  const used = (row: Row) => row.kind === 'key' ? lastUsed(row.key.lastUsedAt) : row.kind === 'agent' ? lastUsed(row.agent.lastUsedAt) : row.kind === 'token' ? lastUsed(row.token.lastUsedAt) : <span className="muted" title="Bane doesn’t track an app password’s last use">—</span>
  // On a phone the last line says what matters most for each: a key's prefix and use, a token's expiry.
  const cardLast = (row: Row) => {
    if (row.kind === 'key') return <><code>{row.key.prefix}</code> · {keyState(row.key) ?? usedLine(row.key.lastUsedAt)}</>
    if (row.kind === 'agent') return agentState(row.agent) ?? usedLine(row.agent.lastUsedAt)
    if (row.kind === 'token') return expiry(row.token)
    return `Created ${date(row.password.createdAt)}`
  }
  // Everything a row shows, in full: the table and the phone's cards clip long names, scopes and address lists.
  const details = (row: Row): [string, ReactNode][] => {
    const { first, second } = access(row)
    if (row.kind === 'key') return [['Type', typeName.key], ['Access', first], [row.key.access.type === 'workspace' ? 'Domains' : 'Mail', second], ['Key prefix', <code>{row.key.prefix}</code>], ['Created', date(row.key.createdAt)], ...(row.key.expiresAt ? [[past(row.key.expiresAt) ? 'Ended' : 'Ends', date(row.key.expiresAt)] as [string, ReactNode]] : []), ['Last used', lastUsed(row.key.lastUsedAt)], ...(row.key.revokedAt ? [['Revoked', date(row.key.revokedAt)] as [string, ReactNode]] : [])]
    if (row.kind === 'agent') return [['Type', typeName.agent], ['Access', first], ['Client', row.agent.clientId], ['Account', row.agent.own ? 'You' : <PrivateAddress value={row.agent.userEmail} />], ['Signed in', date(row.agent.createdAt)], ['Last used', lastUsed(row.agent.lastUsedAt)], ['Status', agentState(row.agent) ?? 'Active']]
    if (row.kind === 'token') return [['Type', typeName.token], ['Access', first], ['Domains', second], ['Expires', tokenState(row.token) ?? `${shortDateTime(row.token.expiresAt)} UTC`], ['Last used', lastUsed(row.token.lastUsedAt)]]
    return [['Type', typeName.app], ['Access', first], ['Inbox', second], ['Created', date(row.password.createdAt)]]
  }
  const [nameColumn, typeColumn, accessColumn, prefixColumn, lastColumn, actionsColumn] = settingsColumns.keys

  return <div className="stack">
    <PageHeader title="API keys" actions={<><Checkbox label="Show inactive" checked={showRevoked} onCheckedChange={checked => { setShowRevoked(checked); pagination.reset() }} /><Button variant="primary" onClick={() => setOpen(true)}>Create key</Button></>} />
    <KeysGuide />
    <div className="keys-sections">
      <section className="section stack" aria-label="Keys">
        <Tabs label="Type" value={type} onValueChange={value => { setType(value as KeyTypeFilter); pagination.reset() }} items={[...keyTypes]} />
        {!listFailed && <DataTable className="keys-table keys-table--two-line" loading={listLoading} skeletonRows={3} rows={rows} rowKey={row => row.id} onRowClick={setViewing} empty={empty}
          columns={[
            { ...nameColumn, render: row => <TwoLines nested={row.kind === 'token'} first={name(row).first} second={name(row).second} />, cardRender: row => <span className={row.kind === 'token' ? 'keys-nested' : undefined}>{name(row).first}</span> },
            { ...typeColumn, render: row => typeName[row.kind] },
            { ...accessColumn, render: row => <TwoLines first={access(row).first} second={access(row).second} />, cardRender: row => <span className={row.kind === 'token' ? 'keys-nested' : undefined}>{access(row).first} · {access(row).second}</span> },
            { ...prefixColumn, render: row => row.kind === 'key' ? <code>{row.key.prefix}</code> : <span className="muted">—</span> },
            { ...lastColumn, render: used, cardRender: row => <span className={row.kind === 'token' ? 'keys-nested' : undefined}>{cardLast(row)}</span> },
            { ...actionsColumn, render: row => rowState(row) ?? <Button variant="danger" aria-label={`Revoke ${rowName(row)}`} onClick={() => setRevoking(row)}>Revoke</Button>,
              cardRender: row => rowState(row) ? null : <DropdownMenu label={`Actions for ${rowName(row)}`} title={rowName(row)} items={[{ label: revokeLabel(row), destructive: true, onSelect: () => setRevoking(row) }]} /> },
          ]} />}
        {failed.length > 0 && <ErrorState error={failed[0].query.error} onRetry={() => failed.forEach(source => void source.query.refetch())} />}
        {keysShown && !listLoading && (!keys.error || pagination.page > 1) && <Pagination page={pagination.page} pageSize={100} nextCursor={keys.data?.nextCursor} onPageChange={next => pagination.onPageChange(next, keys.data?.nextCursor)} />}
      </section>
    </div>
    {open && <CreateKeyDialog open onOpenChange={setOpen} initial={initial} onCreated={setSecret} onConnectAgent={() => setConnecting(true)} />}
    <ConnectAgentDialog open={connecting} onOpenChange={setConnecting} />
    <SecretDialog secret={secret?.secret ?? null} title={secret?.title ?? 'Key created'} description={secret?.description} onClose={() => setSecret(null)}>{secret?.sendExample && <KeySendExample apiKey={secret.secret} />}</SecretDialog>
    <KeyDetails row={viewing} fields={viewing ? details(viewing) : []} onClose={() => setViewing(null)} onRevoke={row => { setViewing(null); setRevoking(row) }} />
    <RevokeDialog row={revoking} onClose={() => setRevoking(null)} pending={revokeKey.isPending || revokeAgent.isPending || revokeToken.isPending || revokePassword.isPending}
      onConfirm={async row => {
        if (row.kind === 'key') await revokeKey.mutateAsync(row.key.id)
        else if (row.kind === 'agent') await revokeAgent.mutateAsync(row.agent.id)
        else if (row.kind === 'token') await revokeToken.mutateAsync(row.token.id)
        else await revokePassword.mutateAsync(row.password)
      }} />
  </div>
}

// One row in full, with Revoke: the way to read a long name or address list on a phone, where a card clips it.
function KeyDetails({ row, fields, onClose, onRevoke }: { row: Row | null; fields: [string, ReactNode][]; onClose: () => void; onRevoke: (row: Row) => void }) {
  return <Dialog open={row !== null} onOpenChange={next => { if (!next) onClose() }} title={row ? rowName(row) : ''} footer={<>
    <Button onClick={onClose}>Close</Button>
    {row && !rowState(row) && <Button variant="danger" onClick={() => onRevoke(row)}>{revokeLabel(row)}</Button>}
  </>}>
    <dl className="keys-details">{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
  </Dialog>
}

// What revoking each one ends, said before it happens.
function RevokeDialog({ row, onClose, onConfirm, pending }: { row: Row | null; onClose: () => void; onConfirm: (row: Row) => Promise<void>; pending: boolean }) {
  const description: ReactNode = !row ? ''
    : row.kind === 'key' ? row.key.access.type === 'workspace' ? 'Requests using this key will stop working. Revoking a key cannot be undone.' : 'Agents using this key stop working immediately, and queued mail it sent will not be dispatched. Revoking cannot be undone.'
    : row.kind === 'agent' ? row.agent.own ? 'This revokes its sign-in and every agent token it made: they stop working immediately. It can sign in again as a new agent.' : <>This revokes the agent tokens it made in this workspace. The sign-in belongs to <PrivateAddress value={row.agent.userEmail} />.</>
    : row.kind === 'token' ? 'This short-lived token stops working immediately. Revoking it cannot be undone.'
    : 'Mail apps using it are signed out and can’t sign in with it again. The inbox and its mail stay.'
  const label = row ? revokeLabel(row) : 'Revoke'
  return <ConfirmDialog open={row !== null} onOpenChange={next => { if (!next) onClose() }} title={`Revoke ${row ? rowName(row) : 'key'}?`} description={description} confirmLabel={label} danger pending={pending} onConfirm={async () => { if (row) await onConfirm(row) }} />
}

function TwoLines({ first, second, nested = false }: { first: ReactNode; second: ReactNode; nested?: boolean }) {
  return <div className={`settings-cell-stack keys-cell${nested ? ' keys-cell--nested' : ''}`}><span title={typeof first === 'string' ? first : undefined}>{first}</span><span className="muted" title={typeof second === 'string' ? second : undefined}>{second}</span></div>
}
