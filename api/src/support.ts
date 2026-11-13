import { createRoute, z } from '@hono/zod-openapi';
import { sql, type SQL } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { ApiError, digest, errors, hasSessionCookie, id, json, log, notFound, randomSecret, response, timed, webhookUrlHint, type App, type AppEnv, type Ctx, type DbExecutor, type SupportScope } from './core.js';
import { AuditEntry, AuditFilters, auditContext, auditInsert, customerTrail, operatorContext, operatorRequired, requireOperator, userEmail } from './audit.js';

// Support integration (api/README.md "Support integration"). Internal: these routes are for Bane's operators and its
// support platform, never for customers.
//
// 1. A signed-in member presses "Contact support" (POST /v1/contact-support): Bane stores a handoff (workspace, user,
//    page, recent request IDs, and whether they share message content for this request) and returns the support
//    platform's URL carrying an Ed25519-signed handoff token.
// 2. The support platform's server verifies who the customer is (that handoff, or an email whose From passed DMARC
//    alignment or a magic link: POST /v1/operator/support/verify-email) and mints a grant for that one user
//    (POST /v1/operator/support/grants) with its operator credential.
// 3. The agent gets only the grant (bane_support_…) in its environment. Every /v1/support/* route derives the customer
//    from the grant alone; a workspaceId filter can only narrow it. Every call is written to audit_events, and each
//    workspace's Activity shows "Bane support viewed this workspace" once per grant. Never secrets; message content only
//    with the customer's own opt-in from the handoff.
//
// Access: /v1/operator/* answers only an operator (operatorGate), /v1/support/* only a live support grant (supportGate).
// Every other credential, including a workspace owner's session, gets the same 403 for every path under them, real or not.

const SUPPORT_TOKEN = /^bane_support_[0-9a-f]{64}$/;
/** Requests per minute per support grant. */
export const SUPPORT_RATE_PER_MINUTE = 120;
const GRANT_MAX_MINUTES = 120;
const bearer = (c: Ctx) => c.req.header('authorization')?.match(/^Bearer (\S+)$/i)?.[1];
const supportRequired = () => new ApiError(403, 'SUPPORT_GRANT_REQUIRED', 'This area is for Bane support with an active support grant.');

/**
 * /v1/operator and /v1/operator/*: an operator's dashboard session, or the support platform through the SupportPlatform
 * service binding (src/support-platform.ts) on the support routes only, else 403. No bearer token is an operator: the
 * static platform token (BANE_SUPPORT_PLATFORM_TOKEN) is retired.
 */
export const operatorGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.env.config.multiTenant) throw operatorRequired();
  if (c.req.header('authorization') !== undefined) throw operatorRequired();
  if (c.env.platformCaller === 'bane-support') {
    if (!c.req.path.startsWith('/v1/operator/support/')) throw operatorRequired();
    const { chargeGrantBudget, checkBudget } = await import('./auth.js');
    checkBudget(c, await timed(c, 'budget-db', () => chargeGrantBudget(c.env, 'platform', 'ops_support')), c.env.config.apiRateLimitPerMinute);
    c.set('actor', { workspaceId: '', permissions: [], domains: [], keyId: 'service:bane-support', credential: 'operatorService' });
    return next();
  }
  if (!hasSessionCookie(c.req.raw.headers)) throw operatorRequired();
  const { authenticate } = await import('./auth.js');
  try { await authenticate(c, async () => {}); await requireOperator(c, 'operator:read'); }
  catch (error) { if (error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404)) throw operatorRequired(); throw error; }
  return next();
};

/**
 * /v1/support/*: a live, unexpired, unrevoked support grant, else 403. One statement authenticates the grant, counts the
 * request against its minute budget, narrows it to the workspaces its user still belongs to, writes this call to the
 * audit trail and, the first time a grant touches a workspace, the customer-visible "support.view" row.
 */
export const supportGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = bearer(c);
  if (!c.env.config.multiTenant || !token || !SUPPORT_TOKEN.test(token)) throw supportRequired();
  const filter = c.req.query('workspaceId') ?? null, context = auditContext(c), limit = SUPPORT_RATE_PER_MINUTE;
  const query = Object.fromEntries(Object.entries(c.req.queries()).map(([k, v]) => [k.slice(0, 40), v.join(',').slice(0, 120)]).slice(0, 12));
  const call = { route: c.req.path.slice(0, 200), method: c.req.method, query }, hash = await digest(token);
  const { rows: [grant] } = await timed(c, 'support-db', () => c.env.db.execute<{ id: string; user_id: string; ticket_ref: string; operator_id: string; content_workspace_id: string | null; expires_at: string; used: number;
    workspaces: SupportScope['workspaces'] }>(sql`WITH g AS (
      UPDATE support_grants SET used = CASE WHEN window_start = date_trunc('minute', now()) THEN least(used + 1, ${limit + 1}) ELSE 1 END,
        window_start = date_trunc('minute', now()), last_used_at = now()
      WHERE token_hash = ${hash} AND revoked_at IS NULL AND expires_at > now()
      RETURNING id, user_id, workspace_ids, ticket_ref, operator_id, content_workspace_id, handoff_id, expires_at, used
    ), scope AS (
      SELECT m.workspace_id AS id, w.name, m.role FROM g JOIN workspace_members m ON m.user_id = g.user_id AND m.workspace_id = ANY(g.workspace_ids) JOIN workspaces w ON w.id = m.workspace_id
    ), logged AS (
      INSERT INTO audit_events(workspace_id, user_id, actor_type, actor_id, actor_label, via, action, target_type, target_id, summary, ticket_ref, request_id, ip_network, user_agent, internal, retain_until)
      SELECT (SELECT id FROM scope WHERE id = ${filter}), g.user_id, 'support', g.id, 'Bane support', 'support', 'support.read', 'user', g.user_id,
        ${JSON.stringify(call)}::jsonb || jsonb_build_object('operator', g.operator_id, 'workspaces', (SELECT coalesce(jsonb_agg(id), '[]') FROM scope)), g.ticket_ref,
        ${context.requestId}, ${context.ipNetwork}, ${context.userAgent}, true, now() + interval '90 days' FROM g WHERE g.used <= ${limit}
    ), viewed AS (
      INSERT INTO audit_events(workspace_id, user_id, actor_type, actor_id, actor_label, via, action, target_type, target_id, summary, ticket_ref, request_id, internal, retain_until)
      SELECT s.id, g.user_id, 'support', g.id, 'Bane support', 'support', 'support.view', 'workspace', s.id,
        jsonb_strip_nulls(jsonb_build_object('ticket', g.ticket_ref, 'until', g.expires_at, 'handoff', g.handoff_id, 'member', g.user_id, 'contentShared', g.content_workspace_id = s.id)),
        g.ticket_ref, ${context.requestId}, false, now() + interval '1 year' FROM g, scope s WHERE g.used <= ${limit} AND (${filter}::text IS NULL OR s.id = ${filter})
      ON CONFLICT (actor_id, workspace_id) WHERE action = 'support.view' DO NOTHING
    ) SELECT g.id, g.user_id, g.ticket_ref, g.operator_id, g.content_workspace_id, g.expires_at::text AS expires_at, g.used,
      coalesce((SELECT json_agg(json_build_object('id', id, 'name', name, 'role', role) ORDER BY name, id) FROM scope), '[]') AS workspaces FROM g`));
  if (!grant) throw supportRequired();
  if (grant.used > limit) { c.header('Retry-After', '60'); throw new ApiError(429, 'REQUEST_RATE_LIMITED', `A support grant may make ${limit} requests a minute. Retry after the window resets.`, undefined, true); }
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') throw new ApiError(403, 'SUPPORT_READ_ONLY', 'A support grant can only read.');
  // Content only in the workspace the customer opted in from, and only while they still belong to it.
  const contentWorkspaceId = grant.workspaces.some(w => w.id === grant.content_workspace_id) ? grant.content_workspace_id : null;
  const scope: SupportScope = { grantId: grant.id, userId: grant.user_id, ticketRef: grant.ticket_ref, operatorId: grant.operator_id, contentWorkspaceId, expiresAt: new Date(grant.expires_at).toISOString(), workspaces: grant.workspaces };
  if (filter !== null && !scope.workspaces.some(w => w.id === filter)) notFound('Workspace');
  c.set('support', scope);
  c.set('actor', { workspaceId: filter ?? scope.workspaces[0]?.id ?? '', permissions: [], domains: [], keyId: grant.id, credential: 'support' });
  return next();
};

