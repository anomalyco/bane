/**
 * The product's public identity in one place: its name, the hosted origin, the addresses people write to, and the
 * names integrations see. The API, dashboard and support Worker import this file; `bun run sdk` (in api/) copies it
 * verbatim to sdk/src/brand.ts and mcp/src/brand.ts, so edit only api/src/brand.ts. It imports nothing, so every
 * package compiles it.
 *
 * Bane is becoming Nightmail (nightmail.com). Until that domain is live the hosted service stays on bane.mx: the
 * switch is `hostedDomain`, with bane.mx moving to `previousDomains` so it stays served. The pre-rename forms a customer
 * could hold (bane_ keys, _bane proofs, X-Bane- headers, bane: scopes, bane.* cookies) were accepted until the cutover
 * and are gone now.
 */
export const productName = 'Nightmail';
/** Lowercase, for identifiers. */
export const productSlug = 'nightmail';

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
/** Environment variable names: NIGHTMAIL_<name>. */
export const envNames = (name: string) => [`NIGHTMAIL_${name}`];

/** OAuth scopes: nightmail:read, nightmail:send, nightmail:manage. */
export const oauthScopePrefixes = [productSlug] as const;
export type OauthScopePrefix = typeof oauthScopePrefixes[number];
/** The scopes an installation asks for, for read, send and manage. */
export const requestedScopes = (_config?: unknown) => (['read', 'send', 'manage'] as const).map(p => `${productSlug}:${p}`);

/** Prefixes of the secrets this service issues, by kind. New secrets get these. */
export const secretPrefixes = { apiKey: 'nm_', addressKey: 'nm_mbx_', agentToken: 'nm_agent_', supportGrant: 'nm_support_', notesKey: 'nm_notes_' } as const;
/** What a key list shows of a new secret: its kind's prefix and the first 8 characters after it. */
export const shownPrefix = (secret: string) => secret.slice(0, secret.lastIndexOf('_') + 9);
/** Any secret of ours inside text, for redaction, pre-rename ones included. Use with replace or matchAll. */
export const ownSecretPattern = /\b(?:nm|bane|os)_[A-Za-z0-9_.-]{20,}/g;

/** User-Agent of the webhook deliveries this service makes. */
export const webhookUserAgent = `${productName}-Webhooks/1.0`;
/** Marks a test delivery to a webhook. */
export const webhookTestHeaders = [`${productName}-Test`] as const;

/** Request headers are X-Nightmail-<name>. */
export const headerPrefix = `X-${productName}-`;
/** A request header's accepted names (X-Nightmail-<name>). */
export const requestHeaderNames = (name: string) => [`x-${productSlug}-${name.toLowerCase()}`];
/** The first accepted name a request carries. */
export const requestHeader = (headers: { get(name: string): string | null }, name: string) => {
  for (const candidate of requestHeaderNames(name)) { const value = headers.get(candidate); if (value !== null) return value; }
  return null;
};
/** Added to mail a ritual forwards; any accepted name on incoming mail stops a forwarding loop. */
export const loopHeader = `${headerPrefix}Loop`;
// X-Bane-Loop still stops one: mail forwarded before the rename can still arrive.
export const loopHeaderNames = [...requestHeaderNames('loop'), 'x-bane-loop'];

/** The Domain Connect provider ID registered with DNS providers (domain-connect/bane.mx.mail.json). Never follows the brand. */
export const domainConnectProviderId = 'bane.mx';
