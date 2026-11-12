import { createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { ApiError, assertSesConfigured, isSimulatedSes, errors, id, json, log, ModuleLoadError, notFound, response, wrapModuleLoad, type App, type Ctx, type Runtime, type JobHandler } from './core.js';
import { caller, assume, platformCredentials } from './provider-credentials.js';
import { awsError, discoverSes, feedbackUrl, loadSetupSdk, POOL_INSTALLATION, poolTenantName, provisionSes, provisionTenant, setupResources, verifiedByoDomains, type SesDiscovery } from './ses-setup.js';
import { importByoClaims } from './domain-claims.js';
import { regionPattern, getRegionSettings } from './ses-region-state.js';
import { JobDeferred, MAX_ATTEMPTS, retryDatabaseFailures } from './jobs.js';
import { loadMailboxSetupSdk, preparePoolReceiving } from './mailbox-setup.js';
import { byoEnabled } from './byo-pilot.js';
import { hostedAllowance, type HostedAllowance } from './hosted-sending.js';
import { requirePlatformAccount } from './config.js';
import { Accepted, Imports, InventoryFields, RegionStatus, disconnectV5, enrollV5, inventory, refreshScan, regionLabels, selectImports, statuses, v5Link, type V5Connection } from './byo-regional.js';
import { CONNECTION_STATES, TENANT_STATES, assertConnectionTransition, campaignActive, desiredTenantStatus, finishProvisioning, notProvisioning, poolReceives, poolSends, setPoolState, setTenantState, startProvisioning, queueTenantJob, type ConnectionState, type TenantState } from './states.js';

const tags = ['Workspaces'], security = [{ dashboardSession: [] }, { secureDashboardSession: [] }] as Record<string, string[]>[];
const Kind = z.enum(['shared', 'byo']);
const AccountId = z.string().regex(/^\d{12}$/).openapi({ example: '123456789012' });
const Create = z.object({ kind: Kind, region: z.string().max(32).regex(regionPattern).optional(), awsAccountId:AccountId.optional() }).strict().openapi('CreateConnection');
const State = z.enum(CONNECTION_STATES).describe('awaiting_role: waiting for the BYO stack. provisioning: verifying regional resources and importing verified domains. ready: sending allowed once the tenant is ready. failed: the last setup attempt failed; verify again.');
const Tenant = z.enum(TENANT_STATES).describe('Hosted only: the SES tenant that isolates this workspace. Sends are rejected with TENANT_NOT_READY until it is ready. BYO connections are always ready.');
const Connection = z.object({ id: z.string(), kind: Kind, region: z.string(), state: State, tenant: Tenant, importedDomains: z.number().int().nonnegative().describe('Number of currently claimed domains imported from this BYO account.'), awsAccountId: z.string().nullable(), roleArn: z.string().nullable(), templateVersion: z.string().nullable(), quickCreateUrl: z.url().nullable(),...InventoryFields }).openapi('ProviderConnection');
// Safe for every workspace member: no account IDs, role ARNs or external IDs.
export const ConnectionSummary = z.object({ kind: Kind, region: z.string(), state: State, tenant: Tenant,
  sendingPause: z.object({ at: z.iso.datetime(), reason: z.string() }).nullable().describe('Hosted reputation hold: sending and dispatch are paused until operator review. Receiving is unaffected.'),
  sendingLimit: z.object({
    cap: z.number().int().nullable().describe('Recipients allowed per rolling 24 hours. Null when this workspace has no hosted limit.'),
    used: z.number().int().describe('Recipients charged in the current rolling 24 hours, including SES simulator addresses.'),
    resetAt: z.iso.datetime().nullable().describe('When capacity next frees up or the limit changes.'),
    nextCap: z.number().int().nullable().describe('The next limit for a new workspace, or null once it has the mature limit.'),
    nextCapAt: z.iso.datetime().nullable().describe('When nextCap applies.'),
  }).nullable().optional().describe('Hosted only: the daily limit (set by the sender score) that POST /v1/emails/send enforces with 429 SEND_LIMIT_REACHED.'),
  standing: z.object({ step: z.enum(['ok', 'notice', 'warn', 'restrict', 'pause']), marketingHeld: z.boolean() }).nullable().optional()
    .describe('Hosted only: the enforcement step summary. GET /v1/sender-score has the reasons, the limit math and what an owner can release.'),
  domains: z.object({ total: z.number().int(), verified: z.number().int() }).optional().describe('Domains claimed in this workspace and how many can send.'),
}).openapi('ConnectionSummary');
type Row = { id: string; workspace_id: string; kind: 'shared' | 'byo'; region: string; state: ConnectionState; tenant_state: TenantState; aws_account_id: string | null; role_arn: string | null; external_id: string | null; platform_principal_arn: string | null; template_version: string | null; confirmed_message_id: string | null; imported_domains?: number };

function owner(c: Ctx) {
  if (!c.env.config.multiTenant) return notFound('Endpoint');
  const a = c.get('actor');
  if (a.credential !== 'dashboard' || (a.role !== 'owner' && a.role !== 'admin')) throw new ApiError(403, 'PERMISSION_DENIED', 'Use an owner or admin dashboard session to manage sending connections.');
  return a.workspaceId;
}
function template(runtime: Runtime) {
  if (!runtime.config.byoTemplateUrl) throw new ApiError(503, 'BYO_NOT_CONFIGURED', 'Bring-your-own AWS is not configured.');
  return runtime.config.byoTemplateUrl;
}
const platformRegion = 'us-east-2';
const sharedRegions = (runtime: Runtime) => runtime.config.regionalSending ? [platformRegion] : runtime.config.sharedRegions ?? [platformRegion];
const principals = new Map<string, { account: string; arn: string }>();
async function platformIdentity(runtime: Runtime, expectedAccount?: string) {
  if (expectedAccount && runtime.config.platformAccount && expectedAccount!==runtime.config.platformAccount) throw new ApiError(503,'AWS_ACCOUNT_MISMATCH','This pool belongs to a different platform account.',undefined,true);
  const key = platformCredentials(runtime), cached = principals.get(key.accessKeyId);
  // A key from another environment must never provision or bind this installation's pool.
  const mismatch = (account: string) => (expectedAccount && account !== expectedAccount) || (runtime.config.platformAccount && account !== runtime.config.platformAccount);
  if (cached) {
    if (mismatch(cached.account)) throw new ApiError(409, 'AWS_ACCOUNT_MISMATCH', 'The platform key no longer matches this pool.');
    return cached;
  }
  const identity = await caller(platformRegion, key);
  if (!identity.Account || !/^\d{12}$/.test(identity.Account) || !identity.Arn?.startsWith(`arn:aws:iam::${identity.Account}:user/`)) throw new ApiError(503, 'PLATFORM_PRINCIPAL_INVALID', 'Use an IAM user in the commercial AWS partition for the platform connection.');
  if (mismatch(identity.Account)) throw new ApiError(409, 'AWS_ACCOUNT_MISMATCH', 'The platform key no longer matches this pool.');
  const value = { account: identity.Account, arn: identity.Arn };
  principals.set(key.accessKeyId, value); return value;
}
// Commercial regions with an SES sending endpoint: https://docs.aws.amazon.com/general/latest/gr/ses.html
const byoRegions = ['us-east-2', 'us-east-1', 'us-west-1', 'us-west-2', 'af-south-1', 'ap-south-2', 'ap-southeast-3', 'ap-southeast-5', 'ap-south-1', 'ap-northeast-3', 'ap-northeast-2',
  'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1', 'ca-central-1', 'ca-west-1', 'eu-central-1', 'eu-west-1', 'eu-west-2', 'eu-south-1', 'eu-west-3', 'eu-north-1', 'eu-central-2',
  'il-central-1', 'me-south-1', 'me-central-1', 'sa-east-1'];
const stackName = (row: Row) => `Bane-${row.id.slice(-20)}`;
function view(runtime: Runtime, row: Row) {
  let quickCreateUrl: string | null = null;
  if (row.template_version==='v5' && row.state!=='disconnecting' && runtime.config.byoV2 && runtime.config.byoV5TemplateUrl && !row.aws_account_id) quickCreateUrl=v5Link(runtime,row);
  if (row.kind === 'byo' && row.template_version!=='v5' && (row.state === 'awaiting_role' || row.state === 'failed')) {
    const params = new URLSearchParams({ templateURL: template(runtime), stackName: stackName(row), param_ExternalId: row.external_id!, param_PlatformPrincipalArn: row.platform_principal_arn!, param_ReceiveMail: 'true',
      param_ConnectionId: row.id, param_ResourcePrefix: setupResources(row.id).topicName.replace(/-feedback$/, ''), param_FeedbackUrl: feedbackUrl({ publicUrl: runtime.config.publicUrl }) });
    quickCreateUrl = `https://${row.region}.console.aws.amazon.com/cloudformation/home?region=${row.region}#/stacks/create/review?${params}`;
  }
  return { id: row.id, kind: row.kind, region: row.region, state: row.state, tenant: row.tenant_state, importedDomains: row.imported_domains ?? 0, awsAccountId: row.aws_account_id, roleArn: row.role_arn, templateVersion: row.template_version, quickCreateUrl };
}
async function get(runtime: Runtime, wid: string) {
  return (await runtime.db.execute<Row>(sql`SELECT c.*, (SELECT count(*)::int FROM domain_claims dc WHERE dc.connection_id=c.id AND dc.identity @> '{"imported":true}') AS imported_domains FROM provider_connections c WHERE workspace_id=${wid}`)).rows[0];
}
export async function connectionSummary(runtime: Runtime, wid: string): Promise<z.infer<typeof ConnectionSummary> | null> {
  // One statement: the same allowance admission charges against (incoming=1 reads the current usage), read without row locks.
  const row = (await runtime.db.execute<Pick<Row, 'kind' | 'region' | 'state' | 'tenant_state'> & {paused_at: string | null; pause_reason: string | null; domains: number; verified_domains: number; allowance: HostedAllowance | null}>(sql`
    SELECT c.kind, c.region, c.state, c.tenant_state, c.paused_at, c.pause_reason,
      (SELECT count(*)::int FROM domain_claims dc WHERE dc.workspace_id=c.workspace_id) AS domains,
      (SELECT count(*)::int FROM domain_claims dc WHERE dc.workspace_id=c.workspace_id AND dc.sending_state IN ('verified','lost')) AS verified_domains,
      CASE WHEN c.kind='shared' THEN ${hostedAllowance(runtime.config, wid, 1, 0, true)} END AS allowance
    FROM provider_connections c WHERE c.workspace_id=${wid}`)).rows[0];
  if (!row) return null;
  const iso = (value: string | null | undefined) => value ? new Date(value).toISOString() : null;
  const allowance = row.allowance;
  return { kind: row.kind, region: row.region, state: row.state, tenant: row.tenant_state, sendingPause: row.paused_at ? { at: new Date(row.paused_at).toISOString(), reason: row.pause_reason! } : null,
    sendingLimit: allowance ? { cap: allowance.cap, used: Number(allowance.used), resetAt: iso(allowance.resetAt), nextCap: allowance.nextCap ?? null, nextCapAt: iso(allowance.nextCapAt) } : null,
    standing: allowance ? { step: (allowance.step ?? 'ok') as 'ok', marketingHeld: !!allowance.marketingHeld } : null,
    domains: { total: row.domains, verified: row.verified_domains } };
}
function checkProvisioned(report: SesDiscovery, pooled: boolean, allowSandbox = false) {
  // Domain verification and a BYO customer's production-access request are separate onboarding steps.
  const blocker = report.blockers.find(b => b.code !== 'SES_DOMAIN_REQUIRED' && ((pooled && !allowSandbox) || b.code !== 'SES_SANDBOX'));
  if (report.provisioned && !blocker) return;
  if (blocker?.code === 'SNS_CONFIRMATION_PENDING') throw new ApiError(409, blocker.code, 'Waiting for AWS to confirm the feedback subscription. Retry shortly.', undefined, true);
  const retryable=!blocker || ['AWS_THROTTLED','AWS_SETUP_TIMEOUT','AWS_SETUP_FAILED','AWS_STATE_UNKNOWN','SNS_SUBSCRIPTION_UNKNOWN'].includes(blocker.code);
  throw new ApiError(409, blocker?.code ?? 'PROVISIONING_INCOMPLETE', blocker?.message ?? 'AWS setup is not confirmed yet. Retry this request.', undefined, retryable);
}

// The pool's sending and receiving states are explicit; the lease only fences one setup run per region
// so a crashed isolate's attempt can be retried without a DB transaction spanning AWS calls.
type Pool = { sending: boolean; receiving: boolean; aws_account_id: string;legacy_names:boolean };
async function getPool(runtime: Runtime, region: string) {
  return (await runtime.db.execute<Pool>(sql`SELECT ${poolSends()} AS sending, (${poolReceives()} AND coalesce(receiving_checked_at,'-infinity')>now()-interval '1 day') AS receiving, aws_account_id,legacy_names FROM provider_pool_regions p WHERE region=${region}`)).rows[0];
}
async function ensurePool(runtime: Runtime, principal:Awaited<ReturnType<typeof platformIdentity>>, region: string) {
  await Promise.all([loadSetupSdk(), loadMailboxSetupSdk()]);
  const account=principal.account;
  const lease = new Date(Date.now() + 180_000).toISOString();
  const fresh=sql`(${poolReceives(sql`provider_pool_regions`)} AND coalesce(provider_pool_regions.receiving_checked_at,'-infinity')>now()-interval '1 day')`;
  const result = await runtime.db.execute<Pick<Pool,'sending'|'receiving'>>(sql`INSERT INTO provider_pool_regions(region, aws_account_id, lease_until) VALUES (${region}, ${account}, ${lease})
    ON CONFLICT(region) DO UPDATE SET lease_until=excluded.lease_until WHERE provider_pool_regions.legacy_names AND NOT (${poolSends(sql`provider_pool_regions`)} AND ${fresh})
      AND provider_pool_regions.aws_account_id=excluded.aws_account_id AND coalesce(provider_pool_regions.lease_until, '-infinity') <= now() RETURNING ${poolSends(sql`provider_pool_regions`)} AS sending,${fresh} AS receiving`);
  if (!result.rowCount) {
    const pool = await getPool(runtime, region);
    if (pool?.aws_account_id !== account) throw new ApiError(409, 'AWS_ACCOUNT_MISMATCH', 'The platform key no longer matches this pool.');
    if (pool.sending && pool.receiving) return;
    throw busy();
  }
  const owned = sql`region=${region} AND lease_until=${lease}::timestamptz`;
  try {
    const scoped = { ...runtime, config: { ...runtime.config, awsAccountId: account, sesFeedbackUrl: undefined } };
    // Independent checkpoints. Sending sandbox/feedback failures cannot skip receiving, and
    // waiting for an inbound confirmation must not block a healthy outbound pool either.
    let receiveFailure: unknown;
    if (!result.rows[0]!.receiving) try {
      const bucket=await preparePoolReceiving(scoped,region,account,async(_account,_bucket,arn)=>{
        if (!(await runtime.db.execute(sql`UPDATE provider_pool_regions SET inbound_topic_arn=${arn} WHERE ${owned}`)).rowCount) throw busy();
      });
      if (!(await runtime.db.execute(setPoolState(owned,'receiving_state',sql`,inbound_bucket=${bucket},receiving_checked_at=now()`))).rowCount) throw busy();
    } catch(e) {
      receiveFailure=e;
      // A simultaneous outbound failure can be the one that escapes this run.
      // Keep the receiving resource/operator action visible independently.
      if (e instanceof ApiError && e.code==='POOL_RECEIVING_DRIFT') log('warn',{operation:'shared-receiving-setup',region,code:e.code,message:e.message});
    }
    if (!result.rows[0]!.sending) {
      const report = await provisionSes(scoped, { region, installationId: POOL_INSTALLATION, verifiedPoolPrincipal:principal, connectionSetup: true, registerTopic: async (_account, arn) => {
        if (!(await runtime.db.execute(sql`UPDATE provider_pool_regions SET feedback_topic_arn=${arn} WHERE ${owned}`)).rowCount) throw busy();
      } });
      checkProvisioned(report, true, runtime.config.allowSesSandbox);
      if (!(await runtime.db.execute(setPoolState(owned,'sending_state'))).rowCount) throw busy();
    }
    if(receiveFailure) throw receiveFailure;
  } finally { await runtime.db.execute(sql`UPDATE provider_pool_regions SET lease_until=NULL WHERE ${owned}`); }
}
const busy = () => new ApiError(409, 'CONNECTION_BUSY', 'Connection setup is already in progress. Retry shortly.', undefined, true);
function uniqueAccount(error: unknown) {
  const e = (error as { cause?: unknown })?.cause ?? error;
  return (e as { code?: string })?.code === '23505' && (e as { constraint?: string }).constraint === 'provider_connections_byo_account';
}
type Confirmation = { messageId: string; confirm: () => Promise<void> };
async function wakeByoJob(runtime: Runtime, connectionId: string) {
  const wake = async (r: Runtime) => { try { await r.wake?.(1); } catch { log('warn',{code:'QUEUE_WAKE_FAILED',connectionId}); } };
  if (runtime.deferNudge) runtime.deferNudge(wake); else await wake(runtime);
}
// This lookup authorizes only signature verification for a SubscriptionConfirmation, never a notification.
export async function byoStackTopic(runtime: Runtime, arn: string) {
  const match = /^arn:aws:sns:([a-z0-9-]+):(\d{12}):(bane-[0-9a-f]{20})-feedback$/.exec(arn);
  if (!match) return;
  const [, region, account, prefix] = match;
  const row = (await runtime.db.execute<Row>(sql`SELECT * FROM provider_connections WHERE resource_prefix=${prefix} AND region=${region} AND kind='byo'
    AND template_version IS DISTINCT FROM 'v5' AND (template_version='v4' OR feedback_topic_arn IS NULL) AND (aws_account_id IS NULL OR aws_account_id=${account}) AND split_part(platform_principal_arn,':',5)<>${account}`)).rows[0];
  if (!row || setupResources(row.id).topicName !== `${prefix}-feedback`) return;
  return (confirmation: Confirmation) => provision(runtime, row, account!, confirmation);
}
async function provision(runtime: Runtime, row: Row, account: string, confirmation?: Confirmation) {
  if (row.template_version==='v5') throw new ApiError(409,'REGIONAL_SETUP_REQUIRED','This connection requires regional setup, not stack import.');
  const roleArn = `arn:aws:iam::${account}:role/${stackName(row)}`;
  if (row.platform_principal_arn!.split(':')[4] === account) throw new ApiError(409, 'AWS_ACCOUNT_IN_USE', 'The shared sending account cannot be used as a customer account.');
  if (row.aws_account_id && row.aws_account_id !== account) throw new ApiError(409, 'AWS_ACCOUNT_MISMATCH', 'Disconnect before choosing a different AWS account.');
  if (confirmation && row.confirmed_message_id === confirmation.messageId && row.state !== 'failed') {
    // A duplicate can arrive after the worker saw SNS's eventually consistent PendingConfirmation.
    if (row.state==='provisioning' && (await runtime.db.execute(sql`UPDATE jobs SET available_at=now() WHERE id=${'byo.verify:'+row.id}
      AND status='pending' AND (last_error='SNS_CONFIRMATION_PENDING' OR payload->>'retryCode'='SNS_CONFIRMATION_PENDING') AND available_at>now()`)).rowCount) await wakeByoJob(runtime,row.id);
    return row;
  }
  if (row.state === 'ready' && !confirmation) return row;
  if (row.template_version !== 'v4' && !confirmation) await loadSetupSdk();
  const credentials = await assume(runtime, row.region, roleArn, row.external_id!, true);
  const scoped = { ...runtime, config: { ...runtime.config, aws: credentials, awsAccountId: account, sesFeedbackUrl: undefined, workspaceId: row.workspace_id } };
  const lease = new Date(Date.now() + 240_000).toISOString();
  // Reserve the verified BYO account BEFORE creating resources in it. The unique index serializes racing workspaces.
  // A manually started v4 job can be waiting for this very callback; don't wait on its lease.
  let join = (row.template_version === 'v4' || !!confirmation) && ['provisioning','ready'].includes(row.state) && row.aws_account_id === account;
  if (!join) try {
    assertConnectionTransition(row.state, 'provisioning');
    if (!(await runtime.db.execute(startProvisioning(row.id, account, roleArn, lease))).rowCount) {
      const current = await get(runtime,row.workspace_id);
      if (!current || current.id!==row.id || current.aws_account_id!==account || !['provisioning','ready'].includes(current.state)) throw busy();
      // The concurrent request already reserved precisely this proven account. Legacy manual
      // provisioning has one writer; v4 can safely join the callback/queue handoff.
      if (!confirmation && (current.state==='ready' || current.template_version!=='v4')) return current;
      row=current; join=true;
    }
  } catch (e) { if (uniqueAccount(e)) throw new ApiError(409, 'AWS_ACCOUNT_IN_USE', 'This AWS account is already connected to a workspace.'); throw e; }
  const owned = sql`id=${row.id} AND lease_until=${lease}::timestamptz`;
  try {
    if (confirmation && row.confirmed_message_id !== confirmation.messageId) await confirmation.confirm(); // Only after external-ID proof and exclusive account reservation.
    if (row.template_version !== 'v4' && !confirmation) {
      // Legacy stacks contain only a role; their manual fallback still provisions dedicated resources.
      const report = await provisionSes(scoped, { region: row.region, installationId: row.id, connectionSetup: true, registerTopic: async (_account, arn) => {
        if (!(await runtime.db.execute(sql`UPDATE provider_connections SET feedback_topic_arn=${arn} WHERE ${owned}`)).rowCount) throw busy();
      } });
      checkProvisioned(report, false);
    }
    const arn = `arn:aws:sns:${row.region}:${account}:${setupResources(row.id).topicName}`;
    const result = await runtime.db.execute<Row>(sql`WITH bound AS (UPDATE provider_connections SET feedback_topic_arn=${arn},
      confirmed_message_id=coalesce(${confirmation?.messageId ?? null},confirmed_message_id),template_version=CASE WHEN ${!!confirmation} THEN 'v4' ELSE template_version END
      WHERE id=${row.id} AND aws_account_id=${account} AND state IN ('provisioning','ready') RETURNING *),
      queued AS (INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'byo.verify:'||id,'byo.verify',workspace_id,jsonb_build_object('connectionId',id) FROM bound WHERE state='provisioning'
        ON CONFLICT(id) DO UPDATE SET status='pending',attempts=0,available_at=now(),lease_until=NULL,last_error=NULL,payload=excluded.payload WHERE jobs.status IN ('failed','completed') OR
          (${!!confirmation} AND jobs.status='pending' AND (jobs.last_error='SNS_CONFIRMATION_PENDING' OR jobs.payload->>'retryCode'='SNS_CONFIRMATION_PENDING')))
      SELECT * FROM bound`);
    if (!result.rows[0]) throw busy();
    if (result.rows[0].state === 'provisioning') await wakeByoJob(runtime,row.id);
    return result.rows[0];
  } catch (e) {
    if (e instanceof ModuleLoadError) throw e;
    // Waiting on AWS (SNS confirmation) is not a failure; the stack stays and verify is retried.
    if (!join) await runtime.db.execute(finishProvisioning(sql`${owned} AND NOT EXISTS (SELECT 1 FROM jobs WHERE id=${'byo.verify:'+row.id} AND status IN ('running','pending'))`, awsError(e).retryable ? 'awaiting_role' : 'failed'));
    throw e;
  }
}

// SNS confirmation has a short HTTP delivery deadline. Keep paced SES reads off that request and
// checkpoint each page. Imported claims cannot authorize sends until the last page commits ready.
export const byoVerifyJob: JobHandler = retryDatabaseFailures(async (runtime, payload, job) => {
  if (!runtime.config.multiTenant || typeof payload.connectionId !== 'string') return;
  const row = (await runtime.db.execute<Row>(sql`SELECT * FROM provider_connections WHERE workspace_id=${job.workspaceId} AND id=${payload.connectionId}`)).rows[0];
  if (!row || row.id !== payload.connectionId || row.kind !== 'byo' || row.state !== 'provisioning' || row.template_version==='v5') return;
  const owned = sql`id=${row.id} AND EXISTS (SELECT 1 FROM jobs WHERE id=${job.id} AND status='running' AND attempts=${job.attempts})`;
  try {
    const cursor = typeof payload.cursor === 'string' ? payload.cursor : undefined;
    const scoped = { ...runtime, config: { ...runtime.config, aws: await assume(runtime, row.region, row.role_arn!, row.external_id!, !cursor), awsAccountId: row.aws_account_id!, workspaceId: row.workspace_id, sesFeedbackUrl: undefined } };
    if (!cursor) {
      const report = await discoverSes(scoped, { region: row.region, installationId: row.id, connectionSetup: true });
      if (report.account && report.account.id !== row.aws_account_id) throw new ApiError(409, 'AWS_ACCOUNT_MISMATCH', 'The verified role no longer matches this account.');
      checkProvisioned(report, false);
    }
    const { domains, next } = await verifiedByoDomains(scoped, row.region, cursor);
    await runtime.db.transaction(async tx => {
      await getRegionSettings(tx,row.workspace_id,'update'); // Same lock order as disconnect.
      if (!(await tx.execute(sql`UPDATE provider_connections SET lease_until=now()+interval '4 minutes' WHERE state='provisioning' AND ${owned}`)).rowCount) return;
      await importByoClaims(tx, row, domains);
      if (!next) await tx.execute(sql`WITH ready AS (${finishProvisioning(owned,'ready')} RETURNING *),
        stale AS (UPDATE ses_region_discovery d SET credentials_fingerprint=NULL, report=NULL FROM ready r WHERE d.workspace_id=r.workspace_id)
        UPDATE ses_installation_settings s SET installation_id=r.id,default_region=r.region,enabled_regions=jsonb_build_array(r.region) FROM ready r WHERE s.workspace_id=r.workspace_id`);
    });
    if (next) throw new JobDeferred(new Date().toISOString(), { connectionId: row.id, cursor: next });
  } catch (e) {
    if (e instanceof JobDeferred || e instanceof ModuleLoadError) throw e;
    const error = awsError(e);
    if (!error.retryable) await runtime.db.execute(finishProvisioning(owned,'failed'));
    else if (error.code==='SNS_CONFIRMATION_PENDING' || job.attempts>=MAX_ATTEMPTS) {
      // Poll, don't exhaust attempts or strand a connection on a transient outage. A signed
      // confirmation advances a pending SNS poll immediately without superseding a running page.
      throw new JobDeferred(new Date(Date.now()+(error.code==='SNS_CONFIRMATION_PENDING'?15_000:300_000)).toISOString(),{...payload,retryCode:error.code});
    }
    throw error;
  }
});
// The one tenant path. CreateTenant is idempotent, so concurrent callers need no lease: both converge on `ready`.
// Called by createConnection, its retry job, the hourly reconcile and domain verification; never by sending.
type TenantTarget = Pick<Row, 'id' | 'region' | 'tenant_state'> & { pool_account: string | null;pool_tenant_name:string|null;managed_tenant:boolean;namespace?:'trusted'|'probation' };
async function tenantTarget(runtime: Runtime, wid: string, connectionId: string) {
  return (await runtime.db.execute<TenantTarget>(sql`SELECT c.id,c.region,c.tenant_state,c.managed_tenant,c.pool_tenant_name,CASE WHEN NOT p.legacy_names THEN p.pool_tier END AS namespace,p.aws_account_id AS pool_account FROM provider_connections c
    LEFT JOIN provider_pool_regions p ON p.region=c.region AND ${poolSends()} AND (c.aws_account_id IS NULL OR c.aws_account_id=p.aws_account_id)
    WHERE c.id=${connectionId} AND c.workspace_id=${wid} AND c.kind='shared'`)).rows[0];
}
export async function ensureTenant(runtime: Runtime, wid: string, connectionId: string) {
  const row = await tenantTarget(runtime, wid, connectionId);
  if (!row || row.tenant_state === 'ready') return;
  if (!row.pool_account) throw new ApiError(503, 'POOL_NOT_READY', 'The shared sending pool for this region is not ready yet.', undefined, true);
  await platformIdentity(runtime, row.pool_account);
  // Record the tenant's ARN: AWS tenant status events are trusted only for a recorded, owned ARN (src/standing.ts).
  const { rows: [owned] } = await runtime.db.execute<{ arn: string }>(sql`SELECT arn FROM hosted_tenant_ownership WHERE workspace_id=${wid} AND region=${row.region}`);
  await provisionTenant(runtime, row.region, row.pool_account, wid,row.managed_tenant,row.namespace,row.pool_tenant_name, { arn: owned?.arn ?? null,
    created: async arn => { await runtime.db.execute(sql`INSERT INTO hosted_tenant_ownership(workspace_id,region,arn) VALUES(${wid},${row.region},${arn}) ON CONFLICT DO NOTHING`); }, fence: async () => {} });
  await runtime.db.execute(setTenantState(row.id, 'ready', row.pool_account));
}
export const tenantJob: JobHandler = retryDatabaseFailures(async (runtime, payload, job) => {
  if (!runtime.config.multiTenant || isSimulatedSes(runtime) || typeof payload.connectionId!=='string') return;
  try { await ensureTenant(runtime,job.workspaceId,payload.connectionId); }
  catch (e) {
    if (e instanceof ModuleLoadError) throw e;
    // The last retry marks the tenant failed so sends say so; the hourly reconcile keeps trying.
    if (job.attempts >= MAX_ATTEMPTS) await runtime.db.execute(setTenantState(payload.connectionId, 'failed',runtime.config.platformAccount));
    throw e;
  }
});

// Bane is the source of truth for the SES tenant status. Every pause and resume bumps provider_connections.tenant_generation;
// hosted_tenant_status records, per regional tenant, what was applied at which generation. The job reads what Bane
// wants now (desiredTenantStatus), applies it to every ready tenant that differs, finishes a resume once no ready tenant
// may still be disabled, and runs again if a transition happened meanwhile. A transition while it runs cannot requeue
// it, so the periodic reconcile (tenantStatusDrift) queues anything still out of line: every interleaving converges.
// An outcome AWS may have applied is never forgotten: a disable is journaled as DISABLING before the call (DISABLED once
// AWS confirms), and ENABLED is recorded only after AWS confirms, so a crash or a lost checkpoint leaves "possibly
// disabled", which a resume enables again. Only AWS refusing the call (AccessDenied: the runtime policy lacks
// ses:UpdateReputationEntityCustomerManagedStatus) is a definite "not applied", and restores the previous record.
type Applied = 'ENABLED' | 'DISABLING' | 'DISABLED';
type TenantRow = { id: string; generation: string; desired: 'ENABLED' | 'DISABLED'; region: string; ready: boolean; tenant: string | null; managed_tenant: boolean; arn: string | null; applied: Applied | null; applied_generation: string | null };
export const tenantStatusJob: JobHandler = retryDatabaseFailures(async (runtime, _payload, job) => {
  if (!runtime.config.multiTenant) return;
  const wid = job.workspaceId;
  for (let pass = 0; pass < 3; pass++) {
    const { rows } = await runtime.db.execute<TenantRow>(sql`SELECT c.id,c.tenant_generation::text AS generation,${desiredTenantStatus(sql`c`)} AS desired,r.region,r.tenant_state='ready' AS ready,
        CASE WHEN r.legacy THEN c.pool_tenant_name ELSE r.pool_tenant_name END AS tenant,r.managed_tenant,o.arn,t.applied,t.generation::text AS applied_generation
      FROM provider_connections c JOIN provider_connection_regions r ON r.connection_id=c.id LEFT JOIN hosted_tenant_ownership o ON o.workspace_id=c.workspace_id AND o.region=r.region
      LEFT JOIN hosted_tenant_status t ON t.connection_id=c.id AND t.region=r.region WHERE c.workspace_id=${wid} AND c.kind='shared' ORDER BY r.region`);
    if (!rows.length) return;
    const { id: connection, generation, desired } = rows[0]!;
    const work = rows.filter(r => r.ready && (desired === 'DISABLED' ? !(r.applied === 'DISABLED' && r.applied_generation === generation) : r.applied !== null && r.applied !== 'ENABLED'));
    const record = (region: string, applied: Applied) => runtime.db.execute(sql`INSERT INTO hosted_tenant_status AS t(connection_id,region,applied,generation) VALUES(${connection},${region},${applied},${generation}::bigint)
      ON CONFLICT(connection_id,region) DO UPDATE SET applied=excluded.applied,generation=excluded.generation,applied_at=now()`);
    const restore = (row: TenantRow) => row.applied === null ? runtime.db.execute(sql`DELETE FROM hosted_tenant_status WHERE connection_id=${connection} AND region=${row.region}`)
      : runtime.db.execute(sql`UPDATE hosted_tenant_status SET applied=${row.applied},generation=${row.applied_generation}::bigint WHERE connection_id=${connection} AND region=${row.region}`);
    if (isSimulatedSes(runtime)) for (const row of work) await record(row.region, desired);
    else if (work.length) {
      const { setTenantSendingStatus, mxResourceName } = await wrapModuleLoad(() => import('./ses-setup.js'));
      for (const row of work) {
        if (desired === 'DISABLED') await record(row.region, 'DISABLING');
        let arn: string;
        try { arn = await setTenantSendingStatus(runtime, row.region, row.tenant ?? (row.managed_tenant ? mxResourceName(wid) : `bane-${wid}`), row.arn, desired); }
        catch (error) {
          if (error instanceof ApiError && error.code === 'AWS_ACCESS_DENIED') {
            if (desired === 'DISABLED') await restore(row);
            log('error', { code: 'SES_TENANT_STATUS_DENIED', workspaceId: wid, region: row.region, status: desired }); return;
          }
          throw error; // Unknown outcome: the journal keeps "possibly disabled"; the job retries.
        }
        await record(row.region, desired);
        // A tenant provisioned before ARNs were recorded gets its ARN here (GetTenant in the pool account).
        if (!row.arn) await runtime.db.execute(sql`INSERT INTO hosted_tenant_ownership(workspace_id,region,arn) VALUES(${wid},${row.region},${arn}) ON CONFLICT DO NOTHING`);
      }
    }
    // A resume that waited for its tenants restarts sending once no ready tenant may still be disabled, fenced on its generation.
    await runtime.db.execute(sql`UPDATE provider_connections pc SET paused_at=NULL,pause_reason=NULL,resume_pending_at=NULL WHERE pc.id=${connection} AND pc.resume_pending_at IS NOT NULL
      AND pc.tenant_generation=${generation}::bigint AND NOT EXISTS (SELECT FROM hosted_tenant_status t JOIN provider_connection_regions r ON r.connection_id=t.connection_id AND r.region=t.region
        WHERE t.connection_id=pc.id AND t.applied<>'ENABLED' AND r.tenant_state='ready')`);
    const { rows: [now] } = await runtime.db.execute<{ generation: string }>(sql`SELECT tenant_generation::text AS generation FROM provider_connections WHERE id=${connection}`);
    if (work.length) log('info', { code: 'SES_TENANT_STATUS_SET', workspaceId: wid, status: desired, tenants: work.length, simulated: isSimulatedSes(runtime) });
    if (now?.generation === generation) return;
  }
});

// Platform maintenance, never called by an HTTP request. One failed tenant or region must not stop the rest.
export async function reconcileSharedConnections(runtime: Runtime) {
  if (!runtime.config.multiTenant || isSimulatedSes(runtime)) return;
  for (const region of sharedRegions(runtime)) {
    // Virginia is outbound-only. Its provisioning and enrollment have a separate release gate.
    if (region==='us-east-1') continue;
    try {
      const pool = await getPool(runtime, region);
      if (pool?.legacy_names===false) continue; // The legacy reconciler never owns a newly enrolled pool.
      if (!pool?.sending || !pool.receiving) {
        const principal=await platformIdentity(runtime,pool?.aws_account_id);
        try { await ensurePool(runtime,principal,region); }
        catch (e) {
          if (e instanceof ModuleLoadError) throw e;
          // Receiving (including its separate SNS confirmation) never blocks a healthy sending pool.
          if (!(await getPool(runtime,region))?.sending) throw e;
          log('warn',{operation:'shared-receiving-setup',region,code:awsError(e).code});
        }
      }
      const pending = await runtime.db.execute<Pick<Row,'id'|'workspace_id'>>(sql`SELECT id,workspace_id FROM provider_connections WHERE kind='shared' AND region=${region} AND tenant_state<>'ready'`);
      for (const row of pending.rows) {
        try { await ensureTenant(runtime, row.workspace_id, row.id); }
        catch (e) { if (e instanceof ModuleLoadError) throw e; log('warn', { operation: 'shared-tenant-setup', region, connectionId: row.id, code: awsError(e).code }); }
      }
    } catch (e) { if (e instanceof ModuleLoadError) throw e; const error=awsError(e); log('warn', { operation: 'shared-pool-setup', region, code: error.code, ...(error.code==='POOL_SENDING_DRIFT'?{message:error.message}:{}) }); }
  }
}
async function create(runtime: Runtime, wid: string, input: z.infer<typeof Create>) {
  const { kind } = input, region = input.region ?? (kind === 'shared' ? sharedRegions(runtime)[0]! : platformRegion);
  if (kind === 'byo') template(runtime);
  // Offered regions come from SHARED_SENDING_REGIONS (Ohio at launch; Ireland is inside the IAM boundary).
  const offered = sharedRegions(runtime);
  if (kind === 'shared' && !offered.includes(region)) throw new ApiError(422, 'SHARED_REGION_UNAVAILABLE', `Shared sending is available in ${offered.join(', ')}.`, 'region');
  if (/^(cn-|us-gov-|us-iso|us-isob|eu-isoe|us-isof)/.test(region)) throw new ApiError(422, 'INVALID_REGION', 'Choose a commercial AWS region.', 'region');
  if (kind === 'byo' && !byoRegions.includes(region)) throw new ApiError(422, 'INVALID_REGION', 'Choose a commercial AWS region where Amazon SES supports sending.', 'region');
  assertSesConfigured(runtime);
  if (kind==='shared') {
    // Hosted is instant: `ready` on creation with zero AWS calls. The tenant job owns CreateTenant and flips
    // tenant_state; until then domains and sends answer TENANT_NOT_READY. Simulation has no tenant, so it is ready.
    const row = (await runtime.db.execute<Row & { queued: boolean }>(sql`WITH pool AS (SELECT aws_account_id FROM provider_pool_regions p WHERE region=${region} AND ${poolSends()}), connection AS (
      INSERT INTO provider_connections(id,workspace_id,kind,region,state,tenant_state,aws_account_id,managed_tenant,pool_tenant_name) VALUES (${id('conn')},${wid},'shared',${region},'ready',${isSimulatedSes(runtime) ? 'ready' : 'pending'},(SELECT aws_account_id FROM pool),${!!runtime.config.regionalSending},${runtime.config.trustedPool?poolTenantName(wid,'probation'):null})
      ON CONFLICT(workspace_id) DO UPDATE SET aws_account_id=coalesce(provider_connections.aws_account_id,excluded.aws_account_id) WHERE provider_connections.kind='shared' AND provider_connections.region=excluded.region RETURNING *),
      settings AS (UPDATE ses_installation_settings s SET default_region=c.region,enabled_regions=CASE WHEN EXISTS(SELECT FROM provider_connection_regions r WHERE r.connection_id=c.id AND NOT r.legacy AND r.sending_state='ready') THEN s.enabled_regions ELSE jsonb_build_array(c.region) END FROM connection c WHERE c.workspace_id=s.workspace_id),
      stale AS (UPDATE ses_region_discovery d SET credentials_fingerprint=NULL,report=NULL FROM connection c WHERE c.workspace_id=d.workspace_id AND d.report IS NOT NULL),
      queued AS (${queueTenantJob(sql`SELECT c.id,c.workspace_id FROM connection c JOIN pool USING (aws_account_id) WHERE c.tenant_state<>'ready'`)} RETURNING 1)
      SELECT c.*, EXISTS (SELECT 1 FROM queued) AS queued FROM connection c`)).rows[0];
    if (!row) throw new ApiError(409,'CONNECTION_EXISTS','Disconnect the existing connection before choosing another.');
    return row;
  }
  const principalArn = (await platformIdentity(runtime)).arn;
  // BYO sends from the customer's own account: there is no tenant to wait for.
  const connectionId = id('conn'), prefix = setupResources(connectionId).topicName.replace(/-feedback$/, '');
  const result = await runtime.db.execute<Row>(sql`INSERT INTO provider_connections(id,workspace_id,kind,region,external_id,platform_principal_arn,template_version,state,tenant_state,resource_prefix)
    VALUES (${connectionId},${wid},${kind},${region},${crypto.randomUUID()},${principalArn},'v4','awaiting_role','ready',${prefix})
    ON CONFLICT(workspace_id) DO NOTHING RETURNING *`);
  const row = result.rows[0] ?? await get(runtime, wid);
  if (!row || row.kind !== kind || row.region !== region) throw new ApiError(409, 'CONNECTION_EXISTS', 'Disconnect the existing connection before choosing another.');
  return row;
}
export function registerProviderConnections(app: App) {
  const path = '/v1/connection';
  app.openapi(createRoute({ method: 'get', path, operationId: 'getConnection', tags, security, description: 'Get the current MX workspace connection or null. Poll during BYO setup for awaiting_role, provisioning, ready or failed and the imported domain count. Owner/admin dashboard only.', responses: { 200: response(z.object({ connection: z.union([Connection, z.null()]) })), ...errors } }), async c => {
    const row = await get(c.env, owner(c)); return c.json({ connection: row ? {...view(c.env, row),...(row.template_version==='v5'?await inventory(c.env.db,row as Row & V5Connection):{})} : null }, 200);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/connection/regions', operationId: 'listConnectionRegions', tags, security, description: 'Regions offered for shared sending, and the commercial AWS regions where Amazon SES supports sending for bring-your-own AWS. Owner/admin dashboard only.', responses: { 200: response(z.object({ shared: z.array(z.string()), byo: z.array(z.string()) }).openapi('ConnectionRegions')), ...errors } }), async c => {
    const wid=owner(c); return c.json({ shared: sharedRegions(c.env), byo: await byoEnabled(c.env,wid)?Object.keys(regionLabels):byoRegions }, 200);
  });
  app.openapi(createRoute({ method: 'post', path, operationId: 'createConnection', tags, security, description: 'Choose a sending provider. Regional BYO enrollment requires an account ID and returns a role-only stack link and a read-only scan operation. Legacy enrollment and Hosted mail return 201.', request: { body: json(Create) }, responses: { 201: response(Connection),202:response(Connection.extend({operationId:z.string(),revision:z.number()})), ...errors } }), async c => {
    const wid = owner(c);
    try {
      const input=c.req.valid('json');
      if (input.kind==='byo' && await byoEnabled(c.env,wid)) {
        if (input.awsAccountId===requirePlatformAccount(c.env.config.platformAccount)) throw new ApiError(409,'AWS_ACCOUNT_IN_USE','The shared sending account cannot be connected.');
        const existing=await get(c.env,wid);
        if (!existing || existing.template_version==='v5') {
          if (!input.awsAccountId || input.region) throw new ApiError(422,'INVALID_CONNECTION','Provide the AWS account ID, not a sending region.');
          assertSesConfigured(c.env);
          const op=await enrollV5(c.env,wid,input.awsAccountId);c.get('actor').wakeJobs=1;
          return c.json({...view(c.env,(await get(c.env,wid))!),...op},202);
        }
        if (input.awsAccountId) throw new ApiError(409,'CONNECTION_EXISTS','A different connection already exists.');
      }
      if (input.awsAccountId!==undefined) throw new ApiError(422,'VALIDATION_ERROR','Account ID is only accepted for regional BYO enrollment.');
      const row = await create(c.env, wid, input);
      if ('queued' in row && row.queued) c.get('actor').wakeJobs=1;
      return c.json(view(c.env, row), 201);
    } catch (e) { if (e instanceof ModuleLoadError) throw e; throw awsError(e); }
  });
  app.openapi(createRoute({method:'post',path:path+'/scan',operationId:'refreshConnectionScan',tags,security,description:'Refresh regional inventory without changing AWS resources or selected domains.',responses:{202:response(z.object({operationId:z.string(),revision:z.number()})),...errors}}),async c=>{
    const result=await refreshScan(c.env,owner(c),c.req.header('Idempotency-Key'));c.get('actor').wakeJobs=1;return c.json(result,202);
  });
  app.openapi(createRoute({method:'post',path:path+'/imports',operationId:'importConnectionDomains',tags,security,description:'Select verified regional candidates explicitly. Sending requires confirmed regional feedback. Imported identities are never modified.',request:{body:json(Imports)},responses:{202:response(Accepted),...errors}}),async c=>{
    const result=await selectImports(c.env,owner(c),c.req.valid('json'),c.req.header('Idempotency-Key'));c.get('actor').wakeJobs=1;return c.json(result,202);
  });
  app.openapi(createRoute({method:'get',path:path+'/regions/status',operationId:'getConnectionRegionStatus',tags,security,description:'Read regional AWS inventory, access, ownership journals and setup errors. Does not contact AWS.',responses:{200:response(RegionStatus),...errors}}),async c=>{
    const wid=owner(c),row=await get(c.env,wid);if (row?.template_version!=='v5') return notFound('Regional connection');return c.json({regions:await statuses(c.env.db,row.id)},200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/connection/verify', operationId: 'verifyConnection', tags, security, description: 'Manual fallback for automatic BYO stack detection. Prove the role and start verification and verified-domain import. Poll getConnection until ready. Safe to retry.', request: { body: json(z.object({ awsAccountId: AccountId }).strict()) }, responses: { 200: response(Connection), ...errors } }), async c => {
    const wid = owner(c); assertSesConfigured(c.env); template(c.env);
    const row = await get(c.env, wid) ?? notFound('Connection');
    if (row.kind !== 'byo') throw new ApiError(409, 'BYO_CONNECTION_REQUIRED', 'Only bring-your-own connections require verification.');
    const account = c.req.valid('json').awsAccountId;
    try { return c.json(view(c.env, await provision(c.env, row, account)), 200); } catch (e) { if (e instanceof ModuleLoadError) throw e; throw awsError(e); }
  });
  app.openapi(createRoute({ method: 'delete', path, operationId: 'deleteConnection', tags, security, description: 'Refuses outstanding mail and campaigns. Regional BYO fences sending and queues verified cleanup of its sending sets and feedback topic. Poll getConnection for the remaining manifest; repeat DELETE to resume after fixing access or drift. Keeps identities, DNS and mailbox data. Remove the customer role stack last. Legacy connections retain AWS resources.', responses: { 200: response(z.object({ deleted: z.literal(true) })),202:response(z.object({operationId:z.string()})), ...errors } }), async c => {
    const wid = owner(c);
    try {
      const current=await get(c.env,wid);
      if (current?.template_version==='v5') {const result=await disconnectV5(c.env,wid,current.id);c.get('actor').wakeJobs=1;return c.json(result,202);}
      await c.env.db.transaction(async db => {
        await getRegionSettings(db, wid, 'update'); // Serialize with send admission, which takes FOR SHARE on this row.
        const row = (await db.execute<Row & { pause_reason: string | null }>(sql`SELECT * FROM provider_connections pc WHERE workspace_id=${wid} AND ${notProvisioning()}
          AND NOT EXISTS (SELECT 1 FROM sending_emails WHERE workspace_id=${wid} AND status IN ('queued','attempting','acceptance_unknown'))
          AND NOT EXISTS (SELECT 1 FROM sending_campaigns c WHERE c.workspace_id=${wid} AND ${campaignActive()}) FOR UPDATE`)).rows[0];
        if (!row) {
          if (!(await db.execute(sql`SELECT 1 FROM provider_connections WHERE workspace_id=${wid}`)).rowCount) return notFound('Connection');
          throw new ApiError(409, 'CONNECTION_IN_USE', 'Finish queued work or active setup before disconnecting.');
        }
        // Disconnect/reconnect must not serve as a workspace-controlled unpause.
        if (row.pause_reason) throw new ApiError(409, 'HOSTED_SENDING_PAUSED', row.pause_reason);
        if (row.template_version==='v5' || (await db.execute(sql`SELECT FROM provider_connection_regions WHERE connection_id=${row.id} AND NOT legacy AND NOT (${row.kind}='shared' AND region='us-east-1' AND pool_tenant_name IS NOT NULL AND receiving_state='off' AND sending_state='ready') LIMIT 1`)).rowCount) throw new ApiError(409,'REGIONAL_DISCONNECT_REQUIRED','A regional connection requires reviewed cleanup before disconnecting.');
        await (await wrapModuleLoad(() => import('./operations.js'))).releaseConnectionDomains(c.env, db, wid, { id: row.id, kind: row.kind, region: row.region, aws_account_id: row.aws_account_id!, role_arn: row.role_arn!, external_id: row.external_id!, tenant_state: row.tenant_state });
        await db.execute(sql`DELETE FROM provider_connections WHERE id=${row.id}`);
      });
    } catch (e) { if (e instanceof ModuleLoadError) throw e; throw awsError(e); }
    return c.json({ deleted: true as const }, 200);
  });
}
