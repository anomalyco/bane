import { receivingPolicy } from './mailbox-ingest-input.js';
import {registerInboxConnection} from './inbox-connection.js';
import { createRoute, z } from '@hono/zod-openapi';
import { and, eq, sql } from 'drizzle-orm';
import { actor, ApiError, errors, json, response, security, type App, type Ctx, type DbExecutor } from './core.js';
import { recordAudit } from './audit.js';
import { mailMessages, mailAttachments, retainedMail } from './db/mailbox.js';
import { lockMailboxLane } from './mailbox-store.js';
import { rolledBack } from './routing.js';
import {
  compileConfig,
  formatDiagnostic,
  ritualPipeline,
  RitualConfig,
  RitualConfigError,
  Ritual,
  Binding,
  projectEmail,
  type Config,
  type Programs,
} from './ritual-pipeline.js';
import { compileRitual, type Diagnostic } from './ritual-engine.js';
import { closest, endpointCall, endpointPayloads, ritualCompletions, ritualTemplates, ritualTypings, type EndpointType } from './ritual-schema.js';
import type { RoutingInput } from './routing-match.js';
import { registerEndpoints } from './ritual-endpoints.js';
import { registerRitualVersion } from './ritual-version.js';

const path = '/v1/rituals',
  meta = { security, tags: ['Rituals'] },
  state = z.object({ version: z.number().int(), config: RitualConfig }),
  ok = { 200: response(state), ...errors };
const Line = z.number().int().min(1);
const TimelineStep = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('condition'), line: Line, column: Line, endLine: Line, endColumn: Line, result: z.boolean().describe('What the condition evaluated to.') }),
  z.object({ kind: z.literal('omens'), line: Line, scores: z.record(z.string(), z.union([z.number(), z.boolean()])).describe('Omen name → the answer the ritual read: the scores passed in, recorded answers or each omen’s onError value.') }),
  z.object({ kind: z.literal('action'), line: Line, op: z.string().describe('label, junk, block, drop, allow, inbox.deliver or endpoint.'), ref: z.string().optional().describe('endpoint:<name> or inbox:<key>.'), value: z.string().optional() }),
  z.object({ kind: z.literal('return'), line: Line }),
]).openapi('RitualTimelineStep');
const TraceRow = z.object({
  recipient: z.string(), kind: z.string().describe('What the ritual is attached to: inbox or address.'), key: z.string().describe('Ritual key.'),
  scores: z.record(z.string(), z.union([z.number(), z.boolean()])), steps: z.number().int(), lines: z.array(z.number().int()).describe('Statement lines run, in order (at most 128).'),
  error: z.string().nullable(), actions: z.array(z.object({ op: z.string(), ref: z.string().optional(), body: z.unknown().optional(), value: z.string().optional() })),
  timeline: z.array(TimelineStep).describe('The evaluation in order: each condition and its result, omen answers read, actions taken and the return (at most 128 steps). For stepping through a dry run.'),
}).openapi('RitualTraceRow');
export function ritualAdmin(c: Ctx, write = false) {
  const a=actor(c,!write&&c.get('actor')?.receivingConsent?'read':'manage');
  if (a.domains.length || a.role === 'member' || (write && (a.credential==='agentToken'||a.grantId&&!a.receivingConsent)))
    throw new ApiError(
      403,
      'ADMIN_REQUIRED',
      'Use a workspace administrator or reconnect with explicit receiving and manage consent.',
    );
  return a;
}
/** A receiving write by an approval, or by a key it created, holds the approval (shared lock) for the rest of the
 * transaction. It is read again here, not only when the request was authenticated: a removal under way finishes first
 * and the write is refused, and one that starts later waits for the transaction and then disables what it recorded.
 * Take it before any row a removal disables (endpoints, routes, keys), the order a removal takes them in. */
