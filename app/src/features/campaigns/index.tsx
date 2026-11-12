import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router'
import { useApiMutation, useApiQuery, useRegion, useApi, useWorkspaceAccess } from '../../data/context'
import { useRefreshListsOnChange } from '../../data/invalidation'
import { useRegionCatalog } from '../../data/regions'
import { ApiError, campaignEditable, campaignResumable, type Campaign, type CampaignInput, type SendCampaignInput } from '../../data/types'
import {
  Alert, Button, Checkbox, ConfirmDialog, Dialog, ErrorState,
  Field, Input, PageHeader, SectionHeader, Select, SkeletonText,
  StatusBadge, Tabs, useToast,
} from '../../components/ui'
import { EmailPreview } from '../../components/EmailPreview'
import { date, number, time } from '../../lib/format'
import { CampaignAudienceSkeleton, CampaignRouteSkeleton } from './skeletons'
import { CampaignPacing, CampaignProgress, campaignDisplayStatus, campaignPollInterval, maxPerDay, maxRatePercent, minPerDay, minRatePercent, perDayError, ratePercentError } from './CampaignProgress'
import { CampaignArchiveButton } from './CampaignArchiveButton'
export { CampaignsPage } from './CampaignList'
export { TemplatesPage, TemplateEditorPage } from './templates'
import { TemplatePickerDialog } from './templates'
import './campaigns.css'
import type { EmailComposerRef } from './EmailComposer'
import { composer as composerChunk, EmailComposer } from './composer-chunk'
import { ChunkFallback } from '../../lib/preloadable'
import { CampaignSenderInput } from './CampaignSenderInput'
import { CampaignAttachments, type CampaignAttachmentsRef } from './CampaignAttachments'
import { campaignVersion, useCampaignSync } from './useCampaignSync'
import { ComposerSkeleton } from './skeletons'
import { AddressList, NamedAddress, PrivateAddress } from '../../components/PrivateAddress'
import { useSingleFlight } from '../../lib/single-flight'

const message = (error: unknown) => error instanceof ApiError ? error.text : error instanceof Error ? error.message : 'Something went wrong. Please try again.'
// {{placeholders}} the campaign uses; email always resolves, everything else needs a contact value or a fallback.
const placeholderPattern = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g
export const placeholders = (...sources: (string | undefined)[]) => [...new Set(sources.flatMap(source => [...(source ?? '').matchAll(placeholderPattern)].map(match => match[1]!)))]
const placeholderLabel: Record<string, string> = { name: 'the contact has no name', firstName: 'the contact has no first name', email: '' }
const emailIsValid = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
const replyToAddresses = (value: string) => value.split(',').map(address => address.trim()).filter(Boolean)
const replyToError = (value: string) => { const addresses = replyToAddresses(value); return addresses.length > 10 ? 'Use at most 10 Reply-To addresses.' : addresses.some(address => !emailIsValid(address)) ? 'Enter valid Reply-To addresses separated by commas.' : '' }
const campaignRoute = (campaign: Pick<Campaign, 'id'>, view: 'edit' | 'review') => `/campaigns/${encodeURIComponent(campaign.id)}/${view}`
function campaignReadinessError(campaign: Campaign) {
  const missing = [!campaign.name.trim() && 'a campaign name', !campaign.subject.trim() && 'a subject', !emailIsValid(campaign.fromEmail.trim()) && 'a valid sender email address', !campaign.listId && 'a recipient list', !campaign.html.trim() && 'email content'].filter(Boolean)
  return missing.length ? `Complete the draft before reviewing or sending: add ${missing.join(', ')}.` : ''
}
const olderCampaign = (candidate: Campaign, baseline: Campaign) => (candidate.revision ?? 1) < (baseline.revision ?? 1) || ((candidate.revision ?? 1) === (baseline.revision ?? 1) && Date.parse(candidate.updatedAt) < Date.parse(baseline.updatedAt))
const campaignInput = (campaign: Campaign): CampaignInput => ({
  id: campaign.id, revision: campaign.revision, draft: campaign.draft, attachments: campaign.attachments, regionId: campaign.regionId,
  name: campaign.name, subject: campaign.subject, previewText: campaign.previewText, fromName: campaign.fromName, fromEmail: campaign.fromEmail, replyTo: campaign.replyTo,
  listId: campaign.listId, segmentId: campaign.segmentId, html: campaign.html, defaults: Object.fromEntries(Object.entries(campaign.draft?.defaults ?? {}).map(([key, value]) => [key, String(value)])),
})

export function CampaignEditorPage() {
  const { id } = useParams()
  const { regionId } = useRegion()
  // Hosted campaigns follow their From domain's region, so a new draft needs no region at all.
  const { multiTenant } = useWorkspaceAccess()
  const regions = useRegionCatalog({ enabled: !id && !multiTenant })
  const fallbackRegion = multiTenant ? '' : regionId || regions.data?.defaultRegion || ''
  const scope = useRef({ id, key: id ?? 'new', createdId: null as string | null })
  if (scope.current.id !== id) {
    const ownCreation = !scope.current.id && id === scope.current.createdId
    scope.current = { id, key: ownCreation ? scope.current.key : id ?? 'new', createdId: null }
  }
  if (!id && !multiTenant && !fallbackRegion) return <CampaignRouteSkeleton kind="editor" isNew />
  return <CampaignEditorLoader key={scope.current.key} id={id} fallbackRegion={fallbackRegion} preserveEditor={next => {scope.current.createdId = next.id}} />
}

function CampaignEditorLoader({ id, fallbackRegion, preserveEditor }: { id?: string; fallbackRegion: string; preserveEditor: (campaign: Campaign) => void }) {
  const query = useApiQuery<Campaign | null>(['campaign', id ?? 'new'], (api, signal) => id ? api.campaigns.get(id, signal) : Promise.resolve(null))
  const opened = useRef<Campaign | null | undefined>(undefined)
  useEffect(() => { void composerChunk.preload().catch(() => {}) }, [])
  useEffect(() => {
    if (query.data) console.info('[Bane timing] campaign content ready', { navigationMs: Number(performance.now().toFixed(1)), revision: query.data.revision })
  }, [query.data])
  if (opened.current === undefined && query.data !== undefined && (query.data === null || (!query.data.archivedAt && campaignEditable(query.data)))) opened.current = query.data
  // Once opened, background refetches must never unmount an unsaved working copy.
  if (opened.current !== undefined) return <CampaignEditor initial={opened.current} fallbackRegion={fallbackRegion} preserveEditor={preserveEditor} />
  if (query.isPending) return <CampaignRouteSkeleton kind="editor" isNew={!id} />
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />
  if (query.data?.archivedAt) return <div className="stack campaign-locked">
    <PageHeader title={query.data.name} backTo="/campaigns?archived=true" actions={<CampaignArchiveButton campaign={query.data} />} />
    <Alert tone="info">This campaign is archived. Restore it to edit or send it.</Alert>
    <Link to={campaignRoute(query.data, 'review')}>View campaign</Link>
  </div>
  if (query.data && !campaignEditable(query.data)) return <div className="stack campaign-locked">
    <PageHeader title={query.data.name} backTo="/campaigns" />
    <Alert tone="info">{campaignResumable(query.data) && query.data.status === 'failed' ? 'This campaign failed after releasing some recipients. Resume or cancel it from its review page; it cannot be edited or sent again from scratch.' : `This campaign is ${query.data.status} and cannot be edited.`}</Alert>
    <Link to={campaignRoute(query.data, 'review')}>View campaign</Link>
  </div>
  return null
}

