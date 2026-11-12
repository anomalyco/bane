import {createRoute,z} from '@hono/zod-openapi';
import {sql} from 'drizzle-orm';
import {ApiError,digest,errors,isSimulatedSes,response,security,type App,type Runtime} from './core.js';
import {accountBrowserRoute,accountSessionActor,accountSessionUser} from './account-login.js';
import {Workspace,WorkspaceRole,memberships} from './workspaces.js';
import {ConnectionSummary,connectionSummary} from './provider-connections.js';

export async function reserveSignIn(runtime:Runtime,headers:Headers) {
  const peer=await digest(headers.get('x-bane-client-ip') ?? 'unknown');
  const result=await runtime.db.execute(sql`SELECT reserve_auth_state(${peer}) AS ok`);
  if (!result.rows[0]?.ok) throw new ApiError(429,'AUTH_STATE_LIMIT','Too many pending sign-ins. Try again later.');
}
export function requireDashboardOrigin(runtime:Runtime,headers:Headers) {
  if (headers.get('origin')!==new URL(runtime.config.publicUrl).origin) throw new ApiError(403,'CSRF_ORIGIN_INVALID','Use the dashboard.');
}
export async function verifiedDashboardUser(runtime:Runtime,headers:Headers) {
  const user=!headers.has('authorization') && await accountSessionUser(runtime,headers);
  if (!user) throw new ApiError(401,'AUTH_REQUIRED','Sign in to Bane.');
  return {userId:user.id,email:user.email};
}
export async function invitationRecipient(runtime:Runtime,headers:Headers) {
  requireDashboardOrigin(runtime,headers);
  return verifiedDashboardUser(runtime,headers);
}
export const getDashboardActor = accountSessionActor;
export function registerDashboardAuth(app: App) {
  app.on(['GET','POST','OPTIONS'],'/api/auth/*',accountBrowserRoute);
  app.openapi(createRoute({method:'get',path:'/v1/me',operationId:'getCurrentIdentity',tags:['Auth'],security,
    responses:{200:response(z.object({id:z.string(),workspaceId:z.string(),role:WorkspaceRole.nullable(),multiTenant:z.boolean(),simulated:z.boolean(),email:z.string().nullable(),name:z.string().nullable(),permissions:z.array(z.enum(['read','send','manage'])),domains:z.array(z.string()),origin:z.string().url(),host:z.string(),connection:ConnectionSummary.nullable().openapi({description:'Multi-tenant sending connection for the current workspace, or null (always null when self-hosted).'}),workspaces:z.array(Workspace).nullable().openapi({description:'Every workspace a signed-in multi-tenant dashboard session belongs to, with its role, by name; select one with X-Bane-Workspace. Null for API keys, MCP and agent tokens (they belong to workspaceId alone) and when self-hosted.'})})),...errors}}),async c=>{
    const identity=c.get('actor'), userId=identity.keyId.startsWith('user_')?identity.keyId.slice(5):null;
    const origin=new URL(c.env.config.publicUrl).origin, hosted=c.env.config.multiTenant;
    const connection=hosted?await connectionSummary(c.env,identity.workspaceId):null;
    const workspaces=hosted && identity.credential==='dashboard' && userId?await memberships(c.env.db,userId):null;
    return c.json({id:userId??identity.keyId,workspaceId:identity.workspaceId,role:WorkspaceRole.nullable().parse(identity.role??null),multiTenant:hosted,simulated:isSimulatedSes(c.env),email:identity.email??null,name:identity.name??null,permissions:identity.permissions,domains:identity.domains,origin,host:new URL(origin).host,connection,workspaces},200);
  });
}
