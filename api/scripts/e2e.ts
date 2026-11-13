// Public client only: no database, dashboard session, provider credentials or test-mode shortcuts.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { assertResponse, contract } from './e2e-contract.js';
import { setTimeout as delay } from 'node:timers/promises';
import { crc32, deflateSync } from 'node:zlib';
import * as sdk from '../../sdk/src/sdk.gen.js';
import { createClient } from '../../sdk/src/client/index.js';
import type { SendEmailInput } from '../../sdk/src/types.gen.js';

type Op = keyof typeof sdk;
const dashboard = 'Requires a signed-in dashboard session, not an API key.';
const shared = 'Would change shared domain, routing, provider or workspace configuration.';
const subdomain = 'Hosted receiving follows exact verified DNS; no wildcard/subdomain fixture.';
const byoV2 = 'Regional BYO setup requires a dashboard owner and a customer AWS account, not the Hosted fixture.';
// Deliberately enumerate IDs (not paths, tags or prefixes): a new endpoint must never auto-skip.
const safeModeSkips: Partial<Record<Op, string>> = {
  listMcpConnections: dashboard, revokeMcpConnection: dashboard, bindMcpConnection: dashboard, listAgents: dashboard, revokeAgent: dashboard,
  createAgentToken: 'Only an MCP OAuth principal can mint an agent token.',
  revokeAgentToken: 'Manage keys can revoke, but cannot mint a run-owned OAuth agent token to revoke.',
  listWorkspaces: dashboard, createWorkspace: dashboard, renameCurrentWorkspace: shared, listWorkspaceMembers: dashboard,
  inviteWorkspaceMember: dashboard, createWorkspaceInvitation: dashboard, listWorkspaceInvitations: dashboard,
  revokeWorkspaceInvitation: dashboard, updateWorkspaceMember: dashboard, removeWorkspaceMember: dashboard,
  acceptWorkspaceInvitation: dashboard,
  getConnection: dashboard, listConnectionRegions: dashboard, createConnection: shared,
  verifyConnection: 'BYO AWS-role verification, not Hosted mail.', deleteConnection: 'Would disconnect this shared workspace.',
  updateWorkspaceSettings: shared, configureRegion: shared, provisionRegion: shared, configureRegionAutoValidation: shared,
  createDomain: 'Creates an SES identity/domain claim; the runner does not provision DNS or AWS resources.',
  deleteDomain: 'The verified claim is shared by every run.', configureDomainMailFrom: shared,
  getDomainDnsSetup: dashboard, completeDomainDnsSetup: 'Browser return with signed Domain Connect token and OIDC session.',
  receiveSesSnsEvent: 'Authenticated AWS ingress; indirect coverage via real SES feedback, never forge SNS.',
  unsubscribeOneClick: 'Leaves a persistent recipient opt-out; consent CRUD uses a fresh simulator contact instead.',
  importTemplateImage: 'Requires a remote HTTPS image source; test assets are generated in-process.',
  updateInboundDomain: shared, enableInboundDomain: 'Hosted receiving follows DNS; there is no run-owned domain to enable.',
  disableInboundDomain: 'Hosted receiving cannot be disabled via API; removing the shared MX would break delivery.',
  createInboundSubdomain: subdomain, updateInboundSubdomain: subdomain, removeInboundSubdomain: subdomain,
  getInboundSubdomain: subdomain,
  refreshConnectionScan: byoV2, importConnectionDomains: byoV2, getConnectionRegionStatus: byoV2,
};
const destructive = process.env.BANE_E2E_ALLOW_DESTRUCTIVE === '1';
const SKIP: Partial<Record<Op,string>> = destructive ? {
  createWorkspace: 'OIDC dashboard only; no public delete for a newly created workspace.',
  createConnection: 'Would replace or reconfigure the sole shared Hosted connection; happy path requires a dashboard owner.',
  deleteConnection: 'Would disconnect the fixture and release shared domain claims if authorization regressed.',
  provisionRegion: 'Queues real AWS resource provisioning; no run-owned region or rollback.',
  configureRegionAutoValidation: 'Changes SES validation behavior for shared configuration sets; no run-owned configuration set.',
  disableInboundDomain: 'Would disable receiving on the shared MX fixture if the Hosted guard regressed.',
  createInboundSubdomain: 'Hosted receiving has no wildcard claim; creating the first child could enable catch-all routing on the shared fixture.',
  completeDomainDnsSetup: 'Needs the signed Domain Connect consent return and an initiating OIDC session for the success flow.',
  receiveSesSnsEvent: 'AWS-signed ingress only. Verified indirectly by real deliveries and feedback; never forge SNS.',
} : safeModeSkips;
SKIP.updateInboundScanPolicy='Changes a shared workspace-wide quarantine policy; covered by isolated acceptance.';
// The audit trail's customer view and the support integration: a Google dashboard session, or a support grant minted by
// an operator. The isolated acceptance suite covers them, including the 403 every customer credential gets.
const supportInternal = 'Internal: needs a support grant minted by an operator; covered by isolated acceptance.';
Object.assign(SKIP, {
  listActivity: 'Google dashboard owners and admins only; covered by isolated acceptance.',
  contactSupport: 'Google dashboard only; creates a support handoff; covered by isolated acceptance.',
  getSupportContext: supportInternal, listSupportWorkspaces: supportInternal, listSupportDomains: supportInternal, listSupportEmails: supportInternal, getSupportEmail: supportInternal,
  listSupportEvents: supportInternal, listSupportWebhookDeliveries: supportInternal, getSupportStanding: supportInternal, getSupportBilling: supportInternal, listSupportAudit: supportInternal,
  getSupportRequest: supportInternal, listSupportRequests: supportInternal, getSupportDeliveryMetrics: supportInternal, getSupportBounceReasons: supportInternal, getSupportDomainHealth: supportInternal, getSupportScreen: supportInternal,
  listSupportCampaigns: supportInternal, getSupportCampaign: supportInternal, getSupportEmailLint: supportInternal, getSupportCampaignLint: supportInternal, getSupportAudienceHealth: supportInternal,
});
SKIP.retryInboundWebhookDelivery='Requires an exhausted run-owned inbound delivery; retries and leases are exercised offline.';
// The receiving MVP (routing, rituals, endpoints, agent inboxes) is exercised end to end by the isolated acceptance
// suite. Live steps need a run-owned receiving host and the R2 mail store on dev; until then each operation is
// listed here by ID so the report shows it as skipped, never silently covered.
// Billing: reads run in the plan-usage step. Moving money needs a signed-in owner (or, for a top-up link, a Stripe
// Checkout session a person pays); the isolated acceptance suite covers them against a fake Stripe.
Object.assign(SKIP, {
  createBillingTopUp: dashboard,
  updateBillingAutoRecharge: dashboard,
  createBillingCardSetup: dashboard,
  deleteBillingPaymentMethod: dashboard,
  createBillingTopUpLink: 'Opens a Stripe Checkout session for a person to pay; covered by isolated acceptance with a fake Stripe.',
  getBillingPayment: 'Needs a run-owned payment; the E2E workspace never pays. Covered by isolated acceptance.',
});
const receivingMvp = 'Receiving MVP: covered by isolated acceptance; live steps follow the dev R2 mail-store rollout.';
Object.assign(SKIP, {
  getRouting: receivingMvp,
  applyRouting: receivingMvp,
  listRoutes: receivingMvp,
  createRoute: receivingMvp,
  getRoute: receivingMvp,
  updateRoute: receivingMvp,
  deleteRoute: receivingMvp,
  getRoutingAudit: receivingMvp,
  listRoutingVersions: receivingMvp,
  getRoutingVersion: receivingMvp,
  restoreRoutingVersion: receivingMvp,
  testRouting: receivingMvp,
  listRitualVersions: receivingMvp,
  getRitualVersion: receivingMvp,
  restoreRitualVersion: receivingMvp,
  setOmenOptIns: receivingMvp,
  listEndpoints: receivingMvp,
  createEndpoint: receivingMvp,
  getEndpoint: receivingMvp,
  updateEndpoint: receivingMvp,
  deleteEndpoint: receivingMvp,
  sendEndpointVerification: receivingMvp,
  testEndpoint: receivingMvp,
  createInboxConnection: receivingMvp,
  checkRitual: receivingMvp,
  getRitualTypings: receivingMvp,
  listRitualTemplates: receivingMvp,
  getRitual: receivingMvp,
  saveRitual: receivingMvp,
  deleteRitual: receivingMvp,
  attachRituals: receivingMvp,
  getRituals: receivingMvp,
  applyRituals: receivingMvp,
  testRituals: receivingMvp,
  createInbox: receivingMvp,
  listInboxes: receivingMvp,
  ...(!destructive?{createInboxFolder:receivingMvp,updateInboxFolder:receivingMvp,deleteInboxFolder:receivingMvp,listInboxAppPasswords:receivingMvp,createInboxAppPassword:'A real password starts a billable day. Isolated positive test; dev probes a nonexistent inbox.',revokeInboxAppPassword:receivingMvp}:{}),
  getInbox: receivingMvp,
  listInboxFolders:receivingMvp, getInboxChanges:receivingMvp, copyInboxMessage:receivingMvp, moveInboxMessage:receivingMvp, deleteInboxMessage:receivingMvp, expungeInboxFolder:receivingMvp,
  updateInbox: receivingMvp,
  deleteInbox: receivingMvp,
  simulateInboxMessage: receivingMvp,
  listInboxMessages: receivingMvp,
  getInboxMessage: receivingMvp,
  updateInboxMessage: receivingMvp,
  getInboxAttachment: receivingMvp,
  releaseRetiredAddress: receivingMvp,
  testInboundWebhook: receivingMvp,
  redeliverInboundMessage: receivingMvp,
} satisfies Partial<Record<Op, string>>);

