import { createPrivateKey, hkdfSync } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from './core.js';
import type { Config } from './core.js';

const optional = <T extends z.ZodType>(schema: T) => z.preprocess(v => v === '' ? undefined : v, schema.optional());
const accountId = z.string().regex(/^\d{12}$/);
const values = z.object({
  BETTER_AUTH_SECRET: z.string().min(32),
  MAILGW_API_TOKEN: optional(z.string().min(32)),
  PREVIOUS_BETTER_AUTH_SECRET: optional(z.string().min(32)),
  ACCOUNT_ISSUER: optional(z.url({ protocol: /^https$/ })),
  ACCOUNT_CLIENT_ID: optional(z.string().min(1)),
  ACCOUNT_CLIENT_PRIVATE_KEY: optional(z.string().min(1)),
  ACCOUNT_ID_TOKEN_ALG: z.enum(['ES256', 'RS256']).default('ES256'),
  AUTH_ALLOWED_EMAILS: z.string().default(''),
  DEFAULT_WORKSPACE_OWNERS: z.string().trim().default('*'),
  MULTI_TENANT: z.enum(['true', 'false']).default('false'),
  BANE_PLATFORM_AWS_ACCOUNT: optional(accountId),
  // Hosted only: the one workspace allowed to own PUBLIC_URL's own domain (see scripts/adopt-platform-domain.ts).
  BANE_PLATFORM_DOMAIN_WORKSPACE: optional(z.string().regex(/^ws_[0-9a-f]{32}$/)),
  BANE_REGIONAL_SENDING: z.enum(['true','false']).default('false'),
  BANE_TRUSTED_POOL: z.enum(['true','false']).default('false'),
  BANE_RECEIVING_REDRIVE: z.enum(['true','false']).default('false'),
  // Development installations only: let Hosted pools become ready while the AWS account is still in the SES sandbox.
  BANE_ALLOW_SES_SANDBOX: z.enum(['true','false']).default('false'),
  BANE_REQUIRE_DMARC_FOR_BULK: z.enum(['true','false']).optional(),
  BANE_HOSTED_SCREEN: z.enum(['true','false']).default('true'),
  BANE_PLACEMENT_SHADOW: z.enum(['true','false']).default('true'),
  // Licensed DBL-compatible DNS zone (may contain a subscription key). Never log it.
  BANE_PLACEMENT_DBL_ZONE: optional(z.string().trim().toLowerCase().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/)),
  BANE_BYO_V2: z.enum(['true','false']).default('false'),
  BYO_V5_TEMPLATE_URL: optional(z.url({ protocol: /^https$/ })),
  BYO_TEMPLATE_URL: optional(z.url({ protocol: /^https$/ })),
  DOMAIN_CONNECT_PRIVATE_KEY: optional(z.string().min(1)),
  DOMAIN_CONNECT_KEY_ID: optional(z.string().regex(/^_?[a-z0-9][a-z0-9-]{0,60}[a-z0-9]$/)),
  // Comma-separated regions offered for MX shared sending.
  SHARED_SENDING_REGIONS: z.string().default('us-east-2'),
  HOSTED_SEND_CAP_FIRST_WEEK: z.coerce.number().int().positive().max(2147483647).default(100),
  HOSTED_SEND_CAP_SECOND_WEEK: z.coerce.number().int().positive().max(2147483647).default(1000),
  HOSTED_SEND_CAP_MATURE: z.coerce.number().int().positive().max(2147483647).default(10000),
  AUTH_ALLOWED_DOMAINS: z.string().default(''),
  // Upgrade-only decryption input for pre-OIDC installations. Never used as the new encryption key.
  ENCRYPTION_KEY: optional(z.string().regex(/^[a-f0-9]{64}$/i)),
  PUBLIC_URL: z.string().url(),
  SES_FEEDBACK_URL: optional(z.string().url().max(2048)),
  DEFAULT_SES_REGION: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/).default('us-east-1'),
  ENABLE_LIVE_SES: z.enum(['true', 'false']).default('false'),
  SIMULATED_SES_LATENCY_MS: z.coerce.number().int().min(0).max(15000).default(100),
  SIMULATED_SES_RATE: z.coerce.number().int().min(1).max(100000).default(1000),
  SIMULATED_SES_DELIVERY_DELAY_MS: z.coerce.number().int().min(0).max(60000).default(250),
  // Aim the dispatcher at a share of the provider quota (1 = exactly the quota). Overshoot is self-correcting:
  // a throttled response drops the target back to the quota for ten seconds.
  DISPATCH_RATE_FACTOR: z.coerce.number().min(0.1).max(10).default(1),
  DISPATCH_DAILY_HEADROOM_PERCENT: z.coerce.number().min(0).max(100).default(10),
  // Absolute live SES target in recipients per second; replaces the quota-derived rate when set.
  DISPATCH_TARGET_RATE: optional(z.coerce.number().int().min(1).max(100000)),
  AWS_ACCESS_KEY_ID: optional(z.string()), AWS_SECRET_ACCESS_KEY: optional(z.string()), AWS_SESSION_TOKEN: optional(z.string()),
  AWS_RUNTIME_CREDENTIALS: z.string().optional(),
  // Requests per minute allowed for each API key, agent token, MCP grant and mailbox key.
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(60).max(100000).default(1200),
  // Slack incoming webhook for hourly SES reputation threshold alerts. Treat as a secret.
  REPUTATION_ALERT_SLACK_URL: optional(z.string().url().max(2048).refine(value => value.startsWith('https://hooks.slack.com/'), 'Use a Slack incoming webhook URL.')),
  // Key for the opt-in Jev content screen on transactional sends (`screen: true`): a TypeSafe AI key, or an
  // OpenCode Console key when JEV_ENDPOINT is OpenCode's inference gateway. Treat as a secret.
  TYPESAFE_API_KEY: optional(z.string().min(1)),
  JEV_ENDPOINT: z.preprocess(v => v === '' ? undefined : v, z.string().url().refine(v => v.startsWith('https://'), 'Use an https URL.').default('https://api.typesafe.ai/v1/systemone')),
  JEV_MODEL: z.preprocess(v => v === '' ? undefined : v, z.string().min(1).max(100).default('jev-latest')),
  JEV_SCREEN_MODE: z.preprocess(v => v === '' ? undefined : v, z.enum(['reject', 'flag']).default('reject')),
  JEV_SCREEN_THRESHOLD: z.preprocess(v => v === '' ? undefined : v, z.coerce.number().min(0).max(1).default(0.7)),
});
const baneKeys = Object.keys(values.shape).filter(key => key.startsWith('BANE_'));
const legacyKey = (key: string) => `MX_${key.slice(5)}`;
export const CONFIG_KEYS = [...Object.keys(values.shape), ...baneKeys.map(legacyKey)];
export function migrationSettings(input: Record<string, unknown>) {
  return {workspaceId: 'default', regions: [values.shape.DEFAULT_SES_REGION.parse(input.DEFAULT_SES_REGION)]};
}
export function requirePlatformAccount(account: Config['platformAccount']): string {
  if (!account || !accountId.safeParse(account).success) throw new ApiError(503,'CONFIG_INVALID','Set BANE_PLATFORM_AWS_ACCOUNT to the 12-digit platform AWS account ID.');
  if (account==='438095551154') throw new ApiError(503,'PLATFORM_ACCOUNT_RETIRED','This release cannot use the retired Hosted AWS account. Switch the runtime key and BANE_PLATFORM_AWS_ACCOUNT together.');
  return account;
}
const list = (value: string) => [...new Set(value.split(',').map(v => v.trim()).filter(Boolean))];
// Separate from Better Auth's signing/encryption uses even though installers manage one root secret.
export function deriveEncryptionKey(secret: string): string {
  return Buffer.from(hkdfSync('sha256', secret, 'opensend:keys:v1', 'webhook-encryption', 32)).toString('hex');
}
export function loadConfig(input: Record<string, unknown>): Config {
  const parsed = values.safeParse({...input, ...Object.fromEntries(baneKeys.map(key => [key, input[key] ?? input[legacyKey(key)]]))});
  if (!parsed.success) throw new ApiError(503, 'CONFIG_INVALID', `Missing or invalid server configuration: ${parsed.error.issues.map(i => i.path.join('.')).join(', ')}.`);
  const v = parsed.data;
  if (Boolean(v.ACCOUNT_CLIENT_ID) !== Boolean(v.ACCOUNT_CLIENT_PRIVATE_KEY)) throw new ApiError(503,'CONFIG_INVALID','Set both ACCOUNT_CLIENT_ID and ACCOUNT_CLIENT_PRIVATE_KEY.');
  let aws: Config['aws'] = v.AWS_ACCESS_KEY_ID && v.AWS_SECRET_ACCESS_KEY ? { accessKeyId:v.AWS_ACCESS_KEY_ID, secretAccessKey:v.AWS_SECRET_ACCESS_KEY, sessionToken:v.AWS_SESSION_TOKEN } : undefined;
  if (v.AWS_RUNTIME_CREDENTIALS !== undefined) {
    try { aws = z.object({accessKeyId:z.string().min(1), secretAccessKey:z.string().min(1)}).strict().parse(JSON.parse(v.AWS_RUNTIME_CREDENTIALS)); }
    catch { throw new ApiError(503,'CONFIG_INVALID','AWS_RUNTIME_CREDENTIALS must contain a complete runtime key pair.'); }
  }
  if (v.MULTI_TENANT==='true' && v.ENABLE_LIVE_SES==='true' && v.BANE_HOSTED_SCREEN==='true' && !v.TYPESAFE_API_KEY)
    throw new ApiError(503,'CONFIG_INVALID','Hosted live screening requires TYPESAFE_API_KEY.');
  if (v.MULTI_TENANT==='true' && (v.BANE_PLATFORM_AWS_ACCOUNT || [v.BANE_REGIONAL_SENDING,v.BANE_TRUSTED_POOL,v.BANE_BYO_V2].includes('true'))) requirePlatformAccount(v.BANE_PLATFORM_AWS_ACCOUNT);
  if (Boolean(v.DOMAIN_CONNECT_PRIVATE_KEY) !== Boolean(v.DOMAIN_CONNECT_KEY_ID)) throw new ApiError(503,'CONFIG_INVALID','Set both DOMAIN_CONNECT_PRIVATE_KEY and DOMAIN_CONNECT_KEY_ID, or neither.');
  let domainConnect: Config['domainConnect'];
  if (v.DOMAIN_CONNECT_PRIVATE_KEY && v.DOMAIN_CONNECT_KEY_ID) {
    try {
      const privateKey=createPrivateKey(v.DOMAIN_CONNECT_PRIVATE_KEY.replace(/\\n/g,'\n'));
      if (privateKey.asymmetricKeyType!=='rsa' || privateKey.asymmetricKeyDetails?.modulusLength!==2048) throw new Error();
      domainConnect={privateKey,keyId:v.DOMAIN_CONNECT_KEY_ID};
    } catch { throw new ApiError(503,'CONFIG_INVALID','DOMAIN_CONNECT_PRIVATE_KEY must be an RSA-2048 private key in PEM format.'); }
  }
  if (v.PREVIOUS_BETTER_AUTH_SECRET && v.ENCRYPTION_KEY) throw new ApiError(503, 'CONFIG_INVALID', 'Finish the legacy ENCRYPTION_KEY upgrade before configuring PREVIOUS_BETTER_AUTH_SECRET.');
  const allowedEmails = list(v.AUTH_ALLOWED_EMAILS).map(e => e.toLowerCase());
  const defaultWorkspaceOwners = v.MULTI_TENANT === 'true' ? [] : v.DEFAULT_WORKSPACE_OWNERS === '*' ? '*' : list(v.DEFAULT_WORKSPACE_OWNERS.toLowerCase());
  if (defaultWorkspaceOwners !== '*' && defaultWorkspaceOwners.some(e => !z.email().safeParse(e).success)) throw new ApiError(503, 'CONFIG_INVALID', 'Set DEFAULT_WORKSPACE_OWNERS to exact email addresses or a single *.');
  const allowedDomains = list(v.AUTH_ALLOWED_DOMAINS).map(d => d.toLowerCase());
  if (allowedEmails.some(e => !z.email().safeParse(e).success) || allowedDomains.some(d => !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(d))) throw new ApiError(503, 'CONFIG_INVALID', 'Use exact email addresses and domain names in the authentication allowlists, without wildcards or URLs.');
  const regions = [v.DEFAULT_SES_REGION];
  const sharedRegions = list(v.SHARED_SENDING_REGIONS);
  if (!sharedRegions.length || sharedRegions.some(r => !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(r))) throw new ApiError(503, 'CONFIG_INVALID', 'Set SHARED_SENDING_REGIONS to comma-separated AWS regions.');
  const url = new URL(v.PUBLIC_URL);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new ApiError(503, 'CONFIG_INVALID', 'PUBLIC_URL must use HTTPS, except for localhost development.');
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new ApiError(503, 'CONFIG_INVALID', 'PUBLIC_URL must be a canonical origin without credentials, a path, query or fragment.');
  return {
    // Retained internal storage namespace, not an installation setting or browser-provided tenant ID.
    workspaceId: 'default', multiTenant: v.MULTI_TENANT === 'true', authSecret: v.BETTER_AUTH_SECRET, previousAuthSecret: v.PREVIOUS_BETTER_AUTH_SECRET,mailGatewayToken:v.MAILGW_API_TOKEN,
    platformAccount: v.BANE_PLATFORM_AWS_ACCOUNT, platformDomainWorkspace: v.MULTI_TENANT==='true' ? v.BANE_PLATFORM_DOMAIN_WORKSPACE : undefined, receivingRedrive:v.BANE_RECEIVING_REDRIVE==='true',byoTemplateUrl: v.BYO_TEMPLATE_URL, sharedRegions, regionalSending: v.MULTI_TENANT === 'true' && v.BANE_REGIONAL_SENDING === 'true',
    trustedPool: v.MULTI_TENANT==='true' && v.BANE_REGIONAL_SENDING==='true' && v.BANE_TRUSTED_POOL==='true',
    allowSesSandbox: v.MULTI_TENANT==='true' && v.BANE_ALLOW_SES_SANDBOX==='true',
    requireDmarcForBulk: v.MULTI_TENANT === 'true' && (v.BANE_REQUIRE_DMARC_FOR_BULK ?? v.ENABLE_LIVE_SES) === 'true',
    hostedScreen: v.MULTI_TENANT==='true' && v.BANE_HOSTED_SCREEN==='true',
    placementShadow: v.MULTI_TENANT === 'true' && v.BANE_PLACEMENT_SHADOW === 'true', placementDblZone: v.BANE_PLACEMENT_DBL_ZONE,
    byoV2: v.MULTI_TENANT === 'true' && v.BANE_BYO_V2 === 'true', byoV5TemplateUrl: v.BYO_V5_TEMPLATE_URL,
    hostedSendCaps: { firstWeek: v.HOSTED_SEND_CAP_FIRST_WEEK, secondWeek: v.HOSTED_SEND_CAP_SECOND_WEEK, mature: v.HOSTED_SEND_CAP_MATURE },
    domainConnect,
    allowedEmails, allowedDomains, defaultWorkspaceOwners,
    accountIssuer: v.ACCOUNT_ISSUER ?? 'https://account.anoma.ly',
    accountClient: v.ACCOUNT_CLIENT_ID && v.ACCOUNT_CLIENT_PRIVATE_KEY ? { id:v.ACCOUNT_CLIENT_ID, privateKey:v.ACCOUNT_CLIENT_PRIVATE_KEY, algorithm:v.ACCOUNT_ID_TOKEN_ALG } : undefined,
    encryptionKey: deriveEncryptionKey(v.BETTER_AUTH_SECRET),
    previousEncryptionKey: v.PREVIOUS_BETTER_AUTH_SECRET ? deriveEncryptionKey(v.PREVIOUS_BETTER_AUTH_SECRET) : v.ENCRYPTION_KEY,
    publicUrl: url.origin, sesFeedbackUrl: v.SES_FEEDBACK_URL, regions, liveEnabled: v.ENABLE_LIVE_SES === 'true',
    simulatedSes: { latencyMs: v.SIMULATED_SES_LATENCY_MS, maxSendRate: v.SIMULATED_SES_RATE, deliveryDelayMs: v.SIMULATED_SES_DELIVERY_DELAY_MS },
    dispatch: { rateFactor: v.DISPATCH_RATE_FACTOR, targetRate: v.DISPATCH_TARGET_RATE, dailyHeadroomPercent: v.DISPATCH_DAILY_HEADROOM_PERCENT },
    aws,
    // Resource names and trusted feedback bindings are hydrated from persisted setup state.
    snsTopicArns: [], inboundTopicArns: [],
    reputationAlertUrl: v.REPUTATION_ALERT_SLACK_URL,
    screen: v.TYPESAFE_API_KEY ? { apiKey: v.TYPESAFE_API_KEY, endpoint: v.JEV_ENDPOINT, model: v.JEV_MODEL, mode: v.JEV_SCREEN_MODE, threshold: v.JEV_SCREEN_THRESHOLD } : undefined,
    apiRateLimitPerMinute: v.API_RATE_LIMIT_PER_MINUTE,
    configurationSets: { transactional: '', marketing: '' },
  };
}
