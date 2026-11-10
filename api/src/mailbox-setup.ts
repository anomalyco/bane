import { setTimeout as delay } from 'node:timers/promises';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { SESClient as SESClientType, ReceiptRule } from '@aws-sdk/client-ses';
import type { S3Client as S3ClientType } from '@aws-sdk/client-s3';
import type { SNSClient as SNSClientType } from '@aws-sdk/client-sns';
import type { STSClient as STSClientType } from '@aws-sdk/client-sts';
import { ApiError, assertSesConfigured, lazyModule, log, ModuleLoadError, type DbExecutor, type JobHandler, type Runtime } from './core.js';
import { jobs } from './db/core.js';
import { mailboxDomains, mailboxRegions,type MxReport } from './db/mailbox.js';
import { enqueue, JobDeferred, MAX_ATTEMPTS, retryDatabaseFailures } from './jobs.js';
import { checkMx } from './mailbox-dns.js';
import { copyWorkspaceRaw } from './mailbox-mime.js';
import { getRegionSettings } from './ses-region-state.js';
import { awsError, canonical, feedbackUrl, policyReady, POOL_INSTALLATION, setupResources } from './ses-setup.js';
import { bucketPolicy, deliveryPolicy, inboundPolicy, lifecycleRules, publicAccessBlock, receiptRule, redrivePolicy, STAGING_PREFIX } from './mail-controls.js';
import { platformCredentials, workspaceConnection, workspaceCredentials,type ReadyConnection } from './provider-credentials.js';
import { activateReceiving, claimReceivable, connectionReady, noteReconcileFailure } from './states.js';

const OWNER_TAG = 'bane:installation-id';
const PURPOSE_TAG = 'bane:purpose';
const PURPOSE = 'mailbox-inbound';
const RULE_CAPACITY = 500; // SES receipt-rule recipient quota.
export { STAGING_PREFIX };
export const workspacePrefix = (wid:string, kind:'raw'|'att') => `workspaces/${wid}/${kind}/`;
export function assertMailboxKey(wid:string,key:string,kind:'raw'|'att') {
  if (!key.startsWith(workspacePrefix(wid,kind)) || key.split('/').some(s=>!s || s==='.' || s==='..')) throw new ApiError(404,'MAILBOX_OBJECT_NOT_FOUND','The object is not in this workspace.');
}

export function mailboxResources(installationId: string, region: string, account?:string) {
  const prefix = setupResources(installationId).topicName.replace(/-feedback$/, '');
  return { prefix, topicName: `${prefix}-inbound`, bucket: `${prefix}${installationId===POOL_INSTALLATION?`-${account}`:''}-mail-${region}`, ruleSetName: `${prefix}-inbound`, rulePrefix: `${prefix}-inbound-` };
}

type MailboxSetupSdk = {
  ses: typeof import('@aws-sdk/client-ses');
  s3: typeof import('@aws-sdk/client-s3');
  sns: typeof import('@aws-sdk/client-sns');
  sts: typeof import('@aws-sdk/client-sts');
  FetchHttpHandler: typeof import('@smithy/fetch-http-handler').FetchHttpHandler;
};
export const loadMailboxSetupSdk = lazyModule((): Promise<MailboxSetupSdk> => Promise.all([
  import('@aws-sdk/client-ses'), import('@aws-sdk/client-s3'), import('@aws-sdk/client-sns'), import('@aws-sdk/client-sts'), import('@smithy/fetch-http-handler'),
]).then(([ses, s3, sns, sts, { FetchHttpHandler }]) => ({ ses, s3, sns, sts, FetchHttpHandler })));
async function awsConfig(region:string, credentials:NonNullable<Runtime['config']['aws']>) {
  const sdk = await loadMailboxSetupSdk();
  return { sdk, config: { region, credentials, ignoreConfiguredEndpointUrls: true, maxAttempts: 2, requestHandler: new sdk.FetchHttpHandler({ requestTimeout: 15000 }) } };
}
import {storageBinding} from './mailbox-ingest-input.js';
export {storageBinding};
export async function mailboxS3(runtime: Runtime, wid:string, region: string, bucket:string, db:DbExecutor=runtime.db, resolved?:ReadyConnection|null) {
  let credentials=platformCredentials(runtime);
  if (runtime.config.multiTenant) {
    const binding=resolved===undefined ? (await db.execute<{binding:ReadyConnection|null}>(sql`SELECT ${storageBinding(wid,region,bucket)} AS binding`)).rows[0]!.binding : resolved;
    if (!binding) throw new ApiError(404,'MAILBOX_OBJECT_NOT_FOUND','The mailbox storage connection is unavailable.');
    credentials=await workspaceCredentials(runtime,region,binding);
  }
  const { sdk, config } = await awsConfig(region, credentials);
  return new sdk.s3.S3Client({ ...config, maxAttempts: 3 });
}

