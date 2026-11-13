import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Link, useLocation } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, X } from 'lucide-react'
import { Button, IconButton, Sheet, Textarea, useToast } from '../../components/ui'
import { usePhone } from '../../lib/media'
import { relativeTime } from '../../lib/format'
import { notesModifier, notesModifierLabel, setUiNotesMode } from '../../lib/ui-notes-mode'
import { noteKinds, noteSeverities, noteStatuses, resolved, statusLabel, uiNotesApi, uiNotesKey, type NoteKind, type NoteSeverity, type NoteStatus, type UiNote } from '../../data/ui-notes'
import { describe, locate, ownElement, routeOf, screenshot, sensitiveElement } from './capture'
import './notes.css'

// UI notes mode, for Nightmail staff (lazy; the shell mounts it only while the mode is on, lib/ui-notes-mode.ts). ⌘-click
// (Ctrl-click off a Mac) any element, or long-press it on a touch screen, to leave a note on it: the click is taken
// before the page sees it, so a link doesn't open and a menu doesn't toggle. The page's open notes show as numbered pins
// on their elements, found again by selector; one whose element isn't here is listed in the tray as moved. Everything
// is an overlay in one fixed layer, so nothing on the page moves.

type Shot = Awaited<ReturnType<typeof screenshot>>
type Draft = { target: Element; info: ReturnType<typeof describe>; shot: Promise<Shot> }
type Anchor = () => DOMRect | null
const LONG_PRESS_MS = 500
const KIND_KEY = 'bane.ui-notes.kind'
const lastKind = (): NoteKind => { try { const value = localStorage.getItem(KIND_KEY); return (noteKinds as readonly string[]).includes(value ?? '') ? value as NoteKind : 'alignment' } catch { return 'alignment' } }
const kindLabel = (kind: string) => kind[0]!.toUpperCase() + kind.slice(1)
// The thing a click lands on inside an icon is a path; the note belongs to the icon.
const noteTarget = (node: Element) => node instanceof SVGElement && node.ownerSVGElement ? node.closest('svg')! : node

