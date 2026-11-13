import { toolResult } from './projection.js';

// The agent's tools (design §4.1). Every account tool is a closure over the conversation's grant: the model never
// passes, sees or chooses identity, and can only narrow to a workspace already in the grant. Each tool has a label
// for the panel's progress line (support/PROTOCOL.md §4.3) that never contains arguments.

export type Param =
  | { type: 'string'; description: string; optional?: boolean; max?: number; pattern?: string }
  | { type: 'number'; description: string; optional?: boolean; min?: number; max?: number }
  | { type: 'enum'; values: readonly string[]; description: string; optional?: boolean }
  | { type: 'strings'; description: string; optional?: boolean; max?: number };
export type ToolSpec = {
  name: string;
  description: string;
  params: Record<string, Param>;
  /** "Checking your Gmail bounces…" while running, "Checked your Gmail bounces" when done. */
  label: (args: Record<string, unknown>) => { running: string; done: string };
  execute: (args: Record<string, unknown>, host: ToolHost) => Promise<string>;
};

/** What the conversation gives its tools. */
export interface ToolHost {
  /** A grant-scoped GET under /v1/support (path with query); throws ToolFailure with a customer-safe message. */
  read(path: string): Promise<unknown>;
  /** The workspace this conversation is about, when one is chosen. */
  workspaceId(): string | null;
  chooseWorkspace(workspaceId: string): Promise<string>;
  requestContentAccess(workspaceId: string, why: string): Promise<string>;
  fileTicket(input: TicketInput): Promise<string>;
}
export type TicketInput = {
  category: string; severity: 'P1' | 'P2' | 'P3'; summary: string; ask: string;
  tried: { tool: string; finding: string }[]; recommendation: string; evidence: Record<string, string[]>;
};
export class ToolFailure extends Error {}

const DAYS = /^\d{1,2}$/;
const ID = '^[A-Za-z0-9_.:-]{1,120}$';
const sinceParam: Param = { type: 'number', description: 'How many days back to look (1–30). Default 7.', optional: true, min: 1, max: 30 };
const workspaceParam: Param = { type: 'string', description: 'Narrow to one of the customer’s workspaces (an ID from account_context). Omit to use the conversation’s workspace.', optional: true, max: 100, pattern: ID };

