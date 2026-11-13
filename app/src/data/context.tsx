import { createContext, Suspense, useContext, useRef, useState, useMemo, useEffect, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation } from 'react-router'
import { createMockApi } from './mock'
import { ApiError, type Identity, type BaneApi, type WorkspaceInvitationPreview } from './types'
import { roleLabel, workspaceApi } from './workspaces'
import { createLiveApi, request, selectAccount, selectedAccount, selectedWorkspace, selectWorkspace } from './live'
import { accountApi, accountsKey, announce, expectAccount, onAccountEvent, POPUP_PATH, takeExpectedAccount, type AccountList } from './accounts'
import { regionCatalogKey } from './regions'
import { dashboardLikelyReady, identityOnboardingStage, rememberDashboardReady, useDomainStep, onboardingStage } from './onboarding'
import { Alert, Button, PageHeader, useToast } from '../components/ui'
import { BootLoader } from '../components/BootLoader'
import { chunk } from '../lib/preloadable'
import { canonicalOrigin } from '../lib/public-origin'
import type { QueryDef } from './queries'
import { resourceOf, staleAfterWrite } from './invalidation'
import { useGuardedMutation } from '../lib/single-flight'
import { SignInConsent } from '../components/LegalLinks'

// The tab's account and workspace. logout signs out of this tab's account only; another connected account takes its place.
type Session = { identity: Identity | null; logout: () => Promise<void>; switchWorkspace: (id: string, path?: string) => Promise<void>
  switchAccount: (id: string, path?: string, workspace?: string) => Promise<void>; addAccount: (path?: string) => void; signOutAccount: (id?: string) => Promise<void>; signOutAll: () => Promise<void>
  notice: string | null; dismissNotice: () => void }