const started = Date.now();
const prefix = `e2e-${started}-${randomUUID().slice(0, 12)}`;
// Workflows supply the verified domain and ID for their own installation.
const setting = (suffix: string) => process.env[`BANE_E2E_${suffix}`] ?? process.env[`OPENSEND_E2E_${suffix}`];
const domain = setting('DOMAIN') ?? 'e2e.bane.mx', domainId = setting('DOMAIN_ID') ?? 'dom_1aa89a5a687348e89699f5cd97f5496b', region = setting('REGION') ?? 'us-east-2';
const from = `${prefix}@${domain}`, inbox = `${prefix}-in@${domain}`;
// SES supports +labels on all three mailboxes. Never reuse a real contact or retained suppression.
const simulator = (kind: 'success' | 'bounce' | 'complaint', label = '') => `${kind}+${prefix}${label}@simulator.amazonses.com`;
const success = simulator('success'), singleSuccess = simulator('success', '-single'), bounce = simulator('bounce'), complaint = simulator('complaint');
const subject = `Bane E2E ${prefix}`, text = `Bane delivery check ${prefix}.`;
const html = `<p>${text}</p>`;
const webhookUrl = 'https://example.com/';
const key = setting('API_KEY');
const base = new URL(setting('URL') ?? 'https://bane.mx');
const client = createClient({ baseUrl: base.origin, redirect: 'error', auth: scheme => scheme.scheme === 'bearer' ? key : undefined });
const attempted = new Set<Op>();
const successResponses = new Set<Op>();
const errorResponses = new Set<Op>();
const providerAccepted = new Set<string>();
let sendBudget = 0;
type Step = { name: string; operationIds: Op[]; status: 'pass' | 'fail'; ms: number; requestId?: string | null; error?: string };
const steps: Step[] = [];
const ctx = new AsyncLocalStorage<{ last?: string; requestId: string | null; ops: Set<Op> }>();
const cleanups: { name: string; fn: () => Promise<unknown> }[] = [];
const defer = (name: string, fn: () => Promise<unknown>) => cleanups.push({ name, fn });
let deadline = started + 155_000, failures = 0;
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
type Input<K extends Op> = NonNullable<Parameters<typeof sdk[K]>[0]>;
type Output<K extends Op> = NonNullable<Awaited<ReturnType<typeof sdk[K]>>['data']>;
class ApiFailure extends Error {
  constructor(op: Op, readonly status: number | undefined, readonly code: string | undefined) {
    super(`${op}: HTTP ${status ?? 'transport failure'} ${code ?? 'no API error code'}`);
  }
}
async function api<K extends Op>(op: K, input: Input<K>): Promise<Output<K>> {
  check(contract.has(op) && !SKIP[op], `unregistered or skipped operation ${op}`);
  const ms = Math.min(op === 'renderCampaignPreviewImage' || op === 'renderCampaignTemplatePreviewImage' ? 30_000 : 12_000, deadline - Date.now());
  check(ms > 0, `run deadline before ${op}`);
  const state = ctx.getStore();
  if (state) { state.last = op; state.requestId = null; state.ops.add(op); }
  attempted.add(op);
  // Count pessimistically: replays, conflicts and tomorrow's canceled campaign also reserve
  // capacity before the request. Never assume a failed transport implies nothing was sent.
  if (['sendEmail','sendEmailBatch','sendCampaign','testCampaign','scheduleCampaign','createInboundThread','replyToInboundThread'].includes(op)) {
    sendBudget += op === 'sendEmailBatch' ? (input as Input<'sendEmailBatch'>).body.emails.length : 1;
    check(sendBudget <= 25, 'refusing to exceed 25 live recipient admissions');
  }
  // Keep the generated method's input/output tied to its key; no handwritten route or schema.
  const call = sdk[op] as (opts: Input<K>) => ReturnType<typeof sdk[K]>;
  // A request that never got a response has no request ID: keep the error's name and cause code (never its message,
  // which can carry the URL) so a transport failure says whether it was a timeout, a reset or a refused connection.
  let transport: string | undefined;
  const result = await call({ ...input, client: input.client ?? client, signal: AbortSignal.timeout(ms), fetch: async (request: Request) => {
    let response: Response;
    try { response = await fetch(request); } catch (error) {
      const e = error as { name?: unknown; cause?: { code?: unknown; name?: unknown } };
      transport = [e.name, e.cause?.code ?? e.cause?.name].filter(v => typeof v === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(v)).join(' ') || 'unknown';
      throw error;
    }
    if (state) state.requestId = response.headers.get('x-request-id');
    return response;
  }});
  const apiError = 'error' in result ? result.error?.error : undefined;
  if (state) state.requestId = result.response?.headers.get('x-request-id') ?? apiError?.requestId ?? null;
  if (result.response) {
    assertResponse(op,result.response.status,result.response.headers.get('content-type'),result.response.ok ? result.data : 'error' in result ? result.error : undefined);
    const requestId = result.response.headers.get('x-request-id');
    check(requestId && (!apiError || apiError.requestId === requestId),`${op}: missing or mismatched request ID`);
    (result.response.ok ? successResponses : errorResponses).add(op);
  }
  // Never serialize SDK errors: request objects, tokens, and unrelated mail can all be sensitive.
  if (result.data === undefined || !result.response?.ok) throw new ApiFailure(op, result.response?.status, apiError?.code ?? (transport && `(${transport})`));
  return result.data as Output<K>;
}
async function expectDenial(call: () => Promise<unknown>, status: number, code: string) {
  try { await call(); } catch (error) {
    if (error instanceof ApiFailure && error.status === status && error.code === code) return;
    throw error;
  }
  throw new Error(`expected ${status} ${code}, got success`);
}
async function step<T>(name: string, work: () => Promise<T>) {
  const trace = { requestId: null, ops: new Set<Op>() };
  return ctx.run(trace, async () => {
    const start = Date.now();
    try {
      const result = await work();
      steps.push({ name, operationIds: [...trace.ops], status: 'pass', ms: Date.now() - start });
      console.log(`✓ ${name} (${Date.now() - start} ms)`);
      return result;
    } catch (error) {
      failures++;
      const message = error instanceof Error ? error.message : 'unexpected failure';
      steps.push({ name, operationIds: [...trace.ops], status: 'fail', ms: Date.now() - start, requestId: trace.requestId, error: `${ctx.getStore()?.last ?? 'local'}: ${message}` });
      console.error(`✗ ${name} (${Date.now() - start} ms): ${message} [${ctx.getStore()?.last ?? 'local'} requestId=${trace.requestId ?? 'unavailable'}]`);
    }
  });
}
async function until<T>(label: string, read: () => Promise<T>, ready: (value: T) => boolean, describe: (value: T) => string | Promise<string>, maxMs = 90_000) {
  const end = Math.min(Date.now() + maxMs, deadline);
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    const remaining = end - Date.now();
    if (remaining <= 0) throw new Error(`timed out waiting for ${label}; last: ${await describe(value)}`);
    await delay(Math.min(2000, remaining));
  }
}
function hasId(page: { data: { id: string }[] }, id: string) { return page.data.some(row => row.id === id); }
async function listed<T extends { id: string }>(id: string, read: (cursor?: string) => Promise<{ data: T[]; nextCursor: string | null }>) {
  let cursor: string | undefined;
  do {
    const page = await read(cursor), row = page.data.find(r => r.id === id);
    if (row) return row;
    check(page.nextCursor !== cursor, 'pagination cursor did not advance');
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  throw new Error(`run-owned record not listed: ${id}`);
}
async function workspaceReads() {
  check((await api('getWorkspaceSettings', {})).name === 'E2E', 'unexpected workspace name');
  const catalog = await api('listRegions', {});
  check(catalog.data.some(r => r.region === region && r.enabled) && catalog.data.some(r => r.region === catalog.defaultRegion && r.isDefault), 'invalid regional catalog');
  const tokens = await api('listAgentTokens', { query: { includeInactive: 'false', limit: 1 } });
  check(Array.isArray(tokens.data) && tokens.data.every(t => t.id.startsWith('agt_') && t.revokedAt === null && !('token' in t)), 'invalid active agent-token metadata');
  // Overview's setup in one read. Each part follows its own list operation: this unrestricted manage key (listAgentTokens
  // above) reads domains, keys (itself at least) and webhooks; an API key has no invitations and no workspace list.
  const setup = await api('getOverviewSetup', {});
  check(setup.domains !== null && setup.domains.data.length > 0 && (setup.apiKeys?.active ?? 0) >= 1 && setup.webhooks !== null && setup.invitations === null, 'invalid Overview setup summary');
  check((await api('getCurrentIdentity', {})).workspaces === null, 'an API key must not list dashboard memberships');
  // Even an unrestricted workspace manager must not see the shared SES account.
  await expectDenial(() => api('getSesSettings', { query: { region } }), 403, 'SHARED_ACCOUNT_PRIVATE');
  await expectDenial(() => api('discoverRegion', { path: { region } }), 409, 'CONNECTION_MANAGED_REGION');
}
async function devBoundaries() {
  // Gateway operations are private, not SDK operations. A public runner must never have its signer.
  for (const op of ['subject','snapshot','body','append','projections']) {
    const response=await fetch(new URL('/internal/v1/mail',base),{method:'POST',redirect:'error',signal:AbortSignal.timeout(12000),body:JSON.stringify({op})});
    check(response.status===403,`unsigned protocol ${op} must be denied`);
  }
  // Exercise the deployed routes without enabling billing or modifying a shared inbox.
  const missingInbox={id:'mbx_'+randomUUID().replaceAll('-','')},missingFolder={...missingInbox,folder:'drafts'};
  await expectDenial(()=>api('createInboxFolder',{path:missingInbox,body:{path:'Check'}}),404,'NOT_FOUND');
  await expectDenial(()=>api('updateInboxFolder',{path:missingFolder,body:{subscribed:false}}),404,'NOT_FOUND');
  await expectDenial(()=>api('deleteInboxFolder',{path:missingFolder}),404,'NOT_FOUND');
  check(!(await api('listInboxAppPasswords',{path:missingInbox})).data.length,'unexpected password listing');
  check((await api('listAppPasswords',{})).data.every(p=>p.inboxId.startsWith('mbx_')&&!('password' in p)),'invalid workspace password listing');
  await expectDenial(()=>api('createInboxAppPassword',{path:missingInbox,body:{name:'Check',protocols:['imap']}}),409,'INBOX_UNAVAILABLE');
  await expectDenial(()=>api('revokeInboxAppPassword',{path:{...missingInbox,passwordId:'app_missing'}}),404,'NOT_FOUND');
  // Valid inputs, nonexistent IDs where possible. A 403/404 covers isolation, NOT the
  // dashboard/BYO happy path: report these operations separately from 2xx coverage.
  const fake = {id:prefix}, path = {id:domainId}, child = {...path, subdomainId:prefix};
  const invite = {email:simulator('success','-invite'),role:'member'} as const;
  // The generated SDK correctly does not attach bearer auth to cookie-only routes.
  // Explicitly present the real E2E API key here to test 403, not anonymous 401.
  const apiKeyClient = createClient({baseUrl:base.origin,redirect:'error',headers:{Authorization:`Bearer ${key}`}});
  async function denied<K extends Op>(op: K, input: Input<K>, status = 403, code = 'DASHBOARD_AUTH_REQUIRED') {
    await step(`${op}: rejects unauthorized or invalid input`,()=>expectDenial(()=>api(op,{...input,client:apiKeyClient}),status,code));
  }
  // Intentionally sequential: don't issue a burst of requests against dashboard endpoints.
  for (const op of ['listWorkspaces','listWorkspaceMembers','listWorkspaceInvitations','listMcpConnections','listAgents'] as const) await denied(op,{});
  await denied('renameCurrentWorkspace',{body:{name:'E2E'}});
  await denied('inviteWorkspaceMember',{body:invite});
  await denied('createWorkspaceInvitation',{body:invite});
  await denied('revokeWorkspaceInvitation',{query:fake});
  await denied('acceptWorkspaceInvitation',{path:fake,headers:{Origin:base.origin}});
  await denied('updateWorkspaceMember',{path:fake,body:{role:'member'}});
  await denied('removeWorkspaceMember',{path:fake});
  await denied('revokeMcpConnection',{path:fake});
  await denied('revokeAgent',{path:fake});
  await denied('bindMcpConnection',{path:fake,body:{workspaceId:prefix,receiving:false}});
  await denied('createAgentToken',{body:{permissions:['read'], domains:[domain], expiresInSeconds:30, purpose:prefix}},403,'MCP_AUTHORIZATION_REQUIRED');
  await denied('revokeAgentToken',{path:fake},404,'NOT_FOUND');
  for (const op of ['getConnection','listConnectionRegions','refreshConnectionScan','getConnectionRegionStatus'] as const) await denied(op,{},403,'PERMISSION_DENIED');
  await denied('verifyConnection',{body:{awsAccountId:'000000000000'}},403,'PERMISSION_DENIED');
  await denied('importConnectionDomains',{body:{revision:1,candidateIds:[prefix],confirm:true}},403,'PERMISSION_DENIED');
  await denied('getDomainDnsSetup',{path},403,'PERMISSION_DENIED');
  await denied('configureDomainMailFrom',{path,body:{mailFromDomain:domain}},422,'MAIL_FROM_DOMAIN_INVALID');
  await denied('deleteDomain',{path:fake},404,'NOT_FOUND');
  await denied('configureRegion',{path:{region},body:{enabled:true}},409,'CONNECTION_MANAGED_REGION');
  await denied('getInboundSubdomain',{path:child},404,'NOT_FOUND');
  await denied('updateInboundSubdomain',{path:child,body:{metadata:{test:prefix}}},404,'NOT_FOUND');
  await denied('removeInboundSubdomain',{path:child},409,'HOSTED_RECEIVING_MANAGED');
  const row = await api('getInboundDomain',{path});
  check(row.status === 'active','refusing to enable an inactive shared fixture');
  await denied('updateInboundDomain',{path,body:{acceptSubdomains:row.subdomains.enabled}},409,'HOSTED_RECEIVING_MANAGED');
  check((await api('enableInboundDomain',{path,body:{force:false}})).status === 'active','already-enabled Hosted domain changed state');
  check((await api('updateWorkspaceSettings',{body:{name:'E2E'}})).name === 'E2E','idempotent workspace update failed');
  const existing = await api('createDomain',{body:{name:domain}});
  check('id' in existing && existing.id === domainId,'re-adding the verified claim allocated another domain');
  await denied('getCurrentIdentity',{headers:{'X-Bane-Environment':'test','X-OpenSend-Environment':'test'}},400,'ENVIRONMENT_REMOVED');
  await denied('createContact',{body:{email:'not-an-email'}},422,'VALIDATION_FAILED');
}

async function regionalSend() {
  const va = 'e2e-va.bane.mx', sendRegion = 'us-east-1', sender = `${prefix}@${va}`, to = simulator('success','-va');
  const page = await api('listDomains',{query:{region:sendRegion,refresh:'false',limit:10}});
  check(page.data.some(d => d.name === va && d.region === sendRegion && d.ready),'Virginia verified sending fixture not ready');
  const receipt = await api('sendEmail',{headers:idKey('virginia'),body:{from:sender,to:[to],region:sendRegion,subject,text}});
  await outcome(receipt.id,to,'delivered',sender,sendRegion);
}

async function mcpChallenge() {
  const trace = ctx.getStore()!;
  const get = async <T>(url: URL) => { trace.last = `GET ${url.href}`; trace.requestId = null; const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(12000) }); trace.requestId = res.headers.get('x-request-id'); check(res.ok, `${url.pathname} returned ${res.status}`); return await res.json() as T; };
  // /mcp accepts an access token from the account service (ES256 JWT), not the API's keys or agent tokens. OpenCode adds
  // ?codemode=false to the URL; both ask for every Bane scope, since clients request what the challenge names.
  for (const [path, bearer] of [['/mcp', null], ['/mcp?codemode=false', null], ['/mcp', key]] as const) {
    trace.last = `POST ${path}${bearer ? ' (API key)' : ''}`; trace.requestId = null;
    const res = await fetch(new URL(path, base), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000), headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
    trace.requestId = res.headers.get('x-request-id');
    const challenge = res.headers.get('www-authenticate') ?? '';
    const rpc = await res.json() as { jsonrpc?: string; error?: { code: number } };
    check(res.status === 401 && rpc.jsonrpc === '2.0' && rpc.error?.code === -32000 && challenge.includes(`resource_metadata="${base.origin}/.well-known/oauth-protected-resource/mcp"`)
      && challenge.includes('scope="bane:read bane:send bane:manage"'), 'MCP OAuth discovery challenge changed');
  }
  const resource = await get<{ resource?: string; authorization_servers?: string[]; scopes_supported?: string[] }>(new URL('/.well-known/oauth-protected-resource/mcp', base));
  check(resource.resource === `${base.origin}/mcp` && resource.authorization_servers?.length === 1 && ['bane:read', 'bane:send', 'bane:manage'].every(scope => resource.scopes_supported?.includes(scope)), 'MCP protected resource metadata changed');
  // The account service is the authorization server. OpenCode signs in with a client metadata document as its client_id.
  const issuer = resource.authorization_servers[0]!;
  const server = await get<{ issuer?: string; client_id_metadata_document_supported?: boolean; code_challenge_methods_supported?: string[] }>(new URL('/.well-known/oauth-authorization-server', issuer));
  check(server.issuer === issuer && server.client_id_metadata_document_supported === true && !!server.code_challenge_methods_supported?.includes('S256'), 'The MCP authorization server no longer accepts client metadata documents with PKCE');
}
const idKey = (name: string) => ({ 'Idempotency-Key': `${prefix}:${name}` });
function message(to: string): SendEmailInput {
  check([singleSuccess, bounce, complaint].includes(to), 'refusing a recipient outside this run');
  // Add send-route header coverage here when the deployed contract supports it.
  return { region, from, to: [to], subject, text };
}
async function outcome(id: string, recipient: string, status: 'delivered' | 'bounced' | 'complained', sender = from, sendRegion = region) {
  const email = await until(`${id} → ${status}`, () => api('getEmail', { path: { id } }), e => {
    check(!e.simulated && e.id === id && e.from === sender && e.region === sendRegion && e.to.length === 1 && e.to[0] === recipient, `unexpected region, envelope or simulated email ${id}`);
    check(!['rejected', 'canceled', 'suppressed', 'rendering_failed', 'acceptance_unknown'].includes(e.status), `${id}: ${e.status} ${e.errorCode ?? ''}`);
    return e.status === status;
  }, e => `${e.status} ${e.errorCode ?? ''}`);
  check(email.providerId && !email.providerId.startsWith('sim_'), `missing live SES id for ${id}`);
  providerAccepted.add(email.providerId);
  const event = { delivered: 'delivery', bounced: 'bounce', complained: 'complaint' }[status];
  const events = await api('listEmailEvents', { path: { id } });
  check(events.data.some(e => e.type === event && !e.simulated && e.emailId === id), `${id}: no live ${event} event`);
}
async function direct() {
  const options = { body: message(singleSuccess), headers: idKey('send') };
  const a = await api('sendEmail', options);
  check(!a.simulated && a.status === 'queued', 'expected a live queued receipt');
  const b = await api('sendEmail', options);
  check(a.id === b.id, 'idempotency replay created another email');
  if (destructive) await expectDenial(() => api('sendEmail', { ...options, body: { ...options.body, subject: `${subject}-conflict` } }), 409, 'IDEMPOTENCY_CONFLICT');
  await outcome(a.id, singleSuccess, 'delivered');
  const content = await api('getEmailContent', { path: { id: a.id } });
  check(content.text === text && content.subject === subject && !content.simulated, 'stored email content differs');
  const detail = await api('getEmailDetail', { path: { id: a.id } });
  check(detail.email.id === a.id && detail.content.text === text && detail.events.data.some(e => e.type === 'delivery'), 'email detail differs from the email, its content or its events');
  const logs = await api('listEmails', { query: { search: singleSuccess, region } });
  check(logs.nextCursor === null && logs.data.length === 1 && hasId(logs, a.id), 'email missing or duplicated in log');
}
async function batch() {
  // SES feedback upserts a suppressed contact. Own it before sending so cleanup never has
  // to sweep by name or race late feedback; deleting the profile keeps its suppression tombstone.
  for (const email of [bounce, complaint]) {
    const row = await api('createContact', { body: { email, name: prefix } });
    defer(`delete simulator contact ${row.id}`, async () => check((await api('deleteContact', { path: { id: row.id } })).deleted, 'contact not deleted'));
  }
  const { data } = await api('sendEmailBatch', { body: { emails: [message(bounce), message(complaint)] }, headers: idKey('batch') });
  check(data.length === 2 && data[0].id !== data[1].id && data.every(e => !e.simulated), 'expected two different live batch receipts');
  await Promise.all([
    step('SES bounce feedback', () => outcome(data[0].id, bounce, 'bounced')),
    step('SES complaint feedback', () => outcome(data[1].id, complaint, 'complained')),
  ]);
  if (destructive) {
    const page = await api('listContacts', {query:{ email:bounce, suppressed:'true' }});
    check(page.data.length === 1 && page.data[0].email === bounce && page.data[0].suppressed,'permanent SES bounce did not suppress this contact');
    const replay = await api('sendEmail', {body:message(bounce), headers:idKey('post-bounce')});
    const blocked = await until('local suppression before SES',()=>api('getEmail',{path:{id:replay.id}}), row=>{
      check(!row.providerId && ['queued','attempting','suppressed'].includes(row.status),'suppressed recipient reached SES'); return row.status === 'suppressed';
    },row=>row.status);
    check(blocked.to[0] === bounce && !blocked.simulated,'wrong suppressed recipient');
  }
}