/** Upgrade old single-tenant objects on first read. Never sign a legacy key or touch it on MX. */
export async function readableMailboxKey(runtime:Runtime,wid:string,region:string,bucket:string,key:string,kind:'raw'|'att',db:DbExecutor=runtime.db,client?:S3ClientType) {
  if (!runtime.config.multiTenant && !key.startsWith('workspaces/')) {
    const raw=kind==='raw';
    if (!(raw ? /^raw\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/ : /^att\/msg_[a-f0-9]{32}\/matt_[a-f0-9]{32}$/).test(key)) throw new ApiError(404,'MAILBOX_OBJECT_NOT_FOUND','Unknown legacy object key.');
    const dest=workspacePrefix(wid,kind)+key.slice(4)+(raw?'.eml':'');
    const binding=raw ? sql`SELECT envelope_to FROM mail_messages WHERE workspace_id=${wid} AND region=${region} AND raw_bucket=${bucket} AND raw_key=${key} AND raw_key='raw/'||ses_message_id` : sql`SELECT 1 FROM mail_attachments WHERE workspace_id=${wid} AND bucket=${bucket} AND storage_key=${key} AND storage_key='att/'||message_id||'/'||id`;
    const row=(await db.execute<{envelope_to:string[]}>(binding)).rows[0];
    if (!row) throw new ApiError(404,'MAILBOX_OBJECT_NOT_FOUND','Unknown legacy mailbox object.');
    const [sdk, s3] = await Promise.all([loadMailboxSetupSdk(), client ? Promise.resolve(client) : mailboxS3(runtime,wid,region,bucket,db)]);
    try { if(raw) await copyWorkspaceRaw(s3,region,bucket,key,dest,row.envelope_to,'legacy-raw');else await s3.send(new sdk.s3.CopyObjectCommand({Bucket:bucket,Key:dest,CopySource:`${bucket}/${key}`})); }
    finally {if(!client)s3.destroy();}
    // A raw download must continue to expire with its original, not 90 days from its last download.
    if(!raw) await db.execute(sql`UPDATE mail_attachments SET storage_key=${dest} WHERE workspace_id=${wid} AND bucket=${bucket} AND storage_key=${key}`);
    key=dest;
  }
  assertMailboxKey(wid,key,kind);
  return key;
}