const homeChunk = chunk(() => import('../features/home'))
export const loadHome = homeChunk.preload
const HomePage = homeChunk.page(m => m.HomePage)
const ApiContext = createContext<BaneApi | null>(null)
const SessionContext = createContext<Session | null>(null)
export const useSession = () => useContext(SessionContext)
// Self-hosted installations have no workspace roles; every signed-in operator administers.
export function useWorkspaceAccess() {
  const identity = useContext(SessionContext)?.identity
  const multiTenant = identity?.multiTenant === true
  const role = multiTenant ? identity?.role ?? null : null
  return { multiTenant, role, canAdminister: !multiTenant || role === 'owner' || role === 'admin' }
}
// What the current workspace still needs before the dashboard opens; null when it can open.
export function useOnboardingStage() {
  const identity = useContext(SessionContext)?.identity
  return onboardingStage(identity, useDomainStep(identity?.workspaceId))
}
// What a finished sign-in (?auth=) means. account_limit only follows Add account.
const authMessages: Record<string, string> = {
  google_required: 'Bane requires Google sign-in. Try again and choose Google at Anomaly account.',
  method_required: 'Sign in again using the authentication method required by this installation.',
  interaction_required: 'Your identity provider needs you to complete sign-in. Try again and follow its prompts.',
  account_limit: 'This browser already has the most accounts Bane connects at once. Sign out of one to add another.',
  error: 'Sign-in didn’t finish. Check that you used your invited or approved account.',
}
// The section of the current page, without a record from the previous account or workspace in it.
export function sectionPath(pathname = window.location.pathname) {
  const [section, child] = pathname.split('/').filter(Boolean)
  return (section === 'audience' && ['lists', 'segments'].includes(child)) || (section === 'campaigns' && child === 'templates') ? `/${section}/${child}` : section ? `/${section}` : '/'
}
// /v1/me as the tab's account. A remembered workspace the account no longer belongs to falls back to the server's
// choice; an account this browser signed out of (in another tab, or its session expired or was revoked) falls back to
// the browser's default account.
async function loadIdentity(signal?: AbortSignal) {
  let result: Identity
  try { result = await request<Identity>('/v1/me', {signal}) }
  catch (error) {
    if (error instanceof ApiError && error.code === 'ACCOUNT_SIGNED_OUT' && selectedAccount()) selectAccount(null)
    else if (error instanceof ApiError && error.code === 'WORKSPACE_ACCESS_DENIED' && selectedWorkspace()) selectWorkspace(null)
    else throw error
    try { result = await request<Identity>('/v1/me', {signal}) }
    catch (retry) {
      if (!(retry instanceof ApiError && retry.code === 'WORKSPACE_ACCESS_DENIED' && selectedWorkspace())) throw retry
      selectWorkspace(null)
      result = await request<Identity>('/v1/me', {signal})
    }
  }
  selectAccount(result.id)
  selectWorkspace(result.multiTenant ? result.workspaceId : null)
  return result
}
function invitationError(error: unknown) {
  if (error instanceof ApiError && error.status === 404) return 'This invitation is invalid, expired or for a different email address. Ask for a new invitation.'
  return `Couldn’t open the invitation. ${error instanceof Error ? error.message : 'Try the link again.'}`
}
const expiry = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
// Shown before anything changes. The slug tells apart workspaces that share a name. An account whose
// only way in is this invitation has no workspace yet (M9): cancelling signs it out instead.
function InvitationReview({ invitation, email, firstWorkspace, joining, error, onJoin, onCancel }: { invitation: WorkspaceInvitationPreview; email: string | null; firstWorkspace: boolean; joining: boolean; error: unknown; onJoin: () => void; onCancel: () => void }) {
  return <main className="page-surface"><PageHeader title="Bane" /><div className="stack" style={{maxWidth: 520}}>
    <h2>Join {invitation.workspaceName}?</h2>
    <p>You were invited{email ? <> as <bdi>{email}</bdi></> : null}. {firstWorkspace ? 'Your account has no workspace yet. Nothing changes until you join; cancelling signs you out.' : 'Nothing changes until you join; you stay in your current workspace if you cancel.'}</p>
    <dl className="invitation-facts">
      <dt>Workspace</dt><dd><bdi>{invitation.workspaceName}</bdi> <code>{invitation.workspaceSlug}</code></dd>
      <dt>Invited by</dt><dd><bdi>{invitation.inviterName}</bdi> <code>{invitation.inviterEmail}</code></dd>
      <dt>Role</dt><dd>{roleLabel[invitation.role]}</dd>
      <dt>Expires</dt><dd>{expiry.format(new Date(invitation.expiresAt))}</dd>
    </dl>
    {error ? <Alert tone="danger">{invitationError(error)}</Alert> : null}
    <div className="cluster"><Button variant="primary" loading={joining} onClick={onJoin}>Join workspace</Button><Button disabled={joining} onClick={onCancel}>{firstWorkspace ? 'Cancel and sign out' : 'Cancel'}</Button></div>
  </div></main>
}
/** Pages anyone can open, signed in or not. */
export const isPublicPath = (path: string) => path === '/docs' || path === '/legal' || path.startsWith('/legal/')
export function ApiProvider({ children, api }: { children: ReactNode; api?: BaneApi }) {
  // The docs and the legal pages are public: they render signed out, and /v1/me only adds the workspace's context.
  const publicRoute = isPublicPath(useLocation().pathname)
  const [provided] = useState(() => api ?? (import.meta.env.VITE_DEMO_MODE === 'true' ? createMockApi() : null))
  // A sign-in (or a return from a provider) this tab started names the account the page opens as; the tab then stays
  // with it. The server names only an account this browser has a session for; a link alone never moves the tab.
  useState(() => {
    const url = new URL(window.location.href), account = url.searchParams.get('account')
    if (account === null) return
    if (takeExpectedAccount() && /^[A-Za-z0-9._:-]{1,200}$/.test(account)) selectAccount(account)
    url.searchParams.delete('account')
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
  })
  // Bumped on workspace switches so clients, cursors and every mounted screen start fresh.
  const [generation, setGeneration] = useState(0)
  const client = useMemo(() => provided ?? createLiveApi(), [provided, generation])
  const cache = useQueryClient()
  const toast = useToast()
  const [authError, setAuthError] = useState<unknown>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [invitation, setInvitation] = useState(() => client.mode === 'demo' || publicRoute ? null : new URLSearchParams(window.location.search).get('invitation'))
  function clearInvitation() {
    const url = new URL(window.location.href)
    url.searchParams.delete('invitation')
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
    setInvitation(null)
  }
  // An invitation link only opens a review. Joining, and switching to the workspace, wait for the
  // recipient's own click: a link alone must never move someone into another workspace.
  const review = useQuery({
    queryKey: ['invitation', invitation], enabled: Boolean(invitation), retry: false, staleTime: Infinity, gcTime: Infinity,
    queryFn: async ({ signal }) => {
      try { return await workspaceApi.reviewInvitation(invitation!, signal) }
      catch (error) {
        // Signed out: keep the link so sign-in returns here to review it.
        if (error instanceof ApiError && error.status === 401) return null
        throw error
      }
    },
  })
  const join = useGuardedMutation({
    mutationFn: async (pending: WorkspaceInvitationPreview) => {
      const { workspaceId } = await workspaceApi.acceptInvitation(pending.id)
      await switchWorkspace(workspaceId)
      clearInvitation()
      toast(`Joined ${pending.workspaceName}`, 'success')
    },
  })
  const identity = useQuery({
    queryKey: ['identity'], enabled: client.mode !== 'demo',
    networkMode: 'always', refetchOnReconnect: true,
    retry: (failures, error) => failures < 1 && error instanceof ApiError && error.code !== 'AUTH_NOT_CONFIGURED' && (error.code === 'NETWORK_UNAVAILABLE' || (error.status ?? 0) >= 500),
    queryFn: async ({signal}) => {
      const started = performance.now()
      const result = await loadIdentity(signal)
      console.info('[Bane timing] Dashboard session ready', { durationMs: Number((performance.now() - started).toFixed(1)) })
      return result
    },
  })
  useEffect(() => {
    if (!invitation) return
    if (review.error) { setNotice(invitationError(review.error)); clearInvitation() }
    // Already a member (an account whose only way in was this invitation joins at sign-in): nothing to confirm or switch.
    else if (review.data?.status === 'accepted') clearInvitation()
    else if (review.data === null && identity.data) { setNotice('Couldn’t open the invitation. Follow the link again.'); clearInvitation() }
  }, [invitation, review.error, review.data, identity.data])
  async function switchWorkspace(id: string, path?: string) {
    const previous = selectedWorkspace()
    // A first-time invitee has no identity yet, so a remembered ID equal to the joined workspace still loads it.
    if (id === previous && cache.getQueryData(['identity'])) return
    await cache.cancelQueries()
    selectWorkspace(id)
    let next: Identity
    try { next = await request<Identity>('/v1/me') }
    catch (error) { selectWorkspace(previous); throw error }
    // Nothing from the previous workspace may remain visible or cached.
    cache.clear()
    cache.setQueryData(['identity'], next)
    if (path) window.history.pushState(null, '', path)
    setGeneration(value => value + 1)
  }
  // Act as another connected account in this tab, at once: no round trip to the account service, one /v1/me to Bane.
  // Nothing from the previous account stays cached or mounted (the generation remounts every screen and dialog), and
  // responses to its requests still in flight are dropped (live.ts). null: the browser's default account.
  async function enter(account: string | null, options: { path?: string; workspace?: string } = {}) {
    const previous = { account: selectedAccount(), workspace: selectedWorkspace() }
    await cache.cancelQueries()
    selectAccount(account)
    if (options.workspace) selectWorkspace(options.workspace)
    let next: Identity
    try { next = await loadIdentity() }
    catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) { selectAccount(previous.account); selectWorkspace(previous.workspace); throw error }
      // No account is left in this browser: the signed-out page.
      selectAccount(null); cache.clear(); setGeneration(value => value + 1); await identity.refetch(); return
    }
    const accounts = cache.getQueryData<AccountList>(accountsKey)
    cache.clear()
    if (accounts) cache.setQueryData<AccountList>(accountsKey, { ...accounts, active: next.id })
    cache.setQueryData(['identity'], next)
    if (options.path) window.history.pushState(null, '', options.path)
    setGeneration(value => value + 1)
  }
  async function switchAccount(id: string, path?: string, workspace?: string) {
    if (id === selectedAccount() && cache.getQueryData(['identity'])) { if (workspace) await switchWorkspace(workspace, path); return }
    await enter(id, { path, workspace })
    // New tabs and links opened outside the dashboard follow the latest choice.
    void accountApi.makeDefault(id).catch(() => {})
  }
  async function signOutAccount(id = selectedAccount() ?? undefined) {
    const result = await accountApi.signOut(id ? { account: id } : {})
    if (id) announce({ type: 'signed-out', accounts: [id] })
    if (id && id !== selectedAccount()) { void cache.invalidateQueries({ queryKey: accountsKey }); return }
    rememberDashboardReady(selectedWorkspace(), false)
    if (result.active) { await enter(result.active, { path: '/' }); toast('Signed out of that account', 'success'); return }
    selectAccount(null); selectWorkspace(null); cache.clear(); await identity.refetch()
  }
  async function signOutAll() {
    await accountApi.signOut({ all: true })
    announce({ type: 'signed-out', accounts: 'all' })
    rememberDashboardReady(selectedWorkspace(), false)
    selectAccount(null); selectWorkspace(null); cache.clear(); await identity.refetch()
  }
  // Add account: the account service's chooser in a popup. The popup starts the sign-in itself and is opened with
  // noopener, so it holds no reference to this page; it reports back over the BroadcastChannel only. The account picked
  // there opens in this tab; Bane never learns which other accounts are signed in at the account service.
  const adding = useRef<{ tab: string; path?: string; fallback: number } | null>(null)
  function addAccount(path?: string) {
    if (adding.current) window.clearTimeout(adding.current.fallback)
    const tab = crypto.randomUUID(), start = new URL(POPUP_PATH, window.location.origin)
    start.searchParams.set('start', '1'); start.searchParams.set('tab', tab)
    window.open(start.href, '_blank', 'popup,noopener,noreferrer,width=480,height=720')
    // noopener leaves no handle to tell a blocked popup apart: one that hasn't announced itself within a few seconds
    // didn't open, so the add continues in this tab as a redirect.
    const fallback = window.setTimeout(() => { if (adding.current?.tab === tab) { adding.current = null; void redirectAdd() } }, 4000)
    adding.current = { tab, path, fallback }
  }
  async function redirectAdd() {
    const callback = new URL(window.location.pathname, window.location.origin)
    callback.search = window.location.search; callback.searchParams.delete('auth')
    try { const url = await accountApi.signIn(callback.href, true); expectAccount(); window.location.assign(url) }
    catch (error) { toast(error instanceof ApiError && error.code === 'ACCOUNT_LIMIT' ? authMessages.account_limit : error instanceof Error ? error.message : 'Couldn’t add an account.', 'error') }
  }
  useEffect(() => onAccountEvent(event => {
    if (event.type === 'add-started') { if (event.tab && event.tab === adding.current?.tab) window.clearTimeout(adding.current.fallback); return }
    if (event.type === 'signed-in') {
      void cache.invalidateQueries({ queryKey: accountsKey })
      const pending = adding.current
      if (!event.tab || event.tab !== pending?.tab) return
      window.clearTimeout(pending.fallback)
      adding.current = null
      if (event.auth || !event.account) { toast(authMessages[event.auth ?? 'error'] ?? authMessages.error, 'error'); return }
      void switchAccount(event.account, pending.path ?? sectionPath()).then(() => toast('Account added', 'success'), () => toast('Couldn’t open the account.', 'error'))
      return
    }
    // Another tab signed this tab's account out: leave it now rather than at its next request.
    const mine = selectedAccount()
    if (event.accounts === 'all' || (mine && event.accounts.includes(mine))) void enter(null, { path: sectionPath() }).catch(() => {})
    else void cache.invalidateQueries({ queryKey: accountsKey })
  }))
  // A request answered that this tab's account is signed out in this browser (expired or revoked): move to another.
  // Several requests can learn it at once: leave once.
  const leaving = useRef(false)
  useEffect(() => {
    const gone = () => {
      if (leaving.current) return
      leaving.current = true
      void enter(null, { path: sectionPath() }).then(() => toast('That account was signed out', 'info'), () => {}).finally(() => { leaving.current = false })
    }
    window.addEventListener('bane:account-signed-out', gone)
    return () => window.removeEventListener('bane:account-signed-out', gone)
  })
  // Load the region catalog alongside /v1/me rather than after it; the shell reuses this cache entry.
  // An invitation link selects its workspace first, so wait until it is accepted. Workspaces that may
  // still need onboarding wait for /v1/me, so onboarding never starts dashboard requests.
  useEffect(() => {
    // A remembered workspace means a hosted installation, which never reads it.
    if (client.mode === 'demo' || publicRoute || invitation || selectedWorkspace() || window.location.pathname === '/onboarding' || !dashboardLikelyReady(selectedWorkspace())) return
    void cache.prefetchQuery({ queryKey: regionCatalogKey(client), queryFn: ({ signal }) => client.regions.list(signal), staleTime: 30_000 })
  }, [cache, client, publicRoute, invitation])
  useEffect(() => {
    if (!identity.data || client.mode === 'demo' || identityOnboardingStage(identity.data)) return
    const match = window.location.pathname.match(/^\/campaigns\/([^/]+)\/(?:edit|review)$/)
    if (!match) return
    let id: string
    try { id = decodeURIComponent(match[1]) } catch { return }
    void cache.prefetchQuery({ queryKey: ['bane', client.mode, 'campaign', id], queryFn: ({ signal }) => client.campaigns.get(id, signal), staleTime: 30_000 })
  }, [cache, client, identity.data])
  // Before a session is known, a 401 from the boot prefetch is answered by /v1/me itself.
  useEffect(() => { const denied = () => { if (!isPublicPath(window.location.pathname) && cache.getQueryData(['identity']) === undefined) return; cache.clear(); void identity.refetch() }; window.addEventListener('bane:unauthorized', denied); return () => window.removeEventListener('bane:unauthorized', denied) }, [cache])
  async function logout() { setAuthError(null); try { await signOutAccount() } catch (error) { setAuthError(error) } }
  // Every sign-in request replaces the browser's single OAuth state cookie, so it starts on pointer down
  // (the click that follows is milliseconds away) rather than on hover or focus. The pending request is
  // used by that click only; a pointer down that never becomes a click is dropped after a few seconds.
  const signIn = useRef<{ at: number; url: Promise<string> } | null>(null)
  function accountUrl() {
    // Assign path components rather than resolving an untrusted redirect parameter.
    const callback = new URL(window.location.origin)
    callback.pathname = window.location.pathname
    callback.search = window.location.search
    callback.hash = window.location.hash
    callback.searchParams.delete('auth')
    return request<{url: string}>('/api/auth/sign-in/account', {method: 'POST', body: {callbackURL: callback.href}}).then(result => {
      const url = new URL(result.url)
      if (url.protocol !== 'https:') throw new Error('Invalid sign-in redirect.')
      return url.href
    })
  }
  function prepareLogin(event: { button: number }) {
    if (busy || event.button !== 0) return
    const url = accountUrl()
    signIn.current = {at: Date.now(), url}
    url.catch(() => { if (signIn.current?.url === url) signIn.current = null })
  }
  async function login() {
    setBusy(true); setAuthError(null)
    const pending = signIn.current
    signIn.current = null
    try { const url = await (pending && Date.now() - pending.at < 5000 ? pending.url : accountUrl()); expectAccount(); window.location.assign(url) }
    catch (error) { setAuthError(error); setBusy(false) }
  }
  const signedOut = identity.error instanceof ApiError && identity.error.status === 401 && identity.error.code === 'AUTH_REQUIRED'
  const unconfigured = identity.error instanceof ApiError && identity.error.code === 'AUTH_NOT_CONFIGURED'
  // Multi-tenant installations greet signed-out visitors at "/" with the public homepage; /health says which this is.
  // Start alongside /v1/me when no ready dashboard session is remembered so signed-out visitors avoid a second round trip.
  const checkHome = client.mode !== 'demo' && window.location.pathname === '/' && (signedOut || (!invitation && !dashboardLikelyReady(selectedWorkspace())))
  const home = useQuery({ queryKey: ['public-home'], enabled: checkHome, staleTime: Infinity, retry: false, queryFn: async ({signal}) => {
    const multiTenant = (await request<{multiTenant?: boolean} | null>('/health', {signal}))?.multiTenant === true
    if (multiTenant) await loadHome()
    return multiTenant
  } })
  const authResult = new URLSearchParams(window.location.search).get('auth')
  // not_approved: a verified OIDC account outside the invite list. The API has already saved it as an access request.
  const authNotice = authError ? <Alert tone="danger">{String(authError)}</Alert>
    : authResult === 'not_approved' ? <Alert tone="info" title="Bane is invite-only right now">{home.data ? 'We saved your OIDC address as a request for access. If someone invited you, open their invitation link and sign in again.' : 'This OIDC account isn’t approved for this installation. Ask an administrator to add it.'}</Alert>
    : authResult && authMessages[authResult] ? <Alert tone={authResult === 'interaction_required' ? 'info' : 'danger'}>{authMessages[authResult]}</Alert>
    : notice ? <Alert tone="danger">{notice}</Alert>
    : invitation && <Alert tone="info" title="You have a workspace invitation">Sign in with the invited account to review it. You join only after you confirm.</Alert>
  // M9: an account whose only way in is the invitation signs in with no workspace, so /v1/me is 401 while
  // the invitation itself is readable. It gets the same review; nothing joins until the recipient clicks Join.
  const invitee = signedOut && invitation !== null && review.data?.status === 'pending'
  const reviewing = !publicRoute && client.mode !== 'demo' && invitation !== null && ((identity.data && !identity.isError) || invitee || (signedOut && review.isFetching))
  return <ApiContext.Provider key={generation} value={client}><SessionContext.Provider value={{identity: identity.data ?? null, logout, switchWorkspace, switchAccount, addAccount, signOutAccount, signOutAll, notice, dismissNotice: () => setNotice(null)}}>
    {reviewing ? review.data?.status === 'pending' ? <InvitationReview invitation={review.data} email={identity.data?.email ?? null} firstWorkspace={invitee} joining={join.isPending} error={join.error} onJoin={() => join.mutate(review.data!)} onCancel={invitee ? () => { clearInvitation(); void logout() } : clearInvitation} /> : <BootLoader />
    : publicRoute || client.mode === 'demo' || (identity.data && !identity.isError) ? <>{authError && <Alert tone="danger">{String(authError)}</Alert>}{children}</> : identity.isPending || home.isLoading ? <BootLoader /> : signedOut && home.data ? <Suspense fallback={null}><HomePage onSignIn={login} onSignInIntent={prepareLogin} busy={busy} notice={authNotice} /></Suspense> : <main className="page-surface"><PageHeader title="Bane" /><div className="stack" style={{maxWidth: 520}}>
      {signedOut ? <>
        <h2>Sign in to Bane</h2>
        {authNotice}
        <Button variant="primary" loading={busy} onClick={login} onPointerDown={prepareLogin}>Continue to sign in</Button>
        <SignInConsent className="muted" />
      </> : <>
        <h2>Couldn’t check your session</h2>
        <Alert tone="warning">{unconfigured ? 'Sign-in is not configured on this installation.' : 'Bane couldn’t verify your session. Try again without signing in.'}</Alert>
      </>}
      <Button loading={identity.isFetching} onClick={() => void identity.refetch()}>Check session again</Button>
    </div></main>}
  </SessionContext.Provider></ApiContext.Provider>
}
// The installation's canonical address (lib/public-origin.ts), for examples and connection URLs: PUBLIC_URL from
// /v1/me when signed in, else from /health, never the page's own Host. null until known; foreign when the page is
// open at another address.
export function useCanonicalOrigin() {
  const demo = useContext(ApiContext)?.mode === 'demo'
  const identity = useContext(SessionContext)?.identity?.origin ?? null
  const instance = useQuery({ queryKey: ['instance-origin'], enabled: !demo && !identity, staleTime: Infinity, gcTime: Infinity, retry: 2,
    queryFn: async ({ signal }) => {
      const response = await fetch('/health', { signal, headers: { Accept: 'application/json' } })
      if (!response.ok) throw new Error('Couldn’t load this installation’s address.')
      return ((await response.json()) as { origin?: string }).origin ?? null
    } })
  return { ...canonicalOrigin({ identity, instance: instance.data, demo, page: window.location.origin }), error: identity ? null : instance.error, retry: () => void instance.refetch() }
}
export function usePublicOrigin(): string | null { return useCanonicalOrigin().origin }
export function useApi() {
  const api = useContext(ApiContext)
  if (!api) throw new Error('ApiProvider is required')
  return api
}
// Polling is opt-in and foreground-only; pass a function to poll only while the data is in progress.
// keepPrevious keeps the last result on screen while a changed key (page, search, filter) loads, so a list never blanks.
// Pass a function to keep it only for some key changes (a region change must not show the old region's rows).
type KeepPrevious = boolean | ((previousKey: readonly unknown[]) => boolean)
type Poll<T> = { interval?: number | ((data: T | undefined) => number | false); enabled?: boolean; keepPrevious?: KeepPrevious }
export function useApiQuery<T>(key: readonly unknown[], read: (api: BaneApi, signal: AbortSignal) => Promise<T>, poll?: Poll<T>) {
  const api = useApi()
  const interval = poll?.interval
  const keep = poll?.keepPrevious
  return useQuery({ queryKey: ['bane', api.mode, ...key], queryFn: ({ signal }) => read(api, signal), enabled: poll?.enabled, refetchInterval: typeof interval === 'function' ? query => interval(query.state.data) : interval ?? false, refetchIntervalInBackground: false,
    placeholderData: keep ? (previous, previousQuery) => keep === true || (previousQuery && keep(previousQuery.queryKey.slice(2))) ? previous : undefined : undefined })
}
export function useApiDef<T>(query: QueryDef<T>, poll?: Poll<T>) { return useApiQuery(query.key, query.read, poll) }
/** `target`: what the write acts on when its function closes over it rather than taking it as input (a thread, a
 *  domain, a campaign). It keys the in-flight guard with the operation and input (lib/single-flight.ts). */