// ---------- the customer's in-app handoff ----------

const b64url = (bytes: Uint8Array | string) => Buffer.from(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes).toString('base64url');
async function keyId(x: string) { return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(x)))).slice(0, 16); }
/** A compact JWS (EdDSA) the support platform verifies with GET /v1/public/support-keys. */
async function signHandoff(key: { kty: 'OKP'; crv: 'Ed25519'; d: string; x: string }, claims: Record<string, unknown>) {
  const header = b64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: await keyId(key.x) })), payload = b64url(JSON.stringify(claims));
  const signer = await crypto.subtle.importKey('jwk', { ...key, ext: false }, { name: 'Ed25519' }, false, ['sign']);
  return `${header}.${payload}.${b64url(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, signer, new TextEncoder().encode(`${header}.${payload}`))))}`;
}
/** A handoff opens at most one grant, within this many minutes; its signed token lives 10 minutes. */
const HANDOFF_MINUTES = 30, HANDOFF_TOKEN_SECONDS = 600, HANDOFFS_PER_HOUR = 10;
const Handoff = z.object({
  id: z.string().describe('The support reference (sho_…). Quote it to support.'),
  url: z.string().nullable().describe('Where to continue with support, carrying the signed handoff; null when no support site is configured.'),
  token: z.string().nullable().describe('The signed handoff (EdDSA JWS, 10 minutes), or null when signing is not configured.'),
  expiresAt: z.string().describe('Until when support can use this handoff to open read access (30 minutes, once).'),
  shareContent: z.boolean(),
}).openapi('SupportHandoff');

// ---------- what support reads ----------

const WorkspaceFilter = z.object({ workspaceId: z.string().max(100).optional().describe('Only this workspace; it must be one of the grant’s. Omit for all of them.') });
const Page = z.object({ cursor: z.string().max(200).optional().describe('nextCursor from the previous page.'), limit: z.coerce.number().int().min(1).max(100).default(25) });
const Since = z.object({ since: z.iso.datetime().optional().describe('Only items at or after this time (default: 7 days ago).') });
const tags = ['Support (internal)'];
const supportSecurity: Record<string, string[]>[] = [{ bearerAuth: [] }];
const describe = (text: string) => `${text} Internal: for Bane support with a support grant (bane_support_…), never for customers.`;
function scoped(c: Ctx, roles?: ('owner' | 'admin' | 'member')[]) {
  const scope = c.get('support')!, filter = c.req.query('workspaceId');
  const workspaces = scope.workspaces.filter(w => (!filter || w.id === filter) && (!roles || roles.includes(w.role)));
  return { scope, ids: workspaces.map(w => w.id), workspaces };
}
const ids = (list: string[]) => sql`${sql.param(list)}::text[]`;
const sinceOf = (since: string | undefined, days = 7) => since ?? new Date(Date.now() - days * 86_400_000).toISOString();
function keyset(cursor: string | undefined) {
  if (!cursor) return null;
  const [at, key] = Buffer.from(cursor, 'base64url').toString().split('|');
  if (!at || !key || Number.isNaN(Date.parse(at))) throw new ApiError(422, 'INVALID_CURSOR', 'The cursor is not valid. Start again without it.', 'cursor');
  return { at, key };
}
const nextCursor = <T extends { at_text: string; key: string }>(rows: T[], limit: number) => rows.length > limit ? Buffer.from(`${rows[limit - 1]!.at_text}|${rows[limit - 1]!.key}`).toString('base64url') : null;
const strip = <T extends Record<string, unknown>>(row: T) => { const { at_text: _a, key: _k, ...rest } = row; return rest; };

const WorkspaceSummary = z.object({
  id: z.string(), name: z.string(), role: z.enum(['owner', 'admin', 'member']).describe('The customer’s role in this workspace.'), createdAt: z.string(),
  sending: z.object({ kind: z.string().describe('shared (Bane Hosted) or byo (their own AWS).'), region: z.string(), state: z.string().nullable(), paused: z.boolean(), pauseReason: z.string().nullable(),
    dailyLimitOverride: z.number().nullable() }).nullable().describe('The sending connection, or null when none is set up.'),
  counts: z.record(z.string(), z.number()).describe('How many of each resource the workspace has: domains, apiKeys, webhooks, inboxes, addresses, routes, endpoints, campaigns, templates, contacts (counted up to 100,000).'),
}).openapi('SupportWorkspace');
const DomainSummary = z.object({
  workspaceId: z.string(), id: z.string(), name: z.string(), region: z.string().nullable(), createdAt: z.string().nullable(),
  sending: z.string().nullable().describe('pending, verified, failed or lost.'), dkim: z.string().nullable(), mailFrom: z.string().nullable(), dmarc: z.string().nullable(),
  receiving: z.string().nullable().describe('off, pending, active or lost.'), lostSince: z.string().nullable(),
}).openapi('SupportDomain');
const EmailSummary = z.object({
  workspaceId: z.string(), id: z.string(), direction: z.enum(['sent', 'received']), at: z.string(), from: z.string(), to: z.array(z.string()), subject: z.string(),
  status: z.string(), errorCode: z.string().nullable(), suppressionReason: z.string().nullable(), campaignId: z.string().nullable(), kind: z.string().nullable(), simulated: z.boolean().nullable(),
  providerMessageId: z.string().nullable().describe('The SES message ID, for provider-side lookups.'),
}).openapi('SupportEmail');
const DeliveryEvent = z.object({ workspaceId: z.string(), id: z.string(), emailId: z.string(), type: z.string().describe('send, delivery, bounce, complaint, reject, open, click…'), at: z.string(),
  detail: z.record(z.string(), z.unknown()).describe('The provider’s event detail (bounce type and diagnostic, complaint feedback type).') }).openapi('SupportDeliveryEvent');
const WebhookDelivery = z.object({ workspaceId: z.string(), id: z.string(), source: z.enum(['email', 'inbound']).describe('email: sending events; inbound: received mail.'), webhookId: z.string(),
  endpoint: z.string().describe('The last four characters of the URL; URLs are credentials.'), eventType: z.string().nullable(), status: z.string(), attempts: z.number(), lastStatusCode: z.number().nullable(),
  lastError: z.string().nullable(), createdAt: z.string(), updatedAt: z.string() }).openapi('SupportWebhookDelivery');
const Standing = z.object({ workspaceId: z.string(), connection: z.record(z.string(), z.unknown()).nullable(), limits: z.record(z.string(), z.unknown()),
  standing: z.record(z.string(), z.unknown()).nullable().describe('The sender standing (step, reasons, score, daily limit) where the reputation system is enabled.'),
  last24h: z.record(z.string(), z.number()).describe('Sent mail in the last 24 hours by status (counted up to 50,000).') }).openapi('SupportStanding');

