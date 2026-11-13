import { useState, type FormEvent, type ReactNode } from 'react'
import * as DropdownPrimitive from '@radix-ui/react-dropdown-menu'
import { useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, LifeBuoy, LogOut, Plus, UserPlus } from 'lucide-react'
import { sectionPath, useApiMutation, useSession } from '../data/context'
import { accountApi, accountsKey, initials, useAccounts, type ConnectedAccount } from '../data/accounts'
import { useMembershipCache, workspaceApi } from '../data/workspaces'
import { fieldError, MutationError } from '../features/settings/shared'
import { usePhone } from '../lib/media'
import { PrivateAddress } from './PrivateAddress'
import { Button, Dialog, Field, Input, Sheet, useToast } from './ui'
import { ContactSupportDialog } from './ContactSupport'

// One menu for who and where: the accounts this browser connected, each with its workspaces, then Add account,
// Contact support and sign-out. Picking a workspace of another account switches account and workspace together. Multi-tenant only; shown
// in the dashboard sidebar, the phone's top bar (as a sheet) and the onboarding header.
type Entry = { key: string; label: ReactNode; text: string; hint?: ReactNode; icon?: ReactNode; checked?: boolean; disabled?: boolean; destructive?: boolean; heading?: boolean; onSelect: () => void }
export function AccountAvatar({ name, email, size = 'md' }: { name: string | null | undefined; email?: string | null; size?: 'sm' | 'md' }) {
  return <span className={`account-avatar account-avatar--${size}`} aria-hidden="true">{initials(name, email)}</span>
}
function Who({ account }: { account: Pick<ConnectedAccount, 'name' | 'email'> }) {
  return <span className="account-menu__who"><span className="account-menu__name">{account.name || account.email || 'Account'}</span>{account.email && <PrivateAddress className="account-menu__email" value={account.email} />}</span>
}
export function AccountSwitcher() {
  const session = useSession()
  const toast = useToast()
  const phone = usePhone()
  const client = useQueryClient()
  const memberships = useMembershipCache()
  const identity = session?.identity
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const [support, setSupport] = useState(false)
  const list = useAccounts(open)
  const load = () => client.fetchQuery({ queryKey: accountsKey, queryFn: ({ signal }) => accountApi.list(signal), staleTime: 30_000 })
  const intent = () => { void load().catch(() => {}) }
  // The phone's sheet is anchored to the bottom of the screen and would grow upwards when the list arrived, so it opens
  // with the list already there (it is usually warm from the touch that started the tap).
  async function openSheet() {
    if (busy) return
    setBusy(true)
    try { await load() } catch { /* The sheet still opens with this tab's account. */ } finally { setBusy(false) }
    setOpen(true)
  }
  if (!identity) return null
  const self: ConnectedAccount = { id: identity.id, name: identity.name ?? '', email: identity.email, workspaces: identity.workspaces ?? [] }
  // The tab's own account comes with the session (GET /v1/me), so the menu opens complete even before the list arrives;
  // its workspaces are always the session's, which a rename has already updated.
  const accounts = list.data?.accounts.some(account => account.id === self.id) ? list.data.accounts.map(account => account.id === self.id ? { ...account, workspaces: self.workspaces } : account) : [self]
  const limit = list.data?.limit ?? 5
  const workspace = self.workspaces.find(item => item.id === identity.workspaceId)
  async function run(action: () => Promise<void> | void, failure: string) {
    setOpen(false); setBusy(true)
    try { await action() } catch (error) { toast(error instanceof Error ? error.message : failure, 'error'); void memberships.refresh() } finally { setBusy(false) }
  }
  const sections: Entry[][] = accounts.map(account => {
    const active = account.id === self.id
    return [
      { key: `account:${account.id}`, heading: true, label: <><AccountAvatar name={account.name} email={account.email} /><Who account={account} />{active && <Check className="account-menu__check" size={14} aria-label="Current account" />}</>, text: account.name || account.email || 'Account',
        disabled: active, onSelect: () => void run(() => session!.switchAccount(account.id, sectionPath()), 'Couldn’t switch account.') },
      ...account.workspaces.map(item => ({ key: `workspace:${account.id}:${item.id}`, text: item.name, label: <span className="account-menu__workspace-name">{item.name}</span>,
        checked: active && item.id === identity.workspaceId,
        onSelect: () => void run(() => active ? session!.switchWorkspace(item.id, sectionPath()) : session!.switchAccount(account.id, sectionPath(), item.id), 'Couldn’t switch workspace.') })),
      ...active ? [{ key: 'new-workspace', text: 'New workspace…', label: 'New workspace…', icon: <Plus />, onSelect: () => { setOpen(false); setCreating(true) } }] : [],
    ]
  })
  const full = accounts.length >= limit
  sections.push([
    { key: 'support', text: 'Contact support…', label: 'Contact support…', icon: <LifeBuoy />, onSelect: () => { setOpen(false); setSupport(true) } },
    { key: 'add', text: 'Add account', label: 'Add account', icon: <UserPlus />, disabled: full, hint: full ? `Up to ${limit} accounts. Sign out of one to add another.` : undefined, onSelect: () => { setOpen(false); session!.addAccount() } },
    { key: 'sign-out', text: 'Sign out of this account', label: 'Sign out of this account', icon: <LogOut />, onSelect: () => void run(() => session!.signOutAccount(self.id), 'Couldn’t sign out.') },
    ...accounts.length > 1 ? [{ key: 'sign-out-all', text: 'Sign out of all accounts', label: 'Sign out of all accounts', icon: <LogOut />, destructive: true, onSelect: () => void run(() => session!.signOutAll(), 'Couldn’t sign out.') }] : [],
  ])
  const trigger = <button type="button" id="sidebar-workspace" className="ui-input ui-select-trigger account-switcher" disabled={busy}
    aria-label={`${self.name || 'Account'}, ${workspace?.name ?? 'workspace'}. Switch account or workspace`} onPointerEnter={intent} onPointerDown={intent} onFocus={intent} onClick={phone ? () => void openSheet() : undefined}>
    <span className="account-switcher__current"><AccountAvatar name={self.name} email={self.email} size="sm" /><span className="account-switcher__workspace">{workspace?.name ?? 'Workspace'}</span></span>
    <span><ChevronDown size={14} aria-hidden="true" /></span>
  </button>
  const refocus = () => requestAnimationFrame(() => document.getElementById('sidebar-workspace')?.focus())
  const create = <>
    {creating && <CreateWorkspaceDialog onClose={() => { setCreating(false); refocus() }} onCreated={id => void run(() => session!.switchWorkspace(id, '/'), 'Couldn’t switch workspace.')} />}
    {support && <ContactSupportDialog onClose={() => { setSupport(false); refocus() }} />}
  </>
  // A phone gets a sheet: full-width rows at the bottom of the screen, in thumb reach, and Cancel.
  if (phone) return <>
    {trigger}
    <Sheet open={open} onOpenChange={setOpen} title="Accounts" className="ui-action-sheet account-sheet">
      {sections.map((section, index) => <div key={index} className="ui-action-sheet__items" role="group">{section.map(entry =>
        <button key={entry.key} type="button" disabled={entry.disabled && !entry.heading} aria-disabled={entry.disabled || undefined} aria-current={entry.checked || (entry.heading && entry.disabled) ? 'true' : undefined}
          className={['ui-action-sheet__item', entry.heading && 'account-sheet__account', entry.destructive && 'ui-action-sheet__item--danger', !entry.heading && !entry.icon && 'account-sheet__workspace'].filter(Boolean).join(' ')}
          onClick={() => { if (entry.disabled) return; setOpen(false); setTimeout(entry.onSelect, 0) }}>
          {entry.icon && <span className="ui-menu-icon">{entry.icon}</span>}
          {entry.icon ? <span className="ui-action-sheet__label">{entry.label}{entry.hint && <span className="ui-action-sheet__hint">{entry.hint}</span>}</span> : entry.label}
          {entry.checked && <Check className="account-menu__check" size={16} aria-label="Current workspace" />}
        </button>)}</div>)}
      <button type="button" className="ui-action-sheet__item ui-action-sheet__cancel" onClick={() => setOpen(false)}>Cancel</button>
    </Sheet>
    {create}
  </>
  return <>
    <DropdownPrimitive.Root open={open} onOpenChange={next => { setOpen(next); if (next) intent() }}>
      <DropdownPrimitive.Trigger asChild>{trigger}</DropdownPrimitive.Trigger>
      <DropdownPrimitive.Portal><DropdownPrimitive.Content align="start" sideOffset={4} className="ui-popover ui-menu account-menu" aria-label="Accounts and workspaces"><div className="ui-popover-scroll">
        {sections.map((section, index) => <DropdownPrimitive.Group key={index} className="account-menu__group">{section.map(entry => entry.heading && entry.disabled
          ? <DropdownPrimitive.Label key={entry.key} className="ui-menu-item account-menu__account" aria-current="true">{entry.label}</DropdownPrimitive.Label>
          : <DropdownPrimitive.Item key={entry.key} disabled={entry.disabled} onSelect={entry.onSelect} title={typeof entry.hint === 'string' ? entry.hint : undefined}
            className={['ui-menu-item', entry.heading ? 'account-menu__account' : entry.icon ? 'account-menu__action' : 'account-menu__workspace', entry.destructive && 'ui-menu-item--danger'].filter(Boolean).join(' ')}>
            {entry.icon && <span className="ui-menu-icon">{entry.icon}</span>}{entry.label}{entry.checked && <Check className="account-menu__check" size={14} aria-label="Current workspace" />}
          </DropdownPrimitive.Item>)}</DropdownPrimitive.Group>)}
      </div></DropdownPrimitive.Content></DropdownPrimitive.Portal>
    </DropdownPrimitive.Root>
    {create}
  </>
}

// A new workspace starts like a new signup: switching to it opens onboarding.
function CreateWorkspaceDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('')
  const create = useApiMutation((_api, value: string) => workspaceApi.create(value), 'Workspace created', false, false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    try { const workspace = await create.mutateAsync(name.trim()); onClose(); onCreated(workspace.id) } catch { /* inline */ }
  }
  return <Dialog open onOpenChange={open => { if (!open && !create.isPending) onClose() }} title="Create workspace" description="Each workspace has its own domains, keys and contacts. You’ll set up sending next."
    footer={<><Button onClick={onClose} disabled={create.isPending}>Cancel</Button><Button type="submit" form="create-workspace" variant="primary" loading={create.isPending}>Create workspace</Button></>}>
    <form id="create-workspace" className="stack" onSubmit={submit}>
      <MutationError error={create.error} />
      <Field label="Name" htmlFor="create-workspace-name" error={fieldError(create.error, 'name')}><Input id="create-workspace-name" maxLength={120} value={name} onChange={event => setName(event.target.value)} disabled={create.isPending} autoFocus required /></Field>
    </form>
  </Dialog>
}
