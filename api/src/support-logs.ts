import { log, type Config } from './core.js';

// The customer's own requests, from this Worker's request lines in Workers Logs (api/README.md "Support integration"):
// app.ts writes one `event: 'request'` line per request (route template, method, status, code, workspace, principal,
// duration; PR #131) and Workers Logs keeps them about 3 days. Nightmail asks the Workers Observability telemetry API for
// this Worker's request lines in the grant's workspaces only, then checks every returned line again here (defense in
// depth: a line outside those workspaces is dropped, whatever the API answered) and builds its answer from an explicit
// allow-list of fields. Never a message, address, user agent, URL, body or anything else a line might carry.

export const LOG_RETENTION_DAYS = 3;
/** Lines read per query: Workers Logs returns a sample spread over the window when more match. */
export const LOG_ROWS = 1000;
const TIMEOUT_MS = 5000;

export type StatusFilter = 'error' | '5xx' | '4xx';
export type RequestLine = { at: string; requestId: string | null; route: string; method: string; status: number; code: string | null; durationMs: number | null; principal: string; workspaceId: string };
type Query = { workspaceIds: string[]; from: number; to: number; status?: StatusFilter; route?: string; code?: string; requestId?: string; limit: number };
/** Workers Logs did not answer, or answered with an error: the read reports `available: false, reason: 'unavailable'`. */
export class LogsUnavailable extends Error {}

/** Route templates (`/v1/emails/:id`) and the request line's own names for requests no route answered. */
export const ROUTE_TEMPLATE = /^(?:unmatched|worker-runtime|group:[a-z-]{1,40}|(?:\/[A-Za-z0-9_.*:{}-]{0,80}){1,12})$/;
export const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const METHOD = /^[A-Z]{3,7}$/, PRINCIPAL = /^[A-Za-z][A-Za-z0-9_]{0,39}$/, REQUEST_ID = /^req_[0-9a-f]{32}$/;
/** Callers that are not the customer: a support grant's own reads, the support platform's binding, and operators. */
const NOT_CUSTOMER = new Set(['support', 'operatorService']);
const internalRoute = (route: string) => /^\/v1\/(?:support|operator)(?:\/|$)/.test(route);

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const inStatus = (status: number, filter: StatusFilter | undefined) => !filter || (filter === '5xx' ? status >= 500 : filter === '4xx' ? status >= 400 && status < 500 : status >= 400);

/** One returned event as a request line of an allowed workspace, from the allow-listed fields only; else null. */
function lineOf(event: unknown, workspaces: Set<string>, script: string): RequestLine | null {
  if (!record(event) || !record(event.source)) return null;
  const source = event.source, worker = event.$workers;
  if (record(worker) && worker.scriptName !== undefined && worker.scriptName !== script) return null;
  if (source.event !== 'request' || typeof source.workspace !== 'string' || !workspaces.has(source.workspace)) return null;
  const status = source.status;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) return null;
  const at = typeof event.timestamp === 'number' && Number.isFinite(event.timestamp) ? event.timestamp : typeof source.timestamp === 'string' ? Date.parse(source.timestamp) : NaN;
  if (!Number.isFinite(at)) return null;
  const route = typeof source.route === 'string' && source.route.length <= 200 && ROUTE_TEMPLATE.test(source.route) ? source.route : 'unmatched';
  const principal = typeof source.principal === 'string' && PRINCIPAL.test(source.principal) ? source.principal : 'unknown';
  if (NOT_CUSTOMER.has(principal) || internalRoute(route)) return null;
  const duration = source.durationMs;
  return {
    at: new Date(at).toISOString(), requestId: typeof source.requestId === 'string' && REQUEST_ID.test(source.requestId) ? source.requestId : null,
    route, method: typeof source.method === 'string' && METHOD.test(source.method) ? source.method : 'OTHER', status,
    code: typeof source.code === 'string' && ERROR_CODE.test(source.code) ? source.code : null,
    durationMs: typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? Math.round(duration * 10) / 10 : null,
    principal, workspaceId: source.workspace,
  };
}

