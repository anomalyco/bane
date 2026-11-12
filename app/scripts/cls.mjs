// CLS gate: cumulative layout shift on every main dashboard page, light and dark, on a cold full load and on in-app
// navigation, over a throttled network with slow API responses that arrive out of order. Fails when any page's CLS
// exceeds 0.001 (or a page errors). The longest task during each in-app navigation is reported, not gated: on CI's
// shared runner the composer and rituals chunks measured 105–179 ms between runs of the same page, too close to a
// 200 ms budget to fail on without flakes.
//
// From app/: bun run cls (builds first), or node scripts/cls.mjs against an existing build.
//   CLS_ONLY=<regex>   only pages whose name matches
//   CLS_WORKERS=<n>    pages measured at once (default: 4 per CPU, at most 16; most of a page's time is network wait)
//   CLS_PG_URL=<url>   Postgres admin URL (CI); otherwise Docker or a local initdb (see cls-fixture.mjs)
//   CLS_CHROME=<path>  Chrome executable; otherwise the installed Google Chrome
//   CLS_SHOTS=1        screenshot every page, not only failing ones
// Writes .cls/report.json (every shift with its source elements), .cls/summary.md (also appended to
// $GITHUB_STEP_SUMMARY) and a screenshot per failing page with the shifted elements outlined.
//
// CLS sums every layout-shift entry without recent input: stricter than the browser's largest session window. In-app
// navigation clicks with an untrusted event, so no shift is excused as following user input. Measurement ends when
// no request is in flight, fonts are loaded and the page has rendered and gone idle twice in a row; there are no
// fixed sleeps, and polling pages settle between polls.
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { seed, start } from './cls-fixture.mjs';

const LIMIT = 0.001, JOB_TIMEOUT_MS = 90_000;
const app = resolve(dirname(fileURLToPath(import.meta.url)), '..'), repo = resolve(app, '..'), out = join(app, '.cls');
const only = process.env.CLS_ONLY ? new RegExp(process.env.CLS_ONLY, 'i') : null;
const workers = Number(process.env.CLS_WORKERS) || Math.min(16, availableParallelism() * 4);
const began = Date.now();
const elapsed = () => `${((Date.now() - began) / 1000).toFixed(1)}s`;

// [name, path, { user, from, click, row }]. The in-app navigation starts on `from` and clicks the control whose text
// starts with `click`, the table row containing `row`, or else a link to `path`; with none of those (pages reached
// from a dropdown menu) it pushes `path` through the router's history. It must land on `path`.
// dana owns an established hosted workspace, nia a brand-new one with a verified domain, ona one still onboarding.
const pages = ids => [
  ['Overview', '/', { from: '/logs' }],
  ['Overview · setup', '/', { user: 'nia' }],
  ['Logs', '/logs', { from: '/' }],
  ['Logs · received', '/logs?view=received', { from: '/logs', click: 'Received' }],
  ['Sent email', `/logs/${ids.email}`, { from: '/logs?view=sent', row: 'Your receipt' }],
  ['Received email', `/logs/${ids.receivedEmail}`, { from: '/logs?view=received', row: 'Invoice for October' }],
  ['Receiving', '/receiving', { from: '/' }],
  ['Receiving · endpoints', '/receiving?tab=endpoints', { from: '/receiving', click: 'Endpoints' }],
  ['Receiving · address', `/receiving/addresses/${ids.address}`, { from: '/receiving', row: 'support@northwind.example' }],
  ['Receiving · inbox', '/receiving/inbox', { from: '/receiving' }],
  ['Receiving · trace', '/receiving/trace', { from: '/receiving' }],
  ['Receiving · rituals', '/receiving/rituals', { from: '/receiving' }],
  ['Receiving · agent inboxes', '/receiving/inboxes', { from: '/receiving' }],
  ['Receiving · agent inbox', `/receiving/inboxes/${ids.inbox}`, { from: '/receiving/inboxes' }],
  ['Receiving · webhooks', '/receiving/webhooks', { from: '/receiving' }],
  ['Receiving · webhook', `/receiving/webhooks/${ids.inboundWebhook}`, { from: '/receiving/webhooks' }],
  ['Campaigns', '/campaigns', { from: '/' }],
  ['Campaign editor', `/campaigns/${ids.campaign}/edit`, { from: '/campaigns' }],
  ['Templates', '/campaigns/templates', { from: '/campaigns' }],
  ['Audience', '/audience', { from: '/' }],
  ['Contact', `/audience/contacts/${ids.contact}`, { from: '/audience' }],
  ['Lists', '/audience/lists', { from: '/audience' }],
  ['List', `/audience/lists/${ids.list}`, { from: '/audience/lists' }],
  ['Segments', '/audience/segments', { from: '/audience' }],
  ['Domains', '/domains', { from: '/' }],
  ['Domain', `/domains/${ids.domain}`, { from: '/domains' }],
  ['API keys', '/api-keys', { from: '/' }],
  ['Settings', '/settings', { from: '/' }],
  ['Settings · members', '/settings#members', { from: '/settings' }],
  ['Settings · sending', '/settings#sending', { from: '/settings' }],
  ['Settings · webhooks', '/settings#webhooks', { from: '/settings' }],
  ['Settings · account', '/settings#account', { from: '/settings' }],
  ['Settings · webhook', `/settings/webhooks/${ids.webhook}`, { from: '/settings#webhooks', row: 'Delivery events' }],
  ['Docs', '/docs', { from: '/' }],
  ['Onboarding', '/onboarding', { user: 'ona' }],
  ['Signed out', '/', { user: null }],
];

