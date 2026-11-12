import { createHash } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import { sql } from 'drizzle-orm';
import { ApiError, dashboardSession, errors, json, notFound, response, security, type App, type Ctx, type DbExecutor } from './core.js';
import { applyChange, type Change } from './standing.js';
import { loadStanding, scoreView, StandingSchema } from './sender-score.js';
import { clearProbe, queueCampaignRun, resumeCampaign } from './states.js';

// The operator API: Anomaly staff with a platform role act on any Hosted workspace through one audited path. The
// /operator dashboard area, Ryan's support platform (phase 2) and scripts are its clients. Roles live in
// platform_operators (granted by scripts/set-operator.ts), never a workspace role. Identity is the signed-in user:
// today a dashboard session, after #89 the same session from Anomaly sign-in, so these routes do not change.
// Hidden from the public OpenAPI document, SDK and llms docs (hide: true).

export type OperatorRole = 'operator' | 'operator:read';
export type OperatorIdentity = { userId: string; email: string; role: OperatorRole };
/** The signed-in operator, or 403. `operator` may change things; `operator:read` only reads. */
export async function operatorActor(c: Ctx, level: OperatorRole): Promise<OperatorIdentity> {
  if (!c.env.config.multiTenant) notFound('Endpoint');
  const a = c.get('actor');
  if (a?.credential !== 'dashboard') throw new ApiError(403, 'OPERATOR_REQUIRED', 'Use a signed-in operator session.');
  const { userId, email } = dashboardSession(c);
  const { rows: [row] } = await c.env.db.execute<{ role: OperatorRole }>(sql`SELECT role FROM platform_operators WHERE user_id=${userId}`);
  if (!row || (level === 'operator' && row.role !== 'operator')) throw new ApiError(403, 'OPERATOR_REQUIRED', level === 'operator' ? 'This action needs the operator role.' : 'This area is for Bane operators.');
  return { userId, email, role: row.role };
}
/** The caller's platform role for GET /v1/me, or null. One indexed read, only for a dashboard session. */
export async function operatorRole(db: DbExecutor, userId: string) {
  return (await db.execute<{ role: OperatorRole }>(sql`SELECT role FROM platform_operators WHERE user_id=${userId}`)).rows[0]?.role ?? null;
}

const Reason = z.string().trim().min(10).max(1000).describe('Why, for the audit log and the customer timeline (at least 10 characters).');
const TicketRef = z.string().trim().min(1).max(200).optional().describe('The support ticket ID or URL.');
const WorkspaceParam = z.object({ id: z.string().min(1).max(100) });
const Mutation = { 'Idempotency-Key': z.string().min(1).max(200).optional(), 'If-Match': z.string().regex(/^"?\d+"?$/).optional().describe('The standing version this action was decided on.') };
const QueueItem = z.object({ workspaceId: z.string(), name: z.string(), step: z.enum(['ok', 'notice', 'warn', 'restrict', 'pause']), since: z.string(), score: z.number().nullable(), dailyLimit: z.number().int(),
  reasons: z.array(z.object({ code: z.string(), message: z.string() })), paused: z.boolean(), quarantined: z.number().int(), watch: z.boolean(), strikes: z.number().int() }).openapi('OperatorQueueItem');
const Action = z.object({ at: z.string(), workspaceId: z.string(), action: z.string(), operatorId: z.string().nullable(), via: z.string().nullable(), reason: z.string().nullable(), ticketRef: z.string().nullable(),
  requestId: z.string().nullable(), before: z.unknown().nullable(), after: z.unknown().nullable(), details: z.unknown() }).openapi('OperatorAction');
const TimelineItem = z.object({ at: z.string(), kind: z.enum(['standing', 'limit', 'quarantine', 'release', 'tenant', 'operator', 'score', 'audit', 'bounces', 'rejection']),
  title: z.string(), detail: z.unknown() }).openapi('OperatorTimelineItem');
