import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { Client } from 'pg';
import { postgresConnection } from '../src/adapters/node.js';
import { mailboxResources } from '../src/mailbox-setup.js';
import { POOL_INSTALLATION, poolTenantName } from '../src/ses-setup.js';

const sha = (text:string) => createHash('sha256').update(text).digest('hex');
const str = {type:'string'} as const, flag = {type:'boolean'} as const;
function options(args:string[]) {
  const {values:v,tokens} = parseArgs({args,tokens:true,options:{plan:flag,apply:flag,restore:str,finalize:str,'expect-plan-sha256':str,
    'old-account':str,'new-account':str,region:str,workspaces:str,'old-bucket':str,'new-bucket':str,'run-id':str}});
  if (new Set(tokens.map(t=>t.kind==='option'?t.name:'')).size!==tokens.length) throw Error('Duplicate option.');
  const old=v['old-account'], dest=v['new-account'], region=v.region, run=v['run-id']??v.restore??v.finalize, expect=v['expect-plan-sha256'];
  if (!old || !dest || !/^\d{12}$/.test(old) || !/^\d{12}$/.test(dest) || old===dest) throw Error('Expected distinct 12-digit old and new accounts.');
  if (region!=='us-east-2') throw Error('Only us-east-2 is supported.');
  const workspaces=(v.workspaces??'').split(',').sort();
  if (workspaces.some(w=>w!=='default' && !/^ws_[0-9a-f]{32}$/.test(w)) || !workspaces.some(w=>w!=='default') || new Set(workspaces).size!==workspaces.length) throw Error('Expected exact, distinct workspace IDs.');
  const buckets=[`opensend-mx-${old}-mail-${region}`,mailboxResources(POOL_INSTALLATION,region,dest).bucket];
  if (v['old-bucket']!==buckets[0] || v['new-bucket']!==buckets[1]) throw Error('Expected the account-specific Ohio Hosted mail bucket names.');
  if (!run || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(run) || [v.restore,v.finalize].some(id=>id!==undefined && id!==run)) throw Error('Expected a single run ID.');
  if ([v.apply,v.plan,v.restore,v.finalize].filter(Boolean).length>1 || (v.apply ? !expect || !/^[0-9a-f]{64}$/.test(expect) : expect!==undefined)) throw Error('Choose --plan, --apply --expect-plan-sha256 HASH, --restore RUN, or --finalize RUN.');
  return {inputs:{run,old,dest,region,workspaces,oldBucket:buckets[0]!,newBucket:buckets[1]!},mode:v.apply?'apply':v.restore?'restore':v.finalize?'finalize':'plan',expect};
}
type Inputs = ReturnType<typeof options>['inputs'];
const binding = `SELECT b.domain_id,b.workspace_id,b.name,b.connection_id,b.region,dc.token FROM domain_sending_bindings b
  JOIN domain_claims dc USING(workspace_id,name,connection_id) JOIN operation_domains d ON (d.id,d.workspace_id,d.name,d.region)=(b.domain_id,b.workspace_id,b.name,b.region)
  JOIN provider_connections c ON (c.id,c.workspace_id,c.region)=(b.connection_id,b.workspace_id,b.region)`;

