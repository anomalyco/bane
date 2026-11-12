# Hosted receiving: deployment and recovery

## Rolling back

Stop new campaign releases and receiving-host changes first. Run these read-only checks on the stage being rolled back. Both counts must be zero before reverting to a Worker that only understands root/`reply.` hosts and fully materialized campaign snapshots:

```sql
SELECT count(*) AS unsupported_receiving_hosts FROM domain_claims
 WHERE receiving_host IS NOT NULL AND receiving_host NOT IN (name, 'reply.' || name);
SELECT count(*) AS deferred_campaign_snapshots FROM sending_emails
 WHERE snapshot @> '{"deferredCampaign":true}'::jsonb;
```

If either count is nonzero, roll forward. Do not clear a binding, rewrite a stub, reset an attempt, or revert the database to make the check pass. Keep the Pulumi-managed controls in place. Rerun the subscription inventory for **both feedback topics** before adopting their HTTPS retry/DLQ configuration; monitor the two regional feedback dead-letter queues separately from the Cloudflare feedback DLQ.

## Receiving capacity holds

The default per-workspace allowance is 5,000 new receipts and 2 GiB per hour, with 5,000 active ingest jobs. A workspace-bound receipt over the hourly message limit is `held` with `MAILBOX_RECEIVE_BUDGET`; the hourly release reserves a slot before queuing it. A receipt over the backlog, or one gaining recipients while its ingest job runs, is `held` with `MAILBOX_RECEIVE_BACKLOG`; the end of an ingest job admits these in order, and the release catches any it skips. A pending receipt fails only for its running ingest claim (`settled_by`) or by lost-receipt recovery; during a deploy's overlap the previous Worker's failure writes are dropped and recovery settles those receipts within the hour. A message that individually fits the byte budget waits for the next window when previous messages used the remaining bytes. Monitor `mail_receipts WHERE status='held'` by workspace and age, and raise `mail_receive_limits` for sustained traffic **before the three-day staging lifetime expires**. Releases do not extend S3 retention or transfer mail to today's domain owner.

## Why production was empty

`deploy.yml` deploys `api/wrangler.prod.jsonc` to `bane.mx`. Both dedicated Ohio accounts returned `ProductionAccessEnabled=false`, `SendingEnabled=true`, `EnforcementStatus=HEALTHY` from `sesv2 get-account`. Dev permits sending sandbox provisioning; production does not. The old reconciler called `provisionSes` and `checkProvisioned` **before** `preparePoolReceiving`. `SES_SANDBOX` therefore stopped the production run before its first inbound S3 or SNS call. The recent production runtime CloudTrail sample shows repeated successful *sending* configuration-set, feedback topic and subscription reads, not an S3 provisioning or IAM failure. The pre-created active `bane-inbound` **set** is only an IAM bootstrap; it contains no rule on its own. The old health check never inspected it. No production database was queried to make this diagnosis.

Sending and receiving checkpoint independently. Pulumi provisions the mail controls. The minute cron registers the verified inbound ARN, waits for signed confirmation and checks the bucket controls, topic policies, HTTPS redrive and sole catch-all without rewriting them. `/health` is deploy liveness; `/health/receiving` returns 503 without a matching binding verified in the last 25 hours. Ready bindings are rechecked daily. This is control-plane readiness, **not** an SMTP canary. Do not enable the production SES sandbox override to repair receiving.

## One-time operator action — not executed during development

1. **Before deploying**, authorize the Pulumi role. Run from the repository root using the two IAM-administrator profiles, **not** the Worker. The IAM role name is `bane-deploy` in both accounts. Keep the existing inline policy name so this replaces the old DLQ-only grant:

   ```bash
   set -euo pipefail
   export AWS_REGION=us-east-2 AWS_PAGER=''
   file=$(mktemp); trap 'rm -f "$file"' EXIT
   for stage in dev production; do
     case "$stage" in dev) account=905840579680; origin=https://dev.bane.mx;; production) account=009882681002; origin=https://bane.mx;; esac
     profile=bane-$stage
     test "$(aws --profile "$profile" sts get-caller-identity --query Account --output text)" = "$account"
     sed -e "s/YOUR_AWS_ACCOUNT_ID/$account/g" -e "s|YOUR_STAGE_ORIGIN|$origin|g" infra/aws-shared/receiving-deploy-policy.json >"$file"
     aws --profile "$profile" iam put-role-policy --role-name bane-deploy --policy-name bane-inbound-dlq-deploy --policy-document "file://$file"
     aws --profile "$profile" iam get-role-policy --role-name bane-deploy --policy-name bane-inbound-dlq-deploy --query PolicyDocument --output json | jq -e --slurpfile expected "$file" '. == $expected[0]'
   done
   ```

   Expected: `true` twice. Verify the existing runtime **permissions boundary** permits the new bucket reads (`s3:GetBucketPolicy`, `s3:GetBucketPublicAccessBlock`, `s3:GetLifecycleConfiguration`) and the read-only topic/subscription calls. If the boundary blocks them, amend that boundary on the same resource/region, not the runtime write grants. Only an operator may [bootstrap the reviewed empty Ohio set on a fresh account](../infra/aws-shared/README.md); never replace a set serving mail.

