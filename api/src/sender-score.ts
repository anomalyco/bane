import { createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { DASHBOARD_CACHE_NOTE, dashboardRead } from './dashboard-cache.js';
import { actor, ApiError, errors, response, security, type App, type Runtime } from './core.js';

// Sender score: a per-workspace reputation grade from the workspace's own sending, computed on request from one SQL
// statement and cached for dashboard sessions. Nothing is written: the daily movement limit is replayed over the last
// 14 days instead of stored, so the score needs no table, job or hot-path write.
//
//   factor score  s = 100 × clamp((bad − x) ÷ (bad − good), 0, 1)
//   raw           R = Σ weight·s ÷ Σ weight, over measured factors (neutral factors drop out and the rest re-weigh)
//   target        T = (n·R + 400·75) ÷ (n + 400), n = non-simulated emails in the 30 days to that day
//   score         starts at 75 fourteen days ago; each day moves towards that day's T by at most +2 or −15
//   grade         none until the workspace's first 100 real emails; then A+ ≥ 95, A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, F
//
// Real email: not simulated by the installation, and addressed to at least one recipient outside the SES mailbox
// simulator (…@simulator.amazonses.com). Simulator feedback is test traffic, not reputation evidence: a test bounce
// must not lower the score, and test sends must not count towards the first 100. (They still use the daily limit.)

export const WARMUP_EMAILS = 100;
const PRIOR = 75, CONFIDENCE = 400, MAX_RISE = 2, MAX_FALL = 15, WINDOW_DAYS = 30, HISTORY_DAYS = 14, SPIKE_FLOOR = 20;
const DAY_MS = 86_400_000;
const GRADES = ['A+', 'A', 'B', 'C', 'D', 'F'] as const;
type Grade = (typeof GRADES)[number];
const BANDS: { grade: Grade; min: number }[] = [{ grade: 'A+', min: 95 }, { grade: 'A', min: 90 }, { grade: 'B', min: 80 }, { grade: 'C', min: 70 }, { grade: 'D', min: 60 }, { grade: 'F', min: 0 }];
const FACTOR_KEYS = ['complaints', 'bounces', 'content', 'auth', 'hygiene', 'consistency'] as const;
type FactorKey = (typeof FACTOR_KEYS)[number];
const FACTORS: Record<FactorKey, { label: string; weight: number; good: number; bad: number; basis: string }> = {
  complaints: { label: 'Complaints', weight: 25, good: 0.0002, bad: 0.003, basis: 'Spam complaints ÷ delivered emails.' },
  bounces: { label: 'Bounces', weight: 20, good: 0.01, bad: 0.08, basis: 'Bounced ÷ provider-accepted emails.' },
  content: { label: 'Content', weight: 20, good: 0.001, bad: 0.03, basis: 'Emails the hosted content screen rejected as spam ÷ emails created. Neutral when the workspace is not screened.' },
  auth: { label: 'Authentication', weight: 15, good: 1, bad: 0, basis: 'By sending volume: DKIM signing 40 %, a verified custom MAIL FROM (aligned SPF) 30 %, DMARC enforcing 30 % (p=none 15 %). Neutral without hosted domain records.' },
  hygiene: { label: 'List hygiene', weight: 10, good: 0.005, bad: 0.05, basis: 'Emails stopped by the suppression list ÷ emails created.' },
  consistency: { label: 'Consistency', weight: 10, good: 3, bad: 20, basis: 'Busiest day ÷ the median of the days with mail in the week before it (at least 20). Days with fewer than two such days are not compared.' },
};

const FactorSchema = z.object({
  key: z.enum(FACTOR_KEYS), label: z.string(), weight: z.number().int().describe('Share of the score, out of 100, when every factor is measured.'),
  value: z.number().nullable().describe('The measured rate or ratio for the 30 days to today; null when neutral.'),
  score: z.number().nullable().describe('0–100 for this factor; null when neutral.'),
  points: z.number().nullable().describe('weight × score ÷ 100; null when neutral.'),
  source: z.enum(['measured', 'neutral']).describe('Neutral factors are left out and the measured ones re-weighted.'),
  basis: z.string(),
}).openapi('SenderScoreFactor');
const SenderScoreSchema = z.object({
  state: z.enum(['warmup', 'graded']).describe('warmup until the workspace has sent its first 100 real emails: not simulated, and to at least one recipient outside the SES mailbox simulator.'),
  emails: z.object({ firstEmails: z.number().int().describe('Real emails ever created, counted up to 100. Simulated sends and emails only to …@simulator.amazonses.com are left out.'), last30Days: z.number().int().describe('Real emails created in the 30 days to today.') }),
  needed: z.number().int().describe('Emails before the first grade (100).'),
  score: z.number().nullable().describe('0–100, one decimal; null while warming up.'),
  grade: z.enum(GRADES).nullable(),
  target: z.number().describe('Where the score is heading: the 30-day result shrunk towards 75 by volume.'),
  raw: z.number().describe('The 30-day weighted factor result before shrinkage.'),
  band: z.object({ min: z.number(), max: z.number() }).nullable().describe('The current grade band.'),
  next: z.object({ grade: z.enum(GRADES), at: z.number() }).nullable().describe('The next grade up and the score it starts at.'),
  factors: z.array(FactorSchema),
  history: z.array(z.object({ date: z.string().describe('UTC day, YYYY-MM-DD.'), score: z.number() })).describe('The replayed daily score, oldest first; the last entry is today.'),
  computedAt: z.iso.datetime(),
}).openapi('SenderScore');
export type SenderScore = z.infer<typeof SenderScoreSchema>;

export type DayRow = { day: string; emails: number; accepted: number; delivered: number; bounced: number; complained: number; screened: number; suppressed: number };
export type DomainRow = { name: string; dkim: boolean; mailFrom: boolean; dmarc: string | null; emails: number };
export type ScoreInputs = { days: DayRow[]; domains: DomainRow[]; firstEmails: number; screened: boolean; today: string };

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const subscore = (key: FactorKey, value: number) => { const { good, bad } = FACTORS[key]; return 100 * clamp((bad - value) / (bad - good), 0, 1); };
// DKIM 40 + aligned SPF 30 + DMARC 30 (p=none half), weighted by each domain's 30-day mail, or evenly when there is none.
export function authShare(domains: DomainRow[]): number | null {
  if (!domains.length) return null;
  const share = (d: DomainRow) => (d.dkim ? 0.4 : 0) + (d.mailFrom ? 0.3 : 0) + (d.dmarc === 'quarantine' || d.dmarc === 'reject' ? 0.3 : d.dmarc === 'none' ? 0.15 : 0);
  const volume = domains.reduce((sum, d) => sum + d.emails, 0);
  return volume ? domains.reduce((sum, d) => sum + share(d) * d.emails, 0) / volume : domains.reduce((sum, d) => sum + share(d), 0) / domains.length;
}

/** Pure scoring from per-day counts, so tests and the route share one implementation. */
export function computeSenderScore(input: ScoreInputs, now = new Date()): SenderScore {
  const today = Date.parse(input.today + 'T00:00:00Z'), byDay = new Map(input.days.map(row => [row.day, row]));
  const count = (ms: number) => byDay.get(dayKey(ms));
  const auth = authShare(input.domains);
  // The factors for the 30 days ending with `end` (a UTC day start).
  const window = (end: number) => {
    const totals = { emails: 0, accepted: 0, delivered: 0, bounced: 0, complained: 0, screened: 0, suppressed: 0 };
    let spike: number | null = null;
    for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
      const ms = end - i * DAY_MS, row = count(ms);
      if (row) for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += row[key];
      if (!row?.emails) continue;
      // The baseline is the median of the days that had mail in the week before, so a new sender's first days and
      // a quiet weekend don't read as spikes; a day needs two such days before it to be compared at all.
      const before = Array.from({ length: 7 }, (_, k) => count(ms - (k + 1) * DAY_MS)?.emails ?? 0).filter(Boolean).sort((a, b) => a - b);
      if (before.length < 2) continue;
      const median = before.length % 2 ? before[(before.length - 1) / 2]! : (before[before.length / 2 - 1]! + before[before.length / 2]!) / 2;
      spike = Math.max(spike ?? 1, row.emails / Math.max(median, SPIKE_FLOOR));
    }
    const values: Record<FactorKey, number | null> = {
      complaints: totals.delivered ? totals.complained / totals.delivered : null,
      bounces: totals.accepted ? totals.bounced / totals.accepted : null,
      content: input.screened && totals.emails ? totals.screened / totals.emails : null,
      auth,
      hygiene: totals.emails ? totals.suppressed / totals.emails : null,
      consistency: spike,
    };
    const factors = FACTOR_KEYS.map(key => {
      const spec = FACTORS[key], value = values[key];
      if (value === null) return { key, label: spec.label, weight: spec.weight, value: null, score: null, points: null, source: 'neutral' as const, basis: spec.basis };
      const score = subscore(key, value);
      return { key, label: spec.label, weight: spec.weight, value, score, points: spec.weight * score / 100, source: 'measured' as const, basis: spec.basis };
    });
    const measured = factors.filter(f => f.source === 'measured'), weight = measured.reduce((sum, f) => sum + f.weight, 0);
    const raw = weight ? measured.reduce((sum, f) => sum + f.points!, 0) / weight * 100 : PRIOR;
    return { factors, raw, target: (totals.emails * raw + CONFIDENCE * PRIOR) / (totals.emails + CONFIDENCE), emails: totals.emails };
  };
  const history: { date: string; score: number }[] = [];
  let score = PRIOR, last = window(today);
  for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
    const end = today - i * DAY_MS, day = i === 0 ? last : window(end);
    score += clamp(day.target - score, -MAX_FALL, MAX_RISE);
    history.push({ date: dayKey(end), score: round(score) });
  }
  const warmup = input.firstEmails < WARMUP_EMAILS;
  const index = BANDS.findIndex(band => score >= band.min), above = index > 0 ? BANDS[index - 1]! : null;
  return {
    state: warmup ? 'warmup' : 'graded',
    emails: { firstEmails: Math.min(input.firstEmails, WARMUP_EMAILS), last30Days: last.emails },
    needed: WARMUP_EMAILS,
    score: warmup ? null : round(score),
    grade: warmup ? null : BANDS[index]!.grade,
    target: round(last.target), raw: round(last.raw),
    band: warmup ? null : { min: BANDS[index]!.min, max: above?.min ?? 100 },
    next: warmup || !above ? null : { grade: above.grade, at: above.min },
    factors: last.factors.map(f => ({ ...f, value: f.value === null ? null : round(f.value, 6), score: f.score === null ? null : round(f.score), points: f.points === null ? null : round(f.points, 2) })),
    history: warmup ? [] : history,
    computedAt: now.toISOString(),
  };
}

