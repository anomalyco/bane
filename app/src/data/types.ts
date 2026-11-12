export type RegionId = string
export type ISODate = string
export type Stream = 'transactional' | 'marketing'
export type AutoValidationMode = 'inherit' | 'off' | 'managed' | 'medium' | 'high' | 'unknown'
export type EmailStatus = 'queued' | 'attempting' | 'accepted' | 'sent' | 'delivered' | 'bounced' | 'complained' | 'complaint' | 'deferred' | 'rejected' | 'rendering_failed' | 'delayed' | 'suppressed' | 'canceled' | 'acceptance_unknown' | 'simulated'
export type ContactStatus = 'unknown' | 'subscribed' | 'unsubscribed' | 'suppressed'
// API campaign states, plus 'sent' which only the demo data uses.
export type CampaignStatus = 'draft' | 'preparing' | 'scheduled' | 'sending' | 'paused' | 'done' | 'failed' | 'canceled' | 'sent'
// Editable, deletable and launchable from scratch: a draft, or a failed launch that released nothing. A failed launch that
// already released recipients can only resume from its cursor or be canceled (it still holds its reservation).
export const campaignEditable = (campaign: Pick<Campaign, 'status' | 'delivery'>) => campaign.status === 'draft' || (campaign.status === 'failed' && !(campaign.delivery?.expanded ?? 0))
export const campaignResumable = (campaign: Pick<Campaign, 'status' | 'delivery'>) => campaign.status === 'paused' || (campaign.status === 'failed' && (campaign.delivery?.expanded ?? 0) > 0)
export const campaignActive = (campaign: Pick<Campaign, 'status' | 'delivery'>) => ['preparing', 'scheduled', 'sending', 'paused'].includes(campaign.status) || campaignResumable(campaign)
export type WebhookEvent = 'send' | 'delivered' | 'bounced' | 'complaint' | 'rejected' | 'delivery_delayed' | 'email.sent' | 'email.delivered' | 'email.bounced' | 'email.complained' | 'email.rejected' | 'email.rendering_failed' | 'email.delivery_delayed' | 'email.opened' | 'email.clicked' | 'contact.subscription_changed' | 'account.standing.changed'
export type TimeRange = '24h' | '7d' | '30d'
export interface PageRequest { page?: number; pageSize?: number; search?: string; regionId?: RegionId; status?: string; stream?: string; listId?: string; segmentId?: string; campaignId?: string; cursor?: string; to?: string; from?: string }
export interface PageResult<T> { items: T[]; total?: number; nextCursor?: string | null; page: number; pageSize: number; facets?: Record<string, number> }
export interface RegionCatalogEntry {
  region: string; enabled: boolean; isDefault: boolean
  discoveryStatus: 'not_discovered' | 'discovering' | 'stale' | 'ready' | 'needs_provisioning' | 'blocked'
  lastDiscoveredAt: string | null; provisionJobId: string | null
  provisionStatus: 'pending' | 'running' | 'completed' | 'failed' | null; provisionError: string | null
}
export interface RegionCatalog { defaultRegion: string; data: RegionCatalogEntry[] }
export interface RegionConfigureInput { enabled?: boolean; makeDefault?: boolean }
export interface RegionProvisionReceipt { jobId: string; status: 'pending' | 'running' }
export interface SesDiscovery {
  region: string; checkedAt: string
  account: { id: string; productionAccess: boolean | null; sendingEnabled: boolean | null; enforcementStatus: string | null; quota: { max24HourSend: number | null; maxSendRate: number | null; sentLast24Hours: number | null } } | null
  domains: { name: string; verificationStatus: string | null; sendingEnabled: boolean | null }[]
  identitiesTruncated: boolean
  resources: {
    transactional: SesConfigurationSet; marketing: SesConfigurationSet; eventDestinationName: string
    topic: { name: string; arn: string | null; exists: boolean | null; owned: boolean | null; policyReady: boolean | null; subscription: 'unknown' | 'missing' | 'pending' | 'confirmed'; rawMessageDelivery: boolean | null; subscriptionsTruncated: boolean; staleSubscriptions: number }
  }
  feedbackUrl: string | null; status: 'ready' | 'needs_provisioning' | 'blocked'; provisioned: boolean
  blockers: { code: string; message: string }[]; warnings: { code: string; message: string }[]
  reputation?: SesReputation | null
}
export interface SesReputation { available: boolean; reason: string | null; bounceRate: number | null; complaintRate: number | null; series: { at: string; bounceRate: number | null; complaintRate: number | null }[] }
interface SesConfigurationSet { name: string; exists: boolean | null; owned: boolean | null; sendingEnabled: boolean | null; eventDestinationExists: boolean | null; eventWired: boolean | null; autoValidation: AutoValidationMode | null }
export interface Workspace { id: string; name: string; accountId?: string; role: string; members?: { id: string; name: string; email: string; role: string }[] }
export interface EmailEvent { id: string; type: string; at: ISODate; description: string; diagnostic?: string }
export interface Email { contact?: {id:string; suppressed:boolean} | null; campaignId?: string | null; text?: string | null; eventsNextCursor?: string | null; fromName?: string; simulated?: boolean; attachments?: string[]; id: string; regionId: RegionId; to: string; from: string; subject: string; stream: Stream; status: EmailStatus; sentAt: ISODate; html: string; events: EmailEvent[] }
export interface ChartPoint { at: ISODate; sent: number; delivered: number; bounced: number; complaints: number }
/** GET /v1/sender-score: the workspace's reputation grade, computed by the API. */
export type SenderGrade = 'A+' | 'A' | 'B' | 'C' | 'D' | 'F'
export interface SenderScoreFactor { key: 'complaints' | 'content' | 'bounces' | 'hygiene' | 'auth' | 'engagement'; label: string; weight: number; value: number | null; score: number | null; points: number | null; source: 'measured' | 'neutral'; basis: string }
/** Hosted only: the daily limit the score sets (rolling 24 hours, recipients) and what changes it. */
export interface SenderLimit { daily: number | null; source: 'calibrating' | 'score' | 'override' | 'exempt'; band: number; next: { limit: number; atScore: number } | null; override: { daily: number; expiresAt: ISODate | null } | null; restore: { daily: number; until: ISODate } | null; strikeCapUntil: ISODate | null; perMinute: number; marketingPerHour: number; transactionalReserve: number }
export type StandingStep = 'ok' | 'notice' | 'warn' | 'restrict' | 'pause'
export interface StandingReason { code: string; metric: 'complaints' | 'bounces' | 'marketing_bounces' | 'transactional_bounces' | 'screen' | 'external'; value: number; count: number; threshold: number; minimum: number; window: '24h' | '7d' | null; step: StandingStep; message: string }
/** Hosted only: the enforcement step, why, and what an owner may release from the dashboard. */
export interface SenderStanding { step: StandingStep; reasons: StandingReason[]; since: ISODate; pauseKind: 'bounce' | 'full' | null; marketingHeld: boolean; marketingRelease: { percent: number; until: ISODate } | null; strikes: number; selfService: { available: boolean; action: 'release_marketing' | 'resume_sending' | null; reason: string | null; availableAt: ISODate | null }; version: number; sequence: number }
export interface SenderScore { state: 'warmup' | 'graded'; emails: { firstEmails: number; last30Days: number }; needed: number; calibratedAt: ISODate | null; score: number | null; grade: SenderGrade | null; target: number; raw: number; band: { min: number; max: number } | null; next: { grade: SenderGrade; at: number } | null; factors: SenderScoreFactor[]; history: { date: string; score: number }[]; limit: SenderLimit | null; standing: SenderStanding | null; computedAt: ISODate }
/** POST /v1/sender-score/release: the fix checklist an owner confirms before releasing a restrict or a bounce-only pause. */
export interface StandingReleaseInput { checklist: { bouncedRemoved: true; listSourceConfirmed: true } }
export interface Overview { periodStart: ISODate; periodEnd: ISODate; sent: number; delivered: number; bounced: number; complaints: number; deferred: number; previousSent: number; points: ChartPoint[]; streams: { name: Stream; sent: number }[]; recentCampaigns: Campaign[] }
export interface Contact { properties?: Record<string, string | number | boolean | null>; id: string; email: string; name: string; country: string; status: ContactStatus; listIds: string[]; createdAt: ISODate; lastOpenedAt: ISODate | null; consent: { source: string; at: ISODate | null }; suppressionReason?: string }
export interface ContactInput { id?: string; email: string; name: string; country: string; status: ContactStatus; listIds: string[] }
export interface AudienceList { unknown?: number; id: string; name: string; total: number; subscribed: number; unsubscribed: number; suppressed: number; createdAt: ISODate }
export interface SegmentRule { id: string; field: 'status' | 'country' | 'listId' | 'lastOpenedAt'; operator: 'is' | 'is_not' | 'within_days'; value: string }
export interface Segment { rule?: Record<string, unknown>; id: string; name: string; match: 'all' | 'any'; rules: SegmentRule[]; matched: number; eligible: number; updatedAt: ISODate }
export type SegmentInput = Pick<Segment, 'name' | 'match' | 'rules' | 'rule'> & { id?: string }
export interface AudiencePreview { matched: number; suppressed: number; unsubscribed: number; eligible: number; contacts: Contact[] }
export type CampaignPreview = { html: string; text: string }
export interface Campaign { counts?: { total: number; byStatus: Record<string, number> }; delivery?: CampaignDelivery | null; archivedAt?: ISODate | null; revision?: number; draft?: Record<string, any>; attachments?: string[]; sourceTemplateId?: string | null; sourceTemplateRevision?: number | null; id: string; regionId: RegionId; name: string; subject: string; previewText: string; fromName: string; fromEmail: string; replyTo: string[]; listId: string; segmentId: string | null; html: string; status: CampaignStatus; createdAt: ISODate; updatedAt: ISODate; scheduledAt: ISODate | null; timezone: string; recipients: number; delivered: number; bounced: number; complaints: number }
// pacing, pausedAt, pauseReason, waiting, and rateShare are optional so older API responses still type-check.
// rateShare is the fraction (0.05–1) of the SES per-second send rate the campaign may use; 1 is the full rate.
export interface CampaignPacing { perDay: number | null; autoPause: boolean; rateShare?: number; windowStartedAt: ISODate | null; windowExpanded: number; nextWindowAt: ISODate | null }
export interface CampaignDelivery { total: number; prepared: number; expanded: number; canceled: number; error: { code: string; message: string } | null; pacing?: CampaignPacing; pausedAt?: ISODate | null; pauseReason?: { code: string; message: string } | null; waiting?: { reason: 'pacing_window' | 'ses_daily_quota' | 'hosted_daily_quota'; until: ISODate } | null }
export interface CampaignPacingInput { perDay: number | null; autoPause?: boolean; rateShare?: number }
type CampaignRate = { value: number | null; numerator: number; denominator: number }
// Lifetime distinct email outcomes (GET /v1/campaigns/{id}/stats); outcomes overlap and simulated mail is counted separately.
export interface CampaignStats { tracking: boolean; totals: { accepted: number; delivered: number; bounced: number; complained: number; opened: number; clicked: number; failed: number; deliveryDelayed: number; simulated: number }; rates: Record<'delivery' | 'bounce' | 'complaint' | 'open' | 'click', CampaignRate> }
// defaults are the fallback values for {{placeholders}} a contact has no value for (the API's draft.defaults).
export type CampaignInput = Pick<Campaign, 'regionId' | 'name' | 'subject' | 'previewText' | 'fromName' | 'fromEmail' | 'listId' | 'segmentId' | 'html'> & { replyTo?: string[]; id?: string; revision?: number; draft?: Record<string, any>; attachments?: string[]; defaults?: Record<string, string>; templateId?: string; idempotencyKey?: string }
export interface CampaignState { id: string; revision: number; updatedAt: ISODate; status: CampaignStatus; scheduledAt: ISODate | null; archivedAt: ISODate | null }
export interface SendCampaignInput { revision?: number; id: string; mode: 'now' | 'schedule'; scheduledAt?: ISODate; timezone: string; pacing?: { perDay?: number | null; autoPause?: boolean; rateShare?: number } }
export interface ApiKey { revokedAt?: string | null; id: string; name: string; prefix: string; permission: 'send' | 'read' | 'manage'; domains: string[]; createdAt: ISODate; lastUsedAt: ISODate | null }
export interface ApiKeyInput { name: string; permission: 'send' | 'read' | 'read_send' | 'manage'; domains: string[] }
export interface CreatedApiKey { key: ApiKey; secret: string }
export interface AgentTokenSummary { id: string; grantId: string; permissions: ('read' | 'send' | 'manage')[]; domains: string[]; purpose: string; expiresAt: ISODate; createdAt: ISODate; lastUsedAt: ISODate | null; revokedAt: ISODate | null }
export interface McpConnection { id: string; clientId: string; name: string | null; userEmail: string; scopes: string[]; createdAt: ISODate; updatedAt: ISODate; status?: 'active'|'expired'|'revoked'; workspaceId?: string | null; receiving?: boolean }
export interface CampaignTemplateDraft { name: string; description: string; subject: string; previewText?: string; fromName?: string; replyTo: string[]; html?: string; attachments: string[] }
export interface CampaignTemplate { id: string; url: string; revision: number; draft: CampaignTemplateDraft; published: CampaignTemplateDraft | null; publishedRevision: number | null; archivedAt: ISODate | null; createdAt: ISODate; updatedAt: ISODate }
export interface CampaignTemplateSummary { id: string; url: string; revision: number; name: string; description: string; subject: string; published: boolean; publishedRevision: number | null; archivedAt: ISODate | null; createdAt: ISODate; updatedAt: ISODate }
export interface AttachmentApi { upload(file: File, inline?: {contentId: string}): Promise<Attachment>; get(id: string, signal?: AbortSignal): Promise<Attachment>; content(id: string, signal?: AbortSignal): Promise<{id: string; filename: string; contentType: string; content: string}>; remove(id: string): Promise<void> }
export type DnsRecordPurpose = 'sending' | 'receiving' | 'mail_from' | 'dmarc'
type Dmarc = { status: 'missing' | 'invalid' | 'none' | 'quarantine' | 'reject'; record: string | null; source: string | null; adkim: 'r' | 's'; aspf: 'r' | 's'; alignment: { dkim: boolean; spf: boolean } }
export interface DnsRecord { id: string; type: 'TXT' | 'CNAME' | 'MX'; name: string; value: string; status: 'verified' | 'pending' | 'not_checked'; purpose?: DnsRecordPurpose; note?: string }
// Why receiving at `host` needs attention, from the API's DNS checks. Blocking issues can't work until DNS or the choice changes.
export interface ReceivingIssue { code: 'cname' | 'foreign_mx' | 'split' | 'wildcard' | 'bane_record' | 'host_taken' | 'claimed' | 'delegated' | 'mx_missing' | 'wrong_region' | 'null_mx' | 'proof_stale' | 'identity_stale'; host: string; blocking: boolean; message: string; provider?: string | null; target?: string | null; suggestion?: string | null }
export interface Domain { receivingIssue?: ReceivingIssue | null; releasesAt?: string | null; dmarc?: Dmarc | null; dnsStatus?: 'available' | 'unavailable'; dnsUnavailableReason?: string | null; id: string; regionId: RegionId; name: string; status: 'verified' | 'pending' | 'issue'; verified?: boolean; dkimStatus?: 'verified' | 'pending' | 'failed'; mailFromDomain?: string | null; mailFromStatus: 'verified' | 'pending' | 'not_configured' | 'failed'; sending?: 'pending' | 'verified'; receiving?: 'pending' | 'verified'; records: DnsRecord[]; createdAt: ISODate }
export type MailboxDomainStatus = 'off' | 'provisioning' | 'waiting_for_mx' | 'active' | 'disabling' | 'disabled' | 'failed'
export interface MailboxDomain {
  id: string; name: string; region: RegionId; status: MailboxDomainStatus; catchAll: 'create_address' | 'store'
  dns: { type: 'MX'; name: string; value: string; priority: number }[]
  mx: { state: 'active' | 'missing' | 'conflict' | 'mixed' | 'wrong_region' | 'null_mx' | 'cname' | 'error'; message: string; providers: string[]; checkedAt: ISODate } | null
  lastError: string | null; enabledAt: ISODate | null; checkedAt: ISODate | null; addressCount: number
  subdomains?: { enabled: boolean; count: number; dns: { type: 'MX'; name: string; value: string; priority: number }[] }
}
export interface Mailbox { id: string; key?: string | null; address: string; displayName: string | null; domain: string; aliases: string[]; rules: string[]; origin: 'api' | 'auto'; createdAt: ISODate; updatedAt: ISODate; stats: { threads: number; unreadThreads: number; lastMessageAt: ISODate | null }; publicAddress?: string | null; expiresAt?: ISODate | null; kind?: 'address' | 'inbox' }
export interface MailAddress { name: string | null; address: string }
export type MailboxPermission = 'read' | 'send' | 'modify'
export const inboundEventTypes = ['message.received', 'message.junk', 'message.stored', 'message.queued', 'message.sent', 'message.delivered', 'message.delayed', 'message.bounced', 'message.complained', 'message.failed', 'thread.updated', 'address.created', 'address.deleted', 'inbox.created', 'inbox.deleted', 'message.held', 'inbox.quota_exceeded'] as const
export type MailboxEventType = typeof inboundEventTypes[number]
export interface MailboxKey { id: string; name: string; prefix: string; addressIds: string[] | null; permissions: MailboxPermission[]; createdAt: ISODate; lastUsedAt: ISODate | null; revokedAt: ISODate | null }
export interface MailboxKeyInput { name: string; addressIds: string[] | null; permissions: MailboxPermission[] }
export interface MailboxWebhookDelivery { id: string; webhookId: string; eventId: string; status: 'pending' | 'delivered' | 'failed'; attemptCount: number; lastStatusCode: number | null; lastError: string | null; createdAt: ISODate; updatedAt: ISODate }
export type MailboxThreadView = 'inbox' | 'starred' | 'archive' | 'spam' | 'trash' | 'all'
export interface MailboxThread {
  id: string; mailboxId: string; subject: string; snippet: string; participants: MailAddress[]; messageCount: number; unreadCount: number
  lastMessageAt: ISODate; lastInboundAt: ISODate | null; archived: boolean; starred: boolean; spam: boolean; trashed: boolean; labels: string[]
}
export interface MailboxMessage {
  id: string; threadId: string; mailboxId: string; direction: 'inbound' | 'outbound'; status: string; errorCode: string | null; read: boolean; labels: string[]
  from: MailAddress; to: MailAddress[]; cc: MailAddress[]; bcc: MailAddress[]; replyTo: MailAddress[]; subject: string; snippet: string; sentAt: ISODate | null; receivedAt: ISODate
  attachmentCount: number; spam: boolean; automated: boolean; messageId: string | null; inReplyTo: string | null; references: string[]
  text: string; replyText: string; html: string | null; bodyTruncated: boolean
  attachments: { id: string; filename: string; contentType: string; size: number; contentId: string | null; disposition: 'attachment' | 'inline' }[]
  verdicts: { spf?: string; dkim?: string; dmarc?: string; spam?: string; virus?: string }
}
export interface MailboxThreadDetail extends MailboxThread { messages: MailboxMessage[] }
// Agent inboxes: expiring addresses for agents and tests (`/v1/inboxes`). The ID also works as an addressId.
export type InboxStatus = 'active' | 'expired' | 'deleting'
export interface Inbox {
  id: string; kind: 'inbox'; type: 'ephemeral' | 'sandbox'; address: string; domain: string; name: string | null; metadata: Record<string, unknown>; clientId: string | null
  status: InboxStatus; createdAt: ISODate; expiresAt: ISODate; deleteAfter: ISODate; limits: { messages: number; bytes: number }
  send: { enabled: boolean; perDay: number; replyOnly: true }; usage: { messages: number; bytes: number; held: number; unread: number; lastMessageAt: ISODate | null }
}
export interface InboxInput { type: Inbox['type']; domain?: string; name?: string; ttlSeconds: number; send?: { enabled: boolean }; credential?: { name: string; permissions: ('read' | 'modify' | 'send')[] } }
export interface CreatedInbox extends Inbox { credential?: { id: string; secret: string; permissions: string[]; expiresAt: ISODate } }
export interface InboxMessage {
  id: string; threadId: string; cursor: string; from: MailAddress; to: MailAddress[]; subject: string; snippet: string; receivedAt: ISODate; read: boolean; junk: boolean
  held: 'quota' | 'expired' | null; attachmentCount: number; auth: { spf?: string; dkim?: string; dmarc?: string }; simulated: boolean; hiddenContent: boolean
  extract: { codes: string[]; links: { text: string; href: string; mismatch: boolean }[] }
}
export interface InboxMessageDetail extends InboxMessage { text: string; replyText: string; html: string | null; attachments: { id: string; filename: string; contentType: string; size: number; url: string | null; expiresAt: ISODate | null }[] }
export interface InboxMessagePage { data: InboxMessage[]; cursor: string; hasMore: boolean }
// Inbound is thread-first: a conversation can be visible through several receiving addresses.
export type InboundAddress = Mailbox
export interface InboundAddressInput { address: string; displayName?: string | null; aliases?: string[]; publicAddress?: string; ttlSeconds?: number }
export interface InboundAddressPatch { displayName?: string | null; aliases?: string[] }
export type InboundThreadView = MailboxThreadView
/** from: the newest visible message's sender (absent on older API responses). */
export interface InboundThread { id: string; subject: string; snippet: string; from?: MailAddress; lastMessageAt: ISODate; addressIds: string[]; messageCount: number }
export interface InboundMessage {
  id: string; threadId: string; addressIds: string[]; direction: 'inbound' | 'outbound'; status: string
  from: MailAddress; to: MailAddress[]; cc: MailAddress[]; replyTo: MailAddress[]; subject: string; snippet: string
  text: string; replyText: string; receivedAt: ISODate; bodyTruncated: boolean; attachmentCount: number
  emailId: string | null; messageId: string | null; inReplyTo: string | null; references: string[]
  /** Read state for the requested address scope; absent on older API responses. */
  read?: boolean
}
export interface InboundAttachment { id: string; filename: string; contentType: string; size: number; disposition: string; contentId: string | null }
// htmlTooComplex: the HTML is past the API's parsing budget; show the text instead of rendering it.
export interface InboundMessageDetail extends InboundMessage { html: string | null; htmlTooComplex?: boolean; attachments: InboundAttachment[] }
export interface InboundAddressState { addressId: string; unreadCount: number; archived: boolean; starred: boolean; trashed: boolean; spam: boolean; labels: string[] }
export interface InboundThreadPatch { addressId?: string; read?: boolean; starred?: boolean; archived?: boolean; trashed?: boolean; spam?: boolean; addLabels?: string[]; removeLabels?: string[] }
export interface InboundRecipients { to: string[]; cc: string[]; bcc: string[] }
export interface InboundThreadDetail extends InboundThread { messages: InboundMessage[]; nextCursor: string | null; addressStates?: InboundAddressState[] }
export interface InboundReplyInput { text: string; addressId?: string; replyToMessageId?: string; replyAll?: boolean; allowAutomated?: boolean; expectedRecipients?: InboundRecipients; idempotencyKey: string }
export interface InboundThreadInput { addressId: string; to: string[]; subject: string; text: string; idempotencyKey: string }
/** Header values are write-only: reads return names, and a masked hint for managers. */
export interface WebhookHeaderView { name: string; hint?: string; updatedAt?: ISODate }
/** Omitted on update to keep the current headers; any list replaces them all, and [] removes them. */
export interface WebhookHeaderInput { name: string; value: string }
export type InboundWebhookFormat = 'bane' | 'inbound'
export interface InboundWebhook { id: string; key?: string | null; name?: string | null; url: string; description: string; eventTypes: MailboxEventType[]; addressIds: string[] | null; paused: boolean; headers: WebhookHeaderView[]; format?: InboundWebhookFormat; junk?: 'skip' | 'include'; createdAt: ISODate; updatedAt: ISODate }
/** eventTypes [] is a route-only webhook: it gets only the mail a route sends to it. */
export interface InboundWebhookInput { url: string; description: string; eventTypes: MailboxEventType[]; addressIds: string[] | null; headers?: WebhookHeaderInput[]; format?: InboundWebhookFormat; junk?: 'skip' | 'include' }
/** A recipient → destinations rule. to: [] keeps mail without an inbox; 'drop' discards it. */
export interface MailRoute { id: string; key: string | null; match: string; to: string[] | 'drop'; enabled: boolean; subaddresses: boolean; note: string; createdAt: ISODate }
export interface MailRouteInput { match: string; to: string[] | 'drop'; enabled?: boolean }
export type RouteTier = 'exact' | 'address' | 'pattern' | 'subaddress' | 'catchall' | 'default'
export interface RoutedRecipient { address: string; tier: RouteTier; route: string | null; inboxes: string[]; webhooks: string[]; dropped: boolean; junk: boolean; domainDefault: 'store' | 'create_address'; warnings: string[] }
export interface RoutingTestResult { version: number; unsaved: boolean; message: { from: string | null; subject: string | null } | null; recipients: RoutedRecipient[] }
export interface RoutingTestInput { to?: string[]; raw?: string; junk?: boolean }
// One row of the unified logs (GET /v1/logs): sent or received mail, newest first. Delivery details of received mail
// (envelopeTo, regionId, the spam status) reach administrators only.
export type LogDirection = 'all' | 'sent' | 'received'
export interface LogEntry {
  id: string; direction: 'sent' | 'received'; at: ISODate; status: string; from: MailAddress; to: string[]; subject: string
  stream: Stream | null; campaignId: string | null; simulated: boolean; attachmentCount: number | null; threadId: string | null
  addresses: { id: string; address: string }[] | null; regionId: RegionId | null; envelopeTo: string[] | null
}
export interface ReceivedEmail {
  id: string; threadId: string; status: string; from: MailAddress; to: MailAddress[]; subject: string; snippet: string
  receivedAt: ISODate; attachmentCount: number
  // Delivery details: present for owners and admins only.
  spam?: boolean; region?: RegionId | null; envelopeTo?: string[]; addresses?: { id: string; address: string }[]
}
export interface ReceivedEmailDetail extends ReceivedEmail {
  sentAt: ISODate | null; cc: MailAddress[]; replyTo: MailAddress[]; messageId: string | null; inReplyTo: string | null; references: string[]
  text: string; replyText: string; html: string | null; htmlTooComplex?: boolean; bodyTruncated: boolean; headers?: { name: string; value: string }[]
  attachments: { id: string; filename: string; contentType: string; size: number; contentId: string | null; disposition: 'attachment' | 'inline'; url: string | null }[]
  verdicts?: { spf?: string; dkim?: string; dmarc?: string; spam?: string; virus?: string }
  sizeBytes?: number | null; rawUrl?: string | null
}
export interface WebhookDelivery { id: string; at: ISODate; regionId: RegionId; event: WebhookEvent; response: number | null; attempts: number; status: 'delivered' | 'retry_pending' | 'pending' | 'failed' | 'paused'; payload: Record<string, unknown>; /** A Test endpoint delivery, not real traffic. */ test?: boolean }
export interface Webhook { id: string; name: string; url: string; regionIds: RegionId[] | 'all'; events: WebhookEvent[]; status: 'active' | 'paused'; secretHint: string; headers: WebhookHeaderView[]; deliveries: WebhookDelivery[]; nextCursor?: string | null; /** The signing secret: only in the response that created the webhook. */ secret?: string }
// An update without regionIds keeps the endpoint's saved region scope.
export type WebhookInput = Pick<Webhook, 'name' | 'url' | 'events'> & { regionIds?: Webhook['regionIds']; id?: string; headers?: WebhookHeaderInput[] }
// Plain-language copy with a next step for errors a new workspace can meet. The server's message stays in `detail`.
// A dashboard session that meets these is a member: say who can do it instead of the key jargon behind the code.
const ownersOnly = 'Only workspace owners and admins can do this. Ask one of them to do it for you, or to make you an admin.'
export const permissionCodes = new Set(['PERMISSION_DENIED', 'ADMIN_REQUIRED', 'OWNER_REQUIRED'])
const friendlyErrors: Record<string, (detail: string) => string> = {
  PERMISSION_DENIED: detail => /permission|owner or admin|administration|principal/i.test(detail) ? ownersOnly : detail,
  ADMIN_REQUIRED: () => ownersOnly,
  OWNER_REQUIRED: () => 'Only a workspace owner can do this.',
  SES_NOT_CONFIGURED: () => 'Sending isn’t available on this server right now. Try again in a few minutes.',
  TENANT_NOT_READY: () => 'Your workspace is still being set up for sending. This usually takes a minute or two, so try again shortly.',
  HOSTED_SENDING_PAUSED: detail => `Sending is paused for this workspace while its reputation is reviewed${detail ? ` (${detail.replace(/\.$/, '')})` : ''}. Receiving still works.`,
  SENDER_DOMAIN_NOT_VERIFIED: () => 'This sender’s domain isn’t verified yet. Open Domains to check its DNS records; you can send once it shows Verified.',
  SEND_LIMIT_REACHED: detail => detail,
  NETWORK_UNAVAILABLE: detail => detail,
  AUDIENCEQL_LIMIT_EXCEEDED: () => 'A bulk change can update at most 10,000 contacts at a time. Filter to a smaller list and try again.',
  AUDIENCE_PLAN_EXPIRED: () => 'This count is more than 15 minutes old. Count again, then confirm.',
  STALE_AUDIENCE_PLAN: () => 'Some of these contacts changed after they were counted. Count again, then confirm.',
}
export class ApiError extends Error {
  /** The server's own message. */
  readonly detail: string
  /** What to show a person: plain language with a next step. */
  readonly text: string
  /** The code and request ID, for support and logs. */
  readonly reference: string
  /** Every problem, when the API reports several (ritual diagnostics). */
  details?: Record<string, unknown>[]
  constructor(message: string, public code: string = 'validation', public fields: Record<string, string> = {}, public requestId?: string, public status?: number) {
    super(`${message} [${code}]${requestId ? ` · Request ${requestId}` : ''}`)
    this.name = 'ApiError'
    this.detail = message
    this.text = friendlyErrors[code]?.(message) ?? message
    this.reference = `${code}${requestId ? ` · Request ${requestId}` : ''}`
  }
}

