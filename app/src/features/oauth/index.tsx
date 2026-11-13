import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Alert, Button, Checkbox, Field, Input, Select, Skeleton, StatusBadge } from '../../components/ui'
import { AccountAvatar } from '../../components/AccountSwitcher'
import { PrivateAddress } from '../../components/PrivateAddress'
import { ThemeToggle } from '../../components/ThemeToggle'
import { accountApi, accountsKey, type ConnectedAccount } from '../../data/accounts'
import { oauthApi, safeRedirect, type OAuthRequest } from '../../data/oauth'
import { ApiError } from '../../data/types'
import { roleLabel } from '../../data/workspaces'
import './oauth.css'

// The consent pages of Bane's MCP authorization server (api/src/oauth-server.ts). An app (OpenCode, Claude Code…) sends
// the browser to /oauth/authorize, which opens /consent/<request>; a device without a browser shows a code that is
// entered on /device. Either way the person picks one of the accounts connected in this browser, a workspace of it and
// the access, and approves or denies. Nothing here trusts the URL beyond the request ID: the server holds the request.

const SCOPES = [
  { scope: 'bane:read', label: 'Read', hint: 'Contacts, email, delivery and workspace data' },
  { scope: 'bane:send', label: 'Send', hint: 'Send email and campaigns' },
  { scope: 'bane:manage', label: 'Manage', hint: 'Domains, keys, webhooks and settings' },
] as const
const errors: Record<string, { title: string; text: string }> = {
  client: { title: 'Bane couldn’t verify this app', text: 'Its sign-in request names an app Bane doesn’t know, or the app’s published details couldn’t be read. Nothing was shared. Try again from the app, and contact its maker if this keeps happening.' },
  redirect: { title: 'This app asked to return somewhere it didn’t register', text: 'Bane only sends a sign-in back to an address the app registered. Nothing was shared. Try again from the app.' },
  request: { title: 'This sign-in request is incomplete', text: 'Start the sign-in again from the app.' },
  busy: { title: 'Too many sign-ins from this network', text: 'Wait a minute, then start again from the app.' },
}
const message = (error: unknown) => error instanceof ApiError ? error.text : 'Something went wrong. Try again.'

function Shell({ children }: { children: ReactNode }) {
  return <div className="oauth-page">
    <header className="oauth-header"><Link className="wordmark" to="/" aria-label="bane home"><span className="wordmark-square" aria-hidden="true" />bane</Link><ThemeToggle /></header>
    <main className="oauth-main">{children}</main>
  </div>
}

/** Sign in first: the browser has no Bane session. The account service returns here. */
function SignIn({ title, text }: { title: string; text: string }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null)
  async function start() {
    setBusy(true); setError(null)
    try { window.location.assign(await accountApi.signIn(window.location.href, false)) } catch (failure) { setError(failure); setBusy(false) }
  }
  return <div className="oauth-card stack">
    <h1>{title}</h1><p className="muted">{text}</p>
    {error ? <Alert tone="danger">{message(error)}</Alert> : null}
    <div className="cluster"><Button variant="primary" loading={busy} onClick={() => void start()}>Sign in to Bane</Button></div>
  </div>
}

export function ConsentPage() {
  const { id } = useParams(), [params] = useSearchParams()
  useEffect(() => { document.title = 'Allow access · bane' }, [])
  const failed = params.get('error')
  if (!id) return <Shell><div className="oauth-card stack"><h1>{errors[failed ?? '']?.title ?? 'Nothing to approve here'}</h1><p className="muted">{errors[failed ?? '']?.text ?? 'Start the sign-in from the app that wants to use Bane.'}</p></div></Shell>
  return <Shell><Consent requestId={id} /></Shell>
}

export function DevicePage() {
  const [params] = useSearchParams()
  useEffect(() => { document.title = 'Connect a device · bane' }, [])
  const browser = useQuery({ queryKey: accountsKey, queryFn: ({ signal }) => accountApi.list(signal), staleTime: 0 })
  const [code, setCode] = useState(params.get('code') ?? ''), [found, setFound] = useState<string | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null)
  const account = browser.data?.active ?? null
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null)
    try { setFound((await oauthApi.device(code, account)).id) } catch (failure) { setError(failure) } finally { setBusy(false) }
  }
  if (found) return <Shell><Consent requestId={found} /></Shell>
  return <Shell>{browser.isPending ? <div className="oauth-card stack"><Skeleton width={240} height={28} /><Skeleton width={360} height={20} /></div>
    : browser.data && !browser.data.accounts.length ? <SignIn title="Connect a device" text="Sign in to Bane, then enter the code your device shows." />
    : <form className="oauth-card stack" onSubmit={submit}>
      <h1>Connect a device</h1>
      <p className="muted">Enter the code shown by the app that wants to use Bane, for example on a server you connected to over SSH.</p>
      <Alert tone="warning" title="Only enter a code you started yourself">Someone who sends you a code is asking for access to your Bane account. Bane never asks for a code by email or chat.</Alert>
      <Field label="Code" htmlFor="device-code" error={error ? message(error) : undefined}>
        <Input id="device-code" className="oauth-code" value={code} onChange={event => setCode(event.target.value.toUpperCase())} placeholder="XXXX-XXXX" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={12} required autoFocus />
      </Field>
      <div className="cluster"><Button type="submit" variant="primary" loading={busy}>Continue</Button></div>
    </form>}</Shell>
}

