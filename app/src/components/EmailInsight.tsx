import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import DOMPurify from 'dompurify'
import { Check, ChevronRight, ExternalLink } from 'lucide-react'
import { useApiQuery } from '../data/context'
import type { PreviewClient, PreviewIssue, SendabilityCategory, SendabilityFinding, SendabilityReport, SenderGrade } from '../data/types'
import { usePhone } from '../lib/media'
import { AddressText } from './AddressText'
import { Alert, Button, ErrorText, SectionHeader, Skeleton, SkeletonText, Tabs } from './ui'
import './email-insight.css'

// One surface for "will this email land and look right": the sendability check (POST /v1/emails/check) beside the
// per-client emulation (POST /v1/emails/preview). Used by a sent email's detail and by the campaign editor's draft.
export type InsightSource = { kind: 'email'; id: string; html: boolean } | { kind: 'campaign'; id: string; revision: number }
type Theme = 'light' | 'dark'
type Device = 'desktop' | 'mobile'

/** Below this the campaign editor and review warn before sending (grade C starts at 70). Never blocking. */
export const LOW_SENDABILITY = 70
const sourceKey = (source: InsightSource | null) => !source ? ['none'] : source.kind === 'email' ? ['email', source.id] : ['campaign', source.id, source.revision]
// A new revision of the same campaign keeps the last result up while it is checked again.
const sameSubject = (source: InsightSource | null) => (previous: readonly unknown[]) => Boolean(source) && previous[1] === source!.kind && previous[2] === source!.id

export function useSendability(source: InsightSource | null) {
  return useApiQuery(['email-check', ...sourceKey(source)], (api, signal) => api.emails.check(source!.kind === 'email' ? { emailId: source!.id } : { campaignId: source!.id }, signal), { enabled: Boolean(source), keepPrevious: sameSubject(source) })
}

const severityRank = { error: 0, warning: 1, info: 2 } as const
const severityTone = { error: 'danger', warning: 'warning', info: 'neutral' } as const
const severityLabel = { error: 'Error', warning: 'Warning', info: 'Note' } as const
const categoryLabel: Record<SendabilityCategory, string> = { authentication: 'Authentication', content: 'Content', headers: 'Headers', size: 'Size', rendering: 'Rendering', reputation: 'Reputation' }
const gradeFor = (score: number): SenderGrade => score >= 95 ? 'A+' : score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F'
const gradeKey = (grade: SenderGrade) => grade === 'A+' ? 'aplus' : grade.toLowerCase()
// Errors, then warnings, then notes; within each, the categories that weigh most in this report's score first.
const ranked = (report: SendabilityReport, findings = report.findings) => {
  const weight = (category: SendabilityCategory) => report.categories.find(item => item.id === category)?.weight ?? 0
  return [...findings].sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || weight(b.category) - weight(a.category))
}
/** The fixes to make first. */
export const topFixes = (report: SendabilityReport, count = 3) => ranked(report).filter(finding => finding.severity !== 'info').slice(0, count)

// The rendering rule summarises the same compatibility lint that "How it renders" lists client by client, so it lives
// there; the form and script rules already say what the preview's lint would repeat about those elements.
const PREVIEW_RULES = new Set(['client-support'])
const COVERED: Record<string, RegExp> = { form: /^html-(?:form|input|button|select|textarea|option|label|fieldset|legend)\b/, script: /^html-script$/ }

