/**
 * The product's public identity in one place: its name, the hosted origin, the addresses people write to, and the
 * names integrations see. The API, dashboard and support Worker import this file; `bun run sdk` (in api/) copies it
 * verbatim to sdk/src/brand.ts and mcp/src/brand.ts, so edit only api/src/brand.ts. It imports nothing, so every
 * package compiles it.
 *
 * Bane is becoming Nightmail (nightmail.com). Until that domain is live the hosted service stays on bane.mx: the
 * switch is `hostedDomain`, with bane.mx moving to `previousDomains` so it stays served. A name a customer may already
 * have (key prefix, DNS proof, header, scope, cookie) stays accepted until the cutover, which removes them all at once
 * (each site is marked "remove after rename cleanup"). Infrastructure names (Workers, buckets, SES resources) are not here.
 */
export const productName = 'Nightmail';
/** Lowercase, for identifiers. */
export const productSlug = 'nightmail';
/** Earlier names, newest first. Still accepted wherever a customer may have saved one. */
export const legacySlugs = ['bane', 'opensend'] as const;

/** The product's own domain. The hosted service moves to it once it is live. */
export const productDomain = 'nightmail.com';
/** The hosted service's domain: dashboard, API, docs and /mcp, with support.<domain> beside it and dev.<domain>. */
export const hostedDomain = 'bane.mx';
/** Domains the hosted service answered on before `hostedDomain`, still served. Empty until the switch. */
export const previousDomains: readonly string[] = [];
export const servedDomains: readonly string[] = [hostedDomain, ...previousDomains];
/** Every dashboard and API host of the hosted service: production and dev, on each served domain. */
export const hostedHosts: readonly string[] = servedDomains.flatMap(domain => [domain, `dev.${domain}`]);
/** The support Worker's host beside a dashboard host (support.bane.mx, support.dev.bane.mx). */
export const supportHost = (host: string) => `support.${host}`;

/**
 * The hosted origin. A running installation uses its own: PUBLIC_URL in the API, VITE_PUBLIC_URL or the page's origin
 * in the dashboard, BANE_ORIGIN in the support Worker. This is their default and the origin examples are written for.
 */
export const publicOrigin = `https://${hostedDomain}`;
export const docsUrl = `${publicOrigin}/docs`;
export const mcpUrl = `${publicOrigin}/mcp`;
export const repositoryUrl = 'https://github.com/anomalyco/nightmail';

/** Where people write to the hosted service. */
export const addresses = {
  support: `support@${hostedDomain}`,
  abuse: `abuse@${hostedDomain}`,
  privacy: `privacy@${hostedDomain}`,
  legal: `legal@${hostedDomain}`,
} as const;

/** The npm package (@banemx/sdk before the rename, now deprecated), the environment variable examples keep an API key
 * in, and the server name MCP client configs save. */
export const sdkPackage = '@nightmail/sdk';
export const apiKeyEnv = 'NIGHTMAIL_API_KEY';
export const mcpServerName = 'nightmail';
/** Environment variable names: NIGHTMAIL_<name>, else the earlier BANE_<name> (remove after rename cleanup). */
export const envNames = (name: string) => [`NIGHTMAIL_${name}`, `BANE_${name}`];

/** OAuth scope prefixes the MCP server accepts (nightmail:read, …). Which one it asks for is OAUTH_SCOPE_PREFIX
 * (config.ts): bane until account.anoma.ly supports nightmail:*. bane: remove after rename cleanup. */
export const oauthScopePrefixes = [productSlug, 'bane'] as const;
export type OauthScopePrefix = typeof oauthScopePrefixes[number];
/** The scopes an installation asks for, for read, send and manage. */
export const requestedScopes = (config: { oauthScopePrefix?: OauthScopePrefix }) => (['read', 'send', 'manage'] as const).map(p => `${config.oauthScopePrefix ?? 'bane'}:${p}`);

/** Prefixes of the secrets this service issues, by kind. New secrets get these. */
export const secretPrefixes = { apiKey: 'nm_', addressKey: 'nm_mbx_', agentToken: 'nm_agent_', supportGrant: 'nm_support_', notesKey: 'nm_notes_' } as const;
/** Earlier prefixes stay valid: bane_… and, before it, OpenSend's os_…. Remove after rename cleanup. */
export const legacySecretPrefixes = ['bane', 'os'] as const;
/** What a key list shows of a new secret: its kind's prefix and the first 8 characters after it. */
export const shownPrefix = (secret: string) => secret.slice(0, secret.lastIndexOf('_') + 9);
/** Any secret of ours (current or earlier prefix) inside text, for redaction. Use with replace or matchAll. */
export const ownSecretPattern = /\b(?:nm|bane|os)_[A-Za-z0-9_.-]{20,}/g;

/** User-Agent of the webhook deliveries this service makes. */
export const webhookUserAgent = `${productName}-Webhooks/1.0`;
/** Marks a test delivery to a webhook. Bane-Test is still sent too (remove after rename cleanup). */
export const webhookTestHeaders = [`${productName}-Test`, 'Bane-Test'] as const;

/** Request headers are X-Nightmail-<name>. */
export const headerPrefix = `X-${productName}-`;
/** A request header's accepted names, current first: X-Nightmail-, then X-Bane- and X-OpenSend- (remove after rename cleanup). */
export const requestHeaderNames = (name: string) => [productSlug, ...legacySlugs].map(slug => `x-${slug}-${name.toLowerCase()}`);
/** The first accepted name a request carries. */
export const requestHeader = (headers: { get(name: string): string | null }, name: string) => {
  for (const candidate of requestHeaderNames(name)) { const value = headers.get(candidate); if (value !== null) return value; }
  return null;
};
/** Added to mail a ritual forwards; any accepted name on incoming mail stops a forwarding loop. */
export const loopHeader = `${headerPrefix}Loop`;
export const loopHeaderNames = requestHeaderNames('loop');

/** The Domain Connect provider ID registered with DNS providers (domain-connect/bane.mx.mail.json). Never follows the brand. */
export const domainConnectProviderId = 'bane.mx';
