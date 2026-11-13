// Sender standing: the pure model behind the ten-minute standing job (standing.ts), GET /v1/sender-score and the
// published thresholds (docs/sending-limits.md). No I/O here, so the job, the route and the tests share it.
//
//   factor score  s = 100 × clamp((bad − x) ÷ (bad − good), 0, 1), x a rate decayed with a 30-day half-life
//   quality       Q = Σ weight·s ÷ Σ weight over measured factors (neutral ones drop out, the rest re-weigh)
//   target        T = (n·Q + 250·60) ÷ (n + 250), n = decayed accepted volume: no evidence sits at 60 (100/day)
//   calibrating   until 100 real recipients were accepted and 24 hours passed: 100/day, no score
//   score         starts at min(65, T) when calibration ends; each UTC day moves towards T by at most +5 / −10
//   limit         100 × 10^((score − 60) ÷ 15), snapped to the bands below; it drops only 2 points under a band
//   ladder        notice → warn → restrict (marketing held) → pause (all sending), each line a count and a rate

export const GRADES = ['A+', 'A', 'B', 'C', 'D', 'F'] as const;
export type Grade = (typeof GRADES)[number];
export const GRADE_BANDS: { grade: Grade; min: number }[] = [{ grade: 'A+', min: 95 }, { grade: 'A', min: 90 }, { grade: 'B', min: 80 }, { grade: 'C', min: 70 }, { grade: 'D', min: 60 }, { grade: 'F', min: 0 }];
export const gradeOf = (score: number): Grade => GRADE_BANDS.find(b => score >= b.min)!.grade;

/** Score → daily limit (rolling 24 hours, recipients). Published. */
export const LIMIT_BANDS = [
  { min: 90, limit: 10_000 }, { min: 85, limit: 5_000 }, { min: 80, limit: 2_000 }, { min: 75, limit: 1_000 },
  { min: 70, limit: 500 }, { min: 65, limit: 200 }, { min: -Infinity, limit: 100 },
] as const;
export const CALIBRATION = { recipients: 100, hours: 24, start: 65, limit: 100 };
export const SCORE = { prior: 60, confidence: 250, halfLifeDays: 30, maxRise: 5, maxFall: 10, hysteresis: 2, historyDays: 180 };
export const bandFor = (score: number) => LIMIT_BANDS.find(b => score >= b.min)!;
export const nextBand = (score: number) => [...LIMIT_BANDS].reverse().find(b => b.min > score) ?? null;
/** Per minute: clamp(limit ÷ 20, 50, 500); marketing per hour max(25, limit ÷ 4); the reserve max(100, 10%). */
export const burstFor = (limit: number) => Math.min(500, Math.max(50, Math.floor(limit / 20)));
export const marketingHourFor = (limit: number) => Math.max(25, Math.floor(limit / 4));
export const reserveFor = (limit: number) => Math.max(Math.min(100, limit), Math.ceil(limit * 0.1));

/** The band a score holds: rises at the band floor, drops only `hysteresis` points under it. */
export function bandLimit(score: number, current: number) {
  const up = bandFor(score).limit;
  if (up >= current) return up;
  return Math.max(up, Math.min(current, bandFor(score + SCORE.hysteresis).limit));
}

export const FACTOR_KEYS = ['complaints', 'content', 'bounces', 'hygiene', 'auth', 'engagement'] as const;
export type FactorKey = (typeof FACTOR_KEYS)[number];
export const FACTORS: Record<FactorKey, { label: string; weight: number; good: number; bad: number; basis: string }> = {
  complaints: { label: 'Complaints', weight: 30, good: 0.0001, bad: 0.003, basis: 'Spam complaints ÷ delivered emails. 0.3% is the line mailbox providers enforce.' },
  content: { label: 'Spam screen', weight: 20, good: 0.001, bad: 0.03, basis: 'Emails the content screen rejected as spam ÷ emails it screened. Neutral when the workspace is not screened.' },
  bounces: { label: 'Bounces', weight: 15, good: 0.005, bad: 0.05, basis: 'Hard bounces to known recipients ÷ accepted emails to them. Mail sent through the API counts as known.' },
  hygiene: { label: 'List quality', weight: 15, good: 0.02, bad: 0.10, basis: 'Hard bounces of first sends (campaign mail) plus suppression-list hits ÷ those emails. First sends are expected to bounce more.' },
  auth: { label: 'Authentication', weight: 10, good: 1, bad: 0, basis: 'By sending volume: DKIM signing 40%, a verified custom MAIL FROM (aligned SPF) 30%, DMARC enforcing 30% (p=none 15%). Neutral without verified domains.' },
  engagement: { label: 'Engagement', weight: 10, good: 0.002, bad: 0.02, basis: 'Marketing unsubscribes ÷ delivered marketing email, lifted up to 10 points by tracked clicks. Opens are ignored. Neutral without marketing mail.' },
};

