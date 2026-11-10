import * as aws from "@pulumi/aws";
import * as cf from "@pulumi/cloudflare";
import * as cfV5 from "@pulumi/cloudflare-v5";
import * as pulumi from "@pulumi/pulumi";
import { render } from "../aws-shared/runtime-policies.mjs";
import { deadLetterAlarm, receivingAlarm } from './receiving-alarm.js';
import { bucketPolicy, deliveryPolicy, feedbackPolicy, inboundPolicy, lifecycleRules, POOL_STREAMS, poolEventDestination, publicAccessBlock, receiptRule, redrivePolicy } from '../../api/src/mail-controls.js';

const stages = {
  dev: {
    account: "905840579680", origin: "https://dev.bane.mx", prefix: "bane-dev", worker: "bane-dev",
    queues: { work: "9c0d42c6410842c38d9304094dccccc4", feedback: "e655c22094e14e198abb3a254e235c7d" },
  },
  production: {
    account: "009882681002", origin: "https://bane.mx", prefix: "bane-prod", worker: "bane-production",
    queues: { work: "753a4b880016464c833b836a63663684", feedback: "34426f99502941fbbed927a059517b7c" },
  },
};

const stack = pulumi.getStack();
if (stack !== "dev" && stack !== "production") throw new Error(`Unsupported Bane stack: ${stack}`);
const stage = stages[stack];
const production = stack === "production";
const config = new pulumi.Config("bane");

const roleArn = config.require("deployRoleArn");
if (!roleArn.startsWith(`arn:aws:iam::${stage.account}:role/`)) {
  throw new Error(`bane:deployRoleArn must identify a role in the ${stack} account`);
}
const permissionsBoundary = config.get("permissionsBoundary");
const writeWorkerSecrets = config.getBoolean("writeWorkerSecrets") ?? !production;
const publishDomainConnectKey = config.getBoolean("publishDomainConnectKey") ?? false;
if (!production && publishDomainConnectKey) throw new Error("Domain Connect publication is production-only");

function adopt(id: string, provider: pulumi.ProviderResource): pulumi.CustomResourceOptions {
  return { import: id, protect: true, provider }; // Dropping one would take its stage down.
}

const cloudflareAccountId = "15d29c8639fd3733b1b5486a2acfd968";
const cloudflare = new cf.Provider("cloudflare", {}); // CLOUDFLARE_API_TOKEN
for (const [purpose, queueId] of Object.entries(stage.queues)) {
  new cf.Queue(purpose, { accountId: cloudflareAccountId, queueName: `${stage.prefix}-${purpose}` }, {
    ...adopt(`${cloudflareAccountId}/${queueId}`, cloudflare), ignoreChanges: ["settings"],
  });
}
// Queue settings (including retention) use installation defaults. Never auto-drain the
// feedback DLQ: an operator replays only after the ingestion fault has been repaired.
for (const purpose of ['webhooks','feedback-dlq']) {
  new cf.Queue(purpose, { accountId: cloudflareAccountId, queueName: `${stage.prefix}-${purpose}` }, { provider: cloudflare, protect: true });
}
const bucket = `${stage.prefix}-attachments`;
new cf.R2Bucket("attachments", { accountId: cloudflareAccountId, name: bucket, jurisdiction: "default", storageClass: "Standard" }, {
  ...adopt(`${cloudflareAccountId}/${bucket}/default`, cloudflare), ignoreChanges: ["location"], // ENAM; creation-only.
});

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

const credentials = { allowedAccountIds: [stage.account], assumeRoles: [{ roleArn }] };
const iam = new aws.Provider("virginia", { ...credentials, region: "us-east-1" });
const ohio = new aws.Provider("ohio-receiving", { ...credentials, region: "us-east-2" });
const deadLetters = new aws.sqs.Queue("receiving-dead-letters", { name: "bane-inbound-dead-letters", sqsManagedSseEnabled: true,
  // The original staging object is recoverable for three days. No extension of mail retention.
  messageRetentionSeconds: 3 * 86400 }, { provider: ohio, protect: true });
new aws.cloudwatch.MetricAlarm('receiving-dead-letter-alarm', receivingAlarm(stage.account,deadLetters.name,config.require('receivingAlarmTopicArn')), {provider:ohio,protect:true});
const queuePolicy = new aws.sqs.QueuePolicy("receiving-dead-letter-policy", {queueUrl:deadLetters.url,policy:deadLetters.arn.apply(arn=>JSON.stringify({Version:"2012-10-17",Statement:[{
  Effect:"Allow",Principal:{Service:"sns.amazonaws.com"},Action:"sqs:SendMessage",Resource:arn,Condition:{ArnEquals:{"aws:SourceArn":`arn:aws:sns:us-east-2:${stage.account}:bane-inbound`},StringEquals:{"aws:SourceAccount":stage.account}}
}]}))},{provider:ohio});

