import * as oauth from 'oauth4webapi';
import { sql } from 'drizzle-orm';
import { digest, log, type Actor, type Runtime, type DbExecutor, type Permission } from './core.js';

const permissions: Permission[] = ['read', 'send', 'manage'];
const audience = (runtime: Runtime) => new URL('/mcp', runtime.config.publicUrl).href;
export function protectedResourceMetadata(runtime: Runtime) {
  return { resource: audience(runtime), resource_name:'Bane', authorization_servers: [runtime.config.accountIssuer],
    scopes_supported: permissions.map(p => `bane:${p}`), bearer_methods_supported: ['header'],
    // Provisional extension name until the issuer publishes its metadata contract.
    scope_descriptions:{'bane:read':'Read workspace data.', 'bane:send':'Send email from the workspace.', 'bane:manage':'Manage workspace mail and resources.'} };
}

// Cache only completed public metadata. Each Worker request owns its fetches.
const authorities = new Map<string, { metadata: oauth.AuthorizationServer; expires: number }>();
async function authority(issuer: string) {
  const cached = authorities.get(issuer);
  if (cached && cached.expires > Date.now()) return cached.metadata;
  const url = new URL(issuer);
  const response = await oauth.discoveryRequest(url, { signal: AbortSignal.timeout(5000) });
  const metadata = await oauth.processDiscoveryResponse(url, response);
  if (!metadata.jwks_uri || new URL(metadata.jwks_uri).protocol !== 'https:') throw Error('Issuer has no HTTPS JWKS');
  if (authorities.size >= 16) authorities.clear();
  authorities.set(issuer, { metadata, expires: Date.now() + 300_000 });
  return metadata;
}

export async function externalMcpGrant(runtime: Runtime, keyId: string, db: DbExecutor = runtime.db): Promise<Actor | null> {
  const { rows: [grant] } = await db.execute<{workspace_id: string; role: string; permissions: Permission[]; receiving:boolean}>(sql`
    SELECT g.workspace_id, m.role, g.permissions,g.receiving FROM bane_resource_grants g
    JOIN bane_oidc_identities i ON (g.issuer, g.subject, g.user_id) = (i.issuer, i.subject, i.user_id)
    JOIN bane_users u ON u.id=i.user_id
    JOIN workspace_members m ON m.workspace_id = g.workspace_id AND m.user_id = i.user_id
    WHERE g.id = ${keyId} AND g.issuer = ${runtime.config.accountIssuer} AND NOT g.revoked AND g.expires_at > now()
      AND m.role IN ('owner','admin','member') AND u.email_verified
      AND (${runtime.config.multiTenant} OR (m.role IN ('owner','admin') AND ${JSON.stringify(runtime.config.allowedEmails)}::jsonb ? lower(u.email))) FOR SHARE OF g, i, m, u`);
  if (!grant) return null;
  const allowed = grant.permissions.filter(p => p !== 'manage' || grant.role !== 'member');
  return allowed.length ? { keyId, grantId: keyId.slice(4), receivingConsent: grant.receiving, workspaceId: grant.workspace_id, role: grant.role, permissions: allowed, domains: [], credential: 'mcp' } : null;
}

