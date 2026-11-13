import { sql } from 'drizzle-orm';
import { ApiError, id, isSimulatedSes, log, type DbExecutor, type JobHandler, type Runtime } from './core.js';
import { enqueue, retryDatabaseFailures } from './jobs.js';
import { queueTenantStatus, resumeHostedConnection, tenantStatusDrift, terminalColumns, terminalEvents, type HostedCaps } from './states.js';
import { dailyLimit, moveScore, nextStanding, quality, stepRank, type DayEvidence, type DomainAuth, type Factor, type LadderInput, type Reason, type ScoreState, type Step, type Window } from './standing-model.js';

// The standing job: every ten minutes it counts each Hosted workspace's mail, moves its score, sets the daily limit
// admission reads, and walks the ladder (notice → warn → restrict → pause). Every change of standing, by the job, an
// owner or an operator, goes through applyChange: one transaction writes the row, its event, the webhook, the owner
// email and, for a pause or resume, the connection hold and the SES tenant switch.

export type StandingActor = { kind: 'system' | 'owner' | 'operator'; id?: string | null; via?: 'job' | 'dashboard' | 'console' | 'script' | 'ses' };
export type StandingRow = {
  workspace_id: string; phase: ScoreState['phase']; first_recipients: number; calibrated_at: string | null; score: string | null; day_score: string | null; score_day: string | null;
  target: string; quality: string; volume: number; factors: Factor[]; band_limit: number; daily_limit: number; step: Step; reasons: Reason[]; since: string; clear_since: string | null;
  pause_kind: 'bounce' | 'full' | null; marketing_hold: boolean; release_until: string | null; release_percent: number | null; last_release_at: string | null; last_self_resume_at: string | null;
  strikes: { at: string; reason: string; kind: string }[]; strike_until: string | null; watch: boolean; notified: Record<string, string>; evidence_at: string | null; computed_at: string | null; version: number; sequence: number;
};
export type Change = {
  workspaceId: string; actor: StandingActor; kind: 'step' | 'limit' | 'quarantine' | 'release' | 'tenant' | 'operator';
  expectVersion?: number; step?: Step; reasons?: Reason[]; pauseKind?: 'bounce' | 'full' | null;
  /** Stop all sending (connection hold, SES tenants disabled). The message is the 409 HOSTED_SENDING_PAUSED text. */
  pause?: { message: string };
  /**
   * Lift the connection hold: min(current limit, percent of the limit before it) for 48 hours (src/states.ts,
   * resumeConnection); optionally hold marketing for a while. `caps` are the installation's limit tiers.
   */
  resume?: { percent: 50 | 100; marketingHours?: number; caps: HostedCaps };
  marketingHold?: boolean; release?: { percent: number; hours: number }; watch?: boolean;
  touch?: { lastRelease?: boolean; lastSelfResume?: boolean };
  details?: Record<string, unknown>; requestId?: string;
};
export const STANDING_EVENT = 'account.standing.changed';
const STRIKE_DAYS = 90;

