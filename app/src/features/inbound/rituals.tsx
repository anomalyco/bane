import { Link, useLocation, useSearchParams } from 'react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { basicSetup } from 'codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { autocompletion } from '@codemirror/autocomplete'
import { forceLinting, linter, lintGutter, type Diagnostic as LintDiagnostic } from '@codemirror/lint'
import { RangeSetBuilder, StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { Alert, Button, Checkbox, ConfirmDialog, DataTable, DropdownMenu, EmptyState, ErrorState, Field, IconButton, Input, PageHeader, SectionHeader, Select, Textarea, useToast, type Column } from '../../components/ui'
import { request } from '../../data/live'
import { ApiError } from '../../data/types'
import { useApiDef, useWorkspaceAccess } from '../../data/context'
import { staleAfterWrite } from '../../data/invalidation'
import { queries } from '../../data/queries'
import { useLeaveGuard } from '../../lib/leave-guard'
import { ritualTemplates } from '../../../../api/src/ritual-schema'
import { concepts, guides } from './concepts'
import { useOverview } from './overview'
import { ConceptLine } from './parts'
import { PrivateAddress } from '../../components/PrivateAddress'
import { defaultChoice, EmailPicker, TraceView, traceInput, useDryRun, useRecentMail, type EmailChoice } from './trace'
import './inbound.css'
import './receiving.css'
import { useSingleFlight } from '../../lib/single-flight'
import { actorText, changedLines, diffLines, useLiveVersion, type ChangeActor, type DiffLine, type LiveChange } from './live'
import { RitualAgentCard } from './ritual-agent'

const errorText = (e: unknown): string => e instanceof ApiError ? e.text : (e as Error).message
type Binding = { ritual: string; target: string; continue: boolean }
type Config = { rituals: { key: string; source: string }[]; attachments: Binding[]; senderLists: Record<string, string[]>; evaluateDomains: string[]; evaluateRoutes: string[] }
type Saved = { version: number; config: Config }
type Problem = { ritual?: string; line: number; column: number; endLine?: number; endColumn?: number; message: string; hint?: string }
type Check = { ok: boolean; diagnostics: Problem[]; calls: string[]; omens: string[]; questions: Record<string, string>; lists: string[] }
type Completion = { label: string; detail: string; info: string; apply?: string; type: string }

const KEY = /^[a-z0-9][a-z0-9-]{0,62}$/
const blank = () => `export default function route(email, ctx) {\n  \n}\n`
const starter = () => ritualTemplates.find(t => t.id === 'junk-newsletters')!.source()
const listsToText = (lists: Record<string, string[]>) => Object.entries(lists).map(([name, entries]) => `${name}: ${entries.join(', ')}`).join('\n')
function textToLists(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const line of text.split('\n')) {
    const [name, rest = ''] = line.split(':')
    const key = name?.trim().toLowerCase()
    if (key) out[key] = rest.split(',').map(x => x.trim().toLowerCase()).filter(Boolean)
  }
  return out
}
const domainsToText = (domains: string[]) => domains.join(', ')
// Bane's color tokens, so the editor follows the light and dark themes. Few colors on purpose.
const highlight = syntaxHighlighting(HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword, tags.operatorKeyword], color: 'var(--color-muted)', fontWeight: '600' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--color-success)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--color-info)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--color-faint)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--color-accent)' },
  { tag: [tags.variableName, tags.propertyName, tags.definition(tags.variableName), tags.punctuation, tags.bracket], color: 'var(--color-text)' },
]))
const offset = (view: EditorView, line: number, column: number) => {
  const l = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines))
  return Math.min(l.from + Math.max(0, column - 1), l.to)
}

// Lines a save made elsewhere changed, marked for a moment (inbound.css .ritual-editor__changed). Never the person's own typing.
const markLines = StateEffect.define<number[]>()
const changedLine = Decoration.line({ class: 'ritual-editor__changed' })
const changedField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    marks = marks.map(tr.changes)
    for (const effect of tr.effects) if (effect.is(markLines)) {
      const lines = new RangeSetBuilder<Decoration>()
      for (const n of [...new Set(effect.value)].sort((a, b) => a - b)) if (n >= 1 && n <= tr.state.doc.lines) { const at = tr.state.doc.line(n).from; lines.add(at, at, changedLine) }
      marks = lines.finish()
    }
    return marks
  },
  provide: field => EditorView.decorations.from(field),
})
type Flash = { lines: number[]; at: number }

/** CodeMirror with workspace completions and live diagnostics from checkRitual. `flash` marks lines a remote save
 *  changed; `relint` checks the script again (the workspace's endpoints changed). */