export type DayEvidence = { day: string; emails: number; accepted: number; delivered: number; bounced: number; first_sends: number; first_bounced: number;
  complained: number; screened: number; rejected: number; suppressed: number; marketing_delivered: number; unsubscribed: number; clicked: number };
export type DomainAuth = { name: string; dkim: boolean; mailFrom: boolean; dmarc: string | null; emails: number };
export type Factor = { key: FactorKey; label: string; weight: number; value: number | null; score: number | null; points: number | null; source: 'measured' | 'neutral'; basis: string };
export type Quality = { quality: number; volume: number; target: number; factors: Factor[] };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const round = (v: number, digits = 1) => Math.round(v * 10 ** digits) / 10 ** digits;
const DAY_MS = 86_400_000;
const subscore = (key: FactorKey, x: number) => { const { good, bad } = FACTORS[key]; return 100 * clamp((bad - x) / (bad - good), 0, 1); };
// DKIM 40 + aligned SPF 30 + DMARC 30 (p=none half), weighted by each domain's mail, or evenly when there is none.
export function authShare(domains: DomainAuth[]): number | null {
  if (!domains.length) return null;
  const share = (d: DomainAuth) => (d.dkim ? 0.4 : 0) + (d.mailFrom ? 0.3 : 0) + (d.dmarc === 'quarantine' || d.dmarc === 'reject' ? 0.3 : d.dmarc === 'none' ? 0.15 : 0);
  const volume = domains.reduce((sum, d) => sum + d.emails, 0);
  return volume ? domains.reduce((sum, d) => sum + share(d) * d.emails, 0) / volume : domains.reduce((sum, d) => sum + share(d), 0) / domains.length;
}

/** Quality, decayed volume and target from daily evidence (30-day half-life) and the domains' authentication. */
export function quality(days: DayEvidence[], domains: DomainAuth[], screened: boolean, today: string): Quality {
  const end = Date.parse(today + 'T00:00:00Z'), t = { accepted: 0, delivered: 0, bounced: 0, known: 0, firstSends: 0, firstBad: 0, complained: 0, screened: 0, rejected: 0, mDelivered: 0, unsub: 0, clicked: 0 };
  for (const d of days) {
    const age = Math.max(0, (end - Date.parse(d.day + 'T00:00:00Z')) / DAY_MS);
    if (age > SCORE.historyDays) continue;
    const w = 2 ** (-age / SCORE.halfLifeDays);
    t.accepted += w * d.accepted; t.delivered += w * d.delivered; t.complained += w * d.complained;
    t.known += w * (d.accepted - d.first_sends); t.bounced += w * (d.bounced - d.first_bounced);
    t.firstSends += w * (d.first_sends + d.suppressed); t.firstBad += w * (d.first_bounced + d.suppressed);
    t.screened += w * d.screened; t.rejected += w * d.rejected;
    t.mDelivered += w * d.marketing_delivered; t.unsub += w * d.unsubscribed; t.clicked += w * d.clicked;
  }
  const values: Record<FactorKey, number | null> = {
    complaints: t.delivered >= 1 ? t.complained / t.delivered : null,
    content: screened && t.screened >= 1 ? t.rejected / t.screened : null,
    bounces: t.known >= 1 ? t.bounced / t.known : null,
    hygiene: t.firstSends >= 1 ? t.firstBad / t.firstSends : null,
    auth: authShare(domains),
    engagement: t.mDelivered >= 1 ? t.unsub / t.mDelivered : null,
  };
  const factors: Factor[] = FACTOR_KEYS.map(key => {
    const spec = FACTORS[key], value = values[key];
    if (value === null) return { key, label: spec.label, weight: spec.weight, value: null, score: null, points: null, source: 'neutral', basis: spec.basis };
    let score = subscore(key, value);
    if (key === 'engagement') score = Math.min(100, score + Math.min(10, 500 * (t.clicked / t.mDelivered)));
    return { key, label: spec.label, weight: spec.weight, value: round(value, 6), score: round(score), points: round(spec.weight * score / 100, 2), source: 'measured', basis: spec.basis };
  });
  const measured = factors.filter(f => f.source === 'measured'), weight = measured.reduce((s, f) => s + f.weight, 0);
  const q = weight ? measured.reduce((s, f) => s + f.weight * f.score! / 100, 0) / weight * 100 : SCORE.prior;
  return { quality: round(q, 2), volume: round(t.accepted, 2), target: round((t.accepted * q + SCORE.confidence * SCORE.prior) / (t.accepted + SCORE.confidence), 2), factors };
}

