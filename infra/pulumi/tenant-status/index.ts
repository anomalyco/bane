import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';
import { createRequire } from 'node:module';

const stage = pulumi.getStack();
if (stage !== 'dev' && stage !== 'production') throw new Error('Expected a Bane stage');
const { config } = createRequire(import.meta.url)(`../Pulumi.${stage}.yaml`); // Bun's native YAML loader
const account = /^arn:aws:iam::(\d{12}):role\/bane-deploy$/.exec(config['bane:deployRoleArn'])?.[1];
if (!account) throw new Error('Expected the stage deploy-role ARN');

for (const region of ['us-east-2', 'us-east-1'] as const) {
  const trusted = region === 'us-east-1';
  if (trusted && String(config['bane:trustedFeedbackPublish']) !== 'true') continue;
  const provider = new aws.Provider(region, { region, allowedAccountIds: [account], assumeRoles: [{ roleArn: config['bane:deployRoleArn'] }] });
  const opts = { provider, protect: true };
  const name = 'bane-tenant-sending-status';
  const topic = `arn:aws:sns:${region}:${account}:${trusted ? 'bane-trusted' : 'bane'}-feedback`;
  const rule = new aws.cloudwatch.EventRule(region, { name, eventPattern: JSON.stringify({
    source: ['aws.ses'], account: [account], region: [region],
    'detail-type': ['Sending Status Disabled', 'Sending Status Enabled'],
    resources: [{ prefix: `arn:aws:ses:${region}:${account}:tenant/bane-` }],
  }) }, opts);
  // Independently provisioned: CI may pass this role to EventBridge but cannot edit its trust or grant.
  const roleArn = `arn:aws:iam::${account}:role/${name}-${region}`;
  // Leave input untouched: #115 consumes the EventBridge envelope inside the signed SNS Message.
  new aws.cloudwatch.EventTarget(region, { rule: rule.name, targetId: 'feedback', arn: topic, roleArn }, opts);
}
