import { createRoute, z } from '@hono/zod-openapi';
import { sql, type SQL } from 'drizzle-orm';
import { errors, response, type App, type DbExecutor } from './core.js';
import { cachedDashboardRead } from './dashboard-cache.js';
import { poolSends } from './states.js';

const PublicStats = z.object({
  generatedAt: z.string().describe('When the figures were computed. Responses are cached for up to 60 seconds.'),
  acceptedLast30Days: z.number().int().describe('Emails Amazon SES accepted in the last 30 days, across the installation. Simulated, suppressed and rejected mail is excluded. Email history is kept for 30 days, so there is no all-time total.'),
  acceptedLastHour: z.number().int().describe('Emails Amazon SES accepted in the last 60 minutes.'),
  acceptedHourly: z.array(z.number().int()).describe('Accepted emails per rolling hour over the last 24 hours, oldest first. The last entry is acceptedLastHour.'),
  deliveryRate: z.number().nullable().describe('delivered ÷ (delivered + bounced) for emails created in the last 30 days, each email counted once. Null without outcomes.'),
  medianSendLatencyMs: z.number().int().nullable().describe('Median time from API acceptance to Amazon SES acceptance for the most recent 5,000 direct, unscheduled sends in the last 24 hours. Null without samples.'),
  regions: z.array(z.string()).describe('AWS regions that accepted mail in the last 30 days. Hosted installations list only their shared sending regions.'),
}).openapi('PublicStats');
export type PublicStats = z.infer<typeof PublicStats>;
/** The 30-day pass: one scan of the retained mail (sending_emails keeps 30 days), so it is refreshed less often than the live figures. */
export type MonthStats = { at: string; accepted: number; delivered: number; bounced: number; regions: string[] };

// Queued and attempting mail has no outcome yet; leaving it out also matches the partial index sending_emails_retire (created_at).
const settled = sql`NOT e.simulated AND e.status NOT IN ('queued','attempting')`;
// The same "accepted" evidence as GET /v1/metrics: a provider ID, an accepted-or-later status, or the accepted outcome bit.
const accepted = sql`(e.status <> 'suppressed' AND (e.provider_id IS NOT NULL OR e.status IN ('accepted','sent','delivered','bounced','complained','delayed') OR (e.event_outcomes & 1) <> 0))`;
const instant = (asOf?: string): SQL => asOf ? sql`${asOf}::timestamptz` : sql`now()`;

// Installation-wide aggregates only: no statement returns a workspace, address, subject or per-workspace figure.
// `asOf` lets acceptance tests evaluate fixture data at a fixed instant; the route always uses now().
export async function computeMonthStats(db: Pick<DbExecutor, 'execute'>, multiTenant: boolean, asOf?: string): Promise<MonthStats> {
  const at = instant(asOf);
  const hosted = multiTenant ? sql`region IN (SELECT p.region FROM provider_pool_regions p WHERE ${poolSends()})` : sql`true`;
  // Grouped by region (a handful of rows) rather than a DISTINCT aggregate, which would sort every email.
  const [row] = (await db.execute<{ accepted: string; delivered: string; bounced: string; regions: string[]; at: string }>(sql`
    WITH regional AS (
      SELECT e.region, count(*) FILTER (WHERE ${accepted}) AS accepted,
        count(*) FILTER (WHERE e.status = 'delivered' OR (e.event_outcomes & 2) <> 0) AS delivered,
        count(*) FILTER (WHERE e.status = 'bounced' OR (e.event_outcomes & 4) <> 0) AS bounced
      FROM sending_emails e
      WHERE e.created_at > ${at} - interval '30 days' AND e.created_at <= ${at} AND ${settled}
      GROUP BY e.region
    )
    SELECT coalesce(sum(accepted), 0)::bigint AS accepted, coalesce(sum(delivered), 0)::bigint AS delivered, coalesce(sum(bounced), 0)::bigint AS bounced,
      coalesce(jsonb_agg(region ORDER BY region) FILTER (WHERE accepted > 0 AND ${hosted}), '[]'::jsonb) AS regions,
      to_char(${at} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
    FROM regional`)).rows;
  return { at: row!.at, accepted: Number(row!.accepted), delivered: Number(row!.delivered), bounced: Number(row!.bounced), regions: row!.regions };
}

