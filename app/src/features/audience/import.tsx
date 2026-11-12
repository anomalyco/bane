import { useState } from 'react'
import { Link } from 'react-router'
import { useApiMutation } from '../../data/context'
import type { ImportPreview } from '../../data/types'
import { Alert, Button, Checkbox, DataTable, Dialog, Field, Input, Select } from '../../components/ui'
import { PrivateAddress } from '../../components/PrivateAddress'
import { fieldError, ListPicker, MutationError, number } from './shared'
import { parseCsv } from './csv'

// Columns the API imports, plus Last name, which only feeds Full name (the API has no last-name field). Headings are
// matched without case, spaces, dashes or underscores, so `first_name`, `First Name` and `firstname` all map.
const targets = [
  { value: 'email', label: 'Email (required)', aliases: ['email', 'emailaddress', 'mail'] },
  { value: 'name', label: 'Full name', aliases: ['name', 'fullname', 'contactname'] },
  { value: 'firstName', label: 'First name', aliases: ['firstname', 'first', 'givenname', 'forename'] },
  { value: 'lastName', label: 'Last name', aliases: ['lastname', 'last', 'surname', 'familyname'] },
  { value: 'plan', label: 'Plan', aliases: ['plan', 'tier'] },
  { value: 'country', label: 'Country', aliases: ['country', 'countrycode'] },
]
const COMBINED = '\u0000first-last'
const MAX_ROWS = 50_000
const sample = 'email,name,first_name,plan,country\nada@example.com,Ada Lovelace,Ada,pro,GB\ngrace@example.com,Grace Hopper,Grace,free,US\n'
const sampleHref = `data:text/csv;charset=utf-8,${encodeURIComponent(sample)}`
const quote = (value: string) => /[",\r\n]|^\s|\s$/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
const plural = (count: number, word: string) => `${number(count)} ${word}${count === 1 ? '' : 's'}`

// Full name from first and last name: the CSV gets one more column holding "first last" (a contact without either
// keeps no name). Blank rows are skipped exactly as the API skips them, so row numbers in the preview still match the file.
function withFullName(csv: string, mapping: Record<string, string>, headers: string[]) {
  const [header, ...data] = parseCsv(csv)
  let column = 'Full name'
  for (let n = 2; headers.includes(column); n++) column = `Full name (${n})`
  const first = headers.indexOf(mapping.firstName), last = headers.indexOf(mapping.lastName)
  const join = (row: string[]) => [first >= 0 ? row[first] : '', last >= 0 ? row[last] : ''].map(value => value?.trim() ?? '').filter(Boolean).join(' ')
  return { csv: [[...header, column], ...data.map(row => [...row, join(row)])].map(row => row.map(quote).join(',')).join('\n'), column }
}

export function ImportContactsDialog({ listId: initialListId = '', onClose }: { listId?: string; onClose: () => void }) {
  const [listId, setListId] = useState(initialListId)
  const [csv, setCsv] = useState(''), [headers, setHeaders] = useState<string[]>([])
  const [mapping, setMapping] = useState<Record<string, string>>({}), [fileError, setFileError] = useState<unknown>(null), [reading, setReading] = useState(false)
  const [consent, setConsent] = useState(false), [evidence, setEvidence] = useState(''), [checked, setChecked] = useState(false)
  const [preview, setPreview] = useState<ImportPreview | null>(null), [result, setResult] = useState<ImportPreview | null>(null)
  const review = useApiMutation((api, input: { csv: string; mapping: Record<string, string>; listId?: string }) => api.imports.preview(input), undefined, false, false)
  const commit = useApiMutation((api, input: { id: string; evidence?: string }) => api.imports.commit(input.id, input.evidence ? { consent: { status: 'subscribed', evidence: input.evidence } } : undefined))
  function resetPreview() { setPreview(null); review.reset(); commit.reset() }
  async function readFile(file?: File) {
    if (!file) return
    resetPreview(); setCsv(''); setHeaders([]); setFileError(null); setReading(true)
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('This file is larger than 5 MiB. Split it into smaller files.')
      const raw = await file.text(), rows = parseCsv(raw), heading = rows[0].map(h => h.trim())
      if (rows.length - 1 > MAX_ROWS) throw new Error(`This file has ${number(rows.length - 1)} rows. Import at most ${number(MAX_ROWS)} at a time.`)
      if (heading.some(h => !h)) throw new Error('Every column needs a heading in the first row.')
      if (new Set(heading).size !== heading.length) throw new Error('Give every column a different heading in the first row.')
      setCsv(raw); setHeaders(heading)
      const detected = Object.fromEntries(targets.map(target => [target.value, heading.find(h => target.aliases.includes(h.toLowerCase().replace(/[ _-]/g, ''))) ?? '']))
      if (!detected.name && (detected.firstName || detected.lastName)) detected.name = COMBINED
      setMapping(detected)
    } catch (cause) { setFileError(cause) } finally { setReading(false) }
  }
  async function submitPreview() {
    const selected = Object.fromEntries(Object.entries(mapping).filter(([key, value]) => value && key !== 'lastName' && value !== COMBINED))
    let input = { csv, mapping: selected }
    if (mapping.name === COMBINED) {
      try { const derived = withFullName(csv, mapping, headers); input = { csv: derived.csv, mapping: { ...selected, name: derived.column } } } catch (cause) { setFileError(cause); return }
    }
    try { setPreview(await review.mutateAsync({ ...input, ...(listId ? { listId } : {}) })) } catch { /* Shown inline. */ }
  }
  async function submitImport() {
    setChecked(true)
    if (!preview || (consent && !evidence.trim())) return
    try { setResult(await commit.mutateAsync({ id: preview.id, evidence: consent ? evidence.trim() : undefined })) } catch { /* Shown inline. */ }
  }
  const busy = reading || review.isPending || commit.isPending
  const locked = busy || Boolean(preview)
  const combinedAvailable = Boolean(mapping.firstName || mapping.lastName || mapping.name === COMBINED)
  const error = fileError || review.error || commit.error
  const unknownHref = listId ? `/audience/lists/${listId}?status=unknown` : '/audience?status=unknown'
  if (result) {
    const imported = result.imported, subscribed = result.subscribed ?? 0
    return <Dialog open onOpenChange={open => { if (!open) onClose() }} title="Import complete" footer={<>{!consent && imported > 0 && <Link className="ui-button ui-button--secondary ui-button--md" to={unknownHref} onClick={onClose}>Review Unknown contacts</Link>}<Button variant="primary" onClick={onClose}>Done</Button></>}><div className="stack">
      <Alert tone="success">{plural(imported, 'contact')} imported{consent ? ` · ${number(subscribed)} marked subscribed` : ''}.</Alert>
      {consent ? subscribed < imported && <p className="muted">{plural(imported - subscribed, 'contact')} already had a consent decision, which was kept: opt-outs and suppressions never change on import.</p>
        : imported > 0 && <Alert tone="info">They can’t receive campaigns yet because they have no recorded consent. Once you have their agreement, choose Review Unknown contacts, then Mark as subscribed.</Alert>}
      {result.errors.length > 0 && <RejectedRows errors={result.errors} skipped />}
    </div></Dialog>
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }} title="Import contacts" footer={<><Button disabled={busy} onClick={onClose}>Cancel</Button>{preview ? <Button variant="primary" loading={commit.isPending} disabled={busy || !preview.rows.length} onClick={() => void submitImport()}>{preview.rows.length ? `Import ${plural(preview.rows.length, 'contact')}` : 'Nothing to import'}</Button> : <Button variant="primary" loading={busy} disabled={!csv || !mapping.email} onClick={() => void submitPreview()}>Preview import</Button>}</>}>
    <div className="stack">
      <Field label="Destination list" htmlFor="import-list" hint={listId ? undefined : 'Optional. Contacts are added to your audience either way.'}><ListPicker id="import-list" emptyLabel="No list" value={listId} disabled={locked} onChange={value => { setListId(value); resetPreview() }} /></Field>
      <Field label="CSV file" htmlFor="import-file" hint={<>Columns: email (required); name, first name, last name, plan and country (optional). Up to {number(MAX_ROWS)} rows and 5 MiB. <a href={sampleHref} download="contacts-sample.csv">Download a sample CSV</a></>}><Input type="file" id="import-file" accept=".csv,text/csv" disabled={locked} onChange={event => void readFile(event.target.files?.[0])} /></Field>
      {csv && <div className="form-grid">{targets.map(target => <Field key={target.value} label={target.label} htmlFor={`map-${target.value}`} error={fieldError(review.error, `mapping.${target.value}`)} hint={target.value === 'lastName' ? mapping.name === COMBINED ? 'Joined with First name into Full name.' : 'Used only when Full name is First + last name.' : target.value === 'name' && mapping.name === COMBINED ? 'Each contact’s first and last name, joined.' : undefined}>
        <Select id={`map-${target.value}`} disabled={locked} value={mapping[target.value] ?? ''} onValueChange={value => { setMapping({ ...mapping, [target.value]: value }); resetPreview() }} options={[{ value: '', label: 'Do not import' }, ...(target.value === 'name' && combinedAvailable ? [{ value: COMBINED, label: 'First + last name' }] : []), ...headers.map(header => ({ value: header, label: header }))]} />
      </Field>)}</div>}
      <div className="audience-consent">
        <Checkbox checked={consent} disabled={busy} onCheckedChange={value => { setConsent(value); setChecked(false) }} label="These people agreed to receive marketing email" />
        <p className="ui-field__hint">{consent ? 'Everyone imported without a consent decision is marked subscribed. People who opted out or are suppressed stay that way.' : 'Without this, imported contacts can’t receive campaigns until they’re marked subscribed.'}</p>
        {consent && <Field label="How did they agree?" htmlFor="import-evidence" error={checked && !evidence.trim() ? 'Say how they agreed, for example “Signed up on our website”.' : fieldError(commit.error, 'consent.evidence')} hint="Saved with each person’s consent record, for example “Signed up on our website”."><Input id="import-evidence" autoFocus maxLength={2000} disabled={busy} value={evidence} onChange={event => setEvidence(event.target.value)} /></Field>}
      </div>
      {preview && <>
        <div className="cluster audience-review-bar"><span className="muted">Fields are locked while you review. Change mapping to edit them.</span><Button size="sm" disabled={busy} onClick={resetPreview}>Change mapping</Button></div>
        {preview.rows.length > 0 && <><DataTable rows={preview.rows.slice(0, 10)} rowKey={row => String(row.row)} columns={[{ key: 'row', label: 'Row', width: '16%', render: row => row.row }, { key: 'email', label: 'Email', width: '50%', render: row => <span className="audience-cell-text"><PrivateAddress value={row.email} /></span> }, { key: 'name', label: 'Full name', width: '34%', render: row => <span className="audience-cell-text" title={row.name}>{row.name || '—'}</span> }]} />
          <span className="muted">{plural(preview.rows.length, 'valid row')}{preview.rows.length > 10 ? ' · showing the first 10' : ''}</span></>}
        {preview.errors.length > 0 && <RejectedRows errors={preview.errors} />}
      </>}
      <MutationError error={error} />
    </div>
  </Dialog>
}

function RejectedRows({ errors, skipped = false }: { errors: ImportPreview['errors']; skipped?: boolean }) {
  return <Alert tone="warning" title={`${plural(errors.length, 'row')} ${skipped ? 'skipped' : 'will be skipped'}`}>{errors.slice(0, 10).map((issue, index) => <div key={index}>Row {issue.row}: {issue.message}</div>)}{errors.length > 10 && <div>and {number(errors.length - 10)} more</div>}</Alert>
}