async function workspaceSummaries(db: DbExecutor, list: SupportScope['workspaces']) {
  if (!list.length) return [];
  const { rows } = await db.execute<{ id: string; created_at: string; sending: z.infer<typeof WorkspaceSummary>['sending']; counts: Record<string, number> }>(sql`SELECT w.id, w.created_at::text,
      (SELECT json_build_object('kind', pc.kind, 'region', pc.region, 'state', to_jsonb(pc) ->> 'state', 'paused', pc.paused_at IS NOT NULL, 'pauseReason', left(to_jsonb(pc) ->> 'pause_reason', 300),
        'dailyLimitOverride', w.send_cap_override) FROM provider_connections pc WHERE pc.workspace_id = w.id) AS sending,
      json_build_object('domains', (SELECT count(*) FROM operation_domains WHERE workspace_id = w.id), 'apiKeys', (SELECT count(*) FROM api_keys WHERE workspace_id = w.id AND revoked_at IS NULL),
        'webhooks', (SELECT count(*) FROM operation_webhooks WHERE workspace_id = w.id) + (SELECT count(*) FROM mailbox_webhooks WHERE workspace_id = w.id),
        'inboxes', (SELECT count(*) FROM mailboxes WHERE workspace_id = w.id AND kind = 'inbox'), 'addresses', (SELECT count(*) FROM mailboxes WHERE workspace_id = w.id AND kind = 'address'),
        'routes', (SELECT count(*) FROM mail_routes WHERE workspace_id = w.id), 'endpoints', (SELECT count(*) FROM mail_endpoints WHERE workspace_id = w.id),
        'campaigns', (SELECT count(*) FROM sending_campaigns WHERE workspace_id = w.id), 'templates', (SELECT count(*) FROM campaign_templates WHERE workspace_id = w.id),
        'contacts', (SELECT count(*) FROM (SELECT FROM audience_contacts WHERE workspace_id = w.id LIMIT 100000) x)) AS counts
    FROM workspaces w WHERE w.id = ANY(${ids(list.map(w => w.id))})`);
  return list.map(w => { const r = rows.find(x => x.id === w.id); return { ...w, createdAt: r ? new Date(r.created_at).toISOString() : '', sending: r?.sending ?? null, counts: r?.counts ?? {} }; });
}
async function domainSummaries(db: DbExecutor, list: string[], limit = 200) {
  if (!list.length) return [];
  return (await db.execute<z.infer<typeof DomainSummary>>(sql`SELECT d.workspace_id AS "workspaceId", d.id, d.name, d.region, d.created_at::text AS "createdAt",
      c.claim ->> 'sending_state' AS sending, c.claim #>> '{identity,ses,DkimAttributes,Status}' AS dkim, c.claim #>> '{identity,ses,MailFromAttributes,MailFromDomainStatus}' AS "mailFrom",
      c.claim #>> '{identity,dmarc,status}' AS dmarc, c.claim ->> 'receiving_state' AS receiving, c.claim ->> 'lost_since' AS "lostSince"
    FROM operation_domains d LEFT JOIN LATERAL (SELECT to_jsonb(dc) AS claim FROM domain_claims dc WHERE dc.name = d.name AND dc.workspace_id = d.workspace_id) c ON true
    WHERE d.workspace_id = ANY(${ids(list)}) ORDER BY d.workspace_id, d.name LIMIT ${limit}`)).rows;
}
async function standings(db: DbExecutor, list: string[]) {
  if (!list.length) return [];
  const { rows } = await db.execute<z.infer<typeof Standing>>(sql`SELECT w.id AS "workspaceId",
      (SELECT jsonb_build_object('kind', pc.kind, 'region', pc.region, 'state', to_jsonb(pc) ->> 'state', 'pausedAt', pc.paused_at, 'pauseReason', left(to_jsonb(pc) ->> 'pause_reason', 300),
        'resumedAt', to_jsonb(pc) ->> 'resumed_at') FROM provider_connections pc WHERE pc.workspace_id = w.id) AS connection,
      jsonb_build_object('dailyOverride', w.send_cap_override, 'pendingOverride', w.pending_cap_override, 'exempt', w.exempt_hosted_quotas,
        'overrideExpiresAt', to_jsonb(w) ->> 'send_cap_override_expires_at') AS limits,
      -- What the customer's own score card and banners show (#115), never operator-only fields such as the watch flag.
      (SELECT jsonb_build_object('step', s.step, 'since', s.since, 'reasons', s.reasons, 'phase', s.phase, 'score', s.score, 'dailyLimit', s.daily_limit, 'factors', s.factors,
        'pauseKind', s.pause_kind, 'marketingHold', s.marketing_hold, 'releaseUntil', s.release_until, 'releasePercent', s.release_percent, 'strikes', jsonb_array_length(s.strikes),
        'strikeUntil', s.strike_until, 'version', s.version) FROM sender_standing s WHERE s.workspace_id = w.id) AS standing,
      (SELECT coalesce(jsonb_object_agg(status, n), '{}') FROM (SELECT status, count(*)::int AS n FROM (SELECT status FROM sending_emails
        WHERE workspace_id = w.id AND created_at > now() - interval '24 hours' LIMIT 50000) x GROUP BY status) y) AS "last24h"
    FROM workspaces w WHERE w.id = ANY(${ids(list)}) ORDER BY w.name, w.id`);
  return rows;
}
async function failures(db: DbExecutor, list: string[]) {
  if (!list.length) return { sends: [] as Record<string, unknown>[], bounces: [] as Record<string, unknown>[], webhookDeliveries: [] as Record<string, unknown>[] };
  type Row = Record<string, unknown>;
  const { rows: [row] } = await db.execute<{ sends: Row[]; bounces: Row[]; webhooks: Row[] }>(sql`SELECT
    (SELECT coalesce(json_agg(x), '[]') FROM (SELECT workspace_id AS "workspaceId", status, coalesce(error_code, suppression_reason, status) AS code, count(*)::int AS count, max(created_at)::text AS "lastAt"
      FROM (SELECT workspace_id, status, error_code, suppression_reason, created_at FROM sending_emails WHERE workspace_id = ANY(${ids(list)}) AND created_at > now() - interval '24 hours'
        AND status IN ('failed','rejected','suppressed','canceled','bounced','complained','acceptance_unknown') LIMIT 20000) e GROUP BY 1, 2, 3 ORDER BY count(*) DESC LIMIT 20) x) AS sends,
    (SELECT coalesce(json_agg(x), '[]') FROM (SELECT workspace_id AS "workspaceId", type, coalesce(data #>> '{bounce,bounceType}', data #>> '{complaint,complaintFeedbackType}', data ->> 'code') AS reason,
      count(*)::int AS count FROM (SELECT workspace_id, type, data FROM sending_email_events WHERE workspace_id = ANY(${ids(list)}) AND created_at > now() - interval '24 hours'
        AND type IN ('bounce','complaint','reject') LIMIT 20000) v GROUP BY 1, 2, 3 ORDER BY count(*) DESC LIMIT 20) x) AS bounces,
    (SELECT coalesce(json_agg(x), '[]') FROM (SELECT workspace_id AS "workspaceId", webhook_id AS "webhookId", source, count(*)::int AS count, max(last_status_code) AS "lastStatusCode",
      left(max(last_error), 300) AS "lastError" FROM (SELECT workspace_id, webhook_id, 'email' AS source, last_status_code, last_error FROM operation_deliveries
        WHERE workspace_id = ANY(${ids(list)}) AND status = 'failed' AND updated_at > now() - interval '24 hours'
      UNION ALL SELECT workspace_id, webhook_id, 'inbound', last_status_code, last_error FROM mailbox_webhook_deliveries
        WHERE workspace_id = ANY(${ids(list)}) AND status = 'failed' AND updated_at > now() - interval '24 hours') d GROUP BY 1, 2, 3 ORDER BY count(*) DESC LIMIT 20) x) AS webhooks`);
  return { sends: row!.sends, bounces: row!.bounces, webhookDeliveries: row!.webhooks };
}