export function UiNotesLayer() {
  const location = useLocation(), route = routeOf(location.pathname)
  const client = useQueryClient(), toast = useToast(), phone = usePhone()
  const notes = useQuery({ queryKey: [...uiNotesKey, 'page', route], queryFn: ({ signal }) => uiNotesApi.list({ route, limit: 200 }, signal).then(page => page.data), staleTime: 30_000 })
  // Numbered in the order they were left, so a pin keeps its number.
  const ordered = useMemo(() => [...notes.data ?? []].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)), [notes.data])
  const number = useMemo(() => new Map(ordered.map((note, index) => [note.id, index + 1])), [ordered])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [viewing, setViewing] = useState<{ id: string; anchor: Anchor } | null>(null)
  const [tray, setTray] = useState(false)
  const [moved, setMoved] = useState<ReadonlySet<string>>(new Set())
  const [focus, setFocus] = useState<string | null>(null)
  // The note just saved: its pin pops in where the note went.
  const [fresh, setFresh] = useState<string | null>(null)
  const outline = useRef<HTMLDivElement>(null)
  useEffect(() => { if (!fresh) return; const timer = setTimeout(() => setFresh(null), 1000); return () => clearTimeout(timer) }, [fresh])

  const replace = useCallback((note: UiNote) => client.setQueryData<UiNote[]>([...uiNotesKey, 'page', route], current => current?.some(item => item.id === note.id) ? current.map(item => item.id === note.id ? note : item) : [...current ?? [], note]), [client, route])
  const remove = useCallback((noteId: string) => client.setQueryData<UiNote[]>([...uiNotesKey, 'page', route], current => current?.filter(item => item.id !== noteId)), [client, route])
  const refresh = useCallback(() => void client.invalidateQueries({ queryKey: uiNotesKey, predicate: query => query.queryKey[1] !== 'page' }), [client])

  const open = useCallback((node: Element) => {
    const target = noteTarget(node)
    // A secret-bearing screen (data-sensitive) never becomes a note: nothing of it is recorded.
    if (sensitiveElement(target)) { toast('That shows a secret, so it can’t have a note. Note what’s around it instead.', 'error'); return }
    setViewing(null); setTray(false)
    // The screenshot starts now, before the composer exists, so it shows the page as it was clicked.
    setDraft({ target, info: describe(target), shot: screenshot(target) })
  }, [toast])

  // The gesture. Capture-phase listeners on window run before React and every other handler.
  useEffect(() => {
    let armed = false, pressed = false, timer = 0, start: { x: number; y: number } | null = null
    const swallow = (event: Event) => { event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation() }
    const cancel = () => { window.clearTimeout(timer); start = null }
    const onPointerDown = (event: PointerEvent) => {
      armed = false; pressed = false
      if (ownElement(event.target) || event.button !== 0) return
      if (event.pointerType === 'touch') {
        cancel(); start = { x: event.clientX, y: event.clientY }
        const target = event.target as Element
        timer = window.setTimeout(() => { pressed = true; start = null; navigator.vibrate?.(8); open(target) }, LONG_PRESS_MS)
        return
      }
      if (notesModifier(event)) { armed = true; swallow(event) }
    }
    const onPointerMove = (event: PointerEvent) => {
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) cancel()
      // Holding the modifier outlines what a click would note. Drawn straight to the element, no animation.
      const box = outline.current
      if (!box || event.pointerType === 'touch') return
      const target = event.target instanceof Element && !ownElement(event.target) && notesModifier(event) ? noteTarget(event.target) : null
      if (!target) { box.hidden = true; return }
      const r = target.getBoundingClientRect()
      Object.assign(box.style, { translate: `${r.left}px ${r.top}px`, width: `${r.width}px`, height: `${r.height}px` })
      box.toggleAttribute('data-blocked', sensitiveElement(target))
      box.hidden = false
    }
    const onUp = (event: Event) => { cancel(); if (armed) swallow(event) }
    const onMouse = (event: MouseEvent) => { if (armed || (notesModifier(event) && !ownElement(event.target))) swallow(event) }
    const onClick = (event: MouseEvent) => {
      if (ownElement(event.target)) return
      if (pressed) { pressed = false; swallow(event); return }
      if (!armed && !(notesModifier(event) && event.button === 0)) return
      armed = false; swallow(event)
      if (event.target instanceof Element) open(event.target)
    }
    const onContextMenu = (event: Event) => { if (pressed || start) swallow(event) }
    const onKey = (event: KeyboardEvent) => { if (!notesModifier(event) && outline.current) outline.current.hidden = true; document.documentElement.toggleAttribute('data-ui-notes-armed', notesModifier(event) && event.type === 'keydown') }
    const onBlur = () => { armed = false; cancel(); if (outline.current) outline.current.hidden = true; document.documentElement.removeAttribute('data-ui-notes-armed') }
    const listeners: [string, EventListener][] = [['pointerdown', onPointerDown as EventListener], ['pointermove', onPointerMove as EventListener], ['pointerup', onUp], ['pointercancel', onUp],
      ['mousedown', onMouse as EventListener], ['mouseup', onMouse as EventListener], ['click', onClick as EventListener], ['auxclick', onMouse as EventListener], ['contextmenu', onContextMenu],
      ['keydown', onKey as EventListener], ['keyup', onKey as EventListener], ['blur', onBlur]]
    for (const [type, listener] of listeners) window.addEventListener(type, listener, { capture: true, passive: false })
    document.documentElement.setAttribute('data-ui-notes-mode', '')
    return () => {
      cancel()
      for (const [type, listener] of listeners) window.removeEventListener(type, listener, { capture: true })
      document.documentElement.removeAttribute('data-ui-notes-mode'); document.documentElement.removeAttribute('data-ui-notes-armed')
    }
  }, [open])

  // Esc closes the topmost thing the layer opened.
  useEffect(() => {
    if (!draft && !viewing && !tray) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (draft) setDraft(null); else if (viewing) setViewing(null); else setTray(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [draft, viewing, tray])

  async function saved(note: UiNote, shot: Promise<Shot>) {
    replace(note); setDraft(null); setFresh(note.id); refresh()
    try {
      const image = await shot
      if (image) replace(await uiNotesApi.screenshot(note.id, image))
    } catch { toast('Note saved, but its screenshot didn’t upload.', 'error') }
  }
  const viewed = viewing ? ordered.find(note => note.id === viewing.id) ?? null : null
  const unresolved = useMemo(() => ordered.filter(note => !resolved(note.status)), [ordered])

  return createPortal(<div data-ui-notes className="uin-layer">
    <div ref={outline} className="uin-outline" hidden />
    <Pins notes={unresolved} number={number} focus={focus} fresh={fresh} onMoved={setMoved} onOpen={(note, anchor) => { setDraft(null); setViewing({ id: note.id, anchor }) }} onFocus={setFocus} />
    {draft && (phone
      ? <Sheet open onOpenChange={next => { if (!next) setDraft(null) }} title="New note" className="uin-sheet"><Composer draft={draft} onClose={() => setDraft(null)} onSaved={saved} /></Sheet>
      : <Anchored anchor={() => draft.target.isConnected ? draft.target.getBoundingClientRect() : null} label="New note"><Composer draft={draft} onClose={() => setDraft(null)} onSaved={saved} /></Anchored>)}
    {viewing && viewed && (phone
      ? <Sheet open onOpenChange={next => { if (!next) setViewing(null) }} title={`Note ${number.get(viewed.id)}`} className="uin-sheet"><Viewer note={viewed} number={number.get(viewed.id)!} moved={moved.has(viewed.id)} onChange={note => { replace(note); refresh() }} onDelete={() => { remove(viewed.id); setViewing(null); refresh() }} onClose={() => setViewing(null)} /></Sheet>
      : <Anchored anchor={viewing.anchor} label={`Note ${number.get(viewed.id)}`} dismiss={() => setViewing(null)}><Viewer note={viewed} number={number.get(viewed.id)!} moved={moved.has(viewed.id)} onChange={note => { replace(note); refresh() }} onDelete={() => { remove(viewed.id); setViewing(null); refresh() }} onClose={() => setViewing(null)} /></Anchored>)}
    <Tray open={tray} onOpenChange={setTray} notes={ordered} number={number} moved={moved} loading={notes.isPending} onFocus={setFocus}
      onPick={(note, row) => {
        const target = moved.has(note.id) || resolved(note.status) ? null : locate(note.element)
        if (target) target.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
        setTray(false); setDraft(null)
        setViewing({ id: note.id, anchor: () => target?.isConnected ? target.getBoundingClientRect() : row.isConnected ? row.getBoundingClientRect() : null })
      }} />
  </div>, document.body)
}

// ---------------------------------------------------------------- an anchored panel

/** A panel beside an element: below it when it fits, else above, inside the viewport; it follows on scroll. */
function Anchored({ anchor, label, children, dismiss }: { anchor: Anchor; label: string; children: ReactNode; dismiss?: () => void }) {
  const panel = useRef<HTMLDivElement>(null), latest = useRef(anchor)
  latest.current = anchor
  useLayoutEffect(() => {
    let frame = 0
    const place = () => {
      frame = 0
      const el = panel.current, rect = latest.current()
      if (!el) return
      const width = el.offsetWidth, height = el.offsetHeight, gap = 8, pad = 12
      const r = rect ?? new DOMRect(innerWidth / 2 - width / 2, innerHeight / 3, width, 0)
      const below = r.bottom + gap + height <= innerHeight - pad || r.top - gap - height < pad
      const top = Math.min(Math.max(pad, below ? r.bottom + gap : r.top - gap - height), innerHeight - height - pad)
      const left = Math.min(Math.max(pad, r.left), innerWidth - width - pad)
      el.style.translate = `${Math.round(left)}px ${Math.round(top)}px`
      el.dataset.side = below ? 'bottom' : 'top'
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(place) }
    place()
    const resize = new ResizeObserver(schedule)
    if (panel.current) resize.observe(panel.current)
    window.addEventListener('scroll', schedule, { capture: true, passive: true }); window.addEventListener('resize', schedule)
    return () => { cancelAnimationFrame(frame); resize.disconnect(); window.removeEventListener('scroll', schedule, { capture: true }); window.removeEventListener('resize', schedule) }
  }, [])
  useEffect(() => {
    if (!dismiss) return
    const onDown = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !(event.target instanceof Element && event.target.closest('.uin-pin, .uin-tray'))) dismiss() }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [dismiss])
  return <div ref={panel} className="uin-panel" role="dialog" aria-label={label}>{children}</div>
}

