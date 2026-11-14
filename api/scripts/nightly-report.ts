// The nightly report (docs/ci.md, "Nightly report and self-improve loop"): the last 24 hours of Bane's structured logs
// on production and dev against the previous seven days. It reads the Workers' lines from Workers Logs (the
// Observability telemetry API) and the mail gateway's from CloudWatch, writes a Markdown report and a JSON summary, and
// can open one GitHub issue per new problem.
//
//   CLOUDFLARE_API_TOKEN=… node --import tsx scripts/nightly-report.ts
//
// Environment:
//   CLOUDFLARE_API_TOKEN     Workers Observability read on both stages' accounts (required).
//   NIGHTLY_REPORT_DIR       reports and cached daily aggregates (default ~/.config/opensend-mx/reports).
//   NIGHTLY_REPO             the GitHub repository for deploy runs and issues (default anomalyco/nightmail).
//   NIGHTLY_FILE_ISSUES=1    open issues labeled `nightly` with gh; otherwise only list what would be filed.
//   NIGHTLY_MAX_ISSUES       new issues per run (default 5).
//   NIGHTLY_AWS_PROFILE_DEV, NIGHTLY_AWS_PROFILE_PRODUCTION   AWS CLI profiles for the gateway's CloudWatch logs.
//   NIGHTLY_END              ISO time the 24-hour window ends (default: now, rounded down to the hour).
//
// Workers Logs keeps only a few days, so each 24-hour window's aggregate is cached under <dir>/state/<stage>/ and the
// seven-day baseline is built from those files (and from whatever the API still holds the first time). The repository is
// public: an issue carries only route templates, error codes, SQLSTATEs, stage names and counts (publicText); request
// IDs stay in the private report, and stack frames and messages are never read.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Json = Record<string, any>;
type Stage = { name: 'production' | 'dev'; account: string; script: string; awsProfile?: string };
// Server errors are kept per code: when, how many workspaces, request IDs and the SQLSTATE. Stack frames and messages
// are never read: they can carry caller text (see publicText).
type Failure = { count: number; first: string; last: string; workspaces: number; requestIds: string[]; databaseCode?: string };
type Route = { method: string; route: string; total: number; c4: number; c5: number; codes: Record<string, number>; failures: Record<string, Failure>; p95?: number; n: number };
type Code = { count: number; level: 'warn' | 'error'; where: Record<string, number> };
type Background = { operation: string; code: string; count: number; level: string; category: 'webhook' | 'dispatch' | 'jobs' };
type Window = { stage: Stage['name']; from: string; to: string; events: number; expected?: number; complete?: boolean; requests: { total: number; c4: number; c5: number };
  routes: Record<string, Route>; codes: Record<string, Code>; deploys: Record<string, { total: number; c5: number; first?: string; last?: string }>;
  background: Record<string, Background>; gateway?: Record<string, number> };
type Problem = { fingerprint: string; kind: string; severity: number; title: string; facts: string[]; stages: string[] };

const HOUR = 3_600_000, DAY = 24 * HOUR, PAGE = 1000;
const here = dirname(fileURLToPath(import.meta.url));
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) throw new Error('Set CLOUDFLARE_API_TOKEN (Workers Observability read on both accounts).');
const reportDir = process.env.NIGHTLY_REPORT_DIR ?? join(homedir(), '.config/opensend-mx/reports');
const repo = process.env.NIGHTLY_REPO ?? 'anomalyco/nightmail';
const fileIssues = process.env.NIGHTLY_FILE_ISSUES === '1';
const maxIssues = Number(process.env.NIGHTLY_MAX_ISSUES ?? 5);
const end = process.env.NIGHTLY_END ? Date.parse(process.env.NIGHTLY_END) : Math.floor(Date.now() / HOUR) * HOUR;
if (!Number.isFinite(end)) throw new Error('NIGHTLY_END must be an ISO time.');