// Every API path gets a stable delay of 300–1300 ms in 200 ms steps: slow, and out of request order, the same way
// every run. Assets load through Chrome's own throttling (150 ms latency, 1.6 Mbps down).
const apiDelay = path => { let h = 0; for (const c of path) h = (h * 31 + c.charCodeAt(0)) >>> 0; return 300 + (h % 6) * 200; };
const throttle = { offline: false, latency: 150, downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8 };

// Runs in the page before its own scripts.
const probe = () => {
  const state = window.__cls = { total: 0, entries: [], nodes: [], long: [], fetches: 0 };
  const rect = r => [r.x, r.y, r.width, r.height].map(Math.round);
  const describe = node => {
    if (!node) return '(removed)';
    if (node.nodeType !== 1) return `#text in ${describe(node.parentElement)}`;
    const parts = [];
    for (let n = node; n && n.nodeType === 1 && n !== document.body && parts.length < 5; n = n.parentElement) {
      const classes = typeof n.className === 'string' ? n.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
      parts.unshift(n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + classes.map(c => '.' + c).join(''));
      if (n.id) break;
    }
    return parts.join(' > ');
  };
  const record = list => {
    for (const e of list) {
      if (e.hadRecentInput) continue;
      state.total += e.value;
      state.entries.push({ value: e.value, at: Math.round(e.startTime), sources: (e.sources || []).map(s => {
        if (s.node) state.nodes.push(s.node);
        return { node: describe(s.node), text: (s.node?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80), from: rect(s.previousRect), to: rect(s.currentRect) };
      }) });
    }
  };
  state.observer = new PerformanceObserver(list => record(list.getEntries()));
  state.observer.observe({ type: 'layout-shift', buffered: true });
  state.read = () => { record(state.observer.takeRecords()); return { total: state.total, entries: state.entries, long: state.long }; };
  state.reset = () => { record(state.observer.takeRecords()); Object.assign(state, { total: 0, entries: [], nodes: [], long: [] }); };
  new PerformanceObserver(list => { for (const e of list.getEntries()) state.long.push({ at: Math.round(e.startTime), duration: Math.round(e.duration) }); }).observe({ type: 'longtask', buffered: true });
  // Fetches the page has started and not yet answered, and response bodies it is still reading, counted in the page:
  // a request started in the last frame can't slip past the network events, and a body the app never reads (which
  // Chrome never reports finished) doesn't hold the measurement open.
  const track = pending => { state.fetches++; pending.finally(() => state.fetches--).catch(() => {}); return pending; };
  const original = window.fetch;
  window.fetch = function (...args) { return track(original.apply(this, args)); };
  for (const method of ['arrayBuffer', 'blob', 'bytes', 'formData', 'json', 'text']) {
    const read = Response.prototype[method];
    if (read) Response.prototype[method] = function (...args) { return track(read.apply(this, args)); };
  }
};
// Resolves once fonts are loaded, two frames have rendered and the main thread has gone idle.
const quiet = () => document.fonts.ready.then(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => requestIdleCallback(() => done(window.__cls.fetches), { timeout: 1000 })))));

// Requests in flight. A fetch() leaves this set when its response headers arrive: the page counts its body reads.
function network(page) {
  const inflight = new Set(), waiters = [];
  let started = 0;
  const finish = request => { inflight.delete(request); if (!inflight.size) for (const done of waiters.splice(0)) done(); };
  page.on('request', request => { inflight.add(request); started++; });
  page.on('response', response => { if (response.request().resourceType() === 'fetch') finish(response.request()); });
  page.on('requestfinished', finish);
  page.on('requestfailed', finish);
  return {
    idle: () => inflight.size ? new Promise(done => waiters.push(done)) : Promise.resolve(),
    get started() { return started; }, get size() { return inflight.size; },
    pending: () => [...inflight].map(r => r.url()),
  };
}
async function settle(page, net) {
  for (let calm = 0; calm < 2;) {
    await net.idle();
    const mark = net.started;
    const fetches = await page.evaluate(quiet);
    calm = !net.size && net.started === mark && !fetches ? calm + 1 : 0;
  }
}
const sharp = n => Math.round(n * 10000) / 10000;

