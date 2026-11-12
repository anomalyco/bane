import { createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { retainedMail } from './db/mailbox.js';
import { actor, ApiError, errors, id, json, response, security, type App, type Ctx, type DbExecutor, type Runtime } from './core.js';
import { receivingPolicy } from './mailbox-ingest-input.js';
import { PARSE_LIMIT } from './mailbox-mime.js';
import { ADDRESS, lockMailboxLane } from './mailbox-store.js';
import { matchRouting, ROUTE_TIERS, type RoutingInput } from './routing-match.js';

export const RoutingKey = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
  .describe('Stable key you choose (lowercase letters, digits, hyphens). Config files refer to inbox:<key> and webhook:<key>.');
const Address = z.string().trim().toLowerCase().max(254);
const Destination = z.string().max(128).regex(/^(?:(?:mbx|mwh)_[a-zA-Z0-9_-]+|(?:inbox|webhook):[a-z0-9][a-z0-9-]{0,62})$/).describe('An inbox (mbx_… or inbox:<key>) or a webhook (mwh_… or webhook:<key>).');
const RouteFields = z
  .object({
    key: RoutingKey.nullable().optional(),
    match: Address.describe(
      'Recipient, case-insensitive: an address (support@acme.com), a local-part pattern (reply+*@acme.com, *-invoices@acme.com) or a catch-all (*@acme.com, or @acme.com). The most specific route wins: exact address, then the pattern with the most literal characters, then the plus-address base, then the catch-all, then the domain default.',
    ),
    to: z
      .union([z.literal('drop'), z.array(Destination).max(10)])
      .describe(
        "Up to 10 destinations, [] to keep mail stored without an inbox (readable by ID), or 'drop' to discard it. A route for an inbox's own address replaces its default delivery, so list the inbox to keep it.",
      ),
    subaddresses: z.boolean().optional().describe('Also route user+tag@host here when nothing more specific matches. Default true.'),
    enabled: z.boolean().optional().describe('A disabled route is skipped; its mail falls through to the next tier. Default true.'),
    note: z.string().max(500).optional(),
  })
  .strict();
const MailRoute = RouteFields.extend({
  id: z.string(),
  key: RoutingKey.nullable(),
  to: RouteFields.shape.to.describe("Inbox and webhook IDs, [] to keep, or 'drop'."),
  subaddresses: z.boolean(),
  enabled: z.boolean(),
  note: z.string(),
  createdAt: z.string(),
}).openapi('MailRoute');
type Route = z.infer<typeof MailRoute>;
type RouteInput = z.infer<typeof RouteFields>;
const RoutingConfig = z.object({ version: z.number().int(), routes: z.array(MailRoute) }).openapi('RoutingConfig');
const RoutingConfigFile = z
  .object({ version: z.number().int().optional().describe('Ignored on apply; send the version in If-Match.'), routes: z.array(RouteFields).max(10000) })
  .strict()
  .openapi('RoutingConfigFile');
const RoutingDiff = z.object({ before: MailRoute.nullable(), after: MailRoute.nullable() }).openapi('RoutingDiff');
const RoutingChange = z
  .object({
    version: z.number().int().describe('Routing version after the change; unchanged for a dry run or when nothing changed.'),
    diff: z.array(RoutingDiff).describe('before null: created; after null: deleted.'),
    warnings: z.array(z.string()),
  })
  .openapi('RoutingChange');
const ActorView = z.object({ type: z.string(), id: z.string() });
const RoutingVersion = z
  .object({ version: z.number().int(), createdAt: z.string(), actor: ActorView, changes: z.number().int(), note: z.string().nullable() })
  .openapi('RoutingVersion');
const RoutingAuditEntry = z
  .object({
    version: z.number().int(),
    resourceId: z.string(),
    before: MailRoute.nullable(),
    after: MailRoute.nullable(),
    actor: ActorView,
    requestId: z.string().nullable(),
    note: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi('RoutingAuditEntry');
const Verdict = z.enum(['PASS', 'FAIL', 'GRAY', 'PROCESSING_FAILED']);
const RoutingTest = z
  .object({
    messageId: z.string().max(120).optional().describe('Replay a stored inbound message with its envelope recipients and SES verdicts.'),
    raw: z
      .string()
      .max(Math.ceil(PARSE_LIMIT / 3) * 4)
      .optional()
      .describe('A pasted message: base64 RFC 822 MIME, parsed with the ingest limits. Its To and Cc are the recipients unless envelope.to is set.'),
    envelope: z
      .object({ to: z.array(Address.regex(ADDRESS)).min(1).max(100) })
      .strict()
      .optional()
      .describe('Envelope recipients, including Bcc.'),
    verdicts: z
      .object({ spam: Verdict.optional(), dmarc: Verdict.optional() })
      .strict()
      .optional()
      .describe('SES verdicts for envelope and raw tests. Each defaults to PASS. A stored message uses its own.'),
    config: RoutingConfigFile.optional().describe('Unsaved routes to test instead of the saved ones: a PUT /v1/routing body. Nothing is saved.'),
    version: z.number().int().nonnegative().optional().describe('Test the routes of an earlier version instead of the saved ones.'),
  })
  .strict()
  .openapi('RoutingTest');
const RoutedRecipient = z
  .object({
    address: z.string(),
    tier: z
      .enum(ROUTE_TIERS)
      .describe(
        "What matched: exact (an exact route), address (an inbox's own address or alias), pattern (a local-part pattern), subaddress (the route or inbox of user@ for user+tag@), catchall (*@host) or default (the domain's catch-all setting).",
      ),
    route: z.string().nullable().describe('Route ID; null for an address, an address wildcard rule or the domain default.'),
    inboxes: z.array(z.string()),
    webhooks: z.array(z.string()),
    skipBase:z.literal(true).optional().describe('A base route explicitly disables plus-address fallback.'),
    limited:z.literal(true).optional().describe('Fan-out was capped. The recipient is also recorded as unrouted.'),
    dropped: z.boolean(),
    junk: z.boolean(),
    domainDefault: z.enum(['store', 'create_address']).describe('The domain catch-all setting, used when tier is default.'),
    warnings: z.array(z.string()).describe('Destinations that were skipped, and why.'),
  })
  .openapi('RoutedRecipient');
const RoutingTestResult = z
  .object({
    version: z.number().int().describe('The routing version tested; for unsaved config, the saved version it starts from.'),
    unsaved: z.boolean(),
    verdicts: z.object({ spam: z.string(), dmarc: z.string() }),
    message: z.object({ from: z.string().nullable(), subject: z.string().nullable() }).nullable(),
    recipients: z.array(RoutedRecipient),
  })
  .openapi('RoutingTestResult');

const fail = (status: number, code: string, message: string, field?: string) => new ApiError(status, code, message, field);
const columns = sql`id,key,match,destinations AS "to",subaddresses,enabled,note,created_at::text AS "createdAt"`;
const hostOf = (match: string) => match.split('@')[1]!;
const listRoutes = async (tx: DbExecutor, w: string) =>
  (await tx.execute<Route>(sql`SELECT ${columns} FROM mail_routes WHERE workspace_id=${w} ORDER BY match`)).rows;
const currentVersion = async (tx: DbExecutor, w: string) =>
  (await tx.execute<{ v: number }>(sql`SELECT coalesce((SELECT version FROM mail_routing_state WHERE workspace_id=${w}),0) AS v`)).rows[0]!.v;
/** Read one bounded slice of immutable identities and their version's diff in the same snapshot.
 * The first change AFTER v contains the exact before-image, even after older audit deltas expire. */
async function versionPage(tx:DbExecutor,w:string,v:number,offset:number,size:number){
  if(v===0)return {routes:[] as Route[],diff:[] as z.infer<typeof RoutingDiff>[],nextCursor:null};
  const manifest=(await tx.execute<{routes:Route[];diff:z.infer<typeof RoutingDiff>[];more:boolean}>(sql`
    SELECT cardinality(route_ids)>${offset+size} OR cardinality(changed_ids)>${offset+size} AS more,
      coalesce((SELECT jsonb_agg(coalesce(change.before,to_jsonb(live)) ORDER BY ord) FROM unnest(route_ids[${offset+1}:${offset+size}]) WITH ORDINALITY ids(ref,ord)
        LEFT JOIN LATERAL (SELECT a.before FROM mail_routing_audit a WHERE a.workspace_id=${w} AND a.resource_id=ref AND a.version>${v} ORDER BY a.version LIMIT 1) change ON true
        LEFT JOIN LATERAL (SELECT ${columns} FROM mail_routes r WHERE r.workspace_id=${w} AND r.id=ref) live ON change.before IS NULL),'[]') AS routes,
      coalesce((SELECT jsonb_agg(jsonb_build_object('before',a.before,'after',a.after) ORDER BY ord) FROM unnest(changed_ids[${offset+1}:${offset+size}]) WITH ORDINALITY ids(ref,ord)
        JOIN mail_routing_audit a ON a.workspace_id=${w} AND a.version=${v} AND a.resource_id=ref),'[]') AS diff
    FROM mail_routing_versions WHERE workspace_id=${w} AND version=${v} AND created_at>=now()-interval '1 year'`)).rows[0];
  if(!manifest)throw fail(410,'VERSION_EXPIRED','This version is no longer retained (one year or 256 versions).');
  return {routes:manifest.routes,diff:manifest.diff,nextCursor:manifest.more?String(offset+size):null};
}
async function historical(tx:DbExecutor,w:string,v:number){
  const routes:Route[]=[];let next:string|null='0';do{const page=await versionPage(tx,w,v,Number(next),256);routes.push(...page.routes);next=page.nextCursor;}while(next);return routes;
}
/** Opts a workspace into the routed store without changing routing (the version stays the same). */
export const enableRouting = (tx: DbExecutor, w: string) =>
  tx.execute(sql`INSERT INTO mail_routing_state(workspace_id) VALUES(${w}) ON CONFLICT DO NOTHING`);

function findRoute(routes: Route[], ref: string) {
  const route = routes.find((r) => r.id === ref || r.key === ref);
  if (!route) throw fail(404, 'NOT_FOUND', `Route ${ref} was not found. List routes with GET /v1/routing/routes.`);
  return route;
}
function makeRoute(fields: RouteInput, previous?: Route): Route {
  return {
    id: previous?.id ?? id('rte'),
    createdAt: previous?.createdAt ?? new Date().toISOString(),
    key: null,
    enabled: true,
    subaddresses: true,
    note: '',
    ...fields,
    match: fields.match.replace(/^@/, '*@'),
  };
}
/** A config entry updates the route with its key, or else the keyless route with its match. */
function applyEntries(routes:Route[],entries:RouteInput[]){
  const byKey=new Map(routes.filter(r=>r.key).map(r=>[r.key,r])),byMatch=new Map(routes.map(r=>[r.match,r]));
  return entries.map(f=>{const sameMatch=byMatch.get(f.match.replace(/^@/,'*@'));return makeRoute(f,(f.key?byKey.get(f.key):undefined)??(!f.key||!sameMatch?.key?sameMatch:undefined));});
}
const referenceSet=(routes:RouteInput[])=>new Set(routes.flatMap(r=>Array.isArray(r.to)?r.to:[]));
function checkReferenceBudget(routes:RouteInput[]){if(referenceSet(routes).size>1000)throw fail(422,'DESTINATION_LIMIT','At most 1,000 distinct destinations per request.','to');}
const same = (a: Route | undefined, b: Route) =>
  !!a && (['key', 'match', 'to', 'enabled', 'subaddresses', 'note'] as const).every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));

function checkRoutes(routes: Route[]) {
  const matches = new Map<string, Route>(),
    keys = new Set<string>(),
    patterns = new Map<string, number>();
  const ids=new Set<string>();
  let exact = 0;
  for (const r of routes) {
    if(ids.has(r.id))throw fail(409,'ROUTE_CONFLICT','Two entries update the same route.');ids.add(r.id);
    if (/^[*]{2,}@/.test(r.match) || !ADDRESS.test(r.match) || hostOf(r.match).includes('*'))
      throw fail(
        422,
        'INVALID_MATCH',
        `"${r.match}" is not a valid match. Use an address (support@acme.com), a local-part pattern (reply+*@acme.com) or a catch-all (*@acme.com).`,
        'match',
      );
    const other = matches.get(r.match);
    if (other)
      throw fail(409, 'ROUTE_CONFLICT', `Route ${other.key ?? other.id} already matches ${r.match}. Add the destinations to that route instead.`, 'match');
    if (r.key && keys.has(r.key)) throw fail(409, 'ROUTE_CONFLICT', `Route key ${r.key} is used twice. Keys must be unique.`, 'key');
    matches.set(r.match, r);
    if (r.key) keys.add(r.key);
    if (!r.match.includes('*')) {
      if (++exact > 10000) throw fail(409, 'ROUTE_LIMIT', 'A workspace has at most 10,000 exact routes. Use a pattern or catch-all route.');
      continue;
    }
    const n = (patterns.get(hostOf(r.match)) ?? 0) + 1;
    if (n > 64) throw fail(409, 'ROUTE_LIMIT', `${hostOf(r.match)} has more than 64 pattern routes, the limit per host.`);
    patterns.set(hostOf(r.match), n);
  }
}
/** Replaces keys with IDs in place. Leniently (restores), drops destinations that no longer exist instead of failing. */
async function resolveDestinations(tx: DbExecutor, w: string, routes: Route[], lenient: boolean) {
  const refs = [...referenceSet(routes)],
    warnings: string[] = [];
  if (!refs.length) return warnings;
  const found = new Map(
    (
      await tx.execute<{ ref: string; id: string }>(
        sql`WITH refs AS MATERIALIZED (SELECT ref,split_part(ref,':',2) AS key FROM jsonb_array_elements_text(${JSON.stringify(refs)}::jsonb) ref)
          SELECT ref,b.id FROM refs JOIN mailboxes b ON b.workspace_id=${w} AND b.id=ref WHERE starts_with(ref,'mbx_')
          UNION ALL SELECT ref,b.id FROM refs JOIN mailboxes b ON b.workspace_id=${w} AND b.key=refs.key WHERE starts_with(ref,'inbox:')
          UNION ALL SELECT ref,h.id FROM refs JOIN mailbox_webhooks h ON h.workspace_id=${w} AND h.id=ref WHERE starts_with(ref,'mwh_')
          UNION ALL SELECT ref,h.id FROM refs JOIN mailbox_webhooks h ON h.workspace_id=${w} AND h.key=refs.key WHERE starts_with(ref,'webhook:')`,
      )
    ).rows.map((d) => [d.ref, d.id]),
  );
  for (const r of routes) {
    if (!Array.isArray(r.to)) continue;
    const missing = r.to.filter((ref) => !found.has(ref));
    if (missing.length && !lenient)
      throw fail(
        422,
        'UNKNOWN_DESTINATION',
        `${missing[0]} is not an inbox or webhook in this workspace. Use an ID from listInboundAddresses or listInboundWebhooks, or a key such as inbox:support.`,
        'to',
      );
    for (const ref of missing) warnings.push(`Removed ${ref} from ${r.match}: it no longer exists.`);
    r.to = [...new Set(r.to.flatMap((ref) => found.get(ref) ?? []))];
  }
  return warnings;
}

/** Validates and writes a whole route set as one version: rows, one audit row per changed route, and the affected host plans. */
async function save(
  tx: DbExecutor,
  c: Ctx,
  w: string,
  version: number,
  before: Route[],
  after: Route[],
  { dryRun = false, lenient = false, note = '' } = {},
) {
  if(after.length>10000)throw fail(422,'ROUTE_LIMIT','A workspace supports at most 10,000 routes.');
  checkRoutes(after);
  const previous = new Map(before.map((r) => [r.id, r])),
    kept = new Set(after.map((r) => r.id));
  const warnings = await resolveDestinations(
    tx,
    w,
    after.filter((r) => !same(previous.get(r.id), r)),
    lenient,
  );
  const diff = [
    ...before.filter((r) => !kept.has(r.id)).map((r) => ({ before: r, after: null })),
    ...after.filter((r) => !same(previous.get(r.id), r)).map((r) => ({ before: previous.get(r.id) ?? null, after: r })),
  ];
  if (!diff.length) return { version, diff, warnings };
  const routes = diff.flatMap((d) => [d.before, d.after]).filter((r): r is Route => !!r);
  const domains = new Map(
    (
      await tx.execute<{ id: string; host: string }>(
        sql`SELECT id,coalesce(receiving_host,name) AS host FROM mailbox_domains WHERE workspace_id=${w} AND coalesce(receiving_host,name) IN (SELECT jsonb_array_elements_text(${JSON.stringify([...new Set(routes.map((r) => hostOf(r.match)))])}::jsonb))`,
      )
    ).rows.map((d) => [d.host, d.id]),
  );
  for (const { after: r } of diff)
    if (r && !domains.has(hostOf(r.match)))
      throw fail(
        422,
        'UNKNOWN_HOST',
        `${hostOf(r.match)} is not a receiving domain in this workspace. Check the spelling, or enable receiving for it first.`,
        'match',
      );
  if (dryRun) return { version, diff, warnings };
  const [{ next }] = (
    await tx.execute<{ next: number }>(
      sql`INSERT INTO mail_routing_state(workspace_id,version) VALUES(${w},1) ON CONFLICT(workspace_id) DO UPDATE SET version=mail_routing_state.version+1 RETURNING version AS next`,
    )
  ).rows as [{ next: number }];
  await tx.execute(
    sql`DELETE FROM mail_routes WHERE workspace_id=${w} AND id IN (SELECT jsonb_array_elements_text(${JSON.stringify(diff.map((d) => (d.before ?? d.after)!.id))}::jsonb))`,
  );
  const rows = diff.flatMap((d) => (d.after ? [{ ...d.after, domain: domains.get(hostOf(d.after.match)) }] : []));
  await tx.execute(
    sql`INSERT INTO mail_routes(id,workspace_id,key,domain_id,match,destinations,subaddresses,enabled,note,created_at) SELECT id,${w},key,domain,match,"to",subaddresses,enabled,note,"createdAt" FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(id text,key text,domain text,match text,"to" jsonb,subaddresses boolean,enabled boolean,note text,"createdAt" timestamptz)`,
  );
  const who = c.get('actor');if(who.grantId&&rows.length)await (await import('./rituals.js')).ownReceiving(tx,c,'route',rows.map(r=>r.id));
  await tx.execute(sql`INSERT INTO mail_routing_versions(workspace_id,version,route_ids,changed_ids,actor_type,actor_id,note)
    VALUES(${w},${next},ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(after.map(r=>r.id).sort())}::jsonb)),ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(diff.map(d=>(d.before??d.after)!.id).sort())}::jsonb)),${who.credential??'apiKey'},${who.keyId},${note||null})`);
  // At most one retired manifest on a normal write; its audit rows share the same transaction.
  await tx.execute(sql`DELETE FROM mail_routing_versions WHERE workspace_id=${w} AND version<=${next-256}`);
  await tx.execute(
    sql`INSERT INTO mail_routing_audit(workspace_id,version,resource_id,before,after,actor_type,actor_id,request_id,note) SELECT ${w},${next},coalesce(before->>'id',after->>'id'),before,after,${who.credential ?? 'apiKey'},${who.keyId},${c.get('requestId')},${note || null} FROM jsonb_to_recordset(${JSON.stringify(diff)}::jsonb) x(before jsonb,after jsonb)`,
  );
  // Exact routes are point lookups; only pattern and catch-all changes rewrite their host's plan.
  for (const domain of new Set(routes.filter((r) => r.match.includes('*')).map((r) => domains.get(hostOf(r.match)))))
    if (domain) await tx.execute(sql`SELECT mail_compile_routes(${w},${domain})`);
  return { version: next, diff, warnings };
}
/** Removes a deleted inbox or webhook from every route, as one routing version, or refuses without ?detach=true. */
export async function detachDestination(tx: DbExecutor, c: Ctx, w: string, destination: string) {
  await lockMailboxLane(tx, w, 'address');
  const using = (
    await tx.execute<{ match: string }>(sql`SELECT match FROM mail_routes WHERE workspace_id=${w} AND destinations ? ${destination} ORDER BY match LIMIT 3`)
  ).rows.map((r) => r.match);
  if (!using.length) return;
  if (c.req.query('detach') !== 'true')
    throw fail(
      409,
      'REFERENCED',
      `Routes for ${using.join(', ')}${using.length === 3 ? ' and more' : ''} deliver to ${destination}. Delete with ?detach=true to remove it from those routes too, or change the routes first.`,
    );
  if (c.get('actor').grantId)throw fail(403,'ADMIN_REQUIRED','Delegated credentials cannot detach route destinations.');
  const routes = await listRoutes(tx, w);
  await save(
    tx,
    c,
    w,
    await currentVersion(tx, w),
    routes,
    routes.map((r) => (Array.isArray(r.to) && r.to.includes(destination) ? { ...r, to: r.to.filter((id) => id !== destination) } : r)),
    { note: `Detach ${destination}` },
  );
}
class RolledBack<T> extends Error {
  constructor(readonly value: T) {
    super('Rolled back');
  }
}
/** Runs work in a transaction and always rolls it back: dry runs exercise the real write path without keeping it. */
export async function rolledBack<T>(db: Runtime['db'], work: (tx: DbExecutor) => Promise<T>): Promise<T> {
  try {
    await db.transaction(async (tx) => {
      throw new RolledBack(await work(tx));
    });
  } catch (error) {
    if (error instanceof RolledBack) return error.value as T;
    throw error;
  }
  throw new Error('Rolled-back transaction committed.');
}
type MimeAddress = { address?: string; group?: MimeAddress[] };
const addressesOf = (list: MimeAddress[] | undefined): string[] =>
  (list ?? []).flatMap((a) => (a.group ? addressesOf(a.group) : a.address ? [a.address.trim().toLowerCase()] : []));

export function registerRouting(app: App) {
  const path = '/v1/routing',
    meta = { security, tags: ['Routing'] };
  // Each operation says whether it only reads. With receiving consent, reads and the dry run need
  // read; every change needs manage.
  const workspace = (c: Ctx, read = c.req.method === 'GET') => {
    const a=actor(c,c.get('actor')?.receivingConsent&&read?'read':'manage');
    if (a.domains.length || a.role === 'member')
      throw fail(
        403,
        'ADMIN_REQUIRED',
        'Routing covers every address in the workspace. Use an owner or admin session, or an API key with manage permission on all domains.',
      );
    return a.workspaceId;
  };
  const edit = async (
    c: Ctx,
    change: (routes: Route[], tx: DbExecutor, version: number) => Route[] | Promise<Route[]>,
    options: Parameters<typeof save>[6] = {},
  ) => {
    const w = workspace(c, false);
    if (c.get('actor').credential==='agentToken'||(c.get('actor').grantId&&!c.get('actor').receivingConsent))
      throw fail(403, 'ADMIN_REQUIRED', 'MCP and agent credentials can read and test routing, not change it. Change routes in the dashboard or with an API key.');
    const result = await c.env.db.transaction(async (tx) => {
      await lockMailboxLane(tx, w, 'address');
      // Hold the approval before any route row: a removal disables an approval's routes after it has taken the approval.
      if (c.get('actor').grantId) await (await import('./rituals.js')).holdReceiving(tx, c);
      const version = await currentVersion(tx, w),
        expected = c.req.header('if-match')?.replace(/^W\//, '').replace(/^"(.*)"$/, '$1');
      if (expected !== undefined && expected !== '*' && expected !== String(version))
        throw fail(
          409,
          'VERSION_CONFLICT',
          `Routing is at version ${version}, not ${expected}. Read GET /v1/routing again, reapply your change and send If-Match: "${version}".`,
        );
      const routes = await listRoutes(tx, w);
      return save(tx, c, w, version, routes, await change(routes, tx, version), options);
    });
    c.header('ETag', `"${result.version}"`);
    return result;
  };
  const IfMatch = z.string().max(32).describe('Apply only if routing is still at this version, from GET /v1/routing or a previous ETag.'),
    ifMatch = z.object({ 'if-match': IfMatch.optional() });
  const RouteParam = z.object({ id: z.string().max(128).describe('Route ID or key.') }),
    VersionParam = z.object({ v: z.coerce.number().int().nonnegative() }),
    Page = z.object({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });

  app.openapi(
    createRoute({
      ...meta,
      method: 'get',
      path,
      operationId: 'getRouting',
      summary: 'Read the routing config',
      description:
        "Every explicit route and the current version (also the ETag). With format=config, routes omit IDs and refer to keyed inboxes and webhooks as inbox:<key> and webhook:<key>, ready to edit and PUT back. An inbox's own addresses route to it without a route.",
      request: { query: z.object({ format: z.enum(['config']).optional() }) },
      responses: { 200: response(z.union([RoutingConfig, RoutingConfigFile])), ...errors },
    }),
    async (c) => {
      const w = workspace(c);
      const config = (
        await c.env.db.execute<{ version: number; routes: Route[] }>(
          sql`SELECT coalesce((SELECT version FROM mail_routing_state WHERE workspace_id=${w}),0) AS version,coalesce((SELECT jsonb_agg(r ORDER BY match) FROM (SELECT ${columns} FROM mail_routes WHERE workspace_id=${w}) r),'[]') AS routes`,
        )
      ).rows[0]!;
      c.header('ETag', `"${config.version}"`);
      if (c.req.valid('query').format !== 'config') return c.json(config, 200);
      const keys = new Map(
        (
          await c.env.db.execute<{ id: string; ref: string }>(
            sql`SELECT id,'inbox:'||key AS ref FROM mailboxes WHERE workspace_id=${w} AND key IS NOT NULL UNION ALL SELECT id,'webhook:'||key FROM mailbox_webhooks WHERE workspace_id=${w} AND key IS NOT NULL`,
          )
        ).rows.map((r) => [r.id, r.ref]),
      );
      const routes = config.routes.map(({ id: _id, createdAt: _at, ...r }) => ({ ...r, to: Array.isArray(r.to) ? r.to.map((d) => keys.get(d) ?? d) : r.to }));
      return c.json({ version: config.version, routes }, 200);
    },
  );
  app.openapi(
    createRoute({
      ...meta,
      method: 'put',
      path,
      operationId: 'applyRouting',
      summary: 'Replace every route',
      description:
        'Declarative apply: routes are matched by key (or, without a key, by match), so applying the same file again changes nothing. Routes missing from the file are deleted. Requires If-Match with the version you read. dryRun=true returns the diff without saving.',
      request: {
        headers: z.object({ 'if-match': IfMatch }),
        query: z.object({ dryRun: z.enum(['true', 'false']).optional() }),
        body: json(RoutingConfigFile),
      },
      responses: { 200: response(RoutingChange), ...errors },
    }),
    async (c) => {checkReferenceBudget(c.req.valid('json').routes);return c.json(
        await edit(c, (routes) => applyEntries(routes,c.req.valid('json').routes), {
          dryRun: c.req.valid('query').dryRun === 'true',
        }),
        200,
      );},
  );
  app.openapi(
    createRoute({
      ...meta,
      method: 'get',
      path: path + '/routes',
      operationId: 'listRoutes',
      summary: 'List routes',
      responses: { 200: response(z.object({ data: z.array(MailRoute) })), ...errors },
    }),
    async (c) => c.json({ data: await listRoutes(c.env.db, workspace(c)) }, 200),
  );
  app.openapi(
    createRoute({
      ...meta,
      method: 'post',
      path: path + '/routes',
      operationId: 'createRoute',
      summary: 'Route a recipient',
      description:
        'Example: { "match": "support@acme.com", "to": ["inbox:support", "webhook:helpdesk"] } keeps the Support inbox and adds a webhook. Mail is routed by the new version as soon as this returns. Test first with testRouting.',
      request: { headers: ifMatch, body: json(RouteFields.openapi('CreateMailRoute')) },
      responses: { 201: response(MailRoute), ...errors },
    }),
    async (c) => {
      const route = makeRoute(c.req.valid('json'));
      await edit(c, (routes) => [...routes, route]);
      return c.json(route, 201);
    },
  );
  app.openapi(
    createRoute({
      ...meta,
      method: 'get',
      path: path + '/routes/{id}',
      operationId: 'getRoute',
      summary: 'Read a route',
      request: { params: RouteParam },
      responses: { 200: response(MailRoute), ...errors },
    }),
    async (c) => c.json(findRoute(await listRoutes(c.env.db, workspace(c)), c.req.valid('param').id), 200),
  );
  app.openapi(
    createRoute({
      ...meta,
      method: 'patch',
      path: path + '/routes/{id}',
      operationId: 'updateRoute',
      summary: 'Change a route',
      description: 'Only supplied fields change; to replaces the whole destination list.',
      request: { params: RouteParam, headers: ifMatch, body: json(RouteFields.partial().openapi('UpdateMailRoute')) },
      responses: { 200: response(MailRoute), ...errors },
    }),
    async (c) => {
      let updated: Route | undefined;
      await edit(c, (routes) => {
        const previous = findRoute(routes, c.req.valid('param').id);
        updated = makeRoute({ ...previous, ...c.req.valid('json') }, previous);
        return routes.map((r) => (r === previous ? updated! : r));
      });
      return c.json(updated!, 200);
    },
  );
  app.openapi(
    createRoute({
      ...meta,
      method: 'delete',
      path: path + '/routes/{id}',
      operationId: 'deleteRoute',
      summary: 'Delete a route',
      description: "The recipient falls back to the next tier, such as its inbox's own address or the catch-all.",
      request: { params: RouteParam, headers: ifMatch },
      responses: { 200: response(RoutingChange), ...errors },
    }),
    async (c) =>
      c.json(
        await edit(c, (routes) => {
          const removed = findRoute(routes, c.req.valid('param').id);
          return routes.filter((r) => r !== removed);
        }),
        200,
      ),
  );
  app.openapi(
    createRoute({
      ...meta,
      method: 'get',
      path: path + '/audit',
      operationId: 'getRoutingAudit',
      summary: 'List route changes',
      description: 'One entry per changed route, newest first, with the state before and after, who changed it and the request ID.',
      request: {
        query: Page.extend({
          resource: z.string().max(128).optional().describe('Only changes to this route ID.'),
          actor: z.string().max(200).optional().describe('Only changes by this API key, agent, MCP grant or user ID.'),
          since: z.iso.datetime().optional(),
        }),
      },
      responses: { 200: response(z.object({ data: z.array(RoutingAuditEntry), nextCursor: z.string().nullable() })), ...errors },
    }),
    async (c) => {
      const w = workspace(c),
        q = c.req.valid('query'),
        [cv, cr] = (q.cursor ?? '').split(':');
      if(q.cursor && !/^[0-9]{1,9}:[A-Za-z0-9_-]+$/.test(q.cursor))throw fail(422,'INVALID_CURSOR','Use the nextCursor from the previous page.');
      const rows = (
        await c.env.db.execute<z.infer<typeof RoutingAuditEntry>>(
          sql`SELECT version,resource_id AS "resourceId",before,after,jsonb_build_object('type',actor_type,'id',actor_id) AS actor,request_id AS "requestId",note,created_at::text AS "createdAt" FROM mail_routing_audit WHERE workspace_id=${w}
            ${q.resource ? sql`AND resource_id=${q.resource}` : sql``} ${q.actor ? sql`AND actor_id=${q.actor}` : sql``} ${q.since ? sql`AND created_at>=${q.since}::timestamptz` : sql``}
            ${q.cursor ? sql`AND (version<${Number(cv)} OR (version=${Number(cv)} AND resource_id>${cr ?? ''}))` : sql``} ORDER BY version DESC,resource_id LIMIT ${q.limit + 1}`,
        )
      ).rows;
      const last = rows.length > q.limit ? rows[q.limit - 1]! : null;
      return c.json({ data: rows.slice(0, q.limit), nextCursor: last && `${last.version}:${last.resourceId}` }, 200);
    },
  );
  app.openapi(
    createRoute({
      ...meta,
      method: 'get',
      path: path + '/versions',
      operationId: 'listRoutingVersions',
      summary: 'List routing versions',
      description: 'Newest first. Every change, apply, detach and restore is one version.',
      request: { query: Page },
      responses: { 200: response(z.object({ data: z.array(RoutingVersion), nextCursor: z.string().nullable() })), ...errors },
    }),
    async (c) => {
      const w = workspace(c),
        q = c.req.valid('query');
      const rows = (
        await c.env.db.execute<z.infer<typeof RoutingVersion>>(
          sql`SELECT version,created_at::text AS "createdAt",jsonb_build_object('type',actor_type,'id',actor_id) AS actor,cardinality(changed_ids) AS changes,note FROM mail_routing_versions
            WHERE workspace_id=${w} AND created_at>=now()-interval '1 year' ${q.cursor ? sql`AND version<${Number(q.cursor) || 0}` : sql``} ORDER BY version DESC LIMIT ${q.limit + 1}`,
        )
      ).rows;
      return c.json({ data: rows.slice(0, q.limit), nextCursor: rows.length > q.limit ? String(rows[q.limit - 1]!.version) : null }, 200);
    },
  );
  app.openapi(
    createRoute({
      ...meta,
      method: 'get',
      path: path + '/versions/{v}',
      operationId: 'getRoutingVersion',
      summary: 'Read a routing version',
      description: 'One page of routes as they were at v and that version’s changes. Pass nextCursor for the next page. History retains the latest 256 versions for up to one year.',
      request: { params: VersionParam,query:Page.extend({cursor:z.string().regex(/^\d{1,5}$/).optional()}) },
      responses: { 200: response(RoutingConfig.extend({ diff: z.array(RoutingDiff),nextCursor:z.string().nullable() }).openapi('RoutingVersionDetail')), ...errors },
    }),
    async (c) => {
      const w = workspace(c),
        v = c.req.valid('param').v;
      if (v > (await currentVersion(c.env.db, w))) throw fail(404, 'NOT_FOUND', `Version ${v} does not exist yet. List versions with GET /v1/routing/versions.`);
      const q=c.req.valid('query');return c.json({version:v,...await versionPage(c.env.db,w,v,Number(q.cursor??0),q.limit)},200);
    },
  );
  app.openapi(
    createRoute({
      ...meta,
      method: 'post',
      path: path + '/versions/{v}/restore',
      operationId: 'restoreRoutingVersion',
      summary: 'Restore a routing version',
      description:
        'Saves the routes of version v as a new version. Destinations deleted since are left out and listed in warnings. Webhook settings and domain catch-all settings are not versioned, so they keep their current values.',
      request: { params: VersionParam, headers: ifMatch },
      responses: { 200: response(RoutingChange), ...errors },
    }),
    async (c) => {
      const v = c.req.valid('param').v,
        w = workspace(c);
      return c.json(
        await edit(
          c,
          (_routes, tx, version) => {
            if (v > version) throw fail(404, 'NOT_FOUND', `Version ${v} does not exist yet. List versions with GET /v1/routing/versions.`);
            return historical(tx, w, v);
          },
          { lenient: true, note: `Restore of v${v}` },
        ),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      ...meta,
      method: 'post',
      path: path + '/test',
      operationId: 'testRouting',
      summary: 'Preview where mail would go',
      description:
        'Read-only: nothing is delivered or saved. Resolves recipients with the same matcher ingest uses and explains each one. Supply envelope.to, a pasted raw message or a stored messageId; add config to test unsaved routes or version to test an earlier one. A stored message tested against the current version matches the routing recorded when it arrived, unless destinations changed since.',
      request: { body: json(RoutingTest) },
      responses: { 200: response(RoutingTestResult), ...errors },
    }),
    async (c) => {
      const w = workspace(c, true),
        input = c.req.valid('json');
      if(input.config){if(input.config.routes.length>1000)throw fail(422,'TEST_CONFIG_LIMIT','A preview accepts up to 1,000 routes.');checkReferenceBudget(input.config.routes);}
      if (input.messageId && input.raw) throw fail(422, 'INVALID_TEST', 'Supply messageId or raw, not both.', 'raw');
      if (input.config && input.version !== undefined) throw fail(422, 'INVALID_TEST', 'Supply config or version, not both.', 'version');
      let to = input.envelope?.to,
        spam: string = input.verdicts?.spam ?? 'PASS',
        dmarc: string = input.verdicts?.dmarc ?? 'PASS',
        received = new Date().toISOString(),
        message: { from: string | null; subject: string | null } | null = null;
      if (input.messageId) {
        actor(c,'manage');
        const row = (
          await c.env.db.execute<{ to: string[]; spam: string | null; dmarc: string | null; at: string; from: string | null; subject: string }>(
            sql`SELECT envelope_to AS "to",verdicts->>'spam' AS spam,verdicts->>'dmarc' AS dmarc,received_at::text AS at,from_address AS "from",subject FROM mail_messages WHERE workspace_id=${w} AND id=${input.messageId} AND direction='inbound' AND ${retainedMail()}`,
          )
        ).rows[0];
        if (!row) throw fail(404, 'NOT_FOUND', `Inbound message ${input.messageId} was not found.`, 'messageId');
        ({ to, at: received } = row);
        spam = row.spam ?? 'MISSING';
        dmarc = row.dmarc ?? '';
        message = { from: row.from, subject: row.subject };
      }
      if (input.raw) {
        const { parseInboundMime } = await import('./mailbox-ingest.js');
        const email = await parseInboundMime(Uint8Array.from(Buffer.from(input.raw, 'base64')));
        if (!email)
          throw fail(422, 'INVALID_MIME', 'raw is not a parseable message within the ingest limits. Send the whole message, headers included, base64-encoded.', 'raw');
        to ??= [...new Set(addressesOf([...(email.to ?? []), ...(email.cc ?? [])]).filter((a) => ADDRESS.test(a)))].slice(0, 100);
        message = { from: email.from?.address?.toLowerCase() ?? null, subject: email.subject ?? null };
      }
      if (!to?.length) throw fail(422, 'MISSING_RECIPIENTS', 'Supply envelope.to, a raw message with To or Cc addresses, or a messageId.', 'envelope');
      const read = async (tx: DbExecutor) =>
        (await tx.execute<{ p: RoutingInput }>(sql`SELECT mail_route_input(${w},${JSON.stringify(to)}::jsonb,true,${receivingPolicy(c.env.config)}::jsonb) AS p`)).rows[0]!.p;
      let routing: RoutingInput,
        version: number;
      if (input.config || input.version !== undefined) {
        // Apply the candidate routes with the real write path, read the claim input, and roll it all back.
        ({ routing, version } = await rolledBack(c.env.db, async (tx) => {
          await lockMailboxLane(tx, w, 'address');
          const saved = await currentVersion(tx, w),
            routes = await listRoutes(tx, w);
          if (input.version !== undefined && input.version > saved)
            throw fail(404, 'NOT_FOUND', `Version ${input.version} does not exist yet. List versions with GET /v1/routing/versions.`, 'version');
          const candidate = input.config
            ? applyEntries(routes,input.config.routes)
            : await historical(tx, w, input.version!);
          await save(tx, c, w, saved, routes, candidate, { lenient: !input.config });
          return { routing: await read(tx), version: input.version ?? saved };
        }));
      } else {
        routing = await read(c.env.db);
        version = routing.version;
      }
      const result = matchRouting(routing, to, spam !== 'PASS', dmarc, received);
      return c.json({ version, unsaved: !!input.config, verdicts: { spam, dmarc }, message, recipients: result.recipients }, 200);
    },
  );
}
