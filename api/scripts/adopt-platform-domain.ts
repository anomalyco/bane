import { parseArgs } from 'node:util';
import { Client } from 'pg';
import { SESv2Client, CreateTenantResourceAssociationCommand, GetEmailIdentityCommand, ListResourceTenantsCommand, type GetEmailIdentityCommandOutput } from '@aws-sdk/client-sesv2';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { postgresConnection } from '../src/adapters/node.js';
import { requirePlatformAccount } from '../src/config.js';
import { id } from '../src/core.js';
import { adoptionFacts, adoptionFingerprint, matchesAdoption } from '../src/adopted-identity.js';
import { claimNameAllowed, platformHost } from '../src/domain-claims.js';
import { inboundHost } from '../src/mailbox-dns.js';
import { claimTenantName, paceSetupSes } from '../src/ses-setup.js';

const region = 'us-east-2';
const ses = (s: GetEmailIdentityCommandOutput) => ({ VerificationStatus: s.VerificationStatus, VerifiedForSendingStatus: s.VerifiedForSendingStatus, DkimAttributes: s.DkimAttributes, MailFromAttributes: s.MailFromAttributes });

// No API endpoint. The platform domain's SES identity (PUBLIC_URL's host) was created by hand before any claim, so it
// has no bane:domain-claim tag: Bane never creates, changes or deletes it, and the runtime IAM policy can't either.
// This operator tool attests it for the one workspace named by BANE_PLATFORM_DOMAIN_WORKSPACE, associates it with
// that workspace's Ohio tenant and records the adoption. Dry run by default; --apply writes. Rerun it after any
// deliberate change to the identity (DKIM, MAIL FROM, default set): the fingerprint pins what was attested.
export async function adoptPlatformDomain(db: Client, client: SESv2Client, wid: string, operator: string, apply: boolean, env: Record<string, string | undefined> = process.env) {
  if (env.MULTI_TENANT !== 'true' || !env.PUBLIC_URL) throw new Error('Run with the Hosted MULTI_TENANT=true and PUBLIC_URL configuration.');
  const account = requirePlatformAccount(env.BANE_PLATFORM_AWS_ACCOUNT ?? env.MX_PLATFORM_AWS_ACCOUNT);
  if (!/^ws_[0-9a-f]{32}$/.test(wid) || (env.BANE_PLATFORM_DOMAIN_WORKSPACE ?? env.MX_PLATFORM_DOMAIN_WORKSPACE) !== wid) throw new Error('BANE_PLATFORM_DOMAIN_WORKSPACE must name this exact workspace, as deployed.');
  if (!operator.startsWith(`arn:aws:sts::${account}:assumed-role/`)) throw new Error('Use a signed-in operator role in the platform account, never the runtime principal.');
  const name = platformHost(env.PUBLIC_URL), arn = `arn:aws:ses:${region}:${account}:identity/${name}`;
  if (!await claimNameAllowed(name, env.PUBLIC_URL, true)) throw new Error('PUBLIC_URL does not name a claimable platform domain.');
  const read = async () => {
    const s = await client.send(new GetEmailIdentityCommand({ EmailIdentity: name }));
    if (s.IdentityType !== 'DOMAIN' || s.DkimAttributes?.SigningAttributesOrigin !== 'AWS_SES' || new Set(s.DkimAttributes.Tokens).size !== 3) throw new Error('Expected an Easy DKIM domain identity.');
    if (s.Tags?.some(t => t.Key === 'bane:domain-claim')) throw new Error('A domain claim created this identity; it is not the operator’s platform identity.');
    return s;
  };
  const member = async () => {
    const page = await client.send(new ListResourceTenantsCommand({ ResourceArn: arn, PageSize: 2 }));
    if (!Array.isArray(page.ResourceTenants) || page.NextToken || page.ResourceTenants.length > 1 || page.ResourceTenants.some(t => t.ResourceArn !== arn)) throw new Error('Unexpected or ambiguous SES tenant membership.');
    return page.ResourceTenants[0]?.TenantName;
  };
  // Same settings -> connection -> namespace lock order as a claim reservation.
  const target = async () => {
    const c = (await db.query(`SELECT c.id,c.pool_tenant_name FROM ses_installation_settings s JOIN provider_connections c USING(workspace_id)
      WHERE s.workspace_id=$1 AND c.kind='shared' AND c.state='ready' AND c.tenant_state='ready' AND c.region=$2 AND c.aws_account_id=$3 AND c.paused_at IS NULL
      FOR NO KEY UPDATE OF s FOR SHARE OF c`, [wid, region, account])).rows[0];
    if (!c) throw new Error('Expected a ready, unpaused Hosted Ohio connection with its SES tenant in the platform account.');
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,84912))', [name.split('.').slice(-2).join('.')]);
    return { id: c.id as string, tenant: claimTenantName(c, wid) };
  };
  const identity = await read(), fingerprint = adoptionFingerprint(adoptionFacts(identity));
  if (!matchesAdoption(identity, fingerprint)) throw new Error('The identity is not verified for sending with Easy DKIM (and its MAIL FROM, if set).');
  const initial = await member(), plan = { workspace: wid, domain: name, identity: arn, fingerprint, dkimTokens: adoptionFacts(identity).dkimTokens, tenant: '', action: '',
    receiving: { name, type: 'MX', priority: 10, value: inboundHost(region) }, domainId: null as string | null };
  await db.query('BEGIN');
  try {
    const c = await target();
    plan.tenant = c.tenant; plan.action = initial ? 'verify existing association and adopt' : 'associate and adopt';
    if (initial && initial !== c.tenant) throw new Error(`The identity already belongs to SES tenant ${initial}.`);
    // Adopting proves ownership of the whole name, which would supersede another workspace's pending claim under it
    // (and delete its identity). Platform hosts belong to other installations and fixtures: never take them over.
    const others = (await db.query('SELECT workspace_id,name FROM domain_claims WHERE workspace_id<>$1 AND domain_names_overlap(name,$2) ORDER BY name', [wid, name])).rows;
    if (others.length) throw new Error(`Other workspaces hold claims under ${name}; review them first: ${others.map(o => `${o.name} (${o.workspace_id})`).join(', ')}.`);
    if (!apply) { await db.query('ROLLBACK'); return plan; }
    const reserved = (await db.query('SELECT token,id,error_code FROM reserve_placed_claim($1,$2,$3,$4)', [wid, name, region, id('dom')])).rows[0];
    if (!reserved?.token || !reserved.id || reserved.error_code) throw new Error(`Claim reservation refused: ${reserved?.error_code ?? 'overlapping claim'}.`);
    // Commit the intent before the first AWS write. A rerun keeps the claim's receiving facts and replaces the attestation.
    const prior = (await db.query(`SELECT identity->'adopted'->>'fingerprint' AS previous FROM domain_claims WHERE workspace_id=$1 AND name=$2 AND connection_id=$3 FOR UPDATE`, [wid, name, c.id])).rows[0];
    if (!prior) throw new Error('The claim is bound to another connection.');
    await db.query(`UPDATE domain_claims dc SET identity=coalesce(dc.identity,jsonb_build_object('proven',false,'mx',NULL,'note',NULL,'receivingChoice',dc.name))||$4::jsonb
      WHERE workspace_id=$1 AND name=$2 AND connection_id=$3`, [wid, name, c.id, { ses: ses(identity), adopted: { arn, fingerprint } }]);
    await db.query(`INSERT INTO hosted_operator_audit(workspace_id,action,details) VALUES($1,'platform-domain-intent',$2)`, [wid, { operator, domain: name, identity: arn, fingerprint, previous: prior.previous ?? null, tenant: c.tenant }]);
    await db.query('COMMIT');
  } catch (e) { await db.query('ROLLBACK'); throw e; }
  // The only AWS write: the platform identity joins the workspace's tenant, so its sends carry that TenantName.
  if (!initial) {
    try { await client.send(new CreateTenantResourceAssociationCommand({ TenantName: plan.tenant, ResourceArn: arn })); }
    catch (e) { if ((e as { name?: string }).name !== 'AlreadyExistsException') throw e; }
  }
  await db.query('BEGIN');
  try {
    const c = await target(), current = await read();
    if (!matchesAdoption(current, fingerprint)) throw new Error('The identity changed during adoption; run again.');
    if (await member() !== c.tenant) throw new Error('The tenant association is not visible yet; run again.');
    const claim = (await db.query(`UPDATE domain_claims dc SET sending_state='verified',lost_since=NULL,identity=dc.identity||$4::jsonb FROM domain_sending_bindings b
      WHERE dc.workspace_id=$1 AND dc.name=$2 AND dc.connection_id=$3 AND dc.identity->'adopted'->>'fingerprint'=$5 AND b.workspace_id=dc.workspace_id AND b.name=dc.name AND b.connection_id=dc.connection_id AND b.region=$6
      RETURNING dc.token::text,b.domain_id`, [wid, name, c.id, { ses: ses(current), proven: true }, fingerprint, region])).rows[0];
    if (!claim) throw new Error('The adopted claim changed; run again.');
    // Start the receiving checks now instead of at the next hourly sweep.
    await db.query(`INSERT INTO jobs(id,type,workspace_id,payload) VALUES('domain.verify:'||$2::text,'domain.verify',$1,jsonb_build_object('domainId',$3::text,'token',$2::text))
      ON CONFLICT(id) DO UPDATE SET status='pending',available_at=now(),attempts=0,lease_until=NULL,last_error=NULL,payload=excluded.payload WHERE jobs.status<>'running'`, [wid, claim.token, claim.domain_id]);
    await db.query(`INSERT INTO hosted_operator_audit(workspace_id,action,details) VALUES($1,'platform-domain-adopted',$2)`, [wid, { operator, domain: name, identity: arn, fingerprint, tenant: c.tenant, domainId: claim.domain_id }]);
    await db.query('COMMIT');
    return { ...plan, domainId: claim.domain_id as string };
  } catch (e) { await db.query('ROLLBACK'); throw e; }
}

if (import.meta.main) {
  const { positionals: [wid, ...rest], values: v } = parseArgs({ allowPositionals: true, options: { apply: { type: 'boolean' } } });
  if (!wid || rest.length) throw new Error('Usage: adopt-platform-domain.ts WORKSPACE_ID [--apply]');
  const cfg = { region, ignoreConfiguredEndpointUrls: true, maxAttempts: 1 }, sts = new STSClient(cfg), client = new SESv2Client(cfg); paceSetupSes(client);
  const db = new Client(postgresConnection(process.env.DATABASE_URL)); await db.connect();
  try {
    const op = await sts.send(new GetCallerIdentityCommand({}));
    if (!op.Arn) throw new Error('No signed-in operator.');
    console.log(JSON.stringify(await adoptPlatformDomain(db, client, wid, op.Arn, !!v.apply), null, 2));
  } finally { await db.end(); sts.destroy(); client.destroy(); }
}
