import { lazy, useEffect, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowUpRight } from 'lucide-react'
import { Button, LoadingRegion, Skeleton } from '../../components/ui'
import { ThemeToggle } from '../../components/ThemeToggle'
import { AnomalyLogo } from '../../components/AnomalyLogo'
import { request } from '../../data/live'
import { number, percent } from '../../lib/format'
import './home.css'

// GET /v1/public/stats: installation-wide aggregates over whole hours, rounded, computed every minute by the API.
// `available` is false until enough workspaces send that the figures can't describe one customer; every figure is then null.
export type PublicStats = { generatedAt: string; available: boolean; acceptedLast30Days: number | null; acceptedLastHour: number | null; acceptedHourly: (number | null)[]; deliveryRate: number | null; medianSendLatencyMs: number | null; regions: string[] }
export const usePublicStats = () => useQuery({ queryKey: ['public-stats'], queryFn: ({ signal }) => request<PublicStats>('/v1/public/stats', { signal }), refetchInterval: 60_000, staleTime: 30_000, retry: 1 })

export const capabilities = [
  ['Send', 'Transactional and marketing.', 'POST /v1/emails/send'],
  ['Receive', 'Parsed and posted to webhooks.', 'POST /v1/inbound/addresses'],
  ['Reply', 'From the receiving address.', 'POST /v1/inbound/threads/:id/reply'],
  ['Thread', 'Full conversation history.', 'GET /v1/inbound/threads/:id'],
] as const

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

type Anchor = { value: number; at: number; perMinute: number }
const estimate = (anchor: Anchor, now: number) => anchor.value + Math.floor(anchor.perMinute * Math.max(0, now - anchor.at) / 60_000)

// The fetched total, advanced at the measured last-hour rate. A refetch continues from whichever is higher, its
// total or the running estimate: the 30-day window also drops old mail, and a counter should not step backwards.
export function useLiveCount(total: number, perMinute: number, fetchedAt: number) {
  const [anchor, setAnchor] = useState<Anchor & { fetchedAt: number }>({ value: total, at: fetchedAt, perMinute, fetchedAt })
  if (anchor.fetchedAt !== fetchedAt) setAnchor({ value: Math.max(total, estimate(anchor, fetchedAt)), at: fetchedAt, perMinute, fetchedAt })
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (perMinute <= 0 || reducedMotion()) return
    const ticker = window.setInterval(() => setNow(Date.now()), Math.min(2000, Math.max(250, 60_000 / perMinute)))
    return () => window.clearInterval(ticker)
  }, [perMinute])
  return estimate(anchor, now)
}

export function VolumeBars({ values }: { values: readonly number[] }) {
  const max = Math.max(1, ...values)
  return <svg className="home-volume" viewBox={`0 0 ${values.length * 6} 40`} preserveAspectRatio="none" aria-hidden="true">
    {values.map((value, index) => <rect key={index} className={index === values.length - 1 ? 'chart-bar chart-bar--active' : 'chart-bar'} x={index * 6} y={40 - (value / max) * 40} width={4} height={(value / max) * 40} rx={1} />)}
  </svg>
}

export type HomeProps = { onSignIn: () => void; onSignInIntent: (event: { button: number }) => void; busy: boolean; notice?: ReactNode }

// Design studies for review, chosen with /?home=terminal|editorial|protocol. Without the parameter the current page renders.
const variants = {
  terminal: lazy(() => import('./variant-terminal').then(module => ({ default: module.TerminalHome }))),
  editorial: lazy(() => import('./variant-editorial').then(module => ({ default: module.EditorialHome }))),
  protocol: lazy(() => import('./variant-protocol').then(module => ({ default: module.ProtocolHome }))),
}
function selectedVariant() {
  const name = new URLSearchParams(window.location.search).get('home')
  return name && Object.hasOwn(variants, name) ? variants[name as keyof typeof variants] : null
}

export function HomePage(props: HomeProps) {
  const [Variant] = useState(selectedVariant)
  useEffect(() => { document.title = 'bane · Email infrastructure' }, [])
  // The first screen after signing in: fetch its code while the visitor reads, so it is already cached on return.
  useEffect(() => {
    const load = () => void import('../onboarding').catch(() => {})
    if (typeof requestIdleCallback === 'function') { const idle = requestIdleCallback(load, { timeout: 3000 }); return () => cancelIdleCallback(idle) }
    const timer = setTimeout(load, 1500); return () => clearTimeout(timer)
  }, [])
  return Variant ? <Variant {...props} /> : <CurrentHome {...props} />
}

// Shared page chrome: navigation, sign-in and footer.
export function HomeHeader({ onSignIn, onSignInIntent, busy }: Pick<HomeProps, 'onSignIn' | 'onSignInIntent' | 'busy'>) {
  return <header className="home-header">
    <a className="wordmark" href="/" aria-label="bane home"><span className="wordmark-square" aria-hidden="true" />bane</a>
    <nav className="home-nav" aria-label="Site">
      <a href="/docs">Docs</a>
      <ThemeToggle />
      <Button onClick={onSignIn} disabled={busy} onPointerDown={onSignInIntent}>Sign in</Button>
    </nav>
  </header>
}

