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

// Cache data, never another request's I/O promise. Cold concurrent probes fail closed.
type Health=Awaited<ReturnType<typeof health>>;
let sample:{account:string|undefined;expires:number;value:Health}|undefined;
export async function cachedHealth(runtime:Runtime):Promise<Health> {
  const {platformAccount:account,multiTenant,liveEnabled}=runtime.config;
  if(!multiTenant || !liveEnabled)return health(runtime);
  if(sample && sample.account===account && sample.expires>Date.now())return sample.value;
  const pending:NonNullable<typeof sample>={account,expires:Date.now()+30_000,value:{status:'unready',service:'bane',multiTenant,receiving:'not_ready'}};
  sample=pending;
  try {pending.value=await health(runtime);} catch { /* Return 503 and bound retries on database failure. */ }
  return pending.value;
}
