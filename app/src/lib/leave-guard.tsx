import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { Button, Dialog } from '../components/ui'

/**
 * Asks before unsaved work is lost: reloading or closing the tab (the browser's own prompt) and following a link
 * inside the dashboard, the sidebar included (a dialog that can save first). The app uses BrowserRouter, which has no
 * navigation blocker, so in-app links are caught on their way to React Router's handler.
 */
export function useLeaveGuard(dirty: boolean, { what = 'your changes', save }: { what?: string; save?: () => Promise<boolean> } = {}) {
  const navigate = useNavigate()
  const [target, setTarget] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const latest = useRef(dirty)
  latest.current = dirty
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => { if (latest.current) { event.preventDefault(); event.returnValue = '' } }
    const click = (event: MouseEvent) => {
      if (!latest.current || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const link = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!link || (link.target && link.target !== '_self') || link.hasAttribute('download')) return
      const url = new URL(link.href, window.location.href)
      // Other sites get the browser's prompt; a link to this same page (a #section) loses nothing.
      if (url.origin !== window.location.origin || (url.pathname === window.location.pathname && url.search === window.location.search)) return
      event.preventDefault(); event.stopPropagation()
      setTarget(`${url.pathname}${url.search}${url.hash}`)
    }
    window.addEventListener('beforeunload', unload)
    document.addEventListener('click', click, true)
    return () => { window.removeEventListener('beforeunload', unload); document.removeEventListener('click', click, true) }
  }, [])
  function leave(to: string) { latest.current = false; setTarget(null); navigate(to) }
  async function saveAndLeave() {
    if (!save || !target) return
    setSaving(true)
    try { if (await save()) leave(target) } finally { setSaving(false) }
  }
  return <Dialog open={target !== null} onOpenChange={open => { if (!open && !saving) setTarget(null) }} title="Leave without saving?" description={`You haven’t saved ${what}. Leaving now discards them.`}
    footer={<><Button disabled={saving} onClick={() => setTarget(null)}>Stay</Button><Button variant="danger" disabled={saving} onClick={() => target && leave(target)}>Discard and leave</Button>{save && <Button variant="primary" loading={saving} onClick={() => void saveAndLeave()}>Save and leave</Button>}</>}>
    <span className="sr-only">Stay on this page to keep editing.</span>
  </Dialog>
}
