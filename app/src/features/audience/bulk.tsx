import { useEffect, useState } from 'react'
import { useApiMutation, useApiQuery } from '../../data/context'
import { Button, Checkbox, Dialog, Field, Input, LoadingRegion, SkeletonText, Alert, useToast } from '../../components/ui'
import { PrivateAddress } from '../../components/PrivateAddress'
import { aqlString, MutationError, number } from './shared'

// "Mark as subscribed…" for contacts with no consent decision (Unknown), on one list or in the whole audience. AudienceQL
// plans the change first (count, sample, warnings); the person attests consent and says how it was given; apply then
// changes exactly the planned contacts and stores that evidence on each consent record. Opt-outs and suppressions stay.
export function BulkSubscribeDialog({ listId, listName, searchIgnored = false, onClose }: { listId?: string; listName?: string; searchIgnored?: boolean; onClose: () => void }) {
  const toast = useToast()
  const list = useApiQuery(['lists', listId ?? ''], (api, signal) => api.lists.get(listId!, signal), { enabled: Boolean(listId) && !listName })
  const name = listName ?? list.data?.name
  const statement = `UPDATE contacts SET consent = 'subscribed' WHERE consent = 'unknown' AND suppressed = FALSE${listId ? ` AND list = ${aqlString(listId)}` : ''}`
  const plan = useApiMutation((api, value: string) => api.audienceQuery.plan(value), undefined, false, false)
  const apply = useApiMutation((api, input: { planId: string; evidence: string; confirmResubscribe: boolean }) => api.audienceQuery.apply(input))
  const [evidence, setEvidence] = useState(''), [attested, setAttested] = useState(false), [resubscribe, setResubscribe] = useState(false), [checked, setChecked] = useState(false)
  const { mutate: count } = plan
  useEffect(() => { count(statement) }, [count, statement])
  const ready = plan.data && plan.data.matched > 0
  const missingEvidence = checked && !evidence.trim(), missingAttestation = checked && !attested, missingResubscribe = checked && Boolean(plan.data?.requiresResubscribeConfirmation) && !resubscribe
  function recount() { apply.reset(); setChecked(false); count(statement) }
  async function submit() {
    setChecked(true)
    if (!plan.data || !evidence.trim() || !attested || (plan.data.requiresResubscribeConfirmation && !resubscribe)) return
    try {
      const result = await apply.mutateAsync({ planId: plan.data.id, evidence: evidence.trim(), confirmResubscribe: resubscribe })
      toast(`${number(result.affected)} contact${result.affected === 1 ? '' : 's'} marked subscribed`, 'success'); onClose()
    } catch { /* Shown in the dialog. */ }
  }
  const matched = plan.data?.matched ?? 0, people = `${number(matched)} ${matched === 1 ? 'person' : 'people'}`
  const busy = plan.isPending || apply.isPending
  return <Dialog open onOpenChange={open => { if (!open && !apply.isPending) onClose() }} title="Mark as subscribed" description="Records that they agreed to marketing email, so campaigns can send to them." footer={<><Button disabled={apply.isPending} onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="bulk-subscribe" loading={apply.isPending} disabled={!ready || plan.isPending}>{ready ? `Mark ${people} as subscribed` : 'Mark as subscribed'}</Button></>}>
    <form id="bulk-subscribe" className="stack" onSubmit={event => { event.preventDefault(); void submit() }}>
      <p className="audience-dialog-copy">Changes every contact with Unknown consent {listId ? <>on <strong>{name ?? 'this list'}</strong></> : 'in your audience'}. People who opted out and suppressed addresses stay as they are.{searchIgnored && ' Your search doesn’t apply here; the count below is what changes.'}</p>
      <div className="audience-plan" aria-live="polite">
        {plan.isPending || plan.isIdle ? <LoadingRegion label="Counting contacts"><SkeletonText width={260} />{[78, 64, 72].map(width => <SkeletonText key={width} width={`${width}%`} />)}</LoadingRegion>
          : plan.isError ? <><MutationError error={plan.error} /><div><Button onClick={recount}>Count again</Button></div></>
          : !matched ? <p className="muted">No one {listId ? 'on this list ' : ''}has Unknown consent. Nothing to change.</p>
          : <><p><strong>{people}</strong> will be marked subscribed{matched > plan.data.sample.length ? `, including:` : ':'}</p>
            <ul className="audience-sample">{plan.data.sample.slice(0, 5).map(row => <li key={row.id}><PrivateAddress value={row.email} />{row.name && <span className="muted"> · {row.name}</span>}</li>)}</ul>
            {matched > 5 && <p className="muted">and {number(matched - 5)} more</p>}
            {plan.data.warnings.map(warning => <Alert key={warning} tone="warning">{warning}</Alert>)}</>}
      </div>
      <Field label="How did they agree?" htmlFor="bulk-evidence" error={missingEvidence ? 'Say how they agreed, for example “Signed up on our website”.' : undefined} hint="Saved in each consent record, like “Ticked the newsletter box at checkout”."><Input id="bulk-evidence" maxLength={2000} disabled={busy || !ready} value={evidence} onChange={event => setEvidence(event.target.value)} /></Field>
      <div><Checkbox checked={attested} disabled={busy || !ready} onCheckedChange={setAttested} label={ready ? `These ${people} agreed to receive marketing email from us.` : 'These people agreed to receive marketing email from us.'} aria-invalid={missingAttestation || undefined} />{missingAttestation && <div className="ui-field__hint ui-field__error" role="alert">Confirm they agreed before marking them subscribed.</div>}</div>
      {plan.data?.requiresResubscribeConfirmation && <div><Checkbox checked={resubscribe} disabled={busy} onCheckedChange={setResubscribe} label="Some of them opted out before. They opted in again." aria-invalid={missingResubscribe || undefined} />{missingResubscribe && <div className="ui-field__hint ui-field__error" role="alert">Confirm the people who opted out opted in again.</div>}</div>}
      {apply.error ? <><MutationError error={apply.error} /><div><Button onClick={recount}>Count again</Button></div></> : null}
    </form>
  </Dialog>
}
