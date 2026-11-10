import * as aws from "@pulumi/aws";
import * as cf from "@pulumi/cloudflare";
import * as cfV5 from "@pulumi/cloudflare-v5";
import * as pulumi from "@pulumi/pulumi";
import { render } from "../aws-shared/runtime-policies.mjs";

const stages = {
  dev: {
    account: "905840579680", origin: "https://dev.bane.mx", prefix: "bane-dev", worker: "bane-dev",
    queues: { work: "9c0d42c6410842c38d9304094dccccc4", feedback: "e655c22094e14e198abb3a254e235c7d" },
  },
  production: {
    account: "009882681002", origin: "https://bane.mx", prefix: "bane-prod", worker: "bane-production",
    queues: { work: "753a4b880016464c833b836a63663684", feedback: "34426f99502941fbbed927a059517b7c" },
  },
};

const stack = pulumi.getStack();
if (stack !== "dev" && stack !== "production") throw new Error(`Unsupported Bane stack: ${stack}`);
const stage = stages[stack];
const production = stack === "production";
const config = new pulumi.Config("bane");

const roleArn = config.require("deployRoleArn");
if (!roleArn.startsWith(`arn:aws:iam::${stage.account}:role/`)) {
  throw new Error(`bane:deployRoleArn must identify a role in the ${stack} account`);
}
const permissionsBoundary = config.get("permissionsBoundary");
const writeWorkerSecrets = config.getBoolean("writeWorkerSecrets") ?? !production;
const publishDomainConnectKey = config.getBoolean("publishDomainConnectKey") ?? false;
if (!production && publishDomainConnectKey) throw new Error("Domain Connect publication is production-only");

function adopt(id: string, provider: pulumi.ProviderResource): pulumi.CustomResourceOptions {
  return { import: id, protect: true, provider }; // Dropping one would take its stage down.
}

const cloudflareAccountId = "15d29c8639fd3733b1b5486a2acfd968";
const cloudflare = new cf.Provider("cloudflare", {}); // CLOUDFLARE_API_TOKEN
for (const [purpose, queueId] of Object.entries(stage.queues)) {
  new cf.Queue(purpose, { accountId: cloudflareAccountId, queueName: `${stage.prefix}-${purpose}` }, {
    ...adopt(`${cloudflareAccountId}/${queueId}`, cloudflare), ignoreChanges: ["settings"],
  });
}
// Queue settings (including retention) use installation defaults. Never auto-drain the
// feedback DLQ: an operator replays only after the ingestion fault has been repaired.
for (const purpose of ['webhooks','feedback-dlq']) {
  new cf.Queue(purpose, { accountId: cloudflareAccountId, queueName: `${stage.prefix}-${purpose}` }, { provider: cloudflare, protect: true });
}
const bucket = `${stage.prefix}-attachments`;
new cf.R2Bucket("attachments", { accountId: cloudflareAccountId, name: bucket, jurisdiction: "default", storageClass: "Standard" }, {
  ...adopt(`${cloudflareAccountId}/${bucket}/default`, cloudflare), ignoreChanges: ["location"], // ENAM; creation-only.
});

// The Hyperdrive config is not managed here. Cloudflare never returns origin.password, and
// Pulumi fails to import the resource because the read state lacks that required property.

if (production && publishDomainConnectKey) {
  // Public DER SubjectPublicKeyInfo (not the private signing key), 200 base64 characters per TXT record.
  const key = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnjQewwWQ0jSgWtbotOqgbSSy+TLFr8NVYAdmVG90AC19tEAKJCZmihzrnKppJcUlfXq5VIgeBoKRpTIvj3ibV7Gm3YGcC9NUme8BTbTsQEm12aAyzBVXGFdXLhh60d/9HB0jYTqQkdP/2y50IWTlGRePwXQ9Rz0zlXAKPma6Dpb66XVQkGOOKkFsJti9JcAb8BrcqQKd+bo1ngHbXrM270s/TAdfgwxswMLBYxxzPHW9DEbYuC3HojUfR+Ga1MH75Q+e2zEM6ENusM4EXUvpGSEWeA3KuI4VE4bci5TwQVzJK8PACjyIgKhzuM65nPgdzMrBSC7JqABEf7ViuId97wIDAQAB";
  for (const [i, chunk] of key.match(/.{1,200}/g)!.entries()) {
    new cf.DnsRecord(`domain-connect-key-${i + 1}`, {
      zoneId: "f2942e4d7fab2ce3d86a876f7564a429", name: "_dck1.domainconnect.bane.mx",
      type: "TXT", ttl: 3600, content: `"p=${i + 1},a=RS256,d=${chunk}"`,
    }, { provider: cloudflare });
  }
}

const credentials = { allowedAccountIds: [stage.account], assumeRoles: [{ roleArn }] };
const iam = new aws.Provider("virginia", { ...credentials, region: "us-east-1" });
const runtime = "bane-runtime";
const user = new aws.iam.User(runtime, {
  name: runtime, path: "/", tags: { "bane:purpose": "hosted-runtime" }, permissionsBoundary,
}, adopt(runtime, iam));

const policies = render("--fresh", { account: stage.account, origin: stage.origin });
const attachments = Object.entries(policies).map(([name, document]) => {
  const arn = `arn:aws:iam::${stage.account}:policy/${name}`;
  const policy = new aws.iam.Policy(name, { name, path: "/", policy: JSON.stringify(document) }, adopt(arn, iam));
  return new aws.iam.UserPolicyAttachment(name, { user: user.name, policyArn: policy.arn }, adopt(`${runtime}/${arn}`, iam));
});

// SES is deliberately outside this program: the receipt rule set, rules, identities,
// tenants and DNS all belong to the app and the operator.

// Never import an IAM access key: AWS returns its secret only on creation.
const key = new aws.iam.AccessKey("runtime-key", { user: user.name }, { provider: iam, dependsOn: attachments });
if (writeWorkerSecrets) {
  // v6 has account Secrets Store resources, not standalone script secrets, so these two PUTs use v5.
  const provider = new cfV5.Provider("worker-secrets", {});
  const target = { accountId: cloudflareAccountId, scriptName: stage.worker };
  // A secret PUT creates a Worker version. Serialize the pair; never DELETE a live binding on replacement.
  const opts = { provider, retainOnDelete: true };
  const accessKeyId = new cfV5.WorkersSecret("worker-access-key-id", {
    ...target, name: "AWS_ACCESS_KEY_ID", secretText: pulumi.secret(key.id),
  }, opts);
  new cfV5.WorkersSecret("worker-secret-access-key", {
    ...target, name: "AWS_SECRET_ACCESS_KEY", secretText: key.secret,
  }, { ...opts, dependsOn: [accessKeyId] });
}