export async function holdReceiving(tx:DbExecutor,c:Ctx){
  const a=c.get('actor');if(!a.grantId)return;
  if(!a.receivingConsent||!a.permissions.includes('manage'))throw new ApiError(403,'ADMIN_REQUIRED','Explicit manage and receiving consent required.');
  const grant=await (await import('./mcp-auth.js')).getMcpGrantActor(c.env,'mcp_'+a.grantId,a.workspaceId,tx);
  if(grant?.workspaceId!==a.workspaceId||!grant.receivingConsent||!grant.permissions.includes('manage'))throw new ApiError(401,'AUTH_INVALID','The MCP approval behind this request was revoked while it ran. Nothing was changed.');
}
export async function ownReceiving(tx:DbExecutor,c:Ctx,kind:'endpoint'|'rituals'|'key'|'route',resource:string|string[]){
  const a=c.get('actor');if(!a.grantId)return;
  await holdReceiving(tx,c);
  for(const r of Array.isArray(resource)?resource:[resource])await tx.execute(sql`INSERT INTO mail_grant_objects VALUES(${a.grantId},${a.workspaceId},${kind},${r}) ON CONFLICT DO NOTHING`);
}
/** Removing an approval holds the endpoints it created or changed. An endpoint URL is write-only, so nothing is posted
 * to a held endpoint, a test included, until its URL is sent again. */
