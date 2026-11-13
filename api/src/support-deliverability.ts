import { createRoute, z } from '@hono/zod-openapi';
import { sql, type SQL } from 'drizzle-orm';
import { ApiError, errors, notFound, response, type App, type Ctx, type DbExecutor } from './core.js';
import { cachedDashboardRead } from './dashboard-cache.js';
import * as d from './deliverability.js';
import type { CampaignDraft } from './db/sending.js';

// The support grant's deliverability reads (support-agent-design §5.2): GET only, behind supportGate (each costs 5 of the
// grant's 120 a minute, see supportWeight), x-internal like every /v1/support route. Each handler is one read-only
// transaction with a 3-second statement timeout (budgetedRead) over the indexes listed in src/deliverability.ts, and its
// result is cached 60 seconds per workspace, route and parameters, stamped computedAt. Windows are at most 30 days
// (hourly at most 72 hours); at most 20 groups plus other and 50 rows. Recipients appear as domains and providers only,
// diagnostics are redacted, and message content only in the workspace whose content the customer shared.

type Meta = (operationId: string, description: string) => { method: 'get'; operationId: string; tags: string[]; security: Record<string, string[]>[]; description: string };
const DAY = d.DAY_MS, HOUR = d.HOUR_MS;

/** The one workspace an aggregate reads: the workspaceId filter, or the grant's only workspace. */
function oneWorkspace(c: Ctx) {
  const scope = c.get('support')!, filter = c.req.query('workspaceId');
  const list = filter ? scope.workspaces.filter(w => w.id === filter) : scope.workspaces;
  if (list.length !== 1) throw new ApiError(422, 'WORKSPACE_REQUIRED', `This grant covers ${list.length} workspaces; aggregates read one. Pass workspaceId (see GET /v1/support/workspaces).`, 'workspaceId');
  return { workspaceId: list[0]!.id };
}
const narrowed = (c: Ctx) => { const scope = c.get('support')!, filter = c.req.query('workspaceId'); return scope.workspaces.filter(w => !filter || w.id === filter).map(w => w.id); };
const ids = (list: string[]) => sql`${sql.param(list)}::text[]`;
/**
 * 60 seconds per (workspace, route, parameters) in the dashboard cache; the result says when it was computed. A read by
 * ID is keyed by the workspaces the grant narrows to, and every read that may hold content by whether it may.
 */
export async function cached<T extends object>(c: Ctx, route: string, workspace: string | string[], params: unknown, compute: () => Promise<T>) {
  const { value } = await cachedDashboardRead(new URL(c.req.url).origin, JSON.stringify(['support', route, workspace, params]),
    async () => ({ computedAt: new Date().toISOString(), ...await compute() }), 60);
  return value;
}
/** The window a read covers: defaults end at the next whole minute, so repeated reads share the cache. */
function windowOf(q: { since?: string; until?: string }, granularity: 'day' | 'hour', defaultSpan: number, maxSpan: number) {
  const now = Date.now(), until = q.until ? Date.parse(q.until) : Math.ceil(now / 60_000) * 60_000, since = q.since ? Date.parse(q.since) : until - defaultSpan;
  if (since >= until) throw new ApiError(422, 'INVALID_DATE_RANGE', 'since must be before until.', 'since');
  if (until - since > maxSpan + 60_000) throw new ApiError(422, 'WINDOW_TOO_LONG', granularity === 'hour' ? 'Hourly reads cover at most 72 hours.' : `This read covers at most ${Math.round(maxSpan / DAY)} days.`, 'since');
  if (since < now - (d.LIMITS.windowDays + 1) * DAY) throw new ApiError(422, 'WINDOW_TOO_OLD', 'Mail and its events are kept 30 days. Daily totals before that are in GET /v1/support/standing (history).', 'since');
  return { since: new Date(since).toISOString(), until: new Date(until).toISOString() };
}
const Domain = z.string().trim().toLowerCase().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/, 'A domain name such as example.com.');
const Since = (days: number) => ({ since: z.iso.datetime().optional().describe(`Window start (default: ${days} days before until). At most 30 days back.`), until: z.iso.datetime().optional().describe('Window end (default: now).') });

