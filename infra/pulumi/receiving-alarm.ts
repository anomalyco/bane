// A redriven notification has only the staging object's three-day recovery window.
// Use the operator's existing pager, never the receipt topic (which feeds the Worker).
export function receivingAlarm<T>(account:string,queue:T,pager:string) {
  if(!new RegExp(`^arn:aws:sns:us-east-2:${account}:[A-Za-z0-9_-]+$`).test(pager) || pager.endsWith(':bane-inbound'))throw new Error('Expected a dedicated same-account Ohio alarm topic');
  return {name:'bane-inbound-dead-letters',namespace:'AWS/SQS',metricName:'ApproximateNumberOfMessagesVisible',
    dimensions:{QueueName:queue},statistic:'Maximum',period:60,evaluationPeriods:1,
    comparisonOperator:'GreaterThanThreshold',threshold:0,treatMissingData:'notBreaching',alarmActions:[pager]};
}
