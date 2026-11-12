// Pre-merge invariants that broke dev only after merge. Fast and offline except the open-PR scan.
//   node --import tsx scripts/check-premerge.ts [--base <sha>]
// --base is the commit this change lands on (the PR's base tip, the merge group's base, or the previous dev tip).
// Locally it defaults to the merge-base with dev. Set GH_TOKEN, GITHUB_REPOSITORY and PR_NUMBER to also compare
// migration numbers with other open pull requests. docs/ci.md explains each failure and how to fix it.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { register } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import ts from 'typescript';

const api = new URL('../', import.meta.url), root = new URL('../', api);
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 }).trim();
const tryGit = (...args: string[]) => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
const argBase = process.argv.indexOf('--base');
const base = argBase > 0 ? git('rev-parse', '--verify', `${process.argv[argBase + 1]}^{commit}`)
  : ['origin/dev', 'bane/dev', 'dev'].map(ref => tryGit('merge-base', 'HEAD', ref)).find(Boolean) ?? null;
const atBase = (path: string) => base ? tryGit('show', `${base}:${path}`) : null;
let failed = 0;
// GitHub annotations: the message shows on the PR's Files tab and in the job summary.
function fail(check: string, message: string, file?: string, line?: number) {
  failed++;
  const where = file ? ` file=${file}${line ? `,line=${line}` : ''}` : '';
  console.log(`::error${where},title=${check}::${message.replaceAll('\n', '%0A')}`);
}
const warn = (check: string, message: string, file?: string) => console.log(`::warning${file ? ` file=${file}` : ''},title=${check}::${message}`);

// 1. Every OpenAPI operation is called or explicitly skipped in the live E2E (dev deploys broke twice on this).
// The live run enforces it again at the end; this catches it before merge. A string literal ('op'), an object
// key (op: 'reason') or SKIP.op in scripts/e2e.ts counts; comments do not.
{
  const spec = JSON.parse(readFileSync(new URL('openapi.json', api), 'utf8')) as { paths: Record<string, Record<string, { operationId?: string }>> };
  const operations = Object.values(spec.paths).flatMap(item => Object.values(item)).map(op => op.operationId).filter((id): id is string => !!id);
  const file = 'api/scripts/e2e.ts', source = ts.createSourceFile(file, readFileSync(new URL('scripts/e2e.ts', api), 'utf8'), ts.ScriptTarget.Latest, true);
  const named = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node)) named.add(node.text);
    if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) named.add(node.name.text);
    if (ts.isPropertyAccessExpression(node) && node.expression.getText(source) === 'SKIP') named.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  const missing = operations.filter(op => !named.has(op));
  for (const op of missing) fail('E2E coverage', `${op} is in openapi.json but neither called nor skipped in the live dev E2E, which fails the dev deploy after merge. Call it in a step with api('${op}', …), or add it to SKIP with the reason it cannot run against dev.`, file);
  console.log(`E2E coverage: ${operations.length - missing.length}/${operations.length} operations called or skipped in ${file}.`);
}