// SES control-plane actions (including receipt rules) are limited to one request per second.
function pacedSes(client: SESClientType, signal: AbortSignal) {
  let last = -Infinity; let queue: Promise<unknown> = Promise.resolve();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return <T = unknown>(label: string, command: any): Promise<T> => {
    const run = queue.then(async () => {
      for (let attempt = 0; ; attempt++) {
        const wait = 1000 - (performance.now() - last);
        if (wait > 0) await delay(Math.ceil(wait), undefined, { signal });
        try { return await client.send(command, { abortSignal: signal }) as T; }
        catch (error) {
          if (attempt < 2 && /Throttl|TooManyRequests/.test(error instanceof Error ? error.name : '')) { await delay(1000 * 2 ** attempt, undefined, { signal }); continue; }
          throw step(label, error);
        } finally { last = performance.now(); }
      }
    });
    queue = run.then(() => undefined, () => undefined);
    return run;
  };
}
// Name the failing AWS action so an IAM gap is obvious from the stored error.
type StepError = ApiError & { awsName?: string };
function step(label: string, error: unknown): StepError {
  if (error instanceof ModuleLoadError) throw error;
  if (error instanceof ApiError) return error;
  const mapped = awsError(error), name = errorName(error);
  const result: StepError = new ApiError(mapped.status, mapped.code, `${mapped.message} (${label}${name ? `: ${name}` : ''})`, mapped.field, mapped.retryable);
  result.awsName = name;
  return result;
}
async function aws<T>(label: string, work: () => Promise<T>): Promise<T> { try { return await work(); } catch (error) { throw step(label, error); } }
const tags = (installationId: string) => [{ Key: OWNER_TAG, Value: installationId }, { Key: PURPOSE_TAG, Value: PURPOSE }];
const errorName = (error: unknown) => error instanceof Error ? error.name : '';
const httpStatus = (error: unknown) => (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;

export type RegionResources = { account: string; bucket: string; topicArn: string; ruleSetName: string };

/** Idempotently creates the Bane-owned bucket, SNS topic + HTTPS subscription and ensures an active receipt rule set. */
type Clients = { sts: STSClientType; s3: S3ClientType; sns: SNSClientType; ses: ReturnType<typeof pacedSes>; sdk: MailboxSetupSdk };
async function ensureRegion(runtime: Runtime, region: string, installationId: string, signal: AbortSignal, { sts, s3, sns, ses, sdk }: Clients, register:(account:string,bucket:string,arn:string)=>Promise<void>): Promise<RegionResources & { rules: ReceiptRule[] }> {
  if (runtime.config.multiTenant && installationId===POOL_INSTALLATION) throw new ApiError(409,'POOL_RESOURCE_OWNERSHIP','Per-domain setup cannot manage hosted pool resources.');
  const { DescribeActiveReceiptRuleSetCommand, CreateReceiptRuleSetCommand, SetActiveReceiptRuleSetCommand, DescribeReceiptRuleSetCommand } = sdk.ses;
  const { HeadBucketCommand, CreateBucketCommand, PutBucketTaggingCommand, PutPublicAccessBlockCommand, PutBucketPolicyCommand, PutBucketLifecycleConfigurationCommand } = sdk.s3;
  const { CreateTopicCommand, ListTagsForResourceCommand, SetTopicAttributesCommand, ListSubscriptionsByTopicCommand, SubscribeCommand } = sdk.sns;
  const { GetCallerIdentityCommand } = sdk.sts;
  const endpoint = feedbackUrl(runtime.config);
  {
    const account = (await aws('sts:GetCallerIdentity', () => sts.send(new GetCallerIdentityCommand({}), { abortSignal: signal }))).Account;
    if (!account || !/^\d{12}$/.test(account)) throw new ApiError(503, 'AWS_ACCOUNT_UNKNOWN', 'STS did not return a valid AWS account identity.');
    if (runtime.config.awsAccountId && runtime.config.awsAccountId !== account) throw new ApiError(409, 'AWS_ACCOUNT_MISMATCH', 'Mailboxes must use the same AWS account as the provisioned SES region.');
    const names = mailboxResources(installationId, region,account);

    // Outside Virginia, CreateBucket returns BucketAlreadyOwnedByYou without changing the bucket.
    // Avoid granting MX ListBucket for a HEAD probe. In Virginia re-creation can reset ACLs.
    let exists = false;
    if (!runtime.config.multiTenant || region === 'us-east-1') {
      try { await s3.send(new HeadBucketCommand({ Bucket: names.bucket,ExpectedBucketOwner:account }), { abortSignal: signal }); exists = true; }
      catch (error) {
        if (httpStatus(error) === 403) throw new ApiError(409, 'MAILBOX_BUCKET_CONFLICT', `The S3 bucket name ${names.bucket} is owned by another AWS account.`);
        if (httpStatus(error) !== 404 && errorName(error) !== 'NotFound') throw step('s3:HeadBucket', error);
      }
    }
    if (!exists) {
      // New general-purpose S3 buckets default to BucketOwnerEnforced. On MX, omitting the header
      // avoids granting the Worker permission to change an existing bucket's ownership controls.
      try { await s3.send(new CreateBucketCommand({ Bucket: names.bucket, ...(runtime.config.multiTenant ? {} : { ObjectOwnership: 'BucketOwnerEnforced' as const }), ...(region === 'us-east-1' ? {} : { CreateBucketConfiguration: { LocationConstraint: region as never } }) }), { abortSignal: signal }); }
      catch (error) { if (errorName(error) !== 'BucketAlreadyOwnedByYou') throw errorName(error) === 'BucketAlreadyExists' ? new ApiError(409, 'MAILBOX_BUCKET_CONFLICT', `The S3 bucket name ${names.bucket} is taken.`) : step('s3:CreateBucket', error); }
    }
    await aws('s3:PutBucketTagging', () => s3.send(new PutBucketTaggingCommand({ Bucket: names.bucket, Tagging: { TagSet: tags(installationId) } }), { abortSignal: signal }));
    await aws('s3:PutPublicAccessBlock', () => s3.send(new PutPublicAccessBlockCommand({ Bucket: names.bucket, PublicAccessBlockConfiguration: publicAccessBlock }), { abortSignal: signal }));
    await aws('s3:PutBucketPolicy', () => s3.send(new PutBucketPolicyCommand({ Bucket: names.bucket, Policy: JSON.stringify(bucketPolicy(names.bucket, region, account, names.rulePrefix)) }), { abortSignal: signal }));
    await aws('s3:PutLifecycleConfiguration', () => s3.send(new PutBucketLifecycleConfigurationCommand({ Bucket: names.bucket, LifecycleConfiguration: {Rules:lifecycleRules(installationId===POOL_INSTALLATION)} }), { abortSignal: signal }));

    // Topic: CreateTopic is idempotent, so ownership is proven by tags, never by name alone.
    const expectedTopic = `arn:aws:sns:${region}:${account}:${names.topicName}`;
    const created = await aws('sns:CreateTopic', () => sns.send(new CreateTopicCommand({ Name: names.topicName, Tags: tags(installationId) }), { abortSignal: signal }));
    if (created.TopicArn !== expectedTopic) throw new ApiError(409, 'RESOURCE_OWNERSHIP_CONFLICT', 'SNS did not return the expected inbound topic ARN.');
    const topicTags = await aws('sns:ListTagsForResource', () => sns.send(new ListTagsForResourceCommand({ ResourceArn: expectedTopic }), { abortSignal: signal }));
    if (!tags(installationId).every(tag => topicTags.Tags?.some(value => value.Key === tag.Key && value.Value === tag.Value))) throw new ApiError(409, 'RESOURCE_OWNERSHIP_CONFLICT', 'The inbound SNS topic exists without this installation’s ownership tags.');
    await aws('sns:SetTopicAttributes', () => sns.send(new SetTopicAttributesCommand({ TopicArn: expectedTopic, AttributeName: 'Policy', AttributeValue: JSON.stringify(inboundPolicy(expectedTopic, region, account, names.rulePrefix)) }), { abortSignal: signal }));
    // Topic default protects already-confirmed subscriptions too. SNS caps HTTP retry time at one hour.
    await aws('sns:SetTopicAttributes', () => sns.send(new SetTopicAttributesCommand({TopicArn:expectedTopic,AttributeName:'DeliveryPolicy',AttributeValue:JSON.stringify(deliveryPolicy)}),{abortSignal:signal}));

    // Trust the topic before subscribing so the signed confirmation passes the ingress allowlist.
    await register(account,names.bucket,expectedTopic);
    const subscriptions = await aws('sns:ListSubscriptionsByTopic', () => sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: expectedTopic }), { abortSignal: signal }));
    const subscription=subscriptions.Subscriptions?.find(sub => sub.Protocol === 'https' && sub.Endpoint === endpoint);
    const subscribed=subscription ?? await aws('sns:Subscribe', () => sns.send(new SubscribeCommand({ TopicArn: expectedTopic, Protocol: 'https', Endpoint: endpoint, ReturnSubscriptionArn: false, Attributes: { RawMessageDelivery: 'false' } }), { abortSignal: signal }));
    if (installationId===POOL_INSTALLATION && !subscribed.SubscriptionArn?.startsWith(expectedTopic+':')) throw new ApiError(503,'INBOUND_CONFIRMATION_PENDING','Waiting for confirmation of the inbound SNS subscription.',undefined,true);
    if(installationId===POOL_INSTALLATION && runtime.config.receivingRedrive && region==='us-east-2') await aws('sns:SetSubscriptionAttributes',()=>sns.send(new sdk.sns.SetSubscriptionAttributesCommand({SubscriptionArn:subscribed.SubscriptionArn,AttributeName:'RedrivePolicy',AttributeValue:JSON.stringify({deadLetterTargetArn:`arn:aws:sqs:${region}:${account}:bane-inbound-dead-letters`})}),{abortSignal:signal}));

    // One receipt rule set is active per account and region. Join an existing one; never replace it.
    let active = await ses<{ Metadata?: { Name?: string }; Rules?: ReceiptRule[] }>('ses:DescribeActiveReceiptRuleSet', new DescribeActiveReceiptRuleSetCommand({}));
    if (!active.Metadata?.Name) {
      try { await ses('ses:CreateReceiptRuleSet', new CreateReceiptRuleSetCommand({ RuleSetName: names.ruleSetName })); }
      catch (error) { if ((error as StepError).awsName !== 'AlreadyExistsException') throw error; }
      await ses('ses:SetActiveReceiptRuleSet', new SetActiveReceiptRuleSetCommand({ RuleSetName: names.ruleSetName }));
      active = await ses('ses:DescribeReceiptRuleSet', new DescribeReceiptRuleSetCommand({ RuleSetName: names.ruleSetName }));
      if (!active.Metadata?.Name) active = { Metadata: { Name: names.ruleSetName }, Rules: active.Rules ?? [] };
    }
    return { account, bucket: names.bucket, topicArn: expectedTopic, ruleSetName: active.Metadata!.Name!, rules: active.Rules ?? [] };
  }
}