// The same static write set drives snapshot, apply and restore. Guard columns are compared, never restored.
// Each image value contains the PK too, so PostgreSQL can reconstruct typed rows without a JS date/number round trip.
function table(name:string,pk:string,changes:Record<string,string>,guard='',where='true') {
  return {name,keys:pk.split(' '),changes,guard,where};
}
const clear=(cols:string) => Object.fromEntries(cols.split(' ').map(col=>[col,'NULL'])) as Record<string,string>;
const boundMailbox=`t.parent_id IS NULL AND EXISTS(SELECT FROM bound b WHERE (b.workspace_id,b.domain_id,b.name,b.region)=(t.workspace_id,t.domain_id,t.name,t.region))`;
const residue=`(t.workspace_id='default' OR EXISTS(SELECT FROM provider_connections c WHERE c.workspace_id=t.workspace_id))`;
const tables=[
  table('provider_pool_regions','region',{aws_account_id:'a.dest',sending_state:"'pending'",receiving_state:"'pending'",generation:'t.generation+1',
    ...clear('feedback_topic_arn inbound_topic_arn inbound_bucket lease_until confirmed_generation')},'legacy_names pool_tier ownership_journal'),
  table('provider_connections','id',{aws_account_id:'a.dest',managed_tenant:'true',pool_tenant_name:'a.names->>t.workspace_id',tenant_state:"'pending'",lease_until:'NULL'},'workspace_id kind region state paused_at pause_reason resumed_at'),
  // mirror_legacy_connection mirrors tenant_state, not managed_tenant on conflict (067).
  table('provider_connection_regions','connection_id region',{managed_tenant:'true',tenant_state:"'pending'",sending_state:"'ready'",scan_state:"'ready_to_import'",receiving_state:"'off'",
    generation:'t.generation+1',receiving_generation:'t.receiving_generation+1',scan_revision:'0',scan_facts:"'{}'::jsonb",
    ...clear('pool_tenant_name confirmed_topic_arn confirmed_generation feedback_topic_arn inbound_topic_arn lease_until ready_at scan_error provision_error')},'legacy ownership_journal'),
  table('domain_claims','workspace_id name',{sending_state:"'pending'",receiving_state:"'off'",...clear('identity receiving_host lost_since receiving_lost_since')},'connection_id token created_at claim_scope ever_proven'),
  table('mailbox_domains','id',{status:"'waiting_for_mx'",mx_misses:'0',updated_at:'now()',...clear('receiving_host mx checked_at enabled_at last_error')},'workspace_id domain_id name region parent_id catch_all',boundMailbox),
  table('ses_region_discovery','workspace_id region',clear('report credentials_fingerprint public_url last_discovered_at trusted_account_id trusted_topic_arn trusted_credentials_fingerprint provision_job_id'),'',residue),
  table('mailbox_regions','workspace_id region',{...clear('account_id bucket topic_arn rule_set_name reconcile_lease_until last_reconciled_at last_error'),updated_at:'now()'},'',residue),
  table('mail_messages','id',{raw_bucket:'a.nb'},'workspace_id region raw_key','raw_bucket IS NOT NULL'),
  table('mail_attachments','id',{bucket:'a.nb'},'workspace_id message_id storage_key sha256 source_attachment_id'),
  table('mail_receipts','workspace_id ses_message_id',{bucket:'a.nb'},'region object_key status'),
];
const ctx=`WITH a AS (SELECT $1::text old,$2::text dest,$3::text region,$4::text[] wids,$5::text ob,$6::text nb,$7::jsonb names), bound AS (${binding})`;
const params=(i:Inputs)=>[i.old,i.dest,i.region,i.workspaces,i.oldBucket,i.newBucket,Object.fromEntries(i.workspaces.filter(w=>w!=='default').map(w=>[w,poolTenantName(w,'probation')]))];

// Each source has a unique stable key k, the writable before-image v, and optional guard-only g.
const projection=(cols:string[])=>`(SELECT to_jsonb(s) FROM (SELECT ${cols.map(c=>'t.'+c).join(',')}) s)`;
const images=tables.map(t=>({name:t.name,rows:`SELECT jsonb_build_array(${t.keys.map(c=>'t.'+c)})::text k,
  ${projection([...t.keys,...Object.keys(t.changes)])} v,${t.guard?projection(t.guard.split(' ')):'NULL::jsonb'} g FROM ${t.name} t,a WHERE ${t.where}`}));
// A verifier job ID and payload token can both be reconstructed from the still-bound domain ID.
// Do not persist the claim token in a second table merely to restore a job.
images.push({name:'jobs',rows:`SELECT b.domain_id k,CASE WHEN j.id IS NOT NULL THEN jsonb_build_object('payload',j.payload-'token','status',j.status,'attempts',j.attempts,'available_at',j.available_at,'created_at',j.created_at,'lease_until',j.lease_until,'last_error',j.last_error) END v,
  to_jsonb(j) g FROM bound b LEFT JOIN jobs j ON j.id='domain.verify:'||b.token`});
