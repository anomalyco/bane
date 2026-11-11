// Receiving IA pitch: one model of where received mail goes, read from the same public API every direction uses.
// Domain → Mail to (an address, its aliases and patterns, a route or a catch-all) → Ritual (optional) → Destinations.
import { useApiDef, useApiQuery, useWorkspaceAccess } from '../../../data/context'
import { request } from '../../../data/live'
import { queries } from '../../../data/queries'
import type { InboundAddress, InboundWebhook, MailboxDomain, MailRoute } from '../../../data/types'
import type { Endpoint } from '../ritual-connections'

export type DestKind = 'inbox' | 'webhook' | 'slack' | 'discord' | 'forward' | 'keep' | 'drop' | 'create'
export type Dest = { id: string; kind: DestKind; name: string; detail: string; href: string; paused?: boolean; pending?: boolean }
export type EntryKind = 'address' | 'pattern' | 'catchall' | 'route' | 'temporary' | 'agent' | 'auto'
export type Entry = {
  id: string; kind: EntryKind; match: string; local: string; host: string; label: string | null; aliases: string[]
  owner?: InboundAddress; route?: MailRoute; domain?: MailboxDomain
  /** Destinations only a ritual sends to, with the ritual that does (it may do so only for some mail). */
  rituals: string[]; to: Dest[]; via: Record<string, string>; unread: number; threads: number; last: string | null; expiresAt: string | null; href: string
}
export type Ritual = { key: string; source: string; calls: string[]; delivers: string[]; omens: boolean; targets: string[] }
export type Group = { host: string; domain?: MailboxDomain; total: number; auto: number; agents: number }
type RitualConfig = { version: number; config: { rituals: { key: string; source: string }[]; attachments: { ritual: string; target: string; continue: boolean }[] } }
type Page = InboundAddress[] & { nextCursor?: string | null }

