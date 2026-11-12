import { parseArgs } from 'node:util';
import { Client } from 'pg';
import { postgresConnection } from '../src/adapters/node.js';
import { log } from '../src/core.js';
import { mxResourceName } from '../src/ses-setup.js';

/** Per SES region: the account the operator's credentials belong to, and removing one exact address from one tenant's list. */
export type SuppressionSes = (region: string) => { account(): Promise<string>; remove(address: string, tenant: string): Promise<boolean> };

// The reasons a mailbox can recover from (the same set an authenticated reply clears). A complaint is the recipient's
// own decision and is lifted only by their not-spam feedback.
const LIFTABLE = ['hard_bounce', 'soft_bounce', 'transient', 'email_validation'];

const awsSes: SuppressionSes = region => ({
  async account() {
    const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
    return (await new STSClient({ region }).send(new GetCallerIdentityCommand({}))).Account ?? '';
  },
  async remove(address, tenant) {
    const { SESv2Client, DeleteSuppressedDestinationCommand } = await import('@aws-sdk/client-sesv2');
    try { await new SESv2Client({ region }).send(new DeleteSuppressedDestinationCommand({ EmailAddress: address, TenantName: tenant })); return true; }
    catch (error) { if (error instanceof Error && error.name === 'NotFoundException') return false; throw error; }
  },
});

/**
 * Lets a workspace send to an address again after a bounce suppressed it, for example a sign-in address whose mailbox
 * now exists. Hosted tenants keep their own SES suppression list, which drops the next send and suppresses the address
 * again, so the SES entries are removed first; Bane changes nothing unless every Hosted region succeeded.
 */
export async function liftSuppression(db: Client, args: string[], ses: SuppressionSes = awsSes) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { reason: { type: 'string' } } });
  const [wid, given] = positionals, reason = values.reason?.trim(), address = given?.trim() ?? '';
  if (positionals.length !== 2 || !wid || !/^[^@\s]+@[^@\s]+$/.test(address) || !reason) throw new Error('Usage: lift-suppression.ts WORKSPACE_ID ADDRESS --reason "..."');
  const { rows: [contact] } = await db.query<{ id: string; suppression_reason: string | null }>(
    'SELECT id, suppression_reason FROM audience_contacts WHERE workspace_id = $1 AND email = $2 AND suppressed', [wid, address.toLowerCase()]);
  if (!contact) throw new Error('This address is not suppressed in this workspace.');
  if (!LIFTABLE.includes(contact.suppression_reason ?? '')) throw new Error(`A ${contact.suppression_reason ?? 'manual'} suppression is not lifted by an operator; only bounces and validation drops are.`);
  const { rows: tenants } = await db.query<{ region: string; aws_account_id: string; tenant: string }>(`SELECT region, aws_account_id,
      coalesce(pool_tenant_name, CASE WHEN managed_tenant THEN $2 ELSE 'bane-' || workspace_id END) AS tenant
    FROM regional_connections WHERE workspace_id = $1 AND kind = 'shared' ORDER BY region`, [wid, mxResourceName(wid)]);
  const removed: { region: string; tenant: string }[] = [];
  for (const target of tenants) {
    const client = ses(target.region), account = await client.account();
    if (account !== target.aws_account_id) throw new Error(`These AWS credentials are for account ${account}, but ${target.region} sends from ${target.aws_account_id}. Nothing was changed.`);
    // SES stores the address with the case it was sent with; Bane stores it lowercased.
    for (const variant of new Set([address, address.toLowerCase()])) if (await client.remove(variant, target.tenant)) removed.push({ region: target.region, tenant: target.tenant });
  }
  const { rows: [audit] } = await db.query<{ details: Record<string, unknown> }>(`WITH lifted AS (
      UPDATE audience_contacts SET suppressed = false, suppression_reason = NULL, suppressed_at = NULL, updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND suppressed AND suppression_reason IS NOT DISTINCT FROM $3 RETURNING id
    ) INSERT INTO hosted_operator_audit(workspace_id, action, details)
      SELECT $1, 'lift-suppression', jsonb_build_object('contactId', id, 'suppressionReason', $3::text, 'reason', $4::text, 'sesRemoved', $5::jsonb) FROM lifted
    RETURNING details`, [wid, contact.id, contact.suppression_reason, reason, JSON.stringify(removed)]);
  if (!audit) throw new Error('The suppression changed while it was being lifted. Run the command again.');
  log('info', { code: 'SUPPRESSION_LIFTED', workspaceId: wid, ...audit.details });
  return audit.details;
}

if (import.meta.main) {
  const db = new Client(postgresConnection(process.env.DATABASE_URL));
  await db.connect();
  try { await liftSuppression(db, process.argv.slice(2)); } finally { await db.end(); }
}
