// Density lint: how much each dashboard page asks a reader to take in, measured in the browser on the CLS gate's
// synthetic workspaces and page list (cls.mjs, cls-fixture.mjs), at desktop 1440 × 900 and phone 390 × 844.
//
// Per page: visible words outside tables, in total and above the fold, text blocks over LONG_BLOCK words, paragraphs,
// distinct controls, tooltips and info icons; and findings: the same value shown twice on one screen (dup-value: the sender score
// in the sidebar and in Overview, say), sections with the same label (dup-label), repeated explanations (dup-text),
// long blocks (long-block) and explanations with nothing to act on near them (inert). The score (SCORE below) weighs
// them; lower is easier to take in.
//
// A ratchet: density-baseline.json holds each page's score and findings. CI fails on a finding that isn't in it, or
// when a page's score rises more than TOLERANCE. A local run lowers the baseline where a page got better; pass
// --update-baseline to accept a worse one deliberately. CI (CI=true) never writes it.
//
// From app/: bun run density           build, measure every page (CLS_DENSITY=only node scripts/cls.mjs), report
//            node scripts/density.mjs --from .cls/density.json   report on measurements already taken (CI: the cls
//                                       job's run with CLS_DENSITY=1, so no second server or seed)
//            --update-baseline        accept the current scores and findings
//            DENSITY_OUT=<dir>        report.json, summary.md and an annotated screenshot per page (default app/.density)
//            CLS_ONLY=<regex>         only pages whose name matches (passed through to cls.mjs)
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = join(app, 'scripts/density-baseline.json');
export const OUT = resolve(process.env.DENSITY_OUT ?? join(app, '.density'));
const LONG_BLOCK = 25, INERT_WORDS = 15, NEAR_PX = 120;
const TOLERANCE = score => Math.max(3, Math.round(score * 0.05));
// Lower is easier to take in. Words count once, again when above the fold; each finding costs what reading past it does.
export const SCORE = { word: 0.1, foldWord: 0.1, longBlock: 4, paragraph: 1, control: 0.5, tip: 1, duplicate: 8, inert: 3 };

// Content pages (legal, docs, the signed-out home), the support chat's scripted conversation, and staff overlays and
// live-edit states that repeat another page, are not measured.
const SKIP = /^(Legal|Docs|Signed out|Support chat)|UI notes|without UI notes|live (update|conflict)|Two accounts|Overview · range/;
export const wanted = job => job.mode === 'load' && (job.device === 'phone' || job.scheme === 'light') && !SKIP.test(job.name ?? job.page);

