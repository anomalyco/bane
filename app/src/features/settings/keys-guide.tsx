import { useState } from 'react'
import { Link } from 'react-router'
import { ChevronDown } from 'lucide-react'
import { guides } from '../inbound/concepts'
import { credentials } from '../docs/credentials'
import './api-keys.css'

// Which key do I need: one quiet line, closed until asked for, and left the way it was last time in this browser. The
// route skeleton renders it too, so the table below never moves when the page arrives.
const guideKey = 'bane.keys-guide'
export function KeysGuide() {
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(guideKey) === 'open' } catch { return false } })
  const toggle = () => {
    setOpen(!open)
    try { if (open) localStorage.removeItem(guideKey); else localStorage.setItem(guideKey, 'open') } catch { /* Stays as chosen for this visit. */ }
  }
  return <section className="keys-guide" aria-label="Which key do I need?" data-open={open || undefined}>
    <div className="keys-guide__line">
      <button type="button" className="keys-guide__toggle" aria-expanded={open} aria-controls="keys-guide-panel" onClick={toggle}>Which key do I need?<ChevronDown size={14} aria-hidden="true" /></button>
      <Link className="guide-link" to={guides.keys}>Guide</Link>
    </div>
    <div id="keys-guide-panel" className="keys-guide__panel" aria-hidden={!open} inert={!open}>
      <div><dl>{credentials.map(kind => <div key={kind.name}><dt>{kind.name}</dt><dd>{kind.line} <span className="keys-guide__where">{kind.where}</span></dd></div>)}</dl></div>
    </div>
  </section>
}
