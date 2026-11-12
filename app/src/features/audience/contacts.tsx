import { useEffect, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { useApiMutation, useApiDef, useApiQuery, useRegion, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import type { Contact, ContactInput, ConsentInput } from '../../data/types'
import { SearchField, Alert, Button, Checkbox, ControlSkeleton, DataTable, Dialog, EmptyState, ErrorState, Field, Input, LoadingRegion, PageHeader, Pagination, PaginationSkeleton, SectionHeader, Select, SkeletonText, StatusBadge } from '../../components/ui'
import { activityColumns, AudienceRouteSkeleton, consentColumns } from './skeletons'
import { ConsentLegend, consentHelp, ContactTable, date, fieldError, ListPicker, MutationError, statusOptions, useAudienceLists } from './shared'
import { ImportContactsDialog } from './import'
import { BulkSubscribeDialog } from './bulk'
import { AudienceHeader } from './header'
import { useAdaptivePageSize, useCursorPagination } from '../../lib/pagination'
import { PrivateAddress } from '../../components/PrivateAddress'

// Search, consent status, list and page live in the URL (q, status, list, page), so Back from a contact, a reload or a
// shared link shows the same contacts. Each change replaces the entry: Back leaves the page instead of undoing typing.
export function ContactsPage() {
  const { pageSize, tableRef } = useAdaptivePageSize(5, 20, 'contacts')
  const [params, setParams] = useSearchParams()
  const search = params.get('q') ?? '', status = statusOptions.some(option => option.value === params.get('status')) ? params.get('status')! : '', listId = params.get('list') ?? ''
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1)
  const update = (changes: Record<string, string | number>) => setParams(current => { const next = new URLSearchParams(current); for (const [key, value] of Object.entries(changes)) { if (value === '' || (key === 'page' && value === 1)) next.delete(key); else next.set(key, String(value)) } return next }, { replace: true })
  const [add, setAdd] = useState(false)
  const [importing, setImporting] = useState(false)
  const [bulk, setBulk] = useState(false)
  // A new fitted page size starts over at page 1; the size the page opened with keeps the page from the URL.
  const fitted = useRef(pageSize)
  useEffect(() => { if (fitted.current !== pageSize) { fitted.current = pageSize; update({ page: 1 }) } }, [pageSize])
  const lists = useAudienceLists()
  const query = useApiDef(queries.contacts({ page, pageSize, search, status, listId }), { keepPrevious: true })
  // Pages are cursor-based: a page this session never reached (a reload on page 3) opens on the page the API returned.
  const served = query.isPlaceholderData ? undefined : query.data?.page
  useEffect(() => { if (served !== undefined && served !== page) update({ page: served }) }, [served, page])
  const filtered = Boolean(search || status || listId)
  return <div className="audience-page">
    <AudienceHeader actions={<><Button onClick={() => setImporting(true)}>Import contacts</Button><Button variant="primary" onClick={() => setAdd(true)}>Add contact</Button></>} />
    <div className="data-toolbar"><div className="cluster"><SearchField className="search-box--list" aria-label="Search contacts" placeholder="Search email or name" value={search} onChange={event => update({ q: event.target.value, page: 1 })} /><Select className="audience-status-filter" aria-label="Filter by consent" value={status} onValueChange={value => update({ status: value, page: 1 })} options={[{ value: '', label: 'All contacts' }, ...statusOptions]} /><ListPicker className="audience-list-filter" label="Filter by list" emptyLabel="All lists" value={listId} onChange={value => update({ list: value, page: 1 })} /></div>{status === 'unknown' && <Button onClick={() => setBulk(true)}>Mark as subscribed…</Button>}</div>
    <ConsentLegend />
    {query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <><ContactTable tableRef={tableRef} contacts={query.data?.items || []} lists={lists.data} listsLoading={lists.isPending} loading={query.isPending} minRows={pageSize} empty={filtered ? <EmptyState title="No matching contacts" description={status === 'unknown' && !search ? 'Everyone here has a consent decision.' : undefined} action={<Button onClick={() => update({ q: '', status: '', list: '', page: 1 })}>Clear filters</Button>} /> : <EmptyState title="No contacts yet" description="Contacts are the people you email. Import a CSV or add them one at a time." action={<Button onClick={() => setImporting(true)}>Import contacts</Button>} />} />{query.isPending ? <PaginationSkeleton /> : <Pagination page={page} pageSize={pageSize} total={query.data.total} nextCursor={query.data.nextCursor} onPageChange={next => update({ page: next })} />}</>}
    {add && <ContactEditor onClose={() => setAdd(false)} />}
    {importing && <ImportContactsDialog listId={listId} onClose={() => setImporting(false)} />}
    {bulk && <BulkSubscribeDialog listId={listId || undefined} searchIgnored={Boolean(search)} onClose={() => setBulk(false)} />}
  </div>
}

function ContactEditor({ contact, onClose }: { contact?: Contact; onClose: () => void }) {
  const [input, setInput] = useState<ContactInput>(() => contact ? { id: contact.id, email: contact.email, name: contact.name, country: contact.country, status: contact.status, listIds: [...contact.listIds] } : { email: '', name: '', country: '', status: 'unsubscribed', listIds: [] })
  const [listSearch, setListSearch] = useState('')
  const [listCursor, setListCursor] = useState<string | undefined>()
  const lists = useAudienceLists(listSearch, listCursor)
  const save = useApiMutation((api, value: ContactInput) => api.contacts.save(value), contact ? 'Contact updated' : 'Contact added')
  async function submit() {
    try { await save.mutateAsync({ ...input, status: contact ? contact.status : 'unknown' }); onClose() } catch { /* Shown inline. */ }
  }
  return <Dialog open onOpenChange={open => { if (!open && !save.isPending) onClose() }} title={contact ? 'Edit contact' : 'Add contact'} footer={<><Button onClick={onClose} disabled={save.isPending}>Cancel</Button><Button variant="primary" type="submit" form="contact-editor" loading={save.isPending} disabled={lists.isPending || lists.isError}>{contact ? 'Save changes' : 'Add contact'}</Button></>}>
    <form id="contact-editor" className="stack" onSubmit={event => { event.preventDefault(); void submit() }}>
      <MutationError error={save.error} />
      <Field label="Email" htmlFor="contact-email" error={fieldError(save.error, 'email')}><Input id="contact-email" type="email" required readOnly={!!contact} value={input.email} onChange={event => setInput({ ...input, email: event.target.value })} /></Field>
      <div className="form-grid"><Field label="Full name" htmlFor="contact-name" error={fieldError(save.error, 'name')}><Input id="contact-name" value={input.name} onChange={event => setInput({ ...input, name: event.target.value })} /></Field><Field label="Country" htmlFor="contact-country" hint="Two-letter country code, e.g. US." error={fieldError(save.error, 'country')}><Input id="contact-country" maxLength={2} value={input.country} onChange={event => setInput({ ...input, country: event.target.value })} /></Field></div>
      <Field label="Find lists" htmlFor="contact-list-search"><Input id="contact-list-search" type="search" placeholder="Search list names" value={listSearch} onChange={event => {setListSearch(event.target.value); setListCursor(undefined)}} /></Field>
      <Field label="Lists" error={fieldError(save.error, 'listIds')}><div className="stack">{lists.isPending ? <LoadingRegion label="Loading lists"><ControlSkeleton /></LoadingRegion> : lists.isError ? <ErrorState error={lists.error} onRetry={() => lists.refetch()} /> : lists.data.length ? lists.data.map(list => <Checkbox key={list.id} checked={input.listIds.includes(list.id)} onCheckedChange={checked => setInput({ ...input, listIds: checked ? [...input.listIds, list.id] : input.listIds.filter(id => id !== list.id) })} label={list.name} />) : <span className="muted">No matching lists.</span>}</div></Field>
      {(listCursor || lists.data?.nextCursor) && <div className="cluster"><Button disabled={save.isPending || lists.isFetching || !listCursor} onClick={() => setListCursor(undefined)}>First matching lists</Button><Button disabled={save.isPending || lists.isFetching || !lists.data?.nextCursor} onClick={() => setListCursor(lists.data?.nextCursor ?? undefined)}>Next matching lists</Button></div>}
      {!contact && <Alert tone="info">New contacts start with Unknown consent, so campaigns skip them until they’re marked subscribed.</Alert>}
      {contact?.status === 'suppressed' && <Alert tone="warning">Suppressed: {contact.suppressionReason || 'Delivery blocked.'}</Alert>}
    </form>
  </Dialog>
}

export function ContactDetailPage() {
  const { id = '' } = useParams()
  const query = useApiQuery(['contacts', id], (api, signal) => api.contacts.get(id, signal))
  return query.isPending ? <AudienceRouteSkeleton kind="contact" /> : query.isError ? <><PageHeader title="Contact" backTo="/audience" /><ErrorState error={query.error} onRetry={() => query.refetch()} /></> : <ContactDetails key={id} contact={query.data} />
}
const consentSources: Record<string, string> = { dashboard: 'Dashboard', api: 'API', mcp: 'MCP', 'agent-token': 'Agent token', import: 'CSV import', audienceql: 'Bulk update', 'footer-confirm': 'Unsubscribe link', 'rfc8058-post': 'One-click unsubscribe', 'ses-subscription': 'SES unsubscribe' }
const consentAction = (status: Contact['status']) => status === 'subscribed' ? 'Unsubscribe' : status === 'unsubscribed' ? 'Resubscribe' : 'Subscribe'
function ContactDetails({ contact }: { contact: Contact }) {
  const { regionId } = useRegion()
  const [edit, setEdit] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const lists = useAudienceLists()
  const initialConsent = (): ConsentInput => ({ status: contact.status === 'subscribed' ? 'unsubscribed' : 'subscribed', confirmResubscribe: false, evidence: '' })
  const [consentInput, setConsentInput] = useState<ConsentInput>(initialConsent)
  const status = useApiMutation((api, input: ConsentInput) => api.consent(contact.id, { ...input, evidence: input.evidence?.trim() || undefined }), 'Consent recorded', false, true, contact.id)
  // Matching emails waits for the first page of consent history, so the history's height is known before anything sits below it.
  const history = useApiQuery(['consent-history', contact.id, undefined], api => api.consentHistory(contact.id))
  useApiQuery(['emails', 'contact-activity', { search: contact.email, page: 1, pageSize: 5, regionId }], (api, signal) => api.emails.list({ search: contact.email, page: 1, pageSize: 5, regionId }, signal))
  async function changeStatus() {
    try { await status.mutateAsync(consentInput); setConfirm(false) } catch { /* Shown in the consent dialog. */ }
  }
  const subscribing = consentInput.status === 'subscribed'
  return <div className="audience-page">
    <PageHeader title={contact.name || <PrivateAddress value={contact.email} />} backTo="/audience" actions={<><Button disabled={contact.status === 'suppressed' || status.isPending} title={contact.status === 'suppressed' ? 'Suppressed addresses are never emailed, so consent can’t be changed here.' : undefined} onClick={() => { status.reset(); setConsentInput(initialConsent()); setConfirm(true) }}>{consentAction(contact.status)}</Button><Button variant="primary" onClick={() => setEdit(true)}>Edit contact</Button></>} />
    <div className="audience-summary cluster">{contact.name && <PrivateAddress value={contact.email} />}<StatusBadge status={contact.status} /><span className="muted">{consentHelp[contact.status]}</span></div>
    <div className="section form-grid audience-properties"><section><SectionHeader title="Properties" /><dl><dt>Full name</dt><dd>{contact.name || '—'}</dd><dt>Country</dt><dd>{contact.country || '—'}</dd><dt>Created</dt><dd>{date(contact.createdAt)}</dd><dt>Last opened</dt><dd>{date(contact.lastOpenedAt)}</dd></dl></section><section><SectionHeader title="Marketing consent" /><dl><dt>Status</dt><dd>{statusOptions.find(option => option.value === contact.status)?.label ?? contact.status}<span className="audience-dd-note">{consentHelp[contact.status]}</span></dd><dt>Suppression</dt><dd>{contact.suppressionReason || 'None'}<span className="audience-dd-note">{contact.suppressionReason ? 'Never emailed. Consent changes don’t lift it.' : 'Blocks all email after a bounce or complaint.'}</span></dd></dl></section></div>
    <section className="section"><SectionHeader title="Lists" actions={<Button onClick={() => setEdit(true)}>Manage lists</Button>} />{lists.isPending ? <LoadingRegion label="Loading list memberships"><SkeletonText width={170} /></LoadingRegion> : lists.isError ? <ErrorState error={lists.error} onRetry={() => lists.refetch()} /> : <div className="cluster audience-links">{contact.listIds.length ? contact.listIds.map(id => <Link key={id} to={`/audience/lists/${id}`}>{lists.data.find(list => list.id === id)?.name || 'Unnamed list'}</Link>) : <span className="muted">Not on any lists.</span>}</div>}</section>
    <ConsentHistory id={contact.id} />
    {!history.isPending && <ContactActivity key={`${contact.email}:${regionId}`} email={contact.email} />}
    {edit && <ContactEditor contact={contact} onClose={() => setEdit(false)} />}
    <Dialog open={confirm} onOpenChange={open => { if (!status.isPending) setConfirm(open) }} title={subscribing ? 'Mark as subscribed' : 'Mark as unsubscribed'} description={subscribing ? 'Records that this person agreed to receive marketing email, so campaigns can send to them.' : 'Records that this person opted out. Campaigns skip them; transactional email still sends.'} footer={<><Button onClick={() => setConfirm(false)} disabled={status.isPending}>Cancel</Button><Button variant="primary" type="submit" form="contact-consent" loading={status.isPending}>{subscribing ? 'Mark as subscribed' : 'Mark as unsubscribed'}</Button></>}><form id="contact-consent" className="stack" onSubmit={event => { event.preventDefault(); void changeStatus() }}>
      <Field label="Status" htmlFor="consent-status"><Select id="consent-status" value={consentInput.status} onValueChange={value => setConsentInput({ ...consentInput, status: value as ConsentInput['status'] })} options={[{ value: 'subscribed', label: 'Subscribed' }, { value: 'unsubscribed', label: 'Unsubscribed' }]} /></Field>
      <Field label={subscribing ? 'How did they agree? (optional)' : 'How did they opt out? (optional)'} htmlFor="consent-evidence" hint={`Saved in this contact’s consent history, for example “${subscribing ? 'Asked to join by email on Nov 3' : 'Asked by phone to stop marketing email'}”.`} error={fieldError(status.error, 'evidence')}><Input id="consent-evidence" maxLength={2000} value={consentInput.evidence ?? ''} onChange={event => setConsentInput({ ...consentInput, evidence: event.target.value })} /></Field>
      {contact.status === 'unsubscribed' && subscribing && <Checkbox checked={consentInput.confirmResubscribe ?? false} onCheckedChange={checked => setConsentInput({ ...consentInput, confirmResubscribe: checked })} label="This person opted out before and has opted in again." />}
      <MutationError error={status.error} />
    </form></Dialog>
  </div>
}
function ContactActivity({ email }: { email: string }) {
  const { regionId } = useRegion()
  const { multiTenant } = useWorkspaceAccess()
  const [page, setPage] = useState(1)
  const params = { search: email, page, pageSize: 5, regionId }
  const query = useApiQuery(['emails', 'contact-activity', params], (api, signal) => api.emails.list(params, signal))
  return <section className="section"><SectionHeader title="Matching emails" />{!multiTenant && <p className="muted">Emails in {regionId}</p>}{query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <><DataTable rows={query.data?.items || []} loading={query.isPending} skeletonRows={5} minRows={5} rowKey={row => row.id} empty={<EmptyState title="No email activity" />} columns={[{ ...activityColumns[0], render: row => <Link className="audience-cell-text" title={row.subject} to={`/logs/${row.id}`}>{row.subject}</Link> }, { ...activityColumns[1], render: row => <StatusBadge status={row.status} /> }, { ...activityColumns[2], render: row => date(row.sentAt) }]} />{query.isPending ? <PaginationSkeleton /> : <Pagination page={page} pageSize={5} total={query.data.total} nextCursor={query.data.nextCursor} onPageChange={setPage} />}</>}</section>
}

function ConsentHistory({ id }: { id: string }) {
  const pagination = useCursorPagination(), cursor = pagination.cursor
  const query = useApiQuery(['consent-history', id, cursor], api => api.consentHistory(id, cursor))
  return <section className="section"><SectionHeader title="Consent history" /><p className="muted">Every change to this person’s marketing consent, and how it was given or withdrawn.</p>{query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <><DataTable loading={query.isPending} skeletonRows={1} rows={query.data?.items ?? []} rowKey={row => row.id} empty={<EmptyState title="No consent recorded yet" description="Changes appear here when this person subscribes, opts out or is marked subscribed." />} columns={[{ ...consentColumns[0], render: row => row.status === 'subscribed' ? 'Subscribed' : 'Unsubscribed' }, { ...consentColumns[1], render: row => consentSources[row.source] ?? row.source }, { ...consentColumns[2], render: row => row.evidence || '—' }, { ...consentColumns[3], render: row => row.policyVersion || '—' }, { ...consentColumns[4], render: row => date(row.occurredAt) }]} />{query.data && <Pagination page={pagination.page} pageSize={20} nextCursor={query.data.nextCursor} onPageChange={next => pagination.onPageChange(next, query.data?.nextCursor)} />}</>}</section>
}
