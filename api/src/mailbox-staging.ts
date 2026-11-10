import { CopyObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { sql } from 'drizzle-orm';
import { ApiError, log, type JobHandler, type Runtime } from './core.js';
import { JobDeferred, retryDatabaseFailures } from './jobs.js';
import { acceptInboundNotification, recoverHeldReceipts, sesIdPattern } from './mailbox-receipts.js';
import { mailboxS3, STAGING_PREFIX } from './mailbox-setup.js';
import { ADDRESS } from './mailbox-store.js';
import { connectionReady, poolReceives } from './states.js';

const sweep='mailbox.sweepStaging', orphan='mailbox.recoverStaging', holds='mailbox.replayHolds';
// Derive the bucket, topic and credential scope from live bindings, never from a listed key or mail header.
const resources=(runtime:Runtime)=>runtime.config.multiTenant ? sql`SELECT inbound_bucket AS bucket,region,inbound_topic_arn AS topic,NULL::text AS owner FROM provider_pool_regions p WHERE ${poolReceives()} AND inbound_bucket IS NOT NULL AND inbound_topic_arn IS NOT NULL
  UNION ALL SELECT r.bucket,r.region,r.topic_arn,r.workspace_id FROM mailbox_regions r JOIN provider_connections c ON c.workspace_id=r.workspace_id AND c.region=r.region AND c.aws_account_id=r.account_id WHERE c.kind='byo' AND c.template_version<>'v5' AND ${connectionReady(sql`c`)} AND r.bucket IS NOT NULL AND r.topic_arn IS NOT NULL` : sql`SELECT bucket,region,topic_arn AS topic,workspace_id AS owner FROM mailbox_regions WHERE workspace_id=${runtime.config.workspaceId} AND bucket IS NOT NULL AND topic_arn IS NOT NULL`;

export async function scheduleMailRecovery(runtime:Runtime) {
  await runtime.db.execute(sql`WITH bindings AS (${resources(runtime)}), work AS (
    SELECT ${sweep}||':'||bucket AS id,${sweep}::text AS type,coalesce(owner,${runtime.config.workspaceId}) AS wid,jsonb_build_object('bucket',bucket,'topic',topic,'shared',owner IS NULL) AS payload FROM bindings
    UNION ALL SELECT ${holds},${holds},${runtime.config.workspaceId},'{}'::jsonb WHERE EXISTS(SELECT FROM mail_receipt_holds WHERE status='held' AND next_check<=now()))
    INSERT INTO jobs(id,type,workspace_id,payload) SELECT w.id,w.type,w.wid,w.payload FROM work w LEFT JOIN jobs j ON j.id=w.id
    WHERE j.id IS NULL OR (j.status NOT IN ('pending','running') AND j.created_at<=now()-interval '50 minutes') ORDER BY j.created_at NULLS FIRST,w.id LIMIT 100
    ON CONFLICT(id) DO UPDATE SET workspace_id=excluded.workspace_id,payload=excluded.payload,attempts=0,status='pending',lease_until=NULL,last_error=NULL,available_at=now(),created_at=now() WHERE jobs.status NOT IN ('pending','running')`);
}

// SES's own leading Received (optionally preceded by Return-Path), never To, Cc, Bcc or a later Received.
// Require the regional SMTP endpoint AND S3 message id. Never infer an authenticated sender.
function traceEnvelope(bytes:Uint8Array,region:string,mid:string) {
  const fields=Buffer.from(bytes).toString('latin1').replace(/\r?\n[ \t]+/g,' ').split(/\r?\n/);fields.pop();
  let field:string|undefined,spamVerdict:{status:string}|undefined,virusVerdict:{status:string}|undefined;
  for(const line of fields){
    if(/^Return-Path:/i.test(line) && !field)continue;
    if(/^Received:/i.test(line) && !field){field=line;continue;}
    const v=/^X-SES-(Spam|Virus)-Verdict:\s*(PASS|FAIL|GRAY|PROCESSING_FAILED)\s*$/i.exec(line);
    if(!v)break;
    if(v[1]!.toLowerCase()==='spam')spamVerdict??={status:v[2]!.toUpperCase()};else virusVerdict??={status:v[2]!.toUpperCase()};
  }
  const m=field && /\sby\s+inbound-smtp\.([a-z0-9-]+)\.amazonaws\.com\s+with\s+E?SMTPS?\s+id\s+([\w.-]+)\s+for\s+(?:<([^<>;\s]+)>|([^<>;\s]+));\s*(.+)$/i.exec(field);
  if (!m || m[1]!==region || m[2]!==mid) return null;
  const addr=(m[3]??m[4])!.toLowerCase(),time=Date.parse(m[5]!);
  return ADDRESS.test(addr) && Number.isFinite(time)?{addr,time,spamVerdict,virusVerdict}:null;
}

const stagingJob:JobHandler=async(runtime,payload,job)=>{
  const bucket=String(payload.bucket);
  const {rows:[r]}=await runtime.db.execute<{region:string;topic:string;owner:string|null}>(sql`WITH bindings AS (${resources(runtime)}) SELECT region,topic,owner FROM bindings WHERE bucket=${bucket} AND topic=${String(payload.topic)} AND owner IS NOT DISTINCT FROM ${payload.shared===true?null:job.workspaceId}::text`);
  if (!r) throw new ApiError(409,'MAILBOX_STAGING_BINDING_LOST','The original receiving binding is unavailable.');
  const s3=await mailboxS3(runtime,job.workspaceId,r.region,bucket);
  const account=r.topic.split(':')[4];
  try {
    if (payload.mid===undefined) {
      const page=await s3.send(new ListObjectsV2Command({Bucket:bucket,ExpectedBucketOwner:account,Prefix:STAGING_PREFIX,StartAfter:typeof payload.after==='string'?payload.after:undefined,MaxKeys:256}));
      const objects=(page.Contents??[]).flatMap(o=>{
        const mid=o.Key?.slice(STAGING_PREFIX.length);
        return mid && o.Key===STAGING_PREFIX+mid && sesIdPattern.test(mid) && o.ETag && o.LastModified && o.LastModified.getTime()<Date.now()-3600_000?[{mid,etag:o.ETag,at:o.LastModified.toISOString()}]:[];
      });
      if(objects.length) await runtime.db.execute(sql`INSERT INTO jobs(id,type,workspace_id,payload)
        SELECT ${orphan}||':'||${bucket}||':'||mid,${orphan},${job.workspaceId},jsonb_build_object('bucket',${bucket}::text,'topic',${r.topic}::text,'shared',${r.owner===null}::boolean,'mid',mid,'etag',etag,'at',at)
        FROM jsonb_to_recordset(${JSON.stringify(objects)}::jsonb) o(mid text,etag text,at text)
        WHERE NOT EXISTS(SELECT FROM mail_receipts m WHERE m.bucket=${bucket} AND m.ses_message_id=o.mid ${r.owner===null?sql``:sql`AND m.workspace_id=${r.owner}`})
          AND NOT EXISTS(SELECT FROM mail_receipt_holds h WHERE h.bucket=${bucket} AND h.ses_message_id=o.mid AND h.binding_workspace IS NOT DISTINCT FROM ${r.owner}::text) ORDER BY mid ON CONFLICT DO NOTHING`);
      if(page.IsTruncated && page.Contents?.at(-1)?.Key) throw new JobDeferred(new Date().toISOString(),{...payload,after:page.Contents.at(-1)!.Key});
      return;
    }
    const mid=String(payload.mid),etag=String(payload.etag),at=Date.parse(String(payload.at));
    if (!sesIdPattern.test(mid) || !etag || !Number.isFinite(at)) throw new ApiError(400,'JOB_PAYLOAD_INVALID','Invalid staging object reference.');
    const key=STAGING_PREFIX+mid;
    const object=await s3.send(new GetObjectCommand({Bucket:bucket,ExpectedBucketOwner:account,Key:key,IfMatch:etag,Range:'bytes=0-16383',ResponseContentEncoding:'identity'})).catch(e=>{if(['NoSuchKey','NotFound','PreconditionFailed'].includes(e?.name))return null;throw e;});
    if(!object)return;
    const env=traceEnvelope(await object.Body!.transformToByteArray(),r.region,mid);
    if (!env) {
      // Preserve evidence outside the 3-day lifecycle, strictly outside every workspace namespace.
      await s3.send(new CopyObjectCommand({Bucket:bucket,ExpectedBucketOwner:account,ExpectedSourceBucketOwner:account,Key:'quarantine/'+mid,CopySource:`${bucket}/${key}`,CopySourceIfMatch:etag,TaggingDirective:'REPLACE'})).catch(e=>{if(e?.name!=='AccessDenied')throw e;log('warn',{code:'MAILBOX_QUARANTINE_ACCESS_DENIED',jobId:job.id});});
      throw new ApiError(422,'MAILBOX_STAGING_ENVELOPE_UNKNOWN','No attributable SES envelope; operator review required.');
    }
    await acceptInboundNotification(runtime,{region:r.region,topicArn:r.topic,message:{notificationType:'Received',mail:{messageId:mid},receipt:{spamVerdict:env.spamVerdict,virusVerdict:env.virusVerdict,recipients:[env.addr],timestamp:new Date(Math.min(env.time,at)).toISOString(),action:{type:'S3',topicArn:r.topic,bucketName:bucket,objectKey:key}}}},{etag,bindingWorkspace:r.owner});
  } catch(e){if(e instanceof Error && e.name==='AccessDenied')throw new ApiError(403,'MAILBOX_STAGING_ACCESS_DENIED','Access to mailbox staging was denied.');throw e;} finally {s3.destroy();}
};

export const stagingJobs:Record<string,JobHandler>={[sweep]:retryDatabaseFailures(stagingJob),[orphan]:retryDatabaseFailures(stagingJob),[holds]:retryDatabaseFailures(async runtime=>{
  if (await recoverHeldReceipts(runtime)===100) throw new JobDeferred(new Date().toISOString());
})};