/** One transaction: lock the standing, check If-Match, write the change, its event and every side effect. */
export async function applyChange(db: DbExecutor, change: Change): Promise<{ eventId: string; version: number; sequence: number; step: Step; previousStep: Step } | null> {
  const wid = change.workspaceId;
  await db.execute(sql`INSERT INTO sender_standing(workspace_id) SELECT workspace_id FROM provider_connections WHERE workspace_id=${wid} AND kind='shared' ON CONFLICT DO NOTHING`);
  // A pause that is resuming (waiting for its SES tenants to be enabled again) counts as lifted: a new pause re-arms it.
  const [row] = (await db.execute<StandingRow & { paused_at: string | null; held: boolean; exempt: boolean; connection_id: string }>(sql`SELECT s.*,CASE WHEN pc.resume_pending_at IS NULL THEN pc.paused_at END AS paused_at,
    pc.marketing_held_at IS NOT NULL AS held,w.exempt_hosted_quotas AS exempt,pc.id AS connection_id FROM sender_standing s
    JOIN provider_connections pc ON pc.workspace_id=s.workspace_id AND pc.kind='shared' JOIN workspaces w ON w.id=s.workspace_id WHERE s.workspace_id=${wid} FOR UPDATE OF s,pc`)).rows;
  if (!row) return null;
  if (change.expectVersion !== undefined && change.expectVersion !== row.version) throw new ApiError(412, 'STANDING_VERSION_CHANGED', `The standing changed since version ${change.expectVersion} (now ${row.version}). Reload and try again.`);
  const now = new Date(), at = now.toISOString(), previousStep = row.step;
  const step = change.step ?? (change.pause ? 'pause' : row.step);
  const strikes = row.strikes.filter(s => Date.parse(s.at) > now.getTime() - STRIKE_DAYS * 86_400_000);
  if (change.pause && !row.paused_at) strikes.push({ at, reason: change.reasons?.[0]?.code ?? 'PAUSED', kind: change.pauseKind ?? 'full' });
  // The second strike in 90 days caps the limit at half for 7 days after the resume.
  const strikeUntil = change.resume && strikes.length >= 2 ? new Date(now.getTime() + 7 * 86_400_000).toISOString() : row.strike_until;
  // A new rise ends an owner's marketing release: the restrict (or pause) holds marketing again.
  const escalated = stepRank(step) > stepRank(previousStep) && stepRank(step) >= stepRank('restrict');
  const releaseUntil = change.release ? new Date(now.getTime() + change.release.hours * 3600_000).toISOString() : change.resume?.marketingHours || escalated ? null : step === 'ok' || step === 'notice' ? null : row.release_until;
  const marketingHold = change.marketingHold ?? (change.resume?.marketingHours ? true : row.marketing_hold);
  const reasons = change.reasons ?? (step === row.step ? row.reasons : []);
  const sequence = Number(row.sequence) + 1, version = row.version + 1, eventId = id('stev');
  await db.execute(sql`UPDATE sender_standing SET step=${step},reasons=${JSON.stringify(reasons)}::jsonb,since=${step !== row.step ? at : row.since}::timestamptz,
    clear_since=${step !== row.step ? null : row.clear_since}::timestamptz,pause_kind=${step === 'pause' ? change.pauseKind ?? row.pause_kind ?? 'full' : null},
    marketing_hold=${marketingHold},release_until=${releaseUntil}::timestamptz,release_percent=${change.release?.percent ?? (releaseUntil ? row.release_percent : null)}::smallint,
    last_release_at=${change.touch?.lastRelease ? at : row.last_release_at}::timestamptz,last_self_resume_at=${change.touch?.lastSelfResume ? at : row.last_self_resume_at}::timestamptz,
    strikes=${JSON.stringify(strikes)}::jsonb,strike_until=${strikeUntil}::timestamptz,watch=${change.watch ?? row.watch},
    version=${version},sequence=${sequence} WHERE workspace_id=${wid}`);
  // A pause bumps the tenant generation, so the SES tenant job disables the tenants even if a resume was in flight.
  if (change.pause && !row.paused_at) {
    await db.execute(sql`UPDATE provider_connections SET paused_at=clock_timestamp(),pause_reason=${change.pause.message},resume_pending_at=NULL,tenant_generation=tenant_generation+1 WHERE id=${row.connection_id}`);
    await db.execute(queueTenantStatus(sql`SELECT ${wid}::text AS workspace_id`));
  }
  let resumed: { pending: boolean; base: number | null; restore_cap: number | null } | undefined;
  if (change.resume && row.paused_at) {
    [resumed] = (await db.execute<{ pending: boolean; base: number | null; restore_cap: number | null }>(resumeHostedConnection(wid, change.resume.percent, change.resume.caps))).rows;
    // A marketing hold after a self-resume ends by itself: the job releases it once release_until passes.
    if (change.resume.marketingHours) await db.execute(sql`UPDATE sender_standing SET release_until=clock_timestamp()+make_interval(hours=>${change.resume.marketingHours}),release_percent=NULL WHERE workspace_id=${wid}`);
  }
  // A marketing hold placed by the hourly check before the standing shipped ends here: a restrict or pause now holds
  // marketing instead, and a release or resume lifts it with the step.
  if (row.held && (row.exempt || stepRank(step) >= stepRank('restrict') || change.release || change.resume)) await db.execute(sql`UPDATE provider_connections SET marketing_held_at=NULL,marketing_hold_reason=NULL WHERE id=${row.connection_id}`);
  const actor = { kind: change.actor.kind, ...(change.actor.id ? { id: change.actor.id } : {}), via: change.actor.via ?? (change.actor.kind === 'system' ? 'job' : 'dashboard') };
  const details = { ...change.details, ...(change.pause ? { paused: true } : {}),
    ...(change.resume ? { resumed: { percent: change.resume.percent, marketingHours: change.resume.marketingHours, limitBefore: resumed?.base ?? null, restoreCap: resumed?.restore_cap ?? null, waitsForTenants: resumed?.pending ?? false } } : {}),
    ...(change.release ? { release: change.release } : {}),
    ...(change.marketingHold !== undefined ? { marketingHold: change.marketingHold } : {}), strikes: strikes.length };
  await db.execute(sql`INSERT INTO standing_events(id,workspace_id,sequence,at,kind,from_step,to_step,reasons,actor,details)
    VALUES(${eventId},${wid},${sequence},${at}::timestamptz,${change.kind},${previousStep},${step},${JSON.stringify(reasons)}::jsonb,${JSON.stringify(actor)}::jsonb,${JSON.stringify(details)}::jsonb)`);
  // Customers see every change of step, a campaign quarantine and an owner's or operator's release on their own webhooks.
  if (step !== previousStep || change.kind === 'quarantine' || change.kind === 'release') {
    const data = { step, previousStep, reasons: reasons.map(({ code, metric, value, count, threshold, minimum, window, message }) => ({ code, metric, value, count, threshold, minimum, window, message })),
      since: step !== previousStep ? at : row.since, version, sequence, actor: { kind: actor.kind }, change: change.kind, marketingHeld: (stepRank(step) >= stepRank('restrict') && !change.release) || marketingHold };
    await enqueue(db, { type: 'operation.publish', workspaceId: wid, payload: { event: { id: `evt_standing_${eventId.slice(5)}`, type: STANDING_EVENT, createdAt: at, workspaceId: wid, region: null, data } } });
  }
  // Owners and admins hear about a rise to warn or above, at most once per step per 24 hours.
  const last = row.notified[step];
  if (stepRank(step) > stepRank(previousStep) && stepRank(step) >= stepRank('warn') && (!last || now.getTime() - Date.parse(last) >= 86_400_000)) {
    await db.execute(sql`UPDATE sender_standing SET notified=notified||jsonb_build_object(${step}::text,${at}::text) WHERE workspace_id=${wid}`);
    await enqueue(db, { type: 'standing.notify', workspaceId: wid, payload: { eventId } });
  }
  if (change.kind === 'quarantine') await enqueue(db, { type: 'standing.notify', workspaceId: wid, payload: { eventId } });
  return { eventId, version, sequence, step, previousStep };
}

// ---------- the job ----------
type Candidate = StandingRow & { connection_id: string; paused_at: string | null; pause_reason: string | null; marketing_hold_reason: string | null; legacy_hold: boolean; exempt: boolean; screened_workspace: boolean; accepted_total: number;
  days: DayEvidence[] | null; domains: DomainAuth[] | null; win: { day: Window; week: Window } | null; screen: { screened: number; rejected: number } | null };