/**
 * This Worker's request lines in these workspaces and the window, newest first: one bounded call (5 seconds, at most
 * `limit` lines) to the telemetry query API, every line checked again here. Throws LogsUnavailable when Cloudflare
 * does not answer or answers with an error (logged with its HTTP status only).
 */
export async function requestLines(observability: NonNullable<Config['observability']>, q: Query): Promise<{ lines: RequestLine[]; truncated: boolean }> {
  if (!q.workspaceIds.length) return { lines: [], truncated: false };
  const eq = (key: string, value: string) => ({ key, operation: 'eq', type: 'string', value });
  const filters: unknown[] = [eq('$workers.scriptName', observability.script), eq('event', 'request'),
    { kind: 'group', filterCombination: 'or', filters: q.workspaceIds.map(id => eq('workspace', id)) }];
  if (q.status) filters.push({ key: 'status', operation: 'gte', type: 'number', value: q.status === '5xx' ? 500 : 400 });
  if (q.status === '4xx') filters.push({ key: 'status', operation: 'lt', type: 'number', value: 500 });
  if (q.route) filters.push(eq('route', q.route));
  if (q.code) filters.push(eq('code', q.code));
  if (q.requestId) filters.push(eq('requestId', q.requestId));
  let status = 0, body: unknown;
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${observability.accountId}/workers/observability/telemetry/query`, {
      method: 'POST', headers: { authorization: `Bearer ${observability.token}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({ queryId: 'bane-support-requests', view: 'events', dry: true, limit: q.limit, timeframe: { from: q.from, to: q.to },
        parameters: { datasets: ['cloudflare-workers'], filterCombination: 'and', filters } }),
    });
    status = response.status;
    body = await response.json();
    if (!response.ok || !record(body) || body.success !== true) throw new Error();
  } catch {
    log('warn', { code: 'SUPPORT_LOGS_UNAVAILABLE', status });
    throw new LogsUnavailable();
  }
  const result = (body as { result?: unknown }).result, found = record(result) && record(result.events) && Array.isArray(result.events.events) ? result.events.events as unknown[] : [];
  const workspaces = new Set(q.workspaceIds), lines: RequestLine[] = [];
  for (const event of found.slice(0, q.limit)) {
    const line = lineOf(event, workspaces, observability.script);
    if (line && inStatus(line.status, q.status) && (!q.route || line.route === q.route) && (!q.code || line.code === q.code) && (!q.requestId || line.requestId === q.requestId)) lines.push(line);
  }
  return { lines: lines.sort((a, b) => a.at < b.at ? 1 : a.at > b.at ? -1 : 0), truncated: found.length >= q.limit };
}

export type RequestGroup = { route: string; method: string; status: number; code: string | null; principal: string; count: number; firstSeen: string; lastSeen: string; sampleRequestIds: string[] };
/** Lines (newest first) grouped by route, method, status, code and principal; the most frequent `max`, with up to 5 of each group's latest request IDs. */
export function groupLines(lines: RequestLine[], max = 50): RequestGroup[] {
  const groups = new Map<string, RequestGroup>();
  for (const line of lines) {
    const key = JSON.stringify([line.route, line.method, line.status, line.code, line.principal]);
    const group = groups.get(key) ?? { route: line.route, method: line.method, status: line.status, code: line.code, principal: line.principal, count: 0, firstSeen: line.at, lastSeen: line.at, sampleRequestIds: [] };
    groups.set(key, group);
    group.count++;
    if (line.at < group.firstSeen) group.firstSeen = line.at;
    if (line.at > group.lastSeen) group.lastSeen = line.at;
    if (line.requestId && group.sampleRequestIds.length < 5 && !group.sampleRequestIds.includes(line.requestId)) group.sampleRequestIds.push(line.requestId);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || (a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : 0)).slice(0, max);
}