const fences=[['bindings','domain_id',binding],['attempts','id','SELECT id,workspace_id,attempt_started_at,provider_id,feedback_topic_arn,dispatch_version FROM sending_emails'],
  ['messages','id','SELECT id,workspace_id,thread_id,sending_email_id,ses_message_id FROM mail_messages'],['boxes','id','SELECT id,domain_id,workspace_id FROM mailboxes'],
  ['addresses','workspace_id,address','SELECT workspace_id,address,mailbox_id FROM mailbox_addresses'],['links','mailbox_id,message_id','SELECT mailbox_id,message_id,workspace_id FROM mailbox_messages']
].map(([name,pk,source])=>({name:name!,rows:`SELECT jsonb_build_array(${pk})::text k,NULL::jsonb v,to_jsonb(f) g FROM (${source}) f` }));
const batches=(rows:string)=>`SELECT (row_number() OVER (ORDER BY k COLLATE "C")-1)/256 chunk,k,v,g FROM (${rows}) source`;
const hashSql=(expr:string)=>`encode(sha256(convert_to(${expr},'UTF8')),'hex')`;

async function schemaCheck(db:Client) {
  const dir=new URL('../migrations/',import.meta.url), files=(await readdir(dir)).filter(n=>/^\d+_[a-z_]+\.sql$/.test(n)).sort();
  const applied=await db.query('SELECT name,checksum FROM bane_migrations ORDER BY name COLLATE "C"');
  const sums=new Map(applied.rows.map(r=>[r.name,r.checksum]));
  if (files.length!==sums.size || !(await Promise.all(files.map(async n=>sums.get(n)===sha(await readFile(new URL(n,dir),'utf8'))))).every(Boolean)) throw Error('Wrong migration set or checksum.');
  const {rows:[database]}=await db.query(`SELECT system_identifier::text AS system_id,current_database() AS database,current_schema() AS schema FROM pg_catalog.pg_control_system()`);
  return {...database,migrationsSha256:sha(JSON.stringify(applied.rows))};
}

