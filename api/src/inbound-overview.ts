// GET /v1/inbound/overview: the Receiving screen in one read. Every route mail can take (an address and its patterns,
// an explicit route, an agent inbox, a domain's catch-all), each with the rituals that run on it and where it goes,
// plus counts per kind, the rituals, the endpoints and the domains. Routes are paged from one statement; the rest is
// bounded by the API's own limits (50 rituals, 256 attachments, the workspace's endpoints and domains).
import { createRoute, z } from '@hono/zod-openapi';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { ApiError, errors, response, webhookUrlHint, type App, type Ctx, type MailboxAccess } from './core.js';
import { domains } from './db/operations.js';
import { mailboxes, mailboxWebhooks } from './db/mailbox.js';
import { Endpoint, endpointRows, endpointView } from './ritual-endpoints.js';
import type { Programs } from './ritual-pipeline.js';
import { withRegionSettings } from './ses-region-state.js';

type Deps = {
  access: (c: Ctx, permission?: 'read') => MailboxAccess;
  mailboxViews: (runtime: Ctx['env'], rows: (typeof mailboxes.$inferSelect)[]) => Promise<Record<string, any>[]>;
  domainViews: (c: Ctx, rows: (typeof domains.$inferSelect)[]) => Promise<Record<string, any>[]>;
  InboundAddressSchema: z.ZodType; InboundDomainSchema: z.ZodType;
  security: Record<string, string[]>[];
};
const KINDS = ['address', 'inbox', 'route', 'pattern', 'catch_all'] as const;
type Kind = (typeof KINDS)[number];
const Kinds = z.string().max(64).regex(new RegExp(`^(${KINDS.join('|')})(,(${KINDS.join('|')}))*$`))
  .describe('Comma-separated kinds to list: address (a receiving address, including temporary ones), inbox (an agent inbox), route (an explicit route for an address that has no inbox of its own), pattern (an address wildcard rule or a pattern route), catch_all (a *@host route, or the domain default for unknown recipients). Default: every kind.');
const Target = z.object({
  type: z.enum(['inbox', 'webhook', 'slack', 'discord', 'forward', 'store', 'drop', 'create_address']).describe('inbox: the address keeps the thread. webhook, slack, discord, forward: an endpoint or an inbound webhook. store: kept without an inbox. drop: not stored. create_address: the domain creates an address for the recipient.'),
  id: z.string().nullable().describe('Address ID for an inbox, webhook ID (mwh_…) for an endpoint or inbound webhook; null for store, drop and create_address.'),
  name: z.string().describe('Display name, endpoint name or address.'),
  detail: z.string().nullable().describe('Where it delivers. Webhook, Slack and Discord URLs are write-only; only the last four characters are shown.'),
  via: z.string().nullable().describe('The ritual that sends mail here. A ritual may do so for only some mail; null when routing always does.'),
  status: z.enum(['ready', 'pending', 'expired', 'declined', 'paused']).nullable().describe('Endpoint status; paused for a paused inbound webhook; null for inboxes and outcomes.'),
}).openapi('InboundOverviewTarget');
const OverviewEndpoint = z.object({
  id: z.string().describe('Webhook ID (mwh_…) that delivers for it.'),
  source: z.enum(['endpoint', 'inbound_webhook']).describe('endpoint: a named endpoint rituals call (and routes can name). inbound_webhook: a webhook created with createInboundWebhook.'),
  name: z.string(), type: z.enum(['webhook', 'slack', 'discord', 'forward']),
  status: z.enum(['ready', 'pending', 'expired', 'declined', 'paused']),
  target: z.string().describe('Where it delivers; URLs are write-only (last four characters).'),
  call: z.string().nullable().describe('How a ritual calls an endpoint; null for an inbound webhook.'),
  eventTypes: z.array(z.string()).describe('Events an inbound webhook subscribes to; empty for endpoints and route-only webhooks.'),
  routes: z.number().int().describe('Routes that name it.'),
  rituals: z.array(z.string()).describe('Rituals that call it.'),
}).openapi('InboundOverviewEndpoint');

