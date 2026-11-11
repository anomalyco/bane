import {createRoute,z} from '@hono/zod-openapi';
import {sql} from 'drizzle-orm';
import {ApiError,errors,json,response,security,type App,type Ctx,type MailboxAccess} from './core.js';
import type {MailboxPermission} from './db/mailbox.js';

const Special=z.enum(['inbox','sent','drafts','junk','archive','trash']);
export const Role=z.union([Special,z.string().regex(/^fld_[0-9a-f]{32}$/)]).describe('Stable folder locator: a built-in role or a custom folder ID.');
const key=z.string().min(1).max(120), uid=z.number().int().min(1).max(4294967295);
const seq=z.string().regex(/^(?:0|[1-9]\d{0,17})$/);
export const Location=z.object({folder:Role,uid,uidValidity:uid,modseq:z.string(),deleted:z.boolean()});
export const flagNames=['flagged','answered','draft','forwarded','junk','notJunk','mdnSent'] as const;
export const flagsOf=(bits:number)=>flagNames.filter((_,i)=>(bits&(1<<i))!==0);
export const inboxVisible=(v:MailboxAccess)=>sql`b.workspace_id=${v.workspaceId} AND b.kind='inbox' AND (b.delete_after IS NULL OR b.delete_after>statement_timestamp()) ${v.mailboxIds?sql`AND b.id=ANY(${sql.param(v.mailboxIds)}::text[])`:sql``}`;
export const locations=sql`coalesce((SELECT jsonb_agg(jsonb_build_object('folder',e.role,'uid',e.uid,'uidValidity',f.uid_validity,'modseq',e.modseq::text,'deleted',e.deleted) ORDER BY e.role,e.uid) FROM inbox_entries e JOIN inbox_folders f USING(inbox_id,role) WHERE e.inbox_id=l.mailbox_id AND e.message_id=l.message_id),'[]'::jsonb)`;
const guard=z.object({source:Role.optional(),uid:uid.optional(),ifModseq:seq.optional()});
const transfer=guard.extend({folder:Role}).strict();
const labels=z.array(z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/).refine(k=>!['unverified','spam','guard-allowed'].includes(k),'Reserved delivery label')).max(20).optional();
const patch=guard.extend({read:z.boolean().optional(),deleted:z.boolean().optional(),addLabels:labels,removeLabels:labels,...Object.fromEntries(flagNames.map(k=>[k,z.boolean().optional()]))}).strict().refine(p=>Object.keys(p).some(k=>!['source','uid','ifModseq'].includes(k)),'Supply at least one flag or label change.');
const result=z.object({id:key,read:z.boolean(),modseq:z.string(),uid:uid.nullable(),removed:z.boolean()});
const base='/v1/inboxes/{id}',detail=`${base}/messages/{messageId}`,meta={tags:['Agent inboxes'],security};
const box=z.object({id:key}),params=box.extend({messageId:key});
function unwrap<T>(value:(T&{error?:string})|undefined){
 const code=value?.error;
 if(!value||code==='NOT_FOUND')throw new ApiError(404,'NOT_FOUND','No such inbox for this credential.');
 if(code==='MESSAGE_GONE')throw new ApiError(404,code,'No such message or folder entry in this inbox.');
 if(code==='AMBIGUOUS_ENTRY')throw new ApiError(409,code,'This message has several folder entries. Pass source and uid from the folder listing.');
 if(code==='LABEL_LIMIT')throw new ApiError(422,code,'A message may have at most 64 keywords.');
 if(code==='MODIFIED')throw new ApiError(409,code,'Message changed after ifModseq. Read the new state before retrying.');
 if(code)throw new Error('Unexpected inbox mutation result');
 return value;
}
export function registerInboxFolders(app:App,access:(c:Ctx,p?:MailboxPermission)=>MailboxAccess){
 const mutate=async(c:Ctx,bid:string,mid:string,op:string,p:unknown)=>{
  const v=access(c,'modify');
  const {rows}=await c.env.db.execute<{r:z.infer<typeof result>}>(sql`SELECT inbox_mutate(b.workspace_id,b.id,${mid},${op},${JSON.stringify(p)}::jsonb) r FROM mailboxes b WHERE ${inboxVisible(v)} AND b.id=${bid}`);
  return unwrap(rows[0]?.r);
 };
 const folder=z.object({id:Role,role:Special.nullable(),path:z.string(),subscribed:z.boolean(),uidValidity:uid,uidNext:z.number(),highestModseq:z.string(),total:z.number(),unseen:z.number()});
 app.openapi(createRoute({...meta,method:'get',path:`${base}/folders`,operationId:'listInboxFolders',summary:'List folders, stable UID namespaces and counts',request:{params:box},responses:{200:response(z.object({data:z.array(folder),state:z.string()})),...errors}}),async c=>{
  const v=access(c,'read'),{id}=c.req.valid('param');
  const {rows}=await c.env.db.execute<{r:{data:z.infer<typeof folder>[];state:string}}>(sql`SELECT jsonb_build_object('state',s.modseq::text,'data',(SELECT jsonb_agg(jsonb_build_object('id',role,'role',CASE WHEN custom_path IS NULL THEN role END,'path',inbox_folder_path(f),'subscribed',subscribed,'uidValidity',uid_validity,'uidNext',uid_next,'highestModseq',highest_modseq::text,'total',total,'unseen',unseen) ORDER BY role) FROM inbox_folders f WHERE inbox_id=b.id)) r FROM mailboxes b JOIN inbox_state s ON s.inbox_id=b.id WHERE ${inboxVisible(v)} AND b.id=${id}`);
  return c.json(unwrap(rows[0]?.r),200);
 });
 const fp=box.extend({folder:Role}),path=z.string().min(1).max(255),edited=z.object({id:Role,state:z.string()});
 const edit=async(c:Ctx,bid:string,op:string,id:string|null,p:string|null,sub:boolean|null)=>{
  const v=access(c,'modify');if(v.mailboxIds&&!v.mailboxIds.includes(bid))throw new ApiError(404,'NOT_FOUND','No such inbox.');
  const r=(await c.env.db.execute<{r:z.infer<typeof edited>&{error?:string}}>(sql`SELECT inbox_edit_folder(${v.workspaceId},${bid},${op},${id},${p},${sub}) r`)).rows[0]!.r;
  if(r.error)throw new ApiError(r.error==='NOT_FOUND'?404:409,r.error,'Folder operation refused.');return r;
 };
 app.openapi(createRoute({...meta,method:'post',path:`${base}/folders`,operationId:'createInboxFolder',summary:'Create a custom folder',request:{params:box,body:json(z.object({path}).strict())},responses:{201:response(edited),...errors}}),async c=>c.json(await edit(c,c.req.valid('param').id,'create',null,c.req.valid('json').path,null),201));
 app.openapi(createRoute({...meta,method:'patch',path:`${base}/folders/{folder}`,operationId:'updateInboxFolder',summary:'Rename a folder tree or change its subscription',request:{params:fp,body:json(z.union([z.object({path}).strict(),z.object({subscribed:z.boolean()}).strict()]))},responses:{200:response(edited),...errors}}),async c=>{const {id,folder}=c.req.valid('param'),q=c.req.valid('json');return c.json('path'in q?await edit(c,id,'rename',folder,q.path,null):await edit(c,id,'subscribe',folder,null,q.subscribed),200)});
 app.openapi(createRoute({...meta,method:'delete',path:`${base}/folders/{folder}`,operationId:'deleteInboxFolder',summary:'Remove a custom folder; preserve otherwise orphaned mail in Trash',request:{params:fp},responses:{200:response(edited),...errors}}),async c=>{const {id,folder}=c.req.valid('param');return c.json(await edit(c,id,'delete',folder,null,null),200)});
 app.openapi(createRoute({...meta,method:'patch',path:detail,operationId:'updateInboxMessage',summary:'Set read state or flags; deleted applies to one folder entry',request:{params,body:json(patch)},responses:{200:response(result),...errors}}),async c=>{
  const {id,messageId}=c.req.valid('param');return c.json(await mutate(c,id,messageId,'flags',c.req.valid('json')),200);
 });
 for(const op of ['move','copy'] as const){
  app.openapi(createRoute({...meta,method:'post',path:`${detail}/${op}`,operationId:op==='move'?'moveInboxMessage':'copyInboxMessage',summary:op==='move'?'Move one entry and allocate a new destination UID':'Copy one entry with a fresh destination UID',request:{params,body:json(transfer)},responses:{200:response(result),...errors}}),async c=>{
   const {id,messageId}=c.req.valid('param');return c.json(await mutate(c,id,messageId,op,c.req.valid('json')),200);
  });
 }
 app.openapi(createRoute({...meta,method:'delete',path:detail,operationId:'deleteInboxMessage',summary:'Move one entry to Trash, or expunge it permanently',request:{params,query:z.object({source:Role.optional(),uid:z.coerce.number().int().min(1).max(4294967295).optional(),permanent:z.enum(['true','false']).default('false'),ifModseq:seq.optional()})},responses:{200:response(result),...errors}}),async c=>{
  const {id,messageId}=c.req.valid('param'),q=c.req.valid('query');return c.json(await mutate(c,id,messageId,q.permanent==='true'?'expunge':'move',{...q,folder:'trash'}),200);
 });
 const expunged=z.object({expunged:z.number(),hasMore:z.boolean()});
 app.openapi(createRoute({...meta,method:'post',path:`${base}/folders/{folder}/expunge`,operationId:'expungeInboxFolder',summary:'Remove entries marked deleted; repeat while hasMore is true',request:{params:box.extend({folder:Role}),body:json(z.object({uids:z.array(uid).min(1).max(500).optional()}).strict())},responses:{200:response(expunged),...errors}}),async c=>{
  const v=access(c,'modify'),{id,folder}=c.req.valid('param'),{uids}=c.req.valid('json');
  const {rows}=await c.env.db.execute<{r:z.infer<typeof expunged>}>(sql`SELECT inbox_expunge_folder(b.workspace_id,b.id,${folder},${sql.param(uids??null)}::bigint[]) r FROM mailboxes b WHERE ${inboxVisible(v)} AND b.id=${id}`);
  return c.json(unwrap(rows[0]?.r),200);
 });
 const changes=z.object({changed:z.array(key),removed:z.array(key),state:seq,hasMore:z.boolean()});
 app.openapi(createRoute({...meta,method:'get',path:`${base}/changes`,operationId:'getInboxChanges',summary:'Sync changed and removed message IDs since an inbox MODSEQ',request:{params:box,query:z.object({since:seq})},responses:{200:response(changes),...errors}}),async c=>{
  const v=access(c,'read'),{id}=c.req.valid('param'),{since}=c.req.valid('query');
  const {rows}=await c.env.db.execute<{r:z.infer<typeof changes>;future:boolean}>(sql`SELECT (s.modseq<${since}::bigint OR s.changes_floor>${since}::bigint) future,page.r FROM mailboxes b JOIN inbox_state s ON s.inbox_id=b.id CROSS JOIN LATERAL (
   WITH touched AS (SELECT * FROM (SELECT modseq,message_id FROM mailbox_messages WHERE mailbox_id=b.id AND modseq>${since}::bigint ORDER BY modseq LIMIT 501) live UNION SELECT * FROM (SELECT modseq,message_id FROM inbox_vanished WHERE inbox_id=b.id AND modseq>${since}::bigint ORDER BY modseq LIMIT 501) gone),
   page AS (SELECT * FROM touched ORDER BY modseq LIMIT 500), ids AS (SELECT DISTINCT message_id FROM page)
   SELECT jsonb_build_object('changed',ARRAY(SELECT message_id FROM ids WHERE EXISTS(SELECT FROM mailbox_messages m WHERE m.mailbox_id=b.id AND m.message_id=ids.message_id)), 'removed',ARRAY(SELECT message_id FROM ids WHERE NOT EXISTS(SELECT FROM mailbox_messages m WHERE m.mailbox_id=b.id AND m.message_id=ids.message_id)), 'hasMore',(SELECT count(*)>500 FROM touched),'state',CASE WHEN (SELECT count(*)>500 FROM touched) THEN (SELECT max(modseq) FROM page) ELSE s.modseq END::text) r) page WHERE ${inboxVisible(v)} AND b.id=${id}`);
  if(rows[0]?.future)throw new ApiError(410,'CHANGES_EXPIRED','Checkpoint is outside the sync window. List folders again.');
  return c.json(unwrap(rows[0]?.r),200);
 });
}
