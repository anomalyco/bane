import { createRoute, z } from '@hono/zod-openapi';
import { sql, and, eq } from 'drizzle-orm';
import { ApiError, digest, errors, id, json, randomSecret, response, security, type App, type Ctx, type ClaimedWebhook, type DbExecutor, type Runtime } from './core.js';
import { claimSends } from './states.js';
import { mailboxes, mailMessages, mailboxWebhooks, retainedMail } from './db/mailbox.js';
import { ritualAdmin, ownReceiving } from './rituals.js';
import { encrypt, decrypt, encryptWebhookHeaders, postWebhook, WebhookHeaders, webhookSecret, webhookUrl } from './operations.js';
import { webhookSecretBinding } from './mailbox-events.js';
import { lockMailboxLane } from './mailbox-store.js';
import { sendFromMailbox } from './mailbox-send.js';
import { endpointPolicy, DEFAULT_POLICY } from './ritual-retry.js';
import { endpointCall, endpointPayloads, type EndpointType } from './ritual-schema.js';

const base = '/v1/endpoints',
  meta = { security, tags: ['Endpoints'] },
  types = ['slack', 'discord', 'webhook', 'forward'] as const,
  Name = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).describe('Endpoint name, unique in the workspace across every type. Rituals call endpoints.<name>(…).'),
  Status = z.enum(['ready', 'pending', 'expired', 'declined', 'paused']).describe('ready: callable. pending: a forward waiting for its recipient to confirm. expired: the confirmation link lapsed. declined: the recipient declined or stopped forwards. paused: deliveries are held.'),
  Policy = z.object({
    perMinute: z.number().int().min(1).max(6000).describe('Calls per minute; extra calls wait for the next minute.'),
    retryOnTimeout: z.boolean().describe('Replay an attempt whose outcome is unknown (timeout, dropped connection). Off by default for chat and webhooks; always on for forwards.'),
    idempotent: z.boolean().describe('The receiver deduplicates by the Idempotency-Key header, so unknown outcomes are replayed. Webhooks only.'),
  }).openapi('EndpointPolicy');
export const Endpoint = z.object({
  name: Name,
  type: z.enum(types),
  status: Status,
  call: z.string().describe('How a ritual calls it.'),
  target: z.string().describe('Where it delivers. Chat credentials are masked; they are write-only.'),
  policy: Policy,
  expiresAt: z.string().nullable().describe('When a pending forward confirmation link expires.'),
  nextStep: z.string().describe('What to do next, for people and agents.'),
  createdAt: z.string(),
}).openapi('Endpoint');
const Url = z.string().max(2048);
const CreateEndpoint = z.discriminatedUnion('type', [
  z.object({ type: z.literal('slack'), name: Name, url: Url.describe('Slack incoming webhook URL (https://hooks.slack.com/services/…). Stored encrypted and never returned.') }).strict(),
  z.object({ type: z.literal('discord'), name: Name, url: Url.describe('Discord webhook URL (https://discord.com/api/webhooks/…). Stored encrypted and never returned.') }).strict(),
  z.object({
    type: z.literal('webhook'), name: Name, url: Url.describe('Public HTTPS URL that receives signed JSON events.'),
    headers: WebhookHeaders.optional(), timeoutSeconds: z.number().int().min(1).max(30).optional(), retryAttempts: z.number().int().min(0).max(10).optional(),
  }).strict(),
  z.object({
    type: z.literal('forward'), name: Name, address: z.email().max(254).toLowerCase().describe('Recipient. They confirm with an emailed link unless preverify applies.'),
    from: z.string().max(254).optional().describe('Receiving address ID (mbx_…) or address that sends the confirmation request. Defaults to the oldest permanent receiving address.'),
    preverify: z.boolean().default(false).describe('Skip the emailed confirmation. Only for addresses on a domain this workspace has verified.'),
  }).strict(),
]).openapi('CreateEndpoint');
const UpdateEndpoint = Policy.partial().extend({
  paused: z.boolean().optional().describe('Hold deliveries. Queued calls resume when unpaused.'),
  url: Url.optional().describe('Replace a Slack, Discord or webhook URL.'),
}).strict().openapi('UpdateEndpoint');
const NameParam = z.object({ name: Name });

