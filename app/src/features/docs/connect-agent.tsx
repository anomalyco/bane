// Connecting an AI agent over MCP, in one place: Docs, API keys, Receiving's agent inboxes and each inbox show the
// same config, built by api/src/mcp-clients.ts (which createInboxConnection uses too).
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { Alert, Button, Checkbox, Dialog, Field, Select, Tabs } from '../../components/ui'
import { CopyAction } from '../../components/motion'
import { useApiQuery, usePublicOrigin, useWorkspaceAccess } from '../../data/context'
import { request } from '../../data/live'
import { ApiError } from '../../data/types'
import { mcpClientNames, mcpClients, mcpClientSteps, mcpServerUrl, mcpSnippet, type McpClient } from '../../../../api/src/mcp-clients'
import './developer.css'
import { useSingleFlight } from '../../lib/single-flight'

/** What an agent signed in with OAuth asks for. Only OpenCode lets the config choose; other clients ask for read. */
export const mcpAccess = [
  { value: 'read', label: 'Read only', scope: 'bane:read offline_access', hint: 'Reads mail, logs and settings. Can’t send or change anything.' },
  { value: 'send', label: 'Read and send', scope: 'bane:read bane:send offline_access', hint: 'Also sends email, which may reach real recipients.' },
  { value: 'manage', label: 'Full access', scope: 'bane:read bane:send bane:manage offline_access', hint: 'Also changes configuration: domains, routes, rituals and keys.' },
] as const
export type McpAccess = typeof mcpAccess[number]['value']
const clientTabs = mcpClients.map(value => ({ value, label: mcpClientNames[value] }))

/** The hosted MCP URL on this installation's canonical address, or null until that is known. */
export function useMcpUrl() { const origin = usePublicOrigin(); return origin ? mcpServerUrl(origin) : null }


/** Client tabs, the snippet with its copy button and the steps after it. Every tab shares one cell, so the height holds. */
export function McpClientSetup({ client, onClient, url, auth, label = 'MCP client' }: { client: McpClient; onClient: (client: McpClient) => void; url: string | null; auth: { bearer: string } | { scope?: string }; label?: string }) {
  const kind = 'bearer' in auth ? 'key' : 'oauth'
  if (!url) return <p className="muted developer-copy" role="status">Loading this installation’s address…</p>
  return <div className="stack">
    <Tabs label={label} value={client} onValueChange={value => onClient(value as McpClient)} items={clientTabs} />
    <div className="developer-client-panels">{mcpClients.map(value => {
      const snippet = mcpSnippet(value, url, auth)
      return <div key={value} className="stack developer-client-panel" data-active={value === client || undefined} inert={value !== client}>
        <div className="developer-snippet">
          <pre className={snippet.startsWith('claude ') ? 'developer-code developer-code--wrap' : 'developer-code'} tabIndex={0} aria-label={`${mcpClientNames[value]} setup`}><code>{snippet}</code></pre>
          <CopyAction key={`${value}:${snippet.length}`} value={snippet} label={`Copy ${mcpClientNames[value]} setup`} variant="ghost" size="sm" compact className="developer-copy-icon developer-snippet__copy" />
        </div>
        <ol className="developer-steps">{mcpClientSteps(value, kind).map(step => <li key={step}>{step}</li>)}</ol>
      </div>
    })}</div>
  </div>
}

type Inbox = { id: string; address: string; name: string | null; status: string; type: 'ephemeral' | 'sandbox' }
type Connection = { id: string | null; config: object; nextStep: string; key: string | null; client: McpClient }
const errorText = (e: unknown) => e instanceof ApiError ? e.text : (e as Error).message

/**
 * Connect an agent: as you over OAuth (it gets the access you approve in the browser, and you can narrow it to chosen
 * inboxes there), or to one agent inbox with an inbox key that can't reach anything else. Opened from an inbox, that
 * inbox is chosen. Every open starts fresh.
 */
