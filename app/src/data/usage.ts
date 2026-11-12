import { request } from './live'

// GET /v1/usage (hosted only): pricing as information (billing is not on yet), this month's counts and the daily
// sending limit with the steps it grows through. Every workspace member may read it; the received count is null for
// members, because it includes unrouted and spam mail they can't open.
export interface UsageStep { cap: number; requires: string }
export interface Usage {
  billing: { enabled: false }
  pricing: { currency: 'USD'; perThousand: number; freeSent: number; freeReceived: number }
  month: { from: string; sent: number; received: number | null }
  daily: { cap: number | null; used: number; resetAt: string | null; step: number | null } | null
  steps: UsageStep[]
  simulated: boolean
}
export const usageApi = { get: (signal?: AbortSignal) => request<Usage>('/v1/usage', { signal }) }
/** What this month would cost at the published price; zero while it stays within the free allowance. Sent mail only when the received count is hidden. */
export function monthEstimate(usage: Usage) {
  const { perThousand, freeSent, freeReceived } = usage.pricing
  return (Math.max(0, usage.month.sent - freeSent) + Math.max(0, (usage.month.received ?? 0) - freeReceived)) / 1000 * perThousand
}
