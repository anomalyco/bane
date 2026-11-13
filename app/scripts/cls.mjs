// CLS gate: cumulative layout shift on every main dashboard page, light and dark, on a cold full load and on in-app
// navigation, over a throttled network with slow API responses that arrive out of order (web fonts load before any text,
// the same way every run; CLS_FONTS=late delays them instead); the main pages again on a
// phone (390 × 844, touch: the tab bar, cards and native selects). Fails when any page's CLS
// exceeds 0.001 (or a page errors). The longest task during each in-app navigation is reported, not gated: on CI's
// shared runner the composer and rituals chunks measured 105–179 ms between runs of the same page, too close to a
// 200 ms budget to fail on without flakes.
//
// From app/: bun run cls (builds first), or node scripts/cls.mjs against an existing build.
//   CLS_ONLY=<regex>   only pages whose name matches
//   CLS_WORKERS=<n>    pages measured at once (default: 5 per CPU, at most 32; most of a page's time is network wait)
//   CLS_PG_URL=<url>   Postgres admin URL (CI); otherwise Docker or a local initdb (see cls-fixture.mjs)
//   CLS_CHROME=<path>  Chrome executable; otherwise the installed Google Chrome
//   CLS_SHOTS=1        screenshot every page, not only failing ones
//   CLS_PHONE=0        skip the phone pass
//   CLS_FONTS=late     deliver web fonts 1.8 s late, to measure the fallback-to-web-font swap
// Writes .cls/report.json (every shift with its source elements), .cls/summary.md (also appended to
// $GITHUB_STEP_SUMMARY) and a screenshot per failing page with the shifted elements outlined.
//
// Live rituals (`live`): on Driftwood's rituals page, an agent's API key saves the open ritual once the page has settled
// (`apply`: the change lands in the editor and the save bar names who made it), or after a keystroke in the editor
// (`conflict`: the card offering their version or yours opens above the save bar). The pages' long poll on
// /v1/rituals/version is always open by design, so it is left out of the network-idle wait.
//
// Support chat: the page loads, then the Help button opens the chat (the scripted demo conversation) and the agent's
// greeting streams in to its end; in-app, the chat stays open on Overview while the sidebar link goes to Logs (on a
// phone, where the chat is a sheet over the page, the tab bar's link closes it).
//
// Dialogs (`dialog`): once the page has settled, the control whose text starts with `dialog` opens its dialog (a bottom
// sheet on a phone), and the measurement covers the load and the open dialog together.
//
// Every measurement also checks the masked addresses on its page (lib/private-address.ts): nothing of a seeded address
// beyond its first two characters is in the page's text, a title, a label or a link before it is revealed, and on a
// cold desktop load, hovering the first few reveals them without anything moving, and so does turning privacy mode off
// with ⇧P (then on again, which masks them as before).
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
import { liveSource, seed, start } from './cls-fixture.mjs';

const LIMIT = 0.001, JOB_TIMEOUT_MS = 90_000;
const app = resolve(dirname(fileURLToPath(import.meta.url)), '..'), repo = resolve(app, '..'), out = join(app, '.cls');
const only = process.env.CLS_ONLY ? new RegExp(process.env.CLS_ONLY, 'i') : null;
const workers = Number(process.env.CLS_WORKERS) || Math.min(32, availableParallelism() * 5);
const began = Date.now();
const elapsed = () => `${((Date.now() - began) / 1000).toFixed(1)}s`;