/** The operator routes for the support platform. */
export function registerSupportOperator(app: App) {
  const operatorSecurity: Record<string, string[]>[] = [{ bearerAuth: [] }, { dashboardSession: [] }, { secureDashboardSession: [] }];
  const Workspaces = z.array(z.object({ id: z.string(), name: z.string(), role: z.enum(['owner', 'admin', 'member']) }));
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security: operatorSecurity, method: 'post', path: '/v1/operator/support/verify-email', operationId: 'operatorVerifySupportEmail',
    request: { body: json(z.object({
      email: z.email().max(254).describe('The From address of the support email.'),
      evidence: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('dmarc'), result: z.literal('pass'), aligned: z.literal(true), messageId: z.string().trim().min(1).max(300).describe('The Message-ID of the verified email, recorded with the lookup.') }).strict(),
        z.object({ kind: z.literal('magic_link'), confirmedAt: z.iso.datetime() }).strict(),
      ]).describe('How the support platform verified the sender: a DMARC-aligned pass, or a magic link the person opened.'),
      ticketRef: z.string().trim().min(1).max(200).optional(),
    }).strict()) },
    responses: { 200: response(z.object({ verified: z.boolean(), user: z.object({ id: z.string(), name: z.string() }).nullable(), workspaces: Workspaces })), ...errors } }), async c => {
    const operator = await requireOperator(c, 'operator:read'), body = c.req.valid('json');
    if (body.evidence.kind === 'magic_link') {
      const at = Date.parse(body.evidence.confirmedAt);
      if (at > Date.now() + 60_000) throw new ApiError(422, 'EVIDENCE_INVALID', 'A magic link confirmation cannot be in the future.', 'evidence.confirmedAt');
      if (at < Date.now() - 86_400_000) throw new ApiError(422, 'EVIDENCE_STALE', 'A magic link confirmation must be less than a day old.', 'evidence.confirmedAt');
    }
    // Only a verified email of a signed-in user maps to an account. One statement: the lookup and its audit row.
    const audit = auditInsert(operatorContext(c, operator), { action: 'support.verify_email', workspaceId: null, userId: sql`u.id`, target: { type: 'user', id: sql`u.id` },
      details: { evidence: body.evidence, ticket: body.ticketRef }, ticketRef: body.ticketRef ?? null, internal: true }, { from: sql`u` });
    const { rows: [row] } = await c.env.db.execute<{ id: string; name: string; workspaces: z.infer<typeof Workspaces> }>(sql`WITH u AS (SELECT id, name FROM bane_users WHERE lower(email) = lower(${body.email}) AND email_verified LIMIT 1),
      logged AS (${audit})
      SELECT u.id, u.name, coalesce((SELECT json_agg(json_build_object('id', w.id, 'name', w.name, 'role', m.role) ORDER BY w.name, w.id) FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.user_id = u.id), '[]') AS workspaces FROM u`);
    return c.json({ verified: !!row, user: row ? { id: row.id, name: row.name } : null, workspaces: row?.workspaces ?? [] }, 200);
  });

  const Grant = z.object({ id: z.string(), userId: z.string(), workspaceIds: z.array(z.string()), ticketRef: z.string(), verification: z.enum(['handoff', 'dmarc', 'magic_link']), contentShared: z.boolean(),
    contentWorkspaceId: z.string().nullable().describe('The one workspace whose message content the customer shared (the handoff’s), or null.'), handoffId: z.string().nullable(), createdAt: z.string(), expiresAt: z.string(), revokedAt: z.string().nullable(), lastUsedAt: z.string().nullable(), operatorId: z.string() }).openapi('SupportGrant');
  const grantView = sql`id, user_id AS "userId", workspace_ids AS "workspaceIds", ticket_ref AS "ticketRef", verification, content_workspace_id IS NOT NULL AS "contentShared", content_workspace_id AS "contentWorkspaceId", handoff_id AS "handoffId", created_at::text AS "createdAt",
    expires_at::text AS "expiresAt", revoked_at::text AS "revokedAt", last_used_at::text AS "lastUsedAt", operator_id AS "operatorId"`;
  const iso = <T extends Record<string, unknown>>(row: T) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'string' && /At$/.test(k) ? new Date(v).toISOString() : v])) as T;
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security: operatorSecurity, method: 'post', path: '/v1/operator/support/grants', operationId: 'operatorCreateSupportGrant',
    request: { body: json(z.object({
      userId: z.string().min(1).max(200).describe('The verified customer: from the signed handoff or verify-email, never from the agent.'),
      ticketRef: z.string().trim().min(1).max(200).describe('The support ticket. One active grant per ticket.'),
      reason: z.string().trim().min(10).max(1000),
      verification: z.enum(['handoff', 'dmarc', 'magic_link']).describe('How the customer was verified. handoff needs handoffId.'),
      handoffId: z.string().regex(/^sho_[0-9a-f]{32}$/).optional().describe('The in-app handoff: used once, within 30 minutes. The only way message content can be shared, and only in the handoff’s workspace, if the customer ticked it.'),
      workspaceIds: z.array(z.string().max(100)).min(1).max(100).optional().describe('The user’s workspaces to cover. Default: the handoff’s workspace for a handoff, otherwise all of them.'),
      ttlMinutes: z.number().int().min(1).max(GRANT_MAX_MINUTES).default(60),
    }).strict()) },
    responses: { 201: response(Grant.extend({ token: z.string().describe('bane_support_…, shown once. Give it to the support agent’s environment only.') })), ...errors } }), async c => {
    const operator = await requireOperator(c, 'operator:read'), body = c.req.valid('json');
    if ((body.verification === 'handoff') !== !!body.handoffId) throw new ApiError(422, 'VALIDATION_FAILED', 'A handoff verification needs handoffId, and only it.', 'handoffId');
    const token = randomSecret('bane_support_'), grantId = id('sgr'), context = operatorContext(c, operator);
    const created = await c.env.db.transaction(async tx => {
      // An expired grant no longer holds its ticket.
      await tx.execute(sql`UPDATE support_grants SET revoked_at = expires_at WHERE ticket_ref = ${body.ticketRef} AND revoked_at IS NULL AND expires_at <= now()`);
      // A handoff opens one grant (it is locked, then marked used in the same statement), covers by default only the
      // workspace it came from, and shares content, if the customer ticked it, only in that workspace.
      const { rows: [row] } = await tx.execute<z.infer<typeof Grant> & { handoff: boolean | null; handoff_used: boolean | null; active: number }>(sql`WITH h AS (
          SELECT share_content, workspace_id, used_at FROM support_handoffs WHERE id = ${body.handoffId ?? null} AND user_id = ${body.userId} AND expires_at > now() FOR UPDATE
        ), m AS (
          SELECT array_agg(workspace_id ORDER BY workspace_id = (SELECT workspace_id FROM h) DESC, created_at) AS ws FROM workspace_members
          WHERE user_id = ${body.userId} ${body.workspaceIds ? sql`AND workspace_id = ANY(${ids(body.workspaceIds)})` : body.verification === 'handoff' ? sql`AND workspace_id = (SELECT workspace_id FROM h)` : sql``}
        ), active AS (SELECT count(*)::int AS n FROM support_grants WHERE user_id = ${body.userId} AND revoked_at IS NULL AND expires_at > now()),
        g AS (
          INSERT INTO support_grants(id, token_hash, user_id, workspace_ids, ticket_ref, verification, handoff_id, content_workspace_id, operator_id, operator_via, reason, expires_at)
          SELECT ${grantId}, ${await digest(token)}, ${body.userId}, m.ws, ${body.ticketRef}, ${body.verification}, ${body.handoffId ?? null},
            (SELECT workspace_id FROM h WHERE share_content AND workspace_id = ANY(m.ws)), ${operator.id}, ${operator.via}, ${body.reason}, now() + make_interval(mins => ${body.ttlMinutes})
          FROM m WHERE cardinality(m.ws) > 0 AND (SELECT n FROM active) < 5 AND (${body.verification} <> 'handoff' OR EXISTS (SELECT FROM h WHERE used_at IS NULL))
          ON CONFLICT (ticket_ref) WHERE revoked_at IS NULL DO NOTHING RETURNING *
        ), used AS (UPDATE support_handoffs s SET used_at = now(), grant_id = g.id FROM g WHERE s.id = g.handoff_id
        ), logged AS (${auditInsert(context, { action: 'support.grant', workspaceId: null, userId: body.userId, target: { type: 'support_grant', id: grantId }, reason: body.reason, ticketRef: body.ticketRef,
          after: sql`(SELECT jsonb_build_object('workspaces', workspace_ids, 'contentWorkspace', content_workspace_id, 'verification', verification, 'handoff', handoff_id, 'expiresAt', expires_at) FROM g)`, internal: true },
          { where: sql`EXISTS (SELECT FROM g)` })})
        SELECT ${grantView}, (SELECT EXISTS (SELECT FROM h)) AS handoff, (SELECT used_at IS NOT NULL FROM h) AS handoff_used, (SELECT n FROM active) AS active,
          (SELECT coalesce(cardinality(ws), 0) FROM m) AS memberships FROM g RIGHT JOIN (SELECT 1) one ON true`);
      return row;
    });
    if (!created?.id) {
      const facts = created as unknown as { handoff: boolean; handoff_used: boolean | null; active: number; memberships: number };
      if (body.verification === 'handoff' && !facts.handoff) throw new ApiError(404, 'NOT_FOUND', 'Handoff was not found for that user, or it expired.');
      if (body.verification === 'handoff' && facts.handoff_used) throw new ApiError(409, 'SUPPORT_HANDOFF_USED', 'This handoff already opened a support grant. The customer can contact support again for a new one.');
      if (!facts.memberships) throw new ApiError(404, 'NOT_FOUND', 'That user has no workspaces in scope.');
      if (facts.active >= 5) throw new ApiError(429, 'SUPPORT_GRANT_LIMIT', 'This user already has 5 active support grants. Revoke one first.');
      throw new ApiError(409, 'SUPPORT_GRANT_ACTIVE', 'This ticket already has an active support grant. Revoke it before minting another.');
    }
    const { handoff: _h, handoff_used: _u, active: _a, memberships: _m, ...grant } = created as typeof created & { memberships?: number };
    log('info', { code: 'SUPPORT_GRANT_CREATED', grantId, operator: operator.id, ticketRef: body.ticketRef });
    return c.json({ ...iso(grant), token }, 201);
  });
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security: operatorSecurity, method: 'get', path: '/v1/operator/support/grants', operationId: 'operatorListSupportGrants',
    request: { query: z.object({ ticketRef: z.string().max(200).optional(), userId: z.string().max(200).optional(), active: z.enum(['true', 'false']).default('true') }) },
    responses: { 200: response(z.object({ data: z.array(Grant) })), ...errors } }), async c => {
    await requireOperator(c, 'operator:read');
    const q = c.req.valid('query');
    const { rows } = await c.env.db.execute<z.infer<typeof Grant>>(sql`SELECT ${grantView} FROM support_grants WHERE true
      ${q.ticketRef ? sql`AND ticket_ref = ${q.ticketRef}` : sql``} ${q.userId ? sql`AND user_id = ${q.userId}` : sql``} ${q.active === 'true' ? sql`AND revoked_at IS NULL AND expires_at > now()` : sql``}
      ORDER BY created_at DESC LIMIT 100`);
    return c.json({ data: rows.map(iso) }, 200);
  });
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security: operatorSecurity, method: 'post', path: '/v1/operator/support/grants/{id}/revoke', operationId: 'operatorRevokeSupportGrant',
    request: { params: z.object({ id: z.string().max(100) }) }, responses: { 200: response(z.object({ id: z.string(), revoked: z.literal(true) })), ...errors } }), async c => {
    const operator = await requireOperator(c, 'operator:read'), grantId = c.req.valid('param').id;
    const { rows } = await c.env.db.execute(sql`WITH g AS (UPDATE support_grants SET revoked_at = now() WHERE id = ${grantId} AND revoked_at IS NULL RETURNING id, user_id, ticket_ref),
      logged AS (${auditInsert(operatorContext(c, operator), { action: 'support.grant_revoke', workspaceId: null, userId: sql`g.user_id`, target: { type: 'support_grant', id: sql`g.id` }, internal: true }, { from: sql`g` })})
      SELECT id FROM g`);
    if (!rows.length) notFound('Active support grant');
    return c.json({ id: grantId, revoked: true as const }, 200);
  });
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security: operatorSecurity, method: 'get', path: '/v1/operator/support/handoffs/{id}', operationId: 'operatorGetSupportHandoff',
    request: { params: z.object({ id: z.string().regex(/^sho_[0-9a-f]{32}$/) }) },
    responses: { 200: response(z.object({ id: z.string(), userId: z.string(), workspaceId: z.string(), kind: z.string(), page: z.string().nullable(), requestIds: z.array(z.string()), message: z.string().nullable(),
      shareContent: z.boolean(), createdAt: z.string(), expiresAt: z.string(), usedAt: z.string().nullable(), grantId: z.string().nullable() })), ...errors } }), async c => {
    await requireOperator(c, 'operator:read');
    const { rows: [row] } = await c.env.db.execute<{ id: string; userId: string; workspaceId: string; kind: string; page: string | null; requestIds: string[]; message: string | null; shareContent: boolean; createdAt: string; expiresAt: string; usedAt: string | null; grantId: string | null }>(sql`SELECT id,
      user_id AS "userId", workspace_id AS "workspaceId", kind, page, request_ids AS "requestIds", message, share_content AS "shareContent", created_at::text AS "createdAt", expires_at::text AS "expiresAt",
      used_at::text AS "usedAt", grant_id AS "grantId" FROM support_handoffs WHERE id = ${c.req.valid('param').id}`);
    if (!row) notFound('Handoff');
    return c.json({ ...row!, createdAt: new Date(row!.createdAt).toISOString(), expiresAt: new Date(row!.expiresAt).toISOString(), usedAt: row!.usedAt ? new Date(row!.usedAt).toISOString() : null }, 200);
  });
}