// ---------------------------------------------------------------- composing

function Chips<T extends string>({ label, values, value, onChange, format, optional }: { label: string; values: readonly T[]; value: T | null; onChange: (value: T | null) => void; format: (value: T) => string; optional?: boolean }) {
  return <div className="uin-chips" role="group" aria-label={label}>{values.map(item =>
    <button key={item} type="button" className="uin-chip" aria-pressed={value === item} onClick={() => onChange(optional && value === item ? null : item)}>{format(item)}</button>)}</div>
}
const submitKeys = (event: ReactKeyboardEvent, submit: () => void) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit() } }

function Composer({ draft, onClose, onSaved }: { draft: Draft; onClose: () => void; onSaved: (note: UiNote, shot: Promise<Shot>) => void }) {
  const [body, setBody] = useState(''), [kind, setKind] = useState<NoteKind>(lastKind), [severity, setSeverity] = useState<NoteSeverity | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { field.current?.focus({ preventScroll: true }) }, [draft])
  const { component, tag } = draft.info.element, where = component ? `${component} · ${tag}` : tag
  async function submit() {
    if (busy) return
    if (!body.trim()) { field.current?.focus(); return }
    setBusy(true); setError(null)
    try { localStorage.setItem(KIND_KEY, kind) } catch { /* Next note starts on the default. */ }
    try { onSaved(await uiNotesApi.create({ body: body.trim(), kind, severity, url: draft.info.url, route: draft.info.route, context: draft.info.context, element: draft.info.element }), draft.shot) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Couldn’t save the note.'); setBusy(false) }
  }
  return <form className="uin-form" onSubmit={event => { event.preventDefault(); void submit() }} onKeyDown={event => submitKeys(event, () => void submit())}>
    <div className="uin-head"><span className="uin-where" title={draft.info.element.selector}>{where}</span><span className="uin-route">{draft.info.route}</span></div>
    <Textarea ref={field} className="uin-text" rows={3} maxLength={4000} value={body} onChange={event => setBody(event.target.value)} placeholder="What’s off here?" aria-label="Note" />
    <Chips label="Type" values={noteKinds} value={kind} onChange={value => setKind(value ?? 'other')} format={kindLabel} />
    <Chips label="Severity (optional)" values={noteSeverities} value={severity} onChange={setSeverity} format={kindLabel} optional />
    {error && <p className="uin-error" role="alert">{error}</p>}
    <div className="uin-foot"><span className="uin-hint">{notesModifierLabel}↵ save · Esc</span><Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button><Button size="sm" type="submit" variant="primary" loading={busy} disabled={!body.trim()}>Save note</Button></div>
  </form>
}

