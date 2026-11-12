import { useState, type ReactNode } from 'react'
import { Button, Checkbox, ConfirmDialog, DataTable, EmptyState, ErrorState, PageHeader, Pagination, SectionHeader } from '../../components/ui'
import { useApiMutation, useApiDef } from '../../data/context'
import { queries } from '../../data/queries'
import type { AgentTokenSummary, ApiKey, MailboxKey, McpConnection } from '../../data/types'
import { date, shortDateTime } from '../../lib/format'
import { useCursorPagination } from '../../lib/pagination'
import { SecretDialog } from './shared'
import { KeySendExample } from '../docs/first-send'
import { CreateKeyDialog, accessLabel, domainScope, permissionList } from './create-key'
import { settingsColumns } from './skeletons'
import './api-keys.css'
import { AddressList } from '../../components/PrivateAddress'
import { ConnectAgentButton } from '../docs/connect-agent'
import { guides } from '../inbound/concepts'
import { Link } from 'react-router'

import { credentials } from '../docs/credentials'

type KeyRow = { kind: 'api'; key: ApiKey } | { kind: 'inbound'; key: MailboxKey }
type ConnectedRow = { kind: 'token'; item: AgentTokenSummary } | { kind: 'mcp'; item: McpConnection }
const lastUsed = (value: string | null) => value ? date(value) : 'Never'
const tokenInactive = (token: AgentTokenSummary) => token.revokedAt !== null || Date.parse(token.expiresAt) <= Date.now()

