import { sql, type SQL } from 'drizzle-orm';
import { ApiError, type DbExecutor, type Runtime } from './core.js';

// Deliverability aggregates over a workspace's retained mail (30 days of sending_emails and their events), shared by
// the support grant's reads (src/support-deliverability.ts) and, later, a customer /v1/metrics?groupBy= (decision D9).
// Every function takes the executor of one budgeted read (budgetedRead) and reads through these indexes only:
//   sending_emails_created_page (workspace_id, created_at DESC, id DESC): the window of a workspace's mail;
//   sending_emails_kind_created (workspace_id, (snapshot->>'kind'), created_at): a stream, without detoasting snapshot;
//   sending_emails_campaign_status (workspace_id, campaign_id, status): one campaign;
//   sending_owner_sender_domain_page (workspace_id, reversed From domain, created_at DESC, id DESC): one From domain;
//   sending_emails_page (workspace_id, id): an event's email;
//   sending_email_events_retention (workspace_id, created_at): the window's events;
//   hosted_screen_hourly, sender_score_daily and sender_standing by their primary keys;
//   audience_contacts_page, audience_members_contact, the audience_list_members and audience_imports primary keys.
// Nothing here returns a recipient address: recipients are counted by domain and provider only.

export const DAY_MS = 86_400_000, HOUR_MS = 3_600_000;
export const LIMITS = { windowDays: 30, hourlyHours: 72, groups: 20, rows: 50, subject: 120, diagnostic: 160 } as const;
export const SCREEN_CODES = ['CONTENT_REJECTED_SPAM', 'CONTENT_IMAGE_ONLY', 'CONTENT_TOO_LARGE_TO_SCREEN', 'ATTACHMENT_TYPE_UNSCREENABLE', 'ATTACHMENT_CONTENT_MISMATCH'];
const texts = (list: readonly string[]) => sql`${sql.param([...list])}::text[]`;

/**
 * One read-only transaction whose every statement stops after 3 seconds. A read that needs longer is refused with
 * 422 SUPPORT_READ_TOO_LARGE rather than holding a connection: the caller narrows the window or the filters.
 */
export async function budgetedRead<T>(db: Runtime['db'], work: (tx: DbExecutor) => Promise<T>): Promise<T> {
  try {
    return await db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
      return work(tx);
    }, { accessMode: 'read only' });
  } catch (error) {
    if ([error, (error as { cause?: unknown })?.cause].some(e => (e as { code?: string } | null)?.code === '57014'))
      throw new ApiError(422, 'SUPPORT_READ_TOO_LARGE', 'This read needs more than 3 seconds. Narrow the window or add a filter (campaignId, fromDomain, provider).');
    throw error;
  }
}

// ---------- recipient providers ----------
/** Recipient domain → mailbox provider, a static map (support-agent-design §5.2). `families` match `<name>.<tld>`. */
export const PROVIDERS = [
  { provider: 'gmail', domains: ['gmail.com', 'googlemail.com'], families: [] },
  { provider: 'microsoft', domains: ['msn.com'], families: ['outlook', 'hotmail', 'live'] },
  { provider: 'yahoo', domains: ['ymail.com', 'rocketmail.com', 'aol.com'], families: ['yahoo'] },
  { provider: 'apple', domains: ['icloud.com', 'me.com', 'mac.com'], families: [] },
  { provider: 'proton', domains: ['proton.me', 'protonmail.com'], families: [] },
  { provider: 'gmx', domains: ['web.de'], families: ['gmx'] },
] as const;
export type Provider = (typeof PROVIDERS)[number]['provider'] | 'other';
export const PROVIDER_NAMES = ['gmail', 'microsoft', 'yahoo', 'apple', 'proton', 'gmx', 'other'] as const satisfies readonly Provider[];
const familyPattern = (families: readonly string[]) => `^(?:${families.join('|')})\\.[a-z]{2,}(?:\\.[a-z]{2,})?$`;
export function providerOf(domain: string): Provider {
  const d = domain.toLowerCase();
  return PROVIDERS.find(p => (p.domains as readonly string[]).includes(d) || (p.families.length && new RegExp(familyPattern(p.families)).test(d)))?.provider ?? 'other';
}
/** The same map in SQL, over a lower-case domain expression. */
export function providerSql(domain: SQL) {
  return sql`CASE ${sql.join(PROVIDERS.map(p => sql`WHEN ${domain} = ANY(${texts(p.domains)})${p.families.length ? sql` OR ${domain} ~ ${familyPattern(p.families)}` : sql``} THEN ${p.provider}::text`), sql` `)} ELSE 'other' END`;
}
const recipientDomain = sql`lower(split_part(e.to_addresses->>0, '@', 2))`;
const fromDomainOf = sql`lower(split_part(e.from_address, '@', 2))`;
/** Exactly this From domain, through sending_owner_sender_domain_page (the reversed domain with its separator). */
export const fromDomainIs = (domain: string) => sql`(reverse(lower(split_part(e.from_address, '@', 2))) || '.') COLLATE "C" = ${[...domain.toLowerCase()].reverse().join('') + '.'}`;