const ruleFor = receiptRule;
function ruleMatches(rule: ReceiptRule, expected: ReceiptRule) {
  const action = rule.Actions?.length === 1 ? rule.Actions[0]!.S3Action : undefined;
  const want = expected.Actions![0]!.S3Action!;
  return rule.Enabled === true && rule.ScanEnabled === true && rule.TlsPolicy === 'Optional' && JSON.stringify([...(rule.Recipients ?? [])].sort()) === JSON.stringify(expected.Recipients)
    && action?.BucketName === want.BucketName && action?.ObjectKeyPrefix === want.ObjectKeyPrefix && action?.TopicArn === want.TopicArn && !action?.KmsKeyArn;
}

const receivingDrift=(resource:string)=>new ApiError(409,'POOL_RECEIVING_DRIFT',`${resource} is missing or differs from the hosted configuration. An operator must run Pulumi provisioning.`);
async function poolRead<T>(resource:string,work:()=>Promise<T>) {
  try {return await work();} catch(e) {
    if (httpStatus(e)===404 || /^(NoSuchBucket|NoSuchBucketPolicy|NoSuchLifecycleConfiguration|NoSuchPublicAccessBlockConfiguration|NotFound(Exception)?|RuleSetDoesNotExist)$/.test((e as StepError)?.awsName??errorName(e))) throw receivingDrift(resource);
    throw step(resource,e);
  }
}
function jsonMatches(value:string|undefined,want:unknown) {
  try {return !!value && canonical(JSON.parse(value))===canonical(want);} catch {return false;}
}
async function verifyPoolRegion(runtime:Runtime,region:string,account:string,signal:AbortSignal,{sdk,s3,sns,ses}:Omit<Clients,'sts'>,register:(account:string,bucket:string,topic:string)=>Promise<void>) {
  const {bucket,rulePrefix,topicName,ruleSetName}=mailboxResources(POOL_INSTALLATION,region,account);
  const topicArn=`arn:aws:sns:${region}:${account}:${topicName}`, endpoint=feedbackUrl(runtime.config), opts={abortSignal:signal}, b={Bucket:bucket,ExpectedBucketOwner:account};
  const policy=await poolRead(`${bucket} Policy`,()=>s3.send(new sdk.s3.GetBucketPolicyCommand(b),opts));
  if (!policyReady(policy.Policy,bucketPolicy(bucket,region,account,rulePrefix))) throw receivingDrift(`${bucket} Policy`);
  const block=await poolRead(`${bucket} PublicAccessBlock`,()=>s3.send(new sdk.s3.GetPublicAccessBlockCommand(b),opts));
  if (canonical(block.PublicAccessBlockConfiguration)!==canonical(publicAccessBlock)) throw receivingDrift(`${bucket} PublicAccessBlock`);
  const lifecycle=await poolRead(`${bucket} LifecycleConfiguration`,()=>s3.send(new sdk.s3.GetBucketLifecycleConfigurationCommand(b),opts));
  // S3/terraform can represent the all-objects filter as <Filter/> rather than <Prefix/>.
  const rules=lifecycle.Rules?.map(r=>({...r,Filter:r.Filter && !Object.keys(r.Filter).length?{Prefix:''}:r.Filter}));
  if (canonical(rules)!==canonical(lifecycleRules(true))) throw receivingDrift(`${bucket} LifecycleConfiguration`);
  const {Attributes:a}=await poolRead(topicArn,()=>sns.send(new sdk.sns.GetTopicAttributesCommand({TopicArn:topicArn}),opts));
  if (a?.Owner!==account || a.TopicArn!==topicArn || !policyReady(a.Policy,inboundPolicy(topicArn,region,account,rulePrefix))) throw receivingDrift(`${topicArn} Policy`);
  if (!jsonMatches(a.DeliveryPolicy,deliveryPolicy)) throw receivingDrift(`${topicArn} DeliveryPolicy`);
  const t=await poolRead(topicArn,()=>sns.send(new sdk.sns.ListTagsForResourceCommand({ResourceArn:topicArn}),opts));
  if (!tags(POOL_INSTALLATION).every(tag=>t.Tags?.some(v=>v.Key===tag.Key && v.Value===tag.Value))) throw receivingDrift(`${topicArn} tags`);
  const active=await poolRead(ruleSetName,()=>ses<{Metadata?:{Name?:string};Rules?:ReceiptRule[]}>('ses:DescribeActiveReceiptRuleSet',new sdk.ses.DescribeActiveReceiptRuleSetCommand({})));
  const expected=receiptRule(rulePrefix+'all',[],{bucket,topicArn}), actual=active.Rules?.[0];
  if (active.Metadata?.Name!==ruleSetName || active.Rules?.length!==1 || !actual || canonical({...actual,Recipients:actual.Recipients??[]})!==canonical(expected)) throw receivingDrift(`${ruleSetName}/${expected.Name}`);

  // Register before confirmation can be accepted. Only the deploy role subscribes inbound:
  // a fresh account may need its signed confirmation resent after this checkpoint.
  await register(account,bucket,topicArn);
  const subs=await poolRead(topicArn,()=>sns.send(new sdk.sns.ListSubscriptionsByTopicCommand({TopicArn:topicArn}),opts));
  const sub=subs.Subscriptions?.[0];
  if (subs.NextToken || subs.Subscriptions?.length!==1 || !sub || sub.Protocol!=='https' || sub.Endpoint!==endpoint || sub.TopicArn!==topicArn || sub.Owner!==account) throw receivingDrift(`${topicArn} HTTPS subscription`);
  if (['PendingConfirmation','pending confirmation'].includes(sub.SubscriptionArn??'')) throw new ApiError(503,'INBOUND_CONFIRMATION_PENDING','Waiting for signed confirmation of the inbound SNS subscription.',undefined,true);
  if (!sub.SubscriptionArn?.startsWith(topicArn+':')) throw receivingDrift(`${topicArn} HTTPS subscription`);
  const {Attributes:s}=await poolRead(sub.SubscriptionArn,()=>sns.send(new sdk.sns.GetSubscriptionAttributesCommand({SubscriptionArn:sub.SubscriptionArn}),opts));
  if (s?.TopicArn!==topicArn || s.Owner!==account || s.Endpoint!==endpoint || s.Protocol!=='https') throw receivingDrift(`${sub.SubscriptionArn} attributes`);
  if (s.PendingConfirmation==='true') throw new ApiError(503,'INBOUND_CONFIRMATION_PENDING','Waiting for signed confirmation of the inbound SNS subscription.',undefined,true);
  if (s.PendingConfirmation!=='false' || s.RawMessageDelivery!=='false' || s.FilterPolicy && !jsonMatches(s.FilterPolicy,{})) throw receivingDrift(`${sub.SubscriptionArn} attributes`);
  if (runtime.config.receivingRedrive && region==='us-east-2' && !jsonMatches(s.RedrivePolicy,redrivePolicy(region,account))) throw receivingDrift(`${sub.SubscriptionArn} RedrivePolicy`);
  return {account,bucket,topicArn,ruleSetName,rules:active.Rules};
}

