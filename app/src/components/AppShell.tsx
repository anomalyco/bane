import { Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate, useNavigationType } from 'react-router'
import { BookOpen, Ellipsis, Globe, Inbox, KeyRound, LayoutGrid, Lock, ScrollText, Send, Settings, ShieldCheck, Users } from 'lucide-react'
import { useApi, useRegion, useSession, useWorkspaceAccess } from '../data/context'
import { sidebarPaths, usePrefetchQueries, usePrefetchRoute, useRouteIntent } from '../data/prefetch'
import { useRegionCatalog, useRegionDiscovery } from '../data/regions'
import { label, number, percent } from '../lib/format'
import { chunk, ChunkFallback } from '../lib/preloadable'
import { queries } from '../data/queries'
import { useScoreAbout } from '../lib/score-about'
import { Alert, Button, EmptyState, ErrorState, Select, Sheet, Skeleton, SkeletonText } from './ui'
import { useCompactShell } from '../lib/media'
import { RouteSkeleton } from './RouteSkeleton'
import { ThemeToggle } from './ThemeToggle'
import { AccountSwitcher } from './AccountSwitcher'
import { StandingBanner } from './StandingBanner'
import { BillingBanner } from './BillingBanner'
import { LegalFooterLinks } from './LegalLinks'
import { PrivacyToggle } from './PrivacyToggle'
import { togglePrivacy } from '../lib/privacy'
import { SupportHost, SupportTrigger, useSupportChat } from './SupportChat'
import { BaneWordmark } from './BaneLogo'

// The sender score card (hosted): its code and data load with the shell, into a slot that already has its final size.
const score = chunk(() => import('../features/score'))
const SidebarScore = score.page(module => module.SidebarScore)
// The sender score explainer: one dialog for every place the score appears, loaded when first opened.
const ScoreAboutHost = score.page(module => module.ScoreAboutHost)