const MAIL_ACCEPTED = sql`e.status<>'suppressed' AND (e.provider_id IS NOT NULL OR e.status IN ('accepted','sent','delivered','bounced','complained','delayed') OR e.event_outcomes & 1 <> 0)`;
/** Counts each due workspace's mail per UTC day: 30 days the first time, then the last 8 (late feedback). */
async function refreshEvidence(db: DbExecutor, limit: number) {
  const { rows: [r] } = await db.execute<{ n: number }>(sql`WITH due AS (
      SELECT workspace_id,evidence_at FROM sender_standing WHERE evidence_at IS NULL OR evidence_at<now()-interval '1 hour' ORDER BY evidence_at NULLS FIRST LIMIT ${limit} FOR UPDATE SKIP LOCKED
    ), mail AS (
      SELECT d.workspace_id,(e.created_at AT TIME ZONE 'UTC')::date AS day,${MAIL_ACCEPTED} AS accepted,
        (e.status='delivered' OR e.event_outcomes & 2 <> 0) AS delivered,(e.status='bounced' OR e.event_outcomes & 4 <> 0) AS bounced,
        (e.status='complained' OR e.event_outcomes & 8 <> 0) AS complained,e.status='suppressed' AS suppressed,
        e.campaign_id IS NOT NULL AS first_send,coalesce(e.snapshot->>'kind'='marketing' OR e.campaign_id IS NOT NULL OR e.snapshot ? 'bulk',false) AS marketing,e.event_outcomes & 32 <> 0 AS clicked
      -- Only real Hosted mail is evidence: never simulated runs, mail only to the SES mailbox simulator, or mail the
      -- workspace sent through its own (BYO) account before (the unit is one email, in numerator and denominator alike).
      FROM due d JOIN sending_emails e ON e.workspace_id=d.workspace_id AND NOT e.simulated AND hosted_real_cost(e.to_addresses||e.cc_addresses||e.bcc_addresses)>0
        AND (e.feedback_topic_arn IS NULL OR EXISTS (SELECT FROM provider_feedback_history h WHERE h.topic_arn=e.feedback_topic_arn AND h.kind='shared'))
        AND e.created_at>=date_trunc('day',now(),'UTC')-CASE WHEN d.evidence_at IS NULL THEN interval '30 days' ELSE interval '7 days' END
    ), days AS (
      SELECT workspace_id,day,count(*)::int AS emails,count(*) FILTER (WHERE accepted)::int AS accepted,count(*) FILTER (WHERE delivered)::int AS delivered,
        count(*) FILTER (WHERE bounced)::int AS bounced,count(*) FILTER (WHERE accepted AND first_send)::int AS first_sends,count(*) FILTER (WHERE bounced AND first_send)::int AS first_bounced,
        count(*) FILTER (WHERE complained)::int AS complained,count(*) FILTER (WHERE suppressed)::int AS suppressed,
        count(*) FILTER (WHERE delivered AND marketing)::int AS marketing_delivered,count(*) FILTER (WHERE clicked AND marketing)::int AS clicked
      FROM mail GROUP BY 1,2
    ), screen AS (
      -- What the screen judged, by the day it judged it (src/dispatcher.ts): mail it never saw does not dilute the rate.
      SELECT d.workspace_id,(v.hour AT TIME ZONE 'UTC')::date AS day,sum(v.screened)::int AS screened,sum(v.rejected)::int AS rejected FROM due d JOIN hosted_screen_hourly v ON v.workspace_id=d.workspace_id
        AND v.hour>=date_trunc('day',now(),'UTC')-CASE WHEN d.evidence_at IS NULL THEN interval '30 days' ELSE interval '7 days' END GROUP BY 1,2
    ), unsub AS (
      SELECT a.workspace_id,(a.occurred_at AT TIME ZONE 'UTC')::date AS day,count(*)::int AS n FROM due d JOIN audience_consent_audit a ON a.workspace_id=d.workspace_id AND a.status='unsubscribed'
        AND a.source IN ('footer-confirm','rfc8058-post','ses-subscription') AND a.occurred_at>=date_trunc('day',now(),'UTC')-CASE WHEN d.evidence_at IS NULL THEN interval '30 days' ELSE interval '7 days' END
      GROUP BY 1,2
    ), parts AS (
      SELECT workspace_id,day,emails,accepted,delivered,bounced,first_sends,first_bounced,complained,0 AS screened,0 AS rejected,suppressed,marketing_delivered,0 AS unsubscribed,clicked FROM days
      UNION ALL SELECT workspace_id,day,0,0,0,0,0,0,0,screened,rejected,0,0,0,0 FROM screen
      UNION ALL SELECT workspace_id,day,0,0,0,0,0,0,0,0,0,0,0,n,0 FROM unsub
    ), upserted AS (
      INSERT INTO sender_score_daily AS s(workspace_id,day,emails,accepted,delivered,bounced,first_sends,first_bounced,complained,screened,rejected,suppressed,marketing_delivered,unsubscribed,clicked)
      SELECT workspace_id,day,sum(emails)::int,sum(accepted)::int,sum(delivered)::int,sum(bounced)::int,sum(first_sends)::int,sum(first_bounced)::int,sum(complained)::int,sum(screened)::int,
        sum(rejected)::int,sum(suppressed)::int,sum(marketing_delivered)::int,sum(unsubscribed)::int,sum(clicked)::int
      FROM parts GROUP BY 1,2 ORDER BY 1,2
      ON CONFLICT(workspace_id,day) DO UPDATE SET (emails,accepted,delivered,bounced,first_sends,first_bounced,complained,screened,rejected,suppressed,marketing_delivered,unsubscribed,clicked)=
        (excluded.emails,excluded.accepted,excluded.delivered,excluded.bounced,excluded.first_sends,excluded.first_bounced,excluded.complained,excluded.screened,excluded.rejected,excluded.suppressed,excluded.marketing_delivered,excluded.unsubscribed,excluded.clicked)
    ), marked AS (UPDATE sender_standing s SET evidence_at=now() FROM due d WHERE s.workspace_id=d.workspace_id)
    SELECT count(*)::int AS n FROM due`);
  return r?.n ?? 0;
}

const PAUSE_LEAD: Record<Reason['metric'], string> = { complaints: 'high spam-complaint rate', screen: 'the content screen rejected a high share of mail',
  transactional_bounces: 'high hard-bounce rate on transactional mail', bounces: 'high hard-bounce rate', marketing_bounces: 'high hard-bounce rate on marketing mail', external: 'paused' };