// ---------- redaction ----------
const ADDRESS = /[^\s<>"'@,;()[\]]+@[^\s<>"'@,;()[\]]+/g;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, IPV6 = /\b(?:[0-9a-f]{1,4}:){2,7}(?::|[0-9a-f]{1,4})\b/gi;
/** A provider diagnostic as support may read it: addresses become <address>, IPs <ip>, at most 160 characters. */
export function redactDiagnostic(text: string | null | undefined): string | null {
  if (!text) return null;
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(ADDRESS, '<address>').replace(IPV4, '<ip>').replace(IPV6, '<ip>').replace(/\s+/g, ' ').trim().slice(0, LIMITS.diagnostic) || null;
}
/** The same in SQL, so redacted diagnostics group together before they are counted. */
const redactedSql = (text: SQL) => sql`left(regexp_replace(regexp_replace(regexp_replace(regexp_replace(${text}, '[[:cntrl:]]+', ' ', 'g'),
  '[^[:space:]<>"''@,;()]+@[^[:space:]<>"''@,;()]+', '<address>', 'g'), '([0-9]{1,3}\\.){3}[0-9]{1,3}', '<ip>', 'g'), '([0-9A-Fa-f]{1,4}:){2,7}(:|[0-9A-Fa-f]{1,4})', '<ip>', 'g'), ${LIMITS.diagnostic})`;

// ---------- findings ----------
export type Severity = 'info' | 'notice' | 'serious' | 'critical';
/** A heuristic the agent can cite (support-agent-design §5.3): the arithmetic is done here, the judgement by the agent. */
export type Finding = { severity: Severity; code: string; message: string; scope: string | null; evidence: Record<string, number> };
const SEVERITY: Severity[] = ['info', 'notice', 'serious', 'critical'];
export const byImpact = (list: Finding[]) => [...list].sort((a, b) => SEVERITY.indexOf(b.severity) - SEVERITY.indexOf(a.severity)).slice(0, LIMITS.rows);
const pct = (v: number) => `${(100 * v).toFixed(v < 0.01 ? 2 : 1).replace(/\.?0+$/, '')}%`;
const num = (n: number) => n.toLocaleString('en-US');
/** Thresholds (published lines first): complaints 0.05% (AUP), 0.1% (Gmail's ceiling), 0.3% (enforced). */
export const THRESHOLDS = {
  complaint: { notice: 0.0005, serious: 0.001, critical: 0.003 }, hardBounce: { serious: 0.02, critical: 0.05 }, firstSendBounce: 0.03,
  throttling: 0.01, spike: 3, newDomainDays: 14, newDomainDaily: 2000, openDrop: 0.4, stale: 0.3, role: 0.05, bulkSubject: 500,
  /** A rate finding needs at least this many events, so one complaint never reads as a crisis. */
  minimumEvents: 2,
} as const;
export type Rate = { numerator: number; denominator: number; value: number | null };
export const rate = (numerator: number, denominator: number, enabled = true): Rate => ({ numerator, denominator, value: denominator > 0 && enabled ? Math.round(numerator / denominator * 1e6) / 1e6 : null });

export function rateFindings(c: Pick<Counts, 'accepted' | 'complained' | 'hardBounced'>, scope: string | null): Finding[] {
  const out: Finding[] = [], t = THRESHOLDS, where = scope ? ` at ${scope}` : '';
  if (c.accepted > 0 && c.complained >= t.minimumEvents) {
    const r = c.complained / c.accepted, line = r >= t.complaint.critical ? 'critical' : r > t.complaint.serious ? 'serious' : r > t.complaint.notice ? 'notice' : null;
    if (line) out.push({ severity: line, code: 'COMPLAINT_RATE', scope, evidence: { complained: c.complained, accepted: c.accepted, rate: r, threshold: t.complaint[line as keyof typeof t.complaint] },
      message: `${num(c.complained)} of ${num(c.accepted)} accepted emails${where} were marked as spam (${pct(r)}). ${line === 'critical' ? 'Gmail and Yahoo enforce 0.3%.' : line === 'serious' ? 'Gmail recommends staying under 0.1%.' : 'Bane’s policy line is 0.05%.'} Usual cause: mail people did not ask for (no opt-in, an old list, too frequent, a misleading subject).` });
  }
  if (c.accepted > 0 && c.hardBounced >= t.minimumEvents) {
    const r = c.hardBounced / c.accepted, line = r > t.hardBounce.critical ? 'critical' : r > t.hardBounce.serious ? 'serious' : null;
    if (line) out.push({ severity: line, code: 'HARD_BOUNCE_RATE', scope, evidence: { hardBounced: c.hardBounced, accepted: c.accepted, rate: r, threshold: t.hardBounce[line] },
      message: `${num(c.hardBounced)} of ${num(c.accepted)} accepted emails${where} hard-bounced (${pct(r)}). ${line === 'critical' ? 'Above 5% usually means an old, bought or mistyped list.' : 'Bane’s policy line is 2%.'} Stop mailing the source of the bounces and validate addresses at signup.` });
  }
  return out;
}
/** A day above 3× the median of the 7 calendar days before it (days without mail count as 0). */
export function spikeFindings(sparse: { at: string; accepted: number }[], scope: string | null): Finding[] {
  const out: Finding[] = [], days: { at: string; accepted: number }[] = [];
  for (const d of [...sparse].sort((a, b) => a.at < b.at ? -1 : 1)) {
    for (let t = days.length ? Date.parse(days.at(-1)!.at.slice(0, 10)) + DAY_MS : NaN; t < Date.parse(d.at.slice(0, 10)); t += DAY_MS) days.push({ at: new Date(t).toISOString().slice(0, 10), accepted: 0 });
    days.push(d);
  }
  for (let i = 7; i < days.length; i++) {
    const prior = days.slice(i - 7, i).map(d => d.accepted).sort((a, b) => a - b), median = prior[3]!;
    if (median > 0 && days[i]!.accepted > THRESHOLDS.spike * median && days[i]!.accepted >= 100)
      out.push({ severity: 'notice', code: 'VOLUME_SPIKE', scope, evidence: { accepted: days[i]!.accepted, trailingMedian: median, ratio: Math.round(days[i]!.accepted / median * 10) / 10 },
        message: `${days[i]!.at.slice(0, 10)}: ${num(days[i]!.accepted)} accepted${scope ? ` from ${scope}` : ''}, ${Math.round(days[i]!.accepted / median * 10) / 10}× the trailing 7-day median (${num(median)}). Providers throttle sudden jumps: ramp up over days instead.` });
  }
  return out.slice(-3);
}

// ---------- 1. delivery metrics ----------
export type Granularity = 'day' | 'hour';
export type GroupBy = 'none' | 'campaign' | 'from_domain' | 'provider' | 'stream';
export type Stream = 'all' | 'transactional' | 'marketing';
export type MetricsQuery = { since: string; until: string; granularity: Granularity; groupBy: GroupBy; stream: Stream; campaignId?: string; fromDomain?: string };
const COUNT_KEYS = ['emails', 'accepted', 'delivered', 'hardBounced', 'softBounced', 'complained', 'opened', 'openedHuman', 'clicked', 'screenRejected', 'suppressed', 'simulated'] as const;
export type Counts = Record<(typeof COUNT_KEYS)[number], number>;
const zeroCounts = (): Counts => Object.fromEntries(COUNT_KEYS.map(k => [k, 0])) as Counts;
const add = (into: Counts, from: Counts, sign = 1) => { for (const k of COUNT_KEYS) into[k] += sign * from[k]; return into; };
export const rates = (c: Counts) => ({
  delivery: rate(c.delivered, c.accepted), bounce: rate(c.hardBounced, c.accepted), complaint: rate(c.complained, c.accepted),
  // Opens and clicks over delivered; null when nothing was tracked (tracking off, or no engagement recorded at all).
  open: rate(c.opened, c.delivered, c.opened + c.clicked > 0), openHuman: rate(c.openedHuman, c.delivered, c.opened + c.clicked > 0), click: rate(c.clicked, c.delivered, c.opened + c.clicked > 0),
});
const bucketOf = (granularity: Granularity, column: SQL) => granularity === 'hour'
  ? sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24":00:00.000Z"')` : sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
// Real mail only: simulated mail is counted apart and never as evidence. Accepted: provider acceptance, as getMetrics.
const ACCEPTED = sql`e.status <> 'suppressed' AND (e.provider_id IS NOT NULL OR e.status IN ('accepted','sent','delivered','bounced','complained','delayed') OR e.event_outcomes & 1 <> 0)`;
const measures = sql`count(*) FILTER (WHERE NOT e.simulated)::int AS emails,
  count(*) FILTER (WHERE NOT e.simulated AND ${ACCEPTED})::int AS accepted,
  count(*) FILTER (WHERE NOT e.simulated AND (e.status = 'delivered' OR e.event_outcomes & 2 <> 0))::int AS delivered,
  count(*) FILTER (WHERE NOT e.simulated AND (e.status = 'bounced' OR e.event_outcomes & 4 <> 0))::int AS "hardBounced",
  count(*) FILTER (WHERE NOT e.simulated AND (e.status = 'delayed' OR e.event_outcomes & 128 <> 0))::int AS "softBounced",
  count(*) FILTER (WHERE NOT e.simulated AND (e.status = 'complained' OR e.event_outcomes & 8 <> 0))::int AS complained,
  count(*) FILTER (WHERE NOT e.simulated AND e.event_outcomes & 16 <> 0)::int AS opened,
  count(*) FILTER (WHERE NOT e.simulated AND h.email_id IS NOT NULL)::int AS "openedHuman",
  count(*) FILTER (WHERE NOT e.simulated AND e.event_outcomes & 32 <> 0)::int AS clicked,
  count(*) FILTER (WHERE NOT e.simulated AND e.status = 'rejected' AND e.error_code = ANY(${texts(SCREEN_CODES)}))::int AS "screenRejected",
  count(*) FILTER (WHERE NOT e.simulated AND e.status = 'suppressed')::int AS suppressed,
  count(*) FILTER (WHERE e.simulated)::int AS simulated`;
type GroupRow = Counts & { bucket: string; key: string };

/**
 * Created-cohort counts per bucket and group, each rate with its numerator and denominator. Groups are the 20 largest
 * by volume plus `other`; a provider group is a provider (gmail, microsoft…) or, for the rest, the recipient domain.
 */
export async function deliveryMetrics(db: DbExecutor, wid: string, q: MetricsQuery) {
  const filters = sql`e.workspace_id = ${wid} AND e.created_at >= ${q.since}::timestamptz AND e.created_at < ${q.until}::timestamptz
    ${q.campaignId ? sql`AND e.campaign_id = ${q.campaignId}` : sql``} ${q.fromDomain ? sql`AND ${fromDomainIs(q.fromDomain)}` : sql``}`;
  // Providers are classified per recipient domain, not per email: the rows are grouped by domain first.
  const key = q.groupBy === 'campaign' ? sql`coalesce(e.campaign_id, '')` : q.groupBy === 'from_domain' ? fromDomainOf : q.groupBy === 'provider' ? recipientDomain : sql`''`;
  const keyOf = q.groupBy === 'provider' ? sql`coalesce(nullif(${providerSql(sql`raw.key`)}, 'other'), raw.key)` : sql`raw.key`;
  // Opens that SES did not flag as a bot or a privacy proxy (isBotEvent true or Likely), once per email.
  const human = sql`human AS MATERIALIZED (SELECT DISTINCT email_id FROM sending_email_events WHERE workspace_id = ${wid} AND created_at >= ${q.since}::timestamptz
    AND type = 'open' AND NOT simulated AND coalesce(data->>'isBotEvent', 'Unknown') NOT IN ('true', 'Likely'))`;
  const arm = (kind: 'transactional' | 'marketing' | null) => sql`SELECT ${bucketOf(q.granularity, sql`e.created_at`)} AS bucket, ${key} AS key, ${measures}
    FROM sending_emails e LEFT JOIN human h ON h.email_id = e.id WHERE ${filters} ${kind ? sql`AND (e.snapshot->>'kind') = ${kind}` : sql``} GROUP BY 1, 2`;
  // A stream reads sending_emails_kind_created; per-stream groups are the whole window minus marketing (every email
  // is created as exactly one kind), so neither arm detoasts snapshot for its kind.
  const sums = sql.join(COUNT_KEYS.map(k => sql`sum(${sql.identifier(k)})::int AS ${sql.identifier(k)}`), sql`, `);
  const grouped = async (kind: 'transactional' | 'marketing' | null) => (await db.execute<GroupRow>(sql`WITH ${human}, raw AS (${arm(kind)}),
      mail AS (SELECT raw.bucket, coalesce(${keyOf}, '') AS key, ${sums} FROM raw GROUP BY 1, 2),
      ranked AS (SELECT key, row_number() OVER (ORDER BY sum(emails + simulated) DESC, key) AS rank FROM mail GROUP BY key)
    SELECT m.bucket, CASE WHEN r.rank <= ${LIMITS.groups} THEN m.key ELSE '~other' END AS key,
      ${sums} FROM mail m JOIN ranked r USING (key) GROUP BY 1, 2 ORDER BY 1, 2`)).rows;
  const kind = q.stream === 'all' ? null : q.stream;
  let rows: GroupRow[];
  if (q.groupBy === 'stream') {
    const all = await grouped(kind), marketing = kind === 'transactional' ? [] : kind === 'marketing' ? all : await grouped('marketing');
    rows = [];
    for (const row of all) {
      const m = marketing.find(x => x.bucket === row.bucket) ?? { ...zeroCounts(), bucket: row.bucket, key: '' };
      if (kind !== 'transactional') rows.push({ ...m, key: 'marketing' });
      if (kind !== 'marketing') rows.push({ ...add({ ...row }, m, -1), bucket: row.bucket, key: 'transactional' });
    }
  } else rows = await grouped(kind);

  const unit = q.granularity === 'hour' ? 'hour' : 'day';
  const { rows: extras } = await db.execute<{ bucket: string; unsubscribed: number; screened: number; rejected: number }>(sql`SELECT bucket, sum(unsubscribed)::int AS unsubscribed,
      sum(screened)::int AS screened, sum(rejected)::int AS rejected FROM (
      SELECT ${bucketOf(q.granularity, sql`occurred_at`)} AS bucket, 1 AS unsubscribed, 0 AS screened, 0 AS rejected FROM audience_consent_audit
        WHERE workspace_id = ${wid} AND status = 'unsubscribed' AND source IN ('footer-confirm', 'rfc8058-post', 'ses-subscription')
          AND occurred_at >= ${q.since}::timestamptz AND occurred_at < ${q.until}::timestamptz
      UNION ALL SELECT ${bucketOf(q.granularity, sql`hour`)}, 0, screened, rejected FROM hosted_screen_hourly
        WHERE workspace_id = ${wid} AND hour >= date_trunc(${unit}, ${q.since}::timestamptz, 'UTC') AND hour < ${q.until}::timestamptz) x GROUP BY 1 ORDER BY 1`);

  const buckets = new Map<string, Counts & { unsubscribed: number }>();
  for (const at of new Set([...rows.map(r => r.bucket), ...extras.map(e => e.bucket)])) buckets.set(at, { ...zeroCounts(), unsubscribed: 0 });
  for (const row of rows) add(buckets.get(row.bucket)!, row);
  for (const e of extras) buckets.get(e.bucket)!.unsubscribed = e.unsubscribed;
  const series = [...buckets].sort(([a], [b]) => a < b ? -1 : 1).map(([at, c]) => ({ at, ...c }));
  const totals = series.reduce((sum, b) => { add(sum, b); sum.unsubscribed += b.unsubscribed; return sum; }, { ...zeroCounts(), unsubscribed: 0 });
  const screen = extras.reduce((s, e) => ({ screened: s.screened + e.screened, rejected: s.rejected + e.rejected }), { screened: 0, rejected: 0 });

  const groups = q.groupBy === 'none' ? null : [...rows.reduce((map, row) => {
    const g = map.get(row.key) ?? { key: row.key, totals: zeroCounts(), buckets: [] as ({ at: string } & Counts)[] };
    add(g.totals, row); if (row.emails + row.simulated > 0) g.buckets.push({ at: row.bucket, ...Object.fromEntries(COUNT_KEYS.map(k => [k, row[k]])) as Counts });
    return map.set(row.key, g);
  }, new Map<string, { key: string; totals: Counts; buckets: ({ at: string } & Counts)[] }>()).values()]
    .sort((a, b) => (a.key === '~other' ? 1 : 0) - (b.key === '~other' ? 1 : 0) || b.totals.emails - a.totals.emails)
    // A provider group is a provider, or a recipient domain outside the map (its provider is other).
    .map(g => ({ key: g.key === '~other' ? 'other' : g.key, other: g.key === '~other', provider: q.groupBy === 'provider' ? (PROVIDER_NAMES.includes(g.key as Provider) ? g.key as Provider : 'other' as const) : null,
      ...g.totals, rates: rates(g.totals), buckets: g.buckets }));

  const findings: Finding[] = [...rateFindings(totals, null)];
  for (const g of groups ?? []) if (!g.other) findings.push(...rateFindings(g, `${q.groupBy === 'campaign' && !g.key ? '(no campaign)' : g.key}`).filter(f => f.severity !== 'notice' || q.groupBy === 'provider'));
  if (q.granularity === 'day') findings.push(...spikeFindings(series, null));
  if (q.groupBy === 'provider' && groups) findings.push(...openDropFindings(groups));
  return { totals: { ...totals, rates: rates(totals) }, buckets: series, groups, screen, findings: byImpact(dedupe(findings)) };
}
const dedupe = (list: Finding[]) => list.filter((f, i) => list.findIndex(o => o.code === f.code && o.scope === f.scope) === i);
/** Opens fall by more than 40% at one provider between the window's halves while the others hold (within 20%). */
function openDropFindings(groups: { key: string; other: boolean; buckets: ({ at: string } & Counts)[] }[]): Finding[] {
  const halves = (list: ({ at: string } & Counts)[], cut: string) => {
    const sum = (part: typeof list) => part.reduce((s, b) => ({ opened: s.opened + b.opened, delivered: s.delivered + b.delivered }), { opened: 0, delivered: 0 });
    return [sum(list.filter(b => b.at < cut)), sum(list.filter(b => b.at >= cut))] as const;
  };
  const all = groups.flatMap(g => g.buckets.map(b => b.at)).sort();
  if (all.length < 2) return [];
  const cut = all[Math.floor(all.length / 2)]!, out: Finding[] = [];
  const stats = groups.filter(g => !g.other).map(g => { const [a, b] = halves(g.buckets, cut); return { key: g.key, a, b, before: a.delivered >= 100 ? a.opened / a.delivered : null, after: b.delivered >= 100 ? b.opened / b.delivered : null }; });
  for (const s of stats) {
    if (s.before === null || s.after === null || s.before === 0) continue;
    const drop = 1 - s.after / s.before;
    const others = stats.filter(o => o !== s && o.before !== null && o.after !== null && o.before > 0);
    if (drop > THRESHOLDS.openDrop && others.length && others.every(o => 1 - o.after! / o.before! < 0.2))
      out.push({ severity: 'serious', code: 'OPEN_RATE_DROP_ONE_PROVIDER', scope: s.key, evidence: { before: Math.round(s.before * 1e4) / 1e4, after: Math.round(s.after * 1e4) / 1e4, drop: Math.round(drop * 1e3) / 1e3, deliveredBefore: s.a.delivered, deliveredAfter: s.b.delivered },
        message: `Opens at ${s.key} fell from ${pct(s.before)} to ${pct(s.after)} of delivered mail while other providers held. That usually means spam-folder placement there: check complaints and authentication at ${s.key}. Opens are noisy (Apple Mail Privacy Protection); clicks are a firmer signal.` });
  }
  return out;
}

// ---------- 2. bounce reasons ----------
export type BounceQuery = { since: string; until: string; provider?: Provider; campaignId?: string; fromDomain?: string; type?: 'bounce' | 'deferral' | 'complaint' };
const EVENT_CLASS = sql`CASE WHEN v.type IN ('bounce', 'validation_suppressed') THEN 'bounce' WHEN v.type = 'non_permanent_bounce' THEN 'soft_bounce'
  WHEN v.type = 'delivery_delay' THEN 'deferral' ELSE 'complaint' END`;
const TYPES: Record<NonNullable<BounceQuery['type']>, string[]> = { bounce: ['bounce', 'validation_suppressed', 'non_permanent_bounce'], deferral: ['delivery_delay'], complaint: ['complaint', 'complaint_feedback'] };
// What a feedback event says about why: SES's bounce type and subtype, the enhanced status code and the diagnostic, where
// the event recorded them (today's events keep the type and subtype; status and diagnostic are read when present).
const diagnostic = sql`coalesce(v.data->>'diagnosticCode', v.data #>> '{bounce,bouncedRecipients,0,diagnosticCode}', v.data #>> '{deliveryDelay,delayedRecipients,0,diagnosticCode}')`;
const enhanced = sql`coalesce(v.data->>'status', v.data #>> '{bounce,bouncedRecipients,0,status}', v.data #>> '{deliveryDelay,delayedRecipients,0,status}', substring(${diagnostic} from '[245]\\.[0-9]{1,3}\\.[0-9]{1,3}'))`;

/** Feedback grouped provider → class → subtype → enhanced status → redacted diagnostic, and the first-send bounce rate. */
export async function bounceReasons(db: DbExecutor, wid: string, q: BounceQuery) {
  const types = q.type ? TYPES[q.type] : Object.values(TYPES).flat();
  const mail = sql`e.workspace_id = ${wid} ${q.campaignId ? sql`AND e.campaign_id = ${q.campaignId}` : sql``} ${q.fromDomain ? sql`AND ${fromDomainIs(q.fromDomain)}` : sql``}`;
  const provider = providerSql(recipientDomain);
  const { rows } = await db.execute<{ provider: Provider; domain: string | null; class: 'bounce' | 'soft_bounce' | 'deferral' | 'complaint'; subtype: string; status: string | null; diagnostic: string | null; count: number; first: string; last: string; campaigns: string[] | null; feedback: string | null }>(sql`WITH v AS (
      SELECT v.type, v.email_id, v.created_at, v.data FROM sending_email_events v WHERE v.workspace_id = ${wid} AND v.created_at >= ${q.since}::timestamptz
        AND v.created_at < ${q.until}::timestamptz AND NOT v.simulated AND v.type = ANY(${texts(types)}) LIMIT 100000
    ), f AS (
      SELECT ${provider} AS provider, ${recipientDomain} AS domain, ${EVENT_CLASS} AS class,
        CASE WHEN v.type IN ('complaint', 'complaint_feedback') THEN coalesce(v.data->>'complaintFeedbackType', 'unspecified')
          WHEN v.type = 'delivery_delay' THEN coalesce(v.data->>'delayType', v.data #>> '{deliveryDelay,delayType}', 'Unspecified')
          ELSE coalesce(v.data->>'bounceType', 'Unknown') || '/' || coalesce(v.data->>'bounceSubType', 'Unknown') END AS subtype,
        ${enhanced} AS status, ${redactedSql(diagnostic)} AS diagnostic, v.created_at, e.campaign_id
      FROM v JOIN sending_emails e ON e.workspace_id = ${wid} AND e.id = v.email_id WHERE ${mail}
    ), g AS (
      SELECT provider, CASE WHEN provider = 'other' THEN domain END AS domain, class, subtype, status, diagnostic, campaign_id, count(*)::int AS n, min(created_at) AS first, max(created_at) AS last
      FROM f ${q.provider ? sql`WHERE provider = ${q.provider}` : sql``} GROUP BY 1, 2, 3, 4, 5, 6, 7
    ) SELECT provider, domain, class, subtype, status, diagnostic, sum(n)::int AS count, min(first)::text AS first, max(last)::text AS last,
      (array_agg(campaign_id ORDER BY n DESC) FILTER (WHERE campaign_id IS NOT NULL))[1:3] AS campaigns
    FROM g GROUP BY 1, 2, 3, 4, 5, 6 ORDER BY count DESC, provider, class LIMIT ${LIMITS.rows + 200}`);
  const kept = rows.slice(0, LIMITS.rows), rest = rows.slice(LIMITS.rows);
  const groups = kept.map(r => ({ provider: r.provider, domain: r.domain, class: r.class, subtype: r.subtype, status: r.status, diagnostic: redactDiagnostic(r.diagnostic), count: r.count,
    firstSeen: new Date(r.first).toISOString(), lastSeen: new Date(r.last).toISOString(), campaigns: [...new Set(r.campaigns ?? [])].slice(0, 3) }));
  const other = rest.length ? { groups: rest.length, count: rest.reduce((s, r) => s + r.count, 0) } : null;
  // First sends: campaign mail, the sender score's definition of mail to recipients not mailed before (hygiene factor).
  const { rows: [first] } = await db.execute<{ sends: number; bounced: number }>(sql`SELECT count(*) FILTER (WHERE ${ACCEPTED})::int AS sends,
      count(*) FILTER (WHERE e.status = 'bounced' OR e.event_outcomes & 4 <> 0)::int AS bounced
    FROM sending_emails e WHERE ${mail} AND e.created_at >= ${q.since}::timestamptz AND e.created_at < ${q.until}::timestamptz AND NOT e.simulated AND e.campaign_id IS NOT NULL`);
  const firstSend = { basis: 'Campaign mail, which the sender score counts as first sends (recipients not mailed before).', ...rate(first?.bounced ?? 0, first?.sends ?? 0) };
  const complaints = Object.entries(groups.filter(g => g.class === 'complaint').reduce<Record<string, number>>((m, g) => ({ ...m, [g.subtype]: (m[g.subtype] ?? 0) + g.count }), {})).map(([feedbackType, count]) => ({ feedbackType, count }));
  // Deliveries per provider, the throttling finding's denominator: only when a group looks like throttling.
  const delivered: Record<string, number> = {};
  if (groups.some(g => (g.class === 'deferral' || g.class === 'soft_bounce') && THROTTLE.test(`${g.status ?? ''} ${g.diagnostic ?? ''}`))) {
    const { rows } = await db.execute<{ provider: string; n: number }>(sql`SELECT ${providerSql(sql`x.domain`)} AS provider, sum(x.n)::int AS n FROM (SELECT ${recipientDomain} AS domain, count(*) AS n
      FROM sending_emails e WHERE ${mail} AND e.created_at >= ${q.since}::timestamptz AND e.created_at < ${q.until}::timestamptz AND NOT e.simulated AND (e.status = 'delivered' OR e.event_outcomes & 2 <> 0) GROUP BY 1) x GROUP BY 1`);
    for (const r of rows) delivered[r.provider] = r.n;
  }
  return { groups, other, complaints, firstSend, findings: byImpact(bounceFindings(groups, firstSend, delivered)) };
}
const AUTH_CODES = /\b5\.7\.(?:26|509|515)\b|5\.7\.1\b.*unauthenticated/i, THROTTLE = /\b4\.7\.(?:28|650)\b|TSS04|\b421\b.*4\.7\.0/i;
function bounceFindings(groups: { provider: Provider; class: string; status: string | null; diagnostic: string | null; count: number }[], first: Rate, delivered: Record<string, number>): Finding[] {
  const out: Finding[] = [], said = (g: (typeof groups)[number]) => `${g.status ?? ''} ${g.diagnostic ?? ''}`;
  const auth = groups.filter(g => g.class === 'bounce' && AUTH_CODES.test(said(g)));
  for (const provider of new Set(auth.map(g => g.provider))) {
    const n = auth.filter(g => g.provider === provider).reduce((s, g) => s + g.count, 0);
    out.push({ severity: 'serious', code: 'AUTHENTICATION_REJECTED', scope: provider, evidence: { bounced: n },
      message: `${num(n)} emails to ${provider} bounced for authentication (5.7.26, 5.7.509, 5.7.515 or unauthenticated 5.7.1): DMARC or alignment fails, or bulk-sender requirements are not met. Check the sending domain’s health and fix DMARC or alignment.` });
  }
  const throttled = groups.filter(g => (g.class === 'deferral' || g.class === 'soft_bounce') && THROTTLE.test(said(g)));
  for (const provider of new Set(throttled.map(g => g.provider))) {
    const n = throttled.filter(g => g.provider === provider).reduce((s, g) => s + g.count, 0), d = delivered[provider] ?? 0;
    if (d > 0 && n / d > THRESHOLDS.throttling) out.push({ severity: 'serious', code: 'PROVIDER_THROTTLING', scope: provider, evidence: { deferred: n, delivered: d, rate: n / d, threshold: THRESHOLDS.throttling },
      message: `${provider} deferred ${num(n)} emails for rate or reputation (4.7.28, TSS04, 4.7.650-style) against ${num(d)} delivered (${pct(n / d)}). Slow down, warm up, and drop unengaged recipients.` });
  }
  if (first.value !== null && first.numerator >= THRESHOLDS.minimumEvents && first.value > THRESHOLDS.firstSendBounce)
    out.push({ severity: 'serious', code: 'FIRST_SEND_BOUNCES', scope: null, evidence: { bounced: first.numerator, sends: first.denominator, rate: first.value, threshold: THRESHOLDS.firstSendBounce },
      message: `${num(first.numerator)} of ${num(first.denominator)} first sends (campaign mail) hard-bounced (${pct(first.value)}). Above 3% points at the source of a recent import: stop mailing it and check where it came from.` });
  return out;
}

// ---------- 3. domain health ----------
export type DomainRow = { id: string; workspace_id: string; name: string; region: string | null; created_at: string | null; claim: Record<string, unknown> | null; connection: { kind: string; region: string } | null };
/** Volume and streams of one From domain over the retained 30 days (exact domain, not its subdomains). */
export async function domainActivity(db: DbExecutor, wid: string, domain: string) {
  const since = new Date(Date.now() - LIMITS.windowDays * DAY_MS).toISOString(), mine = sql`e.workspace_id = ${wid} AND ${fromDomainIs(domain)} AND e.created_at >= ${since}::timestamptz AND NOT e.simulated`;
  const { rows: days } = await db.execute<{ at: string; emails: number; accepted: number; campaign: number }>(sql`SELECT ${bucketOf('day', sql`e.created_at`)} AS at, count(*)::int AS emails,
      count(*) FILTER (WHERE ${ACCEPTED})::int AS accepted, count(*) FILTER (WHERE e.campaign_id IS NOT NULL)::int AS campaign
    FROM sending_emails e WHERE ${mine} GROUP BY 1 ORDER BY 1`);
  // Marketing sent through the API: the kind index, then this domain (from_address is a plain column).
  const { rows: [kinds] } = await db.execute<{ marketing: number }>(sql`SELECT count(*)::int AS marketing FROM sending_emails e WHERE e.workspace_id = ${wid}
    AND (e.snapshot->>'kind') = 'marketing' AND e.created_at >= ${since}::timestamptz AND NOT e.simulated AND ${fromDomainIs(domain)} AND e.campaign_id IS NULL`);
  // Bulk through the transactional path: one subject to more than 500 recipients a day with no campaign.
  const { rows: bulk } = await db.execute<{ day: string; subject: string; emails: number }>(sql`SELECT ${bucketOf('day', sql`e.created_at`)} AS day, left(e.subject, ${LIMITS.subject}) AS subject, count(*)::int AS emails
    FROM sending_emails e WHERE ${mine} AND e.campaign_id IS NULL GROUP BY 1, 2 HAVING count(*) > ${THRESHOLDS.bulkSubject} ORDER BY 3 DESC LIMIT 10`);
  const { rows: [firstSend] } = await db.execute<{ at: string | null }>(sql`SELECT min(e.created_at)::text AS at FROM sending_emails e WHERE ${mine}`);
  return { days, marketingApi: kinds?.marketing ?? 0, bulk, firstSendAt: firstSend?.at ? new Date(firstSend.at).toISOString() : null };
}

type Spf = { record: string | null; records: number; includesAmazonSes: boolean; lookups: number; all: string | null };
type DmarcTags = { record: string | null; source: 'live' | 'stored' | null; at: string | null; p: string | null; sp: string | null; pct: number | null; adkim: string; aspf: string; rua: boolean; ruf: boolean; valid: boolean };
export type LiveDns = { checkedAt: string; complete: boolean; spf: Spf; dmarc: DmarcTags; bimi: { record: string | null; logo: boolean; authority: boolean }; mailFrom: { domain: string; mx: string[]; mxExpected: string; spf: Spf } | null };
const unquote = (s: string) => s.replace(/^"|"$/g, '').replace(/"\s*"/g, '');
export function parseSpf(values: string[]): Spf {
  const records = values.map(unquote).filter(v => /^v=spf1(?:\s|$)/i.test(v)), record = records.length === 1 ? records[0]! : null;
  const terms = record?.split(/\s+/).slice(1) ?? [];
  return { record: records.length ? records.join('\n').slice(0, 500) : null, records: records.length, includesAmazonSes: terms.some(t => /^[+~?-]?include:amazonses\.com$/i.test(t)),
    lookups: terms.filter(t => /^[+~?-]?(?:include:|a(?:[:/]|$)|mx(?:[:/]|$)|ptr|exists:)|^redirect=/i.test(t)).length, all: terms.find(t => /^[+~?-]?all$/i.test(t))?.replace(/^\+/, '') ?? null };
}
export function parseTags(record: string) {
  const tags = new Map<string, string>();
  for (const field of record.trim().replace(/;$/, '').split(';')) { const m = /^\s*([a-z][a-z0-9_-]*)\s*=\s*(.*?)\s*$/i.exec(field); if (m && !tags.has(m[1]!.toLowerCase())) tags.set(m[1]!.toLowerCase(), m[2]!); }
  return tags;
}
export function parseDmarc(record: string | null, source: DmarcTags['source'], at: string | null = null): DmarcTags {
  const tags = record ? parseTags(record) : new Map<string, string>();
  const pctTag = tags.get('pct');
  return { record: record?.slice(0, 500) ?? null, source: record ? source : null, at: record ? at : null, p: tags.get('p')?.toLowerCase() ?? null, sp: tags.get('sp')?.toLowerCase() ?? null,
    pct: pctTag !== undefined && /^\d{1,3}$/.test(pctTag) ? Number(pctTag) : record ? 100 : null, adkim: tags.get('adkim')?.toLowerCase() ?? 'r', aspf: tags.get('aspf')?.toLowerCase() ?? 'r',
    rua: !!tags.get('rua'), ruf: !!tags.get('ruf'), valid: !!record && tags.get('v') === 'DMARC1' && ['none', 'quarantine', 'reject'].includes(tags.get('p')?.toLowerCase() ?? '') };
}

const dnsCache = new Map<string, { until: number; value: LiveDns }>();
/**
 * One budgeted read of the domain's public records through Bane's DNS-over-HTTPS reader (src/public-dns.ts): five
 * labels at most (the domain's SPF, _dmarc, default._bimi, and the MAIL FROM's MX and SPF), 3 seconds in all, cached
 * 5 minutes. A label that did not answer in time is reported as missing with complete=false. DMARC falls back to the
 * stored observation (which follows the organizational domain) when the exact label has none.
 */
export async function liveDns(domain: string, mailFrom: { domain: string; region: string } | null, stored: { record: string | null; checkedAt: number | null } | null): Promise<LiveDns> {
  const key = `${domain}|${mailFrom?.domain ?? ''}|${mailFrom?.region ?? ''}`, hit = dnsCache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const { dns } = await import('./public-dns.js');
  const signal = AbortSignal.timeout(3000);
  let complete = true;
  const read = (name: string, type: 'TXT' | 'MX') => dns(name, type, signal).then(r => r.values, () => { complete = false; return [] as string[]; });
  const [root, dmarc, bimi, mx, bounce] = await Promise.all([read(domain, 'TXT'), read(`_dmarc.${domain}`, 'TXT'), read(`default._bimi.${domain}`, 'TXT'),
    mailFrom ? read(mailFrom.domain, 'MX') : Promise.resolve([]), mailFrom ? read(mailFrom.domain, 'TXT') : Promise.resolve([])]);
  const dmarcRecord = dmarc.map(unquote).find(v => /^v\s*=\s*DMARC1/i.test(v)) ?? null;
  const bimiRecord = bimi.map(unquote).find(v => /^v\s*=\s*BIMI1/i.test(v)) ?? null, bimiTags = bimiRecord ? parseTags(bimiRecord) : new Map<string, string>();
  const value: LiveDns = { checkedAt: new Date().toISOString(), complete, spf: parseSpf(root),
    dmarc: dmarcRecord ? parseDmarc(dmarcRecord, 'live') : parseDmarc(stored?.record ?? null, 'stored', stored?.checkedAt ? new Date(stored.checkedAt).toISOString() : null),
    bimi: { record: bimiRecord?.slice(0, 500) ?? null, logo: !!bimiTags.get('l'), authority: !!bimiTags.get('a') },
    mailFrom: mailFrom ? { domain: mailFrom.domain, mx: mx.map(v => v.trim().split(/\s+/).pop()!.replace(/\.$/, '').toLowerCase()).slice(0, 10), mxExpected: `feedback-smtp.${mailFrom.region}.amazonses.com`, spf: parseSpf(bounce) } : null };
  if (dnsCache.size >= 500) dnsCache.delete(dnsCache.keys().next().value!);
  dnsCache.set(key, { until: Date.now() + (complete ? 300_000 : 30_000), value });
  return value;
}

/** DKIM d= is the From domain when SES Easy DKIM signs for it; SPF aligns when the verified MAIL FROM shares its organizational domain. */
export async function alignment(domain: string, claim: { dkim: string | null; signing: boolean; mailFrom: string | null; mailFromStatus: string | null }, aspf: string) {
  const dkim = claim.dkim === 'SUCCESS' && claim.signing;
  let spf = false;
  if (claim.mailFrom && claim.mailFromStatus === 'SUCCESS') {
    const bounce = claim.mailFrom.toLowerCase();
    if (bounce === domain) spf = true;
    else if (aspf !== 's') { const { placementRoot } = await import('./domain-registry.js'); const [a, b] = await Promise.all([placementRoot(domain), placementRoot(bounce)]); spf = !!a.root && a.root === b.root; }
  }
  return { dkim, spf, dmarcPasses: dkim || spf, verdict: dkim && spf ? 'aligned' : dkim ? 'dkim_only' : spf ? 'spf_only' : 'unaligned', returnPath: claim.mailFrom && claim.mailFromStatus === 'SUCCESS' ? claim.mailFrom : 'amazonses.com' } as const;
}

export function domainFindings(name: string, d: { dns: LiveDns | null; align: Awaited<ReturnType<typeof alignment>>; days: { at: string; accepted: number }[]; ageDays: number | null; bulk: { day: string; subject: string; emails: number }[]; marketingApi: number }): Finding[] {
  const out: Finding[] = [], dm = d.dns?.dmarc;
  if (!d.align.dmarcPasses) out.push({ severity: 'critical', code: 'DMARC_UNALIGNED', scope: name, evidence: {}, message: `Mail from ${name} aligns neither DKIM nor SPF with the From domain, so it fails DMARC. Finish DKIM verification for ${name} in Bane (Domains), or verify a custom MAIL FROM under it.` });
  if (d.dns && !dm?.record) out.push({ severity: 'serious', code: 'DMARC_MISSING', scope: name, evidence: {}, message: `${name} publishes no DMARC record. Gmail, Yahoo and Outlook require one from bulk senders: add a TXT at _dmarc.${name}: v=DMARC1; p=none; rua=mailto:dmarc@${name}` });
  else if (dm?.record && !dm.valid) out.push({ severity: 'serious', code: 'DMARC_INVALID', scope: name, evidence: {}, message: `The DMARC record for ${name} does not parse (it needs v=DMARC1 first and a p= of none, quarantine or reject).` });
  else if (dm?.p === 'none' && !dm.rua) out.push({ severity: 'notice', code: 'DMARC_NO_REPORTS', scope: name, evidence: {}, message: `DMARC for ${name} is p=none with no rua: nobody receives reports. Add rua=mailto:… and move to p=quarantine once mail aligns.` });
  const enforced = !!dm && (dm.p === 'quarantine' || dm.p === 'reject') && (dm.pct ?? 100) === 100;
  if (d.dns?.bimi.record && (!enforced || !d.dns.bimi.authority)) out.push({ severity: 'notice', code: 'BIMI_NOT_READY', scope: name, evidence: { dmarcPct: dm?.pct ?? 0 },
    message: `${name} publishes BIMI, but ${!enforced ? 'DMARC is not at enforcement (BIMI needs p=quarantine or reject at pct=100)' : 'it has no a= (Gmail shows a logo only with a VMC or CMC)'}.` });
  const spf = d.dns?.mailFrom?.spf ?? null;
  if (d.dns?.mailFrom && d.dns.complete && !spf?.includesAmazonSes) out.push({ severity: 'serious', code: 'MAIL_FROM_SPF_MISSING', scope: d.dns.mailFrom.domain, evidence: {}, message: `The MAIL FROM ${d.dns.mailFrom.domain} has no SPF record including amazonses.com: add TXT v=spf1 include:amazonses.com ~all there.` });
  if (d.dns?.mailFrom && d.dns.complete && !d.dns.mailFrom.mx.includes(d.dns.mailFrom.mxExpected)) out.push({ severity: 'serious', code: 'MAIL_FROM_MX_MISSING', scope: d.dns.mailFrom.domain, evidence: {}, message: `The MAIL FROM ${d.dns.mailFrom.domain} needs an MX record to ${d.dns.mailFrom.mxExpected} (priority 10), or SES falls back to amazonses.com and SPF no longer aligns.` });
  for (const s of [d.dns?.spf, spf]) if (s && s.lookups > 10) out.push({ severity: 'serious', code: 'SPF_TOO_MANY_LOOKUPS', scope: name, evidence: { lookups: s.lookups }, message: `An SPF record for ${name} needs ${s.lookups} DNS lookups; receivers give up after 10 (permerror). Flatten or remove includes.` });
  const peak = d.days.reduce((m, x) => Math.max(m, x.accepted), 0);
  if (d.ageDays !== null && d.ageDays < THRESHOLDS.newDomainDays && peak > THRESHOLDS.newDomainDaily) out.push({ severity: 'serious', code: 'WARMUP_TOO_FAST', scope: name, evidence: { ageDays: d.ageDays, peakDaily: peak, threshold: THRESHOLDS.newDomainDaily },
    message: `${name} started sending ${d.ageDays} days ago and already peaked at ${num(peak)} a day. New domains should ramp: about 2,000 a day the first week, doubling weekly, starting with engaged contacts.` });
  out.push(...spikeFindings(d.days, name));
  for (const b of d.bulk.slice(0, 3)) out.push({ severity: 'notice', code: 'MARKETING_VIA_TRANSACTIONAL', scope: name, evidence: { emails: b.emails, threshold: THRESHOLDS.bulkSubject },
    message: `On ${b.day}, ${num(b.emails)} emails from ${name} shared the subject "${b.subject}" without a campaign. Bulk mail sent as transactional has no one-click unsubscribe: send it as a campaign or with kind=marketing.` });
  return byImpact(out);
}

// ---------- 4. screen ----------
export async function screenActivity(db: DbExecutor, wid: string, since: string) {
  const { rows: hours } = await db.execute<{ at: string; screened: number; rejected: number }>(sql`SELECT ${bucketOf('hour', sql`hour`)} AS at, sum(screened)::int AS screened, sum(rejected)::int AS rejected
    FROM hosted_screen_hourly WHERE workspace_id = ${wid} AND hour >= date_trunc('hour', ${since}::timestamptz, 'UTC') GROUP BY 1 ORDER BY 1`);
  // The operator timeline's query (src/operator.ts), for every screen refusal: the reject event carries the spam score.
  const { rows: rejections } = await db.execute<{ emailId: string; campaignId: string | null; at: string; subject: string; errorCode: string; spamScore: number | null; model: string | null }>(sql`SELECT e.id AS "emailId",
      e.campaign_id AS "campaignId", e.created_at::text AS at, left(e.subject, ${LIMITS.subject}) AS subject, e.error_code AS "errorCode",
      (v.data #>> '{screen,spam}')::float8 AS "spamScore", v.data #>> '{screen,model}' AS model
    FROM sending_emails e LEFT JOIN LATERAL (SELECT data FROM sending_email_events WHERE workspace_id = e.workspace_id AND email_id = e.id AND type = 'reject' ORDER BY created_at DESC LIMIT 1) v ON true
    WHERE e.workspace_id = ${wid} AND e.created_at >= ${since}::timestamptz AND e.status = 'rejected' AND e.error_code = ANY(${texts(SCREEN_CODES)})
    ORDER BY e.created_at DESC, e.id DESC LIMIT ${LIMITS.rows}`);
  const totals = hours.reduce((s, h) => ({ screened: s.screened + h.screened, rejected: s.rejected + h.rejected }), { screened: 0, rejected: 0 });
  const byCode = rejections.reduce<Record<string, number>>((m, r) => ({ ...m, [r.errorCode]: (m[r.errorCode] ?? 0) + 1 }), {});
  return { hours, totals: { ...totals, rate: rate(totals.rejected, totals.screened) }, rejections: rejections.map(r => ({ ...r, at: new Date(r.at).toISOString() })), byCode };
}

// ---------- 5. audience health ----------
const ROLE = ['admin', 'administrator', 'billing', 'contact', 'hello', 'help', 'hr', 'info', 'jobs', 'mail', 'marketing', 'media', 'news', 'newsletter', 'noreply', 'no-reply', 'office', 'postmaster', 'press', 'sales', 'support', 'team', 'webmaster'];
const FREE = ['gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.net', 'gmx.de', 'web.de', 'mail.com', 'yandex.com', 'yandex.ru', 'zoho.com', 'qq.com', '163.com'];
const TYPOS = ['gmial.com', 'gmai.com', 'gmal.com', 'gmaill.com', 'gnail.com', 'gmail.co', 'gmail.con', 'gmail.cm', 'gamil.com', 'hotmial.com', 'hotmal.com', 'hotmai.com', 'hotmail.co', 'hotmail.con', 'yaho.com', 'yahooo.com', 'yahoo.co', 'yahoo.con', 'outlok.com', 'outloo.com', 'outlook.co', 'outlook.con', 'iclod.com', 'icloud.co', 'aol.co'];
const local = sql`lower(split_part(c.email, '@', 1))`, cdomain = sql`lower(split_part(c.email, '@', 2))`;
const audienceMeasures = sql`count(*)::int AS contacts,
  count(*) FILTER (WHERE c.marketing_consent = 'subscribed')::int AS subscribed, count(*) FILTER (WHERE c.marketing_consent = 'unknown')::int AS unknown,
  count(*) FILTER (WHERE c.marketing_consent = 'unsubscribed')::int AS unsubscribed, count(*) FILTER (WHERE c.suppressed)::int AS suppressed,
  count(*) FILTER (WHERE c.last_click_at >= now() - interval '30 days')::int AS clicked30, count(*) FILTER (WHERE c.last_click_at >= now() - interval '90 days')::int AS clicked90,
  count(*) FILTER (WHERE c.last_click_at >= now() - interval '180 days')::int AS clicked180,
  count(*) FILTER (WHERE c.observed_since < now() - interval '180 days' AND coalesce(greatest(c.last_open_at, c.last_click_at), '-infinity') < now() - interval '180 days')::int AS stale,
  count(*) FILTER (WHERE c.observed_since IS NULL)::int AS "neverObserved",
  count(*) FILTER (WHERE ${local} = ANY(${texts(ROLE)}))::int AS role, count(*) FILTER (WHERE ${cdomain} = ANY(${texts(FREE)}))::int AS "freeMail",
  count(*) FILTER (WHERE ${cdomain} = ANY(${texts(TYPOS)}))::int AS "typoDomains"`;
type AudienceRow = { contacts: number; subscribed: number; unknown: number; unsubscribed: number; suppressed: number; clicked30: number; clicked90: number; clicked180: number; stale: number; neverObserved: number; role: number; freeMail: number; typoDomains: number };
/** Counts per list (the 20 largest, or one) and for the whole audience, imports of the last 90 days; never an address. */
export async function audienceHealth(db: DbExecutor, wid: string, listId?: string) {
  // Three statements per scope (counts, suppression reasons, providers), each grouped by list: never one per list.
  const views = async (group: SQL, from: SQL) => {
    const { rows } = await db.execute<AudienceRow & { g: string }>(sql`SELECT ${group} AS g, ${audienceMeasures} FROM ${from} GROUP BY 1`);
    const { rows: reasons } = await db.execute<{ g: string; reason: string; n: number }>(sql`SELECT ${group} AS g, coalesce(c.suppression_reason, 'unspecified') AS reason, count(*)::int AS n FROM ${from} AND c.suppressed GROUP BY 1, 2`);
    const { rows: providers } = await db.execute<{ g: string; provider: Provider; n: number }>(sql`SELECT x.g, ${providerSql(sql`x.domain`)} AS provider, sum(x.n)::int AS n
      FROM (SELECT ${group} AS g, ${cdomain} AS domain, count(*) AS n FROM ${from} GROUP BY 1, 2) x GROUP BY 1, 2`);
    return new Map(rows.map(({ g, ...counts }) => [g, { ...counts,
      suppressedBy: Object.fromEntries(reasons.filter(r => r.g === g).sort((a, b) => b.n - a.n).slice(0, 10).map(r => [r.reason, r.n])),
      providers: Object.fromEntries(providers.filter(p => p.g === g).sort((a, b) => b.n - a.n).map(p => [p.provider, p.n])),
      shares: { stale: rate(counts.stale, counts.contacts - counts.neverObserved), role: rate(counts.role, counts.contacts), freeMail: rate(counts.freeMail, counts.contacts) } }]));
  };
  const empty = () => ({ contacts: 0, subscribed: 0, unknown: 0, unsubscribed: 0, suppressed: 0, clicked30: 0, clicked90: 0, clicked180: 0, stale: 0, neverObserved: 0, role: 0, freeMail: 0, typoDomains: 0,
    suppressedBy: {}, providers: {}, shares: { stale: rate(0, 0), role: rate(0, 0), freeMail: rate(0, 0) } });
  const { rows: lists } = await db.execute<{ id: string; name: string; size: number }>(sql`SELECT l.id, l.name, (SELECT count(*)::int FROM audience_list_members m WHERE m.workspace_id = l.workspace_id AND m.list_id = l.id) AS size
    FROM audience_lists l WHERE l.workspace_id = ${wid} ${listId ? sql`AND l.id = ${listId}` : sql``} ORDER BY size DESC, l.id LIMIT ${LIMITS.groups}`);
  const byList = lists.length ? await views(sql`m.list_id`, sql`audience_list_members m JOIN audience_contacts c ON c.workspace_id = m.workspace_id AND c.id = m.contact_id
    WHERE m.workspace_id = ${wid} AND m.list_id = ANY(${texts(lists.map(l => l.id))}) AND c.deleted_at IS NULL`) : new Map();
  const perList = lists.map(list => ({ id: list.id, name: list.name, ...byList.get(list.id) ?? empty() }));
  const all = listId ? null : (await views(sql`''`, sql`audience_contacts c WHERE c.workspace_id = ${wid} AND c.deleted_at IS NULL`)).get('') ?? empty();
  // Imports: each committed import's contacts, now. Suppressions after the import stand for its bounces and complaints:
  // the outcome of first mailing that list (Bane does not record which send first reached each imported contact).
  const { rows: imports } = await db.execute<{ id: string; list_id: string | null; list_name: string | null; created_at: string; imported: number; errors: number; matched: number; hard_bounced: number; complained: number; unsubscribed: number }>(sql`WITH i AS (
      SELECT id, workspace_id, list_id, created_at, imported, errors, rows FROM audience_imports
      WHERE workspace_id = ${wid} AND status = 'committed' AND created_at >= now() - interval '90 days' ${listId ? sql`AND list_id = ${listId}` : sql``} ORDER BY created_at DESC LIMIT 10
    ) SELECT i.id, i.list_id,
      (SELECT name FROM audience_lists l WHERE l.workspace_id = i.workspace_id AND l.id = i.list_id) AS list_name, i.created_at::text, i.imported, jsonb_array_length(i.errors)::int AS errors,
      count(c.id)::int AS matched, count(*) FILTER (WHERE c.suppression_reason = 'hard_bounce' AND c.suppressed_at >= i.created_at)::int AS hard_bounced,
      count(*) FILTER (WHERE c.suppression_reason = 'complaint' AND c.suppressed_at >= i.created_at)::int AS complained,
      count(*) FILTER (WHERE c.marketing_consent = 'unsubscribed')::int AS unsubscribed
    FROM audience_imports i LEFT JOIN LATERAL (SELECT r->>'email' AS email FROM jsonb_array_elements(i.rows) r LIMIT 50000) x ON true
      LEFT JOIN audience_contacts c ON c.workspace_id = i.workspace_id AND c.email = lower(x.email)
    GROUP BY i.id, i.workspace_id, i.list_id, i.created_at, i.imported, i.errors ORDER BY i.created_at DESC`);
  const importViews = imports.map(i => ({ id: i.id, listId: i.list_id, listName: i.list_name, at: new Date(i.created_at).toISOString(), imported: i.imported, errors: i.errors, contacts: i.matched,
    hardBounce: rate(i.hard_bounced, i.matched), complaint: rate(i.complained, i.matched), unsubscribed: i.unsubscribed }));
  const findings: Finding[] = [];
  for (const [scope, v] of [...perList.map(l => [`list ${l.name}`, l] as const), ...(all ? [['all contacts', all] as const] : [])]) {
    const s = v.shares;
    if (s.stale.value !== null && s.stale.denominator >= 100 && s.stale.value > THRESHOLDS.stale) findings.push({ severity: 'notice', code: 'STALE_CONTACTS', scope, evidence: { stale: v.stale, observed: s.stale.denominator, rate: s.stale.value },
      message: `${num(v.stale)} of ${num(s.stale.denominator)} observed contacts in ${scope} have not opened or clicked in 180 days (${pct(s.stale.value)}). Add a sunset policy, or send a re-permission campaign and keep those who click.` });
    if (s.role.value !== null && v.contacts >= 100 && s.role.value > THRESHOLDS.role) findings.push({ severity: 'notice', code: 'ROLE_ADDRESSES', scope, evidence: { role: v.role, contacts: v.contacts, rate: s.role.value },
      message: `${num(v.role)} of ${num(v.contacts)} contacts in ${scope} are role addresses such as info@ or sales@ (${pct(s.role.value)}). They rarely opted in themselves: validate at signup and use double opt-in.` });
    if (v.typoDomains > 0) findings.push({ severity: 'notice', code: 'TYPO_DOMAINS', scope, evidence: { contacts: v.typoDomains }, message: `${num(v.typoDomains)} contacts in ${scope} use a mistyped domain (gmial.com, hotmial.com…). They bounce: fix or remove them, and validate at signup.` });
  }
  for (const i of importViews) if (i.hardBounce.value !== null && i.hardBounce.numerator >= THRESHOLDS.minimumEvents && i.hardBounce.value > THRESHOLDS.firstSendBounce)
    findings.push({ severity: 'serious', code: 'IMPORT_BOUNCES', scope: `import ${i.at.slice(0, 10)}`, evidence: { hardBounced: i.hardBounce.numerator, contacts: i.contacts, rate: i.hardBounce.value, threshold: THRESHOLDS.firstSendBounce },
      message: `${num(i.hardBounce.numerator)} of ${num(i.contacts)} contacts imported on ${i.at.slice(0, 10)}${i.listName ? ` into ${i.listName}` : ''} have since hard-bounced (${pct(i.hardBounce.value)}). Stop mailing that import and check its source.` });
  return { lists: perList, all, imports: importViews, findings: byImpact(findings) };
}

// ---------- 6. lint ----------
export const SHORTENERS = ['bit.ly', 'bitly.com', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly', 'rebrand.ly', 'cutt.ly', 'shorturl.at', 'tiny.cc', 'rb.gy', 'bl.ink', 's.id', 't.ly', 'lnkd.in', 'shorte.st', 'adf.ly'];
const SPAM_PHRASES = ['act now', 'click here', 'limited time', '100% free', 'risk-free', 'risk free', 'you are a winner', 'you have been selected', 'cash bonus', 'double your', 'earn money', 'guaranteed',
  'no credit check', 'urgent', 'congratulations', 'free gift', 'lowest price', 'once in a lifetime', 'this is not spam', 'dear friend', 'call now', 'order now', 'apply now', 'buy now', 'miracle'];
const STAGING = /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?|0\.0\.0\.0)$|\.(?:local|localhost|test|internal|invalid|example)$|(?:^|[.-])(?:staging|stage|dev|preview|sandbox)[.-]|ngrok|\.vercel\.app$|\.pages\.dev$|\.workers\.dev$/i;
const hostOf = (href: string) => { try { return new URL(href.startsWith('//') ? 'https:' + href : href).hostname.toLowerCase(); } catch { return ''; } };
export type LintMetadata = {
  sizeBytes: number; parts: { html: boolean; text: boolean; raw: boolean }; attachments: { count: number; types: string[] }; listUnsubscribe: boolean; listUnsubscribePost: boolean; tracking: boolean;
  alignment: { fromDomain: string; dkimDomain: string | null; returnPath: string; dkimAligned: boolean; spfAligned: boolean };
  subject: { length: number; capitalsShare: number | null; exclamationRuns: number; emoji: number; replyPrefix: boolean; replyWithoutThread: boolean };
};
export function subjectStats(subject: string, threaded: boolean): LintMetadata['subject'] {
  const letters = subject.match(/\p{L}/gu) ?? [], capitals = subject.match(/\p{Lu}/gu) ?? [], reply = /^\s*(?:re|fwd?|aw|wg|tr)\s*:/i.test(subject);
  return { length: [...subject].length, capitalsShare: letters.length ? Math.round(capitals.length / letters.length * 1000) / 1000 : null, exclamationRuns: (subject.match(/!{2,}|[!?]{3,}/g) ?? []).length,
    emoji: (subject.match(/\p{Extended_Pictographic}/gu) ?? []).length, replyPrefix: reply, replyWithoutThread: reply && !threaded };
}
/** The domain claim that signs mail from `fromDomain` (its own identity or a parent's), and the alignment it gives. */
export async function senderAlignment(db: DbExecutor, wid: string, fromDomain: string) {
  const { rows: [claim] } = await db.execute<{ name: string; dkim: string | null; signing: string | null; mail_from: string | null; mail_from_status: string | null; aspf: string | null }>(sql`SELECT name,
      identity #>> '{ses,DkimAttributes,Status}' AS dkim, identity #>> '{ses,DkimAttributes,SigningEnabled}' AS signing, identity #>> '{ses,MailFromAttributes,MailFromDomain}' AS mail_from,
      identity #>> '{ses,MailFromAttributes,MailFromDomainStatus}' AS mail_from_status, identity #>> '{dmarc,aspf}' AS aspf
    FROM domain_claims WHERE workspace_id = ${wid} AND (name = ${fromDomain} OR ${fromDomain} LIKE '%.' || name) ORDER BY length(name) DESC LIMIT 1`);
  if (!claim) return { fromDomain, dkimDomain: null, returnPath: 'amazonses.com', dkimAligned: false, spfAligned: false };
  const a = await alignment(fromDomain, { dkim: claim.dkim, signing: claim.signing === 'true', mailFrom: claim.mail_from, mailFromStatus: claim.mail_from_status }, claim.aspf ?? 'r');
  return { fromDomain, dkimDomain: a.dkim ? claim.name : null, returnPath: a.returnPath, dkimAligned: a.dkim, spfAligned: a.spf };
}
export function metadataFindings(m: LintMetadata, marketing: boolean): Finding[] {
  const out: Finding[] = [], f = (severity: Severity, code: string, message: string, evidence: Record<string, number> = {}) => out.push({ severity, code, message, scope: null, evidence });
  if (!m.parts.text && !m.parts.raw) f('notice', 'NO_TEXT_PART', 'There is no plain-text part. Some filters score HTML-only mail higher, and text-only clients show nothing: add a text version.');
  if (marketing && !m.listUnsubscribe) f('serious', 'NO_LIST_UNSUBSCRIBE', 'Marketing mail without List-Unsubscribe: Gmail and Yahoo require one-click unsubscribe from bulk senders. Send it as a campaign or with kind=marketing so Bane adds it.');
  if (!m.alignment.dkimAligned && !m.alignment.spfAligned) f('critical', 'DMARC_UNALIGNED', `Neither DKIM nor the Return-Path (${m.alignment.returnPath}) aligns with ${m.alignment.fromDomain}, so this mail fails DMARC.`);
  if (m.subject.capitalsShare !== null && m.subject.length >= 10 && m.subject.capitalsShare > 0.5) f('notice', 'SUBJECT_CAPITALS', 'More than half the subject’s letters are capitals, which reads as shouting and as spam.', { capitalsShare: m.subject.capitalsShare });
  if (m.subject.exclamationRuns) f('notice', 'SUBJECT_PUNCTUATION', 'The subject has runs like !!! or ???. Filters penalize them: use one mark at most.', { runs: m.subject.exclamationRuns });
  if (m.subject.replyWithoutThread) f('serious', 'MISLEADING_REPLY_PREFIX', 'The subject starts with RE: or FWD: but the email is not a reply. That is deceptive under the AUP and Gmail’s sender guidelines: remove the prefix.');
  if (m.subject.length > 90) f('info', 'SUBJECT_LONG', `The subject is ${m.subject.length} characters; most clients show about 40 to 60.`, { length: m.subject.length });
  return out;
}
/** Content checks, only with the customer's consent: the probation screen's own HTML pass and link reading. */
export async function lintContent(input: { html?: string | null; text?: string | null; subject: string; footerAddedByBane: boolean; defaults?: string[] }) {
  const { screenedHtmlStats } = await import('./screened-html.js'), { readHtml } = await import('./screen.js');
  const html = input.html ?? null, text = input.text ?? '';
  let stats: ReturnType<typeof screenedHtmlStats> | null = null, read: Awaited<ReturnType<typeof readHtml>> | null = null, unreadable: string | null = null;
  if (html) try { stats = screenedHtmlStats(html); read = await readHtml(html); } catch (error) { unreadable = error instanceof ApiError ? error.code : 'HTML_UNREADABLE'; }
  const textLinks = [...text.matchAll(/(?:https?:)?\/\/[^\s<>"')]+/gi)].map(m => m[0]);
  const links = [...(read?.links ?? []), ...textLinks].filter(l => /^(?:https?:)?\/\//i.test(l));
  const domains = links.reduce<Map<string, number>>((m, l) => { const h = hostOf(l); return h ? m.set(h, (m.get(h) ?? 0) + 1) : m; }, new Map());
  const visible = `${input.subject}\n${read?.text ?? ''}\n${text}`.toLowerCase().replace(/\s+/g, ' ');
  // A sent email should hold no placeholder at all; a campaign's {{name}} is filled per contact, so only a field with
  // no default can fail (MISSING_TEMPLATE_VARIABLE) for a contact without it.
  const known = input.defaults ? new Set(['email', 'name', ...input.defaults]) : null;
  const tokens = [...new Set([...`${html ?? ''}\n${text}\n${input.subject}`.matchAll(/\{\{\s*([^{}]{1,40}?)\s*\}\}|\*\|([A-Z0-9_]{1,30})\|\*/g)].map(m => (m[1] ?? m[2])!.trim()))]
    .filter(t => !known?.has(t)).slice(0, 10);
  const content = {
    readable: !unreadable, unreadableReason: unreadable,
    visibleWords: stats?.words ?? (text.match(/[\p{L}\p{N}]+/gu) ?? []).length,
    images: { count: stats?.images ?? 0, declaredArea: stats?.imageArea ?? 0, wordsRequired: stats?.wordsRequiredByImages ?? 0, rulePasses: stats?.imageRulePasses ?? true, missingAlt: (read?.images ?? []).filter(i => !i.alt).length },
    hiddenWords: stats?.hiddenWords ?? 0, sameColorWords: stats?.recoloredWords ?? 0,
    links: { count: links.length, domains: [...domains].sort((a, b) => b[1] - a[1]).slice(0, LIMITS.groups).map(([domain, count]) => ({ domain, count })),
      shorteners: [...domains.keys()].filter(d => SHORTENERS.includes(d)), mismatchedText: [...(read?.mismatches ?? [])].slice(0, 10),
      plainHttp: links.filter(l => /^http:/i.test(l)).length, localOrStaging: [...domains.keys()].filter(d => STAGING.test(d)).slice(0, 10),
      unsubscribe: input.footerAddedByBane || links.some(l => /unsub|opt-?out|\/preferences/i.test(l)), unsubscribeAddedByBane: input.footerAddedByBane },
    unresolvedTokens: tokens, spamPhrases: SPAM_PHRASES.filter(p => visible.includes(p)).slice(0, 10),
  };
  const out: Finding[] = [], f = (severity: Severity, code: string, message: string, evidence: Record<string, number> = {}) => out.push({ severity, code, message, scope: null, evidence });
  if (!content.images.rulePasses) f('serious', 'IMAGE_TEXT_RATIO', `The images cover about ${num(content.images.declaredArea)} px² with ${num(content.visibleWords)} words of text; the screen asks for ${num(content.images.wordsRequired)} (25 words per 600×300 beyond a 200×200 logo). Put the offer in HTML text and keep images as illustrations.`, { words: content.visibleWords, wordsRequired: content.images.wordsRequired, imageArea: content.images.declaredArea });
  if (content.links.shorteners.length) f('serious', 'URL_SHORTENER', `Links go through ${content.links.shorteners.join(', ')}. Shorteners hide the destination and are on blocklists: link to your own domain.`, { domains: content.links.shorteners.length });
  if (content.links.mismatchedText.length) f('serious', 'LINK_TEXT_MISMATCH', `Link text names another domain than the link opens (${content.links.mismatchedText.slice(0, 3).join('; ')}). Filters treat that as phishing: make them match.`, { links: content.links.mismatchedText.length });
  if (content.hiddenWords > 0) f('notice', 'HIDDEN_TEXT', `${num(content.hiddenWords)} words are hidden by markup (display:none, zero size, invisible) beyond the preheader. Filters penalize hidden text.`, { words: content.hiddenWords });
  if (content.sameColorWords > 0) f('notice', 'TEXT_SAME_COLOR', `${num(content.sameColorWords)} words are drawn in (nearly) their background color.`, { words: content.sameColorWords });
  if (content.images.missingAlt) f('info', 'IMAGES_WITHOUT_ALT', `${content.images.missingAlt} images have no alt text; clients that block images show nothing in their place.`, { images: content.images.missingAlt });
  if (content.links.plainHttp) f('notice', 'PLAIN_HTTP_LINKS', `${content.links.plainHttp} links use http: instead of https:.`, { links: content.links.plainHttp });
  if (content.unresolvedTokens.length) f('serious', 'UNRESOLVED_TOKENS', known
    ? `These fields have no default, so a contact without them fails to render: ${content.unresolvedTokens.map(t => `{{${t}}}`).join(', ')}. Set defaults in the campaign or check the property names.`
    : `Personalization tokens were sent unresolved: ${content.unresolvedTokens.map(t => `{{${t}}}`).join(', ')}. Check the template and the data passed with the send.`, { tokens: content.unresolvedTokens.length });
  if (content.links.localOrStaging.length) f('serious', 'STAGING_LINKS', `Links point at local or staging hosts (${content.links.localOrStaging.join(', ')}). Recipients can’t open them, and filters distrust them.`, { hosts: content.links.localOrStaging.length });
  if (content.spamPhrases.length) f('info', 'SPAM_PHRASES', `Phrases filters often score: ${content.spamPhrases.map(p => `"${p}"`).join(', ')}. One alone rarely matters; several together do.`, { phrases: content.spamPhrases.length });
  if (content.visibleWords < 20 && !content.images.count && html) f('info', 'VERY_SHORT', 'The message has fewer than 20 visible words.', { words: content.visibleWords });
  return { content, findings: out };
}