async function inspect(db:Client,i:Inputs,database:Awaited<ReturnType<typeof schemaCheck>>,post:boolean,usedRun=false) {
  const p=params(i), q=(sql:string)=>db.query(ctx+' '+sql,p);
  const ids=(await q(`SELECT ARRAY(SELECT id FROM workspaces ORDER BY id COLLATE "C") AS workspaces, ARRAY(SELECT id FROM provider_connections ORDER BY id COLLATE "C") AS connections,
    ARRAY(SELECT id FROM workspaces w WHERE NOT EXISTS(SELECT FROM provider_connections c WHERE c.workspace_id=w.id) ORDER BY id COLLATE "C") AS unconnected,
    ARRAY(SELECT domain_id FROM bound ORDER BY domain_id COLLATE "C") AS domains,
    ARRAY(SELECT receiving_host FROM domain_claims WHERE receiving_host IS NOT NULL ORDER BY receiving_host COLLATE "C") AS "receivingHosts"`)).rows[0]!;
  const topic=`'arn:aws:sns:'||a.region||':'||a.old||':opensend-mx-feedback'`, inbound=`'arn:aws:sns:'||a.region||':'||a.old||':opensend-mx-inbound'`;
  const checks:Record<string,string>={
    'unexpected workspaces':`SELECT FROM a WHERE ARRAY(SELECT id FROM workspaces ORDER BY id COLLATE "C")<>a.wids`,
    'unexpected connections':`SELECT FROM provider_connections c,a WHERE NOT a.names ? c.workspace_id UNION ALL SELECT FROM a WHERE NOT EXISTS(SELECT FROM provider_connections)`,
    'account-bound data without connection':['domain_claims','operation_domains','mailbox_domains','mail_threads','mail_messages','mail_message_ids','mail_unrouted','mail_attachments','mail_receipts','sending_emails','sending_campaigns'].map(tab=>`SELECT FROM ${tab} t WHERE NOT EXISTS(SELECT FROM provider_connections c WHERE c.workspace_id=t.workspace_id)`).join(' UNION ALL '),
    'missing Ohio workspace settings':`SELECT FROM provider_connections c WHERE NOT EXISTS(SELECT FROM ses_installation_settings s WHERE s.workspace_id=c.workspace_id AND s.default_region=c.region AND s.enabled_regions=jsonb_build_array(c.region))`,
    'BYO connections':`SELECT FROM provider_connections WHERE kind<>'shared'`,
    'unpaused connections':`SELECT FROM provider_connections WHERE paused_at IS NULL`,
    'unexpected connection binding':`SELECT FROM provider_connections c,a WHERE c.region<>a.region OR c.state<>'ready' OR c.aws_account_id IS DISTINCT FROM ${post?'a.dest':'a.old'} OR ${post?"NOT managed_tenant OR pool_tenant_name IS DISTINCT FROM (a.names->>workspace_id) OR tenant_state<>'pending'":"managed_tenant OR pool_tenant_name IS NOT NULL OR tenant_state<>'ready'"}`,
    'non-legacy or missing regional binding':`SELECT FROM provider_connection_regions r JOIN provider_connections c ON c.id=r.connection_id WHERE NOT r.legacy OR r.region<>c.region OR r.managed_tenant<>c.managed_tenant OR r.tenant_state<>c.tenant_state OR r.sending_state<>'ready' OR r.receiving_state<>'off' OR r.pool_tenant_name IS NOT NULL OR r.feedback_topic_arn IS NOT NULL OR r.inbound_topic_arn IS NOT NULL OR r.confirmed_topic_arn IS NOT NULL UNION ALL SELECT FROM provider_connections c WHERE NOT EXISTS(SELECT FROM provider_connection_regions r WHERE (r.connection_id,r.region)=(c.id,c.region))`,
    'unexpected pool':`SELECT FROM a WHERE (SELECT count(*) FROM provider_pool_regions)<>1 OR NOT EXISTS(SELECT FROM provider_pool_regions t WHERE t.region=a.region AND legacy_names AND pool_tier='probation' AND aws_account_id=${post?'a.dest':'a.old'} AND ${post?"sending_state='pending' AND receiving_state='pending' AND feedback_topic_arn IS NULL AND inbound_topic_arn IS NULL AND inbound_bucket IS NULL":`sending_state='ready' AND receiving_state='ready' AND feedback_topic_arn=(${topic}) AND inbound_topic_arn=(${inbound}) AND inbound_bucket=a.ob`})`,
    ...post?{}:{'destination already has pool rows':`SELECT FROM provider_pool_regions,a WHERE aws_account_id=a.dest`},
    'missing old provider_feedback_history':`SELECT FROM a WHERE NOT EXISTS(SELECT FROM provider_feedback_history h WHERE (h.topic_arn,h.region,h.aws_account_id,h.kind)=((${topic}),a.region,a.old,'shared'))`,
    'ownership journals':`SELECT FROM provider_connection_regions WHERE ownership_journal<>'[]' UNION ALL SELECT FROM provider_pool_regions WHERE ownership_journal<>'[]'`,
    'managed, adopted or imported claims':`SELECT FROM domain_claims WHERE claim_scope<>'exclusive' OR identity ?| array['managed','adopted'] OR identity @> '{"imported":true}' UNION ALL SELECT FROM hosted_adoptions UNION ALL SELECT FROM hosted_tenant_ownership UNION ALL SELECT FROM hosted_domain_tiers UNION ALL SELECT FROM byo_candidates UNION ALL SELECT FROM byo_domain_intents UNION ALL SELECT FROM byo_operation_receipts`,
    'unmatched claims or domains':`SELECT FROM a WHERE (SELECT count(*) FROM bound)<>(SELECT count(*) FROM domain_claims) OR (SELECT count(*) FROM bound)<>(SELECT count(*) FROM operation_domains) OR (SELECT count(DISTINCT token) FROM bound)<>(SELECT count(*) FROM domain_sending_bindings)`,
    'claim within one hour of expiry':`SELECT FROM domain_claims WHERE NOT ever_proven AND created_at<=now()-interval '71 hours'`,
    'unbound mailbox domains':`SELECT FROM mailbox_domains t WHERE NOT (${boundMailbox}) AND (t.parent_id IS NOT NULL OR t.status<>'disabled' OR EXISTS(SELECT FROM bound b WHERE (b.workspace_id,b.name)=(t.workspace_id,t.name)))`,
    'foreign discovery residue':`SELECT FROM ses_region_discovery t,a WHERE NOT (${residue}) OR trusted_account_id<>a.old OR trusted_topic_arn !~ ('^arn:aws:sns:[^:]+:'||a.old||':[^:]+$') OR report#>>'{account,id}'<>a.old OR report#>>'{resources,topic,arn}' !~ ('^arn:aws:sns:[^:]+:'||a.old||':[^:]+$')`,
    'foreign mailbox region residue':`SELECT FROM mailbox_regions t,a WHERE NOT (${residue}) OR account_id<>a.old OR topic_arn !~ ('^arn:aws:sns:[^:]+:'||a.old||':[^:]+$')`,
    'foreign or inconsistent mail locators':`SELECT FROM mail_messages m,a WHERE (raw_bucket IS NULL)<>(raw_key IS NULL) OR (raw_bucket IS NOT NULL AND (raw_bucket<>${post?'a.nb':'a.ob'} OR m.region IS DISTINCT FROM a.region OR NOT a.names ? workspace_id OR NOT starts_with(raw_key,'workspaces/'||workspace_id||'/raw/') OR raw_key~'/(\\.{1,2}/|/|$|\\.{1,2}$)'))
      UNION ALL SELECT FROM mail_receipts r,a WHERE bucket<>${post?'a.nb':'a.ob'} OR r.region<>a.region OR NOT a.names ? workspace_id OR object_key<>'workspaces/'||workspace_id||'/raw/'||ses_message_id||'.eml' OR ses_message_id LIKE '%/%'
      UNION ALL SELECT FROM mail_attachments f,a WHERE bucket<>${post?'a.nb':'a.ob'} OR NOT a.names ? workspace_id OR NOT starts_with(storage_key,'workspaces/'||workspace_id||'/att/') OR storage_key~'/(\\.{1,2}/|/|$|\\.{1,2}$)' OR NOT EXISTS(SELECT FROM mail_messages m WHERE (m.id,m.workspace_id,m.region)=(f.message_id,f.workspace_id,a.region))`,
    'pending attachment archives':`SELECT FROM mail_attachments WHERE source_attachment_id IS NOT NULL`,
    'active provisioning leases':`SELECT FROM provider_pool_regions WHERE lease_until>now() UNION ALL SELECT FROM provider_connections WHERE lease_until>now() UNION ALL SELECT FROM provider_connection_regions WHERE lease_until>now() UNION ALL SELECT FROM mailbox_regions WHERE reconcile_lease_until>now()`,
    'conflicting verifier job':`SELECT FROM bound b JOIN jobs j ON j.id='domain.verify:'||b.token WHERE j.workspace_id<>b.workspace_id OR j.type<>'domain.verify' OR j.status='running' OR j.payload->>'token' IS DISTINCT FROM b.token::text OR j.payload->>'domainId' IS DISTINCT FROM b.domain_id`,
    'running jobs or pending reputation alerts':`SELECT FROM jobs WHERE status='running' OR (status='pending' AND type='reputation.alert')`,
    'active setup or unresolved ingest jobs':`SELECT FROM jobs WHERE (status='pending' AND type~'^(ses|byo|tenant|hosted)\\.') OR (status IN ('pending','failed') AND type='mailbox.ingest' AND NOT EXISTS(SELECT FROM mail_receipts r WHERE r.workspace_id=jobs.workspace_id AND r.ses_message_id=jobs.payload->>'sesMessageId' AND r.status='processed'))`,
    ...post?{'live regional sending bindings after reset':`SELECT FROM regional_sending_connections`, 'claim not reset':`SELECT FROM domain_claims WHERE identity IS NOT NULL OR sending_state<>'pending' OR receiving_state<>'off'`}:{},
  };
  const blockers=Object.fromEntries((await q(Object.entries(checks).map(([label,sql])=>`SELECT '${label}' issue,count(*)::int n FROM (${sql}) v HAVING count(*)>0`).join(' UNION ALL ')+' ORDER BY issue')).rows.map(r=>[r.issue,r.n]));
  if (usedRun) blockers['run ID already used']=1;
  const work=(await q(`SELECT 'send' kind,status state,count(*)::int n FROM sending_emails WHERE status IN ('queued','attempting','acceptance_unknown') GROUP BY status
    UNION ALL SELECT 'campaign',state,count(*)::int FROM sending_campaigns WHERE state IN ('preparing','scheduled','sending','paused') OR (state='failed' AND expanded>0) GROUP BY state
    UNION ALL SELECT 'receipt',status,count(*)::int FROM mail_receipts WHERE status<>'processed' GROUP BY status ORDER BY 1,2`)).rows;
  const jobs=(await q(`SELECT type,status,count(*)::int n FROM jobs WHERE status IN ('pending','running') GROUP BY type,status ORDER BY type,status`)).rows;
  const counts:Record<string,number>=Object.fromEntries(images.map(t=>[t.name,0])),digest=createHash('sha256');
  for (const t of [...images,...fences]) {
    const chunks=await q(`SELECT chunk,count(*)::int n,${hashSql(`string_agg(${hashSql('jsonb_build_array(k,v,g)::text')},'' ORDER BY k COLLATE "C")`)} digest FROM (${batches(t.rows)}) s GROUP BY chunk ORDER BY chunk`);
    digest.update(JSON.stringify([t.name,chunks.rows]));if (t.name in counts) counts[t.name]=chunks.rows.reduce((n,r)=>n+r.n,0);
  }
  const summary={inputs:i,...ids,database,counts,work,jobs,blockers};
  const stableJobs=jobs.filter(j=>j.status!=='pending' || !/^operation\.(webhook$|ses$|publish)/.test(j.type));
  const hash=sha(JSON.stringify([2,tables,p,{...summary,jobs:stableJobs},digest.digest('hex')]));
  return {summary:{...summary,planSha256:hash},hash};
}