// Drizzle expands a JS array into a parameter list, so arrays travel as one JSON parameter.
const textArray = (values: string[]) => sql`ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(values)}::jsonb))`;
const like = (q: string) => `%${q.replace(/[\\%_]/g, ch => `\\${ch}`)}%`;
const encode = (row: { host: string; rank: number; match: string; id: string }) => Buffer.from(JSON.stringify([row.host, row.rank, row.match, row.id])).toString('base64url');
function decode(cursor: string | undefined) {
  if (!cursor) return null;
  try {
    const [host, rank, match, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as [string, number, string, string];
    if (typeof host !== 'string' || typeof rank !== 'number' || typeof match !== 'string' || typeof id !== 'string') throw Error();
    return { host, rank, match, id };
  } catch { throw new ApiError(422, 'INVALID_CURSOR', 'cursor is not a cursor this endpoint returned.', 'cursor'); }
}

export function registerInboundOverview(app: App, deps: Deps) {
  const RouteEntry = z.object({
    id: z.string().describe('Address ID, route ID, <addressId>:<pattern> for an address pattern, or default:<domainId> for a domain default.'),
    kind: z.enum(KINDS),
    match: z.string().describe('The address or pattern mail is sent to.'),
    host: z.string(),
    address: deps.InboundAddressSchema.nullable().describe('The address that owns this route (address, inbox and address-pattern rows).'),
    route: z.object({ id: z.string(), enabled: z.boolean(), to: z.union([z.array(z.string()), z.literal('drop')]) }).nullable().describe('The explicit route for this match, when one exists.'),
    catchAll: z.enum(['store', 'create_address']).nullable().describe('The domain default for unknown recipients, on a domain-default row.'),
    rituals: z.array(z.string()).describe('Rituals attached to this address or alias, in the order they run.'),
    to: z.array(Target).describe('Where its mail goes: routing first, then what attached rituals can send it to.'),
  }).openapi('InboundOverviewRoute');
  const Overview = z.object({
    counts: z.object({ address: z.number().int(), auto: z.number().int().describe('Addresses a catch-all created (origin auto).'), route: z.number().int(), pattern: z.number().int(), catch_all: z.number().int(), inbox: z.number().int() })
      .describe('Routes per kind, after the domain and q filters and before kind and origin.'),
    routes: z.object({ data: z.array(RouteEntry), nextCursor: z.string().nullable() }),
    rituals: z.array(z.object({ key: z.string(), calls: z.array(z.string()).describe('Endpoint names it can call.'), delivers: z.array(z.string()).describe('Inbox keys it can deliver to.'), omens: z.array(z.string()), attachedTo: z.array(z.string()).describe('Address IDs or addresses it runs on.') })),
    endpoints: z.array(OverviewEndpoint),
    domains: z.array(deps.InboundDomainSchema).describe('Every domain with its receiving status, including domains that only send.'),
    manage: z.boolean().describe('False for members and scoped keys: they see their addresses, without routes, rituals, endpoints or domains.'),
  }).openapi('InboundOverview');

  app.openapi(createRoute({
    method: 'get', path: '/v1/inbound/overview', operationId: 'getInboundOverview', tags: ['Inbound addresses'], security: deps.security,
    summary: 'Every route mail can take, with its rituals and endpoints, in one read',
    description: 'One page of routes (addresses, agent inboxes, address patterns, explicit routes and catch-alls) merged and ordered by host, kind and address, each resolved to the rituals that run on it and where its mail goes. Also returns counts per kind, the rituals, the endpoints and the domains. Members and scoped keys see only their addresses.',
    request: { query: z.object({
      kind: Kinds.optional(), origin: z.enum(['api', 'auto']).optional().describe('Filters address rows only: api (created on purpose) or auto (created by a catch-all). Other kinds are unaffected.'),
      domain: z.string().max(253).optional().describe('Receiving host, e.g. reply.acme.com.'), q: z.string().max(200).optional().describe('Matches the address, an alias or the display name.'),
      cursor: z.string().max(400).optional(), limit: z.coerce.number().int().min(1).max(100).default(50),
    }) },
    responses: { 200: response(Overview), ...errors },
  }), async c => {
    const value = deps.access(c, 'read'), w = value.workspaceId, q = c.req.valid('query');
    const manage = value.admin;
    const scope = !manage && value.mailboxIds ? (value.mailboxIds.length ? value.mailboxIds : ['']) : null;
    const kinds = (q.kind?.split(',') ?? KINDS) as Kind[];
    const after = decode(q.cursor);
    const host = q.domain?.toLowerCase() ?? null, needle = q.q?.trim() ? like(q.q.trim().toLowerCase()) : null;
    // Routes, address patterns and domain defaults are admin data; members list their own addresses.
    const rows = (await c.env.db.execute<{ counts: Record<string, number>; page: { id: string; kind: Kind; match: string; host: string; rank: number; address_id: string | null; route_id: string | null; domain_id: string | null }[] }>(sql`
      WITH e AS (
        SELECT m.id, CASE WHEN m.kind='inbox' THEN 'inbox' ELSE 'address' END AS kind, m.origin, m.address AS match, split_part(m.address,'@',2) AS host,
          CASE WHEN m.kind='inbox' THEN 3 WHEN m.origin='auto' THEN 4 ELSE 0 END AS rank, m.id AS address_id, NULL::text AS route_id, NULL::text AS domain_id, m.display_name
        FROM mailboxes m WHERE m.workspace_id=${w} AND (m.delete_after IS NULL OR m.delete_after>statement_timestamp())
          AND (${scope === null}::boolean OR m.id = ANY(${textArray(scope ?? [])}))
        UNION ALL
        SELECT m.id||':'||r, 'pattern', 'api', r, split_part(r,'@',2), 2, m.id, NULL::text, NULL::text, m.display_name
        FROM mailboxes m CROSS JOIN LATERAL jsonb_array_elements_text(m.rules) r
        WHERE m.workspace_id=${w} AND (${scope === null}::boolean OR m.id = ANY(${textArray(scope ?? [])}))
        UNION ALL
        SELECT r.id, CASE WHEN starts_with(r.match,'*@') THEN 'catch_all' WHEN position('*' IN r.match)>0 THEN 'pattern' ELSE 'route' END, 'api', r.match, split_part(r.match,'@',2),
          CASE WHEN starts_with(r.match,'*@') THEN 5 WHEN position('*' IN r.match)>0 THEN 2 ELSE 1 END, NULL::text, r.id, NULL::text, NULL::text
        FROM mail_routes r WHERE ${manage}::boolean AND r.workspace_id=${w}
          AND NOT EXISTS (SELECT FROM mailbox_addresses a WHERE a.workspace_id=${w} AND a.address=r.match AND a.kind<>'public')
        UNION ALL
        SELECT 'default:'||d.domain_id, 'catch_all', 'api', '*@'||coalesce(d.receiving_host,d.name), coalesce(d.receiving_host,d.name), 5, NULL::text, NULL::text, d.domain_id, NULL::text
        FROM mailbox_domains d WHERE ${manage}::boolean AND d.workspace_id=${w} AND d.parent_id IS NULL AND d.status='active'
          AND NOT EXISTS (SELECT FROM mail_routes r WHERE r.workspace_id=${w} AND r.match='*@'||coalesce(d.receiving_host,d.name))
      ), f AS (
        SELECT * FROM e WHERE (${host}::text IS NULL OR e.host=${host})
          AND (${needle}::text IS NULL OR lower(e.match) LIKE ${needle} OR lower(coalesce(e.display_name,'')) LIKE ${needle}
            OR (e.address_id IS NOT NULL AND EXISTS (SELECT FROM mailbox_addresses a WHERE a.workspace_id=${w} AND a.mailbox_id=e.address_id AND a.kind='alias' AND a.address LIKE ${needle})))
      )
      SELECT (SELECT coalesce(jsonb_object_agg(k, n),'{}'::jsonb) FROM (SELECT CASE WHEN kind='address' AND origin='auto' THEN 'auto' ELSE kind END AS k, count(*)::int AS n FROM f GROUP BY 1) x) AS counts,
        (SELECT coalesce(jsonb_agg(p ORDER BY p.host, p.rank, p.match, p.id),'[]'::jsonb) FROM (
          SELECT f.id, f.kind, f.match, f.host, f.rank, f.address_id, f.route_id, f.domain_id FROM f
          WHERE f.kind = ANY(${textArray(kinds)}) AND (${q.origin ?? null}::text IS NULL OR f.kind<>'address' OR f.origin=${q.origin ?? null})
            AND (${after === null}::boolean OR (f.host, f.rank, f.match, f.id) > (${after?.host ?? ''}::text, ${after?.rank ?? 0}::int, ${after?.match ?? ''}::text, ${after?.id ?? ''}::text))
          ORDER BY f.host, f.rank, f.match, f.id LIMIT ${q.limit + 1}) p) AS page`)).rows[0]!;
    const page = rows.page.slice(0, q.limit), last = rows.page.length > q.limit ? page.at(-1)! : null;
    const counts = { address: 0, auto: 0, route: 0, pattern: 0, catch_all: 0, inbox: 0, ...rows.counts };

    // Everything the page refers to, read once. Bounded by the page and by the API's limits.
    const addressIds = [...new Set(page.map(r => r.address_id).filter((x): x is string => !!x))];
    const [boxes, routes, config, endpointList, hooks, routeUse, domainRows] = await Promise.all([
      addressIds.length ? c.env.db.select().from(mailboxes).where(and(eq(mailboxes.workspaceId, w), inArray(mailboxes.id, addressIds))) : Promise.resolve([]),
      manage && page.length ? c.env.db.execute<{ id: string; match: string; to: string[] | 'drop'; enabled: boolean }>(sql`SELECT id,match,destinations AS "to",enabled FROM mail_routes WHERE workspace_id=${w}
        AND (id = ANY(${textArray(page.map(r => r.route_id).filter((x): x is string => !!x))}) OR match = ANY(${textArray(page.filter(r => r.kind === 'address' || r.kind === 'inbox').map(r => r.match))}))`).then(r => r.rows) : Promise.resolve([]),
      manage ? c.env.db.execute<{ config: { rituals?: { key: string }[]; attachments?: { ritual: string; target: string }[] } | null; programs: Programs | null }>(sql`SELECT config,programs FROM mail_ritual_configs WHERE workspace_id=${w}`).then(r => r.rows[0] ?? null) : Promise.resolve(null),
      manage ? endpointRows(c.env.db, w).then(rows => Promise.all(rows.slice(0, 500).map(row => endpointView(c.env, w, row).then(view => ({ view, hook: row.hook_id }))))) : Promise.resolve([]),
      manage ? c.env.db.select({ id: mailboxWebhooks.id, key: mailboxWebhooks.key, url: mailboxWebhooks.url, description: mailboxWebhooks.description, name: mailboxWebhooks.name, eventTypes: mailboxWebhooks.eventTypes, mailboxIds: mailboxWebhooks.mailboxIds, paused: mailboxWebhooks.paused })
        .from(mailboxWebhooks).where(and(eq(mailboxWebhooks.workspaceId, w), sql`${mailboxWebhooks.key} IS NULL`, sql`NOT starts_with(${mailboxWebhooks.id},'con_')`, sql`NOT EXISTS (SELECT FROM mail_endpoints d WHERE d.workspace_id=${w} AND d.hook_id=${mailboxWebhooks.id})`)) : Promise.resolve([]),
      manage ? c.env.db.execute<{ id: string; n: number }>(sql`SELECT d AS id,count(*)::int AS n FROM mail_routes r CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(r.destinations)='array' THEN r.destinations ELSE '[]'::jsonb END) d WHERE r.workspace_id=${w} GROUP BY d`).then(r => r.rows) : Promise.resolve([]),
      manage ? (async () => { c.env = await withRegionSettings(c.env, w); return c.env.db.select().from(domains).where(and(eq(domains.workspaceId, w), inArray(domains.region, c.env.config.regions))).orderBy(domains.name); })() : Promise.resolve([]),
    ]);
    const views = new Map((await deps.mailboxViews(c.env, boxes)).map(v => [v.id as string, v]));
    const programs = config?.programs?.rituals ?? {};
    const attachments = config?.config?.attachments ?? [];
    const endpointByName = new Map(endpointList.map(e => [e.view.name, e]));
    const endpointByHook = new Map(endpointList.map(e => [e.hook, e]));
    const hookById = new Map(hooks.map(h => [h.id, h]));
    const boxByKey = new Map<string, Record<string, any>>();
    // inbox.deliver("key") names an address by key; resolve the keys the rituals use.
    const keys = [...new Set(Object.values(programs).flatMap(ir => ir.refs.filter(r => r.startsWith('inbox:')).map(r => r.slice(6))))];
    if (keys.length) for (const v of await deps.mailboxViews(c.env, await c.env.db.select().from(mailboxes).where(and(eq(mailboxes.workspaceId, w), inArray(mailboxes.key, keys))))) boxByKey.set(v.key, v);

    type T = z.infer<typeof Target>;
    const inboxTarget = (v: Record<string, any>, via: string | null = null): T => ({ type: 'inbox', id: v.id, name: v.displayName || v.address, detail: v.address, via, status: null });
    const endpointTarget = (e: { view: z.infer<typeof Endpoint>; hook: string }, via: string | null = null): T => ({ type: e.view.type, id: e.hook, name: e.view.name, detail: e.view.target, via, status: e.view.status });
    const hookTarget = (h: (typeof hooks)[number]): T => ({ type: 'webhook', id: h.id, name: h.description || h.name || webhookUrlHint(h.url), detail: webhookUrlHint(h.url), via: null, status: h.paused ? 'paused' : null });
    const resolve = (id: string): T | null => { const v = views.get(id) ?? [...boxByKey.values()].find(b => b.id === id); if (v) return inboxTarget(v); const e = endpointByHook.get(id); if (e) return endpointTarget(e); const h = hookById.get(id); return h ? hookTarget(h) : null; };
    const ritualsFor = (targets: string[]) => [...new Set(attachments.filter(a => targets.includes(a.target)).map(a => a.ritual))];
    const viaRituals = (ritualKeys: string[]) => ritualKeys.flatMap(k => (programs[k]?.refs ?? []).map(ref => {
      if (ref.startsWith('endpoint:')) { const e = endpointByName.get(ref.slice(9)); return e ? endpointTarget(e, k) : null; }
      const v = boxByKey.get(ref.slice(6)); return v ? inboxTarget(v, k) : null;
    })).filter((t): t is T => !!t);
    const merge = (base: T[], extra: T[]) => [...base, ...extra].filter((t, i, all) => all.findIndex(x => x.type === t.type && x.id === t.id) === i);
    const routeOf = (match: string) => routes.find(r => r.match === match);
    const subscribed = (addressId: string) => hooks.filter(h => h.eventTypes.includes('message.received') && (h.mailboxIds === null || h.mailboxIds.includes(addressId))).map(hookTarget);
    const routed = (r: { to: string[] | 'drop' }): T[] => r.to === 'drop' ? [{ type: 'drop', id: null, name: 'Dropped', detail: null, via: null, status: null }]
      : r.to.length ? r.to.map(resolve).filter((t): t is T => !!t) : [{ type: 'store', id: null, name: 'Stored, no inbox', detail: null, via: null, status: null }];
    const domainCatchAll = new Map<string, 'store' | 'create_address'>();
    if (manage && page.some(r => r.domain_id)) for (const d of await c.env.db.execute<{ domain_id: string; catch_all: string }>(sql`SELECT domain_id,catch_all FROM mailbox_domains WHERE workspace_id=${w} AND parent_id IS NULL AND domain_id = ANY(${textArray(page.map(r => r.domain_id).filter((x): x is string => !!x))})`).then(r => r.rows))
      domainCatchAll.set(d.domain_id, d.catch_all === 'create_mailbox' || d.catch_all === 'create_address' ? 'create_address' : 'store');

    const data = page.map(r => {
      const v = r.address_id ? views.get(r.address_id) ?? null : null;
      if (r.kind === 'address' || r.kind === 'inbox') {
        const route = routeOf(r.match) ?? null, ritualKeys = ritualsFor([v!.id, v!.address, ...v!.aliases]);
        return { id: r.id, kind: r.kind, match: r.match, host: r.host, address: v, route: route && { id: route.id, enabled: route.enabled, to: route.to }, catchAll: null, rituals: ritualKeys,
          to: merge(route?.enabled ? routed(route) : [inboxTarget(v!)], [...subscribed(v!.id), ...viaRituals(ritualKeys)]) };
      }
      if (r.kind === 'pattern' && v) {
        const ritualKeys = ritualsFor([v.id, v.address, ...v.aliases]);
        return { id: r.id, kind: r.kind, match: r.match, host: r.host, address: v, route: null, catchAll: null, rituals: ritualKeys, to: merge([inboxTarget(v)], [...subscribed(v.id), ...viaRituals(ritualKeys)]) };
      }
      if (r.domain_id) {
        const catchAll = domainCatchAll.get(r.domain_id) ?? 'store';
        return { id: r.id, kind: r.kind, match: r.match, host: r.host, address: null, route: null, catchAll, rituals: [],
          to: [catchAll === 'create_address' ? { type: 'create_address' as const, id: null, name: 'New address per recipient', detail: null, via: null, status: null } : { type: 'store' as const, id: null, name: 'Stored, no inbox', detail: null, via: null, status: null }] };
      }
      const route = routes.find(x => x.id === r.route_id)!, ritualKeys = ritualsFor([r.match]);
      return { id: r.id, kind: r.kind, match: r.match, host: r.host, address: null, route: { id: route.id, enabled: route.enabled, to: route.to }, catchAll: null, rituals: ritualKeys, to: merge(routed(route), viaRituals(ritualKeys)) };
    });
    const rituals = Object.entries(programs).map(([key, ir]) => ({ key, calls: ir.refs.filter(r => r.startsWith('endpoint:')).map(r => r.slice(9)), delivers: ir.refs.filter(r => r.startsWith('inbox:')).map(r => r.slice(6)),
      omens: Object.keys(ir.omens ?? {}), attachedTo: attachments.filter(a => a.ritual === key).map(a => a.target) }));
    const uses = new Map(routeUse.map(r => [r.id, r.n]));
    const endpoints: z.infer<typeof OverviewEndpoint>[] = [
      ...endpointList.map(e => ({ id: e.hook, source: 'endpoint' as const, name: e.view.name, type: e.view.type, status: e.view.status, target: e.view.target, call: e.view.call, eventTypes: [], routes: uses.get(e.hook) ?? 0, rituals: rituals.filter(r => r.calls.includes(e.view.name)).map(r => r.key) })),
      ...hooks.map(h => ({ id: h.id, source: 'inbound_webhook' as const, name: h.description || h.name || webhookUrlHint(h.url), type: 'webhook' as const, status: h.paused ? 'paused' as const : 'ready' as const, target: webhookUrlHint(h.url), call: null, eventTypes: h.eventTypes, routes: uses.get(h.id) ?? 0, rituals: [] })),
    ];
    return c.json({ counts, routes: { data, nextCursor: last ? encode(last) : null }, rituals, endpoints, domains: manage ? await deps.domainViews(c, domainRows) : [], manage } as never, 200);
  });
}