function Editor({ value, change, completions, check, flash, relint }: { value: string; change: (s: string) => void; completions: Completion[]; check: (source: string) => Promise<Problem[]>; flash?: Flash; relint?: number }) {
  const parent = useRef<HTMLDivElement>(null), view = useRef<EditorView | null>(null)
  const latest = useRef({ change, completions, check })
  latest.current = { change, completions, check }
  useEffect(() => {
    const v = new EditorView({
      parent: parent.current!, doc: value,
      extensions: [
        basicSetup, javascript(), highlight, EditorView.lineWrapping, lintGutter(), changedField,
        EditorView.contentAttributes.of({ 'aria-label': 'Ritual source' }),
        autocompletion({ override: [ctx => {
          const word = ctx.matchBefore(/[\w.[\]"-]+/)
          if (!word || (word.from === word.to && !ctx.explicit)) return null
          return { from: word.from, options: latest.current.completions.map(c => ({ label: c.label, type: c.type, detail: c.detail, info: c.info, ...(c.apply ? { apply: c.apply } : {}) })) }
        }] }),
        linter(async editor => (await latest.current.check(editor.state.doc.toString())).map((p): LintDiagnostic => {
          const from = offset(editor, p.line, p.column)
          return { from, to: Math.max(from + 1, offset(editor, p.endLine ?? p.line, p.endColumn ?? p.column)), severity: 'error', message: p.hint ? `${p.message} ${p.hint}` : p.message }
        }), { delay: 400 }),
        EditorView.updateListener.of(u => { if (u.docChanged) latest.current.change(u.state.doc.toString()) }),
      ],
    })
    view.current = v
    return () => { v.destroy(); view.current = null }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const v = view.current, doc = v?.state.doc.toString()
    if (!v || doc === undefined || doc === value) return
    // Replace only the part that differs, so the cursor and the scroll stay where they were.
    let from = 0, end = 0
    while (from < doc.length && from < value.length && doc[from] === value[from]) from++
    while (end < doc.length - from && end < value.length - from && doc[doc.length - 1 - end] === value[value.length - 1 - end]) end++
    v.dispatch({ changes: { from, to: doc.length - end, insert: value.slice(from, value.length - end) } })
  }, [value])
  useEffect(() => {
    const v = view.current
    if (!v || !flash?.lines.length) return
    v.dispatch({ effects: markLines.of(flash.lines) })
    const clear = setTimeout(() => view.current?.dispatch({ effects: markLines.of([]) }), 2600)
    return () => clearTimeout(clear)
  }, [flash])
  useEffect(() => { if (relint && view.current) forceLinting(view.current) }, [relint])
  return <div className="ritual-editor" ref={parent} />
}

type Incoming = Saved & { actor: ChangeActor | null }
type DiffPart = { title: string; lines: DiffLine[] }
/** Who saved a version that arrived while you were editing, to start a sentence. */
function whoSaved(actor: ChangeActor | null) {
  if (actor?.type === 'mcp') return actor.self ? 'This agent' : actor.name ?? 'Your agent'
  if (actor?.type === 'member' && actor.self) return 'You, in another tab,'
  const who = actorText(actor)
  return who[0]!.toUpperCase() + who.slice(1)
}
/** What a save made elsewhere changed, script by script: base → theirs, or yours → theirs for the script you are
 *  editing when both of you changed it. Attachments, sender lists and omen domains are named, not diffed. */
function changesBetween(base: Config, theirs: Config, key: string, yours: string | null): { parts: DiffPart[]; other: string[] } {
  const before = new Map(base.rituals.map(r => [r.key, r.source])), after = new Map(theirs.rituals.map(r => [r.key, r.source]))
  const parts: DiffPart[] = []
  for (const k of [...after.keys(), ...[...before.keys()].filter(k => !after.has(k))]) {
    const b = before.get(k), t = after.get(k)
    if (b === t) continue
    if (k === key && yours !== null && yours !== b) parts.push({ title: t === undefined ? `${k}: yours, deleted in theirs` : `${k}: yours → theirs`, lines: diffLines(yours, t ?? '') })
    else parts.push({ title: t === undefined ? `${k} (deleted)` : b === undefined ? `${k} (new)` : k, lines: diffLines(b ?? '', t ?? '') })
  }
  const other = [
    ...(JSON.stringify(base.attachments) !== JSON.stringify(theirs.attachments) ? ['where rituals run'] : []),
    ...(JSON.stringify(base.senderLists) !== JSON.stringify(theirs.senderLists) ? ['sender lists'] : []),
    ...(JSON.stringify(base.evaluateDomains) !== JSON.stringify(theirs.evaluateDomains) ? ['omen domains'] : []),
  ]
  return { parts, other }
}
/** Two lines of context around each change; longer unchanged runs fold to a gap. */
function folded(lines: DiffLine[]): (DiffLine | null)[] {
  const near = new Set<number>()
  lines.forEach((l, i) => { if (l.kind !== 'same') for (let j = i - 2; j <= i + 2; j++) near.add(j) })
  const out: (DiffLine | null)[] = []
  lines.forEach((l, i) => { if (near.has(i)) out.push(l); else if (out.at(-1) !== null) out.push(null) })
  return out
}
function DiffView({ parts }: { parts: DiffPart[] }) {
  return <div className="ritual-diff" tabIndex={0} aria-label="What changed">{parts.length ? parts.map(part => <div key={part.title}>
    <p className="ritual-diff__title">{part.title}</p>
    <pre className="ritual-diff__lines">{folded(part.lines).map((l, i) => l === null ? <span key={i} className="ritual-diff__gap">⋯</span>
      : l.kind === 'add' ? <ins key={i} className="ritual-diff__line ritual-diff__line--add"><span className="ritual-diff__sign" aria-hidden="true">+</span>{l.text || ' '}</ins>
      : l.kind === 'del' ? <del key={i} className="ritual-diff__line ritual-diff__line--del"><span className="ritual-diff__sign" aria-hidden="true">−</span>{l.text || ' '}</del>
      : <span key={i} className="ritual-diff__line"><span className="ritual-diff__sign" aria-hidden="true"> </span>{l.text || ' '}</span>)}</pre>
  </div>) : <p className="ritual-diff__title">No script changed.</p>}</div>
}

/**
 * One ritual at a time. The script, sender lists and omen domains are a draft until Save (the bar at the bottom says
 * which, and leaving asks first). Where a ritual runs is not part of the draft: attaching, detaching, reordering and
 * "Run the next one too" save at once, because a row that looks attached must be attached.
 */
export function RitualsPage() {
  const { canAdminister } = useWorkspaceAccess()
  const toast = useToast()
  const client = useQueryClient()
  const [params, setParams] = useSearchParams()
  const routeLocation = useLocation()
  const addresses = useApiDef(queries.inboundAddressOptions(), { enabled: canAdminister })
  const overview = useOverview({ limit: 1 })
  const [saved, setSaved] = useState<Saved | null>(null)
  const [loadError, setLoadError] = useState<Error | null>(null)
  const [key, setKey] = useState('')
  const [source, setSource] = useState('')
  // A new ritual's starting script, so an untouched new ritual has nothing to save or lose.
  const [origin, setOrigin] = useState('')
  const [lists, setLists] = useState('')
  const [domains, setDomains] = useState('')
  const [target, setTarget] = useState('')
  const [next, setNext] = useState(false)
  const [completions, setCompletions] = useState<Completion[]>([])
  const [check, setCheck] = useState<Check | null>(null)
  const [problems, setProblems] = useState<Problem[]>([])
  const [pending, setPending] = useState(false)
  const [binding, setBinding] = useState(false)
  const [template, setTemplate] = useState('')
  const [confirmTemplate, setConfirmTemplate] = useState<string | null>(null)
  const [confirmSwitch, setConfirmSwitch] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const recent = useRecentMail()
  const [picked, setChoice] = useState<EmailChoice | null>(null)
  const [as, setAs] = useState('')
  const [answers, setAnswers] = useState<Record<string, number>>({})
  const dry = useDryRun()
  const tryRef = useRef<HTMLElement>(null)
  // Live: saves made elsewhere (an agent over MCP, an API key, another tab) arrive while this page is open. With no
  // local edits they land in place; with local edits they wait in `incoming` until you load theirs or keep yours.
  const [remote, setRemote] = useState<LiveChange | null>(null)
  const [incoming, setIncoming] = useState<Incoming | null>(null)
  const [updatedBy, setUpdatedBy] = useState<{ version: number; actor: ChangeActor | null } | null>(null)
  const [flash, setFlash] = useState<Flash>()
  const [relint, setRelint] = useState(0)
  const [showDiff, setShowDiff] = useState(false)
  const [confirmKeep, setConfirmKeep] = useState(false)
  const listsRef = useRef<Record<string, string[]>>({})
  listsRef.current = textToLists(lists)
  const keyRef = useRef(key)
  keyRef.current = key

  /** Shows one ritual (or a new one) from a saved config; the sender lists and omen domains come with it. */
  function open(s: Saved, wanted: string | null) {
    const r = wanted === null ? undefined : s.config.rituals.find(x => x.key === wanted) ?? (wanted === '' ? undefined : s.config.rituals[0])
    const start = s.config.rituals.length ? blank() : starter()
    setKey(r?.key ?? (s.config.rituals.length ? '' : 'triage')); setSource(r?.source ?? start); setOrigin(r?.source ?? start)
    setLists(listsToText(s.config.senderLists)); setDomains(domainsToText(s.config.evaluateDomains))
    setTemplate(''); setProblems([]); dry.clear()
  }
  useEffect(() => {
    if (!canAdminister) return
    const ac = new AbortController()
    request<{ completions: Completion[] }>('/v1/rituals/typings', { signal: ac.signal }).then(t => setCompletions(t.completions)).catch(() => {})
    request<Saved>('/v1/rituals', { signal: ac.signal }).then(s => {
      // ?key= opens that ritual, ?new=1 starts one; otherwise the first.
      setSaved(s); open(s, params.get('new') ? '' : params.get('key') ?? s.config.rituals[0]?.key ?? '')
    }).catch(e => { if (!ac.signal.aborted) setLoadError(e as Error) })
    return () => ac.abort()
  }, [canAdminister]) // eslint-disable-line react-hooks/exhaustive-deps
  // #try and #attach links from Receiving land on their section once it exists.
  useEffect(() => { if (saved && routeLocation.hash) requestAnimationFrame(() => document.getElementById(routeLocation.hash.slice(1))?.scrollIntoView({ block: 'start' })) }, [saved, routeLocation.hash])

  const isSaved = !!saved?.config.rituals.some(r => r.key === key)
  // The draft: this ritual's script, the sender lists and omen domains. Attachments are always the saved ones.
  const config = useMemo<Config | null>(() => saved && ({
    ...saved.config,
    rituals: isSaved ? saved.config.rituals.map(r => r.key === key ? { key, source } : r) : [...saved.config.rituals, ...(key ? [{ key, source }] : [])],
    senderLists: textToLists(lists),
    evaluateDomains: domains.split(',').map(x => x.trim().toLowerCase()).filter(Boolean),
  }), [saved, isSaved, key, source, lists, domains])
  const scriptChanged = isSaved ? saved!.config.rituals.find(r => r.key === key)!.source !== source : source !== origin
  const listsChanged = !!saved && !!config && JSON.stringify(config.senderLists) !== JSON.stringify(saved.config.senderLists)
  const domainsChanged = !!saved && !!config && JSON.stringify(config.evaluateDomains) !== JSON.stringify(saved.config.evaluateDomains)
  const dirty = !!saved && (scriptChanged || listsChanged || domainsChanged)
  const keyValid = KEY.test(key)

  const live = useRef({ saved, dirty, key, source, isSaved })
  live.current = { saved, dirty, key, source, isSaved }
  useLiveVersion(canAdminister && !!saved, change => {
    setRemote(change)
    // A new or changed endpoint changes what a ritual can call: new completions, and the script checked again.
    if (change.endpointsMoved) request<{ completions: Completion[] }>('/v1/rituals/typings').then(t => { setCompletions(t.completions); setRelint(n => n + 1) }).catch(() => {})
  }, { endpoints: true })
  // A version newer than the one on screen (and not this page's own save, which is never in flight here) is read once,
  // and again 4 s later if that read fails.
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!remote || !saved || pending || binding || remote.version <= Math.max(saved.version, incoming?.version ?? 0)) return
    const ac = new AbortController()
    let again: ReturnType<typeof setTimeout> | undefined
    request<Saved>('/v1/rituals', { signal: ac.signal }).then(s => land(s, remote.actor)).catch(() => { if (!ac.signal.aborted) again = setTimeout(() => setRetry(n => n + 1), 4000) })
    return () => { ac.abort(); clearTimeout(again) }
  }, [remote, saved?.version, incoming?.version, pending, binding, retry]) // eslint-disable-line react-hooks/exhaustive-deps
  // Your edits are gone (Discard, or undone by hand) while their version waits: it lands as if you hadn't edited.
  useEffect(() => {
    if (!incoming || dirty || pending) return
    const { actor, ...s } = incoming
    setIncoming(null); land(s, actor)
  }, [incoming, dirty, pending]) // eslint-disable-line react-hooks/exhaustive-deps
  function land(s: Saved, actor: ChangeActor | null) {
    const { saved: base, dirty, key, source, isSaved } = live.current
    if (!base || s.version <= base.version) return
    // Only routes moved: the version is still the If-Match for saving, so take it quietly.
    if (JSON.stringify(s.config) === JSON.stringify(base.config)) { setSaved(s); return }
    if (dirty) { setIncoming({ ...s, actor }); setShowDiff(false); setConfirmKeep(false); return }
    setSaved(s); setIncoming(null); setUpdatedBy({ version: s.version, actor })
    const theirs = s.config.rituals.find(r => r.key === key)
    if (isSaved && !theirs) {
      toast(`${whoSaved(actor)} deleted ${key}`, 'info')
      open(s, s.config.rituals[0]?.key ?? '')
      setParams(current => { const p = new URLSearchParams(current); p.delete('key'); p.delete('new'); return p }, { replace: true })
      return
    }
    if (theirs) {
      if (theirs.source !== source) { setSource(theirs.source); setFlash({ lines: changedLines(source, theirs.source), at: Date.now() }) }
      setOrigin(theirs.source)
    }
    setLists(listsToText(s.config.senderLists)); setDomains(domainsToText(s.config.evaluateDomains))
  }
  /** Their version replaces your edits. */
  function loadTheirs() {
    if (!incoming) return
    const { actor, ...s } = incoming, before = source
    setSaved(s); setIncoming(null); setUpdatedBy({ version: s.version, actor })
    open(s, s.config.rituals.some(r => r.key === key) ? key : s.config.rituals[0]?.key ?? '')
    const theirs = s.config.rituals.find(r => r.key === key)
    if (theirs && theirs.source !== before) setFlash({ lines: changedLines(before, theirs.source), at: Date.now() })
  }
  // Keeping yours rebases the draft onto their version (its If-Match). What only they changed stays theirs; where
  // both of you changed the same script, list or domains, yours replaces theirs, and that is confirmed first.
  const baseScript = saved?.config.rituals.find(r => r.key === key)?.source
  const theirScript = incoming?.config.rituals.find(r => r.key === key)?.source
  const overlaps = !incoming || !saved ? [] : [
    ...(scriptChanged && theirScript !== baseScript ? [theirScript === undefined ? `their deletion of ${key}` : baseScript === undefined ? `their ritual named ${key}` : `their changes to ${key}`] : []),
    ...(listsChanged && JSON.stringify(incoming.config.senderLists) !== JSON.stringify(saved.config.senderLists) ? ['their sender lists'] : []),
    ...(domainsChanged && JSON.stringify(incoming.config.evaluateDomains) !== JSON.stringify(saved.config.evaluateDomains) ? ['their omen domains'] : []),
  ]
  function keepMine() {
    if (!incoming) return
    if (overlaps.length && !confirmKeep) { setConfirmKeep(true); return }
    const { actor: _actor, ...s } = incoming
    if (!listsChanged) setLists(listsToText(s.config.senderLists))
    if (!domainsChanged) setDomains(domainsToText(s.config.evaluateDomains))
    // Deleted in theirs: saving brings yours back as a new ritual.
    if (isSaved && !s.config.rituals.some(r => r.key === key)) setOrigin(baseScript ?? origin)
    setSaved(s); setIncoming(null); setConfirmKeep(false); setShowDiff(false)
    toast(`Your edits are on top of version ${s.version}. Save to apply them.`, 'success')
  }

  const refresh = () => void client.invalidateQueries({ predicate: query => staleAfterWrite(query.queryKey, false) }).catch(() => {})
  async function lint(text: string): Promise<Problem[]> {
    try {
      const r = await request<Check>('/v1/rituals/check', { method: 'POST', body: { source: text, key: KEY.test(keyRef.current) ? keyRef.current : 'draft', senderLists: listsRef.current } })
      setCheck(r)
      return r.diagnostics
    } catch { return [] }
  }
  /** Saves the draft (and any attachment to add with it). Resolves false when it didn't save; the reason is shown.
   *  Single flight, like the writes below: a second Save or ⌘S before the first answers would send the same version again
   *  and report a conflict next to the success; it gets the first one's result instead. */
  const save = useSingleFlight('rituals.save', async (attachments?: Binding[]): Promise<boolean> => {
    if (!saved || !config || !keyValid) return false
    if (incoming) { toast(`Version ${incoming.version} was saved while you were editing: load theirs or keep yours first.`, 'error'); return false }
    setPending(true); setProblems([])
    try {
      const s = await request<Saved>('/v1/rituals', { method: 'PUT', body: { ...config, ...(attachments ? { attachments } : {}) }, ifMatch: saved.version })
      setSaved(s); setOrigin(source); refresh()
      if (!isSaved || params.get('new')) setParams(current => { const p = new URLSearchParams(current); p.delete('new'); p.set('key', key); return p }, { replace: true })
      toast(`${key} saved · version ${s.version}`, 'success')
      return true
    } catch (e) {
      const details = (e instanceof ApiError ? e.details as Problem[] | undefined : undefined)
      if (details?.length) setProblems(details)
      toast(`Not saved: ${errorText(e)}`, 'error')
      return false
    } finally { setPending(false) }
  })
  /** Attach, detach, reorder and "Run the next one too" save at once; the draft script is left as it is. */
  const saveBindings = useSingleFlight('rituals.attachments', async (attachments: Binding[], done: string) => {
    if (!saved) return
    if (incoming) { toast(`Version ${incoming.version} was saved while you were editing: load theirs or keep yours first.`, 'error'); return }
    // A ritual that was never saved can't be attached on its own: it is saved with its first attachment.
    if (!isSaved && attachments.some(b => b.ritual === key)) { if (await save(attachments)) setTarget(''); return }
    setBinding(true)
    try {
      const s = await request<Saved>('/v1/rituals/attachments', { method: 'PUT', body: { attachments }, ifMatch: saved.version })
      setSaved(s); setTarget(''); refresh(); toast(done, 'success')
    } catch (e) { toast(errorText(e), 'error') }
    finally { setBinding(false) }
  })
  const remove = useSingleFlight('rituals.delete', async () => {
    if (!saved) return
    // Marked as a write in flight (binding), so the live view never reports this delete as someone else's.
    setBinding(true)
    try {
      const s = await request<Saved>(`/v1/rituals/scripts/${encodeURIComponent(key)}`, { method: 'DELETE', ifMatch: saved.version })
      setSaved(s); refresh(); toast(`${key} deleted`, 'success')
      open(s, s.config.rituals[0]?.key ?? '')
      setParams(current => { const p = new URLSearchParams(current); p.delete('key'); p.delete('new'); return p }, { replace: true })
    } finally { setBinding(false) }
  }, key)
  const leaveGuard = useLeaveGuard(dirty, { what: `the changes to ${key || 'this ritual'}`, save: () => save() })
  // ⌘S / Ctrl+S saves the draft from anywhere on the page, the editor included. A new ritual can be saved as it starts.
  const saveRef = useRef(save)
  saveRef.current = save
  const canSave = (dirty || (!isSaved && !!key)) && keyValid && !pending && !incoming
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (canSave) void saveRef.current() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canSave])

  // Try runs only this ritual, unsaved, as if it were attached to the address the email was sent to.
  const choice = picked ?? defaultChoice(recent.data, (addresses.data ?? []).find(a => !a.expiresAt)?.address ?? '')
  const recipient = (choice.mode === 'sample' ? choice.to : as || (choice.mode === 'recent' ? choice.to ?? '' : (choice.mime.match(/^to:\s*(?:.*<)?([^\s<>,]+@[^\s<>,]+)/im)?.[1] ?? ''))).trim().toLowerCase()
  const omens = check?.omens ?? []
  async function tryIt() {
    if (!config || !key || !recipient.includes('@')) return
    const input = traceInput(choice, choice.mode === 'sample' ? undefined : recipient)
    if (!input) return
    // The AI is never asked in a try: the answers set here stand in for it, keyed by question.
    const scores = Object.fromEntries(omens.filter(name => check?.questions[name]).map(name => [check!.questions[name]!, answers[name] ?? 0.5]))
    await dry.run({ ...input, to: [recipient], config: { ...config, attachments: [{ ritual: key, target: recipient, continue: false }] }, ...(Object.keys(scores).length ? { scores } : {}) })
    requestAnimationFrame(() => tryRef.current?.querySelector('.trace-out')?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }))
  }
  function applyTemplate(id: string) {
    const t = ritualTemplates.find(x => x.id === id)
    if (!t) return
    setSource(t.source(completions.find(c => c.detail.startsWith(`${t.needs} ·`))?.label.replace(/^endpoints\.|^endpoints\["|"\]$/g, '')))
    setTemplate(id); setConfirmTemplate(null); dry.clear()
  }
  function switchTo(value: string) {
    if (!saved) return
    open(saved, value); setConfirmSwitch(null)
    setParams(current => { const p = new URLSearchParams(current); if (value) { p.set('key', value); p.delete('new') } else { p.delete('key'); p.set('new', '1') } return p }, { replace: true })
  }

  if (!canAdminister) return <div className="stack inbound-stack"><PageHeader title="Rituals" backTo="/receiving?tab=rituals" /><EmptyState title="Only owners and admins can manage rituals" /></div>
  if (loadError) return <div className="stack inbound-stack"><PageHeader title="Rituals" backTo="/receiving?tab=rituals" /><ErrorState error={loadError} onRetry={() => location.reload()} /></div>
  const bindings = saved?.config.attachments ?? []
  const targets = (addresses.data ?? []).flatMap(a => [{ label: a.address, value: a.id }, ...a.aliases.map(alias => ({ label: alias, value: alias }))])
  const targetName = (value: string) => targets.find(t => t.value === value)?.label ?? value
  const move = (i: number, by: number) => { const a = [...bindings]; const [item] = a.splice(i, 1); a.splice(i + by, 0, item!); void saveBindings(a, `Moved ${item!.ritual} ${by < 0 ? 'up' : 'down'}`) }
  // On a phone each attachment is a card: the address, then the ritual and its place, with the row's actions in a menu.
  const bindingColumns: Column<Binding & { i: number }>[] = [
    { key: 'order', label: '#', width: 48, card: 'hide', render: b => b.i + 1 },
    { key: 'ritual', label: 'Ritual', card: 'line', render: b => <code>{b.ritual}</code>, cardRender: b => <><code>{b.ritual}</code> · runs {b.i + 1}{b.i === 0 ? 'st' : b.i === 1 ? 'nd' : 'rd'}{b.continue ? ', then the next one' : ''}</> },
    { key: 'target', label: 'Runs on mail to', card: 'title', render: b => <PrivateAddress value={targetName(b.target)} /> },
    { key: 'continue', label: 'After it acts', width: 190, card: 'hide', render: b => <Checkbox checked={b.continue} disabled={binding} onCheckedChange={v => void saveBindings(bindings.map((x, i) => i === b.i ? { ...x, continue: v } : x), v ? `${b.ritual} now lets the next ritual run` : `${b.ritual} now stops the next ritual`)} label="Run the next one too" /> },
    { key: 'actions', label: '', width: 132, align: 'right', card: 'end', cardRender: b => <DropdownMenu label={`Actions for ${b.ritual}`} title={<>{b.ritual} on <PrivateAddress value={targetName(b.target)} /></>} items={[
      { label: b.continue ? 'Stop the next one after it acts' : 'Run the next one too', disabled: binding, onSelect: () => void saveBindings(bindings.map((x, i) => i === b.i ? { ...x, continue: !b.continue } : x), b.continue ? `${b.ritual} now stops the next ritual` : `${b.ritual} now lets the next ritual run`) },
      ...(b.i ? [{ label: 'Move up', disabled: binding, onSelect: () => move(b.i, -1) }] : []),
      ...(b.i < bindings.length - 1 ? [{ label: 'Move down', disabled: binding, onSelect: () => move(b.i, 1) }] : []),
      { label: 'Detach', destructive: true, disabled: binding, onSelect: () => void saveBindings(bindings.filter((_, i) => i !== b.i), `Detached ${b.ritual}`) },
    ]} />, render: b => <span className="ritual-row-actions">
      <IconButton label="Move up" disabled={!b.i || binding} onClick={() => move(b.i, -1)}>↑</IconButton>
      <IconButton label="Move down" disabled={b.i === bindings.length - 1 || binding} onClick={() => move(b.i, 1)}>↓</IconButton>
      <IconButton label={`Detach ${b.ritual}`} disabled={binding} onClick={() => void saveBindings(bindings.filter((_, i) => i !== b.i), `Detached ${b.ritual}`)}>×</IconButton>
    </span> },
  ]
  const recipients = (addresses.data ?? []).filter(a => !a.expiresAt).map(a => a.address)
  const attached = bindings.some(b => b.target === target && b.ritual === key)
  const remoteStatus = !pending && saved && isSaved && !dirty && updatedBy?.version === saved.version ? `Updated by ${actorText(updatedBy.actor)} · version ${saved.version}` : null
  const status = pending ? 'Saving…' : !saved ? '' : remoteStatus ?? (!isSaved ? `${key || 'This new ritual'} isn’t saved yet` : dirty ? 'Unsaved changes' : `All changes saved · version ${saved.version}`)
  // The prompts name this ritual's first address, or else the workspace's first.
  const agentAddress = (() => { const b = bindings.find(x => x.ritual === key); return b ? targetName(b.target) : recipients[0] ?? null })()
  const changes = incoming && saved ? changesBetween(saved.config, incoming.config, key, scriptChanged ? source : null) : null
  return <div className="stack inbound-stack ritual-page">
    <PageHeader title="Rituals" backTo="/receiving?tab=rituals" actions={<>
      <Link className="ui-button ui-button--secondary ui-button--md" to="/receiving?tab=endpoints">Endpoints</Link>
      <Link className="ui-button ui-button--secondary ui-button--md" to="/receiving/trace">Trace</Link>
      {/* Always in the header, so the buttons beside it never move; hidden until there's a saved ritual to delete. */}
      <Button variant="danger" className="ritual-delete" data-hidden={!isSaved || undefined} disabled={!isSaved} onClick={() => setConfirmDelete(true)}>Delete</Button>
    </>} />
    <ConceptLine line={concepts.rituals.line} example={concepts.rituals.example} guide={guides.rituals} />
    <RitualAgentCard ritual={keyValid ? key : ''} address={agentAddress && agentAddress.includes('@') ? agentAddress : null} />
    {problems.length > 0 && <Alert tone="danger" title="Not saved. Fix these first:"><ul className="ritual-problems">{problems.map((p, i) => <li key={i}><code>{p.ritual ? `${p.ritual}:` : ''}{p.line}:{p.column}</code> {p.message}{p.hint ? <span className="muted"> {p.hint}</span> : null}</li>)}</ul></Alert>}
    {saved && <>
      <div className="ritual-pickers">
        <Field label="Ritual">
          <Select value={isSaved ? key : ''} onValueChange={v => { if (v === (isSaved ? key : '')) return; if (scriptChanged) setConfirmSwitch(v); else switchTo(v) }}
            options={[...saved.config.rituals.map(r => ({ label: r.key, value: r.key })), { label: 'New ritual', value: '' }]} />
        </Field>
        <Field label="Key" error={key && !keyValid ? 'Use lowercase letters, digits and hyphens, like refund-triage.' : undefined} hint={isSaved ? 'Renaming saves it as a new ritual; this one stays until you delete it.' : 'How addresses and the API refer to it. Lowercase letters, digits and hyphens.'}>
          <Input value={key} onChange={e => setKey(e.target.value.toLowerCase().replace(/[\s_]+/g, '-'))} placeholder="triage" aria-invalid={(!!key && !keyValid) || undefined} />
        </Field>
        <Field label="Start from a template" hint={template ? `Applied “${ritualTemplates.find(t => t.id === template)?.name}”. Not saved until you save.` : 'Replaces the script below.'}>
          <Select value={template} onValueChange={id => { if (!id) return; if (source.trim() && source !== blank() && source !== origin) setConfirmTemplate(id); else applyTemplate(id) }}
            options={[{ label: 'Choose…', value: '' }, ...ritualTemplates.map(t => ({ label: t.name, value: t.id }))]} />
        </Field>
      </div>
      <Editor value={source} change={value => { setSource(value); if (template && value !== source) setTemplate('') }} completions={completions} check={lint} flash={flash} relint={relint} />
      <p className={check && !check.ok ? 'ritual-status ritual-error' : 'ritual-status muted'}>{check === null ? 'Checking…' : check.ok
        ? <>No problems{check.calls.length ? <> · calls <code>{check.calls.join(', ')}</code></> : null}{check.omens.length ? <> · omens <code>{check.omens.join(', ')}</code></> : null}</>
        : (p => <>Line {p.line}, column {p.column}: {p.message}{p.hint ? ` ${p.hint}` : ''}{check.diagnostics.length > 1 ? ` (+${check.diagnostics.length - 1} more)` : ''}</>)(check.diagnostics[0]!)}</p>

      {/* The sections below appear with the first check (it names the omens to answer) and recent mail, so nothing shifts in later.
          Gated on recent mail's first answer (isFetched), not data or error: the picker retries a failed read when it mounts, which
          clears the error, so a gate on the error unmounted it and remounted it in a loop of requests. */}
      {check !== null && recent.isFetched && <>
      <section ref={tryRef} id="try" className="section section--bordered stack ritual-try" aria-labelledby="ritual-try">
        <SectionHeader title={<span id="ritual-try">Try it on an email</span>} />
        <ConceptLine line={`Runs ${key || 'this ritual'} as written, unsaved, as if it were attached to the address the email was sent to. Nothing is sent or saved, and Bane’s AI isn’t asked: you set each omen’s answer here.`} />
        <EmailPicker value={choice} onChange={next => { setChoice(next); dry.clear() }} addresses={recipients} />
        <div className="ritual-try__options">
          {choice.mode !== 'sample' && <Field label="As mail to" htmlFor="ritual-try-to" hint="The address the ritual is attached to for this try."><Input id="ritual-try-to" list="trace-addresses" value={as} onChange={e => { setAs(e.target.value); dry.clear() }} placeholder={recipient || recipients[0] || 'support@acme.com'} autoComplete="off" /></Field>}
          {omens.map(name => <Field key={name} label={<>If omen <code>{name}</code> answers <strong className="ritual-try__score">{(answers[name] ?? 0.5).toFixed(2)}</strong></>} hint={check?.questions[name]}>
            <input className="ritual-try__range" type="range" min={0} max={1} step={0.05} value={answers[name] ?? 0.5} onChange={e => { setAnswers({ ...answers, [name]: Number(e.target.value) }); dry.clear() }} aria-label={`Answer for ${name}`} />
          </Field>)}
        </div>
        <div className="cluster"><Button variant="primary" loading={dry.pending} disabled={!key || !recipient.includes('@') || (check !== null && !check.ok)} onClick={() => void tryIt()}>Run {key || 'ritual'}</Button>
          {check && !check.ok && <span className="ritual-error">Fix the problem above first.</span>}</div>
        <div className="trace-out">{dry.error ? <Alert tone="danger">{dry.error}</Alert> : dry.result && <TraceView result={dry.result} sources={{ [key]: source }} overview={overview.data} inboxes={new Map((addresses.data ?? []).map(a => [a.id, a.address]))} runId={dry.runId} />}</div>
      </section>

      <section id="attach" className="section section--bordered stack" aria-labelledby="ritual-attach">
        <SectionHeader title={<span id="ritual-attach">Runs on</span>} />
        <ConceptLine line="Attach a ritual to an address or alias; changes here save at once. Up to three run in order; the first that acts stops the rest unless “Run the next one too” is on." />
        <DataTable columns={bindingColumns} rows={bindings.map((b, i) => ({ ...b, i }))} rowKey={b => `${b.target}/${b.ritual}`}
          empty={<EmptyState title="Not attached yet" description="Pick an address below. A ritual only runs on mail to the addresses it’s attached to." />} />
        <div className="ritual-attach">
          <Field label={`Attach ${key || 'this ritual'} to`} hint={!isSaved && key ? `Saves ${key} with it.` : undefined}><Select value={target} onValueChange={setTarget} options={[{ label: 'Choose an address', value: '' }, ...targets]} /></Field>
          <Checkbox checked={next} onCheckedChange={setNext} label="Run the next one too" />
          <Button loading={binding || (pending && !isSaved)} disabled={!target || !keyValid || attached || binding || pending} onClick={() => void saveBindings([...bindings, { ritual: key, target, continue: next }], `Attached ${key} to ${targetName(target)}`)}>{isSaved ? 'Attach' : 'Save and attach'}</Button>
        </div>
        {attached && <p className="muted ritual-attach__note">{key} already runs on {targetName(target)}.</p>}
      </section>

      <section className="section section--bordered stack ritual-settings" aria-label="Sender lists and omens">
        <Field label="Sender lists" hint={<>Named lists of senders, one per line: <code>vip: ceo@example.com, @partner.example</code>. Use with <code>lists.has("vip", email.from.address)</code>.</>}>
          <Textarea rows={3} value={lists} onChange={e => setLists(e.target.value)} spellCheck={false} />
        </Field>
        <Field label="Omens can read mail at" hint={<>{concepts.omens.line} Bane’s AI only reads mail at the receiving hosts listed here, separated by commas; everywhere else an omen gives its default answer. <Link to={guides.rituals}>How omens work</Link></>}>
          <Input value={domains} onChange={e => setDomains(e.target.value)} placeholder={(overview.data?.domains ?? []).find(d => d.status === 'active')?.name ?? 'reply.example.com'} />
        </Field>
      </section>

      {/* Always on screen while editing, so the save state and Save are never scrolled away. It arrives with the
          sections above, in its final place. */}
      <div className="ritual-savebar" data-dirty={dirty || !isSaved || undefined} data-remote={remoteStatus ? true : undefined} role="status" aria-live="polite">
        {/* Saved elsewhere while you were editing: above the bar, over the page, so nothing on it moves. */}
        {incoming && changes && <div className="ritual-incoming" role="group" aria-label={`Version ${incoming.version} saved elsewhere`}>
          <p className="ritual-incoming__title"><strong>{whoSaved(incoming.actor)} saved version {incoming.version}</strong> while you were editing.</p>
          <p className="ritual-incoming__detail muted">{(() => {
            // What you both changed, then what only they changed (theirs stays either way).
            const both = overlaps.map(o => o.replace(/^their (deletion of |changes to |ritual named )?/, ''))
            const only = [...changes.parts.map(p => p.title.split(/[: ]/)[0]!), ...changes.other].filter(name => !both.includes(name))
            return <>{both.length ? <>You both changed {both.join(' and ')}.</> : <>Your edits don’t overlap with it.</>}{only.length ? <> It also changed {only.join(', ')}, which stays as they saved it.</> : null}</>
          })()}</p>
          {showDiff && <DiffView parts={changes.parts} />}
          {confirmKeep && <p className="ritual-incoming__warn">Saving yours replaces {overlaps.join(' and ')}.</p>}
          <div className="ritual-incoming__actions">
            <Button size="sm" variant="ghost" aria-expanded={showDiff} onClick={() => setShowDiff(!showDiff)}>{showDiff ? 'Hide diff' : 'View diff'}</Button>
            <Button size="sm" onClick={loadTheirs}>Load theirs</Button>
            {confirmKeep && <Button size="sm" variant="ghost" onClick={() => setConfirmKeep(false)}>Cancel</Button>}
            <Button size="sm" variant={confirmKeep ? 'danger' : 'primary'} onClick={keepMine}>{confirmKeep ? 'Keep mine anyway' : 'Keep mine'}</Button>
          </div>
        </div>}
        <span className="ritual-savebar__state"><span className="ritual-savebar__dot" aria-hidden="true" /><span key={remoteStatus ?? 'local'} className={remoteStatus ? 'ritual-savebar__text ritual-savebar__text--remote' : 'ritual-savebar__text'}>{status}</span></span>
        <div className="cluster">
          <Button variant="ghost" className="ritual-savebar__discard" data-hidden={!dirty || undefined} disabled={!dirty || pending} onClick={() => open(saved, isSaved ? key : '')}>Discard</Button>
          <Button variant="primary" loading={pending} disabled={!canSave} onClick={() => void save()}>Save<kbd className="ritual-savebar__kbd" aria-hidden="true">⌘S</kbd></Button>
        </div>
      </div>
      </>}
    </>}
    {leaveGuard}
    <ConfirmDialog open={confirmTemplate !== null} onOpenChange={value => { if (!value) setConfirmTemplate(null) }} title={`Replace the script with “${ritualTemplates.find(t => t.id === confirmTemplate)?.name ?? 'this template'}”?`}
      description="The script you’ve written is replaced. Nothing is saved until you save, and Discard brings back the saved version." confirmLabel="Replace script" onConfirm={() => { if (confirmTemplate) applyTemplate(confirmTemplate) }} />
    <ConfirmDialog open={confirmSwitch !== null} onOpenChange={value => { if (!value) setConfirmSwitch(null) }} title={`Discard the changes to ${key || 'this ritual'}?`}
      description="You haven’t saved them. Save first to keep them." confirmLabel="Discard changes" danger onConfirm={() => { if (confirmSwitch !== null) switchTo(confirmSwitch) }} />
    <ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} title={`Delete ${key}?`} description={`It stops running on every address it’s attached to${bindings.some(b => b.ritual === key) ? ` (${bindings.filter(b => b.ritual === key).length})` : ''}. Earlier versions stay restorable over the API.`}
      confirmLabel="Delete ritual" danger onConfirm={remove} />
  </div>
}