// ---------------------------------------------------------------- one note

function Viewer({ note, number, moved, onChange, onDelete, onClose }: { note: UiNote; number: number; moved: boolean; onChange: (note: UiNote) => void; onDelete: () => void; onClose: () => void }) {
  const [editing, setEditing] = useState(false), [body, setBody] = useState(note.body), [kind, setKind] = useState(note.kind), [severity, setSeverity] = useState(note.severity)
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState<string | null>(null), [error, setError] = useState<string | null>(null)
  const location = useLocation()
  useEffect(() => { setBody(note.body); setKind(note.kind); setSeverity(note.severity) }, [note.body, note.kind, note.severity])
  async function run(name: string, work: () => Promise<void>) {
    if (busy) return
    setBusy(name); setError(null)
    try { await work() } catch (cause) { setError(cause instanceof Error ? cause.message : 'Couldn’t save the change.') } finally { setBusy(null) }
  }
  const patch = (name: string, change: Parameters<typeof uiNotesApi.update>[1]) => run(name, async () => { onChange(await uiNotesApi.update(note.id, change)); setEditing(false) })
  const here = `${location.pathname}${location.search}` === note.page.path
  return <div className="uin-form" onKeyDown={event => { if (editing) submitKeys(event, () => void patch('save', { body: body.trim(), kind, severity })) }}>
    <div className="uin-head"><span className="uin-number" data-status={note.status}>{number}</span><span className="uin-kind">{kindLabel(note.kind)}{note.severity ? ` · ${note.severity}` : ''}</span><IconButton size="sm" label="Close note" onClick={onClose}><X size={14} /></IconButton></div>
    {editing ? <>
      <Textarea className="uin-text" rows={3} maxLength={4000} value={body} onChange={event => setBody(event.target.value)} aria-label="Note" autoFocus />
      <Chips label="Type" values={noteKinds} value={kind} onChange={value => setKind(value ?? 'other')} format={kindLabel} />
      <Chips label="Severity (optional)" values={noteSeverities} value={severity} onChange={setSeverity} format={kindLabel} optional />
    </> : <p className="uin-body">{note.body}</p>}
    {moved && <p className="uin-moved">Element moved: its selector finds nothing here.{!here && <> <Link to={note.page.path}>Open where it was left</Link></>}</p>}
    <p className="uin-meta">{note.author?.name ?? 'Someone'} · {relativeTime(note.createdAt)}{note.prUrl && <> · <a href={note.prUrl} target="_blank" rel="noreferrer">PR <ExternalLink size={11} aria-hidden="true" /></a></>}</p>
    <Chips label="Status" values={noteStatuses} value={note.status} onChange={value => { if (value && value !== note.status) void patch('status', { status: value as NoteStatus }) }} format={value => statusLabel[value]} />
    {error && <p className="uin-error" role="alert">{error}</p>}
    <div className="uin-foot">
      {confirm
        ? <><span className="uin-confirm">Delete this note?</span><Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>Keep</Button><Button size="sm" variant="danger" loading={busy === 'delete'} onClick={() => void run('delete', async () => { await uiNotesApi.remove(note.id); onDelete() })}>Delete</Button></>
        : editing
          ? <><span className="uin-hint">{notesModifierLabel}↵ save</span><Button size="sm" variant="ghost" onClick={() => { setEditing(false); setBody(note.body); setKind(note.kind); setSeverity(note.severity) }}>Cancel</Button><Button size="sm" variant="primary" loading={busy === 'save'} disabled={!body.trim()} onClick={() => void patch('save', { body: body.trim(), kind, severity })}>Save</Button></>
          : <><Button size="sm" variant="ghost" className="uin-delete" onClick={() => setConfirm(true)}>Delete</Button><Button size="sm" onClick={() => setEditing(true)}>Edit</Button>{!resolved(note.status) && <Button size="sm" variant="primary" loading={busy === 'status'} onClick={() => void patch('status', { status: 'fixed' })}>Resolve</Button>}</>}
    </div>
  </div>
}

