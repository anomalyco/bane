// getInboundOverview: the Receiving screen in one read (routes page, counts, rituals, endpoints, domains).
import { useApiQuery } from '../../data/context'
import { request } from '../../data/live'
import type { InboundAddress, MailboxDomain } from '../../data/types'

export type TargetType = 'inbox' | 'webhook' | 'slack' | 'discord' | 'forward' | 'store' | 'drop' | 'create_address'
export type EndpointStatus = 'ready' | 'pending' | 'expired' | 'declined' | 'paused'
export type Target = { type: TargetType; id: string | null; name: string; detail: string | null; via: string | null; status: EndpointStatus | null }
export type RouteKind = 'address' | 'inbox' | 'route' | 'pattern' | 'catch_all'
export type RouteEntry = {
  id: string; kind: RouteKind; match: string; host: string
  address: InboundAddress | null
  route: { id: string; enabled: boolean; to: string[] | 'drop' } | null
  catchAll: 'store' | 'create_address' | null
  rituals: string[]; to: Target[]
}
export type OverviewRitual = { key: string; calls: string[]; delivers: string[]; omens: string[]; attachedTo: string[] }
export type OverviewEndpoint = { id: string; source: 'endpoint' | 'inbound_webhook'; name: string; type: 'webhook' | 'slack' | 'discord' | 'forward'; status: EndpointStatus; target: string; call: string | null; eventTypes: string[]; routes: number; rituals: string[] }
/** A domain as the overview lists it: its receiving host, receiving status and catch-all. */
export type OverviewDomain = Pick<MailboxDomain, 'id' | 'name' | 'status' | 'catchAll'>
export type Overview = {
  counts: { address: number; auto: number; route: number; pattern: number; catch_all: number; inbox: number }
  routes: { data: RouteEntry[]; nextCursor: string | null }
  rituals: OverviewRitual[]; endpoints: OverviewEndpoint[]; endpointsTruncated: boolean; domains: OverviewDomain[]; manage: boolean
}
export type OverviewQuery = { kind?: string; origin?: 'api' | 'auto'; domain?: string; q?: string; cursor?: string; limit?: number }

export const overviewKey = (query: OverviewQuery) => ['inbound-overview', query.kind ?? '', query.origin ?? '', query.domain ?? '', query.q ?? '', query.cursor ?? '', query.limit ?? 50] as const
export const readOverview = (query: OverviewQuery, signal?: AbortSignal) => {
  const params = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]))
  return request<Overview>(`/v1/inbound/overview${params.size ? `?${params}` : ''}`, { signal })
}
export function useOverview(query: OverviewQuery, keepPrevious = false, enabled = true) {
  return useApiQuery(overviewKey(query), (_api, signal) => readOverview(query, signal), { keepPrevious, enabled })
}
// The Routes tab's first read with no filters, shared with the sidebar prefetch so both use one cache key.
export const firstOverview: OverviewQuery = { limit: 50 }
export const overviewQuery = (query: OverviewQuery) => ({ key: overviewKey(query), read: (_api: unknown, signal: AbortSignal) => readOverview(query, signal) })

export const receivingDomains = <D extends Pick<MailboxDomain, 'status'>>(domains: D[]) => domains.filter(d => !['off', 'disabled'].includes(d.status))
export const ago = (iso: string | null | undefined) => {
  if (!iso) return null
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000))
  return minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`
}
export const expiresIn = (iso: string | null | undefined) => {
  if (!iso) return null
  const hours = Math.round((Date.parse(iso) - Date.now()) / 3_600_000)
  return hours <= 0 ? 'Expired' : hours < 48 ? `Expires in ${hours} h` : `Expires in ${Math.round(hours / 24)} days`
}
export const typeLabel: Record<TargetType, string> = { inbox: 'Inbox', webhook: 'Webhook', slack: 'Slack', discord: 'Discord', forward: 'Forward', store: 'Stored', drop: 'Dropped', create_address: 'New address' }
