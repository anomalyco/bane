import { Fragment, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { ArrowUpRight, Download, Paperclip, Search, X } from 'lucide-react'
import { useApiDef, useApiQuery, useRegion, useApi, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import type { Email, LogDirection, LogEntry, ReceivedEmailDetail } from '../../data/types'
import { Alert, Button, CopyButton, DataTable, EmptyState, ErrorState, Input, PaginationSkeleton, PageHeader, Pagination, SectionHeader, Select, StatusBadge, Tabs } from '../../components/ui'
import { EmailPreview, ReceivedEmailPreview, htmlToText } from '../../components/EmailPreview'
import { date, label, time } from '../../lib/format'
import { downloadCsv } from '../../lib/download'
import { EmailDetailSkeleton } from './skeletons'
import { isReceivedId, logColumns, logCsvRows, logHref, useLogRowIntent } from './rows'
import { useAdaptivePageSize } from '../../lib/pagination'
import { AddressList, NamedAddress, PrivateAddress } from '../../components/PrivateAddress'

const directions = [{ value: 'all', label: 'All' }, { value: 'sent', label: 'Sent' }, { value: 'received', label: 'Received' }]
// Sent statuses, most looked-for first; received and spam filter received mail (spam is visible to owners and admins).
const sentStatuses = ['delivered', 'bounced', 'complained', 'delayed', 'suppressed', 'rejected', 'rendering_failed', 'queued', 'attempting', 'accepted', 'sent', 'canceled', 'acceptance_unknown', 'simulated']
const receivedStatuses = ['received', 'spam']
const option = (value: string) => ({ value, label: value === 'all' ? 'All statuses' : label(value) })
const streams = [{ value: 'all', label: 'All streams' }, { value: 'transactional', label: 'Transactional' }, { value: 'marketing', label: 'Marketing' }]
export const logDirection = (view: string | null, campaignId?: string): LogDirection => campaignId ? 'sent' : view === 'sent' || view === 'received' ? view : 'all'

// Logs: sent and received mail in one list, newest first (GET /v1/logs). Received mail follows the API's rules: owners
// and admins see every received message, including unrouted mail; members see mail on receiving addresses.
export function LogsPage() {
  const { regionId } = useRegion()
  const [params] = useSearchParams()
  const campaignId = params.get('campaign') || undefined
  return <Logs key={`${regionId}:${campaignId ?? ''}`} regionId={regionId} campaignId={campaignId} />
}
// The sidebar's region selector already names the region; repeat it only when it is hidden or a campaign filter shows another region.
// Hosted logs span every region and name none.
export function LogsHeader({ regionId, direction, onDirection, locked }: { regionId: string; direction: LogDirection; onDirection: (value: LogDirection) => void; locked?: boolean }) {
  const selected = useRegion().regionId
  const { canAdminister, multiTenant } = useWorkspaceAccess()
  return <PageHeader title="Logs" actions={<div className="cluster logs-controls">{!multiTenant && (!canAdminister || regionId !== selected) && <span className="muted">{regionId}</span>}
    <Tabs label="Direction" value={direction} onValueChange={value => onDirection(value as LogDirection)} disabled={locked} items={directions} /></div>} />
}
// Everything that decides the rows is in the URL (view, q, status, stream, page), so Back from an email, a reload or a
// shared link shows the same page of the same list. Filters replace the entry instead of adding one per keystroke.
function Logs({ regionId, campaignId }: { regionId: string; campaignId?: string }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const rowIntent = useLogRowIntent()
  const { multiTenant, canAdminister } = useWorkspaceAccess()
  // A campaign sends from one region, so its filter replaces the region selector; it lists sent mail only.
  const campaign = useApiQuery(['campaign', campaignId ?? null], (api, signal) => campaignId ? api.campaigns.get(campaignId, signal) : Promise.resolve(null))
  const direction = logDirection(searchParams.get('view'), campaignId)
  const search = searchParams.get('q') ?? ''
  const allowed = new Set([...direction === 'received' ? [] : sentStatuses, ...campaignId || direction === 'sent' ? [] : canAdminister ? receivedStatuses : ['received']])
  const requested = searchParams.get('status') ?? 'all'
  const status = allowed.has(requested) ? requested : 'all'
  const receivedOnly = direction === 'received' || receivedStatuses.includes(status)
  const requestedStream = searchParams.get('stream')
  const stream = !receivedOnly && (requestedStream === 'transactional' || requestedStream === 'marketing') ? requestedStream : 'all'
  const page = Math.max(1, Math.floor(Number(searchParams.get('page'))) || 1)
  const update = (changes: Record<string, string | null>, keepPage = false) => setSearchParams(previous => {
    const next = new URLSearchParams(previous)
    for (const [key, value] of Object.entries(changes)) if (value === null || value === '' || value === 'all') next.delete(key); else next.set(key, value)
    if (!keepPage) next.delete('page')
    return next
  }, { replace: true })
  const clearCampaign = () => update({ campaign: null })
  // The box keeps its own text while you type and writes it to the URL once you pause: binding the input to the URL
  // directly dropped keystrokes that landed before the previous one's navigation. Back or Clear filters still reset it.
  const [draft, setDraft] = useState(search)
  const written = useRef(search), typing = useRef<number | undefined>(undefined)
  useEffect(() => { if (search !== written.current) { window.clearTimeout(typing.current); written.current = search; setDraft(search) } }, [search])
  useEffect(() => () => window.clearTimeout(typing.current), [])
  const type = (value: string) => { setDraft(value); window.clearTimeout(typing.current); typing.current = window.setTimeout(() => { written.current = value; update({ q: value }) }, 250) }
  const {pageSize, tableRef, measured} = useAdaptivePageSize(5, 100, 'logs')
  // A new page size (the window resized) starts from the first page; the size settling on mount keeps the URL's page.
  const fitted = useRef<number | null>(null)
  useEffect(() => { if (!measured) return; if (fitted.current !== null && fitted.current !== pageSize) update({ page: null }); fitted.current = pageSize }, [pageSize, measured]) // eslint-disable-line react-hooks/exhaustive-deps
  // Status and stream follow the direction: a sent status leaves Received, received and spam leave Sent, and streams are sent mail only.
  const setDirection = (value: LogDirection) => update({ view: value, status: value === 'received' && sentStatuses.includes(status) || value === 'sent' && receivedStatuses.includes(status) ? null : status, stream: value === 'received' ? null : stream })
  const params = { ...(campaignId ? { campaignId } : { regionId }), direction, search, status: status === 'all' ? undefined : status, stream: stream === 'all' ? undefined : stream, page, pageSize }
  const query = useApiDef(queries.logs(params), { interval: 30_000, enabled: measured, keepPrevious: true })
  // A page the session has no cursor for (a reload, or the window's page size changed) comes back as page 1: say so in the URL too.
  const served = query.data && !query.isPlaceholderData ? query.data.page : undefined
  useEffect(() => { if (served !== undefined && served !== page) update({ page: served === 1 ? null : String(served) }, true) }, [served, page]) // eslint-disable-line react-hooks/exhaustive-deps
  // The previous filter's rows stay on screen while the next loads, keyed apart from the result that replaces them: a
  // row in both lists (received mail under All and Received) is swapped in place, not moved down the table.
  const filtered = Boolean(search || campaignId || status !== 'all' || stream !== 'all')
  return <div className="logs-page"><LogsHeader regionId={campaign.data?.regionId ?? regionId} direction={direction} onDirection={setDirection} locked={Boolean(campaignId)} />
    <div className="data-toolbar"><div className="cluster">{campaignId && <Button variant="secondary" aria-label={`Remove campaign filter: ${campaign.data?.name ?? campaignId}`} onClick={clearCampaign} title={campaign.data?.name}><span className="logs-campaign-chip">Campaign: {campaign.data?.name ?? campaignId}</span><X size={14} aria-hidden /></Button>}<div className="search-box"><Search size={16} /><Input type="search" aria-label="Search logs" placeholder="Search logs" value={draft} onChange={event => type(event.target.value)} /></div>
      <Select aria-label="Email status" value={status} onValueChange={value => update({ status: value, ...receivedStatuses.includes(value) ? { stream: null } : {} })} options={['all', ...[...allowed].sort((a, b) => [...receivedStatuses, ...sentStatuses].indexOf(a) - [...receivedStatuses, ...sentStatuses].indexOf(b))].map(option)} />
      <Select aria-label="Email stream filter" value={stream} disabled={receivedOnly} onValueChange={value => update({ stream: value })} options={streams} /></div>
      <Button className="logs-export" aria-label="Export this page as CSV" title="Download the rows on this page as a CSV file" disabled={!query.data?.items.length} onClick={() => downloadCsv(campaignId ? `bane-${campaignId}-logs-page.csv` : 'bane-logs-page.csv', logCsvRows(query.data?.items ?? [], !multiTenant))}><Download size={16} /><span>Export CSV</span></Button>
    </div>
    {query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <>
      <DataTable<LogEntry> className="logs-table" tableRef={tableRef} loading={query.isPending} skeletonRows={pageSize} minRows={pageSize} rows={query.data?.items ?? []} rowKey={row => `${query.isPlaceholderData ? 'previous:' : ''}${row.direction}:${row.id}`} rowHref={logHref} onRowIntent={rowIntent} columns={logColumns}
        empty={campaignId && !search && status === 'all' && stream === 'all' && campaign.data && !campaign.data.counts?.total ? <EmptyState title="Nothing sent from this campaign yet" description={campaign.data.scheduledAt && Date.parse(campaign.data.scheduledAt) > Date.now() ? `It is scheduled for ${date(campaign.data.scheduledAt)} at ${time(campaign.data.scheduledAt)} UTC. Each email appears here once it sends.` : 'Each email appears here once it sends.'} action={<Link className="ui-button ui-button--secondary ui-button--md" to={`/campaigns/${encodeURIComponent(campaignId)}/review`}>Back to campaign</Link>} />
          : filtered ? <EmptyState title="No matching mail" action={<Button onClick={() => update({ q: null, status: null, stream: null, campaign: null, ...direction !== 'all' && !campaignId ? { view: null } : {} })}>Clear filters</Button>} />
          : <EmptyState title={direction === 'received' ? 'No mail received yet' : direction === 'sent' ? 'No mail sent yet' : 'No mail yet'} description="Every email you send or receive appears here." action={<Link className="ui-button ui-button--secondary ui-button--md" to="/docs">Send your first email</Link>} />} />
      {query.data ? <Pagination page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} nextCursor={query.data.nextCursor} count={query.data.items.length} onPageChange={next => update({ page: next === 1 ? null : String(next) }, true)} /> : <PaginationSkeleton />}
    </>}
  </div>
}

// One detail route for both directions: received message IDs start with msg_.
export function LogDetailPage() {
  const { id = '' } = useParams()
  return isReceivedId(id) ? <ReceivedEmailDetailPage /> : <EmailDetailPage />
}

const checkTone = (value?: string) => value === 'PASS' ? 'success' as const : value === 'FAIL' ? 'danger' as const : value === 'GRAY' ? 'warning' as const : 'neutral' as const
const fileSize = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1_048_576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`
export function ReceivedEmailDetailPage() {
  const { id = '' } = useParams()
  // Delivery details (envelope, region, verdicts, headers, the raw .eml) are for owners and admins; members read the message.
  const { canAdminister } = useWorkspaceAccess()
  const query = useApiDef(queries.receivedEmail(id, canAdminister))
  if (query.isPending) return <EmailDetailSkeleton />
  if (query.isError) return <><PageHeader title="Received email" backTo="/logs" /><ErrorState error={query.error} onRetry={() => query.refetch()} /></>
  return <ReceivedEmailDetailView email={query.data} />
}
function ReceivedEmailDetailView({ email }: { email: ReceivedEmailDetail }) {
  const { multiTenant } = useWorkspaceAccess()
  const [view, setView] = useState('preview')
  // Inline images reference attachments by Content-ID. The preview swaps in the signed S3 link only for an
  // exact img[src="cid:…"] after sanitizing, never by text replacement in sender-controlled HTML (L15).
  const html = email.html ?? ''
  const inlineImages = Object.fromEntries(email.attachments.flatMap(file => file.contentId && file.url ? [[file.contentId, file.url]] : []))
  const hasHtml = html.trim().length > 0
  const verdicts = email.verdicts ?? {}
  const checks = (['spf', 'dkim', 'dmarc', 'spam', 'virus'] as const).filter(key => verdicts[key])
  return <div className="email-detail-page"><PageHeader title={email.subject || '(no subject)'} backTo="/logs" actions={email.rawUrl ? <a className="ui-button ui-button--secondary ui-button--md" href={email.rawUrl}><Download size={16} />Download .eml</a> : undefined} />
    <dl className="email-metadata"><div><dt>From</dt><dd><NamedAddress name={email.from.name} address={email.from.address} /></dd></div><div><dt>To</dt><dd>{email.envelopeTo?.length ? <AddressList values={email.envelopeTo} /> : <AddressList values={email.to.map(to => to.address)} />}</dd></div>{email.addresses && <div><dt>Address</dt><dd>{email.addresses.length ? email.addresses.map((mailbox, index) => <Fragment key={mailbox.id}>{index > 0 && ', '}<Link to={`/receiving/inbox?address=${encodeURIComponent(mailbox.id)}&thread=${encodeURIComponent(email.threadId)}&message=${encodeURIComponent(email.id)}`}><PrivateAddress value={mailbox.address} /></Link></Fragment>) : 'Unrouted'}</dd></div>}</dl>
    {email.spam && <Alert tone="warning">SES flagged this message as spam or a virus. It’s stored, but spam never creates a new address.</Alert>}
    {email.bodyTruncated && <Alert tone="info">Part of this message was too large to store. Download the original for the full content.</Alert>}
    <div className="email-detail-grid"><section><Tabs value={view} onValueChange={setView} items={[{ value: 'preview', label: 'Preview' }, { value: 'plain', label: 'Plain text' }, { value: 'html', label: 'HTML' }, { value: 'headers', label: 'Headers' }]} />
      {view === 'preview' ? hasHtml ? <><ReceivedEmailPreview html={html} tooComplex={email.htmlTooComplex} title="Received message preview" inlineImages={inlineImages} />{email.htmlTooComplex && email.text && <pre className="plain-text-preview">{email.text}</pre>}</> : email.text ? <pre className="plain-text-preview">{email.text}</pre> : <EmptyState title="This message has no body" />
        : view === 'plain' ? <pre className="message-source">{email.text || 'No plain-text body.'}</pre>
        : view === 'html' ? <pre className="message-source">{email.html || 'No HTML body.'}</pre>
        : <pre className="message-source">{(email.headers ?? []).map(header => `${header.name}: ${header.value}`).join('\n') || 'No headers stored.'}</pre>}
    </section><section className="delivery-timeline received-details">
      <SectionHeader title="Details" />
      <dl className="received-facts">
        <div><dt>Received</dt><dd>{date(email.receivedAt)} · {time(email.receivedAt)} UTC</dd></div>
        {email.sentAt && <div><dt>Sent</dt><dd>{date(email.sentAt)} · {time(email.sentAt)} UTC</dd></div>}
        {checks.length > 0 && <div><dt>Checks</dt><dd><span className="cluster">{checks.map(key => <StatusBadge key={key} status={`${key.toUpperCase()} ${label(String(verdicts[key]).toLowerCase())}`} tone={checkTone(String(verdicts[key]))} />)}</span><span className="muted received-checks-note">Sender authentication (SPF, DKIM, DMARC) and spam and virus scans. None means no record to check, not a failure.</span></dd></div>}
        {email.cc.length > 0 && <div><dt>Cc</dt><dd><AddressList values={email.cc.map(cc => cc.address)} /></dd></div>}
        {email.replyTo.length > 0 && <div><dt>Reply-To</dt><dd><AddressList values={email.replyTo.map(r => r.address)} /></dd></div>}
        {email.sizeBytes != null && <div><dt>Size</dt><dd>{fileSize(email.sizeBytes)}</dd></div>}
      </dl>
      {email.attachments.length > 0 && <div className="received-group"><h3 className="received-heading">Attachments</h3><ul className="received-attachments">{email.attachments.map(file => <li key={file.id}>
        <Paperclip size={14} aria-hidden />{file.url ? <a href={file.url} target="_blank" rel="noreferrer">{file.filename}</a> : <span>{file.filename}</span>}<span className="muted">{fileSize(file.size)}{file.disposition === 'inline' ? ' · inline' : ''}</span>
      </li>)}</ul></div>}
    </section></div>
    <div className="message-identifiers"><span className="cluster">Message ID <span className="identifier">{email.id}</span><CopyButton value={email.id} label="Copy message ID" /></span>{email.messageId && <span className="cluster">Message-ID <span className="identifier" title={email.messageId}>{email.messageId}</span><CopyButton value={email.messageId} label="Copy Message-ID header" /></span>}{!multiTenant && <span>SES · {email.region ?? '—'}</span>}</div>
  </div>
}

// Statuses that can still change without user action; terminal emails are not polled.
const pendingStatuses = ['queued', 'attempting', 'accepted', 'sent', 'deferred', 'delayed']
export function EmailDetailPage() {
  const { id = '' } = useParams()
  const query = useApiDef(queries.email(id), { interval: email => email && pendingStatuses.includes(email.status) ? 30_000 : false })
  if (query.isPending) return <EmailDetailSkeleton />
  if (query.isError) return <><PageHeader title="Email detail" backTo="/logs" /><ErrorState error={query.error} onRetry={() => query.refetch()} /></>
  return query.data ? <EmailDetail email={query.data} /> : null
}
function EmailDetail({ email }: { email: Email }) {
  const navigate = useNavigate()
  const { multiTenant } = useWorkspaceAccess()
  const api = useApi()
  const [events, setEvents] = useState(email.events)
  const [cursor, setCursor] = useState(email.eventsNextCursor)
  const [eventError, setEventError] = useState('')
  const [eventBusy, setEventBusy] = useState(false)
  const [view, setView] = useState('preview')
  const hasHtml = email.html.trim().length > 0
  const plainText = email.text ?? (api.mode === 'demo' && hasHtml ? htmlToText(email.html) : '')
  const hasPlainText = plainText.trim().length > 0
  const contact = email.contact
  return <div className="email-detail-page"><PageHeader title={email.subject} backTo="/logs" actions={<span className="email-header-actions"><span data-hidden={contact ? true : undefined}><StatusBadge status={email.status} /></span><Button data-hidden={contact ? undefined : true} onClick={() => contact && navigate(`/audience/contacts/${contact.id}`)}>View contact<ArrowUpRight size={16} /></Button></span>} />
    <dl className="email-metadata"><div><dt>To</dt><dd><AddressList values={email.to.split(', ').filter(Boolean)} /></dd></div><div><dt>From</dt><dd><NamedAddress name={email.fromName} address={email.from} /></dd></div><div><dt>Stream</dt><dd>{label(email.stream)}</dd></div></dl>
    {email.simulated && <Alert tone="info">Simulated; not sent to SES.</Alert>}
    {email.status === 'bounced' && <Alert tone="warning">Delivery failed.{contact?.suppressed && ' This address is suppressed.'}</Alert>}
    {['complaint', 'complained'].includes(email.status) && <Alert tone="danger">The recipient reported this message as spam.{contact?.suppressed && ' This address is suppressed.'}</Alert>}
    {['deferred', 'delayed'].includes(email.status) && <Alert tone="warning">Delivery delayed.</Alert>}
    <div className="email-detail-grid"><section><Tabs value={view} onValueChange={setView} items={[{ value: 'preview', label: 'Preview' }, { value: 'html', label: 'HTML' }, { value: 'plain', label: 'Plain text' }]} />
      {view === 'preview' ? hasHtml ? <EmailPreview html={email.html} title="Email message preview" attachmentIds={email.attachments} remoteImages /> : hasPlainText ? <pre className="plain-text-preview">{plainText}</pre> : <EmptyState title="No message snapshot available" /> : <pre className="message-source">{view === 'html' ? email.html || 'No HTML snapshot available.' : hasPlainText ? plainText : 'No plain-text snapshot available.'}</pre>}
    </section><section className="delivery-timeline"><SectionHeader title="Delivery timeline" actions={<span className="muted">UTC</span>} />{!events.length && !cursor && <p className="muted">No delivery events yet.</p>}<ol>{chronological(events).map(event => <li key={event.id}><span className={`timeline-dot ui-tone--${eventTone(event.type)}`} /><div><div className="cluster between"><span title={`Event type: ${event.type}`}>{eventLabel(event.type)}</span><time className="muted">{time(event.at)}</time></div>{eventMeaning(event.type) && <p className="muted">{eventMeaning(event.type)}</p>}{event.diagnostic && <pre className="diagnostic">{event.diagnostic}</pre>}</div></li>)}</ol>{eventError && <Alert tone="danger">{eventError}</Alert>}{cursor && api.emailEvents && <Button loading={eventBusy} onClick={async () => {setEventBusy(true); setEventError(''); try {const next = await api.emailEvents!(email.id, cursor); setEvents(previous => [...previous, ...next.items]); setCursor(next.nextCursor)} catch (error) {setEventError(error instanceof Error ? error.message : 'Couldn’t load events.')} finally {setEventBusy(false)}}}>Load more events</Button>}</section></div>
    <div className="message-identifiers"><span className="cluster">Email ID <span className="identifier">{email.id}</span><CopyButton value={email.id} label="Copy email ID" /></span><span>Created {date(email.sentAt)} · {time(email.sentAt)} UTC</span>{!multiTenant && <span>SES · {email.regionId}</span>}</div>
  </div>
}

// One plain name and one line of meaning per delivery event; the raw event type stays on hover for support and logs.
const eventCopy: Record<string, [title: string, meaning: string]> = {
  dispatch_attempt: ['Handed to SES', 'Bane passed the email to Amazon SES.'],
  accepted: ['Accepted by SES', 'SES took the email and gave it a message ID.'],
  dispatch_deferred: ['Waiting to send', 'Bane is holding the email until there is sending capacity.'],
  provider_throttled: ['Slowed down by SES', 'SES asked Bane to slow down; the email is retried automatically.'],
  acceptance_unknown: ['Acceptance unknown', 'SES didn’t confirm whether it took the email, so Bane won’t resend it.'],
  send: ['Sent by SES', 'SES is delivering it to the recipient’s mail server.'], sent: ['Sent by SES', 'SES is delivering it to the recipient’s mail server.'],
  delivery: ['Delivered', 'The recipient’s mail server accepted it.'], delivered: ['Delivered', 'The recipient’s mail server accepted it.'],
  bounce: ['Bounced', 'The recipient’s server refused it. The reason is below.'], bounced: ['Bounced', 'The recipient’s server refused it. The reason is below.'],
  complaint: ['Marked as spam', 'The recipient reported it as spam.'], complained: ['Marked as spam', 'The recipient reported it as spam.'],
  reject: ['Rejected', 'SES refused to send it, for example because it contained a virus.'], rejected: ['Rejected', 'SES refused to send it, for example because it contained a virus.'],
  rendering_failure: ['Rendering failed', 'A template value couldn’t be filled in, so nothing was sent.'], rendering_failed: ['Rendering failed', 'A template value couldn’t be filled in, so nothing was sent.'],
  delivery_delay: ['Delayed', 'The recipient’s server put it off; SES keeps retrying.'], delivery_delayed: ['Delayed', 'The recipient’s server put it off; SES keeps retrying.'],
  open: ['Opened', 'The recipient opened it with images on.'], opened: ['Opened', 'The recipient opened it with images on.'],
  click: ['Clicked', 'The recipient clicked a link in it.'], clicked: ['Clicked', 'The recipient clicked a link in it.'],
  suppressed: ['Suppressed', 'Not sent: the address is suppressed after an earlier bounce or complaint.'],
  canceled: ['Canceled', 'The email was canceled before it was sent.'],
  subscription: ['Subscription changed', 'The recipient changed their subscription from this email.'],
}
const eventKey = (type: string) => type.replace(/^email\./, '')
// Oldest first; events in the same second keep the order mail moves through them (Handed, Accepted, Sent, Delivered).
const lifecycle = Object.keys(eventCopy)
const chronological = <T extends { at: string; type: string }>(list: T[]) => [...list].sort((a, b) => Date.parse(a.at.slice(0, 19)) - Date.parse(b.at.slice(0, 19)) || lifecycle.indexOf(eventKey(a.type)) - lifecycle.indexOf(eventKey(b.type)))
function eventLabel(type: string) { return eventCopy[eventKey(type)]?.[0] ?? label(eventKey(type)) }
function eventMeaning(type: string) { return eventCopy[eventKey(type)]?.[1] }
function eventTone(type: string) {
  const key = eventKey(type)
  if (['delivery', 'delivered', 'open', 'opened', 'click', 'clicked'].includes(key)) return 'success'
  if (['bounce', 'bounced', 'delivery_delay', 'delivery_delayed', 'provider_throttled', 'dispatch_deferred', 'acceptance_unknown', 'suppressed'].includes(key)) return 'warning'
  if (['complaint', 'complained', 'reject', 'rejected', 'rendering_failure', 'rendering_failed'].includes(key)) return 'danger'
  return 'neutral'
}
