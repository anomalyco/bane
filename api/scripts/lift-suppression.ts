import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { Client } from 'pg';
import { postgresConnection } from '../src/adapters/node.js';
import { log } from '../src/core.js';
import { mxResourceName } from '../src/ses-setup.js';

type Reason = 'BOUNCE' | 'COMPLAINT';
/**
 * Per SES region: the account the operator's credentials belong to, and the suppression entry for one exact address on
 * a tenant's list or, without a tenant, on the account-level list.
 */
export type SuppressionSes = (region: string) => {
  account(): Promise<string>;
  get(address: string, tenant?: string): Promise<Reason | null>;
  remove(address: string, tenant?: string): Promise<boolean>;
};
type Target = { region: string; account: string; tenant?: string };
/** Runs `work` in one database transaction on the script's client. */
export type Transaction = <T>(work: () => Promise<T>) => Promise<T>;
const inTransaction = (db: Client): Transaction => async work => {
  await db.query('BEGIN');
  try { const result = await work(); await db.query('COMMIT'); return result; }
  catch (error) { await db.query('ROLLBACK'); throw error; }
};
// A newer suppression (a complaint, or another bounce) seen while lifting: nothing more is removed and Bane keeps it.
class Superseded extends Error {}
// Bounds every SES call, and with it how long the contact row stays locked against feedback ingest.
const SES_CALL_MS = 5000;

// The reasons a mailbox can recover from (the same set an authenticated reply clears). A complaint is the recipient's
// own decision and is lifted only by their not-spam feedback.
const LIFTABLE = ['hard_bounce', 'soft_bounce', 'transient', 'email_validation'];

const awsSes: SuppressionSes = region => ({
  async account() {
    const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
    return (await new STSClient({ region }).send(new GetCallerIdentityCommand({}))).Account ?? '';
  },
  async get(address, tenant) {
    const { SESv2Client, GetSuppressedDestinationCommand } = await import('@aws-sdk/client-sesv2');
    try { return (await new SESv2Client({ region }).send(new GetSuppressedDestinationCommand({ EmailAddress: address, TenantName: tenant }), { abortSignal: AbortSignal.timeout(SES_CALL_MS) })).SuppressedDestination?.Reason ?? null; }
    catch (error) { if (error instanceof Error && error.name === 'NotFoundException') return null; throw error; }
  },
  async remove(address, tenant) {
    const { SESv2Client, DeleteSuppressedDestinationCommand } = await import('@aws-sdk/client-sesv2');
    try { await new SESv2Client({ region }).send(new DeleteSuppressedDestinationCommand({ EmailAddress: address, TenantName: tenant }), { abortSignal: AbortSignal.timeout(SES_CALL_MS) }); return true; }
    catch (error) { if (error instanceof Error && error.name === 'NotFoundException') return false; throw error; }
  },
});

const where = (t: Target) => t.tenant ? `tenant ${t.tenant} in ${t.region}` : `the account-level list of ${t.account} in ${t.region}`;

/**
 * Lets a workspace send to an address again after a bounce suppressed it, for example a sign-in address whose mailbox
 * now exists. SES keeps its own lists, which would drop the next send and suppress the address again:
 *
 * - The workspace's tenant list is its own; its bounce entries are removed.
 * - The account-level list is shared by every workspace sending from that account (the probation pool suppresses at
 *   account scope). A bounce entry there is removed only with --account-level; a complaint entry never is.
 *
 * Everything is read and every region's account checked before the first write. A `started` row in
 * hosted_operator_audit precedes the first SES change and a `lifted`, `failed` or `superseded` row records each change
 * made. The removals and the clear run under the contact's row lock, which feedback ingest needs to record a bounce or
 * complaint for the address: Bane's suppression is checked again under it, and each SES entry is read again just before
 * it is removed. A complaint, or a newer bounce, seen at any of those points stops the lift (`superseded`) and is kept.
 * SES has no conditional delete: a complaint SES records between that read and the delete reaches Bane as feedback once
 * the lock is released and suppresses the address again there, which is what dispatch checks.
 */
