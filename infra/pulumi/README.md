# Hosted Bane infrastructure

One project, two stacks: `dev` (AWS `905840579680`, Worker `bane-dev`) and `production` (AWS `009882681002`, Worker `opensend-mx`). Pulumi 3.274.1 runs TypeScript directly with `runtime: bun`; use Bun 1.3.14 and `bun install --frozen-lockfile`. Type-check with `bun run tsc --noEmit`.

## Ownership and first update

Each stack adopts **13 existing resources** by the `import` options in [index.ts](index.ts). All production imports have `protect: true`. No separate `pulumi import` or state transfer is needed.

| Owner | Resources | Import ID format |
|---|---|---|
| Cloudflare `15d29c8639fd3733b1b5486a2acfd968` | Work and feedback queues; attachments bucket (ENAM); Hyperdrive (caching off, connection limit 15 dev / 30 prod) | `<account>/<queue-id>`, `<account>/<bucket>/default`, `<account>/<hyperdrive-id>` |
| IAM (us-east-1 provider) | `bane-runtime` user; `bane-runtime`, `bane-runtime-ohio`, `bane-runtime-trusted` policies and their three attachments | `bane-runtime`, policy ARN, `bane-runtime/<policy-arn>` |
| SES (us-east-2 provider) | `bane-inbound` rule set and active rule set | `bane-inbound` for both |

Each stack **creates one access key**; AWS cannot return the old key's secret. `bane:writeWorkerSecrets` defaults to **true in dev, false in production**. When enabled, two named Worker-secret PUTs replace the bindings without importing the unreadable old values. `@pulumi/cloudflare` v5 `WorkersSecret` handles only these writes; v6 handles the other Cloudflare resources. The pair is written sequentially, **not atomically**; schedule rotation around sending and other Worker deployments. Turning the flag off leaves the last values in place; it does not restore the old key.

`bane:publishDomainConnectKey` defaults to **false**. Only production may enable it, to **create** two public TXT records at `_dck1.domainconnect.bane.mx`. Verify the public key matches the signing key and the records are still absent first.

**Never manage here:** the Worker code, routes, custom domains (including `100::` AAAAs), other bindings/secrets, queue consumers, or any other DNS (including SES DKIM and `_bane`). The app owns receipt rules inside the active set, SES tenants, identities, configuration sets, SNS and the mail bucket. The stack does not own state storage, deploy roles, KMS keys or the old manual IAM key.

## CI handoff (Dax)

1. In `.github/workflows/pulumi.yml`, check for `infra/pulumi/Pulumi.yaml`, set both the Bun install `working-directory` and the action `work-dir` to `infra/pulumi`, and keep `stack-name: ${{ github.ref_name }}`. Include `infra/aws-shared/**` in the push paths so policy-only changes deploy.
2. Select the stage's R2 backend **in CI**, with the correct R2 endpoint and credentials. The current `cloud-url` points to AWS S3, not R2. Keep backend credentials separate from the AWS identity used for KMS and `sts:AssumeRole`. On that backend initialize each stack with its central secrets-account KMS key (`pulumi stack init <stage> --secrets-provider 'awskms://…'`); persist the resulting non-secret stack metadata for CI. No backend URL or provider is prescribed by this project.
3. Supply `bane:deployRoleArn` in each stack with the actual `bane-deploy` ARN. Allow the CI identity to assume it; grant the deploy role the scoped IAM/Ohio SES access it needs, and the identity running Pulumi access to the central KMS key. Set `bane:permissionsBoundary` to the runtime user's boundary policy ARN if required (neither user currently has one). To keep adoption unchanged, apply a new boundary as a separate reviewed update.
4. The dev token also needs **Workers Scripts: Edit**, because dev writes the new AWS key into `bane-dev`. The two secret writes are sequential, so for a second or two `bane-dev` holds the new key ID with the old secret, and AWS rejects its calls with 403. Run the first dev `up` while no dev deploy or E2E is running. After the dev E2E passes on the new key, delete the old hand-made `bane-runtime` key: IAM allows only two keys per user, and a future key replacement needs the free slot.
5. Fetch stage-scoped **`CLOUDFLARE_API_TOKEN`** and **`BANE_HYPERDRIVE_DATABASE_URL`** into the job environment, not stack config. The latter must be the existing Hyperdrive runtime origin (not migration/admin credentials). Missing or malformed URLs fail before resource registration. Cloudflare never returns the origin password; Pulumi treats it as secret and ignores `origin.password` on adoption and updates. Scope the token to the owned resources, adding Worker script edits / zone DNS edits only where enabled.
5. Review the first preview before allowing CI to apply: expect 13 imports per stack, **zero replacements or deletes**, one access-key create, and two dev Worker-secret writes. Verify a free IAM key slot (one of two occupied per user at inspection). Adopt dev first, confirm the new key is live and the dev E2E passes, **then delete only the old manual dev key by hand**. Leave production secret writes off until the coordinated AWS switch; creating its new key alone does not cut traffic over.