/** Platform maintenance only: customer identities share one regional catch-all rule. */
export async function preparePoolReceiving(runtime:Runtime,region:string,account:string,register:(account:string,bucket:string,arn:string)=>Promise<void>) {
  if (!runtime.config.multiTenant) throw new ApiError(409,'HOSTED_RECEIVING_REQUIRED','Pool verification requires a hosted installation.');
  if (region==='us-east-1' || (runtime.config.regionalSending && region!=='us-east-2')) throw new ApiError(409,'HOSTED_RECEIVING_REGION','Hosted receiving is only available in Ohio.');
  if (!/^\d{12}$/.test(account) || runtime.config.awsAccountId && runtime.config.awsAccountId!==account) throw new ApiError(409,'AWS_ACCOUNT_MISMATCH','Hosted receiving must use the provisioned pool account.');
  assertSesConfigured(runtime);
  const { sdk, config }=await awsConfig(region,platformCredentials(runtime)),signal=AbortSignal.timeout(90000);
  const ses=new sdk.ses.SESClient(config),clients={ses:pacedSes(ses,signal),s3:new sdk.s3.S3Client(config),sns:new sdk.sns.SNSClient(config),sdk};
  try {
    return (await verifyPoolRegion(runtime,region,account,signal,clients,register)).bucket;
  } finally { ses.destroy(); clients.s3.destroy(); clients.sns.destroy(); }
}