// The UI depends on this boundary, never on fixture data or a transport implementation.
// Dates cross the boundary as ISO-8601 strings; rates are ratios, not formatted percentages.
export type CursorItems<T> = T[] & { nextCursor?: string | null }
export interface BaneApi {
  consentHistory: (id: string, cursor?: string) => Promise<{items: ConsentEvent[]; nextCursor: string | null}>
  emailEvents?: (id: string, cursor?: string) => Promise<{items: EmailEvent[]; nextCursor: string | null}>
  attachments: AttachmentApi
  templateAssets: AttachmentApi
  imports: { preview(input: {csv: string; mapping: Record<string, string>; listId?: string}): Promise<ImportPreview>; commit(id: string, input?: ImportCommitInput): Promise<ImportPreview> }
  consent: (id: string, input: ConsentInput) => Promise<Contact>
  /** AudienceQL bulk changes: plan counts and samples the contacts a statement changes; apply changes exactly those. */
  audienceQuery: { plan(statement: string): Promise<AudiencePlan>; apply(input: { planId: string; confirmResubscribe?: boolean; evidence?: string }): Promise<{ affected: number }> }
  webhookDeliveries?: (id: string, cursor?: string) => Promise<{items: WebhookDelivery[]; nextCursor: string | null}>
  readonly mode: 'demo' | 'live'
  regions: { list(signal?: AbortSignal): Promise<RegionCatalog>; configure(region: string, input: RegionConfigureInput, signal?: AbortSignal): Promise<RegionCatalog>; discover(region: string, options?: { refresh?: boolean }, signal?: AbortSignal): Promise<SesDiscovery>; provision(region: string, signal?: AbortSignal): Promise<RegionProvisionReceipt>; updateAutoValidation(region: string, stream: Stream, mode: Exclude<AutoValidationMode, 'inherit' | 'unknown'>, signal?: AbortSignal): Promise<{stream: Stream; mode: AutoValidationMode}> }
  workspace: { get(signal?: AbortSignal): Promise<Workspace>; update(input: { name: string }, signal?: AbortSignal): Promise<Workspace> }
  overview: { get(input: { regionId: string; range: TimeRange; stream?: Stream }, signal?: AbortSignal): Promise<Overview>; setup(signal?: AbortSignal): Promise<OverviewSetup> }
  senderScore: { get(signal?: AbortSignal): Promise<SenderScore>; release(input: StandingReleaseInput, signal?: AbortSignal): Promise<SenderScore> }
  emails: { list(input: PageRequest, signal?: AbortSignal): Promise<PageResult<Email>>; get(id: string, signal?: AbortSignal): Promise<Email> }
  logs: { list(input: PageRequest & { direction?: LogDirection }, signal?: AbortSignal): Promise<PageResult<LogEntry>> }
  campaigns: { list(input: PageRequest & { archived?: boolean }, signal?: AbortSignal): Promise<PageResult<Campaign>>; get(id: string, signal?: AbortSignal): Promise<Campaign>; state(id: string, signal?: AbortSignal): Promise<CampaignState>; preview(id: string, signal?: AbortSignal): Promise<CampaignPreview>; setArchived(input: { id: string; archived: boolean }, signal?: AbortSignal): Promise<Campaign>; save(input: CampaignInput, signal?: AbortSignal): Promise<Campaign>; audience(input: { id: string; listId: string; segmentId: string | null }, signal?: AbortSignal): Promise<AudiencePreview>; send(input: SendCampaignInput, signal?: AbortSignal): Promise<Campaign | CampaignSendReceipt>; pause(id: string, signal?: AbortSignal): Promise<Campaign>; resume(id: string, signal?: AbortSignal): Promise<Campaign>; setPacing(id: string, input: CampaignPacingInput, signal?: AbortSignal): Promise<Campaign>; unschedule(id: string, signal?: AbortSignal): Promise<Campaign>; reschedule(id: string, scheduledAt: ISODate, signal?: AbortSignal): Promise<Campaign>; cancel(id: string, signal?: AbortSignal): Promise<{ canceled: number; inFlight: number }>; stats(id: string, signal?: AbortSignal): Promise<CampaignStats>; test(input: { id: string; to: string; data?: Record<string, string> }, signal?: AbortSignal): Promise<{ accepted: boolean; id?: string; status?: string; simulated?: boolean }> }
  templates: { list(input?: PageRequest & { archived?: boolean; publishedOnly?: boolean }, signal?: AbortSignal): Promise<PageResult<CampaignTemplateSummary>>; get(id: string, signal?: AbortSignal): Promise<CampaignTemplate>; create(input: {name: string; description?: string}, signal?: AbortSignal): Promise<CampaignTemplate>; update(id: string, revision: number, draft: CampaignTemplateDraft, signal?: AbortSignal): Promise<CampaignTemplate>; publish(id: string, revision: number, signal?: AbortSignal): Promise<CampaignTemplate>; archive(id: string, archived: boolean, signal?: AbortSignal): Promise<CampaignTemplate>; remove(id: string, signal?: AbortSignal): Promise<void>; preview(id: string, published?: boolean, signal?: AbortSignal): Promise<CampaignPreview> }
  contacts: { list(input: PageRequest & { email?: string }, signal?: AbortSignal): Promise<PageResult<Contact>>; get(id: string, signal?: AbortSignal): Promise<Contact>; save(input: ContactInput, signal?: AbortSignal): Promise<Contact> }
  lists: { list(input?: PageRequest & { counts?: boolean }, signal?: AbortSignal): Promise<PageResult<AudienceList>>; get(id: string, signal?: AbortSignal): Promise<AudienceList>; create(input: { name: string }, signal?: AbortSignal): Promise<AudienceList>; remove(id: string, signal?: AbortSignal): Promise<void> }
  segments: { list(input?: PageRequest, signal?: AbortSignal): Promise<PageResult<Segment>>; get(id: string, signal?: AbortSignal): Promise<Segment>; save(input: SegmentInput, signal?: AbortSignal): Promise<Segment>; preview(input: SegmentInput & { listId?: string }, signal?: AbortSignal): Promise<AudiencePreview> }
  keys: { list(signal?: AbortSignal, cursor?: string, includeRevoked?: boolean): Promise<CursorItems<ApiKey>>; create(input: ApiKeyInput, signal?: AbortSignal): Promise<CreatedApiKey>; revoke(id: string, signal?: AbortSignal): Promise<void> }
  credentials: { agentTokens(includeInactive?: boolean, signal?: AbortSignal): Promise<AgentTokenSummary[]>; revokeAgentToken(id: string, signal?: AbortSignal): Promise<void>; mcpConnections(signal?: AbortSignal): Promise<McpConnection[]>; revokeMcpConnection(id: string, signal?: AbortSignal): Promise<void>; bindMcpConnection(id: string, input: { workspaceId: string; receiving: boolean }, signal?: AbortSignal): Promise<void> }
  domains: { list(input: PageRequest & { refresh?: boolean }, signal?: AbortSignal): Promise<PageResult<Domain>>; get(id: string, signal?: AbortSignal): Promise<Domain>; create(input: { regionId: string; name: string }, signal?: AbortSignal): Promise<Domain>; configureMailFrom(id: string, mailFromDomain: string, signal?: AbortSignal): Promise<Domain>; verify(id: string, signal?: AbortSignal): Promise<Domain>; chooseReceivingHost?(id: string, input: { host: string | null; confirm?: boolean }, signal?: AbortSignal): Promise<Domain>; remove(id: string, signal?: AbortSignal): Promise<void> }
  mailboxes: { domains(signal?: AbortSignal): Promise<MailboxDomain[]>; domain(id: string, signal?: AbortSignal): Promise<MailboxDomain>; enableDomain(id: string, input: { force?: boolean }, signal?: AbortSignal): Promise<MailboxDomain>; disableDomain(id: string, signal?: AbortSignal): Promise<MailboxDomain>; checkDomain(id: string, signal?: AbortSignal): Promise<MailboxDomain>; receivedEmail(id: string, signal?: AbortSignal, delivery?: boolean): Promise<ReceivedEmailDetail>
    keys(includeRevoked: boolean, signal?: AbortSignal): Promise<MailboxKey[]>
    createKey(input: MailboxKeyInput, signal?: AbortSignal): Promise<{ key: MailboxKey; secret: string }>
    revokeKey(id: string, signal?: AbortSignal): Promise<void>
  }
  inboxes: {
    folders(id:string,signal?:AbortSignal):Promise<{data:{id:string;role:string|null;path:string;subscribed:boolean;total:number;unseen:number}[]}>
    list(input: { search?: string; cursor?: string }, signal?: AbortSignal): Promise<CursorItems<Inbox>>
    get(id: string, signal?: AbortSignal): Promise<Inbox>
    create(input: InboxInput, signal?: AbortSignal): Promise<CreatedInbox>
    remove(id: string, signal?: AbortSignal): Promise<void>
    messages(id: string, input: { after?: string;folder?:string }, signal?: AbortSignal): Promise<InboxMessagePage>
    message(id: string, messageId: string, signal?: AbortSignal): Promise<InboxMessageDetail>
  }
  inbound: {
    addresses(input: { search?: string; cursor?: string; kind?: 'address' | 'inbox' }, signal?: AbortSignal): Promise<CursorItems<InboundAddress>>
    address(id: string, signal?: AbortSignal): Promise<InboundAddress>
    createAddress(input: InboundAddressInput, signal?: AbortSignal): Promise<InboundAddress>
    updateAddress(id: string, patch: InboundAddressPatch, signal?: AbortSignal): Promise<InboundAddress>
    deleteAddress(id: string, signal?: AbortSignal): Promise<void>
    threads(input: { addressId?: string; q?: string; view: InboundThreadView; cursor?: string }, signal?: AbortSignal): Promise<CursorItems<InboundThread>>
    thread(id: string, input: { addressId?: string; cursor?: string }, signal?: AbortSignal): Promise<InboundThreadDetail>
    updateThread(threadId: string, patch: InboundThreadPatch, signal?: AbortSignal): Promise<InboundAddressState>
    message(id: string, input: { addressId?: string }, signal?: AbortSignal): Promise<InboundMessageDetail>
    attachmentUrl(messageId: string, attachmentId: string, input: { addressId?: string }, signal?: AbortSignal): Promise<{ url: string; expiresAt: ISODate }>
    reply(threadId: string, input: InboundReplyInput, signal?: AbortSignal): Promise<InboundMessage>
    startThread(input: InboundThreadInput, signal?: AbortSignal): Promise<InboundMessage>
    webhooks(signal?: AbortSignal): Promise<InboundWebhook[]>
    /** One page of inbound webhooks; addressId keeps those that get that address's received mail. */
    webhookPage(input: { cursor?: string; addressId?: string }, signal?: AbortSignal): Promise<{ data: InboundWebhook[]; nextCursor: string | null }>
    webhook(id: string, signal?: AbortSignal): Promise<InboundWebhook>
    createWebhook(input: InboundWebhookInput, signal?: AbortSignal): Promise<{ webhook: InboundWebhook; secret: string }>
    updateWebhook(id: string, patch: Partial<InboundWebhookInput> & { paused?: boolean }, signal?: AbortSignal): Promise<InboundWebhook>
    deleteWebhook(id: string, signal?: AbortSignal): Promise<void>
    rotateWebhookSecret(id: string, signal?: AbortSignal): Promise<{ secret: string }>
    webhookDeliveries(id: string, cursor?: string, signal?: AbortSignal): Promise<CursorItems<MailboxWebhookDelivery>>
  }
  routing: {
    routes(signal?: AbortSignal): Promise<{ version: number; routes: MailRoute[] }>
    createRoute(input: MailRouteInput, signal?: AbortSignal): Promise<MailRoute>
    updateRoute(id: string, patch: Partial<MailRouteInput>, signal?: AbortSignal): Promise<MailRoute>
    deleteRoute(id: string, signal?: AbortSignal): Promise<void>
    test(input: RoutingTestInput, signal?: AbortSignal): Promise<RoutingTestResult>
  }
  webhooks: { list(signal?: AbortSignal, cursor?: string): Promise<CursorItems<Webhook>>; get(id: string, signal?: AbortSignal): Promise<Webhook>; save(input: WebhookInput, signal?: AbortSignal): Promise<Webhook>; setStatus(id: string, status: 'active' | 'paused', signal?: AbortSignal): Promise<Webhook>; test(id: string, signal?: AbortSignal): Promise<WebhookDelivery>; retry(id: string, deliveryId: string, signal?: AbortSignal): Promise<WebhookDelivery>; rotate(id: string, signal?: AbortSignal): Promise<{ secret: string }>; reveal(id: string, signal?: AbortSignal): Promise<{ secret: string }>; remove(id: string, signal?: AbortSignal): Promise<void> }
}