// One statement: per-day counts for the 50 days the 14 replayed windows need (each 30 days plus the 7 days before its
// busiest day), sender volume per From domain, the first-100 count, the connection kind and the hosted domain facts.
async function loadInputs(runtime: Runtime, workspaceId: string, now: Date): Promise<ScoreInputs> {
  const today = dayKey(Date.parse(now.toISOString().slice(0, 10) + 'T00:00:00Z'));
  const since = new Date(Date.parse(today + 'T00:00:00Z') - (WINDOW_DAYS + HISTORY_DAYS + 6) * DAY_MS).toISOString();
  const recent = new Date(Date.parse(today + 'T00:00:00Z') - (WINDOW_DAYS - 1) * DAY_MS).toISOString();
  const { rows: [row] } = await runtime.db.execute<{ days: DayRow[]; senders: { domain: string; emails: number }[]; first_emails: number; kind: string | null; domains: Omit<DomainRow, 'emails'>[] }>(sql`
    WITH mail AS MATERIALIZED (
      SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, created_at, status, error_code, event_outcomes, provider_id,
        lower(substring(from_address from '@([A-Za-z0-9.-]+)')) AS domain
      FROM sending_emails WHERE workspace_id = ${workspaceId} AND NOT simulated AND created_at >= ${since}::timestamptz
        AND hosted_real_cost(to_addresses || cc_addresses || bcc_addresses) > 0
    ), days AS (
      SELECT day, count(*)::int AS emails,
        count(*) FILTER (WHERE status <> 'suppressed' AND (provider_id IS NOT NULL OR status IN ('accepted', 'sent', 'delivered', 'bounced', 'complained', 'delayed') OR event_outcomes & 1 <> 0))::int AS accepted,
        count(*) FILTER (WHERE status = 'delivered' OR event_outcomes & 2 <> 0)::int AS delivered,
        count(*) FILTER (WHERE status = 'bounced' OR event_outcomes & 4 <> 0)::int AS bounced,
        count(*) FILTER (WHERE status = 'complained' OR event_outcomes & 8 <> 0)::int AS complained,
        count(*) FILTER (WHERE error_code = 'CONTENT_REJECTED_SPAM')::int AS screened,
        count(*) FILTER (WHERE status = 'suppressed')::int AS suppressed
      FROM mail GROUP BY day
    )
    SELECT
      (SELECT coalesce(json_agg(days ORDER BY day), '[]'::json) FROM days) AS days,
      (SELECT coalesce(json_agg(json_build_object('domain', domain, 'emails', n)), '[]'::json) FROM (SELECT domain, count(*)::int AS n FROM mail WHERE created_at >= ${recent}::timestamptz AND domain IS NOT NULL GROUP BY domain) s) AS senders,
      (SELECT count(*)::int FROM (SELECT 1 FROM sending_emails WHERE workspace_id = ${workspaceId} AND NOT simulated
        AND hosted_real_cost(to_addresses || cc_addresses || bcc_addresses) > 0 LIMIT ${WARMUP_EMAILS}) f) AS first_emails,
      (SELECT kind FROM provider_connections WHERE workspace_id = ${workspaceId}) AS kind,
      (SELECT coalesce(json_agg(json_build_object('name', name,
        'dkim', identity #>> '{ses,DkimAttributes,Status}' = 'SUCCESS' AND identity #>> '{ses,DkimAttributes,SigningEnabled}' = 'true',
        'mailFrom', identity #>> '{ses,MailFromAttributes,MailFromDomainStatus}' = 'SUCCESS',
        'dmarc', identity #>> '{dmarc,status}')), '[]'::json)
        FROM domain_claims WHERE workspace_id = ${workspaceId} AND sending_state = 'verified') AS domains`);
  const senders = row?.senders ?? [];
  // Mail from a subdomain counts towards the claimed domain it belongs to.
  const volume = (name: string) => senders.filter(s => s.domain === name || s.domain.endsWith('.' + name)).reduce((sum, s) => sum + s.emails, 0);
  const screened = Boolean(runtime.config.screen && runtime.config.hostedScreen && row?.kind === 'shared');
  return { days: row?.days ?? [], domains: (row?.domains ?? []).map(d => ({ ...d, dkim: d.dkim === true, mailFrom: d.mailFrom === true, emails: volume(d.name) })), firstEmails: row?.first_emails ?? 0, screened, today };
}

