import { useState } from 'react'
import { useLocation, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Alert, Button, ErrorState, PageHeader, SectionHeader, Skeleton, StatusBadge } from '../../components/ui'
import { AccountAvatar } from '../../components/AccountSwitcher'
import { PrivateAddress } from '../../components/PrivateAddress'
import { accountApi, accountsKey } from '../../data/accounts'
import { useApiDef, useApiMutation, useSession } from '../../data/context'
import { queries } from '../../data/queries'
import { McpApproval, Row, connectionTitle } from './hosted'

// One MCP connection (/settings/mcp/<id>), linked from Settings and the rituals page. One connection is one account: the
// account its client signed in as at the account service. The page lists this browser's connected accounts with that one
// marked, and acts only as the account you pick, never silently as the tab's account; with the right one active, its
// default workspace follows. "Use another account" adds an account through the account service's chooser.
export function McpApprovalPage() {
  const { id = '' } = useParams()
  const session = useSession()
  const location = useLocation()
  const identity = session?.identity
  const browser = useQuery({ queryKey: [...accountsKey, 'connection', id], queryFn: ({ signal }) => accountApi.list(signal, id), staleTime: 0 })
  const owner = browser.data?.connection?.account ?? null
  const [chosen, setChosen] = useState<string | null>(null)
  const picked = chosen ?? owner ?? identity?.id ?? null
  const ready = Boolean(identity && owner && owner === identity.id && picked === owner)
  const connection = useApiDef(queries.mcpConnection(id), { enabled: ready })
  const revoke = useApiMutation((api, connectionId: string) => api.credentials.revokeMcpConnection(connectionId), 'MCP connection revoked')
  const [switching, setSwitching] = useState(false)
  const accounts = browser.data?.accounts ?? []
  const pickedAccount = accounts.find(account => account.id === picked)
  async function continueAs(account: string) {
    setSwitching(true)
    try { await session!.switchAccount(account, location.pathname) } finally { setSwitching(false) }
  }
  return <div className="stack mcp-approval">
    <PageHeader title="MCP connection" backTo="/settings#account" />
    <SectionHeader title="Account" />
    <p className="muted">The client acts as the account it signed in with at Anomaly account. Approve it as that account.</p>
    {browser.isError ? <ErrorState error={browser.error} onRetry={() => void browser.refetch()} /> : <div className="settings-rows" role="radiogroup" aria-label="Account">
      {/* One row while loading (the usual one account); further accounts and the last row are added below it, so
          nothing that is already shown moves. */}
      {browser.isPending ? <div className="settings-row"><Skeleton width={220} height={20} /></div>
        : accounts.map(account => <label key={account.id} className="settings-row mcp-approval__account">
          <span className="mcp-approval__who"><input type="radio" name="mcp-account" checked={picked === account.id} onChange={() => setChosen(account.id)} />
            <AccountAvatar name={account.name} email={account.email} /><span className="settings-row__label"><span>{account.name || account.email}</span>{account.email && <PrivateAddress className="muted" value={account.email} />}</span></span>
          <span className="settings-row__control">{account.id === owner && <StatusBadge status="This connection" tone="info" />}{account.id === identity?.id && <span className="muted">This tab</span>}</span>
        </label>)}
      {browser.data && <div className="settings-row"><span className="settings-row__label"><span>Another account</span><span className="muted">Choose it at Anomaly account</span></span><span className="settings-row__control"><Button onClick={() => session?.addAccount(location.pathname)}>Use another account</Button></span></div>}
    </div>}
    {browser.data && (!owner ? <Alert tone="info" title="This connection used another account">It signed in with an account that isn’t connected in this browser. Use another account to add it, or reconnect the client and choose one of these accounts at Anomaly account.</Alert>
      : picked !== owner ? <Alert tone="info" title="Not this connection’s account">The client signed in with a different account. To connect {pickedAccount?.name || 'this account'} instead, reconnect the client and choose it at Anomaly account.</Alert>
      : owner !== identity?.id ? <div className="cluster"><Button variant="primary" loading={switching} onClick={() => void continueAs(owner)}>Continue as {pickedAccount?.name || pickedAccount?.email || 'this account'}</Button></div>
      : null)}
    {ready && <>
      <SectionHeader title="Default workspace" />
      <p className="muted">Each tool call can name one of your workspaces; calls that name none use this one. Your role in a workspace decides what the client can do there.</p>
      {connection.isError ? <ErrorState error={connection.error} onRetry={() => void connection.refetch()} />
        : !connection.data ? <div className="settings-rows"><div className="settings-row"><Skeleton width={200} height={20} /></div></div>
        : connection.data.status === 'active' ? <div className="settings-rows"><McpApproval key={`${connection.data.id}:${connection.data.workspaceId}`} app={connection.data} workspaces={identity?.workspaces ?? []} linked={false} onRevoke={() => revoke.mutate(connection.data!.id)} /></div>
        : <div className="settings-rows"><Row title={connectionTitle(connection.data)} hint={connection.data.clientId}>{connection.data.status === 'expired' ? 'Expired · reconnect the client' : 'Revoked · reconnect the client'}</Row></div>}
    </>}
  </div>
}