export type ScoreState = { phase: 'seed' | 'calibrating' | 'graded'; firstRecipients: number; calibratedAt: string | null; score: number | null; dayScore: number | null; scoreDay: string | null };
/** Moves the published score towards its target: calibration, then at most +5 / −10 per UTC day. */
export function moveScore(prev: ScoreState, target: number, firstRecipients: number, now: Date): ScoreState {
  const today = now.toISOString().slice(0, 10), recipients = Math.min(CALIBRATION.recipients, Math.max(prev.firstRecipients, firstRecipients));
  if (prev.phase === 'seed') {
    // Existing senders already have evidence: start at the target (no calibration and no 65 start) once.
    if (recipients < CALIBRATION.recipients) return { phase: 'calibrating', firstRecipients: recipients, calibratedAt: null, score: null, dayScore: null, scoreDay: null };
    const score = round(target, 2);
    return { phase: 'graded', firstRecipients: recipients, calibratedAt: prev.calibratedAt ?? now.toISOString(), score, dayScore: score, scoreDay: today };
  }
  if (prev.phase === 'calibrating') {
    const calibratedAt = prev.calibratedAt ?? (recipients >= CALIBRATION.recipients ? now.toISOString() : null);
    if (!calibratedAt || now.getTime() - Date.parse(calibratedAt) < CALIBRATION.hours * 3600_000) return { ...prev, firstRecipients: recipients, calibratedAt };
    const score = round(Math.min(CALIBRATION.start, target), 2);
    return { phase: 'graded', firstRecipients: recipients, calibratedAt, score, dayScore: score, scoreDay: today };
  }
  const dayScore = prev.scoreDay === today && prev.dayScore !== null ? prev.dayScore : prev.score ?? CALIBRATION.start;
  // The day calibration ends, the starting score is that day's: the first rise comes the next UTC day.
  const graduated = !!prev.calibratedAt && new Date(Date.parse(prev.calibratedAt) + CALIBRATION.hours * 3600_000).toISOString().slice(0, 10) === today;
  const score = round(clamp(target, dayScore - SCORE.maxFall, dayScore + (graduated ? 0 : SCORE.maxRise)), 2);
  return { ...prev, firstRecipients: recipients, score, dayScore, scoreDay: today };
}

