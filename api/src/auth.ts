import { createRoute, z } from '@hono/zod-openapi';
import { and, eq, gt, isNull, sql, type SQL } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { ApiError, actor, digest, errors, hasSessionCookie, id, IdParams, isoTime, json, PageQuery, page, randomSecret, response, security, senderDomainAllowed, timed, wrapModuleLoad } from './core.js';
import type { Actor, App, AppEnv, Ctx, Runtime } from './core.js';
import { agentTokens, apiKeys } from './db/core.js';
import { mailboxKeys } from './db/mailbox.js';
import { auditContext, auditInsert, recordAudit } from './audit.js';
import { secretPrefixes, shownPrefix } from './brand.js';

// A private symbol carries server-authorized identity through request-cloning middleware.
// HTTP headers/cookies cannot supply it, and every internal dispatch gets a fresh runtime.
const delegatedActor = Symbol('mcpActor');
// A recent DB-verified fingerprint can spend CPU preparing a large body. This
// hint never authorizes anything: even a hit authenticates inside admission SQL.
const verifiedFingerprints=new Map<string,number>();
function rememberFingerprint(hash:string) {
  verifiedFingerprints.delete(hash);verifiedFingerprints.set(hash,Date.now()+60_000);
  if(verifiedFingerprints.size>1024)verifiedFingerprints.delete(verifiedFingerprints.keys().next().value!);
}
const delegatedMailbox=Symbol('mcpInbox');
export const delegatedInbox=(runtime:Runtime)=>(runtime as Runtime & {[delegatedMailbox]?:import('./core.js').MailboxAccess})[delegatedMailbox];
export function dispatchAsMailboxAccess(app:Pick<App,'fetch'>,request:Request,runtime:Runtime,access:import('./core.js').MailboxAccess){
  const delegated={...runtime,[delegatedMailbox]:access}; return app.fetch(request,delegated);
}
type DelegatedRuntime = Runtime & { [delegatedActor]?: Actor };
export async function dispatchAsActor(app: Pick<App, 'fetch'>, request: Request, runtime: Runtime, identity: Actor): Promise<Response> {
  if (identity.credential !== 'mcp' || !identity.keyId.startsWith('mcp_')) throw new ApiError(403, 'PERMISSION_DENIED', 'Invalid delegated API principal.');
  const delegatedRuntime: DelegatedRuntime = { ...runtime, [delegatedActor]: identity };
  return await app.fetch(request, delegatedRuntime);
}

// `credential` returns at most one authorized row. Charge the originating principal
// (the grant for agent tokens), but touch only the credential actually presented.
function credentialCtes(table: typeof agentTokens | typeof apiKeys | typeof mailboxKeys, credential: SQL) {
  return sql`credential AS MATERIALIZED (${credential}), budget AS (
      INSERT INTO api_request_budgets(workspace_id, key_id, window_start, used)
      SELECT workspace_id, key_id, date_trunc('minute', now()), 1 FROM credential
      ON CONFLICT (workspace_id, key_id) DO UPDATE SET
        used = CASE WHEN api_request_budgets.window_start = excluded.window_start THEN least(api_request_budgets.used + 1, (SELECT max_requests + 1 FROM credential)) ELSE 1 END,
        window_start = excluded.window_start RETURNING used
    ), touched AS (
      UPDATE ${table} k SET last_used_at = ${new Date().toISOString()}::timestamptz FROM credential, budget WHERE k.id = credential.id
        AND (k.last_used_at IS NULL OR k.last_used_at < now() - interval '1 minute')
        ${table === mailboxKeys ? sql`AND budget.used <= credential.max_requests` : sql``}
    )`;
}
export async function chargeCredential<T extends Record<string, unknown>>(c: Ctx, table: typeof agentTokens | typeof apiKeys | typeof mailboxKeys, credential: SQL) {
  const result = await c.env.db.execute<T & { used: number; max_requests: number }>(sql`WITH ${credentialCtes(table,credential)} SELECT credential.*,budget.used FROM credential,budget`);
  const row = result.rows[0];
  if (row) checkBudget(c, row.used, row.max_requests);
  return row;
}
export function checkBudget(c: Ctx, used: number, maxRequests: number) {
  if (used <= maxRequests) return;
  c.header('Retry-After', '60');
  throw new ApiError(429, 'REQUEST_RATE_LIMITED', `This key exceeded its ${maxRequests}-request minute budget. Retry after the window resets.`, undefined, true);
}