// 2. Cloudflare routing. Workers Assets answers any path outside run_worker_first itself (405 for POST, the SPA's
// index.html for GET), so a route missing there is unreachable on Cloudflare while the Node server still serves it.
// The Worker's own fetch also hands GET/HEAD outside its API prefixes to the assets binding.
{
  const before = failed, { createOpenApiApp } = await import('../src/app.js');
  const glob = (p: string) => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*') + '$');
  const routes = (await createOpenApiApp()).routes.filter(r => r.path !== '*' && r.path !== '/*');
  const paths = [...new Set(routes.map(r => r.path.replace(/:[^/]+/g, 'x').replaceAll('*', 'x')))];
  if (!paths.includes('/internal/v1/mail') || !paths.includes('/v1/emails')) fail('Worker routes', 'The route inventory from createOpenApiApp() is incomplete; this check needs updating.');
  const configs: Record<string, { assets: { run_worker_first: string[] } }> = {};
  for (const name of ['wrangler.dev.jsonc', 'wrangler.prod.jsonc']) {
    const parsed = ts.parseConfigFileTextToJson(name, readFileSync(new URL(name, api), 'utf8'));
    if (parsed.error) { fail('Worker routes', `api/${name} does not parse: ${ts.flattenDiagnosticMessageText(parsed.error.messageText, ' ')}`, `api/${name}`); continue; }
    const rules: string[] = (configs[name] = parsed.config).assets.run_worker_first;
    const first = (path: string) => rules.some(r => !r.startsWith('!') && glob(r).test(path)) && !rules.some(r => r.startsWith('!') && glob(r.slice(1)).test(path));
    for (const path of paths.filter(p => !first(p))) fail('Worker routes', `${path} is an API route but api/${name} assets.run_worker_first does not match it, so Cloudflare answers it from static assets (405 or the dashboard HTML). Add its prefix (for example "/${path.split('/')[1]}/*") to run_worker_first in both wrangler configs.`, `api/${name}`);
  }
  const [dev, prod] = [configs['wrangler.dev.jsonc'], configs['wrangler.prod.jsonc']];
  if (dev && prod && !isDeepStrictEqual(dev.assets, prod.assets)) fail('Worker routes', 'The assets block differs between api/wrangler.dev.jsonc and api/wrangler.prod.jsonc. dev is the only place production routing is tested before release: keep them identical.', 'api/wrangler.prod.jsonc');
  // The Worker module imports cloudflare:workers for its Durable Object; give Node an empty stand-in.
  register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s,c,n){return s==='cloudflare:workers'?{url:'data:text/javascript,export class DurableObject{}',shortCircuit:true}:n(s,c)}`));
  const worker = (await import('../src/worker.js')).default as { fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> };
  const env = { ASSETS: { fetch: async () => new Response('static asset', { headers: { 'x-premerge-asset': '1' } }) }, ADMISSION: { limit: async () => ({ success: false }) } };
  // An API path ends at admission (refused here, so nothing else loads); only the outcome matters, not its log line.
  const quiet = { log: console.log, warn: console.warn, info: console.info, error: console.error }, served: string[] = [];
  Object.assign(console, { log() {}, warn() {}, info() {}, error() {} });
  try {
    for (const path of paths) {
      const response = await worker.fetch(new Request(`https://premerge.invalid${path}`), env, { waitUntil() {}, passThroughOnException() {} });
      if (response.headers.get('x-premerge-asset')) served.push(path);
    }
  } finally { Object.assign(console, quiet); }
  for (const path of served) fail('Worker routes', `GET ${path} is an API route, but src/worker.ts hands it to the static assets binding. Add its prefix to the API path pattern in the Worker's fetch handler.`, 'api/src/worker.ts');
  if (failed === before) console.log(`Worker routes: ${paths.length} API paths reach the Worker in both wrangler configs and src/worker.ts.`);
}