export function pinnedUrl(type: string, value: string) {
  const pattern =
    type === 'slack'
      ? /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/
      : /^https:\/\/discord\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+$/;
  if (!pattern.test(value) || value.trim() !== value)
    throw new ApiError(422, 'INVALID_CONNECTOR', type === 'slack' ? 'Use the Slack incoming webhook URL: https://hooks.slack.com/services/…' : 'Use the Discord webhook URL: https://discord.com/api/webhooks/…', 'url');
  return value;
}
/** Chat payloads become plain text: no mentions, no markup and no link unfurls. */
export function renderChat(type: string, body: unknown) {
  const k = type === 'slack' ? 'text' : 'content';
  const fail = () => new ApiError(422, 'INVALID_CONNECTOR_MESSAGE', `endpoints.<name>() for ${type} takes { ${k}: "…" }.`);
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1) throw fail();
  const s = (body as Record<string, unknown>)[k];
  if (typeof s !== 'string' || !s.length) throw fail();
  return type === 'slack'
    ? { text: s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').slice(0, 3000), mrkdwn: false, unfurl_links: false, unfurl_media: false }
    : { content: s.replace(/([\\*_~`|>\[\]()#])/g, '\\$1').replace(/^(\s*)-/gm,'$1\\-').slice(0, 2000), allowed_mentions: { parse: [] }, flags:4 };
}

type Row = {
  name: string; type: EndpointType; hook_id: string; verified: boolean; expires_at: string | Date | null; declined_at: string | Date | null;
  created_at: string | Date; paused: boolean; encrypted_value: string | null; url: string | null;
  per_minute: number | null; retry_on_timeout: boolean | null; idempotent: boolean | null;
};
const iso = (v: string | Date | null) => (v === null ? null : new Date(v).toISOString());
/** All endpoints of a workspace: Slack, Discord and forwards in mail_endpoints, plus keyed webhooks. One name space. */
async function endpointRows(db: DbExecutor, w: string, q: { name?: string; cursor?: string; type?: string; limit?: number } = {}) {
  return (await db.execute<Row>(sql`WITH e AS (
      SELECT split_part(d.ref,':',2) AS name,split_part(d.ref,':',1) AS type,d.hook_id,d.verified,d.expires_at,d.declined_at,d.created_at,h.paused,d.encrypted_value,NULL::text AS url
      FROM mail_endpoints d JOIN mailbox_webhooks h ON h.workspace_id=d.workspace_id AND h.id=d.hook_id WHERE d.workspace_id=${w}
      UNION ALL
      SELECT h.key,'webhook',h.id,true,NULL,NULL,h.created_at,h.paused,NULL,h.url FROM mailbox_webhooks h
      WHERE h.workspace_id=${w} AND h.key IS NOT NULL AND NOT starts_with(h.id,'con_'))
    SELECT e.*,p.per_minute,p.retry_on_timeout,p.idempotent FROM e LEFT JOIN mail_action_policies p ON p.workspace_id=${w} AND p.hook_id=e.hook_id
    WHERE (${q.name ?? null}::text IS NULL OR e.name=${q.name ?? null}) AND (${q.cursor ?? null}::text IS NULL OR e.name>${q.cursor ?? null}) AND (${q.type ?? null}::text IS NULL OR e.type=${q.type ?? null})
    ORDER BY e.name LIMIT ${(q.limit ?? 500) + 1}`)).rows;
}
async function view(runtime: Runtime, w: string, r: Row): Promise<z.infer<typeof Endpoint>> {
  const policy = endpointPolicy(r.type, r), call = endpointCall(r.name);
  const value = r.encrypted_value ? await decrypt(runtime, r.encrypted_value, w + ':endpoint:' + r.hook_id) : null;
  const target = r.type === 'webhook' ? r.url! : r.type === 'forward' ? value! : `${r.type === 'slack' ? 'Slack incoming webhook' : 'Discord webhook'} ••••${value!.slice(-4)}`;
  const expired = r.type === 'forward' && !r.verified && !r.declined_at && r.expires_at !== null && new Date(r.expires_at).getTime() <= Date.now();
  const status = r.paused ? 'paused' : r.declined_at ? 'declined' : r.verified ? 'ready' : expired ? 'expired' : 'pending';
  const payload = endpointPayloads[r.type].signature(r.name).replace(/^endpoints\.[^(]+/, call);
  const nextStep = {
    ready: `Call it from a ritual: ${payload}.`,
    pending: `Waiting for ${target} to open the confirmation link (expires ${iso(r.expires_at)}). Only the recipient can confirm. Resend with sendEndpointVerification if it was lost.`,
    expired: `The confirmation link expired. Send a new one with sendEndpointVerification.`,
    declined: `${target} declined or stopped forwards. A new request is possible 30 days after ${iso(r.declined_at)}.`,
    paused: `Deliveries are held. Resume with updateEndpoint { "paused": false }.`,
  }[status];
  return { name: r.name, type: r.type, status, call, target, policy, expiresAt: status === 'pending' || status === 'expired' ? iso(r.expires_at) : null, nextStep, createdAt: iso(r.created_at)! };
}
async function findEndpoint(db: DbExecutor, w: string, name: string) {
  const row = (await endpointRows(db, w, { name, limit: 1 }))[0];
  if (!row) throw new ApiError(404, 'NOT_FOUND', `No endpoint named ${name}. List them with listEndpoints.`);
  return row;
}
/** Endpoint names are one name space across chat, forward and keyed webhook endpoints. Caller holds the address lane. */
export async function assertEndpointName(tx: DbExecutor, w: string, name: string, exceptHook = '', webhooks = true) {
  const taken = await tx.execute(sql`SELECT FROM mail_endpoints WHERE workspace_id=${w} AND split_part(ref,':',2)=${name} AND hook_id<>${exceptHook}
    UNION ALL SELECT FROM mailbox_webhooks WHERE ${webhooks} AND workspace_id=${w} AND key=${name} AND id<>${exceptHook} LIMIT 1`);
  if (taken.rowCount) throw new ApiError(409, 'ENDPOINT_NAME_TAKEN', `Another endpoint is already named ${name}. Names are shared by Slack, Discord, webhook and forward endpoints.`, 'name');
}
async function debit(tx: DbExecutor, w: string, key: string, limit: number, window: 'day' | 'hour', message = 'Forwarding budget reached for this window.') {
  const charge = await tx.execute(sql`INSERT INTO api_request_budgets AS b(workspace_id,key_id,window_start,used) VALUES(${w},${key},date_trunc(${window},now()),1)
    ON CONFLICT(workspace_id,key_id) DO UPDATE SET used=CASE WHEN b.window_start=excluded.window_start THEN b.used+1 ELSE 1 END,window_start=excluded.window_start
    WHERE b.window_start<>excluded.window_start OR b.used<${limit} RETURNING 1`);
  if (!charge.rowCount) throw new ApiError(429, 'FORWARD_LIMIT', message, undefined, true);
}
async function checkExternal(tx: DbExecutor, w: string, address: string) {
  if ((await tx.execute(sql`SELECT FROM mailbox_domains WHERE workspace_id=${w} AND coalesce(receiving_host,name)=split_part(${address},'@',2) LIMIT 1`)).rowCount)
    throw new ApiError(422, 'FORWARD_LOOP', 'Cannot forward to a receiving host of this workspace; mail would loop.', 'address');
}
/** The address is on a domain this workspace has proven it controls (a verified sending domain or a subdomain of one). */
async function ownVerifiedDomain(runtime: Runtime, tx: DbExecutor, w: string, address: string) {
  const host = address.split('@')[1]!;
  const found = runtime.config.multiTenant
    ? await tx.execute(sql`SELECT FROM domain_claims dc WHERE workspace_id=${w} AND ${claimSends()} AND (name=${host} OR right(${host},length(name)+1)='.'||name) LIMIT 1 FOR SHARE`)
    : await tx.execute(sql`SELECT FROM operation_domains WHERE workspace_id=${w} AND (name=${host} OR right(${host},length(name)+1)='.'||name) LIMIT 1`);
  return !!found.rowCount;
}
async function senderBox(tx: DbExecutor, w: string, from?: string) {
  const [box] = from
    ? await tx.select().from(mailboxes).where(and(eq(mailboxes.workspaceId, w), sql`(${mailboxes.id}=${from} OR ${mailboxes.id}=(SELECT mailbox_id FROM mailbox_addresses WHERE workspace_id=${w} AND address=${from.toLowerCase()}))`))
    : await tx.select().from(mailboxes).where(and(eq(mailboxes.workspaceId, w), sql`${mailboxes.kind}<>'inbox' AND ${mailboxes.expiresAt} IS NULL`)).orderBy(mailboxes.id).limit(1);
  if (!box || box.kind === 'inbox' || box.expiresAt)
    throw new ApiError(422, 'FORWARD_SENDER_REQUIRED', from ? 'Choose a permanent receiving address (not an expiring inbox) to send the confirmation request.' : 'Create a permanent receiving address first; the confirmation request is sent from it.', 'from');
  return box;
}
const forwardBase = (runtime: Runtime) => runtime.config.publicUrl.replace(/\/$/, '') + '/v1/forwarding';
/**
 * Emails the recipient a single-use, 24-hour confirmation link. The message is sealed: the
 * workspace's sent-mail views show it with the link withheld, because the link alone confirms.
 */
async function requestConfirmation(c: Ctx, tx: DbExecutor, w: string, row: { hook_id: string }, address: string, from?: string) {
  const box = await senderBox(tx, w, from);
  const addressHash = await digest(address);
  const declined = (await tx.execute<{ until: string }>(sql`SELECT (declined_at+interval '30 days')::text AS until FROM mail_forward_declines WHERE workspace_id=${w} AND address_hash=${addressHash} AND declined_at>now()-interval '30 days'`)).rows[0];
  if (declined) throw new ApiError(409, 'FORWARD_DECLINED', `${address} declined forwarding from this workspace. You can ask again after ${new Date(declined.until).toISOString()}.`, 'address');
  await debit(tx, w, 'forward-verification', 20, 'day', 'At most 20 forward confirmation requests per workspace per day.');
  await debit(tx, w, 'forward-verification:' + addressHash, 3, 'day', 'At most 3 confirmation requests per address per day.');
  // Across every workspace: one address cannot be flooded with requests by many workspaces.
  await debit(tx, 'global', 'forward-verification:' + addressHash, 5, 'day', 'This address has received too many confirmation requests today.');
  const token = randomSecret('fwd_');
  await tx.execute(sql`UPDATE mail_endpoints SET proof_hash=${await digest(token)},expires_at=now()+interval '24 hours',requested_at=now(),request_from=${box.address},declined_at=NULL WHERE workspace_id=${w} AND hook_id=${row.hook_id}`);
  await sendFromMailbox(c.env, tx, {
    actor: c.get('actor'), scope: { workspaceId: w }, mailbox: box, from: box.address, to: [address], cc: [], bcc: [], replyTo: [],
    subject: `Confirm forwarding from ${box.address}`,
    text: `${box.address} wants to forward the email it receives to ${address}.\n\nTo allow it, open this link within 24 hours and choose Allow:\n${forwardBase(c.env)}/confirm/${token}\n\nIf you don't recognize this request, ignore this email or choose Decline. Nothing is forwarded until you allow it, and declining stops this sender from asking again for 30 days. Every forwarded message includes a link to stop.`,
    inReplyTo: null, references: [], headers: [], attachments: [], autoSubmitted: 'auto-generated', sealed: true,
  });
}

export function registerEndpoints(app: App) {
  app.openapi(createRoute({ ...meta, method: 'get', path: base, operationId: 'listEndpoints', summary: 'List endpoints rituals can call', request: { query: z.object({ type: z.enum(types).optional(), cursor: z.string().max(64).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }) }, responses: { 200: response(z.object({ data: z.array(Endpoint), nextCursor: z.string().nullable() }).openapi('EndpointPage')), ...errors } }), async c => {
    const w = ritualAdmin(c).workspaceId, q = c.req.valid('query'), rows = await endpointRows(c.env.db, w, q);
    return c.json({ data: await Promise.all(rows.slice(0, q.limit).map(r => view(c.env, w, r))), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.name : null }, 200);
  });
  app.openapi(createRoute({ ...meta, method: 'get', path: `${base}/{name}`, operationId: 'getEndpoint', summary: 'Read one endpoint, its status and the next step', request: { params: NameParam }, responses: { 200: response(Endpoint), ...errors } }), async c => {
    const w = ritualAdmin(c).workspaceId;
    return c.json(await view(c.env, w, await findEndpoint(c.env.db, w, c.req.valid('param').name)), 200);
  });
  app.openapi(createRoute({
    ...meta, method: 'post', path: base, operationId: 'createEndpoint', summary: 'Create a named Slack, Discord, webhook or forward endpoint',
    description: 'Slack and Discord URLs are credentials: stored encrypted, pinned to the provider host and never returned. A webhook endpoint is a route-only inbound webhook; its signing secret is returned once. A forward emails its recipient a single-use confirmation link (24 hours); it stays pending until they choose Allow. With preverify, an address on a domain this workspace has verified is ready at once.',
    request: { body: json(CreateEndpoint) }, responses: { 201: response(Endpoint.extend({ secret: z.string().optional().describe('Webhook signing secret, shown once.') }).openapi('CreatedEndpoint')), ...errors },
  }), async c => {
    const a = ritualAdmin(c, true), q = c.req.valid('json'), w = a.workspaceId;
    let secret: string | undefined;
    await c.env.db.transaction(async tx => {
      await lockMailboxLane(tx, w, 'address');
      await assertEndpointName(tx, w, q.name);
      if (q.type === 'webhook') {
        const hookId = id('mwh'), binding = webhookSecretBinding(w, hookId);
        if ((await tx.execute(sql`SELECT FROM mailbox_webhooks WHERE workspace_id=${w} AND NOT paused AND event_types='[]' LIMIT 1 OFFSET 499`)).rowCount)
          throw new ApiError(409, 'MAILBOX_HOOK_LIMIT', 'At most 500 route-only webhooks can be active. Pause or delete one first.');
        secret = webhookSecret();
        await tx.insert(mailboxWebhooks).values({ id: hookId, workspaceId: w, key: q.name, name: q.name, url: webhookUrl(c.env, q.url), description: '', eventTypes: [], mailboxIds: null, paused: false, format: 'bane', junk: 'skip', timeoutSeconds: q.timeoutSeconds, retryAttempts: q.retryAttempts ?? 9, encryptedSecret: await encrypt(c.env, secret, binding), encryptedHeaders: await encryptWebhookHeaders(c.env, q.headers, binding) });
        await ownReceiving(tx, c, 'endpoint', hookId);
        return;
      }
      const count = (await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM mail_endpoints WHERE workspace_id=${w}`)).rows[0]!.n;
      if (count >= 50) throw new ApiError(409, 'ENDPOINT_LIMIT', 'At most 50 Slack, Discord and forward endpoints per workspace. Delete one first.');
      const hookId = id('con'), value = q.type === 'forward' ? q.address : pinnedUrl(q.type, q.url);
      if (q.type === 'forward') await checkExternal(tx, w, value);
      const preverified = q.type === 'forward' && q.preverify;
      if (preverified && !await ownVerifiedDomain(c.env, tx, w, value))
        throw new ApiError(422, 'PREVERIFY_NOT_ALLOWED', `preverify works only for addresses on a domain this workspace has verified. Omit it to email ${value} a confirmation link.`, 'preverify');
      await tx.insert(mailboxWebhooks).values({ id: hookId, workspaceId: w, name: `${q.type}:${q.name}`, url: 'https://ritual.invalid/', eventTypes: [], encryptedSecret: await encrypt(c.env, webhookSecret(), webhookSecretBinding(w, hookId)) });
      await tx.execute(sql`INSERT INTO mail_endpoints(workspace_id,ref,hook_id,encrypted_value,verified,expires_at,preverified_by) VALUES(${w},${q.type + ':' + q.name},${hookId},${await encrypt(c.env, value, w + ':endpoint:' + hookId)},${q.type !== 'forward' || preverified},${q.type === 'forward' && !preverified ? sql`now()+interval '24 hours'` : null},${preverified ? a.keyId : null})`);
      await ownReceiving(tx, c, 'endpoint', hookId);
      if (q.type === 'forward' && !preverified) await requestConfirmation(c, tx, w, { hook_id: hookId }, value, q.from);
    });
    c.header('Cache-Control', 'no-store');
    const created = await view(c.env, w, await findEndpoint(c.env.db, w, q.name));
    if (created.status === 'pending') c.get('actor').wakeJobs = 1;
    return c.json({ ...created, ...(secret ? { secret } : {}) }, 201);
  });
  app.openapi(createRoute({ ...meta, method: 'patch', path: `${base}/{name}`, operationId: 'updateEndpoint', summary: 'Change an endpoint’s rate, retry policy, pause state or URL', request: { params: NameParam, body: json(UpdateEndpoint) }, responses: { 200: response(Endpoint), ...errors } }), async c => {
    const w = ritualAdmin(c, true).workspaceId, name = c.req.valid('param').name, q = c.req.valid('json');
    await c.env.db.transaction(async tx => {
      await lockMailboxLane(tx, w, 'address');
      const row = await findEndpoint(tx, w, name);
      if (q.idempotent && row.type !== 'webhook') throw new ApiError(422, 'UNSUPPORTED_IDEMPOTENCY', 'Only webhook endpoints can declare that they deduplicate by Idempotency-Key.', 'idempotent');
      if (q.url !== undefined) {
        if (row.type === 'forward') throw new ApiError(422, 'FORWARD_ADDRESS_FIXED', 'A forward address cannot change. Create a new forward endpoint so its recipient can confirm.', 'url');
        if (row.type === 'webhook') await tx.update(mailboxWebhooks).set({ url: webhookUrl(c.env, q.url), encryptedHeaders: await encryptWebhookHeaders(c.env, [], webhookSecretBinding(w, row.hook_id)), updatedAt: new Date().toISOString() }).where(and(eq(mailboxWebhooks.workspaceId, w), eq(mailboxWebhooks.id, row.hook_id)));
        else await tx.execute(sql`UPDATE mail_endpoints SET encrypted_value=${await encrypt(c.env, pinnedUrl(row.type, q.url), w + ':endpoint:' + row.hook_id)} WHERE workspace_id=${w} AND hook_id=${row.hook_id}`);
      }
      if (q.paused !== undefined) {
        await tx.update(mailboxWebhooks).set({ paused: q.paused }).where(and(eq(mailboxWebhooks.workspaceId, w), eq(mailboxWebhooks.id, row.hook_id)));
        if (row.paused && !q.paused) { await tx.execute(sql`INSERT INTO jobs(id,type,workspace_id,payload) VALUES('job_'||gen_random_uuid(),'mailbox.resumeDeliveries',${w},jsonb_build_object('hook',${row.hook_id}::text))`); c.get('actor').wakeJobs = 1; }
      }
      if (q.perMinute !== undefined || q.retryOnTimeout !== undefined || q.idempotent !== undefined) {
        const next = { ...endpointPolicy(row.type, row), ...Object.fromEntries(Object.entries({ perMinute: q.perMinute, retryOnTimeout: q.retryOnTimeout, idempotent: q.idempotent }).filter(([, v]) => v !== undefined)) };
        await tx.execute(sql`INSERT INTO mail_action_policies(workspace_id,hook_id,per_minute,retry_on_timeout,idempotent) VALUES(${w},${row.hook_id},${next.perMinute},${next.retryOnTimeout},${next.idempotent})
          ON CONFLICT(workspace_id,hook_id) DO UPDATE SET per_minute=excluded.per_minute,retry_on_timeout=excluded.retry_on_timeout,idempotent=excluded.idempotent`);
      }
      await ownReceiving(tx, c, 'endpoint', row.hook_id);
    });
    return c.json(await view(c.env, w, await findEndpoint(c.env.db, w, name)), 200);
  });
  app.openapi(createRoute({ ...meta, method: 'delete', path: `${base}/{name}`, operationId: 'deleteEndpoint', summary: 'Delete an endpoint no ritual or route uses', request: { params: NameParam }, responses: { 200: response(z.object({ name: Name, deleted: z.literal(true) }).openapi('DeletedEndpoint')), ...errors } }), async c => {
    const w = ritualAdmin(c, true).workspaceId, name = c.req.valid('param').name;
    await c.env.db.transaction(async tx => {
      await lockMailboxLane(tx, w, 'address');
      const row = await findEndpoint(tx, w, name);
      const used = (await tx.execute<{ ritual: boolean; route: boolean }>(sql`SELECT
        EXISTS(SELECT FROM mail_ritual_configs WHERE workspace_id=${w} AND programs->'refs' ? ${'endpoint:' + name}) AS ritual,
        EXISTS(SELECT FROM mail_routes WHERE workspace_id=${w} AND destinations ? ${row.hook_id}) AS route`)).rows[0]!;
      if (used.ritual) throw new ApiError(409, 'ENDPOINT_IN_USE', `An attached ritual calls endpoints.${name}. Remove the call or detach the ritual, then delete.`);
      if (used.route) throw new ApiError(409, 'ENDPOINT_IN_USE', `A route delivers to ${name}. Remove it from routes first (deleteInboundWebhook with detach=true does both).`);
      await tx.delete(mailboxWebhooks).where(and(eq(mailboxWebhooks.workspaceId, w), eq(mailboxWebhooks.id, row.hook_id)));
    });
    return c.json({ name, deleted: true as const }, 200);
  });
  app.openapi(createRoute({ ...meta, method: 'post', path: `${base}/{name}/verification`, operationId: 'sendEndpointVerification', summary: 'Email a forward recipient a new confirmation link', description: 'For a pending, expired or (after 30 days) declined forward. The recipient must open the link and choose Allow; no API call can confirm on their behalf.', request: { params: NameParam, body: json(z.object({ from: z.string().max(254).optional() }).strict()) }, responses: { 202: response(Endpoint), ...errors } }), async c => {
    const w = ritualAdmin(c, true).workspaceId, name = c.req.valid('param').name, q = c.req.valid('json');
    await c.env.db.transaction(async tx => {
      await lockMailboxLane(tx, w, 'address');
      const row = await findEndpoint(tx, w, name);
      if (row.type !== 'forward') throw new ApiError(422, 'VERIFICATION_NOT_NEEDED', `${row.type} endpoints need no recipient confirmation.`);
      if (row.verified) throw new ApiError(409, 'ALREADY_CONFIRMED', `${name} is already confirmed.`);
      await requestConfirmation(c, tx, w, row, await decrypt(c.env, row.encrypted_value!, w + ':endpoint:' + row.hook_id), q.from);
    });
    c.get('actor').wakeJobs = 1;
    return c.json(await view(c.env, w, await findEndpoint(c.env.db, w, name)), 202);
  });
  app.openapi(createRoute({ ...meta, method: 'post', path: `${base}/{name}/test`, operationId: 'testEndpoint', summary: 'Post a fixed test message to a Slack, Discord or webhook endpoint now', description: 'Bypasses rituals and queues: one synchronous post, counted against the endpoint rate. Forwards send real mail, so they are not tested this way; use testRituals for a dry run.', request: { params: NameParam }, responses: { 200: response(z.object({ ok: z.boolean(), status: z.number().int().nullable(), error: z.string().nullable() }).openapi('EndpointTest')), ...errors } }), async c => {
    const w = ritualAdmin(c, true).workspaceId, name = c.req.valid('param').name, row = await findEndpoint(c.env.db, w, name);
    if (row.type === 'forward') throw new ApiError(422, 'FORWARD_TEST_UNAVAILABLE', 'Forwards send real mail. Dry-run the ritual with testRituals instead.');
    await debit(c.env.db, w, 'endpoint-test:' + row.hook_id, 10, 'hour', 'At most 10 endpoint tests per hour.');
    try {
      const result = row.type === 'webhook'
        ? await (await import('./inbound-webhook.js')).sendTestWebhook(c.env, (await c.env.db.select().from(mailboxWebhooks).where(and(eq(mailboxWebhooks.workspaceId, w), eq(mailboxWebhooks.id, row.hook_id))))[0]!, {})
        : await postWebhook(c.env, pinnedUrl(row.type, await decrypt(c.env, row.encrypted_value!, w + ':endpoint:' + row.hook_id)), {}, JSON.stringify(renderChat(row.type, { [row.type === 'slack' ? 'text' : 'content']: `Test from Bane: ${endpointCall(name)} is connected.` })), null, w + ':endpoint:' + row.hook_id);
      const ok = result.status >= 200 && result.status < 300;
      return c.json({ ok, status: result.status, error: ok ? null : `HTTP ${result.status}` }, 200);
    } catch (e) {
      return c.json({ ok: false, status: null, error: e instanceof ApiError ? e.code : 'NETWORK_ERROR' }, 200);
    }
  });
  registerForwardPages(app);
}

// ── Recipient pages ────────────────────────────────────────────────────────────────────────
// Public, no login: the emailed link is the proof. GET only shows the request (mail scanners
// follow links); a same-origin POST from the page records the choice.
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
function page(c: Ctx, title: string, body: string, status: 200 | 403 | 404 | 410 = 200) {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Robots-Tag', 'noindex');
  c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  return c.html(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;max-width:34rem;margin:12vh auto;padding:0 1.25rem;color:#1a1a1a;background:#fbfbf9}h1{font-size:1.15rem;margin:0 0 1rem}p{margin:0 0 1rem;color:#444}form{display:flex;gap:.75rem;margin-top:1.5rem}button{font:inherit;padding:.55rem 1rem;border-radius:6px;border:1px solid #1a1a1a;background:#1a1a1a;color:#fff;cursor:pointer}button[value=decline]{background:transparent;color:#1a1a1a;border-color:#bbb}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}p{color:#aaa}button{background:#eee;color:#111;border-color:#eee}button[value=decline]{color:#eee;border-color:#555}}</style><h1>${escapeHtml(title)}</h1>${body}</html>`, status);
}
const sameOrigin = (c: Ctx) => {
  const origin = c.req.header('origin'), site = c.req.header('sec-fetch-site');
  return (origin === undefined || origin === new URL(c.env.config.publicUrl).origin) && (site === undefined || site === 'same-origin' || site === 'none');
};
async function stopSignature(runtime: Runtime, hookId: string) {
  const key = await crypto.subtle.importKey('raw', Buffer.from(runtime.config.encryptionKey, 'hex'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('forward-stop\n' + hookId))).toString('base64url');
}
/** Stop link included in every forwarded message. Signed, so nothing is stored per message. */
export async function forwardStopUrl(runtime: Runtime, hookId: string) {
  return `${forwardBase(runtime)}/stop/${hookId}.${await stopSignature(runtime, hookId)}`;
}
type Pending = { workspace_id: string; hook_id: string; encrypted_value: string; request_from: string | null };
async function pendingByToken(db: DbExecutor, token: string) {
  return (await db.execute<Pending>(sql`SELECT workspace_id,hook_id,encrypted_value,request_from FROM mail_endpoints WHERE proof_hash=${await digest(token)} AND NOT verified AND declined_at IS NULL AND expires_at>now()`)).rows[0];
}
async function decline(tx: DbExecutor, runtime: Runtime, row: Pending) {
  await tx.execute(sql`UPDATE mail_endpoints SET verified=false,proof_hash=NULL,declined_at=now() WHERE workspace_id=${row.workspace_id} AND hook_id=${row.hook_id}`);
  const hash = await digest(await decrypt(runtime, row.encrypted_value, row.workspace_id + ':endpoint:' + row.hook_id));
  await tx.execute(sql`INSERT INTO mail_forward_declines(workspace_id,address_hash) VALUES(${row.workspace_id},${hash}) ON CONFLICT(workspace_id,address_hash) DO UPDATE SET declined_at=now()`);
}
/** Records the recipient's choice. Single use: the token is cleared by whichever choice comes first. */
export async function answerForward(runtime: Runtime, token: string, choice: 'allow' | 'decline') {
  return runtime.db.transaction(async tx => {
    const row = (await tx.execute<Pending>(sql`SELECT workspace_id,hook_id,encrypted_value,request_from FROM mail_endpoints WHERE proof_hash=${await digest(token)} AND NOT verified AND declined_at IS NULL AND expires_at>now() FOR UPDATE`)).rows[0];
    if (!row) throw new ApiError(410, 'CONFIRMATION_UNAVAILABLE', 'This link was already used or has expired.');
    if (choice === 'allow') await tx.execute(sql`UPDATE mail_endpoints SET verified=true,proof_hash=NULL,confirmed_at=now() WHERE workspace_id=${row.workspace_id} AND hook_id=${row.hook_id}`);
    else await decline(tx, runtime, row);
    return { address: await decrypt(runtime, row.encrypted_value, row.workspace_id + ':endpoint:' + row.hook_id), from: row.request_from };
  });
}
function registerForwardPages(app: App) {
  const confirm = '/v1/forwarding/confirm/:token', stop = '/v1/forwarding/stop/:token';
  app.get(confirm, async c => {
    const token = c.req.param('token'), row = /^fwd_[0-9a-f]{64}$/.test(token) ? await pendingByToken(c.env.db, token) : undefined;
    if (!row) return page(c, 'This link has expired', '<p>It was already used, or more than 24 hours have passed. Nothing will be forwarded unless a new request is allowed.</p>', 410);
    const address = await decrypt(c.env, row.encrypted_value, row.workspace_id + ':endpoint:' + row.hook_id);
    return page(c, 'Allow email forwarding?', `<p><strong>${escapeHtml(row.request_from ?? 'A Bane workspace')}</strong> wants to forward the email it receives to <strong>${escapeHtml(address)}</strong>.</p><p>Forwarded messages arrive as plain text from that address, each with a link to stop. If you decline, this sender cannot ask again for 30 days.</p><form method="post"><button name="choice" value="allow">Allow forwarding</button><button name="choice" value="decline">Decline</button></form>`);
  });
  app.post(confirm, async c => {
    const token = c.req.param('token');
    if (!sameOrigin(c)) return page(c, 'Open the link from your email', '<p>Confirm from the page the emailed link opens.</p>', 403);
    const form = await c.req.parseBody().catch(() => ({} as Record<string, unknown>)), choice = form.choice === 'allow' ? 'allow' : form.choice === 'decline' ? 'decline' : null;
    if (!choice || !/^fwd_[0-9a-f]{64}$/.test(token)) return page(c, 'Choose Allow or Decline', '<p>Open the link from your email again and choose an option.</p>', 403);
    try {
      const done = await answerForward(c.env, token, choice);
      return choice === 'allow'
        ? page(c, 'Forwarding allowed', `<p>Email received by ${escapeHtml(done.from ?? 'this sender')} will now be forwarded to ${escapeHtml(done.address)}. Each forwarded message has a link to stop.</p>`)
        : page(c, 'Request declined', `<p>Nothing will be forwarded to ${escapeHtml(done.address)}. This sender cannot ask again for 30 days.</p>`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 410) return page(c, 'This link has expired', '<p>It was already used, or more than 24 hours have passed.</p>', 410);
      throw e;
    }
  });
  const stopRow = async (c: Ctx) => {
    const [hookId, signature] = c.req.param('token')!.split('.');
    if (!hookId || !signature || !/^con_[A-Za-z0-9_-]+$/.test(hookId) || signature !== await stopSignature(c.env, hookId)) return undefined;
    return (await c.env.db.execute<Pending & { declined_at: string | null }>(sql`SELECT workspace_id,hook_id,encrypted_value,request_from,declined_at FROM mail_endpoints WHERE hook_id=${hookId}`)).rows[0];
  };
  app.get(stop, async c => {
    const row = await stopRow(c);
    if (!row) return page(c, 'Link not recognized', '<p>This stop link is not valid.</p>', 404);
    if (row.declined_at) return page(c, 'Forwarding is off', '<p>These forwards are already stopped.</p>');
    return page(c, 'Stop these forwards?', `<p>Stop forwarding email from <strong>${escapeHtml(row.request_from ?? 'this sender')}</strong> to you. The sender cannot ask again for 30 days.</p><form method="post"><button name="choice" value="decline">Stop forwarding</button></form>`);
  });
  app.post(stop, async c => {
    if (!sameOrigin(c)) return page(c, 'Open the link from a forwarded message', '<p>Stop from the page the link opens.</p>', 403);
    const row = await stopRow(c);
    if (!row) return page(c, 'Link not recognized', '<p>This stop link is not valid.</p>', 404);
    await c.env.db.transaction(tx => decline(tx, c.env, row));
    return page(c, 'Forwarding stopped', '<p>No more messages will be forwarded to you from this sender.</p>');
  });
}

/** Delivers one Slack, Discord or forward call. Retries, rates and fences are applied by ritualDelivery. */
export async function deliverConnector(runtime: Runtime, w: string, h: ClaimedWebhook) {
  const event = h.payload as { messageId: string; type: string; ritualBody?: unknown; data: { recipients?: string[]; junk?: boolean } },
    hook = h.webhook_id;
  const d = (await runtime.db.execute<{ ref: string; encrypted_value: string }>(sql`SELECT ref,encrypted_value FROM mail_endpoints WHERE workspace_id=${w} AND hook_id=${hook} AND verified AND declined_at IS NULL`)).rows[0];
  if (!d || event.type !== 'message.received' || event.data.junk || !event.data.recipients?.length)
    throw new ApiError(422, 'CONNECTOR_UNAVAILABLE', 'Only confirmed endpoints receive routed, non-junk mail.');
  const type = d.ref.split(':')[0] as EndpointType,
    value = await decrypt(runtime, d.encrypted_value, w + ':endpoint:' + hook);
  if (type !== 'forward') return postWebhook(runtime, pinnedUrl(type, value), {}, JSON.stringify(renderChat(type, event.ritualBody)), null, w + ':endpoint:' + hook);
  const stopUrl = await forwardStopUrl(runtime, hook);
  await runtime.db.transaction(async tx => {
    await checkExternal(tx, w, value);
    const [m] = await tx.select().from(mailMessages).where(and(eq(mailMessages.workspaceId, w), eq(mailMessages.id, event.messageId), eq(mailMessages.direction, 'inbound'), retainedMail()));
    if (
      !m ||
      (m.verdicts as { forwardSafe?: boolean }).forwardSafe !== true ||
      m.automated ||
      m.spam ||
      m.status !== 'received' ||
      m.verdicts.virus !== 'PASS' ||
      m.headers.some(x => ['auto-submitted', 'x-bane-loop', 'list-id', 'precedence'].includes(x.name.toLowerCase())) ||
      m.headers.filter(x => x.name.toLowerCase() === 'received').length >= 25
    )
      throw new ApiError(422, 'FORWARD_BLOCKED', 'Automated, junk, unparsed, looped or unscanned mail is never forwarded.');
    const recipient = event.data.recipients![0]!;
    const [box] = await tx.select().from(mailboxes).where(and(eq(mailboxes.workspaceId, w), sql`id=(SELECT mailbox_id FROM mailbox_addresses WHERE workspace_id=${w} AND address IN (${recipient},regexp_replace(${recipient},'[+][^@]*@','@')) ORDER BY (address=${recipient}) DESC LIMIT 1)`));
    if (!box || box.kind === 'inbox' || box.expiresAt) throw new ApiError(422, 'FORWARD_SENDER_REQUIRED', 'Forward from a permanent receiving address.');
    // One forward per message and endpoint, decided in the same transaction as the send.
    if (!(await tx.execute(sql`INSERT INTO mail_forward_once(workspace_id,message_id,endpoint,grants) VALUES(${w},${m.id},${hook},${JSON.stringify((h.payload as {grants?:string[]}).grants??[])}::jsonb) ON CONFLICT DO NOTHING RETURNING 1`)).rowCount) return;
    await debit(tx, w, 'forward-daily', 1000, 'day');
    await debit(tx, w, 'forward-hourly:' + hook, 200, 'hour');
    // Any incoming loop token blocks a forward (above), including tokens from other installations.
    const loop = await crypto.subtle.importKey('raw', Buffer.from(runtime.config.encryptionKey, 'hex'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const token = Buffer.from(await crypto.subtle.sign('HMAC', loop, new TextEncoder().encode(w + ':' + m.id))).toString('base64url');
    const sender = (((m.verdicts as { ritualVerified?: boolean }).ritualVerified && m.fromName) || m.fromAddress || 'Sender').replaceAll('@', ' at ').replace(/[\x00-\x1f<>\x7f]/g, ' ').slice(0, 100);
    const sent=await sendFromMailbox(runtime, tx, {
      actor: { workspaceId: w, keyId: 'forward:' + hook, permissions: ['send'], domains: [] },
      scope: { workspaceId: w }, mailbox: box, from: box.address,
      fromName: `${sender} via ${(box.displayName || box.address.split('@')[0]!).replace(/[\x00-\x1f@<>\x7f]/g, ' ').slice(0, 80)}`,
      to: [value], cc: [], bcc: [], replyTo: [],
      subject: 'Fwd: ' + m.subject.slice(0, 200),
      text: `${(m.text || m.snippet || '(No plain text)').slice(0, 64000)}\n\n--\nForwarded by ${box.address}. Stop these forwards: ${stopUrl}`,
      screen: true, inReplyTo: null, references: [], autoSubmitted: 'auto-generated',
      headers: [{ name: 'X-Bane-Loop', value: 'v1.1.' + token }],
      attachments: [],
    });
    await tx.execute(sql`UPDATE mail_forward_once SET email_id=${sent.message.sendingEmailId} WHERE workspace_id=${w} AND message_id=${m.id} AND endpoint=${hook}`);
  });
  return { status: 202 };
}
export { DEFAULT_POLICY };