const zero: Window = { accepted: 0, bounces: 0, complaints: 0, marketingAccepted: 0, marketingBounces: 0, marketingComplaints: 0 };
/** Workspaces worth a look: recent mail or feedback, a step, a moving score, calibration, or six hours since the last run. */
async function candidates(runtime: Runtime, limit: number, only?: string) {
  const screened = Boolean(runtime.config.screen && runtime.config.hostedScreen);
  return (await runtime.db.execute<Candidate>(sql`WITH c AS (
      SELECT s.* FROM sender_standing s WHERE ${only ? sql`s.workspace_id=${only}` : sql`(s.computed_at IS NULL OR s.computed_at<now()-interval '6 hours' OR s.step<>'ok' OR s.phase='seed' OR (s.phase='calibrating' AND s.calibrated_at IS NOT NULL)
        OR s.score IS DISTINCT FROM s.target OR s.evidence_at>s.computed_at OR s.release_until IS NOT NULL OR s.strike_until IS NOT NULL
        OR EXISTS (SELECT FROM hosted_usage_hourly u WHERE u.workspace_id=s.workspace_id AND u.hour>=date_trunc('hour',now(),'UTC')-interval '47 hours')
        OR EXISTS (SELECT FROM hosted_health_hourly h WHERE h.workspace_id=s.workspace_id AND h.hour>=date_trunc('hour',now(),'UTC')-interval '23 hours')
        OR EXISTS (SELECT FROM hosted_screen_hourly v WHERE v.workspace_id=s.workspace_id AND v.hour>=date_trunc('hour',now(),'UTC')-interval '23 hours')
        OR EXISTS (SELECT FROM provider_connections pc WHERE pc.workspace_id=s.workspace_id AND pc.kind='shared' AND (pc.marketing_held_at IS NOT NULL OR pc.paused_at IS NOT NULL)))`}
      ORDER BY s.computed_at NULLS FIRST LIMIT ${limit})
    SELECT c.*,pc.id AS connection_id,CASE WHEN pc.resume_pending_at IS NULL THEN pc.paused_at END AS paused_at,pc.pause_reason,
      pc.marketing_held_at IS NOT NULL AS legacy_hold,pc.marketing_hold_reason,(SELECT exempt_hosted_quotas FROM workspaces WHERE id=c.workspace_id) AS exempt,${screened} AND pc.kind='shared' AS screened_workspace,
      (SELECT coalesce(sum(accepted),0)::int FROM sender_score_daily d WHERE d.workspace_id=c.workspace_id) AS accepted_total,
      (SELECT json_agg(d ORDER BY d.day) FROM sender_score_daily d WHERE d.workspace_id=c.workspace_id AND d.day>=(now() AT TIME ZONE 'UTC')::date-180) AS days,
      (SELECT json_agg(json_build_object('name',name,'dkim',identity #>> '{ses,DkimAttributes,Status}'='SUCCESS' AND identity #>> '{ses,DkimAttributes,SigningEnabled}'='true',
        'mailFrom',identity #>> '{ses,MailFromAttributes,MailFromDomainStatus}'='SUCCESS','dmarc',identity #>> '{dmarc,status}','emails',0))
        FROM domain_claims WHERE workspace_id=c.workspace_id AND sending_state='verified') AS domains,
      (SELECT json_build_object(
        'day',json_build_object('accepted',coalesce(sum(h.accepted) FILTER (WHERE h.hour>=date_trunc('hour',now(),'UTC')-interval '47 hours'),0),
          'bounces',coalesce(sum(h.bounces) FILTER (WHERE h.hour>=date_trunc('hour',now(),'UTC')-interval '23 hours'),0),
          'complaints',coalesce(sum(h.complaints) FILTER (WHERE h.hour>=date_trunc('hour',now(),'UTC')-interval '23 hours'),0),
          'marketingAccepted',coalesce(sum(h.marketing_accepted) FILTER (WHERE h.hour>=date_trunc('hour',now(),'UTC')-interval '47 hours'),0),
          'marketingBounces',coalesce(sum(h.marketing_bounces) FILTER (WHERE h.hour>=date_trunc('hour',now(),'UTC')-interval '23 hours'),0),
          'marketingComplaints',coalesce(sum(h.marketing_complaints) FILTER (WHERE h.hour>=date_trunc('hour',now(),'UTC')-interval '23 hours'),0)),
        'week',json_build_object('accepted',coalesce(sum(h.accepted),0),
          'bounces',coalesce(sum(h.bounces) FILTER (WHERE h.hour>=date_trunc('hour',now(),'UTC')-interval '167 hours'),0),
          'complaints',coalesce(sum(h.complaints) FILTER (WHERE h.hour>=date_trunc('hour',now(),'UTC')-interval '167 hours'),0),
          'marketingAccepted',coalesce(sum(h.marketing_accepted),0),
          'marketingBounces',coalesce(sum(h.marketing_bounces) FILTER (WHERE h.hour>=date_trunc('hour',now(),'UTC')-interval '167 hours'),0),
          'marketingComplaints',coalesce(sum(h.marketing_complaints) FILTER (WHERE h.hour>=date_trunc('hour',now(),'UTC')-interval '167 hours'),0)))
        FROM hosted_health_hourly h WHERE h.workspace_id=c.workspace_id AND h.epoch=coalesce(pc.resumed_at,'-infinity') AND h.hour>=date_trunc('hour',now(),'UTC')-interval '191 hours') AS win,
      -- Screen verdicts in the current epoch, counted when the dispatcher's screen judged the mail (src/dispatcher.ts).
      (SELECT json_build_object('screened',coalesce(sum(v.screened),0),'rejected',coalesce(sum(v.rejected),0)) FROM hosted_screen_hourly v
        WHERE v.workspace_id=c.workspace_id AND v.epoch=coalesce(pc.resumed_at,'-infinity') AND v.hour>=date_trunc('hour',now(),'UTC')-interval '23 hours') AS screen
    FROM c JOIN provider_connections pc ON pc.workspace_id=c.workspace_id AND pc.kind='shared'`)).rows;
}

