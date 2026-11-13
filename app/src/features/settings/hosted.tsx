import { useState, type FormEvent, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router'
import { ArrowUpRight, Info, Lock } from 'lucide-react'
import { Button, Checkbox, ConfirmDialog, CopyButton, Input, SectionHeader, Select, Skeleton, StatusBadge } from '../../components/ui'
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
import { McpKeyButton } from './mcp-key'
import { ContactSupportDialog } from '../../components/ContactSupport'
import { Invitations, InviteDialog, Members } from './workspace-members'
import './hosted.css'
import { PrivateAddress } from '../../components/PrivateAddress'

// Hosted settings: a grouped rail and one section at a time. Settings are rows, the label on the left and the
// control on the right, each 53px tall so values loading in never move anything. Old #workspace and #webhooks links still land.
type SectionKey = 'general' | 'members' | 'sending' | 'webhooks' | 'activity' | 'usage' | 'billing' | 'account' | 'apps'
// Members see every section in the rail: owner and admin ones carry a lock and open a short explanation instead of
// controls they can't use, so nothing is silently missing.
const groups: { title: string; items: { key: SectionKey; label: string; admin?: string }[] }[] = [
  { title: 'Workspace', items: [{ key: 'general', label: 'General' }, { key: 'members', label: 'Members', admin: 'invite people and change roles' }, { key: 'sending', label: 'Sending', admin: 'connect or disconnect sending' }, { key: 'webhooks', label: 'Webhooks', admin: 'add webhooks for email events' }, { key: 'activity', label: 'Activity', admin: 'see who changed what in this workspace' }, { key: 'usage', label: 'Plan & usage' }, { key: 'billing', label: 'Billing', admin: 'add credit and manage payment' }] },
  { title: 'You', items: [{ key: 'account', label: 'Account' }, { key: 'apps', label: 'Connected apps' }] },
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
    <div key={section} className="hosted-settings__content">
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
          {section === 'apps' && <><SectionHeader title="Connected apps" actions={<McpKeyButton size="sm" />} /><ConnectedApps /></>}
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
function AccountRows() {
  const session = useSession()
  const access = useWorkspaceAccess()
  const [support, setSupport] = useState(false)
  if (!session?.identity) return null
  return <div className="settings-rows">
    <Row title="Name" hint="From your Google account">{session.identity.name || '—'}</Row>
    <Row title="Email">{session.identity.email ? <PrivateAddress value={session.identity.email} /> : '—'}</Row>
    <Row title="Role" hint={access.role === 'member' ? 'Owners and admins can change it' : undefined}>{access.role ? roleLabel[access.role] : '—'}</Row>
    <Row title="Support" hint="Questions, problems or feedback"><Button onClick={() => setSupport(true)}>Contact support</Button></Row>
    <Row title="Session" hint="Your other accounts stay signed in"><Button onClick={() => session.logout()}>Sign out of this account</Button></Row>
    {support && <ContactSupportDialog onClose={() => setSupport(false)} />}
  </div>
}
// The MCP clients this account approved on Bane's consent page, and its MCP keys. Each acts in one workspace; revoking
// one ends it and everything it created stops or pauses (mcp/README.md).
function ConnectedApps() {
  const session = useSession()
  const apps = useApiDef(queries.mcpConnections())
  const revoke = useApiMutation((api,id:string)=>api.credentials.revokeMcpConnection(id),'Connected app revoked')
  if (!session?.identity) return null
  return <div className="settings-rows">
    {apps.isPending && <div className="settings-row"><Skeleton width={220} height={20} /></div>}
    {apps.data?.length === 0 && <Row title="No connected apps" hint="Connect OpenCode, Claude Code or Cursor from Docs → Connect an agent, or create an MCP key">{null}</Row>}
    {apps.data?.map(app=>app.status==='expired'||app.status==='revoked'?<Row key={app.id} title={connectionTitle(app)} hint={app.kind === 'key' ? 'MCP key' : app.clientId}>{app.status==='expired'?'Expired · reconnect the client':'Revoked'}</Row>
      :<McpApproval key={`${app.id}:${app.workspaceId}:${app.receiving}`} app={app} workspaces={session.identity?.workspaces??[]} onRevoke={()=>revoke.mutate(app.id)} />)}
    {apps.error && <p role="alert">Couldn’t load connected apps.</p>}
    <MutationError error={revoke.error}/>
  </div>
}
// A client's name and the label of its entry (`?profile=` on its MCP URL), so a personal and a work entry of one client
// are easy to tell apart. The label is display only.
export const connectionTitle = (app: Pick<McpConnection, 'name' | 'clientId' | 'profile'>) => `${app.name || app.clientId}${app.profile ? ` · ${app.profile}` : ''}`
// Each approval acts in one workspace. A new one waits for this choice when you belong to several; receiving tools
// need an owner or admin there. Save keeps its place whether or not it is shown, so choosing never moves the row.
export function McpApproval({ app, workspaces, onRevoke, linked = true }: { app: McpConnection; workspaces: WorkspaceMembership[]; onRevoke: () => void; linked?: boolean }) {
  const [workspaceId, setWorkspaceId] = useState(app.workspaceId ?? '')
  const [receiving, setReceiving] = useState(app.receiving ?? false)
  const bind = useApiMutation((api, input: { workspaceId: string; receiving: boolean }) => api.credentials.bindMcpConnection(app.id, input), 'Saved')
  const admin = (id: string) => ['owner', 'admin'].includes(workspaces.find(workspace => workspace.id === id)?.role ?? '')
  const changed = workspaceId !== '' && (workspaceId !== app.workspaceId || receiving !== (app.receiving ?? false))
  const name = connectionTitle(app)
  const used = app.lastUsedAt ? `used ${new Date(app.lastUsedAt).toLocaleDateString()}` : 'not used yet'
  const hint = !app.workspaceId ? 'Choose a workspace' : app.kind === 'key' ? `MCP key · ${used}${app.expiresAt ? ` · expires ${new Date(app.expiresAt).toLocaleDateString()}` : ''}` : `${app.clientId} · ${used}`
  return <Row title={linked ? <Link to={`/settings/mcp/${encodeURIComponent(app.id)}`}>{name}</Link> : name} hint={hint}>
    <span className="settings-mcp">
      <Select aria-label={`Workspace for ${name}`} className="settings-mcp__workspace" value={workspaceId} placeholder="Choose a workspace" disabled={bind.isPending}
        options={workspaces.map(workspace => ({ value: workspace.id, label: workspace.name }))} onValueChange={id => { setWorkspaceId(id); if (!admin(id)) setReceiving(false) }} />
      <Checkbox label="Receiving tools" checked={receiving} disabled={bind.isPending || !admin(workspaceId)} onCheckedChange={setReceiving} />
      <Button variant="primary" loading={bind.isPending} data-hidden={!changed || undefined} tabIndex={changed ? undefined : -1} aria-hidden={!changed || undefined} onClick={() => { bind.mutate({ workspaceId, receiving }) }}>Save</Button>
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
