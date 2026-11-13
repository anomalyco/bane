import {createRoute,z} from '@hono/zod-openapi';
import {sql} from 'drizzle-orm';
import {ApiError,digest,errors,isSimulatedSes,response,security,type App,type Runtime} from './core.js';
import {accountBrowserRoute,accountSessionActor,accountSessionUser,settleDefaultAccount} from './account-login.js';
import {Workspace,WorkspaceRole,sessionMemberships} from './workspaces.js';
import {ConnectionSummary,connectionSummary} from './provider-connections.js';
import { productName, requestedScopes } from './brand.js';

export async function reserveSignIn(runtime:Runtime,headers:Headers) {
  const peer=await digest(headers.get('x-bane-client-ip') ?? 'unknown');
  const result=await runtime.db.execute(sql`SELECT reserve_auth_state(${peer}) AS ok`);
  if (!result.rows[0]?.ok) throw new ApiError(429,'AUTH_STATE_LIMIT','Too many pending sign-ins. Try again later.');
}
export function requireDashboardOrigin(runtime:Runtime,headers:Headers) {
  if (headers.get('origin')!==new URL(runtime.config.publicUrl).origin) throw new ApiError(403,'CSRF_ORIGIN_INVALID','Use the dashboard.');
}
export async function verifiedDashboardUser(runtime:Runtime,headers:Headers,requireCurrentEmail=false) {
  // A bearer credential (API key, MCP or agent token) never rides the session cookie. It is refused with 403, as on
  // every other dashboard-only route (core.ts); 401 is for a caller with no session at all.
  if (headers.has('authorization')) throw new ApiError(403,'DASHBOARD_AUTH_REQUIRED','Use a signed-in dashboard session.');
  const user=await accountSessionUser(runtime,headers,requireCurrentEmail);
  if (!user) throw new ApiError(401,'AUTH_REQUIRED',`Sign in to ${productName}.`);
  return {userId:user.id,email:user.email};
}
export async function invitationRecipient(runtime:Runtime,headers:Headers) {
  requireDashboardOrigin(runtime,headers);
  return verifiedDashboardUser(runtime,headers,true);
}
export const getDashboardActor = accountSessionActor;
export { settleDefaultAccount };
export function registerDashboardAuth(app: App) {
  app.on(['GET','POST','OPTIONS'],'/api/auth/*',accountBrowserRoute);
  app.openapi(createRoute({method:'get',path:'/v1/me',operationId:'getCurrentIdentity',tags:['Auth'],security,
    responses:{200:response(z.object({id:z.string(),workspaceId:z.string(),role:WorkspaceRole.nullable(),multiTenant:z.boolean(),simulated:z.boolean(),email:z.string().nullable(),name:z.string().nullable(),permissions:z.array(z.enum(['read','send','manage'])),domains:z.array(z.string()),origin:z.string().url(),host:z.string(),mcpScopes:z.array(z.string()).openapi({description:'The OAuth scopes this installation\'s MCP server asks for, for read, send and manage (nightmail:read …, or bane:read … until the account service supports nightmail:*).'}),connection:ConnectionSummary.nullable().openapi({description:'The current workspace\'s hosted sending connection; null when self-hosted.'}),workspaces:z.array(Workspace).nullable().openapi({description:'A hosted dashboard session\'s workspaces and roles (select one with X-Nightmail-Workspace); null for keys, MCP, agent tokens and self-hosted.'}),operator:z.enum(['operator','operator:read']).nullable().optional().openapi({description:`${productName} staff only: the platform operator role of this dashboard session (it opens /operator). Null for everyone else.`}),uiNotes:z.boolean().optional().openapi({description:`${productName} staff only: this session may use staff UI notes. False for everyone else.`}),
      billing:z.object({enforcement:z.enum(['off','shadow','enforce']),free:z.boolean().describe('Anomaly made this workspace free: never charged or paused for the balance.'),sending:z.enum(['ok','low','paused']),receiving:z.enum(['ok','grace','held']),autoRecharge:z.enum(['off','on','pending','failed','capped'])})
        .nullable().optional().openapi({description:'Hosted dashboard sessions: whether the workspace is free, whether an empty balance has paused sending or held received mail, and auto-recharge, so the dashboard can show it on its first frame. Null otherwise; GET /v1/billing has the detail.'})})),...errors}}),async c=>{
    const identity=c.get('actor'), userId=identity.keyId.startsWith('user_')?identity.keyId.slice(5):null;
    const origin=new URL(c.env.config.publicUrl).origin, hosted=c.env.config.multiTenant;
    const connection=hosted?await connectionSummary(c.env,identity.workspaceId):null;
    const session=hosted && identity.credential==='dashboard' && userId?await sessionMemberships(c.env.db,userId):null;
    // One statement (billing_position and the account row), only for hosted dashboard sessions: the banner's first frame.
    // Staff UI notes: an operator in UI_NOTES_SUBJECTS only (operator-identity.ts); no query when the list is empty.
    const uiNotes=session?.operator==='operator' && userId ? await import('./operator-identity.js').then(({uiNotesAllowed})=>uiNotesAllowed(c.env.db,c.env.config.uiNotesSubjects,userId)) : false;
    const billing=session?await import('./billing/state.js').then(async({readBilling})=>{const b=await readBilling(c.env.db,identity.workspaceId,{amounts:false});return {enforcement:b.enforcement,free:b.mode==='exempt',...b.state};}):null;
    return c.json({id:userId??identity.keyId,workspaceId:identity.workspaceId,role:WorkspaceRole.nullable().parse(identity.role??null),multiTenant:hosted,simulated:isSimulatedSes(c.env),email:identity.email??null,name:identity.name??null,permissions:identity.permissions,domains:identity.domains,origin,host:new URL(origin).host,mcpScopes:requestedScopes(c.env.config),connection,workspaces:session?.workspaces??null,operator:session?.operator??null,uiNotes,billing},200);
  });
}