type Tab = { value: string; label: string; clients?: Record<Device, PreviewClient>; captions?: Record<Device, string> }
const TABS: Tab[] = [
  { value: 'gmail', label: 'Gmail', clients: { desktop: 'gmail-web', mobile: 'gmail-ios' }, captions: { desktop: 'Gmail on the web', mobile: 'Gmail app on iPhone' } },
  { value: 'apple', label: 'Apple Mail', clients: { desktop: 'apple-mail-macos', mobile: 'apple-mail-ios' }, captions: { desktop: 'Apple Mail on Mac', mobile: 'Apple Mail on iPhone' } },
  { value: 'outlook', label: 'Outlook', clients: { desktop: 'outlook-web', mobile: 'outlook-web' }, captions: { desktop: 'Outlook.com and new Outlook', mobile: 'Outlook.com and new Outlook, phone width' } },
  { value: 'yahoo', label: 'Yahoo', clients: { desktop: 'yahoo-web', mobile: 'yahoo-web' }, captions: { desktop: 'Yahoo and AOL Mail on the web', mobile: 'Yahoo and AOL Mail, phone width' } },
  { value: 'samsung', label: 'Samsung', clients: { desktop: 'samsung-email', mobile: 'samsung-email' }, captions: { desktop: 'Samsung Email, desktop width', mobile: 'Samsung Email on Android' } },
  { value: 'outlook-windows', label: 'Outlook Windows' },
]
const LINT_CLIENT: PreviewClient = 'outlook-classic-windows'
const clientsFor = (device: Device) => [...TABS.flatMap(tab => tab.clients ? [tab.clients[device]] : []), LINT_CLIENT].filter((client, index, all) => all.indexOf(client) === index)

export function EmailInsight({ source, pending = false, placeholder, warnBelow }: { source: InsightSource | null; pending?: boolean; placeholder?: ReactNode; warnBelow?: number }) {
  const phone = usePhone()
  const uid = useId()
  const [theme, setTheme] = useState<Theme>('light')
  const [device, setDevice] = useState<Device>(() => phone ? 'mobile' : 'desktop')
  const [tab, setTab] = useState('gmail')
  const check = useSendability(source)
  const campaign = source?.kind === 'campaign' ? source : null
  const campaignHtml = useApiQuery(['campaign-preview', campaign?.id ?? '', campaign?.revision ?? 0], (api, signal) => api.campaigns.preview(campaign!.id, signal), { enabled: Boolean(campaign), keepPrevious: sameSubject(source) })
  const html = campaign ? campaignHtml.data?.html ?? '' : ''
  const previewSource = source?.kind === 'email' ? source.html ? { emailId: source.id } : null : html.trim() ? { html } : null
  const previews = useApiQuery(['email-previews', ...sourceKey(source), theme, device], (api, signal) => api.emails.preview({ source: previewSource!, clients: clientsFor(device), theme, device }, signal), { enabled: Boolean(previewSource), keepPrevious: sameSubject(source) })
  if (!source) return <div className="ei ei--placeholder"><SectionHeader title="Sendability" /><p className="muted">{placeholder}</p></div>
  const previewSettled = campaign ? !campaignHtml.isPending && (!previewSource || !previews.isPending) : !previewSource || !previews.isPending
  if (check.isPending || !previewSettled) return <InsightSkeleton />
  const checking = pending || check.isFetching || previews.isFetching || campaignHtml.isFetching
  const report = check.data
  const shownFindings = report ? report.findings.filter(finding => !(previewSource && PREVIEW_RULES.has(finding.ruleId))) : []
  const covered = report ? report.findings.flatMap(finding => COVERED[finding.ruleId] ? [COVERED[finding.ruleId]] : []) : []
  const issuesOf = (client: PreviewClient) => (previews.data?.find(preview => preview.client === client)?.issues ?? []).filter(issue => !covered.some(rule => rule.test(issue.feature)))
  const tabIssues = (item: Tab) => issuesOf(item.clients ? item.clients[device] : LINT_CLIENT)
  const support = report?.findings.find(finding => PREVIEW_RULES.has(finding.ruleId))
  const current = TABS.find(item => item.value === tab) ?? TABS[0]
  const preview = current.clients ? previews.data?.find(item => item.client === current.clients![device]) : undefined
  return <div className="ei" aria-busy={checking || undefined}><div className="ei-grid">
    <section className="ei-score-col" aria-labelledby={`${uid}-score`}>
      <SectionHeader title={<span id={`${uid}-score`}>Sendability</span>} actions={<span className="muted ei-status" role="status">{checking ? 'Checking…' : ''}</span>} />
      {report ? <>
        {warnBelow !== undefined && report.score < warnBelow && <SendabilityWarning report={report} inPanel />}
        <Score report={report} />
        <Categories report={report} />
        <Findings findings={ranked(report, shownFindings)} />
      </> : <Alert tone="neutral" title="Couldn’t check this email"><ErrorText error={check.error} /><div className="ei-retry"><Button size="sm" onClick={() => void check.refetch()}>Try again</Button></div></Alert>}
    </section>
    <section className="ei-render-col" aria-labelledby={`${uid}-renders`}>
      <SectionHeader title={<span id={`${uid}-renders`}>How it renders</span>} actions={previewSource && <>
        <Segmented label="Color scheme" value={theme} onChange={setTheme} options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
        <Segmented label="Width" value={device} onChange={setDevice} options={[{ value: 'desktop', label: 'Desktop' }, { value: 'mobile', label: 'Phone' }]} />
      </>} />
      {campaignHtml.isError && !campaignHtml.data ? <Alert tone="neutral" title="Couldn’t render this draft"><ErrorText error={campaignHtml.error} /><div className="ei-retry"><Button size="sm" onClick={() => void campaignHtml.refetch()}>Try again</Button></div></Alert>
        : !previewSource ? <p className="muted">{campaign ? 'Add content to see it in each email client.' : 'This email has no HTML, so every client shows its plain text.'}</p>
        : previews.isError && !previews.data ? <Alert tone="neutral" title="Couldn’t emulate the email clients"><ErrorText error={previews.error} /><div className="ei-retry"><Button size="sm" onClick={() => void previews.refetch()}>Try again</Button></div></Alert>
        : <>
          {support && <p className="ei-support"><span className="ei-dot ui-tone--warning" aria-hidden="true" /><span>{support.title}. Widest reach: {featureName(String(support.evidence?.feature ?? ''))}. Each client lists its issues under the preview.</span></p>}
          <Tabs label="Email client" value={tab} onValueChange={setTab} items={TABS.map(item => ({ value: item.value, label: item.label, count: tabIssues(item).length || undefined }))} />
          {current.clients ? <>
            <p className="muted ei-caption">{current.captions![device]} · Emulated offline, not a screenshot. Remote images are blocked.</p>
            {preview?.html ? <ClientFrame html={preview.html} device={device} title={`${current.captions![device]}, ${theme} mode`} pending={previews.isPlaceholderData || previews.isFetching} /> : <div className="ei-frame ei-frame--empty muted">No preview for this client.</div>}
          </> : <p className="muted ei-caption">Classic Outlook for Windows renders with Word, so Bane checks its support instead of previewing it.</p>}
          <IssueList issues={tabIssues(current)} />
        </>}
    </section>
  </div></div>
}

