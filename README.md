# bane

Self-hosted transactional email, newsletters, campaigns, and inbound conversations with Amazon SES. Use **Inbound** to manage receiving addresses, read threads, and reply. One installation, Google-only sign-in, and one public API shared by the dashboard, SDK, and MCP server.

![Bane dashboard showing sending activity, delivery metrics, and recent campaigns](docs/images/dashboard.png)

<p>
  <a href="docs/images/campaign-composer.png"><img src="docs/images/campaign-composer.png" alt="Campaign composer with visual email editing and audience selection" width="49%" /></a>
  <a href="docs/images/email-logs.png"><img src="docs/images/email-logs.png" alt="Email logs with delivery statuses, recipients, and filtering" width="49%" /></a>
</p>

## Start here

1. Clone the repo:

   ```sh
   git clone https://github.com/anomalyco/bane.git
   cd bane
   ```

2. Open the repo in your coding agent and paste:

   ```text
   Help me set up Bane for my use case. Explore this repo and read
   api/README.md first. Ask what I want to send, whether I prefer Docker
   or Cloudflare, and what infrastructure I already have. Recommend the
   simplest setup and explain the plan before making changes. Use my own
   accounts and resources, keep secrets out of git, and start with simulated
   sending. Ask before provisioning, deploying, or sending real email.
   ```

The hosted service is at [bane.mx](https://bane.mx); its [production Worker configuration](api/wrangler.prod.jsonc) is separate from dev.

Prefer a manual setup? Start with [Docker](api/README.md#docker-quickstart) or [Cloudflare](api/README.md#cloudflare). For development, see the [local setup](api/README.md#local-development).

## TypeScript SDK

Install [`banemx`](https://www.npmjs.com/package/banemx) from npm:

```sh
npm install banemx
```

See the [SDK guide](sdk/README.md) for usage examples, or [connect an MCP client](mcp/README.md).

## CI and deployments

1. **Pull request:** `CI` builds the dashboard, SDK and MCP, dry-runs both Worker configs, checks types and generated docs, and runs acceptance against disposable PostgreSQL and S3 fixtures. A breaking OpenAPI change fails the build unless maintainers apply **`api-breaking`**. The label waives compatibility only. On a dev push, the waiver applies only when every pushed commit belongs to that merged PR.
2. **Merge to `dev`:** after push CI passes, `Deploy dev` builds that SHA, then rechecks the dev tip under the deployment lock. Superseded commits are skipped before migration. The current commit migrates, deploys and runs live tests on `dev.bane.mx`; its summary and JSON report distinguish success, expected rejections, skips and failures. `Publish SDK` runs after a successful production deploy.
3. **Production:** push `dev` to `production` (fast-forward only), or dispatch `Deploy production` from `production` with the desired branch, tag or SHA. It resolves the ref once and requires the commit to be reachable from `dev` and to have passed the dev live E2E. Require the `build` and `acceptance` checks on protected `dev` and the `production` environment on the `production` branch. The production Worker must pass health checks on both domains and the non-destructive live suite. Hosted infrastructure is a separate [Pulumi project](infra/pulumi/README.md), with `dev` and `production` stacks.

Configure **environment-scoped** variables (not repository-wide). The deploy secrets
live in AWS Secrets Manager (`us-east-1`, account `604439173067`) and are read through
GitHub OIDC by each environment's own role, `arn:aws:iam::604439173067:role/github/bane-dev`
or `arn:aws:iam::604439173067:role/github/bane-production`:

| Environment | AWS Secrets Manager | Variables |
|---|---|---|
| `dev` | `bane/dev/CLOUDFLARE_API_TOKEN`, `bane/dev/DEV_DATABASE_URL`, `bane/dev/DEV_E2E_API_KEY` | `DEV_E2E_DOMAIN`, `DEV_E2E_DOMAIN_ID`, `DEV_AUTH_ALLOWED_DOMAINS`, `DEV_AUTH_ALLOWED_EMAILS` |
| `production` | `bane/production/CLOUDFLARE_API_TOKEN`, `bane/production/PROD_DATABASE_URL`, `bane/production/PROD_E2E_API_KEY` | `PROD_DEPLOY_ENABLED`, `PROD_E2E_DOMAIN`, `PROD_E2E_DOMAIN_ID`, `PROD_AUTH_ALLOWED_DOMAINS`, `PROD_AUTH_ALLOWED_EMAILS` |

Scope deployment tokens to their respective Workers/resources. Live API keys need read/send/manage on the dedicated **E2E** workspace, not on a customer workspace.

**Production is frozen until the AWS account switch.** The renamed Worker expects `bane-*` pool resources that do not exist in the old production account. Leave `PROD_DEPLOY_ENABLED` unset or `false` until cutover. Only the coordinator should set it to the exact lowercase string `true`, **only** on the `production` GitHub Environment (not the repository or organization). The gate and deploy jobs both check the freeze. No required reviewers are configured; adding a reviewer rule would prompt twice because both jobs use `production`.

**Before the first deployment:** preserve the existing sign-in allowlists. For each non-confidential list, set the environment variable above; the deploy passes it explicitly to Wrangler. GitHub may show plain variables in step logs. For a private list, set `AUTH_ALLOWED_EMAILS` or `AUTH_ALLOWED_DOMAINS` as a **Worker secret** out of band instead, and leave its GitHub variable empty. An empty variable sends no override: it preserves a Worker secret but does **not** preserve a dashboard-only plaintext binding. With neither configured the list is empty.

**Local live E2E:** install API and SDK dependencies, build the SDK (`npm run build --prefix sdk`), and privately export `BANE_E2E_API_KEY`. From `api/` run:

```sh
BANE_E2E_URL=https://dev.bane.mx BANE_E2E_REGION=us-east-2 \
BANE_E2E_DOMAIN=e2e.bane.mx BANE_E2E_DOMAIN_ID=dom_e53755830a0141a5bd6e71e45e942f06 \
BANE_E2E_ALLOW_DESTRUCTIVE=1 npm run e2e
```

This sends real SES simulator and inbound-loop mail and consumes sandbox quota. The destructive opt-in is accepted only on the pinned dev fixture. Omit it for the production-safe subset; never run tests on customer data. Both modes first clean up run-owned fixtures older than 30 minutes from interrupted runs. API keys do not support expiry; normal cleanup and the next run revoke test keys. Inspect `api/e2e-report.json` for operation coverage and request IDs.
