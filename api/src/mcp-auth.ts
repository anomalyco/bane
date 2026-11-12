import {createRoute,z} from '@hono/zod-openapi';
import {sql} from 'drizzle-orm';
import {ApiError,errors,IdParams,page,PageQuery,response,security,type App,type Ctx} from './core.js';
import {protectedResourceMetadata} from './oidc-resource.js';
export {authorizeResource as withMcpAuthorization,externalMcpGrant as getMcpGrantActor} from './oidc-resource.js';

const Connection=z.object({id:z.string(),clientId:z.string(),name:z.string().nullable(),userEmail:z.string(),scopes:z.array(z.string()),createdAt:z.string(),updatedAt:z.string(),status:z.enum(['active','revoked','expired'])}).openapi('McpConnection');
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
    const {rows}=await c.env.db.execute<{id:string;client_id:string;name:string|null;email:string;scopes:string[];created_at:string;updated_at:string;status:'active'|'revoked'|'expired'}>(sql`
      WITH approvals AS (SELECT g.id,g.user_id,g.client_id,g.client_id AS name,ARRAY(SELECT 'bane:'||p FROM unnest(g.permissions)p) scopes,g.created_at,g.updated_at,
        CASE WHEN g.revoked THEN 'revoked' ELSE 'active' END status
        FROM bane_resource_grants g WHERE g.user_id=${user}
        UNION ALL SELECT id,user_id,client_id,name,scopes,created_at,updated_at,'expired' FROM bane_expired_approvals WHERE user_id=${user})
      SELECT a.*,u.email FROM approvals a JOIN bane_users u ON u.id=a.user_id ${cursor?sql`WHERE a.id>${cursor}`:sql``} ORDER BY a.id LIMIT ${limit+1}`);
    return c.json({data:rows.slice(0,limit).map(r=>({id:r.id,clientId:r.client_id,name:r.name,userEmail:r.email,scopes:r.scopes,createdAt:new Date(r.created_at).toISOString(),updatedAt:new Date(r.updated_at).toISOString(),status:r.status})),nextCursor:rows.length>limit?rows[limit-1]!.id:null},200);
  });
  app.openapi(createRoute({method:'post',path:'/v1/mcp-connections/{id}/revoke',operationId:'revokeMcpConnection',tags:['Auth'],security,request:{params:IdParams},responses:{200:response(z.object({id:z.string(),revoked:z.literal(true)})),...errors}}),async c=>{
    const user=owner(c),{id}=c.req.valid('param');
    const changed=await c.env.db.execute(sql`WITH revoked AS (UPDATE bane_resource_grants SET revoked=true,updated_at=now() WHERE user_id=${user} AND id=${id} RETURNING id,grant_key),
      agents AS (UPDATE agent_tokens SET revoked_at=now() WHERE revoked_at IS NULL AND grant_id IN (SELECT id FROM revoked)),
      removed AS (DELETE FROM mail_grant_objects WHERE grant_id IN (SELECT grant_key FROM revoked)) SELECT grant_key FROM revoked`);
    if(!changed.rowCount) throw new ApiError(404,'NOT_FOUND','MCP connection was not found.');
    return c.json({id,revoked:true as const},200);
  });
}
