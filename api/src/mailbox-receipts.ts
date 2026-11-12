import { sql, type SQL } from 'drizzle-orm';
import { ApiError, log, type Runtime } from './core.js';
import { claimReceives, connectionReady, poolReceives } from './states.js';
import { mailJson } from './mailbox-text.js';
import { STAGING_PREFIX } from './mailbox-setup.js';

export type ReceivedNotification = {
  notificationType?: string;
  mail?: { messageId?: string; timestamp?: string; source?: string; destination?: string[]; commonHeaders?: { from?: string[]; to?: string[]; subject?: string; messageId?: string; date?: string } };
  receipt?: { timestamp?: string; recipients?: string[]; spamVerdict?: { status?: string }; virusVerdict?: { status?: string }; spfVerdict?: { status?: string }; dkimVerdict?: { status?: string }; dmarcVerdict?: { status?: string };
    action?: { type?: string; bucketName?: string; objectKey?: string; topicArn?: string } };
};
export const sesIdPattern=/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/;

// Both live SNS and held envelopes pass through exactly the same ownership and receipt fences.
// One statement can create receipts in several workspaces (and a replay, several messages). Its
// receipts are written in workspace then message order, and each takes its workspace's window row
// before the receipt (157); its ingest jobs then take backlog rows in workspace order (155). So two
// route statements take window, receipt and backlog rows in one order, and the global hold release
// never waits on any of them (156).
async function route(runtime:Runtime,source:SQL,replay:boolean) {
  const hosted=runtime.config.multiTenant;
  const result=await runtime.db.execute<{trusted:boolean;n:number;held:number;seen:number}>(sql`WITH source AS MATERIALIZED (${source}), bound AS MATERIALIZED (
    SELECT s.*,b.wid,b.kind FROM source s CROSS JOIN LATERAL (${hosted ? sql`SELECT NULL::text AS wid,'shared' AS kind FROM provider_pool_regions p
      WHERE p.aws_account_id=split_part(s.topic_arn,':',5) AND p.region=s.region AND p.inbound_topic_arn=s.topic_arn AND p.inbound_bucket=s.bucket AND ${poolReceives()}
      UNION ALL SELECT c.workspace_id,'byo' FROM provider_connections c JOIN mailbox_regions r ON r.workspace_id=c.workspace_id AND r.region=c.region AND r.account_id=c.aws_account_id
      WHERE c.kind='byo' AND c.template_version<>'v5' AND ${connectionReady(sql`c`)} AND c.region=s.region AND c.aws_account_id=split_part(s.topic_arn,':',5) AND r.topic_arn=s.topic_arn AND r.bucket=s.bucket` : sql`SELECT workspace_id AS wid,'self' AS kind FROM mailbox_regions r WHERE r.workspace_id=${runtime.config.workspaceId} AND r.region=s.region AND r.topic_arn=s.topic_arn AND r.bucket=s.bucket`}) b
    WHERE NOT s.fenced OR s.binding_workspace IS NOT DISTINCT FROM b.wid
  ), env AS (SELECT b.*,addr,split_part(addr,'@',2) AS host FROM bound b CROSS JOIN jsonb_array_elements_text(b.recipients) e(addr)), matched AS MATERIALIZED (
    SELECT e.bucket,e.mid,m.workspace_id,e.addr FROM env e CROSS JOIN LATERAL (SELECT * FROM mailbox_domains m WHERE ${hosted?sql`m.receiving_host`:sql`m.name`}=e.host AND m.region=e.region AND (e.wid=m.workspace_id OR e.kind='shared') OFFSET 0) m
    WHERE ${replay?sql`e.expires_at>now() AND (e.owners->e.addr) ? m.workspace_id` : sql`NOT EXISTS (SELECT FROM mail_receipt_holds h WHERE h.bucket=e.bucket AND h.ses_message_id=e.mid AND h.binding_workspace IS NOT DISTINCT FROM e.wid AND h.topic_arn=e.topic_arn AND h.recipients ? e.addr AND (h.expires_at<=now() OR NOT (h.owners->e.addr) ? m.workspace_id))`} AND ${hosted ? sql`EXISTS (
      SELECT 1 FROM operation_domains d JOIN domain_claims dc ON dc.name=d.name AND dc.workspace_id=d.workspace_id AND dc.receiving_host=e.host AND ${claimReceives()}
      JOIN provider_connections c ON c.id=dc.connection_id AND c.workspace_id=dc.workspace_id AND c.kind=e.kind AND c.region=m.region AND ${connectionReady(sql`c`)} AND c.aws_account_id=split_part(e.topic_arn,':',5)
      AND dc.receiving_proved_at>now()-interval '72 hours' AND dc.receiving_identity_at>now()-interval '96 hours'
      AND (dc.receiving_proof_missed_at IS NULL OR dc.receiving_proof_missed_at>now()-interval '48 hours') AND (dc.receiving_lost_since IS NULL OR dc.receiving_lost_since>now()-interval '2 hours')
      WHERE d.id=m.domain_id AND d.workspace_id=m.workspace_id AND d.created_at<=e.at AND dc.created_at<=e.at AND (d.region=m.region OR
        (c.kind='shared' AND m.region='us-east-2' AND m.status='active' AND EXISTS
          (SELECT FROM domain_sending_bindings sb WHERE sb.domain_id=d.id AND sb.connection_id=c.id AND sb.region=d.region))))` : sql`m.status IN ('provisioning','waiting_for_mx','active') AND (m.parent_id IS NULL OR EXISTS (SELECT 1 FROM mailbox_domains parent WHERE parent.id=m.parent_id AND parent.workspace_id=m.workspace_id AND parent.status IN ('provisioning','waiting_for_mx','active')))`}
  ), groups AS (SELECT bucket,mid,workspace_id,jsonb_agg(DISTINCT addr ORDER BY addr) AS recipients FROM matched GROUP BY 1,2,3),
  receipts AS (INSERT INTO mail_receipts AS r(workspace_id,ses_message_id,region,bucket,object_key,recipients,notification)
    SELECT g.workspace_id,s.mid,s.region,s.bucket,'workspaces/'||g.workspace_id||'/raw/'||s.mid||'.eml',g.recipients,s.notification FROM groups g JOIN source s USING(bucket,mid) ORDER BY g.workspace_id,s.mid
    ON CONFLICT(workspace_id,ses_message_id) DO UPDATE SET recipients=(SELECT jsonb_agg(DISTINCT a ORDER BY a) FROM jsonb_array_elements_text(r.recipients||excluded.recipients) v(a)),status=CASE WHEN r.status='held' THEN 'held' ELSE 'pending' END,processed_at=NULL
    WHERE r.bucket=excluded.bucket AND r.region=excluded.region AND r.status<>'failed' AND NOT r.recipients @> excluded.recipients
      AND (SELECT count(DISTINCT a) FROM jsonb_array_elements_text(r.recipients||excluded.recipients) v(a))<=200 RETURNING workspace_id,ses_message_id,status
  ), queued AS (INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'job_'||gen_random_uuid(),'mailbox.ingest',workspace_id,jsonb_build_object('sesMessageId',ses_message_id) FROM receipts WHERE status='pending' ORDER BY workspace_id,ses_message_id RETURNING 1),
  unmatched AS (SELECT e.bucket,e.mid,jsonb_agg(DISTINCT e.addr ORDER BY e.addr) AS recipients ${replay?sql``:sql`,jsonb_object_agg(e.addr,setup.owners) AS owners`} FROM env e
    ${replay?sql``:sql`JOIN LATERAL (SELECT jsonb_agg(wid) AS owners FROM (
      SELECT m.workspace_id AS wid FROM mailbox_domains m WHERE (e.wid=m.workspace_id OR e.kind='shared') AND m.region=e.region AND (m.name=e.host OR m.receiving_host=e.host)
      ${hosted?sql`UNION SELECT dc.workspace_id FROM domain_claims dc JOIN provider_connections c ON c.id=dc.connection_id AND c.workspace_id=dc.workspace_id AND c.kind=e.kind AND c.aws_account_id=split_part(e.topic_arn,':',5)
        WHERE (dc.name=e.host OR dc.receiving_host=e.host) AND (e.wid=dc.workspace_id OR e.kind='shared') AND dc.claim_scope<>'account'`:sql``}) candidates) setup ON setup.owners IS NOT NULL`}
    WHERE NOT EXISTS(SELECT FROM matched m WHERE m.bucket=e.bucket AND m.mid=e.mid AND m.addr=e.addr) GROUP BY 1,2),
  held AS (${replay ? sql`UPDATE mail_receipt_holds h SET recipients=coalesce(u.recipients,CASE WHEN b.bucket IS NULL THEN h.recipients ELSE '[]'::jsonb END),next_check=now()+interval '50 minutes',
    status=CASE WHEN h.expires_at<=now() THEN 'failed' WHEN u.mid IS NULL AND b.bucket IS NOT NULL THEN 'released' ELSE 'held' END,
    error=CASE WHEN h.expires_at<=now() THEN 'MAILBOX_UNROUTED_HOST' END FROM source s LEFT JOIN unmatched u USING(bucket,mid) LEFT JOIN bound b USING(bucket,mid)
    WHERE h.bucket=s.bucket AND h.ses_message_id=s.mid RETURNING 1` : sql`INSERT INTO mail_receipt_holds AS h(bucket,ses_message_id,region,topic_arn,binding_workspace,received_at,expires_at,notification,recipients,owners)
    SELECT b.bucket,b.mid,b.region,b.topic_arn,b.wid,b.at,b.expires_at,b.notification,u.recipients,u.owners FROM bound b JOIN unmatched u USING(bucket,mid)
    ON CONFLICT(bucket,ses_message_id) DO UPDATE SET recipients=(SELECT jsonb_agg(DISTINCT a ORDER BY a) FROM jsonb_array_elements_text(h.recipients||excluded.recipients) v(a)),
      notification=CASE WHEN excluded.notification ? 'stagingEtag' THEN h.notification ELSE excluded.notification END,owners=excluded.owners||h.owners,status='held'
    WHERE h.binding_workspace IS NOT DISTINCT FROM excluded.binding_workspace AND h.topic_arn=excluded.topic_arn AND h.expires_at>now() AND NOT h.recipients @> excluded.recipients RETURNING 1`})
  ${replay?sql``:sql`, ignored AS (INSERT INTO mail_ignored_staging(bucket,ses_message_id) SELECT b.bucket,b.mid FROM bound b WHERE NOT EXISTS(SELECT FROM groups) AND NOT EXISTS(SELECT FROM unmatched) ON CONFLICT DO NOTHING)`}
  SELECT EXISTS(SELECT FROM bound) AS trusted,(SELECT count(*)::int FROM queued) AS n,(SELECT count(*)::int FROM held) AS held,(SELECT count(*)::int FROM source) AS seen`);
  return result.rows[0]!;
}

