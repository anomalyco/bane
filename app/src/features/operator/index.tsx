import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, Button, Checkbox, ControlSkeleton, DataTable, Dialog, DropdownMenu, EmptyState, ErrorState, Field, Input, PageHeader, SectionHeader, Select, SkeletonText, StatusBadge, Switch, Tabs, Textarea, useToast, type Column, type MenuItem, type Tone } from '../../components/ui'
import { PrivateAddress } from '../../components/PrivateAddress'
import { useSession } from '../../data/context'
import { ApiError, type SenderScoreFactor, type StandingStep } from '../../data/types'
import { isoTime, operatorApi, type OperatorAction, type OperatorCampaign, type OperatorDomain, type OperatorMember, type OperatorQueueItem, type OperatorTimelineItem, type OperatorWorkspace, type TimelineKind } from '../../data/operator'
import { label, number, shortDateTime } from '../../lib/format'
import { factorFormats } from '../score'
import { actionColumnDefs, ActionsTrigger, campaignColumnDefs, domainColumnDefs, factorColumnDefs, facts, memberColumnDefs, useOperatorTabs, OperatorQueueSkeleton, OperatorWorkspaceSkeleton, QueueToolbar, queueColumnDefs, timelineColumnDefs, WorkspaceBodySkeleton } from './skeletons'

// The operator console (lazy, /operator): Bane staff with a platform role review flagged Hosted workspaces and act on
// them through the audited operator API. Impersonation-free: it reads standing, score, limits and evidence, never
// message bodies, and every address is masked. `operator:read` sees everything and changes nothing.
// UI notes (/operator/notes) live in ./notes and load with this chunk.
export { OperatorNotesPage } from './notes'
const useOperatorRole = () => useSession()?.identity?.operator ?? null
const NotFound = () => <EmptyState headingAs="h1" title="Page not found" action={<Link to="/">Return to overview</Link>} />
const def = (defs: typeof queueColumnDefs, key: string) => defs.find(column => column.key === key)!
const when = (value: string | null | undefined) => value ? `${shortDateTime(isoTime(value))} UTC` : '—'
const At = ({ value }: { value: string | null | undefined }) => <span className="nowrap">{when(value)}</span>
const stepTone: Record<StandingStep, Tone> = { ok: 'success', notice: 'neutral', warn: 'warning', restrict: 'warning', pause: 'danger' }
const stepLabel: Record<StandingStep, string> = { ok: 'Good', notice: 'Notice', warn: 'Warn', restrict: 'Restrict', pause: 'Pause' }
const StepBadge = ({ step }: { step: StandingStep }) => <StatusBadge status={stepLabel[step]} tone={stepTone[step]} />

function useDebounced<T>(value: T, ms = 250) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => { const timer = setTimeout(() => setDebounced(value), ms); return () => clearTimeout(timer) }, [value, ms])
  return debounced
}

export function OperatorPage() {
  const role = useOperatorRole()
  const [params, setParams] = useSearchParams()
  const view = params.get('view') === 'actions' ? 'actions' : 'queue'
  const navigate = useNavigate(), tabs = useOperatorTabs()
  if (!role) return <NotFound />
  return <>
    <PageHeader title="Operator" />
    <div className="op-page">
      <Tabs value={view} label="Operator views" items={tabs} onValueChange={value => value === 'notes' ? navigate('/operator/notes') : setParams(previous => { const next = new URLSearchParams(previous); if (value === 'actions') next.set('view', 'actions'); else next.delete('view'); return next }, { replace: true })} />
      {view === 'queue' ? <Queue /> : <Actions />}
    </div>
  </>
}