// Each stage's account and Worker name come from its wrangler config.
function stage(name: Stage['name'], config: string): Stage {
  const text = readFileSync(join(here, '..', config), 'utf8');
  const field = (key: string) => new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`).exec(text)?.[1];
  const account = field('account_id'), script = field('name');
  if (!account || !script) throw new Error(`${config} has no account_id or name.`);
  return { name, account, script, awsProfile: process.env[`NIGHTLY_AWS_PROFILE_${name.toUpperCase()}`] };
}
const stages = [stage('production', 'wrangler.prod.jsonc'), stage('dev', 'wrangler.dev.jsonc')];

const str = (value: unknown) => typeof value === 'string' && value ? value : undefined;
const iso = (ms: number) => new Date(ms).toISOString();
const p95 = (values: number[]) => { if (!values.length) return undefined; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]; };
const round = (value: number) => Math.round(value);
const pct = (part: number, whole: number) => whole ? `${(100 * part / whole).toFixed(part / whole < 0.01 ? 2 : 1)}%` : '–';
const cell = (value: unknown) => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
const table = (head: string[], rows: unknown[][]) => rows.length ? [`| ${head.join(' | ')} |`, `|${head.map(() => ' --- ').join('|')}|`, ...rows.map(row => `| ${row.map(cell).join(' | ')} |`)].join('\n') : '_None._';

async function telemetry(target: Stage, body: Json): Promise<Json> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${target.account}/workers/observability/telemetry/query`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const json = await response.json().catch(() => ({})) as Json;
    if (json.success) return json.result;
    if (attempt >= 3 || response.status < 500 && response.status !== 429) throw new Error(`Workers Logs query for ${target.script} failed (HTTP ${response.status}): ${JSON.stringify(json.errors ?? json).slice(0, 300)}`);
    await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
  }
}
type Event = { source: Json; version?: string; at: number; id: string };
const scriptFilter = (target: Stage) => ({ key: '$workers.scriptName', operation: 'eq', type: 'string', value: target.script });
async function lineCount(target: Stage, from: number, to: number, filters: Json[] = []) {
  const result = await telemetry(target, { queryId: 'bane-nightly-count', timeframe: { from, to }, view: 'calculations', limit: 10,
    parameters: { datasets: ['cloudflare-workers'], filters: [scriptFilter(target), ...filters], calculations: [{ operator: 'count', alias: 'n' }] } });
  return Number(result.calculations?.[0]?.aggregates?.[0]?.count ?? 0);
}
// Every matching line in the window. The events view samples instead of paging: over a long window, or with a limit
// above 1,000, it returns a subset spread over the window (Nov 12: 260 of 4,033). So compare each page with the exact
// count and split the window until each part comes back whole, down to one second. It also leaves out a few lines its
// count includes, whatever the window (Nov 12: 33 of 6,539 on dev, even in one-second windows), so a part within 0.5%
// of its count is accepted. The caller dedupes by event ID (a boundary event can be in both halves) and treats a window
// that read less than 99.5% of its count as incomplete.
const MIN_SPAN = 1000, COMPLETE = 0.995;
async function events(target: Stage, from: number, to: number, filters: Json[], known?: number): Promise<Event[]> {
  const expected = known ?? await lineCount(target, from, to, filters);
  if (!expected) return [];
  const split = async () => { const middle = from + Math.floor((to - from) / 2); return [...await events(target, from, middle, filters), ...await events(target, middle, to, filters)]; };
  if (expected > PAGE && to - from > MIN_SPAN) return split();
  const result = await telemetry(target, { queryId: 'bane-nightly-report', timeframe: { from, to }, view: 'events', limit: PAGE,
    parameters: { datasets: ['cloudflare-workers'], filters: [scriptFilter(target), ...filters] } });
  const list: Json[] = result.events?.events ?? [];
  if ((list.length >= PAGE || list.length < expected * COMPLETE) && to - from > MIN_SPAN) return split();
  return list.map(event => ({ source: event.source && typeof event.source === 'object' ? event.source : {}, version: event.$workers?.scriptVersion?.id,
    at: Number(event.timestamp), id: String(event.$metadata?.id ?? `${event.timestamp}:${JSON.stringify(event.source).length}`) }));
}
const unique = (list: Event[]) => [...new Map(list.map(event => [event.id, event])).values()];

const WEBHOOK_JOBS = new Set(['operation.webhook', 'mailbox.webhook']);
function category(line: Json): Background['category'] {
  const code = str(line.code) ?? '', operation = str(line.operation) ?? '';
  if (WEBHOOK_JOBS.has(operation) || code.startsWith('WEBHOOK_')) return 'webhook';
  if (/^(?:DISPATCH|SES_|RUNNER_)/.test(code) || line.shard !== undefined || /^dispatch/.test(operation)) return 'dispatch';
  return 'jobs';
}
// Legacy lines (before the request line carried `route` and `code`) named the route `operation`; an auth failure
// logged the middleware's `/v1/*`, and the error line the handler's template when it threw there.
function routeOf(line: Json, error?: Json) {
  if (str(line.route)) return line.route as string;
  const named = [error?.operation, line.operation].find(value => typeof value === 'string' && !value.endsWith('*')) ?? str(line.operation) ?? 'unmatched';
  return named === '/*' ? 'unmatched' : named;
}

