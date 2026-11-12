import { sql, type SQL } from 'drizzle-orm';
import { ApiError, type Config } from './core.js';

// Simulator feedback is not reputation evidence. Admission and dispatch,
// however, consume capacity for every destination, including the simulator.
const simulatorSuffix = '@simulator.amazonses.com';
export const realDestination = (address: string) => !address.toLowerCase().endsWith(simulatorSuffix);
export const hostedCost = (to: string | string[], cc: string[] = [], bcc: string[] = []) =>
  (Array.isArray(to) ? to.length : 1) + cc.length + bcc.length;

export type HostedAllowance = ({ cap: number; marketingCap: number } | { cap: null; marketingCap: null }) & { used: number; resetAt: string | null; nextChangeAt: string; pauseReason: string | null; pendingCapOverride: number | null; exemptHostedQuotas: boolean; nextCap?: number | null; nextCapAt?: string | null; marketingHeld?: boolean; marketingHoldReason?: string | null; step?: string };
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
  if (marketing > 0 && allowance.marketingHeld) throw marketingHeld(allowance.marketingHoldReason);
  if (allowance.cap === null) return;
  const reserved = marketing > 0 && marketing + allowance.used > allowance.marketingCap;
  if (incoming && (incoming + allowance.used > allowance.cap || reserved)) {
    const resetAt = allowance.resetAt ? new Date(allowance.resetAt).toISOString() : undefined;
    const retryable = incoming <= allowance.cap && marketing <= allowance.marketingCap;
    throw new ApiError(429, 'SEND_LIMIT_REACHED', `Hosted sending is limited to ${allowance.cap} recipients per rolling 24 hours; ${count(allowance.used)} are used.${reserved ? ` Marketing stops at ${allowance.marketingCap} to reserve transactional capacity.` : ''}${resetAt ? ` Rolling usage expires at ${resetAt}.` : ''}${!retryable ? ' This submission exceeds the available limit.' : ''}`, undefined, retryable, resetAt);
  }
}

/**
 * The stream a marketing hold stops, as an expression over a sending_emails row: marketing mail and every campaign
 * row. Admission, campaign release and dispatch (owner selection and the final election) use the same rule.
 */
export const heldStream = (e: SQL) => sql`(${e}.snapshot->>'kind'<>'transactional' OR ${e}.campaign_id IS NOT NULL)`;
/**
 * Restrict, an operator's hold, or a marketing hold placed before the standing took over (bounces only): marketing is
 * refused while transactional mail keeps flowing. `reason` is that older hold's own message.
 */
export const marketingHeld = (reason?: string | null) => new ApiError(409, 'MARKETING_HELD', reason ? `${reason} Remove the addresses that bounced; Bane reviews the hold.`
  : 'Marketing from this workspace is held while its sending standing is restricted: bounces or complaints crossed a published line (see GET /v1/sender-score). Transactional mail still sends. Fix the list, then release it from the dashboard or ask for a review.');
