import { useState, type FormEvent, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router'
import { ArrowUpRight, Info, Lock } from 'lucide-react'
import { Button, ConfirmDialog, CopyButton, Input, SectionHeader, Select, Skeleton, StatusBadge } from '../../components/ui'
import { useApiDef, useApiMutation, useSession, useWorkspaceAccess } from '../../data/context'
import { connectionApi, connectionKindLabel, useConnectionCache } from '../../data/connections'
import { queries } from '../../data/queries'
import type { McpConnection, WorkspaceMembership } from '../../data/types'
import { roleLabel, useMembershipCache, workspaceApi } from '../../data/workspaces'
import { label, number } from '../../lib/format'
import { useSenderScore } from '../score'
import { limitSummary, useSendingLimit } from '../overview/setup'
import { openScoreAbout } from '../../lib/score-about'
import { AdminOnly } from './admin-only'
import { MutationError } from './shared'
import { PlanUsage } from './usage'
import { BillingSection } from './billing'
import { WebhooksSection } from './webhooks'
import { ActivitySection } from './activity'
import { ContactSupportDialog } from '../../components/ContactSupport'
import { Invitations, InviteDialog, Members } from './workspace-members'
import './hosted.css'
import { PrivateAddress } from '../../components/PrivateAddress'

// Hosted settings: a grouped rail and one section at a time. Settings are rows, the label on the left and the
// control on the right, each 53px tall so values loading in never move anything. Old #workspace and #webhooks links still land.
type SectionKey = 'general' | 'members' | 'sending' | 'webhooks' | 'activity' | 'usage' | 'billing' | 'account'
// Members see every section in the rail: owner and admin ones carry a lock and open a short explanation instead of
// controls they can't use, so nothing is silently missing. Sections of rows keep a readable column; a section that is
// a table (`width: 'full'`) takes the whole panel, to the same right edge as the app's other tables.
const groups: { title: string; items: { key: SectionKey; label: string; admin?: string; width?: 'full' }[] }[] = [
  { title: 'Workspace', items: [{ key: 'general', label: 'General' }, { key: 'members', label: 'Members', admin: 'invite people and change roles', width: 'full' }, { key: 'sending', label: 'Sending', admin: 'connect or disconnect sending' }, { key: 'webhooks', label: 'Webhooks', admin: 'add webhooks for email events', width: 'full' }, { key: 'activity', label: 'Activity', admin: 'see who changed what in this workspace', width: 'full' }, { key: 'usage', label: 'Plan & usage' }, { key: 'billing', label: 'Billing', admin: 'add credit and manage payment' }] },
  { title: 'You', items: [{ key: 'account', label: 'Account' }] },
]
const items = groups.flatMap(group => group.items)

export function HostedSettings() {
  const { hash } = useLocation()
  const { canAdminister } = useWorkspaceAccess()
  const requested = decodeURIComponent(hash.slice(1))
  const section = (requested === 'workspace' ? 'general' : items.find(item => item.key === requested)?.key) ?? 'general'
  const locked = (item: typeof items[number]) => !canAdminister && Boolean(item.admin)
  const current = items.find(item => item.key === section)!
  return <div className="hosted-settings">
    <nav className="settings-rail" aria-label="Settings">
      <h1 className="settings-rail__title">Settings</h1>
      <div className="settings-rail__groups">{groups.map(group => <div key={group.title} className="settings-rail__group"><span className="settings-rail__group-title">{group.title}</span>
        {group.items.map(item => <Link key={item.key} to={`/settings#${item.key}`} replace aria-current={item.key === section ? 'page' : undefined} data-locked={locked(item) || undefined} title={locked(item) ? 'Owners and admins only' : undefined}>{item.label}{locked(item) && <Lock size={12} aria-label="Owners and admins only" />}</Link>)}
      </div>)}</div>
    </nav>
    {/* Keyed, so switching sections fades the new one in. */}
    <div key={section} className="hosted-settings__content" data-width={locked(current) ? undefined : current.width}>
      {locked(current) ? <AdminOnly title={current.label} action={current.admin!} />
        : <>
          {section === 'general' && <><SectionHeader title="General" /><WorkspaceRows /></>}
          {section === 'members' && <Team />}
          {section === 'sending' && <><SectionHeader title="Sending" /><SendingRows /></>}
          {section === 'webhooks' && <WebhooksSection note={false} />}
          {section === 'activity' && <ActivitySection />}
          {section === 'usage' && <PlanUsage row={Row} />}
          {section === 'billing' && <BillingSection row={Row} />}
          {section === 'account' && <><SectionHeader title="Account" /><AccountRows /></>}
        </>}
    </div>
  </div>
}

export function Row({ title, hint, children }: { title: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return <div className="settings-row"><div className="settings-row__label"><span>{title}</span>{hint && <span className="muted">{hint}</span>}</div><div className="settings-row__control">{children}</div></div>
}

function WorkspaceRows() {
  const session = useSession()
  const { canAdminister } = useWorkspaceAccess()
  // The name comes with the session's memberships (GET /v1/me): no request of its own, so it is there on the first frame.
  const id = session?.identity?.workspaceId
  const current = session?.identity?.workspaces?.find(workspace => workspace.id === id)
  return <div className="settings-rows">
    <Row title="Name" hint={canAdminister ? undefined : 'Owners and admins can rename it'}>{current ? <NameForm key={current.id} initial={current.name} canEdit={canAdminister} /> : <span className="muted">—</span>}</Row>
    <Row title="Workspace ID"><span className="cluster settings-inline"><code>{id}</code>{id && <CopyButton value={id} label="Copy workspace ID" />}</span></Row>
  </div>
}
function NameForm({ initial, canEdit }: { initial: string; canEdit: boolean }) {
  // Members read the name as text: an input that ignores typing looks broken.
  if (!canEdit) return <span className="settings-readonly" title="Only owners and admins can rename the workspace">{initial}</span>
  return <EditableName initial={initial} />
}
function EditableName({ initial }: { initial: string }) {
  const [name, setName] = useState(initial)
  const memberships = useMembershipCache()
  const save = useApiMutation(async (_api, value: string) => { const renamed = await workspaceApi.rename(value); memberships.renamed(renamed); return renamed }, 'Saved')
  async function submit(event: FormEvent) { event.preventDefault(); try { await save.mutateAsync(name.trim()) } catch { /* inline */ } }
  const changed = name.trim() !== initial && name.trim() !== ''
  // Save keeps its place whether or not it is shown, so typing never moves the field.
  return <form className="settings-name" onSubmit={submit}>
    <Input aria-label="Workspace name" className="settings-name-input" maxLength={120} value={name} onChange={event => setName(event.target.value)} disabled={save.isPending} />
    <Button type="submit" variant="primary" loading={save.isPending} data-hidden={!changed || undefined} tabIndex={changed ? undefined : -1} aria-hidden={!changed || undefined}>Save</Button>
    {save.error ? <div className="settings-name-error"><MutationError error={save.error} /></div> : null}
  </form>
}

function SendingRows() {
  const connection = useApiDef(queries.connection())
  const summary = useSession()?.identity?.connection
  const limit = useSendingLimit()
  const current = connection.data, kind = current?.kind ?? summary?.kind, region = current?.region ?? summary?.region
  return <>
    <div className="settings-rows">
      <Row title="Connection" hint={kind === 'byo' ? 'Amazon SES in your AWS account' : 'Sent through Bane’s Amazon SES'}>{kind ? <span className="cluster settings-inline"><span>{connectionKindLabel[kind]}</span><StatusBadge status={label(current?.state ?? summary?.state ?? 'pending')} /></span> : <Skeleton width={160} height={20} />}</Row>
      {region && <Row title="Region" hint="The AWS region your mail is sent from"><code>{region}</code></Row>}
      {kind === 'byo' && <Row title="AWS account"><code>{current?.awsAccountId ?? '—'}</code></Row>}
      <ScoreRow />
      {limit && limit.cap !== null && <Row title="Daily limit" hint="Recipients in the last 24 hours"><Link to="/settings#usage" replace className="settings-score" title={limitSummary(limit)}><span>{number(limit.used)} / {number(limit.cap)}</span><span className="muted">Plan & usage</span><ArrowUpRight size={14} aria-hidden="true" /></Link></Row>}
    </div>
    <DisconnectRow kind={kind} />
  </>
}
function ScoreRow() {
  const { data: report } = useSenderScore()
  return <Row title="Sender score" hint="Your sending health, 0–100">
    {!report ? <Skeleton width={96} height={20} /> : <button type="button" onClick={() => openScoreAbout()} className="settings-score">{report.state === 'graded' ? <><b>{Math.round(report.score!)}</b><span className="settings-score__grade">{report.grade}</span></> : <><span>Not graded yet</span><span className="muted">{number(report.emails.firstEmails)} of {number(report.needed)} real emails</span></>}<Info size={14} aria-hidden="true" /></button>}
  </Row>
}
function DisconnectRow({ kind }: { kind: 'shared' | 'byo' | undefined }) {
  const disconnect = useApiMutation(() => connectionApi.remove(), 'Disconnected', true)
  const [confirming, setConfirming] = useState(false)
  const sync = useConnectionCache()
  if (!kind) return null
  const keeps = 'Domains, DNS records, API keys and received mail stay. It isn’t possible while emails or campaigns are still sending.'
  return <div className="settings-rows settings-danger"><Row title="Disconnect sending" hint="Sending stops until you connect again"><Button variant="danger" onClick={() => setConfirming(true)}>Disconnect</Button></Row>
    <ConfirmDialog open={confirming} onOpenChange={setConfirming} title="Disconnect sending?" description={kind === 'byo' ? `Sending stops until you connect again. ${keeps} AWS resources stay in your account; delete the Bane stack in AWS to revoke access.` : `Sending stops until you connect again. ${keeps}`} confirmLabel="Disconnect" danger pending={disconnect.isPending} onConfirm={async () => { await disconnect.mutateAsync(undefined); sync(null) }} />
  </div>
}
// The account service's connected apps page, on the installations that sign in with Anomaly account.
const accountApps = ({ 'bane.mx': 'https://account.anoma.ly/apps', 'dev.bane.mx': 'https://account.dev.anoma.ly/apps' } as Record<string, string>)[window.location.hostname] ?? null
function AccountRows() {
  const session = useSession()
  const access = useWorkspaceAccess()
  const apps = useApiDef(queries.mcpConnections())
  const revoke = useApiMutation((api,id:string)=>api.credentials.revokeMcpConnection(id),'MCP connection revoked')
  const [support, setSupport] = useState(false)
  if (!session?.identity) return null
  return <div className="settings-rows">
    <Row title="Name" hint="From your Google account">{session.identity.name || '—'}</Row>
    <Row title="Email">{session.identity.email ? <PrivateAddress value={session.identity.email} /> : '—'}</Row>
    <Row title="Role" hint={access.role === 'member' ? 'Owners and admins can change it' : undefined}>{access.role ? roleLabel[access.role] : '—'}</Row>
    <Row title="Support" hint="Questions, problems or feedback"><Button onClick={() => setSupport(true)}>Contact support</Button></Row>
    <Row title="Session" hint="Your other accounts stay signed in"><Button onClick={() => session.logout()}>Sign out of this account</Button></Row>
    {/* An MCP client signs in to the account service, which lists and disconnects it everywhere. Bane lists each
        client's approval below: its default workspace, and Revoke, which ends its access here and everything it set up. */}
    {accountApps && <Row title="Connected apps" hint="Disconnect a client from your Anomaly account"><a href={accountApps}>Manage at Anomaly account</a></Row>}
    {apps.data?.map(app=>app.status==='expired'||app.status==='revoked'?<Row key={app.id} title={connectionTitle(app)} hint={app.clientId}>{app.status==='expired'?'Expired · reconnect the client':'Revoked · reconnect the client'}</Row>
      :<McpApproval key={`${app.id}:${app.workspaceId}`} app={app} workspaces={session.identity?.workspaces??[]} onRevoke={()=>revoke.mutate(app.id)} />)}
    {apps.error && <p role="alert">Couldn’t load MCP approvals.</p>}
    <MutationError error={revoke.error}/>
    {support && <ContactSupportDialog onClose={() => setSupport(false)} />}
  </div>
}
// A client's name and the label of its entry (`?profile=` on its MCP URL), so a personal and a work entry of one client
// are easy to tell apart. The label is display only.
export const connectionTitle = (app: Pick<McpConnection, 'name' | 'clientId' | 'profile'>) => `${app.name || app.clientId}${app.profile ? ` · ${app.profile}` : ''}`
// One approval per client and account. Its tools act in the workspace each call names, checked against your role there
// on every call; this picks the default for calls that name none (automatic: your only workspace, else the one you used
// last). Receiving tools need an owner or admin there and full access. Save keeps its place whether or not it is shown,
// so choosing never moves the row.
const accessLabel = (scopes: string[]) => scopes.includes('bane:manage') ? 'Full access' : scopes.includes('bane:send') ? 'Read and send' : 'Read only'
export function McpApproval({ app, workspaces, onRevoke, linked = true }: { app: McpConnection; workspaces: WorkspaceMembership[]; onRevoke: () => void; linked?: boolean }) {
  const [workspaceId, setWorkspaceId] = useState(app.workspaceId ?? '')
  const bind = useApiMutation((api, workspace: string) => api.credentials.bindMcpConnection(app.id, { workspaceId: workspace }), 'Saved')
  const changed = workspaceId !== '' && workspaceId !== app.workspaceId
  const name = connectionTitle(app)
  return <Row title={linked ? <Link to={`/settings/mcp/${encodeURIComponent(app.id)}`}>{name}</Link> : name} hint={`${accessLabel(app.scopes)} · ${app.clientId}`}>
    <span className="settings-mcp">
      <Select aria-label={`Default workspace for ${name}`} className="settings-mcp__workspace" value={workspaceId} placeholder="Last used" disabled={bind.isPending}
        options={workspaces.map(workspace => ({ value: workspace.id, label: workspace.name }))} onValueChange={setWorkspaceId} />
      <Button variant="primary" loading={bind.isPending} data-hidden={!changed || undefined} tabIndex={changed ? undefined : -1} aria-hidden={!changed || undefined} onClick={() => { bind.mutate(workspaceId) }}>Save</Button>
      <Button variant="danger" aria-label={`Revoke MCP access for ${name}`} onClick={onRevoke}>Revoke</Button>
      {bind.error ? <div className="settings-name-error"><MutationError error={bind.error} /></div> : null}
    </span>
  </Row>
}
// Members and invitations appear together once both are known, so the second table never pushes down. Gated on the
// first answer (isFetched), not isPending: the tables below retry a failed read when they mount, and a retry with no
// data is pending again, so gating on isPending unmounted them and remounted them in a loop of requests.
function Team() {
  const access = useWorkspaceAccess()
  const [inviting, setInviting] = useState(false)
  const members = useApiDef(queries.workspaceMembers())
  const invitations = useApiDef(queries.workspaceInvitations())
  const owner = access.role === 'owner'
  if (!members.isFetched || !invitations.isFetched) return <div className="settings-team-skeleton" aria-busy="true"><SectionHeader title="Members" /></div>
  return <><Members owner={owner} onInvite={() => setInviting(true)} /><Invitations owner={owner} /><InviteDialog open={inviting} owner={owner} onOpenChange={setInviting} /></>
}
