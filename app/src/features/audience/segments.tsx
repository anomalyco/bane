import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { Plus, X } from 'lucide-react'
import { useApiMutation, useApiQuery, useApi } from '../../data/context'
import type { SegmentInput, SegmentRule } from '../../data/types'
import { SearchField, Button, ControlSkeleton, DataTable, ErrorState, Field, Input, LoadingRegion, PageHeader, Pagination, PaginationSkeleton, SectionHeader, Select } from '../../components/ui'
import { AudienceRouteSkeleton, AudienceSummarySkeleton, segmentColumns } from './skeletons'
import { ContactTable, date, fieldError, MutationError, number, pageSize, statusOptions, useAudienceLists } from './shared'
import { useAdaptivePageSize } from '../../lib/pagination'
import { AudienceHeader } from './header'
import { LiveSegmentRoute, LiveSegmentsPage, SegmentsEmpty } from './segments-live'

// Demo mode keeps the earlier segment model (status, country, list and last-opened rules) that its sample data and
// campaign audiences use; live mode edits the API's public rule in segments-live.tsx.

function DemoSegmentsPage() {
  const { pageSize: adaptivePageSize, tableRef } = useAdaptivePageSize()
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const navigate = useNavigate()
  useEffect(() => setPage(1), [adaptivePageSize])
  const params = { search, page, pageSize: adaptivePageSize }
  const query = useApiQuery(['segments', params], (api, signal) => api.segments.list(params, signal))
  return <div className="audience-page"><AudienceHeader actions={<Button variant="primary" onClick={() => navigate('/audience/segments/new')}>Create segment</Button>} /><div className="data-toolbar"><SearchField className="search-box--list" aria-label="Search segments" placeholder="Search segments" value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} /></div>
    {query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <><DataTable tableRef={tableRef} rows={query.data?.items || []} loading={query.isPending} skeletonRows={adaptivePageSize} minRows={adaptivePageSize} rowKey={row => row.id} empty={<SegmentsEmpty search={search} onClear={() => { setSearch(''); setPage(1) }} />} columns={[{ ...segmentColumns[0], render: row => <Link className="audience-cell-text" title={row.name} to={`/audience/segments/${row.id}`}>{row.name}</Link> }, { ...segmentColumns[1], render: row => `${row.rules.length} · match ${row.match}` }, { ...segmentColumns[2], render: row => number(row.matched) }, { ...segmentColumns[3], render: row => number(row.eligible) }, { ...segmentColumns[4], render: row => date(row.updatedAt) }]} />{query.isPending ? <PaginationSkeleton /> : <Pagination page={page} pageSize={adaptivePageSize} total={query.data.total} nextCursor={query.data.nextCursor} onPageChange={setPage} />}</>}
  </div>
}
function DemoSegmentEditorPage() {
  const { id } = useParams()
  return id ? <ExistingSegment key={id} id={id} /> : <SegmentEditor key="new" initial={{ name: '', match: 'all', rules: [newRule()] }} />
}
function ExistingSegment({ id }: { id: string }) {
  const query = useApiQuery(['segments', id], (api, signal) => api.segments.get(id, signal))
  return query.isPending ? <AudienceRouteSkeleton kind="segment" /> : query.isError ? <><PageHeader title="Segment" backTo="/audience/segments" /><ErrorState error={query.error} onRetry={() => query.refetch()} /></> : <SegmentEditor initial={{ id: query.data.id, name: query.data.name, match: query.data.match, rules: query.data.rules }} />
}
function newRule(): SegmentRule { return { id: crypto.randomUUID(), field: 'status', operator: 'is', value: 'subscribed' } }
const fields = [{ value: 'status', label: 'Subscription status' }, { value: 'country', label: 'Country' }, { value: 'listId', label: 'List membership' }, { value: 'lastOpenedAt', label: 'Last opened' }]
function SegmentEditor({ initial }: { initial: SegmentInput }) {
  const [input, setInput] = useState<SegmentInput>(initial)
  const [preview, setPreview] = useState<SegmentInput | null>(null)
  const navigate = useNavigate()
  const lists = useAudienceLists()
  const save = useApiMutation((api, value: SegmentInput) => api.segments.save(value), 'Segment saved')
  const change = (next: SegmentInput) => { setInput(next); setPreview(null) }
  const updateRule = (id: string, patch: Partial<SegmentRule>) => change({ ...input, rules: input.rules.map(rule => rule.id === id ? { ...rule, ...patch } : rule) })
  const valid = input.rules.length > 0 && input.rules.every(rule => rule.value.trim() && (rule.field !== 'lastOpenedAt' || Number(rule.value) > 0))
  async function submit() {
    try { const segment = await save.mutateAsync(input); navigate(`/audience/segments/${segment.id}`, { replace: true }) } catch { /* Shown inline. */ }
  }
  return <div className="audience-page"><PageHeader title={initial.id ? 'Edit segment' : 'Create segment'} backTo="/audience/segments" actions={<Button variant="primary" type="submit" form="segment-editor" loading={save.isPending}>Save segment</Button>} />
    <form id="segment-editor" className="stack audience-editor" onSubmit={event => { event.preventDefault(); void submit() }}>
      <MutationError error={save.error} />
      <Field label="Segment name" htmlFor="segment-name" error={fieldError(save.error, 'name')}><Input id="segment-name" className="audience-name" required value={input.name} onChange={event => change({ ...input, name: event.target.value })} /></Field>
      <section className="section stack"><SectionHeader title="Conditions" /><div className="cluster"><span>Match</span><Select className="audience-match" aria-label="Match conditions" value={input.match} onValueChange={value => change({ ...input, match: value as 'all' | 'any' })} options={[{ value: 'all', label: 'All conditions (AND)' }, { value: 'any', label: 'Any condition (OR)' }]} /></div>
        {lists.isError && <ErrorState error={lists.error} onRetry={() => lists.refetch()} />}
        {input.rules.map((rule, index) => <div className="audience-rule" key={rule.id}>
          <Field label="Property" htmlFor={`rule-field-${rule.id}`}><Select id={`rule-field-${rule.id}`} value={rule.field} onValueChange={value => updateRule(rule.id, { field: value as SegmentRule['field'], operator: value === 'lastOpenedAt' ? 'within_days' : 'is', value: value === 'status' ? 'subscribed' : value === 'lastOpenedAt' ? '30' : '' })} options={fields} /></Field>
          <Field label="Operator" htmlFor={`rule-operator-${rule.id}`}><Select id={`rule-operator-${rule.id}`} value={rule.operator} onValueChange={value => updateRule(rule.id, { operator: value as SegmentRule['operator'] })} options={rule.field === 'lastOpenedAt' ? [{ value: 'within_days', label: 'Within the last' }] : [{ value: 'is', label: 'Is' }, { value: 'is_not', label: 'Is not' }]} /></Field>
          <Field label={rule.field === 'lastOpenedAt' ? 'Days' : 'Value'} htmlFor={`rule-value-${rule.id}`} hint={rule.field === 'country' ? 'Two-letter code, e.g. US.' : undefined} error={fieldError(save.error, `rules.${index}.value`) || fieldError(save.error, `rules.${index}`)}>{rule.field === 'status' ? <Select id={`rule-value-${rule.id}`} value={rule.value} onValueChange={value => updateRule(rule.id, { value })} options={statusOptions} /> : rule.field === 'listId' ? lists.isPending ? <LoadingRegion label="Loading list options"><ControlSkeleton /></LoadingRegion> : <Select id={`rule-value-${rule.id}`} value={rule.value} onValueChange={value => updateRule(rule.id, { value })} options={[{ value: '', label: 'Choose a list' }, ...(lists.data || []).map(list => ({ value: list.id, label: list.name }))]} /> : <Input id={`rule-value-${rule.id}`} required type={rule.field === 'lastOpenedAt' ? 'number' : 'text'} min={rule.field === 'lastOpenedAt' ? 1 : undefined} max={rule.field === 'lastOpenedAt' ? 3650 : undefined} maxLength={rule.field === 'country' ? 2 : undefined} step={rule.field === 'lastOpenedAt' ? 1 : undefined} placeholder={rule.field === 'country' ? 'Country' : undefined} value={rule.value} onChange={event => updateRule(rule.id, { value: event.target.value })} />}</Field>
          <Button aria-label={`Remove condition ${index + 1}`} className="audience-rule-remove" variant="ghost" onClick={() => change({ ...input, rules: input.rules.filter(item => item.id !== rule.id) })}><X size={16} /></Button>
        </div>)}
        <div className="cluster"><Button onClick={() => change({ ...input, rules: [...input.rules, newRule()] })}><Plus size={16} />Add condition</Button><Button disabled={!valid} onClick={() => setPreview({ ...input, name: input.name || 'Audience preview' })}>Preview audience</Button></div>
      </section>
    </form>
    {preview && <SegmentPreview input={preview} />}
  </div>
}
function SegmentPreview({ input }: { input: SegmentInput }) {
  const query = useApiQuery(['segments', 'preview', input], (api, signal) => api.segments.preview(input, signal))
  return <section className="section"><SectionHeader title="Audience preview" />{query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : <>{query.isPending ? <LoadingRegion label="Loading audience counts"><AudienceSummarySkeleton /></LoadingRegion> : <div className="audience-summary cluster"><span>{number(query.data.matched)} matched</span><span>{number(query.data.eligible)} eligible</span><span className="muted">{number(query.data.suppressed)} suppressed</span><span className="muted">{number(query.data.unsubscribed)} unsubscribed</span></div>}<ContactTable contacts={query.data?.contacts || []} members loading={query.isPending} minRows={pageSize} /></>}</section>
}

export function SegmentsPage() {
  const api = useApi()
  return api.mode === 'demo' ? <DemoSegmentsPage /> : <LiveSegmentsPage />
}
export function SegmentEditorPage() {
  const api = useApi()
  return api.mode === 'demo' ? <DemoSegmentEditorPage /> : <LiveSegmentRoute />
}