// The inventory is gathered once, from the exact account, before taking over from
// the old Worker. Never infer absence from a failed AWS read, or replace a live route.
const imports = config.requireObject<string[]>('mailControlImports');
const account = stage.account, region = 'us-east-2', bucketName = `bane-${account}-mail-${region}`;
const inboundArn = `arn:aws:sns:${region}:${account}:bane-inbound`;
const opts = (id:string,provider:pulumi.ProviderResource) => imports.includes(id)?adopt(id,provider):{provider,protect:true};
const tags = (purpose:string) => ({'bane:installation-id':'bane:pool','bane:purpose':purpose});
const mail = new aws.s3.Bucket('pool-mail',{bucket:bucketName,tags:tags('mailbox-inbound')},opts(bucketName,ohio));
const protectedOhio = {provider:ohio,protect:true};
const block = new aws.s3.BucketPublicAccessBlock('pool-mail-private',{bucket:mail.id,blockPublicAcls:publicAccessBlock.BlockPublicAcls,
  ignorePublicAcls:publicAccessBlock.IgnorePublicAcls,blockPublicPolicy:publicAccessBlock.BlockPublicPolicy,restrictPublicBuckets:publicAccessBlock.RestrictPublicBuckets},protectedOhio);
const access = new aws.s3.BucketPolicy('pool-mail-policy',{bucket:mail.id,policy:JSON.stringify(bucketPolicy(bucketName,region,account,'bane-inbound-'))},{...protectedOhio,dependsOn:[block]});
const lifecycle = new aws.s3.BucketLifecycleConfiguration('pool-mail-retention',{bucket:mail.id,rules:lifecycleRules(true).map(r=>({
  id:r.ID,status:r.Status,filter:'Tag' in r.Filter?{tag:{key:r.Filter.Tag.Key,value:r.Filter.Tag.Value}}:{prefix:r.Filter.Prefix},
  expiration:'Expiration' in r?{days:r.Expiration.Days}:undefined,abortIncompleteMultipartUpload:'AbortIncompleteMultipartUpload' in r?{daysAfterInitiation:r.AbortIncompleteMultipartUpload.DaysAfterInitiation}:undefined,
}))},protectedOhio);
const inbound = new aws.sns.Topic('pool-inbound',{name:'bane-inbound',tags:tags('mailbox-inbound'),policy:JSON.stringify(inboundPolicy(inboundArn,region,account,'bane-inbound-')),
  deliveryPolicy:JSON.stringify(deliveryPolicy)},opts(inboundArn,ohio));
const subArn = imports.find(id=>id.startsWith(inboundArn+':'));
if (subArn && !/^[0-9a-f-]{36}$/i.test(subArn.slice(inboundArn.length+1))) throw new Error('Import only the confirmed Bane inbound HTTPS subscription ARN');
const sub = new aws.sns.TopicSubscription('pool-inbound-https',{topic:inbound.arn,protocol:'https',endpoint:stage.origin+'/v1/events/ses',rawMessageDelivery:false,
  endpointAutoConfirms:false,redrivePolicy:JSON.stringify(redrivePolicy(region,account))},{...(subArn?adopt(subArn,ohio):protectedOhio),dependsOn:[queuePolicy]});
const rule=receiptRule('bane-inbound-all',[],{bucket:bucketName,topicArn:inboundArn}), action=rule.Actions[0].S3Action;
const route = new aws.ses.ReceiptRule('pool-inbound-all',{ruleSetName:'bane-inbound',name:rule.Name,enabled:rule.Enabled,scanEnabled:rule.ScanEnabled,tlsPolicy:rule.TlsPolicy,
  recipients:rule.Recipients,s3Actions:[{position:1,bucketName:action.BucketName,objectKeyPrefix:action.ObjectKeyPrefix,topicArn:inbound.arn}]},
  {...opts('bane-inbound:bane-inbound-all',ohio),dependsOn:[access,lifecycle,sub]});