const flags = (row: OperatorQueueItem) => [row.paused && 'paused', row.quarantined > 0 && `${row.quarantined} quarantined`, row.watch && 'watched', row.strikes > 0 && `${row.strikes} ${row.strikes === 1 ? 'strike' : 'strikes'}`].filter(Boolean).join(' · ')
const queueColumns: Column<OperatorQueueItem>[] = [
  { ...def(queueColumnDefs, 'name'), render: row => <span className="op-cell">{row.name}<span className="op-muted-id"> · {row.workspaceId}</span></span>, cardRender: row => row.name },
  { ...def(queueColumnDefs, 'step'), render: row => <StepBadge step={row.step} /> },
  { ...def(queueColumnDefs, 'reason'), render: row => <span className="op-cell" title={row.reasons.map(reason => reason.message).join('\n')}>{flags(row) && <span className="op-flags">{flags(row)} · </span>}{row.reasons[0]?.message ?? '—'}</span> },
  { ...def(queueColumnDefs, 'score'), render: row => row.score === null ? '—' : row.score.toFixed(1), cardRender: row => row.score === null ? 'Calibrating' : `Score ${row.score.toFixed(1)}` },
  { ...def(queueColumnDefs, 'limit'), render: row => number(row.dailyLimit), cardRender: row => `${number(row.dailyLimit)}/day` },
  { ...def(queueColumnDefs, 'since'), render: row => <At value={row.since} />, cardRender: row => `since ${when(row.since)}` },
]
function Queue() {
  const [search, setSearch] = useState('')
  const [step, setStep] = useState('')
  const q = useDebounced(search.trim())
  const queue = useQuery({ queryKey: ['operator', 'queue', q ? '' : step, q], queryFn: ({ signal }) => operatorApi.queue({ q: q || undefined, step: q ? undefined : step as StandingStep || undefined }, signal), placeholderData: previous => previous })
  return <>
    <QueueToolbar search={search} step={step} onSearch={setSearch} onStep={setStep} />
    {queue.isError && !queue.data ? <ErrorState error={queue.error} onRetry={() => void queue.refetch()} />
      : <DataTable className="op-table" loading={queue.isPending} skeletonRows={6} rows={queue.data ?? []} rowKey={row => row.workspaceId} rowHref={row => `/operator/workspaces/${encodeURIComponent(row.workspaceId)}`}
        empty={<EmptyState title={q ? 'No workspace matches' : 'Nothing to review'} description={q ? 'Search by workspace ID or name.' : 'Workspaces above good standing, watched ones and quarantined campaigns appear here.'} />} columns={queueColumns} />}
  </>
}

const actionColumns: Column<OperatorAction>[] = [
  { ...def(actionColumnDefs, 'action'), render: row => label(row.action.replace(/^operator-/, '').replaceAll('-', '_')) },
  { ...def(actionColumnDefs, 'at'), render: row => <At value={row.at} /> },
  { ...def(actionColumnDefs, 'workspace'), render: row => <Link to={`/operator/workspaces/${encodeURIComponent(row.workspaceId)}`} className="op-muted-id">{row.workspaceId}</Link> },
  { ...def(actionColumnDefs, 'reason'), render: row => <span className="op-cell" title={row.reason ?? undefined}>{row.reason ?? '—'}</span> },
  { ...def(actionColumnDefs, 'ticket'), render: row => <span className="op-cell">{row.ticketRef ?? '—'}</span>, cardRender: row => row.ticketRef ? `Ticket ${row.ticketRef}` : row.via ?? '' },
]
function Actions() {
  const actions = useQuery({ queryKey: ['operator', 'actions'], queryFn: ({ signal }) => operatorApi.actions({}, signal) })
  return actions.isError && !actions.data ? <ErrorState error={actions.error} onRetry={() => void actions.refetch()} />
    : <DataTable className="op-table" loading={actions.isPending} skeletonRows={6} rows={actions.data ?? []} rowKey={row => `${row.at}:${row.workspaceId}:${row.action}:${row.requestId ?? ''}`} empty={<EmptyState title="No operator actions yet" />} columns={actionColumns} />
}

// ---------------------------------------------------------------- one workspace

type ActionKind = 'pause' | 'resume' | 'hold' | 'release' | 'limit' | 'campaign'
type PendingAction = { kind: ActionKind; key: string; campaign?: OperatorCampaign }
const open = (kind: ActionKind, campaign?: OperatorCampaign): PendingAction => ({ kind, key: crypto.randomUUID(), campaign })

export function OperatorWorkspacePage() {
  const role = useOperatorRole()
  const id = useParams().id ?? ''
  const enabled = Boolean(role && id)
  const detail = useQuery({ queryKey: ['operator', 'workspace', id], queryFn: ({ signal }) => operatorApi.workspace(id, signal), enabled })
  const [action, setAction] = useState<PendingAction | null>(null)
  if (!role) return <NotFound />
  if (!detail.data && !detail.isError) return <OperatorWorkspaceSkeleton actions={role === 'operator'} />
  const data = detail.data
  const paused = Boolean(data?.connection?.paused || data?.standing?.step === 'pause'), held = Boolean(data?.standing?.marketingHeld)
  const items: MenuItem[] = [
    paused ? { label: 'Resume sending…', onSelect: () => setAction(open('resume')) } : { label: 'Pause sending…', destructive: true, onSelect: () => setAction(open('pause')) },
    held ? { label: 'Release marketing…', onSelect: () => setAction(open('release')) } : { label: 'Hold marketing…', onSelect: () => setAction(open('hold')) },
    { label: 'Set daily limit…', onSelect: () => setAction(open('limit')) },
  ]
  return <>
    <PageHeader title={data?.workspace.name ?? 'Workspace'} backTo="/operator" actions={role === 'operator' ? data ? <DropdownMenu label="Workspace actions" title={data.workspace.name} trigger={<ActionsTrigger />} items={items} /> : <ActionsTrigger disabled /> : undefined} />
    {!data ? <ErrorState error={detail.error} onRetry={() => void detail.refetch()} /> : <>
      <WorkspaceBody data={data} canAct={role === 'operator'} onReleaseCampaign={campaign => setAction(open('campaign', campaign))} />
      <ActionDialog action={action} workspace={data} onClose={() => setAction(null)} />
    </>}
  </>
}