// Up to 1,000 of a kind, 100 per request. Past that the views say how many more there are and search reaches them;
// a summary read (counts per domain, kind, ritual and destination) would replace this in the API.
const MAX_PAGES = 10
const page = (params: Record<string, string>) => async (signal: AbortSignal): Promise<Page> => {
  const rows: InboundAddress[] = []
  let cursor: string | null = null
  for (let i = 0; i < MAX_PAGES; i++) {
    const r: { data: InboundAddress[]; nextCursor: string | null } = await request(`/v1/inbound/addresses?${new URLSearchParams({ limit: '100', ...params, ...(cursor ? { cursor } : {}) })}`, { signal })
    rows.push(...r.data); cursor = r.nextCursor
    if (!cursor) break
  }
  return Object.assign(rows, { nextCursor: cursor })
}
const hostOf = (address: string) => address.slice(address.lastIndexOf('@') + 1)
const localOf = (address: string) => address.slice(0, address.lastIndexOf('@'))
const urlHost = (url: string) => { try { return new URL(url).host } catch { return url } }
export const plural = (n: number, word: string, many = `${word}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? word : many}`

// What a ritual's source calls: endpoints.<name>(…) / endpoints["name"](…) and inbox.deliver("key").
function scan(source: string) {
  const calls = [...source.matchAll(/endpoints(?:\.([a-z0-9_-]+)|\["([^"]+)"\])\s*\(/gi)].map(m => (m[1] ?? m[2])!)
  const delivers = [...source.matchAll(/inbox\.deliver\(\s*"([^"]+)"/g)].map(m => m[1]!)
  return { calls: [...new Set(calls)], delivers: [...new Set(delivers)], omens: /\bomens\s*\(/.test(source) }
}

export const destKindLabel: Record<DestKind, string> = { inbox: 'Inbox', webhook: 'Webhook', slack: 'Slack', discord: 'Discord', forward: 'Forward', keep: 'Kept, no inbox', drop: 'Dropped', create: 'New address per sender' }
export const entryKindLabel: Record<EntryKind, string> = { address: 'Address', pattern: 'Pattern', catchall: 'Everything else', route: 'Route', temporary: 'Temporary', agent: 'Agent inbox', auto: 'Auto-created' }

export function useReceivingModel() {
  const { canAdminister } = useWorkspaceAccess()
  const domains = useApiDef(queries.inboundDomains(), { enabled: canAdminister })
  const named = useApiQuery(['pitch', 'addresses', 'named'], (_api, signal) => page({ kind: 'address', origin: 'api' })(signal))
  const autos = useApiQuery(['pitch', 'addresses', 'auto'], (_api, signal) => page({ kind: 'address', origin: 'auto' })(signal))
  const agents = useApiQuery(['pitch', 'addresses', 'agents'], (_api, signal) => page({ kind: 'inbox' })(signal))
  const routing = useApiDef(queries.routing(), { enabled: canAdminister })
  const webhooks = useApiDef(queries.inboundWebhooks(), { enabled: canAdminister })
  const rituals = useApiQuery(['pitch', 'rituals'], (_api, signal) => request<RitualConfig>('/v1/rituals', { signal }), { enabled: canAdminister })
  const endpoints = useApiQuery(['pitch', 'endpoints'], (_api, signal) => request<{ data: Endpoint[] }>('/v1/endpoints?limit=200', { signal }).then(r => r.data), { enabled: canAdminister })
  const reads = [domains, named, autos, agents, routing, webhooks, rituals, endpoints]
  const settled = reads.every(q => q.data !== undefined || q.error || (q as { fetchStatus?: string }).fetchStatus === 'idle')
  const error = reads.find(q => q.error)?.error ?? null
  const model = settled && !error ? build(domains.data ?? [], named.data ?? [], autos.data ?? [], agents.data ?? [], routing.data?.routes ?? [], webhooks.data ?? [], rituals.data, endpoints.data ?? [], {
    named: !!named.data?.nextCursor, autos: !!autos.data?.nextCursor, agents: !!agents.data?.nextCursor,
  }) : null
  return { model, error, retry: () => reads.forEach(q => q.error && void q.refetch()) }
}
export type Model = ReturnType<typeof build>

function build(domains: MailboxDomain[], named: InboundAddress[], autos: InboundAddress[], agents: InboundAddress[], routes: MailRoute[], webhooks: InboundWebhook[], ritualConfig: RitualConfig | undefined, endpoints: Endpoint[], more: { named: boolean; autos: boolean; agents: boolean }) {
  const receiving = domains.filter(d => !['off', 'disabled'].includes(d.status)).sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) || b.addressCount - a.addressCount || a.name.localeCompare(b.name))
  const sendOnly = domains.filter(d => ['off', 'disabled'].includes(d.status))
  const addresses = [...named, ...autos, ...agents]
  const byId = new Map(addresses.map(a => [a.id, a]))
  const byKey = new Map(addresses.filter(a => a.key).map(a => [a.key!, a]))
  const owner = new Map(addresses.flatMap(a => [a.address, ...a.aliases].map(m => [m, a] as const)))

  // Destinations: every inbox (an address keeps its own threads), webhooks, and the endpoints rituals call.
  const inboxDest = (a: InboundAddress): Dest => ({ id: a.id, kind: 'inbox', name: a.displayName || a.address, detail: a.address, href: `/receiving/addresses/${a.id}` })
  const hookDest = (h: InboundWebhook): Dest => ({ id: h.id, kind: 'webhook', name: h.description || h.name || urlHost(h.url), detail: urlHost(h.url), href: `/receiving/webhooks/${h.id}`, paused: h.paused })
  const endpointDest = (e: Endpoint): Dest => ({ id: `endpoint:${e.name}`, kind: e.type, name: e.name, detail: e.target, href: '/receiving/endpoints', paused: e.status === 'paused', pending: e.status !== 'ready' && e.status !== 'paused' })
  const keep: Dest = { id: 'keep', kind: 'keep', name: 'Kept, no inbox', detail: 'Stored and readable over the API', href: '/receiving/inbox?view=all' }
  const drop: Dest = { id: 'drop', kind: 'drop', name: 'Dropped', detail: 'Not stored', href: '/receiving/routing' }
  const create: Dest = { id: 'create', kind: 'create', name: 'New address per sender', detail: 'The catch-all creates an inbox', href: '/domains' }
  // A webhook endpoint is stored as an inbound webhook keyed by its name: one destination, shown once.
  const eps = new Map(endpoints.map(e => [e.name, endpointDest(e)]))
  const endpointHook = (h: InboundWebhook) => !!h.key && endpoints.some(e => e.type === 'webhook' && e.name === h.key)
  const hooks = new Map(webhooks.map(h => [h.id, endpointHook(h) ? eps.get(h.key!)! : hookDest(h)]))
  const resolve = (id: string): Dest | null => { const a = byId.get(id); return a ? inboxDest(a) : hooks.get(id) ?? null }
  // Webhooks subscribed to message.received also get the mail of the addresses they cover.
  const subscribed = (a: InboundAddress) => webhooks.filter(h => h.eventTypes.includes('message.received') && (h.addressIds === null || h.addressIds.includes(a.id))).map(h => hooks.get(h.id)!)

  const rituals: Ritual[] = (ritualConfig?.config.rituals ?? []).map(r => ({ key: r.key, source: r.source, ...scan(r.source), targets: (ritualConfig?.config.attachments ?? []).filter(x => x.ritual === r.key).map(x => x.target) }))
  const ritualsFor = (targets: string[]) => (ritualConfig?.config.attachments ?? []).filter(x => targets.includes(x.target)).map(x => x.ritual).filter((k, i, all) => all.indexOf(k) === i)
  const ritualDests = (keys: string[]) => keys.flatMap(k => { const r = rituals.find(x => x.key === k); return r ? [...r.calls.map(c => eps.get(c)).filter(Boolean) as Dest[], ...r.delivers.map(d => byKey.get(d)).filter(Boolean).map(a => inboxDest(a!))].map(d => [d, k] as const) : [] })
  // Routing decides `base`; rituals may add more. A destination both give is the routing one.
  const path = (base: Dest[], keys: string[]) => { const extra = ritualDests(keys).filter(([d]) => !base.some(b => b.id === d.id)); return { to: uniq([...base, ...extra.map(([d]) => d)]), via: Object.fromEntries(extra.map(([d, k]) => [d.id, k])) } }
  const uniq = (list: Dest[]) => list.filter((d, i) => list.findIndex(x => x.id === d.id) === i)
  const routeFor = new Map(routes.map(r => [r.match, r]))
  const routeTo = (r: MailRoute): Dest[] => r.to === 'drop' ? [drop] : r.to.length ? r.to.map(resolve).filter(Boolean) as Dest[] : [keep]
  const domainOf = (host: string) => receiving.find(d => d.name === host)

  const entries: Entry[] = []
  for (const a of addresses) {
    const kind: EntryKind = a.kind === 'inbox' ? 'agent' : a.origin === 'auto' ? 'auto' : a.expiresAt ? 'temporary' : 'address'
    const route = routeFor.get(a.address)
    const keys = ritualsFor([a.id, a.address, ...a.aliases])
    entries.push({ id: a.id, kind, match: a.address, local: localOf(a.address), host: hostOf(a.address), label: a.displayName, aliases: a.aliases, owner: a, route, domain: domainOf(hostOf(a.address)),
      rituals: keys, ...path(uniq([...(route ? routeTo(route) : [inboxDest(a)]), ...subscribed(a)]), keys),
      unread: a.stats.unreadThreads, threads: a.stats.threads, last: a.stats.lastMessageAt, expiresAt: a.expiresAt ?? null, href: kind === 'agent' ? `/receiving/inboxes/${a.id}` : `/receiving/addresses/${a.id}` })
    for (const rule of a.rules) entries.push({ id: `${a.id}:${rule}`, kind: 'pattern', match: rule, local: localOf(rule), host: hostOf(rule), label: null, aliases: [], owner: a, domain: domainOf(hostOf(rule)),
      rituals: keys, ...path(uniq([inboxDest(a), ...subscribed(a)]), keys), unread: 0, threads: 0, last: null, expiresAt: null, href: `/receiving/addresses/${a.id}` })
  }
  for (const r of routes) {
    if (owner.has(r.match)) continue
    const host = hostOf(r.match)
    const kind: EntryKind = r.match.startsWith('*@') ? 'catchall' : r.match.includes('*') ? 'pattern' : 'route'
    const keys = ritualsFor([r.match])
    entries.push({ id: r.id, kind, match: r.match, local: localOf(r.match), host, label: null, aliases: [], route: r, domain: domainOf(host), rituals: keys, ...path(uniq(routeTo(r)), keys),
      unread: 0, threads: 0, last: null, expiresAt: null, href: '/receiving/routing' })
  }
  // The domain default ("everything else") for hosts without a *@ route.
  for (const d of receiving) if (d.status === 'active' && !routeFor.has(`*@${d.name}`))
    entries.push({ id: `default:${d.id}`, kind: 'catchall', match: `*@${d.name}`, local: '*', host: d.name, label: null, aliases: [], domain: d, rituals: [], to: [d.catchAll === 'create_address' ? create : keep], via: {},
      unread: 0, threads: 0, last: null, expiresAt: null, href: `/domains/${d.id}` })

  const rank: Record<EntryKind, number> = { address: 0, temporary: 1, route: 2, pattern: 3, agent: 4, auto: 5, catchall: 6 }
  const hostRank = (host: string) => { const i = receiving.findIndex(d => d.name === host); return i < 0 ? receiving.length : i }
  entries.sort((a, b) => hostRank(a.host) - hostRank(b.host) || a.host.localeCompare(b.host) || rank[a.kind] - rank[b.kind] || (b.last ?? '').localeCompare(a.last ?? '') || a.match.localeCompare(b.match))
  const hosts = [...new Set([...receiving.map(d => d.name), ...entries.map(e => e.host)])]
  const groups: Group[] = hosts.map(host => {
    const domain = domainOf(host), here = entries.filter(e => e.host === host)
    const listed = here.filter(e => e.owner && e.kind !== 'pattern').length
    return { host, domain, total: Math.max(domain?.addressCount ?? 0, listed), auto: here.filter(e => e.kind === 'auto').length, agents: here.filter(e => e.kind === 'agent').length }
  })
  // Exact totals come from the domains' address counts; the lists hold the first page of each kind.
  const totals = { addresses: receiving.reduce((n, d) => n + d.addressCount, 0), named: named.length, auto: autos.length, agents: agents.length }
  const destinations = uniq([...addresses.filter(a => a.kind !== 'inbox' && a.origin !== 'auto').map(inboxDest), ...webhooks.filter(h => !endpointHook(h)).map(hookDest), ...endpoints.map(endpointDest)])
  const used = (dest: Dest) => entries.filter(e => e.to.some(d => d.id === dest.id))
  return { domains, receiving, sendOnly, entries, groups, rituals, destinations, webhooks, endpoints, routes, totals, more, used, keep, drop, create, inboxDest }
}

export const ago = (iso: string | null) => {
  if (!iso) return null
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000))
  return minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`
}
export const expiresIn = (iso: string | null) => {
  if (!iso) return null
  const hours = Math.round((Date.parse(iso) - Date.now()) / 3_600_000)
  return hours <= 0 ? 'Expired' : hours < 48 ? `Expires in ${hours} h` : `Expires in ${Math.round(hours / 24)} days`
}
