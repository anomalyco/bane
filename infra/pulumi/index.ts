import * as aws from "@pulumi/aws";
import * as cf from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";
import { mailGateway } from "./mail-gateway.js";
import { deadLetterAlarm, receivingAlarm } from './receiving-alarm.js';
import { bucketPolicy, deliveryPolicy, feedbackPolicy, inboundPolicy, lifecycleRules, POOL_STREAMS, poolEventDestination, publicAccessBlock, receiptRule, redrivePolicy } from '../../api/src/mail-controls.js';

const stages = {
  dev: {
    account: "905840579680", origin: "https://dev.bane.mx", prefix: "bane-dev", worker: "bane-dev",
    cloudflareAccountId: "d8e944f537ceef3f06a5bd3aec1d7a53",
    queues: { work: "b2a85efa75214d8291a61eb0bf4c608a", feedback: "002ff3b09e2040d6a1fe09fa13e36387" },
    extraQueues: { webhooks: "a25aa21928d846c4a5531b7e523901a8", "feedback-dlq": "94a4269c23644e93851be3b28bb55b72" } as Record<string, string>,
  },
  production: {
    account: "009882681002", origin: "https://bane.mx", prefix: "bane-prod", worker: "bane-production",
    cloudflareAccountId: "15d29c8639fd3733b1b5486a2acfd968",
    queues: { work: "753a4b880016464c833b836a63663684", feedback: "34426f99502941fbbed927a059517b7c" },
    extraQueues: {} as Record<string, string>,
  },
};

const stack = pulumi.getStack();
if (stack !== "dev" && stack !== "production") throw new Error(`Unsupported Bane stack: ${stack}`);
const stage = stages[stack];
const production = stack === "production";
const config = new pulumi.Config("bane");
// Only an administrator's separately reviewed run publishes mail controls and gateway code.
// ignoreChanges is an operational convenience; the deploy role's explicit IAM denies enforce it.
const operatorPublish = config.getBoolean('operatorPublish') ?? false;
if (operatorPublish && process.env.GITHUB_ACTIONS) throw new Error('operatorPublish is not a CI deployment mode');
const operatorOnly = (options: pulumi.CustomResourceOptions): pulumi.CustomResourceOptions =>
  ({ ...options, ...(operatorPublish ? {} : { ignoreChanges: ['*'] }) });

const roleArn = config.require("deployRoleArn");
if (!roleArn.startsWith(`arn:aws:iam::${stage.account}:role/`)) {
  throw new Error(`bane:deployRoleArn must identify a role in the ${stack} account`);
}
const publishDomainConnectKey = config.getBoolean("publishDomainConnectKey") ?? false;
if (!production && publishDomainConnectKey) throw new Error("Domain Connect publication is production-only");

function adopt(id: string, provider: pulumi.ProviderResource): pulumi.CustomResourceOptions {
  return { import: id, protect: true, provider }; // Dropping one would take its stage down.
}

const cloudflareAccountId = stage.cloudflareAccountId;
const cloudflare = new cf.Provider("cloudflare", {}); // CLOUDFLARE_API_TOKEN
for (const [purpose, queueId] of Object.entries(stage.queues)) {
  new cf.Queue(purpose, { accountId: cloudflareAccountId, queueName: `${stage.prefix}-${purpose}` }, {
    ...adopt(`${cloudflareAccountId}/${queueId}`, cloudflare), ignoreChanges: ["settings"],
  });
}
// Queue settings (including retention) use installation defaults. Both feedback DLQs have
// archive-only Worker consumers; operators replay only from the authenticated quarantine records.
// feedback-v2 is the tagged feedback lane the Worker writes to; the original feedback queue
// stays as the legacy lane until drained (api/wrangler.<stage>.jsonc).
for (const purpose of ['webhooks','feedback-dlq','feedback-v2','feedback-v2-dlq']) {
  const id = stage.extraQueues?.[purpose];
  new cf.Queue(purpose, { accountId: cloudflareAccountId, queueName: `${stage.prefix}-${purpose}` }, {
    ...(id ? adopt(`${cloudflareAccountId}/${id}`, cloudflare) : { provider: cloudflare, protect: true }),
  });
}
const bucket = `${stage.prefix}-attachments`;
// Both buckets already hold attachments; adopt each in its stage's account.
new cf.R2Bucket("attachments", { accountId: cloudflareAccountId, name: bucket, jurisdiction: "default", storageClass: "Standard" }, {
  ...adopt(`${cloudflareAccountId}/${bucket}/default`, cloudflare), ignoreChanges: ["location"],
});

