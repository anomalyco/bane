import {getTableColumns,sql} from 'drizzle-orm';
import type {DbExecutor} from './core.js';
import {mailMessages,mailAttachments} from './db/mailbox.js';
import {ADDRESS} from './mailbox-store.js';
import {mailJson} from './mailbox-text.js';
import {platformValidationMailbox} from './domain-claims.js';

type Incoming=Omit<typeof mailMessages.$inferInsert,'threadId'> & {receivedAt:string;subject:string;envelopeTo:string[]};
/** One implicit transaction; the routine takes the write lane before the DML snapshot. */
export async function storeIncoming(db:DbExecutor,m:Incoming,files:(typeof mailAttachments.$inferInsert)[],verifiedFrom:boolean,allowCreate:boolean,replyAuthorVerified=false,plan?:import('./routing-match.js').RoutingResult|null,policy?:string,platformHost:string|null=null,preview?:{prefix:string;complete:boolean}){
  const columns=getTableColumns(mailMessages);
  const row=Object.fromEntries(Object.entries(m).filter(([,v])=>v!==undefined).map(([k,v])=>[columns[k as keyof typeof columns].name,v]));
  const refs=[...new Set([m.inReplyTo,...[...(m.references??[])].reverse(),m.messageId].filter((s):s is string=>!!s))].slice(0,101);
  // An existing inbox still receives; `valid` only gates automatic address creation for an unknown recipient.
  const recipients=m.envelopeTo.map((addr,n)=>({addr,n,valid:ADDRESS.test(addr) && !platformValidationMailbox(addr,platformHost)}));
  return (await db.execute<{queued_count:number;wait_ms:number;hold_ms:number}>(sql`SELECT * FROM mail_store_incoming(${mailJson({...row,reply_author_verified:replyAuthorVerified})}::jsonb,${mailJson(files)}::jsonb,${mailJson(refs)}::jsonb,${mailJson(recipients)}::jsonb,${verifiedFrom},${allowCreate},${plan?mailJson(plan):null}::jsonb,${policy??null}::jsonb,${preview?.prefix??null},${preview?.complete??false})`)).rows[0]!;
}
