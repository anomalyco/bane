import { request } from './live'
import { productName } from '../../../api/src/brand'

// Settings → Activity (hosted, owners and admins): GET /v1/activity, the workspace's audit trail, newest first.
export type AuditActorType = 'member' | 'api_key' | 'mcp_grant' | 'agent_token' | 'inbox_key' | 'app_password' | 'operator' | 'support' | 'system' | 'stripe'
export type AuditEntry = {
  id: string
  at: string
  action: string
  actor: { type: AuditActorType; id: string | null; label: string | null; email: string | null }
  via: string
  target: { type: string; id: string | null } | null
  /** The member the event concerns when it is not the actor: whose role changed, or whose support request let Nightmail support in. */
  subject: { userId: string; email: string | null } | null
  summary: Record<string, unknown>
  reason: string | null
  requestId: string | null
  network: string | null
  client: string | null
}
export type ActivityPage = { data: AuditEntry[]; nextCursor: string | null }
export type ActivityFilters = { action?: string; actorType?: AuditActorType; since?: string; until?: string }

export const activityApi = {
  list: (filters: ActivityFilters & { cursor?: string; limit?: number }, signal?: AbortSignal) => {
    const params = new URLSearchParams({ limit: String(filters.limit ?? 50) })
    for (const key of ['cursor', 'action', 'actorType', 'since', 'until'] as const) if (filters[key]) params.set(key, filters[key]!)
    return request<ActivityPage>(`/v1/activity?${params}`, { signal })
  },
}

// What each action reads as. An action not listed here (a newer API) shows its raw name.
const labels: Record<string, string> = {
  'member.invite': 'Invited a member', 'member.invite_revoke': 'Revoked an invitation', 'member.join': 'Joined the workspace', 'member.role_change': 'Changed a member’s role', 'member.remove': 'Removed a member',
  'workspace.create': 'Created the workspace', 'workspace.rename': 'Renamed the workspace', 'settings.update': 'Updated settings', 'settings.inbound_policy': 'Changed the inbound policy',
  'api_key.create': 'Created an API key', 'api_key.revoke': 'Revoked an API key',
  'agent_token.create': 'Created an agent token', 'agent_token.revoke': 'Revoked an agent token', 'mcp_connection.revoke': 'Revoked an agent', 'mcp_connection.bind': 'Set an agent’s default workspace',
  'inbox_key.create': 'Created an API key', 'inbox_key.revoke': 'Revoked an API key', 'inbox_connection.create': 'Connected an agent to inboxes', 'app_password.create': 'Created an app password', 'app_password.revoke': 'Revoked an app password',
  'domain.create': 'Added a domain', 'domain.delete': 'Deleted a domain', 'domain.mail_from': 'Set a MAIL FROM domain', 'domain.receiving_host': 'Chose a receiving host',
  'inbound_domain.enable': 'Turned on receiving', 'inbound_domain.disable': 'Turned off receiving', 'inbound_domain.update': 'Updated a receiving domain',
  'inbound_subdomain.create': 'Added a receiving subdomain', 'inbound_subdomain.update': 'Updated a receiving subdomain', 'inbound_subdomain.delete': 'Deleted a receiving subdomain',
  'address.create': 'Created an address', 'address.update': 'Updated an address', 'address.delete': 'Deleted an address', 'address.release': 'Released an address',
  'inbox.create': 'Created an inbox', 'inbox.update': 'Updated an inbox', 'inbox.delete': 'Deleted an inbox',
  'webhook.create': 'Added a webhook', 'webhook.update': 'Updated a webhook', 'webhook.delete': 'Deleted a webhook', 'webhook.secret_reveal': 'Revealed a signing secret', 'webhook.secret_rotate': 'Rotated a signing secret',
  'inbound_webhook.create': 'Added an inbound webhook', 'inbound_webhook.update': 'Updated an inbound webhook', 'inbound_webhook.delete': 'Deleted an inbound webhook', 'inbound_webhook.secret_rotate': 'Rotated an inbound signing secret',
  'endpoint.create': 'Added an endpoint', 'endpoint.update': 'Updated an endpoint', 'endpoint.delete': 'Deleted an endpoint',
  'ritual.save': 'Saved a ritual', 'ritual.delete': 'Deleted a ritual', 'ritual.apply': 'Applied rituals', 'ritual.attach': 'Attached a ritual', 'ritual.restore': 'Restored rituals', 'ritual.omens': 'Changed omens',
  'routing.apply': 'Applied routing', 'routing.restore': 'Restored routing', 'route.create': 'Added a route', 'route.update': 'Updated a route', 'route.delete': 'Deleted a route',
  'connection.create': 'Connected sending', 'connection.delete': 'Disconnected sending', 'connection.verify': 'Verified the sending connection',
  'region.configure': 'Configured a region', 'region.provision': 'Provisioned a region', 'region.auto_validation': 'Changed auto-validation',
  'campaign.pause': 'Paused a campaign', 'campaign.resume': 'Resumed a campaign', 'campaign.cancel': 'Cancelled a campaign', 'audience.bulk_apply': 'Changed contacts in bulk',
  'sending.pause': 'Paused sending', 'sending.resume': 'Resumed sending',
  'support.contact': 'You contacted support', 'support.view': 'Viewed this workspace',
  'billing.topup': 'Added credit', 'billing.grant': `Promotional credit from ${productName}`, 'billing.adjustment': `Adjustment by ${productName}`, 'billing.refund_release': 'Refund canceled: credit restored',
  'billing.dispute': 'Card payment disputed', 'billing.dispute_reversal': 'Dispute closed: credit restored', 'billing.write_off': 'Unpaid balance written off', 'billing.expire': 'Credit expired',
}
export const actionLabel = (action: string) => labels[action] ?? action
// The area filter: each option is one action prefix, which the API takes as `action=<area>.`.
export const activityAreas: { value: string; label: string }[] = [
  ['member.', 'Members'], ['workspace.', 'Workspace'], ['settings.', 'Settings'], ['api_key.', 'API keys'], ['agent_token.', 'Agent tokens'], ['inbox_key.', 'API keys (earlier)'], ['app_password.', 'App passwords'],
  ['domain.', 'Domains'], ['inbound_domain.', 'Receiving domains'], ['address.', 'Addresses'], ['inbox.', 'Inboxes'], ['webhook.', 'Webhooks'], ['inbound_webhook.', 'Inbound webhooks'],
  ['endpoint.', 'Endpoints'], ['route.', 'Routes'], ['ritual.', 'Rituals'], ['connection.', 'Sending connection'], ['campaign.', 'Campaigns'], ['billing.', 'Billing'], ['support.', 'Support'],
].map(([value, label]) => ({ value, label }))
