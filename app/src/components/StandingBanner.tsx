import { Link, useLocation } from 'react-router'
import { OctagonAlert, TriangleAlert } from 'lucide-react'
import { useApiDef, useSession } from '../data/context'
import { queries } from '../data/queries'
import { standingDid, standingFallback, standingTone } from '../lib/standing'
import { Skeleton } from './ui'

// Restrict and pause put a banner on every dashboard page. The step comes with the session (GET /v1/me), so the banner
// is in place on the shell's first paint; what happened (the first reason, from GET /v1/sender-score) fills a line
// whose height is already reserved, so nothing below it moves when it arrives.
export function StandingBanner() {
  const identity = useSession()?.identity
  const step = identity?.multiTenant ? identity.connection?.standing?.step : undefined
  const shown = step === 'restrict' || step === 'pause'
  const score = useApiDef(queries.senderScore(), { enabled: shown })
  const { pathname } = useLocation()
  if (!shown) return null
  const reason = score.data?.standing?.reasons[0]?.message
  const what = score.data ? reason ?? standingFallback[step] : score.isError ? 'Open Overview for what happened.' : null
  const Icon = step === 'pause' ? OctagonAlert : TriangleAlert
  return <div className={`standing-banner ui-tone--${standingTone(step)}`} role={step === 'pause' ? 'alert' : 'status'} data-step={step}>
    <Icon className="standing-banner__icon" size={16} aria-hidden="true" />
    <div className="standing-banner__text">
      <p className="standing-banner__what" title={what ?? undefined}>{what ?? <Skeleton width="62%" height={12} />}</p>
      <p className="standing-banner__did">{standingDid[step]}</p>
    </div>
    {/* On Overview the hash change scrolls to the card; elsewhere the link opens Overview there. */}
    <Link className="ui-button ui-button--secondary ui-button--sm standing-banner__fix" to="/#standing" replace={pathname === '/'}>Fix checklist</Link>
  </div>
}
