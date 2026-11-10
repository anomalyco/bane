import { sql } from 'drizzle-orm';
import { ApiError, type Config } from './core.js';

// SES counts destinations, not API calls. Only the exact AWS simulator domain is exempt;
// a real address mixed into To/Cc/Bcc still consumes a slot.
const simulatorSuffix = '@simulator.amazonses.com';
export const realDestination = (address: string) => !address.toLowerCase().endsWith(simulatorSuffix);
export const hostedCost = (to: string | string[], cc: string[] = [], bcc: string[] = []) =>
  [to].flat().concat(cc, bcc).filter(realDestination).length;

export type HostedAllowance = ({ cap: number; marketingCap: number } | { cap: null; marketingCap: null }) & { used: number; resetAt: string | null; nextChangeAt: string; pauseReason: string | null; pendingCapOverride: number | null; exemptHostedQuotas: boolean; nextCap?: number | null; nextCapAt?: string | null };
// The current UTC hour plus the preceding 23 buckets. The same statement as admission,
// independent of how many envelopes or destinations were admitted in those hours.
// `read` is for display (GET /v1/me): the same figures from hosted_allowance_read, which takes no row locks.
// Admission keeps hosted_allowance, which locks the policy rows FOR SHARE against a concurrent pause or cap change.
export function hostedAllowance(config: Config, wid: string, incoming: number, marketing = 0, read = false) {
  if (!config.multiTenant) return sql<HostedAllowance | null>`NULL`;
  const { firstWeek, secondWeek, mature } = config.hostedSendCaps, fn = read ? sql`hosted_allowance_read` : sql`hosted_allowance`;
  return sql<HostedAllowance | null>`(SELECT allowance FROM ${fn}(${wid},${incoming},${marketing},${firstWeek},${secondWeek},${mature},${config.dispatch.dailyHeadroomPercent}))`;
}
const count = (value: number) => value.toLocaleString('en-US');
export function assertHostedAllowance(allowance: HostedAllowance | null, incoming: number, marketing = 0) {
  if (!allowance) return;
  if (allowance.pauseReason) throw new ApiError(409, 'HOSTED_SENDING_PAUSED', allowance.pauseReason);
  if (allowance.cap === null) return;
  const reserved = marketing > 0 && marketing + allowance.used > allowance.marketingCap;
  if (incoming && (incoming + allowance.used > allowance.cap || reserved)) {
    const resetAt = allowance.resetAt ? new Date(allowance.resetAt).toISOString() : undefined;
    const retryable = incoming <= allowance.cap && marketing <= allowance.marketingCap;
    const next = allowance.nextCap && allowance.nextCapAt ? `The limit rises to ${count(allowance.nextCap)} at ${new Date(allowance.nextCapAt).toISOString()}.` : '';
    throw new ApiError(429, 'SEND_LIMIT_REACHED', `Hosted sending is limited to ${allowance.cap} recipients per rolling 24 hours; ${count(allowance.used)} are used.${reserved ? ` Marketing stops at ${allowance.marketingCap} to reserve transactional capacity.` : ''}${resetAt ? ` The next capacity change is at ${resetAt}.` : ''}${!retryable ? ' This submission exceeds the available limit.' : ''}${next ? ` ${next}` : ''} Simulator addresses (@simulator.amazonses.com) don't count.`, undefined, retryable, resetAt);
  }
}
