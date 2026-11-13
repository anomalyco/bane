import { createRoute, z } from '@hono/zod-openapi';
import { SQL, sql } from 'drizzle-orm';
import type { OperatorRole } from './operator-identity.js';
import { ApiError, dashboardSession, errors, notFound, response, webhookUrlHint, type App, type Ctx, type DbExecutor, type Runtime } from './core.js';

// The per-account audit trail (migration 260): one append-only table, written by recordAudit() inside the
// caller's own transaction or statement, read by owners and admins (GET /v1/activity, customer-visible rows only),
// by operators (GET /v1/operator/{workspaces,users}/{id}/audit, everything, each read itself audited) and by the
// support grant (GET /v1/support/audit, customer-visible rows of the grant's own workspaces).
// Never on the send-admission path: sending activity lives in the sending logs.

export type AuditActorType = 'member' | 'api_key' | 'mcp_grant' | 'agent_token' | 'inbox_key' | 'app_password' | 'operator' | 'support' | 'system' | 'stripe';
export type AuditVia = 'dashboard' | 'api' | 'mcp' | 'imap' | 'smtp' | 'console' | 'support' | 'script' | 'job' | 'webhook';
export type AuditActor = {
  type: AuditActorType; id: string | null; via: AuditVia;
  /** A short display label (a key's name, a client): never an email address or a secret. */
  label?: string | null;
  /** The person behind the actor, for the per-user trail. */
  userId?: string | null;
  /** The MCP approval (mcp_<consent>) behind an MCP, agent-token or MCP-created key actor; its user is resolved in SQL. */
  grantId?: string | null;
};
/** Who, from where: derived once per request by auditContext(), or built for jobs, scripts and Stripe. */
export type AuditContext = { actor: AuditActor; requestId: string | null; ipNetwork: string | null; userAgent: string | null };
type Value<T> = T | SQL;
export type AuditEvent = {
  /** `<area>.<verb>`, lower snake case: api_key.create, member.role_change, domain.delete. */
  action: string;
  workspaceId: Value<string | null>;
  /** The person the event concerns, when it is not the actor (an invited or removed member, an operator's subject). */
  userId?: Value<string | null>;
  target?: { type: string; id: Value<string | null> } | null;
  /** Small summaries: IDs, names, roles, scopes, changed fields. Redacted again before writing. */
  before?: Value<unknown>; after?: Value<unknown>; details?: Record<string, unknown>;
  reason?: string | null; ticketRef?: string | null;
  /** Hidden from the customer Activity view. Defaults to true for operator and system actors. */
  internal?: boolean;
  retention?: keyof typeof RETENTION;
};

/**
 * Retention, from the legal notes (plans/inboxes-design.md §access log; billing in plans/cost-and-billing.md):
 * account and configuration changes 1 year (it covers card dispute windows of up to 120 days and an annual review),
 * billing and payment events 7 years (financial records), and the per-call log of a support grant 90 days.
 * The hourly maintenance purge deletes only rows past retain_until; the table refuses anything else.
 */
export const RETENTION = { standard: '1 year', billing: '7 years', access: '90 days' } as const;
// Hooks for work in flight (exact calls in the PR that added this file):
// - Billing: in the transaction that posts a ledger entry, recordAudit(tx, systemContext('webhook', { type: 'stripe', id: event.id }),
//   { action: 'billing.topup' | 'billing.refund' | 'billing.dispute' | …, workspaceId, retention: 'billing', … }); members' and operators'
//   billing changes pass `c` or operatorContext(c, operator) instead.
// - Sign-in (#89): recordAudit(tx, { actor: { type: 'member', id: userId, userId, via: 'dashboard' }, requestId, ipNetwork, userAgent },
//   { action: 'auth.sign_in', workspaceId: null, userId, … }); then port userEmail() below to bane_users.
// - Reputation (#111/#115): operator actions arrive through the hosted_operator_audit trigger (migration 262); nothing to call.