export async function chargeGrantBudget(runtime:Runtime,w:string,id:string){
  const max=runtime.config.apiRateLimitPerMinute;
  return (await runtime.db.execute<{used:number}>(sql`INSERT INTO api_request_budgets(workspace_id,key_id,window_start,used) VALUES(${w},${id},date_trunc('minute',now()),1)
    ON CONFLICT(workspace_id,key_id) DO UPDATE SET used=CASE WHEN api_request_budgets.window_start=excluded.window_start THEN least(api_request_budgets.used+1,${max+1}) ELSE 1 END,window_start=excluded.window_start RETURNING used`)).rows[0]!.used;
}
// Run after authentication and before idempotent replay or any configuration handler.
export const requireReceivingConsent: MiddlewareHandler<AppEnv> = async (c,next) => {
  const a=c.get('actor');
  if (a?.grantId && !a.receivingConsent) throw new ApiError(403,'ADMIN_REQUIRED','Reconnect with explicit receiving consent to access receiving configuration.');
  await next();
};

export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const delegated = (c.env as DelegatedRuntime)[delegatedActor];
  const authorization = c.req.header('authorization');
  if (delegated) {
    c.set('actor', delegated);
    const maxRequests = c.env.config.apiRateLimitPerMinute;
    checkBudget(c,await timed(c,'budget-db',()=>chargeGrantBudget(c.env,delegated.workspaceId,delegated.keyId)),maxRequests);
  } else if (authorization !== undefined) {
    const token = authorization.match(/^Bearer (.+)$/i)?.[1];
    if (!token || token.length > 16 * 1024) throw new ApiError(401, 'AUTH_INVALID', 'The API token is invalid or has been revoked.');
    if (/^(?:nm|bane|os)_agent_/.test(token)) { // bane_/os_: remove after rename cleanup
      const [{ verifyAgentToken }, { getMcpGrantActor }] = await wrapModuleLoad(() => Promise.all([import('./agent-token.js'), import('./mcp-auth.js')]));
      const temporary = await verifyAgentToken(c.env.config, token);
      // The approval acts in the workspace the token was minted in (a call names it; the token keeps it).
      const minted = temporary && (await c.env.db.execute<{ workspace_id: string }>(sql`SELECT workspace_id FROM agent_tokens WHERE id = ${temporary.id} AND grant_id = ${temporary.grant}`)).rows[0];
      const grant = temporary && minted && await getMcpGrantActor(c.env, temporary.grant, minted.workspace_id);
      const invalid = () => new ApiError(401, 'AUTH_INVALID', 'The temporary API token is invalid, expired, or its originating approval was revoked.');
      if (!temporary || !grant || temporary.permissions.some(permission => !grant.permissions.includes('manage') && !grant.permissions.includes(permission))) throw invalid();
      const limit = c.env.config.apiRateLimitPerMinute;
      const tracked = await timed(c, 'budget-db', () => chargeCredential(c, agentTokens, sql`
        SELECT id, workspace_id, grant_id AS key_id, ${limit}::int AS max_requests FROM agent_tokens
        WHERE id = ${temporary.id} AND revoked_at IS NULL AND workspace_id = ${grant.workspaceId} AND grant_id = ${temporary.grant}
          AND date_trunc('milliseconds', expires_at) = ${new Date(temporary.exp).toISOString()}::timestamptz
          AND permissions = ${JSON.stringify(temporary.permissions)}::jsonb AND domains = ${JSON.stringify(temporary.domains)}::jsonb`));
      if (!tracked) throw invalid();
      c.set('actor', { ...grant, permissions: temporary.permissions, domains: temporary.domains, credential: 'agentToken',tokenId:temporary.id });
    } else {
      if (!/^(?:nm_|bane_|os_(?:live_)?)[0-9a-f]{64}$/i.test(token)) throw new ApiError(401, 'AUTH_INVALID', 'The API key is invalid or has been revoked.'); // bane_/os_: remove after rename cleanup
      const hash = await digest(token);
      const limit = c.env.config.apiRateLimitPerMinute;
      const credential = sql`
        SELECT k.id, k.workspace_id, k.id AS key_id, k.permissions, k.domains, g.grant_id,
          ${limit}::int AS max_requests
        FROM api_keys k LEFT JOIN mail_grant_objects g ON g.workspace_id=k.workspace_id AND g.kind='api_key' AND g.resource=k.id
        WHERE k.hash = ${hash} AND k.revoked_at IS NULL`;
      if((verifiedFingerprints.get(hash)??0)>Date.now() && c.env.config.multiTenant && c.req.method==='POST' && ['/v1/emails/send','/v1/emails/batch'].includes(c.req.path)) {
        const {tryAtomicKeyAdmission}=await wrapModuleLoad(()=>import('./sending.js'));
        const response=await tryAtomicKeyAdmission(c,credentialCtes(apiKeys,sql`${credential} AND g.grant_id IS NULL`));
        if(response){rememberFingerprint(hash);return response;}
      }
      const key = await timed(c, 'budget-db', () => chargeCredential<Pick<Actor, 'permissions' | 'domains'> & { id: string; workspace_id: string; grant_id:string|null }>(c, apiKeys,credential));
      if (!key) throw new ApiError(401, 'AUTH_INVALID', 'The API key is invalid or has been revoked.');
      let grant:Actor|null=null;
      if (key.grant_id) {
        const {getMcpGrantActor}=await wrapModuleLoad(()=>import('./mcp-auth.js'));
        grant=await getMcpGrantActor(c.env,'mcp_'+key.grant_id,key.workspace_id);
        if (grant?.workspaceId!==key.workspace_id || !grant.permissions.includes('manage')) throw new ApiError(401,'AUTH_INVALID','The originating management approval is no longer active.');
      } else rememberFingerprint(hash);
      c.set('actor', { grantId:grant?.grantId, receivingConsent:grant?.receivingConsent, keyId: key.id, workspaceId: key.workspace_id, permissions: key.permissions, domains: key.domains, credential: 'apiKey' });
    }
  } else {
    if (!c.env.config.accountClient) {
      throw new ApiError(503, 'AUTH_NOT_CONFIGURED', 'Dashboard sign-in is not configured for this deployment.');
    }
    if (!hasSessionCookie(c.req.raw.headers)) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in or supply a bearer API key.');
    const { getDashboardActor, migrateLegacyCookies, requireDashboardOrigin, settleDefaultAccount } = await wrapModuleLoad(() => import('./dashboard-auth.js'));
    const dashboard = await timed(c,'session-db',()=>getDashboardActor(c.env,c.req.raw.headers));
    if (!dashboard) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in or supply a bearer API key.');
    migrateLegacyCookies(c); settleDefaultAccount(c, dashboard.keyId.slice('user_'.length));
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) requireDashboardOrigin(c.env, c.req.raw.headers);
    c.set('actor', dashboard);
  }
  await next();
};
const MailPermission = z.enum(['read', 'send', 'modify', 'create']);
const KeyAccess = z.object({
  type: z.enum(['workspace', 'addresses', 'inbox']).describe('workspace: the whole workspace, with permissions and domains. addresses: only mail at receiving addresses. inbox: only one agent inbox; the key stops working when the inbox is deleted.'),
  addressIds: z.array(z.string()).nullable().describe('addresses: the receiving addresses it may use, or null for every address including ones added later. inbox: the inbox. Null for workspace keys.'),
  inboxId: z.string().nullable().describe('inbox: the agent inbox the key belongs to.'),
  mail: z.array(MailPermission).describe('addresses and inbox: read (mail, events, attachments), send (reply and start conversations from those addresses only), modify (mark read, archive, star, label, delete an inbox), create (create agent inboxes and use the ones it created). Empty for workspace keys.'),
}).openapi('ApiKeyAccess');
const KeySchema = z.object({ id: z.string(), name: z.string(),
  permissions: z.array(z.enum(['read', 'send', 'manage'])).describe('Workspace permissions. Empty for a key limited to addresses or an inbox: see access.'),
  domains: z.array(z.string()), prefix: z.string(), createdAt: z.string(), lastUsedAt: z.string().nullable(), revokedAt: z.string().nullable(),
  access: KeyAccess, expiresAt: z.string().nullable().describe('When a key limited to an expiring inbox stops working (the inbox\'s deletion time). Null otherwise.'),
}).openapi('ApiKey');
export const AgentTokenRecord = z.object({ id: z.string(), grantId: z.string(), permissions: z.array(z.enum(['read', 'send', 'manage'])), domains: z.array(z.string()), purpose: z.string(), expiresAt: z.string(), createdAt: z.string(), lastUsedAt: z.string().nullable(), revokedAt: z.string().nullable() }).openapi('AgentTokenRecord');
const KeyAccessInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('workspace') }).strict(),
  z.object({ type: z.literal('addresses'), addressIds: z.array(z.string().min(1).max(120)).max(500).optional().describe('Receiving address IDs. Omit for every address, including ones added later. [] with create: only the inboxes the key creates.'),
    mail: z.array(MailPermission).min(1).max(4).default(['read']) }).strict(),
  z.object({ type: z.literal('inbox'), inboxId: z.string().min(1).max(120).describe('An active agent inbox. The key stops working when the inbox is deleted, and when an expiring inbox ends.'),
    mail: z.array(z.enum(['read', 'send', 'modify'])).min(1).max(3).default(['read']) }).strict(),
]).openapi('CreateApiKeyAccess');
const KeyInput = z.object({ name: z.string().trim().min(1).max(100),
  permissions: z.array(z.enum(['read', 'send', 'manage'])).min(1).max(3).optional().describe('Workspace keys: read, send and manage. Defaults to send.'),
  domains: z.array(z.string().trim().toLowerCase().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/)).max(50).optional().describe('Workspace keys: sender domains it is limited to, including their subdomains. Defaults to all.'),
  access: KeyAccessInput.optional().describe('What the key is limited to. Defaults to the workspace. A key for addresses or an inbox takes its permissions in access.mail and can never send from other addresses, read other mail or manage the workspace.'),
}).strict().openapi('CreateApiKey');
export function manageKeys(c: Parameters<typeof actor>[0]) {
  const value = actor(c, 'manage');
  if (value.credential === 'agentToken') throw new ApiError(403, 'CREDENTIAL_DELEGATION_FORBIDDEN', 'Temporary agent tokens cannot create, list, or revoke API keys.');
  if (value.domains.length) throw new ApiError(403, 'PERMISSION_DENIED', 'Key administration requires unrestricted management access.');
  return value;
}
const workspaceAccess = { type: 'workspace' as const, addressIds: null, inboxId: null, mail: [] };
const keyView = (key: typeof apiKeys.$inferSelect) => ({ id: key.id, name: key.name, permissions: key.permissions, domains: key.domains, prefix: key.prefix,
  createdAt: isoTime(key.createdAt)!, lastUsedAt: isoTime(key.lastUsedAt), revokedAt: isoTime(key.revokedAt), access: workspaceAccess, expiresAt: null });
