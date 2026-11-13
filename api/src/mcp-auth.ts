import {createRoute,z} from '@hono/zod-openapi';
import {sql} from 'drizzle-orm';
import {ApiError,errors,IdParams,page,PageQuery,response,security,type App,type Ctx} from './core.js';
import {protectedResourceMetadata} from './oidc-resource.js';
import { productName } from './brand.js';
export {authorizeResource as withMcpAuthorization,externalMcpGrant as getMcpGrantActor} from './oidc-resource.js';
import {auditContext,auditInsert} from './audit.js';
import {AgentTokenRecord} from './auth.js';

const Connection=z.object({id:z.string(),clientId:z.string(),name:z.string().nullable(),userEmail:z.string(),scopes:z.array(z.string()),createdAt:z.string(),updatedAt:z.string(),status:z.enum(['active','revoked','expired']),
  workspaceId:z.string().nullable().openapi({description:'The default workspace: where the connection\'s tool calls act when they name none. Null: the person\'s only workspace, else their last-used one. Each call can name another workspace of theirs.'}),
  receiving:z.boolean().openapi({description:'Deprecated, always false. Receiving tools follow the role: an owner or admin of the workspace a call names, with the manage scope (nightmail:manage, or bane:manage).'}),
  profile:z.string().nullable().openapi({description:'The label of the client entry that connected (`?profile=` on its MCP URL), to tell two entries of one client apart. Display only; it never affects access.'})}).openapi('McpConnection');