function checked(n:number|null,expected:number,table:string) {
  if (n!==expected) throw Error(`Unexpected affected row count: ${table}.`);
}
async function writeRows(db:Client,i:Inputs,counts:Record<string,number>,restore:boolean) {
  const p=[...params(i),i.run], saved=(name:string)=>`(SELECT e.* FROM hosted_rehome_images s CROSS JOIN LATERAL jsonb_each(s.before_image) e WHERE s.run_id=$8 AND s.relation='${name}') e`;
  for (const t of tables) {
    const entries=`${saved(t.name)} CROSS JOIN LATERAL jsonb_populate_record(NULL::${t.name},e.value) b`;
    const set=Object.entries(t.changes).map(([col,expr])=>`${col}=${restore?'b.'+col:expr}`).join(',');
    const update=await db.query(`${ctx} UPDATE ${t.name} t SET ${set} FROM a,${entries} WHERE ${t.keys.map(k=>`t.${k}=b.${k}`).join(' AND ')}`,p);
    checked(update.rowCount,counts[t.name]!,t.name);
  }
  if (!restore) {
    const result=await db.query(`${ctx} INSERT INTO jobs(id,type,workspace_id,payload,available_at) SELECT 'domain.verify:'||token,'domain.verify',workspace_id,jsonb_build_object('domainId',domain_id,'token',token,'platformAccount',a.dest),now() FROM bound,a
      ON CONFLICT(id) DO UPDATE SET status='pending',attempts=0,lease_until=NULL,last_error=NULL,payload=excluded.payload,available_at=now(),created_at=now() WHERE jobs.status<>'running' AND jobs.workspace_id=excluded.workspace_id AND jobs.type=excluded.type`,params(i));
    checked(result.rowCount,counts.jobs!,'jobs');
  } else {
    const entries=`${saved('jobs')} JOIN bound d ON d.domain_id=e.key`;
    const del=await db.query(`${ctx} DELETE FROM jobs j USING ${entries} WHERE j.id='domain.verify:'||d.token AND e.value='null'`,p);
    const upd=await db.query(`${ctx} UPDATE jobs j SET (status,attempts,lease_until,last_error,payload,available_at,created_at)=(b.status,b.attempts,b.lease_until,b.last_error,b.payload||jsonb_build_object('token',d.token),b.available_at,b.created_at)
      FROM ${entries} CROSS JOIN LATERAL jsonb_populate_record(NULL::jobs,nullif(e.value,'null')) b WHERE e.value<>'null' AND j.id='domain.verify:'||d.token`,p);
    checked(del.rowCount!+upd.rowCount!,counts.jobs!,'jobs');
  }
}