function ladderInput(row: Pick<Candidate, 'win' | 'screen'>): LadderInput {
  const n = (w: Window | undefined) => Object.fromEntries(Object.entries(w ?? zero).map(([k, v]) => [k, Number(v)])) as Window;
  return { day: n(row.win?.day), week: n(row.win?.week), screened: Number(row.screen?.screened ?? 0), rejected: Number(row.screen?.rejected ?? 0) };
}
/** The live 24-hour and 7-day figures for one workspace (an owner's release re-checks them). */
export async function liveLadder(runtime: Runtime, wid: string) {
  const [row] = await candidates(runtime, 1, wid);
  return row ? ladderInput(row) : null;
}
/**
 * One run: count due workspaces' mail, then move each candidate's score, limit and step. A step change (or a pause the
 * connection already has) goes through applyChange; everything else is one batched update. Returns what changed.
 */
export async function refreshStanding(runtime: Runtime, options: { now?: Date; only?: string; limit?: number } = {}) {
  if (!runtime.config.multiTenant) return { evaluated: 0, changed: 0 };
  const now = options.now ?? new Date(), limit = options.limit ?? 500;
  await runtime.db.execute(sql`INSERT INTO sender_standing(workspace_id) SELECT workspace_id FROM provider_connections WHERE kind='shared' ${options.only ? sql`AND workspace_id=${options.only}` : sql``} ON CONFLICT DO NOTHING`);
  await refreshEvidence(runtime.db, options.only ? 1 : 200);
  const rows = await candidates(runtime, limit, options.only);
  const today = now.toISOString().slice(0, 10), routine: Record<string, unknown>[] = [];
  let changed = 0;
  for (const row of rows) {
    const q = quality(row.days ?? [], row.domains ?? [], row.screened_workspace, today);
    const moved = moveScore({ phase: row.phase, firstRecipients: row.first_recipients, calibratedAt: row.calibrated_at, score: row.score === null ? null : Number(row.score), dayScore: row.day_score === null ? null : Number(row.day_score), scoreDay: row.score_day }, q.target, row.accepted_total, now);
    const input = ladderInput(row);
    const prev = { step: row.step, reasons: row.reasons, since: row.since, clearSince: row.clear_since, pauseKind: row.pause_kind };
    let next = nextStanding(prev, input, now);
    // The connection hold is the truth for a pause: one set outside the ladder (operator script, AWS) is a pause here,
    // and a pause lifted outside it (an operator resume) leaves the workspace at warn, with its limit frozen.
    if (row.paused_at && next.step !== 'pause') next = { step: 'pause', reasons: [{ code: 'ACCOUNT_PAUSED', metric: 'external', value: 0, count: 0, threshold: 0, minimum: 0, window: null, step: 'pause', message: row.pause_reason ?? 'Sending is paused.' }], since: row.paused_at, clearSince: null, pauseKind: 'full' };
    else if (!row.paused_at && prev.step === 'pause' && next.step === 'pause') next = { step: 'warn', reasons: prev.reasons, since: now.toISOString(), clearSince: null, pauseKind: null };
    // A bounce-only marketing hold from before the standing shipped becomes a restrict, so the ladder releases it.
    if (row.legacy_hold && !row.exempt && stepRank(next.step) < stepRank('restrict')) next = { step: 'restrict', reasons: [...next.reasons.filter(r => r.step !== 'restrict'), { code: 'MARKETING_HELD', metric: 'bounces', value: 0, count: 0, threshold: 0, minimum: 0, window: '24h', step: 'restrict',
      message: row.marketing_hold_reason ?? 'Marketing was held after a high hard-bounce rate.' }], since: now.toISOString(), clearSince: null, pauseKind: null };
    // An exempt (first-party) workspace is never held or paused by the ladder: its standing stops at warn (owners are
    // emailed, account.standing.changed is published) and the operators are alerted; only an operator pauses it.
    if (row.exempt && !row.paused_at && stepRank(next.step) > stepRank('warn')) {
      await alertExempt(runtime, row.workspace_id, next, input);
      next = { ...next, step: 'warn', pauseKind: null, ...(prev.step === 'warn' ? { since: prev.since } : {}) };
    }
    const strikeCapped = !!row.strike_until && Date.parse(row.strike_until) > now.getTime();
    const limits = dailyLimit({ phase: moved.phase, score: moved.score, band: row.band_limit, step: next.step, currentLimit: row.daily_limit, strikeCapped });
    // An owner's marketing release and an operator's hold after a self-resume both end on their own.
    const releaseExpired = !!row.release_until && Date.parse(row.release_until) <= now.getTime();
    if (next.step !== prev.step || releaseExpired || row.legacy_hold) {
      const pause = next.step === 'pause' && !row.paused_at;
      const why = next.reasons.find(r => r.step === 'pause');
      const message = pause ? `Hosted sending paused: ${why ? `${PAUSE_LEAD[why.metric]}. ${why.message}` : 'the reputation ladder reached pause.'}` : '';
      try {
        const done = await runtime.db.transaction(tx => applyChange(tx, { workspaceId: row.workspace_id, actor: { kind: 'system', via: 'job' }, kind: 'step', expectVersion: row.version,
          step: next.step, reasons: next.reasons, pauseKind: next.pauseKind, ...(pause ? { pause: { message } } : {}),
          ...(releaseExpired && row.release_percent === null && row.marketing_hold ? { marketingHold: false } : {}),
          details: { day: input.day, week: input.week, screen: { screened: input.screened, rejected: input.rejected }, ...(releaseExpired ? { releaseEnded: true } : {}) } }));
        if (done) { changed++; row.version = done.version; }
        if (done && next.step !== prev.step) log(stepRank(next.step) >= stepRank('restrict') ? 'warn' : 'info', { code: 'STANDING_CHANGED', workspaceId: row.workspace_id, from: prev.step, to: next.step, reasons: next.reasons.map(r => r.code) });
      } catch (error) {
        if (error instanceof ApiError && error.code === 'STANDING_VERSION_CHANGED') continue; // An owner or operator acted meanwhile; next run.
        throw error;
      }
      if (releaseExpired) await runtime.db.execute(sql`UPDATE sender_standing SET release_until=NULL,release_percent=NULL WHERE workspace_id=${row.workspace_id} AND release_until<=now()`);
    }
    // A band change is on the timeline (one statement: the sequence row lock orders it with applyChange).
    if (limits.limit !== row.daily_limit) await runtime.db.execute(sql`WITH s AS (UPDATE sender_standing SET sequence=sequence+1 WHERE workspace_id=${row.workspace_id} RETURNING workspace_id,sequence,step)
      INSERT INTO standing_events(id,workspace_id,sequence,kind,from_step,to_step,actor,details)
      SELECT ${id('stev')},workspace_id,sequence,'limit',step,step,'{"kind":"system","via":"job"}'::jsonb,${JSON.stringify({ from: row.daily_limit, to: limits.limit, score: moved.score })}::jsonb FROM s`);
    routine.push({ workspace_id: row.workspace_id, phase: moved.phase, first_recipients: moved.firstRecipients, calibrated_at: moved.calibratedAt, score: moved.score, day_score: moved.dayScore, score_day: moved.scoreDay,
      target: q.target, quality: q.quality, volume: q.volume, factors: q.factors, band_limit: limits.band, daily_limit: limits.limit, clear_since: next.step === prev.step ? next.clearSince : null,
      strike_until: strikeCapped ? row.strike_until : null, step: next.step });
  }
  if (routine.length) await runtime.db.execute(sql`WITH r AS (SELECT * FROM jsonb_to_recordset(${JSON.stringify(routine)}::jsonb) AS r(workspace_id text,phase text,first_recipients int,calibrated_at timestamptz,
      score numeric,day_score numeric,score_day date,target numeric,quality numeric,volume double precision,factors jsonb,band_limit int,daily_limit int,clear_since timestamptz,strike_until timestamptz,step text)),
    updated AS (UPDATE sender_standing s SET phase=r.phase,first_recipients=r.first_recipients,calibrated_at=r.calibrated_at,score=r.score,day_score=r.day_score,score_day=r.score_day,target=r.target,
      quality=r.quality,volume=r.volume,factors=r.factors,band_limit=r.band_limit,daily_limit=r.daily_limit,clear_since=CASE WHEN s.step=r.step THEN r.clear_since ELSE s.clear_since END,
      strike_until=r.strike_until,computed_at=now() FROM r WHERE s.workspace_id=r.workspace_id RETURNING s.*)
    INSERT INTO sender_score_daily(workspace_id,day,score,quality,target,daily_limit,step) SELECT workspace_id,(now() AT TIME ZONE 'UTC')::date,score,quality,target,daily_limit,step FROM updated
    ON CONFLICT(workspace_id,day) DO UPDATE SET score=excluded.score,quality=excluded.quality,target=excluded.target,daily_limit=excluded.daily_limit,step=excluded.step`);
  await settlePaused(runtime);
  // Any workspace whose SES tenants differ from what Bane wants (a missed job, a tenant ready after the pause) is queued.
  if (!options.only) await runtime.db.execute(queueTenantStatus(tenantStatusDrift()));
  return { evaluated: rows.length, changed };
}

