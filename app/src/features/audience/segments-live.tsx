import { Fragment, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { Braces, ListFilter, Plus, X } from 'lucide-react'
import { useApiMutation, useApiQuery } from '../../data/context'
import { ApiError, type Segment } from '../../data/types'
import { SearchField, Button, DataTable, EmptyState, ErrorState, Field, IconButton, Input, LoadingRegion, PageHeader, Pagination, SectionHeader, Select, Textarea } from '../../components/ui'
import { AudienceRouteSkeleton, AudienceSummarySkeleton } from './skeletons'
import { date, fieldError, ListPicker, MutationError, number, ruleSummary } from './shared'
import { useAdaptivePageSize } from '../../lib/pagination'
import { AudienceHeader } from './header'

// Teaches what a segment is where there are none yet; the demo and the live list share it.
export function SegmentsEmpty({ search, onClear }: { search: string; onClear: () => void }) {
  return search ? <EmptyState title="No matching segments" action={<Button onClick={onClear}>Clear search</Button>} />
    : <EmptyState title="No segments yet" description="A segment is a saved filter, like “Plan is pro” or “Opened an email in the last 30 days”. Campaigns use it to send only to matching people on their list." action={<Link className="ui-button ui-button--secondary ui-button--md" to="/audience/segments/new">Create segment</Link>} />
}

export function LiveSegmentsPage() {
  const { pageSize: adaptivePageSize, tableRef } = useAdaptivePageSize()
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  useEffect(() => setPage(1), [adaptivePageSize])
  const query = useApiQuery(['segments', { page, search, pageSize: adaptivePageSize }], (api, signal) => api.segments.list({ page, search, pageSize: adaptivePageSize }, signal))
  return <div className="audience-page"><AudienceHeader actions={<Link className="ui-button ui-button--primary ui-button--md" to="/audience/segments/new">Create segment</Link>} /><div className="data-toolbar"><SearchField className="search-box--list" aria-label="Search segments" placeholder="Search segments" value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} /></div>{query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <><DataTable tableRef={tableRef} rows={query.data?.items ?? []} loading={query.isPending} skeletonRows={adaptivePageSize} minRows={adaptivePageSize} rowKey={row => row.id} rowHref={row => `/audience/segments/${row.id}`} empty={<SegmentsEmpty search={search} onClear={() => { setSearch(''); setPage(1) }} />} columns={[{ key: 'name', label: 'Name', render: row => <span className="audience-cell-text" title={row.name}>{row.name}</span> }, { key: 'rule', label: 'Conditions', width: '50%', card: 'line', render: row => { const text = ruleSummary(row.rule); return <span className="audience-cell-text" title={text}>{text}</span> } }, { key: 'updatedAt', label: 'Updated', card: 'inline', render: row => date(row.updatedAt), cardRender: row => `Updated ${date(row.updatedAt)}` }]} />{query.data && <Pagination page={query.data.page} pageSize={adaptivePageSize} nextCursor={query.data.nextCursor} onPageChange={setPage} />}</>}</div>
}

