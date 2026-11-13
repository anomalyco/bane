import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ExternalLink } from 'lucide-react'
import { Alert, Button, Checkbox, ConfirmDialog, CopyButton, SecretCode, DataTable, Dialog, DropdownMenu, EmptyState, ErrorState, Field, Input, PageHeader, Select, StatusBadge, Tabs, Textarea, useToast, type Column, type MenuItem, type Tone } from '../../components/ui'
import { useSession } from '../../data/context'
import { noteKinds, noteSeverities, noteStatuses, resolved, statusLabel, uiNotesApi, uiNotesKey, type NoteKind, type NoteSeverity, type NoteStatus, type UiNote } from '../../data/ui-notes'
import { relativeTime, shortDateTime } from '../../lib/format'
import { notesModifierLabel, setUiNotesMode } from '../../lib/ui-notes-mode'
import { NotesToolbar, noteColumnDefs, useOperatorTabs } from './skeletons'

// Every UI note across the dashboard (staff's ⌘-click notes, features/ui-notes): filter by status, type and text, open
// one for its screenshot and everything captured with it, change status in bulk, and make the key an agent uses to fetch
// and resolve them (api/scripts/ui-notes.ts). operator:read sees them; the operator role changes them.
const NotFound = () => <EmptyState headingAs="h1" title="Page not found" action={<Link to="/">Return to overview</Link>} />
const def = (key: string) => noteColumnDefs.find(column => column.key === key)!
const kindLabel = (kind: string) => kind[0]!.toUpperCase() + kind.slice(1)
const statusTone: Record<NoteStatus, Tone> = { open: 'warning', in_progress: 'info', fixed: 'success', wontfix: 'neutral' }
const Status = ({ status }: { status: NoteStatus }) => <StatusBadge status={statusLabel[status]} tone={statusTone[status]} />
function useDebounced<T>(value: T, ms = 250) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => { const timer = setTimeout(() => setDebounced(value), ms); return () => clearTimeout(timer) }, [value, ms])
  return debounced
}
type NotesPage = Awaited<ReturnType<typeof uiNotesApi.list>>
const Thumb = ({ note }: { note: UiNote }) => <span className="op-shot">{note.screenshot && <img src={note.screenshot.url} alt="" loading="lazy" decoding="async" />}</span>

