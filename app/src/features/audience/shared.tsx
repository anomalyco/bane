import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { useApiDef, useApiQuery } from '../../data/context'
import { queries } from '../../data/queries'
import { ApiError, type AudienceList, type Contact } from '../../data/types'
import { Alert, DataTable, ErrorText, Input, SkeletonText, StatusBadge } from '../../components/ui'
import { contactColumns, memberColumns } from './skeletons'
import { date as formatDate, number } from '../../lib/format'
import { PrivateAddress } from '../../components/PrivateAddress'
import { consentTitle } from './consent'

export const pageSize = 8
export const date = (value: string | null) => value ? formatDate(value) : 'Never'
export { number }
export { ConsentLegend, consentHelp, consentTitle, statusOptions } from './consent'
export function fieldError(error: unknown, field: string) { return error instanceof ApiError ? error.fields[field] : undefined }
export function MutationError({ error }: { error: unknown }) { return error ? <Alert tone="danger"><ErrorText error={error} fallback="Couldn’t complete the request." /></Alert> : null }
export function useAudienceLists(search = '', cursor?: string) {
  return useApiDef(queries.audienceLists(search, cursor), { keepPrevious: true })
}
/** A quoted AudienceQL string literal. */
export const aqlString = (value: string) => `'${value.replaceAll("'", "''")}'`

// One control to find and choose a list by name: type to search, arrows and Enter to choose. The first option is
// `emptyLabel` (all lists, or no list). Lists are never shown by ID.
export function ListPicker({ value, onChange, emptyLabel, id, label, disabled = false, className, 'aria-describedby': describedBy }: { value: string; onChange: (id: string) => void; emptyLabel: string; id?: string; label?: string; disabled?: boolean; className?: string; 'aria-describedby'?: string }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [active, setActive] = useState(0)
  const listbox = useId(), menu = useRef<HTMLDivElement>(null)
  const all = useAudienceLists(), found = useAudienceLists(search.trim())
  const options = open && search.trim() ? found : all
  const known = all.data?.find(list => list.id === value)
  const selected = useApiQuery(['lists', value], (api, signal) => api.lists.get(value, signal), { enabled: Boolean(value) && !all.isPending && !known })
  const name = value ? known?.name ?? selected.data?.name : ''
  const items: { id: string; name: string }[] = [{ id: '', name: emptyLabel }, ...(options.data ?? [])]
  const activeIndex = Math.min(active, items.length - 1)
  // Escape closes the open options, not the dialog around the picker: dialogs listen on the document in the capture
  // phase, so this listens on the window, which comes first.
  useEffect(() => {
    if (!open) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.isComposing) { event.stopPropagation(); event.preventDefault(); setOpen(false); setSearch('') } }
    window.addEventListener('keydown', close, { capture: true })
    return () => window.removeEventListener('keydown', close, { capture: true })
  }, [open])
  function choose(next: string) { setOpen(false); setSearch(''); if (next !== value) onChange(next) }
  function show() { if (disabled || open) return; setOpen(true); setSearch(''); setActive(Math.max(0, items.findIndex(item => item.id === value))) }
  function move(step: number) { const next = (activeIndex + step + items.length) % items.length; setActive(next); menu.current?.querySelectorAll('[role="option"]')[next]?.scrollIntoView({ block: 'nearest' }) }
  return <div className={className ? `audience-list-picker ${className}` : 'audience-list-picker'} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) { setOpen(false); setSearch('') } }}>
    <Input id={id} role="combobox" aria-label={label} aria-describedby={describedBy} aria-expanded={open} aria-controls={open ? listbox : undefined} aria-autocomplete="list" aria-activedescendant={open ? `${listbox}-${activeIndex}` : undefined} autoComplete="off" spellCheck={false} disabled={disabled}
      placeholder={open ? 'Search lists by name' : value && !name ? (selected.isError ? 'List not found' : 'Loading list…') : emptyLabel} value={open ? search : name ?? ''}
      onFocus={show} onClick={show} onChange={event => { setSearch(event.target.value); setActive(event.target.value.trim() ? 1 : 0); setOpen(true) }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (!open) show(); else move(event.key === 'ArrowDown' ? 1 : -1) }
        else if (event.key === 'Enter' && open) { event.preventDefault(); if (items[activeIndex]) choose(items[activeIndex].id) }
        else if (event.key === 'Tab') { setOpen(false); setSearch('') }
      }} />
    <ChevronDown size={14} aria-hidden="true" />
    {open && <div ref={menu} id={listbox} role="listbox" aria-label={label ?? 'Lists'} className="ui-popover audience-list-options"><div className="ui-popover-scroll">
      {items.map((item, index) => <button key={item.id || 'none'} id={`${listbox}-${index}`} type="button" role="option" tabIndex={-1} aria-selected={index === activeIndex} data-current={item.id === value || undefined} className="audience-list-option" onPointerMove={() => setActive(index)} onMouseDown={event => event.preventDefault()} onClick={() => choose(item.id)}><span>{item.name}</span>{item.id === value && <Check size={14} aria-hidden="true" />}</button>)}
      {options.isPending ? <div className="audience-list-note" role="status">Loading lists…</div> : options.isError ? <div className="audience-list-note" role="alert">Couldn’t load lists. Close and reopen to try again.</div> : search.trim() && !options.data.length ? <div className="audience-list-note">No list named “{search.trim()}”.</div> : options.data.nextCursor ? <div className="audience-list-note">More lists exist. Type to narrow them down.</div> : null}
    </div></div>}
  </div>
}