// Hosted received mail (raw MIME and files) once BANE_MAIL_STORE=r2; agent inbox mail always.
// Keys start with their class: d/ default (raw kept 90 days, as in
// S3), a/ attachments (no expiry, as today), e/ agent inboxes (the app erases them; 45 days is
// the backstop past the 30-day lease plus 7 days of grace), k/ kept mail (phase 2, app-managed).
const mailBucket = `${stage.prefix}-mail`;
const mailR2 = new cf.R2Bucket("mail", { accountId: cloudflareAccountId, name: mailBucket, jurisdiction: "default", location: "enam", storageClass: "Standard" }, {
  ...(production ? { provider: cloudflare, protect: true } : adopt(`${cloudflareAccountId}/${mailBucket}/default`, cloudflare)),
  ignoreChanges: ["location"], // Creation-only, like attachments.
});
const day = 86400;
new cf.R2BucketLifecycle("mail-lifecycle", { accountId: cloudflareAccountId, bucketName: mailR2.name, jurisdiction: "default", rules: [
  { id: "default-raw-90d", enabled: true, conditions: { prefix: "d/" }, deleteObjectsTransition: { condition: { type: "Age", maxAge: 90 * day } } },
  { id: "ephemeral-safety-45d", enabled: true, conditions: { prefix: "e/" }, deleteObjectsTransition: { condition: { type: "Age", maxAge: 45 * day } } },
  { id: "abort-multipart-1d", enabled: true, conditions: { prefix: "" }, abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: day } } },
] }, { provider: cloudflare, protect: true });

// The Hyperdrive config is not managed here. Cloudflare never returns origin.password, and
// Pulumi fails to import the resource because the read state lacks that required property.

if (production && publishDomainConnectKey) {
  // Public DER SubjectPublicKeyInfo (not the private signing key), 200 base64 characters per TXT record.
  const key = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnjQewwWQ0jSgWtbotOqgbSSy+TLFr8NVYAdmVG90AC19tEAKJCZmihzrnKppJcUlfXq5VIgeBoKRpTIvj3ibV7Gm3YGcC9NUme8BTbTsQEm12aAyzBVXGFdXLhh60d/9HB0jYTqQkdP/2y50IWTlGRePwXQ9Rz0zlXAKPma6Dpb66XVQkGOOKkFsJti9JcAb8BrcqQKd+bo1ngHbXrM270s/TAdfgwxswMLBYxxzPHW9DEbYuC3HojUfR+Ga1MH75Q+e2zEM6ENusM4EXUvpGSEWeA3KuI4VE4bci5TwQVzJK8PACjyIgKhzuM65nPgdzMrBSC7JqABEf7ViuId97wIDAQAB";
  for (const [i, chunk] of key.match(/.{1,200}/g)!.entries()) {
    new cf.DnsRecord(`domain-connect-key-${i + 1}`, {
      zoneId: "f2942e4d7fab2ce3d86a876f7564a429", name: "_dck1.domainconnect.bane.mx",
      type: "TXT", ttl: 3600, content: `"p=${i + 1},a=RS256,d=${chunk}"`,
    }, { provider: cloudflare });
  }
}

const credentials = { allowedAccountIds: [stage.account], ...(operatorPublish ? {} : { assumeRoles: [{ roleArn }] }) };
const iam = new aws.Provider("virginia", { ...credentials, region: "us-east-1" });
const ohio = new aws.Provider("ohio-receiving", { ...credentials, region: "us-east-2" });
const deadLetters = new aws.sqs.Queue("receiving-dead-letters", { name: "bane-inbound-dead-letters", sqsManagedSseEnabled: true,
  // The original staging object is recoverable for three days. No extension of mail retention.
  messageRetentionSeconds: 3 * 86400 }, operatorOnly({ provider: ohio, protect: true }));
new aws.cloudwatch.MetricAlarm('receiving-dead-letter-alarm', receivingAlarm(stage.account,deadLetters.name,config.require('receivingAlarmTopicArn')), {provider:ohio,protect:true});
const queuePolicy = new aws.sqs.QueuePolicy("receiving-dead-letter-policy", {queueUrl:deadLetters.url,policy:deadLetters.arn.apply(arn=>JSON.stringify({Version:"2012-10-17",Statement:[{
  Effect:"Allow",Principal:{Service:"sns.amazonaws.com"},Action:"sqs:SendMessage",Resource:arn,Condition:{ArnEquals:{"aws:SourceArn":`arn:aws:sns:us-east-2:${stage.account}:bane-inbound`},StringEquals:{"aws:SourceAccount":stage.account}}
}]}))},operatorOnly({provider:ohio}));

