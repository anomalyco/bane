import {sql,type SQLWrapper} from 'drizzle-orm';
import type {ReadyConnection} from './provider-credentials.js';
import type {Config} from './core.js';

export const receivingPolicy=(c:Config)=>JSON.stringify({resource:new URL('/mcp',c.publicUrl).href,issuer:c.accountIssuer,hosted:c.multiTenant,subjects:c.allowedSubjects});

export function storageBinding(wid:string|SQLWrapper,region:string|SQLWrapper,bucket:string|SQLWrapper) {
  return sql<ReadyConnection|null>`(SELECT to_jsonb(matched) FROM (
      SELECT 'shared' AS kind,NULL AS id,aws_account_id,NULL AS role_arn,NULL::uuid AS external_id,NULL::text AS template_version,false AS kept_policy_v1 FROM provider_pool_regions
      WHERE region=${region} AND inbound_bucket=${bucket}
      UNION ALL SELECT c.kind,c.id,c.aws_account_id,c.role_arn,c.external_id,c.template_version,EXISTS(SELECT FROM mail_kept_policy_v1 k WHERE k.connection_id=c.id AND k.role_arn=c.role_arn AND k.region=c.region AND k.bucket=mr.bucket) FROM provider_connections c JOIN mailbox_regions mr
      ON mr.workspace_id=c.workspace_id AND mr.region=c.region AND mr.account_id=c.aws_account_id
      WHERE c.workspace_id=${wid} AND c.region=${region} AND c.kind='byo' AND c.template_version<>'v5' AND c.state='ready' AND mr.bucket=${bucket}) matched)`;
}
export type IngestInput={routing?:import('./routing-match.js').RoutingInput|null;region:string;bucket:string;objectKey:string;recipients:string[];notification:Record<string,unknown>;createdAt:string;spamPolicy:string;delivery?:{lifecycle:string;prefixInbox:string|null;drop:boolean;owners:(string|null)[]};binding:ReadyConnection|null};
export const ingestInput=(config:Config,wid:SQLWrapper|string,mid:SQLWrapper|string)=>sql<IngestInput|null>`(SELECT to_jsonb(input) FROM (SELECT r.region,r.bucket,r.object_key AS "objectKey",r.recipients,r.notification,r.created_at AS "createdAt",coalesce(p.spam_policy,'store') AS "spamPolicy",
  ${config.multiTenant?storageBinding(sql`r.workspace_id`,sql`r.region`,sql`r.bucket`):sql`NULL`} AS binding,public.inbox_delivery(r.workspace_id,r.recipients) AS delivery,mail_route_input(r.workspace_id,r.recipients,false,${receivingPolicy(config)}::jsonb) AS routing FROM mail_receipts r LEFT JOIN mail_receive_limits p USING(workspace_id) WHERE r.workspace_id=${wid} AND r.ses_message_id=${mid} AND r.status='pending') input)`;