export function OperatorNotesPage() {
  // Only for the people the API allows (GET /v1/me uiNotes); the API answers 404 to everyone else.
  const identity = useSession()?.identity, role = identity?.uiNotes === true ? identity.operator ?? null : null, canAct = role === 'operator', tabs = useOperatorTabs()
  const navigate = useNavigate(), client = useQueryClient(), toast = useToast()
  const [params, setParams] = useSearchParams()
  const status = params.get('status') ?? '', kind = params.get('kind') ?? ''
  const [search, setSearch] = useState(params.get('q') ?? '')
  const q = useDebounced(search.trim())
  const setParam = (name: string, value: string) => setParams(previous => { const next = new URLSearchParams(previous); if (value) next.set(name, value); else next.delete(name); return next }, { replace: true })
  useEffect(() => { if ((params.get('q') ?? '') !== q) setParam('q', q) }, [q]) // eslint-disable-line react-hooks/exhaustive-deps
  const filter = { status: status === 'all' ? undefined : status ? [status as NoteStatus] : ['open', 'in_progress'] as NoteStatus[], kind: kind ? [kind as NoteKind] : undefined, q: q || undefined }
  const notes = useInfiniteQuery({ queryKey: [...uiNotesKey, 'list', status, kind, q], initialPageParam: undefined as string | undefined, enabled: Boolean(role), placeholderData: keepPreviousData,
    queryFn: ({ pageParam, signal }) => uiNotesApi.list({ ...filter, cursor: pageParam, limit: 100 }, signal), getNextPageParam: (page: NotesPage) => page.nextCursor ?? undefined })
  const rows = useMemo(() => notes.data?.pages.flatMap(page => page.data) ?? [], [notes.data])
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [open, setOpen] = useState<string | null>(null)
  const [keys, setKeys] = useState(false)
  const [bulkDelete, setBulkDelete] = useState(false)
  useEffect(() => { setSelected(current => { const visible = new Set(rows.map(row => row.id)); const next = new Set([...current].filter(id => visible.has(id))); return next.size === current.size ? current : next }) }, [rows])
  if (!role) return <NotFound />
  const refresh = () => client.invalidateQueries({ queryKey: uiNotesKey })
  const toggle = (noteId: string, on: boolean) => setSelected(current => { const next = new Set(current); if (on) next.add(noteId); else next.delete(noteId); return next })
  async function bulk(work: (noteId: string) => Promise<unknown>, done: string) {
    const ids = [...selected], results = await Promise.allSettled(ids.map(work)), failed = results.filter(result => result.status === 'rejected').length
    setSelected(new Set()); await refresh()
    toast(failed ? `${ids.length - failed} of ${ids.length} notes ${done}; ${failed} failed.` : `${ids.length} ${ids.length === 1 ? 'note' : 'notes'} ${done}.`, failed ? 'error' : 'success')
  }
  const setStatus = (value: NoteStatus) => bulk(noteId => uiNotesApi.update(noteId, { status: value }), `marked ${statusLabel[value].toLowerCase()}`)
  const openOnPage = (note: UiNote) => { setUiNotesMode(true); navigate(note.page.path) }
  const allChecked = rows.length > 0 && rows.every(row => selected.has(row.id))
  const columns: Column<UiNote>[] = [
    { ...def('select'), label: canAct && rows.length ? <Checkbox checked={allChecked} onCheckedChange={on => setSelected(on ? new Set(rows.map(row => row.id)) : new Set())} label={<span className="sr-only">Select all</span>} /> : '',
      render: note => canAct ? <Checkbox checked={selected.has(note.id)} onCheckedChange={on => toggle(note.id, on)} label={<span className="sr-only">Select note</span>} /> : null },
    { ...def('shot'), render: note => <Thumb note={note} /> },
    { ...def('note'), render: note => <span className="op-cell" title={note.body}>{note.severity === 'high' && <span className="op-flags">High · </span>}{note.body}</span>, cardRender: note => `${note.severity === 'high' ? 'High · ' : ''}${note.body}` },
    { ...def('status'), render: note => <Status status={note.status} /> },
    { ...def('page'), render: note => <span className="op-cell op-muted-id" title={note.page.path}>{note.page.route}</span> },
    { ...def('kind'), render: note => kindLabel(note.kind) },
    { ...def('created'), render: note => <span className="op-cell" title={`${shortDateTime(note.createdAt)} UTC`}>{relativeTime(note.createdAt)}{note.author?.name ? ` · ${note.author.name.split(' ')[0]}` : ''}</span>, cardRender: note => relativeTime(note.createdAt) },
    { ...def('actions'), render: note => <DropdownMenu label="Note actions" title={note.body.slice(0, 60)} items={[
      { label: 'Open on its page', onSelect: () => openOnPage(note) },
      ...canAct ? noteStatuses.filter(value => value !== note.status).map((value): MenuItem => ({ label: `Mark ${statusLabel[value].toLowerCase()}`, onSelect: () => void uiNotesApi.update(note.id, { status: value }).then(refresh, error => toast(error instanceof Error ? error.message : 'Couldn’t update the note.', 'error')) })) : [],
      ...canAct ? [{ label: 'Delete…', destructive: true, onSelect: () => setOpen(note.id) }] : [],
    ]} /> },
  ]
  const bulkItems: MenuItem[] = [...noteStatuses.map((value): MenuItem => ({ label: `Mark ${statusLabel[value].toLowerCase()}`, onSelect: () => void setStatus(value) })), { label: 'Delete…', destructive: true, onSelect: () => setBulkDelete(true) }]
  const bulkTrigger = <Button className="op-bulk" disabled={!canAct || !selected.size}>{selected.size ? `${selected.size} selected` : 'Select notes'} <ChevronDown size={14} aria-hidden="true" /></Button>
  const filtered = Boolean(q || kind || status)
  return <>
    <PageHeader title="Operator" actions={canAct ? <Button onClick={() => setKeys(true)}>Agent keys</Button> : undefined} />
    <div className="op-page">
      <Tabs value="notes" label="Operator views" items={tabs} onValueChange={value => { if (value !== 'notes') navigate(value === 'actions' ? '/operator?view=actions' : '/operator') }} />
      <NotesToolbar search={search} status={status} kind={kind} onSearch={setSearch} onStatus={value => setParam('status', value)} onKind={value => setParam('kind', value)}
        actions={selected.size ? <DropdownMenu label="Selected notes" title={`${selected.size} selected`} trigger={bulkTrigger} items={bulkItems} /> : bulkTrigger} />
      {notes.isError && !notes.data ? <ErrorState error={notes.error} onRetry={() => void notes.refetch()} /> : <>
        <DataTable className="op-notes" loading={notes.isPending} skeletonRows={6} rows={rows} rowKey={row => row.id} onRowClick={row => setOpen(row.id)} columns={columns}
          empty={<EmptyState title={filtered ? 'No notes match' : 'No open notes'} description={filtered ? 'Try another status, type or search.' : `Turn on UI notes (⇧N), then ${notesModifierLabel}-click anything to leave one.`} />} />
        {notes.hasNextPage && <Button className="op-more" loading={notes.isFetchingNextPage} onClick={() => void notes.fetchNextPage()}>Load more</Button>}
      </>}
    </div>
    {open && <NoteDialog noteId={open} initial={rows.find(row => row.id === open)} canAct={canAct} onClose={() => setOpen(null)} onChanged={() => void refresh()} onOpenOnPage={openOnPage} />}
    {keys && <KeysDialog onClose={() => setKeys(false)} />}
    <ConfirmDialog open={bulkDelete} onOpenChange={setBulkDelete} danger title={`Delete ${selected.size} ${selected.size === 1 ? 'note' : 'notes'}?`} description="Their screenshots are deleted too. This can’t be undone." confirmLabel="Delete"
      onConfirm={() => bulk(noteId => uiNotesApi.remove(noteId), 'deleted')} />
  </>
}

