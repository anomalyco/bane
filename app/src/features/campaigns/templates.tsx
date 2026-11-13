import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { useApi, useApiDef, useApiMutation, useApiQuery, useRegion, useWorkspaceAccess } from '../../data/context'
import { ApiError, type CampaignTemplate, type CampaignTemplateDraft, type CampaignTemplateSummary } from '../../data/types'
import { SearchField, Button, ConfirmDialog, DataTable, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, Pagination, PaginationSkeleton, Select, SkeletonText, StatusBadge, useToast } from '../../components/ui'
import { EmailPreview } from '../../components/EmailPreview'
import { date, shortDateTime, time } from '../../lib/format'
import { CampaignAttachments, type CampaignAttachmentsRef } from './CampaignAttachments'
import type { EmailComposerRef } from './EmailComposer'
import { composer as composerChunk, EmailComposer } from './composer-chunk'
import { queries } from '../../data/queries'
import { usePrefetchQueries } from '../../data/prefetch'
import { ChunkFallback } from '../../lib/preloadable'
import { CampaignRouteSkeleton, ComposerSkeleton, templateColumns } from './skeletons'
import { CampaignsHeader } from './header'
import './campaigns.css'
import { useSingleFlight } from '../../lib/single-flight'

const errorMessage = (error: unknown) => error instanceof ApiError ? error.text : error instanceof Error ? error.message : 'Something went wrong. Please try again.'
// Templates hold concrete example content; personalization belongs to the campaign made from them.
const placeholder = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/
const placeholderHint = (value: string | undefined) => { const match = value ? placeholder.exec(value) : null; return match ? `Templates use example text, not {{${match[1]}}}. Write an example here; add personalization in the campaign.` : '' }
// Only the draft schema's fields: the composer also returns inline attachment ids, which the API rejects as unknown keys.
const templateDraft = (draft: CampaignTemplateDraft): CampaignTemplateDraft => ({ name: draft.name.trim(), description: draft.description ?? '', subject: draft.subject.trim(), previewText: draft.previewText ?? '', fromName: draft.fromName ?? '', replyTo: draft.replyTo ?? [], html: draft.html ?? '', attachments: draft.attachments ?? [] })

/** Creates a campaign draft from a published template and opens it in the editor. */
export function useStartFromTemplate() {
  const navigate = useNavigate()
  const toast = useToast()
  const { regionId } = useRegion()
  // Hosted campaigns follow their From domain's region, so they need no selected region.
  const { multiTenant } = useWorkspaceAccess()
  const mutation = useApiMutation((client, template: {id: string; name: string}) => client.campaigns.save({ templateId: template.id, idempotencyKey: crypto.randomUUID(), regionId, name: template.name, subject: '', previewText: '', fromName: '', fromEmail: '', listId: '', segmentId: null, html: '' }), undefined, false, true, regionId)
  async function start(template: {id: string; name: string}) {
    try { const campaign = await mutation.mutateAsync(template); navigate(`/campaigns/${encodeURIComponent(campaign.id)}/edit`) }
    catch (error) { toast(errorMessage(error), 'error') }
  }
  return { start, pending: mutation.isPending ? mutation.variables?.id ?? '' : null, unavailable: !regionId && !multiTenant }
}

