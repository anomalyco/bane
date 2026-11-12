import { sql } from 'drizzle-orm';
import type { JobHandler } from '../core.js';

/**
 * billing.restored (queued by billing_post on every credit): releases receive holds in batches and wakes campaign runs
 * waiting on balance. Both are no-ops when nothing waits.
 */
export const restoreJob: JobHandler = async (runtime, _payload, job) => {
  const wid = job.workspaceId;
  for (let i = 0; i < 100; i++) {
    const { rows: [row] } = await runtime.db.execute<{ n: number }>(sql`SELECT billing_release_receive_holds(${wid}, 500) AS n`);
    if (!row || row.n < 500) break;
  }
  await runtime.db.execute(sql`UPDATE jobs SET available_at=now() WHERE workspace_id=${wid} AND type='campaign.run' AND status='pending'
    AND id IN (SELECT 'campaign.run:'||id FROM sending_campaigns WHERE workspace_id=${wid} AND waiting_reason='balance')`);
  await runtime.wake?.();
};
