import { useState, type FormEvent, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { ArrowUpRight } from 'lucide-react'
import { Button, ConfirmDialog, CopyButton, Input, PageHeader, SectionHeader, SkeletonText, StatusBadge, Tabs } from '../../components/ui'
import { GradeBadge } from '../../components/GradeBadge'
import { useApiDef, useApiMutation, useSession, useWorkspaceAccess } from '../../data/context'
import { connectionApi, connectionKindLabel, useConnectionCache } from '../../data/connections'
import { queries } from '../../data/queries'
import { roleLabel, workspaceApi } from '../../data/workspaces'
import type { Design } from '../../lib/design'
import { label } from '../../lib/format'
import { useSenderScore } from '../score/use-score'
import { MutationError } from './shared'
import { WebhooksSection } from './webhooks'
import { Invitations, InviteDialog, Members } from './workspace-members'
import './designs.css'

// Three proposed Settings layouts for hosted workspaces, built from the same API calls and tables as today's page.
//  a: rail — grouped left rail, one section at a time (Console's settings layout)
//  b: tabs — three tabs: General, Team, Sending
//  c: one page — each section a two-column row: title and one line on the left, controls on the right
type SectionKey = 'general' | 'members' | 'sending' | 'webhooks' | 'account'
export function PitchSettings({ design }: { design: Exclude<Design, 'current'> }) {
  if (design === 'a') return <SettingsA />
  if (design === 'b') return <SettingsB />
  return <SettingsC />
}

// One setting: what it is on the left, the control on the right.
function Row({ title, hint, children }: { title: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return <div className="set-row"><div className="set-row__label"><span>{title}</span>{hint && <span className="muted">{hint}</span>}</div><div className="set-row__control">{children}</div></div>
}

function WorkspaceRows() {
  const session = useSession()
  const { canAdminister } = useWorkspaceAccess()
  const workspaces = useApiDef(queries.workspaces())
  const current = workspaces.data?.find(workspace => workspace.id === session?.identity?.workspaceId)
  return <div className="set-rows">
    <Row title="Name">{current ? <NameForm key={current.id} initial={current.name} canEdit={canAdminister} /> : <SkeletonText width={240} />}</Row>
    <Row title="Workspace ID"><span className="cluster set-inline"><code>{session?.identity?.workspaceId}</code>{session?.identity?.workspaceId && <CopyButton value={session.identity.workspaceId} label="Copy workspace ID" />}</span></Row>
  </div>
}
function NameForm({ initial, canEdit }: { initial: string; canEdit: boolean }) {
  const [name, setName] = useState(initial)
  const save = useApiMutation((_api, value: string) => workspaceApi.rename(value), 'Saved')
  async function submit(event: FormEvent) { event.preventDefault(); try { await save.mutateAsync(name.trim()) } catch { /* inline */ } }
  const changed = name.trim() !== initial && name.trim() !== ''
  return <form className="set-name" onSubmit={submit}><Input aria-label="Workspace name" maxLength={120} value={name} onChange={event => setName(event.target.value)} readOnly={!canEdit} disabled={save.isPending} />{canEdit && changed && <Button type="submit" variant="primary" loading={save.isPending}>Save</Button>}<MutationError error={save.error} /></form>
}

function SendingRows({ withScore = true }: { withScore?: boolean }) {
  const connection = useApiDef(queries.connection())
  const summary = useSession()?.identity?.connection
  const current = connection.data
  const kind = current?.kind ?? summary?.kind
  return <div className="set-rows">
    <Row title="Connection">{kind ? <span className="cluster set-inline"><span>{connectionKindLabel[kind]}</span><StatusBadge status={label(current?.state ?? summary?.state ?? 'pending')} /></span> : <SkeletonText width={160} />}</Row>
    {current?.kind === 'byo' && <Row title="AWS account"><code>{current.awsAccountId ?? '—'}</code></Row>}
    {(current?.region ?? summary?.region) && <Row title="Region"><code>{current?.region ?? summary?.region}</code></Row>}
    {withScore && <ScoreRow />}
  </div>
}
function ScoreRow() {
  const { report } = useSenderScore()
  return <Row title="Sender score" hint="Replaces sending limits">
    {!report ? <SkeletonText width={120} /> : <Link to="/#sender-score" className="set-score">{report.state === 'warmup' ? <><GradeBadge grade={null} size="sm" /><span>{report.emails} of {report.needed} emails</span></> : <><GradeBadge grade={report.grade} size="sm" /><span>{Math.round(report.score)}</span></>}<ArrowUpRight size={14} /></Link>}
  </Row>
}
function DisconnectRow() {
  const connection = useApiDef(queries.connection())
  const disconnect = useApiMutation(() => connectionApi.remove(), 'Disconnected', true)
  const [confirming, setConfirming] = useState(false)
  const sync = useConnectionCache()
  if (!connection.data) return null
  return <div className="set-rows set-danger"><Row title="Disconnect sending" hint="Sending stops until you connect again."><Button variant="danger" onClick={() => setConfirming(true)}>Disconnect</Button></Row>
    <ConfirmDialog open={confirming} onOpenChange={setConfirming} title="Disconnect sending?" description={connection.data.kind === 'byo' ? 'Sending stops until you connect again. AWS resources stay in your account; delete the Bane stack in AWS to revoke access.' : 'Sending stops until you connect again.'} confirmLabel="Disconnect" danger pending={disconnect.isPending} onConfirm={async () => { await disconnect.mutateAsync(undefined); sync(null) }} />
  </div>
}
function AccountRows() {
  const session = useSession()
  const access = useWorkspaceAccess()
  if (!session?.identity) return null
  return <div className="set-rows">
    <Row title="Email">{session.identity.email || '—'}</Row>
    <Row title="Role">{access.role ? roleLabel[access.role] : '—'}</Row>
    <Row title="Session"><Button onClick={() => session.logout()}>Sign out</Button></Row>
  </div>
}
function Team() {
  const access = useWorkspaceAccess()
  const [inviting, setInviting] = useState(false)
  const owner = access.role === 'owner'
  if (!access.canAdminister) return null
  return <><Members owner={owner} onInvite={() => setInviting(true)} /><Invitations owner={owner} /><InviteDialog open={inviting} owner={owner} onOpenChange={setInviting} /></>
}

// A: grouped rail, one section at a time; old #webhooks / #workspace links still land on the right section.
const railGroups: { title: string; items: { key: SectionKey; label: string }[] }[] = [
  { title: 'Workspace', items: [{ key: 'general', label: 'General' }, { key: 'members', label: 'Members' }, { key: 'sending', label: 'Sending' }, { key: 'webhooks', label: 'Webhooks' }] },
  { title: 'You', items: [{ key: 'account', label: 'Account' }] },
]
function useSectionHash(fallback: SectionKey): SectionKey {
  const { hash } = useLocation()
  const value = decodeURIComponent(hash.slice(1))
  return value === 'workspace' ? 'general' : (['general', 'members', 'sending', 'webhooks', 'account'] as const).find(key => key === value) ?? fallback
}
function SettingsA() {
  const section = useSectionHash('general')
  const { canAdminister } = useWorkspaceAccess()
  const title = railGroups.flatMap(group => group.items).find(item => item.key === section)?.label
  return <div className="set-a">
    <nav className="set-rail" aria-label="Settings">
      <h1 className="set-rail__title">Settings</h1>
      {railGroups.map(group => <div key={group.title} className="set-rail__group"><span className="set-rail__group-title">{group.title}</span>
        {group.items.filter(item => canAdminister || ['general', 'account'].includes(item.key)).map(item => <Link key={item.key} to={`/settings#${item.key}`} aria-current={item.key === section ? 'page' : undefined}>{item.label}</Link>)}
      </div>)}
    </nav>
    <div className="set-a__content">
      {section === 'members' || section === 'webhooks' ? null : <SectionHeader title={title} />}
      {section === 'general' && <WorkspaceRows />}
      {section === 'members' && <Team />}
      {section === 'sending' && <><SendingRows /><DisconnectRow /></>}
      {section === 'webhooks' && <WebhooksSection note={false} />}
      {section === 'account' && <AccountRows />}
    </div>
  </div>
}

// B: three tabs.
const tabs = [{ value: 'general', label: 'General' }, { value: 'team', label: 'Team' }, { value: 'sending', label: 'Sending' }]
function SettingsB() {
  const { hash } = useLocation()
  const navigate = useNavigate()
  const raw = decodeURIComponent(hash.slice(1))
  const tab = raw === 'members' ? 'team' : raw === 'webhooks' ? 'sending' : tabs.some(item => item.value === raw) ? raw : 'general'
  return <div className="set-b">
    <PageHeader title="Settings" />
    <Tabs value={tab} onValueChange={value => navigate(`/settings#${value}`, { replace: true })} items={tabs} label="Settings sections" />
    <div className="set-b__content">
      {tab === 'general' && <><section><SectionHeader title="Workspace" /><WorkspaceRows /></section><section><SectionHeader title="Account" /><AccountRows /></section></>}
      {tab === 'team' && <Team />}
      {tab === 'sending' && <><SendingRows /><WebhooksSection note={false} /><DisconnectRow /></>}
    </div>
  </div>
}

// C: one page, each section a two-column row.
function SettingsC() {
  const { canAdminister } = useWorkspaceAccess()
  const sections: { key: SectionKey; title: string; hint: string; body: ReactNode; admin?: boolean }[] = [
    { key: 'general', title: 'Workspace', hint: 'Shared by everyone in it.', body: <WorkspaceRows /> },
    { key: 'members', title: 'Members', hint: 'Owners and admins manage keys, domains and people.', body: <Team />, admin: true },
    { key: 'sending', title: 'Sending', hint: 'How your mail leaves Bane and how it’s scored.', body: <><SendingRows /><DisconnectRow /></>, admin: true },
    { key: 'webhooks', title: 'Webhooks', hint: 'Events for mail you send. Received mail has its own.', body: <WebhooksSection note={false} />, admin: true },
    { key: 'account', title: 'Account', hint: 'You, in this workspace.', body: <AccountRows /> },
  ]
  return <div className="set-c">
    <PageHeader title="Settings" />
    {sections.filter(section => canAdminister || !section.admin).map(section => <section key={section.key} id={section.key} className="set-c__section">
      <div className="set-c__intro"><h2>{section.title}</h2><p className="muted">{section.hint}</p></div>
      <div className="set-c__body">{section.body}</div>
    </section>)}
  </div>
}