/**
 * Makes the Bane receipt rules accept exactly the domains whose mailbox state wants mail.
 * Rules are packed up to the SES recipient quota. A rule is deleted instead of emptied:
 * a receipt rule with no recipients matches every address on every domain.
 */
export async function reconcileRegion(runtime: Runtime, region: string, workspaceId:string): Promise<void> {
  assertSesConfigured(runtime);
  const scoped={...runtime,config:{...runtime.config,workspaceId}};
  const connection=runtime.config.multiTenant ? await workspaceConnection(scoped,region) : undefined;
  if (connection?.kind==='shared') return; // Pool preparation is never a per-domain operation.
  if (connection?.legacy===false) return; // Sending enrollment never authorizes the v4 receipt-rule reconciler.
  const { sdk, config } = await awsConfig(region,connection ? await workspaceCredentials(scoped,region,connection) : platformCredentials(runtime));
  const { DeleteReceiptRuleCommand, CreateReceiptRuleCommand, UpdateReceiptRuleCommand } = sdk.ses;
  await runtime.db.insert(mailboxRegions).values({ workspaceId, region }).onConflictDoNothing();
  // The lease must expire before the job's own lease (3 minutes), so a retry of a run that died can take over
  // instead of failing as busy. A normal run takes seconds; the abort below keeps a live run inside the lease.
  const [lease] = await runtime.db.update(mailboxRegions).set({ reconcileLeaseUntil: sql`now() + interval '2 minutes'` })
    .where(and(eq(mailboxRegions.workspaceId, workspaceId), eq(mailboxRegions.region, region), sql`(${mailboxRegions.reconcileLeaseUntil} IS NULL OR ${mailboxRegions.reconcileLeaseUntil} < now())`)).returning({ region: mailboxRegions.region });
  if (!lease) throw new ApiError(503, 'MAILBOX_RECONCILE_BUSY', 'Another mailbox setup run owns this region; retrying.', undefined, true);
  const signal = AbortSignal.timeout(100000);
  const sesClient = new sdk.ses.SESClient(config);
  const clients = { sts: new sdk.sts.STSClient(config), s3: new sdk.s3.S3Client(config), sns: new sdk.sns.SNSClient(config), ses: pacedSes(sesClient, signal), sdk };
  try {
    const settings = await getRegionSettings(runtime.db, workspaceId);
    const resources = { ...await ensureRegion({...runtime,config:{...runtime.config,awsAccountId:connection?.aws_account_id ?? runtime.config.awsAccountId}}, region, settings.installationId, signal, clients,async(account,bucket,arn)=>{
      await runtime.db.update(mailboxRegions).set({ accountId:account,bucket,topicArn:arn,updatedAt:new Date().toISOString() }).where(and(eq(mailboxRegions.workspaceId,workspaceId),eq(mailboxRegions.region,region)));
    }), ses: clients.ses };
    const names = mailboxResources(settings.installationId, region);
    const rows = await runtime.db.select().from(mailboxDomains).where(and(eq(mailboxDomains.workspaceId, workspaceId), eq(mailboxDomains.region, region),connection ? sql`EXISTS (SELECT 1 FROM domain_claims dc JOIN operation_domains d ON d.workspace_id=dc.workspace_id AND d.name=dc.name WHERE dc.connection_id=${connection.id} AND dc.receiving_host=${mailboxDomains.receivingHost} AND dc.workspace_id=${workspaceId} AND d.id=${mailboxDomains.domainId} AND d.region=${region})` : undefined));
    // Self-hosted wildcard rows are covered by their parent. BYO rules list only MX-proven hostnames.
    const receiving = rows.filter(row => !row.parentId && ['provisioning', 'waiting_for_mx', 'active'].includes(row.status));
    const desired = new Set(connection ? rows.map(row=>row.receivingHost!) : receiving.flatMap(row => row.acceptSubdomains ? [row.name, `.${row.name}`] : [row.name]));
    const ours = resources.rules.filter(rule => rule.Name?.startsWith(names.rulePrefix)).sort((a, b) => a.Name!.localeCompare(b.Name!));
    const current = new Set(ours.flatMap(rule => rule.Recipients ?? []));
    const pending = [...desired].filter(name => !current.has(name)).sort();
    const plan = ours.map(rule => {
      const kept = (rule.Recipients ?? []).filter(name => desired.has(name));
      while (kept.length < RULE_CAPACITY && pending.length) kept.push(pending.shift()!);
      return { name: rule.Name!, existing: rule, recipients: kept };
    });
    let next = ours.reduce((max, rule) => Math.max(max, Number(rule.Name!.slice(names.rulePrefix.length)) || 0), 0);
    while (pending.length) plan.push({ name: `${names.rulePrefix}${String(++next).padStart(3, '0')}`, existing: undefined as unknown as ReceiptRule, recipients: pending.splice(0, RULE_CAPACITY) });
    let after = resources.rules.at(-1)?.Name;
    for (const item of plan) {
      const rule = ruleFor(item.name, item.recipients, resources);
      if (!item.recipients.length) { if (item.existing) await resources.ses('ses:DeleteReceiptRule', new DeleteReceiptRuleCommand({ RuleSetName: resources.ruleSetName, RuleName: item.name })); continue; }
      if (!item.existing) { await resources.ses('ses:CreateReceiptRule', new CreateReceiptRuleCommand({ RuleSetName: resources.ruleSetName, Rule: rule, ...(after ? { After: after } : {}) })); after = item.name; }
      else if (!ruleMatches(item.existing, rule)) await resources.ses('ses:UpdateReceiptRule', new UpdateReceiptRuleCommand({ RuleSetName: resources.ruleSetName, Rule: rule }));
    }
    const now = new Date().toISOString();
    await runtime.db.update(mailboxRegions).set({ ruleSetName: resources.ruleSetName, lastReconciledAt: now, lastError: null, updatedAt: now }).where(and(eq(mailboxRegions.workspaceId, workspaceId), eq(mailboxRegions.region, region)));
    if (connection) {
      // DNS can move while AWS is working. Activate only still-claimed hosts in the rule we installed.
      await activateReceiving(runtime.db, workspaceId, connection.id, region, [...desired]);
      return;
    }
    for (const row of rows) {
      if (row.parentId) continue;
      if (row.status === 'disabling') { await runtime.db.update(mailboxDomains).set({ status: 'disabled', lastError: null, updatedAt: now }).where(and(eq(mailboxDomains.id, row.id), eq(mailboxDomains.status, 'disabling'))); continue; }
      if (row.status !== 'provisioning') continue;
      const mx = await checkMx(row.name, region);
      await runtime.db.update(mailboxDomains).set({ status: mx.state === 'active' ? 'active' : 'waiting_for_mx', mx, checkedAt: mx.checkedAt, enabledAt: row.enabledAt ?? now, lastError: null, updatedAt: now })
        .where(and(eq(mailboxDomains.id, row.id), eq(mailboxDomains.status, row.status)));
    }
    log('info', { code: 'MAILBOX_REGION_RECONCILED', region, domains: desired.size, rules: plan.filter(item => item.recipients.length).length });
  } finally {
    clients.sts.destroy(); clients.s3.destroy(); clients.sns.destroy(); sesClient.destroy();
    await runtime.db.update(mailboxRegions).set({ reconcileLeaseUntil: null }).where(and(eq(mailboxRegions.workspaceId, workspaceId), eq(mailboxRegions.region, region)));
  }
}