export function HomeActions({ onSignIn, onSignInIntent, busy }: Pick<HomeProps, 'onSignIn' | 'onSignInIntent' | 'busy'>) {
  return <div className="home-actions">
    <Button variant="primary" loading={busy} onClick={onSignIn} onPointerDown={onSignInIntent}>Start with Google</Button>
    <a className="ui-button ui-button--secondary ui-button--md" href="/docs">Docs <ArrowUpRight size={16} aria-hidden="true" /></a>
  </div>
}

export function HomeFooter() {
  return <footer className="home-footer muted">
    <a className="home-by" href="https://anoma.ly" target="_blank" rel="noopener" title="Anomaly (opens in a new tab)">by <AnomalyLogo height={20} /></a>
    <nav aria-label="Developer links"><a href="/docs">Docs</a><a href="/openapi.json">OpenAPI</a><a href="https://www.npmjs.com/package/@banemx/sdk">SDK</a></nav>
  </footer>
}

function CurrentHome({ onSignIn, onSignInIntent, busy, notice }: HomeProps) {
  const stats = usePublicStats()
  return <div className="home-page">
    <HomeHeader onSignIn={onSignIn} onSignInIntent={onSignInIntent} busy={busy} />
    <main className="home-main">
      <section className="home-hero">
        <h1>Email infrastructure done right.</h1>
        <p>One API on Amazon SES.</p>
        <HomeActions onSignIn={onSignIn} onSignInIntent={onSignInIntent} busy={busy} />
        <p className="home-invite muted">Invite-only for now. Sign in with Google to request access.</p>
        {notice}
      </section>
      {/* No board until there are figures to show: while they're withheld (available: false) or failing, the page goes straight to the capabilities. */}
      {stats.data?.available ? <Board stats={stats.data} fetchedAt={stats.dataUpdatedAt} /> : stats.isPending && <BoardSkeleton />}
      <section className="home-capabilities" aria-label="Capabilities">
        {capabilities.map(([name, line, endpoint]) => <div className="home-capability" key={name}>
          <h2>{name}</h2>
          <p className="muted">{line}</p>
          <code>{endpoint}</code>
        </div>)}
      </section>
    </main>
    <HomeFooter />
  </div>
}

export function Board({ stats, fetchedAt }: { stats: PublicStats; fetchedAt: number }) {
  const perMinute = (stats.acceptedLastHour ?? 0) / 60
  const sent = useLiveCount(stats.acceptedLast30Days ?? 0, perMinute, fetchedAt)
  return <section className="home-board" aria-label="Sending stats">
    <div className="home-counter">
      <div>
        <div className="home-counter-label muted"><span className="home-live" aria-hidden="true" />Emails sent · 30 days</div>
        <div className="home-counter-value">{number(sent)}</div>
      </div>
      <div className="home-counter-chart">
        <VolumeBars values={stats.acceptedHourly.map(value => value ?? 0)} />
        <div className="muted cell-caption">Last 24 h</div>
      </div>
    </div>
    <div className="metrics-grid">
      <Stat title="Delivery rate" value={stats.deliveryRate === null ? '—' : percent(stats.deliveryRate)} note="30 days" tone={stats.deliveryRate === null ? undefined : 'success'} />
      <Stat title="Median latency" value={stats.medianSendLatencyMs === null ? '—' : `${number(stats.medianSendLatencyMs)} ms`} note="API to SES" />
      <Stat title="Last hour" value={stats.acceptedLastHour === null ? '—' : number(stats.acceptedLastHour)} note={stats.acceptedLastHour === null ? 'Too few senders' : perMinute >= 1 ? `≈ ${number(Math.round(perMinute))}/min` : '< 1/min'} />
      <Stat title="Regions" value={String(stats.regions.length)} note={stats.regions.map((region, index) => <span key={region}>{index > 0 && ' · '}<span className="nowrap">{region}</span></span>)} />
    </div>
  </section>
}

// Same layout as the board, with no figures until real ones arrive.
export function BoardSkeleton() {
  return <LoadingRegion label="Loading sending stats" className="home-board home-board--loading">
    <div className="home-counter">
      <div>
        <div className="home-counter-label muted"><span className="home-live home-live--idle" aria-hidden="true" />Emails sent · 30 days</div>
        <div className="home-counter-value"><Skeleton width="6.5ch" height="0.8em" /></div>
      </div>
      <div className="home-counter-chart"><Skeleton height={56} /><div className="muted cell-caption">Last 24 h</div></div>
    </div>
    <div className="metrics-grid">
      {['Delivery rate', 'Median latency', 'Last hour', 'Regions'].map(title => <div className="metric" key={title}><div className="muted">{title}</div><div className="metric-value"><Skeleton width={88} height={22} /></div></div>)}
    </div>
  </LoadingRegion>
}

export function Stat({ title, value, note, tone }: { title: string; value: string; note: ReactNode; tone?: string }) {
  return <div className="metric"><div className="muted">{title}</div><div className={`metric-value ${tone ? `text-${tone}` : ''}`}>{value}</div><div className="muted cell-caption">{note}</div></div>
}