export async function rehomeHostedAccount(db:Client,args:string[]) {
  const {inputs:i,mode,expect}=options(args), restore=mode==='restore';
  await db.query(mode==='plan'?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN ISOLATION LEVEL SERIALIZABLE');
  try {
    await db.query("SET LOCAL lock_timeout='3s'; SET LOCAL TIME ZONE 'UTC'; SET LOCAL enable_hashagg=off");
    if (mode==='finalize') {
      const done=await db.query('UPDATE hosted_rehome_runs SET finalized_at=now() WHERE run_id=$1 AND inputs=$2::jsonb AND finalized_at IS NULL RETURNING run_id AS finalized,plan_sha256 AS "planSha256"',[i.run,i]);
      if (!done.rowCount) throw Error('Finalize refused: missing, mismatched or already finalized run.');
      await db.query('DELETE FROM hosted_rehome_images WHERE run_id=$1',[i.run]);await db.query('COMMIT');return done.rows[0]!;
    } else if (mode!=='plan') {
      // LOCK before the first SELECT establishes the SERIALIZABLE snapshot. Writers that were already
      // finishing an admission or a provider update must commit first (or cause a short timeout).
      await db.query(`LOCK TABLE ${tables.map(t=>t.name).join(',')},jobs IN SHARE ROW EXCLUSIVE MODE`);
      await db.query(`LOCK TABLE workspaces,ses_installation_settings,provider_feedback_history,domain_sending_bindings,operation_domains,sending_emails,sending_campaigns,mailboxes,mailbox_addresses,mailbox_messages IN SHARE MODE`);
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended('bane:hosted-account-cutover',0))");
    }
    const database=await schemaCheck(db);
    const run=(await db.query('SELECT plan_sha256,post_sha256,restored_at,finalized_at,inputs=$2::jsonb AS matches FROM hosted_rehome_runs WHERE run_id=$1',[i.run,i])).rows[0];
    if (restore && (!run?.matches || run.finalized_at || run.restored_at)) throw Error('Restore refused: missing, mismatched, restored or finalized run.');
    const snapshot=await inspect(db,i,database,restore,!!run && !restore), {summary}=snapshot;
    if (summary.work.length || Object.keys(summary.blockers).length) throw Error(`Re-home refused: ${JSON.stringify(summary)}`);
    if (mode==='apply') {
      if (snapshot.hash!==expect) throw Error('Plan SHA-256 mismatch; review a new plan.');
      await db.query('INSERT INTO hosted_rehome_runs(run_id,inputs,plan_sha256) VALUES($1,$2,$3)',[i.run,i,snapshot.hash]);
      for (const t of images) await db.query(`${ctx} INSERT INTO hosted_rehome_images SELECT $8,'${t.name}',chunk,jsonb_object_agg(k,v) FROM (${batches(t.rows)}) s GROUP BY chunk`,[...params(i),i.run]);
      await writeRows(db,i,summary.counts,false);
      const post=await inspect(db,i,database,true);
      if (post.summary.work.length || Object.keys(post.summary.blockers).length) throw Error('Post-apply validation failed: '+JSON.stringify(post.summary));
      await db.query('UPDATE hosted_rehome_runs SET post_sha256=$2 WHERE run_id=$1',[i.run,post.hash]);
    } else if (restore) {
      if (!run?.matches || run.restored_at || run.post_sha256!==snapshot.hash) throw Error('Restore refused: run inputs or expected post-apply state differ (new work or attempts).');
      await writeRows(db,i,summary.counts,true);
      const before=await inspect(db,i,database,false);
      if (before.hash!==run.plan_sha256) throw Error('Restored state does not match reviewed plan.');
      await db.query('UPDATE hosted_rehome_runs SET restored_at=now() WHERE run_id=$1',[i.run]);
    }
    await db.query('COMMIT');return restore?{...summary,planSha256:run!.plan_sha256}:summary;
  } catch(e) {await db.query('ROLLBACK');throw e;}
}
if (import.meta.main) {
  const args=process.argv.slice(2);options(args);
  if (!process.env.DATABASE_URL) throw Error('Set DATABASE_URL to the reviewed operator database.');
  const db=new Client(postgresConnection(process.env.DATABASE_URL));await db.connect();
  try {console.log(JSON.stringify(await rehomeHostedAccount(db,args),null,2));}
  catch(e) {console.error(e instanceof Error ? e.message : 'Re-home failed.');process.exitCode=1;} finally {await db.end();}
}
