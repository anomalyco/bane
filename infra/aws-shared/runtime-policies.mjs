// Offline renderer for dedicated Bane accounts. Substitute only the account and SNS origin.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const names = ['bane-runtime', 'bane-runtime-ohio', 'bane-runtime-trusted'];
export function render(mode, { account, origin } = {}) {
  if (mode !== '--fresh' || !/^\d{12}$/.test(account) || typeof origin !== 'string' || origin.length > 261 || !/^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(origin)) throw new Error('Expected --fresh, a 12-digit account and an https origin');
  if (account === '438095551154') throw new Error('The retired shared account is not a dedicated Bane account');
  const files = ['runtime-policy', 'runtime-ohio-policy', 'runtime-trusted-policy'];
  return Object.fromEntries(names.map((name, i) => {
    const policy = JSON.parse(readFileSync(new URL(`./${files[i]}.json`, import.meta.url), 'utf8').replaceAll('YOUR_AWS_ACCOUNT_ID', account).replaceAll('https://bane.mx/v1/events/ses', origin + '/v1/events/ses'));
    if (JSON.stringify(policy).length > 6144) throw new Error(`${name} exceeds 6,144 characters; split, never widen`);
    return [name, policy];
  }));
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [, , mode, name, account, origin] = process.argv;
  if (process.argv.length !== 6 || mode !== '--fresh' || !names.includes(name)) throw new Error(`Usage: node runtime-policies.mjs --fresh <${names.join('|')}> <account> <https origin>`);
  console.log(JSON.stringify(render(mode, { account, origin })[name]));
}
