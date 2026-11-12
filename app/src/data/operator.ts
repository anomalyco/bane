import { request } from './live'
import type { SenderScore, SenderStanding, StandingStep } from './types'

// The operator API (/v1/operator/*): Bane staff with a platform role act on any Hosted workspace through one audited
// path. It is left out of the public SDK, so the /operator area calls it with the dashboard's own request helper.
export type OperatorRole = 'operator' | 'operator:read'
export interface OperatorQueueItem { workspaceId: string; name: string; step: StandingStep; since: string; score: number | null; dailyLimit: number; reasons: { code: string; message: string }[]; paused: boolean; quarantined: number; watch: boolean; strikes: number }
export interface OperatorDomain { name: string; region: string | null; pool: string; dkim: boolean; mailFrom: boolean; dmarc: string | null }
export interface OperatorMember { userId: string; email: string; role: string }
export interface OperatorCampaign { id: string; name: string; state: string; pauseReason: { code?: string; message?: string } | null; quarantines: number }
export interface OperatorWorkspace {
  workspace: { id: string; name: string; createdAt: string }; score: SenderScore; standing: SenderStanding | null
  connection: { region: string; paused: boolean; pauseReason: string | null; tenantStatusApplied: string | null } | null
  domains: OperatorDomain[]; members: OperatorMember[]; siblings: { id: string; name: string }[]
  override: { daily: number; expiresAt: string | null } | null; exempt: boolean; campaigns: OperatorCampaign[]
}
export type TimelineKind = 'standing' | 'limit' | 'quarantine' | 'release' | 'tenant' | 'operator' | 'score' | 'audit' | 'bounces' | 'rejection'
export interface OperatorTimelineItem { at: string; kind: TimelineKind; title: string; detail: unknown }
export interface OperatorAction { at: string; workspaceId: string; action: string; operatorId: string | null; via: string | null; reason: string | null; ticketRef: string | null; requestId: string | null; before: unknown; after: unknown; details: unknown }
export type OperatorReceipt = { ok: true; version: number | null; step: string | null }
/** Every mutation carries why (10–1000 characters) and optionally the support ticket. */
export type OperatorWhy = { reason: string; ticketRef?: string }
/** One key per dialog opening, so a retried submit is answered once; If-Match is the standing version it was decided on. */
export type OperatorGuard = { idempotencyKey: string; ifMatch?: number }

// Timestamps arrive in Postgres text form ("2026-11-12 10:00:00.123456+00"); the API's `before` takes ISO-8601.
export function isoTime(value: string) {
  const iso = value.trim().replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1').replace(/([+-]\d\d)$/, '$1:00')
  const at = Date.parse(iso)
  return Number.isFinite(at) ? new Date(at).toISOString() : value
}

const base = '/v1/operator', id = encodeURIComponent
const query = (values: Record<string, string | number | undefined>) => { const params = new URLSearchParams(); for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== '') params.set(key, String(value)); const text = params.toString(); return text ? `?${text}` : '' }
const why = ({ reason, ticketRef }: OperatorWhy) => ({ reason: reason.trim(), ...ticketRef?.trim() ? { ticketRef: ticketRef.trim() } : {} })
const write = (path: string, method: 'POST' | 'PUT', body: unknown, guard: OperatorGuard) => request<OperatorReceipt>(`${base}${path}`, { method, body, idempotencyKey: guard.idempotencyKey, ifMatch: guard.ifMatch })

export const operatorApi = {
  queue: async (input: { step?: StandingStep; q?: string }, signal?: AbortSignal) => (await request<{ data: OperatorQueueItem[] }>(`${base}/workspaces${query({ step: input.step, q: input.q?.trim(), limit: 100 })}`, { signal })).data,
  workspace: (workspaceId: string, signal?: AbortSignal) => request<OperatorWorkspace>(`${base}/workspaces/${id(workspaceId)}`, { signal }),
  timeline: async (workspaceId: string, before: string | undefined, signal?: AbortSignal) => {
    const page = await request<{ data: OperatorTimelineItem[]; nextBefore: string | null }>(`${base}/workspaces/${id(workspaceId)}/timeline${query({ before, limit: 50 })}`, { signal })
    return { items: page.data, nextBefore: page.nextBefore ? isoTime(page.nextBefore) : null }
  },
  actions: async (input: { workspaceId?: string; before?: string }, signal?: AbortSignal) => (await request<{ data: OperatorAction[] }>(`${base}/actions${query({ workspaceId: input.workspaceId, before: input.before, limit: 50 })}`, { signal })).data,
  pause: (workspaceId: string, input: OperatorWhy, guard: OperatorGuard) => write(`/workspaces/${id(workspaceId)}/pause`, 'POST', why(input), guard),
  resume: (workspaceId: string, input: OperatorWhy & { restore: 50 | 100 }, guard: OperatorGuard) => write(`/workspaces/${id(workspaceId)}/resume`, 'POST', { ...why(input), restore: input.restore }, guard),
  marketing: (workspaceId: string, input: OperatorWhy & { held: boolean }, guard: OperatorGuard) => write(`/workspaces/${id(workspaceId)}/marketing`, 'PUT', { held: input.held, ...why(input) }, guard),
  limit: (workspaceId: string, input: OperatorWhy & { daily: number | null; expiresAt: string | null }, guard: OperatorGuard) => write(`/workspaces/${id(workspaceId)}/limit`, 'PUT', { daily: input.daily, expiresAt: input.daily === null ? null : input.expiresAt, ...why(input) }, guard),
  releaseCampaign: (campaignId: string, input: OperatorWhy, guard: OperatorGuard) => write(`/campaigns/${id(campaignId)}/release`, 'POST', why(input), guard),
}
