// Pure AWS documents, shared by Pulumi (writer) and the hosted Worker (verifier).
// Keep this in the API source tree so the self-hosted Docker build also includes it.
export const STAGING_PREFIX = 'staging/';
export const publicAccessBlock = { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true };
export const deliveryPolicy = {http:{defaultHealthyRetryPolicy:{minDelayTarget:20,maxDelayTarget:120,numRetries:30,numNoDelayRetries:0,numMinDelayRetries:2,numMaxDelayRetries:24,backoffFunction:'exponential'},disableSubscriptionOverrides:true}};
export const redrivePolicy = (region:string,account:string) => ({deadLetterTargetArn:`arn:aws:sqs:${region}:${account}:bane-inbound-dead-letters`});

export function lifecycleRules(pool:boolean) {
  const expire = (ID:string, Filter:{Prefix:string}|{Tag:{Key:string;Value:string}}, Days:number) => ({ ID, Status:'Enabled' as const, Filter, Expiration:{Days} });
  const kind = (Value:string) => ({Tag:{Key:'bane-kind',Value}});
  return [expire('bane-staging',{Prefix:STAGING_PREFIX},3), expire('bane-unattributed',{Prefix:'quarantine/'},30),
    expire('bane-unreferenced-upload',kind('orphan'),1), expire('bane-raw-retention',kind('raw'),90), expire('bane-legacy-raw',{Prefix:'raw/'},90),
    ...(!pool ? [expire('bane-legacy-downloads',kind('legacy-raw'),1)] : []),
    {ID:'bane-abort-uploads',Status:'Enabled' as const,Filter:{Prefix:''},AbortIncompleteMultipartUpload:{DaysAfterInitiation:1}}];
}

const ruleSourceArn = (region:string,account:string,rulePrefix:string) => `arn:aws:ses:${region}:${account}:receipt-rule-set/*:receipt-rule/${rulePrefix}*`;
export function bucketPolicy(bucket:string,region:string,account:string,rulePrefix:string) {
  return { Version:'2012-10-17', Statement:[
    { Sid:'BaneSesInbound',Effect:'Allow',Principal:{Service:'ses.amazonaws.com'},Action:'s3:PutObject',Resource:`arn:aws:s3:::${bucket}/${STAGING_PREFIX}*`,Condition:{StringEquals:{'AWS:SourceAccount':account},ArnLike:{'AWS:SourceArn':ruleSourceArn(region,account,rulePrefix)}} },
    { Sid:'BaneTlsOnly',Effect:'Deny',Principal:'*',Action:'s3:*',Resource:[`arn:aws:s3:::${bucket}`,`arn:aws:s3:::${bucket}/*`],Condition:{Bool:{'aws:SecureTransport':'false'}} },
  ] };
}
const owner = (Resource:string,account:string) => ({ Sid:'BaneOwner',Effect:'Allow',Principal:{AWS:`arn:aws:iam::${account}:root`},Action:['sns:GetTopicAttributes','sns:SetTopicAttributes','sns:AddPermission','sns:RemovePermission','sns:DeleteTopic','sns:Subscribe','sns:ListSubscriptionsByTopic','sns:Publish'],Resource });
export function inboundPolicy(arn:string,region:string,account:string,rulePrefix:string) {
  return { Version:'2012-10-17',Statement:[owner(arn,account),
    { Sid:'BaneSesInbound',Effect:'Allow',Principal:{Service:'ses.amazonaws.com'},Action:'sns:Publish',Resource:arn,Condition:{StringEquals:{'AWS:SourceAccount':account},ArnLike:{'AWS:SourceArn':ruleSourceArn(region,account,rulePrefix)}} },
  ] };
}
export function feedbackPolicy(account:string,arn:{topic:string;sets:string[]},publish=true) {
  return { Version:'2012-10-17',Statement:[owner(arn.topic,account),...(publish ? [
    { Sid:'BaneSesPublish',Effect:'Allow',Principal:{Service:'ses.amazonaws.com'},Action:'sns:Publish',Resource:arn.topic,Condition:{StringEquals:{'AWS:SourceAccount':account,'AWS:SourceArn':arn.sets}} },
  ] : [])] };
}
export function receiptRule(name:string,recipients:string[],{bucket,topicArn}:{bucket:string;topicArn:string}) {
  return { Name:name, Enabled:true, TlsPolicy:'Optional' as const, ScanEnabled:true, Recipients:[...recipients].sort(), Actions:[{S3Action:{BucketName:bucket,ObjectKeyPrefix:STAGING_PREFIX,TopicArn:topicArn}}] };
}