/** Queue one reconcile per region unless one is already waiting (a running one may have read older state). */
export async function queueReconcile(db: DbExecutor, workspaceId: string, region: string) {
  const [waiting] = await db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.workspaceId, workspaceId), eq(jobs.type, 'mailbox.reconcile'), eq(jobs.status, 'pending'), sql`${jobs.payload}->>'region' = ${region}`)).limit(1);
  if (waiting) return waiting.id;
  return enqueue(db, { type: 'mailbox.reconcile', workspaceId, payload: { region } });
}

const reconcileJob: JobHandler = async (runtime, payload, job) => {
  const region = typeof payload.region === 'string' ? payload.region : '';
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region)) throw new ApiError(500, 'JOB_PAYLOAD_INVALID', 'Invalid mailbox reconcile job.');
  try { await reconcileRegion(runtime, region,job.workspaceId); }
  catch (error) {
    if (error instanceof ModuleLoadError) throw error;
    const failure = error instanceof ApiError ? error : new ApiError(503, 'MAILBOX_SETUP_FAILED', 'Mailbox setup could not complete; it will be retried.', undefined, true);
    const final = !failure.retryable || job.attempts >= MAX_ATTEMPTS;
    const message = `${failure.code}: ${failure.message}`.slice(0, 500);
    if (failure.code !== 'MAILBOX_RECONCILE_BUSY') {
      const now = new Date().toISOString();
      await runtime.db.update(mailboxRegions).set({ lastError: message, updatedAt: now }).where(and(eq(mailboxRegions.workspaceId, job.workspaceId), eq(mailboxRegions.region, region)));
      if (runtime.config.multiTenant) await runtime.db.execute(noteReconcileFailure(job.workspaceId, region, message));
      else await runtime.db.update(mailboxDomains).set({ lastError: message, ...(final ? { status: 'failed' as const } : {}), updatedAt: now })
        .where(and(eq(mailboxDomains.workspaceId, job.workspaceId), eq(mailboxDomains.region, region), inArray(mailboxDomains.status, ['provisioning', 'disabling'])));
    }
    throw failure;
  }
};

