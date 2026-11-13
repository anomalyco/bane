import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useIsFetching, useQuery } from '@tanstack/react-query'
import { Link, Navigate, useLocation, useNavigate, useNavigationType, useParams } from 'react-router'
import { Alert, EmptyState, ErrorState, Input, SkeletonText, Tabs } from '../../components/ui'
import { CopyAction } from '../../components/motion'
import { useApi, useApiQuery, useCanonicalOrigin, useSession, useWorkspaceAccess } from '../../data/context'
import { AgentPrompt, agentPrompt } from './agent-setup'
import { guides, type Guide } from './guides'
import { SendingLimitsGuide } from '../score/limits'
import { DocsArticleSkeleton, useDocsAudience } from './frame'
import { openApiQuery } from './openapi'
import './docs.css'

type Schema = Record<string, any>
type Operation = { id: string; method: string; path: string; tag: string; summary: string; description: string; parameters: Schema[]; requestBody?: Schema; responses: Record<string, Schema>; samples: {lang: string; label: string; source: string}[] }
type QuickstartStep = { title: string; text: string; code?: string }
type Document = { info: {title: string; version: string; description?: string; 'x-quickstart'?: QuickstartStep[]}; tags?: {name: string}[]; paths: Record<string, Record<string, Schema>>; components?: {schemas?: Record<string, Schema>; parameters?: Record<string, Schema>} }
const methods = ['get', 'post', 'put', 'patch', 'delete']
// Tag names are API identifiers (ApiKeys); people read them with spaces (API keys).
const tagTitle = (tag: string) => tag === 'ApiKeys' ? 'API keys' : tag === 'Auth' ? 'Agent tokens' : tag
// Examples are written for bane.mx; this instance's own origin goes in their place, so a copied command works here.
const here = (code: string, origin: string) => code.replaceAll('https://bane.mx', origin)
function operationTitle(value: string) {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' ').map((word, index) => /^mcp$/i.test(word) ? 'MCP' : index === 0 ? word[0].toUpperCase() + word.slice(1).toLowerCase() : word.toLowerCase()).join(' ')
}

function resolve(document: Document, value?: Schema): Schema {
  if (!value?.$ref) return value ?? {}
  const [, , section, name] = value.$ref.split('/')
  return (document.components as Schema | undefined)?.[section]?.[name] ?? {}
}
function typeLabel(document: Document, input: Schema): string {
  const schema = resolve(document, input)
  if (schema.oneOf || schema.anyOf) return (schema.oneOf ?? schema.anyOf).map((value: Schema) => typeLabel(document, value)).join(' or ')
  if (Array.isArray(schema.type)) return schema.type.join(' or ')
  if (schema.type === 'array') return `${typeLabel(document, schema.items)}[]`
  return schema.type ?? (schema.properties ? 'object' : 'value')
}
function schemaName(input: Schema): string | null { return typeof input?.$ref === 'string' ? input.$ref.split('/').at(-1) ?? null : null }
function operations(document?: Document): Operation[] {
  if (!document) return []
  const result: Operation[] = []
  for (const [path, pathItem] of Object.entries(document.paths)) for (const method of methods) {
    const operation = pathItem[method]
    // Internal operations (x-internal: support tooling) stay out of the public docs; a tag left empty has no group.
    if (!operation?.operationId || operation['x-internal'] === true) continue
    result.push({ id: operation.operationId, method, path, tag: operation.tags?.[0] ?? 'API', summary: operation.summary ?? operationTitle(operation.operationId), description: operation.description ?? '', parameters: [...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []), ...(Array.isArray(operation.parameters) ? operation.parameters : [])], requestBody: operation.requestBody, responses: operation.responses ?? {}, samples: operation['x-codeSamples'] ?? [] })
  }
  // Groups follow the document's tag order (Emails and Domains first); operations keep path order within a group.
  const order = (document.tags ?? []).map(tag => tag.name)
  const rank = (tag: string) => { const index = order.indexOf(tag); return index === -1 ? order.length : index }
  return result.map((operation, index) => ({ operation, index })).sort((a, b) => rank(a.operation.tag) - rank(b.operation.tag) || a.index - b.index).map(item => item.operation)
}