const LINE: Record<Reason['metric'], string> = { complaints: 'complaints', screen: 'screen', bounces: 'bounces', marketing_bounces: 'bounces', transactional_bounces: 'bounces', external: 'external' };
/** An exempt workspace crossed a restrict or pause line: one operator alert per line per UTC day (reputation.alert). */
async function alertExempt(runtime: Runtime, wid: string, next: { step: Step; reasons: Reason[] }, input: LadderInput) {
  const top = [...next.reasons].sort((a, b) => stepRank(b.step) - stepRank(a.step))[0];
  const line = top ? LINE[top.metric] : 'reputation', scope = next.step === 'pause' ? 'all' : 'marketing';
  const { rows } = await runtime.db.execute(sql`INSERT INTO jobs(id,type,workspace_id,payload) VALUES('exempt-over-line:'||${wid}::text||':'||${line}::text||':'||to_char(now() AT TIME ZONE 'UTC','YYYYMMDD'),'reputation.alert',${wid},
    ${JSON.stringify({ code: 'HOSTED_EXEMPT_OVER_LINE', line, scope, step: next.step, reasons: next.reasons.map(r => r.code), sends: input.day.accepted, bounces: input.day.bounces, complaints: input.day.complaints, rejected: input.rejected, screened: input.screened })}::jsonb)
    ON CONFLICT(id) DO NOTHING RETURNING id`);
  if (rows.length) log('error', { code: 'HOSTED_EXEMPT_OVER_LINE', workspaceId: wid, line, step: next.step, held: false });
}

/** Queued mail of a workspace paused for 72 hours is canceled (ACCOUNT_PAUSED); expired operator overrides end. */
async function settlePaused(runtime: Runtime) {
  await runtime.db.execute(sql`WITH due AS MATERIALIZED (
      SELECT e.id FROM provider_connections pc JOIN sending_emails e ON e.workspace_id=pc.workspace_id AND e.status='queued'
      WHERE pc.kind='shared' AND pc.paused_at<now()-interval '72 hours' AND pc.resume_pending_at IS NULL AND (e.campaign_id IS NULL OR EXISTS (
        SELECT 1 FROM sending_campaigns p WHERE p.workspace_id=e.workspace_id AND p.id=e.campaign_id FOR NO KEY UPDATE OF p SKIP LOCKED))
      ORDER BY e.id LIMIT 1000 FOR UPDATE OF e SKIP LOCKED
    ), canceled AS (UPDATE sending_emails e SET status='canceled',error_code='ACCOUNT_PAUSED',lease_until=NULL,updated_at=clock_timestamp()
      WHERE e.id IN (SELECT id FROM due) AND e.status='queued' RETURNING ${terminalColumns}
    ), ${terminalEvents(sql`SELECT * FROM canceled`)} SELECT count(*)::int AS n FROM canceled`);
  await runtime.db.execute(sql`WITH expired AS (UPDATE workspaces w SET send_cap_override=NULL,send_cap_override_expires_at=NULL
      WHERE send_cap_override_expires_at<=now() RETURNING w.id)
    INSERT INTO hosted_operator_audit(workspace_id,action,details,via,reason) SELECT id,'limit-override-expired','{}'::jsonb,'job','The operator limit override reached its expiry.' FROM expired`);
}

