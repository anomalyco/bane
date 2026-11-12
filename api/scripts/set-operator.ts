import { drizzle } from 'drizzle-orm/node-postgres';
import { parseArgs } from 'node:util';
import { Client } from 'pg';
import { postgresConnection } from '../src/adapters/node.js';
import { log } from '../src/core.js';
import { setOperatorRole, type OperatorRole } from '../src/operator-identity.js';

// Grants or removes a Bane platform operator role (the /operator area and /v1/operator/*). Operators are Anomaly staff,
// never a workspace role: nobody can grant it from the dashboard. The user must have signed in once.
//   node --import tsx scripts/set-operator.ts EMAIL operator|operator:read|off --reason "why"
export async function setOperator(db: Client, args: string[]) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { reason: { type: 'string' } } });
  const [email, role] = positionals, reason = values.reason?.trim();
  if (positionals.length !== 2 || !email?.includes('@') || !['operator', 'operator:read', 'off'].includes(role!) || !reason || reason.length < 10)
    throw new Error('Usage: set-operator.ts EMAIL operator|operator:read|off --reason "why (at least 10 characters)"');
  const { rows: [row] } = await drizzle(db).execute<{ user_id: string | null; previous: OperatorRole | null }>(setOperatorRole(email, role as OperatorRole | 'off', reason));
  if (!row?.user_id) throw new Error('No user with that email has signed in.');
  log('info', { code: 'OPERATOR_ROLE_CHANGED', userId: row.user_id, from: row.previous ?? null, to: role === 'off' ? null : role });
}

if (import.meta.main) {
  const db = new Client(postgresConnection(process.env.DATABASE_URL));
  await db.connect();
  try { await setOperator(db, process.argv.slice(2)); } finally { await db.end(); }
}
