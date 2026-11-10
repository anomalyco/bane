import {sql} from 'drizzle-orm';
import {nodeRuntime} from '../src/adapters/node.js';
import {requirePlatformAccount} from '../src/config.js';
import type {Runtime} from '../src/core.js';
import {caller,platformCredentials} from '../src/provider-credentials.js';
import {mailboxResources,preparePoolReceiving} from '../src/mailbox-setup.js';
import {POOL_INSTALLATION} from '../src/ses-setup.js';

export async function reconcileReadyPool(runtime:Runtime){
  const region='us-east-2',account=requirePlatformAccount(runtime.config.platformAccount);
  if(!runtime.config.multiTenant || !runtime.config.liveEnabled)throw Error('Expected a live Hosted installation.');
  const identity=await caller(region,platformCredentials(runtime));
  if(identity.Account!==account || !identity.Arn?.startsWith(`arn:aws:iam::${account}:user/`))throw Error('Unexpected platform identity.');
  const {bucket,topicName}=mailboxResources(POOL_INSTALLATION,region,account),arn=`arn:aws:sns:${region}:${account}:${topicName}`,lease=new Date(Date.now()+180000).toISOString();
  const binding=sql`region=${region} AND aws_account_id=${account} AND legacy_names AND receiving_state='ready' AND inbound_bucket=${bucket} AND inbound_topic_arn=${arn}`;
  if(!(await runtime.db.execute(sql`UPDATE provider_pool_regions SET lease_until=${lease} WHERE ${binding} AND coalesce(lease_until,'-infinity')<now()`)).rowCount)throw Error('Expected the ready, idle Ohio receiving binding.');
  try {
    await preparePoolReceiving({...runtime,config:{...runtime.config,awsAccountId:account,sesFeedbackUrl:undefined}},region,account,async(a,b,t)=>{
      if(a!==account || b!==bucket || t!==arn || !(await runtime.db.execute(sql`SELECT FROM provider_pool_regions WHERE ${binding} AND lease_until=${lease}`)).rowCount)throw Error('Receiving binding changed.');
    });
  } finally {await runtime.db.execute(sql`UPDATE provider_pool_regions SET lease_until=NULL WHERE ${binding} AND lease_until=${lease}`);}
}
if(import.meta.main){
  if(process.argv.slice(2).join(' ')!=='--apply')throw Error('Usage: reconcile-pool-receiving.ts --apply');
  const {runtime,close}=nodeRuntime(process.env);try{await reconcileReadyPool(runtime);console.log('Ready Ohio receiving resources reconciled.');}finally{await close();}
}
