// Plain words for what a credential can do, shared by API keys, Create key, Settings → Account and the rituals page.
import type { Agent, AppPasswordProtocol, MailPermission } from '../../data/types'

// No serial comma, like the rest of the dashboard: "Read, reply and organize".
const list = new Intl.ListFormat('en-GB', { type: 'conjunction' })
const capitalize = (value: string) => value.replace(/^./, c => c.toUpperCase())

/**
 * Plain words for read/send/manage permission sets. Manage is only "Full access" for credentials that can also
 * administer keys, inbound and settings: unrestricted API keys and agents. Domain-restricted keys and agent tokens
 * can't, so they name the permissions instead.
 */
export function accessLabel(permissions: string[], admin: boolean) {
  if (permissions.includes('manage')) return admin ? 'Full access' : 'Read, send and manage'
  const known = permissions.filter(permission => permission === 'read' || permission === 'send')
  if (known.length === 1) return known[0] === 'send' ? 'Send only' : 'Read only'
  return capitalize(list.format(known.length ? known : permissions))
}
export const domainScope = (domains: string[]) => domains.length ? domains.join(', ') : 'All domains'
const mailWords: Record<MailPermission, string> = { create: 'create inboxes', read: 'read', send: 'reply', modify: 'organize' }
/** What a key limited to mail may do there: "Read", "Read and reply", "Read, reply and organize". */
export const mailLabel = (mail: MailPermission[]) => capitalize(list.format((['create', 'read', 'send', 'modify'] as const).filter(p => mail.includes(p)).map(p => mailWords[p])))
export const protocolLabel = (protocols: AppPasswordProtocol[]) => list.format((['imap', 'smtp'] as const).filter(p => protocols.includes(p)).map(p => p.toUpperCase()))
/** What an agent's sign-in was approved for. */
export const agentAccess = (permissions: string[]) => permissions.includes('manage') ? 'Full access' : permissions.includes('send') ? 'Read and send' : 'Read only'
/** A connected agent's client, and the label of its entry (`?profile=` on its MCP URL), so a personal and a work entry of
 *  one client are easy to tell apart. The label is display only. */
export const connectionTitle = (agent: Pick<Agent, 'name' | 'clientId' | 'profile'>) => `${agent.name || agent.clientId}${agent.profile ? ` · ${agent.profile}` : ''}`
