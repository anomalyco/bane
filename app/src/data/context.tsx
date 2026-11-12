import { createContext, Suspense, useContext, useRef, useState, useMemo, useEffect, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocation } from 'react-router'
import { createMockApi } from './mock'
import { ApiError, type Identity, type BaneApi, type WorkspaceInvitationPreview } from './types'
import { roleLabel, workspaceApi } from './workspaces'
import { createLiveApi, request, selectedWorkspace, selectWorkspace } from './live'
import { regionCatalogKey } from './regions'
import { dashboardLikelyReady, identityOnboardingStage, rememberDashboardReady, useDomainStep, onboardingStage } from './onboarding'
import { Alert, Button, PageHeader, useToast } from '../components/ui'
import { BootLoader } from '../components/BootLoader'
import { chunk } from '../lib/preloadable'
import { canonicalOrigin } from '../lib/public-origin'
import type { QueryDef } from './queries'
import { resourceOf, staleAfterWrite } from './invalidation'
import { useGuardedMutation } from '../lib/single-flight'

type Session = { identity: Identity | null; logout: () => Promise<void>; switchWorkspace: (id: string, path?: string) => Promise<void>; notice: string | null; dismissNotice: () => void }
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
export function ApiProvider({ children, api }: { children: ReactNode; api?: BaneApi }) {
  // The docs are public: they render signed out, and /v1/me only adds the workspace's context.
  const publicRoute = useLocation().pathname === '/docs'
  const [provided] = useState(() => api ?? (import.meta.env.VITE_DEMO_MODE === 'true' ? createMockApi() : null))
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
      let result: Identity
      try { result = await request<Identity>('/v1/me', {signal}) }
      catch (error) {
        // A remembered workspace the user no longer belongs to: fall back to the server's choice.
        if (!(error instanceof ApiError && error.code === 'WORKSPACE_ACCESS_DENIED' && selectedWorkspace())) throw error
        selectWorkspace(null)
        result = await request<Identity>('/v1/me', {signal})
      }
      selectWorkspace(result.multiTenant ? result.workspaceId : null)
      console.info('[Bane timing] Google session ready', { durationMs: Number((performance.now() - started).toFixed(1)) })
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
  useEffect(() => { const denied = () => { if (window.location.pathname !== '/docs' && cache.getQueryData(['identity']) === undefined) return; cache.clear(); void identity.refetch() }; window.addEventListener('bane:unauthorized', denied); return () => window.removeEventListener('bane:unauthorized', denied) }, [cache])
  async function logout() { setAuthError(null); try { await request('/api/auth/sign-out', {method: 'POST', body: {}}); rememberDashboardReady(selectedWorkspace(), false); selectWorkspace(null); cache.clear(); await identity.refetch() } catch (error) { setAuthError(error) } }
  // Every sign-in request replaces the browser's single OAuth state cookie, so it starts on pointer down
  // (the click that follows is milliseconds away) rather than on hover or focus. The pending request is
  // used by that click only; a pointer down that never becomes a click is dropped after a few seconds.
  const signIn = useRef<{ at: number; url: Promise<string> } | null>(null)
  function googleUrl() {
    // Assign path components rather than resolving an untrusted redirect parameter.
    const callback = new URL(window.location.origin)
    callback.pathname = window.location.pathname
    callback.search = window.location.search
    callback.hash = window.location.hash
    callback.searchParams.delete('auth')
    const errorCallback = new URL(callback)
    errorCallback.searchParams.set('auth', 'error')
    // A new account goes straight to onboarding (its first step is known), unless it is joining by invitation link.
    const onboarding = callback.pathname === '/' && !callback.searchParams.has('invitation') ? new URL('/onboarding', window.location.origin) : null
    return request<{url: string}>('/api/auth/sign-in/social', {method: 'POST', body: {provider: 'google', callbackURL: callback.href, errorCallbackURL: errorCallback.href, ...(onboarding ? {newUserCallbackURL: onboarding.href} : {})}}).then(result => {
      const url = new URL(result.url)
      if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com') throw new Error('Invalid Google sign-in redirect.')
      return url.href
    })
  }
  function prepareLogin(event: { button: number }) {
    if (busy || event.button !== 0) return
    const url = googleUrl()
    signIn.current = {at: Date.now(), url}
    url.catch(() => { if (signIn.current?.url === url) signIn.current = null })
  }
  async function login() {
    setBusy(true); setAuthError(null)
    const pending = signIn.current
    signIn.current = null
    try { window.location.assign(await (pending && Date.now() - pending.at < 5000 ? pending.url : googleUrl())) }
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
  // not_approved: a verified Google account outside the invite list. The API has already saved it as an access request.
  const authNotice = authError ? <Alert tone="danger">{String(authError)}</Alert>
    : authResult === 'not_approved' ? <Alert tone="info" title="Bane is invite-only right now">{home.data ? 'We saved your Google address as a request for access. If someone invited you, open their invitation link and sign in again.' : 'This Google account isn’t approved for this installation. Ask an administrator to add it.'}</Alert>
    : authResult === 'error' ? <Alert tone="danger">Google sign-in didn’t finish. It may have been cancelled; try again.</Alert>
    : notice ? <Alert tone="danger">{notice}</Alert>
    : invitation && <Alert tone="info" title="You have a workspace invitation">Sign in with the invited Google account to review it. You join only after you confirm.</Alert>
  // M9: an account whose only way in is the invitation signs in with no workspace, so /v1/me is 401 while
  // the invitation itself is readable. It gets the same review; nothing joins until the recipient clicks Join.
  const invitee = signedOut && invitation !== null && review.data?.status === 'pending'
  const reviewing = !publicRoute && client.mode !== 'demo' && invitation !== null && ((identity.data && !identity.isError) || invitee || (signedOut && review.isFetching))
  return <ApiContext.Provider key={generation} value={client}><SessionContext.Provider value={{identity: identity.data ?? null, logout, switchWorkspace, notice, dismissNotice: () => setNotice(null)}}>
    {reviewing ? review.data?.status === 'pending' ? <InvitationReview invitation={review.data} email={identity.data?.email ?? null} firstWorkspace={invitee} joining={join.isPending} error={join.error} onJoin={() => join.mutate(review.data!)} onCancel={invitee ? () => { clearInvitation(); void logout() } : clearInvitation} /> : <BootLoader />
    : publicRoute || client.mode === 'demo' || (identity.data && !identity.isError) ? <>{authError && <Alert tone="danger">{String(authError)}</Alert>}{children}</> : identity.isPending || home.isLoading ? <BootLoader /> : signedOut && home.data ? <Suspense fallback={null}><HomePage onSignIn={login} onSignInIntent={prepareLogin} busy={busy} notice={authNotice} /></Suspense> : <main className="page-surface"><PageHeader title="Bane" /><div className="stack" style={{maxWidth: 520}}>
      {signedOut ? <>
        <h2>Sign in with Google</h2>
        {authNotice}
        <Button variant="primary" loading={busy} onClick={login} onPointerDown={prepareLogin}>Continue with Google</Button>
      </> : <>
        <h2>Couldn’t check your session</h2>
        <Alert tone="warning">{unconfigured ? 'Google sign-in is not configured on this installation.' : 'Bane couldn’t verify your session. Try again without signing in.'}</Alert>
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