export function useApiMutation<TInput, TResult>(write: (api: BaneApi, input: TInput) => Promise<TResult>, successMessage?: string, refreshSes = false, invalidate = true, target?: unknown) {
  const api = useApi()
  const client = useQueryClient()
  const toast = useToast()
  // One write while it is in flight: a repeat of the same operation on the same target with the same input is dropped
  // (lib/single-flight.ts). The operation is the write's source, the same in every render.
  return useGuardedMutation({
    operation: write.toString(), target,
    gcTime: 0,
    mutationFn: (input: TInput) => write(api, input),
    onSuccess: () => {
      if (successMessage) toast(successMessage, 'success')
      if (!invalidate) return
      void client.invalidateQueries({predicate: query => staleAfterWrite(query.queryKey, refreshSes)}).catch(() => {})
      if (!refreshSes) void client.invalidateQueries({predicate: query => query.queryKey[0] === 'bane' && resourceOf(query.queryKey) === 'campaign-options', refetchType: 'none'}).catch(() => {})
    },
  })
}

const RegionContext = createContext<{ regionId: string; setRegionId: (id: string) => void } | null>(null)
export function RegionProvider({ children }: { children: ReactNode }) {
  const [regionId, setRegion] = useState(() => {
    const linked = new URLSearchParams(window.location.search).get('region')
    if (linked && /^[a-z0-9-]{1,40}$/.test(linked)) return linked
    try { return localStorage.getItem('bane.region') || '' } catch { return '' }
  })
  function setRegionId(id: string) {
    setRegion(id)
    try { localStorage.setItem('bane.region', id) } catch { /* Selection can remain session-only. */ }
  }
  return <RegionContext.Provider value={{ regionId, setRegionId }}>{children}</RegionContext.Provider>
}
// Hosted workspaces send from a region the platform picks per sender, so they view every region at once:
// an empty region omits the filter from every request.
const allRegions = { regionId: '', setRegionId: () => {} }
export function useRegion() {
  const region = useContext(RegionContext)
  const multiTenant = useContext(SessionContext)?.identity?.multiTenant === true
  if (!region) throw new Error('RegionProvider is required')
  return multiTenant ? allRegions : region
}
