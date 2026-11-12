// Operator-only (no API endpoint): refused sign-ins, newest first, so a person can be admitted by subject.
//
//   node --import tsx scripts/list-signin-attempts.ts [--hours 24] [--json]
//
// Env: DATABASE_URL; ACCOUNT_ISSUER (optional) limits the list to that issuer.
// Identity is (issuer, subject). The address and name come from the refused sign-in and are shown only to help the
// operator tell attempts apart: confirm with the person, out of band, which subject and time are theirs before
// using it (for example `scripts/cutover-fresh-start.ts --owner-sub <subject>`). An address never proves who it is.
import { parseArgs } from 'node:util';
import pg from 'pg';
import { postgresConnection } from '../src/adapters/node.js';

export type Attempt = { issuer: string; subject: string; acr: string | null; provider: string | null; provider_hd: string | null;
  email: string | null; name: string | null; outcome: string; attempts: number; first_at: string; last_at: string };

export async function listSigninAttempts(db: pg.Client, hours: number, issuer?: string) {
  const { rows } = await db.query<Attempt>(`SELECT issuer,subject,acr,provider,provider_hd,email,name,outcome,attempts,first_at::text,last_at::text
    FROM bane_signin_attempts WHERE last_at > now() - make_interval(hours => $1) AND ($2::text IS NULL OR issuer = $2) ORDER BY last_at DESC LIMIT 200`,
    [hours, issuer ?? null]);
  return rows;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { hours: { type: 'string', default: '24' }, json: { type: 'boolean' } } });
  const hours = Number(values.hours);
  if (!Number.isInteger(hours) || hours < 1 || hours > 24 * 30) throw new Error('--hours must be a whole number from 1 to 720.');
  const db = new pg.Client(postgresConnection(process.env.DATABASE_URL));
  await db.connect();
  try {
    const rows = await listSigninAttempts(db, hours, process.env.ACCOUNT_ISSUER || undefined);
    if (values.json) console.log(JSON.stringify(rows, null, 2));
    else if (!rows.length) console.log(`No refused sign-ins in the last ${hours} hour(s).`);
    else for (const r of rows) console.log([r.last_at.slice(0, 19), r.issuer, `sub=${r.subject}`, `acr=${r.acr ?? '-'}`,
      `provider=${r.provider ?? '-'}${r.provider_hd ? `/${r.provider_hd}` : ''}`, `outcome=${r.outcome}`, `x${r.attempts}`,
      `(shown, not verified: ${r.name ?? '-'} <${r.email ?? '-'}>)`].join('  '));
  } finally { await db.end(); }
}
