import { useState, type FormEvent } from 'react'
import { Alert, Button, Checkbox, CopyButton, Dialog, Field, Input, Select } from '../../components/ui'
import { useApiMutation, useSession, useWorkspaceAccess } from '../../data/context'
import type { McpConnection, McpKeyInput, WorkspaceMembership } from '../../data/types'
import { roleLabel } from '../../data/workspaces'
import { useMcpUrl } from '../docs/connect-agent'
import { mcpSnippet } from '../../../../api/src/mcp-clients'
import { MutationError } from './shared'

// An MCP key: an approval with a static bearer instead of a browser sign-in, for an MCP client that can't open a browser
// (OpenCode on a server reached over SSH). It works only at /mcp, acts as you in one workspace with the access chosen
// here, and is revoked like any connected app. Shown once.
const SCOPES = [['bane:read', 'Read'], ['bane:send', 'Send'], ['bane:manage', 'Manage']] as const
const LIFETIMES = [['30', '30 days'], ['90', '90 days'], ['365', '1 year']] as const

export function McpKeyButton({ size }: { size?: 'sm' | 'md' }) {
  const [open, setOpen] = useState(false)
  return <><Button size={size} onClick={() => setOpen(true)}>Create MCP key</Button>{open && <McpKeyDialog onClose={() => setOpen(false)} />}</>
}

function McpKeyDialog({ onClose }: { onClose: () => void }) {
  const session = useSession(), access = useWorkspaceAccess(), url = useMcpUrl()
  const identity = session?.identity
  // Hosted: any workspace of this account. Self-hosted: the installation's one workspace.
  const workspaces: WorkspaceMembership[] = identity?.workspaces ?? (identity ? [{ id: identity.workspaceId, name: 'This workspace', slug: identity.workspaceId, role: access.canAdminister ? 'owner' : 'member' }] : [])
  const [name, setName] = useState(''), [workspaceId, setWorkspaceId] = useState(identity?.workspaceId ?? ''), [scopes, setScopes] = useState<string[]>(['bane:read'])
  const [receiving, setReceiving] = useState(false), [days, setDays] = useState('90')
  const [created, setCreated] = useState<{ connection: McpConnection; key: string } | null>(null)
  const create = useApiMutation((api, input: McpKeyInput) => api.credentials.createMcpKey(input), 'MCP key created')
  const admin = ['owner', 'admin'].includes(workspaces.find(item => item.id === workspaceId)?.role ?? '')
  const granted = scopes.filter(scope => scope !== 'bane:manage' || admin)
  async function submit(event: FormEvent) {
    event.preventDefault()
    try { setCreated(await create.mutateAsync({ name: name.trim(), workspaceId, scopes: granted as McpKeyInput['scopes'], receiving: receiving && admin && granted.includes('bane:manage'), expiresInDays: Number(days) })) } catch { /* shown inline */ }
  }
  if (created) {
    const snippet = url ? mcpSnippet('opencode', url, { bearer: '{env:BANE_MCP_KEY}' }) : ''
    return <Dialog open onOpenChange={next => { if (!next) onClose() }} title="MCP key created" description="Shown once. Copy it now." footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      <div className="settings-secret"><code>{created.key}</code><CopyButton value={created.key} label="Copy key" /></div>
      <p className="muted">Put it in <code>BANE_MCP_KEY</code> on the machine that runs the client, then add the server. In OpenCode (<code>opencode.json</code>):</p>
      {snippet && <div className="settings-secret"><pre>{snippet}</pre><CopyButton value={snippet} label="Copy config" /></div>}
      <p className="muted">Other clients send it as <code>Authorization: Bearer …</code> to <code>{url ?? '/mcp'}</code>. It never works on the REST API.</p>
    </Dialog>
  }
  return <Dialog open onOpenChange={next => { if (!next) onClose() }} title="Create MCP key"
    description="For an MCP client that can’t sign in with a browser, such as one on a remote server. The key acts as you in one workspace."
    footer={<><Button onClick={onClose}>Cancel</Button><Button type="submit" form="mcp-key-form" variant="primary" loading={create.isPending} disabled={!name.trim() || !workspaceId || !granted.length}>Create key</Button></>}>
    <form id="mcp-key-form" className="stack" onSubmit={submit}>
      <Field label="Name" htmlFor="mcp-key-name" hint="Where it’s used, for example “Build server”"><Input id="mcp-key-name" value={name} maxLength={100} onChange={event => setName(event.target.value)} required autoFocus /></Field>
      {workspaces.length > 1 && <Field label="Workspace" htmlFor="mcp-key-workspace"><Select id="mcp-key-workspace" value={workspaceId} onValueChange={value => { setWorkspaceId(value); setReceiving(false) }}
        options={workspaces.map(item => ({ value: item.id, label: `${item.name} · ${roleLabel[item.role]}` }))} /></Field>}
      <Field label="Access" hint={admin ? undefined : 'Manage and receiving need an owner or admin'}><div className="cluster">
        {SCOPES.map(([scope, label]) => <Checkbox key={scope} label={label} checked={granted.includes(scope)} disabled={scope === 'bane:manage' && !admin}
          onCheckedChange={on => setScopes(current => on ? [...current, scope] : current.filter(value => value !== scope))} />)}
        {granted.includes('bane:manage') && <Checkbox label="Receiving tools" checked={receiving} onCheckedChange={setReceiving} />}
      </div></Field>
      <Field label="Expires after" htmlFor="mcp-key-lifetime"><Select id="mcp-key-lifetime" value={days} onValueChange={setDays} options={LIFETIMES.map(([value, label]) => ({ value, label }))} /></Field>
      <Alert tone="info">Anyone with the key acts as you. Revoke it in Connected apps when the machine no longer needs it.</Alert>
      <MutationError error={create.error} />
    </form>
  </Dialog>
}