2. **Inventory before the first Pulumi update.** Run the following per stage, pointing Pulumi at that stage's normal backend. `PAGER_ARN` must be an existing, monitored same-account Ohio topic (not inbound) allowing CloudWatch to publish from the named DLQ alarm. Set `TRUSTED_PUBLISH=false` for a new/private Virginia topic. For an existing published topic, set it to `true` **only** after checking the trusted pool row has the expected account/feedback ARN and `confirmed_generation=generation`; do not close a live feedback route or accept SNS subscription status alone as signed evidence.

   ```bash
   # Set STAGE (dev or production), PAGER_ARN and TRUSTED_PUBLISH as reviewed above.
   set -euo pipefail
   : "${STAGE:?}" "${PAGER_ARN:?}" "${TRUSTED_PUBLISH:?}"
   case "$TRUSTED_PUBLISH" in true|false) ;; *) exit 1;; esac
   imports=$(bash infra/aws-shared/mail-control-imports.sh "$STAGE")
   (cd infra/pulumi && pulumi config set --stack "$STAGE" bane:mailControlImports "$imports" &&
     pulumi config set --stack "$STAGE" bane:trustedFeedbackPublish "$TRUSTED_PUBLISH" &&
     pulumi config set --stack "$STAGE" bane:receivingAlarmTopicArn "$PAGER_ARN")
   ```

   Include both reviewed stack settings files in the release. Review the preview: import existing bucket, topics, confirmed inbound subscription and `bane-inbound:bane-inbound-all`; create only genuinely absent resources. Bucket policy/block/lifecycle are put-style resources. No replacements, deletes or set activation. On an import mismatch, stop and inspect the live resource; never delete it to make the import pass. Use a separately approved state-only `pulumi import` with the stack's **regional provider** for a proven owned but drifted resource, then review the in-place correction. Avoid concurrent changes by the old Worker during adoption.

3. **Roll out dev first**, then production via the existing workflow. Pulumi prepares the controls before narrowing the runtime IAM policies; the old Worker may log AccessDenied on setup until the new Worker runs. Existing mail routes remain in place. Do not restore the old grants on rollback. On a fresh inbound subscription, let the cron register the topic; if the initial confirmation arrived too early, use SNS **Request confirmation** on the exact pending HTTPS subscription. Never forge a confirmation or force `receiving_state='ready'`.

   Fresh Virginia enrollment is two-phase: after signed confirmation (`confirmed_generation=generation` for the exact trusted pool binding), change `bane:trustedFeedbackPublish` to `true` and deploy. Retry the trusted provisioning job if it already failed. `POOL_RECEIVING_DRIFT` / `POOL_SENDING_DRIFT` require an operator to review the named resource, refresh Pulumi state and apply the reviewed correction, not a Worker retry to repair it. When changing shared documents in `api/src/mail-controls.ts`, include the infrastructure in the deploy (manual workflow dispatch if necessary).

   Bound, proven receiving claims get a one-time freshness credit and a verify job. A missing TXT raises `receivingIssue.code=proof_stale` immediately; no observation for 24 hours also warns. Mail for that same host continues until the earlier of 48 hours after the first miss or 72 hours after the last proof. SES freshness warns at 48 hours and expires at 96 hours. Restore TXT/SES verification and use **Check now**; the issue includes the hold deadline. A definitive identity rejection, disconnect, or expired MX loss has no extra grace. Holds remain private to the original owners and expire on the existing schedule.

4. **Verify before enabling traffic**:

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

## Rollout of the m52 recheck IAM changes (N1, N7, feedback dead letters)

Order matters: the old Worker writes attachment keys the old policy refuses, and the new Worker refuses to send until Pulumi owns the event destinations. Do these per stage, dev first, before the Worker deploy. Nothing here was run against AWS during development.