function query(args: Record<string, unknown>, host: ToolHost, map: Record<string, string> = {}) {
  const q = new URLSearchParams(), workspace = (args.workspaceId as string | undefined) ?? host.workspaceId();
  if (workspace) q.set('workspaceId', workspace);
  for (const [key, value] of Object.entries(args)) {
    if (key === 'workspaceId' || value === undefined || value === null || value === '') continue;
    if (key === 'days') { if (DAYS.test(String(value))) q.set('since', new Date(Date.now() - Number(value) * 86_400_000).toISOString()); continue; }
    q.set(map[key] ?? key, String(value));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}
const seg = (value: unknown) => encodeURIComponent(String(value));
const read = (path: (a: Record<string, unknown>, h: ToolHost) => string) => async (args: Record<string, unknown>, host: ToolHost) => toolResult(await host.read(path(args, host)));
const fixed = (running: string, done: string) => () => ({ running, done });
const providerName = (p: unknown) => typeof p === 'string' && p ? ({ gmail: 'Gmail', microsoft: 'Outlook', yahoo: 'Yahoo', apple: 'iCloud', proton: 'Proton', gmx: 'GMX' } as Record<string, string>)[p] ?? p : null;

export const TOOLS: ToolSpec[] = [
  { name: 'account_context', description: 'Start here for any account question: who the customer is, their workspaces and roles, sending setup and limits, domains and verification, failures in the last 24 hours, open enforcement, recent changes and request IDs.',
    params: { workspaceId: workspaceParam }, label: fixed('Looking at your account…', 'Looked at your account'), execute: read((a, h) => `/v1/support/context${query(a, h)}`) },
  { name: 'list_workspaces', description: 'The customer’s workspaces with their role, sending connection and resource counts.', params: { workspaceId: workspaceParam },
    label: fixed('Listing your workspaces…', 'Listed your workspaces'), execute: read((a, h) => `/v1/support/workspaces${query(a, h)}`) },
  { name: 'list_domains', description: 'Domains with sending verification (DKIM, MAIL FROM, DMARC) and receiving state.', params: { workspaceId: workspaceParam },
    label: fixed('Checking your domains…', 'Checked your domains'), execute: read((a, h) => `/v1/support/domains${query(a, h)}`) },
  { name: 'get_standing', description: 'Sender standing per workspace: pauses and reasons, limit overrides, score, step and daily limit, 60 days of history and whether a higher limit would be auto-approved, plus the last 24 hours by status.',
    params: { workspaceId: workspaceParam }, label: fixed('Checking your sending standing…', 'Checked your sending standing'), execute: read((a, h) => `/v1/support/standing${query(a, h)}`) },
  { name: 'get_billing', description: 'Balance and the billing ledger (top-ups, usage, refunds, credits) of workspaces the customer owns or administers.',
    params: { workspaceId: workspaceParam }, label: fixed('Checking your billing…', 'Checked your billing'), execute: read((a, h) => `/v1/support/billing${query(a, h)}`) },
  { name: 'get_audit', description: 'The Activity trail (who changed what, when) for workspaces the customer owns or administers, newest first.',
    params: { workspaceId: workspaceParam, action: { type: 'string', description: 'Only actions starting with this, e.g. "api_key." or "domain."', optional: true, max: 60 }, limit: { type: 'number', description: '1–50, default 20', optional: true, min: 1, max: 50 } },
    label: fixed('Reading your activity log…', 'Read your activity log'), execute: read((a, h) => `/v1/support/audit${query(a, h)}`) },
  { name: 'list_emails', description: 'Sent or received mail, newest first: addresses, subject, status and error codes (never bodies).',
    params: { workspaceId: workspaceParam, direction: { type: 'enum', values: ['sent', 'received'], description: 'Default sent.', optional: true }, status: { type: 'string', description: 'e.g. bounced, failed, suppressed, delivered', optional: true, max: 40 },
      days: sinceParam, limit: { type: 'number', description: '1–50, default 25', optional: true, min: 1, max: 50 }, cursor: { type: 'string', description: 'nextCursor from the previous page', optional: true, max: 200 } },
    label: fixed('Looking through your emails…', 'Looked through your emails'), execute: read((a, h) => `/v1/support/emails${query(a, h)}`) },
  { name: 'get_email', description: 'One email with its delivery events; its body only when the customer allowed content access.',
    params: { emailId: { type: 'string', description: 'The email ID', max: 120, pattern: ID }, workspaceId: workspaceParam },
    label: fixed('Opening that email…', 'Opened that email'), execute: read((a, h) => `/v1/support/emails/${seg(a.emailId)}${query({ workspaceId: a.workspaceId }, h)}`) },
  { name: 'list_events', description: 'Delivery events of sent mail (send, delivery, bounce, complaint, reject, open, click), newest first.',
    params: { workspaceId: workspaceParam, emailId: { type: 'string', description: 'Only this email', optional: true, max: 120, pattern: ID }, type: { type: 'string', description: 'e.g. bounce, complaint', optional: true, max: 40 }, days: sinceParam },
    label: fixed('Checking delivery events…', 'Checked delivery events'), execute: read((a, h) => `/v1/support/events${query(a, h)}`) },
  { name: 'list_webhook_deliveries', description: 'Webhook deliveries with attempts, last HTTP status and error (never payloads or URLs).',
    params: { workspaceId: workspaceParam, status: { type: 'enum', values: ['pending', 'delivered', 'failed', 'paused'], description: 'Filter by status', optional: true }, days: sinceParam },
    label: fixed('Checking your webhook deliveries…', 'Checked your webhook deliveries'), execute: read((a, h) => `/v1/support/webhook-deliveries${query(a, h)}`) },
  { name: 'explain_request', description: 'What Bane recorded for one API request ID (req_…) the customer quotes: changes it made, campaign launches, routing versions.',
    params: { requestId: { type: 'string', description: 'req_ followed by 32 hex characters', max: 40, pattern: '^req_[0-9a-f]{32}$' }, workspaceId: workspaceParam },
    label: fixed('Looking up that request…', 'Looked up that request'), execute: read((a, h) => `/v1/support/requests/${seg(a.requestId)}${query({ workspaceId: a.workspaceId }, h)}`) },
  { name: 'delivery_metrics', description: 'Delivery, bounce, complaint, open, click and unsubscribe rates over time, with numerators and denominators, optionally grouped by recipient provider, campaign, sending domain or stream. Includes findings[] computed from the thresholds.',
    params: { workspaceId: workspaceParam, days: { ...sinceParam, description: 'Days back (1–30). Default 14.' } as Param, granularity: { type: 'enum', values: ['day', 'hour'], description: 'hour only for ≤ 3 days', optional: true },
      groupBy: { type: 'enum', values: ['none', 'campaign', 'from_domain', 'provider', 'stream'], description: 'How to split the numbers', optional: true }, stream: { type: 'enum', values: ['transactional', 'marketing', 'all'], description: 'Default all', optional: true },
      campaignId: { type: 'string', description: 'Only this campaign', optional: true, max: 120, pattern: ID }, fromDomain: { type: 'string', description: 'Only mail from this domain', optional: true, max: 253 } },
    label: a => a.groupBy === 'provider' ? { running: 'Comparing results by mailbox provider…', done: 'Compared results by mailbox provider' } : a.groupBy === 'campaign' ? { running: 'Comparing your campaigns…', done: 'Compared your campaigns' } : { running: 'Checking your delivery numbers…', done: 'Checked your delivery numbers' },
    execute: read((a, h) => `/v1/support/deliverability/metrics${query({ days: 14, ...a }, h)}`) },
  { name: 'bounce_reasons', description: 'Bounces, deferrals and complaints grouped by provider, type and SMTP status with a normalized diagnostic, first and last seen and top campaigns; first-send bounce rate for new contacts. Includes findings[].',
    params: { workspaceId: workspaceParam, days: sinceParam, provider: { type: 'enum', values: ['gmail', 'microsoft', 'yahoo', 'apple', 'proton', 'gmx', 'other'], description: 'Only this recipient provider', optional: true },
      type: { type: 'enum', values: ['bounce', 'deferral', 'complaint'], description: 'Default all', optional: true }, campaignId: { type: 'string', description: 'Only this campaign', optional: true, max: 120, pattern: ID }, fromDomain: { type: 'string', description: 'Only mail from this domain', optional: true, max: 253 } },
    label: a => { const p = providerName(a.provider); return p ? { running: `Checking your ${p} bounces…`, done: `Checked your ${p} bounces` } : { running: 'Checking your bounces…', done: 'Checked your bounces' }; },
    execute: read((a, h) => `/v1/support/deliverability/bounces${query(a, h)}`) },
  { name: 'domain_health', description: 'One sending domain in depth: verification, live SPF/DMARC/BIMI records, DKIM and SPF alignment, sending volume and warm-up age, marketing vs transactional mix. Includes findings[].',
    params: { domainId: { type: 'string', description: 'The domain ID from list_domains', max: 120, pattern: ID }, workspaceId: workspaceParam },
    label: fixed('Checking your domain’s DNS and authentication…', 'Checked your domain’s DNS and authentication'), execute: read((a, h) => `/v1/support/domains/${seg(a.domainId)}/health${query({ workspaceId: a.workspaceId }, h)}`) },
  { name: 'screen_rejections', description: 'Bane’s content screen over the last days: hourly screened and rejected counts and the last 50 rejections with subject, error code and spam score.',
    params: { workspaceId: workspaceParam, days: { type: 'number', description: '1–7, default 7', optional: true, min: 1, max: 7 } },
    label: fixed('Checking content screen rejections…', 'Checked content screen rejections'), execute: read((a, h) => `/v1/support/screen${query(a, h)}`) },
  { name: 'list_campaigns', description: 'Recent campaigns: state, audience and size, tracking, From, subject, stats and pacing.',
    params: { workspaceId: workspaceParam, days: sinceParam, state: { type: 'string', description: 'e.g. sent, sending, paused, draft', optional: true, max: 40 } },
    label: fixed('Looking at your campaigns…', 'Looked at your campaigns'), execute: read((a, h) => `/v1/support/campaigns${query(a, h)}`) },
  { name: 'get_campaign', description: 'One campaign with its stats and pacing; its content only when the customer allowed content access.',
    params: { campaignId: { type: 'string', description: 'The campaign ID', max: 120, pattern: ID }, workspaceId: workspaceParam },
    label: fixed('Opening that campaign…', 'Opened that campaign'), execute: read((a, h) => `/v1/support/campaigns/${seg(a.campaignId)}${query({ workspaceId: a.workspaceId }, h)}`) },
  { name: 'lint_email', description: 'Structural checks on one sent email: size, parts, unsubscribe headers, alignment, subject; with content access also links, images vs text, shorteners, unresolved tokens.',
    params: { emailId: { type: 'string', description: 'The email ID', max: 120, pattern: ID }, workspaceId: workspaceParam },
    label: fixed('Checking that email’s structure…', 'Checked that email’s structure'), execute: read((a, h) => `/v1/support/emails/${seg(a.emailId)}/lint${query({ workspaceId: a.workspaceId }, h)}`) },
  { name: 'lint_campaign', description: 'The same checks as lint_email for a campaign’s current content.',
    params: { campaignId: { type: 'string', description: 'The campaign ID', max: 120, pattern: ID }, workspaceId: workspaceParam },
    label: fixed('Checking that campaign’s structure…', 'Checked that campaign’s structure'), execute: read((a, h) => `/v1/support/campaigns/${seg(a.campaignId)}/lint${query({ workspaceId: a.workspaceId }, h)}`) },
  { name: 'audience_health', description: 'List hygiene per list or segment: consent mix, suppressions by reason, engagement recency and stale share, role and typo addresses, provider mix, and recent imports with their first-send bounce and complaint rates. No addresses.',
    params: { workspaceId: workspaceParam, listId: { type: 'string', description: 'Only this list', optional: true, max: 120, pattern: ID } },
    label: fixed('Checking your audience’s health…', 'Checked your audience’s health'), execute: read((a, h) => `/v1/support/audience/health${query(a, h)}`) },
  { name: 'choose_workspace', description: 'When the customer has several workspaces and you need account data, call this with the workspace they named (an ID from the verified list in <customer>). Narrows access to that one workspace.',
    params: { workspaceId: { type: 'string', description: 'A workspace ID from <customer>', max: 100, pattern: ID } },
    label: fixed('Switching to that workspace…', 'Switched workspace'), execute: (a, h) => h.chooseWorkspace(String(a.workspaceId)) },
  { name: 'request_content_access', description: 'Ask the customer to let you read the content (bodies, HTML) of their emails and campaigns in one workspace, for this conversation only. Use only when the content is the likely cause. Say why in one sentence.',
    params: { workspaceId: workspaceParam, why: { type: 'string', description: 'One sentence the customer will see, e.g. "To check why the screen rejected your Nov 3 promo, I need to read its HTML."', max: 240 } },
    label: fixed('Asking for content access…', 'Asked for content access'), execute: (a, h) => h.requestContentAccess(String(a.workspaceId ?? h.workspaceId() ?? ''), String(a.why ?? '')) },
  { name: 'file_ticket', description: 'Pass this conversation to the Bane team. One per conversation; calling again adds facts to the same ticket. See the ticket rules in your instructions.',
    params: {
      category: { type: 'enum', values: ['refund', 'billing_dispute', 'account_closure', 'limit_increase', 'enforcement_review', 'legal', 'security', 'abuse_report', 'bug', 'human_requested', 'other'], description: 'The kind of request' },
      severity: { type: 'enum', values: ['P1', 'P2', 'P3'], description: 'P1: security or sending fully down; P2: legal, pause review, degraded sending; P3: everything else' },
      summary: { type: 'string', description: 'Three sentences for the team: the situation, the cause if known, what the customer wants', max: 1200 },
      ask: { type: 'string', description: 'The customer’s request in their own words (a short quote)', max: 600 },
      tried: { type: 'strings', description: 'What you checked and found, one "tool: finding" per item', max: 12 },
      recommendation: { type: 'string', description: 'The exact action you recommend, with the evidence (e.g. "Refund the duplicate $25 top-up of Nov 3: two identical top-ups 40 s apart in the ledger")', max: 800 },
      evidence: { type: 'strings', description: 'IDs that back it up: request, email, campaign, domain IDs', optional: true, max: 20 },
    },
    label: fixed('Passing this to the Bane team…', 'Passed this to the Bane team'),
    execute: (a, h) => h.fileTicket({
      category: String(a.category), severity: (['P1', 'P2', 'P3'].includes(String(a.severity)) ? a.severity : 'P3') as TicketInput['severity'], summary: String(a.summary ?? ''), ask: String(a.ask ?? ''),
      tried: (Array.isArray(a.tried) ? a.tried : []).slice(0, 12).map(item => { const [tool, ...rest] = String(item).split(':'); return { tool: (tool ?? '').trim().slice(0, 60), finding: rest.join(':').trim().slice(0, 400) }; }),
      recommendation: String(a.recommendation ?? ''), evidence: { ids: (Array.isArray(a.evidence) ? a.evidence : []).slice(0, 20).map(String) },
    }) },
];
export const TOOL_NAMES = TOOLS.map(t => t.name);
