import { listInboxMessages } from './sdk.gen.js';
import type { Client } from './client/index.js';
export class InboxWaitTimeout extends Error { override name='InboxWaitTimeout'; }
/** Oldest matching delivery first, including messages already delivered before the call. */
export async function waitForMessage(client:Client,id:string,options:{after?:string;from?:string;subjectContains?:string;timeoutMs?:number;signal?:AbortSignal;extract?:'codes'|'links'|'codes,links'}={}) {
  const {timeoutMs=120_000,signal,...filters}=options;
  const deadline=Date.now()+timeoutMs, timeout=AbortSignal.timeout(timeoutMs), bounded=signal?AbortSignal.any([timeout,signal]):timeout;
  let after=filters.after;
  try { while(Date.now()<deadline){
    const wait=Math.min(30,Math.ceil((deadline-Date.now())/1000));
    const {data}=await listInboxMessages({client,path:{id},query:{...filters,after,wait,limit:1},signal:bounded,throwOnError:true});
    if(data.data[0])return data.data[0];after=data.cursor;
  }}catch(e){if(signal?.aborted)throw signal.reason;if(!timeout.aborted)throw e;}
  throw new InboxWaitTimeout('No matching message before the deadline.');
}
