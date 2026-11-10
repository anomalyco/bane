import * as aws from "@pulumi/aws";
import * as cf from "@pulumi/cloudflare";
import * as cfV5 from "@pulumi/cloudflare-v5";
import * as pulumi from "@pulumi/pulumi";
import { render } from "../aws-shared/runtime-policies.mjs";

const stages = {
  dev: {
    account: "905840579680", origin: "https://dev.bane.mx", prefix: "bane-dev", worker: "bane-dev",
    queues: { work: "9c0d42c6410842c38d9304094dccccc4", feedback: "e655c22094e14e198abb3a254e235c7d" },
    hyperdrive: "67bf6907a42a483da37f4d2256847281", connections: 15,
  },
  production: {
    account: "009882681002", origin: "https://bane.mx", prefix: "bane-prod", worker: "opensend-mx",
    queues: { work: "753a4b880016464c833b836a63663684", feedback: "34426f99502941fbbed927a059517b7c" },
    hyperdrive: "556aba191add406eaa58a0e26eebb6b1", connections: 30,
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
// opensend-mx sends on the old AWS account until the coordinated production cutover.
const writeWorkerSecrets = config.getBoolean("writeWorkerSecrets") ?? !production;
const publishDomainConnectKey = config.getBoolean("publishDomainConnectKey") ?? false;
if (!production && publishDomainConnectKey) throw new Error("Domain Connect publication is production-only");

function databaseOrigin(raw: string | undefined) {
  // Never let URL/parser exceptions include the input (which contains credentials) in CI logs.
  try {
    const url = new URL(raw ?? "");
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username ||
        !url.password || !/^\/[^/]+$/.test(url.pathname) || url.hash) throw new Error();
    return {
      scheme: "postgres", host: url.hostname, port: Number(url.port || 5432),
      database: decodeURIComponent(url.pathname.slice(1)), user: decodeURIComponent(url.username),
      password: pulumi.secret(decodeURIComponent(url.password)),
    };
  } catch {
    throw new Error("BANE_HYPERDRIVE_DATABASE_URL must be a Postgres URL with a host, user, password and database");
  }
}
const origin = databaseOrigin(process.env.BANE_HYPERDRIVE_DATABASE_URL);

function adopt(id: string, provider: pulumi.ProviderResource): pulumi.CustomResourceOptions {
  return { import: id, protect: true, provider }; // Dev and production: dropping one would take its stage down.
}

const accountId = "15d29c8639fd3733b1b5486a2acfd968";
const cloudflare = new cf.Provider("cloudflare", {}); // CLOUDFLARE_API_TOKEN
for (const [purpose, id] of Object.entries(stage.queues)) {
  new cf.Queue(purpose, { accountId, queueName: `${stage.prefix}-${purpose}` }, {
    ...adopt(`${accountId}/${id}`, cloudflare), ignoreChanges: ["settings"],
  });
}
const bucket = `${stage.prefix}-attachments`;
new cf.R2Bucket("attachments", { accountId, name: bucket, jurisdiction: "default", storageClass: "Standard" }, {
  ...adopt(`${accountId}/${bucket}/default`, cloudflare), ignoreChanges: ["location"], // ENAM; creation-only.
});
new cf.HyperdriveConfig("database", {
  accountId, name: stage.prefix, origin, caching: { disabled: true }, originConnectionLimit: stage.connections,
}, { ...adopt(`${accountId}/${stage.hyperdrive}`, cloudflare), ignoreChanges: ["origin.password", "mtls"] }); // Live returns mtls {}; the password comes from env.

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
const ses = new aws.Provider("ohio", { ...credentials, region: "us-east-2" });
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

const inbound = "bane-inbound";
const ruleSet = new aws.ses.ReceiptRuleSet(inbound, { ruleSetName: inbound }, adopt(inbound, ses));
new aws.ses.ActiveReceiptRuleSet("active-inbound", { ruleSetName: ruleSet.ruleSetName }, adopt(inbound, ses));

// Never import an IAM access key: AWS returns its secret only on creation.
const key = new aws.iam.AccessKey("runtime-key", { user: user.name }, { provider: iam, dependsOn: attachments });
if (writeWorkerSecrets) {
  // v6 has account Secrets Store resources, not standalone script secrets. Pin v5 for these two PUTs only.
  const provider = new cfV5.Provider("worker-secrets", {});
  const target = { accountId, scriptName: stage.worker };
  // A secret PUT creates a Worker version. Serialize the pair; never DELETE a live binding on replacement/disable.
  const opts = { provider, retainOnDelete: true };
  const id = new cfV5.WorkersSecret("worker-key-id", {
    ...target, name: "AWS_ACCESS_KEY_ID", secretText: pulumi.secret(key.id),
  }, opts);
  new cfV5.WorkersSecret("worker-key-secret", {
    ...target, name: "AWS_SECRET_ACCESS_KEY", secretText: key.secret,
  }, { ...opts, dependsOn: [id] });
}
