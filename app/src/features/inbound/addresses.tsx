import { useEffect, useRef, useState, type FormEvent } from 'react'
import { X } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router'
import { Alert, Button, ConfirmDialog, ControlSkeleton, Dialog, ErrorState, Field, IconButton, Input, LoadingRegion, PageHeader, SectionHeader, Select, SkeletonText, useToast } from '../../components/ui'
import { useApiDef, useApiMutation, useApiQuery, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import { date, number } from '../../lib/format'
import { request } from '../../data/live'
import { ApiError, type InboundAddress, type InboundAddressInput, type InboundAddressPatch, type MailboxDomain } from '../../data/types'
import { fieldError, MutationError } from '../settings/shared'
import { AliasEditor, aliasState, commitAliases, type AliasState } from './aliases'
import { kinds, steps } from './concepts'
import { typeLabel, useOverview } from './overview'
import { Match, RitualIcon, TargetIcon, targetName } from './parts'
import { RouteEditor } from './routing'
import { when } from './shared'
import '../settings/settings.css'
import './inbound.css'
import './receiving.css'
import { PrivateAddress } from '../../components/PrivateAddress'
import { useExclusive } from '../../lib/single-flight'

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/
const lifetimes = [{ value: '', label: 'Permanent' }, { value: '3600', label: '1 hour' }, { value: '86400', label: '1 day' }, { value: '604800', label: '7 days' }, { value: '2592000', label: '30 days' }]
export const receivingDomains = <D extends Pick<MailboxDomain, 'status'>>(domains: D[]) => domains.filter(domain => !['off', 'disabled'].includes(domain.status))

export function CreateAddressDialog({ open, onOpenChange, domains }: { open: boolean; onOpenChange: (open: boolean) => void; domains: Pick<MailboxDomain, 'id' | 'name' | 'status'>[] }) {
  const navigate = useNavigate()
  const [address, setAddress] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [publicAddress, setPublicAddress] = useState('')
  const [lifetime, setLifetime] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const create = useApiMutation((api, input: InboundAddressInput) => api.inbound.createAddress(input), 'Address created')
  const receiving = receivingDomains(domains)
  useEffect(() => { if (open) { create.reset(); setErrors({}); setAddress(''); setDisplayName(''); setPublicAddress(''); setLifetime('') } }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  async function submit(event: FormEvent) {
    event.preventDefault()
    const value = address.trim().toLowerCase()
    const next: Record<string, string> = {}
    if (!EMAIL.test(value)) next.address = 'Enter a full email address, such as support@example.com.'
    else if (receiving.length && !receiving.some(domain => domain.name === value.split('@')[1])) next.address = `Use a receiving domain: ${receiving.map(domain => domain.name).join(', ')}.`
    const sender = publicAddress.trim().toLowerCase()
    // The API accepts a public sender only on permanent addresses; the form keeps the two exclusive.
    if (sender && lifetime) next.publicAddress = 'Temporary addresses cannot have a public sender address.'
    else if (sender && !EMAIL.test(sender)) next.publicAddress = 'Enter a full email address.'
    else if (sender && EMAIL.test(value) && (sender.split('@')[0] !== value.split('@')[0] || !value.split('@')[1]!.endsWith(`.${sender.split('@')[1]}`))) next.publicAddress = `Use ${value.split('@')[0]}@ on a parent domain of ${value.split('@')[1]}.`
    setErrors(next)
    if (Object.keys(next).length) return
    try { const row = await create.mutateAsync({ address: value, displayName: displayName.trim() || null, ...(sender ? { publicAddress: sender } : {}), ...(lifetime ? { ttlSeconds: Number(lifetime) } : {}) }); onOpenChange(false); navigate(`/receiving/addresses/${row.id}`) } catch { /* Shown in the form. */ }
  }
  return <Dialog open={open} onOpenChange={next => { if (!create.isPending) onOpenChange(next) }} title="Create address" footer={<><Button disabled={create.isPending} onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" type="submit" form="inbound-create-address" loading={create.isPending}>Create address</Button></>}>
    <form id="inbound-create-address" className="stack" onSubmit={submit} noValidate>
      <MutationError error={create.error} />
      <Field label="Address" htmlFor="inbound-address" error={errors.address || fieldError(create.error, 'address')} hint={receiving.length ? receiving.length > 1 ? `Receiving domains: ${receiving.map(domain => domain.name).join(', ')}` : undefined : 'Enable receiving on a domain first.'}>
        <Input id="inbound-address" type="email" value={address} onChange={event => setAddress(event.target.value)} disabled={create.isPending} placeholder={`support@${receiving[0]?.name ?? 'example.com'}`} autoFocus autoComplete="off" />
      </Field>
      <Field label="Display name" htmlFor="inbound-address-name" error={fieldError(create.error, 'displayName')} hint="Shown as the sender name on replies."><Input id="inbound-address-name" value={displayName} onChange={event => setDisplayName(event.target.value)} disabled={create.isPending} placeholder="Support" /></Field>
      <Field label="Lifetime" htmlFor="inbound-address-lifetime" error={fieldError(create.error, 'ttlSeconds')} hint={lifetime ? 'After expiry it stops receiving and sending. History stays readable until you delete it.' : 'Permanent addresses also claim earlier unrouted mail.'}>
        <Select id="inbound-address-lifetime" value={lifetime} onValueChange={value => { setLifetime(value); if (value) setPublicAddress('') }} disabled={create.isPending} options={lifetimes} />
      </Field>
      <Field label="Public sender" htmlFor="inbound-address-public" error={errors.publicAddress || fieldError(create.error, 'publicAddress')} hint={lifetime ? 'Only permanent addresses can have a public sender.' : 'The default From: the same name on a parent domain verified for sending, such as support@example.com.'}>
        <Input id="inbound-address-public" type="email" value={publicAddress} onChange={event => setPublicAddress(event.target.value)} disabled={create.isPending || !!lifetime} placeholder={address.includes('@') ? `${address.split('@')[0]}@${address.split('@')[1]!.split('.').slice(1).join('.') || 'example.com'}` : 'support@example.com'} autoComplete="off" />
      </Field>
    </form>
  </Dialog>
}

// `base` is the saved address the edit started from, so a just-saved form doesn't wait on the refetch.
type AddressForm = { base: InboundAddress; displayName: string; aliases: AliasState }
const formOf = (address: InboundAddress): AddressForm => ({ base: address, displayName: address.displayName ?? '', aliases: aliasState(address.aliases) })
const sameList = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n')

type RitualConfig = { version: number; config: { attachments: { ritual: string; target: string; continue: boolean }[] } }
const errorText = (e: unknown) => e instanceof ApiError ? e.text : (e as Error).message

/** Route → Rituals → Goes to for one address, with what can be done at each step right there. */
function AddressPath({ address, overview, onAddAlias, onAddPattern }: { address: InboundAddress; overview: ReturnType<typeof useOverview>; onAddAlias: () => void; onAddPattern: () => void }) {
  const toast = useToast()
  const entry = overview.data?.routes.data.find(r => r.address?.id === address.id)
  const [ritual, setRitual] = useState('')
  const [busy, setBusy] = useState(false)
  const [routing, setRouting] = useState(false)
  // Exclusive: attaching reads the saved version and writes against it, so a second click would conflict with the first.
  const attach = useExclusive(async (change: (list: RitualConfig['config']['attachments']) => RitualConfig['config']['attachments'], done: string) => {
    setBusy(true)
    try {
      const current = await request<RitualConfig>('/v1/rituals')
      await request('/v1/rituals/attachments', { method: 'PUT', body: { attachments: change(current.config.attachments) }, ifMatch: current.version })
      toast(done, 'success'); setRitual(''); await overview.refetch()
    } catch (e) { toast(errorText(e), 'error') } finally { setBusy(false) }
  })
  const attached = entry?.rituals ?? []
  const available = (overview.data?.rituals ?? []).filter(r => !attached.includes(r.key))
  const elsewhere = (entry?.to ?? []).filter(t => !(t.type === 'inbox' && t.id === address.id))
  return <div className="addr-path" aria-label={`How mail to ${address.address} is handled`}>
    <section className="addr-step" id="route">
      <h2>{steps.route.title}</h2><p>{steps.route.line}</p>
      <ul>
        <li><Match value={address.address} /></li>
        {address.aliases.map(a => <li key={a}><Match value={a} /><span className="muted">alias</span></li>)}
        {address.rules.map(r => <li key={r}><Match value={r} /><span className="muted">pattern</span></li>)}
      </ul>
      {!address.expiresAt && <div className="addr-step__actions"><Button size="sm" variant="ghost" onClick={onAddAlias}>Add alias</Button><Button size="sm" variant="ghost" onClick={onAddPattern}>Add pattern</Button></div>}
    </section>
    <span className="addr-arrow" aria-hidden="true">→</span>
    <section className="addr-step" id="rituals">
      <h2>{steps.rituals.title}</h2><p>{steps.rituals.line}</p>
      {!entry ? <SkeletonText width="50%" /> : attached.length ? <ul>{attached.map((k, i) => <li key={k}><RitualIcon /><Link to={`/receiving/rituals?key=${encodeURIComponent(k)}`}><code>{k}</code></Link>{i < attached.length - 1 && <span className="addr-then">then</span>}<span className="addr-grow" />
        <IconButton size="sm" label={`Detach ${k}`} disabled={busy} onClick={() => void attach(list => list.filter(b => !(b.ritual === k && b.target === address.id)), `${k} detached.`)}><X size={14} aria-hidden="true" /></IconButton></li>)}</ul>
        : <p className="addr-step__empty">{steps.rituals.empty}. A ritual can label, filter or send this address’s mail on.</p>}
      <div className="addr-step__actions">
        {available.length > 0 && <Select aria-label="Ritual to attach" value={ritual} onValueChange={setRitual} options={[{ value: '', label: 'Attach a ritual…' }, ...available.map(r => ({ value: r.key, label: r.key }))]} />}
        {available.length > 0 && <Button size="sm" disabled={!ritual || busy || attached.length >= 3} onClick={() => void attach(list => [...list, { ritual, target: address.id, continue: false }], `${ritual} attached.`)}>Attach</Button>}
        <Link className="ui-button ui-button--ghost ui-button--sm" to="/receiving/rituals?new=1">Write a ritual</Link>
      </div>
    </section>
    <span className="addr-arrow" aria-hidden="true">→</span>
    <section className="addr-step" id="goes-to">
      <h2>{steps.goesTo.title}</h2><p>{steps.goesTo.line}</p>
      {!entry ? <SkeletonText width="50%" /> : <ul>{entry.to.map(t => <li key={`${t.type}:${t.id}`}><TargetIcon type={t.type} /><span>{targetName(t, address.id)}</span><span className="muted">{t.via ? `via ${t.via}` : t.status === 'paused' ? 'Paused' : typeLabel[t.type]}</span></li>)}</ul>}
      {entry && !elsewhere.length && <p className="addr-step__empty">{steps.goesTo.empty}. Add an endpoint to also send it to a webhook.</p>}
      {entry?.toTruncated && <p className="addr-step__empty">{number(entry.toTotal - entry.to.length)} more {entry.toTotal - entry.to.length === 1 ? 'webhook gets' : 'webhooks get'} this address’s mail. <Link to={`/receiving/webhooks?address=${encodeURIComponent(address.id)}`}>See every webhook</Link></p>}
      {entry?.route && <p className="addr-step__empty">A route sends this address’s mail{entry.route.to === 'drop' ? ' nowhere: it’s dropped' : entry.route.to.includes(address.id) ? '' : ' elsewhere instead of its inbox'}.</p>}
      <div className="addr-step__actions"><Button size="sm" onClick={() => setRouting(true)}>{entry?.route ? 'Edit route' : 'Add an endpoint'}</Button><span className="muted">Slack, Discord and forwards are sent by a ritual.</span></div>
    </section>
    {routing && <RouteEditor match={address.address} route={entry?.route} to={[address.id]} onClose={() => { setRouting(false); void overview.refetch() }} />}
  </div>
}

/** Wildcard patterns that also deliver here, such as reply+*@acme.com. */
function PatternsField({ address, inputRef }: { address: InboundAddress; inputRef: React.RefObject<HTMLInputElement | null> }) {
  const [draft, setDraft] = useState('')
  const save = useApiMutation((api, rules: string[]) => api.inbound.updateAddress(address.id, { rules } as InboundAddressPatch), 'Patterns saved')
  const rules = save.data?.rules ?? address.rules
  const domain = address.address.split('@')[1]
  async function add() {
    const value = draft.trim().toLowerCase(), full = value.includes('@') ? value : `${value}@${domain}`
    if (!value) return
    try { await save.mutateAsync([...rules, full]); setDraft('') } catch { /* Shown below. */ }
  }
  return <div className="ui-field addr-patterns">
    <label className="ui-field__label" htmlFor="address-pattern">Patterns</label>
    {rules.length > 0 && <ul>{rules.map(r => <li key={r}><Match value={r} /><IconButton size="sm" label={`Remove ${r}`} disabled={save.isPending} onClick={() => void save.mutateAsync(rules.filter(x => x !== r)).catch(() => undefined)}><X size={14} aria-hidden="true" /></IconButton></li>)}</ul>}
    <div className="addr-patterns__add"><Input ref={inputRef} id="address-pattern" value={draft} disabled={save.isPending || !!address.expiresAt} placeholder={`${address.address.split('@')[0]}+*@${domain}`} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void add() } }} autoComplete="off" spellCheck={false} />
      <Button disabled={!draft.trim() || save.isPending} loading={save.isPending} onClick={() => void add()}>Add</Button></div>
    <div className={`ui-field__hint${save.error ? ' ui-field__error' : ''}`} role={save.error ? 'alert' : undefined}>{save.error ? errorText(save.error) : address.expiresAt ? 'Temporary addresses cannot have patterns.' : `A pattern catches many addresses with *. ${kinds.pattern.example}.`}</div>
  </div>
}