1. **Deploy role.** Rerun step 1 above unchanged: it re-applies `receiving-deploy-policy.json`, which now also grants the two feedback dead-letter queues and alarms, the Ohio feedback subscription and redrive, and the four pool event destinations.
2. **Runtime boundary (N1).** The `bane-runtime-boundary` policy is not in this repository. Confirm it allows `s3:GetObject`, `s3:PutObject` and `s3:PutObjectTagging` on `arn:aws:s3:::bane-<account>-mail-us-east-2/workspaces/*/att/*`, or on the exact key shapes in `infra/aws-shared/runtime-ohio-policy.json`:

   ```bash
   aws iam get-policy-version --policy-arn "arn:aws:iam::$account:policy/bane-runtime-boundary" \
     --version-id "$(aws iam get-policy --policy-arn "arn:aws:iam::$account:policy/bane-runtime-boundary" --query Policy.DefaultVersionId --output text)" --query PolicyVersion.Document
   aws iam simulate-principal-policy --policy-source-arn "arn:aws:iam::$account:user/bane-runtime" --action-names s3:PutObject s3:GetObject \
     --resource-arns "arn:aws:s3:::bane-$account-mail-us-east-2/workspaces/ws_$(printf 'a%.0s' {1..32})/att/msg_$(printf 'b%.0s' {1..32})/$(printf 'c%.0s' {1..64})/matt_$(printf 'd%.0s' {1..32})" \
     --context-entries ContextKeyName=aws:RequestedRegion,ContextKeyValues=us-east-2,ContextKeyType=string ContextKeyName=s3:ResourceAccount,ContextKeyValues=$account,ContextKeyType=string --query 'EvaluationResults[].EvalDecision'
   ```

   Run the simulation after the Pulumi update in step 5; expected `["allowed","allowed"]`. Before it, the same call shows the denial the old policy causes.
3. **Pool configuration sets (N7).** Confirm the four sets carry the values the Worker now requires, because it can no longer correct them:

   ```bash
   for spec in us-east-2:bane us-east-1:bane-trusted; do for stream in transactional marketing; do
     aws sesv2 get-configuration-set --region "${spec%%:*}" --configuration-set-name "${spec#*:}-$stream" --query '[SendingOptions,SuppressionOptions,Tags]'
   done; done
   ```

   Expected: sending enabled, `SuppressionScope` `TENANT`, reasons `BOUNCE` and `COMPLAINT`, Auto Validation disabled on transactional and `MANAGED` on marketing, and the installation and purpose tags. Correct a drifted set with the operator's own credentials, for example `aws sesv2 put-configuration-set-suppression-options --region us-east-2 --configuration-set-name bane-marketing --suppression-scope TENANT --suppressed-reasons BOUNCE COMPLAINT --validation-options '{"ConditionThreshold":{"ConditionThresholdEnabled":"ENABLED","OverallConfidenceThreshold":{"ConfidenceVerdictThreshold":"MANAGED"}}}'`. A missing Virginia set is created with the [bootstrap commands](../infra/aws-shared/README.md#pool-configuration-sets-operator-once-per-account).
