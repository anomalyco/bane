import {sql} from 'drizzle-orm';
import type {Runtime} from './core.js';

/** No AWS calls on probes. The minute reconciler authenticates and refreshes the binding. */
export async function health(runtime:Runtime) {
  const {multiTenant,liveEnabled,platformAccount}=runtime.config;
  const required=multiTenant && liveEnabled;
  const ready=!required || !!platformAccount && !!(await runtime.db.execute(sql`SELECT FROM provider_pool_regions WHERE region='us-east-2' AND aws_account_id=${platformAccount}
    AND legacy_names AND receiving_state='ready' AND inbound_bucket=${`bane-${platformAccount}-mail-us-east-2`} AND inbound_topic_arn=${`arn:aws:sns:us-east-2:${platformAccount}:bane-inbound`}
    AND receiving_checked_at>now()-interval '25 hours'`)).rowCount;
  return {status:ready?'ok':'unready',service:'bane',multiTenant,receiving:!required?'not_required':ready?'ready':'not_ready'};
}