// ---------------------------------------------------------------- pins

// Ancestors that clip the element (scroll areas, overflow hidden): a pin hides when its element is scrolled out of them.
const clippers = (node: Element) => {
  const list: Element[] = []
  for (let parent = node.parentElement; parent && parent !== document.body; parent = parent.parentElement) if (getComputedStyle(parent).overflow !== 'visible') list.push(parent)
  return list
}
function Pins({ notes, number, focus, fresh, onMoved, onOpen, onFocus }: { notes: UiNote[]; number: Map<string, number>; focus: string | null; fresh: string | null; onMoved: (moved: ReadonlySet<string>) => void; onOpen: (note: UiNote, anchor: Anchor) => void; onFocus: (id: string | null) => void }) {
  const pins = useRef(new Map<string, HTMLButtonElement>())
  const found = useRef(new Map<string, { el: Element; clip: Element[] } | null>())
  const highlight = useRef<HTMLDivElement>(null)
  const location = useLocation()
  const latest = useRef({ notes, focus, onMoved })
  latest.current = { notes, focus, onMoved }
  const control = useRef<{ relocate: () => void; schedule: () => void } | null>(null)
  // One loop for the page's life: positions follow scrolling at once, and elements are found again (debounced) when the
  // page's DOM changes. Pins are moved by their translate property (so a press's scale stays in place), never by React state.
  useLayoutEffect(() => {
    let frame = 0, relocate = true, last = '', timer = 0
    const place = () => {
      frame = 0
      const { notes, focus, onMoved } = latest.current
      if (relocate) {
        relocate = false
        for (const note of notes) {
          const current = found.current.get(note.id)
          if (current?.el.isConnected && current.el.getClientRects().length) continue
          const el = locate(note.element)
          found.current.set(note.id, el ? { el, clip: clippers(el) } : null)
        }
        const missing = notes.filter(note => !found.current.get(note.id)).map(note => note.id).sort().join()
        if (missing !== last) { last = missing; onMoved(new Set(missing ? missing.split(',') : [])) }
      }
      let lit = false
      for (const note of notes) {
        const pin = pins.current.get(note.id), hit = found.current.get(note.id)
        if (!pin) continue
        if (!hit?.el.isConnected) { pin.hidden = true; continue }
        const r = hit.el.getBoundingClientRect()
        const visible = r.width + r.height > 0 && r.bottom > 0 && r.top < innerHeight && hit.clip.every(clip => { const c = clip.getBoundingClientRect(); return r.bottom > c.top && r.top < c.bottom && r.right > c.left && r.left < c.right })
        pin.hidden = !visible
        if (visible) pin.style.translate = `${Math.round(Math.min(Math.max(4, r.left - 13), innerWidth - 26))}px ${Math.round(Math.min(Math.max(4, r.top - 11), innerHeight - 26))}px`
        if (focus === note.id && visible && highlight.current) {
          lit = true
          Object.assign(highlight.current.style, { translate: `${r.left}px ${r.top}px`, width: `${r.width}px`, height: `${r.height}px` })
        }
      }
      if (highlight.current) highlight.current.hidden = !lit
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(place) }
    const changed = () => { if (timer) return; timer = window.setTimeout(() => { timer = 0; relocate = true; schedule() }, 200) }
    control.current = { relocate: () => { found.current.clear(); relocate = true; place() }, schedule }
    const observer = new MutationObserver(records => { if (records.some(record => !ownElement(record.target))) changed() })
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] })
    window.addEventListener('scroll', schedule, { capture: true, passive: true }); window.addEventListener('resize', changed)
    return () => { cancelAnimationFrame(frame); window.clearTimeout(timer); observer.disconnect(); window.removeEventListener('scroll', schedule, { capture: true }); window.removeEventListener('resize', changed); control.current = null }
  }, [])
  const shape = notes.map(note => note.id).join()
  useLayoutEffect(() => { control.current?.relocate() }, [shape, location.key])
  useLayoutEffect(() => { control.current?.schedule() }, [focus])
  return <>
    <div ref={highlight} className="uin-highlight" hidden />
    {notes.map(note => <button key={note.id} ref={node => { if (node) pins.current.set(note.id, node); else pins.current.delete(note.id) }} type="button" className="uin-pin" data-status={note.status} data-fresh={fresh === note.id || undefined} hidden
      aria-label={`Note ${number.get(note.id)}: ${note.body.slice(0, 80)}`} title={note.body.slice(0, 200)}
      onPointerEnter={() => onFocus(note.id)} onPointerLeave={() => onFocus(null)} onFocus={() => onFocus(note.id)} onBlur={() => onFocus(null)}
      onClick={event => { const pin = event.currentTarget; onOpen(note, () => pin.isConnected && !pin.hidden ? pin.getBoundingClientRect() : null) }}>{number.get(note.id)}</button>)}
  </>
}