async function measure(browser, job, fx) {
  const origin = fx.origins[job.index % fx.origins.length];
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: job.scheme });
  const result = { page: job.name, path: job.path, scheme: job.scheme, mode: job.mode, cls: null, entries: [], longTask: null, error: null };
  let page, net;
  const problems = [];
  const work = (async () => {
    if (job.user) await context.addCookies([{ name: 'bane.session_token', value: encodeURIComponent(fx.sessions[job.user].cookie), url: origin, httpOnly: true }]);
    await context.addInitScript(probe);
    // In-app jobs run with Data Saver on, which turns off the app's idle warm-up of the other sidebar pages: the click
    // then loads the next page's code and data cold, the case with the most loading states to get wrong.
    if (job.mode === 'in-app') await context.addInitScript(() => { if (navigator.connection) Object.defineProperty(navigator.connection, 'saveData', { get: () => true }); });
    await context.route(url => url.origin !== origin, route => { problems.push(`external request ${route.request().url()}`); return route.abort(); });
    await context.route(url => url.origin === origin && url.pathname.startsWith('/v1/'), async route => {
      const url = new URL(route.request().url());
      await new Promise(done => setTimeout(done, apiDelay(url.pathname + url.search)));
      await route.continue().catch(() => {});
    });
    page = await context.newPage();
    net = network(page);
    page.on('response', response => { if (response.url().startsWith(origin + '/v1/') && (response.status() >= 500 || response.status() === 429)) problems.push(`${response.status()} ${response.request().method()} ${response.url().slice(origin.length)}`); });
    page.on('pageerror', error => problems.push(`page error: ${error.message}`));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', throttle);
    await page.goto(origin + (job.mode === 'in-app' ? job.from : job.path), { waitUntil: 'load', timeout: 60_000 });
    await settle(page, net);
    if (job.mode === 'in-app') {
      await page.evaluate(() => { window.__cls.reset(); window.__inApp = performance.now(); });
      result.via = await page.evaluate(({ path, click, row }) => {
        const shown = el => el.getClientRects().length > 0, text = el => el.textContent.replace(/\s+/g, ' ').trim();
        if (row) { const tr = [...document.querySelectorAll('tbody tr')].find(tr => shown(tr) && text(tr).includes(row)); tr?.click(); return tr ? 'row' : `no row with “${row}”`; }
        if (click) { const el = [...document.querySelectorAll('a, button, [role=tab]')].find(el => shown(el) && text(el).startsWith(click)); el?.click(); return el ? 'control' : `no control “${click}”`; }
        const target = new URL(path, location.href);
        const link = [...document.querySelectorAll('a[href]')].find(a => a.href === target.href && shown(a));
        if (link) { link.click(); return 'link'; }
        history.pushState(null, '', target.href);
        dispatchEvent(new PopStateEvent('popstate'));
        return 'history';
      }, { path: job.path, click: job.click, row: job.row });
      if (result.via.startsWith('no ')) problems.push(result.via);
      await settle(page, net);
      const state = await page.evaluate(() => ({ at: window.__inApp, url: location.pathname + location.search + location.hash }));
      if (state.at === undefined) problems.push('the navigation reloaded the page');
      if (state.url !== job.path) problems.push(`landed on ${state.url}`);
      const read = await page.evaluate(() => window.__cls.read());
      result.longTask = Math.max(0, ...read.long.filter(t => t.at >= state.at).map(t => t.duration));
      Object.assign(result, { cls: sharp(read.total), entries: read.entries });
    } else {
      const read = await page.evaluate(() => window.__cls.read());
      Object.assign(result, { cls: sharp(read.total), entries: read.entries });
    }
    const broken = await page.evaluate(() => document.querySelector('.fatal-error') ? 'the error boundary rendered' : [...document.querySelectorAll('h1,h2')].some(h => h.textContent === 'Page not found') ? 'Page not found' : null);
    if (broken) problems.push(broken);
    if (result.cls > LIMIT || process.env.CLS_SHOTS) {
      await page.evaluate(() => { for (const n of window.__cls.nodes) if (n.isConnected && n.style) n.style.outline = '2px solid #f0f'; });
      result.screenshot = `${job.slug}.png`;
      await page.screenshot({ path: join(out, result.screenshot) });
    }
  })();
  work.catch(() => {}); // After a timeout the context closes under it.
  let timer;
  try {
    await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out; in flight: ${net?.pending().join(', ') || 'nothing'}`)), JOB_TIMEOUT_MS); })]);
  } catch (error) {
    problems.push(error.message.split('\n')[0]);
  } finally {
    clearTimeout(timer);
    await context.close().catch(() => {});
  }
  if (problems.length) result.error = [...new Set(problems)].join('; ');
  return result;
}

const format = r => !r ? '' : r.error ? `❌ ${r.cls ?? 'error'}` : `${r.cls > LIMIT ? '❌ ' : ''}${r.cls === 0 ? '0' : r.cls.toFixed(4)}`;
function summarize(results, seconds) {
  const failed = results.filter(r => r.error || r.cls > LIMIT);
  const rows = new Map();
  for (const r of results) {
    const row = rows.get(r.page) ?? rows.set(r.page, { path: r.path, long: null }).get(r.page);
    row[`${r.scheme} ${r.mode}`] = r;
    if (r.longTask !== null) row.long = Math.max(row.long ?? 0, r.longTask);
  }
  const lines = [
    `### Layout shift: ${failed.length ? `❌ ${failed.length} of ${results.length} measurements failed` : `✅ ${results.length} measurements, every page at CLS ≤ ${LIMIT}`}`,
    '',
    `Cold load and in-app navigation, throttled network, API responses delayed 300–1300 ms out of order. Limit: CLS ${LIMIT}. Longest task during in-app navigation is reported, not gated. ${seconds}s.`,
    '',
    '| Page | Path | Light load | Light in-app | Dark load | Dark in-app | Longest task |',
    '| --- | --- | --: | --: | --: | --: | --: |',
    ...[...rows].map(([page, row]) => `| ${page} | \`${row.path}\` | ${format(row['light load'])} | ${format(row['light in-app'])} | ${format(row['dark load'])} | ${format(row['dark in-app'])} | ${row.long === null ? '' : `${row.long} ms`} |`),
  ];
  if (failed.length) {
    lines.push('', '#### Failures', '');
    for (const r of failed) {
      lines.push(`- **${r.page}** (${r.scheme}, ${r.mode}) \`${r.path}\`: ${r.error ?? `CLS ${r.cls}`}`);
      for (const e of r.entries.slice(0, 5)) for (const s of e.sources.slice(0, 3)) lines.push(`  - ${e.value.toFixed(4)} at ${e.at} ms: \`${s.node}\` ${JSON.stringify(s.from)} → ${JSON.stringify(s.to)}${s.text ? ` “${s.text.slice(0, 50)}”` : ''}`);
    }
  }
  return { markdown: lines.join('\n') + '\n', failed };
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const fx = await start(repo, { servers: Math.ceil(workers / 4), log: message => console.log(`${elapsed()} ${message}`) });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => fx.stop().finally(() => process.exit(130)));
let results = [];
try {
  const ids = await seed(fx);
  console.log(`${elapsed()} seeded`);
  const jobs = [];
  for (const scheme of ['light', 'dark']) for (const [name, path, { user = 'dana', from, click, row }] of pages(ids)) {
    if (only && !only.test(name)) continue;
    const slug = `${name}-${scheme}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    jobs.push({ name, path, user, scheme, mode: 'load', slug: slug + '-load' });
    if (from) jobs.push({ name, path, user, from, click, row, scheme, mode: 'in-app', slug: slug + '-in-app' });
  }
  jobs.forEach((job, index) => { job.index = index; });
  const browser = await chromium.launch(process.env.CLS_CHROME ? { executablePath: process.env.CLS_CHROME } : { channel: 'chrome' });
  console.log(`${elapsed()} measuring ${jobs.length} page loads, ${workers} at a time`);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(workers, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const r = await measure(browser, job, fx);
      results[job.index] = r;
      const flag = r.error || r.cls > LIMIT ? '✗' : '✓';
      console.log(`${elapsed().padStart(6)} ${flag} ${r.scheme.padEnd(5)} ${r.mode.padEnd(6)} ${r.page.padEnd(26)} ${String(r.cls).padEnd(7)}${r.longTask !== null ? ` ${r.longTask} ms` : ''}${r.error ? `  ${r.error}` : ''}`);
    }
  }));
  await browser.close();
} finally {
  writeFileSync(join(out, 'api.log'), fx.serverLog());
  await fx.stop();
}
results = results.filter(Boolean);
const { markdown, failed } = summarize(results, ((Date.now() - began) / 1000).toFixed(0));
writeFileSync(join(out, 'report.json'), JSON.stringify(results, null, 2));
writeFileSync(join(out, 'summary.md'), markdown);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
console.log('\n' + markdown);
process.exit(failed.length || !results.length ? 1 : 0);
