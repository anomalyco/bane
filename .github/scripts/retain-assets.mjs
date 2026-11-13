// Run once on a clean Vite dist, under the deploy workflow's stage lock. The manifest and
// all files it names ship atomically in the Worker version; failed builds never advance it.
import assert from 'node:assert/strict';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const origin = process.argv[2];
assert(['https://dev.bane.mx', 'https://bane.mx'].includes(origin));
const dist = 'app/dist', assets = join(dist, 'assets'), manifest = 'asset-history.json';
const hashed = /^[\w.~\-]+-[\w-]{8}\.[a-zA-Z0-9]+$/;
const maxSize = 25 * 1024 * 1024, maxFiles = 20_000;
const current = (await readdir(assets)).filter(name => hashed.test(name)).sort();
assert(current.length > 0);
const local = new Set(current);

async function get(path) {
  const response = await fetch(origin + path, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30_000) });
  assert.equal(response.status, 200, `${path} returned ${response.status}`);
  return response;
}

async function materialize(name) {
  assert(typeof name === 'string' && hashed.test(name), 'Invalid asset name in history');
  if (local.has(name)) return;
  const response = await get('/assets/' + name);
  assert(!response.headers.get('content-type')?.includes('text/html'), `Dashboard shell returned for ${name}`);
  const body = Buffer.from(await response.arrayBuffer());
  assert(body.length && body.length <= maxSize, `Invalid size for ${name}`);
  await writeFile(join(assets, name), body, { flag: 'wx' });
  local.add(name);
}

// Pre-manifest versions serve index.html at the manifest URL. Follow their actual Vite
// import/preload graph, including dynamic imports nested inside other lazy chunks.
async function legacyBuild(html) {
  const refs = text => Array.from(text.matchAll(/["'`](?:\/?assets\/|\.\/)([\w.~\-]+-[\w-]{8}\.(?:js|css))["'`]/g), m => m[1]);
  const names = new Set(refs(html));
  assert([...names].some(name => /^index-.*\.js$/.test(name)), 'Expected live Bane dashboard');
  for (const name of names) {
    assert(names.size <= maxFiles);
    await materialize(name);
    if (name.endsWith('.js')) for (const dep of refs(await readFile(join(assets, name), 'utf8'))) names.add(dep);
  }
  return [...names].sort();
}

const live = await get('/' + manifest);
const history = live.headers.get('content-type')?.includes('text/html')
  ? [await legacyBuild(await live.text())] : await live.json();
assert(Array.isArray(history) && history.length >= 1 && history.length <= 4);
const previous = history.slice(0, 3);
assert(previous.every(build => Array.isArray(build) && build.length > 0 && build.length <= maxFiles));
const missing = [...new Set(previous.flat())].filter(name => !local.has(name));
for (let i = 0; i < missing.length; i += 8) await Promise.all(missing.slice(i, i + 8).map(materialize));
await writeFile(join(dist, manifest), JSON.stringify([current, ...previous]), { flag: 'wx' });

const files = (await readdir(dist, { recursive: true, withFileTypes: true })).filter(f => f.isFile());
assert(files.length <= maxFiles, `Workers asset file limit exceeded: ${files.length}`);
for (const f of files) assert((await stat(join(f.parentPath, f.name))).size <= maxSize, `${f.name} exceeds 25 MiB`);
console.log(`Dashboard assets: ${current.length} current; ${local.size - current.length} additional files from ${previous.length} prior build(s).`);