// The live pass reads only indexed, bounded ranges: the last 24 hours, the newest 5,000 direct sends, and mail
// accepted since the 30-day pass (at most its cache lifetime), which advances its total without rescanning.
export async function computePublicStats(db: Pick<DbExecutor, 'execute'>, month: MonthStats, asOf?: string): Promise<PublicStats> {
  const at = instant(asOf);
  const [row] = (await db.execute<{ arrived: string; hourly: Record<string, number>; latency_ms: number | null; generated_at: string }>(sql`
    WITH day AS (
      SELECT floor(extract(epoch FROM ${at} - e.created_at) / 3600)::int AS ago, count(*)::int AS n
      FROM sending_emails e
      WHERE e.created_at > ${at} - interval '24 hours' AND e.created_at <= ${at} AND ${settled} AND ${accepted}
      GROUP BY 1
    ), latency AS (
      -- Admission (sending_emails.created_at) to the dispatcher's 'accepted' event (sending_email_events.created_at,
      -- written when SES returns a MessageId). Campaign mail is paced and scheduled mail waits on purpose, so both are left out.
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM a.accepted_at - d.created_at) * 1000) AS ms
      FROM (SELECT e.workspace_id, e.id, e.created_at FROM sending_emails e
        WHERE e.created_at > ${at} - interval '24 hours' AND e.created_at <= ${at} AND ${settled}
          AND e.campaign_id IS NULL AND (e.scheduled_at IS NULL OR e.dispatch_version > 0)
        ORDER BY e.created_at DESC LIMIT 5000) d
      CROSS JOIN LATERAL (SELECT min(v.created_at) AS accepted_at FROM sending_email_events v
        WHERE v.workspace_id = d.workspace_id AND v.email_id = d.id AND v.type = 'accepted') a
      WHERE a.accepted_at >= d.created_at
    )
    SELECT (SELECT count(*) FROM sending_emails e WHERE e.created_at > ${month.at}::timestamptz AND e.created_at <= ${at} AND ${settled} AND ${accepted})::bigint AS arrived,
      (SELECT coalesce(jsonb_object_agg(ago, n), '{}'::jsonb) FROM day) AS hourly,
      (SELECT ms FROM latency) AS latency_ms,
      to_char(${at} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS generated_at`)).rows;
  const acceptedHourly = Array.from({ length: 24 }, (_, index) => row!.hourly[String(23 - index)] ?? 0);
  const outcomes = month.delivered + month.bounced;
  return {
    generatedAt: row!.generated_at,
    acceptedLast30Days: month.accepted + Number(row!.arrived),
    acceptedLastHour: acceptedHourly[23]!,
    acceptedHourly,
    deliveryRate: outcomes > 0 ? month.delivered / outcomes : null,
    medianSendLatencyMs: row!.latency_ms === null ? null : Math.round(Number(row!.latency_ms)),
    regions: month.regions,
  };
}

export function registerPublicStats(app: App) {
  app.openapi(createRoute({ method: 'get', path: '/v1/public/stats', operationId: 'getPublicStats', tags: ['Metrics'], security: [],
    description: 'Public, unauthenticated sending figures for the installation, computed from stored mail. Aggregates only: no workspace, address or per-workspace figure is returned. Live figures are cached for up to 60 seconds; the 30-day delivery rate and regions for up to 10 minutes. Outcomes use current email state, so recent figures can still rise as Amazon SES reports back.',
    responses: { 200: response(PublicStats), 429: errors[429]!, 500: errors[500]!, 503: errors[503]! } }), async c => {
    const origin = new URL(c.req.url).origin, { db, config } = c.env;
    const { value, hit } = await cachedDashboardRead(origin, 'public-stats', async () => {
      const month = await cachedDashboardRead(origin, 'public-stats:30d', () => computeMonthStats(db, config.multiTenant), 600);
      return computePublicStats(db, month.value);
    });
    c.header('x-bane-stats-cache', hit ? 'hit' : 'miss');
    return c.json(value, 200);
  });
}
