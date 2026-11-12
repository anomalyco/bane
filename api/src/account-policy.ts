import type { Config } from './core.js';

export const googleAcr = 'urn:anomaly:acr:google';

export function canCreateWorkspace(config: Config, email: string, acr: unknown) {
  const address = email.toLowerCase();
  if (config.allowedEmails.includes(address)) return true;
  return config.multiTenant && acr === googleAcr && (config.allowedSignupDomains ?? []).includes(address.split('@').at(-1)!);
}
