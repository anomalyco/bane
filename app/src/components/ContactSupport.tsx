import { useState, type FormEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import { ArrowUpRight } from 'lucide-react'
import { supportApi, type SupportHandoff } from '../data/support'
import { MutationError } from '../features/settings/shared'
import { Button, Checkbox, CopyButton, Dialog, Field, Textarea } from './ui'

const MAX = 2000
// Hosted only: from the workspace menu and Settings → Account. Sends the page and the last failed request IDs with the
// optional message; message content is shared with support only when the person turns it on, and only for this request.
export function ContactSupportDialog({ onClose }: { onClose: () => void }) {
  const [message, setMessage] = useState('')
  const [shareContent, setShareContent] = useState(false)
  const [done, setDone] = useState<SupportHandoff | null>(null)
  const contact = useMutation({ gcTime: 0, mutationFn: supportApi.contact })
  async function submit(event: FormEvent) {
    event.preventDefault()
    try {
      const handoff = await contact.mutateAsync({ shareContent, message: message.trim() || undefined })
      if (handoff.url) window.open(handoff.url, '_blank', 'noopener')
      setDone(handoff)
    } catch { /* Shown in the form. */ }
  }
  const close = () => { if (!contact.isPending) onClose() }
  if (done) return <Dialog open onOpenChange={next => { if (!next) close() }} title={done.url ? 'Support is open in a new tab' : 'Support reference'}
    description={done.url ? 'If the tab didn’t open, use the link below. Mention this reference if you write to support later.' : 'Include this reference when you email Bane support, so they can find this request.'}
    footer={<Button variant="primary" onClick={close}>Done</Button>}>
    <div className="stack">
      <div className="contact-support__reference"><code>{done.id}</code><CopyButton value={done.id} label="Copy support reference" /></div>
      {done.url && <a className="contact-support__link" href={done.url} target="_blank" rel="noopener noreferrer">Open support<ArrowUpRight size={14} aria-hidden="true" /></a>}
    </div>
  </Dialog>
  return <Dialog open onOpenChange={next => { if (!next) close() }} title="Contact support" description="Bane support gets your message, the page you’re on and any recent errors."
    footer={<><Button disabled={contact.isPending} onClick={close}>Cancel</Button><Button variant="primary" type="submit" form="contact-support" loading={contact.isPending}>Contact support</Button></>}>
    <form id="contact-support" className="stack" onSubmit={submit}>
      <MutationError error={contact.error} />
      <Field label="Message" htmlFor="contact-support-message" hint={`Optional. ${message.length.toLocaleString('en-US')} / ${MAX.toLocaleString('en-US')}`}>
        <Textarea id="contact-support-message" value={message} maxLength={MAX} onChange={event => setMessage(event.target.value)} disabled={contact.isPending} placeholder="What were you trying to do?" autoFocus />
      </Field>
      <div className="contact-support__share">
        <Checkbox label="Share message content with support for this request" checked={shareContent} onCheckedChange={setShareContent} disabled={contact.isPending} aria-describedby="contact-support-share-hint" />
        <div id="contact-support-share-hint" className="ui-field__hint">Support can read email bodies only if this is on, and only for this request.</div>
      </div>
    </form>
  </Dialog>
}