// The editor for the API's public segment rule: a leaf {field, operator, value} or {field, operator, days}, or a group
// {operator: and|or, rules} (10 rules a group, 3 levels, 50 rules in all). The builder edits one group of leaves; a nested
// group stays as a row you can remove or change in JSON, so JSON ⇄ builder never loses a rule.
type Row = { id: string; field: string; operator: string; value: string; group?: Record<string, unknown> }
type Builder = { match: 'all' | 'any'; rows: Row[] }
const fields = [{ value: 'email', label: 'Email' }, { value: 'firstName', label: 'First name' }, { value: 'plan', label: 'Plan' }, { value: 'country', label: 'Country' }, { value: 'lastOpenAt', label: 'Opened an email' }, { value: 'lastClickAt', label: 'Clicked a link' }]
const textOperators = [{ value: 'eq', label: 'is' }, { value: 'neq', label: 'is not' }, { value: 'contains', label: 'contains' }]
const activityOperators = [{ value: 'within', label: 'in the last' }, { value: 'inactive', label: 'not in the last' }]
const placeholders: Record<string, string> = { email: 'example.com', firstName: 'Ada', plan: 'pro', country: 'US' }
const MAX_ROWS = 10
const activity = (field: string) => field === 'lastOpenAt' || field === 'lastClickAt'
const newRow = (): Row => ({ id: crypto.randomUUID(), field: 'plan', operator: 'eq', value: '' })
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
function toRow(rule: unknown): Row {
  const r = isRecord(rule) ? rule : {}
  if (Array.isArray(r.rules)) return { id: crypto.randomUUID(), field: '', operator: '', value: '', group: r }
  return { id: crypto.randomUUID(), field: String(r.field ?? 'plan'), operator: String(r.operator ?? 'eq'), value: String(activity(String(r.field)) ? r.days ?? '' : r.value ?? '') }
}
function toBuilder(rule: unknown): Builder {
  if (isRecord(rule) && Array.isArray(rule.rules)) return { match: rule.operator === 'or' ? 'any' : 'all', rows: rule.rules.map(toRow) }
  return { match: 'all', rows: [toRow(rule)] }
}
function fromBuilder({ match, rows }: Builder): Record<string, unknown> {
  const rules = rows.map(row => row.group ?? (activity(row.field) ? { field: row.field, operator: row.operator, days: Number(row.value) } : { field: row.field, operator: row.operator, value: row.value.trim() }))
  return rules.length === 1 ? rules[0] : { operator: match === 'any' ? 'or' : 'and', rules }
}
function rowError(row: Row) {
  if (row.group) return undefined
  if (activity(row.field)) return /^\d+$/.test(row.value) && Number(row.value) >= 1 && Number(row.value) <= 730 ? undefined : 'Enter a whole number of days from 1 to 730.'
  return !row.value.trim() ? `Enter the ${fields.find(field => field.value === row.field)?.label.toLowerCase() ?? 'value'} to match, for example “${placeholders[row.field] ?? 'pro'}”.` : undefined
}
// The API's rule schema, checked before a JSON rule is sent so a typo is named here, not as a request error.
function ruleProblem(value: unknown, depth = 0, path = 'rule'): string | null {
  if (!isRecord(value)) return `${path} must be an object.`
  if (value.operator === 'and' || value.operator === 'or') {
    if (depth >= 3) return `${path} nests groups more than three levels deep.`
    if (!Array.isArray(value.rules) || value.rules.length < 1 || value.rules.length > 10) return `${path}.rules must hold 1 to 10 rules.`
    for (const [index, child] of value.rules.entries()) { const problem = ruleProblem(child, depth + 1, `${path}.rules[${index}]`); if (problem) return problem }
    return Object.keys(value).every(key => key === 'operator' || key === 'rules') ? null : `${path} may only have operator and rules.`
  }
  if (['email', 'firstName', 'plan', 'country'].includes(String(value.field))) return !['eq', 'neq', 'contains'].includes(String(value.operator)) ? `${path}.operator must be eq, neq or contains.` : typeof value.value !== 'string' || value.value.length > 200 ? `${path}.value must be text of at most 200 characters.` : Object.keys(value).every(key => ['field', 'operator', 'value'].includes(key)) ? null : `${path} may only have field, operator and value.`
  if (['lastOpenAt', 'lastClickAt'].includes(String(value.field))) return !['within', 'inactive'].includes(String(value.operator)) ? `${path}.operator must be within or inactive.` : !Number.isInteger(value.days) || Number(value.days) < 1 || Number(value.days) > 730 ? `${path}.days must be a whole number from 1 to 730.` : Object.keys(value).every(key => ['field', 'operator', 'days'].includes(key)) ? null : `${path} may only have field, operator and days.`
  return `${path}.field must be email, firstName, plan, country, lastOpenAt or lastClickAt (or use operator and/or with rules).`
}
// Two rules are the same when they read the same: key order (the database sorts JSON keys) and a one-rule group don't count.
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : isRecord(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value)
const signature = (rule: unknown) => canonical(fromBuilder(toBuilder(rule)))
const ruleSize = (rule: unknown): number => isRecord(rule) && Array.isArray(rule.rules) ? 1 + rule.rules.reduce((sum: number, child) => sum + ruleSize(child), 0) : 1

