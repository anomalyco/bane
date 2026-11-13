import { ApiError } from './types'

// The consent page of Bane's MCP authorization server (api/src/oauth-server.ts, /api/oauth/*). Each call names the account
// it acts as (X-Bane-Account): the one picked on the page, which may not be the tab's own.
export type OAuthRequest = {
  id: string; flow: 'code' | 'device'; scopes: string[]; profile: string | null; expiresAt: string
  client: { id: string; name: string | null; domain: string | null }
  redirect: { kind: 'web' | 'loopback' | 'app' | null; host: string } | null
  device: { userCode: string; ip: string | null; country: string | null; requestedAt: string } | null
}
export type OAuthAnswer = { redirect: string } | { done: true }

async function call<T>(path: string, account: string | null, body?: object): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, { method: body ? 'POST' : 'GET', credentials: 'include',
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(account ? { 'X-Bane-Account': account } : {}) },
      body: body ? JSON.stringify(body) : undefined })
  } catch { throw new ApiError('Cannot reach Bane. Check your connection and try again.', 'NETWORK_UNAVAILABLE') }
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new ApiError(data?.error?.message ?? 'Couldn’t complete the request.', data?.error?.code ?? `HTTP_${response.status}`, {}, data?.error?.requestId, response.status)
  return data as T
}

export const oauthApi = {
  request: (id: string, account: string | null) => call<OAuthRequest>(`/api/oauth/requests/${encodeURIComponent(id)}`, account),
  approve: (id: string, account: string, input: { workspaceId: string; scopes: string[]; receiving: boolean }) => call<OAuthAnswer>(`/api/oauth/requests/${encodeURIComponent(id)}/approve`, account, input),
  deny: (id: string, account: string) => call<OAuthAnswer>(`/api/oauth/requests/${encodeURIComponent(id)}/deny`, account, {}),
  device: (code: string, account: string | null) => call<{ id: string }>('/api/oauth/device', account, { code }),
}

/** A browser destination the consent page may navigate to: only what the server answered, and never a script URL. */
export function safeRedirect(value: string) {
  try { const url = new URL(value); return /^(?:javascript|data|vbscript|file|blob):$/i.test(url.protocol) ? null : url.href } catch { return null }
}
