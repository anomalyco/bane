// Sender score: a per-workspace reputation grade that replaces hard sending limits as Bane's fraud and abuse signal.
// Pitch model, computed in the browser from derived and synthetic inputs; the API version would compute it daily
// on the server (see the pitch notes). Every number here is a proposal.
//
//   factor score  s = 100 × clamp((bad − x) / (bad − good), 0, 1)            (linear between two thresholds)
//   raw           R = Σ weight × s / 100                                       (0–100, weights sum to 100)
//   target        T = (n × R + K × P) / (n + K)    n = emails in 30 days, P = 75, K = 400   (trust grows with volume)
//   score         S_day = S_yesterday + clamp(T − S_yesterday, −15, +2)      (climbs slowly, falls fast)
//   no grade until the first 100 emails; caps: 24 h complaints ≥ 0.5 % or bounces ≥ 10 % → at most D.

export type Grade = 'A+' | 'A' | 'B' | 'C' | 'D' | 'F'
export const gradeBands: readonly { grade: Grade; min: number }[] = [
  { grade: 'A+', min: 95 }, { grade: 'A', min: 90 }, { grade: 'B', min: 80 }, { grade: 'C', min: 70 }, { grade: 'D', min: 60 }, { grade: 'F', min: 0 },
]
export const WARMUP_EMAILS = 100
export const PRIOR = 75
export const CONFIDENCE = 400
export const MAX_RISE = 2
export const MAX_FALL = 15

export type FactorKey = 'complaints' | 'bounces' | 'content' | 'auth' | 'hygiene' | 'consistency'
export type FactorSpec = { key: FactorKey; label: string; short: string; weight: number; good: number; bad: number; format: (value: number) => string; source: string }
const pct = (digits: number) => (value: number) => `${(value * 100).toFixed(digits)}%`
export const factorSpecs: readonly FactorSpec[] = [
  { key: 'complaints', label: 'Complaints', short: 'Compl.', weight: 25, good: 0.0002, bad: 0.003, format: pct(2), source: 'Spam reports ÷ delivered, 30 days' },
  { key: 'bounces', label: 'Bounces', short: 'Bounce', weight: 20, good: 0.01, bad: 0.08, format: pct(1), source: 'Hard bounces ÷ sent, 30 days' },
  { key: 'content', label: 'Content', short: 'Content', weight: 20, good: 0.001, bad: 0.03, format: pct(1), source: 'Share of mail the screen scores ≥ 0.7 spam (sent and forwarded)' },
  { key: 'auth', label: 'Authentication', short: 'Auth', weight: 15, good: 1, bad: 0, format: value => `${Math.round(value * 100)}%`, source: 'DKIM 40 + aligned SPF 30 + DMARC 30 (p=none counts half), by volume' },
  { key: 'hygiene', label: 'List hygiene', short: 'Lists', weight: 10, good: 0.005, bad: 0.05, format: pct(1), source: 'Sends to suppressed, unknown or disposable addresses; replies received count in your favor' },
  { key: 'consistency', label: 'Consistency', short: 'Volume', weight: 10, good: 3, bad: 20, format: value => `${value.toFixed(1)}×`, source: 'Busiest day ÷ the 7-day median before it' },
]

export type ScoreInputs = { emails: number; complaints: number; bounces: number; content: number; auth: number; hygiene: number; consistency: number }
export type FactorResult = FactorSpec & { value: number; score: number; points: number; lost: number }
export type ScoreReport =
  | { state: 'warmup'; emails: number; needed: number }
  | { state: 'graded'; emails: number; raw: number; target: number; score: number; grade: Grade; next: { grade: Grade; at: number; gap: number } | null; band: { min: number; max: number }; factors: FactorResult[]; history: number[] }

export const subscore = (value: number, good: number, bad: number) => 100 * Math.min(1, Math.max(0, (bad - value) / (bad - good)))
export const gradeFor = (score: number): Grade => gradeBands.find(band => score >= band.min)!.grade
export const gradeKey = (grade: Grade) => grade === 'A+' ? 'aplus' : grade.toLowerCase()

export function scoreReport(inputs: ScoreInputs, days = 14): ScoreReport {
  if (inputs.emails < WARMUP_EMAILS) return { state: 'warmup', emails: inputs.emails, needed: WARMUP_EMAILS }
  const factors = factorSpecs.map(spec => {
    const value = inputs[spec.key], score = subscore(value, spec.good, spec.bad), points = spec.weight * score / 100
    return { ...spec, value, score, points, lost: spec.weight - points }
  })
  const raw = factors.reduce((sum, factor) => sum + factor.points, 0)
  const target = (inputs.emails * raw + CONFIDENCE * PRIOR) / (inputs.emails + CONFIDENCE)
  const history = walk(target, days), score = history[history.length - 1]
  return { state: 'graded', emails: inputs.emails, raw, target, score, ...placing(score), factors, history }
}
// The displayed score walks towards the target a day at a time; the pitch replays the last `days` days from the
// first graded day (the prior) so the history shows how the grade moved.
function walk(target: number, days: number) {
  const history: number[] = []
  let score = PRIOR
  for (let day = 0; day < days; day++) { score += Math.max(-MAX_FALL, Math.min(MAX_RISE, target - score)); history.push(score) }
  return history
}
function placing(score: number) {
  const index = gradeBands.findIndex(band => score >= band.min), band = gradeBands[index]
  const above = index > 0 ? gradeBands[index - 1] : null
  return { grade: band.grade, band: { min: band.min, max: above?.min ?? 100 }, next: above ? { grade: above.grade, at: above.min, gap: above.min - score } : null }
}
// Pitch only: the same report pinned to another score, to show every grade band.
export function withScore(report: Extract<ScoreReport, { state: 'graded' }>, score: number): Extract<ScoreReport, { state: 'graded' }> {
  const history = walk(score, report.history.length)
  history[history.length - 1] = score
  return { ...report, target: score, score, ...placing(score), history }
}

// The step that would gain the most points, in plain words.
export function nextStep(report: Extract<ScoreReport, { state: 'graded' }>) {
  const worst = [...report.factors].sort((a, b) => b.lost - a.lost)[0]
  const advice: Record<FactorKey, string> = {
    complaints: 'Send only to people who asked for it, and make unsubscribing one click.',
    bounces: 'Remove addresses that hard-bounce, and confirm new signups.',
    content: 'Review messages the screen flags in Logs.',
    auth: 'Publish a DMARC record and a custom MAIL FROM.',
    hygiene: 'Clean lists of suppressed and unknown addresses.',
    consistency: 'Ramp big sends over a few days.',
  }
  return { factor: worst, text: advice[worst.key], points: worst.lost }
}
