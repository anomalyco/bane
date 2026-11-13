import { hostedHosts, supportHost } from './brand.js';

// The dashboard opens a socket to the hosted support Worker beside it, so connect-src names each one. No other imports:
// the Worker's fast /health path applies these without loading the rest of the API.
const supportSources = hostedHosts.flatMap(host => [`https://${supportHost(host)}`, `wss://${supportHost(host)}`]).join(' ');
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': `default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' ${supportSources}; frame-src 'self' blob:; worker-src 'self' blob:; form-action 'self'`,
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};
