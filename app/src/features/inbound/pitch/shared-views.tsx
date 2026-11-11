import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Check } from 'lucide-react'
import { Button, LoadingRegion } from '../../../components/ui'
import type { Model } from './model'

export function PitchSkeleton({ variant = 'table' }: { variant?: 'table' | 'flow' | 'rail' }) {
  return <LoadingRegion label="Loading receiving"><div className={`pitch-skeleton pitch-skeleton--${variant}`} aria-hidden="true"><span /><span /><span /><span /></div></LoadingRegion>
}

function Step({ n, done, title, children }: { n: number; done?: boolean; title: string; children: ReactNode }) {
  return <li className="pitch-step" data-done={done || undefined}>
    <span className="pitch-step__n" aria-hidden="true">{done ? <Check size={13} /> : n}</span>
    <div className="pitch-step__body"><h3>{title}</h3>{children}</div>
  </li>
}

/** A new account: the same three stages every direction is built on, each with the one action that starts it. */
export function GettingStarted({ model, onCreate, compact = false }: { model: Model; onCreate?: () => void; compact?: boolean }) {
  const receives = model.receiving.some(d => d.status === 'active')
  const sendOnly = model.sendOnly.map(d => d.name)
  return <ol className="pitch-steps" data-compact={compact || undefined}>
    <Step n={1} done={receives} title="Receive on a domain">
      <p className="muted">{receives ? `${model.receiving.filter(d => d.status === 'active').map(d => d.name).join(', ')} receives mail.` : sendOnly.length ? `${sendOnly.join(', ')} only sends. Add its MX record to receive too.` : 'Add a domain and its MX record.'}</p>
      {!receives && <Link className="ui-button ui-button--secondary ui-button--md" to="/domains">Open Domains</Link>}
    </Step>
    <Step n={2} title="Create an address">
      <p className="muted">Mail to it lands in the Inbox, where you, the API and agents read it.</p>
      <Button disabled={!receives} onClick={onCreate}>New address</Button>
    </Step>
    <Step n={3} title="Choose what happens">
      <p className="muted">Optional. A ritual labels, filters or forwards mail; destinations are webhooks, Slack, Discord and forwards.</p>
      <div className="cluster"><Link className="ui-button ui-button--ghost ui-button--md" to="/receiving/rituals">Rituals</Link><Link className="ui-button ui-button--ghost ui-button--md" to="/receiving/endpoints">Destinations</Link></div>
    </Step>
    {!compact && <li className="pitch-steps__aside muted">Testing sign-up mail? An <Link to="/receiving/inboxes">agent inbox</Link> works before any DNS is set up.</li>}
  </ol>
}