/** The warning near Send when a draft scores low: the score and the three fixes to make first. Sending stays possible. */
export function SendabilityWarning({ report, action, inPanel = false }: { report: SendabilityReport; action?: ReactNode; inPanel?: boolean }) {
  const fixes = topFixes(report)
  // Beside the score (the editor's panel) it needn't repeat the number.
  return <Alert tone="warning" title={inPanel ? 'A low score: fix these before sending' : `Sendability ${report.score} of 100 (${report.grade})`}>
    {!inPanel && <p>{fixes.length ? 'Fix these first. You can still send.' : 'You can still send.'}</p>}
    {fixes.length > 0 && <ol className="ei-warning-fixes">{fixes.map(finding => <li key={finding.ruleId}><AddressText text={finding.fix} /></li>)}</ol>}
    {action}
  </Alert>
}

function Score({ report }: { report: SendabilityReport }) {
  return <div className="ei-score" data-grade={gradeKey(report.grade)}>
    <p className="ei-score__line" aria-label={`Score ${report.score} of 100, grade ${report.grade}`}><span className="ei-score__value">{report.score}</span><span className="ei-score__max">/100</span><span className="ei-score__grade">{report.grade}</span></p>
    <span className="ei-bar ei-bar--score" aria-hidden="true"><span style={{ transform: `scaleX(${report.score / 100})` }} /></span>
    <p className="muted ei-score__note">A high score means few problems found, not guaranteed inbox placement.</p>
  </div>
}