4. **Inventory and stack settings.** Rerun step 2 above. The inventory now also adopts the feedback HTTPS subscriptions and the existing `bane-events` / `bane-trusted-events` destinations. Set the Virginia pager, an existing monitored us-east-1 topic in the same account (CloudWatch alarm actions must be in the alarm's region):

   ```bash
   (cd infra/pulumi && pulumi config set --stack "$STAGE" bane:virginiaAlarmTopicArn "$VIRGINIA_PAGER_ARN")
   ```
5. **Pulumi, then the Worker.** Preview, expect imports for the existing destinations and feedback subscriptions, creates for the two feedback queues, queue policies and alarms, and in-place updates for the topic delivery policies and the three runtime policies. Then run the normal deploy. If the Worker logs `POOL_SENDING_DRIFT … event destinations`, Pulumi has not applied the destinations; do not restore the old runtime grants.
6. **BYO v5 customers (N1).** Received attachments need the updated `api/byo-template.yaml` stack before the new Worker serves their receiving. BYO receiving is not enabled in production.

Before the first rotation, [upgrade with the current key](../infra/pulumi/README.md#runtime-credentials) so the Worker reads the bundled secret and Pulumi registers the drain hook. Rotate every 90 days, or at once on suspicion: confirm `bane-deploy` may call `iam:DeleteAccessKey` on `user/bane-runtime`, then `pulumi config set --stack "$STAGE" bane:runtimeKeyRotation "$(date +%Y-%m-%d)"` and deploy. One Worker-secret update publishes the new pair; the previous key stays valid for a five-minute drain before deletion.

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

Alert on CloudTrail management events from `arn:aws:iam::<account>:user/bane-runtime` for `PutBucketPolicy`, `CreateReceiptRule`, `UpdateReceiptRule`, `SetTopicAttributes`, `SetSubscriptionAttributes`, `CreateConfigurationSetEventDestination`, `UpdateConfigurationSetEventDestination`, `DeleteConfigurationSetEventDestination` and `PutConfigurationSetSuppressionOptions` in both hosted accounts, including denied attempts. After rollout these are never normal. A successful write calls for inspection/restoration of the affected control, not just key rotation.

`SES_IDENTITY_QUOTA_EXHAUSTED` is non-retryable. Monitor this error in Worker logs and configure `REPUTATION_ALERT_SLACK_URL` for the daily deduplicated account/region alert. Identity count—not receipt-rule count—limits independent domains. To check or request headroom in the **receiving account and region**, before admitting a batch:

```bash
aws service-quotas get-service-quota --service-code ses --quota-code L-5C01A92C --query 'Quota.[QuotaName,Value,Adjustable]'
aws sesv2 list-email-identities --output json | jq '.EmailIdentities | length'
# Operator only; example desired value, not a guarantee of approval:
aws service-quotas request-service-quota-increase --service-code ses --quota-code L-5C01A92C --desired-value 20000
```

Alert on nonempty `AWS/SQS ApproximateNumberOfMessagesVisible` for `bane-inbound-dead-letters`, `AWS/SNS NumberOfNotificationsFailedToRedriveToDlq`, oldest pending receipt vs staging expiry, failed receipt/job counts, expired proof, and `MAILBOX_SWEEP_COMPLETE.elapsedMs`. `MAILBOX_MESSAGE_INGESTED` reports workspace lag, AWS raw I/O latency and SQL lock wait/hold. A healthy `/health` is not a delivery-latency SLO. Webhook receivers must deduplicate by `Webhook-Id`; a 2xx lost before durable settlement can repeat. Scoped failed deliveries can be redelivered with `POST /v1/inbound/webhooks/{id}/deliveries/{deliveryId}/retry`.

## Mail-store rollout and rollback

Inboxes phase 1 moves new hosted received mail (raw MIME and extracted files) from the SES pool bucket to the R2 bucket `bane-<stage>-mail`, and turns on agent inboxes. SES staging (3 days) and quarantine (30 days) stay in S3. BYO and self-hosted mail stays in its S3 bucket. One Worker variable, `BANE_MAIL_STORE`, switches both; the `MAIL` binding must stay bound once any `r2:` row exists.

| Stage | `MAIL` binding | `BANE_MAIL_STORE` | Effect |
|---|---|---|---|
| dev | `bane-dev-mail` | `r2` | Shared-pool mail and inbox mail in R2; inboxes on |
| production, at deploy | `bane-prod-mail` | `s3` | No change: mail stays in S3, `POST /v1/inboxes` answers `503 INBOXES_UNAVAILABLE` |
| production, after the flip | `bane-prod-mail` | `r2` | As dev |

### Dev

1. Before merging, preview the `dev` stack (`pulumi preview --stack dev` from `infra/pulumi` with the deploy role, or a `Deploy` dispatch with `preview: true`) and check the plan is exactly two creates in the Cloudflare account: `cf:R2Bucket mail` (`bane-dev-mail`, ENAM, protected) and `cf:R2BucketLifecycle mail-lifecycle` (`default-raw-90d` on `d/`, `ephemeral-safety-45d` on `e/`, `abort-multipart-1d`), with no replacements or deletes. The minted Cloudflare token must be allowed to create R2 buckets and write their lifecycle (Workers R2 Storage: Edit); if it isn't, create `bane-dev-mail` once by hand in ENAM and adopt it with an `import` option like the attachments bucket.
2. Verify Hyperdrive query caching is disabled. Merge to `dev`. The deploy applies Pulumi first (`infra/pulumi` changed), then migrations 104–107, then the Worker with the `MAIL` binding. A Worker deploy that binds a missing bucket fails, so Pulumi must succeed first.
3. Verify on `dev.bane.mx`:
   - The receiving canary passes. Its `mail_messages` row has `raw_bucket = 'r2:bane-dev-mail'` and `raw_key = 'd/<workspace>/<message>.eml'`; the only new S3 object is under `staging/`.
   - An inbox on the dev receiving host (`POST /v1/inboxes`) receives a real message, `waitForMessage` returns it within 5 seconds of the SES receipt, and its attachment downloads through `/v1/objects/…`.
   - After `DELETE /v1/inboxes/{id}` and the next hourly sweep, its rows are gone and `npx wrangler r2 object get bane-dev-mail/e/<workspace>/<inbox>/<message>.eml --remote` answers not found.
   - OpenCode connected to `https://dev.bane.mx/mcp` with an inbox key runs create → wait → read → delete.

### Production (after Ryan approves)

4. Push `dev` to `production` as usual. Pulumi creates `bane-prod-mail` and its lifecycle first (same plan as step 1), the migrations run, and the Worker deploys with `BANE_MAIL_STORE=s3`: nothing changes for mail yet.
5. The flip: change `BANE_MAIL_STORE` to `"r2"` in `api/wrangler.prod.jsonc`, merge it through `dev` and push to `production`. New shared-pool mail goes to R2 and agent inboxes turn on.
6. Run the production receiving canary and check its row says `r2:bane-prod-mail`. Add Cloudflare R2 as a storage location for hosted mail to the privacy notice.

### Rollback

Set `BANE_MAIL_STORE` back to `"s3"` and deploy. **Keep the `MAIL` binding and the bucket:** `r2:` rows and outstanding download links read through it. New default mail goes back to S3, new inboxes are refused with `503`, and existing inboxes keep working: their mail and erasure stay in R2 while `MAIL` is bound. Legacy S3 rows stay readable throughout.

**Do not roll back to pre-inbox Worker code after activation.** It cannot read R2 rows, enforce inbox holds, assign cursors or drain erasure. Prefer flag rollback or a forward fix. If a binary rollback is unavoidable, stop new creates and pause receipt processing, end all inboxes, drain GC and object jobs (including failures), and verify there are no inbox rows, GC candidates or outstanding erasures. Additionally, all remaining `r2:` content must stay readable: backport the dual reader or migrate and verify it before considering an S3-only binary. Reconcile pending receipts/jobs before resuming. Do not revert migrations or delete the bucket.

### IAM and erasure

- **Hosted shared pool: no change.** Inbox mail always goes to R2, and R2 deletes go through the binding, so the runtime needs no `s3:DeleteObject`. Default-class raw MIME in R2 expires after 90 days by the `d/` rule, as in S3; extracted attachments do not expire, as today.
- **BYO connections:** inbox mail stays in the customer’s bucket, and the BYO template (v4) grants no delete. Erasing such an inbox removes its rows; its objects stay (raw MIME expires at 90 days through the bucket rule) and the `mail.deleteObjects` job fails with `MAIL_DELETE_DENIED`, keeping its keys. A future template version can grant `s3:DeleteObject` on `workspaces/*/raw/*` and `workspaces/*/att/*`.
- **Self-hosted:** the operator’s S3 credentials need `s3:DeleteObject` on the same two prefixes.
- Watch `SELECT workspace_id,last_error,count(*) FROM jobs WHERE type='mail.deleteObjects' AND status='failed' GROUP BY 1,2` and `RETENTION_PARTIAL` logs. Don’t advertise completed erasure while deletes are failing.

Deletion closes inbox reads and releases real addresses immediately. Previously issued signed links can remain usable for up to five minutes. Receipt and outbound logs (including quoted replies) retain their usual 30 days; shared/default mail, independent copies and backups retain their own policies. Orphan `e/` objects can survive until the 45-day backstop. `INBOX_RETENTION_PARTIAL` and `INBOX_RETENTION_FAILED` identify incomplete phases; an error does not stop other hourly jobs.

## Inbox phase 2 rollout

- Migrate before enabling the new Worker. `140_inbox_writer_fence` must run **before** 141 files the first membership or 142 backfills existing mail. During overlap, old Workers can read and ingest, but a legacy read-state or thread-state write to a managed inbox fails atomically; retry on the new Worker. Leave the guard installed on application rollback. A database already running the unfenced pre-merge prototype needs offline reconciliation, not a replay of backfill 142.
- Install the updated Ohio runtime policy before using hosted S3 fallback. Ordinary raw keeps the `raw` expiry tag; `kept` writes and orphan tagging are authorized separately for `workspaces/<workspace>/raw/kept/msg_<32 hex>.eml`.
- BYO: the customer updates their receiving stack with receiving enabled and `WorkspaceId` set to their Bane workspace. Verify the installed stack reports `KeptReceivingPolicy=kept-v1:<workspace>`, its role matches the ready connection, and its receiving bucket and region match `mailbox_regions`. Only then record that exact `(connection_id, role_arn, region, bucket)` in `mail_kept_policy_v1` using the migration/operator role. No customer API accepts this attestation. Legacy or mismatched bindings return `409 BYO_KEPT_POLICY_REQUIRED` on persistent inbox creation; ephemeral inboxes need no upgrade. Remove the attestation before rolling back the role policy, and drain or migrate persistent deliveries first.
