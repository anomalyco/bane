import { Buffer } from 'node:buffer';
import { sql } from 'drizzle-orm';
import { digest, log, type Actor, type DbExecutor, type Permission, type Runtime } from './core.js';

// The resource server side of Bane's MCP authorization: what /mcp accepts and what an approval may do right now. The
// authorization server that issues these tokens is oauth-server.ts; both live in this installation, on its PUBLIC_URL.
export const PERMISSIONS: Permission[] = ['read', 'send', 'manage'];
export const SCOPES = PERMISSIONS.map(p => `bane:${p}`);
export const SCOPE_DESCRIPTIONS: Record<string, string> = { 'bane:read': 'Read workspace data.', 'bane:send': 'Send email from the workspace.', 'bane:manage': 'Manage workspace mail and resources.' };
/** The authorization server's issuer identifier: PUBLIC_URL's origin, exactly as `authorization_servers` names it. */
export const issuer = (runtime: Pick<Runtime, 'config'>) => runtime.config.publicUrl;
/** The one protected resource. Every token's audience; a `resource` naming /mcp with any query is this resource. */
export const mcpResource = (runtime: Pick<Runtime, 'config'>) => `${runtime.config.publicUrl}/mcp`;
export const ACCESS_TOKEN = /^bane_at_[0-9a-f]{64}$/, MCP_KEY = /^bane_mcp_[0-9a-f]{64}$/;

export function protectedResourceMetadata(runtime: Runtime) {
  return { resource: mcpResource(runtime), resource_name: 'Bane', authorization_servers: [issuer(runtime)], scopes_supported: SCOPES,
    bearer_methods_supported: ['header'], dpop_signing_alg_values_supported: Object.keys(DPOP_ALGORITHMS), dpop_bound_access_tokens_required: false,
    resource_documentation: `${runtime.config.publicUrl}/docs`,
    // Provisional extension, kept from the previous metadata for clients that show it.
    scope_descriptions: SCOPE_DESCRIPTIONS };
}