/** Caller verified SNS or proved the SES trace on an immutable staging object. Never persist full SNS envelopes. */
export async function acceptInboundNotification(runtime:Runtime,input:{topicArn:string;region:string;message:unknown},orphan?:{etag:string;bindingWorkspace:string|null}) {
  const message=input.message as ReceivedNotification;
  if(message?.notificationType!=='Received') { log('info',{code:'MAILBOX_NOTIFICATION_IGNORED',type:String(message?.notificationType??'unknown')}); return 0; }
  const action=message.receipt?.action,mid=message.mail?.messageId;
  const legacy=!runtime.config.multiTenant && action?.objectKey===`raw/${mid}`;
  if (!action?.bucketName || action.type!=='S3' || action.topicArn!==input.topicArn || (!legacy && action.objectKey!==STAGING_PREFIX+mid) || typeof mid!=='string' || !sesIdPattern.test(mid)) throw new ApiError(403,'MAILBOX_NOTIFICATION_UNTRUSTED','The inbound notification does not match this installation’s receiving resources.');
  const recipients=[...new Set((message.receipt?.recipients??[]).filter((s):s is string=>typeof s==='string' && /^[^@\s]+@[^@\s]+$/.test(s)).map(s=>s.toLowerCase()))];
  const {timestamp,spamVerdict,virusVerdict,spfVerdict,dkimVerdict,dmarcVerdict}=message.receipt!,common=message.mail?.commonHeaders;
  const metadata={mail:{source:message.mail?.source,timestamp:message.mail?.timestamp,commonHeaders:{from:common?.from,subject:common?.subject,messageId:common?.messageId}},receipt:{timestamp,spamVerdict,virusVerdict,spfVerdict,dkimVerdict,dmarcVerdict},legacy,stagingEtag:orphan?.etag};
  const receivedAt=timestamp??message.mail?.timestamp;
  if(runtime.config.multiTenant && (!receivedAt || !Number.isFinite(Date.parse(receivedAt)))) throw new ApiError(400,'SES_INVALID_EVENT','The receiving timestamp is missing or invalid.');
  const at=receivedAt && Number.isFinite(Date.parse(receivedAt))?new Date(receivedAt).toISOString():new Date().toISOString();
  const r=await route(runtime,sql`SELECT ${action.bucketName}::text AS bucket,${mid}::text AS mid,${input.region}::text AS region,${input.topicArn}::text AS topic_arn,${at}::timestamptz AS at,
    least(now(),${at}::timestamptz)+interval '48 hours' AS expires_at,${mailJson(metadata)}::jsonb AS notification,${mailJson(recipients)}::jsonb AS recipients,${!!orphan}::boolean AS fenced,${orphan?.bindingWorkspace??null}::text AS binding_workspace`,false);
  if(!r.trusted) throw new ApiError(403,'MAILBOX_NOTIFICATION_UNTRUSTED','Unknown receiving account, topic or bucket.');
  if(r.held) log('warn',{code:'MAILBOX_NOTIFICATION_UNROUTED_HOST',region:input.region});
  return r.n;
}

export async function recoverHeldReceipts(runtime:Runtime) {
  return (await route(runtime,sql`SELECT bucket,ses_message_id AS mid,region,topic_arn,received_at AS at,expires_at,notification,recipients,owners,true AS fenced,binding_workspace
    FROM mail_receipt_holds WHERE status='held' AND next_check<=now() ${runtime.config.multiTenant?sql``:sql`AND binding_workspace=${runtime.config.workspaceId}`}
    ORDER BY next_check,bucket,ses_message_id LIMIT 100 FOR UPDATE SKIP LOCKED`,true)).seen;
}