// ---------- the ladder ----------
export const STEPS = ['ok', 'notice', 'warn', 'restrict', 'pause'] as const;
export type Step = (typeof STEPS)[number];
export const stepRank = (s: Step) => STEPS.indexOf(s);
export type Window = { accepted: number; bounces: number; complaints: number; marketingAccepted: number; marketingBounces: number; marketingComplaints: number };
export type LadderInput = { day: Window; week: Window; screened: number; rejected: number };
export type Reason = { code: string; metric: 'complaints' | 'bounces' | 'marketing_bounces' | 'transactional_bounces' | 'screen' | 'external'; value: number; count: number; threshold: number; minimum: number; window: '24h' | '7d' | null; step: Step; message: string };
/** Ladder lines. Every line is a count and a rate together, so a few events never trip a small sender. Published. */
export const LADDER = {
  complaints: { warn: [{ rate: 0.0005, count: 2, window: '24h' }, { rate: 0.0005, count: 3, window: '7d' }], restrict: [{ rate: 0.001, count: 3, window: '24h' }], pause: [{ rate: 0.003, count: 5, window: '24h' }, { rate: 0.0015, count: 10, window: '7d' }] },
  bounces: { warn: [{ rate: 0.02, count: 10, window: '24h' }, { rate: 0.015, count: 10, window: '7d' }] },
  marketingBounces: { restrict: [{ rate: 0.04, count: 25, window: '24h' }] },
  // The pool-emergency line: any mail at 8%. Bounces alone hold marketing; they stop transactional mail only below.
  anyBounces: { restrict: [{ rate: 0.08, count: 50, window: '24h' }] },
  transactionalBounces: { pause: [{ rate: 0.05, count: 50, window: '24h' }] },
  screen: { warn: [{ rate: 0.02, count: 3 }], restrict: [{ rate: 0.05, count: 10 }], pause: [{ rate: 0.1, count: 25 }] },
  notice: { complaints: 1, bounces: 3, bounceRate: 0.01 },
} as const;
const pct = (v: number) => `${(100 * v).toFixed(2).replace(/\.?0+$/, '')}%`;

/** The highest ladder line the windows cross, and every line crossed. `pause_kind` says what a pause is for. */
export function evaluateLadder(input: LadderInput): { level: Step; reasons: Reason[]; pauseKind: 'bounce' | 'full' | null } {
  const reasons: Reason[] = [];
  const check = (metric: Reason['metric'], step: Step, lines: readonly { rate: number; count: number; window?: string }[], count: (w: '24h' | '7d') => number, total: (w: '24h' | '7d') => number, what: string) => {
    for (const line of lines) {
      const w = (line.window ?? '24h') as '24h' | '7d', n = count(w), d = total(w), rate = d > 0 ? n / d : n > 0 ? 1 : 0;
      if (n >= line.count && rate >= line.rate) {
        reasons.push({ code: `${metric.toUpperCase()}_${step.toUpperCase()}`, metric, value: round(rate, 6), count: n, threshold: line.rate, minimum: line.count, window: metric === 'screen' ? '24h' : w, step,
          message: `${n.toLocaleString('en-US')} of ${d.toLocaleString('en-US')} ${what} in ${w === '24h' ? '24 hours' : '7 days'} (${pct(rate)}; the ${step} line is ${pct(line.rate)} and ${line.count}).` });
        return;
      }
    }
  };
  const win = (w: '24h' | '7d') => w === '24h' ? input.day : input.week;
  for (const step of ['pause', 'restrict', 'warn'] as const) {
    const lines = LADDER.complaints[step as keyof typeof LADDER.complaints];
    if (lines) check('complaints', step, lines, w => win(w).complaints, w => win(w).accepted, 'accepted emails were marked as spam');
    const screen = LADDER.screen[step];
    check('screen', step, screen, () => input.rejected, () => input.screened, 'screened emails were rejected as spam');
  }
  check('transactional_bounces', 'pause', LADDER.transactionalBounces.pause, w => win(w).bounces - win(w).marketingBounces, w => win(w).accepted - win(w).marketingAccepted, 'transactional emails hard-bounced');
  check('marketing_bounces', 'restrict', LADDER.marketingBounces.restrict, w => win(w).marketingBounces, w => win(w).marketingAccepted, 'marketing emails hard-bounced');
  check('bounces', 'restrict', LADDER.anyBounces.restrict, w => win(w).bounces, w => win(w).accepted, 'emails hard-bounced');
  check('bounces', 'warn', LADDER.bounces.warn, w => win(w).bounces, w => win(w).accepted, 'emails hard-bounced');
  const top = reasons.reduce<Step>((s, r) => stepRank(r.step) > stepRank(s) ? r.step : s, 'ok');
  // Keep only the highest line per metric.
  const kept = reasons.filter(r => !reasons.some(o => o !== r && o.metric === r.metric && stepRank(o.step) > stepRank(r.step)));
  if (top === 'ok') {
    const d = input.day;
    if (d.complaints >= LADDER.notice.complaints) kept.push({ code: 'COMPLAINT_NOTICE', metric: 'complaints', value: d.accepted ? round(d.complaints / d.accepted, 6) : 1, count: d.complaints, threshold: 0, minimum: 1, window: '24h', step: 'notice', message: `${d.complaints} accepted ${d.complaints === 1 ? 'email was' : 'emails were'} marked as spam in 24 hours.` });
    else if (d.bounces >= LADDER.notice.bounces && d.accepted && d.bounces / d.accepted >= LADDER.notice.bounceRate) kept.push({ code: 'BOUNCE_NOTICE', metric: 'bounces', value: round(d.bounces / d.accepted, 6), count: d.bounces, threshold: LADDER.notice.bounceRate, minimum: LADDER.notice.bounces, window: '24h', step: 'notice', message: `${d.bounces} of ${d.accepted} accepted emails hard-bounced in 24 hours (${pct(d.bounces / d.accepted)}).` });
    return { level: kept.length ? 'notice' : 'ok', reasons: kept, pauseKind: null };
  }
  const pauseKind = top !== 'pause' ? null : kept.some(r => r.step === 'pause' && r.metric !== 'transactional_bounces') ? 'full' : 'bounce';
  return { level: top, reasons: kept, pauseKind };
}

