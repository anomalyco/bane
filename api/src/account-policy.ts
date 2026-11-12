import { GOOGLE_ACR } from './config.js';
import type { Config } from './core.js';

// Who may sign up, decided by the sign-in itself and never by an email address: Anomaly account can assert a
// verified address that the method used to sign in never vouched for (a GitHub-made account that later links a
// personal Google account signs in with acr=google and its GitHub-verified work address).
//
// Anomaly account's claim for the provider identity behind this sign-in: {provider, sub, email, email_verified, hd?}
// from the provider used for this sign-in, omitted when there is none. Requested as an essential ID-token claim.
export const PROVIDER_IDENTITY_CLAIM = 'https://account.anoma.ly/claims/upstream';

export type ProviderIdentity = { provider: string; sub: string; email: string | null; emailVerified: boolean; hd: string | null };

/** The provider identity behind this sign-in, from a verified ID token or a subject-checked UserInfo response. */
export function providerIdentity(source: Record<string, unknown> | null | undefined): ProviderIdentity | null {
  const value = source?.[PROVIDER_IDENTITY_CLAIM];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  if (typeof p.provider !== 'string' || typeof p.sub !== 'string' || !p.provider || !p.sub) return null;
  return { provider: p.provider, sub: p.sub, email: typeof p.email === 'string' ? p.email : null, emailVerified: p.email_verified === true,
    hd: typeof p.hd === 'string' && p.hd ? p.hd : null };
}

/** Hosted staff, exactly as the account service defines it: a Google sign-in whose Google account has a verified
 * address and belongs to a staff Google Workspace domain (hd, compared exactly). */
export function isStaffSignIn(config: Pick<Config, 'multiTenant' | 'accountRequiredAcr' | 'staffGoogleDomains'>, acr: unknown, upstream: ProviderIdentity | null) {
  return config.multiTenant && config.accountRequiredAcr === GOOGLE_ACR && acr === GOOGLE_ACR
    && upstream?.provider === 'google' && upstream.emailVerified === true && !!upstream.hd && config.staffGoogleDomains.includes(upstream.hd);
}
