import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { Check } from 'lucide-react'
import { SectionHeader } from '../../components/ui'
import { useApi, useApiQuery, useSession, useWorkspaceAccess } from '../../data/context'
import { request } from '../../data/live'
import type { Identity, SendingLimit } from '../../data/types'
import { date, number } from '../../lib/format'
import { TestSend } from '../docs/first-send'
import './setup.css'

// The hosted limit as GET /v1/me reports it, refreshed with the overview so usage stays current.
export function useSendingLimit() {
  const api = useApi()
  const identity = useSession()?.identity
  const hosted = identity?.multiTenant === true && identity.connection?.kind === 'shared'
  const live = useQuery({ queryKey: ['bane', api.mode, 'sending-limit', identity?.workspaceId], enabled: hosted && api.mode === 'live', refetchInterval: 60_000, refetchIntervalInBackground: false,
    queryFn: ({ signal }) => request<Identity>('/v1/me', { signal }) })
  return hosted ? (live.data ?? identity)?.connection?.sendingLimit ?? null : null
}

export function limitSummary(limit: SendingLimit) {
  if (limit.cap === null) return 'No daily limit on this workspace.'
  return `${number(limit.used)} of ${number(limit.cap)} recipients in the last 24 hours.${limit.nextCap && limit.nextCapAt ? ` Rises to ${number(limit.nextCap)} on ${date(limit.nextCapAt, { month: 'short', day: 'numeric' })}.` : ''}`
}

export function SendingLimitBar() {
  const limit = useSendingLimit()
  if (!limit || limit.cap === null) return null
  const share = Math.min(1, limit.used / Math.max(1, limit.cap))
  return <section className="sending-limit" aria-label="Sending limit">
    <div className="sending-limit-text"><span>Sending limit</span><span className="muted">{limitSummary(limit)} Simulator addresses are free.</span></div>
    <div className={`stream-track sending-limit-track${share >= 0.9 ? ' sending-limit-track--full' : ''}`} role="meter" aria-valuemin={0} aria-valuemax={limit.cap} aria-valuenow={limit.used} aria-label="Recipients used in the last 24 hours"><span style={{ width: `${share * 100}%` }} /></div>
  </section>
}

type Step = { key: string; done: boolean; title: string; detail: ReactNode; action?: ReactNode; optional?: boolean }

// Hosted admins until the first email is sent: each step read from server state, not from this browser.
export function SetupCard() {
  const { multiTenant, canAdminister } = useWorkspaceAccess()
  const identity = useSession()?.identity
  const enabled = multiTenant && canAdminister && identity?.connection?.state === 'ready'
  const domains = useApiQuery(['domains', 'setup-card'], (api, signal) => api.domains.list({ page: 1, pageSize: 10, refresh: false }, signal), { enabled })
  const keys = useApiQuery(['keys', 'setup-card'], (api, signal) => api.keys.list(signal, undefined, false), { enabled })
  const emails = useApiQuery(['emails', 'setup-card'], (api, signal) => api.emails.list({ page: 1, pageSize: 1 }, signal), { enabled })
  // A test sent from this card keeps the card up, with its result, until the next visit.
  const [testId, setTestId] = useState<string | null>(null)
  if (!enabled || domains.isPending || keys.isPending || emails.isPending || domains.error || keys.error || emails.error) return null
  const items = domains.data.items
  const verified = items.find(domain => domain.status === 'verified')
  const pending = items.find(domain => domain.status !== 'verified')
  const receiving = items.find(domain => domain.receiving === 'verified')
  const sent = emails.data.items.length > 0 || !!testId
  if (verified && keys.data.length > 0 && sent && !testId) return null
  const steps: Step[] = [
    { key: 'domain', done: !!verified, title: 'Verify a domain',
      detail: verified ? `${verified.name} can send.` : pending ? `${pending.name} is waiting for its DNS records.` : 'Add the domain you send from and publish its DNS records.',
      action: !verified && <Link className="ui-button ui-button--secondary ui-button--md" to={pending ? `/domains/${pending.id}` : '/domains'}>{pending ? 'View records' : 'Add domain'}</Link> },
    { key: 'key', done: keys.data.length > 0, title: 'Create an API key', detail: keys.data.length > 0 ? 'Your app or agent can authenticate.' : 'A Send only key restricted to your domain is enough.',
      action: keys.data.length === 0 && <Link className="ui-button ui-button--secondary ui-button--md" to="/api-keys">Create key</Link> },
    { key: 'send', done: sent, title: 'Send your first email', detail: testId ? <>Test email queued to {identity?.email}. <Link to={`/logs/${encodeURIComponent(testId)}`}>View in Logs</Link></> : sent ? 'It’s in Logs.' : verified ? <>Send a test to yourself, or use the cURL and SDK examples in <Link to="/docs">Docs</Link>.</> : 'Possible once a domain is verified.',
      action: !sent && verified && <TestSend domain={verified} onSent={setTestId} /> },
    { key: 'receive', done: !!receiving, optional: true, title: 'Receive email', detail: receiving ? `${receiving.name} receives mail.` : 'Add the receiving MX record from a domain’s page.',
      action: !receiving && (verified ?? pending) && <Link className="ui-button ui-button--ghost ui-button--md" to={`/domains/${(verified ?? pending)!.id}`}>Set up</Link> },
  ]
  return <section className="setup-card" aria-label="Get set up">
    <SectionHeader title="Get set up" />
    <ol className="setup-steps">{steps.map((step, index) => <li key={step.key} data-done={step.done || undefined}>
      <span className="setup-mark" aria-hidden="true">{step.done ? <Check size={13} strokeWidth={2.75} /> : index + 1}</span>
      <div className="setup-text"><span className="setup-title">{step.title}{step.optional && <span className="muted"> · optional</span>}{step.done && <span className="sr-only"> (done)</span>}</span><span className="muted">{step.detail}</span></div>
      {step.action && <div className="setup-action">{step.action}</div>}
    </li>)}</ol>
  </section>
}