const Rows = ({ rows }: { rows: [string, ReactNode][] }) => <dl className="op-rows">{rows.map(([title, value]) => <div key={title}><dt>{title}</dt><dd>{value}</dd></div>)}</dl>
const yes = (value: boolean) => value ? 'Yes' : 'No'

function WorkspaceBody({ data, canAct, onReleaseCampaign }: { data: OperatorWorkspace; canAct: boolean; onReleaseCampaign: (campaign: OperatorCampaign) => void }) {
  const { score, standing, connection } = data, limit = score.limit
  const graded = score.state === 'graded' && score.score !== null
  const factValues: Record<(typeof facts)[number], ReactNode> = {
    Step: standing ? <StepBadge step={standing.step} /> : '—',
    Score: graded ? `${score.score!.toFixed(1)} · ${score.grade}` : `Calibrating ${score.emails.firstEmails}/${score.needed}`,
    'Daily limit': limit?.daily == null ? 'None' : `${number(limit.daily)}/day`,
    Since: standing ? when(standing.since) : '—',
    Strikes: standing ? number(standing.strikes) : '—',
    Connection: connection ? `${connection.region}${connection.paused ? ' · paused' : ''}` : 'None',
  }
  const offer = standing?.selfService
  const factorColumns: Column<SenderScoreFactor>[] = [
    { ...def(factorColumnDefs, 'factor'), render: f => <span title={f.basis}>{f.label}</span> },
    { ...def(factorColumnDefs, 'score'), render: f => f.score === null ? 'Neutral' : f.score.toFixed(1), cardRender: f => f.score === null ? 'Neutral' : `Score ${f.score.toFixed(1)}` },
    { ...def(factorColumnDefs, 'value'), render: f => f.value === null ? '—' : factorFormats[f.key](f.value) },
    { ...def(factorColumnDefs, 'weight'), render: f => number(f.weight), cardRender: f => `weight ${f.weight}` },
    { ...def(factorColumnDefs, 'points'), render: f => f.points === null ? '—' : f.points.toFixed(2), cardRender: f => f.points === null ? '' : `${f.points.toFixed(2)} pts` },
  ]
  const domainColumns: Column<OperatorDomain>[] = [
    { ...def(domainColumnDefs, 'name'), render: d => d.name },
    { ...def(domainColumnDefs, 'pool'), render: d => label(d.pool) },
    { ...def(domainColumnDefs, 'region'), render: d => d.region ?? '—' },
    { ...def(domainColumnDefs, 'dkim'), render: d => yes(d.dkim), cardRender: d => `DKIM ${d.dkim ? 'on' : 'off'}` },
    { ...def(domainColumnDefs, 'mailFrom'), render: d => yes(d.mailFrom), cardRender: d => `MAIL FROM ${d.mailFrom ? 'on' : 'off'}` },
    { ...def(domainColumnDefs, 'dmarc'), render: d => d.dmarc ? label(d.dmarc) : 'None', cardRender: d => `DMARC ${d.dmarc ?? 'none'}` },
  ]
  const billing = useQuery({ queryKey: ['operator', 'billing', data.workspace.id], queryFn: ({ signal }) => operatorApi.billing(data.workspace.id, signal) })
  const [freeAction, setFreeAction] = useState<FreeAction | null>(null)
  const personFree = (userId: string) => billing.data?.free.people.find(p => p.userId === userId)?.free ?? null
  const memberColumns: Column<OperatorMember>[] = [
    { ...def(memberColumnDefs, 'email'), render: m => <PrivateAddress value={m.email} /> },
    { ...def(memberColumnDefs, 'role'), render: m => label(m.role) },
    { ...def(memberColumnDefs, 'user'), render: m => <span className="op-muted-id">{m.userId}</span> },
    { ...def(memberColumnDefs, 'billing'), render: m => !billing.data ? <SkeletonText width={96} /> : personFree(m.userId)?.live ? <span className="op-cell" title={personFree(m.userId)!.reason}>Free account{personFree(m.userId)!.until ? ` · until ${when(personFree(m.userId)!.until)}` : ''}</span> : <span className="muted">Billed</span> },
    { ...def(memberColumnDefs, 'actions'), render: m => canAct && billing.data ? <DropdownMenu label={`Billing for ${m.email}`} title="Billing" items={[personFree(m.userId)
      ? { label: 'End free account…', onSelect: () => setFreeAction({ kind: 'person', on: false, userId: m.userId, key: crypto.randomUUID() }) }
      : { label: 'Make account free…', onSelect: () => setFreeAction({ kind: 'person', on: true, userId: m.userId, key: crypto.randomUUID() }) }]} /> : null },
  ]
  const free = billing.data?.free
  const billingState = !free ? null : free.free ? `Free (not billed) · ${free.via === 'workspace' ? 'workspace flag' : 'an owner’s free account'}${free.until ? ` · until ${when(free.until)}` : ''}` : `Billed · ${label(billing.data?.account?.paid_mode ?? 'prepaid')}`
  const campaignColumns: Column<OperatorCampaign>[] = [
    { ...def(campaignColumnDefs, 'name'), render: c => <span className="op-cell">{c.name}</span> },
    { ...def(campaignColumnDefs, 'state'), render: c => <StatusBadge status={c.state} /> },
    { ...def(campaignColumnDefs, 'pause'), render: c => <span className="op-cell" title={c.pauseReason?.message}>{c.pauseReason?.code ? label(c.pauseReason.code.toLowerCase()) : '—'}</span> },
    { ...def(campaignColumnDefs, 'quarantines'), render: c => number(c.quarantines), cardRender: c => `${number(c.quarantines)} ${c.quarantines === 1 ? 'quarantine' : 'quarantines'}` },
    { ...def(campaignColumnDefs, 'actions'), render: c => canAct && c.state === 'paused' ? <DropdownMenu label={`Actions for ${c.name}`} title={c.name} items={[{ label: 'Release campaign…', onSelect: () => onReleaseCampaign(c) }]} /> : null },
  ]
  return <div className="op-page">
    <dl className="op-facts">{facts.map(title => <div key={title}><dt>{title}</dt><dd>{factValues[title]}</dd></div>)}</dl>
    <div className="op-grid">
      <section className="op-section" aria-labelledby="op-standing"><SectionHeader title={<span id="op-standing">Standing and why</span>} />
        {standing?.reasons.length ? <ul className="op-reasons">{standing.reasons.map(reason => <li key={reason.code}><span>{reason.message}</span><span className="muted">{reason.code}{reason.window ? ` · ${reason.window}` : ''} · {reason.step}</span></li>)}</ul> : null}
        <Rows rows={[
          ['Pause', connection?.paused ? `${standing?.pauseKind === 'bounce' ? 'Bounce-only' : 'Full'}${connection.pauseReason ? ` · ${connection.pauseReason}` : ''}` : 'Not paused'],
          ['SES tenants', !connection ? '—' : connection.resuming ? 'Enabling before sending resumes' : connection.tenants.length ? connection.tenants.map(t => `${t.region} ${t.applied === 'DISABLED' ? 'disabled' : t.applied === 'DISABLING' ? 'possibly disabled' : 'enabled'}`).join(' · ') : 'Enabled'],
          ['Marketing', standing?.marketingRelease ? `Released at ${standing.marketingRelease.percent}% until ${when(standing.marketingRelease.until)}` : standing?.marketingHeld ? 'Held' : 'Flowing'],
          ['Self-service', !offer ? '—' : offer.available ? `${label(offer.action ?? 'none')} available` : offer.reason ? `${offer.reason}${offer.availableAt ? ` From ${when(offer.availableAt)}.` : ''}` : 'Nothing to release'],
          ['Version', standing ? `${standing.version} · sequence ${standing.sequence}` : '—'],
          ['Sponsor siblings', data.siblings.length ? <ul className="op-siblings">{data.siblings.map(sibling => <li key={sibling.id}><Link to={`/operator/workspaces/${encodeURIComponent(sibling.id)}`}>{sibling.name}</Link></li>)}</ul> : 'None'],
          ['Created', when(data.workspace.createdAt)],
        ]} />
      </section>
      <section className="op-section" aria-labelledby="op-limit"><SectionHeader title={<span id="op-limit">Limit math</span>} />
        {limit ? <Rows rows={[
          ['Enforced', limit.daily === null ? 'No daily limit' : `${number(limit.daily)} a day · ${label(limit.source)}`],
          ['Score band', `${number(limit.band)} a day${limit.next ? ` · next ${number(limit.next.limit)} at ${limit.next.atScore}` : ''}`],
          ['Score', graded ? `${score.score!.toFixed(1)} → target ${score.target.toFixed(1)} · quality ${score.raw.toFixed(1)}` : `Calibrating${score.calibratedAt ? `, graded from ${when(new Date(Date.parse(score.calibratedAt) + 86_400_000).toISOString())}` : ''}`],
          ['Override', limit.override ? `${number(limit.override.daily)} a day${limit.override.expiresAt ? ` until ${when(limit.override.expiresAt)}` : ', no expiry'}` : data.exempt ? 'Exempt from hosted quotas' : 'None'],
          ['Restore', limit.restore ? `${number(limit.restore.daily)} a day until ${when(limit.restore.until)}` : 'None'],
          ['Strike cap', limit.strikeCapUntil ? `50% until ${when(limit.strikeCapUntil)}` : 'None'],
          ['Bursts', `${number(limit.perMinute)} a minute · marketing ${number(limit.marketingPerHour)} an hour`],
          ['Transactional reserve', number(limit.transactionalReserve)],
        ]} /> : <EmptyState title="No hosted limit" />}
      </section>
    </div>
    <section className="op-section"><SectionHeader title="Factors" /><DataTable className="op-table" rows={score.factors} rowKey={f => f.key} columns={factorColumns} empty={<EmptyState title="No factors yet" />} /></section>
    <section className="op-section"><SectionHeader title="Domains" /><DataTable className="op-table" rows={data.domains} rowKey={d => d.name} columns={domainColumns} empty={<EmptyState title="No domains" />} /></section>
    <section className="op-section" aria-labelledby="op-billing"><SectionHeader title={<span id="op-billing">Billing</span>} />
      <dl className="op-rows op-rows--single">
        <div><dt>Billing</dt><dd title={billingState ?? undefined}>{billingState ?? <SkeletonText width={220} />}</dd></div>
        <div><dt>Free (not billed)</dt><dd className="op-free">{!free ? <ControlSkeleton width={36} /> : <>
          <span title={canAct ? undefined : 'Needs the operator role'}><Switch label={<span className="sr-only">Free (not billed)</span>} checked={Boolean(free.workspace && !free.workspace.expired)} disabled={!canAct}
            onCheckedChange={on => setFreeAction({ kind: 'workspace', on, key: crypto.randomUUID() })} /></span>
          <span className="muted op-cell" title={free.workspace?.reason ?? undefined}>{free.workspace ? `${free.workspace.expired ? 'Ended' : 'Since'} ${when(free.workspace.expired ? free.workspace.until : free.workspace.at)}${!free.workspace.expired && free.workspace.until ? ` · until ${when(free.workspace.until)}` : ''} · ${free.workspace.reason ?? ''}` : 'This workspace’s own flag'}</span>
        </>}</dd></div>
        <div><dt>Free owners</dt><dd>{!free ? <SkeletonText width={160} /> : number(free.people.filter(p => p.role === 'owner' && p.free?.live).length)}</dd></div>
      </dl>
    </section>
    <section className="op-section"><SectionHeader title="Members" /><DataTable className="op-table" rows={data.members} rowKey={m => m.userId} columns={memberColumns} empty={<EmptyState title="No members" />} /></section>
    <FreeDialog action={freeAction} workspaceId={data.workspace.id} onClose={() => setFreeAction(null)} />
    <section className="op-section"><SectionHeader title="Campaigns" /><DataTable className="op-table" rows={data.campaigns} rowKey={c => c.id} columns={campaignColumns} empty={<EmptyState title="No active or quarantined campaigns" />} /></section>
    <Timeline workspaceId={data.workspace.id} />
  </div>
}

