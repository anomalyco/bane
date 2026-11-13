import { sql } from 'drizzle-orm';
import { type Actor, type Runtime } from './core.js';
import { hostedAllowance, type HostedAllowance } from './hosted-sending.js';
import type { IdentityFacts } from './states.js';
import { dmarcView } from './dmarc.js';
import { cachedDashboardRead } from './dashboard-cache.js';
import { loadStanding, scoreView } from './sender-score.js';

export type CheckContext = {
  domain?: { verified: boolean; dkim?: boolean; mailFrom?: boolean; spf?: boolean; fromSpf?: boolean; dmarc?: string; rua?: boolean; ageDays?: number; pool?: string };
  standing?: {score: number | null; warmup: boolean; accepted: number; bounced: number; complained: number; daily: number | null};
};
// Never run placement probes, look up remote assets or lock admission rows.
// Fresh facts for the exact From only: a parent's DMARC record does not prove the subdomain has no override.
export async function checkContext(runtime: Runtime, a: Actor, fromDomain: string): Promise<CheckContext> {
  type Row = {identity: IdentityFacts | null; state: string; age: number | null; pool: string | null; from_spf: boolean | null};
  const domainRead = runtime.db.execute<Row>(sql`SELECT c.identity,c.sending_state AS state,
    (s.signals->>'ageDays')::int + floor(extract(epoch FROM now()-s.started_at)/86400)::int AS age,
    CASE WHEN s.started_at>now()-interval '48 hours' THEN (s.signals #>> '{exact,spf}')::boolean END AS from_spf,
    CASE WHEN pc.kind='shared' THEN coalesce(p.pool_tier,'probation') END AS pool
    FROM domain_claims c LEFT JOIN domain_sending_bindings b ON (b.workspace_id,b.name)=(c.workspace_id,c.name)
    LEFT JOIN domain_placement_shadow s ON s.domain_id=b.domain_id LEFT JOIN provider_connections pc ON pc.id=c.connection_id
    LEFT JOIN provider_pool_regions p ON p.region=b.region WHERE c.workspace_id=${a.workspaceId} AND c.name=${fromDomain}`);
  type Standing = { score: string | null; phase: string | null; accepted: number; bounced: number; complained: number; allowance: HostedAllowance | null };
  // Match getSenderScore's workspace boundary. Scoped readers can check their own mail, not infer workspace totals.
  const standingRead = !a.domains.length && runtime.config.multiTenant ? runtime.db.execute<Standing>(sql`SELECT st.score,st.phase,
    mail.*, ${hostedAllowance(runtime.config,a.workspaceId,0,0,true)} AS allowance FROM provider_connections pc
    LEFT JOIN sender_standing st ON st.workspace_id=pc.workspace_id CROSS JOIN LATERAL (
      SELECT coalesce(sum(accepted),0)::int AS accepted,coalesce(sum(bounced),0)::int AS bounced,coalesce(sum(complained),0)::int AS complained
      FROM sender_score_daily WHERE workspace_id=pc.workspace_id AND day>(now() AT TIME ZONE 'UTC')::date-7) mail
    WHERE pc.workspace_id=${a.workspaceId} AND pc.kind='shared'`) : undefined;
  const [domain, standing] = await Promise.all([domainRead, standingRead]);
  const d=domain.rows[0], s=standing?.rows[0], ses=d?.identity?.ses, dm=ses && dmarcView(d?.identity?.dmarc,ses);
  // Self-hosted/BYO has no persisted grade. Share the sender-score projection, cache only workspace aggregates
  // (never message content), and only compute for the unrestricted readers entitled to that projection.
  let rep:CheckContext['standing'];
  if (s) rep={score:s.score===null ? null : Number(s.score),warmup:s.phase!=='graded',accepted:s.accepted,bounced:s.bounced,complained:s.complained,daily:s.allowance?.cap??null};
  else if (!a.domains.length) rep=(await cachedDashboardRead(runtime.config.publicUrl,`check-standing:${a.workspaceId}`,async()=>{
    const row=await loadStanding(runtime,a.workspaceId), view=scoreView(row);
    const start=new Date(Date.now()-6*86400000).toISOString().slice(0,10), recent=(row.days??[]).filter(day=>day.day>=start);
    return {score:view.score,warmup:view.state==='warmup',daily:null,...recent.reduce((n,d)=>({accepted:n.accepted+d.accepted,bounced:n.bounced+d.bounced,complained:n.complained+d.complained}),{accepted:0,bounced:0,complained:0})};
  },60)).value;
  return {domain: d && {verified: d.state==='verified', dkim: ses?.DkimAttributes ? ses.DkimAttributes.SigningEnabled===true && ses.DkimAttributes.Status==='SUCCESS' : undefined,
    mailFrom: ses && !!ses.MailFromAttributes?.MailFromDomain, spf: dm?.alignment.spf, fromSpf:d?.from_spf??undefined, dmarc: dm?.status,
    rua: dm?.record ? /(?:^|;)\s*rua\s*=\s*mailto:/i.test(dm.record) : undefined, ageDays: d.age ?? undefined, pool: d.pool ?? undefined},
    standing: rep};
}