const REQUEST_LINES = [{ key: 'method', operation: 'exists', type: 'string' }];
const PROBLEM_LINES = [{ kind: 'group', filterCombination: 'or', filters: ['warn', 'error'].map(value => ({ key: 'level', operation: 'eq', type: 'string', value })) },
  { key: 'method', operation: 'DOES_NOT_EXIST', type: 'string' }];
async function aggregate(target: Stage, from: number, to: number): Promise<Window> {
  const counts = await Promise.all([lineCount(target, from, to, REQUEST_LINES), lineCount(target, from, to, PROBLEM_LINES)]);
  const [requestLines, problemLines] = (await Promise.all([events(target, from, to, REQUEST_LINES, counts[0]), events(target, from, to, PROBLEM_LINES, counts[1])])).map(unique) as [Event[], Event[]];
  const expected = counts[0] + counts[1];
  const window: Window = { stage: target.name, from: iso(from), to: iso(to), events: requestLines.length + problemLines.length, expected,
    complete: requestLines.length >= counts[0] * COMPLETE && problemLines.length >= counts[1] * COMPLETE, requests: { total: 0, c4: 0, c5: 0 }, routes: {}, codes: {}, deploys: {}, background: {} };
  // A failed request's error line (its code, and for an unexpected failure the stack) joins its request line by ID.
  const errors = new Map<string, Json>();
  for (const { source } of problemLines) if (str(source.requestId) && !source.jobId && typeof source.status === 'number') errors.set(source.requestId, source);
  const samples = new Map<string, number[]>(), workspaces = new Map<Failure, Set<string>>();
  const note = (code: string, level: Code['level'], where: string, count: number) => {
    const entry = window.codes[code] ??= { count: 0, level, where: {} };
    entry.count += count; if (level === 'error') entry.level = 'error';
    entry.where[where] = (entry.where[where] ?? 0) + count;
  };
  for (const { source, version, at } of requestLines) {
    if (source.operation === 'worker-runtime' || typeof source.status !== 'number') continue;
    const status = source.status, error = errors.get(source.requestId);
    const weight = typeof source.sampleRate === 'number' && source.sampleRate > 0 ? 1 / source.sampleRate
      : source.event === undefined && source.level === 'info' && (status === 200 || status === 202) ? 100 : 1; // Legacy lines sampled 200/202 at 1%.
    const method = str(source.method) ?? 'GET', route = routeOf(source, error), key = `${method} ${route}`;
    const entry = window.routes[key] ??= { method, route, total: 0, c4: 0, c5: 0, codes: {}, failures: {}, n: 0 };
    entry.total += weight; window.requests.total += weight;
    const deploy = str(source.deploy) ?? (version ? `version:${version}` : 'unknown');
    const release = window.deploys[deploy] ??= { total: 0, c5: 0 };
    release.total += weight;
    if (status < 400) { const list = samples.get(key) ?? []; if (typeof source.durationMs === 'number') list.push(source.durationMs); samples.set(key, list); continue; }
    const code = str(source.code) ?? str(error?.code) ?? `HTTP_${status}`;
    entry.codes[code] = (entry.codes[code] ?? 0) + weight;
    note(code, status >= 500 ? 'error' : 'warn', key, weight);
    if (status >= 500) {
      entry.c5 += weight; window.requests.c5 += weight; release.c5 += weight;
      const when = iso(at), failure = entry.failures[code] ??= { count: 0, first: when, last: when, workspaces: 0, requestIds: [] };
      failure.count += weight; if (when < failure.first) failure.first = when; if (when > failure.last) failure.last = when;
      release.first = !release.first || when < release.first ? when : release.first; release.last = !release.last || when > release.last ? when : release.last;
      if (failure.requestIds.length < 3 && str(source.requestId)) failure.requestIds.push(source.requestId);
      failure.databaseCode ??= str(source.databaseCode) ?? str(error?.databaseCode);
      const workspace = str(source.workspace) ?? str(source.workspaceId); // Counted, never stored.
      if (workspace) { const set = workspaces.get(failure) ?? new Set(); set.add(workspace); workspaces.set(failure, set); }
    } else { entry.c4 += weight; window.requests.c4 += weight; }
  }
  for (const [key, list] of samples) { const entry = window.routes[key]!; entry.p95 = p95(list); entry.n = list.length; }
  for (const [failure, set] of workspaces) failure.workspaces = set.size;
  // Everything else at warn or error: queue consumers, crons, Durable Object dispatchers, jobs, the runner.
  for (const { source } of problemLines) {
    if (str(source.requestId) && !source.jobId && typeof source.status === 'number') continue; // Counted with its request.
    const code = str(source.code) ?? 'UNCODED', operation = str(source.operation) ?? (source.shard ? 'dispatcher' : source.queue ? `queue:${source.queue}` : 'worker');
    const level = source.level === 'error' ? 'error' : 'warn', key = `${operation}|${code}`;
    const entry = window.background[key] ??= { operation, code, count: 0, level, category: category(source) };
    entry.count++; if (level === 'error') entry.level = 'error';
    note(code, level, operation, 1);
  }
  return window;
}

