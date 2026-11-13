import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Alert, Button, Checkbox, Dialog, useToast } from '../../components/ui'
import { useApi, useWorkspaceAccess } from '../../data/context'
import type { SenderScore, SenderStanding } from '../../data/types'
import { shortDateTime } from '../../lib/format'
import { releaseLabel, standingDid, standingFallback, standingTitle, standingTone, stepAtLeast, type RaisedStep } from '../../lib/standing'
import { productName } from '../../../../api/src/brand'

// Overview's standing card, from Warn up: what happened (each reason, with its numbers), what Nightmail did, and the fix
// checklist. Owners and admins release a restrict or a bounce-only pause here once the API offers it; members read it.
export function StandingCard({ report }: { report: SenderScore }) {
  const { canAdminister } = useWorkspaceAccess()
  const [releasing, setReleasing] = useState(false)
  const standing = report.standing
  if (!standing || !stepAtLeast(standing.step, 'warn')) return null
  const step = standing.step as RaisedStep, offer = standing.selfService
  return <section id="standing" className={`standing-card ui-tone--${standingTone(step)}`} aria-labelledby="standing-title" data-step={step}>
    <div className="standing-card__head"><span className="standing-card__dot" aria-hidden="true" /><h2 id="standing-title">{standingTitle[step]}</h2><span className="muted">Since {shortDateTime(standing.since)}</span></div>
    <div className="standing-card__part"><h3>What happened</h3>
      {standing.reasons.length ? <ul>{standing.reasons.map(reason => <li key={reason.code}>{reason.message}</li>)}</ul> : <p>{standingFallback[step]}</p>}
    </div>
    <div className="standing-card__part"><h3>What {productName} did</h3><p>{standingDid[step]}{didExtra(standing)}</p></div>
    <div className="standing-card__part"><h3>How to fix it</h3>
      <ol className="standing-checklist">
        <li>Remove contacts that bounced or complained. <Link to="/audience">Audience</Link></li>
        <li>Confirm every contact opted in; stop mailing bought or old lists.</li>
        {step === 'warn' && <li>This clears by itself after 24 hours under 80% of the line.</li>}
      </ol>
    </div>
    {(step !== 'warn' || offer.available) && <div className="standing-card__action">
      {offer.available && offer.action ? canAdminister ? <Button variant="primary" onClick={() => setReleasing(true)}>{releaseLabel[offer.action]}</Button>
        : <p className="muted">Owners and admins can {releaseLabel[offer.action].toLowerCase()} once the checklist is done.</p>
        : <p className="muted">{offer.reason ?? 'This needs a review.'}{offer.availableAt ? ` Available from ${shortDateTime(offer.availableAt)} UTC.` : ''}</p>}
    </div>}
    <Link className="standing-card__docs" to="/docs#sending-limits">How sending limits work</Link>
    {offer.action && canAdminister && <ReleaseDialog open={releasing} onOpenChange={setReleasing} action={offer.action} />}
  </section>
}
function didExtra(standing: SenderStanding) {
  const parts = []
  if (standing.marketingRelease) parts.push(`Marketing is released at ${standing.marketingRelease.percent}% of its allowance until ${shortDateTime(standing.marketingRelease.until)} UTC.`)
  if (standing.strikes > 0 && standing.step === 'pause') parts.push(`${standing.strikes === 1 ? 'This is the first pause' : `This is pause ${standing.strikes}`} in 90 days.`)
  return parts.length ? ` ${parts.join(' ')}` : ''
}

const releaseCopy = {
  release_marketing: { title: 'Release marketing?', description: 'Marketing resumes at 50% of its allowance for 48 hours. You can do this once every 14 days.', done: 'Marketing released' },
  resume_sending: { title: 'Resume sending?', description: 'Sending resumes at 50% of the limit for 48 hours; marketing stays held for the first 24. You can do this once every 30 days.', done: 'Sending resumed' },
} as const
// Both checklist items are required; the API re-checks the last 24 hours before it releases anything.
function ReleaseDialog({ open, onOpenChange, action }: { open: boolean; onOpenChange: (open: boolean) => void; action: keyof typeof releaseCopy }) {
  const api = useApi(), client = useQueryClient(), toast = useToast()
  const [removed, setRemoved] = useState(false), [confirmed, setConfirmed] = useState(false)
  const release = useMutation({
    mutationFn: () => api.senderScore.release({ checklist: { bouncedRemoved: true, listSourceConfirmed: true } }),
    onSuccess: report => {
      // The response is the new score and standing: show it now, then reread the session's summary (the banner).
      client.setQueryData(['bane', api.mode, 'sender-score'], report)
      void client.invalidateQueries({ queryKey: ['identity'] })
      void client.invalidateQueries({ predicate: query => query.queryKey[0] === 'bane' && ['sending-limit', 'campaigns'].includes(String(query.queryKey[2])) })
      toast(releaseCopy[action].done, 'success')
      onOpenChange(false)
    },
  })
  const { reset } = release
  useEffect(() => { if (open) { setRemoved(false); setConfirmed(false); reset() } }, [open, reset])
  const copy = releaseCopy[action]
  return <Dialog open={open} onOpenChange={next => { if (!release.isPending) onOpenChange(next) }} title={copy.title} description={copy.description}
    footer={<><Button disabled={release.isPending} onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" disabled={!removed || !confirmed} loading={release.isPending} onClick={() => release.mutate()}>{releaseLabel[action]}</Button></>}>
    <div className="standing-release">
      <Checkbox checked={removed} onCheckedChange={setRemoved} label="Contacts that bounced or complained are removed." />
      <Checkbox checked={confirmed} onCheckedChange={setConfirmed} label="Every contact opted in; no bought or old lists." />
      {release.error && <Alert tone="danger">{release.error instanceof Error ? release.error.message : 'Couldn’t release. Try again.'}</Alert>}
    </div>
  </Dialog>
}