// [name, path, { user, from, click, row, switchTo, support, notes, dialog }]. The in-app navigation starts on `from` and clicks the
// control whose text starts with `click`, the table row containing `row`, picks the workspace `switchTo` in the account
// switcher, or else a link to `path`; with none of those (pages reached from a dropdown menu) it pushes `path` through
// the router's history. It must land on `path`. `support` opens the support chat first, `dialog` a dialog (see above).
// dana owns an established hosted workspace (and is a Bane operator), nia a brand-new one with a verified domain, ona one
// still onboarding, rae a restricted one that also owes $12.40 (the standing and billing banners on every page).
// A list of users is one browser signed in to each of them (one session cookie per account, the first the default).
const pages = ids => [
  ['Overview', '/', { from: '/logs' }],
  ['Overview · setup', '/', { user: 'nia' }],
  ['Logs', '/logs', { from: '/' }],
  ['Logs · received', '/logs?view=received', { from: '/logs', click: 'Received' }],
  ['Sent email', `/logs/${ids.email}`, { from: '/logs?view=sent', row: 'Your receipt' }],
  ['Received email', `/logs/${ids.receivedEmail}`, { from: '/logs?view=received', row: 'Invoice for October' }],
  ['Receiving', '/receiving', { from: '/' }],
  ['Receiving · endpoints', '/receiving?tab=endpoints', { from: '/receiving', click: 'Endpoints' }],
  ['Receiving · address', `/receiving/addresses/${ids.address}`, { from: '/receiving' }],
  ['Receiving · inbox', '/receiving/inbox', { from: '/receiving' }],
  ['Receiving · trace', '/receiving/trace', { from: '/receiving' }],
  ['Receiving · rituals', '/receiving/rituals', { from: '/receiving' }],
  ['Receiving · rituals · no agent', '/receiving/rituals', { user: 'nia' }],
  ['Receiving · rituals · agent', '/receiving/rituals', { user: 'kai', from: '/receiving' }],
  ['Receiving · rituals · live update', '/receiving/rituals', { user: 'kai', live: 'apply' }],
  ['Receiving · rituals · live conflict', '/receiving/rituals', { user: 'kai', live: 'conflict' }],
  ['Receiving · agent inboxes', '/receiving/inboxes', { from: '/receiving' }],
  ['Receiving · agent inbox', `/receiving/inboxes/${ids.inbox}`, { from: '/receiving/inboxes' }],
  ['Receiving · webhooks', '/receiving/webhooks', { from: '/receiving' }],
  ['Receiving · webhook', `/receiving/webhooks/${ids.inboundWebhook}`, { from: '/receiving/webhooks' }],
  ['Campaigns', '/campaigns', { from: '/' }],
  ['Campaign editor', `/campaigns/${ids.campaign}/edit`, { from: '/campaigns' }],
  ['New campaign', '/campaigns/new', { from: '/campaigns', click: 'Create campaign' }],
  ['Campaign review', `/campaigns/${ids.campaign}/review`, { from: '/campaigns' }],
  ['Templates', '/campaigns/templates', { from: '/campaigns' }],
  ['Template', `/campaigns/templates/${ids.template}`, { from: '/campaigns/templates', row: 'Receipt' }],
  ['Audience', '/audience', { from: '/' }],
  ['Contact', `/audience/contacts/${ids.contact}`, { from: '/audience' }],
  ['Lists', '/audience/lists', { from: '/audience' }],
  ['List', `/audience/lists/${ids.list}`, { from: '/audience/lists' }],
  ['Segments', '/audience/segments', { from: '/audience' }],
  ['Segment', `/audience/segments/${ids.segment}`, { from: '/audience/segments', row: 'Pro plan' }],
  ['Domains', '/domains', { from: '/' }],
  ['Domain', `/domains/${ids.domain}`, { from: '/domains' }],
  ['API keys', '/api-keys', { from: '/' }],
  ['Settings', '/settings', { from: '/' }],
  ['Settings · members', '/settings#members', { from: '/settings' }],
  ['Settings · sending', '/settings#sending', { from: '/settings' }],
  ['Settings · webhooks', '/settings#webhooks', { from: '/settings' }],
  ['Settings · activity', '/settings#activity', { from: '/settings' }],
  ['Settings · account', '/settings#account', { from: '/settings' }],
  ['Settings · plan & usage', '/settings#usage', { from: '/settings' }],
  ['Settings · billing', '/settings#billing', { from: '/settings' }],
  ['Settings · billing · owed', '/settings#billing', { user: 'rae', from: '/' }],
  ['Settings · billing · free', '/settings#billing', { user: 'nia', from: '/' }],
  ['Settings · webhook', `/settings/webhooks/${ids.webhook}`, { from: '/settings#webhooks', row: 'Delivery events' }],
  ['Settings · MCP connection', `/settings/mcp/${ids.mcp}`, { from: '/settings#account' }],
  ['Docs', '/docs', { from: '/' }],
  ['Operator', '/operator', { from: '/' }],
  ['Operator · workspace', `/operator/workspaces/${ids.restricted}`, { from: '/operator', row: 'Harbor Supply' }],
  ['Operator · UI notes', '/operator/notes', { from: '/operator', click: 'UI notes' }],
  // UI notes mode on (a staff overlay): its pins, tray and lazy code load over the page without moving anything.
  ['Overview · UI notes mode', '/', { from: '/logs', notes: true }],
  // An operator outside UI_NOTES_SUBJECTS with the mode forced on: no tab, toggle, pill or pins, and the API says 404.
  ['Operator · without UI notes', '/operator', { user: 'rae', from: '/', notes: true }],
  ['Overview · restricted', '/', { user: 'rae', from: '/logs' }],
  ['Campaigns · restricted', '/campaigns', { user: 'rae', from: '/' }],
  // The docs: inside the dashboard signed in (a guide from the contents, an operation, a deep-linked overview section),
  // in their own layout signed out.
  ['Docs · guide', '/docs/rituals', { from: '/docs', click: 'Rituals and omens' }],
  ['Docs · MCP guide', '/docs/mcp', { from: '/' }],
  ['Docs · operation', '/docs/api/sendEmail', { from: '/docs/receiving' }],
  ['Docs · section', '/docs#sending-limits', { from: '/api-keys' }],
  ['Docs · signed out', '/docs', { user: null }],
  ['Docs · signed out guide', '/docs/receiving', { user: null, from: '/docs', click: 'Receiving' }],
  ['Onboarding', '/onboarding', { user: 'ona' }],
  // Two accounts in one browser: a cold load as the default (dana), then switching to nia's workspace from the switcher.
  ['Two accounts · switch', '/', { user: ['dana', 'nia'], from: '/', switchTo: 'Lumen Labs' }],
  ['Signed out', '/', { user: null }],
  // The public legal pages: signed out from the homepage and between documents, and signed in from the sidebar.
  ['Legal', '/legal', { user: null, from: '/legal/terms', click: 'Overview' }],
  ['Legal · terms', '/legal/terms', { user: null, from: '/' }],
  ['Legal · terms, signed in', '/legal/terms', { from: '/settings' }],
  ['Legal · acceptable use', '/legal/acceptable-use', { user: null, from: '/legal/terms' }],
  ['Legal · privacy', '/legal/privacy', { user: null, from: '/legal' }],
  ['Legal · subprocessors', '/legal/subprocessors', { user: null, from: '/legal/privacy' }],
  ['Support chat', '/logs', { from: '/', support: true }],
  ['Overview · sending limits dialog', '/', { dialog: 'How limits work' }],
];