// The installation's canonical address (useCanonicalOrigin). The page renders its examples only once it is known, and
// never on another host, so every example below has it.
const DocsOrigin = createContext('')
const useDocsOrigin = () => useContext(DocsOrigin)
/** Shown instead of any example when the docs are open somewhere other than the installation's own address. */
function ForeignHost({ origin }: { origin: string }) {
  const page = window.location.host, canonical = new URL(origin).host
  return <article className="docs-operation docs-foreign"><Alert tone="danger" title="This isn’t this Bane installation’s address">
    These docs are open at <strong>{page}</strong>, but this installation is at <strong>{canonical}</strong>. Examples, keys and agent setup are only shown at its own address, so nothing you copy sends a key somewhere else. <a href={`${origin}${window.location.pathname}${window.location.hash}`}>Open the docs at {canonical}</a>.
  </Alert></article>
}

function Quickstart({ steps }: { steps: QuickstartStep[] }) {
  const origin = useDocsOrigin()
  steps = steps.map(step => step.code ? { ...step, code: here(step.code, origin) } : step)
  return <section id="quickstart" className="docs-section docs-quickstart" aria-labelledby="docs-quickstart"><h2 id="docs-quickstart">Quickstart</h2>
    <ol>{steps.map(step => <li key={step.title}><strong>{step.title}.</strong> {step.text}
      {step.code && <div className="docs-quickstart-code"><pre className="docs-code" tabIndex={0}><code>{step.code}</code></pre><CopyAction value={step.code} label={`Copy ${step.title} example`} variant="ghost" size="sm" compact className="developer-copy-icon" /></div>}</li>)}</ol>
  </section>
}

function SchemaDefinition({ document, input }: {document: Document; input: Schema}) {
  const name = schemaName(input)
  const schema = resolve(document, input)
  const required = new Set<string>(schema.required ?? [])
  const properties = Object.entries<Schema>(schema.properties ?? {})
  if (!properties.length) return <div className="docs-schema-inline"><code>{name ?? typeLabel(document, schema)}</code>{schema.description && <p>{schema.description}</p>}</div>
  return <div className="docs-schema">
    {name && <code className="docs-schema-name">{name}</code>}
    {schema.description && <p className="muted">{schema.description}</p>}
    <div className="docs-field-list">{properties.map(([property, definition]) => <div className="docs-field" key={property}>
      <div><code>{property}</code>{required.has(property) && <span className="docs-required">required</span>}<span className="docs-type">{typeLabel(document, definition)}</span></div>
      {resolve(document, definition).description && <p>{resolve(document, definition).description}</p>}
    </div>)}</div>
  </div>
}

function OperationPage({ document, operation: raw }: {document: Document; operation: Operation}) {
  const origin = useDocsOrigin()
  const operation = useMemo(() => ({ ...raw, samples: raw.samples.map(sample => ({ ...sample, source: here(sample.source, origin) })) }), [raw, origin])
  // The chosen language carries over to the next operation that has it.
  const [language, setLanguage] = useState(operation.samples[0]?.label ?? 'TypeScript SDK')
  const sample = operation.samples.find(item => item.label === language) ?? operation.samples[0]
  const body = operation.requestBody?.content?.['application/json']?.schema
  const parameters = operation.parameters.map(parameter => resolve(document, parameter))
  return <article className="docs-operation">
    <header className="docs-operation-header">
      <h1>{operation.summary}</h1>
      <div className="docs-endpoint"><span data-method={operation.method}>{operation.method}</span><code>{operation.path}</code><CopyAction value={operation.path} label="Copy endpoint path" variant="ghost" size="sm" compact className="developer-copy-icon" /></div>
      {operation.description && <p>{operation.description}</p>}
    </header>
    {sample && <section className="docs-section" aria-labelledby="docs-example-title">
      <h2 id="docs-example-title">Example</h2>
      <div className="docs-example-bar"><Tabs label="Example language" value={sample.label} onValueChange={setLanguage} items={operation.samples.map(item => ({value: item.label, label: item.label}))} /><CopyAction key={`${operation.id}:${language}`} value={sample.source} label="Copy code example" variant="ghost" size="sm" compact className="developer-copy-icon" /></div>
      {/* Every language shares one cell, so switching tabs never changes the section's height. */}
      <div className="docs-example-panels">{operation.samples.map(item => <pre key={item.label} className="docs-code" tabIndex={0} aria-label={`${item.label} example`} data-active={item.label === sample.label || undefined} inert={item.label !== sample.label}><code>{item.source}</code></pre>)}</div>
    </section>}
    {parameters.length > 0 && <section className="docs-section"><h2>Parameters</h2><div className="docs-field-list">{parameters.map(parameter => <div className="docs-field" key={`${parameter.in}:${parameter.name}`}><div><code>{parameter.name}</code>{parameter.required && <span className="docs-required">required</span>}<span className="docs-type">{parameter.in} · {typeLabel(document, parameter.schema)}</span></div>{parameter.description && <p>{parameter.description}</p>}</div>)}</div></section>}
    {body && <section className="docs-section"><h2>Request body</h2><SchemaDefinition document={document} input={body} /></section>}
    <section className="docs-section"><h2>Responses</h2><div className="docs-responses">{Object.entries(operation.responses).map(([status, response]) => { const schema = response.content?.['application/json']?.schema; return <details key={status} open={status.startsWith('2')}><summary><code>{status}</code><span>{response.description}</span></summary>{schema && <SchemaDefinition document={document} input={schema} />}</details> })}</div></section>
  </article>
}

