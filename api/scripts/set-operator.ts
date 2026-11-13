import { drizzle } from 'drizzle-orm/node-postgres';
import { parseArgs } from 'node:util';
import { Client } from 'pg';
import { postgresConnection } from '../src/adapters/node.js';
import { log } from '../src/core.js';
import { setOperatorRole, type OperatorRole } from '../src/operator-identity.js';

// Grants or removes a Bane platform operator role (the /operator area and /v1/operator/*). Operators are Anomaly staff,
// never a workspace role: nobody can grant it from the dashboard. The person is named by issuer subject, never by
// address: read it from scripts/list-signin-attempts.ts after they signed in once, and confirm it with them.
//   ACCOUNT_ISSUER=https://account.anoma.ly node --import tsx scripts/set-operator.ts SUBJECT operator|operator:read|off --reason "why"
export async function setOperator(db: Client, args: string[], issuer = process.env.ACCOUNT_ISSUER) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { reason: { type: 'string' } } });
  const [subject, role] = positionals, reason = values.reason?.trim();
  if (positionals.length !== 2 || !subject || /\s/.test(subject) || subject.length > 255 || !['operator', 'operator:read', 'off'].includes(role!) || !reason || reason.length < 10)
    throw new Error('Usage: set-operator.ts SUBJECT operator|operator:read|off --reason "why (at least 10 characters)"');
  if (!issuer || !/^https:\/\/[^/]+$/.test(issuer)) throw new Error('Set ACCOUNT_ISSUER to the issuer the subject belongs to (https://account.anoma.ly in production).');
  const { rows: [row] } = await drizzle(db).execute<{ user_id: string | null; previous: OperatorRole | null }>(setOperatorRole(issuer, subject, role as OperatorRole | 'off', reason));
  if (!row?.user_id) throw new Error('No user with that subject has signed in at this issuer.');
  log('info', { code: 'OPERATOR_ROLE_CHANGED', userId: row.user_id, from: row.previous ?? null, to: role === 'off' ? null : role });
}

if (import.meta.main) {
  const db = new Client(postgresConnection(process.env.DATABASE_URL));
  await db.connect();
  try { await setOperator(db, process.argv.slice(2)); } finally { await db.end(); }
}