const trustedPublish=config.requireBoolean('trustedFeedbackPublish');
// Mythos 5.1 N-M3: SES bounce and complaint feedback reaches the Worker over HTTPS. SNS retries it
// with backoff for up to an hour, then dead-letters it to a queue only that topic may write, and the
// operator is paged on the first message. Alarm actions must be in the queue's region.
const pagers = [config.require('receivingAlarmTopicArn'), config.require('virginiaAlarmTopicArn')];
const feedback = [false,true].map((trusted,i)=>{
  const r=trusted?'us-east-1':region, prefix=trusted?'bane-trusted':'bane', name=prefix+'-feedback', arn=`arn:aws:sns:${r}:${account}:${name}`;
  const sets=['transactional','marketing'].map(stream=>`arn:aws:ses:${r}:${account}:configuration-set/${prefix}-${stream}`);
  const provider=trusted?iam:ohio, options={provider,protect:true};
  const topic=new aws.sns.Topic(`pool-${name}`,{name,tags:{...tags('ses-feedback'),...(trusted?{'bane:owner':'bane'}:{})},
    deliveryPolicy:JSON.stringify(deliveryPolicy),policy:JSON.stringify(feedbackPolicy(account,{topic:arn,sets},!trusted||trustedPublish))},opts(arn,provider));
  const dlq=new aws.sqs.Queue(`${name}-dead-letters`,{name:`${name}-dead-letters`,sqsManagedSseEnabled:true,messageRetentionSeconds:14*86400},options);
  new aws.cloudwatch.MetricAlarm(`${name}-dead-letter-alarm`,deadLetterAlarm(account,r,`${name}-dead-letters`,dlq.name,pagers[i]!),options);
  const policy=new aws.sqs.QueuePolicy(`${name}-dead-letter-policy`,{queueUrl:dlq.url,policy:dlq.arn.apply(queue=>JSON.stringify({Version:'2012-10-17',Statement:[{
    Effect:'Allow',Principal:{Service:'sns.amazonaws.com'},Action:'sqs:SendMessage',Resource:queue,Condition:{ArnEquals:{'aws:SourceArn':arn},StringEquals:{'aws:SourceAccount':account}}
  }]}))},{provider});
  const subscription=imports.find(id=>id.startsWith(arn+':'));
  if (subscription && !/^[0-9a-f-]{36}$/i.test(subscription.slice(arn.length+1))) throw new Error(`Import only the confirmed Bane ${name} HTTPS subscription ARN`);
  // Virginia's subscription is created and journaled by the Worker during trusted enrollment;
  // Pulumi only adopts it afterwards. Ohio's is created here if the inventory found none.
  if (subscription || !trusted) new aws.sns.TopicSubscription(`pool-${name}-https`,{topic:topic.arn,protocol:'https',endpoint:stage.origin+'/v1/events/ses',rawMessageDelivery:false,
    endpointAutoConfirms:false,redrivePolicy:dlq.arn.apply(deadLetterTargetArn=>JSON.stringify({deadLetterTargetArn}))},{...(subscription?adopt(subscription,provider):options),dependsOn:[policy]});
  return topic;
});
// N7: the runtime key can no longer write event destinations or suppression options on the pool
// sets. An operator creates the four sets once (tenant suppression, docs/receiving-operations.md);
// Pulumi owns their destinations, Virginia's only after its signed confirmation. The Worker verifies.
const destinations = [false,true].flatMap((trusted,i)=>trusted && !trustedPublish ? [] : POOL_STREAMS.map(stream=>{
  const prefix=trusted?'bane-trusted':'bane', set=`${prefix}-${stream}`, topic=feedback[i]!, d=poolEventDestination(prefix,'');
  return new aws.sesv2.ConfigurationSetEventDestination(`pool-${set}-events`,{configurationSetName:set,eventDestinationName:d.Name,
    eventDestination:{enabled:d.Enabled,matchingEventTypes:d.MatchingEventTypes,snsDestination:{topicArn:topic.arn}}},
    {...opts(`${set}|${d.Name}`,trusted?iam:ohio),dependsOn:[topic]});
}));
const runtime = "bane-runtime";
const user = new aws.iam.User(runtime, {
  name: runtime, path: "/", tags: { "bane:purpose": "hosted-runtime" }, permissionsBoundary,
}, adopt(runtime, iam));

const policies = render("--fresh", { account: stage.account, origin: stage.origin });
const attachments = Object.entries(policies).map(([name, document]) => {
  const arn = `arn:aws:iam::${stage.account}:policy/${name}`;
  const policy = new aws.iam.Policy(name, { name, path: "/", policy: JSON.stringify(document) }, {...adopt(arn, iam),dependsOn:[route,...feedback,...destinations]});
  return new aws.iam.UserPolicyAttachment(name, { user: user.name, policyArn: policy.arn }, adopt(`${runtime}/${arn}`, iam));
});

// The operator owns the active set; the Worker still manages identities, sets and tenants.

// Never import an IAM access key: AWS returns its secret only on creation.
// Keep the previous key active while old Worker versions and in-flight sends drain.
const rotation = config.get("runtimeKeyRotation");
if (rotation !== undefined && (!/^[a-z0-9-]{1,32}$/.test(rotation) || !writeWorkerSecrets)) {
  throw new Error("bane:runtimeKeyRotation needs 1-32 lowercase letters, digits or hyphens, and bane:writeWorkerSecrets");
}
const drainKey = new pulumi.ResourceHook('drain-runtime-key', async () => {
  await new Promise<void>(resolve => setTimeout(resolve, 5 * 60_000));
});
const key = new aws.iam.AccessKey(rotation ? `runtime-key-${rotation}` : "runtime-key", { user: user.name }, {
  provider: iam, dependsOn: attachments, hooks: { beforeDelete: [drainKey] },
});
if (writeWorkerSecrets) {
  // One PUT publishes one version containing the complete pair. Pulumi must
  // finish this dependent update before retiring its previous key dependency.
  const provider = new cfV5.Provider("worker-secrets", {});
  const target = { accountId: cloudflareAccountId, scriptName: stage.worker };
  new cfV5.WorkersSecret("worker-runtime-credentials", {
    ...target, name: "AWS_RUNTIME_CREDENTIALS", secretText: pulumi.secret(pulumi.jsonStringify({ accessKeyId: key.id, secretAccessKey: key.secret })),
  }, { provider, retainOnDelete: true });
}