/** Every ten minutes, one runner at a time (a durable election, like the daily depth reconcile). Best effort. */
export async function standingTick(runtime: Runtime) {
  if (!runtime.config.multiTenant) return;
  try {
    const { rows } = await runtime.db.execute(sql`INSERT INTO job_schedule(workspace_id,next_wake_at) VALUES ('maintenance:standing',now()+interval '10 minutes')
      ON CONFLICT(workspace_id) DO UPDATE SET next_wake_at=excluded.next_wake_at WHERE job_schedule.next_wake_at<=now() RETURNING 1`);
    if (!rows.length) return;
    const result = await refreshStanding(runtime);
    log('info', { code: 'STANDING_REFRESHED', ...result });
  } catch (error) { log('warn', { code: 'STANDING_REFRESH_FAILED', message: error instanceof ApiError ? error.code : 'The next run retries.' }); }
}

// ---------- AWS tenant status (EventBridge → the pool's feedback SNS topic) ----------
/** An SES "Sending Status Enabled/Disabled" EventBridge event for a tenant, as delivered through SNS. */
export function tenantStatusEvent(message: Record<string, unknown>) {
  const m = message as { source?: unknown; 'detail-type'?: unknown; account?: unknown; region?: unknown; resources?: unknown; detail?: { data?: { origin?: unknown; record?: { status?: unknown; cause?: unknown } } } };
  if (m.source !== 'aws.ses' || (m['detail-type'] !== 'Sending Status Disabled' && m['detail-type'] !== 'Sending Status Enabled')) return null;
  const arn = Array.isArray(m.resources) ? m.resources[0] : null, origin = m.detail?.data?.origin, status = m.detail?.data?.record?.status;
  if (typeof arn !== 'string' || !/^arn:aws:ses:[a-z0-9-]+:\d{12}:tenant\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9-]+$/.test(arn) || (origin !== 'AWS_SES' && origin !== 'CUSTOMER_MANAGED')
    || (status !== 'ENABLED' && status !== 'DISABLED' && status !== 'REINSTATED') || typeof m.account !== 'string') return null;
  return { arn, account: m.account, region: typeof m.region === 'string' ? m.region : null, tenant: arn.split('/')[1]!, origin, status, cause: typeof m.detail?.data?.record?.cause === 'string' ? m.detail.data.record.cause.slice(0, 300) : null } as const;
}
/**
 * Mirrors AWS's own tenant pauses. A DISABLED from AWS (or from the strict reputation policy, which sets the
 * customer-managed status with its own cause) pauses the workspace (SES_TENANT_PAUSED): only an operator resumes it,
 * after AWS reinstates the tenant. Bane's own switch ("Status manually updated.") and every enable are timeline only.
 *
 * A valid SNS signature proves which topic published the bytes, not that SES wrote them: a BYO account controls what
 * its own topic publishes. So an event counts only when it arrived on a Bane-owned shared topic (topicKind, set by the
 * ingress from the topic's registration), its account, the tenant ARN's account and the topic's account agree, the
 * ARN's region is the topic's region, and the ARN is a tenant Bane recorded as owned (hosted_tenant_ownership) by a
 * shared connection whose pool or regional topic is that topic. A name never authorizes a target. Returns the refusal
 * code, or null when accepted.
 */
export async function ingestTenantStatus(runtime: Runtime, event: NonNullable<ReturnType<typeof tenantStatusEvent>>, source: { topicArn: string; region: string; topicKind?: 'byo' | 'shared' }) {
  const [, , , topicRegion, topicAccount] = source.topicArn.split(':'), [, , , arnRegion, arnAccount] = event.arn.split(':');
  const refuse = (code: string) => { log('warn', { code: 'SES_TENANT_STATUS_REFUSED', reason: code, tenant: event.arn, topic: source.topicArn, status: event.status }); return code; };
  if (source.topicKind !== 'shared') return refuse('SNS_TOPIC_NOT_ALLOWED');
  if (event.account !== topicAccount || arnAccount !== topicAccount) return refuse('SES_ACCOUNT_MISMATCH');
  if (arnRegion !== topicRegion || source.region !== topicRegion || (event.region !== null && event.region !== topicRegion)) return refuse('SES_TENANT_NOT_OWNED');
  const { rows: [owner] } = await runtime.db.execute<{ workspace_id: string }>(sql`SELECT c.workspace_id FROM hosted_tenant_ownership o
    JOIN provider_connections c ON c.workspace_id=o.workspace_id AND c.kind='shared'
    WHERE o.arn=${event.arn} AND o.region=${arnRegion} AND (
      EXISTS (SELECT FROM provider_pool_regions p WHERE p.feedback_topic_arn=${source.topicArn} AND p.region=${arnRegion} AND p.aws_account_id=${arnAccount})
      OR EXISTS (SELECT FROM provider_connection_regions r WHERE r.connection_id=c.id AND r.region=${arnRegion} AND r.feedback_topic_arn=${source.topicArn} AND c.aws_account_id=${arnAccount}))`);
  if (!owner) return refuse('SES_TENANT_NOT_OWNED');
  const ours = event.origin === 'CUSTOMER_MANAGED' && event.cause === 'Status manually updated.';
  const pause = event.status === 'DISABLED' && !ours;
  await runtime.db.transaction(tx => applyChange(tx, { workspaceId: owner.workspace_id, actor: { kind: 'system', via: 'ses' }, kind: 'tenant',
    ...(pause ? { step: 'pause', pauseKind: 'full', pause: { message: 'Hosted sending paused: AWS paused this workspace’s SES tenant. Bane reviews it with AWS before sending resumes.' },
      reasons: [{ code: 'SES_TENANT_PAUSED', metric: 'external', value: 0, count: 0, threshold: 0, minimum: 0, window: null, step: 'pause', message: event.cause ?? 'AWS paused the SES tenant.' }] } : {}),
    details: { tenant: event.arn, origin: event.origin, status: event.status, cause: event.cause } }));
  log(pause ? 'error' : 'info', { code: 'SES_TENANT_STATUS', workspaceId: owner.workspace_id, origin: event.origin, status: event.status, paused: pause });
  // AWS's pause applies to every workspace, exempt (first-party) ones included: alert the operators loudly, once per tenant a day.
  if (pause) await runtime.db.execute(sql`INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'tenant-paused:'||${event.arn}::text||':'||to_char(now() AT TIME ZONE 'UTC','YYYYMMDD'),'reputation.alert',${owner.workspace_id},
    jsonb_build_object('code','SES_TENANT_PAUSED','tenant',${event.arn}::text,'cause',${event.cause}::text,'exempt',w.exempt_hosted_quotas) FROM workspaces w WHERE w.id=${owner.workspace_id} ON CONFLICT(id) DO NOTHING`);
  return null;
}

