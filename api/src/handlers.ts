import { createRoute, z } from '@hono/zod-openapi';
import { and, eq, sql } from 'drizzle-orm';
import { actor, ApiError, errors, json, response, security, type App, type Ctx, type DbExecutor } from './core.js';
import { mailMessages, mailAttachments, retainedMail } from './db/mailbox.js';
import { lockMailboxLane } from './mailbox-store.js';
import { rolledBack } from './routing.js';
import {
  compileConfig,
  handlerPipeline,
  HandlerConfig,
  Handler,
  Guard,
  Binding,
  projectEmail,
  type Config,
  type Programs,
} from './handler-pipeline.js';
import type { RoutingInput } from './routing-match.js';
import { registerHandlerDestinations } from './handler-destinations.js';

const path = '/v1/routing/handlers',
  meta = { security, tags: ['Handlers'] },
  state = z.object({ version: z.number().int(), config: HandlerConfig }),
  ok = { 200: response(state), ...errors };
export function handlerAdmin(c: Ctx, write = false) {
  const a = actor(c, 'manage');
  if (a.domains.length || a.role === 'member' || (write && ['mcp', 'agentToken'].includes(a.credential ?? '')))
    throw new ApiError(
      403,
      'ADMIN_REQUIRED',
      'Use a workspace-wide administrator. MCP can read and dry-run Handlers, not change them.',
    );
  return a;
}
async function current(tx: DbExecutor, w: string) {
  const r = (
    await tx.execute<{ version: number; config: Config | null }>(
      sql`SELECT coalesce(s.version,0) AS version,h.config FROM (SELECT 1) one LEFT JOIN mail_routing_state s ON s.workspace_id=${w} LEFT JOIN mail_handler_configs h ON h.workspace_id=${w}`,
    )
  ).rows[0];
  return { version: r.version, config: r.config ?? HandlerConfig.parse({}) };
}
async function prepare(tx: DbExecutor, w: string, c: Config) {
  let p: Programs;
  try {
    p = compileConfig(c);
  } catch (e) {
    throw new ApiError(422, 'HANDLER_INVALID', e instanceof Error ? e.message : 'Invalid handler', 'source');
  }
  const refs = [...new Set([...Object.values(p.handlers), ...p.guards.map((g) => g.ir)].flatMap((ir) => ir.refs))];
  const found = (
    await tx.execute<{
      ref: string;
      id: string;
    }>(sql`WITH refs AS (SELECT ref,split_part(ref,':',2) AS key FROM jsonb_array_elements_text(${JSON.stringify(refs)}::jsonb) ref)
    SELECT ref,b.id FROM refs JOIN mailboxes b ON b.workspace_id=${w} AND b.key=refs.key WHERE starts_with(ref,'inbox:')
    UNION ALL SELECT ref,h.id FROM refs JOIN mailbox_webhooks h ON h.workspace_id=${w} AND h.key=refs.key WHERE starts_with(ref,'webhook:') AND NOT starts_with(h.id,'con_')
    UNION ALL SELECT d.ref,d.hook_id FROM refs JOIN mail_handler_destinations d ON d.workspace_id=${w} AND d.ref=refs.ref AND d.verified`)
  ).rows;
  p.refs = Object.fromEntries(found.map((r) => [r.ref, r.id]));
  for (const r of refs)
    if (!Object.hasOwn(p.refs, r))
      throw new ApiError(422, 'UNKNOWN_DESTINATION', `Create and verify ${r} in this workspace before saving.`);
  const invalid = (
    await tx.execute<{ t: string }>(
      sql`SELECT t FROM jsonb_array_elements_text(${JSON.stringify(c.attachments.map((a) => a.target))}::jsonb) t WHERE NOT EXISTS(SELECT FROM mailbox_addresses a WHERE a.workspace_id=${w} AND (a.address=t OR a.mailbox_id=t)) LIMIT 1`,
    )
  ).rows[0];
  if (invalid) throw new ApiError(422, 'UNKNOWN_TARGET', `No receiving inbox or address ${invalid.t} in this workspace.`);
  return p;
}
async function save(tx: DbExecutor, c: Ctx, w: string, config: Config, version: number) {
  const p = await prepare(tx, w, config),
    next = version + 1;
  await tx.execute(
    sql`INSERT INTO mail_routing_state(workspace_id,version) VALUES(${w},${next}) ON CONFLICT(workspace_id) DO UPDATE SET version=excluded.version`,
  );
  await tx.execute(
    sql`INSERT INTO mail_handler_configs VALUES(${w},${next},${JSON.stringify(config)}::jsonb,${config.guards.length || config.attachments.length ? JSON.stringify(p) : null}::jsonb) ON CONFLICT(workspace_id) DO UPDATE SET version=excluded.version,config=excluded.config,programs=excluded.programs`,
  );
  const who = c.get('actor');
  await tx.execute(
    sql`INSERT INTO mail_routing_versions(workspace_id,version,route_ids,changed_ids,actor_type,actor_id,note) VALUES(${w},${next},ARRAY(SELECT id FROM mail_routes WHERE workspace_id=${w} ORDER BY match),ARRAY[]::text[],${who.credential ?? 'apiKey'},${who.keyId},'Handler configuration')`,
  );
  await tx.execute(
    sql`INSERT INTO mail_handler_versions(workspace_id,version,config,actor) VALUES(${w},${next},${JSON.stringify(config)}::jsonb,${who.keyId})`,
  );
  await tx.execute(
    sql`DELETE FROM mail_handler_versions WHERE workspace_id=${w} AND (version<=${next - 256} OR created_at<now()-interval '1 year');`,
  );
  await tx.execute(sql`DELETE FROM mail_routing_versions WHERE workspace_id=${w} AND version<=${next - 256}`);
  return { version: next, config };
}
const versionHeader = z.object({ 'if-match': z.string().max(32).optional() });
async function edit(c: Ctx, change: (config: Config) => Config) {
  const w = handlerAdmin(c, true).workspaceId;
  return c.env.db.transaction(async (tx) => {
    await lockMailboxLane(tx, w, 'address');
    const s = await current(tx, w),
      expected = c.req.header('if-match')?.replace(/^"|"$/g, '');
    if (expected !== undefined && expected !== String(s.version))
      throw new ApiError(409, 'VERSION_CONFLICT', `Routing is now at version ${s.version}. Reload before saving.`);
    const result = await save(tx, c, w, HandlerConfig.parse(change(s.config)), s.version);
    c.header('ETag', `"${result.version}"`);
    return result;
  });
}
export function registerHandlers(app: App) {
  registerHandlerDestinations(app);
  const params = z.object({ kind: z.enum(['scripts', 'guards']), key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/) }),
    item = path + '/{kind}/{key}',
    entry = z.union([Handler, Guard]);
  app.openapi(
    createRoute({
      ...meta,
      method: 'get',
      path: item,
      operationId: 'getHandlerEntry',
      summary: 'Read a handler script or Guard rule by key',
      request: { params },
      responses: { 200: response(entry), ...errors },
    }),
    async (c) => {
      const q = c.req.valid('param'),
        s = await current(c.env.db, handlerAdmin(c).workspaceId),
        row = s.config[q.kind === 'scripts' ? 'handlers' : 'guards'].find((h) => h.key === q.key);
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Entry not found.');
      return c.json(row, 200);
    },
  );
  app.openapi(
    createRoute({
      ...meta,
      method: 'put',
      path: item,
      operationId: 'putHandlerEntry',
      summary: 'Create or update a reusable handler or Guard rule',
      request: { headers: versionHeader, params, body: json(entry) },
      responses: ok,
    }),
    async (c) => {
      const q = c.req.valid('param'),
        body = c.req.valid('json');
      if (q.key !== body.key || (q.kind === 'scripts') !== 'source' in body)
        throw new ApiError(422, 'INVALID_ENTRY', 'Entry kind and key must match the URL.');
      return c.json(
        await edit(c, (config) => {
          const upsert = <T extends { key: string }>(rows: T[], row: T) =>
            rows.some((r) => r.key === row.key) ? rows.map((r) => (r.key === row.key ? row : r)) : [...rows, row];
          return 'source' in body
            ? { ...config, handlers: upsert(config.handlers, body) }
            : { ...config, guards: upsert(config.guards, body) };
        }),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      ...meta,
      method: 'delete',
      path: item,
      operationId: 'deleteHandlerEntry',
      summary: 'Remove a handler and its attachments, or a Guard rule',
      request: { headers: versionHeader, params },
      responses: ok,
    }),
    async (c) => {
      const q = c.req.valid('param');
      return c.json(
        await edit(c, (config) =>
          q.kind === 'guards'
            ? { ...config, guards: config.guards.filter((g) => g.key !== q.key) }
            : {
                ...config,
                handlers: config.handlers.filter((h) => h.key !== q.key),
                attachments: config.attachments.filter((b) => b.handler !== q.key),
              },
        ),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      ...meta,
      method: 'put',
      path: path + '/attachments',
      operationId: 'setHandlerAttachments',
      summary: 'Attach, reorder and detach handlers by replacing the ordered binding list',
      request: { headers: versionHeader, body: json(z.object({ attachments: z.array(Binding).max(256) })) },
      responses: ok,
    }),
    async (c) => c.json(await edit(c, (config) => ({ ...config, ...c.req.valid('json') })), 200),
  );
  app.openapi(
    createRoute({
      ...meta,
      method: 'get',
      path,
      operationId: 'getHandlers',
      summary: 'Read handlers, ordered attachments, Guard and sender lists',
      request: { query: z.object({ version: z.coerce.number().int().positive().optional() }) },
      responses: ok,
    }),
    async (c) => {
      const w = handlerAdmin(c).workspaceId,
        v = c.req.valid('query').version;
      const r = v
        ? (
            await c.env.db.execute<{ config: Config; version: number }>(
              sql`SELECT config,version FROM mail_handler_versions WHERE workspace_id=${w} AND version=${v}`,
            )
          ).rows[0]
        : await current(c.env.db, w);
      if (!r) throw new ApiError(404, 'NOT_FOUND', 'Handler version not found.');
      c.header('ETag', `"${r.version}"`);
      return c.json(r, 200);
    },
  );
  app.openapi(
    createRoute({
      ...meta,
      method: 'put',
      path,
      operationId: 'putHandlers',
      summary: 'Create, replace or remove handlers, Guard rules and ordered bindings in one version',
      request: { headers: versionHeader, body: json(HandlerConfig) },
      responses: ok,
    }),
    async (c) => c.json(await edit(c, () => c.req.valid('json')), 200),
  );
  const dry = z
    .object({
      config: HandlerConfig.optional(),
      messageId: z.string().max(128).optional(),
      mime: z
        .string()
        .max(256 * 1024)
        .optional(),
      to: z.array(z.email()).min(1).max(100).optional(),
      scores: z.record(z.string().max(500), z.number().min(0).max(1)).optional(),
    })
    .strict();
  app.openapi(
    createRoute({
      ...meta,
      method: 'post',
      path: path + '/test',
      operationId: 'testHandlers',
      summary: 'Trace saved or proposed Handlers on a stored message or pasted MIME; never calls Jev or delivers mail',
      request: { body: json(dry) },
      responses: {
        200: response(
          z.object({
            version: z.number(),
            recipients: z.array(z.record(z.string(), z.unknown())),
            trace: z.array(z.record(z.string(), z.unknown())),
            steps: z.number(),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const w = handlerAdmin(c).workspaceId,
        q = c.req.valid('json');
      if (!!q.messageId === !!q.mime) throw new ApiError(422, 'INVALID_TEST', 'Supply messageId or mime.');
      let email: ReturnType<typeof projectEmail>,
        scores = q.scores;
      if (q.messageId) {
        const [m] = await c.env.db
          .select()
          .from(mailMessages)
          .where(
            and(
              eq(mailMessages.workspaceId, w),
              eq(mailMessages.id, q.messageId),
              eq(mailMessages.direction, 'inbound'),
              retainedMail(),
            ),
          );
        if (!m) throw new ApiError(404, 'NOT_FOUND', 'Stored inbound message not found.');
        const files = await c.env.db
          .select()
          .from(mailAttachments)
          .where(and(eq(mailAttachments.workspaceId, w), eq(mailAttachments.messageId, m.id)));
        const v = m.verdicts as typeof m.verdicts & { handlerVerified?: boolean; handlerScores?: Record<string, number> };
        email = projectEmail(m, files, v.handlerVerified === true);
        scores ??= v.handlerScores;
      } else {
        const { parseInboundMime, flatten, headersOf } = await import('./mailbox-ingest.js');
        const bytes = Buffer.from(q.mime!),
          m = await parseInboundMime(bytes);
        if (!m) throw new ApiError(422, 'INVALID_MIME', 'Paste a MIME message within the parser limits.');
        const to = flatten(m.to),
          cc = flatten(m.cc);
        email = projectEmail(
          {
            id: 'msg_preview',
            workspaceId: w,
            direction: 'inbound',
            fromAddress: flatten(m.from)[0]?.address,
            fromName: flatten(m.from)[0]?.name,
            subject: m.subject,
            text: m.text,
            html: m.html,
            headers: headersOf(m),
            to,
            cc,
            replyTo: flatten(m.replyTo),
            envelopeTo: q.to ?? [...to, ...cc].map((a) => a.address),
            receivedAt: new Date().toISOString(),
            sizeBytes: bytes.length,
            verdicts: {},
            status: 'received',
          },
          m.attachments.map((a, i) => ({
            id: 'preview_' + i,
            filename: a.filename ?? `attachment-${i + 1}`,
            contentType: a.mimeType,
            sizeBytes: typeof a.content === 'string' ? Buffer.byteLength(a.content) : a.content.byteLength,
            contentId: a.contentId,
          })),
          false,
        );
      }
      if (q.to) email.envelope.to = q.to;
      if (!email.envelope.to.length || email.envelope.to.length > 100)
        throw new ApiError(422, 'INVALID_TEST', 'Supply 1–100 envelope recipients.');
      const { input, version } = await rolledBack(c.env.db, async (tx) => {
        await lockMailboxLane(tx, w, 'address');
        const s = await current(tx, w);
        if (q.config) await save(tx, c, w, q.config, s.version);
        const input = (
          await tx.execute<{ p: RoutingInput }>(
            sql`SELECT mail_route_input(${w},${JSON.stringify(email.envelope.to)}::jsonb,true) AS p`,
          )
        ).rows[0].p;
        input.programs ??= compileConfig(HandlerConfig.parse({}));
        return { input, version: s.version };
      });
      const { plan, trace, steps } = await handlerPipeline(c.env, w, input, email, scores, true);
      return c.json({ version, recipients: plan.recipients, trace, steps }, 200);
    },
  );
}