// The mail gateway logs to CloudWatch (infra/pulumi/mail-gateway.ts). Its JSON lines carry `code`; lines from before
// the JSON format only said "login refused".
async function gateway(target: Stage, from: number, to: number): Promise<Record<string, number> | undefined> {
  if (!target.awsProfile) return undefined;
  const aws = (...args: string[]) => JSON.parse(execFileSync('aws', [...args, '--profile', target.awsProfile!, '--region', 'us-east-2', '--output', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const query = String.raw`fields @message | filter @message like /login refused|GATEWAY_AUTH|authentication service unavailable/ | parse @message /"code":"(?<gcode>[A-Z_]+)"/ | stats count(*) as n by gcode`;
  const { queryId } = aws('logs', 'start-query', '--log-group-name', '/ecs/bane-mail-gateway', '--start-time', String(Math.floor(from / 1000)), '--end-time', String(Math.floor(to / 1000)), '--query-string', query);
  for (let i = 0; i < 60; i++) {
    const result = aws('logs', 'get-query-results', '--query-id', queryId);
    if (result.status === 'Complete') {
      const counts: Record<string, number> = { GATEWAY_AUTH_FAILED: 0, GATEWAY_AUTH_UNAVAILABLE: 0 };
      for (const row of result.results as { field: string; value: string }[][]) {
        const code = row.find(field => field.field === 'gcode')?.value || 'GATEWAY_AUTH_FAILED';
        counts[code] = (counts[code] ?? 0) + Number(row.find(field => field.field === 'n')?.value ?? 0);
      }
      return counts;
    }
    if (['Failed', 'Cancelled', 'Timeout'].includes(result.status)) throw new Error(`CloudWatch query ${result.status} for ${target.name}`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`CloudWatch query did not finish for ${target.name}`);
}

// Cached aggregates: today's window is saved for tomorrow's baseline; older windows come from the cache, or from the
// API while Workers Logs still holds them.
// Files are named by the window's end hour; a past window matches within two hours (daylight saving moves the run).
const stateFile = (target: Stage, windowEnd: number) => join(reportDir, 'state', target.name, `${iso(windowEnd).slice(0, 13)}.json`);
async function windowFor(target: Stage, windowEnd: number, current: boolean): Promise<Window | null> {
  const file = stateFile(target, windowEnd);
  const cached = current ? undefined : [0, -1, 1, -2, 2].map(hours => stateFile(target, windowEnd + hours * HOUR)).find(existsSync);
  if (cached) return JSON.parse(readFileSync(cached, 'utf8'));
  if (!current && await lineCount(target, windowEnd - DAY, windowEnd) === 0) return null; // Past retention or no traffic.
  const window = await aggregate(target, windowEnd - DAY, windowEnd);
  // An incomplete window is never cached or used as a baseline, and files no issues (problems()).
  if (!window.complete) { console.error(`${target.name} to ${iso(windowEnd)}: read ${window.events} of ${window.expected} lines`); if (!current) return null; }
  try { window.gateway = await gateway(target, windowEnd - DAY, windowEnd); } catch (error) { console.error(`gateway logs for ${target.name} to ${iso(windowEnd)}: ${(error as Error).message.split('\n').find(line => line.includes('rror')) ?? 'failed'}`); }
  if (window.complete) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(window)); }
  return window;
}

// Deploy SHAs for Worker versions, from the deploy workflow runs (run-name "Deploy <branch> <sha>") that were running
// when the version was created. Lines logged after DEPLOY_SHA shipped carry the SHA themselves.
async function versionShas(target: Stage, versions: string[]): Promise<Map<string, string>> {
  const shas = new Map<string, string>();
  if (!versions.length) return shas;
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${target.account}/workers/scripts/${target.script}/versions?per_page=100`, { headers: { authorization: `Bearer ${token}` } });
    const created = new Map<string, string>((((await response.json()) as Json).result?.items ?? []).map((item: Json) => [item.id, item.metadata?.created_on]));
    const runs: Json[] = JSON.parse(execFileSync('gh', ['api', `repos/${repo}/actions/workflows/deploy.yml/runs?per_page=100`, '--jq', '[.workflow_runs[] | {display_title, run_started_at, updated_at}]'], { encoding: 'utf8', maxBuffer: 16 << 20 }));
    const branch = target.name === 'dev' ? 'dev' : 'production';
    for (const version of versions) {
      const at = Date.parse(created.get(version) ?? '');
      if (!Number.isFinite(at)) continue;
      const run = runs.find(item => String(item.display_title).startsWith(`Deploy ${branch} `)
        && Date.parse(item.run_started_at) <= at && at <= Date.parse(item.updated_at));
      const sha = run && /\b([0-9a-f]{40})\b/.exec(String(run.display_title))?.[1];
      if (sha) shas.set(version, sha.slice(0, 12));
    }
  } catch (error) { console.error(`deploy SHAs for ${target.name}: ${(error as Error).message}`); }
  return shas;
}

// Public issue text. The repository is public, so an issue is built only from values that pass these checks: route
// templates, error codes, SQLSTATEs, stage names and numbers. Never stack frames, error messages, request or
// workspace IDs, timestamps of single requests, or any other log text (PR #131 review: a multiline database error
// can put caller text where a stack frame is expected).
const METHOD = '(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)';
const publicText = {
  route: (value: string) => new RegExp(`^${METHOD} (?:/[A-Za-z0-9_:.*{}/-]{0,120}|unmatched)$`).test(value) ? value : 'an API route',
  code: (value: string) => /^[A-Z][A-Z0-9_]{1,63}$/.test(value) ? value : 'an error code',
  place: (value: string) => new RegExp(`^${METHOD} `).test(value) ? publicText.route(value) : /^[a-z][a-z0-9_.:-]{0,63}$/.test(value) ? value : 'background work',
  sqlstate: (value?: string) => value && /^[0-9A-Z]{5}$/.test(value) ? value : undefined,
  count: (value: number) => Math.round(value).toLocaleString('en-US'),
};
function publicIssueBody(problem: Problem, windowEnd: string) {
  return `<!-- nightly-fingerprint: ${problem.fingerprint} -->\n${problem.facts.map(fact => `- ${fact}`).join('\n')}\n\n---\n`
    + `Opened by the nightly log report (docs/ci.md, "Nightly report and self-improve loop") for the 24 hours to ${windowEnd.slice(0, 16)}Z. `
    + 'Nightly issues carry error codes, route templates and counts only; the request IDs and details are in the private report.';
}

function problems(target: Stage, today: Window, baseline: Window[]): Problem[] {
  const found: Problem[] = [];
  if (!today.complete) return found; // Counts from a partial read are not findings.
  const knownCodes = new Set(baseline.flatMap(day => Object.keys(day.codes)));
  const stageName = `\`${target.name}\``;
  for (const route of Object.values(today.routes)) {
    for (const [rawCode, failure] of Object.entries(route.failures ?? {})) {
      const key = publicText.route(`${route.method} ${route.route}`), code = publicText.code(rawCode), sqlstate = publicText.sqlstate(failure.databaseCode);
      found.push({ fingerprint: `5xx|${key}|${code}`, kind: '5xx', stages: [target.name], severity: failure.count * (target.name === 'production' ? 100 : 10),
        title: `${key} answers 5xx ${code}`,
        facts: [`${stageName}: \`${key}\` answered \`${code}\` ${publicText.count(failure.count)} time(s), out of about ${publicText.count(route.total)} requests.`
          + (sqlstate ? ` SQLSTATE \`${sqlstate}\`${sqlstate === '40P01' ? ' (deadlock; see the deadlock guard in docs/ci.md)' : ''}.` : '')] });
    }
  }
  for (const [rawCode, entry] of Object.entries(today.codes)) {
    if (knownCodes.has(rawCode) || !baseline.length) continue;
    const request = Object.keys(entry.where).some(key => new RegExp(`^${METHOD} `).test(key));
    if (request && entry.level === 'error') continue; // Filed above as a 5xx route.
    if (entry.level !== 'error' && entry.count < 50) continue; // A new client error is noise until it is common.
    const code = publicText.code(rawCode);
    const places = Object.entries(entry.where).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([place, count]) => `\`${publicText.place(place)}\` ×${publicText.count(count)}`);
    const first = publicText.place(Object.entries(entry.where).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'worker');
    found.push({ fingerprint: `new-code|${code}|${first}`, kind: 'new-code', stages: [target.name], severity: entry.count * (entry.level === 'error' ? 50 : 1) * (target.name === 'production' ? 10 : 1),
      title: `New ${entry.level === 'error' ? 'error' : 'client error'} code ${code} in ${first}`,
      facts: [`${stageName}: \`${code}\` (${entry.level === 'error' ? 'error' : 'warn'}) was logged ${publicText.count(entry.count)} time(s) (${places.join(', ')}). It was not logged in the previous ${baseline.length} day(s).`] });
  }
  for (const route of Object.values(today.routes)) {
    const raw = `${route.method} ${route.route}`, key = publicText.route(raw);
    const history = baseline.map(day => day.routes[raw]).filter((item): item is Route => Boolean(item?.p95 !== undefined && item.n));
    const n = history.reduce((sum, item) => sum + item.n, 0);
    if (route.p95 === undefined || route.n < 20 || n < 20) continue;
    const before = history.map(item => item.p95!).sort((a, b) => a - b)[Math.floor(history.length / 2)]!;
    if (route.p95 < Math.max(before * 1.5, before + 250)) continue;
    found.push({ fingerprint: `p95|${key}`, kind: 'p95', stages: [target.name], severity: (route.p95 - before) / 10 * (target.name === 'production' ? 10 : 1),
      title: `${key} p95 latency rose from ${publicText.count(before)} ms to ${publicText.count(route.p95)} ms`,
      facts: [`${stageName}: successful \`${key}\` requests had a p95 of ${publicText.count(route.p95)} ms over ${route.n} sampled requests, against a median daily p95 of ${publicText.count(before)} ms over the previous ${history.length} day(s) (${n} samples).`] });
  }
  if (today.gateway && baseline.some(day => day.gateway)) {
    const days = baseline.filter(day => day.gateway);
    for (const [rawCode, count] of Object.entries(today.gateway)) {
      const usual = days.reduce((sum, day) => sum + (day.gateway![rawCode] ?? 0), 0) / days.length, code = publicText.code(rawCode);
      const unavailable = rawCode === 'GATEWAY_AUTH_UNAVAILABLE' && count > 0 && usual === 0;
      if (!unavailable && !(count >= 50 && count > 3 * usual)) continue;
      found.push({ fingerprint: `gateway|${code}`, kind: 'gateway', stages: [target.name], severity: count * (target.name === 'production' ? 10 : 1),
        title: unavailable ? 'Mail gateway logins failed because the API was unavailable' : `Mail gateway login failures rose to ${publicText.count(count)} a day`,
        facts: [`${stageName}: the IMAP/SMTP gateway logged \`${code}\` ${publicText.count(count)} time(s), against ${usual.toFixed(1)} a day over the previous ${days.length} day(s).`] });
    }
  }
  return found;
}

function stageSection(target: Stage, today: Window, baseline: Window[], shas: Map<string, string>) {
  const routes = Object.values(today.routes);
  const failing = routes.filter(route => route.c4 + route.c5).sort((a, b) => b.c5 - a.c5 || (b.c4 + b.c5) - (a.c4 + a.c5)).slice(0, 15);
  const rate = routes.filter(route => route.c4 + route.c5 && route.total >= 10).sort((a, b) => (b.c4 + b.c5) / b.total - (a.c4 + a.c5) / a.total).slice(0, 10);
  const known = new Set(baseline.flatMap(day => Object.keys(day.codes)));
  const fresh = Object.entries(today.codes).filter(([code]) => !known.has(code)).sort((a, b) => b[1].count - a[1].count);
  const topCodes = (codes: Record<string, number>) => Object.entries(codes).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([code, count]) => `${code} ×${round(count)}`).join(', ');
  const latency = routes.filter(route => route.p95 !== undefined && route.n >= 5).map(route => {
    const history = baseline.map(day => day.routes[`${route.method} ${route.route}`]).filter(item => item?.p95 !== undefined && item.n) as Route[];
    const before = history.length ? history.map(item => item.p95!).sort((a, b) => a - b)[Math.floor(history.length / 2)] : undefined;
    return { route, before, change: before ? route.p95! / before : undefined };
  }).filter(item => item.change !== undefined && item.change >= 1.25).sort((a, b) => b.change! - a.change!).slice(0, 10);
  const deploys = Object.entries(today.deploys).filter(([, value]) => value.c5).sort((a, b) => b[1].c5 - a[1].c5);
  const background = Object.values(today.background);
  const lines = [
    `## ${target.name} (\`${target.script}\`)`, '',
    `${round(today.requests.total)} API requests (successful requests are sampled, so their count and latency are estimates; failures are exact), ${round(today.requests.c4)} client errors (4xx), ${round(today.requests.c5)} server errors (5xx); ${today.events} of ${today.expected ?? '?'} matching log lines read${today.complete ? '' : ' (**incomplete**: Workers Logs returned under 99.5% of the lines it counted, so this stage files no issues and is not kept as a baseline)'}. Baseline: ${baseline.length ? baseline.map(day => day.to.slice(0, 10)).join(', ') : 'none yet'}.`, '',
    '### Top failing routes', '',
    table(['Route', 'Requests', '4xx', '5xx', 'Failure rate', 'Top codes'], failing.map(route => [`\`${route.method} ${route.route}\``, round(route.total), round(route.c4), round(route.c5), pct(route.c4 + route.c5, route.total), topCodes(route.codes)])), '',
    '**Highest failure rate** (routes with at least 10 requests):', '',
    table(['Route', 'Requests', 'Failures', 'Rate'], rate.map(route => [`\`${route.method} ${route.route}\``, round(route.total), round(route.c4 + route.c5), pct(route.c4 + route.c5, route.total)])), '',
    `### New error codes (not seen in the previous ${baseline.length} day(s))`, '',
    baseline.length ? table(['Code', 'Level', 'Count', 'Where'], fresh.map(([code, entry]) => [`\`${code}\``, entry.level, round(entry.count), Object.entries(entry.where).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([place, count]) => `${place} ×${round(count)}`).join(', ')])) : '_No baseline yet: the first nights build it._', '',
    '### p95 latency regressions (successful requests, at least 25% slower)', '',
    table(['Route', 'p95 today', 'Baseline p95', 'Change', 'Samples'], latency.map(({ route, before, change }) => [`\`${route.method} ${route.route}\``, `${round(route.p95!)} ms`, `${round(before!)} ms`, `×${change!.toFixed(2)}`, route.n])), '',
    '### 5xx by deploy', '',
    table(['Deploy', 'Requests', '5xx', 'Rate', 'First', 'Last'], deploys.map(([deploy, value]) => {
      const version = deploy.startsWith('version:') ? deploy.slice(8) : undefined;
      return [version ? `${shas.get(version) ?? '?'} (version ${version.slice(0, 8)})` : deploy, round(value.total), round(value.c5), pct(value.c5, value.total), value.first ?? '', value.last ?? ''];
    })), '',
    '### Dispatcher, runner and job failures', '',
    table(['Where', 'Code', 'Level', 'Count'], background.filter(item => item.category !== 'webhook').sort((a, b) => b.count - a.count).slice(0, 15).map(item => [item.operation, `\`${item.code}\``, item.level, item.count])), '',
    '### Webhook delivery failures', '',
    table(['Job', 'Code', 'Level', 'Count'], background.filter(item => item.category === 'webhook').sort((a, b) => b.count - a.count).map(item => [item.operation, `\`${item.code}\``, item.level, item.count])), '',
    '### Mail gateway auth failures', '',
    today.gateway ? table(['Code', 'Last 24 h', 'Daily average before'], Object.entries(today.gateway).map(([code, count]) => {
      const days = baseline.filter(day => day.gateway);
      return [`\`${code}\``, count, days.length ? (days.reduce((sum, day) => sum + (day.gateway![code] ?? 0), 0) / days.length).toFixed(1) : '–'];
    })) : `_Not read: NIGHTLY_AWS_PROFILE_${target.name.toUpperCase()} is unset, or its AWS session has expired (aws sso login)._`, '',
  ];
  return lines.join('\n');
}