export async function protocolScoreCap(runtime:Runtime,w:string){const now=new Date();const grade=computeSenderScore(await loadInputs(runtime,w,now),now).grade;return grade===null?200:({'A+':2000,A:2000,B:1000,C:300,D:100,F:50})[grade];}
export function registerSenderScore(app: App) {
  app.openapi(createRoute({ method: 'get', path: '/v1/sender-score', operationId: 'getSenderScore', tags: ['Metrics'], security,
    description: 'The workspace sender score: a 0–100 reputation grade from its own sending over 30 days (complaints, bounces, content-screen rejections, domain authentication, suppression hits, volume spikes). No grade until the first 100 real emails: simulated sends and emails only to the SES mailbox simulator (…@simulator.amazonses.com) never count. The score starts at 75 and moves at most +2 or −15 a day towards its target. ' + DASHBOARD_CACHE_NOTE + ' Workspace-wide: keys restricted to domains get 403.',
    responses: { 200: response(SenderScoreSchema), ...errors } }), async c => {
    const a = actor(c, 'read');
    if (a.domains.length) throw new ApiError(403, 'UNRESTRICTED_KEY_REQUIRED', 'Workspace-wide operations require a key without domain restrictions.');
    const compute = async () => { const now = new Date(); return computeSenderScore(await loadInputs(c.env, a.workspaceId, now), now); };
    if (a.credential !== 'dashboard') return c.json(await compute(), 200);
    const body = await dashboardRead(c, ['sender-score', a.workspaceId, Math.floor(Date.now() / 60_000)].join('|'), compute);
    c.header('x-bane-sender-score-cache', body.cache);
    return c.json(body.value, 200);
  });
}