// At most 40 characters of letters, digits, spaces and . _ - ( ), trimmed; anything else (or nothing left) is no label.
export function profileLabel(value: string | null) {
  const label = value?.normalize('NFKC').replace(/[^\p{L}\p{N} ._()-]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(label ?? '').slice(0, 40).join('').trim() || null;
}

/**
 * What an approval may do now, or null: it isn't revoked or expired, the person still belongs to its workspace (and, on
 * a self-hosted installation, is an allowlisted owner or admin), and their role still covers what they approved: a
 * member can't hold manage, so a manage approval made by an admin who is now a member stops (approve it again with what
 * a member may grant). Receiving consent stays limited by the role guards of the routes it opens, as before. When ACCOUNT_REQUIRED_ACR is set, the session that approved it must
 * have signed in that way. Used by /mcp, the token endpoint, agent tokens and keys an approval created.
 */
export async function mcpGrantActor(runtime: Runtime, keyId: string, db: DbExecutor = runtime.db): Promise<Actor | null> {
  const { rows: [grant] } = await db.execute<{ workspace_id: string; role: string; permissions: Permission[]; receiving: boolean; acr: string | null; kind: string }>(sql`
    SELECT g.workspace_id, m.role, g.permissions, g.receiving, g.acr, g.kind FROM bane_resource_grants g
    JOIN bane_oidc_identities i ON (g.issuer, g.subject, g.user_id) = (i.issuer, i.subject, i.user_id)
    JOIN bane_users u ON u.id=i.user_id
    JOIN workspace_members m ON m.workspace_id = g.workspace_id AND m.user_id = i.user_id
    WHERE g.id = ${keyId} AND g.issuer = ${runtime.config.accountIssuer} AND g.kind IN ('oauth','key') AND NOT g.revoked AND g.expires_at > now()
      AND m.role IN ('owner','admin','member')
      AND (${runtime.config.multiTenant} OR (m.role IN ('owner','admin') AND ${JSON.stringify(runtime.config.allowedSubjects)}::jsonb ? i.subject)) FOR SHARE OF g, i, m, u`);
  if (!grant) return null;
  const required = runtime.config.accountRequiredAcr;
  if (required && grant.acr !== required) return null;
  if (grant.role === 'member' && grant.permissions.includes('manage')) return null;
  return grant.permissions.length ? { keyId, grantId: keyId.slice(4), receivingConsent: grant.receiving, workspaceId: grant.workspace_id, role: grant.role, permissions: grant.permissions, domains: [], credential: 'mcp' } : null;
}

// ---------- DPoP (RFC 9449), optional ----------

const DPOP_ALGORITHMS: Record<string, { kty: string; crv?: string; key: EcKeyImportParams | RsaHashedImportParams | Algorithm; verify: EcdsaParams | Algorithm }> = {
  ES256: { kty: 'EC', crv: 'P-256', key: { name: 'ECDSA', namedCurve: 'P-256' }, verify: { name: 'ECDSA', hash: 'SHA-256' } },
  EdDSA: { kty: 'OKP', crv: 'Ed25519', key: { name: 'Ed25519' }, verify: { name: 'Ed25519' } },
  RS256: { kty: 'RSA', key: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, verify: { name: 'RSASSA-PKCS1-v1_5' } },
};
export const DPOP_ALGS = Object.keys(DPOP_ALGORITHMS);
const b64 = (value: string) => Buffer.from(value, 'base64url');
const sha256 = async (value: string) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString('base64url');
/** The access token hash a DPoP proof carries (`ath`). */
export const tokenHash = sha256;

/**
 * Verifies a DPoP proof for one request and returns its key's thumbprint (RFC 7638), or null. The proof must be for
 * this method and URL (without query), recent (issued at most five minutes ago, one in the future), carry the access
 * token's hash when there is one, and be new: its jti is remembered for its key until it could no longer be accepted.
 */
export async function verifyDpop(runtime: Runtime, proof: string, expected: { htm: string; htu: string; ath?: string }): Promise<string | null> {
  if (proof.length > 8192) return null;
  const parts = proof.split('.');
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
  let header: Record<string, unknown>, payload: Record<string, unknown>;
  try { header = JSON.parse(b64(parts[0]!).toString('utf8')); payload = JSON.parse(b64(parts[1]!).toString('utf8')); } catch { return null; }
  if (!header || !payload || typeof header !== 'object' || typeof payload !== 'object' || header.typ !== 'dpop+jwt' || typeof header.alg !== 'string') return null;
  const algorithm = Object.hasOwn(DPOP_ALGORITHMS, header.alg) ? DPOP_ALGORITHMS[header.alg]! : null;
  const jwk = header.jwk as Record<string, unknown> | undefined;
  if (!algorithm || !jwk || typeof jwk !== 'object' || jwk.kty !== algorithm.kty || (algorithm.crv && jwk.crv !== algorithm.crv)) return null;
  // The public members only, in RFC 7638 order. A private member means the client leaked its key: refuse it.
  if (['d', 'p', 'q', 'dp', 'dq', 'qi', 'k'].some(member => member in jwk)) return null;
  const members = jwk.kty === 'EC' ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y } : jwk.kty === 'OKP' ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x } : { e: jwk.e, kty: jwk.kty, n: jwk.n };
  if (Object.values(members).some(value => typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value as string))) return null;
  if (jwk.kty === 'RSA' && b64(members.n as string).length < 256) return null;
  try {
    const key = await crypto.subtle.importKey('jwk', members as JsonWebKey, algorithm.key, false, ['verify']);
    if (!await crypto.subtle.verify(algorithm.verify, key, b64(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))) return null;
  } catch { return null; }
  const now = Date.now() / 1000;
  if (typeof payload.jti !== 'string' || !payload.jti || payload.jti.length > 256 || payload.htm !== expected.htm || typeof payload.htu !== 'string'
    || typeof payload.iat !== 'number' || payload.iat < now - 300 || payload.iat > now + 60) return null;
  let htu: URL; try { htu = new URL(payload.htu); } catch { return null; }
  if (`${htu.origin}${htu.pathname}` !== expected.htu) return null;
  if (expected.ath !== undefined && payload.ath !== expected.ath) return null;
  const jkt = await sha256(JSON.stringify(members));
  const fresh = await runtime.db.execute(sql`INSERT INTO bane_dpop_proofs(id, expires_at) VALUES (${await digest(JSON.stringify(['dpop', jkt, payload.jti]))}, now()+interval '7 minutes') ON CONFLICT DO NOTHING RETURNING id`);
  return fresh.rowCount ? jkt : null;
}

// ---------- /mcp ----------