// The inventory is gathered once, from the exact account, before taking over from
// the old Worker. Never infer absence from a failed AWS read, or replace a live route.
const imports = config.requireObject<string[]>('mailControlImports');
const account = stage.account, region = 'us-east-2', bucketName = `bane-${account}-mail-${region}`;
const inboundArn = `arn:aws:sns:${region}:${account}:bane-inbound`;
const opts = (id:string,provider:pulumi.ProviderResource) => imports.includes(id)?adopt(id,provider):{provider,protect:true};
const tags = (purpose:string) => ({'bane:installation-id':'bane:pool','bane:purpose':purpose});
export const mailGatewayEndpoint = mailGateway(stack, stage, config, ohio, iam, cloudflare, tags("mail-gateway"), operatorOnly);
const mail = new aws.s3.Bucket('pool-mail',{bucket:bucketName,tags:tags('mailbox-inbound')},opts(bucketName,ohio));
const protectedOhio = operatorOnly({provider:ohio,protect:true});
const block = new aws.s3.BucketPublicAccessBlock('pool-mail-private',{bucket:mail.id,blockPublicAcls:publicAccessBlock.BlockPublicAcls,
  ignorePublicAcls:publicAccessBlock.IgnorePublicAcls,blockPublicPolicy:publicAccessBlock.BlockPublicPolicy,restrictPublicBuckets:publicAccessBlock.RestrictPublicBuckets},protectedOhio);
const access = new aws.s3.BucketPolicy('pool-mail-policy',{bucket:mail.id,policy:JSON.stringify(bucketPolicy(bucketName,region,account,'bane-inbound-'))},{...protectedOhio,dependsOn:[block]});
const lifecycle = new aws.s3.BucketLifecycleConfiguration('pool-mail-retention',{bucket:mail.id,rules:lifecycleRules(true).map(r=>({
  id:r.ID,status:r.Status,filter:'Tag' in r.Filter?{tag:{key:r.Filter.Tag.Key,value:r.Filter.Tag.Value}}:{prefix:r.Filter.Prefix},
  expiration:'Expiration' in r?{days:r.Expiration.Days}:undefined,abortIncompleteMultipartUpload:'AbortIncompleteMultipartUpload' in r?{daysAfterInitiation:r.AbortIncompleteMultipartUpload.DaysAfterInitiation}:undefined,
}))},protectedOhio);
const inbound = new aws.sns.Topic('pool-inbound',{name:'bane-inbound',tags:tags('mailbox-inbound'),policy:JSON.stringify(inboundPolicy(inboundArn,region,account,'bane-inbound-')),
  deliveryPolicy:JSON.stringify(deliveryPolicy)},operatorOnly(opts(inboundArn,ohio)));
const subArn = imports.find(id=>id.startsWith(inboundArn+':'));
if (subArn && !/^[0-9a-f-]{36}$/i.test(subArn.slice(inboundArn.length+1))) throw new Error('Import only the confirmed Bane inbound HTTPS subscription ARN');
const sub = new aws.sns.TopicSubscription('pool-inbound-https',{topic:inbound.arn,protocol:'https',endpoint:stage.origin+'/v1/events/ses',rawMessageDelivery:false,
  endpointAutoConfirms:false,redrivePolicy:JSON.stringify(redrivePolicy(region,account))},{...operatorOnly(subArn?adopt(subArn,ohio):protectedOhio),dependsOn:[queuePolicy]});
const rule=receiptRule('bane-inbound-all',[],{bucket:bucketName,topicArn:inboundArn}), action=rule.Actions[0].S3Action;
const route = new aws.ses.ReceiptRule('pool-inbound-all',{ruleSetName:'bane-inbound',name:rule.Name,enabled:rule.Enabled,scanEnabled:rule.ScanEnabled,tlsPolicy:rule.TlsPolicy,
  recipients:rule.Recipients,s3Actions:[{position:1,bucketName:action.BucketName,objectKeyPrefix:action.ObjectKeyPrefix,topicArn:inbound.arn}]},
  {...operatorOnly(opts('bane-inbound:bane-inbound-all',ohio)),dependsOn:[access,lifecycle,sub]});