export function registerSupportDeliverability(app: App, meta: Meta, WorkspaceFilter: z.ZodObject<{ workspaceId: z.ZodOptional<z.ZodString> }>) {
  const Severity = z.enum(['info', 'notice', 'serious', 'critical']);
  const Finding = z.object({ severity: Severity, code: z.string(), message: z.string().describe('Plain words with the numbers; the usual cause and fix.'), scope: z.string().nullable().describe('The provider, domain, campaign or list it is about, or null for the whole read.'),
    evidence: z.record(z.string(), z.number()).describe('The numbers behind it: counts, rates as fractions, thresholds.') }).openapi('SupportFinding');
  const Findings = z.array(Finding).describe('Heuristics computed from this read, most severe first (support-agent-design §5.3). Weigh them; they are not verdicts.');
  const Rate = z.object({ numerator: z.number(), denominator: z.number(), value: z.number().nullable().describe('A fraction; null when the denominator is zero.') }).openapi('SupportRate');
  const countShape = {
    emails: z.number().describe('Real emails created (simulated mail is counted apart).'), accepted: z.number().describe('Accepted by the provider (SES).'), delivered: z.number(), hardBounced: z.number(),
    softBounced: z.number().describe('Delayed or soft-bounced at least once.'), complained: z.number(), opened: z.number().describe('Opened at least once, bots and privacy proxies included.'),
    openedHuman: z.number().describe('Opened with an open SES did not flag as a bot.'), clicked: z.number(), screenRejected: z.number().describe('Refused by the content screen.'), suppressed: z.number(), simulated: z.number(),
  };
  const Rates = z.object({ delivery: Rate.describe('delivered / accepted'), bounce: Rate.describe('hardBounced / accepted'), complaint: Rate.describe('complained / accepted'),
    open: Rate.describe('opened / delivered; null when nothing was tracked'), openHuman: Rate.describe('openedHuman / delivered'), click: Rate.describe('clicked / delivered') }).openapi('SupportRates');
  const Bucket = z.object({ at: z.string().describe('UTC day (YYYY-MM-DD) or hour (ISO).'), ...countShape });

  // ---------- 1. metrics ----------
  const Metrics = z.object({
    workspaceId: z.string(), computedAt: z.string(), window: z.object({ since: z.string(), until: z.string(), granularity: z.enum(['day', 'hour']) }),
    groupBy: z.enum(['none', 'campaign', 'from_domain', 'provider', 'stream']), stream: z.enum(['all', 'transactional', 'marketing']), filters: z.object({ campaignId: z.string().nullable(), fromDomain: z.string().nullable() }),
    totals: z.object({ ...countShape, unsubscribed: z.number().describe('Recipient unsubscribes (footer, one-click, SES) in the window, for the whole workspace: stream, campaignId and fromDomain do not narrow them.'), rates: Rates }),
    buckets: z.array(Bucket.extend({ unsubscribed: z.number() })).describe('Every bucket with mail, oldest first: the volume per day or hour.'),
    groups: z.array(z.object({ key: z.string().describe('Campaign ID ("" for mail outside campaigns), From domain, provider or recipient domain, or stream.'), other: z.boolean().describe('The groups beyond the largest 20, summed.'),
      provider: z.enum(d.PROVIDER_NAMES).nullable(), ...countShape, rates: Rates, buckets: z.array(Bucket) })).nullable().describe('Null when groupBy=none.'),
    screen: z.object({ screened: z.number(), rejected: z.number() }).describe('What the Hosted content screen judged in the window, for the whole workspace (not narrowed by the filters).'),
    findings: Findings,
  }).openapi('SupportDeliveryMetrics');
  app.openapi(createRoute({ ...meta('getSupportDeliveryMetrics', 'Delivery, bounce, complaint, open and click counts per day or hour over at most 30 days, optionally per campaign, From domain, recipient provider or stream, each rate with its numerator and denominator, plus findings. Created-cohort: an email counts in the bucket it was created in.'),
    path: '/v1/support/deliverability/metrics', request: { query: WorkspaceFilter.extend({ ...Since(14),
      granularity: z.enum(['day', 'hour']).default('day').describe('hour: at most 72 hours.'), groupBy: z.enum(['none', 'campaign', 'from_domain', 'provider', 'stream']).default('none'),
      stream: z.enum(['all', 'transactional', 'marketing']).default('all'), campaignId: z.string().max(120).optional(), fromDomain: Domain.optional() }) }, responses: { 200: response(Metrics), ...errors } }), async c => {
    const q = c.req.valid('query'), { workspaceId } = oneWorkspace(c);
    const w = windowOf(q, q.granularity, q.granularity === 'hour' ? 48 * HOUR : 14 * DAY, q.granularity === 'hour' ? d.LIMITS.hourlyHours * HOUR : d.LIMITS.windowDays * DAY);
    const params = { ...w, granularity: q.granularity, groupBy: q.groupBy, stream: q.stream, campaignId: q.campaignId, fromDomain: q.fromDomain };
    return c.json(await cached(c, 'metrics', workspaceId, params, async () => ({ workspaceId, window: { ...w, granularity: q.granularity }, groupBy: q.groupBy, stream: q.stream,
      filters: { campaignId: q.campaignId ?? null, fromDomain: q.fromDomain ?? null }, ...await d.budgetedRead(c.env.db, tx => d.deliveryMetrics(tx, workspaceId, params)) })), 200);
  });

  // ---------- 2. bounces ----------
  const Bounces = z.object({
    workspaceId: z.string(), computedAt: z.string(), window: z.object({ since: z.string(), until: z.string() }),
    groups: z.array(z.object({ provider: z.enum(d.PROVIDER_NAMES), domain: z.string().nullable().describe('The recipient domain when the provider is other.'),
      class: z.enum(['bounce', 'soft_bounce', 'deferral', 'complaint']), subtype: z.string().describe('Bounce type/subtype (Permanent/General, Transient/MailboxFull…), delay type, or complaint feedback type.'),
      status: z.string().nullable().describe('Enhanced status code (5.1.1, 5.7.26, 4.7.0…) when the event recorded one.'), diagnostic: z.string().nullable().describe('The redacted diagnostic (addresses are <address>, IPs <ip>), 160 characters.'),
      count: z.number(), firstSeen: z.string(), lastSeen: z.string(), campaigns: z.array(z.string()).describe('Up to 3 campaigns with most of these.') })).describe('At most 50 groups, largest first.'),
    other: z.object({ groups: z.number(), count: z.number() }).nullable().describe('What the 50 groups leave out.'),
    complaints: z.array(z.object({ feedbackType: z.string(), count: z.number() })),
    firstSend: Rate.extend({ basis: z.string() }).describe('Hard bounces of first sends: a bad import stands out here.'),
    findings: Findings,
  }).openapi('SupportBounceReasons');
  app.openapi(createRoute({ ...meta('getSupportBounceReasons', 'Bounces, deferrals and complaints over at most 30 days, grouped by recipient provider, then type and subtype, enhanced status and redacted diagnostic, with first and last seen and the campaigns behind them; complaints by feedback type; the first-send bounce rate; findings.'),
    path: '/v1/support/deliverability/bounces', request: { query: WorkspaceFilter.extend({ ...Since(14), provider: z.enum(d.PROVIDER_NAMES).optional(), campaignId: z.string().max(120).optional(), fromDomain: Domain.optional(),
      type: z.enum(['bounce', 'deferral', 'complaint']).optional().describe('Default: all three.') }) }, responses: { 200: response(Bounces), ...errors } }), async c => {
    const q = c.req.valid('query'), { workspaceId } = oneWorkspace(c), w = windowOf(q, 'day', 14 * DAY, d.LIMITS.windowDays * DAY);
    const params = { ...w, provider: q.provider, campaignId: q.campaignId, fromDomain: q.fromDomain, type: q.type };
    return c.json(await cached(c, 'bounces', workspaceId, params, async () => ({ workspaceId, window: w, ...await d.budgetedRead(c.env.db, tx => d.bounceReasons(tx, workspaceId, params)) })), 200);
  });

  // ---------- 3. domain health ----------
  const Spf = z.object({ record: z.string().nullable(), records: z.number().describe('More than one SPF record is a permerror.'), includesAmazonSes: z.boolean(), lookups: z.number().describe('DNS-querying terms in the record itself (receivers allow 10 in all).'), all: z.string().nullable().describe('-all, ~all, ?all…') });
  const DomainHealth = z.object({
    workspaceId: z.string(), computedAt: z.string(), domain: z.object({ id: z.string(), name: z.string(), region: z.string().nullable(), createdAt: z.string().nullable() }),
    claim: z.object({ sending: z.string().nullable(), dkim: z.string().nullable(), dkimSigning: z.boolean(), mailFrom: z.object({ domain: z.string().nullable(), status: z.string().nullable() }),
      dmarc: z.object({ status: z.string().nullable(), record: z.string().nullable(), source: z.string().nullable(), checkedAt: z.string().nullable() }), receiving: z.string().nullable(), lostSince: z.string().nullable(),
      connection: z.object({ kind: z.string(), region: z.string() }).nullable().describe('shared (Bane Hosted pool) or byo.') }).describe('What Bane stored at the last verification.'),
    dns: z.object({ checkedAt: z.string(), complete: z.boolean().describe('False when a lookup did not answer within the 3-second budget.'), spf: Spf,
      dmarc: z.object({ record: z.string().nullable(), source: z.enum(['live', 'stored']).nullable().describe('stored: the exact label had none; this is the last verification’s record (it may be the organizational domain’s).'), at: z.string().nullable(),
        p: z.string().nullable(), sp: z.string().nullable(), pct: z.number().nullable(), adkim: z.string(), aspf: z.string(), rua: z.boolean(), ruf: z.boolean(), valid: z.boolean() }),
      bimi: z.object({ record: z.string().nullable(), logo: z.boolean().describe('l= present'), authority: z.boolean().describe('a= present (VMC or CMC)') }),
      mailFrom: z.object({ domain: z.string(), mx: z.array(z.string()), mxExpected: z.string(), spf: Spf }).nullable() }).describe('One live read of public DNS (5 labels, 3 seconds, cached 5 minutes).'),
    alignment: z.object({ dkim: z.boolean().describe('DKIM d= is the From domain (SES Easy DKIM verified and signing).'), spf: z.boolean().describe('The Return-Path (verified MAIL FROM) shares the From domain’s organizational domain.'),
      dmarcPasses: z.boolean(), verdict: z.enum(['aligned', 'dkim_only', 'spf_only', 'unaligned']), returnPath: z.string() }),
    volume: z.object({ days: z.array(z.object({ at: z.string(), emails: z.number(), accepted: z.number(), campaign: z.number() })).describe('Days with mail in the last 30, oldest first.'),
      firstSendAt: z.string().nullable().describe('The first send kept (30 days): the warm-up age, unless olderThanRetention.'), olderThanRetention: z.boolean(), warmupAgeDays: z.number().nullable(),
      peakDaily: z.number(), medianDaily: z.number(), peakToMedian: z.number().nullable() }),
    streams: z.object({ emails: z.number(), campaign: z.number(), marketingApi: z.number().describe('kind=marketing sends through the API.'), marketingShare: Rate,
      listUnsubscribe: z.string().describe('How marketing from this domain gets List-Unsubscribe.'),
      bulkLikeTransactional: z.array(z.object({ day: z.string(), subject: z.string(), emails: z.number() })).describe('One subject to more than 500 recipients a day outside campaigns.') }),
    findings: Findings,
  }).openapi('SupportDomainHealth');
  app.openapi(createRoute({ ...meta('getSupportDomainHealth', 'One sending domain’s health: the stored verification, one live DNS read (SPF, DMARC, BIMI, the MAIL FROM’s MX and SPF), the DMARC alignment verdict, 30 days of volume and warm-up age, the marketing share and bulk-looking transactional mail, and findings.'),
    path: '/v1/support/domains/{id}/health', request: { query: WorkspaceFilter, params: z.object({ id: z.string().max(120) }) }, responses: { 200: response(DomainHealth), ...errors } }), async c => {
    const domainId = c.req.valid('param').id, list = narrowed(c);
    if (!list.length) notFound('Domain');
    const { rows: [row] } = await c.env.db.execute<d.DomainRow>(sql`SELECT d.id, d.workspace_id, d.name, d.region, d.created_at::text, to_jsonb(dc) AS claim,
        (SELECT json_build_object('kind', pc.kind, 'region', pc.region) FROM provider_connections pc WHERE pc.workspace_id = d.workspace_id) AS connection
      FROM operation_domains d LEFT JOIN domain_claims dc ON dc.workspace_id = d.workspace_id AND dc.name = d.name WHERE d.id = ${domainId} AND d.workspace_id = ANY(${ids(list)})`);
    if (!row) notFound('Domain');
    const r = row!, name = r.name.toLowerCase();
    return c.json(await cached(c, 'domain-health', r.workspace_id, { id: r.id }, async () => {
      const identity = (r.claim?.identity ?? {}) as { ses?: { DkimAttributes?: { Status?: string; SigningEnabled?: boolean }; MailFromAttributes?: { MailFromDomain?: string; MailFromDomainStatus?: string } };
        dmarc?: { status?: string; record?: string | null; source?: string | null; checkedAt?: number; aspf?: string } | null };
      const ses = identity.ses ?? {}, stored = identity.dmarc ?? null, mailFromDomain = ses.MailFromAttributes?.MailFromDomain?.toLowerCase() ?? null;
      const activity = await d.budgetedRead(c.env.db, tx => d.domainActivity(tx, r.workspace_id, name));
      const region = r.region ?? r.connection?.region ?? c.env.config.regions[0]!;
      const dns = await d.liveDns(name, mailFromDomain ? { domain: mailFromDomain, region } : null, stored ? { record: stored.record ?? null, checkedAt: stored.checkedAt ?? null } : null);
      const align = await d.alignment(name, { dkim: ses.DkimAttributes?.Status ?? null, signing: ses.DkimAttributes?.SigningEnabled === true, mailFrom: mailFromDomain, mailFromStatus: ses.MailFromAttributes?.MailFromDomainStatus ?? null }, dns.dmarc.aspf);
      const daily = activity.days.map(x => x.accepted).sort((a, b) => a - b), median = daily.length ? daily[Math.floor(daily.length / 2)]! : 0, peak = daily.at(-1) ?? 0;
      const first = activity.firstSendAt ? Date.parse(activity.firstSendAt) : null, olderThanRetention = first !== null && first < Date.now() - (d.LIMITS.windowDays - 1) * DAY;
      const ageDays = first !== null && !olderThanRetention ? Math.floor((Date.now() - first) / DAY) : null;
      const emails = activity.days.reduce((s, x) => s + x.emails, 0), campaign = activity.days.reduce((s, x) => s + x.campaign, 0);
      return { workspaceId: r.workspace_id,
        domain: { id: r.id, name: r.name, region: r.region, createdAt: r.created_at ? new Date(r.created_at).toISOString() : null },
        claim: { sending: (r.claim?.sending_state as string | undefined) ?? null, dkim: ses.DkimAttributes?.Status ?? null, dkimSigning: ses.DkimAttributes?.SigningEnabled === true,
          mailFrom: { domain: mailFromDomain, status: ses.MailFromAttributes?.MailFromDomainStatus ?? null },
          dmarc: { status: stored?.status ?? null, record: stored?.record?.slice(0, 500) ?? null, source: stored?.source ?? null, checkedAt: stored?.checkedAt ? new Date(stored.checkedAt).toISOString() : null },
          receiving: (r.claim?.receiving_state as string | undefined) ?? null, lostSince: (r.claim?.lost_since as string | undefined) ? new Date(r.claim!.lost_since as string).toISOString() : null, connection: r.connection },
        dns, alignment: align,
        volume: { days: activity.days, firstSendAt: activity.firstSendAt, olderThanRetention, warmupAgeDays: ageDays, peakDaily: peak, medianDaily: median, peakToMedian: median ? Math.round(peak / median * 10) / 10 : null },
        streams: { emails, campaign, marketingApi: activity.marketingApi, marketingShare: d.rate(campaign + activity.marketingApi, emails),
          listUnsubscribe: 'Bane adds List-Unsubscribe and List-Unsubscribe-Post (one-click) to every campaign email and every kind=marketing send; transactional sends carry none.', bulkLikeTransactional: activity.bulk },
        findings: d.domainFindings(name, { dns, align, days: activity.days, ageDays, bulk: activity.bulk, marketingApi: activity.marketingApi }),
      };
    }), 200);
  });

  // ---------- 4. screen ----------
  const Screen = z.object({
    workspaceId: z.string(), computedAt: z.string(), since: z.string(),
    hours: z.array(z.object({ at: z.string(), screened: z.number(), rejected: z.number() })).describe('Hours the Hosted content screen judged mail in.'),
    totals: z.object({ screened: z.number(), rejected: z.number(), rate: Rate }), byCode: z.record(z.string(), z.number()).describe('Among the rejections listed.'),
    rejections: z.array(z.object({ emailId: z.string(), campaignId: z.string().nullable(), at: z.string(), subject: z.string().describe('120 characters.'),
      errorCode: z.string().describe('CONTENT_REJECTED_SPAM, CONTENT_IMAGE_ONLY, CONTENT_TOO_LARGE_TO_SCREEN, ATTACHMENT_TYPE_UNSCREENABLE, ATTACHMENT_CONTENT_MISMATCH.'),
      spamScore: z.number().nullable().describe('The classifier’s spam probability, for CONTENT_REJECTED_SPAM.'), model: z.string().nullable() })).describe('The last 50, newest first.'),
  }).openapi('SupportScreen');
  app.openapi(createRoute({ ...meta('getSupportScreen', 'The Hosted content screen over at most 7 days: hourly screened and rejected counts, and the last 50 rejections with subject, error code and spam score. Never bodies.'),
    path: '/v1/support/screen', request: { query: WorkspaceFilter.extend({ since: z.iso.datetime().optional().describe('Default and limit: 7 days ago.') }) }, responses: { 200: response(Screen), ...errors } }), async c => {
    const q = c.req.valid('query'), { workspaceId } = oneWorkspace(c), w = windowOf({ since: q.since }, 'day', 7 * DAY, 7 * DAY);
    return c.json(await cached(c, 'screen', workspaceId, w.since, async () => ({ workspaceId, since: w.since, ...await d.budgetedRead(c.env.db, tx => d.screenActivity(tx, workspaceId, w.since)) })), 200);
  });

  // ---------- 5. campaigns ----------
  const Stats = z.object({ counts: z.object({ total: z.number(), byStatus: z.record(z.string(), z.number()) }), totals: z.record(z.string(), z.number()),
    rates: z.object({ delivery: Rate, bounce: Rate, complaint: Rate, open: Rate, click: Rate }) }).describe('Lifetime statistics, as GET /v1/campaigns/{id}/stats computes them.');
  const CampaignSummary = z.object({
    id: z.string(), name: z.string(), state: z.string(), createdAt: z.string(), launchedAt: z.string().nullable(), scheduledAt: z.string().nullable(), stream: z.literal('marketing'),
    audience: z.object({ listId: z.string().nullable(), listName: z.string().nullable(), segmentId: z.string().nullable(), segmentName: z.string().nullable(),
      size: z.number().nullable().describe('Recipients frozen at launch, or the list’s current members for a draft.') }),
    tracking: z.boolean(), from: z.string().nullable(), fromName: z.string().nullable(), replyTo: z.array(z.string()), subject: z.string().nullable().describe('120 characters.'), previewTextLength: z.number(),
    pauseReason: z.object({ code: z.string(), message: z.string() }).nullable(), waiting: z.object({ reason: z.string(), until: z.string() }).nullable(), quarantines: z.number(), stats: Stats,
  }).openapi('SupportCampaign');
  const CampaignDetail = CampaignSummary.extend({ workspaceId: z.string(), computedAt: z.string(),
    pacing: z.array(z.object({ at: z.string(), emails: z.number() })).describe('Emails materialized per hour, the last 72 hours with any.'),
    content: z.object({ html: z.string().nullable(), previewText: z.string().nullable(), sourceTemplateId: z.string().nullable() }).nullable().describe('The draft’s block HTML, only when the customer shared message content in this workspace (grant.contentWorkspaceId); otherwise null.'),
  }).openapi('SupportCampaignDetail');
  type Row = { id: string; workspace_id: string; draft: CampaignDraft; state: string; created_at: string; launched_at: string | null; scheduled_at: string | null; total: number; pause_reason: { code: string; message: string } | null;
    waiting_reason: string | null; waiting_until: string | null; quarantines: number; review_id: string | null; list_name: string | null; segment_name: string | null; list_size: number | null; source_template_id: string | null };
  const campaignRows = (db: DbExecutor, where: SQL, limit: number) => db.execute<Row>(sql`SELECT p.id, p.workspace_id, p.draft, p.state, p.created_at::text, r.created_at::text AS launched_at, p.scheduled_at::text,
      p.total, p.pause_reason, p.waiting_reason, p.waiting_until::text, p.quarantines, p.review_id, p.source_template_id,
      (SELECT name FROM audience_lists l WHERE l.workspace_id = p.workspace_id AND l.id = p.draft #>> '{audience,listId}') AS list_name,
      (SELECT name FROM audience_segments s WHERE s.workspace_id = p.workspace_id AND s.id = p.draft #>> '{audience,segmentId}') AS segment_name,
      CASE WHEN p.review_id IS NULL THEN (SELECT count(*)::int FROM audience_list_members m WHERE m.workspace_id = p.workspace_id AND m.list_id = p.draft #>> '{audience,listId}') END AS list_size
    FROM sending_campaigns p LEFT JOIN sending_campaign_reviews r ON r.workspace_id = p.workspace_id AND r.id = p.review_id WHERE ${where} ORDER BY p.created_at DESC, p.id DESC LIMIT ${limit}`);
  const summary = (row: Row, stats: { counts: unknown; totals: unknown; rates: unknown } | undefined) => ({
    id: row.id, name: row.draft.name, state: row.state, createdAt: new Date(row.created_at).toISOString(), launchedAt: row.launched_at ? new Date(row.launched_at).toISOString() : null,
    scheduledAt: row.scheduled_at ? new Date(row.scheduled_at).toISOString() : null, stream: 'marketing' as const,
    audience: { listId: row.draft.audience?.listId ?? null, listName: row.list_name, segmentId: row.draft.audience?.segmentId ?? null, segmentName: row.segment_name, size: row.review_id ? row.total : row.list_size },
    tracking: !!row.draft.tracking, from: row.draft.from || null, fromName: row.draft.fromName ?? null, replyTo: row.draft.replyTo ?? [], subject: row.draft.subject ? row.draft.subject.slice(0, d.LIMITS.subject) : null,
    previewTextLength: [...(row.draft.previewText ?? '')].length, pauseReason: row.pause_reason ? { code: row.pause_reason.code, message: row.pause_reason.message.slice(0, 300) } : null,
    waiting: row.waiting_reason && row.waiting_until ? { reason: row.waiting_reason, until: new Date(row.waiting_until).toISOString() } : null, quarantines: row.quarantines,
    stats: { counts: stats?.counts, totals: stats?.totals, rates: stats?.rates } as z.infer<typeof Stats>,
  });
  const statsOf = async (db: DbExecutor, wid: string, rows: Row[]) => {
    const { campaignStats } = await import('./sending.js');
    const full = await db.select().from((await import('./db/sending.js')).campaigns).where(sql`workspace_id = ${wid} AND id = ANY(${ids(rows.map(r => r.id))})`);
    return campaignStats(db, { workspaceId: wid }, full);
  };
  app.openapi(createRoute({ ...meta('listSupportCampaigns', 'Recent campaigns, newest first: state, audience and size, tracking, sender, subject, pause reason and lifetime statistics. Never content.'),
    path: '/v1/support/campaigns', request: { query: WorkspaceFilter.extend({ since: z.iso.datetime().optional().describe('Created at or after (default: 30 days ago).'), state: z.string().max(40).optional(),
      limit: z.coerce.number().int().min(1).max(d.LIMITS.rows).default(20) }) }, responses: { 200: response(z.object({ workspaceId: z.string(), computedAt: z.string(), data: z.array(CampaignSummary) })), ...errors } }), async c => {
    const q = c.req.valid('query'), { workspaceId } = oneWorkspace(c), since = q.since ?? new Date(Math.ceil(Date.now() / 60_000) * 60_000 - 30 * DAY).toISOString();
    return c.json(await cached(c, 'campaigns', workspaceId, [since, q.state, q.limit], () => d.budgetedRead(c.env.db, async tx => {
      const { rows } = await campaignRows(tx, sql`p.workspace_id = ${workspaceId} AND p.created_at >= ${since}::timestamptz ${q.state ? sql`AND p.state = ${q.state}` : sql``}`, q.limit);
      const stats = await statsOf(tx, workspaceId, rows);
      return { workspaceId, data: rows.map(row => summary(row, stats.get(row.id))) };
    })), 200);
  });
  const campaignById = async (c: Ctx, tx: DbExecutor, id: string) => {
    const list = narrowed(c);
    const { rows: [row] } = list.length ? await campaignRows(tx, sql`p.id = ${id} AND p.workspace_id = ANY(${ids(list)})`, 1) : { rows: [] };
    if (!row) notFound('Campaign');
    return row!;
  };
  app.openapi(createRoute({ ...meta('getSupportCampaign', 'One campaign: what the list shows, plus hourly send pacing and, only when the customer shared message content in its workspace, the draft content.'),
    path: '/v1/support/campaigns/{id}', request: { query: WorkspaceFilter, params: z.object({ id: z.string().max(120) }) }, responses: { 200: response(CampaignDetail), ...errors } }), async c => {
    const id = c.req.valid('param').id, scope = c.get('support')!;
    return c.json(await cached(c, 'campaign', narrowed(c), [id, scope.contentWorkspaceId], () => d.budgetedRead(c.env.db, async tx => {
      const row = await campaignById(c, tx, id);
      const stats = await statsOf(tx, row.workspace_id, [row]), shared = scope.contentWorkspaceId === row.workspace_id;
      const { rows: pacing } = await tx.execute<{ at: string; emails: number }>(sql`SELECT to_char(date_trunc('hour', created_at, 'UTC') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24":00:00.000Z"') AS at, count(*)::int AS emails
        FROM sending_emails WHERE workspace_id = ${row.workspace_id} AND campaign_id = ${row.id} AND created_at >= now() - interval '72 hours' GROUP BY 1 ORDER BY 1`);
      return { workspaceId: row.workspace_id, ...summary(row, stats.get(row.id)), pacing,
        content: shared ? { html: row.draft.html ?? null, previewText: row.draft.previewText ?? null, sourceTemplateId: row.source_template_id } : null };
    })), 200);
  });

  // ---------- 6. lint ----------
  const Lint = z.object({
    id: z.string(), workspaceId: z.string(), computedAt: z.string(), kind: z.enum(['email', 'campaign']), contentShared: z.boolean(),
    metadata: z.object({ sizeBytes: z.number(), parts: z.object({ html: z.boolean(), text: z.boolean(), raw: z.boolean() }), attachments: z.object({ count: z.number(), types: z.array(z.string()) }),
      listUnsubscribe: z.boolean(), listUnsubscribePost: z.boolean(), tracking: z.boolean(),
      alignment: z.object({ fromDomain: z.string(), dkimDomain: z.string().nullable(), returnPath: z.string(), dkimAligned: z.boolean(), spfAligned: z.boolean() }),
      subject: z.object({ length: z.number(), capitalsShare: z.number().nullable(), exclamationRuns: z.number(), emoji: z.number(), replyPrefix: z.boolean(), replyWithoutThread: z.boolean() }) }).describe('Always: what the message is made of, never its words.'),
    content: z.object({ readable: z.boolean(), unreadableReason: z.string().nullable(), visibleWords: z.number(),
      images: z.object({ count: z.number(), declaredArea: z.number(), wordsRequired: z.number().describe('Words the screen’s image rule asks for: 25 per 600×300 beyond a 200×200 logo.'), rulePasses: z.boolean(), missingAlt: z.number() }),
      hiddenWords: z.number(), sameColorWords: z.number(),
      links: z.object({ count: z.number(), domains: z.array(z.object({ domain: z.string(), count: z.number() })), shorteners: z.array(z.string()), mismatchedText: z.array(z.string()).describe('"text domain → link domain"'),
        plainHttp: z.number(), localOrStaging: z.array(z.string()), unsubscribe: z.boolean(), unsubscribeAddedByBane: z.boolean() }),
      unresolvedTokens: z.array(z.string()), spamPhrases: z.array(z.string()) }).nullable().describe('Only when the customer shared message content in this workspace; otherwise null.'),
    findings: Findings,
  }).openapi('SupportLint');
  type Snapshot = { from?: string; subject?: string; html?: string; text?: string; raw?: string; kind?: string; tracking?: boolean; headers?: { Name: string; Value: string }[]; attachments?: string[]; deferredCampaign?: boolean; unsubscribeUrl?: string };
  const attachmentsOf = async (tx: DbExecutor, wid: string, list: string[]) => list.length
    ? (await tx.execute<{ content_type: string; size: number }>(sql`SELECT content_type, size FROM sending_attachments WHERE workspace_id = ${wid} AND id = ANY(${ids(list.slice(0, 50))})`)).rows : [];
  app.openapi(createRoute({ ...meta('getSupportEmailLint', 'Checks one sent email against what filters and Bane’s screen look at. Always the metadata (size, parts, attachment types, List-Unsubscribe, tracking, DKIM and Return-Path alignment, subject style); the content checks (words against images, links, shorteners, hidden text, unresolved tokens, staging links, spam phrases) only with the customer’s content consent.'),
    path: '/v1/support/emails/{id}/lint', request: { query: WorkspaceFilter, params: z.object({ id: z.string().max(120) }) }, responses: { 200: response(Lint), ...errors } }), async c => {
    const id = c.req.valid('param').id, list = narrowed(c), scope = c.get('support')!;
    if (!list.length) notFound('Sent email');
    return c.json(await cached(c, 'email-lint', list, [id, scope.contentWorkspaceId], () => d.budgetedRead(c.env.db, async tx => {
      const { rows: [row] } = await tx.execute<{ workspace_id: string; from_address: string; subject: string; campaign_id: string | null; snapshot: Snapshot; size: number }>(sql`SELECT workspace_id, from_address, subject, campaign_id,
          snapshot, octet_length(snapshot::text)::int AS size FROM sending_emails WHERE id = ${id} AND workspace_id = ANY(${ids(list)})`);
      if (!row) notFound('Sent email');
      const s = row!.snapshot, headers = (s.headers ?? []).map(h => h.Name.toLowerCase()), marketing = s.kind === 'marketing' || !!row!.campaign_id;
      const files = await attachmentsOf(tx, row!.workspace_id, s.attachments ?? []);
      const metadata: d.LintMetadata = { sizeBytes: row!.size + files.reduce((n, f) => n + f.size, 0), parts: { html: !!s.html || !!s.deferredCampaign, text: !!s.text || !!s.deferredCampaign, raw: !!s.raw },
        attachments: { count: files.length, types: [...new Set(files.map(f => f.content_type.split(';')[0]!.trim().toLowerCase()))] },
        listUnsubscribe: headers.includes('list-unsubscribe') || !!s.unsubscribeUrl, listUnsubscribePost: headers.includes('list-unsubscribe-post') || !!s.unsubscribeUrl, tracking: !!s.tracking,
        alignment: await d.senderAlignment(tx, row!.workspace_id, row!.from_address.split('@')[1]!.toLowerCase()), subject: d.subjectStats(row!.subject ?? '', headers.includes('in-reply-to')) };
      const shared = scope.contentWorkspaceId === row!.workspace_id;
      // A sent campaign email keeps no body (it is rendered from the campaign's frozen review): lint the campaign.
      const lint = shared && !s.raw && !s.deferredCampaign && !s.unsubscribeUrl ? await d.lintContent({ html: s.html, text: s.text, subject: row!.subject ?? '', footerAddedByBane: marketing }) : null;
      return { id, workspaceId: row!.workspace_id, kind: 'email' as const, contentShared: shared, metadata, content: lint?.content ?? null, findings: d.byImpact([...d.metadataFindings(metadata, marketing), ...lint?.findings ?? []]) };
    })), 200);
  });
  app.openapi(createRoute({ ...meta('getSupportCampaignLint', 'Checks one campaign’s draft the same way as an email: metadata always, content checks only with the customer’s content consent.'),
    path: '/v1/support/campaigns/{id}/lint', request: { query: WorkspaceFilter, params: z.object({ id: z.string().max(120) }) }, responses: { 200: response(Lint), ...errors } }), async c => {
    const id = c.req.valid('param').id, scope = c.get('support')!;
    return c.json(await cached(c, 'campaign-lint', narrowed(c), [id, scope.contentWorkspaceId], () => d.budgetedRead(c.env.db, async tx => {
      const row = await campaignById(c, tx, id), draft = row.draft, files = await attachmentsOf(tx, row.workspace_id, draft.attachments ?? []);
      let html: string | null = null, text: string | null = null;
      // The email a valid draft becomes (as the campaign preview renders it); a draft that is not valid block HTML as written.
      if (draft.html?.trim()) try {
        const blocks = await import('./campaign-blocks.js');
        blocks.validateBlockHtml(draft.html);
        html = blocks.renderBlockHtml(draft.html, { fontBase: `${c.env.config.publicUrl}/fonts/`, title: draft.subject }); text = blocks.renderBlockText(draft.html) || null;
      } catch { html = draft.html; }
      const metadata: d.LintMetadata = { sizeBytes: (html?.length ?? 0) + (text?.length ?? 0) + files.reduce((n, f) => n + f.size, 0), parts: { html: !!html, text: !!text, raw: false },
        attachments: { count: files.length, types: [...new Set(files.map(f => f.content_type.split(';')[0]!.trim().toLowerCase()))] }, listUnsubscribe: true, listUnsubscribePost: true, tracking: !!draft.tracking,
        alignment: draft.from ? await d.senderAlignment(tx, row.workspace_id, draft.from.split('@')[1]!.toLowerCase()) : { fromDomain: '', dkimDomain: null, returnPath: 'amazonses.com', dkimAligned: false, spfAligned: false },
        subject: d.subjectStats(draft.subject ?? '', false) };
      const shared = scope.contentWorkspaceId === row.workspace_id;
      const lint = shared ? await d.lintContent({ html, text, subject: draft.subject ?? '', footerAddedByBane: true, defaults: Object.keys(draft.defaults ?? {}) }) : null;
      return { id, workspaceId: row.workspace_id, kind: 'campaign' as const, contentShared: shared, metadata, content: lint?.content ?? null,
        findings: d.byImpact([...d.metadataFindings(metadata, true).filter(f => draft.from || f.code !== 'DMARC_UNALIGNED'), ...lint?.findings ?? []]) };
    })), 200);
  });

  // ---------- 7. audience health ----------
  const AudienceView = z.object({ contacts: z.number(), subscribed: z.number(), unknown: z.number(), unsubscribed: z.number(), suppressed: z.number(), suppressedBy: z.record(z.string(), z.number()),
    clicked30: z.number(), clicked90: z.number(), clicked180: z.number(), stale: z.number().describe('Observed for more than 180 days with no open or click.'), neverObserved: z.number(),
    role: z.number().describe('info@, sales@ and other role addresses.'), freeMail: z.number(), typoDomains: z.number().describe('gmial.com, hotmial.com, gmail.co…'), providers: z.record(z.string(), z.number()),
    shares: z.object({ stale: Rate.describe('stale / observed contacts'), role: Rate, freeMail: Rate }) });
  const Audience = z.object({
    workspaceId: z.string(), computedAt: z.string(), lists: z.array(AudienceView.extend({ id: z.string(), name: z.string() })).describe('The 20 largest lists, or the one asked for.'),
    all: AudienceView.nullable().describe('Every contact; null when listId narrows the read.'),
    imports: z.array(z.object({ id: z.string(), listId: z.string().nullable(), listName: z.string().nullable(), at: z.string(), imported: z.number(), errors: z.number(), contacts: z.number(),
      hardBounce: Rate.describe('Imported contacts suppressed for a hard bounce since the import.'), complaint: Rate, unsubscribed: z.number() })).describe('Committed imports of the last 90 days, newest first (10).'),
    findings: Findings,
  }).openapi('SupportAudienceHealth');
  app.openapi(createRoute({ ...meta('getSupportAudienceHealth', 'List hygiene: per list (the 20 largest) and overall, consent mix, suppressions by reason, engagement recency and stale share, role, free-mail and mistyped addresses, providers; recent imports with their bounce and complaint outcomes; findings. Counts only, never an address.'),
    path: '/v1/support/audience/health', request: { query: WorkspaceFilter.extend({ listId: z.string().max(120).optional() }) }, responses: { 200: response(Audience), ...errors } }), async c => {
    const q = c.req.valid('query'), { workspaceId } = oneWorkspace(c);
    return c.json(await cached(c, 'audience', workspaceId, q.listId ?? null, async () => ({ workspaceId, ...await d.budgetedRead(c.env.db, tx => d.audienceHealth(tx, workspaceId, q.listId)) })), 200);
  });
}