// 3. Migrations. src/migrate.ts applies every /^\d+_[a-z_]+\.sql$/ file once, in name order, and refuses a changed one.
// A migration that sorts before one dev already applied runs in a different order on a fresh database than on dev,
// and two open PRs picking the same next number collide when the second one merges.
{
  const dir = 'api/migrations', applied = /^\d+_[a-z_]+\.sql$/, numbered = /^(\d{3})_[a-z_]+\.sql$/;
  // Pairs that shipped before this check, ordered by name everywhere since. Never add to this list.
  const grandfathered = new Set(['038', '093', '095', '098', '104', '105', '106', '120', '133', '140', '153', '154', '155', '158']);
  const head = readdirSync(new URL('migrations/', api)).filter(n => !n.startsWith('.')).sort();
  const number = (name: string) => numbered.exec(name)?.[1];
  for (const name of head) {
    if (!applied.test(name)) fail('Migrations', `${name} does not match ${applied} and src/migrate.ts would silently skip it. Name it NNN_lower_snake_case.sql (letters and underscores only after the number).`, `${dir}/${name}`);
    else if (!numbered.test(name)) fail('Migrations', `${name} must start with a three-digit number.`, `${dir}/${name}`);
  }
  const byNumber = new Map<string, string[]>();
  for (const name of head) { const n = number(name); if (n) byNumber.set(n, [...byNumber.get(n) ?? [], name]); }
  const baseList = base ? (tryGit('ls-tree', '--name-only', `${base}:${dir}`) ?? '').split('\n').filter(Boolean) : [];
  const baseMax = baseList.map(number).filter(Boolean).sort().at(-1) ?? '000';
  const added = head.filter(n => !baseList.includes(n));
  // A new file that reuses a dev number is reported below with the number to use instead.
  for (const [n, names] of byNumber) if (names.length > 1 && !grandfathered.has(n) && (n > baseMax || !names.some(name => added.includes(name)))) fail('Migrations', `Migration number ${n} is used by ${names.join(' and ')}. Renumber the newer one to the next free number.`, `${dir}/${names.find(name => added.includes(name)) ?? names.at(-1)}`);
  for (const name of baseList) {
    if (!head.includes(name)) fail('Migrations', `${name} is on the base branch and was deleted or renamed. Applied migrations are permanent: restore it and add a new migration.`, `${dir}/${name}`);
    else if (atBase(`${dir}/${name}`) !== readFileSync(new URL(`migrations/${name}`, api), 'utf8').trim()) fail('Migrations', `${name} is already on the base branch, and dev has applied it. Editing it fails every upgraded database with MIGRATION_CHANGED: revert the edit and add a new migration.`, `${dir}/${name}`);
  }
  let next = Number(baseMax) + 1;
  const claimed = new Map<string, number>();
  const token = process.env.GH_TOKEN, repo = process.env.GITHUB_REPOSITORY, pr = Number(process.env.PR_NUMBER);
  if (added.length && token && repo && pr) {
    // Other open PRs into dev that add a migration. An older PR keeps its number; this one renumbers.
    const get = async (path: string) => {
      const response = await fetch(`https://api.github.com/${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' } });
      if (!response.ok) throw new Error(`GitHub ${path}: HTTP ${response.status}`);
      return response.json() as Promise<{ number: number; filename: string; status: string }[]>;
    };
    const pulls: { number: number }[] = [];
    for (let page = 1; ; page++) { const rows = await get(`repos/${repo}/pulls?state=open&base=dev&per_page=100&page=${page}`); pulls.push(...rows); if (rows.length < 100) break; }
    await Promise.all(pulls.filter(p => p.number !== pr).map(async p => {
      for (let page = 1; page <= 30; page++) {
        const files = await get(`repos/${repo}/pulls/${p.number}/files?per_page=100&page=${page}`);
        for (const f of files) {
          const n = f.status === 'added' && f.filename.startsWith(`${dir}/`) ? number(f.filename.slice(dir.length + 1)) : undefined;
          if (n && (!claimed.has(n) || claimed.get(n)! > p.number)) claimed.set(n, p.number);
        }
        if (files.length < 100) break;
      }
    }));
    next = Math.max(next, ...[...claimed.keys()].map(n => Number(n) + 1));
  }
  const free = () => String(next++).padStart(3, '0');
  for (const name of added) {
    const n = number(name);
    if (!n) continue;
    const other = claimed.get(n);
    const taken = baseList.find(b => number(b) === n);
    if (n <= baseMax) fail('Migrations', `${name} ${taken ? `reuses number ${n} (${taken} on dev)` : `sorts before ${baseMax}, the newest migration on dev`}, so a fresh database applies it in a different order than dev did. Renumber it to ${free()}.`, `${dir}/${name}`);
    else if (other !== undefined && other < pr) fail('Migrations', `Open PR #${other} already adds migration ${n}. The older PR keeps the number: renumber ${name} to ${free()}.`, `${dir}/${name}`);
    else if (other !== undefined) warn('Migrations', `Newer open PR #${other} also adds migration ${n}; it will be asked to renumber.`, `${dir}/${name}`);
  }
  console.log(`Migrations: ${head.length} files, ${added.length} new on top of ${baseMax}${base ? ` (base ${base.slice(0, 12)})` : ' (no base: order not checked)'}.`);
}

// 4. Phone layout: below 640 px every DataTable renders cards from each column's `card` slot (AGENTS.md). A column
// defined without one falls back to a guessed slot. Existing columns are grandfathered; a new one must say where it goes.
{
  const columns = (file: string, text: string) => {
    const found: { key: string; line: number }[] = [];
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      if (ts.isObjectLiteralExpression(node) && !node.properties.some(ts.isSpreadAssignment)) {
        const props = new Map(node.properties.flatMap(p => p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? [[p.name.text, p] as const] : []));
        if (props.has('key') && props.has('label') && props.has('render') && !props.has('card')) {
          const key = props.get('key')!;
          found.push({ key: ts.isPropertyAssignment(key) ? key.initializer.getText(source) : 'key', line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  };
  const files = git('ls-files', '--', 'app/src/*.tsx', 'app/src/*.ts').split('\n').filter(Boolean);
  let total = 0, added = 0;
  for (const file of files) {
    const now = columns(file, readFileSync(new URL(file, root), 'utf8'));
    total += now.length;
    if (!now.length) continue;
    const before = new Set(columns(file, atBase(file) ?? '').map(c => c.key));
    for (const column of now.filter(c => !before.has(c.key))) added++, fail('Card slots', `Table column ${column.key} has no card slot. Below 640 px DataTable renders each row as a card: set card to 'title', 'aside', 'line', 'inline', 'field', 'end' or 'hide' (see Column in app/src/components/ui/primitives.tsx).`, file, column.line);
  }
  console.log(`Card slots: ${total - added} grandfathered columns without a card slot, ${added} new.`);
}

// 5. Flake quarantine: an acceptance test named with [flaky #N] is skipped by the required job and run by the nightly.
// It must name its tracking issue, and that issue must still be open (closing it means the flake was fixed).
{
  const file = 'api/api.acceptance.test.ts', text = readFileSync(new URL('api.acceptance.test.ts', api), 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const tagged: { name: string; issue?: number; line: number }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['test', 'it', 'describe'].includes(node.expression.text)) {
      const title = node.arguments[0];
      if (title && ts.isStringLiteralLike(title) && /flaky/i.test(title.text)) {
        tagged.push({ name: title.text, issue: Number(/\[flaky #(\d+)\]/.exec(title.text)?.[1]) || undefined, line: source.getLineAndCharacterOfPosition(title.getStart(source)).line + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const token = process.env.GH_TOKEN, repo = process.env.GITHUB_REPOSITORY;
  for (const test of tagged) {
    if (!test.issue) { fail('Quarantine', `"${test.name}" mentions flaky but has no [flaky #<issue>] tag. Quarantine a test with the exact tag and its open issue, or rename it.`, file, test.line); continue; }
    if (!token || !repo) continue;
    const response = await fetch(`https://api.github.com/repos/${repo}/issues/${test.issue}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' } });
    const issue = response.ok ? await response.json() as { state: string } : null;
    if (!issue) fail('Quarantine', `"${test.name}" is quarantined under #${test.issue}, which does not exist. Open an issue for the flake and use its number.`, file, test.line);
    else if (issue.state !== 'open') fail('Quarantine', `#${test.issue} is closed but "${test.name}" is still quarantined. Remove the [flaky #${test.issue}] tag so the test blocks again, or reopen the issue.`, file, test.line);
  }
  console.log(`Quarantine: ${tagged.length} acceptance test${tagged.length === 1 ? '' : 's'} quarantined${tagged.length ? ` (${tagged.map(t => `#${t.issue ?? '?'}`).join(', ')}); the nightly runs them` : ''}.`);
}

if (failed) {
  console.log(`\n${failed} pre-merge check${failed === 1 ? '' : 's'} failed. docs/ci.md explains each one and how to fix it.`);
  process.exitCode = 1;
}
