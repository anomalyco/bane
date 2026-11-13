import { useState, type FormEvent } from 'react'
import { Share } from 'lucide-react'
import { Button, ConfirmDialog, CopyButton, DataTable, Dialog, DropdownMenu, EmptyState, ErrorState, Field, Input, SectionHeader, Select, useToast } from '../../components/ui'
import { useApiMutation, useApiDef, useSession } from '../../data/context'
import { queries } from '../../data/queries'
import type { WorkspaceInvitation, WorkspaceMember, WorkspaceRole } from '../../data/types'
import { roleLabel, workspaceApi } from '../../data/workspaces'
import { date } from '../../lib/format'
import { fieldError, MutationError } from './shared'
import { PrivateAddress } from '../../components/PrivateAddress'

// A phone shares an invitation link through the system share sheet; everything can copy it.
const canShare = () => typeof navigator.share === 'function'
async function shareLink(url: string, toast: ReturnType<typeof useToast>) {
  try { await navigator.share({ title: 'Join the workspace on Bane', url }) } catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) toast('Couldn’t open sharing.', 'error') }
}
async function copyLink(url: string, toast: ReturnType<typeof useToast>) {
  try { await navigator.clipboard.writeText(url); toast('Invitation link copied', 'success') } catch { toast('Couldn’t copy to clipboard.', 'error') }
}
const roleOptions = (owner: boolean) => (owner ? ['owner', 'admin', 'member'] as const : ['admin', 'member'] as const).map(role => ({ value: role, label: roleLabel[role] }))
// One line per role, wherever a role is chosen.
const roleHint: Record<WorkspaceRole, string> = {
  owner: 'Everything, including adding and removing other owners.',
  admin: 'Everything except owners: keys, domains, webhooks, sending and members.',
  member: 'Sends email, reads logs and edits content. Can’t manage keys, domains, webhooks or teammates.',
}
function RoleGuide({ owner }: { owner: boolean }) {
  return <dl className="settings-role-guide">{(owner ? ['owner', 'admin', 'member'] as const : ['admin', 'member'] as const).map(role => <div key={role}><dt>{roleLabel[role]}</dt><dd className="muted">{roleHint[role]}</dd></div>)}</dl>
}
// What a role change does, said before it happens. A promotion to owner can't be taken back by the person granting it.
function roleChange(member: WorkspaceMember, role: WorkspaceRole) {
  const who = member.name || member.email
  if (role === 'owner') return { title: `Make ${who} an owner?`, description: `Owners can do everything, including changing your role or removing you. Only another owner can undo this.`, confirm: 'Make owner', danger: true }
  if (role === 'admin') return { title: `Make ${who} an admin?`, description: member.role === 'owner' ? `${who} stops being an owner. Admins manage keys, domains, webhooks, sending and members, but not owners.` : 'Admins manage keys, domains, webhooks, sending and members, but not owners.', confirm: 'Make admin', danger: false }
  return { title: `Change ${who} to member?`, description: 'They keep sending email and editing content, and lose access to keys, domains, webhooks, sending and members at once.', confirm: 'Change to member', danger: false }
}


