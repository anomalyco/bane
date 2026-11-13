import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Copy } from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Alert, Button, CopyButton, DataTable, DropdownMenu, StatusBadge, useToast } from '../../components/ui'
import { CopyAction, LiveStatus, type LiveState } from '../../components/motion'
import { useApi, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import { useRefreshListsOnChange } from '../../data/invalidation'
import { request } from '../../data/live'
import type { DnsRecord, DnsRecordPurpose, Domain, ReceivingIssue } from '../../data/types'
import { settingsColumns } from './skeletons'
import { receivingIssueTitle } from './receiving-issue-title'
import './settings.css'
import './domain-records.css'
import { expectAccount } from '../../data/accounts'

// Hosted reads are DB-only, so poll briskly while visible; self-hosted reads call SES and stay slow.
export function useDomain(id: string, recheckUntil = 0) {
  const api = useApi()
  const { multiTenant } = useWorkspaceAccess()
  const query = useQuery({
    queryKey: ['bane', api.mode, ...queries.domain(id).key],
    queryFn: ({ signal }) => queries.domain(id).read(api, signal),
    refetchInterval: query => query.state.status === 'error' ? false : query.state.data?.status === 'pending' || query.state.data?.mailFromStatus === 'pending' || (multiTenant && Date.now() < recheckUntil) ? multiTenant ? 3000 : 60_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: multiTenant ? 'always' : false,
  })
  // The cached Domains list must not keep showing the status the poll has just moved past.
  useRefreshListsOnChange('domains', query.data && `${query.data.status}/${query.data.mailFromStatus}`)
  return query
}

export type DnsSetup = { provider: { id: string; name: string } | null; applyUrl: string | null; groups: string[] }
// Off until DNS providers host Bane's Domain Connect template (none do yet), so the records never wait on
// discovery that can only fail. DnsWaitNote says why there is no one-click button. Flip once a provider ships it.
const oneClickDns = false
// Domain Connect: the provider's one-click consent URL, when the domain's DNS host supports it.
// Fetched once per page. Callers hold the records back while it is pending (the API bounds discovery
// to about three seconds), and the answer is fixed at reveal, so the button never appears above
// records that are already on screen.
export function useDnsSetup(domain: Domain | undefined) {
  const api = useApi()
  const { multiTenant, canAdminister } = useWorkspaceAccess()
  const needed = !!domain && domain.records.some(record => record.purpose !== 'dmarc' && record.status !== 'verified')
  const enabled = oneClickDns && api.mode !== 'demo' && multiTenant && canAdminister && needed
  const query = useQuery({
    queryKey: ['bane', api.mode, 'domain', domain?.id, 'dns-setup'],
    queryFn: ({ signal }) => request<DnsSetup>(`/v1/domains/${encodeURIComponent(domain!.id)}/dns-setup`, { signal }),
    // gcTime 0: each page asks afresh, since pending groups change between onboarding and the domain page.
    enabled, retry: false, staleTime: Infinity, gcTime: 0, refetchOnWindowFocus: false,
  })
  const id = domain?.id
  const [timedOut, setTimedOut] = useState<string>()
  useEffect(() => { if (!enabled || !id) return; const timer = setTimeout(() => setTimedOut(id), 4000); return () => clearTimeout(timer) }, [enabled, id])
  const pending = !!domain && enabled && query.isPending && timedOut !== id
  // Decided once per domain, so moving between domains never reuses another domain's link.
  const decided = useRef<{ id: string; setup: DnsSetup | null }>(undefined)
  if (domain && !pending && decided.current?.id !== domain.id) decided.current = { id: domain.id, setup: query.data?.applyUrl && query.data.provider ? query.data : null }
  const current = decided.current
  return { pending: !domain || pending, setup: current && current.id === id ? current.setup : null }
}

// Navigates this tab: providers refuse to be framed, and they return to /domains/<id> when done.
function DnsConnect({ setup, open }: { setup: DnsSetup; open: boolean }) {
  return <div className="dns-connect" data-hidden={!open || undefined} inert={!open}>
    <a className="ui-button ui-button--primary ui-button--md" href={setup.applyUrl!} rel="noopener" onClick={expectAccount}>Configure DNS with {setup.provider!.name}<ArrowRight size={16} aria-hidden /></a>
    <p className="muted">Or add the records below yourself.</p>
  </div>
}

// Records saved before purposes split into sending and receiving may still say dkim or ownership.
const purposeOf = (record: DnsRecord): DnsRecordPurpose => {
  const purpose = record.purpose as string | undefined
  return purpose === 'dkim' || purpose === 'ownership' ? 'sending' : record.purpose ?? (record.type === 'CNAME' ? 'sending' : 'mail_from')
}
export const recordsFor = (domain: Domain, purpose: DnsRecordPurpose) => domain.records.filter(record => purposeOf(record) === purpose)
export function domainState(domain: Domain) {
  return domain.status === 'verified' ? { status: 'Verified', tone: 'success' as const } : domain.status === 'issue' ? { status: 'Failed', tone: 'danger' as const } : { status: 'Pending', tone: 'warning' as const }
}
const allVerified = (records: DnsRecord[]) => records.length > 0 && records.every(record => record.status === 'verified')
// Shown relative to the zone, as most DNS providers ask for it; copying gives the full name.
const relativeHost = (name: string, domain: string) => name === domain ? '@' : name.endsWith(`.${domain}`) ? name.slice(0, -domain.length - 1) : name
const fqdn = (name: string) => name.endsWith('.') ? name : `${name}.`
export function zoneLines(records: DnsRecord[]) {
  return records.map(record => {
    const value = record.type === 'TXT' ? `"${record.value.replace(/"/g, '\\"')}"`
      : record.type === 'MX' ? record.value.replace(/(\S+)$/, target => fqdn(target))
      : fqdn(record.value)
    return `${fqdn(record.name)}\t3600\tIN\t${record.type}\t${value}`
  }).join('\n')
}

// On a phone each record is a card: name and value on one line each, and Copy in the row's action sheet. A copy
// button inside a card's 20 px line would clip it and the wrapped value under it.
export function DnsRecordTable({ domain, records, status }: { domain: string; records: DnsRecord[]; status?: string }) {
  const toast = useToast()
  const copy = async (value: string, what: string) => {
    try { await navigator.clipboard.writeText(value); toast(`Copied ${what}`, 'success') }
    catch { toast('Couldn’t copy to clipboard.', 'error') }
  }
  return <DataTable className="domain-records" rows={records} rowKey={record => record.id} columns={[
    { ...settingsColumns.dns[0], render: record => record.type },
    { ...settingsColumns.dns[1], width: '36%', render: record => <div className="settings-copy-cell"><code title={record.name}>{breakable(relativeHost(record.name, domain))}</code><CopyButton value={record.name} label={`Copy full ${record.type} name`} /></div>, cardRender: record => <code>{breakable(relativeHost(record.name, domain))}</code> },
    { ...settingsColumns.dns[2], render: record => record.value ? <div className="settings-copy-cell"><code title={record.value}>{breakable(record.value)}</code><CopyButton value={record.value} label={`Copy ${record.type} value`} /></div> : '—', cardRender: record => record.value ? <code>{breakable(record.value)}</code> : '—' },
    { key: 'status', label: 'Status', width: 136, card: 'aside', render: record => <StatusBadge status={status ?? (record.status === 'verified' ? 'Verified' : 'Pending')} /> },
    { key: 'copy', label: '', card: 'end', table: false, render: record => <DropdownMenu label={`Copy ${record.type} record`} title={`${record.type} ${relativeHost(record.name, domain)}`} items={[
      { label: 'Copy full name', icon: <Copy size={16} />, onSelect: () => void copy(record.name, 'name') },
      { label: 'Copy value', icon: <Copy size={16} />, disabled: !record.value, onSelect: () => void copy(record.value, 'value') },
    ]} /> },
  ]} />
}

// What the two alignments mean together: DMARC passes when either one aligns, so one "not aligned" is often fine.
function dmarcVerdict(dkim: boolean, spf: boolean) {
  if (dkim && spf) return 'Both align, so mail from this domain passes DMARC. Nothing to do.'
  if (dkim) return 'DMARC passes through DKIM. To align SPF too, set a custom MAIL FROM domain under Advanced.'
  if (spf) return 'DMARC passes through SPF. Publish the DKIM records above to align DKIM too.'
  return 'Neither aligns, so DMARC fails: publish the DKIM records above, then check again.'
}
function DmarcRecords({ domain }: { domain: Domain }) {
  const policy = domain.dmarc, recommendation = recordsFor(domain, 'dmarc')[0]
  if (!policy && !recommendation) return null // Nothing to show until the first background check.
  const mode = (value: 's' | 'r') => value === 's' ? 'strict' : 'relaxed'
  const alignment = (aligned: boolean) => aligned ? 'aligned' : 'not aligned'
  // One table row in every state, including the first background check. Never present an
  // observed or inherited policy as an instruction to publish a new TXT record.
  const row: DnsRecord = recommendation ?? { id: 'policy', type: 'TXT', name: `_dmarc.${policy?.source ?? domain.name}`, value: policy?.record ?? '', status: 'not_checked' }
  return <div className="stack domain-group">
    <div className="ui-section-header"><div className="domain-group-title"><h3>DMARC <span className="muted">· {policy?.status ?? 'not checked'}</span></h3>
      <p className="muted dmarc-alignment"><span title={policy ? `${mode(policy.adkim)}: ${policy.adkim === 's' ? 'only this exact domain counts' : 'subdomains of this domain count too'}` : undefined}>DKIM {policy ? `${alignment(policy.alignment.dkim)} (${mode(policy.adkim)})` : 'not checked'}</span> <span title={policy ? `${mode(policy.aspf)}: ${policy.aspf === 's' ? 'only this exact domain counts' : 'subdomains of this domain count too'}` : undefined}>SPF {policy ? `${alignment(policy.alignment.spf)} (${mode(policy.aspf)})` : 'not checked'}</span></p>
      {policy && <p className="muted">{dmarcVerdict(policy.alignment.dkim, policy.alignment.spf)}</p>}</div></div>
    <DnsRecordTable domain={domain.name} records={[row]} status={recommendation ? 'Recommended' : !policy ? 'Not checked' : policy.status === 'invalid' ? 'Invalid' : policy.source && policy.source !== domain.name ? 'Inherited' : policy.record ? 'Published' : 'Missing'} />
  </div>
}

function RecordGroup({ title, optional = false, description, notes = [], alert, domain, records, actions, status }: { title: string; optional?: boolean; description: string; notes?: string[]; alert?: ReactNode; domain: string; records: DnsRecord[]; actions?: ReactNode; status?: string }) {
  return <div className="stack domain-group">
    <div className="ui-section-header"><div className="domain-group-title"><h3>{title}{optional && <span className="muted"> · optional</span>}</h3><p className="muted">{description}</p>{notes.map(note => <p key={note}>{note}</p>)}</div>{actions && <div className="cluster">{actions}</div>}</div>
    {alert}
    <DnsRecordTable domain={domain} records={records} status={status} />
  </div>
}

const liveState = (verified: boolean): LiveState => verified ? 'verified' : 'pending'

// Long hostnames wrap at their dots rather than mid-label.
const breakable = (text: string) => text.split('.').flatMap((part, index) => index === 0 ? [part] : [<wbr key={index} />, `.${part}`])

function CopyText({ label, display, value, copyLabel }: { label: string; display: string; value: string; copyLabel: string }) {
  return <div className="dns-cell">
    <span className="dns-label">{label}</span>
    <span className="dns-text"><code title={value}>{breakable(display)}</code><CopyAction value={value} label={copyLabel} variant="ghost" size="sm" compact className="dns-copy" /></span>
  </div>
}

// Guided layout (onboarding): a heading with one quiet status per group, then plain hairline rows.
function RecordRows({ title, optional = false, description, notes = [], alert, verified, domain, records }: { title: string; optional?: boolean; description: string; notes?: string[]; alert?: ReactNode; verified: boolean; domain: string; records: DnsRecord[] }) {
  return <div className="dns-group" data-state={liveState(verified)}>
    <div className="dns-group-head">
      <h3>{title}{optional && <span className="muted"> · optional</span>}</h3>
      <LiveStatus state={liveState(verified)} plain />
    </div>
    <p className="dns-group-copy muted">{description}</p>
    {notes.map(note => <p key={note} className="dns-group-copy muted">{note}</p>)}
    {alert}
    <div className="dns-columns" aria-hidden="true"><span>Type</span><span>Name</span><span>Value</span><span /></div>
    <ul className="dns-rows">{records.map((record, index) => <li key={record.id} className="dns-row" style={{ '--i': index } as CSSProperties}>
      <div className="dns-cell dns-type"><span className="dns-label">Type</span><code>{record.type}</code></div>
      <CopyText label="Name" display={relativeHost(record.name, domain)} value={record.name} copyLabel={`Copy full ${record.type} name`} />
      <CopyText label="Value" display={record.value} value={record.value} copyLabel={`Copy ${record.type} value`} />
      <div className="dns-cell dns-status"><span className="dns-label">Status</span><LiveStatus state={liveState(record.status === 'verified')} plain /></div>
    </li>)}</ul>
  </div>
}

const guides = [
  ['Cloudflare', 'https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/'],
  ['GoDaddy', 'https://www.godaddy.com/help/manage-dns-records-680'],
  ['Namecheap', 'https://www.namecheap.com/support/knowledgebase/article.aspx/434/2237/how-do-i-set-up-host-records-for-a-domain/'],
  ['Route 53', 'https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resource-record-sets-creating.html'],
  ['Squarespace', 'https://support.squarespace.com/hc/en-us/articles/360002101888-Adding-custom-DNS-records-to-your-Squarespace-managed-domain'],
  ['Vercel', 'https://vercel.com/docs/domains/managing-dns-records'],
] as const
const hoursLeft = (at: string) => Math.max(0, Math.ceil((Date.parse(at) - Date.now()) / 3_600_000))

// While records are pending: how long DNS usually takes, that Bane keeps checking, when an unproven domain is released, and where to add records.
export function DnsWaitNote({ domain }: { domain: Domain }) {
  if (domain.status === 'verified' || (domain.sending ?? 'pending') === 'verified') return null
  return <div className="dns-wait">
    <p>New records usually appear within minutes, sometimes up to an hour. Bane checks every 20 seconds while this page is open, and keeps checking after you leave.</p>
    {domain.releasesAt && <p>If the sending records aren’t found within 72 hours, {domain.name} is released and you’d add it again ({hoursLeft(domain.releasesAt)} h left).</p>}
    <p>One-click setup isn’t available yet, so add the records yourself. Guides: {guides.map(([name, url], index) => <span key={name}>{index > 0 && ' · '}<a href={url} target="_blank" rel="noreferrer">{name}</a></span>)}</p>
  </div>
}

/**
 * Where the domain receives and why, from the receiving MX record the API chose (onboarding and the domain page say
 * the same thing). Bane receives on a free subdomain such as reply.<domain> unless the domain's own MX already points
 * to Bane, so publishing the record never moves mail that goes elsewhere today, unless someone chose the root.
 */
export function receivingHostCopy(domain: string, receiving: DnsRecord[]) {
  const host = receiving.find(record => record.type === 'MX')?.name ?? receiving[0]?.name
  if (!host) return `Receive mail at ${domain}.`
  if (host !== domain) return `Mail to addresses on ${host} comes to Bane. Mail to ${domain} itself is unchanged, so your current mailboxes keep working.`
  return receiving.every(record => record.status === 'verified')
    ? `Every address at ${domain} receives here: its MX record already points to Bane.`
    : `This MX record sends all mail for ${domain} to Bane, including mailboxes hosted elsewhere today. To keep them, receive on a subdomain like reply.${domain}.`
}

// The domain page adds its receiving actions (choose the root or a subdomain, Check MX now) to the receiving group.
export type ReceivingView = { actions?: ReactNode }

// What the API's DNS checks found for the receiving host: blocking issues in red, the rest as warnings.
export function ReceivingIssueAlert({ issue }: { issue: ReceivingIssue }) {
  // A code added to the API before the dashboard knows it still shows, with a plain title.
  return <div className="dns-issue"><Alert tone={issue.blocking ? 'danger' : 'warning'} title={receivingIssueTitle(issue.code, issue.host)}>{issue.message}</Alert></div>
}

// Sending and receiving records. MAIL FROM is optional and lives in the domain's Advanced section.
export function DomainRecords({ domain, actions, guided = false, setup = null, receivingView }: { domain: Domain; actions?: ReactNode; guided?: boolean; setup?: DnsSetup | null; receivingView?: ReceivingView }) {
  const toast = useToast()
  const sending = recordsFor(domain, 'sending'), receiving = recordsFor(domain, 'receiving'), issue = domain.receivingIssue ?? null
  // Onboarding copies only what sending needs; receiving is optional and copied on its own.
  const all = guided ? sending : [...sending, ...receiving]
  const notes = [...new Set(receiving.flatMap(record => record.note && record.note !== issue?.message ? [record.note] : []))]
  const alert = issue && <ReceivingIssueAlert issue={issue} />
  const receivingCopy = receivingHostCopy(domain.name, receiving)
  async function copyAll() {
    try { await navigator.clipboard.writeText(`${zoneLines(all)}\n`); toast(`Copied ${all.length} ${guided ? 'sending ' : ''}records`, 'success') }
    catch { toast('Couldn’t copy to clipboard.', 'error') }
  }
  const sendingVerified = (domain.sending ?? (domain.status === 'verified' ? 'verified' : 'pending')) === 'verified'
  const receivingVerified = (domain.receiving ?? (allVerified(receiving) ? 'verified' : 'pending')) === 'verified'
  // Stays in place (invisible) once every record verifies, so nothing below moves.
  const connect = setup && <DnsConnect setup={setup} open={domain.records.some(record => record.purpose !== 'dmarc' && record.status !== 'verified')} />
  if (guided) return <section className="dns-guided" aria-label="DNS records">
    {connect}
    <div className="dns-guided-bar"><h2>DNS records</h2>{all.length > 0 && <Button onClick={() => void copyAll()}><Copy size={14} aria-hidden />Copy sending records</Button>}</div>
    {domain.dnsStatus === 'unavailable' && <p className="muted">{domain.dnsUnavailableReason || 'DNS records are not available yet.'}</p>}
    {sending.length > 0 && <RecordRows title="Sending" description={`Signs your mail and proves ${domain.name} is yours.`} verified={sendingVerified} domain={domain.name} records={sending} />}
    {receiving.length > 0 && <RecordRows title="Receiving" optional description={receivingCopy} notes={notes} alert={alert} verified={receivingVerified} domain={domain.name} records={receiving} />}
  </section>
  return <section className="section stack">
    <div className="ui-section-header"><div className="domain-group-title"><h2>DNS records</h2><p className="muted">Add these at your DNS provider. Bane keeps checking.</p></div>
      <div className="cluster">{actions}{all.length > 0 && <Button onClick={() => void copyAll()}><Copy size={14} aria-hidden />Copy all</Button>}</div>
    </div>
    {connect}
    {domain.dnsStatus === 'unavailable' && <p className="muted">{domain.dnsUnavailableReason || 'DNS records are not available yet.'}</p>}
    {sending.length > 0 && <RecordGroup title="Sending" description="Signs your mail and proves the domain is yours." domain={domain.name} records={sending} />}
    {receiving.length > 0 && <RecordGroup title="Receiving" optional description={receivingCopy} notes={notes} alert={alert} domain={domain.name} records={receiving} actions={receivingView?.actions} status={issue && receiving.some(record => record.name === issue.host) ? 'Attention' : undefined} />}
    <DmarcRecords domain={domain} />
  </section>
}