export type StandingState = { step: Step; reasons: Reason[]; since: string; clearSince: string | null; pauseKind: 'bounce' | 'full' | null };
/**
 * The next step. Steps rise as soon as a line is crossed. A warn clears by itself once every metric stayed under 80%
 * of its warn line for 24 hours; a notice clears as soon as nothing triggers it. A restrict or pause never clears by
 * itself: an owner releases it (bounce-only) or an operator does. A pause is applied by the caller (it stops mail).
 */
export function nextStanding(prev: StandingState, input: LadderInput, now: Date): StandingState {
  const at = now.toISOString(), evaluation = evaluateLadder(input);
  if (stepRank(evaluation.level) > stepRank(prev.step) && stepRank(evaluation.level) >= stepRank('warn'))
    return { step: evaluation.level, reasons: evaluation.reasons, since: at, clearSince: null, pauseKind: evaluation.pauseKind };
  if (prev.step === 'pause' || prev.step === 'restrict') {
    // A transactional bounce problem during a restrict still escalates (handled above); otherwise keep the reasons.
    return { ...prev, reasons: stepRank(evaluation.level) >= stepRank(prev.step) ? evaluation.reasons : prev.reasons };
  }
  if (prev.step === 'warn') {
    const under = belowClearLine(input);
    if (stepRank(evaluation.level) >= stepRank('warn') || !under) return { ...prev, reasons: stepRank(evaluation.level) >= stepRank('warn') ? evaluation.reasons : prev.reasons, clearSince: null };
    const clearSince = prev.clearSince ?? at;
    if (now.getTime() - Date.parse(clearSince) < 24 * 3600_000) return { ...prev, clearSince };
    return { step: evaluation.level, reasons: evaluation.reasons, since: at, clearSince: null, pauseKind: null };
  }
  if (evaluation.level !== prev.step) return { step: evaluation.level, reasons: evaluation.reasons, since: at, clearSince: null, pauseKind: null };
  return { ...prev, reasons: evaluation.reasons };
}
/** Every metric under 80% of its warn line (rate and count alike). */
export function belowClearLine(input: LadderInput) {
  const f = 0.8, d = input.day, w = input.week;
  const rate = (n: number, total: number) => total > 0 ? n / total : n > 0 ? 1 : 0;
  const under = (n: number, total: number, line: { rate: number; count: number }) => n < line.count * f || rate(n, total) < line.rate * f;
  return under(d.complaints, d.accepted, LADDER.complaints.warn[0]) && under(w.complaints, w.accepted, LADDER.complaints.warn[1])
    && under(d.bounces, d.accepted, LADDER.bounces.warn[0]) && under(w.bounces, w.accepted, LADDER.bounces.warn[1])
    && under(input.rejected, input.screened, LADDER.screen.warn[0]);
}

