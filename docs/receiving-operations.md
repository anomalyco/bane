# Hosted receiving: deployment and recovery

## Why production was empty

`deploy.yml` deploys `api/wrangler.prod.jsonc` to `bane.mx`. Both dedicated Ohio accounts returned `ProductionAccessEnabled=false`, `SendingEnabled=true`, `EnforcementStatus=HEALTHY` from `sesv2 get-account`. Dev permits sending sandbox provisioning; production does not. The old reconciler called `provisionSes` and `checkProvisioned` **before** `preparePoolReceiving`. `SES_SANDBOX` therefore stopped the production run before its first inbound S3 or SNS call. The recent production runtime CloudTrail sample shows repeated successful *sending* configuration-set, feedback topic and subscription reads, not an S3 provisioning or IAM failure. The pre-created active `bane-inbound` **set** is only an IAM bootstrap; it contains no rule on its own. The old health check never inspected it. No production database was queried to make this diagnosis.

Sending and receiving checkpoint independently. The minute cron registers the exact inbound ARN before subscribing, waits for confirmation, attaches redrive, and creates or repairs one enabled, scanning, recipient-unfiltered rule. `/health` is deploy liveness: neither GET nor HEAD checks PostgreSQL or AWS. Monitor `/health/receiving` separately: behind Worker admission, it returns 503 until the account, region, topic, bucket and a reconciliation in the past 25 hours match. It samples at most once per isolate per 30 seconds; a cold concurrent probe can return 503. Ready bindings are rechecked daily. This is control-plane readiness, **not** an SMTP canary. Do not set `BANE_ALLOW_SES_SANDBOX=true` in production to repair receiving.

## One-time operator action — not executed during development

1. **Before the reviewed deployment**, authorize `bane-deploy` to check the active Ohio set and manage the named dead-letter queue and its alarm. From the repository root, under an IAM administrator (not the Worker):

   ```bash
   set -euo pipefail
   export AWS_PROFILE=bane-production AWS_REGION=us-east-2 AWS_PAGER=''
   account=009882681002
   test "$(aws sts get-caller-identity --query Account --output text)" = "$account"
   file=$(mktemp); trap 'rm -f "$file"' EXIT
   sed "s/YOUR_AWS_ACCOUNT_ID/$account/g" infra/aws-shared/receiving-deploy-policy.json >"$file"
   aws iam put-role-policy --role-name bane-deploy --policy-name bane-inbound-dlq-deploy --policy-document "file://$file"
   aws iam get-role-policy --role-name bane-deploy --policy-name bane-inbound-dlq-deploy --query PolicyDocument --output json | jq -e --slurpfile expected "$file" '. == $expected[0]'
   ```

   Expected: `true`. Repeat for dev with `bane-dev`, `905840579680`. The **only** SES action CI needs is `ses:DescribeActiveReceiptRuleSet`, limited to Ohio. A missing or differently named active set stops CI. Only an operator may [bootstrap the reviewed empty set on a fresh account](../infra/aws-shared/README.md); never replace a set serving mail. No Worker grants for SQS or CloudWatch alarm administration.

   Configure `bane:receivingAlarmTopicArn` in each reviewed Pulumi stack config before CI preview/up. Use an existing, monitored same-account Ohio SNS pager topic (not the inbound notification topic). Confirm its subscription and allow `cloudwatch.amazonaws.com` to publish from this account's `arn:aws:cloudwatch:us-east-2:<account>:alarm:bane-inbound-dead-letters`. No pager destination means no infrastructure rollout.

2. **Deploy the approved production ref via the existing workflow** after stage testing and the production unfreeze. CI checks the set, provisions the queue/policy and alarm, migrates PostgreSQL, then deploys the Worker. The signed SNS confirmation and next minute tick complete setup; never insert a fake workspace or force `receiving_state='ready'`. Review over-cap legacy configs (>32 active hooks per workspace, >64 wildcard mailboxes per domain). 095 builds the new indexes online and keeps `jobs_ingest_due` for old Workers. On a lock timeout retry the migration; do not remove the old index during rollout.

   Bound, proven receiving claims get a one-time freshness credit and a verify job. A missing TXT raises `receivingIssue.code=proof_stale` immediately; no observation for 24 hours also warns. Mail for that same host continues until the earlier of 48 hours after the first miss or 72 hours after the last proof. SES freshness warns at 48 hours and expires at 96 hours. Restore TXT/SES verification and use **Check now**; the issue includes the hold deadline. A definitive identity rejection, disconnect, or expired MX loss has no extra grace. Holds remain private to the original owners and expire on the existing schedule.

