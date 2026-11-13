import { sql } from 'drizzle-orm';
import type { JobHandler } from '../core.js';

/**
 * billing.restored (queued by billing_post on every credit): releases receive holds in batches and wakes campaign runs
 * waiting on balance. Both are no-ops when nothing waits.
 */
export const restoreJob: JobHandler = async (runtime, _payload, job) => {
  const wid = job.workspaceId;
  // A credit that leaves the workspace unpaid for 7 days or more (still in debt) keeps the hold: nothing to release.
  const { rows: [p] } = await runtime.db.execute<{ held: boolean }>(sql`SELECT coalesce((billing_position(${wid})->>'receiveHeld')::boolean,false) AS held`);
  for (let i = 0; i < 100 && !p?.held; i++) {
    const { rows: [row] } = await runtime.db.execute<{ n: number }>(sql`SELECT billing_release_receive_holds(${wid}, 500) AS n`);
    if (!row || row.n < 500) break;
  }
  await runtime.db.execute(sql`UPDATE jobs SET available_at=now() WHERE workspace_id=${wid} AND type='campaign.run' AND status='pending'
    AND id IN (SELECT 'campaign.run:'||id FROM sending_campaigns WHERE workspace_id=${wid} AND waiting_reason='balance')`);
  await runtime.wake?.();
};