/** Published templates to start a campaign from; the empty state explains how to get one. */
export function TemplatePickerDialog({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const query = useApiQuery(['templates', { publishedOnly: true, page: 1 }], (client, signal) => client.templates.list({ publishedOnly: true, page: 1, pageSize: 50 }, signal))
  const { start, pending, unavailable } = useStartFromTemplate()
  const rows: CampaignTemplateSummary[] = query.data?.items ?? []
  return <Dialog open onOpenChange={value => { if (pending === null) onOpenChange(value) }} title="Start from a template" description="Copies a published template into a new draft; editing the draft doesn’t change the template." className="template-picker-dialog">
    {query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <div className="template-picker" aria-busy={query.isPending || undefined}>
      {query.isPending ? [0, 1, 2].map(index => <div key={index} className="template-picker__row" aria-hidden="true"><SkeletonText width="45%" lineHeight={18} /><SkeletonText width="70%" lineHeight={18} /></div>)
        : rows.length ? rows.map(row => <button key={row.id} type="button" className="template-picker__row" disabled={pending !== null || unavailable} onClick={() => void start(row)}><span className="template-picker__name">{row.name}</span><span className="muted">{row.description || row.subject || 'No subject yet'}</span>{pending === row.id && <span className="muted template-picker__status" role="status">Creating draft…</span>}</button>)
        : <EmptyState title="No published templates" description="A template is a reusable email design. Publish one under Templates to start campaigns from it here." action={<Link className="ui-button ui-button--secondary ui-button--md" to="/campaigns/templates">Go to templates</Link>} />}
    </div>}
  </Dialog>
}

export function TemplatesPage() {
  const navigate = useNavigate()
  const warm = usePrefetchQueries()
  const toast = useToast()
  const { start, pending, unavailable } = useStartFromTemplate()
  const [params, setParams] = useSearchParams()
  const archived = params.get('archived') === 'true'
  const search = params.get('search') ?? ''
  const requestedPage = Number(params.get('page'))
  const currentPage = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1
  const query = useApiQuery(['templates', { search, archived, page: currentPage }], (client, signal) => client.templates.list({ search: search || undefined, archived, page: currentPage, pageSize: 10 }, signal))
  const create = useApiMutation((client, name: string) => client.templates.create({ name }))
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  async function createTemplate() {
    if (!name.trim()) return
    try { const result = await create.mutateAsync(name.trim()); navigate(`/campaigns/templates/${encodeURIComponent(result.id)}`) }
    catch (error) { toast(errorMessage(error), 'error') }
  }
  return <>
    <CampaignsHeader actions={<Button variant="primary" onClick={() => setCreateOpen(true)}>Create template</Button>} />
    <div className="data-toolbar"><div className="cluster"><SearchField className="search-box--list" aria-label="Search templates" placeholder="Search templates" value={search} onChange={event => setParams(previous => { const next = new URLSearchParams(previous); event.target.value ? next.set('search', event.target.value) : next.delete('search'); next.delete('page'); return next })} /><Select aria-label="Filter templates" value={archived ? 'archived' : 'active'} onValueChange={value => setParams(previous => { const next = new URLSearchParams(previous); value === 'archived' ? next.set('archived', 'true') : next.delete('archived'); next.delete('page'); return next })} options={[{value: 'active', label: 'Active'}, {value: 'archived', label: 'Archived'}]} /></div></div>
    {query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <>
      <DataTable loading={query.isPending} skeletonRows={4} minRows={4} rows={query.data?.items ?? []} rowKey={row => row.id} rowHref={row => `/campaigns/templates/${encodeURIComponent(row.id)}`} onRowIntent={row => { void warm([queries.template(row.id)]); void composerChunk.preload().catch(() => {}) }} empty={<EmptyState title={search ? 'No matching templates' : archived ? 'No archived templates' : 'No templates yet'} description={search || archived ? undefined : 'A template is a reusable email design. Publish one, then start campaigns from it with Use template.'} action={!search && !archived ? <Button variant="primary" onClick={() => setCreateOpen(true)}>Create template</Button> : undefined} />} columns={[
        {...templateColumns[0], render: row => <div className="campaign-row-name"><span className="campaign-row-title">{row.name}</span><span className="muted">{row.subject || row.description || 'No subject yet'}</span></div>, cardRender: row => row.name},
        {...templateColumns[1], render: row => <StatusBadge status={row.published ? 'Published' : 'Draft'} />},
        {...templateColumns[2], render: row => row.description || row.subject || 'No subject yet'},
        {...templateColumns[3], render: row => <span className="muted campaign-activity" title={`${date(row.updatedAt)} · ${time(row.updatedAt)} UTC`}>{shortDateTime(row.updatedAt)}</span>, cardRender: row => `Updated ${date(row.updatedAt, { month: 'short', day: 'numeric', timeZone: 'UTC' })}`},
        {...templateColumns[4], render: row => archived ? null : <Button size="sm" variant="secondary" title={row.published ? 'Start a new campaign draft from this template' : 'Publish this template to start campaigns from it'} disabled={!row.published || pending !== null || unavailable} loading={pending === row.id} onClick={event => { event.stopPropagation(); void start(row) }}>Use template</Button>},
      ]} />
      {query.isPending ? <PaginationSkeleton /> : <Pagination page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} nextCursor={query.data.nextCursor} onPageChange={page => setParams(previous => { const next = new URLSearchParams(previous); next.set('page', String(page)); return next })} />}
    </>}
    <Dialog open={createOpen} onOpenChange={setCreateOpen} title="Create template" description="A reusable starting point for campaigns. You can change everything later." footer={<><Button onClick={() => setCreateOpen(false)}>Cancel</Button><Button variant="primary" loading={create.isPending} disabled={!name.trim()} onClick={() => void createTemplate()}>Create</Button></>}><Field label="Name"><Input autoFocus placeholder="Monthly newsletter" value={name} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void createTemplate() }} /></Field></Dialog>
  </>
}