const trustedPublish=config.requireBoolean('trustedFeedbackPublish');
// Mythos 5.1 N-M3: SES bounce and complaint feedback reaches the Worker over HTTPS. SNS retries it
// with backoff for up to an hour, then dead-letters it to a queue only that topic may write, and the
// operator is paged on the first message. Alarm actions must be in the queue's region.
const pagers = [config.require('receivingAlarmTopicArn'), config.require('virginiaAlarmTopicArn')];
const feedback = [false,true].map((trusted,i)=>{
  const r=trusted?'us-east-1':region, prefix=trusted?'bane-trusted':'bane', name=prefix+'-feedback', arn=`arn:aws:sns:${r}:${account}:${name}`;
  const sets=['transactional','marketing'].map(stream=>`arn:aws:ses:${r}:${account}:configuration-set/${prefix}-${stream}`);
  const provider=trusted?iam:ohio, options=operatorOnly({provider,protect:true});
  const topic=new aws.sns.Topic(`pool-${name}`,{name,tags:{...tags('ses-feedback'),...(trusted?{'bane:owner':'bane'}:{})},
    deliveryPolicy:JSON.stringify(deliveryPolicy),policy:JSON.stringify(feedbackPolicy(account,{topic:arn,sets},!trusted||trustedPublish))},operatorOnly(opts(arn,provider)));
  const dlq=new aws.sqs.Queue(`${name}-dead-letters`,{name:`${name}-dead-letters`,sqsManagedSseEnabled:true,messageRetentionSeconds:14*86400},options);
  new aws.cloudwatch.MetricAlarm(`${name}-dead-letter-alarm`,deadLetterAlarm(account,r,`${name}-dead-letters`,dlq.name,pagers[i]!),{provider,protect:true});
  const policy=new aws.sqs.QueuePolicy(`${name}-dead-letter-policy`,{queueUrl:dlq.url,policy:dlq.arn.apply(queue=>JSON.stringify({Version:'2012-10-17',Statement:[{
    Effect:'Allow',Principal:{Service:'sns.amazonaws.com'},Action:'sqs:SendMessage',Resource:queue,Condition:{ArnEquals:{'aws:SourceArn':arn},StringEquals:{'aws:SourceAccount':account}}
  }]}))},operatorOnly({provider}));
  const subscription=imports.find(id=>id.startsWith(arn+':'));
  if (subscription && !/^[0-9a-f-]{36}$/i.test(subscription.slice(arn.length+1))) throw new Error(`Import only the confirmed Bane ${name} HTTPS subscription ARN`);
  // Virginia's subscription is created and journaled by the Worker during trusted enrollment;
  // Pulumi only adopts it afterwards. Ohio's is created here if the inventory found none.
  if (subscription || !trusted) new aws.sns.TopicSubscription(`pool-${name}-https`,{topic:topic.arn,protocol:'https',endpoint:stage.origin+'/v1/events/ses',rawMessageDelivery:false,
    endpointAutoConfirms:false,redrivePolicy:dlq.arn.apply(deadLetterTargetArn=>JSON.stringify({deadLetterTargetArn}))},{...operatorOnly(subscription?adopt(subscription,provider):options),dependsOn:[policy]});
  return topic;
});
// N7: the runtime key can no longer write event destinations or suppression options on the pool
// sets. An operator creates the four sets once (tenant suppression, docs/receiving-operations.md);
// Pulumi owns their destinations, Virginia's only after its signed confirmation. The Worker verifies.
const destinations = [false,true].flatMap((trusted,i)=>trusted && !trustedPublish ? [] : POOL_STREAMS.map(stream=>{
  const prefix=trusted?'bane-trusted':'bane', set=`${prefix}-${stream}`, topic=feedback[i]!, d=poolEventDestination(prefix,'');
  return new aws.sesv2.ConfigurationSetEventDestination(`pool-${set}-events`,{configurationSetName:set,eventDestinationName:d.Name,
    eventDestination:{enabled:d.Enabled,matchingEventTypes:d.MatchingEventTypes,snsDestination:{topicArn:topic.arn}}},
    {...operatorOnly(opts(`${set}|${d.Name}`,trusted?iam:ohio)),dependsOn:[topic]});
}));
// Operator-owned runtime user, policy versions, keys and Worker binding. CI may
// attach only these approved policies; lookups fail closed when bootstrap is missing.
const runtime = "bane-runtime";
const user = aws.iam.getUserOutput({ userName: runtime }, { provider: iam });
for (const name of [runtime, "bane-runtime-ohio", "bane-runtime-trusted"]) {
  const arn = `arn:aws:iam::${stage.account}:policy/${name}`;
  const existing = aws.iam.getPolicyOutput({ arn }, { provider: iam });
  new aws.iam.UserPolicyAttachment(name, { user: user.userName, policyArn: existing.arn }, adopt(`${runtime}/${arn}`, iam));
}
