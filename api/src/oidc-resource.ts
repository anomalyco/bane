import * as oauth from 'oauth4webapi';
import { Buffer } from 'node:buffer';
import { sql } from 'drizzle-orm';
import { digest, log, type Actor, type Runtime, type DbExecutor, type Permission } from './core.js';

const permissions: Permission[] = ['read', 'send', 'manage'];
const SCOPES = permissions.map(p => `bane:${p}`);
const audience = (runtime: Runtime) => new URL('/mcp', runtime.config.publicUrl).href;
export function protectedResourceMetadata(runtime: Runtime) {
  return { resource: audience(runtime), resource_name:'Bane', authorization_servers: [runtime.config.accountIssuer],
    scopes_supported: SCOPES, bearer_methods_supported: ['header'],
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

// At most 40 characters of letters, digits, spaces and . _ - ( ), trimmed; anything else (or nothing left) is no label.
export function profileLabel(value: string | null) {
  const label = value?.normalize('NFKC').replace(/[^\p{L}\p{N} ._()-]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(label ?? '').slice(0, 40).join('').trim() || null;
}

// What a role may do: owners and admins everything, members read and send. A call acts with the approval's scopes
// intersected with this, in the workspace it names.
const rolePermissions = (role: string): Permission[] => role === 'owner' || role === 'admin' ? permissions : ['read', 'send'];

/**
 * An MCP approval (one per account and client, as the account service's tokens name them) acting in one workspace,
 * or null. The approval is active (not revoked, its token not expired); the person who made it still belongs to the
 * workspace (and, self-hosted, is an allowlisted owner or admin); it acts with its scopes intersected with their role
 * there. Receiving tools need an owner or admin (receivingConsent), and changing them the bane:manage scope as well, as
 * every write does. Checked on every MCP tool call, and
 * whenever a credential or object the approval created is used in that workspace.
 */
export async function externalMcpGrant(runtime: Runtime, keyId: string, workspaceId: string, db: DbExecutor = runtime.db): Promise<Actor | null> {
  const { rows: [grant] } = await db.execute<{role: string; permissions: Permission[]}>(sql`
    SELECT m.role, g.permissions FROM bane_resource_grants g
    JOIN bane_oidc_identities i ON (g.issuer, g.subject, g.user_id) = (i.issuer, i.subject, i.user_id)
    JOIN bane_users u ON u.id=i.user_id
    JOIN workspace_members m ON m.workspace_id = ${workspaceId} AND m.user_id = i.user_id
    WHERE g.id = ${keyId} AND g.issuer = ${runtime.config.accountIssuer} AND NOT g.revoked AND g.expires_at > now()
      AND m.role IN ('owner','admin','member')
      AND (${runtime.config.multiTenant} OR (m.role IN ('owner','admin') AND ${JSON.stringify(runtime.config.allowedSubjects)}::jsonb ? i.subject)) FOR SHARE OF g, i, m, u`);
  if (!grant) return null;
  const allowed = grant.permissions.filter(p => rolePermissions(grant.role).includes(p));
  return allowed.length ? { keyId, grantId: keyId.slice(4), receivingConsent: grant.role !== 'member', workspaceId, role: grant.role, permissions: allowed, domains: [], credential: 'mcp' } : null;
}

export type McpWorkspace = { id: string; name: string; slug: string; role: 'owner' | 'admin' | 'member'; permissions: Permission[] };
/** An authenticated MCP connection: its approval and the workspaces it can act in. Each tool call picks one. */
export type McpConnection = {
  keyId: string; userId: string; permissions: Permission[]; workspaces: McpWorkspace[];
  /** The workspace a call without `workspace` acts in, and why: set on this connection, the only one, or the dashboard's last. */
  defaultWorkspace: { id: string; source: 'set' | 'only' | 'last-used' } | null;
  /** Everything the connection could do in some workspace: what its listing shows. Each call is checked again. */
  listing: Actor;
};
export class WorkspaceChoice extends Error {
  constructor(readonly code: 'WORKSPACE_REQUIRED' | 'WORKSPACE_NOT_FOUND' | 'WORKSPACE_AMBIGUOUS' | 'WORKSPACE_ACCESS_DENIED', message: string) { super(message); }
}
/** The workspace a tool call names (ID, slug or name, as the workspaces tool lists them), else the connection's default. */
export function chooseWorkspace(connection: McpConnection, value: string | undefined) {
  const choices = () => connection.workspaces.map(w => `${w.name} (${w.id})`).join(', ');
  if (value === undefined) {
    if (connection.defaultWorkspace) return connection.defaultWorkspace.id;
    throw new WorkspaceChoice('WORKSPACE_REQUIRED', `Pass workspace (an ID or name) or set a default with setDefaultWorkspace. Your workspaces: ${choices()}.`);
  }
  const exact = connection.workspaces.find(w => w.id === value) ?? connection.workspaces.find(w => w.slug === value);
  if (exact) return exact.id;
  const named = connection.workspaces.filter(w => w.name.toLowerCase() === value.trim().toLowerCase());
  if (named.length === 1) return named[0]!.id;
  if (named.length > 1) throw new WorkspaceChoice('WORKSPACE_AMBIGUOUS', `Several of your workspaces are named ${value.slice(0, 120)}: pass its ID. ${choices()}.`);
  // Never says whether a workspace exists that this account doesn't belong to.
  throw new WorkspaceChoice('WORKSPACE_ACCESS_DENIED', `You don't belong to a workspace ${value.slice(0, 120)}. Your workspaces: ${choices()}.`);
}

/** The workspaces an approval's person belongs to, with what this approval (narrowed to the presented token's scopes)
 * may do in each, and its default. */
export async function mcpConnection(runtime: Runtime, keyId: string, scopes: Permission[] = permissions): Promise<McpConnection | null> {
  const { rows } = await runtime.db.execute<{ user_id: string; permissions: Permission[]; chosen: string | null; last_used: string | null; id: string | null; name: string | null; slug: string | null; role: McpWorkspace['role'] | null }>(sql`
    SELECT g.user_id, g.permissions, g.workspace_id AS chosen, u.selected_workspace_id AS last_used, w.id, w.name, w.slug, m.role
    FROM bane_resource_grants g JOIN bane_oidc_identities i ON (g.issuer, g.subject, g.user_id) = (i.issuer, i.subject, i.user_id)
    JOIN bane_users u ON u.id = i.user_id
    LEFT JOIN workspace_members m ON m.user_id = i.user_id AND m.role IN ('owner','admin','member')
      AND (${runtime.config.multiTenant} OR (m.role IN ('owner','admin') AND ${JSON.stringify(runtime.config.allowedSubjects)}::jsonb ? i.subject))
    LEFT JOIN workspaces w ON w.id = m.workspace_id
    WHERE g.id = ${keyId} AND g.issuer = ${runtime.config.accountIssuer} AND NOT g.revoked AND g.expires_at > now()
    ORDER BY w.name, w.id`);
  const first = rows[0];
  if (!first) return null;
  const granted = first.permissions.filter(p => scopes.includes(p));
  const workspaces = rows.flatMap(r => r.id && r.role ? [{ id: r.id, name: r.name!, slug: r.slug!, role: r.role, permissions: granted.filter(p => rolePermissions(r.role!).includes(p)) }] : [])
    .filter(w => w.permissions.length);
  const member = (id: string | null) => !!id && workspaces.some(w => w.id === id);
  const defaultWorkspace = member(first.chosen) ? { id: first.chosen!, source: 'set' as const } : workspaces.length === 1 ? { id: workspaces[0]!.id, source: 'only' as const }
    : member(first.last_used) ? { id: first.last_used!, source: 'last-used' as const } : null;
  const best = workspaces.find(w => w.role !== 'member') ?? workspaces[0];
  const listingPermissions = [...new Set(workspaces.flatMap(w => w.permissions))];
  const listing: Actor = { keyId, grantId: keyId.slice(4), workspaceId: defaultWorkspace?.id ?? best?.id ?? '', role: best?.role ?? 'member', permissions: permissions.filter(p => listingPermissions.includes(p)),
    receivingConsent: workspaces.some(w => w.role !== 'member'), domains: [], credential: 'mcp' };
  return { keyId, userId: first.user_id, permissions: granted, workspaces, defaultWorkspace, listing };
}

/** Sets the workspace a connection's calls use when they name none. Only one of the person's own. */
export async function setDefaultWorkspace(runtime: Runtime, keyId: string, workspaceId: string) {
  await runtime.db.execute(sql`UPDATE bane_resource_grants SET workspace_id=${workspaceId}, updated_at=now() WHERE id=${keyId} AND NOT revoked`);
}

/** The JWT's audience when it names this resource: /mcp on this origin, with any query (OpenCode sends the URL it was
 * configured with, such as /mcp?codemode=true, as the resource). The signature and the rest are checked as usual. */
function expectedAudience(resource: string, token: string) {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { aud?: unknown };
    const aud = Array.isArray(claims.aud) && claims.aud.length === 1 ? claims.aud[0] : claims.aud;
    if (typeof aud !== 'string' || aud.includes('#')) return resource;
    const url = new URL(aud);
    return `${url.origin}${url.pathname}` === resource && !url.username && !url.password ? aud : resource;
  } catch { return resource; }
}

export async function authorizeResource(runtime: Runtime, request: Request, handler: (connection: McpConnection) => Promise<Response>) {
  const resource = audience(runtime);
  const metadata = new URL('/.well-known/oauth-protected-resource/mcp', resource).href;
  // MCP clients expect a JSON-RPC envelope; the challenge itself lives in WWW-Authenticate (RFC 6750, RFC 9470). The
  // scope is every Bane scope: clients ask for what the challenge names, and the person narrows it when approving.
  // `detail` replaces only the JSON-RPC message; the challenge header keeps its fixed description.
  function denied(status: 401 | 403, error = status === 401 ? 'invalid_token' : 'insufficient_scope', extra = '', detail?: string) {
    const scheme = /^dpop /i.test(request.headers.get('authorization') ?? '') ? 'DPoP' : 'Bearer';
    const message = error === 'insufficient_user_authentication' ? 'Bane requires Google sign-in. Reconnect this MCP client and choose Google at Anomaly account.'
      : status === 401 ? 'Reconnect and authorize this MCP client at the account service.' : 'This client has no active Bane approval for the requested access.';
    return Response.json({jsonrpc:'2.0', error:{code:-32000, message:detail ?? message}, id:null}, {status, headers: { 'cache-control':'no-store', 'www-authenticate':`${scheme} error="${error}", error_description="${message}", resource_metadata="${metadata}", scope="${SCOPES.join(' ')}"${extra}` }});
  }
  const auth = request.headers.get('authorization');
  if (!auth || auth.length > 16384 || (request.headers.get('dpop')?.length ?? 0) > 8192) return denied(401);
  let claims: oauth.JWTAccessTokenClaims;
  try {
    const as = await authority(runtime.config.accountIssuer!);
    // The audience is this resource; htm and htu must match the actual HTTP request.
    claims = await oauth.validateJwtAccessToken(as, request, expectedAudience(resource, auth.replace(/^(?:Bearer|DPoP)\s+/i, '')),
      { signingAlgorithms: ['ES256','RS256'], [oauth.clockTolerance]: 0, signal: AbortSignal.timeout(5000) });
  } catch { return denied(401); }
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
  // One approval per account and client: the same client used by two accounts (a personal and a work entry) gets two.
  // The account service's consent behind this token: its access tokens' jti is <consent>.<random>.
  const consent = typeof claims.jti === 'string' ? /^([A-Za-z0-9_-]{8,200})\.[A-Za-z0-9_-]{8,200}$/.exec(claims.jti)?.[1] ?? null : null;
  // `?profile=` on the MCP URL is only a label for that entry, shown in Bane; it never selects or authorizes anything.
  const profile = profileLabel(new URL(request.url).searchParams.get('profile'));
  // Revoked in Bane, an approval refuses the tokens of the consents it had. A token of a new consent (the person
  // connected the client again at the account service) starts it again under a new key, so nothing tied to the revoked
  // one comes back: its credentials, objects, ritual parts and scheduled mail stay ended. (Clients with a fixed
  // client_id, such as OpenCode's metadata document, could otherwise never reconnect that account.)
  if (consent) await runtime.db.execute(sql`UPDATE bane_resource_grants SET id=${'mcp_at_' + await digest(JSON.stringify([userId, claims.client_id, consent]))},
      revoked=false, issuer_grant=${consent}, permissions=${sql.param(allowed)}::text[], expires_at=to_timestamp(${claims.exp}), issued_at=${claims.iat},
      profile=coalesce(${profile}, profile), created_at=now(), updated_at=now(), issuer=${claims.iss}, subject=${claims.sub}
    WHERE user_id=${userId} AND client_id=${claims.client_id} AND revoked AND issuer_grant IS NOT NULL AND NOT ${consent}=ANY(revoked_issuer_grants)`);
  // The approval follows the newest token: its scopes, expiry and consent. It names no workspace: every tool call names
  // one (or uses the connection's default, workspace_id) and is checked against the person's membership and role there.
  const { rows: [upserted] } = await runtime.db.execute<{created:boolean}>(sql`INSERT INTO bane_resource_grants(id,issuer,subject,user_id,client_id,permissions,expires_at,issued_at,profile,issuer_grant)
    VALUES (${'mcp_at_' + await digest(JSON.stringify([userId, claims.client_id]))},${claims.iss},${claims.sub},${userId},${claims.client_id},${sql.param(allowed)}::text[],to_timestamp(${claims.exp}),${claims.iat},${profile},${consent})
    ON CONFLICT(user_id,client_id) DO UPDATE SET permissions=excluded.permissions,expires_at=excluded.expires_at,profile=coalesce(excluded.profile,bane_resource_grants.profile),
      issued_at=excluded.issued_at,updated_at=now(),issuer=excluded.issuer,subject=excluded.subject,issuer_grant=coalesce(excluded.issuer_grant,bane_resource_grants.issuer_grant)
    WHERE NOT bane_resource_grants.revoked AND NOT coalesce(excluded.issuer_grant=ANY(bane_resource_grants.revoked_issuer_grants), false)
      AND (excluded.issued_at>bane_resource_grants.issued_at OR (excluded.issued_at=bane_resource_grants.issued_at AND
        excluded.permissions=bane_resource_grants.permissions AND excluded.expires_at>bane_resource_grants.expires_at))
    RETURNING (xmax=0) AS created`);
  if (upserted?.created) log('info', { code: 'MCP_APPROVAL_CREATED', userId, client: String(claims.client_id).slice(0, 200) });
  const { rows: [approval] } = await runtime.db.execute<{ id: string; blocked: boolean }>(sql`SELECT id, revoked OR coalesce(${consent}::text=ANY(revoked_issuer_grants), false) AS blocked
    FROM bane_resource_grants WHERE user_id=${userId} AND client_id=${claims.client_id}`);
  if (!approval || approval.blocked) return denied(403);
  const keyId = approval.id;
  // The presented token's own scopes: a token older than the approval's newest may carry fewer.
  const connection = await mcpConnection(runtime, keyId, allowed);
  if (!connection) return denied(403);
  if (!connection.workspaces.length) return denied(403, undefined, '', 'This account belongs to no Bane workspace these scopes can act in. Join or create one in Bane, then reconnect.');
  return handler(connection);
}