/** The customer's "Contact support", the public signing keys and the grant's read routes. */
export function registerSupport(app: App) {
  app.openapi(createRoute({ method: 'post', path: '/v1/contact-support', operationId: 'contactSupport', tags: ['Workspaces'], security: [{ dashboardSession: [] }, { secureDashboardSession: [] }] as Record<string, string[]>[],
    description: 'Hosted: start a support request from the dashboard. Returns a support reference and, when configured, the support site’s URL carrying a signed handoff (this workspace, you, the page and recent request IDs). Support reads message content only if shareContent is true, only in this workspace and only for this request (one grant, within 30 minutes). Any member may contact support.',
    request: { body: json(z.object({
      kind: z.enum(['support', 'appeal', 'limit_request']).default('support'),
      page: z.string().trim().max(200).regex(/^\/[^\s]*$/).optional().describe('The dashboard path the person was on.'),
      requestIds: z.array(z.string().regex(/^req_[0-9a-f]{32}$/)).max(5).default([]).describe('x-request-id values of recent failed requests.'),
      shareContent: z.boolean().default(false).describe('Let support read message content (email bodies) in this workspace, for this request only.'),
      message: z.string().trim().max(2000).optional(),
    }).strict()) },
    responses: { 201: response(Handoff), ...errors } }), async c => {
    if (!c.env.config.multiTenant) notFound('Endpoint');
    const a = c.get('actor');
    if (a?.credential !== 'dashboard') throw new ApiError(403, 'DASHBOARD_AUTH_REQUIRED', 'Use a signed-in dashboard session.');
    const body = c.req.valid('json'), userId = a.keyId.slice(5), handoffId = id('sho');
    const { rows: [row] } = await c.env.db.execute<{ id: string; expires_at: string; name: string; email: string }>(sql`WITH h AS (
        INSERT INTO support_handoffs(id, user_id, workspace_id, kind, page, request_ids, message, share_content, expires_at)
        SELECT ${handoffId}, ${userId}, ${a.workspaceId}, ${body.kind}, ${body.page ?? null}, ${sql.param(body.requestIds)}::text[], ${body.message ?? null}, ${body.shareContent}, now() + ${`${HANDOFF_MINUTES} minutes`}::interval
        WHERE (SELECT count(*) FROM support_handoffs WHERE user_id = ${userId} AND created_at > now() - interval '1 hour') < ${HANDOFFS_PER_HOUR}
        RETURNING id, expires_at
      ), logged AS (${auditInsert(auditContext(c), { action: 'support.contact', workspaceId: a.workspaceId, target: { type: 'support_handoff', id: handoffId },
        after: { kind: body.kind, page: body.page, requestIds: body.requestIds, contentShared: body.shareContent } }, { where: sql`EXISTS (SELECT FROM h)` })})
      SELECT h.id, h.expires_at::text, w.name, ${userEmail(sql`${userId}`)} AS email FROM h, workspaces w WHERE w.id = ${a.workspaceId}`);
    if (!row) { c.header('Retry-After', '3600'); throw new ApiError(429, 'SUPPORT_RATE_LIMITED', `You can contact support ${HANDOFFS_PER_HOUR} times an hour. Email support with your earlier reference instead.`, undefined, true); }
    const support = c.env.config.support, now = Math.floor(Date.now() / 1000);
    const token = support?.signingKey ? await signHandoff(support.signingKey, { iss: c.env.config.publicUrl, aud: 'bane-support', jti: handoffId, iat: now, exp: now + HANDOFF_TOKEN_SECONDS,
      kind: body.kind, workspace: { id: a.workspaceId, name: row.name }, user: { id: userId, email: row.email, role: a.role }, page: body.page ?? null, requestIds: body.requestIds,
      shareContent: body.shareContent, message: !!body.message }) : null;
    const url = support?.url ? `${support.url}#${token ? `handoff=${token}` : `handoffId=${handoffId}`}` : null;
    return c.json({ id: handoffId, url, token, expiresAt: new Date(row.expires_at).toISOString(), shareContent: body.shareContent }, 201);
  });
  app.get('/v1/public/support-keys', async c => {
    const key = c.env.config.support?.signingKey;
    c.header('cache-control', 'public, max-age=300');
    return c.json({ keys: key ? [{ kty: 'OKP', crv: 'Ed25519', x: key.x, kid: await keyId(key.x), alg: 'EdDSA', use: 'sig' }] : [] });
  });

  // ---------- GET /v1/support/* (supportGate has authenticated the grant and logged the call) ----------
  const meta = (operationId: string, description: string) => ({ method: 'get' as const, operationId, tags, security: supportSecurity, description: describe(description) });

  const Context = z.object({
    grant: z.object({ id: z.string(), ticketRef: z.string(), expiresAt: z.string(), contentShared: z.boolean().describe('Whether this request may read email bodies (the customer opted in).'),
      contentWorkspaceId: z.string().nullable().describe('The one workspace whose email bodies this request may read, or null.') }),
    user: z.object({ id: z.string(), name: z.string().nullable(), email: z.string().nullable(), createdAt: z.string().nullable() }),
    workspaces: z.array(WorkspaceSummary), domains: z.array(DomainSummary).describe('Up to 50 domains across the workspaces.'),
    recentFailures: z.object({ since: z.string(), sends: z.array(z.record(z.string(), z.unknown())).describe('Failed, rejected, suppressed and bounced sends in the last 24 hours, by code.'),
      bounces: z.array(z.record(z.string(), z.unknown())).describe('Bounce, complaint and reject events in the last 24 hours, by reason.'),
      webhookDeliveries: z.array(z.record(z.string(), z.unknown())).describe('Webhook deliveries that failed in the last 24 hours, by webhook.'),
      authErrors: z.null().describe('Bane does not store failed sign-ins or rejected API keys; look up a request ID instead.') }),
    standing: z.array(Standing), recentActivity: z.array(AuditEntry).describe('The last 20 customer-visible audit entries (owner and admin workspaces).'),
    openEnforcement: z.array(z.object({ workspaceId: z.string(), kind: z.string(), since: z.string().nullable(), reason: z.string().nullable() })).describe('Paused sending and paused campaigns.'),
    handoff: z.object({ id: z.string(), page: z.string().nullable(), requestIds: z.array(z.string()), message: z.string().nullable(), createdAt: z.string() }).nullable().describe('What the customer sent from "Contact support", if the grant came from it.'),
    links: z.object({ requestIds: z.array(z.string()).describe('Request IDs to look up with /v1/support/requests/{requestId}.') }),
  }).openapi('SupportContext');
  app.openapi(createRoute({ ...meta('getSupportContext', 'Start here: one compact summary of the customer for a support conversation: who they are, their workspaces and roles, sending setup and limits, domains and their verification, failures in the last 24 hours, open enforcement, the last 20 audit entries and request IDs to drill into.'), path: '/v1/support/context', request: { query: WorkspaceFilter }, responses: { 200: response(Context), ...errors } }), async c => {
    const { scope, ids: list, workspaces } = scoped(c), admin = workspaces.filter(w => w.role !== 'member').map(w => w.id), db = c.env.db;
    const { rows: [user] } = await db.execute<{ id: string; name: string | null; email: string | null; created_at: string | null }>(sql`SELECT id, name, email, created_at::text FROM bane_users WHERE id = ${scope.userId}`);
    const { rows: [handoff] } = await db.execute<{ id: string; page: string | null; request_ids: string[]; message: string | null; created_at: string }>(sql`SELECT h.id, h.page, h.request_ids, h.message, h.created_at::text
      FROM support_grants g JOIN support_handoffs h ON h.id = g.handoff_id WHERE g.id = ${scope.grantId}`);
    const [summaries, domains, recent, activity, stand] = [await workspaceSummaries(db, workspaces), await domainSummaries(db, list, 50), await failures(db, list), await customerTrail(db, admin, AuditFilters.parse({ limit: 20 })), await standings(db, list)];
    const { rows: enforcement } = await db.execute<{ workspaceId: string; kind: string; since: string | null; reason: string | null }>(sql`SELECT workspace_id AS "workspaceId", 'sending_paused' AS kind, paused_at::text AS since,
        left(to_jsonb(pc) ->> 'pause_reason', 300) AS reason FROM provider_connections pc WHERE workspace_id = ANY(${ids(list)}) AND paused_at IS NOT NULL
      UNION ALL SELECT workspace_id, 'campaign_paused:' || id, paused_at::text, left(pause_reason::text, 300) FROM sending_campaigns WHERE workspace_id = ANY(${ids(list)}) AND state = 'paused' LIMIT 20`);
    const requestIds = [...new Set([...(handoff?.request_ids ?? []), ...activity.data.map(e => e.requestId).filter((r): r is string => !!r)])].slice(0, 10);
    return c.json({ grant: { id: scope.grantId, ticketRef: scope.ticketRef, expiresAt: scope.expiresAt, contentShared: !!scope.contentWorkspaceId, contentWorkspaceId: scope.contentWorkspaceId },
      user: { id: scope.userId, name: user?.name ?? null, email: user?.email ?? null, createdAt: user?.created_at ? new Date(user.created_at).toISOString() : null },
      workspaces: summaries, domains, recentFailures: { since: new Date(Date.now() - 86_400_000).toISOString(), ...recent, authErrors: null }, standing: stand, recentActivity: activity.data,
      openEnforcement: enforcement.map(e => ({ ...e, since: e.since ? new Date(e.since).toISOString() : null })),
      handoff: handoff ? { id: handoff.id, page: handoff.page, requestIds: handoff.request_ids, message: handoff.message, createdAt: new Date(handoff.created_at).toISOString() } : null,
      links: { requestIds } }, 200);
  });
  app.openapi(createRoute({ ...meta('listSupportWorkspaces', 'The customer’s workspaces with their role, sending connection and resource counts.'), path: '/v1/support/workspaces', request: { query: WorkspaceFilter }, responses: { 200: response(z.object({ data: z.array(WorkspaceSummary) })), ...errors } }), async c =>
    c.json({ data: await workspaceSummaries(c.env.db, scoped(c).workspaces) }, 200));
  app.openapi(createRoute({ ...meta('listSupportDomains', 'Every domain with its sending verification (DKIM, MAIL FROM, DMARC) and receiving state.'), path: '/v1/support/domains', request: { query: WorkspaceFilter }, responses: { 200: response(z.object({ data: z.array(DomainSummary) })), ...errors } }), async c =>
    c.json({ data: await domainSummaries(c.env.db, scoped(c).ids) }, 200));

  const EmailQuery = WorkspaceFilter.extend(Page.shape).extend(Since.shape).extend({
    direction: z.enum(['sent', 'received']).default('sent'),
    status: z.string().max(40).optional().describe('Sent: queued, accepted, delivered, bounced, complained, failed, suppressed, canceled…; received: received, held…'),
    address: z.string().trim().toLowerCase().max(254).optional().describe('Only mail to or from this exact address.'),
  });
  app.openapi(createRoute({ ...meta('listSupportEmails', 'Sent or received mail, newest first: addresses, subject, status and error codes. Never bodies; read one email for its events (and its body when the customer shared content).'), path: '/v1/support/emails', request: { query: EmailQuery }, responses: { 200: response(z.object({ data: z.array(EmailSummary), nextCursor: z.string().nullable() })), ...errors } }), async c => {
    const q = c.req.valid('query'), list = scoped(c).ids, cursor = keyset(q.cursor);
    if (!list.length) return c.json({ data: [], nextCursor: null }, 200);
    const rows = q.direction === 'sent' ? (await c.env.db.execute<z.infer<typeof EmailSummary> & { at_text: string; key: string }>(sql`SELECT workspace_id AS "workspaceId", id, 'sent' AS direction, created_at::text AS at_text,
        id AS key, created_at::text AS at, from_address AS "from", to_addresses AS "to", subject, status, error_code AS "errorCode", suppression_reason AS "suppressionReason", campaign_id AS "campaignId",
        snapshot ->> 'kind' AS kind, simulated, provider_id AS "providerMessageId" FROM sending_emails
      WHERE workspace_id = ANY(${ids(list)}) AND created_at >= ${sinceOf(q.since)}::timestamptz ${q.status ? sql`AND status = ${q.status}` : sql``}
        ${q.address ? sql`AND (lower(from_address) = ${q.address} OR to_addresses ? ${q.address} OR cc_addresses ? ${q.address} OR bcc_addresses ? ${q.address})` : sql``}
        ${cursor ? sql`AND (created_at, id) < (${cursor.at}::timestamptz, ${cursor.key})` : sql``}
      ORDER BY created_at DESC, id DESC LIMIT ${q.limit + 1}`)).rows
      : (await c.env.db.execute<z.infer<typeof EmailSummary> & { at_text: string; key: string }>(sql`SELECT workspace_id AS "workspaceId", id, 'received' AS direction, received_at::text AS at_text, id AS key,
        received_at::text AS at, from_address AS "from", envelope_to AS "to", subject, status, error_code AS "errorCode", suppression_reason AS "suppressionReason", NULL AS "campaignId",
        CASE WHEN spam THEN 'spam' WHEN automated THEN 'automated' END AS kind, NULL::boolean AS simulated, ses_message_id AS "providerMessageId" FROM mail_messages
      WHERE workspace_id = ANY(${ids(list)}) AND direction = 'inbound' AND received_at >= ${sinceOf(q.since)}::timestamptz ${q.status ? sql`AND status = ${q.status}` : sql``}
        ${q.address ? sql`AND (lower(from_address) = ${q.address} OR envelope_to ? ${q.address})` : sql``}
        ${cursor ? sql`AND (received_at, id) < (${cursor.at}::timestamptz, ${cursor.key})` : sql``}
      ORDER BY received_at DESC, id DESC LIMIT ${q.limit + 1}`)).rows;
    return c.json({ data: rows.slice(0, q.limit).map(r => ({ ...strip(r), at: new Date(r.at).toISOString() })), nextCursor: nextCursor(rows, q.limit) }, 200);
  });
  const EmailDetail = EmailSummary.extend({
    events: z.array(DeliveryEvent).describe('Delivery events for a sent email, oldest first.'),
    authentication: z.record(z.string(), z.unknown()).nullable().describe('SPF, DKIM and DMARC verdicts of a received email.'),
    content: z.object({ subject: z.string(), text: z.string().nullable(), html: z.string().nullable() }).nullable().describe('The body, only when the customer shared message content with this request and the email is in that workspace (grant.contentWorkspaceId); otherwise null.'),
  }).openapi('SupportEmailDetail');
  app.openapi(createRoute({ ...meta('getSupportEmail', 'One sent or received email with its delivery events; its body only when the customer shared message content with this request.'), path: '/v1/support/emails/{id}', request: { query: WorkspaceFilter, params: z.object({ id: z.string().max(120) }) }, responses: { 200: response(EmailDetail), ...errors } }), async c => {
    const { scope, ids: list } = scoped(c), emailId = c.req.valid('param').id, db = c.env.db, shared = (workspace: SQL) => scope.contentWorkspaceId ? sql`${workspace} = ${scope.contentWorkspaceId}` : sql`false`;
    const { rows: [sent] } = await db.execute<z.infer<typeof EmailSummary> & { snapshot: { subject?: string; text?: string; html?: string } }>(sql`SELECT workspace_id AS "workspaceId", id, 'sent' AS direction,
        created_at::text AS at, from_address AS "from", to_addresses AS "to", subject, status, error_code AS "errorCode", suppression_reason AS "suppressionReason", campaign_id AS "campaignId",
        snapshot ->> 'kind' AS kind, simulated, provider_id AS "providerMessageId", CASE WHEN ${shared(sql`workspace_id`)} THEN jsonb_build_object('subject', snapshot -> 'subject', 'text', snapshot -> 'text', 'html', snapshot -> 'html') END AS snapshot
      FROM sending_emails WHERE id = ${emailId} AND workspace_id = ANY(${ids(list)})`);
    if (sent) {
      const { rows: events } = await db.execute<z.infer<typeof DeliveryEvent>>(sql`SELECT workspace_id AS "workspaceId", id, email_id AS "emailId", type, created_at::text AS at, data AS detail
        FROM sending_email_events WHERE workspace_id = ${sent.workspaceId} AND email_id = ${sent.id} ORDER BY created_at, id LIMIT 100`);
      const { snapshot, ...rest } = sent;
      return c.json({ ...rest, at: new Date(sent.at).toISOString(), events: events.map(e => ({ ...e, at: new Date(e.at).toISOString(), detail: e.detail ?? {} })), authentication: null,
        content: snapshot ? { subject: snapshot.subject ?? sent.subject, text: snapshot.text ?? null, html: snapshot.html ?? null } : null }, 200);
    }
    const { rows: [received] } = await db.execute<z.infer<typeof EmailSummary> & { verdicts: Record<string, unknown> | null; text: string | null; html: string | null }>(sql`SELECT workspace_id AS "workspaceId", id,
        'received' AS direction, received_at::text AS at, from_address AS "from", envelope_to AS "to", subject, status, error_code AS "errorCode", suppression_reason AS "suppressionReason", NULL AS "campaignId",
        CASE WHEN spam THEN 'spam' WHEN automated THEN 'automated' END AS kind, NULL::boolean AS simulated, ses_message_id AS "providerMessageId", verdicts,
        CASE WHEN ${shared(sql`workspace_id`)} THEN text END AS text, CASE WHEN ${shared(sql`workspace_id`)} THEN html END AS html, ${shared(sql`workspace_id`)} AS content_shared
      FROM mail_messages WHERE id = ${emailId} AND workspace_id = ANY(${ids(list)}) AND direction = 'inbound'`);
    if (!received) notFound('Email');
    const { verdicts, text, html, content_shared: contentShared, ...rest } = received! as typeof received & { content_shared: boolean };
    return c.json({ ...rest, at: new Date(received!.at).toISOString(), events: [], authentication: verdicts ?? null, content: contentShared ? { subject: received!.subject, text, html } : null }, 200);
  });
  app.openapi(createRoute({ ...meta('listSupportEvents', 'Delivery events of sent mail (send, delivery, bounce, complaint, reject, open, click), newest first.'), path: '/v1/support/events', request: { query: WorkspaceFilter.extend(Page.shape).extend(Since.shape).extend({
    emailId: z.string().max(120).optional(), type: z.string().max(40).optional() }) }, responses: { 200: response(z.object({ data: z.array(DeliveryEvent), nextCursor: z.string().nullable() })), ...errors } }), async c => {
    const q = c.req.valid('query'), list = scoped(c).ids, cursor = keyset(q.cursor);
    if (!list.length) return c.json({ data: [], nextCursor: null }, 200);
    const { rows } = await c.env.db.execute<z.infer<typeof DeliveryEvent> & { at_text: string; key: string }>(sql`SELECT workspace_id AS "workspaceId", id, email_id AS "emailId", type, created_at::text AS at,
        created_at::text AS at_text, id AS key, data AS detail FROM sending_email_events
      WHERE workspace_id = ANY(${ids(list)}) AND created_at >= ${sinceOf(q.since)}::timestamptz ${q.emailId ? sql`AND email_id = ${q.emailId}` : sql``} ${q.type ? sql`AND type = ${q.type}` : sql``}
        ${cursor ? sql`AND (created_at, id) < (${cursor.at}::timestamptz, ${cursor.key})` : sql``} ORDER BY created_at DESC, id DESC LIMIT ${q.limit + 1}`);
    return c.json({ data: rows.slice(0, q.limit).map(r => ({ ...strip(r), at: new Date(r.at).toISOString(), detail: r.detail ?? {} })), nextCursor: nextCursor(rows, q.limit) }, 200);
  });
  app.openapi(createRoute({ ...meta('listSupportWebhookDeliveries', 'Webhook deliveries (sending events and received mail), newest first, with attempts, the last HTTP status and error. Never payloads or URLs.'), path: '/v1/support/webhook-deliveries', request: { query: WorkspaceFilter.extend(Page.shape).extend(Since.shape).extend({
    status: z.enum(['pending', 'delivered', 'failed', 'paused']).optional(), webhookId: z.string().max(120).optional() }) }, responses: { 200: response(z.object({ data: z.array(WebhookDelivery), nextCursor: z.string().nullable() })), ...errors } }), async c => {
    const q = c.req.valid('query'), list = scoped(c).ids, cursor = keyset(q.cursor);
    if (!list.length) return c.json({ data: [], nextCursor: null }, 200);
    const filters = (t: SQL) => sql`${t}.workspace_id = ANY(${ids(list)}) AND ${t}.updated_at >= ${sinceOf(q.since)}::timestamptz ${q.status ? sql`AND ${t}.status = ${q.status}` : sql``} ${q.webhookId ? sql`AND ${t}.webhook_id = ${q.webhookId}` : sql``}`;
    const { rows } = await c.env.db.execute<z.infer<typeof WebhookDelivery> & { at_text: string; key: string; url: string | null }>(sql`SELECT * FROM (
        SELECT d.workspace_id AS "workspaceId", d.id, 'email' AS source, d.webhook_id AS "webhookId", w.url, d.payload ->> 'type' AS "eventType", d.status, d.attempt_count AS attempts,
          d.last_status_code AS "lastStatusCode", left(d.last_error, 300) AS "lastError", d.created_at::text AS "createdAt", d.updated_at::text AS "updatedAt", d.updated_at AS sort, d.updated_at::text AS at_text, d.id AS key
        FROM operation_deliveries d LEFT JOIN operation_webhooks w ON w.id = d.webhook_id WHERE ${filters(sql`d`)}
        UNION ALL SELECT d.workspace_id, d.id, 'inbound', d.webhook_id, w.url, d.payload ->> 'type', d.status, d.attempt_count, d.last_status_code, left(d.last_error, 300), d.created_at::text, d.updated_at::text,
          d.updated_at, d.updated_at::text, d.id FROM mailbox_webhook_deliveries d LEFT JOIN mailbox_webhooks w ON w.id = d.webhook_id WHERE ${filters(sql`d`)}
      ) x ${cursor ? sql`WHERE (sort, key) < (${cursor.at}::timestamptz, ${cursor.key})` : sql``} ORDER BY sort DESC, key DESC LIMIT ${q.limit + 1}`);
    return c.json({ data: rows.slice(0, q.limit).map(r => { const { url, sort: _s, ...rest } = strip(r) as typeof r & { sort?: unknown }; return { ...rest, endpoint: url ? webhookUrlHint(url) : '', createdAt: new Date(r.createdAt).toISOString(), updatedAt: new Date(r.updatedAt).toISOString() }; }),
      nextCursor: nextCursor(rows, q.limit) }, 200);
  });
  app.openapi(createRoute({ ...meta('getSupportStanding', 'Sending standing and limits per workspace: the connection and any pause with its reason, limit overrides, the sender standing where enabled, and the last 24 hours of sends by status.'), path: '/v1/support/standing', request: { query: WorkspaceFilter }, responses: { 200: response(z.object({ data: z.array(Standing) })), ...errors } }), async c =>
    c.json({ data: await standings(c.env.db, scoped(c).ids) }, 200));
  const Billing = z.object({ available: z.boolean().describe('False until billing is enabled on this installation.'), data: z.array(z.object({ workspaceId: z.string(), account: z.record(z.string(), z.unknown()).nullable(),
    ledger: z.array(z.record(z.string(), z.unknown())).describe('The latest 50 ledger entries: top-ups, usage, refunds, disputes, credits.') })) }).openapi('SupportBilling');
  app.openapi(createRoute({ ...meta('getSupportBilling', 'Balance, payments and the billing ledger of the workspaces the customer owns or administers.'), path: '/v1/support/billing', request: { query: WorkspaceFilter }, responses: { 200: response(Billing), ...errors } }), async c => {
    const list = scoped(c, ['owner', 'admin']).ids, db = c.env.db;
    // TODO(billing): the ledger tables come with the billing build (plans/billing-build-spec.md); read through to_jsonb so their exact columns don't matter here.
    const { rows: [tables] } = await db.execute<{ accounts: boolean; ledger: boolean }>(sql`SELECT to_regclass('billing_accounts') IS NOT NULL AS accounts, to_regclass('billing_transactions') IS NOT NULL AS ledger`);
    if (!tables?.ledger || !list.length) return c.json({ available: !!tables?.ledger, data: [] }, 200);
    const { rows } = await db.execute<{ workspaceId: string; account: Record<string, unknown> | null; ledger: Record<string, unknown>[] }>(sql`SELECT w.id AS "workspaceId",
      ${tables.accounts ? sql`(SELECT to_jsonb(a) - 'stripe_customer' - 'reload_payment_method' FROM billing_accounts a WHERE a.workspace_id = w.id)` : sql`NULL::jsonb`} AS account,
      coalesce((SELECT jsonb_agg(to_jsonb(b) - 'workspace_id') FROM (SELECT * FROM billing_transactions b WHERE b.workspace_id = w.id ORDER BY b.id DESC LIMIT 50) b), '[]') AS ledger
      FROM workspaces w WHERE w.id = ANY(${ids(list)})`);
    return c.json({ available: true, data: rows }, 200);
  });
  app.openapi(createRoute({ ...meta('listSupportAudit', 'The audit trail the customer sees in Settings → Activity (who changed what, when, from where), for the workspaces they own or administer. Filter by time, action or actor; newest first.'), path: '/v1/support/audit', request: { query: WorkspaceFilter.extend(AuditFilters.shape) }, responses: { 200: response(z.object({ data: z.array(AuditEntry), nextCursor: z.string().nullable() })), ...errors } }), async c => {
    const { workspaceId: _w, ...filters } = c.req.valid('query');
    return c.json(await customerTrail(c.env.db, scoped(c, ['owner', 'admin']).ids, filters), 200);
  });
  const RequestTrace = z.object({
    requestId: z.string(), found: z.boolean().describe('Whether Bane stored anything about this request for this customer.'),
    auditEvents: z.array(AuditEntry).describe('Changes the request made.'),
    campaigns: z.array(z.object({ workspaceId: z.string(), id: z.string(), name: z.string(), state: z.string(), error: z.unknown().nullable() })).describe('Campaign launches the request started.'),
    routingVersions: z.array(z.object({ workspaceId: z.string(), version: z.number(), resourceId: z.string(), at: z.string() })).describe('Routing versions the request wrote.'),
    note: z.string(),
  }).openapi('SupportRequestTrace');
  app.openapi(createRoute({ ...meta('getSupportRequest', 'What Bane recorded for one API request (the x-request-id a customer quotes): the changes it made, campaign launches and routing versions. Requests that changed nothing leave no database record.'), path: '/v1/support/requests/{requestId}', request: { query: WorkspaceFilter, params: z.object({ requestId: z.string().regex(/^req_[0-9a-f]{32}$/) }) }, responses: { 200: response(RequestTrace), ...errors } }), async c => {
    const { scope, ids: list } = scoped(c), requestId = c.req.valid('param').requestId, db = c.env.db;
    // DB-side only. TODO(request logs): when request logging lands in the database, add route, status and error code here.
    const auditEvents = (await customerTrail(db, list, AuditFilters.parse({ requestId, limit: 20 }))).data;
    const { rows: campaigns } = list.length ? await db.execute<{ workspaceId: string; id: string; name: string; state: string; error: unknown }>(sql`SELECT workspace_id AS "workspaceId", id, coalesce(draft ->> 'name', id) AS name, state, error
      FROM sending_campaigns WHERE request_id = ${requestId} AND workspace_id = ANY(${ids(list)}) LIMIT 20`) : { rows: [] };
    const { rows: routing } = list.length ? await db.execute<{ workspaceId: string; version: number; resourceId: string; at: string }>(sql`SELECT workspace_id AS "workspaceId", version, resource_id AS "resourceId", created_at::text AS at
      FROM mail_routing_audit WHERE request_id = ${requestId} AND workspace_id = ANY(${ids(list)}) LIMIT 50`) : { rows: [] };
    const found = !!(auditEvents.length || campaigns.length || routing.length);
    return c.json({ requestId, found, auditEvents, campaigns, routingVersions: routing.map(r => ({ ...r, at: new Date(r.at).toISOString() })),
      note: found ? 'Changes recorded for this request.' : 'Nothing recorded: the request changed nothing, belongs to another account, or is older than the retention window. Ask for the time, the route and the error code shown.' }, 200);
  });
}
