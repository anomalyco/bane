import { GOOGLE_ACR } from './config.js';
import type { Config } from './core.js';

// Who may sign up, decided by the sign-in itself and never by an email address: Anomaly account can assert a
// verified address that the method used to sign in never vouched for (a GitHub-made account that later links a
// personal Google account signs in with acr=google and its GitHub-verified work address).
//
// The account service is adding a claim that describes the provider identity behind this sign-in. Its name is
// provisional until the account service publishes it; everything that reads it goes through providerIdentity().
export const PROVIDER_IDENTITY_CLAIM = 'provider_identity';

export type ProviderIdentity = { provider: string; sub: string; email: string | null; emailVerified: boolean; hd: string | null };

/** The provider identity behind this sign-in, from a verified ID token or a subject-checked UserInfo response. */
export function providerIdentity(source: Record<string, unknown> | null | undefined): ProviderIdentity | null {
  const value = source?.[PROVIDER_IDENTITY_CLAIM];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  if (typeof p.provider !== 'string' || typeof p.sub !== 'string' || !p.provider || !p.sub) return null;
  return { provider: p.provider, sub: p.sub, email: typeof p.email === 'string' ? p.email : null, emailVerified: p.email_verified === true,
    hd: typeof p.hd === 'string' && p.hd ? p.hd.toLowerCase() : null };
}

/** Hosted staff: this sign-in used Google, and the Google account belongs to a staff Google Workspace domain (hd). */
export function isStaffSignIn(config: Pick<Config, 'multiTenant' | 'accountRequiredAcr' | 'staffGoogleDomains'>, acr: unknown, provider: ProviderIdentity | null) {
  return config.multiTenant && config.accountRequiredAcr === GOOGLE_ACR && acr === GOOGLE_ACR
    && provider?.provider === 'google' && !!provider.hd && config.staffGoogleDomains.includes(provider.hd);
}