export function ConnectAgentDialog({ open, onOpenChange, inboxId }: { open: boolean; onOpenChange: (open: boolean) => void; inboxId?: string }) {
  const { canAdminister } = useWorkspaceAccess()
  const url = useMcpUrl()
  const [client, setClient] = useState<McpClient>('opencode')
  const [mode, setMode] = useState<'oauth' | 'key'>('oauth')
  const [access, setAccess] = useState<McpAccess>('read')
  const [inbox, setInbox] = useState('')
  const [reply, setReply] = useState(false)
  const [result, setResult] = useState<Connection | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const inboxes = useApiQuery(['agent-inboxes', 'connect'], (_api, signal) => request<{ data: Inbox[] }>('/v1/inboxes?status=active&limit=100', { signal }).then(r => r.data), { enabled: open && canAdminister })
  useEffect(() => {
    if (!open) return
    setClient('opencode'); setMode(inboxId && canAdminister ? 'key' : 'oauth'); setAccess('read'); setInbox(inboxId ?? ''); setReply(false); setResult(null); setError('')
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const active = (inboxes.data ?? []).filter(box => box.status === 'active')
  const chosen = inbox || active[0]?.id || ''
  const label = (box: Inbox) => box.name ? `${box.name} · ${box.address}` : box.address
  // Single flight: each call makes a new idempotency key, so a second click before the first answers would make a second key.
  const create = useSingleFlight(async () => {
    if (!chosen) return
    setBusy(true); setError('')
    try {
      const made = await request<{ id: string | null; config: object; nextStep: string }>('/v1/inbox-connections', { method: 'POST', body: { inboxes: [chosen], client, auth: 'key', reply }, idempotencyKey: crypto.randomUUID() })
      // The key is inside the config, shown once; the snippet for every client is rebuilt from it.
      const bearer = JSON.stringify(made.config).match(/Bearer (bane_mbx_[A-Za-z0-9_-]+)/)?.[1] ?? null
      setResult({ ...made, key: bearer, client })
    } catch (e) { setError(errorText(e)) }
    finally { setBusy(false) }
  })
  const selected = mcpAccess.find(option => option.value === access)!
  // The API names the key after the inbox (its name, or else its address) and the client it was made for.
  const box = active.find(item => item.id === chosen)
  const keyName = box?.name ? `${box.name} · ${mcpClientNames[result?.client ?? client]}` : null
  const close = () => { if (!busy) onOpenChange(false) }
  return <Dialog open={open} onOpenChange={next => { if (!next) close() }} title="Connect an agent" className="connect-agent-dialog"
    description="Let an AI agent such as OpenCode, Claude Code or Cursor work with Bane over MCP."
    footer={mode === 'key' && !result ? <><Button disabled={busy} onClick={close}>Cancel</Button><Button variant="primary" loading={busy} disabled={!chosen} onClick={() => void create()}>Create inbox key</Button></> : <Button variant="primary" onClick={close}>Done</Button>}>
    <div className="stack">
      {!result && <>
        <Field label="What it can reach" hint={mode === 'oauth' ? 'It signs in as you and gets the access you approve in the browser. On that screen you can also limit it to chosen agent inboxes.' : 'A key that reads one agent inbox and nothing else in the workspace. It stops working when the inbox is deleted.'}>
          <Select value={mode} onValueChange={value => { setMode(value as typeof mode); setError('') }} options={[{ value: 'oauth', label: 'Sign in as me (OAuth)' }, ...(canAdminister ? [{ value: 'key', label: 'One agent inbox (inbox key)' }] : [])]} />
        </Field>
        {mode === 'oauth' ? <Field label="Access it asks for" hint={client === 'opencode' ? selected.hint : `${mcpClientNames[client]} asks for read access; you can approve more in the browser.`}>
          <Select value={access} onValueChange={value => setAccess(value as McpAccess)} disabled={client !== 'opencode'} options={mcpAccess.map(({ value, label }) => ({ value, label }))} />
        </Field> : <>
          <Field label="Inbox" hint={inboxes.isPending ? 'Loading inboxes…' : !active.length ? undefined : 'Agent inboxes are expiring addresses for agents and tests.'}>
            {inboxes.isPending || active.length ? <Select value={chosen} onValueChange={setInbox} disabled={inboxes.isPending} options={active.map(box => ({ value: box.id, label: label(box) }))} />
              : <p className="muted connect-agent__empty">No active agent inboxes. <Link to="/receiving/inboxes" onClick={close}>Create one in Receiving</Link>, then connect it here.</p>}
          </Field>
          <Checkbox checked={reply} onCheckedChange={setReply} label="Also let it reply to people who wrote to the inbox (needs replies on for the inbox)" />
        </>}
      </>}
      {result && <Alert tone="success" title="Inbox key created">Copy the setup now: the key is shown only once. You’ll find it in API keys and on the inbox’s page{keyName ? <>, named “{keyName}”</> : null}.</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}
      {(mode === 'oauth' || result) && <McpClientSetup client={client} onClient={setClient} url={url} auth={result?.key ? { bearer: result.key } : { scope: selected.scope }} />}
      {mode === 'key' && !result && <McpClientPreview client={client} onClient={setClient} />}
    </div>
  </Dialog>
}

/** Before the key exists: just the client choice, so the created config is for the right one. */
function McpClientPreview({ client, onClient }: { client: McpClient; onClient: (client: McpClient) => void }) {
  return <div className="stack"><Tabs label="MCP client" value={client} onValueChange={value => onClient(value as McpClient)} items={clientTabs} />
    <p className="muted developer-copy">The setup for {mcpClientNames[client]}, with the key in it, appears here once you create the key.</p></div>
}

/** The button that opens it, wherever an agent might be connected from. */
export function ConnectAgentButton({ inboxId, variant = 'secondary', size = 'md', initiallyOpen = false }: { inboxId?: string; variant?: 'primary' | 'secondary' | 'ghost'; size?: 'sm' | 'md'; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen)
  return <><Button variant={variant} size={size} onClick={() => setOpen(true)}>Connect an agent</Button><ConnectAgentDialog open={open} onOpenChange={setOpen} inboxId={inboxId} /></>
}
