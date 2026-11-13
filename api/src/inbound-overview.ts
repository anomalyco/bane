// GET /v1/inbound/overview: the Receiving screen in one read. Every route mail can take (an address and its patterns,
// an explicit route, an agent inbox, a domain's catch-all), each with the rituals that run on it and where it goes,
// plus counts per kind, the rituals, the endpoints and the domains.
//
// Database budget: two statements, run one after the other (one connection at a time), whatever the route count.
//   1. routes: counts per kind and one page of routes, with everything a page row refers to (its address, aliases and
//      thread stats, its explicit route, the inboxes and webhooks that route delivers to, and per address its webhook
//      subscribers, active first, at most OVERVIEW_SUBSCRIBERS, with exact totals).
//   2. workspace (managers only): the ritual config, the first 100 endpoints and 100 inbound webhooks (plus endpoints
//      and inboxes a ritual names), their route counts from one probe of the destinations index, and the domains.
// withRegionSettings adds one single-row read on hosted regional sending only.
import { createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { ApiError, errors, response, webhookUrlHint, type App, type Ctx, type MailboxAccess } from './core.js';
import type { mailboxes } from './db/mailbox.js';
import { domains } from './db/operations.js';
import { Endpoint, endpointSource, endpointView, type EndpointRow } from './ritual-endpoints.js';
import type { Programs } from './ritual-pipeline.js';
import { withRegionSettings } from './ses-region-state.js';

type MailboxRow = typeof mailboxes.$inferSelect;
type Deps = {
  access: (c: Ctx, permission?: 'read') => MailboxAccess;
  mailboxView: (row: MailboxRow, addresses: { address: string; kind: string }[], stat?: { threads: number; unread: number; last: string | null }) => Record<string, any>;
  InboundAddressSchema: z.ZodType; InboundDomainStatus: z.ZodType; InboundCatchAll: z.ZodType;
  security: Record<string, string[]>[];
};
/** Endpoints and inbound webhooks listed per overview; endpointsTruncated says when a workspace has more. */
export const OVERVIEW_ENDPOINTS = 100;
/** Webhook subscribers listed per route, active ones first. A route with more says so (toTruncated, toTotal, toMore). */
export const OVERVIEW_SUBSCRIBERS = 50;
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

const like = (q: string) => `%${q.replace(/[\\%_]/g, ch => `\\${ch}`)}%`;
// Drizzle expands a JS array into a parameter list, so arrays travel as one JSON parameter.
const textArray = (values: string[]) => sql`ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(values)}::jsonb))`;
const encode = (row: { host: string; rank: number; match: string; id: string }) => Buffer.from(JSON.stringify([row.host, row.rank, row.match, row.id])).toString('base64url');
function decode(cursor: string | undefined) {
  if (!cursor) return null;
  try {
    const [host, rank, match, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as [string, number, string, string];
    if (typeof host !== 'string' || !Number.isInteger(rank) || rank < 0 || rank > 9 || typeof match !== 'string' || typeof id !== 'string') throw Error();
    return { host, rank, match, id };
  } catch { throw new ApiError(422, 'INVALID_CURSOR', 'cursor is not a cursor this endpoint returned.', 'cursor'); }
}

type PageRow = { id: string; kind: Kind; match: string; host: string; rank: number; address_id: string | null; domain_id: string | null; catch_all: string | null; route: { id: string; to: string[] | 'drop'; enabled: boolean } | null };
type Slim = { id: string; address: string; displayName: string | null };
type Hook = { id: string; name: string | null; description: string; url: string; event_types: string[]; mailbox_ids: string[] | null; paused: boolean; routes?: number };
type Subscribers = { list: Hook[]; total: number; active: number };
type RoutesResult = { counts: Record<string, number>; page: PageRow[]; boxes: { row: MailboxRow; addresses: { address: string; kind: string }[]; stat: { threads: number; unread: number; last: string | null } | null }[]; dest_boxes: Slim[]; dest_endpoints: EndpointRow[]; dest_hooks: Hook[]; subscribers: Record<string, Subscribers> };
type WorkspaceResult = { config: { rituals?: { key: string }[]; attachments?: { ritual: string; target: string }[] } | null; programs: Programs | null; endpoints: (EndpointRow & { routes: number; listed: boolean })[]; endpoints_more: boolean; endpoint_hooks: Pick<Hook, 'id' | 'event_types' | 'mailbox_ids'>[]; hooks: Hook[]; hooks_more: boolean; keyed: (Slim & { key: string })[]; domains: { id: string; name: string; status: string; catchAll: string }[] };

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
    to: z.array(Target).describe(`Where its mail goes: routing first, then active webhook subscribers, then what attached rituals can send it to, then paused subscribers. Routing and ritual targets are always complete; subscribers are listed up to ${OVERVIEW_SUBSCRIBERS}, active ones first.`),
    toTotal: z.number().int().describe('Targets in the complete list. Larger than to.length only when toTruncated.'),
    toTruncated: z.boolean().describe(`True when the address has more than ${OVERVIEW_SUBSCRIBERS} webhook subscribers, so to is not the whole list.`),
    toMore: z.string().nullable().describe('When toTruncated: the API path that lists every webhook subscribed to this address (listInboundWebhooks with addressId and eventType=message.received; follow nextCursor).'),
  }).openapi('InboundOverviewRoute');
  const OverviewDomain = z.object({
    id: z.string().describe('Bane domain ID.'), name: z.string().describe('Receiving host: the domain, or the subdomain it receives at.'),
    status: deps.InboundDomainStatus, catchAll: deps.InboundCatchAll,
  }).openapi('InboundOverviewDomain');
  const Overview = z.object({
    counts: z.object({ address: z.number().int(), auto: z.number().int().describe('Addresses a catch-all created (origin auto).'), route: z.number().int(), pattern: z.number().int(), catch_all: z.number().int(), inbox: z.number().int() })
      .describe('Routes per kind, after the domain and q filters and before kind and origin.'),
    routes: z.object({ data: z.array(RouteEntry), nextCursor: z.string().nullable() }),
    rituals: z.array(z.object({ key: z.string(), calls: z.array(z.string()).describe('Endpoint names it can call.'), delivers: z.array(z.string()).describe('Inbox keys it can deliver to.'), omens: z.array(z.string()), attachedTo: z.array(z.string()).describe('Address IDs or addresses it runs on.') })),
    endpoints: z.array(OverviewEndpoint).describe(`At most ${OVERVIEW_ENDPOINTS} endpoints (by name) and ${OVERVIEW_ENDPOINTS} inbound webhooks.`),
    endpointsTruncated: z.boolean().describe(`True when the workspace has more endpoints or inbound webhooks than listed. Read them all with listEndpoints and listInboundWebhooks, following nextCursor until it is null.`),
    domains: z.array(OverviewDomain).describe('Every domain with its receiving status, including domains that only send.'),
    manage: z.boolean().describe('False for members and scoped keys: they see their addresses, without routes, rituals, endpoints or domains.'),
  }).openapi('InboundOverview');

  app.openapi(createRoute({
    method: 'get', path: '/v1/inbound/overview', operationId: 'getInboundOverview', tags: ['Inbound addresses'], security: deps.security,
    summary: 'Every route mail can take, with its rituals and endpoints, in one read',
    description: 'One page of routes (addresses, agent inboxes, address patterns, explicit routes and catch-alls) merged and ordered by host, kind and address, each resolved to the rituals that run on it and where its mail goes. Also returns counts per kind, the rituals, up to 100 endpoints and 100 inbound webhooks, and the domains. Members and scoped keys see only their addresses. Requires explicit receiving consent on MCP-derived credentials, like the other receiving reads.',
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

    // Statement 1: counts and one page, with what each page row refers to. Routes, address patterns, domain defaults and
    // webhook subscriptions are admin data; members list their own addresses.
    const routes = (await c.env.db.execute<RoutesResult>(sql`/* inbound-overview: routes */
      WITH e AS (
        SELECT m.id, CASE WHEN m.kind='inbox' THEN 'inbox' ELSE 'address' END AS kind, m.origin, m.address AS match, split_part(m.address,'@',2) AS host,
          CASE WHEN m.kind='inbox' THEN 3 WHEN m.origin='auto' THEN 4 ELSE 0 END AS rank, m.id AS address_id, NULL::text AS route_id, NULL::text AS domain_id, NULL::text AS catch_all, m.display_name
        FROM mailboxes m WHERE m.workspace_id=${w} AND (m.delete_after IS NULL OR m.delete_after>statement_timestamp())
          AND (${scope === null}::boolean OR m.id = ANY(${textArray(scope ?? [])}))
        UNION ALL
        SELECT m.id||':'||r, 'pattern', 'api', r, split_part(r,'@',2), 2, m.id, NULL::text, NULL::text, NULL::text, m.display_name
        FROM mailboxes m CROSS JOIN LATERAL jsonb_array_elements_text(m.rules) r
        WHERE m.workspace_id=${w} AND (${scope === null}::boolean OR m.id = ANY(${textArray(scope ?? [])}))
        UNION ALL
        SELECT r.id, CASE WHEN starts_with(r.match,'*@') THEN 'catch_all' WHEN position('*' IN r.match)>0 THEN 'pattern' ELSE 'route' END, 'api', r.match, split_part(r.match,'@',2),
          CASE WHEN starts_with(r.match,'*@') THEN 5 WHEN position('*' IN r.match)>0 THEN 2 ELSE 1 END, NULL::text, r.id, NULL::text, NULL::text, NULL::text
        FROM mail_routes r WHERE ${manage}::boolean AND r.workspace_id=${w}
          AND NOT EXISTS (SELECT FROM mailbox_addresses a WHERE a.workspace_id=${w} AND a.address=r.match AND a.kind<>'public')
        UNION ALL
        SELECT 'default:'||d.domain_id, 'catch_all', 'api', '*@'||coalesce(d.receiving_host,d.name), coalesce(d.receiving_host,d.name), 5, NULL::text, NULL::text, d.domain_id, d.catch_all, NULL::text
        FROM mailbox_domains d WHERE ${manage}::boolean AND d.workspace_id=${w} AND d.parent_id IS NULL AND d.status='active'
          AND NOT EXISTS (SELECT FROM mail_routes r WHERE r.workspace_id=${w} AND r.match='*@'||coalesce(d.receiving_host,d.name))
      ), f AS (
        SELECT * FROM e WHERE (${host}::text IS NULL OR e.host=${host})
          AND (${needle}::text IS NULL OR lower(e.match) LIKE ${needle} OR lower(coalesce(e.display_name,'')) LIKE ${needle}
            OR (e.address_id IS NOT NULL AND EXISTS (SELECT FROM mailbox_addresses a WHERE a.workspace_id=${w} AND a.mailbox_id=e.address_id AND a.kind='alias' AND a.address LIKE ${needle})))
      ), p AS (
        SELECT f.* FROM f WHERE f.kind = ANY(${textArray(kinds)}) AND (${q.origin ?? null}::text IS NULL OR f.kind<>'address' OR f.origin=${q.origin ?? null})
          AND (${after === null}::boolean OR (f.host, f.rank, f.match, f.id) > (${after?.host ?? ''}::text, ${after?.rank ?? 0}::int, ${after?.match ?? ''}::text, ${after?.id ?? ''}::text))
        ORDER BY f.host, f.rank, f.match, f.id LIMIT ${q.limit + 1}
      ), pr AS (
        SELECT p.*, r.id AS rid, r.destinations AS rto, r.enabled AS ren FROM p LEFT JOIN LATERAL (
          SELECT r.id, r.destinations, r.enabled FROM mail_routes r WHERE ${manage}::boolean AND r.workspace_id=${w}
            AND (r.id=p.route_id OR (p.kind IN ('address','inbox') AND r.match=p.match)) LIMIT 1) r ON true
      ), dest AS (
        SELECT DISTINCT d FROM pr CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(pr.rto)='array' THEN pr.rto ELSE '[]'::jsonb END) d
      ), ids AS (SELECT DISTINCT address_id AS id FROM p WHERE address_id IS NOT NULL
      ), cand AS (
        -- Every webhook (keyed or not) that gets message.received for some page address, exactly the set
        -- listInboundWebhooks?addressId=&eventType=message.received lists: one scan of the workspace's webhooks.
        SELECT h.id,h.name,h.description,h.url,h.event_types,h.mailbox_ids,h.paused FROM mailbox_webhooks h
        WHERE ${manage}::boolean AND h.workspace_id=${w} AND NOT starts_with(h.id,'con_')
          AND h.event_types ? 'message.received' AND (h.mailbox_ids IS NULL OR h.mailbox_ids ?| ARRAY(SELECT id FROM ids))
      )
      SELECT
        (SELECT coalesce(jsonb_object_agg(k, n),'{}'::jsonb) FROM (SELECT CASE WHEN kind='address' AND origin='auto' THEN 'auto' ELSE kind END AS k, count(*)::int AS n FROM f GROUP BY 1) x) AS counts,
        (SELECT coalesce(jsonb_agg(jsonb_build_object('id',pr.id,'kind',pr.kind,'match',pr.match,'host',pr.host,'rank',pr.rank,'address_id',pr.address_id,'domain_id',pr.domain_id,'catch_all',pr.catch_all,
          'route',CASE WHEN pr.rid IS NULL THEN NULL ELSE jsonb_build_object('id',pr.rid,'to',pr.rto,'enabled',pr.ren) END) ORDER BY pr.host,pr.rank,pr.match,pr.id),'[]'::jsonb) FROM pr) AS page,
        (SELECT coalesce(jsonb_agg(jsonb_build_object(
          'row', jsonb_build_object('id',m.id,'workspaceId',m.workspace_id,'key',m.key,'domainId',m.domain_id,'address',m.address,'displayName',m.display_name,'rules',m.rules,'metadata',m.metadata,
            'origin',m.origin,'sendLimits',m.send_limits,'requireDmarc',m.require_dmarc,'expiresAt',m.expires_at::text,'kind',m.kind,'deleteAfter',m.delete_after::text,'createdAt',m.created_at::text,'updatedAt',m.updated_at::text),
          'addresses', (SELECT coalesce(jsonb_agg(jsonb_build_object('address',a.address,'kind',a.kind)),'[]'::jsonb) FROM mailbox_addresses a WHERE a.mailbox_id=m.id),
          'stat', (SELECT jsonb_build_object('threads',count(*)::int,'unread',(count(*) FILTER (WHERE t.unread_count>0))::int,'last',max(t.last_message_at)::text) FROM mailbox_threads t WHERE t.mailbox_id=m.id AND t.trashed_at IS NULL))),'[]'::jsonb)
          FROM mailboxes m WHERE m.workspace_id=${w} AND m.id IN (SELECT id FROM ids)) AS boxes,
        (SELECT coalesce(jsonb_agg(jsonb_build_object('id',m.id,'address',m.address,'displayName',m.display_name)),'[]'::jsonb)
          FROM mailboxes m WHERE m.workspace_id=${w} AND m.id IN (SELECT d FROM dest) AND m.id NOT IN (SELECT id FROM ids)) AS dest_boxes,
        (SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) FROM (SELECT e.* FROM ${endpointSource(w)} e WHERE e.hook_id IN (SELECT d FROM dest)) x) AS dest_endpoints,
        (SELECT coalesce(jsonb_agg(to_jsonb(h)),'[]'::jsonb) FROM (
          SELECT h.id,h.name,h.description,h.url,h.event_types,h.mailbox_ids,h.paused FROM mailbox_webhooks h
          WHERE ${manage}::boolean AND h.workspace_id=${w} AND NOT starts_with(h.id,'con_') AND h.id IN (SELECT d FROM dest)) h) AS dest_hooks,
        -- Per page address: its webhook subscribers, active before paused, at most OVERVIEW_SUBSCRIBERS, and exact totals.
        (SELECT coalesce(jsonb_object_agg(i.id, jsonb_build_object('list', x.list, 'total', n.total, 'active', n.active)),'{}'::jsonb) FROM ids i
          CROSS JOIN LATERAL (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.paused, c.id),'[]'::jsonb) AS list FROM (
            SELECT * FROM cand c WHERE c.mailbox_ids IS NULL OR c.mailbox_ids ? i.id ORDER BY c.paused, c.id LIMIT ${OVERVIEW_SUBSCRIBERS}) c) x
          CROSS JOIN LATERAL (SELECT count(*)::int AS total, (count(*) FILTER (WHERE NOT c.paused))::int AS active FROM cand c WHERE c.mailbox_ids IS NULL OR c.mailbox_ids ? i.id) n) AS subscribers`)).rows[0]!;
    const page = routes.page.slice(0, q.limit), last = routes.page.length > q.limit ? page.at(-1)! : null;
    const counts = { address: 0, auto: 0, route: 0, pattern: 0, catch_all: 0, inbox: 0, ...routes.counts };

    // Statement 2 (managers): the workspace side, bounded by OVERVIEW_ENDPOINTS and the API's own limits (50 rituals,
    // 256 attachments). Route counts come from one probe of the destinations GIN index for all listed endpoints.
    let ws: WorkspaceResult = { config: null, programs: null, endpoints: [], endpoints_more: false, endpoint_hooks: [], hooks: [], hooks_more: false, keyed: [], domains: [] };
    if (manage) {
      c.env = await withRegionSettings(c.env, w);
      ws = (await c.env.db.execute<WorkspaceResult>(sql`/* inbound-overview: workspace */
        WITH cfg AS (SELECT config, programs FROM mail_ritual_configs WHERE workspace_id=${w}),
        refs AS (SELECT DISTINCT ref FROM cfg CROSS JOIN LATERAL jsonb_each(coalesce(cfg.programs->'rituals','{}'::jsonb)) r(k, ir)
          CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(r.ir->'refs','[]'::jsonb)) ref),
        first AS (SELECT e.* FROM ${endpointSource(w)} e ORDER BY e.name LIMIT ${OVERVIEW_ENDPOINTS + 1}),
        named AS (SELECT e.* FROM ${endpointSource(w)} e WHERE 'endpoint:'||e.name IN (SELECT ref FROM refs)),
        eps AS (SELECT * FROM first UNION SELECT * FROM named),
        hk AS (SELECT h.id,h.name,h.description,h.url,h.event_types,h.mailbox_ids,h.paused FROM mailbox_webhooks h
          WHERE h.workspace_id=${w} AND h.key IS NULL AND NOT starts_with(h.id,'con_')
            AND NOT EXISTS (SELECT FROM mail_endpoints d WHERE d.workspace_id=${w} AND d.hook_id=h.id) ORDER BY h.paused, h.id DESC LIMIT ${OVERVIEW_ENDPOINTS + 1}), -- active first, then listInboundWebhooks' order
        listed AS (SELECT hook_id AS id FROM eps UNION SELECT id FROM hk),
        -- One probe of the destinations index for every listed endpoint at once; only routes that name one are unnested.
        usage AS (SELECT d AS id, count(*)::int AS n FROM mail_routes r CROSS JOIN LATERAL jsonb_array_elements_text(r.destinations) d
          WHERE r.workspace_id=${w} AND jsonb_typeof(r.destinations)='array' AND r.destinations ?| ARRAY(SELECT id FROM listed) AND d IN (SELECT id FROM listed) GROUP BY d)
        SELECT
          (SELECT config FROM cfg) AS config, (SELECT programs FROM cfg) AS programs,
          (SELECT coalesce(jsonb_agg(to_jsonb(eps) || jsonb_build_object('listed', eps.hook_id IN (SELECT hook_id FROM first),
            'routes', coalesce((SELECT n FROM usage WHERE usage.id=eps.hook_id),0))),'[]'::jsonb) FROM eps) AS endpoints,
          (SELECT count(*) > ${OVERVIEW_ENDPOINTS} FROM first) AS endpoints_more,
          (SELECT coalesce(jsonb_agg(jsonb_build_object('id',h.id,'event_types',h.event_types,'mailbox_ids',h.mailbox_ids)),'[]'::jsonb)
            FROM mailbox_webhooks h WHERE h.workspace_id=${w} AND h.id IN (SELECT hook_id FROM eps)) AS endpoint_hooks,
          (SELECT coalesce(jsonb_agg(to_jsonb(hk) || jsonb_build_object('routes', coalesce((SELECT n FROM usage WHERE usage.id=hk.id),0)) ORDER BY hk.paused, hk.id DESC),'[]'::jsonb) FROM hk) AS hooks,
          (SELECT count(*) > ${OVERVIEW_ENDPOINTS} FROM hk) AS hooks_more,
          (SELECT coalesce(jsonb_agg(jsonb_build_object('id',m.id,'key',m.key,'address',m.address,'displayName',m.display_name)),'[]'::jsonb)
            FROM mailboxes m WHERE m.workspace_id=${w} AND m.key IN (SELECT substr(ref,7) FROM refs WHERE starts_with(ref,'inbox:'))) AS keyed,
          (SELECT coalesce(jsonb_agg(jsonb_build_object('id',d.id,'name',coalesce(md.receiving_host,d.name),'status',coalesce(md.status,'off'),
            'catchAll',CASE WHEN md.catch_all IN ('create_mailbox','create_address') THEN 'create_address' ELSE 'store' END) ORDER BY d.name),'[]'::jsonb)
            FROM ${domains} d LEFT JOIN mailbox_domains md ON md.workspace_id=${w} AND md.domain_id=d.id AND md.parent_id IS NULL
            WHERE d.workspace_id=${w} AND d.region = ANY(${textArray(c.env.config.regions)})) AS domains`)).rows[0]!;
    }

    // Everything below is assembly from the two results; no more reads.
    const views = new Map(routes.boxes.map(b => { const v = deps.mailboxView(b.row, b.addresses, b.stat ?? undefined); return [v.id as string, v]; }));
    const slim = new Map<string, Slim>([...routes.dest_boxes.map(b => [b.id, b] as const), ...ws.keyed.map(b => [b.id, b] as const)]);
    const programs = ws.programs?.rituals ?? {};
    const attachments = ws.config?.attachments ?? [];
    const endpointRows = [...routes.dest_endpoints, ...ws.endpoints];
    const endpointViews = new Map<string, { view: z.infer<typeof Endpoint>; hook: string }>();
    for (const row of endpointRows) if (!endpointViews.has(row.hook_id)) endpointViews.set(row.hook_id, { view: await endpointView(c.env, w, row), hook: row.hook_id });
    const endpointByName = new Map([...endpointViews.values()].map(e => [e.view.name, e]));
    const hookById = new Map([...routes.dest_hooks, ...ws.hooks].map(h => [h.id, h]));
    const boxByKey = new Map(ws.keyed.map(b => [b.key, b]));

    type T = z.infer<typeof Target>;
    const inboxTarget = (v: { id: string; address: string; displayName?: string | null }, via: string | null = null): T => ({ type: 'inbox', id: v.id, name: v.displayName || v.address, detail: v.address, via, status: null });
    const endpointTarget = (e: { view: z.infer<typeof Endpoint>; hook: string }, via: string | null = null): T => ({ type: e.view.type, id: e.hook, name: e.view.name, detail: e.view.target, via, status: e.view.status });
    const hookTarget = (h: Hook): T => ({ type: 'webhook', id: h.id, name: h.description || h.name || webhookUrlHint(h.url), detail: webhookUrlHint(h.url), via: null, status: h.paused ? 'paused' : null });
    const resolve = (id: string): T | null => {
      const v = (views.get(id) as Slim | undefined) ?? slim.get(id); if (v) return inboxTarget(v);
      const e = endpointViews.get(id); if (e) return endpointTarget(e);
      const h = hookById.get(id); return h ? hookTarget(h) : null;
    };
    const ritualsFor = (targets: string[]) => [...new Set(attachments.filter(a => targets.includes(a.target)).map(a => a.ritual))];
    const viaRituals = (ritualKeys: string[]) => ritualKeys.flatMap(k => (programs[k]?.refs ?? []).map(ref => {
      if (ref.startsWith('endpoint:')) { const e = endpointByName.get(ref.slice(9)); return e ? endpointTarget(e, k) : null; }
      const v = boxByKey.get(ref.slice(6)); return v ? inboxTarget(v, k) : null;
    })).filter((t): t is T => !!t);
    const merge = (base: T[], extra: T[]) => [...base, ...extra].filter((t, i, all) => all.findIndex(x => x.type === t.type && x.id === t.id) === i);
    // What each webhook a route or ritual names is subscribed to, so a subscriber that is also one of those counts once.
    const hookInfo = new Map<string, Pick<Hook, 'event_types' | 'mailbox_ids'>>([...routes.dest_hooks, ...ws.endpoint_hooks].map(h => [h.id, h]));
    const subscribes = (h: Pick<Hook, 'event_types' | 'mailbox_ids'> | undefined, addressId: string) => !!h && h.event_types.includes('message.received') && (h.mailbox_ids === null || h.mailbox_ids.includes(addressId));
    const subscriberTarget = (h: Hook): T => { const e = endpointViews.get(h.id); return e ? endpointTarget(e) : hookTarget(h); };
    /** An address's complete list: routing, active subscribers, ritual targets, paused subscribers; and whether it is all here. */
    const destinations = (addressId: string, routing: T[], via: T[]) => {
      const s = routes.subscribers[addressId] ?? { list: [], total: 0, active: 0 };
      const to = merge(merge(merge(routing, s.list.filter(h => !h.paused).map(subscriberTarget)), via), s.list.filter(h => h.paused).map(subscriberTarget));
      const named = merge(routing, via);
      const overlap = named.filter(t => t.id && t.type !== 'inbox' && subscribes(hookInfo.get(t.id), addressId)).length;
      const toTotal = named.length + s.total - overlap;
      return { to, toTotal, toTruncated: toTotal > to.length, toMore: toTotal > to.length ? `/v1/inbound/webhooks?addressId=${encodeURIComponent(addressId)}&eventType=message.received` : null };
    };
    const complete = (to: T[]) => ({ to, toTotal: to.length, toTruncated: false, toMore: null });
    const routed = (r: { to: string[] | 'drop' }): T[] => r.to === 'drop' ? [{ type: 'drop', id: null, name: 'Dropped', detail: null, via: null, status: null }]
      : r.to.length ? r.to.map(resolve).filter((t): t is T => !!t) : [{ type: 'store', id: null, name: 'Stored, no inbox', detail: null, via: null, status: null }];

    const data = page.map(r => {
      const v = r.address_id ? views.get(r.address_id) ?? null : null;
      const route = r.route && { id: r.route.id, enabled: r.route.enabled, to: r.route.to };
      if (r.kind === 'address' || r.kind === 'inbox') {
        const ritualKeys = ritualsFor([v!.id, v!.address, ...v!.aliases]);
        return { id: r.id, kind: r.kind, match: r.match, host: r.host, address: v, route, catchAll: null, rituals: ritualKeys,
          ...destinations(v!.id, route?.enabled ? routed(route) : [inboxTarget(v as Slim)], viaRituals(ritualKeys)) };
      }
      if (r.kind === 'pattern' && v) {
        const ritualKeys = ritualsFor([v.id, v.address, ...v.aliases]);
        return { id: r.id, kind: r.kind, match: r.match, host: r.host, address: v, route: null, catchAll: null, rituals: ritualKeys, ...destinations(v.id, [inboxTarget(v as Slim)], viaRituals(ritualKeys)) };
      }
      if (r.domain_id) {
        const catchAll = r.catch_all === 'create_mailbox' || r.catch_all === 'create_address' ? 'create_address' as const : 'store' as const;
        return { id: r.id, kind: r.kind, match: r.match, host: r.host, address: null, route: null, catchAll, rituals: [],
          ...complete([catchAll === 'create_address' ? { type: 'create_address' as const, id: null, name: 'New address per recipient', detail: null, via: null, status: null } : { type: 'store' as const, id: null, name: 'Stored, no inbox', detail: null, via: null, status: null }]) };
      }
      const ritualKeys = ritualsFor([r.match]);
      return { id: r.id, kind: r.kind, match: r.match, host: r.host, address: null, route, catchAll: null, rituals: ritualKeys, ...complete(merge(route ? routed(route) : [], viaRituals(ritualKeys))) };
    });
    const rituals = Object.entries(programs).map(([key, ir]) => ({ key, calls: ir.refs.filter(r => r.startsWith('endpoint:')).map(r => r.slice(9)), delivers: ir.refs.filter(r => r.startsWith('inbox:')).map(r => r.slice(6)),
      omens: Object.keys(ir.omens ?? {}), attachedTo: attachments.filter(a => a.ritual === key).map(a => a.target) }));
    const listed = ws.endpoints.filter(e => e.listed).sort((a, b) => a.name < b.name ? -1 : 1).slice(0, OVERVIEW_ENDPOINTS);
    const endpoints: z.infer<typeof OverviewEndpoint>[] = [
      ...listed.map(row => { const e = endpointViews.get(row.hook_id)!; return { id: e.hook, source: 'endpoint' as const, name: e.view.name, type: e.view.type, status: e.view.status, target: e.view.target, call: e.view.call, eventTypes: [], routes: row.routes, rituals: rituals.filter(r => r.calls.includes(e.view.name)).map(r => r.key) }; }),
      ...ws.hooks.slice(0, OVERVIEW_ENDPOINTS).map(h => ({ id: h.id, source: 'inbound_webhook' as const, name: h.description || h.name || webhookUrlHint(h.url), type: 'webhook' as const, status: h.paused ? 'paused' as const : 'ready' as const, target: webhookUrlHint(h.url), call: null, eventTypes: h.event_types, routes: h.routes ?? 0, rituals: [] })),
    ];
    return c.json({ counts, routes: { data, nextCursor: last ? encode(last) : null }, rituals, endpoints, endpointsTruncated: ws.endpoints_more || ws.hooks_more, domains: ws.domains, manage } as never, 200);
  });
}
