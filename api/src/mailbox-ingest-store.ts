import {getTableColumns,sql} from 'drizzle-orm';
import type {DbExecutor} from './core.js';
import {mailMessages,mailAttachments} from './db/mailbox.js';
import {ADDRESS} from './mailbox-store.js';
import {mailJson} from './mailbox-text.js';

type Incoming=Omit<typeof mailMessages.$inferInsert,'threadId'> & {receivedAt:string;subject:string;envelopeTo:string[]};
/** One implicit transaction; the routine takes the write lane before the DML snapshot. */
export async function storeIncoming(db:DbExecutor,m:Incoming,files:(typeof mailAttachments.$inferInsert)[],verifiedFrom:boolean,allowCreate:boolean){
  const columns=getTableColumns(mailMessages);
  const row=Object.fromEntries(Object.entries(m).filter(([,v])=>v!==undefined).map(([k,v])=>[columns[k as keyof typeof columns].name,v]));
  const refs=[...new Set([m.inReplyTo,...[...(m.references??[])].reverse(),m.messageId].filter((s):s is string=>!!s))].slice(0,101);
  const recipients=m.envelopeTo.map((addr,n)=>({addr,n,valid:ADDRESS.test(addr)}));
  return (await db.execute<{queued_count:number;wait_ms:number;hold_ms:number}>(sql`SELECT * FROM mail_store_incoming_v2(${mailJson(row)}::jsonb,${mailJson(files)}::jsonb,${mailJson(refs)}::jsonb,${mailJson(recipients)}::jsonb,${verifiedFrom},${allowCreate})`)).rows[0]!;
}
