import { recentFailedRequestIds, request } from './live'

// The in-app support handoff (hosted): POST /v1/contact-support opens a support conversation for this workspace.
// `url` is the support platform's page for it, when one is configured; otherwise the reference `id` goes in an email.
export type SupportHandoff = { id: string; url: string | null; token: string | null; expiresAt: string; shareContent: boolean }
export const supportApi = {
  contact: (input: { shareContent: boolean; message?: string }) => {
    const requestIds = recentFailedRequestIds()
    return request<SupportHandoff>('/v1/contact-support', { method: 'POST', body: {
      kind: 'support', page: window.location.pathname.slice(0, 200), shareContent: input.shareContent,
      ...(requestIds.length ? { requestIds } : {}), ...(input.message ? { message: input.message } : {}),
    } })
  },
}