const WorkspaceView = z.object({ workspace: z.object({ id: z.string(), name: z.string(), createdAt: z.string() }), score: z.unknown(), standing: StandingSchema.nullable(),
  connection: z.object({ region: z.string(), paused: z.boolean(), pauseReason: z.string().nullable(), tenantStatusApplied: z.string().nullable() }).nullable(),
  domains: z.array(z.object({ name: z.string(), region: z.string().nullable(), pool: z.string(), dkim: z.boolean(), mailFrom: z.boolean(), dmarc: z.string().nullable() })),
  members: z.array(z.object({ userId: z.string(), email: z.string(), role: z.string() })), siblings: z.array(z.object({ id: z.string(), name: z.string() })),
  override: z.object({ daily: z.number().int(), expiresAt: z.string().nullable() }).nullable(), exempt: z.boolean(),
  campaigns: z.array(z.object({ id: z.string(), name: z.string(), state: z.string(), pauseReason: z.unknown().nullable(), quarantines: z.number().int() })) }).openapi('OperatorWorkspace');

type Audit = { action: string; before?: unknown; after?: unknown; reason: string; ticketRef?: string };
/** Idempotency, If-Match and the audit row around one mutation, all in one transaction. */
async function mutate<T>(c: Ctx, operator: OperatorIdentity, workspaceId: string, body: unknown, work: (tx: DbExecutor, expectVersion: number | undefined) => Promise<{ result: T; audit: Audit }>): Promise<T> {
  const key = c.req.header('Idempotency-Key'), match = c.req.header('If-Match'), expectVersion = match ? Number(match.replaceAll('"', '')) : undefined;
  const hash = createHash('sha256').update(JSON.stringify([c.req.method, c.req.path, body])).digest('hex');
  return c.env.db.transaction(async tx => {
    if (key) {
      const { rows: [prior] } = await tx.execute<{ request_hash: string; response: T }>(sql`SELECT request_hash,response FROM operator_idempotency WHERE operator_id=${operator.userId} AND key=${key} FOR UPDATE`);
      if (prior) { if (prior.request_hash !== hash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was used for a different request.'); return prior.response; }
    }
    const { result, audit } = await work(tx, expectVersion);
    await tx.execute(sql`INSERT INTO hosted_operator_audit(workspace_id,action,details,operator_id,via,reason,ticket_ref,request_id,before,after)
      VALUES(${workspaceId},${audit.action},${JSON.stringify({ operatorRole: operator.role })}::jsonb,${operator.userId},'console',${audit.reason},${audit.ticketRef ?? null},${c.get('requestId') ?? null},
        ${JSON.stringify(audit.before ?? null)}::jsonb,${JSON.stringify(audit.after ?? null)}::jsonb)`);
    if (key) await tx.execute(sql`INSERT INTO operator_idempotency(operator_id,key,request_hash,response) VALUES(${operator.userId},${key},${hash},${JSON.stringify(result)}::jsonb)`);
    return result;
  });
}
async function hostedWorkspace(db: DbExecutor, id: string) {
  const { rows: [row] } = await db.execute<{ id: string; version: number | null }>(sql`SELECT w.id,s.version FROM workspaces w JOIN provider_connections pc ON pc.workspace_id=w.id AND pc.kind='shared'
    LEFT JOIN sender_standing s ON s.workspace_id=w.id WHERE w.id=${id}`);
  return row ?? notFound('Hosted workspace');
}
const standingOf = async (db: DbExecutor, id: string) => (await db.execute<{ step: string; version: number; marketing_hold: boolean; paused: boolean }>(sql`SELECT s.step,s.version,s.marketing_hold,pc.paused_at IS NOT NULL AS paused
  FROM sender_standing s JOIN provider_connections pc ON pc.workspace_id=s.workspace_id AND pc.kind='shared' WHERE s.workspace_id=${id}`)).rows[0] ?? null;
const operatorReason = (code: string, message: string) => [{ code, metric: 'external' as const, value: 0, count: 0, threshold: 0, minimum: 0, window: null, step: 'pause' as const, message }];

export function registerOperator(app: App) {
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'get', path: '/v1/operator/workspaces', operationId: 'operatorListWorkspaces',
    request: { query: z.object({ step: z.enum(['notice', 'warn', 'restrict', 'pause']).optional(), q: z.string().trim().max(200).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }) },
    responses: { 200: response(z.object({ data: z.array(QueueItem) })), ...errors } }), async c => {
    await operatorActor(c, 'operator:read');
    const q = c.req.valid('query'), search = q.q ? `%${q.q.replace(/[\\%_]/g, m => '\\' + m)}%` : null;
    // The queue: anything above ok, watched workspaces and quarantined campaigns, most severe first. A search spans all.
    const { rows } = await c.env.db.execute<z.infer<typeof QueueItem>>(sql`SELECT w.id AS "workspaceId",w.name,s.step,s.since::text AS since,s.score::float AS score,s.daily_limit AS "dailyLimit",
        coalesce((SELECT json_agg(json_build_object('code',r->>'code','message',r->>'message')) FROM jsonb_array_elements(s.reasons) r),'[]') AS reasons,pc.paused_at IS NOT NULL AS paused,
        (SELECT count(*)::int FROM sending_campaigns sc WHERE sc.workspace_id=w.id AND sc.state='paused' AND sc.pause_reason->>'code' IN ('LIST_QUALITY','BOUNCE_RATE_HIGH','COMPLAINT_RATE_HIGH')) AS quarantined,
        s.watch,jsonb_array_length(s.strikes)::int AS strikes
      FROM sender_standing s JOIN workspaces w ON w.id=s.workspace_id JOIN provider_connections pc ON pc.workspace_id=s.workspace_id AND pc.kind='shared'
      WHERE ${search ? sql`(w.id=${q.q} OR w.name ILIKE ${search})` : q.step ? sql`s.step=${q.step}` : sql`(s.step<>'ok' OR s.watch OR EXISTS (SELECT FROM sending_campaigns sc WHERE sc.workspace_id=w.id AND sc.state='paused'
        AND sc.pause_reason->>'code' IN ('LIST_QUALITY','BOUNCE_RATE_HIGH','COMPLAINT_RATE_HIGH')))`}
      ORDER BY CASE s.step WHEN 'pause' THEN 0 WHEN 'restrict' THEN 1 WHEN 'warn' THEN 2 WHEN 'notice' THEN 3 ELSE 4 END,s.since LIMIT ${q.limit}`);
    return c.json({ data: rows }, 200);
  });
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'get', path: '/v1/operator/workspaces/{id}', operationId: 'operatorGetWorkspace', request: { params: WorkspaceParam },
    responses: { 200: response(WorkspaceView), ...errors } }), async c => {
    await operatorActor(c, 'operator:read');
    const wid = c.req.valid('param').id;
    await hostedWorkspace(c.env.db, wid);
    const score = scoreView(await loadStanding(c.env, wid));
    const { rows: [row] } = await c.env.db.execute<z.infer<typeof WorkspaceView>>(sql`SELECT
      (SELECT json_build_object('id',id,'name',name,'createdAt',created_at) FROM workspaces WHERE id=${wid}) AS workspace,
      (SELECT json_build_object('region',region,'paused',paused_at IS NOT NULL,'pauseReason',pause_reason,'tenantStatusApplied',tenant_status_applied) FROM provider_connections WHERE workspace_id=${wid} AND kind='shared') AS connection,
      coalesce((SELECT json_agg(json_build_object('name',dc.name,'region',b.region,'pool',coalesce(t.tier,'probation'),
        'dkim',coalesce(dc.identity #>> '{ses,DkimAttributes,Status}'='SUCCESS',false),'mailFrom',coalesce(dc.identity #>> '{ses,MailFromAttributes,MailFromDomainStatus}'='SUCCESS',false),'dmarc',dc.identity #>> '{dmarc,status}') ORDER BY dc.name)
        FROM domain_claims dc LEFT JOIN domain_sending_bindings b USING(workspace_id,name,connection_id) LEFT JOIN hosted_domain_tiers t ON t.connection_id=dc.connection_id AND t.name=dc.name
        WHERE dc.workspace_id=${wid}),'[]') AS domains,
      coalesce((SELECT json_agg(json_build_object('userId',m.user_id,'email',u.email,'role',m.role) ORDER BY m.role,u.email) FROM workspace_members m JOIN auth_user u ON u.id=m.user_id WHERE m.workspace_id=${wid}),'[]') AS members,
      coalesce((SELECT json_agg(json_build_object('id',o.id,'name',o.name) ORDER BY o.created_at) FROM workspaces me JOIN workspaces o ON o.quota_sponsor=me.quota_sponsor AND o.id<>me.id WHERE me.id=${wid} AND me.quota_sponsor IS NOT NULL),'[]') AS siblings,
      (SELECT CASE WHEN send_cap_override IS NOT NULL THEN json_build_object('daily',send_cap_override,'expiresAt',send_cap_override_expires_at) END FROM workspaces WHERE id=${wid}) AS override,
      (SELECT exempt_hosted_quotas FROM workspaces WHERE id=${wid}) AS exempt,
      coalesce((SELECT json_agg(x) FROM (SELECT id,coalesce(draft->>'name',id) AS name,state,pause_reason AS "pauseReason",quarantines FROM sending_campaigns
        WHERE workspace_id=${wid} AND (quarantines>0 OR state IN ('sending','paused','scheduled')) ORDER BY updated_at DESC LIMIT 20) x),'[]') AS campaigns`);
    return c.json({ ...row!, score, standing: score.standing }, 200);
  });
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'get', path: '/v1/operator/workspaces/{id}/timeline', operationId: 'operatorWorkspaceTimeline',
    request: { params: WorkspaceParam, query: z.object({ before: z.iso.datetime().optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }) },
    responses: { 200: response(z.object({ data: z.array(TimelineItem), nextBefore: z.string().nullable() })), ...errors } }), async c => {
    await operatorActor(c, 'operator:read');
    const wid = c.req.valid('param').id, q = c.req.valid('query'), before = q.before ?? new Date(Date.now() + 60_000).toISOString();
    await hostedWorkspace(c.env.db, wid);
    // One stream: standing events, operator actions, the daily score, hourly hard bounces and complaints by recipient
    // domain (never an address), and screen rejections with their spam score and subject. No message bodies.
    const { rows } = await c.env.db.execute<z.infer<typeof TimelineItem>>(sql`SELECT * FROM (
      SELECT at::text AS at,CASE kind WHEN 'step' THEN 'standing' ELSE kind END AS kind,
        CASE WHEN from_step IS DISTINCT FROM to_step THEN coalesce(from_step,'?')||' → '||to_step WHEN kind='limit' AND details ? 'from' THEN 'Daily limit '||(details->>'from')||' → '||(details->>'to')
          WHEN kind='limit' THEN 'Limit override changed' ELSE kind||' ('||(actor->>'kind')||')' END AS title,
        jsonb_build_object('reasons',reasons,'actor',actor,'details',details,'sequence',sequence) AS detail FROM standing_events WHERE workspace_id=${wid} AND at<${before}::timestamptz
      UNION ALL SELECT at::text,'audit',action,jsonb_build_object('operatorId',operator_id,'via',via,'reason',coalesce(reason,details->>'reason'),'ticketRef',ticket_ref,'before',before,'after',after)
        FROM hosted_operator_audit WHERE workspace_id=${wid} AND at<${before}::timestamptz
      UNION ALL SELECT (day::timestamp AT TIME ZONE 'UTC')::text,'score','Score '||coalesce(round(score,1)::text,'calibrating')||' · limit '||coalesce(daily_limit::text,'?'),
        jsonb_build_object('accepted',accepted,'bounced',bounced,'complained',complained,'rejected',rejected,'quality',quality,'target',target,'step',step)
        FROM sender_score_daily WHERE workspace_id=${wid} AND (day::timestamp AT TIME ZONE 'UTC')<${before}::timestamptz AND day>(now() AT TIME ZONE 'UTC')::date-60
      UNION ALL SELECT hour::text,'bounces',sum(b)||' hard bounces, '||sum(cpl)||' complaints at '||domain,jsonb_build_object('domain',domain,'bounces',sum(b),'complaints',sum(cpl)) FROM (
        SELECT date_trunc('hour',e.created_at,'UTC') AS hour,lower(split_part(e.to_addresses->>0,'@',2)) AS domain,(e.status='bounced' OR e.event_outcomes & 4 <> 0)::int AS b,(e.status='complained' OR e.event_outcomes & 8 <> 0)::int AS cpl
        FROM sending_emails e WHERE e.workspace_id=${wid} AND NOT e.simulated AND e.created_at>now()-interval '7 days' AND e.created_at<${before}::timestamptz AND (e.status IN ('bounced','complained') OR e.event_outcomes & 12 <> 0)) x
        GROUP BY hour,domain
      UNION ALL SELECT e.created_at::text,'rejection','Screen rejected: '||left(e.subject,120),jsonb_build_object('spam',v.data->'screen'->'spam','model',v.data->'screen'->'model','campaignId',e.campaign_id,'emailId',e.id)
        FROM sending_emails e LEFT JOIN LATERAL (SELECT data FROM sending_email_events WHERE workspace_id=e.workspace_id AND email_id=e.id AND type='reject' ORDER BY created_at DESC LIMIT 1) v ON true
        WHERE e.workspace_id=${wid} AND e.error_code='CONTENT_REJECTED_SPAM' AND e.created_at>now()-interval '7 days' AND e.created_at<${before}::timestamptz
    ) t ORDER BY at DESC LIMIT ${q.limit + 1}`);
    return c.json({ data: rows.slice(0, q.limit), nextBefore: rows.length > q.limit ? rows[q.limit - 1]!.at : null }, 200);
  });

  const MutationBody = z.object({ reason: Reason, ticketRef: TicketRef }).strict();
  const done = z.object({ ok: z.literal(true), version: z.number().int().nullable(), step: z.string().nullable() });
  const change = async (c: Ctx, wid: string, body: { reason: string; ticketRef?: string }, action: string, build: (current: NonNullable<Awaited<ReturnType<typeof standingOf>>>) => Omit<Change, 'workspaceId' | 'actor' | 'expectVersion'>) => {
    const operator = await operatorActor(c, 'operator');
    await hostedWorkspace(c.env.db, wid);
    return mutate(c, operator, wid, body, async (tx, expectVersion) => {
      const before = await standingOf(tx, wid);
      if (!before) notFound('Hosted workspace');
      const result = await applyChange(tx, { workspaceId: wid, actor: { kind: 'operator', id: operator.userId, via: 'console' }, expectVersion, ...build(before!),
        details: { reason: body.reason, ...(body.ticketRef ? { ticketRef: body.ticketRef } : {}), ...build(before!).details } });
      const after = await standingOf(tx, wid);
      return { result: { ok: true as const, version: result?.version ?? null, step: result?.step ?? null }, audit: { action, before, after, reason: body.reason, ticketRef: body.ticketRef } };
    });
  };
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'post', path: '/v1/operator/workspaces/{id}/pause', operationId: 'operatorPauseWorkspace', request: { params: WorkspaceParam, headers: z.object(Mutation), body: json(MutationBody) },
    responses: { 200: response(done), ...errors } }), async c => {
    const body = c.req.valid('json'), wid = c.req.valid('param').id;
    return c.json(await change(c, wid, body, 'operator-pause', current => {
      if (current.paused) throw new ApiError(409, 'ALREADY_PAUSED', 'This workspace is already paused.');
      // The reason is for the audit and the operator timeline; customers see that Bane paused it after a review.
      return { kind: 'operator', step: 'pause', pauseKind: 'full', pause: { message: 'Hosted sending paused by Bane after a review. Ask for a review from the dashboard for details.' }, reasons: operatorReason('OPERATOR_PAUSE', 'Bane paused sending after a review.') };
    }), 200);
  });
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'post', path: '/v1/operator/workspaces/{id}/resume', operationId: 'operatorResumeWorkspace',
    request: { params: WorkspaceParam, headers: z.object(Mutation), body: json(z.object({ reason: Reason, ticketRef: TicketRef, restore: z.union([z.literal(50), z.literal(100)]).default(50) }).strict()) },
    responses: { 200: response(done), ...errors } }), async c => {
    const body = c.req.valid('json'), wid = c.req.valid('param').id;
    return c.json(await change(c, wid, body, 'operator-resume', current => {
      if (!current.paused) throw new ApiError(409, 'NOT_PAUSED', 'This workspace is not paused.');
      return { kind: 'operator', step: 'warn', resume: { percent: body.restore }, details: { restore: body.restore } };
    }), 200);
  });
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'put', path: '/v1/operator/workspaces/{id}/marketing', operationId: 'operatorSetMarketingHold',
    request: { params: WorkspaceParam, headers: z.object(Mutation), body: json(z.object({ held: z.boolean(), reason: Reason, ticketRef: TicketRef }).strict()) },
    responses: { 200: response(done), ...errors } }), async c => {
    const body = c.req.valid('json'), wid = c.req.valid('param').id;
    return c.json(await change(c, wid, body, body.held ? 'operator-hold-marketing' : 'operator-release-marketing', current => body.held
      ? { kind: 'operator', marketingHold: true, step: current.step === 'pause' ? 'pause' : 'restrict', reasons: current.step === 'pause' ? undefined : [{ ...operatorReason('OPERATOR_HOLD', 'Bane holds marketing after a review.')[0]!, step: 'restrict' }] }
      : { kind: 'operator', marketingHold: false, step: current.step === 'restrict' ? 'warn' : current.step as Change['step'] }), 200);
  });
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'put', path: '/v1/operator/workspaces/{id}/limit', operationId: 'operatorSetLimit',
    request: { params: WorkspaceParam, headers: z.object(Mutation), body: json(z.object({ daily: z.number().int().min(1).max(10_000_000).nullable().describe('null returns the workspace to the score limit.'),
      expiresAt: z.iso.datetime().nullable().optional().describe('When the override ends (at most a year ahead); omit or null for no expiry.'), reason: Reason, ticketRef: TicketRef }).strict()) },
    responses: { 200: response(done), ...errors } }), async c => {
    const body = c.req.valid('json'), wid = c.req.valid('param').id;
    if (body.expiresAt && (Date.parse(body.expiresAt) <= Date.now() || Date.parse(body.expiresAt) > Date.now() + 366 * 86_400_000)) throw new ApiError(422, 'INVALID_EXPIRY', 'Choose an expiry between now and a year from now.', 'expiresAt');
    const operator = await operatorActor(c, 'operator');
    await hostedWorkspace(c.env.db, wid);
    return c.json(await mutate(c, operator, wid, body, async (tx, expectVersion) => {
      const current = await standingOf(tx, wid);
      if (expectVersion !== undefined && current && current.version !== expectVersion) throw new ApiError(412, 'STANDING_VERSION_CHANGED', `The standing changed since version ${expectVersion} (now ${current.version}).`);
      const { rows: [before] } = await tx.execute<{ daily: number | null; expiresAt: string | null }>(sql`SELECT send_cap_override AS daily,send_cap_override_expires_at AS "expiresAt" FROM workspaces WHERE id=${wid} FOR UPDATE`);
      await tx.execute(sql`UPDATE workspaces SET send_cap_override=${body.daily},send_cap_override_expires_at=${body.daily === null ? null : body.expiresAt ?? null}::timestamptz WHERE id=${wid}`);
      await tx.execute(sql`WITH s AS (UPDATE sender_standing SET sequence=sequence+1 WHERE workspace_id=${wid} RETURNING workspace_id,sequence,step)
        INSERT INTO standing_events(id,workspace_id,sequence,kind,from_step,to_step,actor,details) SELECT 'stev_'||replace(gen_random_uuid()::text,'-',''),workspace_id,sequence,'limit',step,step,
          ${JSON.stringify({ kind: 'operator', id: operator.userId, via: 'console' })}::jsonb,${JSON.stringify({ override: { from: before, to: { daily: body.daily, expiresAt: body.expiresAt ?? null } }, reason: body.reason })}::jsonb FROM s`);
      return { result: { ok: true as const, version: current?.version ?? null, step: current?.step ?? null }, audit: { action: 'operator-set-limit', before, after: { daily: body.daily, expiresAt: body.expiresAt ?? null }, reason: body.reason, ticketRef: body.ticketRef } };
    }), 200);
  });
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'post', path: '/v1/operator/campaigns/{id}/release', operationId: 'operatorReleaseCampaign',
    request: { params: WorkspaceParam, headers: z.object(Mutation), body: json(MutationBody) }, responses: { 200: response(done), ...errors } }), async c => {
    const body = c.req.valid('json'), campaignId = c.req.valid('param').id;
    const operator = await operatorActor(c, 'operator');
    const { rows: [campaign] } = await c.env.db.execute<{ workspace_id: string; state: string; expanded: number; request_id: string | null; scheduled_at: string | null; pause_reason: { code: string } | null; quarantines: number; name: string }>(sql`SELECT c.workspace_id,c.state,c.expanded,c.request_id,c.scheduled_at,c.pause_reason,c.quarantines,coalesce(c.draft->>'name',c.id) AS name
      FROM sending_campaigns c JOIN provider_connections pc ON pc.workspace_id=c.workspace_id AND pc.kind='shared' WHERE c.id=${campaignId}`);
    if (!campaign) notFound('Campaign');
    if (campaign!.state !== 'paused') throw new ApiError(409, 'CAMPAIGN_NOT_PAUSED', 'Only a paused campaign can be released.');
    const wid = campaign!.workspace_id, ref = { workspaceId: wid, id: campaignId };
    return c.json(await mutate(c, operator, wid, body, async tx => {
      const next = campaign!.scheduled_at && Date.parse(campaign!.scheduled_at) > Date.now() && campaign!.expanded === 0 ? 'scheduled' as const : 'sending' as const;
      if (!(await tx.execute(resumeCampaign(ref, next))).rows.length) throw new ApiError(409, 'CAMPAIGN_LOCKED', 'The campaign changed meanwhile; reload it.');
      await tx.execute(clearProbe(ref));
      await tx.execute(queueCampaignRun(ref, campaign!.request_id ? { requestId: campaign!.request_id } : {}, next === 'scheduled' ? campaign!.scheduled_at : null));
      const result = await applyChange(tx, { workspaceId: wid, actor: { kind: 'operator', id: operator.userId, via: 'console' }, kind: 'release', details: { campaignId, campaignName: campaign!.name, reason: body.reason } });
      return { result: { ok: true as const, version: result?.version ?? null, step: result?.step ?? null }, audit: { action: 'operator-release-campaign', before: { campaignId, pauseReason: campaign!.pause_reason, quarantines: campaign!.quarantines }, after: { campaignId, state: next }, reason: body.reason, ticketRef: body.ticketRef } };
    }), 200);
  });
  app.openapi(createRoute({ hide: true, tags: ['Operator'], security, method: 'get', path: '/v1/operator/actions', operationId: 'operatorListActions',
    request: { query: z.object({ workspaceId: z.string().max(100).optional(), operator: z.string().max(100).optional(), before: z.iso.datetime().optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }) },
    responses: { 200: response(z.object({ data: z.array(Action) })), ...errors } }), async c => {
    await operatorActor(c, 'operator:read');
    const q = c.req.valid('query');
    const { rows } = await c.env.db.execute<z.infer<typeof Action>>(sql`SELECT at::text AS at,workspace_id AS "workspaceId",action,operator_id AS "operatorId",via,coalesce(reason,details->>'reason') AS reason,
      ticket_ref AS "ticketRef",request_id AS "requestId",before,after,details FROM hosted_operator_audit
      WHERE true ${q.workspaceId ? sql`AND workspace_id=${q.workspaceId}` : sql``} ${q.operator ? sql`AND operator_id=${q.operator}` : sql``} ${q.before ? sql`AND at<${q.before}::timestamptz` : sql``}
      ORDER BY at DESC LIMIT ${q.limit}`);
    return c.json({ data: rows }, 200);
  });
}