/** Self-hosted legacy routes have no domain_claims row. Keep their last good observation on outages too. */
export async function saveMailboxMx(db:DbExecutor,wid:string,domainId:string,mx:MxReport) {
  if (mx.state==='error') return;
  const active=mx.state==='active';
  const mixed=mx.state==='mixed';
  const hold=sql`(status='active' AND NOT ${active} AND (${mixed} OR mx_misses<2))`;
  await db.execute(sql`UPDATE mailbox_domains SET mx=CASE WHEN ${hold} THEN mx ELSE ${JSON.stringify(mx)}::jsonb END,
    checked_at=${mx.checkedAt},updated_at=now(),mx_misses=CASE WHEN ${hold} AND NOT ${mixed} THEN mx_misses+1 ELSE 0 END,
    status=CASE WHEN status NOT IN ('waiting_for_mx','active') OR ${hold} THEN status WHEN ${active} THEN 'active' ELSE 'waiting_for_mx' END
    WHERE workspace_id=${wid} AND domain_id=${domainId} AND parent_id IS NULL`);
}
// One hourly pass through the binding index, in resumable pages. At most 600 bindings
// read and 50 DNS jobs written per step: 12 healthy rounds cover even a full page,
// with 36 hours of slack before DMARC expiry. Sparse pages retain hourly checks.
const dnsSweep='maintenance.domainDns', dnsBatch=50, dnsPage=dnsBatch*12;
const scheduleDnsPage:JobHandler=async(runtime,payload)=>{
  if(!runtime.config.multiTenant) return;
  const after=typeof payload.after==='string' ? sql`WHERE domain_id>${payload.after}` : sql``;
  const {rows:[next]}=await runtime.db.execute<{after:string}>(sql`WITH page AS MATERIALIZED (
      SELECT domain_id,connection_id,workspace_id,name,region FROM domain_sending_bindings ${after} ORDER BY domain_id LIMIT ${dnsPage}
    ), due AS (SELECT dc.token,dc.workspace_id,d.domain_id AS id,coalesce(j.created_at,dc.created_at) AS last_attempt FROM page d
      JOIN domain_claims dc ON d.workspace_id=dc.workspace_id AND d.name=dc.name AND d.connection_id=dc.connection_id
      JOIN regional_connections pc ON pc.id=d.connection_id AND pc.region=d.region AND ${connectionReady()}
      LEFT JOIN jobs j ON j.id='domain.mx:'||dc.token WHERE dc.identity IS NOT NULL AND (${claimReceivable()} OR dc.sending_state IN ('verified','lost')) AND (j.id IS NULL OR (j.status NOT IN ('pending','running') AND j.created_at<=now()-interval '50 minutes'))
      ORDER BY last_attempt,j.created_at NULLS FIRST,dc.token LIMIT ${dnsBatch}), verify AS (
      INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'domain.verify:'||dc.token,'domain.verify',d.workspace_id,jsonb_build_object('domainId',d.id,'token',dc.token) FROM due d JOIN domain_claims dc ON dc.token=d.token JOIN provider_connections pc ON pc.id=dc.connection_id
      WHERE dc.receiving_host IS NOT NULL AND (dc.receiving_identity_at IS NULL OR dc.receiving_identity_at<now()-CASE WHEN pc.kind='byo' THEN interval '8 hours' ELSE interval '24 hours' END)
      ON CONFLICT(id) DO UPDATE SET status='pending',payload=excluded.payload,available_at=now(),attempts=0,lease_until=NULL,last_error=NULL WHERE jobs.status IN ('completed','failed')), queued AS (
      INSERT INTO jobs(id,type,workspace_id,payload,available_at)
      SELECT 'domain.mx:'||token,'domain.mx',workspace_id,jsonb_build_object('domainId',id,'token',token),
        now()+interval '1 hour'*(row_number() OVER(ORDER BY last_attempt,token)-1)/${dnsBatch} FROM due
      ON CONFLICT(id) DO UPDATE SET status='pending',attempts=0,payload=excluded.payload,available_at=excluded.available_at,created_at=now(),lease_until=NULL,last_error=NULL WHERE jobs.status NOT IN ('pending','running') AND jobs.created_at<=now()-interval '50 minutes')
    SELECT max(domain_id) AS after FROM page HAVING count(*)=${dnsPage}`);
  if(next) throw new JobDeferred(new Date().toISOString(),{after:next.after});
};

/** Hourly: refresh DNS for receiving and proven sending domains. */
export async function refreshMailboxDns(runtime: Runtime) {
  if (runtime.config.multiTenant) {
    // Duplicate ticks must not reset an in-progress cursor or start a second sweep.
    await runtime.db.execute(sql`INSERT INTO jobs(id,type,workspace_id,payload) VALUES(${dnsSweep},${dnsSweep},${runtime.config.workspaceId},'{}')
      ON CONFLICT(id) DO UPDATE SET status='pending',attempts=0,payload='{}',available_at=now(),created_at=now(),lease_until=NULL,last_error=NULL
      WHERE jobs.status NOT IN ('pending','running') AND jobs.created_at<=now()-interval '50 minutes'`);
    return;
  }
  const rows = await runtime.db.select().from(mailboxDomains).where(and(isNull(mailboxDomains.parentId), inArray(mailboxDomains.status, ['waiting_for_mx', 'active']), sql`(${mailboxDomains.checkedAt} IS NULL OR ${mailboxDomains.checkedAt} < now() - interval '50 minutes')`)).limit(50);
  for (const row of rows) {
    const mx = await checkMx(row.name, row.region);
    await saveMailboxMx(runtime.db,row.workspaceId,row.domainId,mx);
  }
}

export const mailboxSetupJobs: Record<string, JobHandler> = { 'mailbox.reconcile': reconcileJob, [dnsSweep]:retryDatabaseFailures(scheduleDnsPage) };
