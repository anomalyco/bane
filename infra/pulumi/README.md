# Hosted Bane infrastructure

One project, two stacks: `dev` (AWS `905840579680`, Worker `bane-dev`) and `production` (AWS `009882681002`, Worker `bane-production`). Pulumi 3.274.1 runs the TypeScript directly with `runtime: bun`; use Bun 1.3.14 and `bun install --frozen-lockfile`. Type-check with `bun run tsc --noEmit`.

## What each stack owns

Each stack adopts **10 existing resources** through the `import` options in [index.ts](index.ts), all with `protect: true`:

| Owner | Resources | Import ID |
|---|---|---|
| Cloudflare `15d29c8639fd3733b1b5486a2acfd968` | work and feedback queues; attachments bucket (ENAM) | `<account>/<queue-id>`, `<account>/<bucket>/default` |
| IAM (us-east-1 provider) | `bane-runtime` user; the `bane-runtime`, `bane-runtime-ohio` and `bane-runtime-trusted` policies and their three attachments | `bane-runtime`, policy ARN, `bane-runtime/<policy-arn>` |

**Not managed: the Hyperdrive config.** Cloudflare never returns `origin.password`, and Pulumi rejects importing it because the read state lacks that required property (`Missing required property 'origin.password'`). The live config stays as created, with caching off and 15 dev / 30 production connections; `api/wrangler.<environment>.jsonc` binds it by ID. Adopt it here once the provider can import write-only required fields.

Each stack **creates one access key**; AWS cannot return the old key's secret. `bane:writeWorkerSecrets` defaults to **true in dev, false in production**, and `Pulumi.production.yaml` turns it on explicitly for `bane-production`. When enabled, two named Worker-secret PUTs replace the bindings without importing the unreadable old values. `@pulumi/cloudflare` v5 `WorkersSecret` handles only these writes; v6 handles the other Cloudflare resources. The pair is written sequentially, **not atomically**; schedule rotation around sending and other Worker deployments. Turning the flag off leaves the last values in place; it does not restore the old key.

`bane:publishDomainConnectKey` defaults to **false**. Only production may enable it, to **create** two public TXT records at `_dck1.domainconnect.bane.mx`. Verify the [public key in index.ts](index.ts) matches the signing key and the records are still absent first.

**Never manage here:** the Worker code, routes, custom domains (including `100::` AAAAs), other bindings/secrets, queue consumers, or any other DNS (including SES DKIM and `_bane`). SES is entirely outside this program: the active receipt rule set, its rules, identities, tenants, configuration sets, SNS and the mail bucket belong to the app and the operator. The stack does not own state storage, deploy roles, KMS keys or the old manual IAM key.

## CI

`.github/workflows/deploy.yml` runs the Pulumi stack first in each stage's deploy, after `dev` CI passes or on a `production` push, when `infra/pulumi/**`, `infra/aws-shared/**` or the workflow changed; manual dispatches always run it, with `init` and `preview` inputs (`preview` leaves the Worker untouched). State lives in R2 (`bane-<stage>-pulumi`) and is encrypted with `alias/pulumi/bane-<stage>`; AWS comes from GitHub OIDC through `github/bane-<stage>` and the stack's `bane:deployRoleArn`. `CLOUDFLARE_API_TOKEN` is minted per run and passed through the environment only. The deploy role needs `iam:GetPolicy`, `iam:GetPolicyVersion` and `iam:ListPolicyVersions` on `policy/bane-runtime` as well as `policy/bane-runtime-*`.

Each stack settings file pins its KMS `secretsprovider`; a clean checkout needs it, or Pulumi falls back to the passphrase provider and refuses to run. `Pulumi.dev.yaml` also carries the existing stack's `encryptedkey`. After the first init of `production`, copy its generated `encryptedkey` from the stack settings into `Pulumi.production.yaml` so later runs from a clean checkout can decrypt state.

For the first run, dispatch on `dev` with `init: true`, `preview: true`. Init creates the stack; expect **10 imports, one access-key create and two dev Worker-secret writes, with zero replacements or deletes**. Then run `init: true`, `preview: false` while no dev deploy or E2E is running. After the dev E2E passes on the new key, delete the old hand-made `bane-runtime` key; IAM allows only two keys per user, and a future key replacement needs the free slot. Production follows the same sequence and writes the new key to `bane-production` only; the old `opensend-mx` Worker, its secrets and its Hyperdrive are untouched.