function gh(args: string[], input?: string) { return execFileSync('gh', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 16 << 20 }); }

async function main() {
  const date = new Date(end).toLocaleDateString('en-CA');
  const sections: string[] = [], all: Problem[] = [];
  for (const target of stages) {
    const today = (await windowFor(target, end, true))!;
    const baseline: Window[] = [];
    for (let day = 1; day <= 7; day++) { const past = await windowFor(target, end - day * DAY, false); if (past) baseline.push(past); }
    const versions = Object.keys(today.deploys).filter(key => key.startsWith('version:') && today.deploys[key]!.c5).map(key => key.slice(8));
    sections.push(stageSection(target, today, baseline, await versionShas(target, versions)));
    all.push(...problems(target, today, baseline));
  }
  // One problem per fingerprint across stages; production first.
  const merged = new Map<string, Problem>();
  for (const problem of all.sort((a, b) => b.severity - a.severity)) {
    const existing = merged.get(problem.fingerprint);
    if (existing) { existing.stages.push(...problem.stages); existing.severity += problem.severity; existing.facts.push(...problem.facts); }
    else merged.set(problem.fingerprint, { ...problem, stages: [...problem.stages], facts: [...problem.facts] });
  }
  const ranked = [...merged.values()].sort((a, b) => b.severity - a.severity);
  const tracked = new Map<string, { number: number; state: string; url: string }>();
  try {
    const issues = JSON.parse(gh(['issue', 'list', '--repo', repo, '--label', 'nightly', '--state', 'all', '--limit', '300', '--json', 'number,state,url,body'])) as Json[];
    for (const issue of issues) for (const match of String(issue.body).matchAll(/<!-- nightly-fingerprint: (.+?) -->/g)) if (!tracked.has(match[1]!) || issue.state === 'OPEN') tracked.set(match[1]!, issue as never);
  } catch (error) { console.error(`listing nightly issues: ${(error as Error).message.split('\n')[0]}`); }
  if (fileIssues) try { gh(['label', 'create', 'nightly', '--repo', repo, '--color', '5319e7', '--description', 'Opened by the nightly log report (docs/ci.md)', '--force']); } catch { /* Exists or no permission; filing reports it. */ }
  const filed: Json[] = [], open: Json[] = [], skipped: Problem[] = [];
  for (const problem of ranked) {
    const known = tracked.get(problem.fingerprint);
    if (known?.state === 'OPEN') { open.push({ ...problem, number: known.number, url: known.url }); continue; }
    if (!fileIssues || filed.length >= maxIssues) { skipped.push(problem); continue; }
    const body = publicIssueBody(problem, iso(end)) + (known ? `\n\nRecurred after #${known.number} was closed.` : '');
    try {
      const url = gh(['issue', 'create', '--repo', repo, '--label', 'nightly', '--title', `Nightly: ${problem.title}${problem.stages.includes('production') ? '' : ' (dev)'}`, '--body-file', '-'], body).trim();
      filed.push({ ...problem, url, number: Number(url.split('/').pop()) });
    } catch (error) { console.error(`filing "${problem.title}": ${(error as Error).message.split('\n')[0]}`); skipped.push(problem); }
  }
  const issueLine = (item: Json) => `- [#${item.number}](${item.url}) ${item.title} (${item.stages.join(', ')})`;
  const report = [
    `# Bane nightly report, ${date}`, '',
    `Window: ${iso(end - DAY)} to ${iso(end)}. Sources: Workers Logs for ${stages.map(item => `\`${item.script}\``).join(' and ')}; CloudWatch \`/ecs/bane-mail-gateway\`. Counts of sampled successes are estimates.`, '',
    '## Problems', '',
    `Filed now (${filed.length}):`, filed.length ? filed.map(issueLine).join('\n') : '- none', '',
    `Already tracked by an open issue (${open.length}):`, open.length ? open.map(issueLine).join('\n') : '- none', '',
    `Not filed (${skipped.length})${fileIssues ? ` (cap of ${maxIssues} per night)` : ' (NIGHTLY_FILE_ISSUES is off)'}:`, skipped.length ? skipped.map(item => `- ${item.title} (${item.stages.join(', ')}; \`${item.fingerprint}\`)`).join('\n') : '- none', '',
    ...sections, '',
    '## Self-improve', '', '_The self-improve session appends its summary here._', '',
  ].join('\n');
  mkdirSync(reportDir, { recursive: true });
  const base = join(reportDir, `nightly-${date}`);
  writeFileSync(`${base}.md`, report);
  writeFileSync(`${base}.json`, JSON.stringify({ date, window: { from: iso(end - DAY), to: iso(end) }, report: `${base}.md`,
    filed, open, notFiled: skipped }, null, 2));
  console.log(JSON.stringify({ report: `${base}.md`, filed: filed.length, open: open.length, notFiled: skipped.length }));
}

await main();
