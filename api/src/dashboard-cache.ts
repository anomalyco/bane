import { sql } from 'drizzle-orm';
import { digest, type Runtime } from './core.js';

const TTL_SECONDS = 60;
// The newest email and the newest email event in a workspace, as one cache-key part: a dashboard read cached before
// the latest send or delivery is never served after it, so Overview's figures agree with Logs on the next read. Two
// index probes (sending_emails_created_page, operation_events_metrics); quiet workspaces keep hitting the cache.
export async function mailActivity(runtime: Pick<Runtime, 'db'>, workspaceId: string): Promise<string> {
  const { rows: [row] } = await runtime.db.execute<{ emails: string | null; events: string | null }>(sql`SELECT
    (SELECT max(created_at) FROM sending_emails WHERE workspace_id = ${workspaceId})::text AS emails,
    (SELECT max(created_at) FROM operation_events WHERE workspace_id = ${workspaceId})::text AS events`);
  return `${row?.emails ?? ''}/${row?.events ?? ''}`;
}
const memoryCache = new Map<string, { expires: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();
// Per-isolate memory first, then the colo-wide Workers Cache API when present (absent on Node).
// On Node, concurrent identical requests share one query. Workers can't await another request's
// I/O ("Cannot perform I/O on behalf of a different request"), so there each request computes its own.
export async function cachedDashboardRead<T>(origin: string, scope: string, compute: () => Promise<T>, ttlSeconds = TTL_SECONDS): Promise<{ value: T; hit: boolean }> {
  const key = JSON.stringify([origin,scope]);
  const now = Date.now(), memory = memoryCache.get(key);
  if (memory && memory.expires > now) return { value: memory.value as T, hit: true };
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  const pending = cache ? undefined : inflight.get(key);
  if (pending) return { value: await pending as T, hit: true };
  const request = new Request(`${origin}/__cache/dashboard/${await digest(key)}`);
  const remember = (value: unknown, expires: number) => {
    if (memoryCache.size >= 500) memoryCache.delete(memoryCache.keys().next().value!);
    memoryCache.set(key, { expires, value });
  };
  if (cache) {
    const hit = await cache.match(request).catch(() => undefined);
    const expires = Number(hit?.headers.get('x-bane-expires') ?? hit?.headers.get('x-opensend-expires'));
    if (hit && expires > Date.now()) { const value = await hit.json() as T; remember(value,expires); return { value, hit: true }; }
  }
  const work = compute();
  if (!cache) inflight.set(key, work);
  try {
    const value = await work;
    const expires = Date.now() + ttlSeconds * 1000;
    remember(value,expires);
    if (cache) await cache.put(request, new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', 'cache-control': `max-age=${ttlSeconds}`, 'x-bane-expires': String(expires) } })).catch(() => undefined);
    return { value, hit: false };
  } finally { if (!cache) inflight.delete(key); }
}
