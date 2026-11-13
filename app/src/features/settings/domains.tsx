import { useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router'
import { Alert, Button, ConfirmDialog, DataTable, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, Pagination, PaginationSkeleton, SectionHeader, Select, StatusBadge, StatusDot } from '../../components/ui'
import { useApi, useApiMutation, useApiDef, useApiQuery, useRegion, useSession, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import { usePrefetchQueries } from '../../data/prefetch'
import { label } from '../../lib/format'
import { ApiError, type DnsRecord, type Domain, type MailboxDomain } from '../../data/types'
import { request } from '../../data/live'
import { domainPattern, normalizeDomain } from '../../lib/domain'
import { catchAllLabel, mxTone, receivingStatus } from '../inbound/status'
import { receivingIssueReason, receivingIssueTitle } from './receiving-issue-title'
import { catchAllSetting } from '../inbound/concepts'
import { fieldError, MutationError } from './shared'
import { AdminOnlyPage } from './admin-only'
import { DomainDetailSkeleton, domainColumns } from './skeletons'
import { DnsRecordTable, DnsWaitNote, DomainRecords, domainState, recordsFor, useDnsSetup, useDomain, zoneLines } from './domain-records'

function downloadDnsRecords(domain: string, records: DnsRecord[]) {
  const text = `; DNS records for ${domain}\n; Import into your DNS provider or add each record manually.\n${zoneLines(records)}\n`
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
  const link = Object.assign(document.createElement('a'), { href: url, download: `${domain}-dns-records.txt` })
  link.click()
  URL.revokeObjectURL(url)
}

// What sending setup still waits for, beside its status; null once it waits for nothing.
function sendingNote(domain: Domain) {
  const ownership = recordsFor(domain, 'sending').filter(record => record.type === 'TXT')
  const parts = [domain.dkimStatus && domain.dkimStatus !== 'verified' && `DKIM ${domain.dkimStatus}`, ownership.length > 0 && !ownership.every(record => record.status === 'verified') && 'Ownership pending', ['pending', 'failed'].includes(domain.mailFromStatus) && `MAIL FROM ${domain.mailFromStatus}`].filter(Boolean)
  return parts.length ? parts.join(' · ') : domain.status === 'verified' ? null : 'Waiting for DNS'
}

// A card's corner has room for the status alone; the note is on the domain's page.
function SendingCell({ domain, short = false }: { domain: Domain; short?: boolean }) {
  const { status } = domainState(domain), note = sendingNote(domain)
  return <StatusDot tone={domain.status === 'issue' ? 'danger' : domain.status === 'verified' ? 'success' : 'warning'} note={short ? undefined : note} title={note ? `${status} · ${note}` : undefined}>{status}</StatusDot>
}

// One line per domain: the host it receives at (the domain itself or a subdomain such as reply.), or Off. The column
// says "Receiving", so an active host needs no word of its own; other states and DNS issues add a short note. A card has
// no Addresses column, so an active host's card notes its address count instead. One page per domain for sending and
// receiving: Receiving doesn't list domains of its own.
function ReceivingCell({ domain, receiving, card = false }: { domain: Domain; receiving?: MailboxDomain; card?: boolean }) {
  const issue = domain.receivingIssue
  if (issue) return <StatusDot tone={issue.blocking ? 'danger' : 'warning'} note={receivingIssueReason(issue.code)} title={`${receivingIssueTitle(issue.code, issue.host)}. ${issue.message}`}>{issue.host}</StatusDot>
  if (!receiving || receiving.status === 'off' || receiving.status === 'disabled') return <StatusDot tone="neutral" muted title="Receiving is off. Set it up on the domain’s page." note={<Link className="domain-setup-link" to={`/domains/${domain.id}`}>Set up</Link>}>Off</StatusDot>
  const status = receivingStatus[receiving.status]
  const detail = receiving.status === 'failed' ? receiving.lastError : receiving.status === 'waiting_for_mx' ? receiving.mx?.message : null
  return <StatusDot tone={status.tone} note={receiving.status !== 'active' ? status.label : card ? `${receiving.addressCount.toLocaleString('en-US')} ${receiving.addressCount === 1 ? 'address' : 'addresses'}` : undefined} title={[`${status.label} at ${receiving.name}`, detail].filter(Boolean).join('. ')}>{receiving.name}</StatusDot>
}

/** Hosted: where the domain receives, its addresses and catch-all. Only once receiving is on: while it is off the Receiving records below say how to turn it on, and the status is in the page's facts. */
/** The page reads the receiving domain before it shows (so this section arrives at its final height) and passes it in. */
function ReceivingSettings({ domainId, receiving }: { domainId: string; receiving: { data?: MailboxDomain; error: unknown; refetch: () => unknown } }) {
  const check = useApiMutation((api, _: void) => api.mailboxes.checkDomain(domainId), 'MX records checked', false, true, domainId)
  const update = useApiMutation((_api, catchAll: MailboxDomain['catchAll']) => request<MailboxDomain>(`/v1/inbound/domains/${encodeURIComponent(domainId)}`, { method: 'PATCH', body: { catchAll } }), 'Catch-all saved', false, true, domainId)
  const state = update.data ?? receiving.data
  if (!state) return receiving.error ? <section className="section stack"><SectionHeader title="Receiving" /><ErrorState error={receiving.error as Error} onRetry={() => void receiving.refetch()} /></section> : null
  if (['off', 'disabled'].includes(state.status)) return null
  return <section className="section stack" aria-labelledby="domain-receiving">
    <div className="ui-section-header"><div className="domain-group-title"><h2 id="domain-receiving">Receiving</h2><p className="muted">Mail to addresses at {state.name} follows its <Link to={`/receiving?domain=${encodeURIComponent(state.name)}`}>routes</Link>.</p></div>
      {state.status !== 'active' && <div className="cluster"><Button loading={check.isPending} onClick={() => void check.mutateAsync().catch(() => undefined)}>Check MX now</Button></div>}</div>
    <MutationError error={update.error ?? check.error} />
    <dl className="settings-facts domain-facts domain-receiving-facts">
      <div><dt>Receives at</dt><dd>{state.name}</dd></div>
      <div><dt>Addresses</dt><dd><Link to={`/receiving?domain=${encodeURIComponent(state.name)}`}>{state.addressCount.toLocaleString('en-US')}</Link></dd></div>
      <div title={catchAllSetting.line}><dt>{catchAllSetting.title}</dt><dd><Select aria-label={`${catchAllSetting.title}: ${catchAllSetting.line}`} value={state.catchAll} onValueChange={value => void update.mutateAsync(value as MailboxDomain['catchAll']).catch(() => undefined)} disabled={update.isPending}
        options={[{ value: 'store', label: catchAllSetting.options.store }, { value: 'create_address', label: catchAllSetting.options.create_address }]} /></dd></div>
    </dl>
    <p className="muted domain-receiving-note">{catchAllSetting.line}</p>
  </section>
}

export function DomainsPage() {
  return useWorkspaceAccess().canAdminister ? <DomainsList /> : <AdminOnlyPage title="Domains" button="Add domain" action="add domains, see their DNS records and turn on receiving" />
}
function DomainsList() {
  const { regionId } = useRegion()
  const warm = usePrefetchQueries()
  const { multiTenant } = useWorkspaceAccess()
  const columns = domainColumns(multiTenant)
  const navigate = useNavigate()
  const [pageState, setPageState] = useState({ regionId, page: 1 })
  const page = pageState.regionId === regionId ? pageState.page : 1
  const domains = useApiDef(queries.domains(regionId, page), { keepPrevious: previous => previous[1] === regionId })
  const inbound = useApiDef(queries.inboundDomains())
  const receivingOf = (id: string) => inbound.data?.find(d => d.id === id)
  const create = useApiMutation((api, input: { regionId: string; name: string }) => api.domains.create(input), 'Domain added', true)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [invalid, setInvalid] = useState('')
  function openCreate() { create.reset(); setName(''); setInvalid(''); setOpen(true) }
  async function submit(event: FormEvent) {
    event.preventDefault()
    const value = normalizeDomain(name)
    if (!domainPattern.test(value)) { setInvalid('Enter a domain like updates.acme.com.'); return }
    setInvalid('')
    setName(value)
    try {
      const domain = await create.mutateAsync({ regionId, name: value })
      setOpen(false)
      navigate(`/domains/${domain.id}`)
    } catch { /* Shown inline. */ }
  }
  return <div className="stack">
    <PageHeader title="Domains" actions={<Button variant="primary" onClick={openCreate}>Add domain</Button>} />
    {domains.error ? <ErrorState error={domains.error} onRetry={() => void domains.refetch()} /> : <>
      <DataTable className="domains-table" loading={domains.isPending || (inbound.isPending && !inbound.error)} skeletonRows={3} minRows={3} rows={domains.data?.items ?? []} rowKey={row => row.id} rowHref={row => `/domains/${row.id}`} onRowIntent={row => void warm([queries.domain(row.id)])} empty={<EmptyState title={multiTenant ? 'No domains' : 'No domains in this region'} description="Add a domain to send and receive mail." action={<Button onClick={openCreate}>Add domain</Button>} />} columns={[
        { ...columns[0], render: row => <span className="domain-name" title={row.name}>{row.name}</span> },
        { ...columns[1], render: row => <SendingCell domain={row} />, cardRender: row => <SendingCell domain={row} short /> },
        { ...columns[2], render: row => <ReceivingCell domain={row} receiving={receivingOf(row.id)} />, cardRender: row => <ReceivingCell domain={row} receiving={receivingOf(row.id)} card /> },
        { ...columns[3], render: row => { const r = receivingOf(row.id); return r && r.status !== 'off' && r.status !== 'disabled' ? <Link to={`/receiving?domain=${encodeURIComponent(r.name)}`} onClick={event => event.stopPropagation()}>{r.addressCount.toLocaleString('en-US')}</Link> : <span className="muted">—</span> } },
        ...multiTenant ? [] : [{ ...columns[4], render: (row: Domain) => row.regionId }],
      ]} />
      {domains.isPending ? <PaginationSkeleton /> : <Pagination page={page} pageSize={10} total={domains.data.total} nextCursor={domains.data.nextCursor} onPageChange={next => setPageState({ regionId, page: next })} />}
    </>}
    <Dialog open={open} onOpenChange={next => { if (!create.isPending) setOpen(next) }} title="Add domain" footer={<><Button disabled={create.isPending} onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={create.isPending} type="submit" form="add-domain">Add domain</Button></>}>
      <form id="add-domain" className="stack" onSubmit={submit} noValidate>
        <MutationError error={create.error} />
        <Field label="Domain name" htmlFor="domain-name" error={invalid || fieldError(create.error, 'name')}><Input id="domain-name" autoFocus required value={name} onChange={event => setName(event.target.value)} disabled={create.isPending} placeholder="updates.acme.com" /></Field>
        {!multiTenant && <Field label="Sending region" htmlFor="domain-region"><Input id="domain-region" value={regionId} readOnly /></Field>}
      </form>
    </Dialog>
  </div>
}

export function DomainDetailPage() {
  return useWorkspaceAccess().canAdminister ? <DomainDetail /> : <AdminOnlyPage title="Domain" backTo="/domains" action="add domains, see their DNS records and turn on receiving" />
}
function DomainDetail() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { regionId, setRegionId } = useRegion()
  const { multiTenant } = useWorkspaceAccess()
  const hosted = useSession()?.identity?.connection?.kind === 'shared'
  const chooseSupported = !!useApi().domains.chooseReceivingHost
  const [recheckUntil, setRecheckUntil] = useState(0)
  const domain = useDomain(id, recheckUntil)
  const receiving = useApiQuery(['mailbox-domain', id], (api, signal) => api.mailboxes.domain(id, signal), { enabled: hosted })
  const verify = useApiMutation((api, domainId: string) => api.domains.verify(domainId), 'Checking records', true)
  const client = useQueryClient()
  // Invalidate only after leaving: refetching this domain would 404 while the dialog closes.
  const remove = useApiMutation((api, domainId: string) => api.domains.remove(domainId), 'Domain deleted', true, false)
  const configureMailFrom = useApiMutation((api, input: {id: string; mailFromDomain: string}) => api.domains.configureMailFrom(input.id, input.mailFromDomain), 'Custom MAIL FROM configured', true)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [mailFromOpen, setMailFromOpen] = useState(false)
  const [mailFromDomain, setMailFromDomain] = useState('')
  const [mailFromInvalid, setMailFromInvalid] = useState('')
  function openMailFrom() { configureMailFrom.reset(); setMailFromDomain(domain.data?.mailFromDomain ?? `email.${domain.data?.name ?? ''}`); setMailFromInvalid(''); setMailFromOpen(true) }
  async function submitMailFrom(event: FormEvent) {
    event.preventDefault()
    const current = domain.data, value = mailFromDomain.trim().toLowerCase()
    if (!current || !domainPattern.test(value) || value === current.name || !value.endsWith(`.${current.name}`)) { setMailFromInvalid(`Use an unused subdomain of ${current?.name ?? 'this domain'}.`); return }
    setMailFromInvalid('')
    try { await configureMailFrom.mutateAsync({id, mailFromDomain: value}); setMailFromOpen(false) } catch { /* Shown inline. */ }
  }
  const dns = useDnsSetup(domain.data)
  // Hosted receiving: a free subdomain by default. Choosing a host goes through the API's DNS checks: a CNAME, one of
  // Bane's own names or a host in use elsewhere is refused; a host another provider receives for asks before moving its mail.
  const [moveMail, setMoveMail] = useState<{ host: string; message: string } | null>(null)
  const choose = useApiMutation(async (api, input: { host: string | null; confirm?: boolean }) => {
    const updated = await api.domains.chooseReceivingHost!(id, input)
    client.setQueryData(['bane', api.mode, 'domain', id], updated)
    return updated
  }, undefined, false, true, id)
  async function chooseHost(host: string | null) {
    choose.reset()
    try { await choose.mutateAsync({ host }) }
    catch (error) { if (host && error instanceof ApiError && error.code === 'RECEIVING_HOST_IN_USE') { choose.reset(); setMoveMail({ host, message: error.detail.replace(/^Move mail for \S+\? /, '').replace(/ Send confirm: true to choose it anyway\.$/, '') }) } }
  }
  async function checkNow() { try { await verify.mutateAsync(id); if (multiTenant) setRecheckUntil(Date.now() + 30_000) } catch { /* Shown inline. */ } }
  if (domain.isPending || (!domain.error && (dns.pending || (hosted && receiving.isPending && !receiving.error)))) return <DomainDetailSkeleton />
  if (domain.error) return <div className="stack"><PageHeader title="Domain" backTo="/domains" /><ErrorState error={domain.error} onRetry={() => void domain.refetch()} /></div>
  const current = domain.data
  const mailFromRecords = recordsFor(current, 'mail_from')
  const mailFromName = current.mailFromDomain ?? mailFromRecords[0]?.name ?? null
  const state = domainState(current)
  const sendingDetail = sendingNote(current)
  const receivingRecord = recordsFor(current, 'receiving')[0]
  const receivingPending = !!receivingRecord && receivingRecord.status !== 'verified'
  const onRoot = receivingRecord?.name === current.name
  // Check MX now also stays for a live host whose DNS changed (receivingIssue); choosing another host only before it receives.
  const receivingActions = hosted && (receivingPending || current.receivingIssue) ? <>
    {receivingPending && chooseSupported && <Button loading={choose.isPending} onClick={() => void chooseHost(onRoot ? null : current.name)}>{onRoot ? 'Use a subdomain instead' : `Use ${current.name} instead`}</Button>}
    <Button loading={verify.isPending} onClick={() => void checkNow()} title="Added the MX record? Check it now instead of waiting for the hourly check.">Check MX now</Button>
  </> : undefined
  const sesUrl = `https://${current.regionId}.console.aws.amazon.com/ses/home?region=${encodeURIComponent(current.regionId)}#/identities/${encodeURIComponent(current.name)}`
  return <div className="stack">
    <PageHeader title={current.name} backTo="/domains" actions={<>
      <Button loading={verify.isPending} onClick={() => void checkNow()}>Check now</Button>
      {!hosted && <a className="ui-button ui-button--secondary ui-button--md" href={sesUrl} target="_blank" rel="noreferrer">Open in SES</a>}
      {multiTenant && <Button variant="danger" onClick={() => { remove.reset(); setDeleteOpen(true) }}>Delete domain</Button>}
    </>} />
    <MutationError error={verify.error ?? choose.error} />
    {!multiTenant && regionId !== current.regionId && <Alert tone="info">This domain belongs to {current.regionId}. <Button variant="ghost" onClick={() => setRegionId(current.regionId)}>Switch to {current.regionId}</Button></Alert>}
    <dl className="settings-facts domain-facts">
      <div><dt>Sending</dt><dd><StatusBadge status={state.status} tone={state.tone} />{sendingDetail && <span className="muted domain-fact-note" title={sendingDetail}>{sendingDetail}</span>}</dd></div>
      {hosted && receiving.data && <div><dt>Receiving</dt><dd><StatusBadge status={receiving.data.status === 'active' ? 'On' : receivingStatus[receiving.data.status].label} tone={receivingStatus[receiving.data.status].tone} /></dd></div>}
      {!multiTenant && <div><dt>Region</dt><dd>{current.regionId}</dd></div>}
    </dl>
    {hosted && <ReceivingSettings domainId={id} receiving={receiving} />}
    <div className="domain-sections">
      <DomainRecords domain={current} setup={dns.setup} receivingView={hosted ? { actions: receivingActions } : undefined} actions={current.records.length > 0 && <Button onClick={() => downloadDnsRecords(current.name, current.records)}>Download .txt</Button>} />
      <DnsWaitNote domain={current} />
      <details className="domain-advanced">
        <summary>Advanced</summary>
        <div className="domain-advanced-body">
          <div className="ui-section-header"><div className="domain-group-title"><h3>Custom MAIL FROM{mailFromName && <span className="muted"> · {mailFromName}</span>}</h3><p className="muted">Routes bounces through a subdomain you own for relaxed SPF alignment.</p></div>
            <div className="cluster">{mailFromName && <StatusBadge status={label(current.mailFromStatus)} />}<Button aria-label={mailFromName ? 'Change custom MAIL FROM' : 'Add custom MAIL FROM'} onClick={openMailFrom}>{mailFromName ? 'Change' : 'Add'}</Button></div>
          </div>
          {mailFromRecords.length > 0 && <DnsRecordTable domain={current.name} records={mailFromRecords} />}
        </div>
      </details>
      {!hosted && <MailboxReceiving domainId={id} domainName={current.name} verified={current.status === 'verified'} />}
    </div>
    <ConfirmDialog open={!!moveMail} onOpenChange={open => { if (!open) setMoveMail(null) }} title={`Move mail for ${moveMail?.host ?? current.name}?`}
      description={`${moveMail?.message ?? ''} Mail stops arriving there once the MX record changes.`} confirmLabel={`Use ${moveMail?.host ?? current.name} anyway`} danger
      onConfirm={() => choose.mutateAsync({ host: moveMail!.host, confirm: true })} />
    <ConfirmDialog open={deleteOpen} onOpenChange={setDeleteOpen} title={`Delete ${current.name}?`} description="Sending from it stops. Its DNS records stay at your DNS provider until you remove them." confirmLabel="Delete domain" danger pending={remove.isPending} onConfirm={async () => { await remove.mutateAsync(id); navigate('/domains', { replace: true }); client.removeQueries({ predicate: query => query.queryKey[0] === 'bane' && query.queryKey[2] === 'domain' && query.queryKey[3] === id }); void client.invalidateQueries({ predicate: query => query.queryKey[0] === 'bane' && query.queryKey[2] === 'domains' }) }} />
    <Dialog open={mailFromOpen} onOpenChange={next => {if (!configureMailFrom.isPending) setMailFromOpen(next)}} title={current.mailFromDomain ? 'Change custom MAIL FROM' : 'Add custom MAIL FROM'} footer={<><Button disabled={configureMailFrom.isPending} onClick={() => setMailFromOpen(false)}>Cancel</Button><Button variant="primary" loading={configureMailFrom.isPending} type="submit" form="configure-mail-from">Save</Button></>}>
      <form id="configure-mail-from" className="stack" onSubmit={submitMailFrom} noValidate>
        <MutationError error={configureMailFrom.error} />
        <Field label="MAIL FROM domain" htmlFor="mail-from-domain" error={mailFromInvalid || fieldError(configureMailFrom.error, 'mailFromDomain')}><Input id="mail-from-domain" autoFocus required value={mailFromDomain} onChange={event => setMailFromDomain(event.target.value)} disabled={configureMailFrom.isPending} placeholder={`email.${current.name}`} /></Field>
        <p className="muted">Use an unused subdomain of {current.name}.</p>
      </form>
    </Dialog>
  </div>
}

function MailboxReceiving({ domainId, domainName, verified }: { domainId: string; domainName: string; verified: boolean }) {
  const { multiTenant } = useWorkspaceAccess()
  const receiving = useApiQuery(['mailbox-domain', domainId], (api, signal) => api.mailboxes.domain(domainId, signal), { interval: state => state && ['provisioning', 'waiting_for_mx', 'disabling'].includes(state.status) ? 30_000 : false })
  const enable = useApiMutation((api, force: boolean) => api.mailboxes.enableDomain(domainId, { force }), 'Receiving setup started', false, true, domainId)
  const disable = useApiMutation((api, _: void) => api.mailboxes.disableDomain(domainId), 'Receiving turned off', false, true, domainId)
  const check = useApiMutation((api, _: void) => api.mailboxes.checkDomain(domainId), 'MX records checked', false, true, domainId)
  const [conflict, setConflict] = useState<string | null>(null)
  const [disableOpen, setDisableOpen] = useState(false)
  async function start() {
    try { await enable.mutateAsync(false) }
    catch (error) { if (error instanceof ApiError && error.code === 'MX_CONFLICT') { enable.reset(); setConflict(error.message.replace(/ Retry with force=true to continue anyway\. \[MX_CONFLICT\].*$/, '')) } }
  }
  if (receiving.error) return <section className="section stack"><SectionHeader title="Receiving" /><ErrorState error={receiving.error} onRetry={() => void receiving.refetch()} /></section>
  const state = receiving.data
  const on = !!state && !['off', 'disabled'].includes(state.status)
  const status = state ? receivingStatus[state.status] : null
  const records: DnsRecord[] = (state?.dns ?? []).map((record, index) => ({ id: `mx_${index}`, type: 'MX', name: record.name, value: `${record.priority} ${record.value}`, status: state?.mx?.state === 'active' ? 'verified' : 'pending' }))
  return <section className="section stack">
    <div className="ui-section-header"><div className="domain-group-title"><h2>Receiving</h2><p className="muted">Receive mail on {domainName}. Its addresses and routes are in <Link to={`/receiving?domain=${encodeURIComponent(domainName)}`}>Receiving</Link>.</p></div>
      <div className="cluster">{on ? <>
        <Button loading={check.isPending} onClick={async () => { try { await check.mutateAsync() } catch { /* Shown inline. */ } }}>Check MX</Button>
        {state!.status !== 'disabling' && <Button onClick={() => setDisableOpen(true)}>Turn off</Button>}
      </> : <Button variant="primary" disabled={!verified || !state} loading={enable.isPending} onClick={start}>Enable receiving</Button>}</div>
    </div>
    <MutationError error={enable.error ?? disable.error ?? check.error} />
    {!verified && !on && <p className="muted">Verify the domain before enabling receiving.</p>}
    {state && status && on && <>
      <dl className="settings-facts domain-facts">
        <div><dt>Status</dt><dd><StatusBadge status={status.label} tone={status.tone} /></dd></div>
        <div title={catchAllSetting.line}><dt>{catchAllSetting.title}</dt><dd>{catchAllLabel[state.catchAll]}</dd></div>
        <div><dt>Addresses</dt><dd><Link to="/receiving">{state.addressCount}</Link></dd></div>
        {!multiTenant && <div><dt>Region</dt><dd>{state.region}</dd></div>}
      </dl>
      {state.lastError && <Alert tone="danger">{state.lastError}</Alert>}
      {state.status === 'provisioning' && <Alert tone="info">Creating the S3 bucket, SNS topic and SES receipt rule, usually in under a minute.</Alert>}
      {state.mx && state.status !== 'provisioning' && <Alert tone={mxTone(state.mx.state)}>{state.mx.message}</Alert>}
      <DnsRecordTable domain={domainName} records={records} />
    </>}
    <ConfirmDialog open={!!conflict} onOpenChange={open => { if (!open) setConflict(null) }} title={`Move mail for ${domainName}?`} description={`${conflict ?? ''} Mail stops arriving at that provider once the MX record changes.`} confirmLabel="Enable anyway" danger onConfirm={() => enable.mutateAsync(true)} />
    <ConfirmDialog open={disableOpen} onOpenChange={setDisableOpen} title={`Stop receiving on ${domainName}?`} description="SES stops accepting mail for this domain. Addresses and stored messages are kept." confirmLabel="Turn off" danger onConfirm={() => disable.mutateAsync()} />
  </section>
}