const SECRET_KEY = /secret|password|passwd|token|api[_-]?key|private|credential|authorization|cookie|signature|hash|^dkim|^headers?$/i;
const CONTENT_KEY = /^(?:html|text|body|bodies|content|raw|mime|snippet|preview|source|attachments?)$/i;
const URL_KEY = /(?:^|[a-z])(?:url|uri|endpoint)$/i;
/** Removes secrets, message content and full URLs; bounds depth, strings and arrays. Names, IDs, roles and scopes stay. */
export function redactSummary(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.length > 200 ? value.slice(0, 199) + '…' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= 4) return '[nested]';
  if (Array.isArray(value)) return [...value.slice(0, 20).map(v => redactSummary(v, depth + 1)), ...(value.length > 20 ? [`… ${value.length - 20} more`] : [])];
  if (typeof value !== 'object') return null;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
    if (entry === undefined) continue;
    if (SECRET_KEY.test(key) && !/^(?:has|hasSecret|secretSet|tokenId|tokenPrefix|keyId|hashPrefix)$/.test(key)) out[key] = entry === null ? null : '[redacted]';
    else if (CONTENT_KEY.test(key)) out[key] = entry === null ? null : '[content]';
    else if (URL_KEY.test(key) && typeof entry === 'string') out[key] = webhookUrlHint(entry);
    else out[key] = redactSummary(entry, depth + 1);
  }
  return out;
}
function summaryJson(event: AuditEvent): SQL {
  const parts: SQL[] = [];
  const add = (name: string, value: Value<unknown> | undefined) => {
    if (value === undefined) return;
    if (value instanceof SQL) parts.push(sql`${name}::text, ${value}`);
    else parts.push(sql`${name}::text, ${JSON.stringify(redactSummary(value))}::jsonb`);
  };
  add('before', event.before); add('after', event.after);
  for (const [key, value] of Object.entries(event.details ?? {})) add(key, value);
  if (!parts.length) return sql`'{}'::jsonb`;
  // A summary never fails the change it describes: an oversized one is replaced, not rejected by the CHECK.
  return sql`(SELECT CASE WHEN octet_length(s::text) > 8000 THEN jsonb_build_object('truncated', true, 'keys', (SELECT jsonb_agg(k) FROM jsonb_object_keys(s) k)) ELSE s END
    FROM jsonb_strip_nulls(jsonb_build_object(${sql.join(parts, sql`, `)})) s)`;
}
const text = (value: Value<string | null | undefined>, max: number) => value instanceof SQL ? sql`left(${value}, ${max})` : value == null ? sql`NULL` : sql`${value.slice(0, max)}`;
/** The grant behind an MCP or agent-token actor is an approval (bane_resource_grants); its user is the person who made it. */
const grantUser = (actor: AuditActor) => actor.userId ? sql`${actor.userId}` : actor.grantId?.startsWith('mcp_')
  ? sql`(SELECT user_id FROM bane_resource_grants WHERE id = ${actor.grantId})` : sql`NULL`;

/**
 * The INSERT for one audit row, to compose into the caller's own statement (a data-modifying CTE) so a change and
 * its audit row cost one round trip. With `from`, one row is written per row of that relation (for example the
 * rows a CTE changed: `from: sql\`changed\``), and SQL values in the event may refer to its columns.
 */
export function auditInsert(context: AuditContext, event: AuditEvent, options: { from?: SQL; where?: SQL } = {}): SQL {
  const { actor } = context;
  const internal = event.internal ?? (actor.type === 'operator' || actor.type === 'system');
  const userId = event.userId === undefined ? grantUser(actor) : text(event.userId, 200);
  return sql`INSERT INTO audit_events(workspace_id, user_id, actor_type, actor_id, actor_label, via, action, target_type, target_id, summary, reason, ticket_ref,
      request_id, ip_network, user_agent, internal, retain_until)
    SELECT ${text(event.workspaceId, 200)}, ${userId}, ${actor.type}, ${actor.id?.slice(0, 200) ?? null}, ${actor.label?.slice(0, 120) ?? null}, ${actor.via}, ${event.action},
      ${event.target?.type.slice(0, 40) ?? null}, ${event.target ? text(event.target.id, 200) : sql`NULL`}, ${summaryJson(event)}, ${event.reason?.slice(0, 1000) ?? null},
      ${event.ticketRef?.slice(0, 200) ?? null}, ${context.requestId?.slice(0, 64) ?? null}, ${context.ipNetwork}, ${context.userAgent}, ${internal},
      now() + ${RETENTION[event.retention ?? 'standard']}::interval
    ${options.from ? sql`FROM ${options.from}` : sql``} ${options.where ? sql`WHERE ${options.where}` : sql``}`;
}
/**
 * Writes one audit row inside the caller's transaction (pass the transaction, not the pool). For a change that is a
 * single statement, compose auditInsert() into it instead, which costs no extra round trip. A change made outside the
 * database (an SES call) writes its row first in a transaction held across the call, so it fails closed.
 */
