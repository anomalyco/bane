// Preview smoke (docs/ci.md): every API route, asked anonymously of the real Worker under `wrangler dev` (workerd)
// with the real wrangler config's assets and run_worker_first, must be answered by the Worker itself: an x-request-id
// header and a status below 500. Workers Assets answers a path outside run_worker_first with 405 (non-GET) or the
// dashboard's HTML (GET), neither with a request ID; a module that fails to load in workerd answers 503.
//   node --import tsx scripts/preview-smoke.ts <origin>
import { createOpenApiApp } from '../src/app.js';

const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:8799').origin;
const routes = (await createOpenApiApp()).routes.filter(r => r.path !== '*' && r.path !== '/*' && r.method !== 'ALL' && r.method !== 'OPTIONS');
const unique = [...new Map(routes.map(r => [`${r.method} ${r.path}`, r])).values()];
const sample = (path: string) => path.replace(/:([A-Za-z]+)(\{[^}]*\})?/g, (_, name: string) => /token/i.test(name) ? 'u_' + '0'.repeat(64) : `${name}_premerge`).replaceAll('*', 'premerge');
const failures: string[] = [];
let checked = 0, retried = 0;
// One request at a time. wrangler's dev proxy sometimes drops a request ("Network connection lost", a bare text/plain
// 500), on a different route each run; that one response is retried. Anything else is the answer.
// A 503 is allowed only with a documented not-ready code (public stats before their first hourly run).
const notReady = new Set(['PUBLIC_STATS_PENDING']);
for (const route of unique) {
  const path = sample(route.path), method = route.method;
  let response: Response | undefined, body = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    // No body: anonymous requests stop at authentication, and wrangler's dev proxy drops a request whose body the
    // Worker never read.
    const init: RequestInit = { method, redirect: 'manual', signal: AbortSignal.timeout(20_000), headers: { origin } };
    try { response = await fetch(origin + path, init); body = await response.text(); } catch (error) { response = undefined; body = (error as Error).message; }
    const dropped = !response || (response.status === 500 && !response.headers.get('x-request-id') && (response.headers.get('content-type') ?? '').startsWith('text/plain'));
    if (!dropped) break;
    retried++;
  }
  if (!response) { failures.push(`${method} ${route.path}: ${body}`); continue; }
  checked++;
  const id = response.headers.get('x-request-id'), type = response.headers.get('content-type') ?? '';
  let code: string | undefined;
  try { code = (JSON.parse(body) as { error?: { code?: string } }).error?.code; } catch {}
  if (!id && (response.status === 405 || type.startsWith('text/html'))) failures.push(`${method} ${route.path}: HTTP ${response.status} ${type} without x-request-id, so Workers Assets answered it. Add its prefix to run_worker_first in both wrangler configs.`);
  else if (!id) failures.push(`${method} ${route.path}: HTTP ${response.status} ${type || '(no content type)'} without x-request-id: the Worker did not answer (an uncaught error? see the wrangler log).`);
  else if (response.status >= 500 && !(response.status === 503 && code && notReady.has(code))) failures.push(`${method} ${route.path}: HTTP ${response.status} ${code ?? ''} (${id}) from the Worker on an anonymous request; see this request ID in the wrangler log.`);
}
// The dashboard itself still comes from assets.
for (const path of ['/', '/logs', '/settings']) {
  const response = await fetch(origin + path, { signal: AbortSignal.timeout(20_000) });
  const html = await response.text();
  if (response.status !== 200 || !html.includes('<div id="root"')) failures.push(`GET ${path}: expected the dashboard HTML from assets, got HTTP ${response.status}.`);
}
const missing = await fetch(origin + '/assets/does-not-exist.js');
if (missing.status !== 404) failures.push(`Missing chunk: expected 404, got ${missing.status}.`);
for (const failure of failures) console.log(`::error title=Preview smoke::${failure}`);
console.log(`Preview smoke: ${checked} of ${unique.length} routes answered by the Worker; ${retried} dropped by the dev proxy and retried; ${failures.length} problem(s).`);
if (failures.length || checked !== unique.length) process.exitCode = 1;