// ---------------------------------------------------------------- the tray

function Tray({ open, onOpenChange, notes, number, moved, loading, onPick, onFocus }: { open: boolean; onOpenChange: (open: boolean) => void; notes: UiNote[]; number: Map<string, number>; moved: ReadonlySet<string>; loading: boolean; onPick: (note: UiNote, row: HTMLElement) => void; onFocus: (id: string | null) => void }) {
  const unresolved = notes.filter(note => !resolved(note.status)), done = notes.filter(note => resolved(note.status))
  const panel = useRef<HTMLDivElement>(null)
  useDismiss(panel, open, () => onOpenChange(false))
  const row = (note: UiNote) => <li key={note.id}><button type="button" className="uin-row" data-resolved={resolved(note.status) || undefined} onClick={event => onPick(note, event.currentTarget)}
    onPointerEnter={() => onFocus(note.id)} onPointerLeave={() => onFocus(null)}>
    <span className="uin-number" data-status={note.status}>{number.get(note.id)}</span>
    <span className="uin-row__body" title={note.body}>{note.body}</span>
    <span className="uin-row__tag">{resolved(note.status) ? statusLabel[note.status] : moved.has(note.id) ? 'Element moved' : kindLabel(note.kind)}</span>
  </button></li>
  return <div ref={panel} className="uin-tray">
    {open && <div className="uin-tray__panel" role="dialog" aria-label="Notes on this page">
      {loading ? <p className="uin-tray__empty">Loading notes…</p> : !notes.length ? <p className="uin-tray__empty">No notes on this page yet. {notesModifierLabel}-click anything to leave one.</p> : <ul className="uin-list">{unresolved.map(row)}{done.map(row)}</ul>}
      <div className="uin-tray__foot"><Link to="/operator/notes" onClick={() => onOpenChange(false)}>All notes</Link><Button size="sm" variant="ghost" onClick={() => setUiNotesMode(false)}>Turn off</Button></div>
    </div>}
    <button type="button" className="uin-pill" aria-expanded={open} onClick={() => onOpenChange(!open)}>
      <span className="uin-pill__dot" aria-hidden="true" />Notes<span className="uin-pill__count">{loading ? '–' : unresolved.length}</span><span className="uin-pill__hint">{notesModifierLabel}-click to add</span>
    </button>
  </div>
}
function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node) && !(event.target instanceof Element && event.target.closest('.uin-panel'))) close() }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [ref, open, close])
}
