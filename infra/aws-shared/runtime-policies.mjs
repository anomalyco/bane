// Offline renderer. The checked-in primary denies edits to *every* Virginia identity.
// Release only narrows that deny with the operator's independently attested adoption manifest.
// A dedicated account (no adopted identities, no self-hosted installation beside it) renders with
// `--fresh` instead: both account-sharing denies are dropped and nothing else changes.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const account = '438095551154';
export const names = ['opensend-mx', 'opensend-mx-ohio-v8', 'opensend-mx-trusted-v8'];
const selfHosted = 'opensend-042df6f752eaa1f62cb8-';
const feedbackPath = '/v1/events/ses';
export function render(manifest, target = {}) {
  const fresh = manifest === '--fresh', to = target.account ?? account, origin = target.origin ?? 'https://opensend.mx';
  if (fresh && (!target.account || !target.origin)) throw new Error('A fresh account needs its own account ID and origin');
  if (!/^\d{12}$/.test(to) || origin.length > 261 || !/^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(origin)) throw new Error('Expected a 12-digit account and an https origin');
  if (fresh && to === account) throw new Error(`${account} shares Virginia with self-hosted mail; render it with the adoption manifest`);
  const adopted = fresh ? [] : JSON.parse(readFileSync(manifest, 'utf8'));
  const prefix = `arn:aws:ses:us-east-1:${to}:identity/`;
  if (!fresh && (!Array.isArray(adopted) || adopted.length !== 12 || new Set(adopted).size !== 12 || adopted.some(a => {
    if (typeof a !== 'string' || !a.startsWith(prefix)) return true;
    const d = a.slice(prefix.length);
    return d.length > 253 || !d.includes('.') || !d.split('.').every(l => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l));
  }))) throw new Error('Expected 12 distinct exact Virginia domain identity ARNs in the adoption manifest');
  const files = ['runtime-policy', 'runtime-ohio-policy', 'runtime-trusted-policy'];
  return Object.fromEntries(names.map((name, i) => {
    const policy = JSON.parse(readFileSync(new URL(`./${files[i]}.json`, import.meta.url), 'utf8').replaceAll('YOUR_AWS_ACCOUNT_ID', to).replaceAll(`https://opensend.mx${feedbackPath}`, origin + feedbackPath));
    if (!i && fresh) {
      const kept = policy.Statement.filter(s => s.Sid !== 'ProtectAdoptedIdentities' && !JSON.stringify(s).includes(selfHosted));
      if (kept.length !== policy.Statement.length - 2) throw new Error('Expected exactly two account-sharing statements in the primary');
      policy.Statement = kept;
    } else if (!i) policy.Statement.find(s => s.Sid === 'ProtectAdoptedIdentities').Resource = adopted.toSorted();
    if (JSON.stringify(policy).length > 6144) throw new Error(`${name} exceeds 6,144 characters; split, never widen`);
    return [name, policy];
  }));
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [, , manifest, name, to, origin] = process.argv, fresh = manifest === '--fresh';
  if (!names.includes(name) || process.argv.length !== (fresh ? 6 : 4)) throw new Error(`Usage: node runtime-policies.mjs <adopted-arns.json> <${names.join('|')}>\n       node runtime-policies.mjs --fresh <name> <account> <https origin>`);
  console.log(JSON.stringify(render(manifest, fresh ? { account: to, origin } : {})[name]));
}
