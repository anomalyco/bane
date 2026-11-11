# Hosted Bane infrastructure

One project, two stacks: `dev` (AWS `905840579680`, Cloudflare `d8e944f537ceef3f06a5bd3aec1d7a53`, Worker `bane-dev`) and `production` (AWS `009882681002`, Cloudflare `15d29c8639fd3733b1b5486a2acfd968`, Worker `bane-production`). Pulumi 3.274.1 runs the TypeScript directly with `runtime: bun`; use Bun 1.3.14 and `bun install --frozen-lockfile`. Type-check with `bun run tsc --noEmit`.

## What each stack owns

The deploy role owns the Ohio mail bucket, public access block, bucket policy and lifecycle, the inbound and feedback topics, inbound HTTPS subscription/redrive, catch-all receipt rule, DLQ and alarm. It also manages the Virginia trusted feedback topic and its two-phase publish policy. [Receiving operations](../../docs/receiving-operations.md) covers required `bane:mailControlImports`, `bane:trustedFeedbackPublish` and `bane:receivingAlarmTopicArn` settings and the one-time role policy.

It also **creates** the R2 bucket for hosted received mail, `bane-<stage>-mail` (ENAM, protected), and its lifecycle rules: `d/` raw mail expires after 90 days, `e/` agent-inbox objects after 45 days as a backstop to the app’s erasure, and incomplete multipart uploads after a day. The Worker binds it as `MAIL`; see [mail-store rollout](../../docs/receiving-operations.md#mail-store-rollout-and-rollback).

In addition to existing mail resources identified by the adoption inventory, each stack adopts these existing resources through the `import` options in [index.ts](index.ts), all with `protect: true`. Dev's queues are new in anomaly-dev and are adopted by their new ids; dev's attachments bucket is created rather than adopted:

| Owner | Resources | Import ID |
|---|---|---|
| Cloudflare (see the stage's `cloudflareAccountId`) | work and feedback queues; attachments bucket (ENAM; production only) | `<account>/<queue-id>`, `<account>/<bucket>/default` |
| IAM (us-east-1 provider) | `bane-runtime` user; the `bane-runtime`, `bane-runtime-ohio` and `bane-runtime-trusted` policies and their three attachments | `bane-runtime`, policy ARN, `bane-runtime/<policy-arn>` |

**Not managed: the Hyperdrive config.** Cloudflare never returns `origin.password`, and Pulumi rejects importing it because the read state lacks that required property (`Missing required property 'origin.password'`). The live config stays as created, with caching off and 15 dev / 30 production connections; `api/wrangler.<environment>.jsonc` binds it by ID. Adopt it here once the provider can import write-only required fields.

### Runtime credentials

Each stack **creates one access key**; AWS cannot return the old key's secret. `bane:writeWorkerSecrets` defaults to **true in dev, false in production**, and `Pulumi.production.yaml` turns it on explicitly for `bane-production`. A single v5 `WorkersSecret` PUT publishes the complete key pair as `AWS_RUNTIME_CREDENTIALS`. Turning the flag off leaves the binding in place.

**Upgrade before rotating:** first deploy with `runtimeKeyRotation` unchanged. This publishes the existing pair, installs the old-key drain hook, and rolls out Worker code that prefers the bundle. The two previous bindings are retained for the upgrade; don't roll back to split-binding-only code after the first rotation. On subsequent rotations Pulumi creates the new key, updates the bundle, then waits five minutes before deleting the previous key. Keep an IAM key slot free and don't overlap rotations or Worker deploys.

`bane:publishDomainConnectKey` defaults to **false**. Only production may enable it, to **create** two public TXT records at `_dck1.domainconnect.bane.mx`. Verify the [public key in index.ts](index.ts) matches the signing key and the records are still absent first.

**Never manage here:** the Worker code, routes, custom domains (including `100::` AAAAs), other bindings/secrets, queue consumers, or any other DNS (including SES DKIM and `_bane`). The operator activates the receipt rule set, the Worker manages identities, tenants and SES configuration sets; Pulumi owns the catch-all rule inside the reviewed active set. The stack does not own state storage, deploy roles, KMS keys or the old manual IAM key.

## CI

`.github/workflows/deploy.yml` runs the Pulumi stack first in each stage's deploy, after `dev` CI passes or on a `production` push, when `infra/pulumi/**`, `infra/aws-shared/**` or the workflow changed; manual dispatches always run it, with `init` and `preview` inputs (`preview` leaves the Worker untouched). State lives in R2 (`bane-<stage>-pulumi`) and is encrypted with `alias/pulumi/bane-<stage>`; AWS comes from GitHub OIDC through `github/bane-<stage>` and the stack's `bane:deployRoleArn`. `CLOUDFLARE_API_TOKEN` is minted per run and passed through the environment only. The deploy role needs `iam:GetPolicy`, `iam:GetPolicyVersion` and `iam:ListPolicyVersions` on `policy/bane-runtime` as well as `policy/bane-runtime-*`.

Each stack settings file pins its KMS `secretsprovider`; a clean checkout needs it, or Pulumi falls back to the passphrase provider and refuses to run. `Pulumi.dev.yaml` also carries the existing stack's `encryptedkey`. After the first init of `production`, copy its generated `encryptedkey` from the stack settings into `Pulumi.production.yaml` so later runs from a clean checkout can decrypt state.

For a new stack, dispatch on `dev` with `init: true`, `preview: true`. Init creates the stack; expect the baseline imports, inventoried mail-resource imports or creates, one access-key create and one dev Worker-secret write, with zero replacements or deletes. Then run `init: true`, `preview: false` while no dev deploy or E2E is running. After the dev E2E passes on the new key, delete the old hand-made `bane-runtime` key; IAM allows only two keys per user, and a future key replacement needs the free slot. Production follows the same sequence and writes the new key to `bane-production` only; the old `opensend-mx` Worker, its secrets and its Hyperdrive are untouched.