export async function recordAudit(db: DbExecutor, context: AuditContext | Ctx, event: AuditEvent): Promise<void> {
  await db.execute(auditInsert('actor' in context && 'requestId' in context ? context : auditContext(context as Ctx), event));
}

/** The client's network, never its address: IPv4 /24, IPv6 /48. */
export function ipNetwork(address: string | null | undefined): string | null {
  if (!address || address === 'unknown') return null;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(address.replace(/^::ffff:/i, ''));
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (!address.includes(':')) return null;
  const [head = '', tail = ''] = address.split('::');
  const groups = head ? head.split(':') : [];
  const fill = 8 - groups.length - (tail ? tail.split(':').length : 0);
  const full = [...groups, ...Array(Math.max(fill, 0)).fill('0'), ...(tail ? tail.split(':') : [])];
  if (full.length !== 8 || full.some(g => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return `${full.slice(0, 3).map(g => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/48`;
}
/** The product family of a user agent ("Chrome 131 on macOS", "@banemx/sdk 0.4", "curl"), never the full string. */
export function userAgentFamily(agent: string | null | undefined): string | null {
  if (!agent) return null;
  const os = /Windows/.test(agent) ? 'Windows' : /iPhone|iPad/.test(agent) ? 'iOS' : /Android/.test(agent) ? 'Android' : /Mac OS X|Macintosh/.test(agent) ? 'macOS' : /Linux/.test(agent) ? 'Linux' : null;
  for (const [name, pattern] of [['Edge', /Edg\/(\d+)/], ['Firefox', /Firefox\/(\d+)/], ['Chrome', /Chrome\/(\d+)/], ['Safari', /Version\/(\d+)[.\d]* .*Safari/]] as const) {
    const match = pattern.exec(agent);
    if (match) return `${name} ${match[1]}${os ? ` on ${os}` : ''}`;
  }
  const product = /^([A-Za-z@][\w@./-]{0,48})(?:\/(\d+(?:\.\d+)?))?/.exec(agent.trim());
  return product ? `${product[1]}${product[2] ? ` ${product[2]}` : ''}`.slice(0, 80) : null;
}

/** Who is acting on this request, as the audit trail names it. */
export function auditContext(c: Ctx): AuditContext {
  const a = c.get('actor'), box = c.get('mailboxAccess');
  let actor: AuditActor;
  if (a?.credential === 'dashboard') actor = { type: 'member', id: a.keyId.slice(5), userId: a.keyId.slice(5), via: 'dashboard' };
  else if (a?.credential === 'apiKey') actor = { type: 'api_key', id: a.keyId, via: 'api', grantId: a.grantId ? `mcp_${a.grantId}` : null };
  else if (a?.credential === 'mcp') actor = { type: 'mcp_grant', id: a.keyId, via: 'mcp', grantId: a.keyId };
  else if (a?.credential === 'agentToken') actor = { type: 'agent_token', id: a.tokenId ?? null, via: 'api', grantId: a.keyId };
  else if (box) actor = { type: 'inbox_key', id: box.keyId, via: box.grantId ? 'mcp' : 'api' };
  else if (a?.credential === 'operatorService') actor = { type: 'operator', id: a.keyId, via: 'support' };
  else actor = { type: 'system', id: null, via: 'job' };
  return { actor, requestId: c.get('requestId') ?? null, ipNetwork: ipNetwork(c.req.header('x-bane-client-ip')), userAgent: userAgentFamily(c.req.header('user-agent')) };
}
/** Background jobs, scripts and provider webhooks (Stripe): no request, no client. */
export const systemContext = (via: AuditVia = 'job', actor: Partial<AuditActor> = {}): AuditContext =>
  ({ actor: { type: 'system', id: null, via, ...actor }, requestId: null, ipNetwork: null, userAgent: null });

/** Deletes rows past their retention, a page at a time (the table refuses earlier deletes). */
export async function purgeExpiredAudit(runtime: Pick<Runtime, 'db'>, limit = 5000) {
  const result = await runtime.db.execute(sql`DELETE FROM audit_events WHERE id IN (SELECT id FROM audit_events WHERE retain_until <= now() ORDER BY retain_until LIMIT ${limit})`);
  return result.rowCount ?? 0;
}

// ---------- operator identity ----------

export type OperatorIdentity = { id: string; role: OperatorRole; via: 'console' | 'support'; userId: string | null };
/**
 * Who the operator is, for the audit and support routes and the /v1/operator/* gate (support.ts operatorGate). There is
 * one operator check: a signed-in dashboard session goes through #115's operatorActor (src/operator.ts, which reads the
 * role through src/operator-identity.ts). The only other operator is the support platform's Worker, through the
 * SupportPlatform service binding (src/support-platform.ts), read-only and on the support routes only. Never a
 * workspace role: owners get 403.
 */
export async function requireOperator(c: Ctx, level: OperatorRole): Promise<OperatorIdentity> {
  const a = c.get('actor');
  if (a?.credential === 'operatorService') {
    if (level !== 'operator:read') throw operatorRequired();
    return { id: a.keyId, role: 'operator:read', via: 'support', userId: null };
  }
  if (!c.env.config.multiTenant || a?.credential !== 'dashboard') throw operatorRequired();
  // Loaded on demand: operator.ts brings the standing model, which most audited routes never need.
  const { operatorActor } = await import('./operator.js');
  const operator = await operatorActor(c, level);
  return { id: operator.userId, role: operator.role, via: 'console', userId: operator.userId };
}
export const operatorRequired = () => new ApiError(403, 'OPERATOR_REQUIRED', 'This area is for Bane operators.');
export const operatorContext = (c: Ctx, operator: OperatorIdentity): AuditContext => ({ ...auditContext(c), actor: { type: 'operator', id: operator.id, userId: operator.userId, via: operator.via } });

// ---------- reading the trail ----------

/** The person behind a user ID, for display (identity is the issuer subject; the address is display only). */
export const userEmail = (userId: SQL) => sql`(SELECT email FROM bane_users WHERE id = ${userId})`;

export const AuditEntry = z.object({
  id: z.string().describe('Stable ID of the entry; audit entries are prefixed aud_, ledger lines bill_, enforcement events enf_.'),
  at: z.string().describe('When it happened (ISO 8601, UTC).'),
  action: z.string().describe('What happened, as <area>.<verb>: api_key.create, member.role_change, domain.delete, support.view.'),
  actor: z.object({
    type: z.enum(['member', 'api_key', 'mcp_grant', 'agent_token', 'inbox_key', 'app_password', 'operator', 'support', 'system', 'stripe']).describe('member is a signed-in person; support is Bane support reading with your permission; system is Bane itself.'),
    id: z.string().nullable().describe('The member user ID, key ID, grant ID or support grant ID.'),
    label: z.string().nullable().describe('A short display name for the actor, such as a key name, or null.'),
    email: z.string().nullable().describe('The member’s email address, for member actors.'),
  }),
  via: z.string().describe('Where the action came from: dashboard, api, mcp, support, job, webhook.'),
  target: z.object({ type: z.string(), id: z.string().nullable() }).nullable().describe('The object acted on.'),
  subject: z.object({ userId: z.string(), email: z.string().nullable() }).nullable().describe('The member the event concerns when it is not the actor: the member whose role changed or whose support request let Bane support in.'),
  summary: z.record(z.string(), z.unknown()).describe('Before and after, with secrets and message content removed.'),
  reason: z.string().nullable(),
  requestId: z.string().nullable().describe('The x-request-id of the API request that made the change.'),
  network: z.string().nullable().describe('The client network (/24 or /48), never the full address.'),
  client: z.string().nullable().describe('The client family, such as "Chrome 131 on macOS".'),
}).openapi('AuditEntry');
type Entry = z.infer<typeof AuditEntry>;
export const AuditPage = z.object({ data: z.array(AuditEntry), nextCursor: z.string().nullable().describe('Pass as cursor for older entries; null at the end.') });

export const AuditFilters = z.object({
  since: z.iso.datetime().optional().describe('Only entries at or after this time.'),
  until: z.iso.datetime().optional().describe('Only entries before this time.'),
  action: z.string().trim().regex(/^[a-z][a-z_.]{0,63}$/).optional().describe('An exact action (api_key.create) or an area followed by a dot (api_key.).'),
  actorType: z.enum(['member', 'api_key', 'mcp_grant', 'agent_token', 'inbox_key', 'app_password', 'operator', 'support', 'system', 'stripe']).optional(),
  actorId: z.string().trim().min(1).max(200).optional(),
  requestId: z.string().regex(/^req_[0-9a-f]{32}$/).optional().describe('Only what one API request (its x-request-id) changed.'),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
type Filters = z.infer<typeof AuditFilters>;
const cursorOf = (row: { at_text: string; uid: string }) => Buffer.from(`${row.at_text}|${row.uid}`).toString('base64url');
function parseCursor(cursor: string | undefined) {
  if (!cursor) return null;
  const [at, uid] = Buffer.from(cursor, 'base64url').toString().split('|');
  if (!at || !uid || Number.isNaN(Date.parse(at)) || !/^[a-z]{3,4}_[\w-]{1,120}$/.test(uid)) throw new ApiError(422, 'INVALID_CURSOR', 'The cursor is not valid. Start again without it.', 'cursor');
  return { at, uid };
}
function filterSql(f: Filters, columns: { at: SQL; uid: SQL; action: SQL; actorType: SQL; actorId: SQL; requestId: SQL }) {
  const cursor = parseCursor(f.cursor);
  return sql.join([
    f.since ? sql`${columns.at} >= ${f.since}::timestamptz` : sql`true`,
    f.until ? sql`${columns.at} < ${f.until}::timestamptz` : sql`true`,
    f.action ? (f.action.endsWith('.') ? sql`starts_with(${columns.action}, ${f.action})` : sql`${columns.action} = ${f.action}`) : sql`true`,
    f.actorType ? sql`${columns.actorType} = ${f.actorType}` : sql`true`,
    f.actorId ? sql`${columns.actorId} = ${f.actorId}` : sql`true`,
    f.requestId ? sql`${columns.requestId} = ${f.requestId}` : sql`true`,
    cursor ? sql`(${columns.at}, ${columns.uid}) < (${cursor.at}::timestamptz, ${cursor.uid})` : sql`true`,
  ], sql` AND `);
}
const entrySelect = sql`'aud_' || e.id AS uid, e.at::text AS at_text, e.action, e.actor_type, e.actor_id, e.actor_label, e.via, e.target_type, e.target_id, e.summary, e.reason,
  e.request_id, e.ip_network, e.user_agent, CASE WHEN e.actor_type = 'member' THEN ${userEmail(sql`e.actor_id`)} END AS actor_email,
  CASE WHEN e.user_id IS DISTINCT FROM e.actor_id OR e.actor_type <> 'member' THEN e.user_id END AS subject_id,
  CASE WHEN e.user_id IS DISTINCT FROM e.actor_id OR e.actor_type <> 'member' THEN ${userEmail(sql`e.user_id`)} END AS subject_email`;
type Row = { uid: string; at_text: string; action: string; actor_type: Entry['actor']['type']; actor_id: string | null; actor_label: string | null; via: string; target_type: string | null;
  target_id: string | null; summary: Record<string, unknown> | null; reason: string | null; request_id: string | null; ip_network: string | null; user_agent: string | null; actor_email: string | null;
  subject_id: string | null; subject_email: string | null };
function entries(rows: Row[], limit: number): { data: Entry[]; nextCursor: string | null } {
  const data = rows.slice(0, limit).map((r): Entry => ({ id: r.uid, at: new Date(r.at_text).toISOString(), action: r.action, actor: { type: r.actor_type, id: r.actor_id, label: r.actor_label, email: r.actor_email },
    via: r.via, target: r.target_type ? { type: r.target_type, id: r.target_id } : null, subject: r.subject_id ? { userId: r.subject_id, email: r.subject_email } : null, summary: r.summary ?? {}, reason: r.reason, requestId: r.request_id, network: r.ip_network, client: r.user_agent }));
  return { data, nextCursor: rows.length > limit ? cursorOf(rows[limit - 1]!) : null };
}
const columns = { at: sql`e.at`, uid: sql`('aud_' || e.id)`, action: sql`e.action`, actorType: sql`e.actor_type`, actorId: sql`e.actor_id`, requestId: sql`e.request_id` };

/** Customer-visible entries of some workspaces: what owners, admins and a support grant read. */
export async function customerTrail(db: DbExecutor, workspaceIds: string[], f: Filters): Promise<{ data: Entry[]; nextCursor: string | null }> {
  if (!workspaceIds.length) return { data: [], nextCursor: null };
  const { rows } = await db.execute<Row>(sql`SELECT ${entrySelect} FROM audit_events e
    WHERE e.workspace_id = ANY(${sql.param(workspaceIds)}::text[]) AND NOT e.internal AND ${filterSql(f, columns)}
    ORDER BY e.at DESC, uid DESC LIMIT ${f.limit + 1}`);
  return entries(rows, f.limit);
}

// Enforcement (#111/#115) and the billing ledger join the operator view when their tables exist on this database.
// They are read through to_jsonb(row), so only id, workspace_id and the time column are assumed.
let sources: Promise<{ standing: boolean; billing: boolean }> | undefined;
const optionalSources = (db: DbExecutor) => sources ??= db.execute<{ standing: boolean; billing: boolean; operator_audit: boolean }>(sql`SELECT
    to_regclass('standing_events') IS NOT NULL AS standing, to_regclass('billing_ledger') IS NOT NULL AS billing`)
  .then(r => ({ standing: !!r.rows[0]?.standing, billing: !!r.rows[0]?.billing }))
  .catch(error => { sources = undefined; throw error; });

/** Everything about a workspace or a user, for operators; the read itself is written to the trail in the same statement. */
async function operatorTrail(c: Ctx, operator: OperatorIdentity, scope: { workspaceId: string } | { userId: string }, f: Filters, include: string[]) {
  const db = c.env.db, available = await optionalSources(db);
  const wid = 'workspaceId' in scope ? scope.workspaceId : null;
  const parts = [sql`SELECT ${entrySelect}, e.at, e.internal FROM audit_events e WHERE ${wid ? sql`e.workspace_id = ${wid}` : sql`e.user_id = ${(scope as { userId: string }).userId}`}`];
  const extra = (uid: SQL, at: SQL, action: SQL, actorType: SQL, from: SQL) => sql`SELECT ${uid} AS uid, ${at}::text AS at_text, ${action} AS action, ${actorType} AS actor_type, NULL::text AS actor_id,
    NULL::text AS actor_label, 'job' AS via, NULL::text AS target_type, NULL::text AS target_id, x.detail AS summary, NULL::text AS reason, NULL::text AS request_id, NULL::text AS ip_network,
    NULL::text AS user_agent, NULL::text AS actor_email, NULL::text AS subject_id, NULL::text AS subject_email, ${at} AS at, true AS internal FROM ${from}`;
  if (wid && include.includes('enforcement') && available.standing) parts.push(extra(sql`'enf_' || x.id`, sql`x.at`, sql`'standing.' || coalesce(x.kind, 'event')`, sql`coalesce(x.detail #>> '{actor,kind}', 'system')`,
    sql`(SELECT s.id::text AS id, s.at, s.kind, to_jsonb(s) - 'workspace_id' AS detail FROM standing_events s WHERE s.workspace_id = ${wid}) x`));
  // Operator actions (hosted_operator_audit) are already in audit_events: migration 262 mirrors and backfilled them.
  // Billing's money movements are already audit rows (the billing_ledger_audit trigger, migration 302); this adds the
  // hourly usage rows, which are not events.
  if (wid && include.includes('billing') && available.billing) parts.push(extra(sql`'bill_' || x.id`, sql`x.at`, sql`'billing.' || coalesce(x.kind, 'entry')`, sql`'system'`,
    sql`(SELECT b.id::text AS id, b.created_at AS at, b.kind, to_jsonb(b) - 'workspace_id' AS detail FROM billing_ledger b WHERE b.workspace_id = ${wid} AND b.kind = 'usage') x`));
  const all = sql`(${sql.join(parts, sql` UNION ALL `)})`;
  const outer = { at: sql`t.at`, uid: sql`t.uid`, action: sql`t.action`, actorType: sql`t.actor_type`, actorId: sql`t.actor_id`, requestId: sql`t.request_id` };
  const context = operatorContext(c, operator);
  const log = auditInsert(context, { action: 'audit.read', workspaceId: wid, userId: 'userId' in scope ? scope.userId : null, target: wid ? { type: 'workspace', id: wid } : { type: 'user', id: (scope as { userId: string }).userId },
    details: { filters: Object.fromEntries(Object.entries({ ...f, cursor: undefined }).filter(([, v]) => v !== undefined)), include }, internal: true });
  const { rows } = await db.execute<Row & { internal: boolean }>(sql`WITH logged AS (${log} RETURNING id)
    SELECT t.* FROM ${all} t WHERE ${filterSql(f, outer)} ORDER BY t.at DESC, t.uid DESC LIMIT ${f.limit + 1}`);
  const page = entries(rows, f.limit);
  return { ...page, data: page.data.map((entry, i) => ({ ...entry, internal: rows[i]!.internal })) };
}

const security: Record<string, string[]>[] = [{ bearerAuth: [] }, { dashboardSession: [] }, { secureDashboardSession: [] }];
const sessionOnly: Record<string, string[]>[] = [{ dashboardSession: [] }, { secureDashboardSession: [] }];
const OperatorEntry = AuditEntry.extend({ internal: z.boolean().describe('Hidden from the customer Activity view.') }).openapi('OperatorAuditEntry');
const OperatorQuery = AuditFilters.extend({ include: z.string().regex(/^(?:billing|enforcement)(?:,(?:billing|enforcement))*$/).optional().describe('Also join enforcement events and billing ledger lines (comma-separated).') });

export function registerAudit(app: App) {
  app.openapi(createRoute({ method: 'get', path: '/v1/activity', operationId: 'listActivity', tags: ['Workspaces'], security: sessionOnly,
    description: 'What happened in this workspace and who did it: members, roles and invitations, API keys, inbox keys and app passwords, domains, webhooks, endpoints, routes and rituals, settings, exports and deletions, and each time Bane support viewed the workspace with a support grant. Newest first. Owners and admins only; secrets and message content are never recorded.',
    request: { query: AuditFilters }, responses: { 200: response(AuditPage), ...errors } }), async c => {
    const a = dashboardSession(c, true);
    return c.json(await customerTrail(c.env.db, [a.workspaceId], c.req.valid('query')), 200);
  });
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'get', path: '/v1/operator/workspaces/{id}/audit', operationId: 'operatorWorkspaceAudit',
    request: { params: z.object({ id: z.string().min(1).max(100) }), query: OperatorQuery }, responses: { 200: response(z.object({ data: z.array(OperatorEntry), nextCursor: z.string().nullable() })), ...errors } }), async c => {
    const operator = await requireOperator(c, 'operator:read'), id = c.req.valid('param').id, q = c.req.valid('query');
    if (!(await c.env.db.execute(sql`SELECT FROM workspaces WHERE id = ${id}`)).rowCount) notFound('Workspace');
    return c.json(await operatorTrail(c, operator, { workspaceId: id }, q, q.include?.split(',') ?? []), 200);
  });
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'get', path: '/v1/operator/users/{id}/audit', operationId: 'operatorUserAudit',
    request: { params: z.object({ id: z.string().min(1).max(200) }), query: AuditFilters }, responses: { 200: response(z.object({ data: z.array(OperatorEntry), nextCursor: z.string().nullable() })), ...errors } }), async c => {
    const operator = await requireOperator(c, 'operator:read'), id = c.req.valid('param').id;
    if (!(await c.env.db.execute(sql`SELECT FROM bane_users WHERE id = ${id}`)).rowCount) notFound('User');
    return c.json(await operatorTrail(c, operator, { userId: id }, c.req.valid('query'), []), 200);
  });
}