export function Members({ owner, onInvite }: { owner: boolean; onInvite: () => void }) {
  const session = useSession()
  const members = useApiDef(queries.workspaceMembers())
  const update = useApiMutation((_api, input: { id: string; role: WorkspaceRole }) => workspaceApi.updateMember(input.id, input.role), 'Role updated')
  const remove = useApiMutation((_api, id: string) => workspaceApi.removeMember(id), 'Member removed')
  const [removing, setRemoving] = useState<WorkspaceMember | null>(null)
  const [changing, setChanging] = useState<{ member: WorkspaceMember; role: WorkspaceRole } | null>(null)
  const change = changing && roleChange(changing.member, changing.role)
  const owners = members.data?.filter(member => member.role === 'owner').length ?? 0
  // Only owners manage owners; the last owner stays until another is promoted. Your own row is read-only.
  const manageable = (member: WorkspaceMember) => member.userId !== session?.identity?.id && (owner || member.role !== 'owner')
  const lastOwner = (member: WorkspaceMember) => member.role === 'owner' && owners <= 1
  return <section className="section stack settings-rule">
    <SectionHeader title="Members" actions={<Button onClick={onInvite}>Invite teammate</Button>} />
    <MutationError error={update.error} />
    {members.error ? <ErrorState error={members.error} onRetry={() => void members.refetch()} /> : <DataTable loading={members.isPending} skeletonRows={2} rows={members.data ?? []} rowKey={member => member.id} empty={<EmptyState title="No members" />} columns={[
      { key: 'name', label: 'Name', width: '28%', render: member => <>{member.name || '—'}{member.userId === session?.identity?.id && <span className="muted"> · You</span>}</> },
      { key: 'email', label: 'Email', width: '34%', card: 'line', render: member => <span className="settings-break"><PrivateAddress value={member.email} /></span> },
      { key: 'role', label: 'Role', width: 160, card: 'inline', render: member => manageable(member) && !lastOwner(member) ? <Select aria-label={`Role for ${member.name || 'this member'}`} value={member.role} onValueChange={role => { if (role !== member.role) setChanging({ member, role: role as WorkspaceRole }) }} disabled={update.isPending} options={roleOptions(owner)} /> : roleLabel[member.role], cardRender: member => roleLabel[member.role] },
      // A phone puts the role and Remove in the row's action sheet.
      { key: 'actions', label: '', align: 'right', card: 'end', render: member => manageable(member) && !lastOwner(member) ? <Button variant="danger" onClick={() => setRemoving(member)}>Remove</Button> : null,
        cardRender: member => manageable(member) && !lastOwner(member) ? <DropdownMenu label={`Actions for ${member.name || 'this member'}`} title={member.name || <PrivateAddress value={member.email} />} items={[
          ...roleOptions(owner).filter(option => option.value !== member.role).map(option => ({ label: `Make ${option.label.toLowerCase()}`, hint: roleHint[option.value], disabled: update.isPending, onSelect: () => setChanging({ member, role: option.value }) })),
          { label: 'Remove from workspace', destructive: true, onSelect: () => setRemoving(member) },
        ]} /> : null },
    ]} />}
    <RoleGuide owner={owner} />
    <ConfirmDialog open={changing !== null} onOpenChange={open => { if (!open) setChanging(null) }} title={change?.title ?? ''} description={change?.description ?? ''} confirmLabel={change?.confirm} danger={change?.danger} pending={update.isPending} onConfirm={async () => { if (changing) await update.mutateAsync({ id: changing.member.id, role: changing.role }) }} />
    <ConfirmDialog open={removing !== null} onOpenChange={open => { if (!open) setRemoving(null) }} title={`Remove ${removing?.name || removing?.email || 'member'}?`} description="They lose access to this workspace immediately. You can invite them again later." confirmLabel="Remove member" danger pending={remove.isPending} onConfirm={async () => { if (removing) await remove.mutateAsync(removing.id) }} />
  </section>
}

