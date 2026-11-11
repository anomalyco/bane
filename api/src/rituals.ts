import {registerInboxConnection} from './inbox-connection.js';
import { createRoute, z } from '@hono/zod-openapi';
import { and, eq, sql } from 'drizzle-orm';
import { actor, ApiError, errors, json, response, security, type App, type Ctx, type DbExecutor } from './core.js';
import { mailMessages, mailAttachments, retainedMail } from './db/mailbox.js';
import { lockMailboxLane } from './mailbox-store.js';
import { rolledBack } from './routing.js';
import {
  compileConfig,
  ritualPipeline,
  RitualConfig,
  Ritual,
  Binding,
  projectEmail,
  type Config,
  type Programs,
} from './ritual-pipeline.js';
import type { RoutingInput } from './routing-match.js';
import { registerEndpoints } from './ritual-endpoints.js';

const path = '/v1/rituals',
  meta = { security, tags: ['Rituals'] },
  state = z.object({ version: z.number().int(), config: RitualConfig }),
  ok = { 200: response(state), ...errors };
export function ritualAdmin(c: Ctx, write = false) {
  const a=actor(c,!write&&c.get('actor')?.receivingConsent?'read':'manage');
  if (a.domains.length || a.role === 'member' || (write && (a.credential==='agentToken'||a.credential==='mcp'&&!a.receivingConsent)))
    throw new ApiError(
      403,
      'ADMIN_REQUIRED',
      'Use a workspace administrator or reconnect with explicit receiving and manage consent.',
    );
  return a;
}
export async function ownReceiving(tx:DbExecutor,c:Ctx,kind:'endpoint'|'rituals'|'key'|'route',resource:string){const a=c.get('actor');if(a.credential!=='mcp')return;if(!a.receivingConsent||!a.permissions.includes('manage'))throw new ApiError(403,'ADMIN_REQUIRED','Explicit manage and receiving consent required.');await tx.execute(sql`INSERT INTO mail_grant_objects VALUES(${a.keyId.slice(4)},${a.workspaceId},${kind},${resource}) ON CONFLICT DO NOTHING`)}
async function current(tx: DbExecutor, w: string) {
  const r = (
    await tx.execute<{ version: number; config: Config | null }>(
      sql`SELECT coalesce(s.version,0) AS version,h.config FROM (SELECT 1) one LEFT JOIN mail_routing_state s ON s.workspace_id=${w} LEFT JOIN mail_ritual_configs h ON h.workspace_id=${w}`,
    )
  ).rows[0];
  return { version: r.version, config: r.config ?? RitualConfig.parse({}) };
}
async function prepare(tx: DbExecutor, w: string, c: Config) {
  let p: Programs;
  try {
    p = compileConfig(c);
  } catch (e) {
    throw new ApiError(422, 'RITUAL_INVALID', e instanceof Error ? e.message : 'Invalid ritual', 'source');
  }
  const refs = [...new Set(Object.values(p.rituals).flatMap((ir) => ir.refs))];
  const found = (
    await tx.execute<{
      ref: string;
      id: string;
    }>(sql`WITH refs AS (SELECT ref,split_part(ref,':',2) AS key FROM jsonb_array_elements_text(${JSON.stringify(refs)}::jsonb) ref)
    SELECT ref,b.id FROM refs JOIN mailboxes b ON b.workspace_id=${w} AND b.key=refs.key WHERE starts_with(ref,'inbox:')
    UNION ALL SELECT ref,h.id FROM refs JOIN mailbox_webhooks h ON h.workspace_id=${w} AND h.key=refs.key WHERE starts_with(ref,'webhook:') AND NOT starts_with(h.id,'con_')
    UNION ALL SELECT d.ref,d.hook_id FROM refs JOIN mail_endpoints d ON d.workspace_id=${w} AND d.ref=refs.ref AND d.verified`)
  ).rows;
  p.refs = Object.fromEntries(found.map((r) => [r.ref, r.id]));
  for (const r of refs)
    if (!Object.hasOwn(p.refs, r))
      throw new ApiError(422, 'UNKNOWN_ENDPOINT', `Create and verify ${r} in this workspace before saving.`);
  const invalid = (
    await tx.execute<{ t: string }>(
      sql`SELECT t FROM jsonb_array_elements_text(${JSON.stringify(c.attachments.map((a) => a.target))}::jsonb) t WHERE NOT EXISTS(SELECT FROM mailbox_addresses a WHERE a.workspace_id=${w} AND (a.address=t OR a.mailbox_id=t)) LIMIT 1`,
    )
  ).rows[0];
  if (invalid) throw new ApiError(422, 'UNKNOWN_TARGET', `No receiving inbox or address ${invalid.t} in this workspace.`);
  return p;
}
async function save(tx: DbExecutor, c: Ctx, w: string, config: Config, version: number,preview=false) {
  const p = await prepare(tx, w, config),
    next = version + 1;
  if(!preview&&c.get('actor').credential==='mcp'&&c.get('actor').receivingConsent){await ownReceiving(tx,c,'rituals','workspace');}
  p.grants=(await tx.execute<{id:string}>(sql`SELECT grant_id AS id FROM mail_grant_objects WHERE workspace_id=${w} AND kind='rituals'`)).rows.map(r=>r.id);
  await tx.execute(
    sql`INSERT INTO mail_routing_state(workspace_id,version) VALUES(${w},${next}) ON CONFLICT(workspace_id) DO UPDATE SET version=excluded.version`,
  );
  await tx.execute(
    sql`INSERT INTO mail_ritual_configs VALUES(${w},${next},${JSON.stringify(config)}::jsonb,${config.attachments.length ? JSON.stringify(p) : null}::jsonb) ON CONFLICT(workspace_id) DO UPDATE SET version=excluded.version,config=excluded.config,programs=excluded.programs`,
  );
  const who = c.get('actor');
  await tx.execute(
    sql`INSERT INTO mail_routing_versions(workspace_id,version,route_ids,changed_ids,actor_type,actor_id,note) VALUES(${w},${next},ARRAY(SELECT id FROM mail_routes WHERE workspace_id=${w} ORDER BY match),ARRAY[]::text[],${who.credential ?? 'apiKey'},${who.keyId},'Ritual configuration')`,
  );
  await tx.execute(
    sql`INSERT INTO mail_ritual_versions(workspace_id,version,config,actor) VALUES(${w},${next},${JSON.stringify(config)}::jsonb,${who.keyId})`,
  );
  await tx.execute(
    sql`DELETE FROM mail_ritual_versions WHERE workspace_id=${w} AND (version<=${next - 256} OR created_at<now()-interval '1 year');`,
  );
  await tx.execute(sql`DELETE FROM mail_routing_versions WHERE workspace_id=${w} AND version<=${next - 256}`);
  return { version: next, config };
}
const versionHeader = z.object({ 'if-match': z.string().max(32).optional() });
async function edit(c: Ctx, change: (config: Config) => Config) {
  const w = ritualAdmin(c, true).workspaceId;
  return c.env.db.transaction(async (tx) => {
    await lockMailboxLane(tx, w, 'address');
    const s = await current(tx, w),
      expected = c.req.header('if-match')?.replace(/^"|"$/g, '');
    if (expected !== undefined && expected !== String(s.version))
      throw new ApiError(409, 'VERSION_CONFLICT', `Routing is now at version ${s.version}. Reload before saving.`);
    const result = await save(tx, c, w, RitualConfig.parse(change(s.config)), s.version);
    c.header('ETag', `"${result.version}"`);
    return result;
  });
}
export function registerRituals(app: App) {
  app.openapi(createRoute({...meta,method:'get',path:path+'/history',operationId:'listRitualVersions',summary:'List saved ritual versions, newest first',request:{query:z.object({cursor:z.coerce.number().int().positive().optional(),limit:z.coerce.number().int().min(1).max(100).default(25)})},responses:{200:response(z.object({data:z.array(z.object({version:z.number(),actor:z.string()})),nextCursor:z.number().nullable()})),...errors}}),async c=>{const w=ritualAdmin(c).workspaceId,q=c.req.valid('query'),rows=(await c.env.db.execute<{version:number;actor:string}>(sql`SELECT version,actor FROM mail_ritual_versions WHERE workspace_id=${w} AND version<${q.cursor??2147483647} ORDER BY version DESC LIMIT ${q.limit+1}`)).rows;return c.json({data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].version:null},200)});
  app.openapi(createRoute({...meta,method:'post',path:path+'/restore',operationId:'restoreRitualVersion',summary:'Recompile a retained version and restore it as a new version',request:{headers:versionHeader,body:json(z.object({version:z.number().int().positive()}))},responses:ok}),async c=>{const w=ritualAdmin(c,true).workspaceId,v=c.req.valid('json').version,row=(await c.env.db.execute<{config:Config}>(sql`SELECT config FROM mail_ritual_versions WHERE workspace_id=${w} AND version=${v}`)).rows[0];if(!row)throw new ApiError(404,'NOT_FOUND','Version no longer retained.');return c.json(await edit(c,()=>row.config),200)});
  const evalSettings=RitualConfig.pick({evaluateDomains:true,evaluateRoutes:true});
  app.openapi(createRoute({...meta,method:'put',path:path+'/omens',operationId:'setRitualEvaluation',summary:'Set the domains and routes that may send inbound evidence to Jev',request:{headers:versionHeader,body:json(evalSettings)},responses:ok}),async c=>c.json(await edit(c,x=>({...x,...c.req.valid('json')})),200));
  registerEndpoints(app);registerInboxConnection(app);
  const params=z.object({key:z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/)}),item=path+'/scripts/{key}';
  app.openapi(createRoute({...meta,method:'get',path:item,operationId:'getRitualEntry',summary:'Read one reusable script',request:{params},responses:{200:response(Ritual),...errors}}),async c=>{const {key}=c.req.valid('param'),s=await current(c.env.db,ritualAdmin(c).workspaceId),r=s.config.rituals.find(x=>x.key===key);if(!r)throw new ApiError(404,'NOT_FOUND','Script not found.');return c.json(r,200)});
  app.openapi(createRoute({...meta,method:'put',path:item,operationId:'putRitualEntry',summary:'Create or update one reusable script',request:{params,headers:versionHeader,body:json(Ritual)},responses:ok}),async c=>{const {key}=c.req.valid('param'),r=c.req.valid('json');if(key!==r.key)throw new ApiError(422,'INVALID_KEY','Script key must match the URL.');return c.json(await edit(c,s=>({...s,rituals:[...s.rituals.filter(h=>h.key!==key),r]})),200)});
  app.openapi(createRoute({...meta,method:'delete',path:item,operationId:'deleteRitualEntry',summary:'Remove a script and detach it everywhere',request:{params,headers:versionHeader},responses:ok}),async c=>{const {key}=c.req.valid('param');return c.json(await edit(c,s=>({...s,rituals:s.rituals.filter(h=>h.key!==key),attachments:s.attachments.filter(h=>h.ritual!==key)})),200)});
  app.openapi(
    createRoute({
      ...meta,
      method: 'put',
      path: path + '/attachments',
      operationId: 'setRitualAttachments',
      summary: 'Attach, reorder and detach rituals by replacing the ordered binding list',
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
      operationId: 'getRituals',
      summary: 'Read rituals, ordered attachments, and sender lists',
      request: { query: z.object({ version: z.coerce.number().int().positive().optional() }) },
      responses: ok,
    }),
    async (c) => {
      const w = ritualAdmin(c).workspaceId,
        v = c.req.valid('query').version;
      const r = v
        ? (
            await c.env.db.execute<{ config: Config; version: number }>(
              sql`SELECT config,version FROM mail_ritual_versions WHERE workspace_id=${w} AND version=${v}`,
            )
          ).rows[0]
        : await current(c.env.db, w);
      if (!r) throw new ApiError(404, 'NOT_FOUND', 'Ritual version not found.');
      c.header('ETag', `"${r.version}"`);
      return c.json(r, 200);
    },
  );
  app.openapi(
    createRoute({
      ...meta,
      method: 'put',
      path,
      operationId: 'putRituals',
      summary: 'Create, replace or remove rituals and ordered bindings in one version',
      request: { headers: versionHeader, body: json(RitualConfig) },
      responses: ok,
    }),
    async (c) => c.json(await edit(c, () => c.req.valid('json')), 200),
  );
  const dry = z
    .object({
      config: RitualConfig.optional(),
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
      operationId: 'testRituals',
      summary: 'Trace saved or proposed Rituals on a stored message or pasted MIME; never calls Jev or delivers mail',
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
      const w = ritualAdmin(c).workspaceId,
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
        const v = m.verdicts as typeof m.verdicts & { ritualVerified?: boolean; ritualScores?: Record<string, number> };
        email = projectEmail(m, files, v.ritualVerified === true);
        scores ??= v.ritualScores;
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
        if (q.config) await save(tx, c, w, q.config, s.version,true);
        const input = (
          await tx.execute<{ p: RoutingInput }>(
            sql`SELECT mail_route_input(${w},${JSON.stringify(email.envelope.to)}::jsonb,true) AS p`,
          )
        ).rows[0].p;
        input.programs ??= compileConfig(RitualConfig.parse({}));
        return { input, version: s.version };
      });
      const { plan, trace, steps } = await ritualPipeline(c.env, w, input, email, scores, true);
      return c.json({ version, recipients: plan.recipients, trace, steps }, 200);
    },
  );
}