/**
 * Authorizes one /mcp request with a token from Bane's authorization server: an access token (5 minutes) or an MCP key
 * created in Settings. Every request reads the token, its approval and the person's live membership.
 */
export async function authorizeResource(runtime: Runtime, request: Request, handler: (actor: Actor) => Promise<Response>) {
  const resource = mcpResource(runtime);
  const metadata = `${runtime.config.publicUrl}/.well-known/oauth-protected-resource/mcp`;
  const auth = request.headers.get('authorization');
  const presented = /^(Bearer|DPoP)\s+(\S+)$/i.exec(auth ?? '');
  // MCP clients expect a JSON-RPC envelope; the challenge itself lives in WWW-Authenticate (RFC 6750, RFC 9728). The
  // scope is every Bane scope, so a client asks for all of them and the person narrows them on the consent page.
  function denied(status: 401 | 403, error: string | null, detail?: string, dpop = false) {
    const message = status === 401 ? 'Sign in to Bane again: reconnect this MCP client and approve it.' : 'This approval has no access to that.';
    const params = [error && `error="${error}"`, error && `error_description="${message}"`, `resource_metadata="${metadata}"`, `scope="${SCOPES.join(' ')}"`, dpop && `algs="${DPOP_ALGS.join(' ')}"`].filter(Boolean).join(', ');
    return Response.json({ jsonrpc: '2.0', error: { code: -32000, message: detail ?? message }, id: null }, { status, headers: { 'cache-control': 'no-store', 'www-authenticate': `${dpop ? 'DPoP' : 'Bearer'} ${params}` } });
  }
  if (!presented) return denied(401, auth ? 'invalid_request' : null);
  const [, scheme, token] = presented as unknown as [string, string, string];
  const dpopScheme = scheme.toLowerCase() === 'dpop';
  if (!ACCESS_TOKEN.test(token) && !MCP_KEY.test(token)) return denied(401, 'invalid_token', undefined, dpopScheme);
  const { rows: [row] } = await runtime.db.execute<{ kind: string; grant_id: string; scopes: string[]; jkt: string | null }>(sql`
    SELECT kind, grant_id, scopes, jkt FROM bane_oauth_tokens WHERE hash=${await digest(token)} AND kind IN ('access','key') AND expires_at > now()`);
  if (!row || (row.kind === 'key') !== MCP_KEY.test(token)) return denied(401, 'invalid_token', undefined, dpopScheme);
  // A sender-constrained token needs its key's proof on every request; a plain bearer token never uses the DPoP scheme.
  if (row.jkt) {
    const proof = request.headers.get('dpop');
    const jkt = dpopScheme && proof ? await verifyDpop(runtime, proof, { htm: request.method, htu: resource, ath: await tokenHash(token) }) : null;
    if (jkt !== row.jkt) return denied(401, 'invalid_token', undefined, true);
  } else if (dpopScheme) return denied(401, 'invalid_token');
  const actor = await mcpGrantActor(runtime, row.grant_id);
  if (!actor) {
    const { rows: [pending] } = await runtime.db.execute(sql`SELECT FROM bane_resource_grants WHERE id=${row.grant_id} AND workspace_id IS NULL AND NOT revoked AND expires_at > now()`);
    if (pending) return denied(403, 'insufficient_scope', `Choose a workspace for this MCP client in Bane: ${runtime.config.publicUrl}/settings/mcp/${row.grant_id}`);
    // Revoked, expired, or the person's membership or role no longer covers it: the client signs in again.
    log('info', { code: 'MCP_APPROVAL_INACTIVE', grant: row.grant_id });
    return denied(401, 'invalid_token', undefined, !!row.jkt);
  }
  // Tokens store their scopes as permissions (read, send, manage).
  const permissions = actor.permissions.filter(permission => row.scopes.includes(permission));
  if (!permissions.length) return denied(403, 'insufficient_scope');
  // `?profile=` on the MCP URL only labels the entry in Settings; it never selects or authorizes anything.
  const profile = profileLabel(new URL(request.url).searchParams.get('profile'));
  await runtime.db.execute(sql`UPDATE bane_resource_grants SET last_used_at=now(), profile=coalesce(${profile}, profile) WHERE id=${row.grant_id}
    AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute' OR (${profile}::text IS NOT NULL AND profile IS DISTINCT FROM ${profile}))`);
  return handler({ ...actor, permissions });
}