export function LiveSegmentRoute() {
  const { id } = useParams()
  // After the first save the URL becomes /segments/<id> (replacing /new, so a reload or a second save can't create a
  // duplicate); the editor that created it stays mounted instead of reloading.
  const [created, setCreated] = useState<string | null>(null)
  const loadId = id && id !== created ? id : undefined
  const query = useApiQuery(['segments', loadId ?? 'new'], (api, signal) => api.segments.get(loadId!, signal), { enabled: Boolean(loadId) })
  if (!loadId) return <LiveSegmentEditor key="new" initial={null} onCreated={setCreated} />
  return query.isPending ? <AudienceRouteSkeleton kind="segment" /> : query.isError ? <div className="audience-page"><PageHeader title="Segment" backTo="/audience/segments" /><ErrorState error={query.error} onRetry={() => query.refetch()} /></div> : <LiveSegmentEditor key={loadId} initial={query.data} onCreated={setCreated} />
}
function LiveSegmentEditor({ initial, onCreated }: { initial: Segment | null; onCreated: (id: string) => void }) {
  const navigate = useNavigate()
  const [name, setName] = useState(initial?.name ?? '')
  const [saved, setSaved] = useState(() => initial ? { id: initial.id, name: initial.name, rule: signature(initial.rule), at: initial.updatedAt } : null)
  const [builder, setBuilder] = useState<Builder>(() => initial ? toBuilder(initial.rule) : { match: 'all', rows: [newRow()] })
  const [json, setJson] = useState<string | null>(null), [jsonError, setJsonError] = useState('')
  const [checked, setChecked] = useState(false)
  const [countList, setCountList] = useState('')
  const save = useApiMutation((api, input: { id?: string; name: string; rule: Record<string, unknown> }) => api.segments.save({ ...input, match: 'all', rules: [] }), 'Segment saved')
  const errors = builder.rows.map(rowError)
  const serverField = save.error instanceof ApiError ? Object.keys(save.error.fields)[0] ?? '' : ''
  const serverRow = /^rule\.rules\.(\d+)/.exec(serverField)?.[1]
  const update = (next: Builder) => { setBuilder(next); save.reset() }
  const updateRow = (id: string, patch: Partial<Row>) => update({ ...builder, rows: builder.rows.map(row => row.id === id ? { ...row, ...patch } : row) })
  function changeField(row: Row, field: string) {
    if (activity(field) === activity(row.field)) return updateRow(row.id, { field })
    updateRow(row.id, activity(field) ? { field, operator: 'within', value: '30' } : { field, operator: 'eq', value: '' })
  }
  function parseJson(text: string): Record<string, unknown> | null {
    let value: unknown
    try { value = JSON.parse(text) } catch { setJsonError('This isn’t valid JSON. Check the quotes, commas and brackets.'); return null }
    const problem = ruleProblem(value) ?? (ruleSize(value) > 50 ? 'A segment holds at most 50 rules and groups in all.' : null)
    if (problem) { setJsonError(problem); return null }
    setJsonError(''); return value as Record<string, unknown>
  }
  function toggleJson() {
    if (json === null) { setJson(JSON.stringify(fromBuilder(builder), null, 2)); setJsonError(''); return }
    const rule = parseJson(json)
    if (rule) { setBuilder(toBuilder(rule)); setJson(null) }
  }
  async function submit() {
    setChecked(true)
    const rule = json !== null ? parseJson(json) : errors.some(Boolean) ? null : fromBuilder(builder)
    if (!rule || !name.trim()) return
    try {
      const segment = await save.mutateAsync({ id: saved?.id, name: name.trim(), rule })
      setSaved({ id: segment.id, name: segment.name, rule: signature(segment.rule), at: segment.updatedAt }); setChecked(false)
      if (!saved) { onCreated(segment.id); navigate(`/audience/segments/${segment.id}`, { replace: true }) }
    } catch { /* Shown inline. */ }
  }
  // Counts describe the saved rule; say so once the conditions on screen differ from it.
  const ruleChanged = Boolean(saved) && (json !== null ? (() => { try { return signature(JSON.parse(json)) !== saved!.rule } catch { return true } })() : canonical(fromBuilder(builder)) !== saved!.rule)
  return <div className="audience-page"><PageHeader title={saved ? 'Edit segment' : 'Create segment'} backTo="/audience/segments" actions={<Button variant="primary" type="submit" form="segment-editor" loading={save.isPending}>Save segment</Button>} />
    <form id="segment-editor" className="stack audience-editor" noValidate onSubmit={event => { event.preventDefault(); void submit() }}>
      <div className="audience-name"><Field label="Segment name" htmlFor="segment-name" error={checked && !name.trim() ? 'Name this segment, for example “Engaged customers”.' : fieldError(save.error, 'name')}><Input id="segment-name" maxLength={200} value={name} onChange={event => { setName(event.target.value); save.reset() }} /></Field></div>
      <section className="section stack"><SectionHeader title="Conditions" actions={<Button variant="ghost" size="sm" onClick={toggleJson}>{json === null ? <><Braces size={14} aria-hidden="true" />Edit as JSON</> : <><ListFilter size={14} aria-hidden="true" />Use the rule builder</>}</Button>} />
        <p className="muted">A segment narrows a campaign’s list to the people who match these conditions.</p>
        {json === null ? <>
          <div className="cluster"><span>Match</span><Select className="audience-match" aria-label="Match conditions" value={builder.match} onValueChange={value => update({ ...builder, match: value as Builder['match'] })} options={[{ value: 'all', label: 'all of these conditions' }, { value: 'any', label: 'any of these conditions' }]} /></div>
          <div className="audience-conditions" role="group" aria-label="Conditions">
            <div className="audience-condition audience-condition--head" aria-hidden="true"><span>Field</span><span>Condition</span><span>Value</span><span /></div>
            {builder.rows.map((row, index) => { const error = checked && errors[index] || (serverRow === String(index) ? save.error instanceof ApiError ? save.error.fields[serverField] : undefined : undefined), n = index + 1; return <Fragment key={row.id}>
              {row.group ? <div className="audience-condition"><div className="audience-condition-group"><span className="audience-cell-text" title={ruleSummary(row.group)}>{ruleSummary(row.group)}</span><span className="muted">Group of conditions. Edit as JSON to change it.</span></div><IconButton className="audience-condition-remove" label={`Remove condition ${n}`} disabled={builder.rows.length === 1} onClick={() => update({ ...builder, rows: builder.rows.filter(item => item.id !== row.id) })}><X size={16} /></IconButton></div>
                : <div className="audience-condition">
                  <Select className="audience-condition-field" aria-label={`Condition ${n} field`} value={row.field} onValueChange={value => changeField(row, value)} options={fields} />
                  <Select className="audience-condition-operator" aria-label={`Condition ${n} operator`} value={row.operator} onValueChange={value => updateRow(row.id, { operator: value })} options={activity(row.field) ? activityOperators : textOperators} />
                  {activity(row.field) ? <div className="audience-condition-value audience-condition-days"><Input type="number" inputMode="numeric" min={1} max={730} step={1} aria-label={`Condition ${n} days`} aria-invalid={Boolean(error) || undefined} value={row.value} onChange={event => updateRow(row.id, { value: event.target.value })} /><span className="muted">days</span></div>
                    : <Input className="audience-condition-value" aria-label={`Condition ${n} value`} aria-invalid={Boolean(error) || undefined} maxLength={200} value={row.value} onChange={event => updateRow(row.id, { value: event.target.value })} />}
                  <IconButton className="audience-condition-remove" label={`Remove condition ${n}`} disabled={builder.rows.length === 1} onClick={() => update({ ...builder, rows: builder.rows.filter(item => item.id !== row.id) })}><X size={16} /></IconButton>
                </div>}
              {error && <div className="ui-field__hint ui-field__error" role="alert">Condition {n}: {error}</div>}
            </Fragment> })}
          </div>
          <div className="cluster"><Button disabled={builder.rows.length >= MAX_ROWS} onClick={() => update({ ...builder, rows: [...builder.rows, newRow()] })}><Plus size={16} />Add condition</Button><span className="ui-field__hint">{builder.rows.length >= MAX_ROWS ? 'A group holds 10 conditions. Edit as JSON to nest groups.' : 'Is and is not match exact text; contains ignores case. Opened and clicked count tracked campaign email.'}</span></div>
        </> : <Field label="Rule JSON" htmlFor="segment-rule" error={jsonError || (serverField.startsWith('rule') && save.error instanceof ApiError ? save.error.fields[serverField] : undefined)} hint={<>A condition is {'{"field", "operator", "value"}'} (email, firstName, plan, country with eq, neq or contains) or {'{"field", "operator", "days"}'} (lastOpenAt, lastClickAt with within or inactive, 1–730 days). Group them with {'{"operator": "and" | "or", "rules": […]}'}: 10 rules a group, 3 levels, 50 in all.</>}><Textarea id="segment-rule" className="audience-json" rows={14} spellCheck={false} value={json} onChange={event => { setJson(event.target.value); setJsonError(''); save.reset() }} /></Field>}
        <MutationError error={save.error} />
      </section>
      <section className="section stack"><SectionHeader title="Matching contacts" actions={<ListPicker className="audience-count-list" label="Count within list" emptyLabel="All contacts" value={countList} onChange={setCountList} />} />
        {saved ? <SegmentCounts id={saved.id} at={saved.at} listId={countList} stale={ruleChanged} /> : <p className="audience-summary muted">Save the segment to count who matches.</p>}
      </section>
    </form>
  </div>
}
function SegmentCounts({ id, at, listId, stale }: { id: string; at: string; listId: string; stale: boolean }) {
  const query = useApiQuery(['segments', 'preview', id, at, listId], (api, signal) => api.segments.preview({ id, name: '', match: 'all', rules: [], listId: listId || undefined }, signal))
  if (query.isPending) return <LoadingRegion label="Counting matching contacts"><AudienceSummarySkeleton /></LoadingRegion>
  if (query.isError) return query.error instanceof ApiError && query.error.code === 'AUDIENCE_LIMIT_EXCEEDED' ? <p className="audience-summary muted">More than 1,000 contacts match, the most a preview counts. Pick a list to count within it.</p> : <ErrorState error={query.error} onRetry={() => query.refetch()} />
  return <div className="audience-summary cluster"><span><strong>{number(query.data.matched)}</strong> match</span><span>{number(query.data.eligible)} can receive campaigns</span><span className="muted">{number(query.data.unsubscribed)} not subscribed</span><span className="muted">{number(query.data.suppressed)} suppressed</span>{stale && <span className="muted">Counts are for the saved conditions. Save to update them.</span>}</div>
}