// The phone pass: the pages someone opens on a phone (every list as cards, the details they open, Settings), light only.
const phonePages = new Set(['Overview', 'Logs', 'Sent email', 'Received email', 'Receiving', 'Receiving · address', 'Receiving · inbox', 'Receiving · agent inboxes', 'Receiving · webhooks', 'Campaigns', 'Campaign review', 'Templates', 'Audience', 'Lists', 'Domains', 'Domain', 'API keys', 'Settings', 'Settings · members', 'Settings · plan & usage', 'Settings · activity', 'Settings · billing', 'Settings · billing · owed', 'Settings · billing · free', 'Settings · webhook', 'Settings · MCP connection', 'Onboarding', 'Two accounts · switch', 'Operator', 'Operator · workspace', 'Operator · UI notes', 'Overview · UI notes mode', 'Operator · without UI notes', 'Overview · restricted', 'Campaigns · restricted', 'Signed out', 'Legal', 'Legal · terms', 'Legal · privacy', 'Docs', 'Docs · MCP guide', 'Docs · section', 'Docs · signed out', 'Support chat', 'Overview · sending limits dialog']);
const devices = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
};

// Every API path gets a stable delay of 300–1300 ms in 200 ms steps: slow, and out of request order, the same way
// every run. Assets load through Chrome's own throttling (150 ms latency, 1.6 Mbps down).
const apiDelay = path => { let h = 0; for (const c of path) h = (h * 31 + c.charCodeAt(0)) >>> 0; return 300 + (h % 6) * 200; };
const throttle = { offline: false, latency: 150, downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8 };
// Web fonts are served at once from app/dist, not through the throttled network, so they have loaded before the
// (throttled) script that renders any text runs. Before, whether a font arrived before or after the page's text varied
// with the runner's load, and a page whose text changed size when the font swapped in failed only sometimes (Settings ·
// webhook on a phone, 2 of 3 dev runs on Nov 12). CLS_FONTS=late measures that swap instead: every font arrives 1.8 s
// late, after the slowest API response, so text first paints in its local fallback (tokens.css).
const lateFonts = process.env.CLS_FONTS === 'late', FONT_DELAY_MS = 1800;

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
  const original = window.fetch, held = url => String(url).includes('/v1/rituals/version');
  window.fetch = function (...args) { const pending = original.apply(this, args); return held(args[0] instanceof Request ? args[0].url : args[0]) ? pending : track(pending); };
  for (const method of ['arrayBuffer', 'blob', 'bytes', 'formData', 'json', 'text']) {
    const read = Response.prototype[method];
    if (read) Response.prototype[method] = function (...args) { return held(this.url) ? read.apply(this, args) : track(read.apply(this, args)); };
  }
};
// Resolves once fonts are loaded, two frames have rendered and the main thread has gone idle.
const quiet = () => document.fonts.ready.then(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => requestIdleCallback(() => done(window.__cls.fetches), { timeout: 1000 })))));