export function ContactTable({ contacts, lists = [], members = false, loading = false, minRows = pageSize, listsLoading = false, tableRef, empty }: { contacts: Contact[]; lists?: AudienceList[]; members?: boolean; loading?: boolean; minRows?: number; listsLoading?: boolean; tableRef?: (node: HTMLDivElement | null) => void; empty?: ReactNode }) {
  const columns = members ? memberColumns : contactColumns
  return <DataTable tableRef={tableRef} rows={contacts} loading={loading} skeletonRows={minRows} minRows={minRows} rowKey={row => row.id} rowHref={row => `/audience/contacts/${row.id}`} empty={empty} columns={columns.map(column => ({ ...column, cardRender: column.key === 'name' ? (row: Contact) => row.name || 'No name' : column.key === 'created' ? (row: Contact) => `Added ${date(row.createdAt)}` : undefined, render: (row: Contact) => {
    if (column.key === 'email') return <span className="audience-cell-text"><PrivateAddress value={row.email} /></span>
    if (column.key === 'status') return <span title={consentTitle(row.status)}><StatusBadge status={row.status} /></span>
    if (column.key === 'suppression') return <span className="audience-cell-text" title={row.suppressionReason || undefined}>{row.suppressionReason || '—'}</span>
    if (column.key === 'name') return <span className="audience-cell-text" title={row.name}>{row.name || '—'}</span>
    if (column.key === 'lists') {
      if (listsLoading && row.listIds.length) return <SkeletonText width="70%" />
      const names = row.listIds.map(id => lists.find(list => list.id === id)?.name).filter(Boolean).join(', ')
      const unnamed = row.listIds.length - (names ? names.split(', ').length : 0)
      const text = names ? unnamed ? `${names} +${unnamed}` : names : unnamed ? `${unnamed} list${unnamed === 1 ? '' : 's'}` : '—'
      return <span className="audience-cell-text" title={text}>{text}</span>
    }
    return date(row.createdAt)
  } }))} />
}

// A segment's public rule (API SegmentRule) as one readable line: `Country is DE`, `Not opened in 90 days`,
// `Plan is pro and (Country is DE or Country is FR)`.
type PublicRule = { field?: string; operator?: string; value?: unknown; days?: unknown; rules?: PublicRule[] }
const ruleFields: Record<string, string> = { email: 'Email', firstName: 'First name', plan: 'Plan', country: 'Country' }
export function ruleSummary(rule: unknown, nested = false): string {
  const r = (rule ?? {}) as PublicRule
  if (Array.isArray(r.rules)) {
    const parts = r.rules.map(child => ruleSummary(child, true))
    const text = parts.join(r.operator === 'or' ? ' or ' : ' and ')
    return nested && parts.length > 1 ? `(${text})` : text || 'Everyone'
  }
  if (r.field === 'lastOpenAt' || r.field === 'lastClickAt') {
    const verb = r.field === 'lastOpenAt' ? 'opened' : 'clicked', days = number(Number(r.days))
    return r.operator === 'inactive' ? `Not ${verb} in ${days} days` : `${verb[0].toUpperCase()}${verb.slice(1)} in the last ${days} days`
  }
  const op = r.operator === 'neq' ? 'is not' : r.operator === 'contains' ? 'contains' : 'is'
  return `${ruleFields[r.field ?? ''] ?? r.field ?? 'Value'} ${op} ${String(r.value ?? '')}`
}
