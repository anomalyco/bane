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
    try { return (await new SESv2Client({ region }).send(new GetSuppressedDestinationCommand({ EmailAddress: address, TenantName: tenant }))).SuppressedDestination?.Reason ?? null; }
    catch (error) { if (error instanceof Error && error.name === 'NotFoundException') return null; throw error; }
  },
  async remove(address, tenant) {
    const { SESv2Client, DeleteSuppressedDestinationCommand } = await import('@aws-sdk/client-sesv2');
    try { await new SESv2Client({ region }).send(new DeleteSuppressedDestinationCommand({ EmailAddress: address, TenantName: tenant })); return true; }
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
 * made. Bane is cleared only if its suppression is still the one that was read: a bounce that arrives meanwhile stays.
 */
export async function liftSuppression(db: Client, args: string[], ses: SuppressionSes = awsSes) {
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
  const removed: ReturnType<typeof entry>[] = [];
  for (const target of plan) {
    try { if (await clients.get(target.region)!.remove(target.address, target.tenant)) removed.push(entry(target)); }
    catch (error) {
      await audit({ status: 'failed', removed, failed: { ...entry(target), error: error instanceof Error ? error.name : 'Error' } });
      throw new Error(`Removing the SES entry on ${where(target)} failed (${error instanceof Error ? error.name : 'error'}); ${removed.length} earlier removal(s) are recorded under lift ${liftId}. Bane still suppresses the address; run the command again to finish.`, { cause: error });
    }
  }
  // Clear only the suppression that was read: the row version changes with any other transaction's write, and a new
  // bounce always moves suppressed_at forward (mergeSuppression), even within one transaction.
  const { rows: [finished] } = await db.query<{ details: Record<string, unknown> }>(`WITH lifted AS (
      UPDATE audience_contacts SET suppressed = false, suppression_reason = NULL, suppressed_at = NULL, updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND suppressed AND xmin::text = $3 AND suppression_reason IS NOT DISTINCT FROM $5
        AND suppressed_at::text IS NOT DISTINCT FROM $6 RETURNING id
    ) INSERT INTO hosted_operator_audit(workspace_id, action, details)
      SELECT $1, 'lift-suppression', $4::jsonb || jsonb_build_object('status', CASE WHEN EXISTS (SELECT FROM lifted) THEN 'lifted' ELSE 'superseded' END)
    RETURNING details`, [wid, contact.id, contact.version, JSON.stringify({ ...base, removed }), contact.suppression_reason, contact.suppressed_at]);
  if (finished!.details.status !== 'lifted') throw new Error(`The address was suppressed again while it was being lifted; Bane keeps the new suppression. ${removed.length} SES removal(s) are recorded under lift ${liftId}.`);
  log('info', { code: 'SUPPRESSION_LIFTED', workspaceId: wid, ...finished!.details });
  return finished!.details;
}

if (import.meta.main) {
  const db = new Client(postgresConnection(process.env.DATABASE_URL));
  await db.connect();
  try { await liftSuppression(db, process.argv.slice(2)); } finally { await db.end(); }
}