export const resumeNeedsUrl = () => new ApiError(409, 'ENDPOINT_URL_REQUIRED', 'Deliveries were held when the approval that created or changed this endpoint was removed, and its URL is write-only. Send the URL again to resume.', 'url');
async function current(tx: DbExecutor, w: string) {
  const r = (
    await tx.execute<{ version: number; config: Config | null }>(
      sql`SELECT coalesce(s.version,0) AS version,h.config FROM (SELECT 1) one LEFT JOIN mail_routing_state s ON s.workspace_id=${w} LEFT JOIN mail_ritual_configs h ON h.workspace_id=${w}`,
    )
  ).rows[0];
  return { version: r.version, config: r.config ?? RitualConfig.parse({}) };
}
type Resolved = { ref: string; id: string; type: EndpointType | 'inbox'; ready: boolean };
/** Resolves endpoint and inbox names to IDs and checks every call against its endpoint's type. */
async function analyze(tx: DbExecutor, w: string, c: Config): Promise<{ programs: Programs | null; diagnostics: Diagnostic[]; code: string }> {
  let p: Programs;
  try {
    p = compileConfig(c);
  } catch (e) {
    if (e instanceof RitualConfigError) return { programs: null, diagnostics: e.diagnostics, code: 'RITUAL_INVALID' };
    throw e;
  }
  const refs = [...new Set(Object.values(p.rituals).flatMap(ir => ir.refs))];
  const found = refs.length ? (await tx.execute<Resolved>(sql`WITH refs AS (SELECT ref,split_part(ref,':',2) AS key FROM jsonb_array_elements_text(${JSON.stringify(refs)}::jsonb) ref)
    SELECT ref,b.id,'inbox' AS type,true AS ready FROM refs JOIN mailboxes b ON b.workspace_id=${w} AND b.key=refs.key WHERE starts_with(ref,'inbox:')
    UNION ALL SELECT ref,h.id,'webhook',true FROM refs JOIN mailbox_webhooks h ON h.workspace_id=${w} AND h.key=refs.key AND NOT starts_with(h.id,'con_') WHERE starts_with(ref,'endpoint:')
    UNION ALL SELECT refs.ref,d.hook_id,split_part(d.ref,':',1),d.verified AND d.declined_at IS NULL FROM refs JOIN mail_endpoints d ON d.workspace_id=${w} AND split_part(d.ref,':',2)=refs.key WHERE starts_with(refs.ref,'endpoint:')`)).rows : [];
  const byRef = new Map(found.map(r => [r.ref, r])), diagnostics: Diagnostic[] = [];
  let names: { endpoints: string[]; inboxes: string[] } | null = null;
  const known = async () => names ??= {
    endpoints: (await tx.execute<{ name: string }>(sql`SELECT split_part(ref,':',2) AS name FROM mail_endpoints WHERE workspace_id=${w} UNION ALL SELECT key FROM mailbox_webhooks WHERE workspace_id=${w} AND key IS NOT NULL AND NOT starts_with(id,'con_') LIMIT 1000`)).rows.map(r => r.name),
    inboxes: (await tx.execute<{ key: string }>(sql`SELECT key FROM mailboxes WHERE workspace_id=${w} AND key IS NOT NULL LIMIT 1000`)).rows.map(r => r.key),
  };
  for (const [ritual, ir] of Object.entries(p.rituals))
    for (const site of ir.sites ?? []) {
      const r = byRef.get(site.ref), name = site.ref.slice(site.ref.indexOf(':') + 1), inbox = site.ref.startsWith('inbox:');
      const report = (message: string, hint?: string) => diagnostics.push({ ritual, line: site.line, column: site.column, endLine: site.line, endColumn: site.column, message, ...(hint ? { hint } : {}) });
      if (!r) {
        const options = (await known())[inbox ? 'inboxes' : 'endpoints'], guess = closest(name, options);
        if (inbox) report(`No inbox has the key ${name}.`, guess ? `Did you mean inbox.deliver("${guess}")?` : 'Give the inbox a key with updateInboundAddress, or use one listed by listInboundAddresses.');
        else report(`No endpoint named ${name}.`, guess ? `Did you mean ${endpointCall(guess)}?` : 'Create it first with createEndpoint (type slack, discord, webhook or forward).');
        continue;
      }
      if (!r.ready) { report(`${endpointCall(name)} is a forward waiting for its recipient to confirm.`, 'Rituals can call it once they choose Allow in the emailed link; getEndpoint shows its status.'); continue; }
      if (r.type === 'inbox' || r.type === 'webhook') continue;
      const shape = endpointPayloads[r.type], k = shape.fields?.[0];
      if (site.args < shape.args[0] || site.args > shape.args[1] || (k && site.fields && (site.fields.length !== 1 || site.fields[0] !== k)))
        report(`${endpointCall(name)} is a ${r.type} endpoint: call it as ${shape.signature(name).replace(/^endpoints\.[^(]+/, endpointCall(name))}.`, r.type === 'forward' ? 'A forward sends this message itself; it takes no payload.' : `Pass one record with a ${k} field.`);
    }
  p.refs = Object.fromEntries(found.map(r => [r.ref, r.id]));
  p.types = Object.fromEntries(found.map(r => [r.ref, r.type]));
  return { programs: p, diagnostics, code: diagnostics.length ? 'UNKNOWN_ENDPOINT' : '' };
}
export function invalidRituals(code: string, diagnostics: Diagnostic[]) {
  const error = new ApiError(422, code, `${formatDiagnostic(diagnostics[0]!)}${diagnostics.length > 1 ? ` (and ${diagnostics.length - 1} more in error.details)` : ''}`, 'rituals');
  error.details = diagnostics;
  return error;
}
async function prepare(tx: DbExecutor, w: string, c: Config) {
  const { programs, diagnostics, code } = await analyze(tx, w, c);
  if (!programs || diagnostics.length) throw invalidRituals(code, diagnostics);
  const invalid = (
    await tx.execute<{ t: string }>(
      sql`SELECT t FROM jsonb_array_elements_text(${JSON.stringify(c.attachments.map((a) => a.target))}::jsonb) t WHERE NOT EXISTS(SELECT FROM mailbox_addresses a WHERE a.workspace_id=${w} AND (a.address=t OR a.mailbox_id=t)) LIMIT 1`,
    )
  ).rows[0];
  if (invalid) throw new ApiError(422, 'UNKNOWN_TARGET', `No receiving inbox or address ${invalid.t} in this workspace.`, 'attachments');
  return programs;
}
async function save(tx: DbExecutor, c: Ctx, w: string, config: Config, version: number,preview=false) {
  const p = await prepare(tx, w, config),
    next = version + 1;
  const prior=(await tx.execute<{config:Config;owners:Record<string,string|null>}>(sql`SELECT config,owners FROM mail_ritual_configs WHERE workspace_id=${w} FOR UPDATE`)).rows[0];
  const bindingKey=(b:Config['attachments'][number])=>'attachment:'+b.target+':'+b.ritual;
  const parts=(cfg:Config)=>new Map<string,string>([
    ...cfg.rituals.map(r=>['ritual:'+r.key,r.source] as const),
    ...cfg.attachments.map(b=>[bindingKey(b),String(b.continue)] as const),
    ...Object.entries(cfg.senderLists).map(([k,v])=>['list:'+k,JSON.stringify(v)] as const),
    ...cfg.evaluateDomains.map(k=>['domain:'+k,k] as const),...cfg.evaluateRoutes.map(k=>['route:'+k,k] as const),
  ]);
  const before=prior&&parts(prior.config), grant=c.get('actor').grantId??null;
  if (prior && grant && !preview) {
    // Ignore additions and this approval's own bindings. What remains must be the
    // same chain, including continue flags: the first action can stop later guards.
    const protectedBindings=prior.config.attachments.filter(b=>prior.owners[bindingKey(b)]!==grant);
    const protectedKeys=new Set(protectedBindings.map(bindingKey));
    const retained=config.attachments.filter(b=>protectedKeys.has(bindingKey(b)));
    if (retained.length!==protectedBindings.length || retained.some((b,i)=>bindingKey(b)!==bindingKey(protectedBindings[i]) || b.continue!==protectedBindings[i].continue))
      throw new ApiError(403,'RITUAL_BINDING_NOT_OWNED','This approval cannot remove, change, or reorder another owner’s ritual attachments.','attachments');
  }
  p.owners=Object.fromEntries([...parts(config)].map(([k,v])=>[k,before?.get(k)===v?prior?.owners[k]??null:preview?null:grant]));
  await tx.execute(
    sql`INSERT INTO mail_routing_state(workspace_id,version) VALUES(${w},${next}) ON CONFLICT(workspace_id) DO UPDATE SET version=excluded.version`,
  );
  await tx.execute(
    sql`INSERT INTO mail_ritual_configs(workspace_id,version,config,programs,owners) VALUES(${w},${next},${JSON.stringify(config)}::jsonb,${config.attachments.length ? JSON.stringify(p) : null}::jsonb,${JSON.stringify(p.owners)}::jsonb) ON CONFLICT(workspace_id) DO UPDATE SET version=excluded.version,config=excluded.config,programs=excluded.programs,owners=excluded.owners`,
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
// Every saved version is audited with its version and what changed, never a ritual's source.
type EditAudit = { action: string; target?: { type: string; id: string }; after?: (config: Config) => Record<string, unknown> };
const counts = (x: Config) => ({ rituals: x.rituals.length, attachments: x.attachments.length, senderLists: Object.keys(x.senderLists).length });
async function edit(c: Ctx, change: (config: Config) => Config, audit: EditAudit) {
  const w = ritualAdmin(c, true).workspaceId;
  return c.env.db.transaction(async (tx) => {
    await lockMailboxLane(tx, w, 'address');
    const s = await current(tx, w),
      expected = c.req.header('if-match')?.replace(/^"|"$/g, '');
    if (expected !== undefined && expected !== String(s.version))
      throw new ApiError(409, 'VERSION_CONFLICT', `Routing is now at version ${s.version}. Reload before saving.`);
    const result = await save(tx, c, w, RitualConfig.parse(change(s.config)), s.version);
    await recordAudit(tx, c, { action: audit.action, workspaceId: w, target: audit.target ?? { type: 'rituals', id: w }, before: { version: s.version }, after: { version: result.version, ...audit.after?.(result.config) } });
    c.header('ETag', `"${result.version}"`);
    return result;
  });
}
export function registerRituals(app: App) {
  app.openapi(createRoute({...meta,method:'get',path:path+'/history',operationId:'listRitualVersions',summary:'List saved ritual versions, newest first',request:{query:z.object({cursor:z.coerce.number().int().positive().optional(),limit:z.coerce.number().int().min(1).max(100).default(25)})},responses:{200:response(z.object({data:z.array(z.object({version:z.number(),actor:z.string()})),nextCursor:z.number().nullable()})),...errors}}),async c=>{const w=ritualAdmin(c).workspaceId,q=c.req.valid('query'),rows=(await c.env.db.execute<{version:number;actor:string}>(sql`SELECT version,actor FROM mail_ritual_versions WHERE workspace_id=${w} AND version<${Math.min(q.cursor??2147483647,2147483647)} ORDER BY version DESC LIMIT ${q.limit+1}`)).rows;return c.json({data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].version:null},200)});
  app.openapi(createRoute({...meta,method:'post',path:path+'/restore',operationId:'restoreRitualVersion',summary:'Recompile a retained version and restore it as a new version',request:{headers:versionHeader,body:json(z.object({version:z.number().int().positive()}))},responses:ok}),async c=>{const w=ritualAdmin(c,true).workspaceId,v=c.req.valid('json').version,row=v>2147483647?undefined:(await c.env.db.execute<{config:Config}>(sql`SELECT config FROM mail_ritual_versions WHERE workspace_id=${w} AND version=${v}`)).rows[0];if(!row)throw new ApiError(404,'NOT_FOUND','Version no longer retained.');return c.json(await edit(c,()=>row.config,{action:'ritual.restore',after:x=>({restoredVersion:v,...counts(x)})}),200)});
  const evalSettings=RitualConfig.pick({evaluateDomains:true,evaluateRoutes:true});
  app.openapi(createRoute({...meta,method:'put',path:path+'/omens',operationId:'setOmenOptIns',summary:'Set the domains and routes that may send inbound evidence to Jev',request:{headers:versionHeader,body:json(evalSettings)},responses:ok}),async c=>c.json(await edit(c,x=>({...x,...c.req.valid('json')}),{action:'ritual.omens',after:x=>({evaluateDomains:x.evaluateDomains,evaluateRoutes:x.evaluateRoutes})}),200));
  registerEndpoints(app);
  registerInboxConnection(app);
  registerRitualVersion(app);
  const DiagnosticSchema = z.object({ ritual: z.string().optional(), line: z.number().int(), column: z.number().int(), endLine: z.number().int(), endColumn: z.number().int(), message: z.string(), hint: z.string().optional() }).openapi('RitualDiagnostic');
  app.openapi(createRoute({
    ...meta, method: 'post', path: path + '/check', operationId: 'checkRitual',
    summary: 'Compile one ritual source against this workspace without saving',
    description: 'Returns every problem with its line, column and a hint, and what the ritual calls. Use it while editing; nothing is saved, delivered or sent to Jev.',
    request: { body: json(z.object({ source: z.string().max(65536), key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).default('draft'), senderLists: RitualConfig.shape.senderLists.optional().describe('Lists to check against. Defaults to the saved sender lists.') }).strict()) },
    responses: { 200: response(z.object({ ok: z.boolean(), diagnostics: z.array(DiagnosticSchema), calls: z.array(z.string()).describe('Endpoints and inboxes the ritual calls.'), omens: z.array(z.string()), questions: z.record(z.string(), z.string()).describe('Omen name → its question. testRituals takes scores keyed by question.'), lists: z.array(z.string()) }).openapi('RitualCheck')), ...errors },
  }), async c => {
    const w = ritualAdmin(c).workspaceId, q = c.req.valid('json'), saved = await current(c.env.db, w);
    const config = RitualConfig.parse({ rituals: [{ key: q.key, source: q.source }], senderLists: q.senderLists ?? saved.config.senderLists });
    const { programs, diagnostics } = await analyze(c.env.db, w, config);
    let ir = programs?.rituals[q.key];
    if (!ir) try { ir = compileRitual(q.source); } catch { /* reported in diagnostics */ }
    return c.json({ ok: !diagnostics.length, diagnostics, calls: ir?.refs.map(r => r.startsWith('inbox:') ? `inbox.deliver("${r.slice(6)}")` : endpointCall(r.slice(9))) ?? [], omens: Object.keys(ir?.omens ?? {}), questions: Object.fromEntries(Object.entries(ir?.omens ?? {}).map(([name, omen]) => [name, omen.prompt])), lists: [...new Set(ir?.lists?.map(l => l.name) ?? [])] }, 200);
  });
  const workspaceSymbols = async (c: Ctx) => {
    const w = ritualAdmin(c).workspaceId;
    const [endpoints, inboxes, saved] = await Promise.all([
      c.env.db.execute<{ name: string; type: EndpointType; status: string }>(sql`SELECT split_part(ref,':',2) AS name,split_part(ref,':',1) AS type,CASE WHEN declined_at IS NOT NULL THEN 'declined' WHEN verified THEN 'ready' ELSE 'pending' END AS status FROM mail_endpoints WHERE workspace_id=${w}
        UNION ALL SELECT key,'webhook','ready' FROM mailbox_webhooks WHERE workspace_id=${w} AND key IS NOT NULL AND NOT starts_with(id,'con_') ORDER BY 1 LIMIT 1000`),
      c.env.db.execute<{ key: string }>(sql`SELECT key FROM mailboxes WHERE workspace_id=${w} AND key IS NOT NULL ORDER BY key LIMIT 1000`),
      current(c.env.db, w),
    ]);
    return { endpoints: endpoints.rows, inboxes: inboxes.rows.map(r => r.key), lists: Object.keys(saved.config.senderLists) };
  };
  app.openapi(createRoute({
    ...meta, method: 'get', path: path + '/typings', operationId: 'getRitualTypings',
    summary: 'TypeScript declarations and editor completions for this workspace',
    description: 'Generated from the workspace’s endpoints, inbox keys and sender lists. Load typescript into an editor as a .d.ts, or read it to learn exactly what a ritual can call.',
    responses: { 200: response(z.object({ typescript: z.string(), completions: z.array(z.object({ label: z.string(), type: z.enum(['function', 'property', 'variable', 'keyword']), detail: z.string(), info: z.string(), apply: z.string().optional() })), endpoints: z.array(z.object({ name: z.string(), type: z.enum(['slack', 'discord', 'webhook', 'forward']), status: z.string() })), inboxes: z.array(z.string()), lists: z.array(z.string()) }).openapi('RitualTypings')), ...errors },
  }), async c => {
    const symbols = await workspaceSymbols(c);
    c.header('Cache-Control', 'no-store');
    return c.json({ typescript: ritualTypings(symbols), completions: ritualCompletions(symbols), ...symbols }, 200);
  });
  app.openapi(createRoute({
    ...meta, method: 'get', path: path + '/templates', operationId: 'listRitualTemplates',
    summary: 'Starting points for common rituals, filled in with this workspace’s endpoints',
    description: 'Each template compiles. An endpoint template uses the first endpoint of the type it needs; endpoint is null when there is none yet, and source then uses a placeholder name to replace.',
    responses: { 200: response(z.object({ data: z.array(z.object({ id: z.string(), name: z.string(), description: z.string(), needs: z.enum(['slack', 'discord', 'webhook', 'forward']).nullable(), endpoint: z.string().nullable(), source: z.string() })) }).openapi('RitualTemplates')), ...errors },
  }), async c => {
    const { endpoints } = await workspaceSymbols(c);
    return c.json({ data: ritualTemplates.map(t => {
      const endpoint = t.needs ? endpoints.find(e => e.type === t.needs && e.status === 'ready')?.name ?? null : null;
      return { id: t.id, name: t.name, description: t.description, needs: t.needs ?? null, endpoint, source: t.source(endpoint ?? undefined) };
    }) }, 200);
  });
  const params=z.object({key:z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/)}),item=path+'/scripts/{key}';
  app.openapi(createRoute({...meta,method:'get',path:item,operationId:'getRitual',summary:'Read one reusable script',request:{params},responses:{200:response(Ritual),...errors}}),async c=>{const {key}=c.req.valid('param'),s=await current(c.env.db,ritualAdmin(c).workspaceId),r=s.config.rituals.find(x=>x.key===key);if(!r)throw new ApiError(404,'NOT_FOUND','Script not found.');return c.json(r,200)});
  app.openapi(createRoute({...meta,method:'put',path:item,operationId:'saveRitual',summary:'Create or update one reusable script',request:{params,headers:versionHeader,body:json(Ritual)},responses:ok}),async c=>{const {key}=c.req.valid('param'),r=c.req.valid('json');if(key!==r.key)throw new ApiError(422,'INVALID_KEY','Script key must match the URL.');return c.json(await edit(c,s=>({...s,rituals:[...s.rituals.filter(h=>h.key!==key),r]}),{action:'ritual.save',target:{type:'ritual',id:key},after:()=>({key})}),200)});
  app.openapi(createRoute({...meta,method:'delete',path:item,operationId:'deleteRitual',summary:'Remove a script and detach it everywhere',request:{params,headers:versionHeader},responses:ok}),async c=>{const {key}=c.req.valid('param');return c.json(await edit(c,s=>({...s,rituals:s.rituals.filter(h=>h.key!==key),attachments:s.attachments.filter(h=>h.ritual!==key)}),{action:'ritual.delete',target:{type:'ritual',id:key},after:()=>({key})}),200)});
  app.openapi(
    createRoute({
      ...meta,
      method: 'put',
      path: path + '/attachments',
      operationId: 'attachRituals',
      summary: 'Attach, reorder and detach rituals by replacing the ordered binding list',
      request: { headers: versionHeader, body: json(z.object({ attachments: z.array(Binding).max(256) })) },
      responses: ok,
    }),
    async (c) => c.json(await edit(c, (config) => ({ ...config, ...c.req.valid('json') }), { action: 'ritual.attach', after: (x) => ({ attachments: x.attachments.length, rituals: [...new Set(x.attachments.map((b) => b.ritual))] }) }), 200),
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
      operationId: 'applyRituals',
      summary: 'Create, replace or remove rituals and ordered bindings in one version',
      request: { headers: versionHeader, body: json(RitualConfig) },
      responses: ok,
    }),
    async (c) => c.json(await edit(c, () => c.req.valid('json'), { action: 'ritual.apply', after: counts }), 200),
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
            trace: z.array(TraceRow),
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
        actor(c,'manage');
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
            sql`SELECT mail_route_input(${w},${JSON.stringify(email.envelope.to)}::jsonb,true,${receivingPolicy(c.env.config)}::jsonb) AS p`,
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