export function Invitations({ owner }: { owner: boolean }) {
  const toast = useToast()
  const invitations = useApiDef(queries.workspaceInvitations())
  const revoke = useApiMutation((_api, id: string) => workspaceApi.revokeInvitation(id), 'Invitation revoked')
  const [revoking, setRevoking] = useState<WorkspaceInvitation | null>(null)
  return <section className="section stack settings-rule">
    <SectionHeader title="Invitations" />
    {invitations.error ? <ErrorState error={invitations.error} onRetry={() => void invitations.refetch()} /> : <DataTable loading={invitations.isPending} skeletonRows={2} rows={invitations.data ?? []} rowKey={invitation => invitation.id} minRows={2} empty={<EmptyState title="No pending invitations" />} columns={[
      { key: 'email', label: 'Email', width: '40%', render: invitation => <span className="settings-break"><PrivateAddress value={invitation.email} /></span> },
      { key: 'role', label: 'Role', width: 160, card: 'line', render: invitation => roleLabel[invitation.role] },
      { key: 'expires', label: 'Expires', card: 'inline', render: invitation => date(invitation.expiresAt), cardRender: invitation => `Expires ${date(invitation.expiresAt)}` },
      { key: 'actions', label: '', align: 'right', width: 160, card: 'end', render: invitation => <span className="cluster settings-row-actions"><CopyButton value={invitation.acceptUrl} label="Copy invitation link" />{(owner || invitation.role !== 'owner') && <Button variant="danger" onClick={() => setRevoking(invitation)}>Revoke</Button>}</span>,
        cardRender: invitation => <DropdownMenu label="Actions for this invitation" title="Invitation" items={[
          ...canShare() ? [{ label: 'Share invitation link', onSelect: () => void shareLink(invitation.acceptUrl, toast) }] : [],
          { label: 'Copy invitation link', onSelect: () => void copyLink(invitation.acceptUrl, toast) },
          ...owner || invitation.role !== 'owner' ? [{ label: 'Revoke invitation', destructive: true, onSelect: () => setRevoking(invitation) }] : [],
        ]} /> },
    ]} />}
    <ConfirmDialog open={revoking !== null} onOpenChange={open => { if (!open) setRevoking(null) }} title={`Revoke invitation for ${revoking?.email ?? 'this address'}?`} description="The invitation link stops working." confirmLabel="Revoke invitation" danger pending={revoke.isPending} onConfirm={async () => { if (revoking) await revoke.mutateAsync(revoking.id) }} />
  </section>
}

export function InviteDialog({ open, owner, onOpenChange }: { open: boolean; owner: boolean; onOpenChange: (open: boolean) => void }) {
  const toast = useToast()
  const create = useApiMutation((_api, input: { email: string; role: WorkspaceRole }) => workspaceApi.invite(input), 'Invitation created')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<WorkspaceRole>('member')
  const [emailError, setEmailError] = useState('')
  const [created, setCreated] = useState<WorkspaceInvitation | null>(null)
  async function submit(event: FormEvent) {
    event.preventDefault()
    const value = email.trim()
    if (!value) { setEmailError('Enter their email address.'); return }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) { setEmailError('That doesn’t look like an email address. It should look like name@company.com.'); return }
    setEmailError('')
    try { setCreated(await create.mutateAsync({ email: value, role })) } catch { /* The mutation error is shown in the form. */ }
  }
  function close() { onOpenChange(false); setCreated(null); setEmail(''); setRole('member'); setEmailError(''); create.reset() }
  if (created) return <Dialog open={open} onOpenChange={next => { if (!next) close() }} title="Invitation link" description={`Share this link with them yourself; Bane doesn’t email it. It works only for that address, until ${date(created.expiresAt)}.`} footer={<Button variant="primary" onClick={close}>Done</Button>}>
    <div className="settings-secret"><code>{created.acceptUrl}</code><CopyButton value={created.acceptUrl} label="Copy invitation link" /></div>
    {canShare() && <Button className="settings-share" onClick={() => void shareLink(created.acceptUrl, toast)}><Share size={16} />Share link</Button>}
  </Dialog>
  return <Dialog open={open} onOpenChange={next => { if (!create.isPending) { if (next) onOpenChange(true); else close() } }} title="Invite teammate" description="Bane doesn’t send an email: you get a link to share with them. They join by signing in with this address." footer={<><Button disabled={create.isPending} onClick={close}>Cancel</Button><Button variant="primary" loading={create.isPending} type="submit" form="invite-member">Create invitation link</Button></>}>
    <form id="invite-member" className="stack" onSubmit={submit} noValidate>
      <MutationError error={create.error} />
      <Field label="Email" htmlFor="invite-email" error={emailError || fieldError(create.error, 'email')}><Input id="invite-email" type="email" value={email} onChange={event => { setEmail(event.target.value); if (emailError) setEmailError(''); if (create.error) create.reset() }} autoFocus required disabled={create.isPending} placeholder="name@company.com" /></Field>
      <Field label="Role" htmlFor="invite-role"><Select id="invite-role" value={role} onValueChange={value => setRole(value as WorkspaceRole)} disabled={create.isPending} options={roleOptions(owner)} /></Field>
      <RoleGuide owner={owner} />
    </form>
  </Dialog>
}