// ---------------------------------------------------------------- one note

const Facts = ({ rows }: { rows: [string, ReactNode][] }) => <dl className="op-rows">{rows.filter(([, value]) => value !== null && value !== '').map(([title, value]) => <div key={title}><dt>{title}</dt><dd>{value}</dd></div>)}</dl>
function NoteDialog({ noteId, initial, canAct, onClose, onChanged, onOpenOnPage }: { noteId: string; initial?: UiNote; canAct: boolean; onClose: () => void; onChanged: () => void; onOpenOnPage: (note: UiNote) => void }) {
  const fetched = useQuery({ queryKey: [...uiNotesKey, 'note', noteId], queryFn: ({ signal }) => uiNotesApi.get(noteId, signal), initialData: initial, staleTime: 0 })
  const note = fetched.data
  const [body, setBody] = useState(note?.body ?? ''), [kind, setKind] = useState<string>(note?.kind ?? 'other'), [severity, setSeverity] = useState<string>(note?.severity ?? '')
  const [status, setStatus] = useState<string>(note?.status ?? 'open'), [prUrl, setPrUrl] = useState(note?.prUrl ?? ''), [resolution, setResolution] = useState(note?.resolution ?? '')
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [confirm, setConfirm] = useState(false)
  useEffect(() => { if (!note) return; setBody(note.body); setKind(note.kind); setSeverity(note.severity ?? ''); setStatus(note.status); setPrUrl(note.prUrl ?? ''); setResolution(note.resolution ?? '') }, [note?.updatedAt]) // eslint-disable-line react-hooks/exhaustive-deps
  async function run(work: () => Promise<unknown>) {
    setBusy(true); setError(null)
    try { await work(); onChanged(); onClose() } catch (cause) { setError(cause instanceof Error ? cause.message : 'Couldn’t save the note.') } finally { setBusy(false) }
  }
  function save(event: FormEvent) {
    event.preventDefault()
    if (!note) return
    void run(() => uiNotesApi.update(note.id, { body: body.trim(), kind: kind as NoteKind, severity: (severity || null) as NoteSeverity | null, status: status as NoteStatus, prUrl: prUrl.trim() || null, resolution: resolution.trim() || null }))
  }
  const e = note?.element, styles = e ? Object.entries(e.styles).map(([name, value]) => `${name}: ${value}`).join('; ') : ''
  return <Dialog open onOpenChange={next => { if (!next && !busy) onClose() }} className="op-note-dialog" title={note ? `${kindLabel(note.kind)} note` : 'Note'}
    footer={!note ? undefined : confirm
      ? <><span className="op-confirm">Delete this note and its screenshot?</span><Button onClick={() => setConfirm(false)} disabled={busy}>Keep</Button><Button variant="danger" loading={busy} onClick={() => void run(() => uiNotesApi.remove(note.id))}>Delete</Button></>
      : <>{canAct && <Button variant="ghost" className="op-delete" onClick={() => setConfirm(true)}>Delete</Button>}<Button onClick={() => onOpenOnPage(note)}>Open on page</Button>{canAct && <Button type="submit" form="op-note-form" variant="primary" loading={busy} disabled={!body.trim()}>Save</Button>}</>}>
    {!note ? fetched.isPending ? <p className="muted" role="status">Loading the note…</p> : <ErrorState error={fetched.error ?? 'This note was deleted.'} /> : <form id="op-note-form" className="op-dialog-fields" onSubmit={save}>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="op-note-shot">
        {note.screenshot ? <a href={note.screenshot.url} target="_blank" rel="noreferrer" title="Open full size"><img src={note.screenshot.url} alt={`Screenshot of ${e?.component ?? e?.tag ?? 'the element'}`} style={note.screenshot.width ? { maxWidth: note.screenshot.width / Math.min(2, Math.max(1, note.context.dpr)) } : undefined} /></a> : <span className="muted">No screenshot</span>}
      </div>
      <Field label="Note"><Textarea value={body} onChange={event => setBody(event.target.value)} maxLength={4000} rows={3} disabled={!canAct} /></Field>
      <div className="op-note-grid">
        <Field label="Status"><Select value={status} onValueChange={setStatus} disabled={!canAct} options={noteStatuses.map(value => ({ value, label: statusLabel[value] }))} /></Field>
        <Field label="Type"><Select value={kind} onValueChange={setKind} disabled={!canAct} options={noteKinds.map(value => ({ value, label: kindLabel(value) }))} /></Field>
        <Field label="Severity"><Select value={severity} onValueChange={setSeverity} disabled={!canAct} options={[{ value: '', label: 'None' }, ...noteSeverities.map(value => ({ value, label: kindLabel(value) }))]} /></Field>
      </div>
      <Field label="Fixing pull request"><Input type="url" inputMode="url" value={prUrl} onChange={event => setPrUrl(event.target.value)} placeholder="https://github.com/…/pull/…" disabled={!canAct} /></Field>
      {(canAct || note.resolution) && <Field label="Resolution"><Textarea value={resolution} onChange={event => setResolution(event.target.value)} maxLength={2000} rows={2} placeholder={resolved(note.status) ? 'What was done, or why not' : 'Optional'} disabled={!canAct} /></Field>}
      <Facts rows={[
        ['Page', <Link to={note.page.path} onClick={() => onOpenOnPage(note)}>{note.page.path}</Link>],
        ['Route', <code>{note.page.route}</code>],
        ['Element', e ? <><code>{e.selector}</code>{e.component ? <span className="muted"> · {e.components.join(' › ') || e.component}</span> : null}</> : null],
        ['Text', e?.text ?? null],
        ['Box', e ? `${e.box.width} × ${e.box.height} at ${e.box.x}, ${e.box.y}` : null],
        ['Styles', styles ? <code className="op-note-styles">{styles}</code> : null],
        ['Shown on', `${note.context.viewport.width} × ${note.context.viewport.height} @${note.context.dpr}x · ${note.context.device} · ${note.context.theme} · build ${note.context.build}`],
        ['Left', `${shortDateTime(note.createdAt)} UTC${note.author?.name ? ` by ${note.author.name}` : ''}`],
        ['Pull request', note.prUrl ? <a href={note.prUrl} target="_blank" rel="noreferrer">{note.prUrl} <ExternalLink size={11} aria-hidden="true" /></a> : null],
        ['ID', <span className="op-muted-id">{note.id}</span>],
      ]} />
    </form>}
  </Dialog>
}