async function audience() {
  const contact = await api('createContact', { body: { email: success, name: prefix } });
  const c = { id: contact.id };
  defer(`delete contact ${c.id}`, async () => check((await api('deleteContact', { path: c })).deleted, 'contact not deleted'));
  check(contact.email === success, 'contact address differs');
  const list = await api('createContactList', { body: { name: prefix } });
  const l = { id: list.id };
  defer(`delete list ${l.id}`, async () => check((await api('deleteContactList', { path: l })).deleted, 'list not deleted'));
  const rule = { field: 'email', operator: 'eq', value: success } as const;
  const segment = await api('createSegment', { body: { name: prefix, rule } });
  const s = { id: segment.id };
  defer(`delete segment ${s.id}`, async () => check((await api('deleteSegment', { path: s })).deleted, 'segment not deleted'));
  await api('updateContact', { path: c, body: { name: subject } });
  await api('updateContactList', { path: l, body: { description: subject } });
  await api('updateSegment', { path: s, body: { name: subject } });
  check((await api('getContact', { path: c })).name === subject, 'contact edit not persisted');
  check((await api('getContactList', { path: l })).description === subject, 'list edit not persisted');
  const saved = await api('getSegment', { path: s });
  check(saved.name === subject && 'field' in saved.rule && saved.rule.field === 'email' && saved.rule.operator === 'eq' && saved.rule.value === success, 'exact simulator segment not persisted');
  check(hasId(await api('listContacts', { query: { email: success } }), c.id), 'contact not listed');
  check(hasId(await api('listContactLists', { query: { search: prefix } }), l.id), 'list not listed');
  check(hasId(await api('listSegments', { query: { search: prefix } }), s.id), 'segment not listed');
  await api('updateContactConsent', { path: c, body: { status: 'subscribed', source: prefix } });
  check((await api('listContactConsentEvents', { path: c })).data.some(e => e.source === prefix && e.status === 'subscribed'), 'no subscription audit');
  const added = await api('addListMembers', { path: l, body: { contactIds: [c.id] } });
  check(added.added === 1, 'did not add exactly one member');
  defer(`remove membership ${l.id}`, async () => check((await api('removeListMember', { path: { ...l, contactId: c.id } })).deleted, 'membership not removed'));
  const members = await api('listListMembers', { path: l });
  check(members.nextCursor === null && members.data.length === 1 && members.data[0].id === c.id && members.data[0].email === success, 'refusing audience: not exactly this run’s simulator recipient');
  const preview = await api('previewSegment', { path: s, body: { listId: l.id } });
  check(preview.matched === 1 && preview.eligible === 1, 'segment did not select one eligible member');
  const rows = await api('queryAudience', { body: { statement: `SELECT email FROM contacts WHERE id = '${c.id}'` } });
  check(rows.rows.length === 1 && rows.rows[0].email === success, 'AudienceQL returned another contact');
  const plan = await api('planAudienceMutation', { body: { statement: `UPDATE contacts SET name = '${prefix}' WHERE id = '${c.id}'` } });
  check(plan.matched === 1 && plan.sample.length === 1 && plan.sample[0].id === c.id && plan.sample[0].email === success, 'refusing plan: not exactly this run’s contact');
  check((await api('applyAudiencePlan', { body: { planId: plan.id } })).affected === 1, 'audience plan did not apply');
  await step('One-row contact import and retained receipt', async () => {
    const name = `${prefix}-import`;
    const preview = await api('previewContactImport', { body: { csv: `email,name\n${success},${name}\n`, listId: l.id, mapping: { email: 'email', name: 'name' } } });
    const path = { id: preview.id };
    check(preview.status === 'preview' && preview.listId === l.id && preview.rows.length === 1 && preview.rows[0].email === success && !preview.errors.length, 'refusing import of anything but this run’s contact');
    // Attested consent marks only contacts with no decision; this run's contact is already subscribed, so nothing changes.
    const committed = await api('commitContactImport', { path, body: { consent: { status: 'subscribed', evidence: `${prefix} e2e attestation` } } });
    check(committed.status === 'committed' && committed.imported === 1 && committed.subscribed === 0, 'import did not commit exactly one row without re-recording consent');
    const receipt = await api('getContactImport', { path });
    check(receipt.id === path.id && receipt.listId === l.id && receipt.rows.length === 1 && receipt.rows[0].name === name, 'incorrect stored import');
    // This endpoint exposes summary metadata only and has no server-side listId filter.
    const summary = await listed(path.id, cursor => api('listContactImports', { query: { cursor, limit: 100 } }));
    check(summary.listId === l.id && summary.imported === 1 && summary.status === 'committed', 'incorrect import summary');
    const updated = await api('getContact', { path: c });
    check(updated.name === name && updated.email === success && updated.listIds.includes(l.id) && updated.marketingConsent === 'subscribed', 'import lost membership or consent');
  });
  return { listId: l.id, segmentId: s.id };
}