export async function authorizeResource(runtime: Runtime, request: Request, handler: (actor: Actor) => Promise<Response>) {
  const resource = audience(runtime);
  const metadata = new URL('/.well-known/oauth-protected-resource/mcp', resource).href;
  // MCP clients expect a JSON-RPC envelope; the challenge itself lives in WWW-Authenticate (RFC 6750, RFC 9470).
  // `detail` replaces only the JSON-RPC message; the challenge header keeps its fixed description.
  function denied(status: 401 | 403, error = status === 401 ? 'invalid_token' : 'insufficient_scope', extra = '', detail?: string) {
    const scheme = /^dpop /i.test(request.headers.get('authorization') ?? '') ? 'DPoP' : 'Bearer';
    const message = error === 'insufficient_user_authentication' ? 'Bane requires Google sign-in. Reconnect this MCP client and choose Google at Anomaly account.'
      : status === 401 ? 'Reconnect and authorize this MCP client at the account service.' : 'This client has no active Bane approval for the requested access.';
    return Response.json({jsonrpc:'2.0', error:{code:-32000, message:detail ?? message}, id:null}, {status, headers: { 'cache-control':'no-store', 'www-authenticate':`${scheme} error="${error}", error_description="${message}", resource_metadata="${metadata}", scope="bane:read"${extra}` }});
  }
  const auth = request.headers.get('authorization');
  if (!auth || auth.length > 16384 || (request.headers.get('dpop')?.length ?? 0) > 8192) return denied(401);
  let claims: oauth.JWTAccessTokenClaims;
  try {
    const as = await authority(runtime.config.accountIssuer!);
    // The audience is configured; htm and htu must match the actual HTTP request.
    claims = await oauth.validateJwtAccessToken(as, request, resource,
      { signingAlgorithms: ['ES256','RS256'], [oauth.clockTolerance]: 0, signal: AbortSignal.timeout(5000) });
  } catch { return denied(401); }
  if (claims.aud !== resource && !(Array.isArray(claims.aud) && claims.aud.length === 1 && claims.aud[0] === resource)) return denied(401);
  // A token minted in the future would also block every later token from updating the approval.
  if (typeof claims.iat !== 'number' || claims.iat > Date.now() / 1000 + 30) return denied(401);
  // The dashboard's sign-in requirement applies to every access token, refreshed ones included:
  // the issuer copies the authentication context of the original sign-in into each token it mints.
  const requiredAcr = runtime.config.accountRequiredAcr;
  if (requiredAcr && claims.acr !== requiredAcr) {
    log('warn', { code: 'MCP_ACR_REFUSED', client: String(claims.client_id).slice(0, 200), acr: typeof claims.acr === 'string' ? claims.acr.slice(0, 100) : null });
    return denied(401, 'insufficient_user_authentication', `, acr_values="${requiredAcr}"`);
  }
  const scopes = new Set(typeof claims.scope === 'string' ? claims.scope.split(' ') : []);
  const allowed = permissions.filter(p => scopes.has(`bane:${p}`));
  if (!allowed.length) return denied(403);
  const proof = request.headers.get('dpop');
  if (proof) {
    const {jti} = JSON.parse(Buffer.from(proof.split('.')[1]!, 'base64url').toString('utf8')) as {jti:string};
    const replay = await digest(JSON.stringify([claims.iss, claims.cnf, jti]));
    const inserted = await runtime.db.execute(sql`INSERT INTO bane_dpop_proofs(id, expires_at) VALUES (${replay}, now()+interval '11 minutes') ON CONFLICT DO NOTHING RETURNING id`);
    if (!inserted.rowCount) return denied(401);
  }
  const identity = await runtime.db.execute<{user_id:string}>(sql`SELECT user_id FROM bane_oidc_identities WHERE issuer=${claims.iss} AND subject=${claims.sub}`);
  const userId=identity.rows[0]?.user_id;
  if (!userId) return denied(403);
  const keyId = 'mcp_at_' + await digest(JSON.stringify([userId,claims.client_id]));
  // The first approval binds to the user's only workspace. With several, it waits unbound (workspace_id NULL)
  // until the user chooses one in Bane; an unbound approval (or one whose workspace was deleted) binds by
  // itself once one membership remains, without receiving: that consent named the old workspace. A bound approval
  // keeps its workspace when the user joins others.
  const { rows: [upserted] } = await runtime.db.execute<{created:boolean;workspace_id:string|null}>(sql`WITH existing AS (SELECT workspace_id FROM bane_resource_grants WHERE id=${keyId}), memberships AS (
    SELECT m.workspace_id, m.role FROM workspace_members m WHERE m.user_id=${userId} AND m.role IN ('owner','admin','member')
      AND (NOT EXISTS(SELECT FROM existing WHERE workspace_id IS NOT NULL) OR m.workspace_id=(SELECT workspace_id FROM existing)) LIMIT 2
  ), target AS (
    SELECT workspace_id, role FROM memberships WHERE (SELECT count(*) FROM memberships)=1
    UNION ALL SELECT NULL, NULL WHERE (SELECT count(*) FROM memberships)=2
  ) INSERT INTO bane_resource_grants(id,issuer,subject,user_id,client_id,workspace_id,permissions,expires_at,issued_at)
    SELECT ${keyId},${claims.iss},${claims.sub},${userId},${claims.client_id},workspace_id,
      CASE WHEN role='member' THEN array_remove(${sql.param(allowed)}::text[],'manage') ELSE ${sql.param(allowed)}::text[] END,
      to_timestamp(${claims.exp}),${claims.iat} FROM target
    ON CONFLICT(user_id,client_id) DO UPDATE SET permissions=excluded.permissions,expires_at=excluded.expires_at,
      issued_at=excluded.issued_at,updated_at=now(),issuer=excluded.issuer,subject=excluded.subject,workspace_id=excluded.workspace_id,
      receiving=bane_resource_grants.receiving AND bane_resource_grants.workspace_id IS NOT NULL
    WHERE NOT bane_resource_grants.revoked AND (bane_resource_grants.workspace_id IS NULL OR bane_resource_grants.workspace_id=excluded.workspace_id)
      AND (excluded.issued_at>bane_resource_grants.issued_at OR (excluded.issued_at=bane_resource_grants.issued_at AND
        excluded.permissions=bane_resource_grants.permissions AND excluded.expires_at>bane_resource_grants.expires_at))
    RETURNING (xmax=0) AS created, workspace_id`);
  if (upserted?.created) log('info', { code: 'MCP_APPROVAL_CREATED', userId, client: String(claims.client_id).slice(0, 200), pending: upserted.workspace_id === null });
  const actor = await externalMcpGrant(runtime, keyId);
  if (!actor) {
    const { rows: [pending] } = await runtime.db.execute(sql`SELECT FROM bane_resource_grants WHERE id=${keyId} AND workspace_id IS NULL AND NOT revoked`);
    return pending ? denied(403, undefined, '', `Choose a workspace for this MCP client in Bane: ${new URL('/settings/account', runtime.config.publicUrl).href}`) : denied(403);
  }
  const granted=actor.permissions.filter(permission=>allowed.includes(permission));
  return granted.length ? handler({...actor,permissions:granted}) : denied(403);
}