export function TemplateEditorPage() {
  const { id = '' } = useParams()
  const query = useApiDef(queries.template(id))
  if (query.isPending) return <CampaignRouteSkeleton kind="template" />
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />
  return <TemplateEditor key={query.data.id} initial={query.data} />
}

function TemplateEditor({ initial }: {initial: CampaignTemplate}) {
  const api = useApi()
  const cache = useQueryClient()
  const navigate = useNavigate()
  const toast = useToast()
  const composer = useRef<EmailComposerRef>(null)
  const attachments = useRef<CampaignAttachmentsRef>(null)
  const [template, setTemplate] = useState(initial)
  const [draft, setDraft] = useState(initial.draft)
  const draftRef = useRef(draft)
  const [ready, setReady] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [assetBusy, setAssetBusy] = useState(false)
  const [composerBusy, setComposerBusy] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  // A failed save waits for the next edit (or a click on the status) instead of retrying the same request forever.
  const [error, setError] = useState('')
  const version = useRef(0)
  const savingRef = useRef(false)
  const { start, pending: starting, unavailable } = useStartFromTemplate()
  const archived = Boolean(template.archivedAt)
  const subjectHint = placeholderHint(draft.subject), previewHint = placeholderHint(draft.previewText)
  const refreshLists = () => cache.invalidateQueries({queryKey: ['bane', api.mode, 'templates'], refetchType: 'none'})
  const remember = (value: CampaignTemplate) => cache.setQueryData(['bane', api.mode, 'template', value.id], value)
  const changed = useCallback(() => { version.current++; setDirty(true); setError('') }, [])
  function change<K extends keyof CampaignTemplateDraft>(key: K, value: CampaignTemplateDraft[K]) { const next = {...draftRef.current, [key]: value}; draftRef.current = next; setDraft(next); changed() }
  useEffect(() => {
    if (!dirty || error || saving || savingRef.current || !ready || assetBusy || composerBusy || archived || !draft.name.trim() || subjectHint || previewHint) return
    const timer = window.setTimeout(() => void save(), 800)
    return () => window.clearTimeout(timer)
  }, [dirty, error, saving, ready, assetBusy, composerBusy, archived, draft.name, subjectHint, previewHint])
  useEffect(() => { const warn = (event: BeforeUnloadEvent) => { if (dirty || savingRef.current) { event.preventDefault(); event.returnValue = '' } }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn) }, [dirty])
  function fail(message: string) { setError(message); toast(message, 'error') }
  async function save(): Promise<CampaignTemplate | null> {
    if (savingRef.current || !ready || archived) return null
    const blocked = !draftRef.current.name.trim() ? 'Name: enter a template name.' : placeholderHint(draftRef.current.subject) ? `Subject: ${placeholderHint(draftRef.current.subject)}` : placeholderHint(draftRef.current.previewText) ? `Inbox preview: ${placeholderHint(draftRef.current.previewText)}` : ''
    if (blocked) { fail(blocked); return null }
    savingRef.current = true; setSaving(true); setError('')
    const submittedVersion = version.current
    try {
      const content = await composer.current?.prepare()
      if (!content) throw new Error('The editor is still loading. Try again in a moment.')
      const bodyHint = placeholderHint(content.html)
      if (bodyHint) throw new Error(`Body: ${bodyHint}`)
      const submitted = templateDraft({...draftRef.current, html: content.html, attachments: [...new Set([...(draftRef.current.attachments ?? []), ...(content.inlineAttachmentIds ?? [])])]})
      const updated = await api.templates.update(template.id, template.revision, submitted)
      remember(updated)
      await refreshLists()
      setTemplate(updated); draftRef.current = version.current === submittedVersion ? updated.draft : draftRef.current; if (version.current === submittedVersion) { setDraft(updated.draft); setDirty(false) }
      return updated
    } catch (cause) { fail(errorMessage(cause)); return null }
    finally { savingRef.current = false; setSaving(false) }
  }
  // Publish and Archive run one at a time per action: a second press before the first answers would send the same revision again.
  const publish = useSingleFlight('templates.publish', async () => {
    const current = dirty || error ? await save() : template
    if (!current) return
    try { const updated = await api.templates.publish(current.id, current.revision); setTemplate(updated); remember(updated); await refreshLists(); toast('Template published. Use it to start a campaign.', 'success') }
    catch (cause) { toast(errorMessage(cause), 'error') }
  }, template.id)
  const archive = useSingleFlight('templates.archive', async () => {
    try { const updated = await api.templates.archive(template.id, !archived); setTemplate(updated); remember(updated); await refreshLists(); toast(archived ? 'Template restored' : 'Template archived', 'success') }
    catch (cause) { toast(errorMessage(cause), 'error') }
  }, template.id)
  const published = template.publishedRevision !== null && !archived
  const upToDate = template.publishedRevision === template.revision && !dirty
  return <div className="campaign-compose-page template-compose-page">
    <PageHeader title="Edit template" backTo="/campaigns/templates" actions={<>
      <div className="campaign-sync-status" data-state={error ? 'offline' : dirty || saving ? 'changed' : 'live'} data-actionable={error ? true : undefined} role="status" title={error || 'Changes save automatically. Publish to use them in new campaigns.'}><span className="campaign-sync-dot" aria-hidden="true" />{error ? <Button variant="ghost" size="sm" disabled={saving} onClick={() => void save()}>Save failed · Retry</Button> : <span>{saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved'}</span>}</div>
      <Button variant="ghost" disabled={saving || dirty || !draft.html} onClick={() => setPreviewOpen(true)}>Preview</Button>
      {archived && <Button variant="danger" onClick={() => setDeleteOpen(true)}>Delete</Button>}
      <Button variant="ghost" disabled={saving} onClick={() => void archive()}>{archived ? 'Restore' : 'Archive'}</Button>
      <Button variant="secondary" title={published ? 'Start a new campaign draft from the published version' : 'Publish this template to start campaigns from it'} disabled={!published || starting !== null || unavailable} loading={starting !== null} onClick={() => void start({ id: template.id, name: template.published?.name ?? template.draft.name })}>Use template</Button>
      <Button variant="primary" title={upToDate ? 'New campaigns use this version' : 'New campaigns use the published version; campaigns already made from it never change'} disabled={archived || saving || !ready || upToDate} onClick={() => void publish()}>{upToDate ? 'Published' : 'Publish'}</Button>
    </>} />
    <section className="campaign-compose-workspace" aria-label="Template composer"><div className="campaign-compose-scroll"><div className="campaign-compose-sheet">
      <p className="template-compose-intro">A reusable starting point for campaigns. Write example content here; add personalization such as {'{{name}}'} in each campaign.</p>
      <div className="campaign-compose-metadata">
        <div className="campaign-compose-row"><label htmlFor="template-name">Name</label><Input id="template-name" placeholder="Template name" value={draft.name} disabled={archived} aria-invalid={!draft.name.trim() || undefined} onChange={event => change('name', event.target.value)} /></div>
        <div className="campaign-compose-row"><label htmlFor="template-description">Purpose</label><Input id="template-description" placeholder="When to use it, shown when picking a template" value={draft.description} disabled={archived} onChange={event => change('description', event.target.value)} /></div>
        <div className="campaign-compose-row campaign-compose-subject"><label htmlFor="template-subject">Subject</label><Input id="template-subject" placeholder="Example subject" value={draft.subject} disabled={archived} aria-invalid={Boolean(subjectHint) || undefined} aria-describedby={subjectHint ? 'template-subject-hint' : undefined} onChange={event => change('subject', event.target.value)} /></div>
        {subjectHint && <p id="template-subject-hint" className="campaign-compose-feedback ui-field__error" role="alert">{subjectHint}</p>}
        <div className="campaign-compose-row"><label htmlFor="template-preview">Inbox preview</label><Input id="template-preview" placeholder="Text shown after the subject in the inbox" value={draft.previewText ?? ''} disabled={archived} aria-invalid={Boolean(previewHint) || undefined} aria-describedby={previewHint ? 'template-preview-hint' : undefined} onChange={event => change('previewText', event.target.value)} /></div>
        {previewHint && <p id="template-preview-hint" className="campaign-compose-feedback ui-field__error" role="alert">{previewHint}</p>}
        <div className="campaign-compose-row"><label htmlFor="template-from">From name</label><Input id="template-from" placeholder="Sender name, e.g. Acme" value={draft.fromName ?? ''} disabled={archived} onChange={event => change('fromName', event.target.value)} /></div>
        <div className="campaign-compose-row"><label htmlFor="template-reply">Reply to</label><Input id="template-reply" placeholder="Optional reply@example.com" value={draft.replyTo.join(', ')} disabled={archived} onChange={event => change('replyTo', event.target.value.split(',').map(value => value.trim()).filter(Boolean))} /></div>
      </div>
      <ChunkFallback.Provider value={<ComposerSkeleton />}><EmailComposer ref={composer} attachmentApi={api.templateAssets} attachmentIds={draft.attachments} initialHtml={draft.html ?? ''} disabled={archived} onReady={() => setReady(true)} onDirty={changed} onBusy={setComposerBusy} onAttach={() => attachments.current?.open()} /></ChunkFallback.Provider>
      <CampaignAttachments ref={attachments} attachmentApi={api.templateAssets} ids={draft.attachments} persisted={template.draft.attachments} onChange={ids => change('attachments', ids)} onBusy={setAssetBusy} disabled={archived || saving || composerBusy} />
    </div></div></section>
    {previewOpen && <TemplatePreviewDialog template={template} onOpenChange={setPreviewOpen} />}
    <ConfirmDialog open={deleteOpen} onOpenChange={setDeleteOpen} title="Delete template?" description="Campaigns already created from this template will not change." confirmLabel="Delete template" danger onConfirm={async () => { await api.templates.remove(template.id); cache.removeQueries({queryKey: ['bane', api.mode, 'template', template.id], exact: true}); await refreshLists(); navigate('/campaigns/templates') }} />
  </div>
}

function TemplatePreviewDialog({ template, onOpenChange }: {template: CampaignTemplate; onOpenChange: (open: boolean) => void}) {
  const api = useApi()
  const preview = useApiQuery(['template-preview', template.id, template.revision], (client, signal) => client.templates.preview(template.id, false, signal))
  return <Dialog open onOpenChange={onOpenChange} title="Template preview" className="template-preview-dialog">
    {preview.isError ? <ErrorState error={preview.error} onRetry={() => preview.refetch()} /> : preview.isPending ? <div className="stack"><ComposerSkeleton /></div> : <EmailPreview html={preview.data.html} attachmentIds={template.draft.attachments} attachmentApi={api.templateAssets} respectStyles />}
  </Dialog>
}