// Members can't manage sending infrastructure; the API enforces this too.
const adminOnly = new Set(['/api-keys', '/domains'])
type NavItem = readonly [path: string, title: string]
const navigation: readonly NavItem[] = [['/', 'Overview'], ['/logs', 'Logs'], ['/receiving', 'Receiving'], ['/campaigns', 'Campaigns'], ['/audience', 'Audience'], ['/domains', 'Domains'], ['/api-keys', 'API keys'], ['/docs', 'Docs'], ['/settings', 'Settings']]
// Bane staff (a platform operator role in GET /v1/me) also get the operator console, last.
const operatorLink: NavItem = ['/operator', 'Operator']
// Below 900 px the sidebar becomes a top bar (workspace, theme) and a bottom tab bar: the four areas used most, one
// thumb-tap away and always in view, and More, a sheet with the rest. A drawer would hide every destination behind a
// button; the tab bar keeps the main ones visible and says where you are.
const tabs = ['/', '/logs', '/receiving', '/campaigns']
const icons: Record<string, ReactNode> = { '/': <LayoutGrid />, '/logs': <ScrollText />, '/receiving': <Inbox />, '/campaigns': <Send />, '/audience': <Users />, '/domains': <Globe />, '/api-keys': <KeyRound />, '/docs': <BookOpen />, '/settings': <Settings />, '/operator': <ShieldCheck /> }
const current = (path: string, pathname: string) => path === '/' ? pathname === '/' : pathname === path || pathname.startsWith(`${path}/`)
export function AppShell() {
  const api = useApi()
  const { regionId, setRegionId } = useRegion()
  const session = useSession()
  const access = useWorkspaceAccess()
  const location = useLocation()
  const scoreAbout = useScoreAbout()
  // The support chat: Help in the page's bottom-right corner (in the top bar on a phone or tablet), one conversation for
  // the whole visit that stays open across pages.
  const support = useSupportChat({ demoApi: api.mode === 'demo', hosted: access.multiTenant, staff: Boolean(session?.identity?.operator || session?.identity?.billing?.free) })
  const [scoreAboutMounted, setScoreAboutMounted] = useState(false)
  useEffect(() => { if (scoreAbout.open) setScoreAboutMounted(true) }, [scoreAbout.open])
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
  // The page card scrolls on a desktop; on a phone or tablet the document does, so the browser's bars collapse.
  const compact = useCompactShell()
  const navigationType = useNavigationType()
  const scrolls = useRef(new Map<string, number>())
  const lastPath = useRef(location.pathname)
  const scroller = () => compact ? document.scrollingElement as HTMLElement | null : content.current
  useEffect(() => {
    const el = scroller(), key = location.key, target: HTMLElement | Window | null = compact ? window : el
    if (!el || !target) return
    const save = () => { scrolls.current.set(key, el.scrollTop) }
    target.addEventListener('scroll', save, { passive: true })
    return () => target.removeEventListener('scroll', save)
  }, [location.key, compact])
  useLayoutEffect(() => {
    const el = scroller(), samePage = lastPath.current === location.pathname
    lastPath.current = location.pathname
    if (navigationType === 'POP') {
      const top = scrolls.current.get(location.key) ?? 0
      if (!el) return
      let frame = 0, tries = 0
      const apply = () => { el.scrollTop = top; if (Math.abs(el.scrollTop - top) > 1 && tries++ < 60) frame = requestAnimationFrame(apply) }
      const stop = () => cancelAnimationFrame(frame)
      apply()
      window.addEventListener('wheel', stop, { once: true, passive: true }); window.addEventListener('touchstart', stop, { once: true, passive: true })
      return () => { stop(); window.removeEventListener('wheel', stop); window.removeEventListener('touchstart', stop) }
    }
    if (samePage) return
    window.scrollTo(0, 0)
    content.current?.scrollTo(0, 0)
  }, [location.key])
  useEffect(() => {
    const preferred = regions.data?.defaultRegion
    if (!access.multiTenant && regions.data && !current && enabled.length) setRegionId(enabled.find(region => region.region === preferred)?.region ?? enabled[0].region)
  }, [access.multiTenant, regions.data, current, enabled, setRegionId])
  useEffect(() => { document.title = `${[...navigation, operatorLink].find(([path]) => path === '/' ? location.pathname === '/' : location.pathname.startsWith(path))?.[1] ?? 'bane'} · bane` }, [location.pathname])
  // "/" jumps to the page's search box, as in most list-heavy tools, unless you are already typing somewhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="dialog"]')) return
      const search = content.current?.querySelector<HTMLInputElement>('input[type="search"]:not(:disabled)')
      if (!search) return
      event.preventDefault(); search.focus(); search.select()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  // ⇧P turns privacy mode (lib/privacy.ts) on or off, unless you are typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'P' || !event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || event.repeat || event.defaultPrevented) return
      if ((event.target as HTMLElement | null)?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return
      event.preventDefault(); togglePrivacy()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
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
  // Members see every page: owner and admin ones carry a lock and open a short note on who can use them.
  const links: readonly NavItem[] = [...navigation, ...session?.identity?.operator ? [operatorLink] : []]
  const locked = (path: string) => !access.canAdminister && adminOnly.has(path)
  const scoreHost = (scoreAbout.open || scoreAboutMounted) && <Suspense fallback={null}><ScoreAboutHost /></Suspense>
  const context = <>
    {access.multiTenant && <AccountSwitcher />}
    {access.canAdminister && !access.multiTenant && <Select id="sidebar-view-region" aria-label="Viewing region" value={current?.region ?? ''} onValueChange={changeRegion} options={enabled.map(region => ({ value: region.region, label: region.region }))} disabled={regions.isPending || !enabled.length} placeholder={regions.isPending ? 'Loading regions…' : 'No enabled regions'} />}
    {access.canAdminister && !access.multiTenant && regions.isError && <Button variant="ghost" onClick={() => regions.refetch()}>Retry regions</Button>}
    {api.mode === 'demo' && <span className="demo-indicator" title="Sample data; no external requests.">Demo mode</span>}
  </>
  // The links and privacy mode first, so the last item (the sender score card, or SES's quota) ends on the main panel's bottom edge.
  const footer = <>
    <LegalFooterLinks />
    <PrivacyToggle />
    {access.canAdminister && !access.multiTenant && needsProvisioning && <Link className="sidebar-setup" to={`/settings?region=${encodeURIComponent(regionId)}`}><span>Region needs provisioning</span><span className="sidebar-setup-action">Set up {regionId} →</span></Link>}
    <div className="sidebar-quota">{!access.canAdminister || access.multiTenant ? null : quota?.sentLast24Hours != null && quota.max24HourSend != null ? <>
      <div className="quota-label"><span>SES · 24h</span><span>{percent(quota.sentLast24Hours / Math.max(1, quota.max24HourSend), 0)}</span></div>
      {quota.max24HourSend > 0 && <meter className="quota-meter" min={0} max={quota.max24HourSend} value={quota.sentLast24Hours} aria-label="Daily sending quota used" />}
      <span>{number(quota.sentLast24Hours)} / {number(quota.max24HourSend)} sent</span>
    </> : discovery.isFetching ? <><div className="quota-label"><span>Checking SES…</span><Skeleton width={28} /></div><Skeleton height={3} /><SkeletonText lineHeight={18} /></> : needsProvisioning ? null : <><span>SES · {discovery.isError ? 'Check failed' : label(current?.discoveryStatus ?? 'not_discovered')}</span><Link to="/settings">Set up SES</Link></>}</div>
    {access.multiTenant && <div className="sidebar-score-slot"><SidebarScore /></div>}
  </>
  const supportHost = support.mode && <SupportHost chat={support} />
  const main = <main ref={content} id="main-content" className="page-surface" tabIndex={-1}>{session?.notice && <div className="page-notice"><Alert tone="danger" title="Invitation not accepted" onDismiss={session.dismissNotice}>{session.notice}</Alert></div>}
    <StandingBanner />
    <BillingBanner />
    <ChunkFallback.Provider value={<RouteSkeleton />}><Suspense fallback={<RouteSkeleton />}>
      {needsRegion && regions.isError && !regions.data ? <ErrorState error={regions.error} onRetry={() => regions.refetch()} />
        : needsRegion && (regions.isPending ? !regionId : !current && enabled.length > 0) ? <RouteSkeleton />
        : needsRegion && regions.data && !enabled.length ? <EmptyState title="No enabled regions" action={!access.multiTenant && <Link to="/settings">Set up SES</Link>} />
        : <Outlet />}
    </Suspense></ChunkFallback.Provider>
  </main>
  if (compact) return <div className="app-shell app-shell--compact">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <header className="mobile-bar">
      <NavLink className="wordmark" to="/" aria-label="bane overview"><BaneWordmark /></NavLink>
      <div className="mobile-bar__context">{context}</div>
      {support.mode && <SupportTrigger chat={support} />}
      <ThemeToggle />
    </header>
    {scoreHost}
    {main}
    <TabBar links={links} intent={intent} footer={footer} locked={locked} />
    {supportHost}
  </div>
  return <div className={support.mode ? 'app-shell app-shell--support' : 'app-shell'}>
    <a className="skip-link" href="#main-content">Skip to content</a>
    <aside className="sidebar">
      <NavLink className="wordmark" to="/" aria-label="bane overview"><BaneWordmark /></NavLink>
      <ThemeToggle />
      <div className="sidebar-context">{context}</div>
      {/* Members see every page: owner and admin ones carry a lock and explain who can use them. */}
      <nav className="main-navigation" aria-label="Main navigation">{links.map(([path, title]) => <NavLink key={path} to={path} end={path === '/'} {...locked(path) ? lockedProps : intent(path)}>{title}{locked(path) && <Lock size={12} aria-label="Owners and admins only" />}</NavLink>)}</nav>
      <div className="sidebar-footer">{footer}</div>
    </aside>
    {scoreHost}
    {main}
    {support.mode && <SupportTrigger chat={support} floating />}
    {supportHost}
  </div>
}

// The tab bar and its More sheet. More opens as a history entry of its own, so Back (or a swipe back) closes it
// instead of leaving the page; a page picked in it replaces that entry, so Back from there returns to the page below.
const issued = new Set<string>()
const lockedProps = { title: 'Owners and admins only', 'data-locked': true }
function TabBar({ links, intent, footer, locked }: { links: readonly NavItem[]; intent: ReturnType<typeof useRouteIntent>; footer: ReactNode; locked: (path: string) => boolean }) {
  const location = useLocation(), navigate = useNavigate()
  // Only an entry opened in this visit counts: a reload on it shows the page, not a stale sheet.
  const token = (location.state as { more?: string } | null)?.more
  const open = Boolean(token && issued.has(token))
  const more = links.filter(([path]) => !tabs.includes(path))
  const inMore = more.some(([path]) => current(path, location.pathname))
  const show = () => { const next = `${Date.now()}:${Math.random()}`; issued.add(next); navigate({ pathname: location.pathname, search: location.search, hash: location.hash }, { state: { more: next } }) }
  const close = () => { if (open) navigate(-1) }
  return <>
    <nav className="tab-bar" aria-label="Main navigation">
      {links.filter(([path]) => tabs.includes(path)).map(([path, title]) => <NavLink key={path} className="tab-bar__item" to={path} end={path === '/'} {...intent(path)}><span className="tab-bar__icon" aria-hidden="true">{icons[path]}</span><span className="tab-bar__label">{title}</span></NavLink>)}
      <button type="button" className="tab-bar__item" aria-haspopup="dialog" aria-expanded={open} aria-current={inMore ? 'page' : undefined} data-active={inMore || open || undefined} onClick={show}><span className="tab-bar__icon" aria-hidden="true"><Ellipsis /></span><span className="tab-bar__label">More</span></button>
    </nav>
    <Sheet open={open} onOpenChange={next => { if (!next) close() }} title="More" hideTitle className="more-sheet">
      <nav className="more-sheet__links" aria-label="More pages">{more.map(([path, title]) => <NavLink key={path} className="more-sheet__link" to={path} replace {...locked(path) ? lockedProps : intent(path)}><span className="more-sheet__icon" aria-hidden="true">{icons[path]}</span>{title}{locked(path) && <Lock className="more-sheet__lock" size={14} aria-label="Owners and admins only" />}</NavLink>)}</nav>
      <div className="more-sheet__footer">{footer}</div>
    </Sheet>
  </>
}
