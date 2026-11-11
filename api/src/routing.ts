import { createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { actor, ApiError, errors, id, json, response, security, type App, type Ctx, type DbExecutor } from './core.js';
import { ADDRESS, lockMailboxLane } from './mailbox-store.js';
import { matchRouting, type RoutingInput } from './routing-match.js';

export const RoutingKey = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const Address = z.string().trim().toLowerCase().max(254);
const Fields = z
  .object({
    key: RoutingKey.nullable().optional(),
    match: Address,
    to: z.union([z.literal('drop'), z.array(z.string().max(128)).max(10)]),
    subaddresses: z.boolean().optional(),
    enabled: z.boolean().optional(),
    note: z.string().max(500).optional(),
  })
  .strict();
const View = Fields.extend({ id: z.string(), createdAt: z.string() }).openapi('MailRoute'),
  Config = z.object({ routes: z.array(View), version: z.number().int() }).openapi('RoutingConfig');
type Route = z.infer<typeof View>;
const ConfigFile = z
  .object({ routes: z.array(Fields).max(10000), version: z.number().int().optional() })
  .strict()
  .openapi('RoutingConfigFile');
const Diff = z.object({ before: View.nullable(), after: View.nullable() }),
  Change = z.object({ version: z.number().int(), diff: z.array(Diff) });
const columns = sql`id,key,match,destinations AS "to",subaddresses,enabled,note,created_at::text AS "createdAt"`;
const failure = (code: string, message: string, status = 422) => new ApiError(status, code, message);
const list = async (tx: DbExecutor, w: string) =>
  (await tx.execute<Route>(sql`SELECT ${columns} FROM mail_routes WHERE workspace_id=${w} ORDER BY match`)).rows;
async function current(tx: DbExecutor, w: string) {
  return (
    await tx.execute<{ v: number }>(sql`SELECT coalesce((SELECT version FROM mail_routing_state WHERE workspace_id=${w}),0) AS v`)
  ).rows[0]!.v;
}
async function historical(tx: DbExecutor, w: string, v: number) {
  return (
    await tx.execute<{ r: Route }>(
      sql`SELECT r FROM (SELECT DISTINCT ON(resource_id) after AS r FROM mail_routing_audit WHERE workspace_id=${w} AND version<=${v} ORDER BY resource_id,version DESC) h WHERE r IS NOT NULL ORDER BY r->>'match'`,
    )
  ).rows.map((r) => r.r);
}
const find = (routes: Route[], ref: string) => {
  const r = routes.find((r) => r.id === ref || r.key === ref);
  if (!r) throw failure('NOT_FOUND', 'Route not found.', 404);
  return r;
};
function make(fields: z.infer<typeof Fields>, previous?: Route): Route {
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
async function save(tx: DbExecutor, c: Ctx, w: string, version: number, before: Route[], after: Route[], dry = false, note = '') {
  const old = new Map(before.map((r) => [r.id, r])),
    seen = new Set<string>(),
    keys = new Set<string>(),
    counts = new Map<string, number>();
  let exact = 0;
  const same = (a: Route | undefined, b: Route) =>
    !!a &&
    (['key', 'match', 'to', 'enabled', 'subaddresses', 'note'] as const).every(
      (k) => JSON.stringify(a[k]) === JSON.stringify(b[k]),
    );
  let changed: Route[] = [];
  for (const r of after) {
    if (!ADDRESS.test(r.match) || r.match.split('@')[1]!.includes('*'))
      throw failure('INVALID_MATCH', 'Supply an address or a local-part wildcard on a receiving host.');
    if (seen.has(r.match) || (r.key && keys.has(r.key))) throw failure('ROUTE_CONFLICT', 'Duplicate match or route key.', 409);
    seen.add(r.match);
    if (r.key) keys.add(r.key);
    if (r.match.includes('*')) {
      const host = r.match.split('@')[1]!,
        n = 1 + (counts.get(host) ?? 0);
      if (n > 64) throw failure('ROUTE_LIMIT', 'At most 64 patterns per host.', 409);
      counts.set(host, n);
    } else if (++exact > 10000) throw failure('ROUTE_LIMIT', 'At most 10,000 exact routes.', 409);
    const prev = old.get(r.id);
    if (!same(prev, r)) changed.push(r);
  }
  const existing = new Set(after.map((r) => r.id)),
    removed = before.filter((r) => !existing.has(r.id));
  const refs = [...new Set(changed.flatMap((r) => (Array.isArray(r.to) ? r.to : [])))];
  const dests = (
    await tx.execute<{ id: string; ref: string }>(
      sql`WITH refs AS (SELECT jsonb_array_elements_text(${JSON.stringify(refs)}::jsonb) AS ref) SELECT b.id,ref FROM refs JOIN mailboxes b ON b.workspace_id=${w} AND (b.id=ref OR 'inbox:'||b.key=ref) UNION ALL SELECT h.id,ref FROM refs JOIN mailbox_webhooks h ON h.workspace_id=${w} AND (h.id=ref OR 'webhook:'||h.key=ref)`,
    )
  ).rows;
  const ids = new Map(dests.map((d) => [d.ref, d.id]));
  for (const r of changed)
    if (Array.isArray(r.to))
      r.to = [
        ...new Set(
          r.to.map((ref) => {
            const id = ids.get(ref);
            if (!id) throw failure('UNKNOWN_DESTINATION', 'Destination does not exist in this workspace.');
            return id;
          }),
        ),
      ];
  changed = changed.filter((r) => !same(old.get(r.id), r));
  const diff = [
    ...removed.map((r) => ({ before: r, after: null })),
    ...changed.map((r) => ({ before: old.get(r.id) ?? null, after: r })),
  ];
  if (!diff.length) return { version, diff };
  const hosts = [
    ...new Set(
      diff
        .flatMap((d) => [d.before, d.after])
        .filter((r): r is Route => !!r)
        .map((r) => r.match.split('@')[1]!),
    ),
  ];
  const domains = (
    await tx.execute<{ id: string; host: string }>(
      sql`SELECT id,coalesce(receiving_host,name) AS host FROM mailbox_domains WHERE workspace_id=${w} AND coalesce(receiving_host,name) IN (SELECT jsonb_array_elements_text(${JSON.stringify(hosts)}))`,
    )
  ).rows;
  const domain = new Map(domains.map((d) => [d.host, d.id]));
  for (const r of changed)
    if (!domain.has(r.match.split('@')[1]!))
      throw failure('UNKNOWN_HOST', 'Route must belong to a receiving host in this workspace.');
  if (dry) return { version, diff };
  await tx.execute(
    sql`INSERT INTO mail_routing_state(workspace_id,version) VALUES(${w},1) ON CONFLICT(workspace_id) DO UPDATE SET version=mail_routing_state.version+1`,
  );
  await tx.execute(
    sql`DELETE FROM mail_routes WHERE workspace_id=${w} AND id IN (SELECT jsonb_array_elements_text(${JSON.stringify(diff.map((d) => (d.before ?? d.after)!.id))}))`,
  );
  await tx.execute(
    sql`INSERT INTO mail_routes(id,workspace_id,key,domain_id,match,destinations,subaddresses,enabled,note,created_at) SELECT id,${w},key,domain,match,"to",subaddresses,enabled,note,"createdAt" FROM jsonb_to_recordset(${JSON.stringify(changed.map((r) => ({ ...r, domain: domain.get(r.match.split('@')[1]!) })))}::jsonb) AS x(id text,key text,domain text,match text,"to" jsonb,subaddresses boolean,enabled boolean,note text,"createdAt" timestamptz)`,
  );
  const a = c.get('actor');
  await tx.execute(
    sql`INSERT INTO mail_routing_audit(workspace_id,version,resource_id,before,after,actor_type,actor_id,request_id,note) SELECT ${w},${version + 1},coalesce(before->>'id',after->>'id'),before,after,${a.credential ?? 'apiKey'},${a.keyId},${c.get('requestId')},${note} FROM jsonb_to_recordset(${JSON.stringify(diff)}::jsonb) x(before jsonb,after jsonb)`,
  );
  const affected = diff
    .flatMap((d) => [d.before, d.after])
    .filter((r) => r?.match.includes('*'))
    .map((r) => domain.get(r!.match.split('@')[1]!));
  for (const d of new Set(affected.filter(Boolean))) await tx.execute(sql`SELECT mail_compile_routes(${w},${d})`);
  return { version: version + 1, diff };
}
export async function detachDestination(tx: DbExecutor, c: Ctx, w: string, dest: string) {
  await lockMailboxLane(tx, w, 'address');
  if (!(await tx.execute(sql`SELECT FROM mail_routes WHERE workspace_id=${w} AND destinations ? ${dest} LIMIT 1`)).rowCount)
    return;
  if (c.req.query('detach') !== 'true')
    throw failure('REFERENCED', 'Destination is used by a route. Pass detach=true to remove its references.', 409);
  const routes = await list(tx, w);
  await save(
    tx,
    c,
    w,
    await current(tx, w),
    routes,
    routes.map((r) => (Array.isArray(r.to) && r.to.includes(dest) ? { ...r, to: r.to.filter((id) => id !== dest) } : r)),
    false,
    'Detach destination',
  );
}
export function registerRouting(app: App) {
  const path = '/v1/routing',
    meta = { security, tags: ['Routing'] },
    wid = (c: Ctx) => {
      const a = actor(c, 'manage');
      if (a.domains.length || a.role === 'member')
        throw failure('ADMIN_REQUIRED', 'Use an unrestricted workspace manage credential.', 403);
      return a.workspaceId;
    };
  const edit = async (
    c: Ctx,
    fn: (rows: Route[], tx: DbExecutor, version: number) => Route[] | Promise<Route[]>,
    dry = false,
    note = '',
  ) => {
    const w = wid(c);
    if (['mcp', 'agentToken'].includes(c.get('actor').credential ?? ''))
      throw failure('ADMIN_REQUIRED', 'Routing changes require workspace admin approval.', 403);
    return c.env.db.transaction(async (tx) => {
      await lockMailboxLane(tx, w, 'address');
      const version = await current(tx, w),
        expected = c.req.header('if-match');
      if (expected !== undefined && expected !== String(version) && expected !== `"${version}"`)
        throw failure('VERSION_CONFLICT', 'Routing has changed. Read the current version.', 409);
      const rows = await list(tx, w);
      return save(tx, c, w, version, rows, await fn(rows, tx, version), dry, note);
    });
  };
  const params = z.object({ id: z.string().max(128) }),
    versions = z.object({ v: z.coerce.number().int().nonnegative() });
  app.openapi(
    createRoute({
      ...meta,
      method: 'get',
      path,
      operationId: 'getRouting',
      request: { query: z.object({ format: z.enum(['config']).optional() }) },
      responses: { 200: response(z.union([Config, ConfigFile])), ...errors },
    }),
    async (c) => {
      const w = wid(c);
      const result = (
        await c.env.db.execute<{ version: number; routes: Route[] }>(
          sql`SELECT coalesce((SELECT version FROM mail_routing_state WHERE workspace_id=${w}),0) AS version,coalesce((SELECT jsonb_agg(r ORDER BY match) FROM (SELECT ${columns} FROM mail_routes WHERE workspace_id=${w}) r),'[]') AS routes`,
        )
      ).rows[0]!;
      if (c.req.valid('query').format === 'config') {
        const keys = new Map(
          (
            await c.env.db.execute<{ id: string; ref: string }>(
              sql`SELECT id,'inbox:'||key AS ref FROM mailboxes WHERE workspace_id=${w} AND key IS NOT NULL UNION ALL SELECT id,'webhook:'||key AS ref FROM mailbox_webhooks WHERE workspace_id=${w} AND key IS NOT NULL`,
            )
          ).rows.map((r) => [r.id, r.ref]),
        );
        return c.json(
          {
            version: result.version,
            routes: result.routes.map(({ id: _id, createdAt: _at, ...r }) => ({
              ...r,
              to: Array.isArray(r.to) ? r.to.map((id) => keys.get(id) ?? id) : r.to,
            })),
          },
          200,
        );
      }
      return c.json(result, 200);
    },
  );
  app.openapi(
    createRoute({
      ...meta,
      method: 'put',
      path,
      operationId: 'applyRouting',
      request: {
        headers: z.object({ 'if-match': z.string().max(32) }),
        query: z.object({ dryRun: z.enum(['true', 'false']).optional() }),
        body: json(ConfigFile),
      },
      responses: { 200: response(Change), ...errors },
    }),
    async (c) =>
      c.json(
        await edit(
          c,
          (rows) =>
            c.req.valid('json').routes.map((f) =>
              make(
                f,
                rows.find((r) => (f.key ? r.key === f.key : r.match === f.match)),
              ),
            ),
          c.req.valid('query').dryRun === 'true',
        ),
        200,
      ),
  );
  app.openapi(
    createRoute({
      ...meta,
      method: 'get',
      path: path + '/routes',
      operationId: 'listRoutes',
      responses: { 200: response(z.object({ data: z.array(View) })), ...errors },
    }),
    async (c) => c.json({ data: await list(c.env.db, wid(c)) }, 200),
  );
  app.openapi(
    createRoute({
      ...meta,
      method: 'post',
      path: path + '/routes',
      operationId: 'createRoute',
      request: { body: json(Fields.openapi('CreateMailRoute')) },
      responses: { 201: response(View), ...errors },
    }),
    async (c) => {
      const r = make(c.req.valid('json'));
      await edit(c, (rows) => [...rows, r]);
      return c.json(r, 201);
    },
  );
  app.openapi(
    createRoute({
      ...meta,
      method: 'get',
      path: path + '/routes/{id}',
      operationId: 'getRoute',
      request: { params },
      responses: { 200: response(View), ...errors },
    }),
    async (c) => c.json(find(await list(c.env.db, wid(c)), c.req.valid('param').id), 200),
  );
  app.openapi(
    createRoute({
      ...meta,
      method: 'patch',
      path: path + '/routes/{id}',
      operationId: 'updateRoute',
      request: { params, body: json(Fields.partial()) },
      responses: { 200: response(View), ...errors },
    }),
    async (c) => {
      let r: Route;
      await edit(c, (rows) => {
        const prev = find(rows, c.req.valid('param').id);
        r = make({ ...prev, ...c.req.valid('json') }, prev);
        return rows.map((old) => (old === prev ? r : old));
      });
      return c.json(r!, 200);
    },
  );
  app.openapi(
    createRoute({
      ...meta,
      method: 'delete',
      path: path + '/routes/{id}',
      operationId: 'deleteRoute',
      request: { params },
      responses: { 200: response(Change), ...errors },
    }),
    async (c) =>
      c.json(
        await edit(c, (rows) => {
          const removed = find(rows, c.req.valid('param').id);
          return rows.filter((r) => r !== removed);
        }),
        200,
      ),
  );
  const audit = z.record(z.string(), z.unknown());
  app.openapi(
    createRoute({
      ...meta,
      method: 'get',
      path: path + '/audit',
      operationId: 'getRoutingAudit',
      request: {
        query: z.object({
          resource: z.string().max(128).optional(),
          actor: z.string().max(200).optional(),
          since: z.iso.datetime().optional(),
        }),
      },
      responses: { 200: response(z.object({ data: z.array(audit) })), ...errors },
    }),
    async (c) =>
      c.json(
        {
          data: (
            await c.env.db.execute(
              sql`SELECT * FROM mail_routing_audit WHERE workspace_id=${wid(c)} ${c.req.query('resource') ? sql`AND resource_id=${c.req.query('resource')}` : sql``} ${c.req.query('actor') ? sql`AND actor_id=${c.req.query('actor')}` : sql``} ${c.req.query('since') ? sql`AND created_at>=${c.req.query('since')}::timestamptz` : sql``} ORDER BY version DESC,resource_id LIMIT 100`,
            )
          ).rows,
        },
        200,
      ),
  );
  app.openapi(
    createRoute({
      ...meta,
      method: 'get',
      path: path + '/versions',
      operationId: 'listRoutingVersions',
      responses: { 200: response(z.object({ data: z.array(audit) })), ...errors },
    }),
    async (c) =>
      c.json(
        {
          data: (
            await c.env.db.execute(
              sql`SELECT version,max(actor_id) AS actor,max(created_at) AS "createdAt",count(*)::int AS changes FROM mail_routing_audit WHERE workspace_id=${wid(c)} GROUP BY version ORDER BY version DESC LIMIT 100`,
            )
          ).rows,
        },
        200,
      ),
  );
  app.openapi(
    createRoute({
      ...meta,
      method: 'get',
      path: path + '/versions/{v}',
      operationId: 'getRoutingVersion',
      request: { params: versions },
      responses: { 200: response(Config.extend({ diff: z.array(Diff) })), ...errors },
    }),
    async (c) => {
      const w = wid(c),
        v = c.req.valid('param').v;
      if (v > (await current(c.env.db, w))) throw failure('NOT_FOUND', 'Version not found.', 404);
      return c.json(
        {
          version: v,
          routes: await historical(c.env.db, w, v),
          diff: (
            await c.env.db.execute<z.infer<typeof Diff>>(
              sql`SELECT before,after FROM mail_routing_audit WHERE workspace_id=${w} AND version=${v} ORDER BY resource_id`,
            )
          ).rows,
        },
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      ...meta,
      method: 'post',
      path: path + '/versions/{v}/restore',
      operationId: 'restoreRoutingVersion',
      request: { params: versions },
      responses: { 200: response(Change), ...errors },
    }),
    async (c) => {
      const v = c.req.valid('param').v;
      return c.json(
        await edit(
          c,
          (_, tx, cur) => {
            if (v > cur) throw failure('NOT_FOUND', 'Version not found.', 404);
            return historical(tx, wid(c), v);
          },
          false,
          `Restore of v${v}`,
        ),
        200,
      );
    },
  );
  const test = z
    .object({
      messageId: z.string().optional(),
      envelope: z.object({ from: z.string().optional(), to: z.array(Address.regex(ADDRESS)).min(1).max(100) }).optional(),
      verdicts: z.object({ spam: z.string().optional(), dmarc: z.string().optional() }).optional(),
    })
    .strict();
  const result = z.object({
    version: z.number(),
    recipients: z.array(
      z.object({
        address: z.string(),
        route: z.string().nullable(),
        tier: z.string(),
        default: z.string(),
        inboxes: z.array(z.string()),
        webhooks: z.array(z.string()),
        junk: z.boolean(),
        dropped: z.boolean(),
        warnings: z.array(z.string()),
      }),
    ),
  });
  app.openapi(
    createRoute({
      ...meta,
      method: 'post',
      path: path + '/test',
      operationId: 'testRouting',
      description: 'Read-only. Resolve envelope recipients or replay a stored message against the current routing version.',
      request: { body: json(test) },
      responses: { 200: response(result), ...errors },
    }),
    async (c) => {
      const w = wid(c),
        input = c.req.valid('json');
      let to = input.envelope?.to,
        junk = input.verdicts?.spam?.toUpperCase() !== 'PASS',
        dmarc = input.verdicts?.dmarc?.toUpperCase() ?? 'GRAY',
        at = new Date().toISOString();
      if (input.messageId) {
        const row = (
          await c.env.db.execute<{ to: string[]; spam: boolean; dmarc: string; at: string }>(
            sql`SELECT envelope_to AS "to",spam,verdicts->>'dmarc' AS dmarc,received_at::text AS at FROM mail_messages WHERE workspace_id=${w} AND id=${input.messageId} AND direction='inbound'`,
          )
        ).rows[0];
        if (!row) throw failure('NOT_FOUND', 'Message not found.', 404);
        to = row.to;
        junk = row.spam;
        dmarc = row.dmarc;
        at = row.at;
      }
      if (!to) throw failure('MISSING_ENVELOPE', 'Supply envelope.to or messageId.');
      const { p } = (
        await c.env.db.execute<{ p: RoutingInput }>(sql`SELECT mail_route_input(${w},${JSON.stringify(to)}::jsonb,true) AS p`)
      ).rows[0]!;
      return c.json(matchRouting(p, to, junk, dmarc, at), 200);
    },
  );
}
