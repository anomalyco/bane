import type { ReactNode } from 'react'
import { Alert, Dialog, Button, CopyButton, ErrorText, SecretCode } from '../../components/ui'
import { ApiError } from '../../data/types'

export function errorText(error: unknown) {
  return error instanceof Error ? error.message : 'Couldn’t save the change. Try again.'
}
export function fieldError(error: unknown, field: string) {
  return error instanceof ApiError ? error.fields[field] : undefined
}
export function MutationError({ error }: { error: unknown }) {
  return error ? <Alert tone="danger"><ErrorText error={error} fallback="Couldn’t save the change. Try again." /></Alert> : null
}
export function SecretDialog({ secret, title, onClose, children, description = 'Shown once. Copy it now.' }: { secret: string | null; title: string; onClose: () => void; children?: ReactNode; description?: string }) {
  // Sensitive as a whole: the secret, and any example built from it (children), never reach a UI note.
  return <Dialog sensitive open={secret !== null} onOpenChange={open => { if (!open) onClose() }} title={title} description={description} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
    <div className="settings-secret"><SecretCode>{secret}</SecretCode>{secret && <CopyButton value={secret} label="Copy secret" />}</div>
    {children}
  </Dialog>
}
