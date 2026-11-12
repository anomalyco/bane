import {createRoute,z} from '@hono/zod-openapi';
import {sql} from 'drizzle-orm';
import {actor,ApiError,errors,IdParams,page,PageQuery,response,security,type App,type Ctx} from './core.js';
import {protectedResourceMetadata} from './oidc-resource.js';
export {authorizeResource as withMcpAuthorization,externalMcpGrant as getMcpGrantActor} from './oidc-resource.js';

const Connection=z.object({id:z.string(),clientId:z.string(),name:z.string().nullable(),userEmail:z.string(),scopes:z.array(z.string()),createdAt:z.string(),updatedAt:z.string()}).openapi('McpConnection');
function owner(c:Ctx) {
  const principal=actor(c,'manage');
  if(principal.credential!=='dashboard') throw new ApiError(403,'DASHBOARD_AUTH_REQUIRED','Use your dashboard session.');
  return principal.workspaceId;
}
export function registerMcpAuth(app:App) {
  for(const path of ['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp']) app.on(['GET','HEAD','OPTIONS'],path,c=>{
    c.header('Access-Control-Allow-Origin','*');
    return c.req.method==='OPTIONS'?c.body(null,204):c.json(protectedResourceMetadata(c.env));
  });
  app.openapi(createRoute({method:'get',path:'/v1/mcp-connections',operationId:'listMcpConnections',tags:['Auth'],security,request:{query:PageQuery},responses:{200:response(page(Connection)),...errors}}),async c=>{
    const workspace=owner(c),{limit,cursor}=c.req.valid('query');
    const {rows}=await c.env.db.execute<{id:string;client_id:string;email:string;permissions:string[];created_at:string}>(sql`
      SELECT g.id,g.client_id,u.email,g.permissions,g.created_at::text FROM bane_resource_grants g JOIN bane_oidc_identities i USING(issuer,subject)
      JOIN bane_users u ON u.id=i.user_id WHERE g.workspace_id=${workspace} AND g.expires_at>now() AND NOT g.revoked
      ${cursor?sql`AND g.id>${cursor}`:sql``} ORDER BY g.id LIMIT ${limit+1}`);
    return c.json({data:rows.slice(0,limit).map(r=>({id:r.id,clientId:r.client_id,name:null,userEmail:r.email,scopes:r.permissions.map(p=>'bane:'+p),createdAt:new Date(r.created_at).toISOString(),updatedAt:new Date(r.created_at).toISOString()})),nextCursor:rows.length>limit?rows[limit-1]!.id:null},200);
  });
  app.openapi(createRoute({method:'post',path:'/v1/mcp-connections/{id}/revoke',operationId:'revokeMcpConnection',tags:['Auth'],security,request:{params:IdParams},responses:{200:response(z.object({id:z.string(),revoked:z.literal(true)})),...errors}}),async c=>{
    const workspace=owner(c),{id}=c.req.valid('param');
    const changed=await c.env.db.execute(sql`UPDATE bane_resource_grants SET revoked=true WHERE workspace_id=${workspace} AND id=${id} RETURNING id`);
    if(!changed.rowCount) throw new ApiError(404,'NOT_FOUND','MCP connection was not found.');
    return c.json({id,revoked:true as const},200);
  });
}
