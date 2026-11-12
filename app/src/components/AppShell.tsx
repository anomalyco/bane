import { Suspense, useEffect, useLayoutEffect, useRef } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate, useNavigationType } from 'react-router'
import { Lock } from 'lucide-react'
import { useApi, useRegion, useSession, useWorkspaceAccess } from '../data/context'
import { sidebarPaths, usePrefetchQueries, usePrefetchRoute, useRouteIntent } from '../data/prefetch'
import { useRegionCatalog, useRegionDiscovery } from '../data/regions'
import { label, number, percent } from '../lib/format'
import { chunk, ChunkFallback } from '../lib/preloadable'
import { queries } from '../data/queries'
import { Alert, Button, EmptyState, ErrorState, Select, Skeleton, SkeletonText } from './ui'
import { RouteSkeleton } from './RouteSkeleton'
import { ThemeToggle } from './ThemeToggle'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'

// The sender score card (hosted): its code and data load with the shell, into a slot that already has its final size.
const score = chunk(() => import('../features/score'))
const SidebarScore = score.page(module => module.SidebarScore)

// Members can't manage sending infrastructure; the API enforces this too.
const adminOnly = new Set(['/api-keys', '/domains'])
const navigation = [['/', 'Overview'], ['/logs', 'Logs'], ['/receiving', 'Receiving'], ['/campaigns', 'Campaigns'], ['/audience', 'Audience'], ['/domains', 'Domains'], ['/api-keys', 'API keys'], ['/docs', 'Docs'], ['/settings', 'Settings']] as const
export function AppShell() {
  const api = useApi()
  const { regionId, setRegionId } = useRegion()
  const session = useSession()
  const access = useWorkspaceAccess()
  const location = useLocation()
  // Hosted workspaces view every region at once, so no page waits on a selected region.
  const needsRegion = !access.multiTenant && (location.pathname === '/' || ['/logs', '/domains'].some(path => location.pathname.startsWith(path)))
  // Hosted workspaces view every region at once and never read the SES region catalog.
  const regions = useRegionCatalog({ enabled: !access.multiTenant })
  const enabled = regions.data?.data.filter(region => region.enabled) ?? []
  const current = regions.data?.data.find(region => region.region === regionId && region.enabled)
  // Hosted workspaces reach the shell only once onboarding is done (see App). Their regions are
  // managed by the sending connection, so SES discovery and its sidebar status don't apply.
  const discovery = useRegionDiscovery(access.multiTenant ? undefined : current)
  const quota = discovery.data?.account?.quota
  const provisioning = current?.provisionStatus === 'pending' || current?.provisionStatus === 'running'
  const needsProvisioning = Boolean(current && !provisioning && (current.discoveryStatus === 'needs_provisioning' || (discovery.data && !discovery.data.provisioned)))
  const navigate = useNavigate()
  const prefetchRoute = usePrefetchRoute()
  const intent = useRouteIntent()
  const prefetchQueries = usePrefetchQueries()
  const latest = useRef({ prefetchRoute, pathname: location.pathname, canAdminister: access.canAdminister })
  latest.current = { prefetchRoute, pathname: location.pathname, canAdminister: access.canAdminister }
  const regionReady = access.multiTenant || Boolean(current)
  // The page in front of the user: its first-screen requests start with its code, not after it, on a cold load too.
  useEffect(() => {
    const path = latest.current.pathname
    if (api.mode === 'live' && regionReady && (sidebarPaths as readonly string[]).includes(path)) void latest.current.prefetchRoute(path)
    if (api.mode === 'live' && access.multiTenant) { void score.preload().catch(() => {}); void prefetchQueries([queries.senderScore()]) }
  }, [api.mode, regionReady])
  // Once the page in front of the user has settled, warm every other sidebar page one at a time (its code and
  // first-screen queries, one request set per page, nothing already fresh). Hovering a link does the same at once.
  const warming = useRef(false)
  const content = useRef<HTMLElement>(null)
  useEffect(() => {
    const saveData = (navigator as { connection?: { saveData?: boolean } }).connection?.saveData
    if (warming.current || api.mode !== 'live' || !regionReady || saveData) return
    warming.current = true
    let stopped = false
    let release: (() => void) | undefined
    // A hidden tab waits for the user to come back instead of fetching in the background.
    const visible = () => !document.hidden ? Promise.resolve() : new Promise<void>(resolve => {
      const done = () => { document.removeEventListener('visibilitychange', onChange); release = undefined; resolve() }
      const onChange = () => { if (!document.hidden) done() }
      release = done
      document.addEventListener('visibilitychange', onChange)
    })
    const idle = () => new Promise<void>(resolve => typeof requestIdleCallback === 'function' ? requestIdleCallback(() => resolve(), { timeout: 3000 }) : void setTimeout(resolve, 300))
    void (async () => {
      await new Promise(resolve => setTimeout(resolve, 600))
      for (const path of sidebarPaths) {
        await visible()
        await idle()
        const { pathname, canAdminister, prefetchRoute } = latest.current
        if (stopped) return
        if ((path === '/' ? pathname === '/' : pathname.startsWith(path)) || (!canAdminister && adminOnly.has(path))) continue
        await prefetchRoute(path)
      }
    })()
    return () => { stopped = true; release?.(); warming.current = false }
  }, [api.mode, regionReady])
  // Scroll: a new page starts at the top (filter and tab changes on the same page keep their place); Back and Forward
  // restore where that entry was left, waiting a moment for its (usually cached) content to be tall enough again.
  const navigationType = useNavigationType()
  const scrolls = useRef(new Map<string, number>())
  const lastPath = useRef(location.pathname)
  useEffect(() => {
    const el = content.current, key = location.key
    if (!el) return
    const save = () => { scrolls.current.set(key, el.scrollTop) }
    el.addEventListener('scroll', save, { passive: true })
    return () => el.removeEventListener('scroll', save)
  }, [location.key])
  useLayoutEffect(() => {
    const el = content.current, samePage = lastPath.current === location.pathname
    lastPath.current = location.pathname
    if (navigationType === 'POP') {
      const top = scrolls.current.get(location.key) ?? 0
      if (!el) return
      let frame = 0, tries = 0
      const apply = () => { el.scrollTop = top; if (Math.abs(el.scrollTop - top) > 1 && tries++ < 60) frame = requestAnimationFrame(apply) }
      const stop = () => cancelAnimationFrame(frame)
      apply()
      el.addEventListener('wheel', stop, { once: true, passive: true }); el.addEventListener('touchstart', stop, { once: true, passive: true })
      return () => { stop(); el.removeEventListener('wheel', stop); el.removeEventListener('touchstart', stop) }
    }
    if (samePage) return
    window.scrollTo(0, 0)
    el?.scrollTo(0, 0)
  }, [location.key])
  useEffect(() => {
    const preferred = regions.data?.defaultRegion
    if (!access.multiTenant && regions.data && !current && enabled.length) setRegionId(enabled.find(region => region.region === preferred)?.region ?? enabled[0].region)
  }, [access.multiTenant, regions.data, current, enabled, setRegionId])
  useEffect(() => { document.title = `${navigation.find(([path]) => path === '/' ? location.pathname === '/' : location.pathname.startsWith(path))?.[1] ?? 'bane'} · bane` }, [location.pathname])
  function changeRegion(id: string) {
    setRegionId(id)
    const parts = location.pathname.split('/').filter(Boolean)
    if (['logs', 'domains'].includes(parts[0])) {
      if (parts.length > 1) navigate(`/${parts[0]}`)
      else {
        const search = new URLSearchParams(location.search)
        search.delete('page')
        navigate({ pathname: location.pathname, search: search.toString() }, { replace: true })
      }
    }
  }
  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <aside className="sidebar">
      <NavLink className="wordmark" to="/" aria-label="bane overview"><span className="wordmark-square" aria-hidden="true" />bane</NavLink>
      <ThemeToggle />
      <div className="sidebar-context">
        {access.multiTenant && <WorkspaceSwitcher />}
        {access.canAdminister && !access.multiTenant && <Select id="sidebar-view-region" aria-label="Viewing region" value={current?.region ?? ''} onValueChange={changeRegion} options={enabled.map(region => ({ value: region.region, label: region.region }))} disabled={regions.isPending || !enabled.length} placeholder={regions.isPending ? 'Loading regions…' : 'No enabled regions'} />}
        {access.canAdminister && !access.multiTenant && regions.isError && <Button variant="ghost" onClick={() => regions.refetch()}>Retry regions</Button>}
        {api.mode === 'demo' && <span className="demo-indicator" title="Sample data; no external requests.">Demo mode</span>}
      </div>
      {/* Members see every page: owner and admin ones carry a lock and explain who can use them. */}
      <nav className="main-navigation" aria-label="Main navigation">{navigation.map(([path, title]) => { const locked = !access.canAdminister && adminOnly.has(path); return <NavLink key={path} to={path} end={path === '/'} {...locked ? { title: 'Owners and admins only', 'data-locked': true } : intent(path)}>{title}{locked && <Lock size={12} aria-label="Owners and admins only" />}</NavLink> })}</nav>
      <div className="sidebar-footer">
        {access.multiTenant && <div className="sidebar-score-slot"><SidebarScore /></div>}
        {access.canAdminister && !access.multiTenant && needsProvisioning && <Link className="sidebar-setup" to={`/settings?region=${encodeURIComponent(regionId)}`}><span>Region needs provisioning</span><span className="sidebar-setup-action">Set up {regionId} →</span></Link>}
      <div className="sidebar-quota">{!access.canAdminister || access.multiTenant ? null : quota?.sentLast24Hours != null && quota.max24HourSend != null ? <>
        <div className="quota-label"><span>SES · 24h</span><span>{percent(quota.sentLast24Hours / Math.max(1, quota.max24HourSend), 0)}</span></div>
        {quota.max24HourSend > 0 && <meter className="quota-meter" min={0} max={quota.max24HourSend} value={quota.sentLast24Hours} aria-label="Daily sending quota used" />}
        <span>{number(quota.sentLast24Hours)} / {number(quota.max24HourSend)} sent</span>
      </> : discovery.isFetching ? <><div className="quota-label"><span>Checking SES…</span><Skeleton width={28} /></div><Skeleton height={3} /><SkeletonText lineHeight={18} /></> : needsProvisioning ? null : <><span>SES · {discovery.isError ? 'Check failed' : label(current?.discoveryStatus ?? 'not_discovered')}</span><Link to="/settings">Set up SES</Link></>}</div>
      </div>
    </aside>
    <main ref={content} id="main-content" className="page-surface" tabIndex={-1}>{session?.notice && <div className="page-notice"><Alert tone="danger" title="Invitation not accepted" onDismiss={session.dismissNotice}>{session.notice}</Alert></div>}
      <ChunkFallback.Provider value={<RouteSkeleton />}><Suspense fallback={<RouteSkeleton />}>
        {needsRegion && regions.isError && !regions.data ? <ErrorState error={regions.error} onRetry={() => regions.refetch()} />
          : needsRegion && (regions.isPending ? !regionId : !current && enabled.length > 0) ? <RouteSkeleton />
          : needsRegion && regions.data && !enabled.length ? <EmptyState title="No enabled regions" action={!access.multiTenant && <Link to="/settings">Set up SES</Link>} />
          : <Outlet />}
      </Suspense></ChunkFallback.Provider>
    </main>
  </div>
}