export function ApiKeysPage() {
  // /api-keys?connect=1 (from Overview and Docs) opens Connect an agent.
  const [connectLink] = useState(() => new URLSearchParams(window.location.search).has('connect'))
  const [showRevoked, setShowRevoked] = useState(false)
  const pagination = useCursorPagination()
  const cursor = pagination.cursor
  const keys = useApiDef(queries.keys(cursor, showRevoked), { keepPrevious: true })
  const inboundKeys = useApiDef(queries.mailboxKeys(showRevoked), { keepPrevious: true })
  const addresses = useApiDef(queries.inboundAddressOptions())
  const agentTokens = useApiDef(queries.agentTokens(showRevoked), { keepPrevious: true })
  const mcpConnections = useApiDef(queries.mcpConnections())
  const revoke = useApiMutation((api, id: string) => api.keys.revoke(id), 'API key revoked')
  const revokeInbound = useApiMutation((api, id: string) => api.mailboxes.revokeKey(id), 'Inbound key revoked')
  const revokeAgentToken = useApiMutation((api, id: string) => api.credentials.revokeAgentToken(id), 'Agent token revoked')
  const revokeMcpConnection = useApiMutation((api, id: string) => api.credentials.revokeMcpConnection(id), 'MCP connection revoked')
  const [open, setOpen] = useState(false)
  const [secret, setSecret] = useState<{ value: string; title: string } | null>(null)
  const [revokeKey, setRevokeKey] = useState<KeyRow | null>(null)
  const [revokeToken, setRevokeToken] = useState<AgentTokenSummary | null>(null)
  const [revokeConnection, setRevokeConnection] = useState<McpConnection | null>(null)
  const address = (id: string) => addresses.data?.find(item => item.id === id)?.address ?? id
  const inboxOf = (id: string) => addresses.data?.find(item => item.id === id && item.kind === 'inbox')

  // Inbound keys aren't paginated, so they join the first page of API keys, newest first.
  const firstPage = !cursor
  const listLoading = keys.isPending || firstPage && (inboundKeys.isPending || addresses.isPending)
  // Each source fails on its own: a failed API key page still lists inbound keys, and the other way round.
  const apiFailed = Boolean(keys.error)
  const inboundFailed = firstPage && Boolean(inboundKeys.error)
  const listFailed = apiFailed && (!firstPage || inboundFailed)
  const emptyTitle = cursor ? 'No keys on this page' : `No ${showRevoked ? '' : 'active '}${apiFailed ? 'inbound keys' : inboundFailed ? 'API keys' : 'keys'}`
  const rows: KeyRow[] = [...(keys.data ?? []).map(key => ({ kind: 'api' as const, key })), ...(firstPage ? inboundKeys.data ?? [] : []).map(key => ({ kind: 'inbound' as const, key }))]
    .sort((a, b) => b.key.createdAt.localeCompare(a.key.createdAt))
  const connected: ConnectedRow[] = [...(mcpConnections.data ?? []).map(item => ({ kind: 'mcp' as const, item })), ...(agentTokens.data ?? []).map(item => ({ kind: 'token' as const, item }))]
  const connectedError = agentTokens.error ?? mcpConnections.error
  // Always shown once known, empty or not: where agents you connect appear, and how to connect one.
  const showConnected = !listLoading && !agentTokens.isPending && !mcpConnections.isPending
  const connectionName = (grantId: string) => mcpConnections.data?.find(connection => connection.id === grantId)?.name

  return <div className="stack">
    <PageHeader title="API keys" actions={<><Checkbox label="Show inactive" checked={showRevoked} onCheckedChange={checked => { setShowRevoked(checked); pagination.reset() }} /><ConnectAgentButton initiallyOpen={connectLink} /><Button variant="primary" onClick={() => setOpen(true)}>Create key</Button></>} />
    <section className="keys-guide" aria-labelledby="keys-guide">
      <h2 id="keys-guide">Which key do I need? <Link className="guide-link" to={guides.keys}>Guide</Link></h2>
      <dl>{credentials.map(kind => <div key={kind.name}><dt>{kind.name}</dt><dd>{kind.line} <span className="keys-guide__where">{kind.where}</span></dd></div>)}</dl>
    </section>
    <div className="keys-sections">
      <section className="section stack" aria-label="Keys">
        {!listFailed && <DataTable className="keys-table keys-table--two-line" loading={listLoading} skeletonRows={3} rows={rows} rowKey={row => row.key.id}
          empty={<EmptyState title={emptyTitle} description={cursor || showRevoked || apiFailed || inboundFailed ? undefined : 'Create a key to send from your app or let an agent work on an inbound address.'} />}
          columns={[
            { ...settingsColumns.keys[0], render: row => <TwoLines first={row.key.name} second={`Created ${date(row.key.createdAt)}`} /> },
            { ...settingsColumns.keys[1], render: row => row.kind === 'api'
              ? <TwoLines first={accessLabel(row.key.permission.split(', '), row.key.domains.length === 0)} second={domainScope(row.key.domains)} />
              : <TwoLines first={<>{row.key.addressIds?.length === 1 && inboxOf(row.key.addressIds[0]!) ? 'Inbox key: ' : 'Inbound key: '}{row.key.addressIds ? <AddressList values={row.key.addressIds.map(address)} /> : 'every address'}</>} second={permissionList(row.key.permissions)} /> },
            { ...settingsColumns.keys[2], render: row => <code>{row.key.prefix}</code> },
            { ...settingsColumns.keys[3], render: row => lastUsed(row.key.lastUsedAt) },
            { ...settingsColumns.keys[4], render: row => row.key.revokedAt ? 'Revoked' : <Button variant="danger" aria-label={`Revoke ${row.key.name}`} onClick={() => setRevokeKey(row)}>Revoke</Button> },
          ]} />}
        {apiFailed && <ErrorState error={keys.error} onRetry={() => void keys.refetch()} />}
        {inboundFailed && <ErrorState error={inboundKeys.error} onRetry={() => void inboundKeys.refetch()} />}
        {!listLoading && (!apiFailed || pagination.page > 1) && <Pagination page={pagination.page} pageSize={20} nextCursor={keys.data?.nextCursor} onPageChange={next => pagination.onPageChange(next, keys.data?.nextCursor)} />}
      </section>
      {showConnected && <section className="section stack">
        <div className="keys-head">
          <SectionHeader title="Connected agents" actions={<ConnectAgentButton size="sm" />} />
          <p className="muted">Agents signed in as someone in this workspace over MCP, and the short-lived agent tokens they made. Revoking a sign-in also revokes its tokens.</p>
        </div>
        {connectedError ? <ErrorState error={connectedError} onRetry={() => { void agentTokens.refetch(); void mcpConnections.refetch() }} /> : <DataTable className="keys-table keys-table--two-line" rows={connected} rowKey={row => row.item.id}
          empty={<EmptyState title="No agents connected" description="Connect an agent to let OpenCode, Claude Code or Cursor work with Bane as you. It shows up here once it signs in, with a Revoke button." />} columns={[
          { key: 'name', label: 'Name', width: '30%', render: row => row.kind === 'mcp'
            ? <TwoLines first={row.item.name || 'MCP client'} second={row.item.userEmail} />
            : <TwoLines first={row.item.purpose} second={`Agent token${connectionName(row.item.grantId) ? ` from ${connectionName(row.item.grantId)}` : ''}`} /> },
          { key: 'access', label: 'Access', width: '30%', render: row => row.kind === 'mcp'
            ? <TwoLines first={accessLabel(row.item.scopes.map(scope => scope.replace('bane:', '')), true)} second={row.item.scopes.map(scope => scope.replace('bane:', '').replaceAll('_', ' ')).join(', ')} />
            : <TwoLines first={accessLabel(row.item.permissions, false)} second={domainScope(row.item.domains)} /> },
          { key: 'when', label: 'Connected / expires', width: '18%', render: row => row.kind === 'mcp' ? `Connected ${date(row.item.createdAt)}` : row.item.revokedAt ? 'Revoked' : tokenInactive(row.item) ? 'Expired' : `Expires ${shortDateTime(row.item.expiresAt)} UTC` },
          { key: 'used', label: 'Last used', render: row => row.kind === 'mcp' ? '—' : lastUsed(row.item.lastUsedAt) },
          { key: 'actions', label: '', align: 'right', width: 100, render: row => row.kind === 'mcp'
            ? <Button variant="danger" aria-label={`Revoke ${row.item.name || 'MCP connection'}`} onClick={() => setRevokeConnection(row.item)}>Revoke</Button>
            : tokenInactive(row.item) ? null : <Button variant="danger" aria-label={`Revoke ${row.item.purpose}`} onClick={() => setRevokeToken(row.item)}>Revoke</Button> },
        ]} />}
      </section>}
    </div>
    {open && <CreateKeyDialog open onOpenChange={setOpen} onCreated={(value, title) => setSecret({ value, title })} />}
    <SecretDialog secret={secret?.value ?? null} title={secret?.title ?? 'Key created'} onClose={() => setSecret(null)}>{secret?.title === 'API key created' && <KeySendExample apiKey={secret.value} />}</SecretDialog>
    <ConfirmDialog open={revokeKey !== null} onOpenChange={next => { if (!next) setRevokeKey(null) }} title={`Revoke ${revokeKey?.key.name ?? 'key'}?`}
      description={revokeKey?.kind === 'inbound' ? 'Agents using this key stop working immediately, and queued mail it sent will not be dispatched. Revoking cannot be undone.' : 'Requests using this key will stop working. Revoking a key cannot be undone.'}
      confirmLabel="Revoke key" danger pending={revoke.isPending || revokeInbound.isPending} onConfirm={async () => { if (revokeKey?.kind === 'api') await revoke.mutateAsync(revokeKey.key.id); else if (revokeKey) await revokeInbound.mutateAsync(revokeKey.key.id) }} />
    <ConfirmDialog open={revokeToken !== null} onOpenChange={next => { if (!next) setRevokeToken(null) }} title={`Revoke ${revokeToken?.purpose ?? 'agent token'}?`} description="This temporary token will stop working immediately. Revoking it cannot be undone." confirmLabel="Revoke token" danger pending={revokeAgentToken.isPending} onConfirm={async () => { if (revokeToken) await revokeAgentToken.mutateAsync(revokeToken.id) }} />
    <ConfirmDialog open={revokeConnection !== null} onOpenChange={next => { if (!next) setRevokeConnection(null) }} title={`Revoke ${revokeConnection?.name || 'MCP connection'}?`} description="This connection and every agent token created from it will stop working immediately." confirmLabel="Revoke connection" danger pending={revokeMcpConnection.isPending} onConfirm={async () => { if (revokeConnection) await revokeMcpConnection.mutateAsync(revokeConnection.id) }} />
  </div>
}

function TwoLines({ first, second }: { first: ReactNode; second: string }) {
  return <div className="settings-cell-stack keys-cell"><span title={typeof first === 'string' ? first : undefined}>{first}</span><span className="muted" title={second}>{second}</span></div>
}