function RecentMail({ address, threads }: { address: InboundAddress; threads: ReturnType<typeof useAddressThreads> }) {
  if (threads.error) return <ErrorState error={threads.error} onRetry={() => void threads.refetch()} />
  if (!threads.data) return <div aria-hidden="true"><SkeletonText width="60%" /></div>
  if (!threads.data.length) return <p className="muted">No mail yet. Mail sent to <PrivateAddress value={address.address} /> shows up here and in the Inbox within seconds.</p>
  return <ul className="addr-recent">{threads.data.slice(0, 5).map(t => <li key={t.id}><Link to={`/receiving/inbox?address=${address.id}&thread=${t.id}`}><span>{t.subject || '(no subject)'}</span><span className="muted">{t.snippet}</span><time>{when(t.lastMessageAt)}</time></Link></li>)}</ul>
}

const useAddressThreads = (id: string) => useApiDef(queries.inboundThreads(id, 'inbox', '', undefined))

export function InboundAddressDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { canAdminister } = useWorkspaceAccess()
  const address = useApiQuery(['inbound-address', id], (api, signal) => api.inbound.address(id, signal))
  const save = useApiMutation((api, patch: InboundAddressPatch) => api.inbound.updateAddress(id, patch), 'Address saved')
  const remove = useApiMutation((api, _: void) => api.inbound.deleteAddress(id), 'Address deleted')
  const [edited, setInput] = useState<AddressForm | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const patternInput = useRef<HTMLInputElement>(null)
  const current = address.data
  // The path and recent mail are separate reads; the page shows once all of them settle, so nothing moves in.
  const overview = useOverview({ q: current?.address ?? '', kind: current?.kind === 'inbox' ? 'inbox' : 'address', limit: 5 }, false, canAdminister && !!current)
  const threads = useAddressThreads(id)
  const ready = !!current && (!canAdminister || overview.data !== undefined || !!overview.error) && (threads.data !== undefined || !!threads.error)
  const input = edited ?? (current ? formOf(current) : null)
  if (address.error) return <><PageHeader title="Address" backTo="/receiving" /><ErrorState error={address.error} onRetry={() => void address.refetch()} /></>
  const base = input?.base
  const dirty = !!base && !!input && (input.displayName.trim() !== (base.displayName ?? '') || !sameList(input.aliases.list, base.aliases) || !!input.aliases.draft.trim())
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!input || !base) return
    // Text still in the alias box counts: add it, or stop on it so nothing invalid is sent.
    const aliases = commitAliases(input.aliases, { address: base.address, temporary: !!base.expiresAt })
    if (!aliases.ok) { setInput({ ...input, aliases: { list: aliases.list, draft: aliases.draft, message: aliases.message } }); document.getElementById('inbound-address-aliases')?.focus(); return }
    const patch: InboundAddressPatch = {}
    if (input.displayName.trim() !== (base.displayName ?? '')) patch.displayName = input.displayName.trim() || null
    if (!sameList(aliases.list, base.aliases)) patch.aliases = aliases.list
    if (!Object.keys(patch).length) { setInput(null); return }
    setInput({ ...input, aliases: { list: aliases.list, draft: '', message: null } })
    try { setInput(formOf(await save.mutateAsync(patch))) } catch { /* Shown in the form. */ }
  }
  const focus = (target: () => HTMLElement | null) => { const el = target(); el?.scrollIntoView({ block: 'center' }); el?.focus() }
  return <div className="stack inbound-stack">
    {/* The actions hold their place while the address loads: on a phone they take a row of their own. */}
    <PageHeader title={current ? <PrivateAddress value={current.address} /> : <SkeletonText width={240} lineHeight={28} />} backTo="/receiving" actions={current ? <>
      {canAdminister && <Link className="ui-button ui-button--secondary ui-button--md" to={`/receiving/trace?to=${encodeURIComponent(current.address)}`}>Trace</Link>}
      <Link className="ui-button ui-button--secondary ui-button--md" to={`/receiving/inbox?address=${encodeURIComponent(current.id)}`}>Open in Inbox</Link>
      {canAdminister && <Button variant="danger" onClick={() => setConfirmDelete(true)}>Delete</Button>}
    </> : <span className="cluster" aria-hidden="true">{canAdminister && <ControlSkeleton width="calc(5ch + 28px)" />}<ControlSkeleton width="calc(13ch + 28px)" />{canAdminister && <ControlSkeleton width="calc(6ch + 28px)" />}</span>} />
    {!ready ? <LoadingRegion label="Loading address"><div className="addr-skeleton" aria-hidden="true"><span /><span /><span /></div></LoadingRegion> : current && <div className="stack inbound-stack addr-page">
      <dl className="settings-facts">
        <div><dt>Domain</dt><dd><Link to="/domains">{current.domain}</Link></dd></div>
        <div><dt>Sends as</dt><dd className="settings-break"><PrivateAddress value={current.publicAddress ?? current.address} /></dd></div>
        <div><dt>Created</dt><dd>{current.origin === 'auto' ? 'By the catch-all, ' : ''}{date(current.createdAt)}</dd></div>
        <div><dt>Threads</dt><dd>{number(current.stats.threads)}{current.stats.unreadThreads > 0 && <span className="muted"> · {number(current.stats.unreadThreads)} unread</span>}</dd></div>
        <div><dt>Last message</dt><dd>{current.stats.lastMessageAt ? date(current.stats.lastMessageAt) : 'None yet'}</dd></div>
        {current.expiresAt && <div><dt>Expires</dt><dd>{date(current.expiresAt)}</dd></div>}
      </dl>
      {current.expiresAt && Date.parse(current.expiresAt) <= Date.now() && <Alert tone="info">This temporary address has expired. It no longer receives or sends mail; its history stays readable until you delete it.</Alert>}
      {canAdminister && <AddressPath address={current} overview={overview} onAddAlias={() => focus(() => document.getElementById('inbound-address-aliases'))} onAddPattern={() => focus(() => patternInput.current)} />}
      <section className="section stack" aria-labelledby="address-recent">
        <SectionHeader title={<span id="address-recent">Recent mail</span>} actions={<Link className="ui-button ui-button--ghost ui-button--md" to={`/receiving/inbox?address=${encodeURIComponent(current.id)}`}>Open in Inbox</Link>} />
        <RecentMail address={current} threads={threads} />
      </section>
      {canAdminister && <section className="section section--bordered stack">
        <SectionHeader title="Settings" />
        {input && <form className="stack inbound-settings-form" onSubmit={submit} noValidate>
          <MutationError error={save.error} />
          <Field label="Display name" htmlFor="inbound-address-display" error={fieldError(save.error, 'displayName')} hint="Shown as the sender name on replies."><Input id="inbound-address-display" value={input.displayName} onChange={event => setInput({ ...input, displayName: event.target.value })} disabled={save.isPending} placeholder="Support" /></Field>
          <AliasEditor id="inbound-address-aliases" address={current.address} temporary={!!current.expiresAt} saved={input.base.aliases} value={input.aliases} onChange={aliases => setInput({ ...input, aliases })} disabled={save.isPending} error={fieldError(save.error, 'aliases')} />
          <div className="cluster form-actions"><Button variant="primary" type="submit" loading={save.isPending} disabled={!dirty}>Save changes</Button>{dirty && !save.isPending && <Button onClick={() => { setInput(null); save.reset() }}>Discard</Button>}</div>
        </form>}
        <PatternsField key={current.updatedAt} address={current} inputRef={patternInput} />
      </section>}
    </div>}
    <ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} title={`Delete ${current?.address ?? 'this address'}?`} description="The address and its aliases are released, and its read, star and archive state is removed. Stored messages are kept; future mail to these addresses follows the domain’s catch-all, and routes that deliver to this inbox stop doing so." confirmLabel="Delete address" danger pending={remove.isPending} onConfirm={async () => { await remove.mutateAsync(); navigate('/receiving') }} />
  </div>
}