function CampaignEditor({ initial, fallbackRegion, preserveEditor }: { initial: Campaign | null; fallbackRegion: string; preserveEditor: (campaign: Campaign) => void }) {
  const toast = useToast()
  const { multiTenant } = useWorkspaceAccess()
  const api = useApi()
  const navigate = useNavigate()
  const [accepted, setAccepted] = useState(initial)
  const acceptedRef = useRef(initial)
  const [form, setForm] = useState<CampaignInput>(() => initial ? campaignInput(initial) : { regionId: fallbackRegion, name: '', subject: '', previewText: '', fromName: '', fromEmail: '', replyTo: [], listId: '', segmentId: null, html: '', defaults: {} })
  const [templatesOpen, setTemplatesOpen] = useState(false)
  // Body placeholders are known from the last saved body; subject and inbox preview are read as they are typed.
  const [bodyKeys, setBodyKeys] = useState(() => placeholders(initial?.html))
  const [replyToText, setReplyToText] = useState(() => (initial?.replyTo ?? []).join(', '))
  const formRef = useRef(form)
  function updateForm(next: CampaignInput) { formRef.current = next; setForm(next) }
  const editVersion = useRef(0)
  const [edits, setEdits] = useState(0)
  const [autosaving, setAutosaving] = useState(false)
  const [autosavePaused, setAutosavePaused] = useState(false)
  const creation = useRef<{ input: CampaignInput; version: number; ambiguous?: boolean } | null>(null)
  const mounted = useRef(true)
  const composer = useRef<EmailComposerRef>(null)
  const attachments = useRef<CampaignAttachmentsRef>(null)
  const [generation, setGeneration] = useState(0)
  const [composerReady, setComposerReady] = useState(false)
  const readyRef = useRef(false)
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
  const busyRef = useRef(false)
  const [remote, setRemote] = useState<Campaign | null>(null)
  const remoteRef = useRef<Campaign | null>(null)
  const [reviewUpdate, setReviewUpdate] = useState(false)
  const [loadingLatest, setLoadingLatest] = useState(false)
  const refreshController = useRef<AbortController | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [attachmentsBusy, setAttachmentsBusy] = useState(false)
  const [composerBusy, setComposerBusy] = useState(false)
  const handleComposerReady = useCallback(() => { readyRef.current = true; setComposerReady(true) }, [])
  const [error, setError] = useState('')
  const [testOpen, setTestOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(Boolean(initial?.previewText))
  const previewInput = useRef<HTMLInputElement>(null)
  const guard = useRef(false)
  useEffect(() => {
    mounted.current = true
    const warn = (event: BeforeUnloadEvent) => { if (dirtyRef.current || guard.current) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', warn)
    return () => { mounted.current = false; refreshController.current?.abort(); window.removeEventListener('beforeunload', warn) }
  }, [])
  const [optionCursors, setOptionCursors] = useState<{lists?: string; domains?: string}>({})
  const options = useApiQuery(['campaign-options', { pageSize: 100, ...optionCursors }], async (api, signal) => {
    const [listPage, domainPage, segmentPage] = await Promise.all([
      api.lists.list({ pageSize: 100, cursor: optionCursors.lists, counts: false }, signal), api.domains.list({pageSize: 100, cursor: optionCursors.domains, refresh: false}, signal),
      api.segments.list({ pageSize: 100 }, signal),
    ])
    const lists = [...listPage.items].sort((a, b) => a.name.localeCompare(b.name)), domains = domainPage.items
    return { lists, segments: [...segmentPage.items].sort((a, b) => a.name.localeCompare(b.name)), domains: domains.filter(domain => domain.status === 'verified'), next: {lists: listPage.nextCursor, domains: domainPage.nextCursor} }
  })
  const previousOptions = useRef<typeof options.data>(undefined)
  if (options.data) previousOptions.current = options.data
  const choices = options.data ?? previousOptions.current ?? { lists: [], segments: [], domains: [], next: { lists: null, domains: null } }
  const cache = useQueryClient()
  // Saves write the campaign into the cache instead of refetching every query on each autosave.
  const saveMutation = useApiMutation((api, input: CampaignInput) => api.campaigns.save(input), undefined, false, false)
  const pending = preparing || autosaving || attachmentsBusy || composerBusy || saveMutation.isPending || loadingLatest
  busyRef.current = pending
  const markDirty = useCallback(() => { editVersion.current += 1; setEdits(editVersion.current); dirtyRef.current = true; setDirty(true); setError('') }, [])
  const handleComposerDirty = useCallback(() => { if (readyRef.current) markDirty() }, [markDirty])
  function change<K extends keyof CampaignInput>(key: K, value: CampaignInput[K]) {
    updateForm({ ...formRef.current, [key]: value })
    markDirty()
  }
  function queueRemote(next: Campaign | null) { remoteRef.current = next; setRemote(next) }
  function applyRemote(next: Campaign) {
    // A manual reload and background poll can finish out of order. Never discard
    // a newer snapshot that arrived while the reload was in flight.
    if (remoteRef.current && olderCampaign(next, remoteRef.current)) next = remoteRef.current
    if (acceptedRef.current && olderCampaign(next, acceptedRef.current)) next = acceptedRef.current
    acceptedRef.current = next
    setAccepted(next)
    updateForm(campaignInput(next))
    setReplyToText(next.replyTo.join(', '))
    setAutosavePaused(false)
    creation.current = null
    dirtyRef.current = false
    setDirty(false)
    readyRef.current = false
    setComposerReady(readyRef.current)
    setGeneration(value => value + 1)
    setPreviewOpen(Boolean(next.previewText))
    queueRemote(null)
    setReviewUpdate(false)
    setTestOpen(false)
    setError('')
  }
  function receiveRemote(next: Campaign) {
    const baseline = acceptedRef.current
    if (!baseline || next.id !== baseline.id || campaignVersion(next) === campaignVersion(baseline)) return
    if (olderCampaign(next, baseline) || (remoteRef.current && olderCampaign(next, remoteRef.current))) return
    setTestOpen(false)
    if (dirtyRef.current || busyRef.current) queueRemote(next)
    else applyRemote(next)
  }
  const sync = useCampaignSync(accepted, receiveRemote)
  const current = remote ?? accepted
  const unavailable = Boolean(sync.error && 'status' in sync.error && [401, 403, 404].includes(Number(sync.error.status)))
  const readOnly = unavailable || Boolean(current && (current.archivedAt || !campaignEditable(current)))
  const controlsDisabled = preparing || attachmentsBusy || composerBusy || loadingLatest || readOnly
  const replyToValidation = replyToError(replyToText)
  const personalized = [...new Set([...placeholders(form.subject, form.previewText), ...bodyKeys])]
  const saveDisabled = options.isPending || options.isError || !composerReady || readOnly || Boolean(remote) || Boolean(replyToValidation)
  useEffect(() => {
    if (!dirty || pending || saveDisabled || autosavePaused || !form.name.trim()) return
    const timer = setTimeout(() => { void save('auto') }, 800)
    return () => clearTimeout(timer)
  }, [edits, dirty, pending, saveDisabled, autosavePaused, form.name])
  useEffect(() => { if (remote && !dirtyRef.current && !busyRef.current) applyRemote(remote) }, [remote, pending, dirty])
  async function loadLatest() {
    if (!acceptedRef.current || pending) return
    const controller = new AbortController()
    refreshController.current?.abort()
    refreshController.current = controller
    setLoadingLatest(true)
    busyRef.current = true
    try {
      const latest = await api.campaigns.get(acceptedRef.current.id, controller.signal)
      if (!controller.signal.aborted) applyRemote(latest)
    } catch (cause) { if (!controller.signal.aborted) toast(message(cause), 'error') }
    finally { if (!controller.signal.aborted) { setLoadingLatest(false); busyRef.current = false } }
  }
  const syncLabel = autosaving || preparing || saveMutation.isPending ? 'Saving…' : remote ? 'Update available' : autosavePaused ? 'Save failed' : error ? 'Check draft' : unavailable ? 'Unavailable' : readOnly ? 'Read only' : sync.connection === 'offline' ? 'Sync interrupted' : dirty ? form.name.trim() ? 'Unsaved changes' : 'Name required' : accepted ? 'Saved' : 'New draft'
  function reportError(value: string) { setError(value); toast(value, 'error') }
  async function save(next: 'auto' | 'edit' | 'review' | 'test') {
    if (guard.current || pending || !readyRef.current || readOnly) return
    const automatic = next === 'auto'
    if (remoteRef.current) { if (!automatic) setReviewUpdate(true); return }
    const continuing = next === 'review' || next === 'test'
    const input = creation.current?.input ?? formRef.current
    const version = creation.current?.version ?? editVersion.current
    const validation = !input.name.trim() ? 'Enter a campaign name.'
      : continuing && !input.subject.trim() ? 'Enter a subject before continuing.'
      : (continuing || input.fromEmail.trim()) && !emailIsValid(input.fromEmail.trim()) ? 'Enter a valid sender email address.'
      : !multiTenant && (!input.regionId.trim() || input.regionId.trim().length > 40) ? 'Enter a region identifier of 1–40 characters.'
      : continuing && !input.listId ? 'Choose a recipient list before continuing.' : ''
    if (validation) { if (!automatic) reportError(validation); return }
    // An unchanged saved draft needs no new revision: open the test or review straight away.
    if (continuing && acceptedRef.current && !dirtyRef.current && !creation.current) {
      if (next === 'test') setTestOpen(true)
      else navigate(campaignRoute(acceptedRef.current, 'review'))
      return
    }
    guard.current = true
    busyRef.current = true
    setError('')
    setAutosavePaused(false)
    if (automatic) setAutosaving(true)
    else setPreparing(true)
    try {
      let submitted = creation.current?.input
      if (!submitted) {
        const content = await composer.current?.prepare()
        if (!content) throw new Error('The composer is still loading. Try again in a moment.')
        if (continuing && !content.html.trim()) throw new Error('Add some email content before continuing.')
        submitted = { ...input, ...content, attachments: [...new Set([...(input.attachments ?? []), ...(content.inlineAttachmentIds ?? [])])], defaults: Object.fromEntries(Object.entries(input.defaults ?? {}).map(([key, value]) => [key, value.trim()]).filter(([, value]) => value)), name: input.name.trim(), subject: input.subject.trim(), fromName: input.fromName.trim(), fromEmail: input.fromEmail.trim(), regionId: input.regionId.trim() }
        if (!submitted.id) {
          submitted.idempotencyKey = crypto.randomUUID()
          creation.current = { input: structuredClone(submitted), version }
        }
      }
      const saved = await saveMutation.mutateAsync(submitted)
      cache.setQueryData(['bane', api.mode, 'campaign', saved.id], saved)
      void cache.invalidateQueries({queryKey: ['bane', api.mode, 'campaigns'], refetchType: 'none'})
      if (!mounted.current) return
      creation.current = null
      const changedWhileSaving = editVersion.current !== version
      acceptedRef.current = saved
      setAccepted(saved)
      dirtyRef.current = changedWhileSaving
      setDirty(changedWhileSaving)
      queueRemote(remoteRef.current && olderCampaign(saved, remoteRef.current) ? remoteRef.current : null)
      updateForm({...formRef.current, id: saved.id, revision: saved.revision, draft: saved.draft, attachments: changedWhileSaving ? formRef.current.attachments : saved.attachments})
      const reviewing = next === 'review' && !changedWhileSaving
      if (!submitted.id && !reviewing) {
        preserveEditor(saved)
        navigate(campaignRoute(saved, 'edit'), { replace: true })
      }
      if (next === 'test' && !changedWhileSaving) setTestOpen(true)
      else if (reviewing) navigate(campaignRoute(saved, 'review'))
      setBodyKeys(placeholders(submitted.html))
    } catch (cause) {
      if (!mounted.current) return
      const status = cause && typeof cause === 'object' && 'status' in cause ? Number(cause.status) : 0
      if (creation.current) {
        if (!creation.current.ambiguous && status >= 400 && status < 500 && status !== 408) creation.current = null
        else creation.current.ambiguous = true
      }
      setAutosavePaused(true)
      if (automatic) setError(message(cause))
      else reportError(message(cause))
      sync.checkNow()
    } finally {
      guard.current = false
      if (mounted.current) { setPreparing(false); setAutosaving(false) }
    }
  }
  return <div className="campaign-compose-page">
    <PageHeader title={accepted ? 'Edit campaign' : 'Create campaign'} backTo="/campaigns" actions={<>
      <div className="campaign-sync-status" role="status" data-state={error || autosavePaused || sync.connection === 'offline' ? 'offline' : remote || dirty || autosaving ? 'changed' : sync.connection} data-actionable={remote || error || autosavePaused || sync.connection === 'offline' || undefined} title={error || sync.error?.message || (remote ? 'A newer version is available. Your unsaved changes are safe.' : autosavePaused ? 'Autosave paused. Retry saving your changes.' : readOnly ? 'This campaign is no longer editable.' : 'Changes save automatically and sync with MCP and the API.')}>
        <span className="campaign-sync-dot" aria-hidden="true" />
        {remote || error || autosavePaused || sync.connection === 'offline' ? <Button variant="ghost" size="sm" disabled={pending} onClick={() => { if (remote) setReviewUpdate(true); else if (autosavePaused) void save('edit'); else if (error) toast(error, 'error'); else sync.checkNow() }}>{syncLabel}</Button> : <span>{syncLabel}</span>}
      </div>
      <div className="campaign-compose-actions">
        {!accepted && <Button variant="ghost" disabled={pending} onClick={() => setTemplatesOpen(true)}>Use a template</Button>}
        <Button variant="ghost" disabled={!accepted || saveDisabled || pending || autosavePaused} title={!accepted ? 'Name the campaign first; it saves automatically' : undefined} onClick={() => save('test')}>Send test</Button>
        <Button variant="primary" disabled={saveDisabled || pending || autosavePaused} loading={preparing} onClick={() => save('review')}>Continue to review</Button>
      </div>
    </>} />
    {options.isError && <ErrorState error={options.error} onRetry={() => options.refetch()} />}
    <section className="campaign-compose-workspace" aria-label="Campaign composer">
      <div className="campaign-compose-scroll">
        <div className="campaign-compose-sheet">
          <div className="campaign-compose-metadata">
            <div className="campaign-compose-row"><label htmlFor="campaign-name">Name</label><Input id="campaign-name" placeholder="Campaign name" value={form.name} onChange={event => change('name', event.target.value)} required disabled={controlsDisabled} /></div>
            <div className="campaign-compose-row"><label htmlFor="campaign-from-email">From</label><CampaignSenderInput key={generation} name={form.fromName} email={form.fromEmail} domains={choices.domains.map(domain => domain.name)} disabled={controlsDisabled || options.isPending} onChange={({name, email}) => {const domain = email.split('@')[1]?.toLowerCase(); const supports = (parent: string) => domain === parent || domain?.endsWith(`.${parent}`); const match = choices.domains.find(item => supports(item.name) && item.regionId === formRef.current.regionId) ?? choices.domains.find(item => supports(item.name)); if (name !== formRef.current.fromName || email !== formRef.current.fromEmail || (match && match.regionId !== formRef.current.regionId)) updateForm({...formRef.current, fromName: name, fromEmail: email, ...(match ? {regionId: match.regionId} : {})}); markDirty()}} /></div>
            <div className="campaign-compose-row"><label htmlFor="campaign-reply-to">Reply to</label><Input id="campaign-reply-to" type="text" inputMode="email" autoCapitalize="none" spellCheck={false} placeholder="Optional reply@example.com" value={replyToText} aria-invalid={Boolean(replyToValidation) || undefined} aria-describedby={replyToValidation ? 'campaign-reply-to-error' : undefined} onChange={event => { const value = event.target.value; setReplyToText(value); updateForm({...formRef.current, replyTo: replyToAddresses(value)}); markDirty() }} disabled={controlsDisabled} /></div>
            {replyToValidation && <div id="campaign-reply-to-error" className="campaign-compose-feedback ui-field__error" role="alert">{replyToValidation}</div>}
            {(optionCursors.domains || choices.next.domains) && <div className="campaign-compose-feedback cluster"><Button onClick={() => setOptionCursors({...optionCursors, domains: undefined})}>First domains</Button><Button disabled={!choices.next.domains} onClick={() => setOptionCursors({...optionCursors, domains: choices.next.domains ?? undefined})}>More domains</Button></div>}
            {!options.isPending && choices.domains.length === 0 && <Alert tone="warning">No verified domains on this page. <Link to="/domains">Add a domain</Link></Alert>}
            <div className="campaign-compose-row"><label htmlFor="campaign-list">To</label><Select id="campaign-list" aria-label="Recipient list" disabled={controlsDisabled || options.isPending} value={form.listId} onValueChange={value => change('listId', value)} options={options.isPending ? [{value: form.listId, label: 'Loading recipient lists…', disabled: true}] : choices.lists.length ? [{ value: '', label: 'Choose a list' }, ...(form.listId && !choices.lists.some(l => l.id === form.listId) ? [{value: form.listId, label: form.listId}] : []), ...choices.lists.map(list => ({ value: list.id, label: list.name }))] : [{value: '', label: 'No lists yet. Create one in Audience.', disabled: true}]} /></div>
            {(optionCursors.lists || choices.next.lists) && <div className="campaign-compose-feedback cluster"><Button onClick={() => setOptionCursors({...optionCursors, lists: undefined})}>First lists</Button><Button disabled={!choices.next.lists} onClick={() => setOptionCursors({...optionCursors, lists: choices.next.lists ?? undefined})}>More lists</Button></div>}
            <div className="campaign-compose-row"><label htmlFor="campaign-segment">Segment</label><Select id="campaign-segment" aria-label="Segment" disabled={controlsDisabled || options.isPending} value={form.segmentId ?? ''} onValueChange={value => change('segmentId', value || null)} options={[{ value: '', label: 'Everyone on the list' }, ...(form.segmentId && !choices.segments.some(segment => segment.id === form.segmentId) ? [{value: form.segmentId, label: form.segmentId}] : []), ...choices.segments.map(segment => ({ value: segment.id, label: `Only ${segment.name}` })), ...(!options.isPending && !choices.segments.length ? [{ value: '__none', label: 'No segments yet. A segment is a saved filter, made in Audience.', disabled: true }] : [])]} /></div>
            <DraftAudienceLine campaign={accepted} listId={form.listId} segmentId={form.segmentId} segmentName={choices.segments.find(segment => segment.id === form.segmentId)?.name} />
            <div className="campaign-compose-row campaign-compose-subject"><label htmlFor="campaign-subject">Subject</label><Input id="campaign-subject" placeholder="Add a subject" value={form.subject} onChange={event => change('subject', event.target.value)} disabled={controlsDisabled} /><Button className="campaign-preview-toggle" variant="ghost" size="sm" disabled={controlsDisabled} aria-expanded={previewOpen} aria-controls="campaign-preview-row" title="Text shown after the subject in the inbox" onClick={() => {setPreviewOpen(!previewOpen); if (!previewOpen) requestAnimationFrame(() => previewInput.current?.focus({preventScroll: true}))}}>Inbox preview</Button></div>
            <div id="campaign-preview-row" className="campaign-compose-preview" data-open={previewOpen || undefined} aria-hidden={!previewOpen} inert={!previewOpen}>
              <div><div className="campaign-compose-row"><label htmlFor="campaign-preview">Inbox preview</label><Input ref={previewInput} id="campaign-preview" maxLength={200} placeholder="Text shown after the subject in the inbox" value={form.previewText} onChange={event => change('previewText', event.target.value)} disabled={controlsDisabled} /></div></div>
            </div>
          </div>
          <ChunkFallback.Provider value={<ComposerSkeleton />}><EmailComposer key={generation} ref={composer} personalize attachmentIds={form.attachments ?? []} initialHtml={form.html} disabled={controlsDisabled} onReady={handleComposerReady} onDirty={handleComposerDirty} onBusy={value => {busyRef.current = value || attachmentsBusy || guard.current || loadingLatest; setComposerBusy(value); if (value) markDirty()}} onAttach={() => {markDirty(); attachments.current?.open()}} /></ChunkFallback.Provider>
          <CampaignAttachments key={`attachments:${generation}`} ref={attachments} ids={form.attachments ?? []} persisted={form.draft?.attachments ?? []} onChange={ids => change('attachments', ids)} onBusy={value => {busyRef.current = value || guard.current || loadingLatest; setAttachmentsBusy(value)}} disabled={preparing || autosaving || saveMutation.isPending || composerBusy || loadingLatest || readOnly} />
          {personalized.length > 0 && <section className="campaign-personalize" aria-labelledby="campaign-personalize-title">
            <p className="campaign-personalize__lead"><strong id="campaign-personalize-title">Personalization</strong> <span className="muted">A fallback fills in when a contact has no value. Without one, a contact missing a value stops the send.</span></p>
            {personalized.map(key => key === 'email' ? <div key={key} className="campaign-compose-row"><span>{'{{email}}'}</span><span className="muted">Always the contact’s email address</span></div>
              : <div key={key} className="campaign-compose-row"><label htmlFor={`campaign-fallback-${key}`}>{`{{${key}}}`}</label><Input id={`campaign-fallback-${key}`} placeholder={placeholderLabel[key] ? `Used when ${placeholderLabel[key]}, e.g. there` : `Used when a contact has no ${key}`} value={form.defaults?.[key] ?? ''} aria-invalid={!form.defaults?.[key]?.trim() || undefined} onChange={event => change('defaults', { ...formRef.current.defaults, [key]: event.target.value })} disabled={controlsDisabled} /></div>)}
          </section>}
        </div>
      </div>
    </section>
    <ConfirmDialog open={reviewUpdate} onOpenChange={value => {if (!loadingLatest) setReviewUpdate(value)}} title="Load the latest campaign?" description="This campaign changed outside this editor. Loading the latest version will discard your unsaved browser changes." confirmLabel="Load latest" onConfirm={loadLatest} pending={loadingLatest} />
    {accepted && testOpen && <TestEmailDialog campaign={accepted} open={testOpen} onOpenChange={setTestOpen} />}
    {templatesOpen && <TemplatePickerDialog onOpenChange={setTemplatesOpen} />}
  </div>
}

// One reserved line under To/Segment: who the saved draft reaches and, if some can't be emailed, why and where to fix it.
function DraftAudienceLine({ campaign, listId, segmentId, segmentName }: { campaign: Campaign | null; listId: string; segmentId: string | null; segmentName?: string }) {
  const saved = Boolean(campaign && listId && campaign.listId === listId && (campaign.segmentId ?? null) === (segmentId ?? null))
  const query = useApiQuery(['campaign-audience', campaign?.id ?? '', campaign?.revision ?? 0], (api, signal) => api.campaigns.audience({ id: campaign!.id, listId, segmentId }, signal), { enabled: saved, keepPrevious: true })
  const data = saved ? query.data : undefined
  const fix = data && data.unsubscribed > 0 ? <> · {number(data.unsubscribed)} not subscribed · <Link to={`/audience/lists/${encodeURIComponent(listId)}?status=unknown`}>Why?</Link></> : null
  const text = !listId ? <>Choose a list. Only contacts who agreed to marketing email receive campaigns.</>
    : !data ? <span role="status">{query.isError ? 'Couldn’t count recipients.' : 'Counting recipients…'}</span>
    : data.matched === 0 ? segmentId ? <>Nobody in this list matches {segmentName ?? 'this segment'}. <Link to={`/audience/segments/${encodeURIComponent(segmentId)}`}>Review the segment</Link></> : <>No contacts in this list yet. <Link to={`/audience/lists/${encodeURIComponent(listId)}`}>Add contacts</Link></>
    : <>{number(data.eligible)} of {number(data.matched)} {data.matched === 1 ? 'contact' : 'contacts'}{segmentName ? ` in ${segmentName}` : ''} can receive this campaign{fix}{data.suppressed > 0 ? ` · ${number(data.suppressed)} suppressed` : ''}</>
  return <div className="campaign-compose-row campaign-audience-line"><span aria-hidden="true" /><span className="campaign-audience-line__text">{text}</span></div>
}

function TestEmailDialog({ campaign, open, onOpenChange }: { campaign: Campaign; open: boolean; onOpenChange: (value: boolean) => void }) {
  const [to, setTo] = useState('')
  const [error, setError] = useState('')
  const guard = useRef(false)
  // Placeholders without a fallback need a sample value, or the test can't render.
  const fallbacks = campaign.draft?.defaults ?? {}
  const samples = placeholders(campaign.subject, campaign.previewText, campaign.html).filter(key => key !== 'email' && (fallbacks[key] === undefined || fallbacks[key] === ''))
  const [data, setData] = useState<Record<string, string>>(() => Object.fromEntries(samples.map(key => [key, key === 'name' ? 'Sam Example' : key === 'firstName' ? 'Sam' : ''])))
  const [sent, setSent] = useState<{ to: string; id?: string } | null>(null)
  const mutation = useApiMutation((api, input: { id: string; to: string; data: Record<string, string> }) => api.campaigns.test(input))
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (guard.current || mutation.isPending) return
    if (!emailIsValid(to.trim())) { setError('Recipient email: enter an address like you@example.com.'); return }
    const missing = samples.find(key => !data[key]?.trim())
    if (missing) { setError(`Sample {{${missing}}}: enter a value to show in the test, or add a fallback in the editor.`); return }
    setError('')
    guard.current = true
    try {
      const result = await mutation.mutateAsync({ id: campaign.id, to: to.trim(), data: Object.fromEntries(samples.map(key => [key, data[key]!.trim()])) })
      if (!result.accepted) { setError('The test email was not accepted. Please try again.'); return }
      setSent({ to: to.trim(), id: result.id })
    } catch (cause) { setError(message(cause)) }
    finally { guard.current = false }
  }
  return <Dialog open={open} onOpenChange={value => { if (!mutation.isPending) { setError(''); onOpenChange(value) } }} title="Send test email" description="Sends the saved draft to one address. Tests don’t count as a campaign send.">
    {sent ? <div className="stack">
      <Alert tone="success">Test sent to <PrivateAddress value={sent.to} />.{sent.id && <> <Link to={`/logs/${encodeURIComponent(sent.id)}`}>View in Logs</Link></>}</Alert>
      <div className="cluster campaign-dialog-actions"><Button variant="secondary" onClick={() => { setSent(null); mutation.reset() }}>Send another</Button><Button variant="primary" onClick={() => onOpenChange(false)}>Done</Button></div>
    </div> : <form className="stack" onSubmit={submit} noValidate>
      <Field label="Recipient email" htmlFor="campaign-test-recipient"><Input id="campaign-test-recipient" type="email" autoComplete="email" autoFocus value={to} onChange={event => { setTo(event.target.value); setError('') }} disabled={mutation.isPending} /></Field>
      {samples.map(key => <Field key={key} label={`Sample {{${key}}}`} htmlFor={`campaign-test-${key}`} hint="Only for this test. Add a fallback in the editor for contacts without a value."><Input id={`campaign-test-${key}`} value={data[key] ?? ''} onChange={event => { setData({ ...data, [key]: event.target.value }); setError('') }} disabled={mutation.isPending} /></Field>)}
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="cluster campaign-dialog-actions"><Button variant="secondary" type="button" disabled={mutation.isPending} onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" type="submit" loading={mutation.isPending}>Send test</Button></div>
    </form>}
  </Dialog>
}

export function CampaignReviewPage() {
  const { id = '' } = useParams()
  const query = useApiQuery(['campaign', id], (api, signal) => api.campaigns.get(id, signal), { interval: campaignPollInterval })
  // The polled review learns of a finished or paused send before the cached Campaigns list does.
  useRefreshListsOnChange('campaigns', query.data?.status)
  if (query.isPending) return <CampaignRouteSkeleton kind="review" />
  if (!query.data) return <ErrorState error={query.error} onRetry={() => query.refetch()} />
  return <CampaignReview key={id} campaign={query.data} stale={query.isError} refreshing={query.isFetching} refresh={() => void query.refetch()} />
}

// The server renders block HTML into the styled email; the review shows that rendering, not the blocks.
function CampaignRenderedPreview({ campaign, transform = html => html }: { campaign: Campaign; transform?: (html: string) => string }) {
  const preview = useApiQuery(['campaign-preview', campaign.id, campaign.revision], (api, signal) => api.campaigns.preview(campaign.id, signal))
  if (preview.isPending) return <div className="ui-email-preview campaign-preview-loading" role="status"><SkeletonText width="55%" lineHeight={28} /><SkeletonText /><SkeletonText width="80%" /></div>
  if (preview.isError) return <ErrorState error={preview.error} onRetry={() => void preview.refetch()} />
  return <EmailPreview html={transform(preview.data.html)} title="Campaign email preview" attachmentIds={campaign.attachments} respectStyles remoteImages />
}
// Schedules are entered and stored in UTC; every place that shows one also gives the viewer's local time.
const utcLabel = (value: string) => `${date(value, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}, ${date(value, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' })} UTC`
const localLabel = (value: string) => `${new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value))} your time`
const parseUtc = (value: string) => value ? new Date(`${value}:00Z`) : null
function scheduleError(value: string) {
  const parsed = parseUtc(value)
  if (!parsed || Number.isNaN(parsed.getTime())) return 'Date and time: choose when to send.'
  if (parsed.getTime() <= Date.now()) return `Date and time: that time has passed. It is now ${utcLabel(new Date().toISOString())}.`
  if (parsed.getTime() > Date.now() + 365 * 86_400_000) return 'Date and time: schedule within one year.'
  return ''
}
function ScheduleField({ value, onChange, error, disabled, id }: { value: string; onChange: (value: string) => void; error?: string; disabled?: boolean; id: string }) {
  const parsed = parseUtc(value)
  const hint = parsed && !Number.isNaN(parsed.getTime()) ? `${localLabel(parsed.toISOString())}.` : 'Enter the time in UTC; your local time appears here.'
  return <Field label="Date and time (UTC)" htmlFor={id} error={error} hint={error ? undefined : hint}><Input id={id} type="datetime-local" value={value} aria-invalid={Boolean(error) || undefined} onChange={event => onChange(event.target.value)} disabled={disabled} /></Field>
}
// A schedule that has released nobody yet can still move or go back to a draft.
const unreleasedSchedule = (campaign: Campaign) => Boolean(campaign.scheduledAt) && ['preparing', 'scheduled', 'paused'].includes(campaign.status) && (campaign.delivery?.expanded ?? 0) === 0
const sampleValue = (key: string) => key === 'email' ? 'sam@example.com' : key === 'name' ? 'Sam Example' : key === 'firstName' ? 'Sam' : `[${key}]`
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`)

function useCampaignCache() {
  const api = useApi()
  const cache = useQueryClient()
  return (next: Campaign) => { cache.setQueryData(['bane', api.mode, 'campaign', next.id], next); void cache.invalidateQueries({ queryKey: ['bane', api.mode, 'campaigns'], refetchType: 'none' }) }
}

function ScheduledBanner({ campaign }: { campaign: Campaign }) {
  const api = useApi()
  const navigate = useNavigate()
  const toast = useToast()
  const accept = useCampaignCache()
  const { canAdminister } = useWorkspaceAccess()
  const [dialog, setDialog] = useState<'reschedule' | 'edit' | 'unschedule' | null>(null)
  const at = campaign.scheduledAt!
  const total = campaign.delivery?.total ?? campaign.recipients
  async function unschedule(edit: boolean) {
    accept(await api.campaigns.unschedule(campaign.id))
    toast(edit ? 'Unscheduled. Schedule it again after editing.' : 'Unscheduled. The campaign is a draft again.', 'success')
    if (edit) navigate(campaignRoute(campaign, 'edit'))
  }
  const blocked = canAdminister ? undefined : 'Only owners and admins can change a schedule.'
  return <>
    <Alert tone="info" title={`Scheduled for ${utcLabel(at)}`}>
      <div className="campaign-pacing-banner">
        <span>{localLabel(at)} · {number(total)} {total === 1 ? 'recipient' : 'recipients'} · Nothing has been sent yet.</span>
        <div className="cluster"><Button size="sm" disabled={!canAdminister} title={blocked} onClick={() => setDialog('reschedule')}>Reschedule</Button><Button size="sm" disabled={!canAdminister} title={blocked ?? 'Unschedules it so you can edit; schedule it again afterwards'} onClick={() => setDialog('edit')}>Edit</Button><Button size="sm" variant="ghost" disabled={!canAdminister} title={blocked} onClick={() => setDialog('unschedule')}>Unschedule</Button></div>
      </div>
    </Alert>
    <ConfirmDialog open={dialog === 'edit'} onOpenChange={open => setDialog(open ? 'edit' : null)} title="Edit this campaign?" description="Editing unschedules it and makes it a draft again. Nobody has been emailed. Schedule it again when you’re done." confirmLabel="Unschedule and edit" onConfirm={() => unschedule(true)} />
    <ConfirmDialog open={dialog === 'unschedule'} onOpenChange={open => setDialog(open ? 'unschedule' : null)} title="Unschedule this campaign?" description="It becomes a draft again and won’t send. Nobody has been emailed." confirmLabel="Unschedule" onConfirm={() => unschedule(false)} />
    {dialog === 'reschedule' && <RescheduleDialog campaign={campaign} onClose={() => setDialog(null)} />}
  </>
}

function RescheduleDialog({ campaign, onClose }: { campaign: Campaign; onClose: () => void }) {
  const api = useApi()
  const toast = useToast()
  const accept = useCampaignCache()
  const [value, setValue] = useState(() => campaign.scheduledAt!.slice(0, 16))
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  // Single flight: a second Reschedule before the first answers would send the same change again.
  const reschedule = useSingleFlight(async (at: string) => {
    setPending(true)
    try { const next = await api.campaigns.reschedule(campaign.id, at); accept(next); toast(`Rescheduled for ${utcLabel(next.scheduledAt!)}`, 'success'); onClose() }
    catch (cause) { setError(message(cause)) }
    finally { setPending(false) }
  })
  function submit(event: FormEvent) {
    event.preventDefault()
    const problem = scheduleError(value)
    if (problem) { setError(problem); return }
    void reschedule(parseUtc(value)!.toISOString())
  }
  return <Dialog open onOpenChange={open => { if (!open && !pending) onClose() }} title="Reschedule campaign" description="The audience and message stay as they are. To change them, use Edit instead.">
    <form className="stack" onSubmit={submit} noValidate>
      <ScheduleField id="campaign-reschedule" value={value} onChange={next => { setValue(next); setError('') }} error={error} disabled={pending} />
      <div className="cluster campaign-dialog-actions"><Button type="button" disabled={pending} onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" loading={pending}>Reschedule</Button></div>
    </form>
  </Dialog>
}

// Stops a campaign that is sending, paused or failed after releasing some recipients; emails already sent stay sent.
function CancelCampaignButton({ campaign }: { campaign: Campaign }) {
  const api = useApi()
  const toast = useToast()
  const cache = useQueryClient()
  const { canAdminister } = useWorkspaceAccess()
  const [open, setOpen] = useState(false)
  return <>
    <Button variant="ghost" disabled={!canAdminister} title={canAdminister ? 'Stop releasing recipients and cancel queued emails' : 'Only owners and admins can cancel campaigns.'} onClick={() => setOpen(true)}>Cancel campaign</Button>
    <ConfirmDialog open={open} onOpenChange={setOpen} danger title="Cancel this campaign?" description="Recipients who haven’t been sent to yet won’t get it, and queued emails are canceled. Emails already sent stay sent. You can’t undo this." confirmLabel="Cancel campaign" onConfirm={async () => { const result = await api.campaigns.cancel(campaign.id); toast(`Campaign canceled · ${number(result.canceled)} not sent`, 'success'); await cache.invalidateQueries({ queryKey: ['bane', api.mode, 'campaign', campaign.id] }); void cache.invalidateQueries({ queryKey: ['bane', api.mode, 'campaigns'], refetchType: 'none' }) }} />
  </>
}

// Where the campaign goes: the list (and segment) by name, never by id.
function AudienceSource({ listId, segmentId }: { listId: string; segmentId: string | null }) {
  const list = useApiQuery(['lists', listId], (api, signal) => api.lists.get(listId, signal), { enabled: Boolean(listId) })
  const segment = useApiQuery(['segments', segmentId ?? ''], (api, signal) => api.segments.get(segmentId!, signal), { enabled: Boolean(segmentId) })
  if (!listId) return <p className="campaign-audience-source muted">No list chosen yet.</p>
  return <p className="campaign-audience-source" title={list.data?.name}>{list.data ? <Link to={`/audience/lists/${encodeURIComponent(listId)}`}>{list.data.name}</Link> : <SkeletonText width={120} />}{segmentId && <span className="muted"> · only {segment.data?.name ?? 'segment'}</span>}</p>
}

function CampaignResults({ campaign }: { campaign: Campaign }) {
  const byStatus = campaign.counts?.byStatus ?? {}
  const total = Math.max(campaign.counts?.total ?? 0, campaign.delivery?.total ?? 0)
  const canceled = (byStatus.canceled ?? 0) + (campaign.delivery?.canceled ?? 0)
  const rows: [string, number, string][] = [
    ['Delivered', (byStatus.delivered ?? 0) + (byStatus.simulated ?? 0), 'Accepted by the recipient’s mail server'],
    ['Bounced', byStatus.bounced ?? 0, 'Rejected by the recipient’s mail server; Bane stops emailing these addresses'],
    ['Complaints', byStatus.complained ?? 0, 'Marked as spam; Bane stops emailing these addresses'],
    ['Failed', (byStatus.rejected ?? 0) + (byStatus.rendering_failed ?? 0), 'Couldn’t be sent'],
    ['Suppressed', byStatus.suppressed ?? 0, 'Skipped because the address is suppressed'],
    ['Canceled', canceled, 'Never sent because the campaign was canceled'],
  ]
  return <div className="campaign-audience-summary">
    <div className="campaign-summary-line"><strong>Recipients</strong><span>{number(total)}</span></div>
    {rows.map(([label, count, hint]) => <div className="campaign-summary-line" key={label} title={hint}><span>{label}</span><span>{number(count)}</span></div>)}
    {(byStatus.simulated ?? 0) > 0 && <p className="muted">{number(byStatus.simulated)} delivered in simulation mode: no real email was sent.</p>}
  </div>
}

function CampaignReview({ campaign, stale, refreshing, refresh }: { campaign: Campaign; stale: boolean; refreshing: boolean; refresh: () => void }) {
  const navigate = useNavigate()
  const [mode, setMode] = useState<'now' | 'schedule'>('now')
  const [scheduled, setScheduled] = useState('')
  const [error, setError] = useState('')
  const [scheduleProblem, setScheduleProblem] = useState('')
  const [confirmation, setConfirmation] = useState<SendCampaignInput | null>(null)
  const [testOpen, setTestOpen] = useState(false)
  const [pace, setPace] = useState({ limit: false, perDay: '50000', autoPause: true, share: '50' })
  const guard = useRef(false)
  const { canAdminister, multiTenant } = useWorkspaceAccess()
  const origin = multiTenant ? '' : ` from ${campaign.regionId}`

  const draft = !campaign.archivedAt && campaignEditable(campaign)
  const readinessError = campaignReadinessError(campaign)
  const fallbacks = campaign.draft?.defaults ?? {}
  const keys = placeholders(campaign.subject, campaign.previewText, campaign.html)
  const missingFallbacks = keys.filter(key => key !== 'email' && (fallbacks[key] === undefined || fallbacks[key] === ''))
  // A live count of the saved audience, read as the page opens; the send freezes its own snapshot.
  const audience = useApiQuery(['campaign-audience', campaign.id, campaign.revision ?? 0], (api, signal) => api.campaigns.audience({ id: campaign.id, listId: campaign.listId, segmentId: campaign.segmentId }, signal), { enabled: draft && Boolean(campaign.listId) })
  const listName = useApiQuery(['lists', campaign.listId], (api, signal) => api.lists.get(campaign.listId, signal), { enabled: Boolean(campaign.listId) }).data?.name
  const perDay = Number(pace.perDay.trim().replaceAll(',', ''))
  const paceError = pace.limit ? perDayError(perDay) : ''
  const paceDays = pace.limit && !paceError && audience.data?.eligible ? Math.ceil(audience.data.eligible / perDay) : null
  const sharePercent = Number(pace.share.trim())
  const shareError = ratePercentError(sharePercent)
  const paceSummary = (input: SendCampaignInput | null) => !input?.pacing ? '' : `${input.pacing.perDay ? ` Sends to up to ${number(input.pacing.perDay)} recipients per day${paceDays ? ` (about ${paceDays} ${paceDays === 1 ? 'day' : 'days'})` : ''}.` : ''}${input.pacing.rateShare != null && input.pacing.rateShare < 1 ? ` Uses at most ${Math.round(input.pacing.rateShare * 100)}% of your sending speed.` : ''}${input.pacing.autoPause === false ? ' Auto-pause on high bounces or complaints is off.' : ''}`
  const [receipt, setReceipt] = useState('')
  const sendMutation = useApiMutation((api, input: SendCampaignInput) => api.campaigns.send(input))
  const recipients = audience.data ? `${number(audience.data.eligible)} eligible ${audience.data.eligible === 1 ? 'recipient' : 'recipients'}` : 'the eligible recipients'
  const audienceName = `${listName ? ` in ${listName}` : ''}`
  function requestConfirmation() {
    if (!draft || sendMutation.isPending) return
    if (readinessError) { setError(readinessError); return }
    setError('')
    if (audience.data && audience.data.eligible < 1) { setError('Nobody on this list can receive campaigns yet. Mark contacts as subscribed or choose another list.'); return }
    if (paceError) { setError(`Recipients per day: ${paceError}`); return }
    if (shareError) { setError(`Sending speed limit: ${shareError}`); return }
    const input: SendCampaignInput = { id: campaign.id, mode, timezone: 'UTC', revision: campaign.revision }
    // Defaults (no daily limit, auto-pause on, full send rate) need no pacing object.
    if (pace.limit || !pace.autoPause || sharePercent < 100) input.pacing = { perDay: pace.limit ? perDay : null, autoPause: pace.autoPause, rateShare: sharePercent / 100 }
    if (mode === 'schedule') {
      // datetime-local has no offset: this field is explicitly UTC, never the browser's local zone.
      const problem = scheduleError(scheduled)
      if (problem) { setScheduleProblem(problem); return }
      input.scheduledAt = parseUtc(scheduled)!.toISOString()
    }
    setConfirmation(input)
  }
  async function confirmSend() {
    if (!confirmation || !draft || guard.current || sendMutation.isPending) return
    if (readinessError) { setError(readinessError); setConfirmation(null); return }
    guard.current = true
    setError('')
    try { const result = await sendMutation.mutateAsync(confirmation); setReceipt('queued' in result && !result.scheduledAt ? `Sending started · ${number(result.queued)} ${result.queued === 1 ? 'recipient' : 'recipients'}${result.simulated ? ' · simulation mode, no real email is sent' : ''}` : ''); setConfirmation(null) }
    catch (cause) { setError(message(cause)); setConfirmation(null) }
    finally { guard.current = false }
  }
  const scheduledView = !draft && !campaign.archivedAt && unreleasedSchedule(campaign)
  const sentSomething = (campaign.counts?.total ?? 0) > 0
  const finished = ['done', 'canceled'].includes(campaign.status) || (campaign.status === 'failed' && !campaignResumable(campaign))
  const cancellable = !draft && !campaign.archivedAt && !scheduledView && (['preparing', 'sending', 'paused'].includes(campaign.status) || campaignResumable(campaign))
  const previewHtml = (html: string) => keys.length ? html.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_, key: string) => escapeHtml(fallbacks[key] ? String(fallbacks[key]) : sampleValue(key))) : html
  return <div className="stack campaign-review">
    <PageHeader title={campaign.name} backTo={campaign.archivedAt ? '/campaigns?archived=true' : '/campaigns'} actions={<div className="cluster">{!campaignEditable(campaign) && (sentSomething ? <Link className="ui-button ui-button--secondary ui-button--md" to={`/logs?campaign=${encodeURIComponent(campaign.id)}`}>View logs</Link> : <Button disabled title="Each email appears in Logs once sending starts">View logs</Button>)}<StatusBadge status={campaignDisplayStatus(campaign)} />{campaign.archivedAt && <CampaignArchiveButton campaign={campaign} />}</div>} />
    {stale && <Alert tone="warning">Couldn’t refresh this campaign. Showing the last available counts.</Alert>}
    {draft && readinessError && <Alert tone="warning">{readinessError} <Link to={campaignRoute(campaign, 'edit')}>Edit draft</Link></Alert>}
    {draft && missingFallbacks.length > 0 && <Alert tone="warning">{missingFallbacks.map(key => `{{${key}}}`).join(', ')} {missingFallbacks.length === 1 ? 'has' : 'have'} no fallback. A contact without a value stops the send. <Link to={campaignRoute(campaign, 'edit')}>Add a fallback</Link></Alert>}
    {receipt && <Alert tone="success">{receipt}</Alert>}{campaign.delivery?.error && <Alert tone="danger">{campaign.delivery.error.message}</Alert>}
    {scheduledView && <ScheduledBanner campaign={campaign} />}
    <div className="campaign-review-layout">
      <section className="campaign-fields">
        <SectionHeader title={campaignEditable(campaign) || scheduledView ? 'Recipients' : 'Delivery'} actions={draft ? <Button variant="ghost" onClick={() => navigate(campaignRoute(campaign, 'edit'))}>Edit audience</Button> : <div className="cluster">{cancellable && <CancelCampaignButton campaign={campaign} />}<Button variant="secondary" size="sm" onClick={refresh} disabled={refreshing} title="This page also updates by itself">Refresh</Button></div>} />
        {draft ? !campaign.listId ? <p className="muted">Choose a list in the editor to see who receives this campaign.</p> : audience.isPending ? <CampaignAudienceSkeleton /> : audience.isError ? <ErrorState error={audience.error} onRetry={() => void audience.refetch()} /> : <>
          <div><strong className="campaign-recipient-count">{number(audience.data.eligible)}</strong><p className="muted">eligible recipients</p></div>
          <AudienceSource listId={campaign.listId} segmentId={campaign.segmentId} />
          <div className="campaign-audience-summary">
            <div className="campaign-summary-line"><span>Matched contacts</span><span>{number(audience.data.matched)}</span></div>
            <div className="campaign-summary-line muted" title="Bounced, complained or blocked addresses are never emailed"><span>Suppressed</span><span>{audience.data.suppressed ? `−${number(audience.data.suppressed)}` : '0'}</span></div>
            <div className="campaign-summary-line muted"><span>Not subscribed{audience.data.unsubscribed > 0 && <> · <Link to={`/audience/lists/${encodeURIComponent(campaign.listId)}?status=unknown`}>Fix</Link></>}</span><span>{audience.data.unsubscribed ? `−${number(audience.data.unsubscribed)}` : '0'}</span></div>
          </div>
          <p className="muted campaign-audience-note">Eligible means subscribed and not suppressed. Consent is checked again as each email sends.</p>
          <Button disabled={sendMutation.isPending || audience.isFetching} onClick={() => void audience.refetch()}>Refresh count</Button>
        </> : <>
          {scheduledView ? <div className="campaign-audience-summary">
            <div className="campaign-summary-line"><span>Recipients, frozen when scheduled</span><span>{number(campaign.delivery?.total ?? campaign.recipients)}</span></div>
            <AudienceSource listId={campaign.listId} segmentId={campaign.segmentId} />
          </div> : <>
            <AudienceSource listId={campaign.listId} segmentId={campaign.segmentId} />
            <CampaignPacing key={`${campaign.id}:${campaign.delivery?.pacing?.perDay ?? ''}:${campaign.delivery?.pacing?.autoPause ?? ''}:${campaign.delivery?.pacing?.rateShare ?? ''}`} campaign={campaign} />
            {finished ? <CampaignResults campaign={campaign} /> : campaign.counts ? <CampaignProgress campaign={campaign} /> : <div className="campaign-audience-summary"><div className="campaign-summary-line"><span>Recipients</span><span>{number(campaign.recipients)}</span></div></div>}
          </>}
          {scheduledView && <CampaignPacing key={`${campaign.id}:paused`} campaign={campaign} />}
        </>}
      </section>
      <section className="campaign-fields">
        <SectionHeader title="Message" actions={draft ? <><Button variant="ghost" onClick={() => navigate(campaignRoute(campaign, 'edit'))}>Edit message</Button><Button variant="secondary" disabled={Boolean(readinessError)} onClick={() => setTestOpen(true)}>Send test</Button></> : undefined} />
        <dl className="campaign-message-details"><dt>From</dt><dd><NamedAddress name={campaign.fromName} address={campaign.fromEmail} /></dd>{campaign.replyTo.length > 0 && <><dt>Reply to</dt><dd><AddressList values={campaign.replyTo} /></dd></>}<dt>Subject</dt><dd>{campaign.subject}</dd>{campaign.previewText && <><dt>Inbox preview</dt><dd>{campaign.previewText}</dd></>}</dl>
        <CampaignRenderedPreview campaign={campaign} transform={previewHtml} />
        {keys.length > 0 && <p className="muted campaign-audience-note">Shown with fallback or sample values; each contact sees their own.</p>}
      </section>
    </div>
    {draft && <section className="campaign-delivery">
      <SectionHeader title="Delivery" />
      <p className="muted campaign-delivery-lead">Review the message and audience, then send now or pick a time.</p>
      <Tabs value={mode} onValueChange={value => { if (!sendMutation.isPending) { setMode(value as 'now' | 'schedule'); setError(''); setScheduleProblem('') } }} items={[{ value: 'now', label: 'Send now' }, { value: 'schedule', label: 'Schedule' }]} />
      {mode === 'schedule' && <ScheduleField id="campaign-schedule" value={scheduled} onChange={value => { setScheduled(value); setScheduleProblem(''); setError('') }} error={scheduleProblem} disabled={sendMutation.isPending} />}
      <div className="campaign-pacing-options" role="group" aria-labelledby="campaign-pacing-label">
        <div id="campaign-pacing-label" className="ui-field__label">Pace sending</div>
        <Checkbox label="Limit recipients per day" checked={pace.limit} disabled={sendMutation.isPending} onCheckedChange={limit => { setPace({ ...pace, limit }); setError('') }} />
        {pace.limit && <Field label="Recipients per day" htmlFor="campaign-per-day" error={paceError} hint={paceDays ? `About ${paceDays} ${paceDays === 1 ? 'day' : 'days'} for ${number(audience.data!.eligible)} eligible recipients.` : undefined}><Input id="campaign-per-day" type="number" inputMode="numeric" min={minPerDay} max={maxPerDay} step={1} value={pace.perDay} onChange={event => { setPace({ ...pace, perDay: event.target.value }); setError('') }} disabled={sendMutation.isPending} /></Field>}
        <Field label="Sending speed limit (%)" htmlFor="campaign-rate-share" error={shareError} hint="The share of your sending speed this campaign may use. The rest stays free for transactional email and other campaigns."><Input id="campaign-rate-share" type="number" inputMode="numeric" min={minRatePercent} max={maxRatePercent} step={1} value={pace.share} onChange={event => { setPace({ ...pace, share: event.target.value }); setError('') }} disabled={sendMutation.isPending} /></Field>
        <Checkbox label="Pause automatically on high bounces or complaints" checked={pace.autoPause} disabled={sendMutation.isPending} onCheckedChange={autoPause => setPace({ ...pace, autoPause })} />
        <p className="muted">Sending also stays within your daily sending limit.</p>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {!canAdminister && <Alert tone="info">Only owners and admins can send or schedule campaigns.</Alert>}
      <div className="campaign-delivery-actions"><Button variant="secondary" disabled={sendMutation.isPending} onClick={() => navigate(campaignRoute(campaign, 'edit'))}>Back to draft</Button><Button variant="primary" loading={sendMutation.isPending} disabled={!canAdminister || Boolean(readinessError) || Boolean(audience.data && !audience.data.eligible)} onClick={requestConfirmation}>{mode === 'schedule' ? 'Schedule campaign' : 'Send campaign now'}</Button></div>
    </section>}
    <ConfirmDialog open={confirmation !== null} onOpenChange={open => { if (!open && !sendMutation.isPending) setConfirmation(null) }} title={confirmation?.mode === 'schedule' ? 'Schedule this campaign?' : 'Send this campaign now?'} description={confirmation?.mode === 'schedule' ? `Send “${campaign.name}”${origin} to ${recipients}${audienceName} on ${utcLabel(confirmation.scheduledAt!)} (${localLabel(confirmation.scheduledAt!)}).${paceSummary(confirmation)} You can reschedule or unschedule it until it starts sending.` : `Send “${campaign.name}”${origin} to ${recipients}${audienceName} now.${paceSummary(confirmation)} Consent is checked again as each email sends. You can’t undo this.`} confirmLabel={confirmation?.mode === 'schedule' ? 'Schedule' : 'Send now'} onConfirm={confirmSend} pending={sendMutation.isPending} />
    {draft && testOpen && <TestEmailDialog campaign={campaign} open={testOpen} onOpenChange={setTestOpen} />}
  </div>
}