const Binding=z.object({workspaceId:z.string().min(1).max(200).openapi({description:'One of your workspaces. Until one is set, calls use your only workspace, else the one you used last.'}),
  receiving:z.boolean().optional().openapi({description:'Deprecated and ignored: receiving follows the role.'})}).strict().openapi('McpConnectionBinding');
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
/** Revokes the person's own approval: its agent tokens and everything it created end with it. False if not theirs. */
async function revokeApproval(c:Ctx,user:string,id:string){
  // Blocks the tokens of the account service's consents this approval had; a new sign-in there brings it back.
  const changed=await c.env.db.execute(sql`WITH revoked AS (UPDATE nightmail_resource_grants SET revoked=true,updated_at=now(),
      revoked_issuer_grants=CASE WHEN issuer_grant IS NULL OR issuer_grant=ANY(revoked_issuer_grants) THEN revoked_issuer_grants ELSE revoked_issuer_grants||issuer_grant END
      WHERE user_id=${user} AND id=${id} RETURNING id,grant_key,client_id,permissions,workspace_id),
    agents AS (UPDATE agent_tokens SET revoked_at=now() WHERE revoked_at IS NULL AND grant_id IN (SELECT id FROM revoked)),
    removed AS (DELETE FROM mail_grant_objects WHERE grant_id IN (SELECT grant_key FROM revoked)),
    audit AS (${auditInsert(auditContext(c),{action:'mcp_connection.revoke',workspaceId:sql`coalesce(revoked.workspace_id,${c.get('actor').workspaceId})`,userId:user,
      target:{type:'mcp_connection',id},before:sql`jsonb_build_object('clientId',revoked.client_id,'scopes',revoked.permissions)`},{from:sql`revoked`})})
    SELECT grant_key FROM revoked`);
  return !!changed.rowCount;
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
  type Row={id:string;client_id:string;name:string|null;email:string;scopes:string[];created_at:string;updated_at:string;status:'active'|'revoked'|'expired';workspace_id:string|null;receiving:boolean;profile:string|null};
  const approvals=(user:string,where:ReturnType<typeof sql>,scope:string)=>sql`
      WITH approvals AS (SELECT g.id,g.user_id,g.client_id,g.client_id AS name,ARRAY(SELECT ${scope}||p FROM unnest(g.permissions)p) scopes,g.created_at,g.updated_at,
        CASE WHEN g.revoked THEN 'revoked' ELSE 'active' END status,g.workspace_id,false AS receiving,g.profile
        FROM nightmail_resource_grants g WHERE g.user_id=${user}
        UNION ALL SELECT id,user_id,client_id,name,scopes,created_at,updated_at,'expired',NULL,false,NULL FROM nightmail_expired_approvals WHERE user_id=${user})
      SELECT a.*,u.email FROM approvals a JOIN nightmail_users u ON u.id=a.user_id ${where}`;
  const view=(r:Row)=>({id:r.id,clientId:r.client_id,name:clientLabel(r.name)||null,userEmail:r.email,scopes:r.scopes,createdAt:new Date(r.created_at).toISOString(),updatedAt:new Date(r.updated_at).toISOString(),status:r.status,workspaceId:r.workspace_id,receiving:r.receiving,profile:r.profile});
  app.openapi(createRoute({method:'get',path:'/v1/mcp-connections',operationId:'listMcpConnections',tags:['Auth'],security,deprecated:true,description:'Deprecated: listAgents lists your connected agents with their last use and the agent tokens they made.',request:{query:PageQuery},responses:{200:response(page(Connection)),...errors}}),async c=>{
    const user=owner(c),{limit,cursor}=c.req.valid('query');
    const {rows}=await c.env.db.execute<Row>(sql`${approvals(user,cursor?sql`WHERE a.id>${cursor}`:sql``,'nightmail:')} ORDER BY a.id LIMIT ${limit+1}`);
    return c.json({data:rows.slice(0,limit).map(view),nextCursor:rows.length>limit?rows[limit-1]!.id:null},200);
  });
  // Sets the connection's default workspace: where its tool calls act when they name none (an agent can also call
  // setDefaultWorkspace). It grants nothing: every call is checked against the person's membership and role in the
  // workspace it acts in, and what the approval created stays in its own workspace.
  app.openapi(createRoute({method:'post',path:'/v1/mcp-connections/{id}/workspace',operationId:'bindMcpConnection',tags:['Auth'],security,description:'Sets an MCP connection\'s default workspace, for tool calls that name none.',request:{params:IdParams,body:{required:true,content:{'application/json':{schema:Binding}}}},responses:{200:response(z.object({id:z.string(),workspaceId:z.string(),receiving:z.boolean()})),...errors}}),async c=>{
    const user=owner(c),{id}=c.req.valid('param'),{workspaceId}=c.req.valid('json');
    const {rows:[result]}=await c.env.db.execute<{revoked:boolean|null;role:string|null;bound:boolean}>(sql`WITH approval AS (SELECT revoked,client_id,workspace_id FROM nightmail_resource_grants WHERE id=${id} AND user_id=${user}),
      membership AS (SELECT role FROM workspace_members WHERE workspace_id=${workspaceId} AND user_id=${user} AND role IN ('owner','admin','member')),
      bound AS (UPDATE nightmail_resource_grants SET workspace_id=${workspaceId},updated_at=now() WHERE id=${id} AND user_id=${user} AND NOT revoked
        AND EXISTS(SELECT FROM membership) RETURNING id),
      audit AS (${auditInsert(auditContext(c),{action:'mcp_connection.bind',workspaceId,userId:user,target:{type:'mcp_connection',id},
        before:sql`jsonb_build_object('clientId',approval.client_id,'workspaceId',approval.workspace_id)`,after:{workspaceId}},{from:sql`bound, approval`})})
      SELECT (SELECT revoked FROM approval) revoked,(SELECT role FROM membership) role,EXISTS(SELECT FROM bound) bound`);
    if(result?.revoked==null) throw new ApiError(404,'NOT_FOUND','MCP connection was not found.');
    if(result.revoked) throw new ApiError(409,'MCP_CONNECTION_REVOKED',`This MCP connection is revoked in ${productName}.`);
    if(!result.role) throw new ApiError(403,'PERMISSION_DENIED','You are not a member of that workspace.');
    return c.json({id,workspaceId,receiving:false},200);
  });
  app.openapi(createRoute({method:'post',path:'/v1/mcp-connections/{id}/revoke',operationId:'revokeMcpConnection',tags:['Auth'],security,deprecated:true,description:'Deprecated: revokeAgent.',request:{params:IdParams},responses:{200:response(z.object({id:z.string(),revoked:z.literal(true)})),...errors}}),async c=>{
    const {id}=c.req.valid('param');
    if(!await revokeApproval(c,owner(c),id)) throw new ApiError(404,'NOT_FOUND','MCP connection was not found.');
    return c.json({id,revoked:true as const},200);
  });

  // ---------- agents: a sign-in and the agent tokens it made, one list ----------
  type AgentRow={id:string;client_id:string;name:string|null;profile:string|null;permissions:string[];workspace_id:string|null;created_at:string;last_used_at:string|null;status:'active'|'revoked'|'expired';own:boolean;email:string;
    tokens:{id:string;grant_id:string;permissions:('read'|'send'|'manage')[];domains:string[];purpose:string;expires_at:string;created_at:string;last_used_at:string|null;revoked_at:string|null}[]};
  const Agent=z.object({id:z.string().describe('The sign-in (mcp_…).'),clientId:z.string(),name:z.string().nullable(),profile:z.string().nullable().openapi({description:'The label of the client entry that connected (?profile= on its MCP URL). Display only.'}),
    userEmail:z.string().describe('Who signed the agent in.'),own:z.boolean().describe('Your own sign-in. Otherwise another member\'s agent that made agent tokens in this workspace (owners and admins see these).'),
    status:z.enum(['active','revoked','expired']),permissions:z.array(z.enum(['read','send','manage'])).describe('What the sign-in was approved for, before your role in each workspace narrows it.'),
    workspaceId:z.string().nullable().describe('Your sign-ins: the default workspace for calls that name none. Null otherwise.'),
    createdAt:z.string(),lastUsedAt:z.string().nullable().describe('The latest use of the sign-in or of one of its agent tokens here.'),
    tokens:z.array(AgentTokenRecord).describe('Short-lived agent tokens it made in this workspace, newest first (at most 20). Revoking the agent revokes them.')}).openapi('Agent');
  const time=(value:string|null)=>value?new Date(value).toISOString():null;
  app.openapi(createRoute({method:'get',path:'/v1/agents',operationId:'listAgents',tags:['Auth'],security,
    summary:'List connected agents and their agent tokens',
    description:`Agent tokens are how agents use ${productName}: an agent signs in over MCP as you, and can make short-lived tokens for scripts (createAgentToken). Each connected agent is listed once with its access, last use and the tokens it made in this workspace. Owners and admins also see other members' agents that made tokens here. Dashboard session only.`,
    request:{query:z.object({includeInactive:z.enum(['true','false']).default('false').describe('Also list revoked and expired sign-ins and tokens.')})},responses:{200:response(z.object({data:z.array(Agent)}).openapi('AgentList')),...errors}}),async c=>{
    const user=owner(c),a=c.get('actor'),w=a.workspaceId,all=c.req.valid('query').includeInactive==='true';
    const admin=a.role==='owner'||a.role==='admin',live=all?sql``:sql`AND t.revoked_at IS NULL AND t.expires_at>now()`;
    const {rows}=await c.env.db.execute<AgentRow>(sql`
      WITH agents AS (
        SELECT g.id,g.user_id,g.client_id,g.client_id AS name,g.profile,g.permissions,g.workspace_id,g.created_at,g.last_used_at,CASE WHEN g.revoked THEN 'revoked' ELSE 'active' END AS status,true AS own
          FROM nightmail_resource_grants g WHERE g.user_id=${user} ${all?sql``:sql`AND NOT g.revoked`}
        ${all?sql`UNION ALL SELECT e.id,e.user_id,e.client_id,e.name,NULL,ARRAY(SELECT substr(s,6) FROM unnest(e.scopes) s WHERE s LIKE 'bane:%'),NULL,e.created_at,NULL,'expired',true FROM nightmail_expired_approvals e WHERE e.user_id=${user}`:sql``}
        UNION ALL SELECT g.id,g.user_id,g.client_id,g.client_id,g.profile,g.permissions,NULL,g.created_at,g.last_used_at,CASE WHEN g.revoked THEN 'revoked' ELSE 'active' END,false
          FROM nightmail_resource_grants g WHERE ${admin} AND g.user_id<>${user} AND EXISTS(SELECT FROM agent_tokens t WHERE t.workspace_id=${w} AND t.grant_id=g.id ${live})
        ORDER BY 11 DESC,8 DESC LIMIT 200)
      SELECT a.id,a.client_id,a.name,a.profile,a.permissions,a.workspace_id,a.created_at::text,a.status,a.own,u.email,
        greatest(a.last_used_at,(SELECT max(t.last_used_at) FROM agent_tokens t WHERE t.workspace_id=${w} AND t.grant_id=a.id))::text AS last_used_at,
        coalesce((SELECT jsonb_agg(t ORDER BY t.created_at DESC) FROM (SELECT t.id,t.grant_id,t.permissions,t.domains,t.purpose,t.expires_at,t.created_at,t.last_used_at,t.revoked_at FROM agent_tokens t
          WHERE t.workspace_id=${w} AND t.grant_id=a.id ${live} ORDER BY t.created_at DESC LIMIT 20) t),'[]') AS tokens
      FROM agents a JOIN nightmail_users u ON u.id=a.user_id ORDER BY a.own DESC,a.created_at DESC`);
    const known=['read','send','manage'] as const;
    return c.json({data:rows.map(r=>({id:r.id,clientId:r.client_id,name:clientLabel(r.name)||null,profile:r.profile,userEmail:r.email,own:r.own,status:r.status,
      permissions:known.filter(p=>r.permissions.includes(p)),workspaceId:r.own?r.workspace_id:null,createdAt:time(r.created_at)!,lastUsedAt:time(r.last_used_at),
      tokens:r.tokens.map(t=>({id:t.id,grantId:t.grant_id,permissions:t.permissions,domains:t.domains,purpose:t.purpose,expiresAt:time(t.expires_at)!,createdAt:time(t.created_at)!,lastUsedAt:time(t.last_used_at),revokedAt:time(t.revoked_at)}))}))},200);
  });
  app.openapi(createRoute({method:'post',path:'/v1/agents/{id}/revoke',operationId:'revokeAgent',tags:['Auth'],security,
    summary:'Revoke a connected agent and its agent tokens',
    description:'Your own agent: its sign-in, every agent token it made and everything it created stop working at once (it can sign in again as a new connection). Another member\'s agent (owners and admins): the agent tokens it made in this workspace are revoked; the sign-in belongs to that person. Dashboard session only.',
    request:{params:IdParams},responses:{200:response(z.object({id:z.string(),revoked:z.literal(true),scope:z.enum(['agent','tokens']).describe('agent: the sign-in and everything it made. tokens: its agent tokens in this workspace.')})),...errors}}),async c=>{
    const user=owner(c),a=c.get('actor'),{id}=c.req.valid('param');
    if(await revokeApproval(c,user,id)) return c.json({id,revoked:true as const,scope:'agent' as const},200);
    if(a.role!=='owner'&&a.role!=='admin') throw new ApiError(404,'NOT_FOUND','Agent was not found.');
    const {rows}=await c.env.db.execute<{id:string}>(sql`WITH t AS (UPDATE agent_tokens SET revoked_at=now() WHERE workspace_id=${a.workspaceId} AND grant_id=${id} AND revoked_at IS NULL AND expires_at>now() RETURNING id,purpose),
      audit AS (${auditInsert(auditContext(c),{action:'agent_token.revoke',workspaceId:a.workspaceId,target:{type:'agent_token',id:sql`t.id`},before:sql`jsonb_build_object('purpose',left(t.purpose,200),'agent',${id}::text)`},{from:sql`t`})})
      SELECT id FROM t`);
    if(!rows.length && !(await c.env.db.execute(sql`SELECT FROM agent_tokens WHERE workspace_id=${a.workspaceId} AND grant_id=${id} LIMIT 1`)).rowCount) throw new ApiError(404,'NOT_FOUND','Agent was not found.');
    return c.json({id,revoked:true as const,scope:'tokens' as const},200);
  });
}