// ---------------------------------------------------------------- agent keys

function KeysDialog({ onClose }: { onClose: () => void }) {
  const client = useQueryClient()
  const keys = useQuery({ queryKey: [...uiNotesKey, 'keys'], queryFn: ({ signal }) => uiNotesApi.keys.list(signal) })
  const [name, setName] = useState('Fix agent'), [days, setDays] = useState('30'), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  async function create(event: FormEvent) {
    event.preventDefault()
    setBusy(true); setError(null)
    try { setSecret((await uiNotesApi.keys.create({ name: name.trim(), expiresInDays: Number(days) })).secret); await client.invalidateQueries({ queryKey: [...uiNotesKey, 'keys'] }) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Couldn’t create the key.') } finally { setBusy(false) }
  }
  const revoke = async (keyId: string) => { try { await uiNotesApi.keys.revoke(keyId); await client.invalidateQueries({ queryKey: [...uiNotesKey, 'keys'] }) } catch (cause) { setError(cause instanceof Error ? cause.message : 'Couldn’t revoke the key.') } }
  const live = (keys.data ?? []).filter(key => !key.revokedAt && Date.parse(key.expiresAt) > Date.now())
  const origin = window.location.origin
  return <Dialog sensitive={Boolean(secret)} open onOpenChange={next => { if (!next) onClose() }} title="Agent keys" className="op-keys-dialog"
    description="A key lets a script or agent list UI notes, download their screenshots and set their status as you. It does nothing else, and stops working if you lose the operator role."
    footer={<Button onClick={onClose}>Done</Button>}>
    <div className="op-dialog-fields">
      {error && <Alert tone="danger">{error}</Alert>}
      {secret ? <Alert tone="success" title="Copy the key now. It isn’t shown again.">
        <span className="op-key-secret"><SecretCode>{secret}</SecretCode><CopyButton value={secret} label="Copy key" /></span>
        <code className="op-key-usage">{`BANE_URL=${origin} BANE_UI_NOTES_KEY=${secret.slice(0, 15)}… node --import tsx api/scripts/ui-notes.ts list --status open --json --screenshots ./notes`}</code>
      </Alert> : <form className="op-key-form" onSubmit={create}>
        <Field label="Name" htmlFor="ui-note-key-name"><Input id="ui-note-key-name" value={name} maxLength={100} onChange={event => setName(event.target.value)} required /></Field>
        <Field label="Expires"><Select value={days} onValueChange={setDays} options={[{ value: '7', label: 'In 7 days' }, { value: '30', label: 'In 30 days' }, { value: '90', label: 'In 90 days' }]} /></Field>
        <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>Create key</Button>
      </form>}
      <ul className="op-keys">{keys.isPending ? <li className="muted">Loading keys…</li> : !live.length ? <li className="muted">No active keys.</li> : live.map(key => <li key={key.id}>
        <span className="op-cell"><strong>{key.name}</strong> <span className="op-muted-id">{key.prefix}…</span></span>
        <span className="muted">{key.lastUsedAt ? `used ${relativeTime(key.lastUsedAt)}` : 'never used'} · expires {relativeTime(key.expiresAt)}</span>
        <Button size="sm" variant="danger" onClick={() => void revoke(key.id)}>Revoke</Button>
      </li>)}</ul>
    </div>
  </Dialog>
}