// One opaque RGBA pixel. Build PNG chunks locally so neither upload nor inspection fetches an image.
function pixelPng() {
  const chunk = (type: string, data: Buffer) => {
    const bytes = Buffer.alloc(data.length + 12);
    bytes.writeUInt32BE(data.length, 0); bytes.write(type, 4); bytes.set(data, 8);
    bytes.writeUInt32BE(crc32(bytes.subarray(4, 8 + data.length)), 8 + data.length);
    return bytes;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 32, 96, 128, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
async function templateAsset() {
  const png = pixelPng(), filename = `${prefix}.png`, content = png.toString('base64');
  const file = await api('uploadTemplateAsset', { body: { filename, content, contentType: 'image/png', disposition: 'inline', contentId: prefix } });
  const path = { id: file.id };
  defer(`delete template PNG ${file.id}`, async () => check((await api('deleteTemplateAsset', { path })).deleted, 'template asset not deleted'));
  const stored = await api('getTemplateAsset', { path });
  check(stored.filename === filename && stored.size === png.length && stored.contentType === 'image/png' && stored.contentId === prefix, 'template PNG metadata changed');
  check((await api('getTemplateAssetContent', { path })).content === content, 'template PNG bytes changed');
}
function checkScreenshot(image: { data: string; mimeType: string }) {
  const png = Buffer.from(image.data, 'base64');
  check(image.mimeType === 'image/png' && png.length > 33 && png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' && png.readUInt32BE(16) === 720 && png.readUInt32BE(20) > 0, 'expected a rendered 720px PNG');
}

async function attachment() {
  const content = Buffer.from(text).toString('base64');
  const file = await api('uploadAttachment', { body: { filename: `${prefix}.txt`, contentType: 'text/plain', content } });
  const path = { id: file.id };
  defer(`delete attachment ${file.id}`, async () => check((await api('deleteAttachment', { path })).deleted, 'attachment not deleted'));
  check((await api('getAttachment', { path })).size === Buffer.byteLength(text), 'incorrect stored size');
  check((await api('getAttachmentContent', { path })).content === content, 'attachment bytes changed');
  // A sent email holds an immutable reference. Use a disposable draft to exercise actual
  // attachment use without leaving an undeletable uploaded object after every deploy.
  const draft = await api('createCampaign', { body: { name: `${prefix}-attachment`, region, from, attachments: [file.id] } });
  const campaign = { id: draft.id };
  defer(`delete attachment draft ${draft.id}`, async () => check((await api('deleteCampaign', { path: campaign })).deleted, 'draft not deleted'));
  check((await api('getCampaign', { path: campaign })).draft.attachments?.includes(file.id), 'draft lost attachment reference');
}

async function template() {
  const item = await api('createCampaignTemplate', { body: { name: prefix } });
  const path = { id: item.id };
  defer(`delete template ${item.id}`, async () => check((await api('deleteCampaignTemplate', { path })).deleted, 'template not deleted'));
  const saved = await api('updateCampaignTemplate', { path, body: { revision: item.revision, draft: { ...item.draft, subject, html } } });
  const published = await api('publishCampaignTemplate', { path, body: { revision: saved.revision } });
  check(published.publishedRevision === saved.revision, 'wrong published revision');
  const preview = await api('previewCampaignTemplate', { path, query: { published: 'true' } });
  check(preview.html.includes(text) && preview.text.includes(text), 'published content missing in preview');
  await step('Render published template PNG', async () => {
    const image = await api('renderCampaignTemplatePreviewImage', { path, query: { published: 'true' } });
    check(image.published && image.revision === saved.revision, 'renderer returned another template revision');
    checkScreenshot(image);
  });
  check((await api('getCampaignTemplate', { path })).published?.subject === subject, 'published subject differs');
  check(hasId(await api('listCampaignTemplates', { query: { search: prefix, publishedOnly: 'true' } }), item.id), 'template not listed');
  check((await api('setCampaignTemplateArchived', { path, body: { archived: true } })).archivedAt, 'template did not archive');
  check(!(await api('setCampaignTemplateArchived', { path, body: { archived: false } })).archivedAt, 'template did not restore');
  return item.id;
}

function retireCampaign(id: string) {
  const path = { id };
  // Only draft/unreleased failed campaigns can be deleted. Archive dispatch history instead.
  defer(`retire campaign ${id}`, () => cleanCampaign(id));
  return path;
}
async function cleanCampaign(id: string) {
  const path = {id}, row = await api('getCampaign', { path });
  if (row.state === 'draft' || (row.state === 'failed' && !row.delivery?.expanded)) {
    check((await api('deleteCampaign', { path })).deleted, 'draft not deleted');
  } else {
    if (row.state !== 'done' && row.state !== 'canceled') {
      try { await api('cancelCampaign', { path }); }
      catch (error) { if ((await api('getCampaignState', { path })).state !== 'done') throw error; }
    }
    check((await api('setCampaignArchived', { path, body: { archived: true } })).archivedAt, 'terminal campaign not archived');
  }
}
type Audience = { listId: string; segmentId: string };
async function scheduledCampaign(audience: Audience) {
  const item = await api('createCampaign', { body: { name: `${prefix}-schedule`, audience, from, region, subject, html, tracking: false } });
  const path = retireCampaign(item.id);
  const eligible = await api('previewCampaignAudience', { path });
  check(item.draft.audience?.listId === audience.listId && item.draft.audience.segmentId === audience.segmentId && eligible.matched === 1 && eligible.eligible === 1, 'refusing unexpected scheduled audience');
  const scheduledAt = new Date(Date.now() + 86_400_000).toISOString();
  const launch = await api('scheduleCampaign', { path, headers: idKey('schedule'), body: { revision: item.revision, scheduledAt } });
  check(launch.id === item.id && launch.queued === 1 && launch.scheduledAt === scheduledAt && !launch.simulated, 'schedule receipt differs');
  await until('campaign prepared for tomorrow', () => api('getCampaignState', { path }), row => {
    check(['preparing', 'scheduled'].includes(row.state), `unexpected pre-schedule state ${row.state}`);
    return row.state === 'scheduled';
  }, row => row.state);
  const paused = await api('pauseCampaign', { path, body: {} });
  check(paused.state === 'paused' && paused.delivery?.expanded === 0, 'future campaign did not pause before dispatch');
  const paced = await api('setCampaignPacing', { path, body: { perDay: 100, rateShare: 0.25 } });
  check(paced.delivery?.pacing.perDay === 100 && paced.delivery.pacing.rateShare === 0.25, 'pacing changes missing');
  const resumed = await api('resumeCampaign', { path, body: {} });
  check(resumed.state === 'scheduled' && resumed.scheduledAt && Date.parse(resumed.scheduledAt) === Date.parse(scheduledAt), 'resume lost future schedule');
  const later = new Date(Date.parse(scheduledAt) + 86_400_000).toISOString();
  const moved = await api('rescheduleCampaign', { path, body: { scheduledAt: later } });
  check(moved.state === 'scheduled' && moved.scheduledAt !== null && Date.parse(moved.scheduledAt) === Date.parse(later) && moved.delivery?.expanded === 0, 'reschedule did not move the send time');
  const unscheduled = await api('unscheduleCampaign', { path, body: {} });
  check(unscheduled.state === 'draft' && unscheduled.scheduledAt === null && unscheduled.delivery === null && unscheduled.counts.total === 0, 'unschedule did not return an untouched draft');
  const again = await api('scheduleCampaign', { path, headers: idKey('schedule-again'), body: { revision: unscheduled.revision, scheduledAt } });
  check(again.queued === 1 && again.scheduledAt === scheduledAt, 'unscheduled draft did not schedule again');
  await until('campaign scheduled again', () => api('getCampaignState', { path }), row => {
    check(['preparing', 'scheduled'].includes(row.state), `unexpected pre-schedule state ${row.state}`);
    return row.state === 'scheduled';
  }, row => row.state);
  const canceled = await api('cancelCampaign', { path });
  check(canceled.state === 'canceled' && canceled.inFlight === 0 && canceled.canceled === 1, 'cancel did not stop one future recipient');
  const stats = await api('getCampaignStats', { path });
  check(stats.state === 'canceled' && stats.counts.total === 0 && stats.delivery?.expanded === 0, 'scheduled campaign materialized an email');
}
async function campaign(audience: Audience, templateId?: string) {
  const item = await api('createCampaign', { body: { name: prefix, from, region, audience, tracking: false, ...(templateId ? { templateId } : { subject, html }) } });
  const path = retireCampaign(item.id);
  check(item.draft.subject === subject && item.draft.html === html && (!templateId || item.sourceTemplateId === templateId), 'unexpected draft or template copy');
  const saved = await api('updateCampaign', { path, body: { revision: item.revision, draft: { ...item.draft, name: subject } } });
  check(saved.revision > item.revision && saved.draft.name === subject, 'revision did not advance');
  check(hasId(await api('listCampaigns', { query: { search: prefix } }), item.id), 'campaign not listed');
  const preview = await api('previewCampaign', { path });
  check(preview.html.includes(text) && preview.text.includes(text), 'campaign preview differs');
  await step('Render campaign PNG', async () => checkScreenshot(await api('renderCampaignPreviewImage', { path })));
  const allowed = await api('previewCampaignAudience', { path });
  check(saved.draft.audience?.listId === audience.listId && saved.draft.audience.segmentId === audience.segmentId && allowed.matched === 1 && allowed.eligible === 1, 'refusing campaign: not the verified one-member exact-email audience');
  const test = await api('testCampaign', { path, body: { to: success }, headers: idKey('campaign-test') });
  check(!test.simulated && test.status === 'queued', 'test email not live');
  const sent = await api('sendCampaign', { path, body: { revision: saved.revision }, headers: idKey('campaign') });
  check(!sent.simulated && sent.queued === 1 && sent.id === item.id, 'expected one live campaign recipient');
  await until(`campaign ${item.id} done`, () => api('getCampaignState', { path }), c => {
    check(!['failed', 'canceled', 'paused'].includes(c.state), `campaign ${item.id} ${c.state}`);
    return c.state === 'done';
  }, async c => {
    // State polling is intentionally cheap. Read the hold before cleanup clears it.
    const stats = await api('getCampaignStats', { path }).catch(() => null);
    const d = stats?.delivery;
    return d ? `${c.state}, released ${d.expanded}/${d.total}${d.waiting ? `, ${d.waiting.reason} until ${d.waiting.until}` : ''}` : c.state;
  });
  const stats = await api('getCampaignStats', { path });
  check(stats.totals.accepted === 1 && stats.counts.total === 1 && stats.totals.simulated === 0, 'campaign done without one live acceptance');
  const logs = await api('listEmails', { query: { campaignId: item.id } });
  check(logs.data.length === 1 && logs.data[0].to[0] === success, 'wrong campaign recipient');
  await outcome(logs.data[0].id, success, 'delivered');
  await step('Read unsubscribe confirmation without changing consent', async () => {
    const { text } = await api('getEmailContent', { path: { id: logs.data[0].id } });
    const token = text?.match(/\/unsubscribe\/(u_[a-f0-9]{64})\s*$/)?.[1];
    check(token, 'no unsubscribe capability in run-owned marketing email');
    const page = await api('unsubscribeByLink', { path: { token }, parseAs: 'text' });
    check(page.includes('<form method="post">'), 'GET must display a confirmation form');
    check((await api('previewCampaignAudience', { path })).eligible === 1, 'GET changed audience consent');
    if (destructive) {
      const page = await api('unsubscribeOneClick',{path:{token},parseAs:'text'});
      check(page.includes('unsubscribed'),'one-click did not confirm opt-out');
      const [row] = (await api('listContacts',{query:{email:success}})).data;
      check(row?.email === success && row.marketingConsent === 'unsubscribed','one-click did not opt out this run’s contact');
    }
  });
  await outcome(test.id, success, 'delivered');
  // Cancellation must not retroactively retract a finished, delivered campaign.
  try { await api('cancelCampaign', { path }); }
  catch (error) {
    if (!(error instanceof ApiFailure && error.status === 409 && error.code === 'CAMPAIGN_ALREADY_DISPATCHED')) throw error;
    return;
  }
  throw new Error('cancelCampaign accepted a completed campaign');
}

async function webhook() {
  // Synthetic tests bypass pause, actual workspace subscriptions do not. No customer events
  // or signing secrets leave the workspace. example.com is not a public request inbox.
  // A throwaway bearer value: proves custom headers are stored, masked on read and kept on edit.
  const bearer = `Bearer ${randomUUID()}`;
  const item = await api('createWebhook', { body: { url: webhookUrl, description: prefix, eventTypes: ['email.delivered'], paused: true, headers: [{ name: 'Authorization', value: bearer }] } });
  const path = { id: item.id };
  defer(`delete webhook ${item.id}`, async () => check((await api('deleteWebhook', { path })).deleted, 'webhook not deleted'));
  const created = await api('getWebhook', { path });
  check(item.url === '••••' + webhookUrl.slice(-4) && created.url === item.url, 'outbound webhook URL is not masked');
  check(item.paused && created.paused, 'test endpoint must remain paused');
  check(created.headers?.length === 1 && created.headers[0].name === 'Authorization' && created.headers[0].hint?.endsWith(bearer.slice(-4)) && !JSON.stringify(created).includes(bearer), 'custom header missing, unmasked or leaked on read');
  await api('updateWebhook', { path, body: { description: subject, paused: true } });
  const edited = await api('getWebhook', { path });
  check(edited.description === subject && edited.headers?.[0]?.name === 'Authorization', 'webhook edit not persisted or dropped its custom header');
  check(hasId(await api('listWebhooks', { query: { limit: 100 } }), item.id), 'webhook not listed');
  const before = await api('revealWebhookSecret', { path });
  check(item.secret.startsWith('whsec_') && item.secret === before.secret && !('secret' in created), 'createWebhook did not return the signing secret once');
  const after = await api('rotateWebhookSecret', { path });
  check(after.secret.startsWith('whsec_') && before.secret !== after.secret, 'test endpoint signing secret did not rotate');
  const test = await api('testWebhook', { path });
  const detail = await until('synthetic signed webhook HTTP attempt', () => api('getWebhookDelivery', { path: { ...path, deliveryId: test.id } }), d => d.attempts.some(a => a.statusCode !== null), d => `${d.status}, attempts=${d.attemptCount} ${d.lastError ?? ''}`);
  // Even an HTTP error proves the request reached a receiver. Do not gate an MX deploy on
  // a 2xx status; a DNS/connect/signing failure (no HTTP response) does not qualify.
  check(detail.synthetic && detail.webhookId === item.id && detail.payload.id === detail.eventId && detail.attempts.some(a => a.deliveryId === test.id && a.statusCode !== null && a.statusCode >= 100 && a.statusCode < 600), `no HTTP attempt recorded for synthetic delivery ${test.id}`);
  check(hasId(await api('listWebhookDeliveries', { path }), test.id), 'signed test attempt not listed');
  // Retry only our synthetic probe. HTTP errors can already have an automatic retry pending;
  // in that case verify the duplicate-retry guard instead of forcing another delivery.
  const deliveryPath = { ...path, deliveryId: test.id };
  try {
    const next = await api('retryWebhookDelivery', { path: deliveryPath });
    check(next.id === test.id && next.status === 'pending', 'wrong retry receipt');
  } catch (error) {
    if (!(error instanceof ApiFailure && error.status === 409 && error.code === 'DELIVERY_PENDING' && detail.status === 'pending')) throw error;
    return;
  }
  await until('second synthetic HTTP attempt', () => api('getWebhookDelivery', { path: deliveryPath }), d => d.synthetic && d.attemptCount > detail.attemptCount && d.attempts.some(a => a.statusCode !== null && !detail.attempts.some(first => a.id === first.id)), d => `${d.status}, attempts=${d.attemptCount}`);
}

async function apiKey() {
  const item = await api('createApiKey', { body: { name: prefix, permissions: ['read'], domains: [domain] } });
  const path = { id: item.id };
  defer(`revoke throwaway key ${item.id}`, async () => check((await api('revokeApiKey', { path })).revoked, 'key not revoked'));
  check(item.name === prefix && item.domains.length === 1 && item.domains[0] === domain && item.permissions.join() === 'read', 'wrong child key scope');
  check(hasId(await api('listApiKeys', { query: { includeRevoked: 'false', limit: 100 } }), item.id), 'throwaway key not listed');
}

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function cliUpload() {
  const key = await api('createApiKey',{body:{name:`${prefix}-cli`,permissions:['send'],domains:[domain]}});
  defer(`revoke CLI key ${key.id}`,()=>api('revokeApiKey',{path:{id:key.id}}));
  const file=`${prefix}.txt`, bytes=Buffer.from(text);
  writeFileSync(file,bytes,{flag:'wx',mode:0o600});
  const trace=ctx.getStore()!; trace.last='SDK CLI POST /v1/attachments/upload'; trace.requestId=null;
  try {
    const cmd = promisify(execFile);
    const {stdout,stderr} = await cmd(process.execPath,['--import','tsx','scripts/e2e-upload-cli.ts',file,base.origin],{env:{PATH:process.env.PATH,CLI_TEMP_KEY:key.secret},timeout:16000}).catch((err: {stderr?:string})=>{
      trace.requestId = err.stderr?.match(/requestId=(req_[a-zA-Z0-9_-]+)/)?.[1] ?? null;
      throw new Error('SDK upload CLI failed; build sdk first (child stderr withheld)');
    });
    trace.requestId=stderr.match(/requestId=(req_[a-zA-Z0-9_-]+)/)?.[1] ?? null;
    let uploaded: {filename?:unknown; size?:unknown; id?:unknown} | null;
    try { uploaded = JSON.parse(stdout); } catch { throw new Error('Invalid SDK upload CLI JSON (stdout withheld)'); }
    check(uploaded && typeof uploaded === 'object','Invalid SDK upload CLI receipt');
    check(uploaded.filename === file && uploaded.size === bytes.length && typeof uploaded.id === 'string','CLI receipt differs');
    const path={id:uploaded.id}; defer(`delete CLI upload ${path.id}`,()=>api('deleteAttachment',{path}));
    check(hash(Buffer.from((await api('getAttachmentContent',{path})).content,'base64'))===hash(bytes),'CLI SHA-256 mismatch');
  } finally {unlinkSync(file);}
}

async function inboundKey(addressId: string, otherId: string) {
  const key = await api('createInboundKey', { body: { name: prefix, addressIds: [addressId], permissions: ['read'] } });
  const path = { id: key.id };
  const restricted = createClient({ baseUrl: base.origin, redirect: 'error', headers: { Authorization: `Bearer ${key.secret}` } });
  defer(`revoke inbound key ${key.id}`, async () => {
    const revoked = await api('revokeInboundKey', { path });
    check(revoked.id === key.id && revoked.revokedAt, 'inbound key not revoked');
    await expectDenial(() => api('getInboundAddress', { client: restricted, path: { addressId } }), 401, 'AUTH_INVALID');
  });
  const row = await listed(key.id, cursor => api('listInboundKeys', { query: { cursor, limit: 100 } }));
  check(row.addressIds?.length === 1 && row.addressIds[0] === addressId && row.permissions.join() === 'read', 'inbound key scope differs');
  check((await api('getInboundAddress', { client: restricted, path: { addressId } })).address === inbox, 'run key cannot read its address');
  await expectDenial(() => api('getInboundAddress', { client: restricted, path: { addressId: otherId } }), 404, 'NOT_FOUND');
  // The same key as an API key limited to the address: listed with the other API keys, and kept out of the workspace.
  const limited = await api('createApiKey', { body: { name: prefix, access: { type: 'addresses', addressIds: [addressId], mail: ['read'] } } });
  const limitedClient = createClient({ baseUrl: base.origin, redirect: 'error', headers: { Authorization: `Bearer ${limited.secret}` } });
  defer(`revoke limited key ${limited.id}`, async () => {
    check((await api('revokeApiKey', { path: { id: limited.id } })).revoked, 'limited key not revoked');
    await expectDenial(() => api('getInboundAddress', { client: limitedClient, path: { addressId } }), 401, 'AUTH_INVALID');
  });
  check(limited.secret.startsWith('bane_mbx_') && limited.access.type === 'addresses' && limited.access.addressIds?.join() === addressId && limited.access.mail.join() === 'read' && !limited.permissions.length, 'limited key access differs');
  check((await listed(limited.id, cursor => api('listApiKeys', { query: { cursor, limit: 100, includeRevoked: 'false' } }))).access.type === 'addresses', 'limited key not listed as an API key');
  check((await api('getInboundAddress', { client: limitedClient, path: { addressId } })).address === inbox, 'limited key cannot read its address');
  await expectDenial(() => api('getInboundAddress', { client: limitedClient, path: { addressId: otherId } }), 404, 'NOT_FOUND');
  await expectDenial(() => api('getCurrentIdentity', { client: limitedClient }), 401, 'AUTH_INVALID');
}

async function inboundWebhook(addressId: string, threadId: string) {
  await api('getInboundScanPolicy',{});
  // Only this address's thread-state metadata, never message.received/stored or mail content.
  const item = await api('createInboundWebhook', { body: { url: webhookUrl, description: prefix, addressIds: [addressId], eventTypes: ['thread.updated'], paused: true } });
  const path = { id: item.id };
  defer(`delete inbound webhook ${path.id}`, async () => check((await api('deleteInboundWebhook', { path })).ok, 'inbound webhook not deleted'));
  const stored = await api('getInboundWebhook', { path });
  check(item.url === '••••' + webhookUrl.slice(-4) && stored.url === item.url, 'inbound webhook URL is not masked');
  check(stored.paused && stored.addressIds?.length === 1 && stored.addressIds[0] === addressId && stored.eventTypes.join() === 'thread.updated', 'unsafe inbound webhook subscription');
  check(hasId(await api('listInboundWebhooks', {}), path.id), 'inbound webhook not listed');
  // Paged five at a time, the run-owned hook is reached by following nextCursor; the address and event filters keep it.
  check((await pages(cursor => api('listInboundWebhooks', { query: { limit: 5, cursor } }))).some(h => h.id === path.id), 'inbound webhook not reached by cursor paging');
  check(hasId(await api('listInboundWebhooks', { query: { addressId, eventType: 'thread.updated' } }), path.id), 'inbound webhook filters dropped a subscriber');
  check(!hasId(await api('listInboundWebhooks', { query: { addressId, eventType: 'message.received' } }), path.id), 'inbound webhook event filter kept a non-subscriber');
  const rotated = await api('rotateInboundWebhookSecret', { path });
  check(rotated.secret.startsWith('whsec_') && rotated.secret !== item.secret, 'inbound webhook secret did not rotate');
  const before = await api('listInboundEvents', { query: { addressId, types: 'thread.updated' } });
  try {
    const active = await api('updateInboundWebhook', { path, body: { paused: false, addressIds: [addressId], eventTypes: ['thread.updated'] } });
    check(!active.paused && active.addressIds?.[0] === addressId && active.addressIds.length === 1 && active.eventTypes.join() === 'thread.updated', 'inbound subscription scope changed');
    const state = await api('updateInboundThread', { path: { threadId }, body: { addressId, addLabels: [prefix] } });
    check(state.labels.includes(prefix), 'test label was not applied');
    const events = await api('listInboundEvents', { query: { addressId, types: 'thread.updated', after: before.cursor } });
    const event = events.data.find(e => e.addressId === addressId && e.threadId === threadId && e.type === 'thread.updated');
    check(event, 'no matching thread metadata event');
    await until('scoped thread metadata HTTP attempt', () => api('listInboundWebhookDeliveries', { path }), page => page.data.some(d => d.webhookId === item.id && d.eventId === event.id && d.attemptCount > 0 && d.lastStatusCode !== null), page => `${page.data.length} deliveries`);
  } finally {
    // Don't wait for unrelated campaign polling or end-of-run cleanup to stop delivery.
    await step('Pause the run-owned inbound webhook',async()=>check((await api('updateInboundWebhook',{path,body:{paused:true}})).paused,'webhook still active'));
  }
}

async function inbound() {
  const d = { id: domainId };
  check(hasId(await api('listInboundDomains', {}), domainId), 'inbound domain not listed');
  const report = await until('public MX exclusively routed to the test region', () => api('checkInboundDomain', { path: d }), r => {
    check(r.name === domain && r.region === region, 'wrong inbound domain');
    return r.mx?.state === 'active';
  }, r => r.mx?.state ?? 'unknown');
  check(report.mx?.expected.name === domain && report.mx.records.length && report.mx.records.every(r => r.host === `inbound-smtp.${region}.amazonaws.com`), 'refusing self-loop: unexpected public mail exchanger');
  await until('receiving MX active', () => api('getInboundDomain', { path: d }), row => row.status === 'active', row => row.status);
  async function address(email: string) {
    const row = await api('createInboundAddress', { body: { address: email, ttlSeconds: 600 } });
    const path = { addressId: row.id };
    defer(`delete address ${row.id}`, async () => check((await api('deleteInboundAddress', { path })).ok, 'address not deleted'));
    check(row.address === email && row.expiresAt, 'unexpected temporary address');
    return row;
  }
  const sender = await address(from), receiver = await address(inbox);
  const addressId = receiver.id;
  await step('Verify inbound read key is restricted to one address', () => inboundKey(addressId, sender.id));
  const children = await api('listInboundSubdomains', { path: d, query: { limit: 1 } });
  check(Array.isArray(children.data) && children.data.every(r => r.parentDomainId === domainId), 'subdomain page includes another parent');
  await api('updateInboundAddress', { path: { addressId }, body: { displayName: prefix } });
  check((await api('getInboundAddress', { path: { addressId } })).displayName === prefix, 'receiving address edit not persisted');
  check(hasId(await api('listInboundAddresses', { query: { domain, q: prefix } }), addressId), 'receiving address not listed');
  // The Receiving screen's one read: both run-owned addresses as address routes, searchable, with the inbox they keep.
  const overview = await api('getInboundOverview', { query: { domain, q: prefix, kind: 'address' } });
  const listed = overview.routes.data.filter(r => [sender.id, receiver.id].includes(r.address?.id ?? ''));
  check(overview.manage && listed.length === 2 && listed.every(r => r.kind === 'address' && r.to.some(t => t.type === 'inbox' && t.id === r.address?.id)), 'overview missing the run-owned address routes');
  check(overview.counts.address >= 2 && overview.domains.some(r => r.id === domainId), 'overview counts or domains wrong');
  if (destructive) {
    const query = {domain,q:prefix,limit:1};
    const a = await api('listInboundAddresses',{query});
    check(a.data.length===1 && a.nextCursor,'first address page missing cursor');
    const b = await api('listInboundAddresses',{query:{...query,cursor:a.nextCursor}});
    check(b.data.length===1 && !b.nextCursor && [a.data[0].id,b.data[0].id].sort().join() === [sender.id,receiver.id].sort().join(),'cursor duplicated, skipped or leaked an address');
  }
  const events = await api('listInboundEvents', { query: { addressId, types: 'message.received' } });
  const sent = await api('createInboundThread', {
    headers: idKey('self-loop'), body: { addressId: sender.id, from, to: [inbox], subject, text,
      attachments: [{ filename: `${prefix}.png`, contentType:'image/png', content: pixelPng().toString('base64') }] },
  });
  check(sent.direction === 'outbound' && sent.from.address === from && sent.to.length === 1 && sent.to[0].address === inbox, 'wrong self-loop envelope');
  const arrival = await until('new inbound message event', () => api('listInboundEvents', { query: { addressId, types: 'message.received', after: events.cursor } }), e => e.data.some(v => v.addressId === addressId && v.type === 'message.received'), e => `${e.data.length} matching events`);
  const event = arrival.data.find(v => v.addressId === addressId && v.type === 'message.received')!;
  check(event.threadId && event.messageId, 'receipt missing thread/message IDs');
  const path = { threadId: event.threadId };
  const msg = await api('getInboundMessage', { path: { messageId: event.messageId }, query: { addressId } });
  check(msg.direction === 'inbound' && msg.from.address === from && msg.subject === subject && msg.text.includes(text) && msg.to.some(a => a.address === inbox), 'inbound message differs from sent content');
  check(msg.attachments.length === 1 && msg.attachments[0].filename === `${prefix}.png`, 'inbound attachment missing');
  const link = await api('getInboundAttachment', { path: { messageId: msg.id, attachmentId: msg.attachments[0].id }, query: { addressId } });
  check(new URL(link.url).protocol === 'https:' && Date.parse(link.expiresAt) > Date.now(), 'expected a temporary HTTPS attachment URL');
  if (destructive) await step('Download and import the run-owned inbound PNG',async()=>{
    // S3 presigned while mail stays in S3; a Bane-signed /v1/objects link on this origin once it is in R2.
    const url = new URL(link.url), own = url.origin === base.origin && /^\/v1\/objects\/[A-Za-z0-9_.-]+$/.test(url.pathname);
    check((own || /(?:^|\.)s3[.-][a-z0-9-]+\.amazonaws\.com$/.test(url.hostname) && !url.port) && !url.username && !url.password,'refusing an attachment URL that is neither S3 nor this deployment’s object link');
    const res=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(12000)});
    const trace=ctx.getStore()!; trace.last=own?'GET /v1/objects':'S3 GetObject'; trace.requestId=res.headers.get(own?'x-request-id':'x-amz-request-id');
    check(res.ok && hash(new Uint8Array(await res.arrayBuffer()))===hash(pixelPng()),'inbound attachment SHA-256 mismatch');
    const imported=await api('importTemplateImage',{body:{url:link.url,contentId:prefix,filename:`${prefix}.png`}});
    const path={id:imported.asset.id}; defer(`delete imported PNG ${path.id}`,()=>api('deleteTemplateAsset',{path}));
    check(imported.src===`cid:${prefix}` && hash(Buffer.from((await api('getTemplateAssetContent',{path})).content,'base64'))===hash(pixelPng()),'import changed image bytes or CID');
  });
  check(hasId(await api('listInboundThreads', { query: { addressId, q: prefix } }), path.threadId), 'arrived thread not listed');
  check(hasId(await api('listInboundMessages', { query: { addressId, direction: 'inbound', q: prefix } }), msg.id), 'arrived message not listed');
  // The unified logs list received mail next to sent mail for the same credential.
  const unified = await api('listLogs', { query: { direction: 'received', search: prefix, limit: 100 } });
  check(unified.received && unified.data.some(row => row.id === msg.id && row.direction === 'received' && row.threadId === msg.threadId), 'arrived message missing from the unified logs');
  check((await api('getInboundThread', { path, query: { addressId } })).messages.some(m => m.id === msg.id), 'message absent from thread');
  check((await api('updateInboundThread', { path, body: { addressId, starred: true } })).starred, 'thread edit failed');
  await step('Scoped inbound webhook, rotation and thread metadata delivery', () => inboundWebhook(addressId, path.threadId));
  const reply = await api('replyToInboundThread', { path, headers: idKey('reply'), body: {
    addressId, replyToMessageId: msg.id, text, expectedRecipients: { to: [from], cc: [], bcc: [] },
  } });
  check(reply.threadId === msg.threadId && reply.direction === 'outbound' && reply.to[0]?.address === from && reply.emailId, 'reply not bound to original conversation');
  const replies = await until('reply received by original test sender', () => api('listInboundMessages', { query: { addressId: sender.id, direction: 'inbound', q: prefix } }), page => page.data.some(m => m.from.address === inbox && m.threadId === sent.threadId), page => `${page.data.length} messages`);
  const received = replies.data.find(m => m.from.address === inbox && m.threadId === sent.threadId)!;
  const delivered = await api('getInboundMessage', { path: { messageId: received.id }, query: { addressId: sender.id } });
  check(delivered.text.includes(text) && msg.messageId && delivered.inReplyTo === msg.messageId, 'reply body or In-Reply-To differs');
  for (const emailId of [sent.emailId,reply.emailId]) {
    check(emailId,'inbound send missing email ID');
    const email = await api('getEmail',{path:{id:emailId}});
    check(!email.simulated && email.providerId,'inbound loop missing provider acceptance'); providerAccepted.add(email.providerId);
  }
}

async function prepare() {
  check(base.protocol === 'https:' && base.href === base.origin + '/', 'BANE_E2E_URL must be a bare HTTPS origin');
  check(!destructive || (base.origin === 'https://dev.bane.mx' && domain === 'e2e.bane.mx' && domainId === 'dom_e53755830a0141a5bd6e71e45e942f06' && region === 'us-east-2'),'destructive tests require the exact dev fixture');
  check(key && domain && domainId, 'missing BANE_E2E_API_KEY, DOMAIN or DOMAIN_ID');
  check((await api('getWorkspaceSettings',{})).name === 'E2E','refusing non-E2E workspace');
  const me = await api('getCurrentIdentity', {});
  check(me.multiTenant && !me.simulated && me.origin === base.origin && me.connection?.kind === 'shared' && me.connection.region === region && me.connection.state === 'ready' && me.connection.tenant === 'ready', 'expected live MX, ready Hosted mail, us-east-2');
  // Inbound, webhooks, templates, metrics and key management need an unrestricted key; the domain ID
  // check below still pins the run to the test workspace, and every send in this script is from the test domain.
  check((me.domains.length === 0 || (me.domains.length === 1 && me.domains[0] === domain)) && ['read', 'send', 'manage'].every(p => me.permissions.some(v => v === p)), 'refusing a key scoped to another domain or missing read/send/manage');
  const path = { id: domainId };
  const info = await api('getDomain', { path });
  check(info.id === domainId && info.name === domain && info.region === region, 'test domain ID/name/region mismatch');
  check(hasId(await api('listDomains', { query: { refresh: 'false', region, limit: 10 } }), domainId), 'domain absent from scoped catalog');
  await api('verifyDomain', { path });
  await until('verified sending domain', () => api('getDomain', { path }), d => d.ready && d.sending === 'verified', d => `${d.sending}/${d.verificationStatus}/${d.dkimStatus}`, 110_000);
  // Onboarding endpoints, exercised without changing the shared fixture: a host outside the domain is
  // refused before any DNS read or write; dashboard-only routes refuse bearer keys; stats are public.
  await expectDenial(() => api('chooseReceivingHost', { path, body: { host: `${prefix}.invalid`, confirm: false } }), 422, 'RECEIVING_HOST_INVALID');
  await expectDenial(() => api('sendDomainTestEmail', { path }), 401, 'AUTH_REQUIRED');
  await expectDenial(() => api('releaseSenderStanding', { body: { checklist: { bouncedRemoved: true, listSourceConfirmed: true } } }), 401, 'AUTH_REQUIRED');
  await expectDenial(() => api('getWorkspaceInvitation', { path: { id: `inv_${randomUUID().replace(/-/g, '')}` } }), 401, 'AUTH_REQUIRED');
  const stats = await api('getPublicStats', {});
  check(typeof stats.available === 'boolean', 'public stats missing availability');
  return true;
}

// A broad name like "e2e-operator" must NEVER be taken as ownership. The label
// must be exactly one minted by this suite (including the pre-rename form), and
// both its embedded timestamp and the server's creation timestamp must be old.
function staleRun(label: string | null | undefined, createdAt: string) {
  const m = label?.match(/^(?:(?:Bane|OpenSend MX) E2E )?(e2e-(\d{13})-[a-f0-9]{8}-[a-f0-9]{3})(?:-(?:cli|schedule|attachment|import))?$/);
  if (!m) return null;
  const minted = Number(m[2]), created = Date.parse(createdAt), cutoff = started - 30*60_000;
  return minted < cutoff && created < cutoff && Math.abs(created-minted) < 5*60_000 ? m[1] : null;
}
async function pages<T>(read: (cursor?:string)=>Promise<{data:T[]; nextCursor:string|null}>) {
  const rows:T[] = [], seen=new Set<string>();
  let cursor:string|undefined;
  do {
    const page=await read(cursor); rows.push(...page.data); cursor=page.nextCursor ?? undefined;
    if (cursor) {check(!seen.has(cursor),'stale-object scan received a duplicate cursor'); seen.add(cursor);}
  } while(cursor);
  return rows;
}
async function sweepStaleObjects() {
  // prepare() already checked E2E workspace, live Hosted identity and exact domain ID.
  // Enumerate each collection BEFORE deleting from it so mutations cannot shift pages.
  const q={limit:100,search:'e2e-'};
  for (const k of await pages(cursor=>api('listApiKeys',{query:{cursor,limit:100,includeRevoked:'false'}}))) {
    const run=staleRun(k.name,k.createdAt);
    if (run && k.domains.length===1 && k.domains[0]===domain && k.permissions.length===1 &&
        ((k.name===run && k.permissions[0]==='read') || (k.name===`${run}-cli` && k.permissions[0]==='send'))) {
      check((await api('revokeApiKey',{path:{id:k.id}})).revoked,'stale API key not revoked');
    }
  }
  for (const k of await pages(cursor=>api('listInboundKeys',{query:{cursor,limit:100,includeRevoked:'false'}}))) {
    if (staleRun(k.name,k.createdAt)===k.name && k.addressIds?.length===1 && k.permissions.join()==='read')
      check((await api('revokeInboundKey',{path:{id:k.id}})).revokedAt,'stale inbound key not revoked');
  }
  for (const h of await pages(cursor=>api('listWebhooks',{query:{limit:100,cursor}}))) {
    if (staleRun(h.description,h.createdAt) && h.eventTypes.join()==='email.delivered')
      check((await api('deleteWebhook',{path:{id:h.id}})).deleted,'stale webhook not deleted');
  }
  for (const h of await pages(cursor=>api('listInboundWebhooks',{query:{limit:100,cursor}}))) {
    if (staleRun(h.description,h.createdAt) && h.addressIds?.length===1 && h.eventTypes.join()==='thread.updated')
      check((await api('deleteInboundWebhook',{path:{id:h.id}})).ok,'stale inbound webhook not deleted');
  }
  // Retire live dispatch before deleting its template or audience. Already-archived
  // dispatch history is immutable; listCampaigns defaults to unarchived rows only.
  for (const c of await pages(cursor=>api('listCampaigns',{query:{...q,cursor}}))) {
    const run=staleRun(c.draft.name,c.createdAt);
    if (run && c.draft.from===`${run}@${domain}` && c.draft.region===region) await cleanCampaign(c.id);
  }
  for (const archived of ['true','false'] as const) {
    for (const t of await pages(cursor=>api('listCampaignTemplates',{query:{...q,cursor,archived}}))) {
      if (staleRun(t.name,t.createdAt)===t.name) check((await api('deleteCampaignTemplate',{path:{id:t.id}})).deleted,'stale template not deleted');
    }
  }
  for (const s of await pages(cursor=>api('listSegments',{query:{...q,cursor}}))) {
    const run=staleRun(s.name,s.createdAt);
    if (run && 'value' in s.rule && s.rule.value===`success+${run}@simulator.amazonses.com`)
      check((await api('deleteSegment',{path:{id:s.id}})).deleted,'stale segment not deleted');
  }
  for (const l of await pages(cursor=>api('listContactLists',{query:{...q,cursor}}))) {
    if (staleRun(l.name,l.createdAt)===l.name) check((await api('deleteContactList',{path:{id:l.id}})).deleted,'stale list not deleted');
  }
  for (const c of await pages(cursor=>api('listContacts',{query:{...q,cursor}}))) {
    const run=staleRun(c.name,c.createdAt);
    if (run && ['bounce','complaint','success'].some(kind=>c.email===`${kind}+${run}@simulator.amazonses.com`))
      check((await api('deleteContact',{path:{id:c.id}})).deleted,'stale simulator contact not deleted');
  }
  return true;
}

async function run() {
  console.log(`${prefix} ${base.origin}`);
  try {
    const ready = await step('Live identity and verified domain', prepare);
    if (!ready) return;
    if (!await step('Retire interrupted E2E fixtures older than 30 minutes',sweepStaleObjects)) return;
    await Promise.all([
      ...(destructive ? [step('Dev fixture contracts',devBoundaries),step('Virginia delivery and feedback',regionalSend),step('SDK binary upload CLI',cliUpload),step('MCP authorization discovery',mcpChallenge)] : []),
      step('Single send, replay, delivery and email log', direct),
      step('Preview run-owned HTML without sending', async () => {
        const { previews } = await api('previewEmail', { body: { html: `<p style="display:flex">${prefix}</p>`, clients: ['gmail-web', 'outlook-classic-windows'], theme: 'dark', device: 'mobile' } });
        check(previews.length === 2 && previews[0].client === 'gmail-web' && previews[0].html.includes(prefix) && /Content-Security-Policy/i.test(previews[0].html), 'missing offline HTML preview');
        check(previews[1].client === 'outlook-classic-windows' && previews[1].html === '' && previews[1].issues.length > 0, 'missing lint-only classic Outlook result');
      }),
      step('Batch send', batch), step('Attachment upload, bytes and draft use', attachment),
      step('Temporary inbound addresses, self-loop, thread and reply', inbound),
      step('Paused webhook, rotated secret and synthetic signed HTTP attempt', webhook),
      step('Create and list restricted throwaway API key', apiKey),
      step('Workspace settings, region catalog, token metadata and Hosted SES privacy', workspaceReads),
      step('Upload and inspect a template PNG', templateAsset),
      (async () => {
        const [selection, tpl, guide] = await Promise.all([
          step('Contact, consent, list, segment and AudienceQL', audience),
          step('Publish, preview and restore literal template', template),
          step('Campaign content guide', async () => {
            check((await api('getCampaignContentGuide', {})).markdown.includes('<p>'), 'guide missing paragraph block');
            return true;
          }),
        ]);
        // A template permission failure does not hide campaign dispatch regressions.
        if (selection && guide) await Promise.all([
          step('Preview exact audience, send campaign and observe done + delivery', () => campaign(selection, tpl)),
          step('Schedule, pause, pace, resume and cancel without dispatch', () => scheduledCampaign(selection)),
        ]);
      })(),
    ]);
    await step('Regional metrics, sender score and plan usage for this run window', async () => {
      const sender = await api('getSenderScore', {});
      check(sender.state === 'warmup' ? sender.score === null : sender.score !== null && sender.score >= 0 && sender.score <= 100, 'sender score outside its grading range');
      // Plan & usage: the price, this run's sends are in the month, a manage key sees the received count (members and
      // read-only keys get null), and the daily limit names its steps.
      const usage = await api('getUsage', {});
      check(usage.billing.enabled === (usage.billing.enforcement === 'enforce') && usage.pricing.perThousand > 0 && usage.month.sent >= 3 && typeof usage.month.received === 'number' && usage.steps.length === 3 && (usage.daily === null || usage.daily.step === null || usage.steps[usage.daily.step]?.cap === usage.daily.cap), 'invalid plan and usage summary');
      // Billing as a manage key reads it: the balance and state, today's metered usage, and the ledger and payments pages.
      const bill = await api('getBilling', {});
      check(bill.balance !== null && bill.free.emails.limit === usage.pricing.freeEmails && ['off', 'shadow', 'enforce'].includes(bill.enforcement), 'billing summary without amounts for a manage key');
      const metered = await api('getBillingUsage', { query: { granularity: 'day' } });
      check(Array.isArray(metered.data) && metered.data.every(p => /^\d+$/.test(p.quantity)), 'billing usage is not a list of integer quantities');
      for (const list of [await api('listBillingLedger', { query: { limit: 5 } }), await api('listBillingPayments', { query: { limit: 5 } })]) check(Array.isArray(list.data) && list.data.length <= 5, 'billing page over its limit');
      const m = await api('getMetrics', { query: { from: new Date(started).toISOString(), region, granularity: 'hour' } });
      check(m.basis === 'created-cohort' && m.region === region && m.totals.emails >= 3 && m.totals.bounced >= 1 && m.totals.complained >= 1 && m.totals.delivered >= 1, 'regional metrics do not include expected simulator outcomes');
    });
  } finally {
    deadline = Date.now() + 35_000;
    for (const { name, fn } of cleanups.reverse()) await step(name, fn);
  }
}

function finish() {
  const ended = Date.now();
  const missing = [...contract].filter(op => !attempted.has(op as Op) && !Object.hasOwn(SKIP, op));
  const stale = Object.keys(SKIP).filter(op => !contract.has(op));
  if (missing.length || stale.length) {
    failures++;
    const error = [missing.length && `not reached: ${missing.join(', ')}`, stale.length && `obsolete skips: ${stale.join(', ')}`].filter(Boolean).join('; ');
    steps.push({ name: 'OpenAPI coverage', status: 'fail', ms: 0, operationIds: [], requestId: null, error });
    console.error(`✗ OpenAPI coverage (0 ms): ${error}`);
  }
  const skipped = Object.keys(SKIP).length;
  const covered = new Set(steps.filter(s => s.status === 'pass').flatMap(s => s.operationIds));
  const headline = `Bane E2E ${failures ? 'FAIL' : 'PASS'} — ${covered.size}/${contract.size} operations in passing steps, ${attempted.size} attempted, ${skipped} intentionally skipped, ${missing.length} not reached (${((ended - started) / 1000).toFixed(1)} s)`;
  console.log(headline);
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const report = { commit, targetUrl: base.origin, run: prefix, start: new Date(started).toISOString(), end: new Date(ended).toISOString(), ms: ended - started,
    status: failures ? 'fail' : 'pass', destructive, ses: { observedProviderAcceptances:providerAccepted.size, reservedRecipientBudget:sendBudget }, steps,
    coverage: { total: contract.size, passed: [...covered].sort(), attempted: [...attempted].sort(), successResponses:[...successResponses].sort(), negativeOnly:[...errorResponses].filter(op=>!successResponses.has(op)).sort(), notReached: missing.sort(), skipped: SKIP, staleSkips: stale } };
  // Atomic replacement also makes a shared working directory safe for concurrent invocations.
  const tmp = `.${prefix}-report.tmp`;
  writeFileSync(tmp, JSON.stringify(report, null, 2) + '\n');
  renameSync(tmp, 'e2e-report.json');
  if (process.env.GITHUB_STEP_SUMMARY) {
    const escape = (v: string) => v.replaceAll('|', '\\|').replace(/[<>\r\n]/g, ' ');
    const failed = steps.filter(s => s.status === 'fail');
    const md = [`## ${headline}`, '', `Commit: \`${commit}\`. ${successResponses.size} operations returned a validated success; ${report.coverage.negativeOnly.length} exercised only their error contract.`,
      `SES: ${providerAccepted.size} distinct provider IDs observed; ${sendBudget}/25 recipient admissions reserved (including replays, suppressed and canceled sends).`, '',
      ...failed.map(s => `- **${escape(s.name)}**: ${s.name === 'OpenAPI coverage' ? 'See unaccounted operations in the JSON artifact.' : escape(s.error!)} (request ID: \`${s.requestId ?? 'unavailable'}\`)`), '', '<details><summary>Every step</summary>', '', '| Step | Result | ms |', '|---|---|---:|', ...steps.map(s => `| ${escape(s.name)} | ${s.status} | ${s.ms} |`), '', '</details>', ''];
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n') + '\n');
  }
  if (failures) process.exitCode = 1;
}
try { await run(); } finally { finish(); }