function Consent({ requestId }: { requestId: string }) {
  const browser = useQuery({ queryKey: accountsKey, queryFn: ({ signal }) => accountApi.list(signal), staleTime: 0 })
  const accounts = browser.data?.accounts ?? []
  const [chosen, setChosen] = useState<string | null>(null)
  const picked = accounts.find(account => account.id === chosen) ?? accounts.find(account => account.id === browser.data?.active) ?? accounts[0]
  // The request reads as the picked account; any connected account may read it, so a switch doesn't refetch.
  const request = useQuery({ queryKey: ['oauth-request', requestId], queryFn: () => oauthApi.request(requestId, picked!.id), enabled: !!picked, retry: false, staleTime: Infinity })
  if (browser.isPending || (picked && request.isPending)) return <div className="oauth-card stack" aria-busy="true"><Skeleton width={280} height={28} /><Skeleton width={420} height={20} /><Skeleton width={420} height={53} /><Skeleton width={420} height={53} /></div>
  if (browser.isError) return <div className="oauth-card stack"><Alert tone="danger">{message(browser.error)}</Alert></div>
  if (!picked) return <SignIn title="Sign in to continue" text="An app wants to use your Bane account. Sign in to Bane to review what it asks for." />
  if (request.isError) return <div className="oauth-card stack"><h1>This request is no longer open</h1><p className="muted">{request.error instanceof ApiError && request.error.status === 404 ? 'It expired or was already answered. Start the sign-in again from the app.' : message(request.error)}</p></div>
  return <Review request={request.data!} accounts={accounts} picked={picked} onPick={setChosen} />
}

