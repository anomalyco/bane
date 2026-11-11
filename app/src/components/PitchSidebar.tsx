import { Link, useLocation } from 'react-router'
import { Check } from 'lucide-react'
import type { Design } from '../lib/design'
import { SidebarScore } from '../features/score'
import { useSetupSteps } from '../features/overview/setup'
import '../features/overview/designs.css'

// Pitch sidebar additions, loaded only when ?design= is set (see AppShell). Direction B splits the sidebar:
// navigation on top, setup steps in the middle while setup is unfinished, the score card at the bottom.
export default function PitchSidebar({ design, part }: { design: Exclude<Design, 'current'>; part: 'middle' | 'footer' }) {
  if (part === 'footer') return <SidebarScore variant={design} />
  return design === 'b' ? <SidebarSetup /> : null
}

function SidebarSetup() {
  const setup = useSetupSteps()
  const { pathname } = useLocation()
  if (!setup) return null
  const required = setup.steps.filter(step => !step.optional)
  return <section className="sidebar-steps" aria-label="Setup">
    <div className="sidebar-steps__head"><span>Setup</span><span className="muted">{required.filter(step => step.done).length}/{required.length}</span></div>
    <ol>{setup.steps.map((step, index) => <li key={step.key}>
      <Link to={step.to} data-done={step.done || undefined} data-current={step === setup.current || undefined} aria-current={pathname === step.to ? 'page' : undefined}>
        <span className="setup-rail__mark" aria-hidden="true">{step.done ? <Check size={11} strokeWidth={2.75} /> : index + 1}</span>
        <span>{step.short}</span>
        {step.optional && <span className="muted">Optional</span>}
      </Link>
    </li>)}</ol>
  </section>
}
