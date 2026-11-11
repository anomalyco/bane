import { useLocation } from 'react-router'
import { useApiDef, useApiQuery, useRegion } from '../../data/context'
import { queries } from '../../data/queries'
import type { Domain, Overview } from '../../data/types'
import { readScoreOverride } from '../../lib/design'
import { scoreReport, withScore, type ScoreInputs, type ScoreReport } from '../../lib/sender-score'

// Pitch only: no score API yet. Bounces, complaints and volume consistency come from the real 30-day metrics,
// authentication from the workspace's domains; the content screen and list hygiene inputs are synthetic until the
// API stores per-email screen scores and suppression hits.
export const SYNTHETIC = { content: 0.004, hygiene: 0.012 } as const

// DKIM 40 + aligned SPF (custom MAIL FROM) 30 + DMARC 30, where p=none earns half; averaged over sending domains.
export function authShare(domains: Domain[]) {
  const sending = domains.filter(domain => domain.status === 'verified')
  if (!sending.length) return 0
  const each = sending.map(domain => (domain.dkimStatus === 'failed' ? 0 : 0.4) + (domain.mailFromStatus === 'verified' ? 0.3 : 0)
    + (domain.dmarc?.status === 'quarantine' || domain.dmarc?.status === 'reject' ? 0.3 : domain.dmarc?.status === 'none' ? 0.15 : 0))
  return each.reduce((sum, value) => sum + value, 0) / each.length
}
// The busiest day against the median of the seven days before it.
export function spikeRatio(points: Overview['points']) {
  const days = points.map(point => point.sent)
  let worst = 1
  for (let i = 7; i < days.length; i++) {
    const window = days.slice(i - 7, i).sort((a, b) => a - b), median = window[3]
    if (median > 0) worst = Math.max(worst, days[i] / median)
  }
  return worst
}

export function useSenderScore(): { report: ScoreReport | null; domains: Domain[]; loading: boolean } {
  const { regionId } = useRegion()
  const override = readScoreOverride(useLocation().search)
  const metrics = useApiDef(queries.overview(regionId, '30d', 'all'), { interval: 60_000 })
  const domains = useApiQuery(['domains', 'score'], (api, signal) => api.domains.list({ page: 1, pageSize: 10, refresh: false }, signal))
  if (!metrics.data || !domains.data) return { report: null, domains: domains.data?.items ?? [], loading: metrics.isPending || domains.isPending }
  const data = metrics.data
  const inputs: ScoreInputs = {
    emails: data.sent,
    complaints: data.delivered ? data.complaints / data.delivered : 0,
    bounces: data.sent ? data.bounced / data.sent : 0,
    content: SYNTHETIC.content,
    auth: authShare(domains.data.items),
    hygiene: SYNTHETIC.hygiene,
    consistency: spikeRatio(data.points),
  }
  const report = scoreReport(inputs)
  return { report: override !== null && report.state === 'graded' ? withScore(report, override) : report, domains: domains.data.items, loading: false }
}
