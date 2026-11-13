# bane

Self-hosted transactional email, newsletters, campaigns, and inbound conversations with Amazon SES. Use **Receiving** to route mail to addresses, run [rituals](docs/rituals.md) on it, send it to endpoints, and read and reply to threads ([how it fits together](docs/receiving.md)). One installation, OIDC sign-in, and one public API shared by the dashboard, SDK, and MCP server.

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

The hosted service is at [bane.mx](https://bane.mx); its [production Worker configuration](api/wrangler.prod.jsonc) is separate from dev. Its daily limits follow each workspace's sender score: see [how sending limits work](docs/sending-limits.md).

Prefer a manual setup? Start with [Docker](api/README.md#docker-quickstart) or [Cloudflare](api/README.md#cloudflare). For development, see the [local setup](api/README.md#local-development).

## TypeScript SDK

Install [`@banemx/sdk`](https://www.npmjs.com/package/@banemx/sdk) from npm:

```sh
npm install @banemx/sdk
```

See the [SDK guide](sdk/README.md) for usage examples, or [connect an MCP client](mcp/README.md).

## CI and deployments

1. **Pull request:** `CI` builds the dashboard, SDK and MCP, dry-runs both Worker configs, checks types and generated docs, and runs acceptance against disposable PostgreSQL and S3 fixtures. A breaking OpenAPI change fails the build unless maintainers apply **`api-breaking`**. The label waives compatibility only. On a dev push, the waiver applies only when every pushed commit belongs to that merged PR.
2. **Merge to `dev`:** after push CI passes, `Deploy` runs the `dev` stage: it builds that SHA, then rechecks the dev tip under the deployment lock. Superseded commits are skipped before migration. The current commit applies Pulumi first when infrastructure or the workflow changed, then migrates, deploys and runs live tests on `dev.bane.mx`; its summary and JSON report distinguish success, expected rejections, skips and failures.
3. **Production:** push `dev` to `production` (fast-forward only), or dispatch `Deploy` from `production` with the desired branch, tag or SHA. It resolves the ref once and requires the commit to be reachable from `origin/production` and from `dev`, and to have passed the dev live E2E. Require the `build` and `acceptance` checks on protected `dev` and the `production` environment on the `production` branch. The production Worker must pass health checks on both domains; Pulumi runs first for that stage too. Only `thdxr` and `R44VC0RP` may push to `dev`/`production` or dispatch these workflows. Hosted infrastructure is a separate [Pulumi project](infra/pulumi/README.md), with `dev` and `production` stacks.
4. **SDK release:** dispatch `Release SDK` from `dev` with `bump` (`patch`, `minor` or `major`). Its `build` job runs repository code with no environment, secrets or OIDC token and uploads the packed tarball; its `publish` job runs in the `release` environment (where a reviewer approves), never checks out the repository, publishes that tarball through npm trusted publishing (the environment's OIDC token; there is no npm token), then tags the build's commit `v<version>` and creates the GitHub release. The version comes from the newest tag, or from `sdk/package.json` before the first tag, and is never committed back, so `dev` stays restricted and `production` stays fast-forward only. Only `dev` may deploy the `release` environment.

Configure **environment-scoped** variables (not repository-wide). The deploy secrets
live in AWS Secrets Manager (`us-east-1`, account `604439173067`) and are read through
GitHub OIDC by each environment's own role, `arn:aws:iam::604439173067:role/github/bane-dev`
or `arn:aws:iam::604439173067:role/github/bane-production`:

| Environment | AWS Secrets Manager | Variables |
|---|---|---|
| `dev` | `DATABASE_URL`, `BANE_ROOT_SECRET`, `ACCOUNT_CLIENT_PRIVATE_KEY`, `TYPESAFE_API_KEY`, `E2E_API_KEY`; `MAILGW_API_TOKEN` while the gateway is enabled | `E2E_DOMAIN`, `E2E_DOMAIN_ID` |
| `production` | `DATABASE_URL`, `BANE_ROOT_SECRET`, `ACCOUNT_CLIENT_PRIVATE_KEY`, `TYPESAFE_API_KEY`; `MAILGW_API_TOKEN` while the gateway is enabled | `PROD_DEPLOY_ENABLED` |

For a self-hosted installation, register a confidential OIDC client with your issuer and follow the [dashboard sign-in setup](api/README.md#dashboard-sign-in).

`MAILGW_API_TOKEN` is the IMAP/SMTP gateway's shared key and must equal the stage's `mail-gateway/api-token`. The committed `bane:mailGatewayEnabled` in `infra/pulumi/Pulumi.<stage>.yaml` decides how the Worker deploy treats it:

- **True:** the deploy reads the key inside its Worker step and binds it, and stops if the key is missing or invalid.
- **False (the default):** the deploy removes the Worker's binding, so gateway calls get 403 `PROTOCOL_DENIED`.

See the [dev turn-on runbook](gateway/PHASE2.md#dev-turn-on-runbook).

**Both stages use the same key names.** The stage comes from the GitHub environment,
which selects that environment's variables, and from the `bane/<stage>/` folder, which
selects that stage's secrets. Never prefix a key with `DEV_` or `PROD_`; the deploy reads
`bane/${stage}/DATABASE_URL` and `vars.E2E_DOMAIN` for either stage. Only dev
runs a live E2E, so only `bane/dev/` holds an `E2E_API_KEY`. `PROD_DEPLOY_ENABLED` keeps
its name for now because the production freeze check reads it.

The Cloudflare token is not stored anywhere. Each deploy mints a 30-minute token from the
token issuer in `anomalyco/secrets` with the environment's own role, scoped to the stage's
Worker, its custom-domain zones and the Pulumi resources (see the `cloudflare` entry for
`bane/dev` and `bane/production` in that repo's `config.ts`). The issuer restricts each
token to the IP that minted it, so a token only works on the job that asked for it. Live API
keys need read/send/manage on the dedicated **E2E** workspace, not on a customer workspace.

**Production is frozen until the AWS account switch.** The renamed Worker expects `bane-*` pool resources that do not exist in the old production account. Leave `PROD_DEPLOY_ENABLED` unset or `false` until cutover. Only the coordinator should set it to the exact lowercase string `true`, **only** on the `production` GitHub Environment (not the repository or organization). The gate and deploy jobs both check the freeze. No required reviewers are configured; adding a reviewer rule would prompt twice because both jobs use `production`.

**Sign-in policy is committed, not a variable.** Identity is the issuer subject; no address or address domain admits anyone. `api/wrangler.<stage>.jsonc` sets `ACCOUNT_REQUIRED_ACR` (Google) and `AUTH_STAFF_GOOGLE_DOMAINS` (staff sign-up by the Google Workspace domain of the sign-in's provider identity; empty, so off, until the account service's claim name is confirmed). Everyone else joins by invitation or is bound by subject by an operator (`api/scripts/list-signin-attempts.ts`). The old `AUTH_ALLOWED_EMAILS`/`AUTH_ALLOWED_DOMAINS` GitHub variables are no longer read; delete them, and any Worker secret of those names.

**Local live E2E:** install API and SDK dependencies, build the SDK (`cd sdk && bun run build`), and privately export `BANE_E2E_API_KEY`. From `api/` run:

```sh
BANE_E2E_URL=https://dev.bane.mx BANE_E2E_REGION=us-east-2 \
BANE_E2E_DOMAIN=e2e.bane.mx BANE_E2E_DOMAIN_ID=dom_e53755830a0141a5bd6e71e45e942f06 \
BANE_E2E_ALLOW_DESTRUCTIVE=1 bun run e2e
```

This sends real SES simulator and inbound-loop mail and consumes sandbox quota. The destructive opt-in is accepted only on the pinned dev fixture. Omit it for the production-safe subset; never run tests on customer data. Both modes first clean up run-owned fixtures older than 30 minutes from interrupted runs. API keys do not support expiry; normal cleanup and the next run revoke test keys. Inspect `api/e2e-report.json` for operation coverage and request IDs.