const kindTone: Record<TimelineKind, Tone> = { standing: 'warning', limit: 'neutral', quarantine: 'danger', release: 'success', tenant: 'warning', operator: 'info', score: 'neutral', audit: 'info', bounces: 'warning', rejection: 'danger' }
type Json = Record<string, unknown>
const record = (value: unknown): Json => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : {}
// One line of what the API recorded for an event; it carries no addresses and no message bodies.
function detailText(item: OperatorTimelineItem) {
  const d = record(item.detail), details = record(d.details), actor = record(d.actor)
  const reasons = Array.isArray(d.reasons) ? d.reasons.map(reason => record(reason).message).filter((m): m is string => typeof m === 'string') : []
  const parts: unknown[] = item.kind === 'score' ? [`${number(Number(d.accepted ?? 0))} accepted`, `${number(Number(d.bounced ?? 0))} bounced`, `${number(Number(d.complained ?? 0))} complaints`, `${number(Number(d.rejected ?? 0))} rejected`]
    : item.kind === 'audit' ? [d.reason, d.ticketRef && `ticket ${d.ticketRef}`, d.via]
    : item.kind === 'rejection' ? [d.spam !== undefined && `spam ${typeof d.spam === 'object' ? JSON.stringify(d.spam) : d.spam}`, d.campaignId && `campaign ${d.campaignId}`]
    : item.kind === 'bounces' ? []
    : [...reasons, details.reason, details.ticketRef && `ticket ${details.ticketRef}`, actor.kind && `by ${actor.kind}${actor.via ? ` via ${actor.via}` : ''}`]
  return parts.filter(part => typeof part === 'string' && part).join(' · ')
}
const timelineColumns: Column<OperatorTimelineItem & { key: string }>[] = [
  { ...def(timelineColumnDefs, 'title'), render: item => <span className="op-cell" title={item.title}>{item.title}</span> },
  { ...def(timelineColumnDefs, 'kind'), render: item => <StatusBadge status={label(item.kind)} tone={kindTone[item.kind] ?? 'neutral'} /> },
  { ...def(timelineColumnDefs, 'detail'), render: item => { const text = detailText(item); return <span className="op-cell muted" title={text}>{text || '—'}</span> } },
  { ...def(timelineColumnDefs, 'at'), render: item => <At value={item.at} /> },
]
// The evidence timeline: standing changes, operator actions, the daily score, bounces and complaints by recipient
// domain and screen rejections, newest first. "Load more" pages back with the API's cursor.
function Timeline({ workspaceId }: { workspaceId: string }) {
  const timeline = useInfiniteQuery({
    queryKey: ['operator', 'timeline', workspaceId], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => operatorApi.timeline(workspaceId, pageParam, signal), getNextPageParam: page => page.nextCursor ?? undefined,
  })
  const rows = (timeline.data?.pages ?? []).flatMap((page, p) => page.items.map((item, i) => ({ ...item, key: `${p}:${i}:${item.at}:${item.kind}` })))
  return <section className="op-section"><SectionHeader title="Evidence timeline" />
    {timeline.isError && !timeline.data ? <ErrorState error={timeline.error} onRetry={() => void timeline.refetch()} /> : <>
      <DataTable className="op-table" loading={timeline.isPending} skeletonRows={5} rows={rows} rowKey={row => row.key} columns={timelineColumns} empty={<EmptyState title="No events yet" />} />
      {timeline.hasNextPage && <Button className="op-more" loading={timeline.isFetchingNextPage} onClick={() => void timeline.fetchNextPage()}>Load more</Button>}
      {timeline.isError && timeline.data && <Alert tone="danger">{timeline.error instanceof Error ? timeline.error.message : 'Couldn’t load more events.'}</Alert>}
    </>}
  </section>
}

