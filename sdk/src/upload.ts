import { publicOrigin } from './brand.js'
export interface UploadAttachmentBytesOptions {
  apiUrl: string
  token: string
  filename: string
  bytes: Uint8Array | ArrayBuffer | Blob
  contentType?: string
  disposition?: 'attachment' | 'inline'
  contentId?: string
  idempotencyKey?: string
  signal?: AbortSignal
}
export interface UploadedAttachment {
  id: string
  filename: string
  contentType: string
  size: number
  disposition: 'attachment' | 'inline'
  contentId: string | null
  createdAt: string
}
export class BaneUploadError extends Error {
  constructor(message: string, readonly code: string, readonly status: number, readonly requestId?: string) { super(message); this.name = 'BaneUploadError' }
}
export { BaneUploadError as OpenSendUploadError }
// The token and file bytes go only to an HTTPS origin (HTTP only on loopback), and never follow a redirect
// to another origin: Node's fetch would otherwise resend the body there.
function apiOrigin(apiUrl: string) {
  let base: URL
  try { base = new URL(apiUrl) } catch { throw new BaneUploadError(`apiUrl must be an absolute URL such as ${publicOrigin}.`, 'INVALID_API_URL', 0) }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
  if (base.username || base.password || (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback))) {
    throw new BaneUploadError('apiUrl must be an HTTPS origin without credentials. HTTP is allowed only on loopback.', 'INVALID_API_URL', 0)
  }
  return base.origin
}
export async function uploadAttachmentBytes(options: UploadAttachmentBytesOptions): Promise<UploadedAttachment> {
  const endpoint = new URL('/v1/attachments/upload', apiOrigin(options.apiUrl))
  const bytes = options.bytes instanceof Blob ? options.bytes : new Blob([options.bytes instanceof Uint8Array ? options.bytes.slice().buffer : options.bytes])
  const response = await fetch(endpoint, {
    method: 'POST', signal: options.signal, body: bytes, redirect: 'error',
    headers: {
      Authorization: `Bearer ${options.token}`,
      'Content-Type': options.contentType ?? 'application/octet-stream',
      'X-Bane-Filename': encodeURIComponent(options.filename),
      'X-Bane-Disposition': options.disposition ?? 'attachment',
      ...(options.contentId ? { 'X-Bane-Content-Id': options.contentId } : {}),
      ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
      Accept: 'application/json',
    },
  })
  const data = await response.json().catch(() => null) as UploadedAttachment | { error?: { code?: string; message?: string; requestId?: string } } | null
  if (!response.ok) {
    const error = data && 'error' in data ? data.error : undefined
    throw new BaneUploadError(error?.message ?? 'Attachment upload failed.', error?.code ?? `HTTP_${response.status}`, response.status, error?.requestId ?? response.headers.get('x-request-id') ?? undefined)
  }
  if (!data || !('id' in data) || typeof data.id !== 'string') throw new BaneUploadError('Bane returned an invalid attachment response.', 'INVALID_RESPONSE', response.status, response.headers.get('x-request-id') ?? undefined)
  return data as UploadedAttachment
}