// ---------------------------------------------------------------- in the page
const probe = ({ LONG_BLOCK, INERT_WORDS, NEAR_PX }) => {
  const shown = el => el.getClientRects().length > 0 && el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && !el.closest('.sr-only, [hidden], .density-overlay');
  const dialog = [...document.querySelectorAll('[role=dialog], [role=alertdialog]')].find(shown);
  const root = dialog ?? document.querySelector('#main-content') ?? document.body;
  const fold = Math.min(innerHeight, root.getBoundingClientRect().bottom);
  const words = text => (text.match(/[A-Za-z0-9][^\s]*/g) ?? []).filter(w => /[A-Za-z0-9]/.test(w)).length;
  const norm = text => text.replace(/\s+/g, ' ').trim();
  const SKIP_TEXT = 'script, style, noscript, textarea, input, select, option, svg, pre, .cm-editor, [contenteditable=""], [contenteditable="true"], iframe';
  const blockOf = node => { for (let el = node.parentElement; el; el = el.parentElement) { const d = getComputedStyle(el).display; if (d !== 'inline' && d !== 'contents') return el; } return document.body; };
  const label = el => norm(el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').slice(0, 60);
  const path = el => { const parts = []; for (let n = el; n && n !== document.body && parts.length < 4; n = n.parentElement) parts.unshift(n.tagName.toLowerCase() + (typeof n.className === 'string' && n.className ? '.' + n.className.trim().split(/\s+/)[0] : '')); return parts.join(' > '); };

  // Text blocks: the text of each block-level box (a paragraph, a cell, a button), on the whole screen.
  // With a dialog open the screen is the dialog: the page behind it is dimmed and measured on its own.
  const blocks = new Map();
  const walker = document.createTreeWalker(dialog ?? document.body, NodeFilter.SHOW_TEXT);
  for (let node; (node = walker.nextNode());) {
    if (!/[A-Za-z0-9]/.test(node.nodeValue) || node.parentElement.closest(SKIP_TEXT) || !shown(node.parentElement)) continue;
    const block = blockOf(node);
    const entry = blocks.get(block) ?? blocks.set(block, { el: block, text: '', last: null }).get(block);
    entry.text += (entry.last && (entry.last !== node.parentElement || /\d$/.test(entry.text) && /^\d/.test(node.nodeValue)) ? ' ' : '') + node.nodeValue;
    entry.last = node.parentElement;
  }
  const list = [...blocks.values()].map(b => {
    const r = b.el.getBoundingClientRect(), style = getComputedStyle(b.el), text = norm(b.text);
    const heading = /^H[1-6]$/.test(b.el.tagName) || b.el.matches('[role=heading], legend, .ui-dialog__title, [class*=__title], [class*=-title]');
    const control = Boolean(b.el.closest('button, a[href], [role=button], [role=tab], [role=menuitem], [role=option], label, summary'));
    return { el: b.el, text, words: words(text), top: r.top, bottom: r.bottom, left: r.left, right: r.right, size: parseFloat(style.fontSize), heading, control,
      inRoot: root.contains(b.el), shell: Boolean(b.el.closest('aside.sidebar, nav, .mobile-tabbar, .ui-toasts')), table: Boolean(b.el.closest('table, .ui-card, [role=grid], [role=listbox]')),
      paragraph: !heading && !control && /[.!?:]/.test(text) && words(text) >= 8 };
  }).filter(b => b.words > 0);
  const inRoot = list.filter(b => b.inRoot);

  // Controls: what a reader can do on the page, counted once per name; a table's rows count as one control.
  const controls = new Set(), CONTROL = 'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=switch], [role=checkbox], [role=combobox], [role=menuitem], summary';
  for (const el of root.querySelectorAll(CONTROL)) {
    if (!shown(el)) continue;
    const row = el.closest('tbody, .ui-card') ?? (el.parentElement && [...el.parentElement.children].filter(c => c.tagName === el.tagName).length >= 5 ? el : null);
    controls.add(row ? `group:${path(row.parentElement)}` : `${(el.getAttribute('role') ?? el.tagName).toLowerCase()}:${label(el)}`);
  }
  // Tooltips and info icons: a title that isn't just the clipped text, and the info and help glyphs.
  const tips = [...root.querySelectorAll('[title], [data-tooltip], [aria-describedby], svg.lucide-info, svg.lucide-circle-help, svg.lucide-circle-question-mark, svg.lucide-badge-info')].filter(el => {
    if (!shown(el) || el.closest('.private-address')) return false;
    if (el.matches('svg')) return true;
    const title = norm(el.getAttribute('title') ?? el.getAttribute('data-tooltip') ?? '');
    if (el.hasAttribute('aria-describedby') && !el.hasAttribute('title')) return [...el.getAttribute('aria-describedby').split(' ')].some(id => document.getElementById(id)?.getAttribute('role') === 'tooltip');
    return words(title) >= 3 && !norm(el.textContent).includes(title.slice(0, 20));
  });

  const findings = [], marks = [];
  const mark = (el, type, tag) => { marks.push({ el, type, tag }); };
  // Keys leave out digits (counts and times move between runs) and the product's name (a rename isn't a new finding).
  const find = (type, message, key, els, tag) => { findings.push({ type, message, key: key.toLowerCase().replace(/\d/g, '#').replace(/\b(bane|nightmail)\b/g, 'brand').slice(0, 80) }); for (const el of els) mark(el, type, tag); };
  const where = b => b.shell ? 'sidebar' : b.inRoot ? 'page' : 'banner';
  // One inside the other, or items of one collection (rows of a list, cards of a strip): two rules with the same
  // threshold, or two rows with the same count, aren't the same information.
  const near = (a, b) => {
    if (a.el.contains(b.el) || b.el.contains(a.el)) return true;
    let x = a.el; while (x.parentElement && !x.parentElement.contains(b.el)) x = x.parentElement;
    let y = b.el; while (y.parentElement && y.parentElement !== x.parentElement) y = y.parentElement;
    return x.tagName === y.tagName && x.className === y.className && x.parentElement.children.length >= 3;
  };

  // The same value twice on one screen: the figures in short labels and stats (not prose, tables, charts, dates or
  // times) with at least 2 significant digits, in two places that aren't one inside the other.
  const MONTH = '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*';
  const values = list.filter(b => !b.table && b.words <= 8 && !b.el.closest('svg, [aria-hidden=true], [class*=chart], [class*=axis], time, [role=img], [role=tablist], [role=radiogroup], [role=combobox], select')).flatMap(b => {
    const text = b.text.replace(/\d{1,2}:\d{2}(:\d{2})?/g, ' ').replace(new RegExp(`${MONTH}\\s+\\d{1,2}|\\d{1,2}\\s+${MONTH}|\\d{4}-\\d{2}-\\d{2}`, 'g'), ' ');
    // Not part of an identifier (INV-2209, order 4821's “#4821”) or a unit word glued on (30d, 24h).
    // Thresholds (“≥ 2% and ≥ 25”) are rules, not readings, and “/ 100” is a scale. The word after a figure is its
    // unit: “1,000 emails” and “1,000 recipients” are different things.
    if (/[≥≤<>]/.test(text)) return [];
    return [...text.matchAll(/(?<![\w#-])[$€£]?\d[\d,]*(\.\d+)?%?(?![\w-])/g)].map(m => ({ ...b, at: m.index, shown: m[0], value: m[0].replace(/[$€£,%]/g, '').replace(/\.0+$/, ''), unit: /^\s*([A-Za-z]+)/.exec(text.slice(m.index + m[0].length))?.[1]?.toLowerCase().replace(/s$/, '') ?? '' }))
      .filter(v => v.value.replace(/^[0.]+/, '').replace(/\D/g, '').length >= 2 && !/^(19|20)\d\d$/.test(v.value) && !(v.value === '100' && /(\/|of|–)\s*$/.test(text.slice(0, v.at))));
  });
  // A value's label: the nearest short text before it in its card (or its own words, “Limit 5,000/day”).
  const context = b => {
    const own = norm(b.text.replace(/[$€£]?\d[\d,./]*%?/g, ' ').replace(/[·:|]/g, ' '));
    if (/[A-Za-z]{3,}/.test(own)) return own.slice(0, 30);
    for (let el = b.el.parentElement, i = 0; el && i < 4; el = el.parentElement, i++) {
      const before = list.filter(x => x !== b && el.contains(x.el) && !x.el.contains(b.el) && x.words <= 6 && /[A-Za-z]{3,}/.test(x.text) && (x.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING));
      if (before.length) return before[0].text.slice(0, 30);
    }
    return '';
  };
  const byValue = new Map();
  for (const v of values) (byValue.get(v.value) ?? byValue.set(v.value, []).get(v.value)).push(v);
  for (const [value, all] of byValue) for (const group of (units => units.length < 2 ? [all] : units.map(u => all.filter(v => !v.unit || v.unit === u)))([...new Set(all.map(v => v.unit).filter(Boolean))])) {
    const apart = group.filter((v, i) => !group.some((w, j) => j < i && near(v, w)));
    if (apart.length < 2 || !apart.some(v => v.inRoot)) continue;
    const labels = apart.map(v => `${context(v) || 'unlabelled'} (${where(v)})`);
    find('dup-value', `${apart[0].shown} shown ${apart.length} times: ${labels.join(', ')}`, `${value}|${apart.map(v => context(v) || v.text.slice(0, 20)).join('|')}`, apart.map(v => v.el), apart[0].shown);
  }
  // Sections with the same label: two headings with the same text on one screen (navigation and tabs left out).
  const heads = list.filter(b => b.heading && !b.shell && b.words <= 8);
  const byHead = new Map();
  for (const h of heads) { const k = h.text.toLowerCase(); (byHead.get(k) ?? byHead.set(k, []).get(k)).push(h); }
  for (const [text, group] of byHead) if (group.length > 1) find('dup-label', `“${group[0].text}” labels ${group.length} sections`, text, group.map(h => h.el), 'same label');
  // Repeated explanations: a sentence of 6+ words said twice, or two blocks sharing most of their word triples.
  const prose = list.filter(b => b.words >= 6 && !b.heading && !b.control && !b.table);
  const sentences = new Map();
  for (const b of prose) for (const s of b.text.split(/(?<=[.!?])\s+/)) if (words(s) >= 6) { const k = s.toLowerCase().replace(/\d+/g, '#'); (sentences.get(k) ?? sentences.set(k, []).get(k)).push(b); }
  const said = new Set();
  for (const [s, group] of sentences) { const uniq = [...new Set(group)].filter((b, i, all) => !all.some((c, j) => j < i && near(b, c))); if (uniq.length > 1) { said.add(uniq.map(b => b.el)); find('dup-text', `said ${uniq.length} times: “${s.slice(0, 80)}”`, s, uniq.map(b => b.el), 'repeated'); } }
  const triples = text => { const w = text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean), out = new Set(); for (let i = 0; i + 2 < w.length; i++) out.add(w.slice(i, i + 3).join(' ')); return out; };
  for (let i = 0; i < prose.length; i++) for (let j = i + 1; j < prose.length; j++) {
    const a = prose[i], b = prose[j];
    if (a.words < 10 || b.words < 10 || near(a, b)) continue;
    const ta = triples(a.text), tb = triples(b.text), shared = [...ta].filter(t => tb.has(t)).length;
    if (shared / Math.min(ta.size, tb.size) >= 0.5 && ![...said].some(els => els.includes(a.el) && els.includes(b.el))) find('dup-text', `explained twice: “${a.text.slice(0, 60)}” and “${b.text.slice(0, 60)}”`, a.text.slice(0, 40) + '|' + b.text.slice(0, 40), [a.el, b.el], 'repeated');
  }
  // Long blocks, and explanations with nothing to do near them (no control within NEAR_PX, and no link inside).
  const actionable = [...document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=switch], [role=checkbox], [role=combobox], summary')].filter(shown).map(el => el.getBoundingClientRect());
  for (const b of inRoot) {
    if (b.words > LONG_BLOCK && !b.table) find('long-block', `${b.words} words in one block: “${b.text.slice(0, 70)}…”`, b.text.slice(0, 40), [b.el], `${b.words}w`);
    if (b.paragraph && b.words >= INERT_WORDS && !b.table && !b.el.querySelector('a[href], button')) {
      const acts = actionable.some(r => r.bottom >= b.top - NEAR_PX && r.top <= b.bottom + NEAR_PX && r.right >= b.left - 200 && r.left <= b.right + 200);
      if (!acts) find('inert', `nothing to act on near: “${b.text.slice(0, 70)}…”`, b.text.slice(0, 40), [b.el], 'no action');
    }
  }
  window.__density = { marks };
  // Words outside tables and card lists: the page's own copy, labels and figures. Rows of data are counted apart and
  // not scored; their amount depends on the data, not on the page.
  const copy = inRoot.filter(b => !b.table);
  const total = copy.reduce((n, b) => n + b.words, 0);
  const above = copy.filter(b => b.top < fold && b.bottom > 0).reduce((n, b) => n + b.words, 0);
  return {
    scope: dialog ? 'dialog' : 'page', words: total, fold: above, dataWords: inRoot.filter(b => b.table).reduce((n, b) => n + b.words, 0), longBlocks: findings.filter(f => f.type === 'long-block').length,
    paragraphs: inRoot.filter(b => b.paragraph).length, controls: controls.size, tips: tips.length,
    duplicates: findings.filter(f => f.type.startsWith('dup-')).length, inert: findings.filter(f => f.type === 'inert').length,
    blocks: inRoot.sort((a, b) => b.words - a.words).slice(0, 5).map(b => ({ words: b.words, text: b.text.slice(0, 140) })), findings,
    values: values.map(v => `${v.shown}|${v.text.slice(0, 30)}|${where(v)}`).slice(0, 40), tipTexts: tips.slice(0, 12).map(el => el.matches('svg') ? `icon in ${label(el.parentElement)}` : norm(el.getAttribute('title') ?? '').slice(0, 60)), controlNames: [...controls].slice(0, 60),
  };
};

// Draws each finding over the page: duplicates magenta, long blocks orange, inert explanations yellow, with a tag.
const annotate = ({ score, name }) => {
  const colors = { 'dup-value': '#e0119d', 'dup-label': '#e0119d', 'dup-text': '#e0119d', 'long-block': '#f06a00', inert: '#c9a400' };
  const layer = document.createElement('div');
  layer.className = 'density-overlay';
  layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;font:600 11px/1.2 ui-monospace,monospace';
  for (const { el, type, tag } of window.__density.marks) {
    if (!el.isConnected) continue;
    const r = el.getBoundingClientRect(), box = document.createElement('div'), label = document.createElement('span');
    box.style.cssText = `position:absolute;left:${r.left - 3}px;top:${r.top - 3}px;width:${r.width + 6}px;height:${r.height + 6}px;outline:2px ${type === 'inert' ? 'dashed' : 'solid'} ${colors[type]};border-radius:4px;background:${colors[type]}14`;
    label.textContent = `${type} · ${tag}`;
    label.style.cssText = `position:absolute;left:-2px;top:-17px;padding:1px 4px;border-radius:3px;color:#fff;background:${colors[type]};white-space:nowrap`;
    box.append(label); layer.append(box);
  }
  const head = document.createElement('div');
  head.textContent = `${name} · density ${score}`;
  head.style.cssText = 'position:absolute;right:8px;bottom:8px;padding:4px 8px;border-radius:4px;color:#fff;background:#111d';
  layer.append(head);
  document.body.append(layer);
};

export const score = m => Math.round(m.words * SCORE.word + m.fold * SCORE.foldWord + m.longBlocks * SCORE.longBlock + m.paragraphs * SCORE.paragraph + m.controls * SCORE.control + m.tips * SCORE.tip + m.duplicates * SCORE.duplicate + m.inert * SCORE.inert);
const pageKey = r => `${r.page} · ${r.device}`;
const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Waits out what the CLS gate's settle doesn't: a debounced request that starts after the network went quiet (the
// rituals check), and sheets and dialogs still sliding in. Both modes then measure the same finished page.
async function calm(page) {
  for (let round = 0; round < 2; round++) {
    await page.waitForTimeout(400);
    await page.waitForFunction(() => !window.__cls || window.__cls.fetches === 0, null, { timeout: 8000, polling: 100 }).catch(() => {});
    await page.evaluate(() => Promise.race([Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))), new Promise(done => setTimeout(done, 2000))]));
  }
}

// Called by cls.mjs on each wanted job once the page has settled (and its CLS has been read).
export async function collect(page, job) {
  await calm(page);
  const m = await page.evaluate(probe, { LONG_BLOCK, INERT_WORDS, NEAR_PX });
  m.score = score(m);
  // The whole page, annotated: the viewport grows to the content's height so findings below the fold show too.
  mkdirSync(OUT, { recursive: true });
  const height = await page.evaluate(() => { const main = document.querySelector('[role=dialog]') ? null : document.querySelector('#main-content'); return main ? main.scrollHeight - main.clientHeight : 0; });
  const size = page.viewportSize();
  if (height > 0) await page.setViewportSize({ width: size.width, height: Math.min(size.height + height, 6000) });
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  await page.evaluate(annotate, { score: m.score, name: `${job.name} (${job.device})` });
  m.screenshot = `${slug(job.name)}-${job.device}.png`;
  await page.screenshot({ path: join(OUT, m.screenshot) });
  await page.evaluate(() => document.querySelector('.density-overlay')?.remove());
  if (height > 0) await page.setViewportSize(size);
  return m;
}

// ---------------------------------------------------------------- report and ratchet
function readBaseline() { try { return JSON.parse(readFileSync(BASELINE, 'utf8')).pages ?? {}; } catch { return {}; } }
function writeBaseline(pages) {
  const sorted = Object.fromEntries(Object.keys(pages).sort().map(k => [k, { score: pages[k].score, findings: [...pages[k].findings].sort() }]));
  writeFileSync(BASELINE, JSON.stringify({ about: 'Density lint: each page’s score and findings accepted so far (app/scripts/density.mjs). A new finding or a score more than 5% higher fails; a local run lowers these as pages improve. Regenerate with: node scripts/density.mjs --update-baseline', pages: sorted }, null, 1) + '\n');
}
const fkey = f => `${f.type}|${f.key}`;

export function report(results, { update = false, ci = Boolean(process.env.CI) } = {}) {
  const measured = results.filter(r => r.density);
  const errors = results.filter(r => !r.density && wanted(r));
  const baseline = readBaseline(), next = { ...baseline };
  const rows = measured.map(r => {
    const key = pageKey(r), was = baseline[key], m = r.density;
    // A finding matches the baseline by its key, or else any unmatched baseline finding of its type on this page: a
    // reworded string is the same finding, and only one more of a type than before is new.
    const keys = m.findings.map(fkey), left = [...was?.findings ?? []];
    const take = same => { const i = left.findIndex(same); if (i >= 0) left.splice(i, 1); return i >= 0; };
    const unmatched = m.findings.filter((f, i) => !take(k => k === keys[i]));
    const fresh = unmatched.filter(f => !take(k => k.startsWith(f.type + '|')));
    const fixed = left.length;
    const worse = !update && was && m.score > was.score + TOLERANCE(was.score);
    if (update || !was) next[key] = { score: m.score, findings: keys };
    else if (!ci && (m.score < was.score - 1 || fixed) && !worse && !fresh.length) next[key] = { score: Math.min(was.score, m.score), findings: keys };
    // A page new to the baseline fails only on duplicate information; the rest is recorded on the next local run.
    return { key, r, m, was, fresh: update ? [] : was ? fresh : fresh.filter(f => f.type.startsWith('dup-')), worse, fixed };
  }).sort((a, b) => b.m.score - a.m.score);
  const failed = rows.filter(row => row.worse || row.fresh.length);
  const delta = row => !row.was ? 'new' : row.m.score === row.was.score ? '' : `${row.m.score > row.was.score ? '+' : ''}${row.m.score - row.was.score}`;
  const md = [
    `### Density: ${failed.length ? `❌ ${failed.length} page${failed.length === 1 ? '' : 's'} got denser` : `✅ no page got denser (${rows.length} measured)`}`,
    '',
    `Score = ${Object.entries(SCORE).map(([k, v]) => `${v}·${k}`).join(' + ')}; lower is easier to take in. Fails on a new finding or a score more than 5% (at least 3) over the baseline. Rules: app/scripts/density.mjs; fixing: app/scripts/copy-fix.md.`,
    '',
    '| Page | Device | Score | Δ | Words | Above fold | Long blocks | Paragraphs | Controls | Tips | Duplicates | Inert |',
    '| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |',
    ...rows.map(({ r, m, worse, fresh, ...row }) => `| ${worse || fresh.length ? '❌ ' : ''}${r.page}${m.scope === 'dialog' ? ' (dialog)' : ''} | ${r.device} | ${m.score} | ${delta({ ...row, m })} | ${m.words} | ${m.fold} | ${m.longBlocks || ''} | ${m.paragraphs || ''} | ${m.controls} | ${m.tips || ''} | ${m.duplicates || ''} | ${m.inert || ''} |`),
  ];
  if (failed.length) {
    md.push('', '#### Got denser', '');
    for (const row of failed) {
      md.push(`- **${row.key}**${row.worse ? `: score ${row.was.score} → ${row.m.score}` : ''}`);
      for (const f of row.fresh) md.push(`  - new ${f.type}: ${f.message}`);
    }
  }
  const dups = rows.flatMap(row => row.m.findings.filter(f => f.type.startsWith('dup-')).map(f => `- ${row.key}: **${f.type}** ${f.message}`));
  if (dups.length) md.push('', '#### Duplicate information', '', ...[...new Set(dups)]);
  if (errors.length) md.push('', '#### Not measured', '', ...errors.map(r => `- ${r.page} (${r.device}): ${r.error}`));
  const markdown = md.join('\n') + '\n';
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(rows.map(({ key, r, m, was, fresh, worse }) => ({ page: r.page, device: r.device, path: r.path, ...m, baseline: was?.score ?? null, fresh, worse })), null, 2));
  writeFileSync(join(OUT, 'summary.md'), markdown);
  if (!ci && (update || JSON.stringify(next) !== JSON.stringify(baseline))) writeBaseline(next);
  return { markdown, failed, rows, errors };
}

// ---------------------------------------------------------------- CLI
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), from = args.includes('--from') ? resolve(args[args.indexOf('--from') + 1]) : null;
  const raw = from ?? join(app, '.cls/density.json');
  if (!from) {
    const run = spawnSync(process.execPath, [join(app, 'scripts/cls.mjs')], { stdio: 'inherit', env: { ...process.env, CLS_DENSITY: 'only' } });
    if (run.status !== 0 && !existsSync(raw)) process.exit(run.status ?? 1);
  }
  const results = JSON.parse(readFileSync(raw, 'utf8'));
  const { markdown, failed, errors } = report(results, { update: args.includes('--update-baseline') });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  console.log('\n' + markdown);
  console.log(`Report and annotated screenshots: ${OUT}`);
  process.exit(failed.length && !args.includes('--update-baseline') || errors.length ? 1 : 0);
}