function Categories({ report }: { report: SendabilityReport }) {
  const unscored = report.categories.some(category => !category.weight)
  return <>
    <ul className="ei-categories" aria-label="Scores by category">{report.categories.map(category => <li key={category.id} data-grade={category.weight ? gradeKey(gradeFor(category.score)) : undefined}>
      <span className="ei-categories__label">{categoryLabel[category.id]}</span>
      <span className="ei-categories__value">{category.weight ? category.score : <span aria-label="not scored">—</span>}</span>
      <span className="ei-bar" aria-hidden="true"><span style={{ transform: `scaleX(${category.weight ? category.score / 100 : 0})` }} /></span>
    </li>)}</ul>
    {unscored && <p className="muted ei-categories__note">— Not scored: no evidence yet, so it doesn’t count.</p>}
  </>
}

// Problems (errors, then warnings) first; notes are measurements and context that cost few or no points.
function Findings({ findings: sorted }: { findings: SendabilityFinding[] }) {
  const problems = sorted.filter(finding => finding.severity !== 'info'), notes = sorted.filter(finding => finding.severity === 'info')
  return <>
    {problems.length ? <ul className="ei-findings" aria-label="Problems">{problems.map(finding => <Finding key={finding.ruleId} finding={finding} />)}</ul>
      : <p className="ei-clear"><Check size={16} aria-hidden="true" />No problems found.</p>}
    {notes.length > 0 && <div className="ei-notes"><h3 className="ei-group">Notes</h3><ul className="ei-findings" aria-label="Notes">{notes.map(finding => <Finding key={finding.ruleId} finding={finding} />)}</ul></div>}
  </>
}

const evidenceLabel = (key: string) => key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, first => first.toUpperCase()).replace(/ ([A-Z])/g, (_, letter: string) => ` ${letter.toLowerCase()}`)
function Finding({ finding }: { finding: SendabilityFinding }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const evidence = Object.entries(finding.evidence ?? {})
  return <li className="ei-finding" data-severity={finding.severity}>
    <span className={`ei-dot ui-tone--${severityTone[finding.severity]}`} aria-hidden="true" />
    <div className="ei-finding__body">
      <button type="button" className="ei-finding__title" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}><span className="sr-only">{severityLabel[finding.severity]}: </span><span><AddressText text={finding.title} /></span><ChevronRight size={14} aria-hidden="true" /></button>
      <p className="ei-finding__fix"><AddressText text={finding.fix} /></p>
      <div id={id} className="ei-finding__detail" data-open={open || undefined} inert={!open}><div>
        <p><AddressText text={finding.detail} /></p>
        {evidence.length > 0 && <dl className="ei-evidence">{evidence.map(([key, value]) => <div key={key}><dt>{evidenceLabel(key)}</dt><dd>{typeof value === 'number' ? value.toLocaleString() : <AddressText text={value} />}</dd></div>)}</dl>}
        <p className="ei-finding__rule">{severityLabel[finding.severity]} · {categoryLabel[finding.category]} · <code>{finding.ruleId}</code></p>
      </div></div>
    </div>
  </li>
}