// ---------- asking for more (reputation-and-ops-design §3.5) ----------
/** Auto-approval of "Request a higher limit": score ≥ 90 for 14 days, no ladder step in 30 days, at most 25,000 a day. */
export const LIMIT_REQUEST = { minScore: 90, scoreDays: 14, quietDays: 30, maxAuto: 25_000 } as const;
export type LimitRequest = { eligibleForAutoApproval: boolean; reasons: { code: string; message: string }[]; maxAuto: number };
/**
 * Whether a limit request qualifies for auto-approval now. `days` are the published daily scores (sender_score_daily),
 * `steps` the ladder steps (warn, restrict, pause) entered in the last 30 days, `requested` the limit asked for, if known.
 * Notice is not a ladder step: it is a note on the score card.
 */
export function limitRequestEligibility(o: { phase: ScoreState['phase'] | null; step: Step | null; days: { day: string; score: number | null }[]; steps: number; today: string; requested?: number }): LimitRequest {
  const reasons: LimitRequest['reasons'] = [], { minScore, scoreDays, quietDays, maxAuto } = LIMIT_REQUEST;
  if (o.phase === null) reasons.push({ code: 'NO_STANDING', message: 'This workspace has no sender standing (Bane Hosted sending only), so a limit request goes to a person.' });
  else if (o.phase !== 'graded') reasons.push({ code: 'CALIBRATING', message: 'The score is still calibrating; it needs 100 real recipients and 24 hours first.' });
  // The 14 UTC days up to today, or up to yesterday before the job has written today's score.
  const byDay = new Map(o.days.map(d => [d.day, d.score])), end = Date.parse(o.today + 'T00:00:00Z') - (byDay.has(o.today) ? 0 : DAY_MS);
  const wanted = Array.from({ length: scoreDays }, (_, i) => new Date(end - i * DAY_MS).toISOString().slice(0, 10));
  const short = wanted.filter(day => { const s = byDay.get(day); return s === undefined || s === null || s < minScore; });
  if (o.phase === 'graded' && short.length) reasons.push({ code: 'SCORE_BELOW_90', message: `The score must be ${minScore} or more on each of the last ${scoreDays} days; it was not on ${short.length} of them (latest ${short[0]}).` });
  if (o.steps > 0 || (o.step !== null && stepRank(o.step) >= stepRank('warn'))) reasons.push({ code: 'RECENT_LADDER_STEP', message: `The workspace reached a warn, restrict or pause step in the last ${quietDays} days${o.step !== null && stepRank(o.step) >= stepRank('warn') ? ` (now: ${o.step})` : ''}.` });
  if (o.requested !== undefined && o.requested > maxAuto) reasons.push({ code: 'OVER_AUTO_MAXIMUM', message: `Requests above ${maxAuto.toLocaleString('en-US')} a day always go to a person.` });
  return { eligibleForAutoApproval: !reasons.length, reasons, maxAuto };
}

/** The limit admission enforces from the standing (before an operator override or a resume's restore). */
export function dailyLimit(o: { phase: ScoreState['phase']; score: number | null; band: number; step: Step; currentLimit: number; strikeCapped: boolean }) {
  if (o.phase !== 'graded' || o.score === null) return { band: CALIBRATION.limit, limit: CALIBRATION.limit };
  let band = bandLimit(o.score, o.band);
  // Warn and above freeze the limit: no rises until the step clears.
  if (stepRank(o.step) >= stepRank('warn')) band = Math.min(band, o.band);
  const limit = o.strikeCapped ? Math.max(CALIBRATION.limit, Math.floor(band / 2)) : band;
  return { band, limit };
}