// Pages: /docs (the overview), /docs/<guide> and /docs/api/<operationId>. Overview sections keep anchors (#sending-limits).
const operationPath = (id: string) => `/docs/api/${encodeURIComponent(id)}`
type Page = { kind: 'overview' } | { kind: 'guide'; guide: Guide } | { kind: 'operation'; id: string } | { kind: 'missing' }
function pageOf(splat: string): Page {
  const parts = splat.split('/').filter(Boolean)
  if (!parts.length) return { kind: 'overview' }
  const guide = parts.length === 1 ? guides.find(item => item.id === parts[0]) : undefined
  if (guide) return { kind: 'guide', guide }
  return parts.length === 2 && parts[0] === 'api' ? { kind: 'operation', id: parts[1]! } : { kind: 'missing' }
}
const pathOf = (page: Page) => page.kind === 'guide' ? `/docs/${page.guide.id}` : page.kind === 'operation' ? operationPath(page.id) : '/docs'
function anchor(hash: string) { try { return decodeURIComponent(hash.slice(1)) } catch { return '' } }
// Links from before the docs had pages of their own: /docs#guide-rituals, /docs#mcp and /docs#sendEmail.
function legacyPath(hash: string, all: Operation[]): string | null {
  const id = anchor(hash)
  if (id === 'mcp') return '/docs/mcp'
  if (id.startsWith('guide-') && guides.some(guide => `guide-${guide.id}` === id)) return `/docs/${id.slice('guide-'.length)}`
  // Operation IDs are camelCase; overview sections are kebab-case.
  return /^[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*$/.test(id) || all.some(operation => operation.id === id) ? operationPath(id) : null
}

function GuidePage({ guide }: { guide: Guide }) {
  const index = guides.indexOf(guide), next = guides[index + 1]
  return <article className="docs-operation docs-guide">
    <header className="docs-operation-header"><span className="docs-eyebrow">Guide</span><h1>{guide.title}</h1><p>{guide.summary}</p></header>
    {guide.body()}
    <nav className="docs-section docs-guide-next" aria-label="More guides">{next ? <Link to={`/docs/${next.id}`}>Next: {next.title}</Link> : <Link to="/docs">Back to the overview</Link>}</nav>
  </article>
}
function MissingPage() {
  return <article className="docs-operation"><EmptyState headingAs="h1" title="Page not found" description="This page isn’t in the docs. It may have moved." action={<Link to="/docs">Open the overview</Link>} /></article>
}

// Workspace admins (and demo mode) get a prompt with this workspace's domain; null while it loads.
// Members and signed-out readers get the general prompt, so they never call /v1/domains.
function useAgentPrompt() {
  const identity = useSession()?.identity
  const checkingSession = useIsFetching({ queryKey: ['identity'] }) > 0
  const { multiTenant, canAdminister } = useWorkspaceAccess()
  const demo = useApi().mode === 'demo'
  const withDomain = (Boolean(identity) || demo) && canAdminister
  const origin = useDocsOrigin()
  const domains = useApiQuery(['domains', 'agent-prompt'], (api, signal) => api.domains.list({ page: 1, pageSize: 20, refresh: false }, signal), { enabled: withDomain })
  if ((!identity && !demo && checkingSession) || (withDomain && domains.isPending)) return null
  // Prefer a verified domain for the test send; any domain still gives the agent its DNS context.
  const items = domains.data?.items ?? []
  const domain = withDomain ? items.find(row => row.status === 'verified') ?? items[0] ?? null : undefined
  return agentPrompt({ origin, domain, email: identity?.email ?? null, multiTenant })
}

function DocsOverview({ document, all }: {document: Document; all: Operation[]}) {
  const prompt = useAgentPrompt()
  const groups = [...new Set(all.map(operation => operation.tag))]
  const install = 'npm install @banemx/sdk'
  return <article className="docs-operation docs-overview">
    <header className="docs-operation-header"><h1>Bane API</h1><p>{document.info.description}</p></header>
    {document.info['x-quickstart']?.length ? <Quickstart steps={document.info['x-quickstart']} /> : null}
    <section id="guides" className="docs-section" aria-labelledby="docs-guides"><h2 id="docs-guides">Guides</h2><div className="docs-resource-list">
      {guides.map(guide => <Link key={guide.id} to={`/docs/${guide.id}`}><strong>{guide.title}</strong><span>{guide.summary}</span></Link>)}
    </div></section>
    <AgentPrompt prompt={prompt} />
    <section id="sdk" className="docs-section"><h2>TypeScript SDK</h2><p className="muted">Generated client and types, <a href="https://www.npmjs.com/package/@banemx/sdk">published on npm</a>. Call it from a trusted server with an API key.</p><div className="docs-install"><code>{install}</code><CopyAction value={install} label="Copy install command" variant="ghost" size="sm" compact className="developer-copy-icon" /></div></section>
    <section id="formats" className="docs-section"><h2>Documentation formats</h2><div className="docs-resource-list">
      <a href="/docs.md"><strong>Markdown reference</strong><span>API index for agents and text tools, with a complete reference per tag.</span></a>
      <a href="/llms.txt"><strong>Agent index</strong><span>Canonical links to every focused operation page.</span></a>
      <a href="/openapi.json"><strong>OpenAPI 3.1</strong><span>Machine-readable schemas and generated code examples.</span></a>
    </div></section>
    <section id="sending-limits" className="docs-section" aria-labelledby="sending-limits-title"><h2 id="sending-limits-title">How sending limits work</h2><SendingLimitsGuide /></section>
    <section id="operations" className="docs-section"><h2 className="docs-section-heading">API operations<span>{all.length}</span></h2>
      <div className="docs-overview-groups">{groups.map(group => <section key={group}><h3>{tagTitle(group)}<span>{all.filter(operation => operation.tag === group).length}</span></h3><div>{all.filter(operation => operation.tag === group).map(operation => <Link key={operation.id} to={operationPath(operation.id)}><span data-method={operation.method}>{operation.method}</span><span>{operation.summary}</span><code>{operation.path}</code></Link>)}</div></section>)}</div>
    </section>
  </article>
}

// The tab's title and the description search results and link previews read, per page.
const defaultDescription = window.document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content ?? ''
function useDocumentMeta(title: string, description: string) {
  useEffect(() => {
    window.document.title = `${title} · Bane docs`
    window.document.querySelector<HTMLMetaElement>('meta[name="description"]')?.setAttribute('content', description)
  }, [title, description])
  useEffect(() => () => window.document.querySelector<HTMLMetaElement>('meta[name="description"]')?.setAttribute('content', defaultDescription), [])
}
// A new page opens at its top, or at the section its link names once that section has rendered. Back and Forward
// leave scrolling to the dashboard (or the browser), which restores where that page was left.
function useAnchorScroll(ready: boolean) {
  const location = useLocation(), navigationType = useNavigationType()
  const landed = useRef(false)
  useEffect(() => {
    if (!ready) return
    const first = !landed.current
    landed.current = true
    if (navigationType === 'POP' && !first) return
    const id = anchor(location.hash)
    const target = id ? window.document.getElementById(id) : null
    if (target) target.scrollIntoView({ block: 'start' })
    else if (!first) window.scrollTo(0, 0)
  }, [location.key, ready])
}

function DocsPicker({ page, title, all }: { page: Page; title: string; all: Operation[] }) {
  const navigate = useNavigate()
  const value = pathOf(page)
  const groups = [...new Set(all.map(operation => operation.tag))]
  const known = page.kind === 'overview' || page.kind === 'guide' || all.some(operation => operationPath(operation.id) === value)
  return <select className="ui-input ui-select-trigger ui-native-select" aria-label="Documentation page" value={value} onChange={event => navigate(event.target.value)}>
    {!known && <option value={value} disabled>{title}</option>}
    <optgroup label="Guides"><option value="/docs">Overview and quickstart</option>{guides.map(guide => <option key={guide.id} value={`/docs/${guide.id}`}>{guide.title}</option>)}</optgroup>
    {groups.map(group => <optgroup key={group} label={tagTitle(group)}>{all.filter(operation => operation.tag === group).map(operation => <option key={operation.id} value={operationPath(operation.id)}>{operation.summary}</option>)}</optgroup>)}
  </select>
}

export function DocsPage() {
  const site = useCanonicalOrigin()
  const query = useQuery(openApiQuery)
  const spec = query.data as Document | undefined
  const all = useMemo(() => operations(spec), [spec])
  const location = useLocation()
  const page = pageOf(useParams()['*'] ?? '')
  const inShell = useDocsAudience() === 'shell'
  const current = page.kind === 'operation' ? all.find(operation => operation.id === page.id) : undefined
  const missing = page.kind === 'missing' || (page.kind === 'operation' && Boolean(spec) && !current)
  const title = missing ? 'Page not found' : page.kind === 'guide' ? page.guide.title : page.kind === 'operation' ? current?.summary ?? 'API reference' : 'Bane API'
  const description = page.kind === 'guide' ? page.guide.summary : current ? `${current.method.toUpperCase()} ${current.path}${current.description ? `. ${current.description}` : ''}` : spec?.info.description ?? defaultDescription
  useDocumentMeta(title, description)
  useAnchorScroll(Boolean(site.origin) && (page.kind === 'guide' || missing || Boolean(spec)))
  const [search, setSearch] = useState('')
  const q = search.trim().toLowerCase()
  const filtered = q ? all.filter(operation => `${operation.id} ${operation.summary} ${operation.path} ${operation.tag}`.toLowerCase().includes(q)) : all
  const groups = [...new Set(filtered.map(operation => operation.tag))]
  const shownGuides = q ? guides.filter(item => `${item.title} ${item.summary}`.toLowerCase().includes(q)) : guides
  const active = pathOf(page)
  // The contents keep the open page in view: a deep link to an operation far down the list shows where it is.
  const contents = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const box = contents.current, item = box?.querySelector('[aria-current="page"]')
    if (!box || !item) return
    const outer = box.getBoundingClientRect(), inner = item.getBoundingClientRect()
    if (inner.top < outer.top || inner.bottom > outer.bottom - 24) box.scrollTop += inner.top - outer.top - outer.height / 3
  }, [active, all.length])
  const legacy = page.kind === 'overview' && location.hash ? legacyPath(location.hash, all) : null
  if (legacy) return <Navigate replace to={legacy} />
  const Main = inShell ? 'div' : 'main'
  return <div className="docs-frame"><div className="docs-layout">
    <aside className="docs-toc" aria-label="Documentation contents"><Input type="search" aria-label="Search the documentation" placeholder="Search guides and API" value={search} onChange={event => setSearch(event.target.value)} />
      <div className="docs-toc-scroll" ref={contents}><nav aria-label="Guides and API operations">
        {shownGuides.length > 0 && <div className="docs-nav-group docs-nav-group--guides"><h2>Guides</h2>{!q && <Link to="/docs" data-active={active === '/docs' || undefined} aria-current={active === '/docs' ? 'page' : undefined}><span>Overview and quickstart</span></Link>}{shownGuides.map(item => <Link key={item.id} to={`/docs/${item.id}`} data-active={active === `/docs/${item.id}` || undefined} aria-current={active === `/docs/${item.id}` ? 'page' : undefined}><span>{item.title}</span></Link>)}</div>}
        {query.isPending ? <div className="stack"><SkeletonText /><SkeletonText /><SkeletonText /></div> : !groups.length && q ? !shownGuides.length && <p className="muted docs-nav-empty">Nothing matches.</p> : groups.map(group => <div className="docs-nav-group" key={group}><h2>{tagTitle(group)}</h2>{filtered.filter(operation => operation.tag === group).map(operation => { const to = operationPath(operation.id); return <Link key={operation.id} to={to} data-active={active === to || undefined} aria-current={active === to ? 'page' : undefined}><span data-method={operation.method}>{operation.method}</span><span>{operation.summary}</span></Link> })}</div>)}</nav></div>
    </aside>
    <div className="docs-picker"><DocsPicker page={page} title={title} all={all} /></div>
    <Main className="docs-main">{site.foreign && site.origin ? <ForeignHost origin={site.origin} /> : !site.origin ? (site.error ? <ErrorState error={site.error} onRetry={site.retry} /> : <DocsArticleSkeleton />) : <DocsOrigin.Provider value={site.origin}>{missing ? <MissingPage /> : page.kind === 'guide' ? <GuidePage guide={page.guide} /> : query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : !spec ? <DocsArticleSkeleton /> : current ? <OperationPage document={spec} operation={current} /> : <DocsOverview document={spec} all={all} />}</DocsOrigin.Provider>}</Main>
  </div></div>
}