const htmlNames: Record<string, string> = { semantics: 'semantic elements', lists: 'lists', 'h1-h6': 'headings', 'image-maps': 'image maps', comments: 'comments', doctype: 'doctype', 'meta-color-scheme': 'color-scheme meta tag' }
function featureName(feature: string): ReactNode {
  const [kind, ...parts] = feature.split('-'), rest = parts.join('-')
  if (kind === 'css') return <>CSS <code>{rest.replace(/^at-media-?/, '@media ').trim()}</code></>
  if (kind === 'html') return htmlNames[rest] ? `HTML ${htmlNames[rest]}` : <>HTML <code>{`<${rest.replace(/^(input|button)-(.+)$/, '$1 type=$2')}>`}</code></>
  const words = feature.replaceAll('-', ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}
function IssueList({ issues }: { issues: PreviewIssue[] }) {
  if (!issues.length) return <p className="ei-clear ei-clear--issues"><Check size={16} aria-hidden="true" />No compatibility issues in this client.</p>
  const sorted = [...issues].sort((a, b) => (a.severity === 'error' ? 0 : 1) - (b.severity === 'error' ? 0 : 1))
  return <ul className="ei-issues" aria-label="Compatibility issues">{sorted.map(issue => <li key={issue.feature}>
    <span className={`ei-dot ui-tone--${issue.severity === 'error' ? 'danger' : 'warning'}`} aria-hidden="true" />
    <span className="ei-issues__name">{featureName(issue.feature)}</span>
    <span className="muted">{issue.severity === 'error' ? 'Not supported' : 'Partly supported'}</span>
    <a className="ei-issues__link" href={`https://www.caniemail.com/features/${encodeURIComponent(issue.feature)}/`} target="_blank" rel="noreferrer">Can I email<ExternalLink size={12} aria-hidden="true" /><span className="sr-only"> (opens in a new tab)</span></a>
  </li>)}</ul>
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (value: T) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const move = (index: number) => { onChange(options[index].value); refs.current[index]?.focus() }
  return <div className="ei-segmented" role="radiogroup" aria-label={label}>{options.map((option, index) => <button key={option.value} ref={node => { refs.current[index] = node }} type="button" role="radio" aria-checked={value === option.value} tabIndex={value === option.value ? 0 : -1} onClick={() => onChange(option.value)}
    onKeyDown={event => { const next = ['ArrowRight', 'ArrowDown'].includes(event.key) ? (index + 1) % options.length : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? (index + options.length - 1) % options.length : null; if (next !== null) { event.preventDefault(); move(next) } }}>{option.label}</button>)}</div>
}

// ── The emulated client in a frame ──
// The frame follows the API's contract: srcdoc in an iframe with sandbox="" (no scripts, an opaque origin) and a
// CSP that blocks every remote load. An opaque frame can't report its height, so the document is measured first
// in an inert, hidden copy at the client's width (scripts never run; every URL is stripped), the frame gets that
// height, and it fades in once loaded. A long email scrolls inside a capped frame.
const DEVICE_WIDTH: Record<Device, number> = { desktop: 800, mobile: 390 }
const MAX_HEIGHT = 1400
const GUARD = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; form-action 'none'; base-uri 'none'"><meta name="referrer" content="no-referrer"><style>html{scrollbar-width:none}html::-webkit-scrollbar{display:none}</style>`
const frameDocument = (html: string) => /<head\b[^>]*>/i.test(html) ? html.replace(/<head\b[^>]*>/i, head => head + GUARD) : GUARD + html
// Type selectors for the document's own root and body, renamed for the copy's stand-ins.
const ROOTS = /(^|[\s,>+~(}{])(:root|html|body)(?=[\s,.#:[>+~{)]|$)/gi
// Nothing in the copy may fetch: imports, image sets and url() go, in style sheets and style attributes alike.
const withoutUrls = (css: string) => css.replace(/@import[^;]*;?/gi, '').replace(/(?:-webkit-)?image-set\([^)]*\)/gi, 'none').replace(/url\([^)]*\)/gi, 'none')
function measureHeight(html: string, width: number): number {
  const clean = DOMPurify.sanitize(html, { WHOLE_DOCUMENT: true, ADD_TAGS: ['style'], FORBID_TAGS: ['script', 'iframe', 'frame', 'object', 'embed', 'link', 'meta', 'base', 'video', 'audio', 'source'], FORBID_ATTR: ['srcset', 'href', 'background', 'action', 'formaction', 'ping', 'xlink:href'] })
  const doc = new DOMParser().parseFromString(clean, 'text/html')
  const css = withoutUrls([...doc.querySelectorAll('style')].map(style => { const text = style.textContent ?? ''; style.remove(); return text }).join('\n'))
    .replace(ROOTS, (_, before: string, root: string) => `${before}.ei-m-${root === 'body' ? 'body' : 'html'}`)
  // A blocked image keeps the frame's broken-image box; data: images load in both.
  doc.querySelectorAll('[style]').forEach(element => element.setAttribute('style', withoutUrls(element.getAttribute('style') ?? '')))
  doc.querySelectorAll('[src]').forEach(element => { if (!/^data:image\//i.test(element.getAttribute('src') ?? '')) element.setAttribute('src', 'data:,') })
  const host = document.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  host.style.cssText = `position:absolute;top:0;left:-20000px;width:${width}px;visibility:hidden;pointer-events:none;contain:layout style paint`
  const root = host.attachShadow({ mode: 'closed' })
  const outer = document.createElement('div'), body = document.createElement('div')
  for (const { name, value } of doc.documentElement.attributes) outer.setAttribute(name, value)
  for (const { name, value } of doc.body.attributes) body.setAttribute(name, value)
  outer.classList.add('ei-m-html'); body.classList.add('ei-m-body')
  body.append(...doc.body.childNodes)
  outer.append(body)
  const style = document.createElement('style')
  style.textContent = `:host{all:initial;display:block;width:${width}px}.ei-m-html{display:flow-root;width:${width}px}.ei-m-body{display:block;margin:8px}\n${css}`
  root.append(style, outer)
  document.body.append(host)
  try { return Math.ceil(outer.getBoundingClientRect().height) } finally { host.remove() }
}

type Layer = { doc: string; width: number; height: number; loaded: boolean }
function ClientFrame({ html, device, title, pending }: { html: string; device: Device; title: string; pending: boolean }) {
  const width = DEVICE_WIDTH[device]
  const doc = useMemo(() => frameDocument(html), [html])
  const height = useMemo(() => Math.max(160, measureHeight(html, width)), [html, width])
  const box = useRef<HTMLDivElement>(null)
  const [available, setAvailable] = useState(0)
  useLayoutEffect(() => {
    const element = box.current!
    const read = () => setAvailable(element.clientWidth)
    read()
    const observer = new ResizeObserver(read)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  // The previous frame stays until the next has loaded, then the next fades in over it.
  const [layers, setLayers] = useState<Layer[]>(() => [{ doc, width, height, loaded: false }])
  const top = layers[layers.length - 1]
  if (top.doc !== doc || top.width !== width) setLayers([...layers.filter(layer => layer.loaded).slice(-1), { doc, width, height, loaded: false }])
  const loaded = (layer: Layer) => setLayers(list => { const index = list.indexOf(layer); return index < 0 ? list : [{ ...layer, loaded: true }, ...list.slice(index + 1)] })
  const scale = available ? Math.min(1, available / width) : 1
  const shown = Math.min(height, MAX_HEIGHT)
  return <><div ref={box} className="ei-frame" data-pending={pending || undefined} data-first={layers.length === 1 && !layers[0].loaded || undefined} style={{ height: Math.ceil(shown * scale) }}>
    {layers.map(layer => <iframe key={`${layer.width}:${layer.doc}`} title={title} srcDoc={layer.doc} sandbox="" referrerPolicy="no-referrer" data-loaded={layer.loaded || undefined} onLoad={() => loaded(layer)}
      style={{ width: layer.width, height: Math.min(layer.height, MAX_HEIGHT), left: available ? Math.max(0, (available - layer.width * scale) / 2) : 0, transform: scale < 1 ? `scale(${scale})` : undefined }} />)}
  </div>{height > MAX_HEIGHT && <p className="muted ei-caption">A long email: scroll inside the preview for the rest.</p>}</>
}

export function InsightSkeleton() {
  return <div className="ei ei--loading" aria-busy="true"><span role="status" className="sr-only">Checking this email</span><div className="ei-grid">
    <section className="ei-score-col" aria-hidden="true">
      <SectionHeader title="Sendability" />
      <div className="ei-score"><SkeletonText width={120} lineHeight={36} /><Skeleton height={4} /><SkeletonText width="80%" /></div>
      <div className="ei-categories ei-categories--loading">{Array.from({ length: 6 }, (_, index) => <Skeleton key={index} height={36} />)}</div>
      <div className="stack">{Array.from({ length: 4 }, (_, index) => <SkeletonText key={index} width={index % 2 ? '60%' : '85%'} lineHeight={40} />)}</div>
    </section>
    <section className="ei-render-col" aria-hidden="true">
      <SectionHeader title="How it renders" />
      <Skeleton height={32} />
      <SkeletonText width="70%" />
      <Skeleton height={480} />
    </section>
  </div></div>
}
