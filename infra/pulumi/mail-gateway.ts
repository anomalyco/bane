import * as aws from "@pulumi/aws";
import * as cf from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";

const name = "bane-mail-gateway";
const ports = [993, 143, 465, 587];
const healthPort = 8080;
const cidr = "10.68.0.0/16";

type Stage = { account: string; cloudflareAccountId: string; origin: string };

/** The stage's own API origin. The gateway binary falls back to production, so never leave it unset. */
function apiOrigin(stage: "dev" | "production", origin: string) {
  const url = URL.canParse(origin) ? new URL(origin) : undefined;
  if (!url || url.protocol !== "https:" || url.origin !== origin || (stage === "production") !== (url.hostname === "bane.mx")) {
    throw new Error(`The ${stage} stack needs its own https API origin for MAILGW_API_URL (got ${JSON.stringify(origin)})`);
  }
  return url;
}

export function mailGateway(stage: "dev" | "production", { account, cloudflareAccountId, origin }: Stage,
  config: pulumi.Config, ohio: aws.Provider, iam: aws.Provider, cloudflare: cf.Provider, tags: Record<string, string>) {
  const api = apiOrigin(stage, origin);
  const opts = { provider: ohio, protect: true };
  const iamOpts = { provider: iam, protect: true };
  const named = (suffix: string) => ({ ...tags, Name: `${name}-${suffix}` });
  const desired = config.getNumber("mailGatewayDesired") ?? 0;
  if (!Number.isSafeInteger(desired) || desired < 0) throw new Error("bane:mailGatewayDesired must be a nonnegative integer");
  // The deploy reads the same committed flag: true binds the Worker's MAILGW_API_TOKEN (and fails
  // without it), false removes it. Tasks only run against a Worker that can authenticate them.
  const enabled = config.getBoolean("mailGatewayEnabled") ?? false;
  if (desired > 0 && !enabled) throw new Error("Set bane:mailGatewayEnabled to true before scaling bane:mailGatewayDesired above 0");
  const image = config.get("mailGatewayImage");
  const repoUrl = `${account}.dkr.ecr.us-east-2.amazonaws.com/${name}`;
  if ((desired > 0 && !image) || (image !== undefined &&
    (!image.startsWith(`${repoUrl}@`) || !/^sha256:[0-9a-f]{64}$/.test(image.slice(repoUrl.length + 1))))) {
    throw new Error(`Set bane:mailGatewayImage to ${repoUrl}@sha256:<digest> before scaling up`);
  }
  const pager = config.require("receivingAlarmTopicArn");
  if (pager !== `arn:aws:sns:us-east-2:${account}:bane-alerts`) throw new Error("Expected the stage's Ohio bane-alerts topic");

  const repo = new aws.ecr.Repository(name, { name, imageTagMutability: "IMMUTABLE",
    imageScanningConfiguration: { scanOnPush: true }, tags }, opts);
  new aws.ecr.LifecyclePolicy(name, { repository: repo.name, policy: JSON.stringify({ rules: [{
    rulePriority: 1, description: "Keep the 20 most recently pushed images, tagged or untagged",
    selection: { tagStatus: "any", countType: "imageCountMoreThan", countNumber: 20 }, action: { type: "expire" },
  }] }) }, opts);

  const vpc = new aws.ec2.Vpc(name, { cidrBlock: cidr, enableDnsSupport: true, enableDnsHostnames: true, tags: named("vpc") }, opts);
  const igw = new aws.ec2.InternetGateway(name, { vpcId: vpc.id, tags: named("igw") }, opts);
  const routes = new aws.ec2.RouteTable(name, { vpcId: vpc.id, routes: [{ cidrBlock: "0.0.0.0/0", gatewayId: igw.id }], tags: named("public") }, opts);
  const subnets = ["a", "b"].map((az, i) => new aws.ec2.Subnet(`${name}-${az}`, { vpcId: vpc.id,
    availabilityZone: `us-east-2${az}`, cidrBlock: `10.68.${i}.0/24`, tags: named(`public-${az}`) }, opts));
  const associations = subnets.map((s, i) => new aws.ec2.RouteTableAssociation(`${name}-public-${i}`, { subnetId: s.id, routeTableId: routes.id }, opts));
  const subnetIds = subnets.map(s => s.id);

  const tcp = (port: number) => ({ protocol: "tcp", fromPort: port, toPort: port });
  const targetPorts = [...ports, healthPort];
  const edge = new aws.ec2.SecurityGroup(`${name}-nlb`, { name: `${name}-nlb`, vpcId: vpc.id,
    ingress: ports.map(p => ({ ...tcp(p), cidrBlocks: ["0.0.0.0/0"] })),
    egress: targetPorts.map(p => ({ ...tcp(p), cidrBlocks: [cidr] })), tags: named("nlb") }, opts);
  const tasks = new aws.ec2.SecurityGroup(`${name}-tasks`, { name: `${name}-tasks`, vpcId: vpc.id,
    // Referencing the NLB SG also works with source-IP preservation. No public ingress to a task ENI.
    ingress: targetPorts.map(p => ({ ...tcp(p), securityGroups: [edge.id] })),
    egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }], tags: named("tasks") }, opts);

  const lb = new aws.lb.LoadBalancer(name, { name, loadBalancerType: "network", internal: false, ipAddressType: "ipv4",
    enableCrossZoneLoadBalancing: true, securityGroups: [edge.id], subnets: subnetIds, tags }, { ...opts, dependsOn: associations });
  const groups = ports.map(port => new aws.lb.TargetGroup(`${name}-${port}`, { name: `${name}-${port}`, vpcId: vpc.id,
    port, protocol: "TCP", targetType: "ip", preserveClientIp: "true", deregistrationDelay: 300,
    healthCheck: { protocol: "HTTP", port: `${healthPort}`, path: "/health", matcher: "200" }, tags }, opts));
  const listeners = groups.map((group, i) => new aws.lb.Listener(`${name}-${ports[i]}`, { loadBalancerArn: lb.arn,
    port: ports[i], protocol: "TCP", tcpIdleTimeoutSeconds: 1800,
    defaultActions: [{ type: "forward", targetGroupArn: group.arn }], tags }, opts));

  const log = new aws.cloudwatch.LogGroup(name, { name: `/ecs/${name}`, retentionInDays: 30, tags }, opts);
  const secrets = Object.entries({ DATABASE_URL: "db-url", MAILGW_CERT_PEM: "tls-cert", MAILGW_KEY_PEM: "tls-key", MAILGW_API_TOKEN: "api-token" })
    .map(([env, key]) => ({ name: env, valueFrom: new aws.secretsmanager.Secret(`${name}-${key}`, {
      name: `bane/${stage}/mail-gateway/${key}`, tags,
    }, opts).arn })); // Metadata only. Never create SecretVersion or read AWSCURRENT into state.
  const assumeRolePolicy = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "sts:AssumeRole",
    Principal: { Service: "ecs-tasks.amazonaws.com" }, Condition: { StringEquals: { "aws:SourceAccount": account },
      ArnLike: { "aws:SourceArn": `arn:aws:ecs:us-east-2:${account}:*` } } }] });
  // Operator-owned ceiling for both roles (infra/aws-shared/gateway-boundary-policy.json): the deploy
  // role may create them and write the execution role's inline policy only with this boundary attached.
  const permissionsBoundary = `arn:aws:iam::${account}:policy/bane-gateway-boundary`;
  const task = new aws.iam.Role(`${name}-task`, { name: `${name}-task`, assumeRolePolicy, permissionsBoundary, tags }, iamOpts);
  const execution = new aws.iam.Role(`${name}-execution`, { name: `${name}-execution`, assumeRolePolicy, permissionsBoundary, tags }, iamOpts);
  const executionAccess = new aws.iam.RolePolicy(`${name}-execution`, {
    name, role: execution.name,
    policy: pulumi.jsonStringify({ Version: "2012-10-17", Statement: [
      { Effect: "Allow", Action: "ecr:GetAuthorizationToken", Resource: "*", Condition: { StringEquals: { "aws:RequestedRegion": "us-east-2" } } },
      { Effect: "Allow", Action: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"], Resource: repo.arn },
      { Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: `arn:aws:logs:us-east-2:${account}:log-group:/ecs/${name}:log-stream:gateway/${name}/*` },
      { Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: secrets.map(secret => secret.valueFrom) },
    ] }),
  }, iamOpts);

  const cluster = new aws.ecs.Cluster(name, { name, tags }, opts);
  // A new image must be able to replace the task definition revision without unprotecting the service.
  const definition = new aws.ecs.TaskDefinition(name, { family: name, requiresCompatibilities: ["FARGATE"], networkMode: "awsvpc",
    runtimePlatform: { operatingSystemFamily: "LINUX", cpuArchitecture: "ARM64" }, cpu: "512", memory: "1024",
    // ECS can't scope DeregisterTaskDefinition by family. Leave old revisions for operator cleanup.
    skipDestroy: true, taskRoleArn: task.arn, executionRoleArn: execution.arn, tags,
    containerDefinitions: pulumi.jsonStringify([{ name, essential: true, image: image ?? pulumi.interpolate`${repo.repositoryUrl}:unpublished`,
      ulimits: [{ name: "nofile", softLimit: 8192, hardLimit: 8192 }], portMappings: targetPorts.map(containerPort => ({ containerPort, protocol: "tcp" })), stopTimeout: 120, secrets,
      environment: [{ name: "MAILGW_API_URL", value: api.origin }],
      // The image runs as distroless nonroot. Unlike Docker, Fargate keeps the kernel's 1024
      // floor for unprivileged binds, so 143/465/587/993 would fail with EACCES without this.
      systemControls: [{ namespace: "net.ipv4.ip_unprivileged_port_start", value: `${Math.min(...ports)}` }],
      logConfiguration: { logDriver: "awslogs", options: { "awslogs-group": log.name, "awslogs-region": "us-east-2", "awslogs-stream-prefix": "gateway" } },
    }]),
  }, { provider: ohio });
  const service = new aws.ecs.Service(name, { name, cluster: cluster.arn, launchType: "FARGATE", platformVersion: "1.4.0",
    taskDefinition: definition.arn, desiredCount: desired, deploymentMinimumHealthyPercent: 100, deploymentMaximumPercent: 200,
    deploymentCircuitBreaker: { enable: true, rollback: true }, waitForSteadyState: true,
    networkConfiguration: { assignPublicIp: true, subnets: subnetIds, securityGroups: [tasks.id] },
    loadBalancers: groups.map((group, i) => ({ targetGroupArn: group.arn, containerName: name, containerPort: ports[i] })), tags,
  }, { ...opts, dependsOn: [...listeners, executionAccess], customTimeouts: { update: "30m" } });

  const alarm = { namespace: "AWS/NetworkELB", comparisonOperator: "GreaterThanThreshold", treatMissingData: "notBreaching",
    period: 60, evaluationPeriods: 2, alarmActions: [pager], tags };
  groups.forEach((group, i) => {
    const id = `${name}-unhealthy-${ports[i]}`;
    new aws.cloudwatch.MetricAlarm(id, { ...alarm, name: id, metricName: "UnHealthyHostCount", statistic: "Maximum", threshold: 0,
      dimensions: { LoadBalancer: lb.arnSuffix, TargetGroup: group.arnSuffix } }, opts);
  });
  new aws.cloudwatch.MetricAlarm(`${name}-resets`, { ...alarm, name: `${name}-resets`, metricName: "TCP_ELB_Reset_Count",
    statistic: "Sum", threshold: 10, dimensions: { LoadBalancer: lb.arnSuffix } }, opts);

  if (config.getBoolean("mailGatewayDns") ?? false) {
    const zone = api.hostname; // dev.bane.mx or bane.mx: each stage owns its own zone.
    const zoneId = cf.getZoneOutput({ filter: { name: zone, account: { id: cloudflareAccountId } } }, { provider: cloudflare }).id;
    for (const host of ["imap", "smtp"]) new cf.DnsRecord(`${name}-${host}`, { zoneId, name: `${host}.${zone}`,
      type: "CNAME", content: lb.dnsName, proxied: false, ttl: 300 }, { provider: cloudflare, protect: true, dependsOn: [service] });
  }
  return lb.dnsName;
}