export async function liftSuppression(db: Client, args: string[], ses: SuppressionSes = awsSes, transaction: Transaction = inTransaction(db)) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { reason: { type: 'string' }, 'account-level': { type: 'boolean', default: false } } });
  const [wid, given] = positionals, reason = values.reason?.trim(), address = given?.trim() ?? '', accountLevel = values['account-level'];
  if (positionals.length !== 2 || !wid || !/^[^@\s]+@[^@\s]+$/.test(address) || !reason) throw new Error('Usage: lift-suppression.ts WORKSPACE_ID ADDRESS --reason "..." [--account-level]');
  const { rows: [contact] } = await db.query<{ id: string; suppression_reason: string | null; suppressed_at: string | null; version: string }>(
    'SELECT id, suppression_reason, suppressed_at::text, xmin::text AS version FROM audience_contacts WHERE workspace_id = $1 AND email = $2 AND suppressed', [wid, address.toLowerCase()]);
  if (!contact) throw new Error('This address is not suppressed in this workspace.');
  if (!LIFTABLE.includes(contact.suppression_reason ?? '')) throw new Error(`A ${contact.suppression_reason ?? 'manual'} suppression is not lifted by an operator; only bounces and validation drops are.`);
  const { rows: regions } = await db.query<{ region: string; account: string; tenant: string }>(`SELECT region, aws_account_id AS account,
      coalesce(pool_tenant_name, CASE WHEN managed_tenant THEN $2 ELSE 'bane-' || workspace_id END) AS tenant
    FROM regional_connections WHERE workspace_id = $1 AND kind = 'shared' ORDER BY region`, [wid, mxResourceName(wid)]);

  // Preflight: no SES or Bane change happens until every region has been checked.
  const variants = [...new Set([address, address.toLowerCase()])], clients = new Map(regions.map(r => [r.region, ses(r.region)]));
  for (const r of regions) {
    const account = await clients.get(r.region)!.account();
    if (account !== r.account) throw new Error(`These AWS credentials are for account ${account}, but ${r.region} sends from ${r.account}. Nothing was changed.`);
  }
  const plan: (Target & { address: string })[] = [], shared: string[] = [];
  for (const r of regions) for (const target of [{ region: r.region, account: r.account, tenant: r.tenant }, { region: r.region, account: r.account }] as Target[]) {
    for (const variant of variants) {
      const listed = await clients.get(r.region)!.get(variant, target.tenant);
      if (!listed) continue;
      if (listed === 'COMPLAINT') throw new Error(`SES lists this address for a complaint on ${where(target)}. Complaints are not lifted. Nothing was changed.`);
      if (!target.tenant && !accountLevel) shared.push(where(target));
      else plan.push({ ...target, address: variant });
    }
  }
  if (shared.length) throw new Error(`SES lists this address for a bounce on ${[...new Set(shared)].join(' and ')}. That list is shared by every workspace sending from the account; rerun with --account-level to remove the bounce entry for all of them. Nothing was changed.`);

  const liftId = randomUUID(), base = { liftId, contactId: contact.id, suppressionReason: contact.suppression_reason, reason, accountLevel };
  const audit = (details: Record<string, unknown>) => db.query(`INSERT INTO hosted_operator_audit(workspace_id, action, details) VALUES ($1, 'lift-suppression', $2::jsonb)`, [wid, JSON.stringify({ ...base, ...details })]);
  const entry = (t: Target) => ({ region: t.region, scope: t.tenant ? 'tenant' : 'account', ...(t.tenant ? { tenant: t.tenant } : { account: t.account }) });
  await audit({ status: 'started', plan: plan.map(entry) });
  const removed: ReturnType<typeof entry>[] = [], changed = (now?: { suppression_reason: string | null; suppressed_at: string | null; version?: string }) =>
    !now || (now.version !== undefined && now.version !== contact.version) || now.suppression_reason !== contact.suppression_reason || now.suppressed_at !== contact.suppressed_at;
  let current: Target | undefined;
  try {
    const finished = await transaction(async () => {
      // The row lock feedback ingest takes to suppress this address: no bounce or complaint lands in Bane until this ends.
      await db.query(`SELECT set_config('lock_timeout', '5s', true)`);
      const { rows: [now] } = await db.query<{ suppression_reason: string | null; suppressed_at: string | null; version: string }>(
        'SELECT suppression_reason, suppressed_at::text, xmin::text AS version FROM audience_contacts WHERE workspace_id = $1 AND id = $2 AND suppressed FOR UPDATE', [wid, contact.id]);
      if (changed(now)) throw new Superseded(now?.suppression_reason === 'complaint' ? 'A complaint was recorded in Bane for this address while it was being lifted.' : 'The address was suppressed again while it was being lifted.');
      for (const target of plan) {
        current = target;
        const client = clients.get(target.region)!, listed = await client.get(target.address, target.tenant);
        if (listed === 'COMPLAINT') throw new Superseded(`SES recorded a complaint for this address on ${where(target)} while it was being lifted.`);
        if (listed === 'BOUNCE' && await client.remove(target.address, target.tenant)) removed.push(entry(target));
      }
      current = undefined;
      const { rows: [row] } = await db.query<{ suppression_reason: string | null; suppressed_at: string | null }>(
        'SELECT suppression_reason, suppressed_at::text FROM audience_contacts WHERE workspace_id = $1 AND id = $2 AND suppressed', [wid, contact.id]);
      if (changed(row)) throw new Superseded(row?.suppression_reason === 'complaint' ? 'A complaint was recorded in Bane for this address while it was being lifted.' : 'The address was suppressed again while it was being lifted.');
      const { rows: [done] } = await db.query<{ details: Record<string, unknown> }>(`WITH lifted AS (
          UPDATE audience_contacts SET suppressed = false, suppression_reason = NULL, suppressed_at = NULL, updated_at = now()
          WHERE workspace_id = $1 AND id = $2 AND suppressed RETURNING id
        ) INSERT INTO hosted_operator_audit(workspace_id, action, details) SELECT $1, 'lift-suppression', $3::jsonb FROM lifted RETURNING details`,
        [wid, contact.id, JSON.stringify({ ...base, removed, status: 'lifted' })]);
      return done!.details;
    });
    log('info', { code: 'SUPPRESSION_LIFTED', workspaceId: wid, ...finished });
    return finished;
  } catch (error) {
    // The transaction rolled back; these rows record what SES already changed.
    if (error instanceof Superseded) {
      await audit({ status: 'superseded', removed, why: error.message });
      throw new Error(`${error.message} Bane keeps the suppression and nothing more was removed; ${removed.length} SES removal(s) are recorded under lift ${liftId}.`);
    }
    const name = error instanceof Error ? error.name : 'Error';
    await audit({ status: 'failed', removed, failed: { ...(current ? entry(current) : { step: 'bane' }), error: name } });
    throw new Error(`${current ? `Removing the SES entry on ${where(current)}` : 'Locking the contact'} failed (${name}); ${removed.length} earlier removal(s) are recorded under lift ${liftId}. Bane still suppresses the address; run the command again to finish.`, { cause: error });
  }
}

if (import.meta.main) {
  const db = new Client(postgresConnection(process.env.DATABASE_URL));
  await db.connect();
  try { await liftSuppression(db, process.argv.slice(2)); } finally { await db.end(); }
}