// ---------- owner emails ----------
const stepWords: Record<Step, string> = { ok: 'in good standing', notice: 'noted', warn: 'warned', restrict: 'restricted: marketing is held', pause: 'paused' };
export function noticeText(o: { workspace: string; step: Step; reasons: Reason[]; quarantine?: { campaign: string; message: string } | null; dashboard: string; marketingHeld: boolean }) {
  const did = o.quarantine ? `Bane paused the campaign "${o.quarantine.campaign}". Your other mail is unaffected.`
    : o.step === 'pause' ? 'Bane paused all sending from this workspace. Receiving, inboxes, reads and the dashboard keep working. Queued mail is held for 72 hours, then canceled.'
    : o.step === 'restrict' ? 'Bane holds marketing (campaigns and marketing sends). Receipts, password resets and other transactional mail still send.'
    : 'Nothing is held yet. Your daily limit stays where it is (it will not rise) until this clears.';
  const fix = o.quarantine ? ['Remove the contacts that bounced and any you have not mailed before.', 'Check where the list came from and that every contact opted in.', 'Resume the campaign from its page, or ask for a review.']
    : ['Find the campaign or domain named above and stop sending to the addresses that bounced or complained.', 'Remove contacts you cannot show opted in, and old or bought lists.', o.step === 'warn' ? 'Keep sending as usual: the warning clears by itself after 24 hours under the line.' : 'Open the dashboard to follow the checklist, release it when allowed, or ask for a review.'];
  const what = o.quarantine ? o.quarantine.message : o.reasons.filter(r => r.step !== 'notice').map(r => `- ${r.message}`).join('\n') || '- Sending standing changed.';
  return { subject: o.quarantine ? `Bane paused a campaign in ${o.workspace}` : `Bane: ${o.workspace} is ${stepWords[o.step]}`,
    text: `What happened\n${what}\n\nWhat Bane did\n${did}\n\nHow to fix it\n${fix.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\nOpen the dashboard: ${o.dashboard}\nThe thresholds are published at ${o.dashboard.replace(/\/$/, '')}/docs#sending-limits\n` };
}
/**
 * Emails the workspace's owners and admins about a standing change, through the platform workspace's own sending
 * (BANE_NOTIFY_FROM on the platform domain). Without that configuration the dashboard and webhook still carry it.
 */
export const notifyJob: JobHandler = retryDatabaseFailures(async (runtime, payload, job) => {
  const from = runtime.config.notifyFrom, sender = runtime.config.platformDomainWorkspace;
  const [event] = (await runtime.db.execute<{ kind: string; to_step: Step; reasons: Reason[]; details: Record<string, unknown>; name: string; recipients: string[] }>(sql`SELECT e.kind,e.to_step,e.reasons,e.details,w.name,
      ARRAY(SELECT u.email FROM workspace_members m JOIN bane_users u ON u.id=m.user_id WHERE m.workspace_id=e.workspace_id AND m.role IN ('owner','admin') AND u.email_verified ORDER BY u.email LIMIT 20) AS recipients
    FROM standing_events e JOIN workspaces w ON w.id=e.workspace_id WHERE e.id=${String(payload.eventId)} AND e.workspace_id=${job.workspaceId}`)).rows;
  if (!event || !event.recipients.length) return;
  if (!from || !sender || !runtime.config.multiTenant) { log('info', { code: 'STANDING_NOTIFY_SKIPPED', workspaceId: job.workspaceId, step: event.to_step, reason: 'BANE_NOTIFY_FROM or the platform workspace is not configured' }); return; }
  const quarantine = event.kind === 'quarantine' ? { campaign: String(event.details.campaignName ?? 'campaign'), message: String(event.details.message ?? '') } : null;
  // Workspace and campaign names are the customer's: one line, bounded, so the subject is always a valid header.
  const oneLine = (v: string) => v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 100) || 'your workspace';
  if (quarantine) quarantine.campaign = oneLine(quarantine.campaign);
  const notice = noticeText({ workspace: oneLine(event.name), step: event.to_step, reasons: event.reasons, quarantine, dashboard: runtime.config.publicUrl, marketingHeld: event.to_step === 'restrict' });
  const { sendSystemEmail } = await import('./sending.js');
  await sendSystemEmail(runtime, sender, { from, to: event.recipients, subject: notice.subject, text: notice.text, idempotencyKey: `standing:${String(payload.eventId)}`, standingEvent: String(payload.eventId) });
  log('info', { code: 'STANDING_NOTIFIED', workspaceId: job.workspaceId, step: event.to_step, recipients: event.recipients.length, simulated: isSimulatedSes(runtime) });
});
export const standingJobs: Record<string, JobHandler> = { 'standing.notify': notifyJob };
