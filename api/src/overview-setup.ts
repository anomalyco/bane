// GET /v1/overview/setup: what Overview's setup steps and next steps read, in one request instead of five (domains,
// API keys, any email, webhooks and invitations).
//
// Each section is answered exactly when its own endpoint would answer this caller: the same notMember path guard
// (memberRefused) and the same handler guard. A section the caller couldn't read there is null here. Beyond listDomains'
// own view, the sections are counts, so no webhook URL, key prefix, address or subject leaves through this route.
//
// Database budget after authentication, whatever the workspace holds, one statement at a time:
//   hosted: 2 (the domain page, then one statement with every count);
//   self-hosted: 4 (region settings, the domain page and its cached SES reports, then the counts).
import { createRoute, z } from '@hono/zod-openapi';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { manageKeys } from './auth.js';
import { actor, admits, dashboardSession, errors, memberRefused, response, security, type App } from './core.js';
import { apiKeys } from './db/core.js';
import { webhooks } from './db/operations.js';
import { emails } from './db/sending.js';
import { workspaceInvitations } from './db/workspaces.js';
import { DomainPage, domainPage, domainReader, workspaceActor } from './operations.js';
import { mailWhere } from './sending.js';
import { withRegionSettings } from './ses-region-state.js';

const Setup = z.object({
  domains: DomainPage.nullable().describe('The ten newest domains, exactly as listDomains with limit=10 and refresh=false returns them (continue there with nextCursor). Null when listDomains would refuse the caller, such as a member or a self-hosted installation without live SES.'),
  apiKeys: z.object({ active: z.number().int().describe('Unrevoked API keys.') }).nullable().describe('Null when listApiKeys would refuse the caller: it needs unrestricted manage, and agent tokens never list keys.'),
  emails: z.object({ any: z.boolean().describe('Whether any email the caller can read exists. Same scope as listEmails: a domain-restricted key sees only direct sends from its domains.') }),
  webhooks: z.object({ total: z.number().int().describe('Outbound webhooks, paused ones included.') }).nullable().describe('Null when listWebhooks would refuse the caller: members and domain-restricted keys.'),
  invitations: z.object({ pending: z.number().int().describe('Pending, unexpired invitations.') }).nullable().describe('Null unless listWorkspaceInvitations would answer: an owner or admin dashboard session on a hosted installation.'),
}).openapi('OverviewSetup');
type Counts = { api_keys: number | null; any_email: boolean; webhooks: number | null; invitations: number | null };

export function registerOverviewSetup(app: App) {
  app.openapi(createRoute({ method: 'get', path: '/v1/overview/setup', operationId: 'getOverviewSetup', tags: ['Settings'], security,
    summary: 'What this workspace has set up, in one read',
    description: 'The newest domains, the number of active API keys, outbound webhooks and pending invitations, and whether any email exists. Each part follows the permission rules of its own list operation and is null where that operation would refuse the caller. Counts only: no webhook URL, key, address or subject.',
    responses: { 200: response(Setup), ...errors } }), async c => {
    const a = actor(c), w = a.workspaceId;
    const readable = (path: string, guard: () => unknown) => !memberRefused(a, 'GET', path) && admits(guard);
    const keys = readable('/v1/api-keys', () => manageKeys(c)), hooks = readable('/v1/webhooks', () => workspaceActor(c)), invites = readable('/v1/workspaces/current/invitations', () => dashboardSession(c, true));
    let domains: z.infer<typeof DomainPage> | null = null;
    if (!memberRefused(a, 'GET', '/v1/domains')) {
      // listDomains loads self-hosted region settings before its own guard (app.ts); hosted reads need none without a region.
      if (!c.env.config.multiTenant) c.env = await withRegionSettings(c.env, w);
      if (admits(() => domainReader(c))) domains = await domainPage(c, a, { limit: 10, refresh: 'false' });
    }
    const row = (await c.env.db.execute<Counts>(sql`/* overview-setup: counts */ SELECT
      ${keys ? sql`(SELECT count(*)::int FROM ${apiKeys} WHERE ${and(eq(apiKeys.workspaceId, w), isNull(apiKeys.revokedAt))})` : sql`NULL::int`} AS api_keys,
      EXISTS (SELECT FROM ${emails} WHERE ${mailWhere(a)}) AS any_email,
      ${hooks ? sql`(SELECT count(*)::int FROM ${webhooks} WHERE ${eq(webhooks.workspaceId, w)})` : sql`NULL::int`} AS webhooks,
      ${invites ? sql`(SELECT count(*)::int FROM ${workspaceInvitations} WHERE ${and(eq(workspaceInvitations.workspaceId, w), eq(workspaceInvitations.status, 'pending'), gt(workspaceInvitations.expiresAt, sql`now()`))})` : sql`NULL::int`} AS invitations`)).rows[0]!;
    return c.json({ domains, apiKeys: row.api_keys === null ? null : { active: row.api_keys }, emails: { any: row.any_email },
      webhooks: row.webhooks === null ? null : { total: row.webhooks }, invitations: row.invitations === null ? null : { pending: row.invitations } }, 200);
  });
}
