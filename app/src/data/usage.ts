import { request } from './live'

// GET /v1/usage (hosted only): the price and the free allowance (sent and received combined), whether billing charges
// yet, this month's counts and the daily sending limit with the steps it grows through. Every workspace member may read
// it; the received count is null for members, because it includes unrouted and spam mail they can't open. The balance
// itself is GET /v1/billing (data/billing.ts).
export interface UsageStep { cap: number; requires: string }
export interface Usage {
  billing: { enabled: boolean; enforcement: 'off' | 'shadow' | 'enforce' }
  pricing: { currency: 'USD'; perThousand: number; freeEmails: number; freeStorageBytes: number }
  month: { from: string; sent: number; received: number | null }
  daily: { cap: number | null; used: number; resetAt: string | null; step: number | null } | null
  steps: UsageStep[]
  simulated: boolean
}
export const usageApi = { get: (signal?: AbortSignal) => request<Usage>('/v1/usage', { signal }) }
/** What this month costs at the published price beyond the combined free allowance. Sent mail only when the received count is hidden. */
export function monthEstimate(usage: Usage) {
  const { perThousand, freeEmails } = usage.pricing
  return Math.max(0, usage.month.sent + (usage.month.received ?? 0) - freeEmails) / 1000 * perThousand
}
