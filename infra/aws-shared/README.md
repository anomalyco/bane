# Bane hosted AWS accounts

Production (`009882681002`, `https://bane.mx`) and dev (`905840579680`, `https://dev.bane.mx`) have separate dedicated accounts. No policy or key is shared between them.

The [hosted Pulumi stacks](../pulumi/README.md) own the runtime key and policies, the Ohio mail bucket and receipt rule, and the regional notification topic policies. Before deploying these resources, [authorize the deploy role and inventory existing resources](../../docs/receiving-operations.md). Do not rerun the key bootstrap in these accounts. The renderer below is the policy source for both stacks and the acceptance suite.

## Manual bootstrap reference (non-Pulumi installations)

1. Create `bane-runtime`, an IAM user with no console access or groups.
2. Render all three customer-managed policies for this account and its canonical origin. From this directory, for example:

   ```sh
   for name in bane-runtime bane-runtime-ohio bane-runtime-trusted; do
     node runtime-policies.mjs --fresh "$name" 009882681002 https://bane.mx > "$name.json"
   done
   ```

   Review the [IAM boundaries](iam-review.md) and the rendered documents before attaching them to `bane-runtime` only. Use the dev account and origin together when rendering for dev.
3. Create an access key for **Application running outside AWS**. Store both values securely and configure `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` as secrets on that environment's Worker. No session token. This is not an R2 or administrator key.
4. Prepare sending independently in Ohio and Virginia; receiving is **Ohio only**. There is no per-domain receipt-rule setup on the shared account. Shared sends, including inline images and attachments, use tenant-conditioned SESv2 `SendEmail`. There is no classic raw-send or SMTP grant. [SES v2 authorization](https://docs.aws.amazon.com/service-authorization/latest/reference/list_sesv2.html) · [classic SES authorization](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ses.html)

Keep `bane-runtime` server-side: it can still send as pool tenants and read pooled mailbox objects. It verifies, but cannot rewrite, the bucket controls, receipt rules, topic policies, subscription attributes, pool configuration sets, their suppression or their event destinations. `bane-deploy` provisions those controls; the operator creates the four pool configuration sets once (below). Only an operator can create or activate a receipt rule **set**; classic SES does not support name-scoped receipt-rule permissions. Strict pauses individual tenants, but AWS still evaluates the account's overall reputation. [SES tenants](https://docs.aws.amazon.com/ses/latest/dg/tenants.html)

In the intended dedicated account, confirm there is no existing active set serving mail. Using the operator principal, not `bane-runtime`, create and activate the Ohio set:

```sh
aws ses create-receipt-rule-set --rule-set-name bane-inbound --region us-east-2
aws ses set-active-receipt-rule-set --rule-set-name bane-inbound --region us-east-2
```

### Pool configuration sets (operator, once per account)

The runtime key can only read the pool sets, and Pulumi owns their event destinations, which need the sets to exist. On a fresh account, before the first Pulumi run, the operator creates them with tenant suppression and the default Auto Validation (`api/src/mail-controls.ts` `poolSuppression`). Skip any set that already exists; never recreate one.

```sh
tx='{"SuppressedReasons":["BOUNCE","COMPLAINT"],"SuppressionScope":"TENANT","ValidationOptions":{"ConditionThreshold":{"ConditionThresholdEnabled":"DISABLED"}}}'
mk='{"SuppressedReasons":["BOUNCE","COMPLAINT"],"SuppressionScope":"TENANT","ValidationOptions":{"ConditionThreshold":{"ConditionThresholdEnabled":"ENABLED","OverallConfidenceThreshold":{"ConfidenceVerdictThreshold":"MANAGED"}}}}'
for spec in us-east-2:bane us-east-1:bane-trusted; do
  region=${spec%%:*}; prefix=${spec#*:}; tags=(Key=bane:installation-id,Value=bane:pool Key=bane:purpose,Value=ses-feedback)
  [[ $prefix == bane-trusted ]] && tags+=(Key=bane:owner,Value=bane)
  aws sesv2 create-configuration-set --region "$region" --configuration-set-name "$prefix-transactional" --sending-options SendingEnabled=true --suppression-options "$tx" --tags "${tags[@]}"
  aws sesv2 create-configuration-set --region "$region" --configuration-set-name "$prefix-marketing" --sending-options SendingEnabled=true --suppression-options "$mk" --tags "${tags[@]}"
done
```

## Publish the shared receiving DNS once

`SHARED_INBOUND_DOMAIN` defaults to `in.bane.mx`. After scheduled pool preparation, run this read-only query to get the exact wildcard MX and three DNS-only Easy DKIM CNAMEs for the production identity. Publish the returned names and values, not tokens from another region or a test account. No customer DNS is needed for workspace-slug addresses.

```sql
SELECT r.type, r.name, r.priority, r.value
FROM provider_pool_regions p, jsonb_to_recordset(p.inbound_dns) r(type text,name text,priority int,value text)
WHERE p.region='us-east-2';
```

For the default Ohio pool the MX is `*.in.bane.mx.  MX  10  inbound-smtp.us-east-2.amazonaws.com.`. SES supplies the CNAME tokens **and signing zone**; they cannot be determined before the identity exists. A custom sending domain's optional `purpose: inbound` MX is separate from MAIL FROM and does not gate sending.

## In-product work before live traffic

- [ ] Never point Hosted receiving at Virginia. Production approval, quotas, reputation and suppression are account-regional. The Hosted user cannot submit [regional production-access requests](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html).
- [ ] Create one namespace- and owner-tagged tenant per workspace **per region**, using `bane-probation-ws_*` in Ohio or `bane-trusted-ws_*` in Virginia. Verify exclusive ownership; do not adopt identities by discovery. SES stored templates are BYO-only.
- [ ] Resolve the tenant and associated configuration set from the authenticated workspace for every simple/raw send, campaign and reply. Refuse unready/paused tenants; verify wrong or missing tenant requests fail. Do not route on caller-supplied names or tags.
- [ ] Set tenant suppression to `TENANT` for `BOUNCE` and `COMPLAINT`. Assign **Strict** before enabling sends. The runtime configures tenant suppression; it cannot list or change individual suppressed destinations. [Suppression precedence](https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list-tenant-level-configure.html)
- [ ] Attribute signed feedback and authenticated envelope recipients to the correct workspace. Implement per-tenant auto-pause from feedback, explicit operator-controlled reinstatement, and in-product alerts on tenant and regional account reputation. Admission/pacing must respect each regional account quota. Prove these paths with two workspaces before enabling customer traffic.

## Optional one-time hardening

Root MFA: register a passkey or hardware MFA device on the AWS root user; do not create root access keys.  
GuardDuty: review coverage and cost, then enable it in the pool regions if desired.