// ---------------------------------------------------------------- actions

const actionCopy: Record<ActionKind, { title: string; description: string; confirm: string; done: string; danger?: boolean }> = {
  pause: { title: 'Pause sending?', description: 'All sending stops and the SES tenants are disabled. Owners see a pause banner and are emailed.', confirm: 'Pause sending', done: 'Sending paused', danger: true },
  resume: { title: 'Resume sending?', description: 'Sending resumes at the restore share you choose; a strike stays on record.', confirm: 'Resume sending', done: 'Sending resumed' },
  hold: { title: 'Hold marketing?', description: 'Campaigns pause and new marketing is refused; transactional mail keeps sending.', confirm: 'Hold marketing', done: 'Marketing held' },
  release: { title: 'Release marketing?', description: 'Campaigns can send again; the workspace stays at Warn until it clears.', confirm: 'Release marketing', done: 'Marketing released' },
  limit: { title: 'Set the daily limit', description: 'An override replaces the score’s limit until it expires. Clear it to return to the score’s limit.', confirm: 'Save limit', done: 'Limit saved' },
  campaign: { title: 'Release this campaign?', description: 'The quarantined campaign resumes where it stopped.', confirm: 'Release campaign', done: 'Campaign released' },
}
// Each opening has its own Idempotency-Key, and every submit sends If-Match with the standing version it was decided on.
// Free (not billed): a workspace's own flag, or a person's (every workspace they own while they own it). Operators only;
// the reason goes into the audit log. An end date is optional.
type FreeAction = { kind: 'workspace' | 'person'; on: boolean; userId?: string; key: string }
function FreeDialog({ action, workspaceId, onClose }: { action: FreeAction | null; workspaceId: string; onClose: () => void }) {
  const last = useRef(action)
  if (action) last.current = action
  const shown = action ?? last.current
  const title = !shown ? '' : shown.kind === 'workspace' ? shown.on ? 'Make this workspace free?' : 'Bill this workspace again?' : shown.on ? 'Make this person’s account free?' : 'End this person’s free account?'
  const description = !shown ? undefined : shown.kind === 'workspace'
    ? shown.on ? 'It is never gated or charged; usage is still measured. The customer sees “Free plan (courtesy of Anomaly)”.' : 'Usage settled from now on is charged again, unless an owner has a free account.'
    : shown.on ? 'Every workspace this person owns is free while they own it. It binds to their sign-in, not their email.' : 'The workspaces they own are billed again unless they are free on their own.'
  return <Dialog open={action !== null} onOpenChange={next => { if (!next) onClose() }} title={title} description={description}>
    {shown && <FreeForm key={shown.key} action={shown} workspaceId={workspaceId} onClose={onClose} />}
  </Dialog>
}
function FreeForm({ action, workspaceId, onClose }: { action: FreeAction; workspaceId: string; onClose: () => void }) {
  const client = useQueryClient(), toast = useToast()
  const [reason, setReason] = useState(''), [ticket, setTicket] = useState(''), [until, setUntil] = useState(''), [tried, setTried] = useState(false)
  const reasonError = reason.trim().length < 10 ? 'At least 10 characters.' : reason.trim().length > 1000 ? 'At most 1,000 characters.' : ''
  const untilError = until && !(Date.parse(until) > Date.now()) ? 'A time in the future.' : ''
  const mutation = useMutation({
    mutationFn: () => {
      const input = { free: action.on, reason, ticketRef: ticket, until: until ? new Date(until).toISOString() : null }, guard = { idempotencyKey: action.key }
      return action.kind === 'workspace' ? operatorApi.workspaceFree(workspaceId, input, guard) : operatorApi.personFree(action.userId!, input, guard)
    },
    onSuccess: () => { toast(action.on ? 'Marked free' : 'Billed again', 'success'); void client.invalidateQueries({ queryKey: ['operator'] }); onClose() },
  })
  function submit(event: FormEvent) { event.preventDefault(); setTried(true); if (!reasonError && !untilError) mutation.mutate() }
  return <form className="op-dialog-fields" onSubmit={submit} noValidate>
    {action.on && <Field label="Ends" hint="Optional. Empty means no end date." error={tried ? untilError : ''}><Input type="datetime-local" value={until} onChange={event => setUntil(event.target.value)} /></Field>}
    <Field label="Reason" hint="Goes into the audit log." error={tried ? reasonError : ''}><Textarea value={reason} maxLength={1000} onChange={event => setReason(event.target.value)} /></Field>
    <Field label="Ticket" hint="Optional: the support ticket ID or URL."><Input value={ticket} maxLength={200} onChange={event => setTicket(event.target.value)} /></Field>
    {mutation.error && <Alert tone="danger">{mutation.error instanceof Error ? mutation.error.message : 'Couldn’t complete the action.'}</Alert>}
    <div className="ui-dialog__footer"><Button disabled={mutation.isPending} onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={mutation.isPending}>{action.on ? 'Make free' : 'Bill again'}</Button></div>
  </form>
}
function ActionDialog({ action, workspace, onClose }: { action: PendingAction | null; workspace: OperatorWorkspace; onClose: () => void }) {
  const last = useRef(action)
  if (action) last.current = action
  const shown = action ?? last.current
  return <Dialog open={action !== null} onOpenChange={next => { if (!next) onClose() }} title={shown ? actionCopy[shown.kind].title : ''} description={shown ? shown.kind === 'campaign' ? `${shown.campaign?.name}: ${actionCopy.campaign.description}` : actionCopy[shown.kind].description : undefined}>
    {shown && <ActionForm key={shown.key} action={shown} workspace={workspace} onClose={onClose} />}
  </Dialog>
}
function ActionForm({ action, workspace, onClose }: { action: PendingAction; workspace: OperatorWorkspace; onClose: () => void }) {
  const client = useQueryClient(), toast = useToast()
  const copy = actionCopy[action.kind]
  const [reason, setReason] = useState(''), [ticket, setTicket] = useState(''), [restore, setRestore] = useState<'50' | '100'>('50')
  const [daily, setDaily] = useState(workspace.override ? String(workspace.override.daily) : ''), [expires, setExpires] = useState(''), [clear, setClear] = useState(false)
  const [tried, setTried] = useState(false)
  const reasonError = reason.trim().length < 10 ? 'At least 10 characters.' : reason.trim().length > 1000 ? 'At most 1,000 characters.' : ''
  const ticketError = ticket.trim().length > 200 ? 'At most 200 characters.' : ''
  const dailyValue = Number(daily), dailyError = action.kind === 'limit' && !clear && !(Number.isInteger(dailyValue) && dailyValue >= 1 && dailyValue <= 10_000_000) ? 'A whole number from 1 to 10,000,000.' : ''
  const mutation = useMutation({
    mutationFn: () => {
      const id = workspace.workspace.id, why = { reason, ticketRef: ticket }, guard = { idempotencyKey: action.key, ifMatch: workspace.standing?.version }
      switch (action.kind) {
        case 'pause': return operatorApi.pause(id, why, guard)
        case 'resume': return operatorApi.resume(id, { ...why, restore: restore === '100' ? 100 : 50 }, guard)
        case 'hold': return operatorApi.marketing(id, { ...why, held: true }, guard)
        case 'release': return operatorApi.marketing(id, { ...why, held: false }, guard)
        case 'limit': return operatorApi.limit(id, { ...why, daily: clear ? null : dailyValue, expiresAt: expires ? new Date(expires).toISOString() : null }, guard)
        case 'campaign': return operatorApi.releaseCampaign(action.campaign!.id, why, guard)
      }
    },
    onSuccess: () => { toast(copy.done, 'success'); void client.invalidateQueries({ queryKey: ['operator'] }); onClose() },
    // A stale version means someone (or the ladder) changed the standing: reread it so the next try decides on it.
    onError: error => { if (error instanceof ApiError && error.status === 412) void client.invalidateQueries({ queryKey: ['operator', 'workspace', workspace.workspace.id] }) },
  })
  function submit(event: FormEvent) {
    event.preventDefault()
    setTried(true)
    if (reasonError || ticketError || dailyError) return
    mutation.mutate()
  }
  return <form className="op-dialog-fields" onSubmit={submit} noValidate>
    {action.kind === 'resume' && <Field label="Restore"><Select aria-label="Restore" value={restore} onValueChange={value => setRestore(value as '50' | '100')} options={[{ value: '50', label: '50% of the limit for 48 hours' }, { value: '100', label: 'The full limit' }]} /></Field>}
    {action.kind === 'limit' && <>
      <Checkbox checked={clear} onCheckedChange={setClear} label="Return to the score’s limit" disabled={!workspace.override} />
      <Field label="Daily limit" hint={`Recipients per rolling 24 hours. The score’s band is ${number(workspace.score.limit?.band ?? 0)}.`} error={tried ? dailyError : ''}><Input type="number" inputMode="numeric" min={1} max={10_000_000} step={1} value={clear ? '' : daily} disabled={clear} onChange={event => setDaily(event.target.value)} /></Field>
      <Field label="Expires" hint="Optional, at most a year ahead. Empty means no expiry."><Input type="datetime-local" value={expires} disabled={clear} onChange={event => setExpires(event.target.value)} /></Field>
    </>}
    <Field label="Reason" hint="Goes into the audit log and the workspace’s timeline." error={tried ? reasonError : ''}><Textarea value={reason} maxLength={1000} onChange={event => setReason(event.target.value)} /></Field>
    <Field label="Ticket" hint="Optional: the support ticket ID or URL." error={tried ? ticketError : ''}><Input value={ticket} maxLength={200} onChange={event => setTicket(event.target.value)} /></Field>
    {mutation.error && <Alert tone="danger">{mutation.error instanceof Error ? mutation.error.message : 'Couldn’t complete the action.'}</Alert>}
    <div className="ui-dialog__footer"><Button disabled={mutation.isPending} onClick={onClose}>Cancel</Button><Button type="submit" variant={copy.danger ? 'danger' : 'primary'} loading={mutation.isPending}>{copy.confirm}</Button></div>
  </form>
}
