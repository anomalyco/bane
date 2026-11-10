// A redriven notification has only its own recovery window (staging: three days; SES feedback:
// the DLQ's 14 days). Use the operator's existing pager in the queue's region, never a Bane topic
// (those feed the Worker). CloudWatch alarm actions must be in the alarm's region.
export function deadLetterAlarm<T>(account:string,region:'us-east-1'|'us-east-2',name:string,queue:T,pager:string) {
  if(!new RegExp(`^arn:aws:sns:${region}:${account}:[A-Za-z0-9_-]+$`).test(pager) || /:bane-(inbound|feedback|trusted-feedback)$/.test(pager))throw new Error(`Expected a dedicated same-account ${region} alarm topic`);
  return {name,namespace:'AWS/SQS',metricName:'ApproximateNumberOfMessagesVisible',
    dimensions:{QueueName:queue},statistic:'Maximum',period:60,evaluationPeriods:1,
    comparisonOperator:'GreaterThanThreshold',threshold:0,treatMissingData:'notBreaching',alarmActions:[pager]};
}
export function receivingAlarm<T>(account:string,queue:T,pager:string) {
  return deadLetterAlarm(account,'us-east-2','bane-inbound-dead-letters',queue,pager);
}
