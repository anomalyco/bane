// Dev E2E fixture capacity, applied by every dev deploy before its live E2E (deploy.yml; docs/ci.md). The fixture
// workspace on dev.bane.mx sends all day (deploys, the scheduled E2E, agents' runs), and its one-time 500/day override
// ran out on Nov 12: campaigns held with hosted_daily_quota, three red deploys, every release blocked. This sets a
// finite operator override of 100,000 recipients per rolling 24 hours (90,000 for marketing with the default reserve);
// even a run every minute at the E2E's 25-admission ceiling (36,000 a day) stays under it. Minute limits, pending
// limits, reputation holds and provider quotas still apply, and the workspace is not exempted.
//
// One statement, so it is atomic on its own or inside a caller's transaction. It writes hosted_operator_audit only
// when it changes the row, never lowers a larger override, and leaves an exempted workspace alone (an override would
// cap it). It refuses any stage but dev and any workspace that is not exactly the E2E fixture.
//   STAGE=dev PUBLIC_URL=https://dev.bane.mx BANE_E2E_DOMAIN_ID=dom_... DATABASE_URL=... node --import tsx scripts/dev-e2e-fixture.ts
import type { Client } from 'pg';
import { log } from '../src/core.js';

export const DEV_E2E_SEND_CAP = 100_000;
const FIXTURE_DOMAINS = ['e2e.bane.mx', 'e2e-va.bane.mx'];
const reason = 'Dev E2E fixture capacity, applied by every dev deploy (scripts/dev-e2e-fixture.ts)';

export async function applyDevE2eFixture(db: Pick<Client, 'query'>, env: Record<string, string | undefined>) {
  if (env.STAGE !== 'dev' || env.PUBLIC_URL !== 'https://dev.bane.mx') throw new Error('The dev E2E fixture capacity applies only to dev (STAGE=dev, PUBLIC_URL=https://dev.bane.mx).');
  const domainId = env.BANE_E2E_DOMAIN_ID;
  if (!domainId || !/^dom_[0-9a-f]{32}$/.test(domainId)) throw new Error('BANE_E2E_DOMAIN_ID must name the fixture domain.');
  // The workspace the live E2E requires (prepare()): named E2E, owning the fixture domain, with a shared Hosted
  // connection and both fixture claims verified.
  const { rows } = await db.query<{ id: string; exempt: boolean; current: number | null; details: Record<string, unknown> | null }>(`
    WITH fixture AS (
      SELECT w.id, w.exempt_hosted_quotas, w.send_cap_override FROM workspaces w
      JOIN operation_domains d ON d.workspace_id = w.id AND d.id = $1 AND d.name = $2
      WHERE w.name = 'E2E'
        AND EXISTS (SELECT FROM provider_connections c WHERE c.workspace_id = w.id AND c.kind = 'shared')
        AND (SELECT count(*) FROM domain_claims c WHERE c.workspace_id = w.id AND c.name = ANY($3) AND c.sending_state = 'verified') = cardinality($3::text[])
      FOR UPDATE OF w
    ), changed AS (
      UPDATE workspaces w SET send_cap_override = $4 FROM fixture f
      WHERE w.id = f.id AND NOT f.exempt_hosted_quotas AND (f.send_cap_override IS NULL OR f.send_cap_override < $4)
      RETURNING w.id, f.send_cap_override AS old
    ), audit AS (
      INSERT INTO hosted_operator_audit (workspace_id, action, details)
      SELECT id, 'set-dev-e2e-send-cap', jsonb_build_object('old', old, 'new', $4::int, 'reason', $5::text) FROM changed
      RETURNING details
    )
    SELECT f.id, f.exempt_hosted_quotas AS exempt, f.send_cap_override AS current, (SELECT details FROM audit) AS details FROM fixture f`,
    [domainId, FIXTURE_DOMAINS[0], FIXTURE_DOMAINS, DEV_E2E_SEND_CAP, reason]);
  if (rows.length !== 1) throw new Error('No unique E2E fixture workspace owns the fixture domain with both fixture claims verified; nothing changed.');
  const [row] = rows;
  log('info', row!.details ? { code: 'DEV_E2E_FIXTURE_CAPACITY_SET', workspaceId: row!.id, ...row!.details } : { code: 'DEV_E2E_FIXTURE_CAPACITY_UNCHANGED', workspaceId: row!.id, exempt: row!.exempt, sendCapOverride: row!.current });
  return { workspaceId: row!.id, changed: !!row!.details };
}

if (import.meta.main) {
  const [{ Client }, { postgresConnection }] = await Promise.all([import('pg'), import('../src/adapters/node.js')]);
  const db = new Client(postgresConnection(process.env.DATABASE_URL));
  await db.connect();
  try { await applyDevE2eFixture(db, process.env); } finally { await db.end(); }
}
