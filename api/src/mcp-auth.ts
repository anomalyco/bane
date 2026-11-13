import {createRoute,z} from '@hono/zod-openapi';
import {sql} from 'drizzle-orm';
import {ApiError,errors,IdParams,page,PageQuery,response,security,type App,type Ctx} from './core.js';
import {protectedResourceMetadata} from './oidc-resource.js';
export {authorizeResource as withMcpAuthorization,externalMcpGrant as getMcpGrantActor} from './oidc-resource.js';
import {auditContext,auditInsert} from './audit.js';

const Connection=z.object({id:z.string(),clientId:z.string(),name:z.string().nullable(),userEmail:z.string(),scopes:z.array(z.string()),createdAt:z.string(),updatedAt:z.string(),status:z.enum(['active','revoked','expired']),workspaceId:z.string().nullable(),receiving:z.boolean()}).openapi('McpConnection');
const Binding=z.object({workspaceId:z.string().min(1).max(200),receiving:z.boolean()}).strict().openapi('McpConnectionBinding');
// How a client's self-chosen name is shown in the connections list (ported from #90):
// - Every space, line break and control character, and the blank cells U+2800, U+FFFC and U+1D159, become one space.
// - Characters that are never drawn are dropped: default-ignorable code points (soft hyphen, grapheme joiner,
//   direction marks and overrides, word joiners, fillers, tags), lone surrogates and annotation marks.
// - Two of those shape their neighbours, so they stay where they do: a zero-width joiner or non-joiner between two
//   shown characters, and one variation selector directly after a shown character. Emoji sequences and joining
//   scripts keep their form; emoji tag sequences fall back to their base.
// - At most 160 characters. A name left without a letter, number, punctuation mark or symbol has no label ('').
const NAME_BLANK = /[\s\p{Cc}\p{Zl}\p{Zp}\u2800\uFFFC\u{1D159}]+/gu, NAME_SHOWN = /[\p{L}\p{N}\p{P}\p{S}]/u;
const NAME_HIDDEN = /^[\p{Default_Ignorable_Code_Point}\p{Cs}\uFFF9-\uFFFB]$/u;
const NAME_JOINER = /^[\u200C\u200D]$/, NAME_SELECTOR = /^[\u180B-\u180D\u180F\uFE00-\uFE0F\u{E0100}-\u{E01EF}]$/u;
export function clientLabel(name: string | null | undefined) {
  const out: string[] = [];
  // A joiner needs a shown character after it.
  const settle = () => { while (out.length && NAME_JOINER.test(out.at(-1)!)) out.pop(); };
  for (const ch of (name ?? '').replace(NAME_BLANK, ' ')) {
    const last = out.at(-1);
    if (ch === ' ') { settle(); if (out.length && out.at(-1) !== ' ') out.push(ch); }
    else if (!NAME_HIDDEN.test(ch)) out.push(ch);
    else if (last !== undefined && last !== ' ' && !NAME_JOINER.test(last) && (NAME_JOINER.test(ch) || (NAME_SELECTOR.test(ch) && !NAME_SELECTOR.test(last)))) out.push(ch);
  }
  out.length = Math.min(out.length, 160);
  settle();
  const label = out.join('').trim();
  return NAME_SHOWN.test(label) ? label : '';
}
function owner(c:Ctx) {
  const principal=c.get('actor');
  if(principal.credential!=='dashboard') throw new ApiError(403,'DASHBOARD_AUTH_REQUIRED','Use your dashboard session.');
  return principal.keyId.slice('user_'.length);
}
export function registerMcpAuth(app:App) {
  for(const path of ['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp']) app.on(['GET','HEAD','OPTIONS'],path,c=>{
    c.header('Access-Control-Allow-Origin','*');
    return c.req.method==='OPTIONS'?c.body(null,204):c.json(protectedResourceMetadata(c.env));
  });
  app.openapi(createRoute({method:'get',path:'/v1/mcp-connections',operationId:'listMcpConnections',tags:['Auth'],security,request:{query:PageQuery},responses:{200:response(page(Connection)),...errors}}),async c=>{
    const user=owner(c),{limit,cursor}=c.req.valid('query');
    const {rows}=await c.env.db.execute<{id:string;client_id:string;name:string|null;email:string;scopes:string[];created_at:string;updated_at:string;status:'active'|'revoked'|'expired';workspace_id:string|null;receiving:boolean}>(sql`
      WITH approvals AS (SELECT g.id,g.user_id,g.client_id,g.client_id AS name,ARRAY(SELECT 'bane:'||p FROM unnest(g.permissions)p) scopes,g.created_at,g.updated_at,
        CASE WHEN g.revoked THEN 'revoked' ELSE 'active' END status,g.workspace_id,g.receiving
        FROM bane_resource_grants g WHERE g.user_id=${user}
        UNION ALL SELECT id,user_id,client_id,name,scopes,created_at,updated_at,'expired',NULL,false FROM bane_expired_approvals WHERE user_id=${user})
      SELECT a.*,u.email FROM approvals a JOIN bane_users u ON u.id=a.user_id ${cursor?sql`WHERE a.id>${cursor}`:sql``} ORDER BY a.id LIMIT ${limit+1}`);
    return c.json({data:rows.slice(0,limit).map(r=>({id:r.id,clientId:r.client_id,name:clientLabel(r.name)||null,userEmail:r.email,scopes:r.scopes,createdAt:new Date(r.created_at).toISOString(),updatedAt:new Date(r.updated_at).toISOString(),status:r.status,workspaceId:r.workspace_id,receiving:r.receiving})),nextCursor:rows.length>limit?rows[limit-1]!.id:null},200);
  });
  // Chooses (or changes) the workspace an approval acts in. Credentials it created elsewhere stop at their next
  // use: agent tokens, mailbox keys and protocol passwords all check the approval's current workspace.
  app.openapi(createRoute({method:'post',path:'/v1/mcp-connections/{id}/workspace',operationId:'bindMcpConnection',tags:['Auth'],security,request:{params:IdParams,body:{required:true,content:{'application/json':{schema:Binding}}}},responses:{200:response(z.object({id:z.string(),workspaceId:z.string(),receiving:z.boolean()})),...errors}}),async c=>{
    const user=owner(c),{id}=c.req.valid('param'),{workspaceId,receiving}=c.req.valid('json');
    const {rows:[result]}=await c.env.db.execute<{revoked:boolean|null;role:string|null;bound:boolean}>(sql`WITH approval AS (SELECT revoked,client_id,workspace_id,receiving FROM bane_resource_grants WHERE id=${id} AND user_id=${user}),
      membership AS (SELECT role FROM workspace_members WHERE workspace_id=${workspaceId} AND user_id=${user} AND role IN ('owner','admin','member')),
      bound AS (UPDATE bane_resource_grants SET workspace_id=${workspaceId},receiving=${receiving},updated_at=now() WHERE id=${id} AND user_id=${user} AND NOT revoked
        AND EXISTS(SELECT FROM membership WHERE NOT ${receiving} OR role IN ('owner','admin')) RETURNING id),
      audit AS (${auditInsert(auditContext(c),{action:'mcp_connection.bind',workspaceId,userId:user,target:{type:'mcp_connection',id},
        before:sql`jsonb_build_object('clientId',approval.client_id,'workspaceId',approval.workspace_id,'receiving',approval.receiving)`,after:{workspaceId,receiving}},{from:sql`bound, approval`})})
      SELECT (SELECT revoked FROM approval) revoked,(SELECT role FROM membership) role,EXISTS(SELECT FROM bound) bound`);
    if(result?.revoked==null) throw new ApiError(404,'NOT_FOUND','MCP connection was not found.');
    if(result.revoked) throw new ApiError(409,'MCP_CONNECTION_REVOKED','This MCP connection is revoked. Reconnect the client to approve it again.');
    if(!result.role) throw new ApiError(403,'PERMISSION_DENIED','You are not a member of that workspace.');
    if(!result.bound) throw new ApiError(403,'ADMIN_REQUIRED','Receiving tools need an owner or admin of that workspace.');
    return c.json({id,workspaceId,receiving},200);
  });
  app.openapi(createRoute({method:'post',path:'/v1/mcp-connections/{id}/revoke',operationId:'revokeMcpConnection',tags:['Auth'],security,request:{params:IdParams},responses:{200:response(z.object({id:z.string(),revoked:z.literal(true)})),...errors}}),async c=>{
    const user=owner(c),{id}=c.req.valid('param');
    const changed=await c.env.db.execute(sql`WITH revoked AS (UPDATE bane_resource_grants SET revoked=true,updated_at=now() WHERE user_id=${user} AND id=${id} RETURNING id,grant_key,client_id,permissions,workspace_id),
      agents AS (UPDATE agent_tokens SET revoked_at=now() WHERE revoked_at IS NULL AND grant_id IN (SELECT id FROM revoked)),
      removed AS (DELETE FROM mail_grant_objects WHERE grant_id IN (SELECT grant_key FROM revoked)),
      audit AS (${auditInsert(auditContext(c),{action:'mcp_connection.revoke',workspaceId:sql`coalesce(revoked.workspace_id,${c.get('actor').workspaceId})`,userId:user,
        target:{type:'mcp_connection',id},before:sql`jsonb_build_object('clientId',revoked.client_id,'scopes',revoked.permissions)`},{from:sql`revoked`})})
      SELECT grant_key FROM revoked`);
    if(!changed.rowCount) throw new ApiError(404,'NOT_FOUND','MCP connection was not found.');
    return c.json({id,revoked:true as const},200);
  });
}