// Requests in flight. A fetch() leaves this set when its response headers arrive: the page counts its body reads.
function network(page) {
  const inflight = new Set(), waiters = [];
  let started = 0;
  const finish = request => { inflight.delete(request); if (!inflight.size) for (const done of waiters.splice(0)) done(); };
  page.on('request', request => { if (request.url().includes(LONG_POLL)) return; inflight.add(request); started++; });
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
// The live view's long poll (features/inbound/live.ts) stays open while its page does; it never counts as loading.
const LONG_POLL = '/v1/rituals/version';
let liveSaves = 0;

// Masked addresses, in the page. A seeded mailbox address (cls-fixture.mjs) may be spelled out only where it is typed or
// chosen (a field, a picker, a dialog) or in a code example; everywhere else the page holds its first two characters.
const maskedLeaks = () => {
  const SEEDED = /[A-Za-z0-9._%+*-]+@(?:[a-z0-9-]+\.)*(?:northwind\.example|lumenlabs\.example|fieldnotes\.example|driftwood\.example|example\.net|example\.com)\b/gi;
  const mailbox = value => value.slice(0, value.lastIndexOf('@')).replace(/\*/g, '') !== '';
  const exempt = el => !!el.closest('input, textarea, select, option, datalist, [contenteditable=""], [contenteditable="true"], pre, code, [role=dialog], [role=alertdialog]');
  const found = [], note = (what, value) => { if (found.length < 5) found.push(`${what} spells out ${value.slice(0, 2)}…`); };
  for (const el of document.querySelectorAll('.private-address:not([data-revealed])')) {
    const text = el.querySelector('.private-address__value')?.textContent ?? el.textContent;
    if ([...text].length > 2 || !el.querySelector('.private-address__rest')) note('a masked address', text);
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node; (node = walker.nextNode());) for (const value of node.nodeValue.match(SEEDED) ?? []) if (mailbox(value) && !exempt(node.parentElement) && !node.parentElement.closest('[data-revealed]')) note(`text in <${node.parentElement.tagName.toLowerCase()} class="${node.parentElement.className}">`, value);
  for (const el of document.body.querySelectorAll('[title], [aria-label], [aria-description], [alt], a[href]')) for (const name of ['title', 'aria-label', 'aria-description', 'alt', 'href']) {
    let value = el.getAttribute(name) ?? ''; try { value = decodeURIComponent(value); } catch {}
    for (const match of value.match(SEEDED) ?? []) if (mailbox(match) && !exempt(el)) note(`${name} on <${el.tagName.toLowerCase()} class="${el.className}">`, match);
  }
  return found;
};
// Where to hover the first few masked addresses in view that the pointer can reach, and what must stay where it is.
const maskedTargets = () => [...document.querySelectorAll('.private-address:not([data-revealed])')].map((el, index) => {
  const r = el.getBoundingClientRect(), x = r.left + 3, y = r.top + r.height / 2;
  return r.width > 0 && r.top >= 0 && r.bottom <= innerHeight && el.contains(document.elementFromPoint(x, y)) ? { index, x, y } : null;
}).filter(Boolean).slice(0, 3);
const maskedState = index => {
  const el = document.querySelectorAll('.private-address')[index], rect = node => { const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(n => Math.round(n * 100) / 100).join(' '); };
  return { revealed: el.hasAttribute('data-revealed'), text: el.querySelector('.private-address__value').textContent, own: rect(el), around: rect(el.closest('tr, li, dd, h1, p, section') ?? el.parentElement) };
};
async function masking(page, hover) {
  const problems = await page.evaluate(maskedLeaks);
  if (!hover) return problems;
  const frame = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  for (const { index, x, y } of await page.evaluate(maskedTargets)) {
    const before = await page.evaluate(maskedState, index);
    await page.mouse.move(x, y); await frame();
    const shown = await page.evaluate(maskedState, index);
    await page.mouse.move(1, 1); await frame();
    const after = await page.evaluate(maskedState, index);
    if (!shown.revealed || [...shown.text].length <= 2) problems.push(`hovering ${before.text}… did not reveal it`);
    else if (shown.own !== before.own || shown.around !== before.around) problems.push(`revealing ${before.text}… moved it: ${before.own} → ${shown.own}`);
    if (after.revealed || after.text !== before.text || after.own !== before.own) problems.push(`${before.text}… stayed revealed or moved after the pointer left`);
  }
  // Privacy mode off (⇧P, lib/privacy.ts) reveals every address at once without moving anything; on again masks them.
  const count = await page.evaluate(() => document.querySelectorAll('.private-address').length);
  if (!count) return problems;
  const states = async () => { const all = []; for (let i = 0; i < Math.min(count, 5); i++) all.push(await page.evaluate(maskedState, i)); return all; };
  // ⇧P is ignored while typing (the support chat's box, a ritual's editor), so leave whatever field has focus first.
  await page.evaluate(() => document.activeElement?.blur());
  const before = await states();
  await page.keyboard.press('Shift+P'); await frame();
  const off = await states(), root = await page.evaluate(() => ({ privacy: document.documentElement.dataset.privacy, pressed: document.querySelector('.privacy-toggle')?.getAttribute('aria-pressed') }));
  if (root.privacy !== 'off' || root.pressed !== 'false') problems.push(`⇧P did not turn privacy mode off: ${JSON.stringify(root)}`);
  off.forEach((state, i) => {
    if (!state.revealed || [...state.text].length <= 2) problems.push(`privacy mode off left ${before[i].text}… masked`);
    else if (state.own !== before[i].own || state.around !== before[i].around) problems.push(`privacy mode off moved ${before[i].text}…: ${before[i].own} → ${state.own}`);
  });
  await page.keyboard.press('Shift+P'); await frame();
  const on = await states();
  on.forEach((state, i) => { if (state.revealed !== before[i].revealed || state.text !== before[i].text || state.own !== before[i].own) problems.push(`privacy mode on again did not mask ${before[i].text}… as before`); });
  problems.push(...await page.evaluate(maskedLeaks));
  return problems;
}

async function measure(browser, job, fx) {
  const origin = fx.origins[job.index % fx.origins.length];
  const context = await browser.newContext({ ...devices[job.device], colorScheme: job.scheme });
  const result = { page: job.name, path: job.path, scheme: job.scheme, device: job.device, mode: job.mode, cls: null, entries: [], longTask: null, error: null };
  let page, net;
  const problems = [];
  const work = (async () => {
    if (job.user) await context.addCookies([job.user].flat().map((user, slot) => ({ name: slot ? `bane.session_token.${slot}` : 'bane.session_token', value: encodeURIComponent(fx.sessions[user].cookie), url: origin, httpOnly: true })));
    await context.addInitScript(probe);
    // Data Saver turns off the shell's idle warm-up of every other sidebar section: in-app clicks then load the next
    // page's code and data cold, and cold loads (apart from Overview, which exercises the warm-up in each pass) measure
    // their own page rather than re-fetching all eight sections 170 times.
    if (job.mode === 'in-app' || job.name !== 'Overview') await context.addInitScript(() => {
      if (navigator.connection) Object.defineProperty(navigator.connection, 'saveData', { get: () => true });
      else Object.defineProperty(navigator, 'connection', { value: { saveData: true }, configurable: true });
    });
    // The support chat's scripted demo (components/SupportChat.tsx), so the open chat is measured without a support Worker.
    if (job.support) await context.addInitScript(() => sessionStorage.setItem('bane.support', 'demo'));
    // UI notes mode, as an operator turns it on (lib/ui-notes-mode.ts).
    if (job.notes) await context.addInitScript(() => localStorage.setItem('bane.ui-notes', 'on'));
    page = await context.newPage();
    net = network(page);
    page.on('request', request => { const url = request.url(); if (/^https?:\/\//i.test(url) && !url.startsWith(origin)) problems.push(`external request ${url}`); });
    page.on('response', response => { if (response.url().startsWith(origin + '/v1/') && (response.status() >= 500 || response.status() === 429)) problems.push(`${response.status()} ${response.request().method()} ${response.url().slice(origin.length)}`); });
    page.on('pageerror', error => problems.push(`page error: ${error.message}`));
    // Network rules shape traffic in Chrome without CDP Fetch interception (context.route), whose per-request pauses
    // stalled targets on Linux CI. The fixture shaper applies apiDelay on /v1/* and serves /fonts/* from memory.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    if (lateFonts) await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.emulateNetworkConditionsByRule', {
      offline: false,
      matchedNetworkConditions: [
        ...(lateFonts ? [] : [{ urlPattern: `${origin}/fonts/*`, offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }]),
        { urlPattern: `${origin}/*`, ...throttle },
        { urlPattern: 'http*://*', offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
      ],
    });
    await page.goto(origin + (job.mode === 'in-app' ? job.from : job.path), { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // With late fonts, the fallbacks only keep text still if this machine has one of their local fonts (tokens.css).
    const missing = !lateFonts ? [] : await page.evaluate(() => Promise.all([...document.fonts].filter(f => f.family.includes('Fallback')).map(f => f.load().then(() => null, () => `${f.family} ${f.weight} ${f.unicodeRange}`))));
    for (const face of missing.filter(Boolean)) problems.push(`no local font for ${face}: install fonts-liberation and fonts-dejavu-core, or measure on a machine with Arial and Menlo`);
    await settle(page, net);
    if (job.support) {
      // Open the chat and let the greeting finish: the panel is idle and no caret is left in it.
      const opened = await page.evaluate(() => { const button = document.getElementById('support-trigger'); button?.click(); return Boolean(button); });
      if (!opened) problems.push('no Help button');
      else await page.waitForFunction(() => document.querySelector('#support-panel[data-open]:not([data-busy])') && !document.querySelector('#support-panel .support-caret'), null, { timeout: 30_000, polling: 100 });
      await settle(page, net);
    }
    if (job.dialog) {
      const opened = await page.evaluate(label => { const el = [...document.querySelectorAll('button')].find(el => el.getClientRects().length && el.textContent.trim().startsWith(label)); el?.click(); return Boolean(el); }, job.dialog);
      if (!opened) problems.push(`no control “${job.dialog}”`);
      else await page.waitForSelector('[role=dialog][data-state=open]', { timeout: 10_000 }).catch(() => problems.push(`“${job.dialog}” opened no dialog`));
      await settle(page, net);
    }
    if (job.mode === 'in-app') {
      await page.evaluate(() => { window.__cls.reset(); window.__inApp = performance.now(); });
      if (job.switchTo) {
        // Open the switcher (a dropdown opens on pointer down, the phone's sheet on click) and pick the other account's workspace.
        await page.evaluate(() => { const trigger = document.querySelector('#sidebar-workspace'); trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' })); trigger?.click(); });
        const item = await page.waitForFunction(text => [...document.querySelectorAll('[role=menuitem], .account-sheet button')].find(el => el.textContent.includes(text)), job.switchTo, { timeout: 10_000 }).catch(() => null);
        result.via = item ? 'switch' : `no workspace “${job.switchTo}” in the switcher`;
        if (item) await item.evaluate(el => el.click());
      } else result.via = await page.evaluate(({ path, click, row }) => {
        const shown = el => el.getClientRects().length > 0, text = el => el.textContent.replace(/\s+/g, ' ').trim();
        // A table row, or on a phone its card (whose link covers it).
        if (row) { const tr = [...document.querySelectorAll('tbody tr, .ui-card')].find(tr => shown(tr) && text(tr).includes(row)); (tr?.querySelector('.ui-card__link') ?? tr)?.click(); return tr ? 'row' : `no row with “${row}”`; }
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
    if (job.live) {
      // The agent saves; the page must show it (`apply`) or offer the choice (`conflict`) without anything moving.
      if (job.live === 'conflict') {
        await page.click('.ritual-editor .cm-line >> nth=2');
        await page.keyboard.press('End'); await page.keyboard.type(' // mine');
        await page.waitForFunction(() => document.querySelector('.ritual-savebar')?.textContent.includes('Unsaved changes'), null, { timeout: 10_000 });
      }
      const saved = await fetch(fx.apiOrigin + '/v1/rituals/scripts/triage', { method: 'PUT', headers: { authorization: `Bearer ${fx.liveKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ key: 'triage', source: liveSource(++liveSaves) }) });
      if (!saved.ok) problems.push(`the agent's save failed: ${saved.status}`);
      else await page.waitForSelector(job.live === 'conflict' ? '.ritual-incoming' : '.ritual-savebar__text--remote', { timeout: 30_000 }).catch(() => problems.push(`no ${job.live === 'conflict' ? 'conflict card' : 'live update'} after the agent's save`));
      await settle(page, net);
      if (job.mode === 'load') { const read = await page.evaluate(() => window.__cls.read()); Object.assign(result, { cls: sharp(read.total), entries: read.entries }); }
    }
    if (job.user === 'rae') {
      const leak = await page.evaluate(async () => [document.querySelector('.uin-pill, .uin-pin, .uin-layer') && 'the notes layer', [...document.querySelectorAll('[role=tab], [role=menuitem]')].some(el => el.textContent.startsWith('UI notes')) && 'a UI notes control',
        await fetch('/v1/operator/ui-notes').then(r => r.status !== 404 && `GET /v1/operator/ui-notes answered ${r.status}`)].filter(Boolean));
      for (const what of leak) problems.push(`${what} for an operator outside UI_NOTES_SUBJECTS`);
    }
    const broken = await page.evaluate(() => document.querySelector('.fatal-error') ? 'the error boundary rendered' : [...document.querySelectorAll('h1,h2')].some(h => h.textContent === 'Page not found') ? 'Page not found' : null);
    if (broken) problems.push(broken);
    problems.push(...await masking(page, job.mode === 'load' && job.device === 'desktop'));
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
    row[`${r.device === 'phone' ? 'phone' : r.scheme} ${r.mode}`] = r;
    if (r.longTask !== null) row.long = Math.max(row.long ?? 0, r.longTask);
  }
  const lines = [
    `### Layout shift: ${failed.length ? `❌ ${failed.length} of ${results.length} measurements failed` : `✅ ${results.length} measurements, every page at CLS ≤ ${LIMIT}`}`,
    '',
    `Cold load and in-app navigation, throttled network, API responses delayed 300–1300 ms out of order, web fonts ${lateFonts ? `after ${FONT_DELAY_MS} ms` : 'before any text'}; desktop 1440 × 900, phone 390 × 844 with touch. Limit: CLS ${LIMIT}. Longest task during in-app navigation is reported, not gated. ${seconds}s.`,
    '',
    '| Page | Path | Light load | Light in-app | Dark load | Dark in-app | Phone load | Phone in-app | Longest task |',
    '| --- | --- | --: | --: | --: | --: | --: | --: | --: |',
    ...[...rows].map(([page, row]) => `| ${page} | \`${row.path}\` | ${format(row['light load'])} | ${format(row['light in-app'])} | ${format(row['dark load'])} | ${format(row['dark in-app'])} | ${format(row['phone load'])} | ${format(row['phone in-app'])} | ${row.long === null ? '' : `${row.long} ms`} |`),
  ];
  if (failed.length) {
    lines.push('', '#### Failures', '');
    for (const r of failed) {
      lines.push(`- **${r.page}** (${r.device === 'phone' ? 'phone' : r.scheme}, ${r.mode}) \`${r.path}\`: ${r.error ?? `CLS ${r.cls}`}`);
      for (const e of r.entries.slice(0, 5)) for (const s of e.sources.slice(0, 3)) lines.push(`  - ${e.value.toFixed(4)} at ${e.at} ms: \`${s.node}\` ${JSON.stringify(s.from)} → ${JSON.stringify(s.to)}${s.text ? ` “${s.text.slice(0, 50)}”` : ''}`);
    }
  }
  return { markdown: lines.join('\n') + '\n', failed };
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const browserPromise = chromium.launch(process.env.CLS_CHROME ? { executablePath: process.env.CLS_CHROME } : { channel: 'chrome' });
browserPromise.catch(() => {});
const fx = await start(repo, { servers: Math.min(2, Math.ceil(workers / 8)), delay: apiDelay, fontDelay: lateFonts ? FONT_DELAY_MS : 0, log: message => console.log(`${elapsed()} ${message}`) }).catch(async error => {
  await browserPromise.then(b => b.close(), () => {});
  throw error;
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => Promise.allSettled([fx.stop(), browserPromise.then(b => b.close())]).finally(() => process.exit(130)));
let results = [];
try {
  const [ids, browser] = await Promise.all([seed(fx), browserPromise]);
  console.log(`${elapsed()} seeded`);
  const jobs = [];
  const passes = [['desktop', 'light'], ['desktop', 'dark'], ...process.env.CLS_PHONE === '0' ? [] : [['phone', 'light']]];
  for (const [device, scheme] of passes) for (const [name, path, { user = 'dana', from, click, row, switchTo, support, live, notes }] of pages(ids)) {
    if (only && !only.test(name) || device === 'phone' && !phonePages.has(name)) continue;
    const slug = `${name}-${device === 'phone' ? 'phone' : scheme}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    jobs.push({ name, path, user, scheme, device, support, live, notes, mode: 'load', slug: slug + '-load' });
    if (from) jobs.push({ name, path, user, from, click, row, switchTo, support, notes, scheme, device, mode: 'in-app', slug: slug + '-in-app' });
  }
  jobs.forEach((job, index) => { job.index = index; });
  // Multi-step jobs (Support chat, live rituals, Overview's full warm-up) start first so none trails alone at the end.
  const weight = job => (job.support ? 4 : 0) + (job.live ? 2 : 0) + (job.name === 'Overview' && job.mode === 'load' ? 3 : 0);
  const queue = [...jobs].sort((a, b) => weight(b) - weight(a));
  console.log(`${elapsed()} measuring ${jobs.length} page loads, ${workers} at a time`);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(workers, queue.length) }, async () => {
    while (next < queue.length) {
      const job = queue[next++];
      const r = await measure(browser, job, fx);
      results[job.index] = r;
      const flag = r.error || r.cls > LIMIT ? '✗' : '✓';
      console.log(`${elapsed().padStart(6)} ${flag} ${(r.device === 'phone' ? 'phone' : r.scheme).padEnd(5)} ${r.mode.padEnd(6)} ${r.page.padEnd(26)} ${String(r.cls).padEnd(7)}${r.longTask !== null ? ` ${r.longTask} ms` : ''}${r.error ? `  ${r.error}` : ''}`);
    }
  }));
} finally {
  await browserPromise.then(b => b.close(), () => {});
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
