// Nightly flake report (docs/ci.md). Reads each acceptance run's JUnit files and outcome.json and each CLS run's report.json, writes the job summary and keeps
// one GitHub issue current. Usage: node flake-report.mjs <artifacts dir>. Needs GH_TOKEN, GITHUB_REPOSITORY, RUN_URL.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
const decode = s => s.replace(/&(lt|gt|quot|apos|amp|#(\d+)|#x([0-9a-f]+));/gi, (_, name, dec, hex) =>
  dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[name]);
const files = dir => readdirSync(dir).flatMap(name => statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : [join(dir, name)]);

const dirs = readdirSync(root).filter(name => statSync(join(root, name)).isDirectory()).sort();
const runs = dirs.filter(name => !name.startsWith('nightly-cls-')), clsRuns = dirs.filter(name => name.startsWith('nightly-cls-'));
const tests = new Map(); // name -> { passed, failed, errors: string[] }
const suiteFailures = [];
for (const run of runs) {
  let outcome = { outcome: 'unknown', deadlocks: 0 };
  try { outcome = JSON.parse(readFileSync(join(root, run, 'outcome.json'), 'utf8')); } catch {}
  let failedHere = 0;
  for (const file of files(join(root, run)).filter(f => f.endsWith('.xml'))) {
    // Node's JUnit reporter: one <testcase> per test, a nested <failure> when it failed, <skipped> when skipped.
    for (const match of readFileSync(file, 'utf8').matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
      const name = decode(/\bname="([^"]*)"/.exec(match[1])?.[1] ?? '?'), body = match[3] ?? '';
      if (/<skipped\b/.test(body)) continue;
      const row = tests.get(name) ?? { passed: 0, failed: 0, errors: [] };
      if (/<failure\b/.test(body)) {
        row.failed++; failedHere++;
        // Node escapes the assertion message twice inside the attribute.
        const message = decode(decode(/<failure\b[^>]*\bmessage="([^"]*)"/.exec(body)?.[1] ?? /<failure\b[^>]*>([\s\S]*?)<\/failure>/.exec(body)?.[1] ?? ''));
        row.errors.push(message.split('\n').find(line => line.trim())?.trim().slice(0, 200) ?? '');
      } else row.passed++;
      tests.set(name, row);
    }
  }
  const label = outcome.run ?? run;
  if (outcome.deadlocks > 0) suiteFailures.push(`run ${label}: Postgres detected ${outcome.deadlocks} deadlock(s)`);
  else if (outcome.outcome !== 'success' && failedHere === 0) suiteFailures.push(`run ${label}: ${outcome.outcome} with no failing test (setup, timeout or a crashed shard: see the run log)`);
}

// CLS gate runs: a measurement fails when the page errors or its CLS is above the gate's 0.001 limit.
const shifts = new Map(); // "page (device scheme mode)" -> { failed, total, worst, error }
for (const run of clsRuns) {
  let results = [];
  try { results = JSON.parse(readFileSync(join(root, run, 'report.json'), 'utf8')); } catch {
    let outcome = {}; try { outcome = JSON.parse(readFileSync(join(root, run, 'outcome.json'), 'utf8')); } catch {}
    suiteFailures.push(`CLS run ${outcome.run ?? run}: no report (${outcome.outcome ?? 'unknown'}: the build or fixture failed, see the run log)`);
    continue;
  }
  for (const r of results) {
    const key = `${r.page} (${r.device} ${r.scheme} ${r.mode})`, row = shifts.get(key) ?? { failed: 0, total: 0, worst: 0, error: '' };
    row.total++;
    if (r.error || r.cls > 0.001) { row.failed++; row.worst = Math.max(row.worst, r.cls ?? 0); row.error ||= r.error ?? ''; }
    shifts.set(key, row);
  }
}
const shifting = [...shifts].filter(([, r]) => r.failed > 0).sort((a, b) => b[1].failed - a[1].failed);

const flaky = /\[flaky #(\d+)\]/;
const failing = [...tests].filter(([, r]) => r.failed > 0).sort((a, b) => b[1].failed - a[1].failed);
const stable = [...tests].filter(([name, r]) => flaky.test(name) && r.failed === 0 && r.passed === runs.length);
const cell = s => s.replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
const date = new Date().toISOString().slice(0, 10);
const lines = [
  `## Nightly ${date}: ${runs.length} acceptance runs (${tests.size} tests), ${clsRuns.length} CLS runs (${shifts.size} measurements)`, '',
  failing.length || shifting.length || suiteFailures.length ? `${failing.length} test(s) and ${shifting.length} CLS measurement(s) failed at least once. [Run](${process.env.RUN_URL})` : `Everything passed in every run. [Run](${process.env.RUN_URL})`, '',
  ...(failing.length ? ['| Test | Failed | First error |', '| --- | ---: | --- |', ...failing.map(([name, r]) => `| ${cell(name)} | ${r.failed}/${r.failed + r.passed} | ${cell(r.errors[0] ?? '')} |`), ''] : []),
  ...(shifting.length ? ['| CLS measurement | Failed | Worst CLS or error |', '| --- | ---: | --- |', ...shifting.map(([name, r]) => `| ${cell(name)} | ${r.failed}/${r.total} | ${cell(r.error || r.worst.toFixed(4))} |`), ''] : []),
  ...(suiteFailures.length ? ['Run-level failures:', '', ...suiteFailures.map(s => `- ${s}`), ''] : []),
  ...(stable.length ? ['Quarantined tests that passed every run (remove the tag and close the issue):', '', ...stable.map(([name]) => `- ${cell(name)}`), ''] : []),
  'Fix a flaky test, or quarantine it while you do: add `[flaky #<issue>]` to its name. A CLS measurement that fails only sometimes has a timing-dependent shift: see docs/ci.md.',
];
const body = lines.join('\n');
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, body + '\n');
console.log(body);

// One issue, labeled nightly-flakes: updated on a failing night, closed on a clean one.
const repo = process.env.GITHUB_REPOSITORY;
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
if (repo && process.env.GH_TOKEN) {
  const label = 'nightly-flakes', title = 'Nightly acceptance flakes';
  gh('label', 'create', label, '-R', repo, '--color', 'D93F0B', '--description', 'Tests that failed in the nightly acceptance runs', '--force');
  const open = gh('issue', 'list', '-R', repo, '--label', label, '--state', 'open', '--json', 'number', '--jq', '.[0].number // empty');
  const dirty = failing.length > 0 || shifting.length > 0 || suiteFailures.length > 0 || stable.length > 0;
  if (dirty && open) {
    gh('issue', 'edit', open, '-R', repo, '--body', body);
    gh('issue', 'comment', open, '-R', repo, '--body', `${date}: ${failing.length} failing test(s), ${shifting.length} failing CLS measurement(s), ${suiteFailures.length} run-level failure(s). ${process.env.RUN_URL}`);
  } else if (dirty) gh('issue', 'create', '-R', repo, '--title', title, '--label', label, '--body', body);
  else if (open) gh('issue', 'close', open, '-R', repo, '--comment', `${date}: everything passed in all ${runs.length} acceptance and ${clsRuns.length} CLS runs. ${process.env.RUN_URL}`);
}
