import { Link } from 'react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { basicSetup } from 'codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { autocompletion } from '@codemirror/autocomplete'
import { linter, lintGutter, type Diagnostic as LintDiagnostic } from '@codemirror/lint'
import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { Alert, Button, Checkbox, DataTable, EmptyState, ErrorState, Field, IconButton, Input, PageHeader, SectionHeader, Select, StatusBadge, Tabs, Textarea, type Column } from '../../components/ui'
import { request } from '../../data/live'
import { ApiError } from '../../data/types'
const errorText = (e: unknown): string => e instanceof ApiError ? e.text : (e as Error).message
import { useApiDef, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import { ritualTemplates } from '../../../../api/src/ritual-schema'
import './inbound.css'

type Binding = { ritual: string; target: string; continue: boolean }
type Config = { rituals: { key: string; source: string }[]; attachments: Binding[]; senderLists: Record<string, string[]>; evaluateDomains: string[]; evaluateRoutes: string[] }
type Saved = { version: number; config: Config }
type Problem = { ritual?: string; line: number; column: number; endLine?: number; endColumn?: number; message: string; hint?: string }
type Check = { ok: boolean; diagnostics: Problem[]; calls: string[]; omens: string[]; questions: Record<string, string>; lists: string[] }
type Completion = { label: string; detail: string; info: string; apply?: string; type: string }
type Intent = { op: string; ref?: string; body?: unknown; value?: string }
type TraceRow = { recipient: string; key: string; steps: number; lines: number[]; scores: Record<string, number | boolean>; error: string | null; actions: Intent[] }
type Recipient = { address: string; inboxes?: string[]; webhooks?: string[]; labels?: string[]; junk?: boolean; dropped?: boolean; warnings?: string[]; actions?: Record<string, unknown[]> }
type DryRun = { version: number; steps: number; trace: TraceRow[]; recipients: Recipient[] }

const blank = () => `export default function route(email, ctx) {\n  \n}\n`
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
const actionText = (a: Intent) => a.ref?.startsWith('inbox:') ? `inbox.deliver("${a.ref.slice(6)}")`
  : a.ref ? `endpoints.${a.ref.slice(9)}(${a.body === undefined ? '' : JSON.stringify(a.body)})`
  : `${a.op}(${a.value === undefined ? '' : JSON.stringify(a.value)})`

/** CodeMirror with workspace completions and live diagnostics from checkRitual. */
function Editor({ value, change, completions, check }: { value: string; change: (s: string) => void; completions: Completion[]; check: (source: string) => Promise<Problem[]> }) {
  const parent = useRef<HTMLDivElement>(null), view = useRef<EditorView | null>(null)
  const latest = useRef({ change, completions, check })
  latest.current = { change, completions, check }
  useEffect(() => {
    const v = new EditorView({
      parent: parent.current!, doc: value,
      extensions: [
        basicSetup, javascript(), highlight, EditorView.lineWrapping, lintGutter(),
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
    const v = view.current
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } })
  }, [value])
  return <div className="ritual-editor" ref={parent} />
}

export function RitualsPage() {
  const { canAdminister } = useWorkspaceAccess()
  const addresses = useApiDef(queries.inboundAddressOptions(), { enabled: canAdminister })
  const [saved, setSaved] = useState<Saved | null>(null)
  const [loadError, setLoadError] = useState<Error | null>(null)
  const [key, setKey] = useState('')
  const [source, setSource] = useState('')
  const [bindings, setBindings] = useState<Binding[]>([])
  const [lists, setLists] = useState('')
  const [domains, setDomains] = useState('')
  const [target, setTarget] = useState('')
  const [next, setNext] = useState(false)
  const [completions, setCompletions] = useState<Completion[]>([])
  const [check, setCheck] = useState<Check | null>(null)
  const [problems, setProblems] = useState<Problem[]>([])
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)
  const [pending, setPending] = useState(false)
  const [mode, setMode] = useState<'mime' | 'messageId'>('mime')
  const [sample, setSample] = useState('')
  const [result, setResult] = useState<DryRun | null>(null)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const listsRef = useRef<Record<string, string[]>>({})
  listsRef.current = textToLists(lists)
  const keyRef = useRef(key)
  keyRef.current = key

  useEffect(() => {
    if (!canAdminister) return
    const ac = new AbortController()
    request<{ completions: Completion[] }>('/v1/rituals/typings', { signal: ac.signal }).then(t => setCompletions(t.completions)).catch(() => {})
    request<Saved>('/v1/rituals', { signal: ac.signal }).then(s => {
      setSaved(s); setBindings(s.config.attachments); setLists(listsToText(s.config.senderLists)); setDomains(s.config.evaluateDomains.join(', '))
      const first = s.config.rituals[0]
      setKey(first?.key ?? 'triage'); setSource(first?.source ?? ritualTemplates.find(t => t.id === 'junk-newsletters')!.source())
    }).catch(e => { if (!ac.signal.aborted) setLoadError(e as Error) })
    return () => ac.abort()
  }, [canAdminister])

  // The edited ritual keeps its place, so an untouched page is not "changed".
  const config = useMemo<Config | null>(() => saved && ({
    ...saved.config,
    rituals: saved.config.rituals.some(r => r.key === key) ? saved.config.rituals.map(r => r.key === key ? { key, source } : r) : [...saved.config.rituals, ...(key ? [{ key, source }] : [])],
    attachments: bindings,
    senderLists: textToLists(lists),
    evaluateDomains: domains.split(',').map(x => x.trim().toLowerCase()).filter(Boolean),
  }), [saved, key, source, bindings, lists, domains])
  const dirty = !!saved && !!config && JSON.stringify(config) !== JSON.stringify(saved.config)

  async function lint(text: string): Promise<Problem[]> {
    try {
      const r = await request<Check>('/v1/rituals/check', { method: 'POST', body: { source: text, key: /^[a-z0-9][a-z0-9-]{0,62}$/.test(keyRef.current) ? keyRef.current : 'draft', senderLists: listsRef.current } })
      setCheck(r)
      return r.diagnostics
    } catch { return [] }
  }
  async function save() {
    if (!saved || !config) return
    setPending(true); setNotice(null); setProblems([])
    try {
      const s = await request<Saved>('/v1/rituals', { method: 'PUT', body: config, ifMatch: saved.version })
      setSaved(s); setNotice({ tone: 'success', text: `Saved as version ${s.version}.` })
    } catch (e) {
      const details = (e instanceof ApiError ? e.details as Problem[] | undefined : undefined)
      if (details?.length) setProblems(details)
      setNotice({ tone: 'danger', text: errorText(e) })
    } finally { setPending(false) }
  }
  async function dryRun() {
    if (!config) return
    setPending(true); setResult(null); setNotice(null)
    // Dry runs never ask Jev: the answers typed here stand in for it, keyed by question.
    const scores = Object.fromEntries(Object.entries(answers).filter(([name, v]) => v.trim() !== '' && check?.questions[name]).map(([name, v]) => [check!.questions[name]!, Math.min(1, Math.max(0, Number(v) || 0))]))
    try { setResult(await request<DryRun>('/v1/rituals/test', { method: 'POST', body: { config, [mode]: sample, ...(Object.keys(scores).length ? { scores } : {}) } })) }
    catch (e) { setNotice({ tone: 'danger', text: errorText(e) }); setProblems((e instanceof ApiError ? e.details as Problem[] | undefined : undefined) ?? []) }
    finally { setPending(false) }
  }

  if (!canAdminister) return <div className="stack inbound-stack"><PageHeader title="Rituals" backTo="/receiving" /><EmptyState title="Only owners and admins can manage rituals" /></div>
  if (loadError) return <div className="stack inbound-stack"><PageHeader title="Rituals" backTo="/receiving" /><ErrorState error={loadError} onRetry={() => location.reload()} /></div>
  const targets = (addresses.data ?? []).flatMap(a => [{ label: `${a.address} (inbox)`, value: a.id }, ...a.aliases.map(alias => ({ label: alias, value: alias }))])
  const targetName = (value: string) => targets.find(t => t.value === value)?.label.replace(/ \(inbox\)$/, '') ?? value
  const move = (i: number, by: number) => { const a = [...bindings]; const [item] = a.splice(i, 1); a.splice(i + by, 0, item!); setBindings(a) }
  const bindingColumns: Column<Binding & { i: number }>[] = [
    { key: 'order', label: '#', width: 48, render: b => b.i + 1 },
    { key: 'ritual', label: 'Ritual', render: b => <code>{b.ritual}</code> },
    { key: 'target', label: 'Runs on mail to', render: b => targetName(b.target) },
    { key: 'continue', label: 'After it acts', width: 190, render: b => <Checkbox checked={b.continue} onCheckedChange={v => setBindings(bindings.map((x, i) => i === b.i ? { ...x, continue: v } : x))} label="Run the next one too" /> },
    { key: 'actions', label: '', width: 132, align: 'right', render: b => <span className="ritual-row-actions">
      <IconButton label="Move up" disabled={!b.i} onClick={() => move(b.i, -1)}>↑</IconButton>
      <IconButton label="Move down" disabled={b.i === bindings.length - 1} onClick={() => move(b.i, 1)}>↓</IconButton>
      <IconButton label="Detach" onClick={() => setBindings(bindings.filter((_, i) => i !== b.i))}>×</IconButton>
    </span> },
  ]
  const traceColumns: Column<TraceRow>[] = [
    { key: 'recipient', label: 'Recipient', render: r => r.recipient },
    { key: 'ritual', label: 'Ritual', width: 140, render: r => <code>{r.key}</code> },
    { key: 'scores', label: 'Omens', width: 160, render: r => Object.entries(r.scores).map(([k, v]) => `${k} ${typeof v === 'number' ? v.toFixed(2) : v}`).join(' · ') || '—' },
    { key: 'actions', label: 'Actions', render: r => r.error ? <span className="ritual-error">{r.error}</span> : r.actions.length ? <code className="ritual-actions">{r.actions.map(actionText).join('\n')}</code> : <span className="muted">None</span> },
    { key: 'steps', label: 'Steps', width: 80, align: 'right', render: r => r.steps },
  ]
  const outcome = (r: Recipient) => r.dropped ? 'Dropped' : r.junk ? 'Junk' : 'Delivered'
  return <div className="stack inbound-stack">
    <PageHeader title="Rituals" backTo="/receiving" actions={<>
      <Link className="ui-button ui-button--secondary ui-button--md" to="/receiving/endpoints">Endpoints</Link>
      <Button variant="primary" disabled={pending || !dirty || !key} onClick={() => void save()}>Save</Button>
    </>} />
    <p className="muted">Scripts that run when mail reaches an inbox or address.</p>
    {notice && <Alert tone={notice.tone} onDismiss={() => setNotice(null)}>{notice.text}</Alert>}
    {problems.length > 0 && <ul className="ritual-problems">{problems.map((p, i) => <li key={i}><code>{p.ritual ? `${p.ritual}:` : ''}{p.line}:{p.column}</code> {p.message}{p.hint ? <span className="muted"> {p.hint}</span> : null}</li>)}</ul>}
    {saved && <>
      <div className="ritual-pickers">
        <Field label="Ritual">
          <Select value={saved.config.rituals.some(r => r.key === key) ? key : ''} onValueChange={v => {
            const r = saved.config.rituals.find(x => x.key === v)
            setKey(r?.key ?? ''); setSource(r?.source ?? blank()); setResult(null)
          }} options={[...saved.config.rituals.map(r => ({ label: r.key, value: r.key })), { label: 'New ritual', value: '' }]} />
        </Field>
        <Field label="Key"><Input value={key} onChange={e => setKey(e.target.value.toLowerCase())} placeholder="triage" /></Field>
        <Field label="Start from a template">
          <Select value="" onValueChange={id => { const t = ritualTemplates.find(x => x.id === id); if (t) setSource(t.source(completions.find(c => c.detail.startsWith(`${t.needs} ·`))?.label.replace(/^endpoints\.|^endpoints\["|"\]$/g, ''))) }}
            options={[{ label: 'Choose…', value: '' }, ...ritualTemplates.map(t => ({ label: t.name, value: t.id }))]} />
        </Field>
      </div>
      <Editor value={source} change={setSource} completions={completions} check={lint} />
      <p className={check && !check.ok ? 'ritual-status ritual-error' : 'ritual-status muted'}>{check === null ? 'Checking…' : check.ok
        ? <>No problems{check.calls.length ? <> · calls <code>{check.calls.join(', ')}</code></> : null}{check.omens.length ? <> · omens <code>{check.omens.join(', ')}</code></> : null}</>
        : (p => <>Line {p.line}, column {p.column}: {p.message}{p.hint ? ` ${p.hint}` : ''}{check.diagnostics.length > 1 ? ` (+${check.diagnostics.length - 1} more)` : ''}</>)(check.diagnostics[0]!)}</p>

      <SectionHeader title="Runs on" />
      <DataTable columns={bindingColumns} rows={bindings.map((b, i) => ({ ...b, i }))} rowKey={b => `${b.target}/${b.ritual}`}
        empty={<EmptyState title="Not attached yet" description="Pick an inbox or address below. The first ritual that acts stops the chain unless “Run the next one too” is on." />} />
      <div className="ritual-attach">
        <Field label={`Attach ${key || 'this ritual'} to`}><Select value={target} onValueChange={setTarget} options={[{ label: 'Choose an inbox or address', value: '' }, ...targets]} /></Field>
        <Checkbox checked={next} onCheckedChange={setNext} label="Run the next one too" />
        <Button disabled={!target || !key || bindings.some(b => b.target === target && b.ritual === key)} onClick={() => { setBindings([...bindings, { ritual: key, target, continue: next }]); setTarget('') }}>Attach</Button>
      </div>

      <div className="ritual-settings">
        <Field label="Sender lists" hint={<>One per line: <code>vip: ceo@example.com, @partner.example</code>. Use with <code>lists.has("vip", email.from.address)</code>.</>}>
          <Textarea rows={3} value={lists} onChange={e => setLists(e.target.value)} spellCheck={false} />
        </Field>
        <Field label="Domains that may ask omens" hint="Receiving hosts whose mail Jev may read to answer omen questions. Elsewhere omens answer 0 or false.">
          <Input value={domains} onChange={e => setDomains(e.target.value)} placeholder="reply.example.com" />
        </Field>
      </div>

      <SectionHeader title="Dry run" />
      <p className="muted">Runs the unsaved rituals on an email. Nothing is delivered, saved or sent to Jev.</p>
      <Tabs label="Email source" value={mode} onValueChange={v => { setMode(v as typeof mode); setSample(''); setResult(null) }} items={[{ value: 'mime', label: 'Paste an email' }, { value: 'messageId', label: 'Stored message' }]} />
      {mode === 'mime'
        ? <Textarea aria-label="Email to test" rows={6} spellCheck={false} value={sample} onChange={e => setSample(e.target.value)} placeholder={'To: support@example.com\nFrom: customer@example.net\nSubject: Refund for order 4821\n\nHi, I would like a refund.'} />
        : <Input aria-label="Stored message ID" value={sample} onChange={e => setSample(e.target.value)} placeholder="msg_…" />}
      {!!check?.omens.length && <div className="ritual-answers">{check.omens.map(name => <Field key={name} label={<>If <code>{name}</code> answers</>} hint={check.questions[name]}>
        <Input inputMode="decimal" placeholder="0–1" value={answers[name] ?? ''} onChange={e => setAnswers({ ...answers, [name]: e.target.value })} />
      </Field>)}</div>}
      <div><Button disabled={pending || !sample.trim()} onClick={() => void dryRun()}>Run</Button></div>
      {result && <section aria-live="polite" className="stack">
        <DataTable columns={traceColumns} rows={result.trace} rowKey={r => `${r.recipient}/${r.key}`} empty={<EmptyState title="No ritual ran" description="No attached ritual matches these recipients." />} />
        <ul className="ritual-outcomes">{result.recipients.map(r => <li key={r.address}>
          <StatusBadge status={outcome(r)} tone={r.dropped ? 'danger' : r.junk ? 'warning' : 'success'} /> <span>{r.address}</span>
          {!r.dropped && <span className="muted"> · {r.inboxes?.length ?? 0} inbox{r.inboxes?.length === 1 ? '' : 'es'}, {Object.values(r.actions ?? {}).flat().length} endpoint call{Object.values(r.actions ?? {}).flat().length === 1 ? '' : 's'}</span>}
          {r.labels?.length ? <span className="muted"> · labels {r.labels.join(', ')}</span> : null}
          {r.warnings?.map(w => <span key={w} className="ritual-error"> · {w}</span>)}
        </li>)}</ul>
        <p className="muted">{result.steps} steps in total, on version {result.version}.</p>
      </section>}
    </>}
  </div>
}
