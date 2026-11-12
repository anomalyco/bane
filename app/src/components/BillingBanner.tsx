import { Link, useLocation } from 'react-router'
import { CreditCard, OctagonAlert } from 'lucide-react'
import { useSession, useWorkspaceAccess } from '../data/context'

// An empty balance on every dashboard page, once billing is enforced: sending paused, received mail held, or
// auto-recharge turned off after a failed charge. The state comes with the session (GET /v1/me), so the banner is in
// place on the shell's first paint and never pushes a page down after it renders. Admins get Add credit; members are
// told who can fix it. It shares the standing banner's look.
const COPY = {
  held: { what: 'Received mail is being held: the balance has been below $0 for 7 days.', did: 'New mail is stored, not delivered to inboxes, webhooks or IMAP. Nothing is deleted.', tone: 'danger' },
  paused: { what: 'Sending is paused: your balance is empty.', did: 'Sends get 402 and campaigns wait; received mail is still accepted. Nothing is deleted.', tone: 'danger' },
  recharge: { what: 'Auto-recharge is off: the last charge to your card failed.', did: 'Sending continues until the balance runs out. Update the card, then turn it back on.', tone: 'warning' },
} as const

export function BillingBanner() {
  const billing = useSession()?.identity?.billing
  const { canAdminister } = useWorkspaceAccess()
  const { pathname, hash } = useLocation()
  // A free workspace (courtesy of Anomaly) never shows a balance banner.
  if (!billing || billing.enforcement !== 'enforce' || billing.free) return null
  const kind = billing.receiving === 'held' ? 'held' : billing.sending === 'paused' ? 'paused' : billing.autoRecharge === 'failed' ? 'recharge' : null
  if (!kind) return null
  const copy = COPY[kind], here = pathname === '/settings' && hash === '#billing'
  const Icon = kind === 'recharge' ? CreditCard : OctagonAlert
  return <div className={`standing-banner billing-banner ui-tone--${copy.tone}`} role={kind === 'recharge' ? 'status' : 'alert'} data-billing={kind}>
    <Icon className="standing-banner__icon" size={16} aria-hidden="true" />
    <div className="standing-banner__text">
      <p className="standing-banner__what">{copy.what}</p>
      <p className="standing-banner__did">{canAdminister ? copy.did : 'Ask a workspace owner or admin to add credit in Settings → Billing.'}</p>
    </div>
    {canAdminister && !here && <Link className="ui-button ui-button--secondary ui-button--sm standing-banner__fix" to="/settings#billing">{kind === 'recharge' ? 'Update card' : 'Add credit'}</Link>}
  </div>
}