function Review({ request, accounts, picked, onPick }: { request: OAuthRequest; accounts: ConnectedAccount[]; picked: ConnectedAccount; onPick: (id: string) => void }) {
  const name = request.client.name || 'An app'
  const [workspaceId, setWorkspaceId] = useState(''), [scopes, setScopes] = useState<string[]>(request.scopes), [receiving, setReceiving] = useState(false)
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null), [error, setError] = useState<unknown>(null), [done, setDone] = useState<'approved' | 'denied' | null>(null)
  const workspaces = picked.workspaces
  const workspace = workspaces.find(item => item.id === workspaceId) ?? (workspaces.length === 1 ? workspaces[0] : undefined)
  const admin = workspace ? ['owner', 'admin'].includes(workspace.role) : false
  // A member grants read and send only; receiving needs manage, and an owner or admin.
  const allowed = (scope: string) => request.scopes.includes(scope) && (scope !== 'bane:manage' || admin)
  const granted = scopes.filter(allowed)
  useEffect(() => { setWorkspaceId(''); setReceiving(false) }, [picked.id])
  async function answer(kind: 'approve' | 'deny') {
    setBusy(kind); setError(null)
    try {
      const result = kind === 'approve' ? await oauthApi.approve(request.id, picked.id, { workspaceId: workspace!.id, scopes: granted, receiving: receiving && admin && granted.includes('bane:manage') }) : await oauthApi.deny(request.id, picked.id)
      setDone(kind === 'approve' ? 'approved' : 'denied')
      // Back to the app (its registered address, with the code or the refusal). A device polls by itself.
      if ('redirect' in result) { const target = safeRedirect(result.redirect); if (target) window.location.assign(target) }
    } catch (failure) { setError(failure); setBusy(null) }
  }
  if (done) return <div className="oauth-card stack">
    <h1>{done === 'approved' ? `${name} is connected` : 'Access denied'}</h1>
    <p className="muted">{request.flow === 'device' ? (done === 'approved' ? 'Return to your device: it continues by itself.' : 'Nothing was shared. You can close this tab.')
      : done === 'approved' ? 'Returning to the app. You can close this tab once it says it’s connected.' : 'Nothing was shared. Returning to the app.'}</p>
    {request.flow === 'code' && done === 'approved' && request.redirect?.kind === 'loopback' && <Alert tone="info" title="App on another computer?">If the app runs on a server you reached over SSH, this browser can’t open its address and shows an error page. Copy that page’s full address from the address bar and paste it into the app.</Alert>}
  </div>
  const where = request.redirect?.kind === 'loopback' ? 'an app on this computer' : request.redirect?.kind === 'app' ? 'an app on this device' : request.redirect?.host
  return <div className="oauth-card stack">
    <div className="oauth-title"><h1>Allow {name} to use Bane?</h1>{request.profile && <StatusBadge status={request.profile} tone="neutral" />}</div>
    <p className="muted">{request.client.domain ? <>Published by <strong>{request.client.domain}</strong>.</> : <>This app registered itself with Bane under this name; Bane can’t confirm who made it.</>}
      {where ? <> After you answer, Bane returns to {where}{request.redirect?.kind === 'web' ? '' : <> (<code>{request.redirect!.host}</code>)</>}.</> : null}</p>
    {request.device && <Alert tone="warning" title={`Check the code on your device: ${request.device.userCode}`}>Requested {new Date(request.device.requestedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} from <code>{request.device.ip ?? 'an unknown address'}</code>{request.device.country ? ` (${request.device.country})` : ''}. Approve only if you started this yourself, on a device you control.</Alert>}
    <section className="stack oauth-section" aria-labelledby="oauth-account"><h2 id="oauth-account">Account</h2>
      <div className="oauth-rows" role="radiogroup" aria-labelledby="oauth-account">
        {accounts.map(account => <label key={account.id} className="oauth-row oauth-account">
          <span className="oauth-who"><input type="radio" name="oauth-account" checked={picked.id === account.id} onChange={() => onPick(account.id)} />
            <AccountAvatar name={account.name} email={account.email} /><span className="oauth-row__label"><span>{account.name || account.email}</span>{account.email && <PrivateAddress className="muted" value={account.email} />}</span></span>
        </label>)}
        <AddAccount />
      </div>
    </section>
    <section className="stack oauth-section" aria-labelledby="oauth-workspace"><h2 id="oauth-workspace">Workspace</h2>
      {workspaces.length ? <Select aria-labelledby="oauth-workspace" value={workspace?.id ?? ''} placeholder="Choose a workspace" onValueChange={setWorkspaceId}
        options={workspaces.map(item => ({ value: item.id, label: `${item.name} · ${roleLabel[item.role]}` }))} />
        : <Alert tone="info">This account doesn’t belong to a workspace yet. Pick another account, or join a workspace first.</Alert>}
    </section>
    <section className="stack oauth-section" aria-labelledby="oauth-access"><h2 id="oauth-access">Access</h2>
      <div className="oauth-scopes">
        {SCOPES.filter(item => request.scopes.includes(item.scope)).map(item => <div key={item.scope} className="oauth-scope">
          <Checkbox label={item.label} checked={granted.includes(item.scope)} disabled={!allowed(item.scope)} onCheckedChange={on => setScopes(current => on ? [...current, item.scope] : current.filter(value => value !== item.scope))} />
          <span className="muted">{item.scope === 'bane:manage' && workspace && !admin ? 'Owners and admins only' : item.hint}</span>
        </div>)}
        {granted.includes('bane:manage') && <div className="oauth-scope"><Checkbox label="Receiving tools" checked={receiving} disabled={!admin} onCheckedChange={setReceiving} /><span className="muted">Routes, rituals, endpoints and received mail</span></div>}
      </div>
    </section>
    {error ? <Alert tone="danger">{message(error)}</Alert> : null}
    <div className="cluster">
      <Button variant="primary" loading={busy === 'approve'} disabled={!workspace || !granted.length || busy !== null} onClick={() => void answer('approve')}>Allow access</Button>
      <Button loading={busy === 'deny'} disabled={busy !== null} onClick={() => void answer('deny')}>Deny</Button>
    </div>
    <p className="muted oauth-note">You can revoke it at any time in Settings → Connected apps.</p>
  </div>
}

/** Another account: signed in at the account service's chooser, then back to this page. */
function AddAccount() {
  const [busy, setBusy] = useState(false)
  async function add() { setBusy(true); try { window.location.assign(await accountApi.signIn(window.location.href, true)) } catch { setBusy(false) } }
  return <div className="oauth-row"><span className="oauth-row__label"><span>Another account</span><span className="muted">Choose it at Anomaly account</span></span><Button loading={busy} onClick={() => void add()}>Use another account</Button></div>
}