export interface SendingLimit { cap: number | null; used: number; resetAt: string | null; nextCap: number | null; nextCapAt: string | null }
export interface Identity { id: string; workspaceId: string; role?: WorkspaceRole | null; multiTenant?: boolean; workspaces?: WorkspaceMembership[] | null; connection?: (Pick<ProviderConnection, 'kind' | 'region' | 'state' | 'tenant'> & { sendingLimit?: SendingLimit | null; domains?: { total: number; verified: number }; standing?: { step: StandingStep; marketingHeld: boolean } | null }) | null; /** Bane staff only: the platform operator role, which opens /operator. */ operator?: 'operator' | 'operator:read' | null; name: string | null; email: string | null; permissions: string[]; domains: string[]; origin: string; host: string }
export type WorkspaceRole = 'owner' | 'admin' | 'member'
export interface WorkspaceMembership { id: string; name: string; slug: string; role: WorkspaceRole }
// GET /v1/overview/setup: Overview's setup and next steps in one read. A part is null where its own list would refuse the caller.
export interface OverviewSetup { domains: Domain[] | null; apiKeys: { active: number } | null; emails: { any: boolean }; webhooks: { total: number } | null; invitations: { pending: number } | null }
export interface WorkspaceMember { id: string; userId: string; email: string; name: string; role: WorkspaceRole }
export type ConnectionKind = 'shared' | 'byo'
export type ConnectionState = 'awaiting_role' | 'provisioning' | 'ready' | 'failed'
export type TenantState = 'pending' | 'ready' | 'failed'
export interface ProviderConnection { id: string; kind: ConnectionKind; region: string; state: ConnectionState; tenant: TenantState; awsAccountId: string | null; roleArn: string | null; templateVersion: string | null; quickCreateUrl: string | null; importedDomains?: number }
export interface WorkspaceInvitation { id: string; workspaceId: string; email: string; role: WorkspaceRole; expiresAt: string; acceptUrl: string }
export interface WorkspaceInvitationPreview { id: string; workspaceId: string; workspaceName: string; workspaceSlug: string; inviterName: string; inviterEmail: string; role: WorkspaceRole; expiresAt: string; status: 'pending' | 'accepted' }
export interface Attachment { disposition?: 'attachment' | 'inline'; contentId?: string | null; id: string; filename: string; contentType: string; size: number }
export interface ConsentInput { status: "subscribed" | "unsubscribed"; source?: string; evidence?: string; policyVersion?: string; occurredAt?: string; confirmResubscribe?: boolean }
export interface ConsentEvent { id: string; status: "subscribed" | "unsubscribed"; source: string; evidence: string | null; policyVersion: string | null; occurredAt: string }
export interface ImportPreview { id: string; status: "preview" | "committed"; imported: number; rows: {row: number; email: string; name?: string}[]; errors: {row: number; field: string; message: string}[]; /** Set by commit: contacts it marked subscribed. */ subscribed?: number }
/** Commit an import; `consent` records that everyone imported without a consent decision agreed to marketing email. */
export interface ImportCommitInput { consent?: { status: 'subscribed'; evidence: string; policyVersion?: string } }
export interface AudiencePlan { id: string; operation: 'update_contacts' | 'add_to_list' | 'remove_from_list'; matched: number; sample: { id: string; email: string; name: string | null; consent: 'unknown' | 'subscribed' | 'unsubscribed'; suppressed: boolean }[]; warnings: string[]; requiresResubscribeConfirmation: boolean; expiresAt: string }

export interface CampaignSendReceipt { id: string; state: "preparing"; queued: number; scheduledAt: string | null; simulated: boolean }