3. **Verify before enabling traffic**:

   ```bash
   export AWS_PROFILE=bane-production AWS_REGION=us-east-2 AWS_PAGER=''
   account=009882681002; bucket=bane-$account-mail-us-east-2
   topic=arn:aws:sns:us-east-2:$account:bane-inbound
   curl -fsS https://bane.mx/health/receiving | jq -e '.status=="ok" and .receiving=="ready"'
   aws cloudwatch describe-alarms --alarm-names bane-inbound-dead-letters | jq -e '.MetricAlarms | length==1 and (.[0] | .ActionsEnabled and (.AlarmActions|length)==1 and .MetricName=="ApproximateNumberOfMessagesVisible" and .Threshold==0)'
   aws ses describe-active-receipt-rule-set | jq -e --arg b "$bucket" --arg t "$topic" '
     .Metadata.Name=="bane-inbound" and (.Rules|length)==1 and
     (.Rules[0] | .Name=="bane-inbound-all" and .Enabled and .ScanEnabled and (.Recipients|length)==0 and
       (.Actions|length)==1 and .Actions[0].S3Action=={BucketName:$b,ObjectKeyPrefix:"staging/",TopicArn:$t})'
   aws s3api head-bucket --bucket "$bucket" --expected-bucket-owner "$account"
   sub=$(aws sns list-subscriptions-by-topic --topic-arn "$topic" | jq -er --arg t "$topic:" '
     [.Subscriptions[]|select(.Protocol=="https" and .Endpoint=="https://bane.mx/v1/events/ses" and (.SubscriptionArn|startswith($t)))]|select(length==1)|.[0].SubscriptionArn')
   aws sns get-subscription-attributes --subscription-arn "$sub" | jq -e --arg q "arn:aws:sqs:us-east-2:$account:bane-inbound-dead-letters" '
     .Attributes | .PendingConfirmation=="false" and (.RedrivePolicy|fromjson|.deadLetterTargetArn)==$q'
   ```

   Expected: health 200 and successful assertions. If not, keep traffic gated and inspect `shared-receiving-setup` / `shared-pool-setup` logs; do **not** delete or replace the active set. Finally use a separately authorized canary from a controlled sender to a proven test address; confirm one mailbox message and verify its webhook signature. No such email was sent as part of these local checks.

## Redrive one failed notification

The work queue contains wake hints, not envelopes. The SNS HTTPS subscription redrives undeliverable original messages to an encrypted SQS Standard queue scoped to that exact topic and account. Inspect/replay as an authorized operator **before staging expires**; the staging sweeper cannot reconstruct a Bcc envelope. Do not log payloads or publish them to a different topic. Replay causes fresh SNS signing and the same topic/account/bucket, receipt-time, workspace and dedup checks; it does not override quarantine or a failed receipt.

```bash
set -euo pipefail; umask 077
export AWS_PROFILE=bane-production AWS_REGION=us-east-2 AWS_PAGER=''
account=009882681002; test "$(aws sts get-caller-identity --query Account --output text)" = "$account"
topic=arn:aws:sns:us-east-2:$account:bane-inbound; bucket=bane-$account-mail-us-east-2
q=$(aws sqs get-queue-url --queue-name bane-inbound-dead-letters --queue-owner-aws-account-id "$account" --query QueueUrl --output text)
dir=$(mktemp -d); trap 'rm -f "$dir/item" "$dir/message"; rmdir "$dir"' EXIT
aws sqs receive-message --queue-url "$q" --max-number-of-messages 1 --visibility-timeout 300 --wait-time-seconds 5 >"$dir/item"
jq -cer --arg t "$topic" --arg b "$bucket" '.Messages[0].Body | fromjson |
  (if .Type=="Notification" then select(.TopicArn==$t) | .Message | fromjson else . end) |
  select(.notificationType=="Received" and .receipt.action.type=="S3" and .receipt.action.topicArn==$t and .receipt.action.bucketName==$b and
    (.mail.messageId|test("^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$")) and .receipt.action.objectKey==("staging/"+.mail.messageId))' "$dir/item" >"$dir/message"
aws s3api head-object --bucket "$bucket" --expected-bucket-owner "$account" --key "$(jq -r .receipt.action.objectKey "$dir/message")" --query ContentLength
aws sns publish --topic-arn "$topic" --message "file://$dir/message" --query MessageId --output text
# Only AFTER verifying the expected receipt disposition, while the handle is still valid:
aws sqs delete-message --queue-url "$q" --receipt-handle "$(jq -er '.Messages[0].ReceiptHandle' "$dir/item")"
```

No SQS message means no replay. If an object or binding is gone, or a step fails, stop before delete. Do not reconstruct recipients from MIME headers. Workspace raw copies are required for private Bcc/trace stripping and separate access; S3 staging/quarantine/raw retention remains 3/30/90 days. Published attachments do not acquire an age-based expiry; only positively unreferenced uploads get an orphan expiration tag.

## Capacity and alerts

`SES_IDENTITY_QUOTA_EXHAUSTED` is non-retryable. Monitor this error in Worker logs and configure `REPUTATION_ALERT_SLACK_URL` for the daily deduplicated account/region alert. Identity count—not receipt-rule count—limits independent domains. To check or request headroom in the **receiving account and region**, before admitting a batch:

```bash
aws service-quotas get-service-quota --service-code ses --quota-code L-5C01A92C --query 'Quota.[QuotaName,Value,Adjustable]'
aws sesv2 list-email-identities --output json | jq '.EmailIdentities | length'
# Operator only; example desired value, not a guarantee of approval:
aws service-quotas request-service-quota-increase --service-code ses --quota-code L-5C01A92C --desired-value 20000
```

Alert on nonempty `AWS/SQS ApproximateNumberOfMessagesVisible` for `bane-inbound-dead-letters`, `AWS/SNS NumberOfNotificationsFailedToRedriveToDlq`, oldest pending receipt vs staging expiry, failed receipt/job counts, expired proof, and `MAILBOX_SWEEP_COMPLETE.elapsedMs`. `MAILBOX_MESSAGE_INGESTED` reports workspace lag, AWS raw I/O latency and SQL lock wait/hold. A healthy `/health` is not a delivery-latency SLO. Webhook receivers must deduplicate by `Webhook-Id`; a 2xx lost before durable settlement can repeat. Scoped failed deliveries can be redelivered with `POST /v1/inbound/webhooks/{id}/deliveries/{deliveryId}/retry`.
