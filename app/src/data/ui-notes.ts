import { request, selectedAccount } from './live'
import { ApiError } from './types'

// UI notes (/v1/operator/ui-notes): Bane staff's design and bug notes on the dashboard itself, global to the deployment.
// Left out of the public SDK, like the rest of the operator API, so the dashboard calls it with its own request helper.
export const noteKinds = ['alignment', 'spacing', 'copy', 'bug', 'motion', 'mobile', 'other'] as const
export const noteSeverities = ['low', 'medium', 'high'] as const
export const noteStatuses = ['open', 'in_progress', 'fixed', 'wontfix'] as const
export type NoteKind = typeof noteKinds[number]
export type NoteSeverity = typeof noteSeverities[number]
export type NoteStatus = typeof noteStatuses[number]
export const statusLabel: Record<NoteStatus, string> = { open: 'Open', in_progress: 'In progress', fixed: 'Fixed', wontfix: 'Won’t fix' }
export const resolved = (status: NoteStatus) => status === 'fixed' || status === 'wontfix'

export interface NoteElement {
  selector: string; alternatives: string[]; testId: string | null; component: string | null; components: string[]
  tag: string; role: string | null; label: string | null; text: string | null
  box: { x: number; y: number; width: number; height: number; scrollX: number; scrollY: number }
  styles: Record<string, string>
}
export interface NoteContext { viewport: { width: number; height: number }; dpr: number; theme: 'light' | 'dark'; device: 'phone' | 'tablet' | 'desktop'; pointer: 'fine' | 'coarse'; build: string; title?: string }
export interface UiNote {
  id: string; body: string; kind: NoteKind; severity: NoteSeverity | null; status: NoteStatus; prUrl: string | null; resolution: string | null
  page: { url: string; path: string; route: string }; context: NoteContext; element: NoteElement
  screenshot: { url: string; expiresAt: string; contentType: string; bytes: number; width: number | null; height: number | null } | null
  author: { id: string; name: string | null } | null; updatedBy: { id: string; name: string | null } | null
  createdAt: string; updatedAt: string; resolvedAt: string | null
}
export type NewNote = { body: string; kind: NoteKind; severity: NoteSeverity | null; url: string; route: string; context: NoteContext; element: NoteElement }
export type NotePatch = Partial<Pick<UiNote, 'body' | 'kind' | 'severity' | 'status' | 'prUrl' | 'resolution'>>
export interface NoteKey { id: string; name: string; prefix: string; createdAt: string; expiresAt: string; lastUsedAt: string | null; revokedAt: string | null }
export type NoteFilter = { route?: string; status?: NoteStatus[]; kind?: NoteKind[]; q?: string; cursor?: string; limit?: number }

const base = '/v1/operator/ui-notes', id = encodeURIComponent
const query = (filter: NoteFilter) => {
  const params = new URLSearchParams()
  if (filter.route) params.set('route', filter.route)
  if (filter.status?.length) params.set('status', filter.status.join(','))
  if (filter.kind?.length) params.set('kind', filter.kind.join(','))
  if (filter.q?.trim()) params.set('q', filter.q.trim())
  if (filter.cursor) params.set('cursor', filter.cursor)
  params.set('limit', String(filter.limit ?? 100))
  return `?${params}`
}
export const uiNotesKey = ['ui-notes'] as const

export const uiNotesApi = {
  list: (filter: NoteFilter, signal?: AbortSignal) => request<{ data: UiNote[]; nextCursor: string | null }>(`${base}${query(filter)}`, { signal }),
  get: (noteId: string, signal?: AbortSignal) => request<UiNote>(`${base}/${id(noteId)}`, { signal }),
  create: (input: NewNote) => request<UiNote>(base, { method: 'POST', body: input }),
  update: (noteId: string, patch: NotePatch) => request<UiNote>(`${base}/${id(noteId)}`, { method: 'PATCH', body: patch }),
  remove: (noteId: string) => request<{ id: string; deleted: true }>(`${base}/${id(noteId)}`, { method: 'DELETE' }),
  // The image goes up as the request body, not JSON, with the account this tab acts as.
  async screenshot(noteId: string, shot: { blob: Blob; width: number; height: number }) {
    const account = selectedAccount()
    const response = await fetch(`${base}/${id(noteId)}/screenshot?width=${shot.width}&height=${shot.height}`, { method: 'PUT', credentials: 'include', body: shot.blob,
      headers: { Accept: 'application/json', 'Content-Type': shot.blob.type, ...(account ? { 'X-Bane-Account': account } : {}) } })
    const data = await response.json().catch(() => null)
    if (!response.ok) throw new ApiError(data?.error?.message ?? 'Couldn’t upload the screenshot.', data?.error?.code ?? `HTTP_${response.status}`, {}, data?.error?.requestId, response.status)
    return data as UiNote
  },
  keys: {
    list: async (signal?: AbortSignal) => (await request<{ data: NoteKey[] }>('/v1/operator/ui-note-keys', { signal })).data,
    create: (input: { name: string; expiresInDays: number }) => request<NoteKey & { secret: string }>('/v1/operator/ui-note-keys', { method: 'POST', body: input }),
    revoke: (keyId: string) => request<{ id: string; revoked: true }>(`/v1/operator/ui-note-keys/${id(keyId)}/revoke`, { method: 'POST' }),
  },
}