// Keys limited to addresses or an inbox live in mailbox_keys (address-keys.ts); loaded only when a request names one.
const addressKeys = () => wrapModuleLoad(() => import('./address-keys.js'));
export function registerAuth(app: App) {
  app.openapi(createRoute({ method: 'post', path: '/v1/agent-tokens', operationId: 'createAgentToken', tags: ['Auth'], security, description: 'A short-lived, nonrefreshable token for temporary scripts. Requires an MCP approval and never exceeds it; manage tokens cannot administer credentials.', request: { body: json(z.object({
    permissions: z.array(z.enum(['read', 'send', 'manage'])).min(1).max(3).refine(value => value[0] === 'read' && new Set(value).size === value.length, 'Start with read and do not repeat permissions.'),
    expiresInSeconds: z.number().int().min(30).max(86400), domains: z.array(z.string().trim().toLowerCase().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/)).max(50).default([]),
    purpose: z.string().trim().min(1).max(200),
  }).strict()) }, responses: { 201: response(z.object({ id: z.string(), token: z.string(), expiresAt: z.string(), permissions: z.array(z.enum(['read', 'send', 'manage'])), domains: z.array(z.string()), purpose: z.string() }).openapi('AgentToken')), ...errors } }), async c => {
    const input = c.req.valid('json'); const identity = actor(c, input.permissions.includes('manage') ? 'manage' : input.permissions.includes('send') ? 'send' : 'read');
    if (identity.credential !== 'mcp' || !identity.keyId.startsWith('mcp_')) throw new ApiError(403, 'MCP_AUTHORIZATION_REQUIRED', 'Temporary agent tokens can only be delegated directly from an MCP OAuth approval.');
    if (input.permissions.some(permission => !identity.permissions.includes('manage') && !identity.permissions.includes(permission))) throw new ApiError(403, 'PERMISSION_DENIED', 'The MCP approval does not include every requested permission.');
    if (identity.domains.length && (!input.domains.length || input.domains.some(domain => !senderDomainAllowed(identity.domains, domain)))) throw new ApiError(403, 'SENDER_DOMAIN_FORBIDDEN', 'The temporary token must remain restricted to the approved sender domains or their subdomains.', 'domains');
    const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1000).toISOString();
    const tokenId = id('agt');
    const { createAgentToken } = await wrapModuleLoad(() => import('./agent-token.js'));
    const token = await createAgentToken(c.env.config, { id: tokenId, grant: identity.keyId, permissions: input.permissions, domains: input.domains, expiresAt });
    // The token and its audit row in one statement.
    await c.env.db.execute(sql`WITH t AS (INSERT INTO agent_tokens(id, workspace_id, grant_id, permissions, domains, purpose, expires_at)
      VALUES (${tokenId}, ${identity.workspaceId}, ${identity.keyId}, ${JSON.stringify(input.permissions)}::jsonb, ${JSON.stringify(input.domains)}::jsonb, ${input.purpose}, ${expiresAt}::timestamptz) RETURNING id)
      ${auditInsert(auditContext(c), { action: 'agent_token.create', workspaceId: identity.workspaceId, target: { type: 'agent_token', id: tokenId },
        after: { permissions: input.permissions, domains: input.domains, purpose: input.purpose, expiresAt } }, { from: sql`t` })}`);
    return c.json({ id: tokenId, token, expiresAt, permissions: input.permissions, domains: input.domains, purpose: input.purpose }, 201);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/agent-tokens', operationId: 'listAgentTokens', tags: ['Auth'], security, request: { query: PageQuery.extend({ includeInactive: z.enum(['true', 'false']).default('false') }) }, responses: { 200: response(page(AgentTokenRecord)), ...errors } }), async c => {
    const identity = manageKeys(c); const query = c.req.valid('query');
    const rows = await c.env.db.select().from(agentTokens).where(and(eq(agentTokens.workspaceId, identity.workspaceId), query.includeInactive === 'false' ? and(isNull(agentTokens.revokedAt), gt(agentTokens.expiresAt, new Date().toISOString())) : undefined, query.cursor ? gt(agentTokens.id, query.cursor) : undefined)).orderBy(agentTokens.id).limit(query.limit + 1);
    const data = rows.slice(0, query.limit).map(({ workspaceId: _workspace, ...row }) => row);
    return c.json({ data, nextCursor: rows.length > query.limit ? rows[query.limit - 1]!.id : null }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/agent-tokens/{id}/revoke', operationId: 'revokeAgentToken', tags: ['Auth'], security, request: { params: IdParams }, responses: { 200: response(z.object({ id: z.string(), revoked: z.literal(true) })), ...errors } }), async c => {
    const identity = manageKeys(c), tokenId = c.req.valid('param').id;
    const { rows: [row] } = await c.env.db.execute<{ id: string }>(sql`WITH t AS (UPDATE agent_tokens SET revoked_at = now() WHERE workspace_id = ${identity.workspaceId} AND id = ${tokenId} AND revoked_at IS NULL
        RETURNING id, purpose), a AS (${auditInsert(auditContext(c), { action: 'agent_token.revoke', workspaceId: identity.workspaceId, target: { type: 'agent_token', id: sql`t.id` },
        before: sql`jsonb_build_object('purpose', left(t.purpose, 200))` }, { from: sql`t` })}) SELECT id FROM t`);
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Agent token was not found or is already revoked.');
    return c.json({ id: row.id, revoked: true as const }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/api-keys', operationId: 'createApiKey', tags: ['ApiKeys'], security,
    description: 'One key type with permissions. By default a workspace key (permissions, optional sender domains). With access, a key limited to receiving addresses or to one agent inbox (bearer nm_mbx_…): it reads and, with send, replies only there, and never reaches the rest of the workspace. The secret is returned once.',
    request: { body: json(KeyInput) }, responses: { 201: response(KeySchema.extend({ secret: z.string() })), ...errors } }), async c => {
    const auth = manageKeys(c); const input = c.req.valid('json'), access = input.access ?? { type: 'workspace' as const };
    if (access.type !== 'workspace') {
      if (input.permissions || input.domains?.length) throw new ApiError(422, 'VALIDATION_FAILED', 'A key for addresses or an inbox takes its permissions in access.mail and has no sender domains.', input.permissions ? 'permissions' : 'domains');
      const { createLimitedKey, limitedKeyView } = await addressKeys();
      const { row, secret } = await createLimitedKey(c, auth.workspaceId, input.name, access, { addresses: 'access.addressIds', inbox: 'access.inboxId', mail: 'access.mail' });
      return c.json({ ...limitedKeyView(row), secret }, 201);
    }
    const permissions = input.permissions ?? ['send'], domains = input.domains ?? [];
    const secret = randomSecret(secretPrefixes.apiKey);
    const [key] = await c.env.db.transaction(async tx => {
      const rows = await tx.insert(apiKeys).values({ id: id('key'), workspaceId: auth.workspaceId, name: input.name, permissions, domains, hash: await digest(secret), prefix: shownPrefix(secret) }).returning();
      // A key created by an MCP agent lives only as long as the approval that created it.
      if (auth.grantId) await tx.execute(sql`INSERT INTO mail_grant_objects VALUES(${auth.grantId},${auth.workspaceId},'api_key',${rows[0]!.id})`);
      await recordAudit(tx, c, { action: 'api_key.create', workspaceId: auth.workspaceId, target: { type: 'api_key', id: rows[0]!.id },
        after: { name: input.name, permissions, domains, prefix: rows[0]!.prefix.slice(0, 9), mcpGrant: auth.grantId ?? undefined } });
      return rows;
    });
    return c.json({ ...keyView(key!), secret }, 201);
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/api-keys', operationId: 'listApiKeys', tags: ['ApiKeys'], security, description: 'Every API key in the workspace, ordered by ID: workspace keys and keys limited to addresses or an inbox. includeRevoked=false also leaves out keys whose inbox was deleted or whose lease ended.',
    request: { query: PageQuery.extend({ includeRevoked: z.enum(['true', 'false']).default('true') }) }, responses: { 200: response(page(KeySchema)), ...errors } }), async c => {
    const auth = manageKeys(c); const q = c.req.valid('query'), w = auth.workspaceId, active = q.includeRevoked === 'false', after = q.cursor ? sql`AND id > ${q.cursor}` : sql``;
    // One cursor over both tables. A limited key has no workspace permissions or domains: its access says what it may do.
    const { rows } = await c.env.db.execute<{ id: string; name: string; prefix: string; permissions: ('read' | 'send' | 'manage')[]; domains: string[]; created_at: string; last_used_at: string | null; revoked_at: string | null;
      expires_at: string | null; address_ids: string[] | null; inbox_id: string | null; mail: ('read' | 'send' | 'modify' | 'create')[]; limited: boolean }>(sql`
      SELECT * FROM (SELECT id, name, prefix, permissions, domains, created_at::text, last_used_at::text, revoked_at::text, NULL::text AS expires_at, NULL::jsonb AS address_ids, NULL::text AS inbox_id, '[]'::jsonb AS mail, false AS limited
          FROM api_keys WHERE workspace_id = ${w} ${active ? sql`AND revoked_at IS NULL` : sql``} ${after}
        UNION ALL SELECT id, name, prefix, '[]'::jsonb, '[]'::jsonb, created_at::text, last_used_at::text, revoked_at::text, expires_at::text, mailbox_ids, inbox_id, permissions, true
          FROM mailbox_keys WHERE workspace_id = ${w} ${active ? sql`AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())` : sql``} ${after}) k
      ORDER BY id LIMIT ${q.limit + 1}`);
    const data = rows.slice(0, q.limit).map(r => ({ id: r.id, name: r.name, permissions: r.permissions, domains: r.domains, prefix: r.prefix,
      createdAt: isoTime(r.created_at)!, lastUsedAt: isoTime(r.last_used_at), revokedAt: isoTime(r.revoked_at), expiresAt: isoTime(r.expires_at),
      access: r.limited ? { type: r.inbox_id ? 'inbox' as const : 'addresses' as const, addressIds: r.address_ids, inboxId: r.inbox_id, mail: r.mail } : workspaceAccess }));
    return c.json({ data, nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/api-keys/{id}/revoke', operationId: 'revokeApiKey', tags: ['ApiKeys'], security, description: 'Revokes any API key, including one limited to addresses or an inbox. Requests with it fail at once, and mail it queued is not sent.',
    request: { params: IdParams }, responses: { 200: response(z.object({ id: z.string(), revoked: z.literal(true) })), ...errors } }), async c => {
    const auth = manageKeys(c); const keyId = c.req.valid('param').id;
    if (keyId.startsWith('mbk_')) {
      const revoked = await (await addressKeys()).revokeLimitedKey(c, auth.workspaceId, keyId);
      if (!revoked) throw new ApiError(404, 'NOT_FOUND', 'API key was not found.');
      return c.json({ id: revoked.row.id, revoked: true as const }, 200);
    }
    // A repeated revoke keeps the first revocation time and writes no second audit row.
    const { rows: [key] } = await c.env.db.execute<{ id: string }>(sql`WITH k AS (UPDATE api_keys SET revoked_at = coalesce(revoked_at, now()) WHERE id = ${keyId} AND workspace_id = ${auth.workspaceId}
        RETURNING id, name, left(prefix, 9) AS prefix, revoked_at = now() AS fresh),
      a AS (${auditInsert(auditContext(c), { action: 'api_key.revoke', workspaceId: auth.workspaceId, target: { type: 'api_key', id: sql`k.id` },
        before: sql`jsonb_build_object('name', k.name, 'prefix', k.prefix)` }, { from: sql`k`, where: sql`k.fresh` })}) SELECT id FROM k`);
    if (!key) throw new ApiError(404, 'NOT_FOUND', 'API key was not found.');
    return c.json({ id: key.id, revoked: true as const }, 200);
  });
}
