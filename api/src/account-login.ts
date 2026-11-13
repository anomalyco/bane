import * as oidc from 'oauth4webapi';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError, digest, log, type Actor, type Ctx, type DbExecutor, type Runtime } from './core.js';
import { getCookie, setCookie } from 'hono/cookie';
import { onboardNewUser, pendingInvitation } from './workspaces.js';
import { isStaffSignIn, PROVIDER_IDENTITY_CLAIM, providerIdentity, type ProviderIdentity } from './account-policy.js';

const verifiedEmail = z.email().max(320);
const loginFailed = () => new ApiError(403, 'SIGN_IN_DENIED', 'This account cannot sign in.');
class AuthenticationMethodRequired extends Error {}
class NotAdmitted extends Error { constructor(readonly reason: string) { super(reason); } }

function loginIssue(error: unknown, requiredAcr?: string) {
  const issuerError = error instanceof oidc.AuthorizationResponseError || error instanceof oidc.ResponseBodyError ? error.error : undefined;
  if (error instanceof AuthenticationMethodRequired || issuerError === 'unmet_authentication_requirements') {
    if (requiredAcr === 'urn:anomaly:acr:google') return {reason:'google_required', message:'Bane requires Google sign-in. Try again and choose Google at Anomaly account.'};
    return {reason:'method_required', message:'Sign in again using the authentication method required by this installation.'};
  }
  if (issuerError === 'interaction_required') return {reason:'interaction_required', message:'Your identity provider needs you to complete sign-in. Try again and follow its prompts.'};
}

async function provider(runtime: Runtime) {
  const { accountIssuer, accountClient, publicUrl } = runtime.config;
  if (!accountIssuer || !accountClient) throw new ApiError(503, 'AUTH_NOT_CONFIGURED', 'Configure the OIDC client to enable dashboard sign-in.');
  const issuer = new URL(accountIssuer);
  const options = { signal: () => AbortSignal.timeout(6000) };
  const metadata = await oidc.processDiscoveryResponse(issuer, await oidc.discoveryRequest(issuer, options));
  const client: oidc.Client = { client_id: accountClient.id, id_token_signed_response_alg: accountClient.algorithm };
  const jwk = JSON.parse(accountClient.privateKey) as JsonWebKey & {kid:string};
  const key = await crypto.subtle.importKey('jwk', jwk, {name:'ECDSA', namedCurve:'P-256'}, false, ['sign']);
  const authentication = oidc.PrivateKeyJwt({ key, kid: jwk.kid });
  const callback = new URL('/api/auth/callback/account',publicUrl).href;
  return { metadata, client, authentication, callback, options };
}

// A browser keeps one session per account it connected, in its own cookie (a slot): `session_token` (slot 0, the
// name every earlier build used) and `session_token.1` to `.4`. Each request acts as exactly one of them, the account
// named by X-Bane-Account (one per tab) or, without the header, the browser's default (`bane.account`). Separate
// cookies, rather than one cookie listing every session, mean signing in, signing out or a session expiring only ever
// writes that account's own cookie: two tabs changing different accounts at once can't lose or bring back each other's
// session, and each cookie carries its own expiry.
export const MAX_ACCOUNTS = 5;
const accountId = /^[A-Za-z0-9._:-]{1,200}$/;
const POPUP_PATH = '/signed-in/';
type Jar = { slots: { slot: number; hash: string }[]; selected: string | null; preferred: string | null };
const cookieValue = (headers: Headers, name: string) => {
  const found = headers.get('cookie')?.split(';').map(c => c.trim()).filter(c => c.startsWith(`${name}=`)) ?? [];
  return found.length === 1 ? found[0]!.slice(name.length + 1) : null;
};
const slotCookie = (runtime: Runtime, slot: number) => cookieName(runtime, slot ? `session_token.${slot}` : 'session_token');
async function sessionJar(runtime: Runtime, headers: Headers): Promise<Jar> {
  const slots: Jar['slots'] = [];
  for (let slot = 0; slot < MAX_ACCOUNTS; slot++) {
    const token = cookieValue(headers, slotCookie(runtime, slot));
    if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) slots.push({ slot, hash: await digest(token) });
  }
  // An unknown or malformed account name matches no session: the request is refused rather than acting as another account.
  const header = headers.get('x-bane-account'), preferred = cookieValue(headers, cookieName(runtime, 'account'));
  return { slots, selected: header === null ? null : accountId.test(header) ? header : '', preferred: preferred && accountId.test(preferred) ? preferred : null };
}
const hashes = (jar: Jar) => sql.param(jar.slots.map(s => s.hash));
/** The one session a request acts as: the tab's account, else the browser's default, else the first connected slot. */
function activeSession(runtime: Runtime, jar: Jar) {
  return sql`SELECT s.* FROM bane_sessions s WHERE s.token_hash=ANY(${hashes(jar)}::text[]) AND s.issuer=${runtime.config.accountIssuer} AND s.expires_at>now()
    ${jar.selected === null ? sql`` : sql`AND s.user_id=${jar.selected}`}
    ORDER BY (s.user_id=${jar.preferred ?? ''}) DESC, array_position(${hashes(jar)}::text[], s.token_hash) LIMIT 1`;
}
/** Every account with a live session in this browser, in slot order, and the dead slots to clear. */
async function connectedAccounts(runtime: Runtime, jar: Jar, db: DbExecutor = runtime.db) {
  if (!jar.slots.length) return { accounts: [] as { slot: number; hash: string; id: string; name: string; email: string | null }[], dead: [] as number[] };
  const { rows } = await db.execute<{ token_hash: string; id: string; name: string; email: string | null }>(sql`SELECT s.token_hash,u.id,u.name,u.email
    FROM bane_sessions s JOIN bane_users u ON u.id=s.user_id WHERE s.token_hash=ANY(${hashes(jar)}::text[]) AND s.issuer=${runtime.config.accountIssuer} AND s.expires_at>now()`);
  const live = new Map(rows.map(row => [row.token_hash, row]));
  const accounts = jar.slots.flatMap(s => { const row = live.get(s.hash); return row ? [{ slot: s.slot, hash: s.hash, id: row.id, name: row.name, email: row.email }] : []; });
  return { accounts, dead: jar.slots.filter(s => !live.has(s.hash)).map(s => s.slot) };
}

export async function beginAccountLogin(runtime: Runtime, returnUrl: URL, peer: string, prompt?: 'select_account') {
  const origin = new URL(runtime.config.publicUrl).origin;
  if (returnUrl.origin !== origin || returnUrl.username || returnUrl.password) throw loginFailed();
  const slots = await runtime.db.execute(sql`SELECT reserve_auth_state(${await digest(peer)}) AS ok`);
  if (!slots.rows[0]?.ok) throw new ApiError(429, 'AUTH_STATE_LIMIT', 'Too many pending sign-ins. Try again later.');
  const { metadata, client, authentication, callback, options } = await provider(runtime);
  const state = oidc.generateRandomState(), binding = oidc.generateRandomState();
  const verifier = oidc.generateRandomCodeVerifier(), nonce = oidc.generateRandomNonce();
  let params = new URLSearchParams({ client_id:client.client_id, response_type:'code', scope:'openid profile email', redirect_uri:callback,
    state, nonce, code_challenge_method:'S256', code_challenge:await oidc.calculatePKCECodeChallenge(verifier) });
  // Adding an account: the account service shows its chooser, and Bane learns only the account picked there.
  if (prompt) params.set('prompt', prompt);
  const requiredAcr = runtime.config.accountClient?.requiredAcr;
  // The required authentication context, and the provider identity behind the sign-in when staff sign-up is on.
  const idToken: Record<string, unknown> = {};
  if (requiredAcr) idToken.acr = {essential:true, values:[requiredAcr]};
  if (runtime.config.staffGoogleDomains.length) idToken[PROVIDER_IDENTITY_CLAIM] = {essential:true};
  if (Object.keys(idToken).length) params.set('claims', JSON.stringify({id_token:idToken}));
  if (metadata.pushed_authorization_request_endpoint) {
    const response = await oidc.pushedAuthorizationRequest(metadata, client, authentication, params, options);
    const pushed = await oidc.processPushedAuthorizationResponse(metadata, client, response);
    params = new URLSearchParams({client_id:client.client_id, request_uri:pushed.request_uri});
  } else if (metadata.require_pushed_authorization_requests) throw loginFailed();
  const url = new URL(metadata.authorization_endpoint!);
  if (url.protocol !== 'https:') throw loginFailed();
  for (const [key,value] of params) url.searchParams.set(key,value);
  await runtime.db.execute(sql`INSERT INTO bane_login_flows(state_hash,cookie_hash,issuer,client_id,nonce,verifier,return_url,expires_at)
    VALUES (${await digest(state)},${await digest(binding)},${metadata.issuer},${client.client_id},${nonce},${verifier},${returnUrl.href},now()+interval '10 minutes')`);
  return { url:url.href, binding };
}

// Every verified sign-in, refused or admitted: one row per subject for the operator (scripts/list-signin-attempts.ts),
// who may then bind that subject explicitly. The address and name are shown, never trusted.
async function recordAttempt(runtime: Runtime, claims: oidc.IDToken, upstream: ProviderIdentity | null, address: string | null, outcome: string) {
  const acr = typeof claims.acr === 'string' ? claims.acr.slice(0, 200) : null, name = typeof claims.name === 'string' ? claims.name.slice(0, 200) : null;
  if (outcome.startsWith('signed_in')) log('info', { code: 'SIGN_IN', outcome, subject: claims.sub, acr });
  else log('warn', { code: 'SIGN_IN_NOT_APPROVED', reason: outcome, subject: claims.sub, acr });
  await runtime.db.execute(sql`INSERT INTO bane_signin_attempts(issuer,subject,acr,provider,provider_hd,email,name,outcome)
    VALUES(${claims.iss},${claims.sub},${acr},${upstream?.provider ?? null},${upstream?.hd ?? null},${address},${name},${outcome})
    ON CONFLICT(issuer,subject) DO UPDATE SET acr=excluded.acr,provider=excluded.provider,provider_hd=excluded.provider_hd,email=excluded.email,
      name=excluded.name,outcome=excluded.outcome,attempts=bane_signin_attempts.attempts+1,last_at=now()`).catch(() => {});
}

// One retry when the server asks for a DPoP nonce: the handle stored it from the refusal.
async function retryDPoPNonce<T>(attempt: () => Promise<T>) {
  try { return await attempt(); } catch (error) { if (!oidc.isDPoPNonceError(error)) throw error; return attempt(); }
}

class AccountLimit extends Error {}
export async function finishAccountLogin(runtime: Runtime, url: URL, binding: string, jar: Jar = { slots: [], selected: null, preferred: null }, onFlow?: (returnUrl: string) => void) {
  const state = url.searchParams.get('state');
  if (!state || state.length > 256 || !binding || binding.length > 256) throw loginFailed();
  const {rows:[flow]} = await runtime.db.execute<{nonce:string;verifier:string;return_url:string}>(sql`
    DELETE FROM bane_login_flows WHERE state_hash=${await digest(state)} AND cookie_hash=${await digest(binding)}
      AND issuer=${runtime.config.accountIssuer} AND client_id=${runtime.config.accountClient?.id} AND expires_at>now() RETURNING nonce,verifier,return_url`);
  if (!flow) throw loginFailed();
  onFlow?.(flow.return_url);
  const { metadata, client, authentication, callback, options } = await provider(runtime);
  const params = oidc.validateAuthResponse(metadata, client, url, state);
  // The account service refuses a first-party client's code exchange without a DPoP proof (invalid_dpop_proof) and
  // asks for its nonce first (use_dpop_nonce). One ephemeral key per sign-in proves the exchange and the userinfo
  // read; an issuer that doesn't advertise DPoP gets none.
  const DPoP = metadata.dpop_signing_alg_values_supported?.includes('ES256') ? oidc.DPoP(client, await oidc.generateKeyPair('ES256')) : undefined;
  const { response, tokens } = await retryDPoPNonce(async () => {
    const response = await oidc.authorizationCodeGrantRequest(metadata, client, authentication, params, callback, flow.verifier, { ...options, DPoP });
    return { response, tokens: await oidc.processAuthorizationCodeResponse(metadata, client, response, {requireIdToken:true,expectedNonce:flow.nonce}) };
  });
  await oidc.validateApplicationLevelSignature(metadata, response, options);
  const claims = oidc.getValidatedIdTokenClaims(tokens)!;
  const requiredAcr = runtime.config.accountClient?.requiredAcr;
  const needUserInfo = (claims.email === undefined || claims.email_verified === undefined || !providerIdentity(claims)) && !!metadata.userinfo_endpoint;
  const bound = tokens.token_type === 'dpop' ? { DPoP } : {};
  const profile = needUserInfo
    ? await retryDPoPNonce(async () => oidc.processUserInfoResponse(metadata, client, claims.sub, await oidc.userInfoRequest(metadata, client, tokens.access_token, { ...options, ...bound })))
    : claims;
  const address = verifiedEmail.safeParse(profile.email).data ?? null;
  const emailAtLogin = profile.email_verified === true ? address : null;
  const upstream = providerIdentity(claims) ?? providerIdentity(profile as Record<string, unknown>);
  if (requiredAcr && claims.acr !== requiredAcr) {
    await recordAttempt(runtime, claims, upstream, address, 'method_required');
    throw new AuthenticationMethodRequired();
  }
  const returnUrl = new URL(flow.return_url);
  if (returnUrl.origin !== new URL(runtime.config.publicUrl).origin) throw loginFailed();
  const invitation = returnUrl.pathname === '/' ? returnUrl.searchParams.get('invitation') : null;
  // Identity is (issuer, subject). An email address is display and contact data only: it never admits a person
  // and never links a subject to an existing user.
  const staff = isStaffSignIn(runtime.config, claims.acr, upstream);
  const session = oidc.generateRandomState();
  let admitted = 'signed_in', slot = 0, userId = '';
  try {
    await runtime.db.transaction(async db => {
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([claims.iss,claims.sub])},83062))`);
      const existing = await db.execute<{user_id:string}>(sql`SELECT user_id FROM bane_oidc_identities WHERE issuer=${claims.iss} AND subject=${claims.sub} FOR SHARE`);
      userId = existing.rows[0]?.user_id ?? '';
      if (!userId) {
        // A new subject is admitted only by a sub-bound decision: hosted staff (the provider identity, see
        // account-policy.ts), the invitation link it followed, or a self-hosted subject allowlist. Operators bind
        // anyone else by subject (scripts/cutover-fresh-start.ts --owner-sub, or a bane_oidc_identities row).
        // Only the invitation path reads the address: it must be the verified invitation target.
        const selfHosted = !runtime.config.multiTenant && runtime.config.allowedSubjects.includes(claims.sub);
        const invited = runtime.config.multiTenant && !staff && !!invitation && !!emailAtLogin && await pendingInvitation(db, emailAtLogin, invitation);
        if (!staff && !invited && !selfHosted) throw new NotAdmitted(invitation ? 'invitation' : 'not_approved');
        userId = crypto.randomUUID();
        const name = typeof claims.name === 'string' && claims.name.trim() ? claims.name.slice(0,200) : address ?? 'Bane user';
        if (emailAtLogin) await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(lower(${emailAtLogin}),80324))`);
        // The address is display and contact data. Verified addresses stay unique; a taken one is stored unverified.
        await db.execute(sql`INSERT INTO bane_users(id,name,email,email_verified) VALUES(${userId},${name},${address}::text,
          ${!!emailAtLogin} AND NOT EXISTS(SELECT FROM bane_users WHERE email_verified AND lower(email)=lower(${address}::text)))`);
        await db.execute(sql`INSERT INTO bane_oidc_identities(issuer,subject,user_id) VALUES(${claims.iss},${claims.sub},${userId})`);
        admitted = `signed_in:${staff ? 'staff' : invited ? 'invitation' : 'subject'}`;
        log('info', { code: 'SIGN_IN_USER_CREATED', userId, subject: claims.sub, admission: admitted });
        if (runtime.config.multiTenant) {
          if (!await onboardNewUser(db,{id:userId,email:emailAtLogin,name},staff,runtime.config.regions[0]!,invitation)) throw new NotAdmitted('invitation');
        } else if (runtime.config.defaultWorkspaceOwners === '*' || runtime.config.defaultWorkspaceOwners.includes(claims.sub)) {
          await db.execute(sql`INSERT INTO workspace_members(id,user_id,workspace_id,role) VALUES(${crypto.randomUUID()},${userId},'default','owner')`);
        }
      }
      // Serialize email ownership changes separately from the stable subject. A
      // conflicting address must never transfer somebody else's user or memberships.
      if (emailAtLogin) await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(lower(${emailAtLogin}),80324))`);
      const updated = await db.execute(sql`WITH observed AS (
        SELECT ${address}::text AS email, (${!!emailAtLogin} AND NOT EXISTS(SELECT FROM bane_users WHERE id<>${userId}
          AND email_verified AND lower(email)=lower(${address}))) AS verified
      ) UPDATE bane_users u SET email=o.email,email_verified=o.verified,updated_at=now() FROM observed o
        WHERE u.id=${userId} AND (u.email,u.email_verified) IS DISTINCT FROM (o.email,o.verified) RETURNING u.id`);
      if(updated.rowCount) await db.execute(sql`DELETE FROM bane_sessions WHERE user_id=${userId}`);
      // The account's own slot when this browser already has it (signing in again replaces that session), else the
      // first slot without a live session. A sixth account is refused before anything is written.
      const { accounts } = await connectedAccounts(runtime, jar, db);
      const same = accounts.filter(account => account.id === userId);
      const free = Array.from({ length: MAX_ACCOUNTS }, (_, i) => i).find(i => !accounts.some(account => account.slot === i));
      if (!same.length && free === undefined) throw new AccountLimit();
      slot = same[0]?.slot ?? free!;
      if (same.length) await db.execute(sql`DELETE FROM bane_sessions WHERE token_hash=ANY(${sql.param(same.map(account => account.hash))}::text[])`);
      await db.execute(sql`INSERT INTO bane_sessions(token_hash,user_id,issuer,subject,verified_email,staff,expires_at) VALUES
        (${await digest(session)},${userId},${claims.iss},${claims.sub},${emailAtLogin ?? null},${staff},now()+interval '7 days')`);
    });
  } catch (error) {
    if (!(error instanceof NotAdmitted)) throw error;
    await recordAttempt(runtime, claims, upstream, address, error.reason);
    throw loginFailed();
  }
  await recordAttempt(runtime, claims, upstream, address, admitted);
  return {session, slot, userId, returnUrl:returnUrl.href};
}

const cookieName = (runtime: Runtime, name: string) => `${runtime.config.publicUrl.startsWith('https:') ? '__Host-' : ''}bane.${name}`;
const cookieOptions = (runtime: Runtime, maxAge: number) => ({ httpOnly:true, secure:runtime.config.publicUrl.startsWith('https:'), sameSite:'Lax' as const, path:'/', maxAge });
const SESSION_SECONDS = 604800;

/** The session this request acts as, or null. A tab naming an account this browser has no live session for gets null. */
async function currentSession(runtime: Runtime, headers: Headers) {
  const jar = await sessionJar(runtime, headers);
  if (!jar.slots.length) return null;
  const { rows: [row] } = await runtime.db.execute<{ token_hash: string; user_id: string; subject: string; staff: boolean }>(activeSession(runtime, jar));
  return row ?? null;
}

export async function accountSessionUser(runtime: Runtime, headers: Headers, requireCurrentEmail = false) {
  const jar = await sessionJar(runtime, headers);
  if (!jar.slots.length) return null;
  const {rows:[user]} = await runtime.db.execute<{id:string;email:string}>(sql`SELECT u.id,u.email FROM (${activeSession(runtime, jar)}) s
    JOIN bane_users u ON u.id=s.user_id ${requireCurrentEmail ? sql`WHERE u.email_verified AND lower(u.email)=lower(s.verified_email)` : sql``}`);
  return user ?? null;
}

/** The current dashboard session's subject and hosted staff status (decided at sign-in from the provider identity). */
export async function accountSessionPolicy(runtime: Runtime, headers: Headers) {
  const row = await currentSession(runtime, headers);
  return row && { subject: row.subject, staff: row.staff };
}

const signedOut = () => new ApiError(401, 'ACCOUNT_SIGNED_OUT', 'This account is no longer signed in to Bane in this browser.');
export async function accountSessionActor(runtime: Runtime, headers: Headers): Promise<Actor|null> {
  const jar = await sessionJar(runtime, headers);
  if (!jar.slots.length) return null;
  const selected = headers.get('x-bane-workspace') ?? headers.get('x-opensend-workspace');
  const {rows:[m]} = await runtime.db.execute<{id:string;email:string;name:string;workspace:string;role:string}>(sql`
    WITH active AS MATERIALIZED (${activeSession(runtime, jar)}),
    member AS (SELECT u.id,u.email,u.name,m.workspace_id AS workspace,m.role FROM active s JOIN bane_users u ON s.user_id=u.id
      JOIN workspace_members m ON m.user_id=u.id WHERE m.role IN ('owner','admin','member')
      ${runtime.config.multiTenant ? sql`` : sql`AND m.role IN ('owner','admin') AND ${JSON.stringify(runtime.config.allowedSubjects)}::jsonb ? s.subject`}
      ${selected && runtime.config.multiTenant ? sql`AND m.workspace_id=${selected}` : sql``}
      ORDER BY (m.workspace_id=u.selected_workspace_id) DESC NULLS LAST,m.created_at,m.id LIMIT 1
    ), selected AS (UPDATE bane_users u SET selected_workspace_id=member.workspace FROM member WHERE u.id=member.id AND u.selected_workspace_id IS DISTINCT FROM member.workspace)
    SELECT * FROM member`);
  if (!m) {
    const session = await currentSession(runtime, headers);
    // The tab's account was signed out, expired or revoked: refuse, never fall back to another account's session.
    if (!session) { if (jar.selected !== null) throw signedOut(); return null; }
    if (selected && runtime.config.multiTenant) throw new ApiError(403,'WORKSPACE_ACCESS_DENIED','This workspace is not available to your session.');
    return null;
  }
  return { keyId:`user_${m.id}`, email:m.email, name:m.name, workspaceId:m.workspace, role:m.role, permissions:m.role==='member'?['read','send']:['manage'], domains:[],credential:'dashboard' };
}

/**
 * A request without the tab's account acted as the browser default. When the default cookie named another account (one
 * signed out, expired or revoked since), it now names the account actually used, so a stale default never lingers.
 */
export function settleDefaultAccount(c: Ctx, userId: string) {
  if (c.req.header('x-bane-account') !== undefined) return;
  const name = cookieName(c.env, 'account');
  if (cookieValue(c.req.raw.headers, name) !== userId) setCookie(c, name, userId, cookieOptions(c.env, SESSION_SECONDS));
}

/** This browser's connected accounts, each with its own workspaces, read with that account's own session. */
async function accountList(runtime: Runtime, c: Ctx, jar: Jar, connection?: string) {
  const { accounts, dead } = await connectedAccounts(runtime, jar);
  // A session that expired or was revoked removes only its own account: clear just that cookie.
  for (const slot of dead) setCookie(c, slotCookie(runtime, slot), '', cookieOptions(runtime, 0));
  const unique = accounts.filter((account, i) => accounts.findIndex(other => other.id === account.id) === i);
  const ids = sql.param(unique.map(account => account.id));
  const { rows: memberships } = unique.length ? await runtime.db.execute<{ user_id: string; id: string; name: string; slug: string; role: 'owner' | 'admin' | 'member' }>(sql`
    SELECT m.user_id,w.id,w.name,w.slug,m.role FROM workspace_members m JOIN workspaces w ON w.id=m.workspace_id
    WHERE m.user_id=ANY(${ids}::text[]) AND m.role IN ('owner','admin','member') ORDER BY w.name,w.id`) : { rows: [] };
  // Which connected account an MCP approval belongs to, so its page acts as that account and never as whichever is active.
  const owner = connection && unique.length ? (await runtime.db.execute<{ user_id: string }>(sql`SELECT user_id FROM bane_resource_grants WHERE id=${connection} AND user_id=ANY(${ids}::text[])`)).rows[0]?.user_id ?? null : null;
  const active = jar.selected !== null ? unique.find(account => account.id === jar.selected) : unique.find(account => account.id === jar.preferred) ?? unique[0];
  if (jar.selected === null && active && active.id !== jar.preferred) setCookie(c, cookieName(runtime, 'account'), active.id, cookieOptions(runtime, SESSION_SECONDS));
  return {
    accounts: unique.map(({ id, name, email }) => ({ id, name, email, workspaces: memberships.filter(m => m.user_id === id).map(({ id, name, slug, role }) => ({ id, name, slug, role })) })),
    active: active?.id ?? null, limit: MAX_ACCOUNTS, ...connection === undefined ? {} : { connection: { id: connection, account: owner } },
  };
}

export async function accountBrowserRoute(c: Ctx) {
  const runtime = c.env, path = c.req.path, origin = new URL(runtime.config.publicUrl).origin;
  c.header('Cache-Control','no-store');
  // Signing in, switching and signing out change this browser's sessions: only the dashboard itself may ask.
  if (c.req.method === 'POST' && c.req.header('origin') !== origin) throw new ApiError(403,'CSRF_ORIGIN_INVALID','Use the dashboard to sign in or out.');
  const jar = () => sessionJar(runtime, c.req.raw.headers);
  // An empty body is {} (earlier dashboards sign out without one).
  const body = async <T extends z.ZodType>(schema: T) => {
    const text = await c.req.text();
    let value: unknown = null;
    try { value = text.trim() ? JSON.parse(text) : {}; } catch { /* refused below */ }
    const input = schema.safeParse(value);
    if (!input.success) throw new ApiError(422, 'AUTH_INPUT_INVALID', 'The request body is invalid.');
    return input.data as z.infer<T>;
  };
  if (path === '/api/auth/sign-in/account' && c.req.method === 'POST') {
    const input = z.object({ callbackURL:z.url().max(2048), prompt:z.literal('select_account').optional() }).strict().safeParse(await c.req.json().catch(()=>null));
    if (!input.success) throw new ApiError(422,'AUTH_INPUT_INVALID','Supply the dashboard return URL.');
    // A sixth account is refused before the account service is asked, on every sign-in; the callback checks again.
    if ((await connectedAccounts(runtime, await jar())).accounts.length >= MAX_ACCOUNTS) throw new ApiError(409,'ACCOUNT_LIMIT',`A browser can connect at most ${MAX_ACCOUNTS} accounts. Sign out of one to add another.`);
    const start = await beginAccountLogin(runtime,new URL(input.data.callbackURL),c.req.header('x-bane-client-ip') ?? 'unknown',input.data.prompt).catch(error=>{
      const issue = loginIssue(error, runtime.config.accountClient?.requiredAcr);
      if (issue) throw new ApiError(403,'SIGN_IN_DENIED',issue.message);
      throw error;
    });
    setCookie(c,cookieName(runtime,'login'),start.binding,cookieOptions(runtime,600));
    return c.json({url:start.url});
  }
  if (path === '/api/auth/callback/account' && c.req.method === 'GET') {
    const binding = getCookie(c,cookieName(runtime,'login')) ?? '';
    setCookie(c,cookieName(runtime,'login'),'',cookieOptions(runtime,0));
    let started: string | undefined;
    try {
      const { session,slot,userId,returnUrl } = await finishAccountLogin(runtime,new URL(c.req.url),binding,await jar(),url => { started = url; });
      setCookie(c,slotCookie(runtime,slot),session,cookieOptions(runtime,SESSION_SECONDS));
      // The account just signed in becomes this browser's default, and the page it returns to opens as it.
      setCookie(c,cookieName(runtime,'account'),userId,cookieOptions(runtime,SESSION_SECONDS));
      const target = new URL(returnUrl);
      target.searchParams.set('account', userId);
      return c.redirect(target.href,303);
    } catch (error) {
      const issue = error instanceof AccountLimit ? {reason:'account_limit'} : loginIssue(error, runtime.config.accountClient?.requiredAcr);
      // What failed, never a token or a claim: the error class, the issuer's error code and the library's message.
      const failure = error as { name?: string; error?: unknown; status?: unknown; message?: unknown };
      log('warn', { code: 'SIGN_IN_DENIED', reason: issue?.reason ?? (error instanceof ApiError ? error.code : 'error'), errorType: failure?.name,
        issuerError: typeof failure?.error === 'string' ? failure.error.slice(0, 80) : undefined, issuerStatus: typeof failure?.status === 'number' ? failure.status : undefined,
        detail: error instanceof ApiError || error instanceof AccountLimit ? undefined : String(failure?.message ?? '').slice(0, 200) });
      // An account added in a popup reports back to the page that opened it; every other failure lands on the dashboard.
      const back = started && new URL(started).pathname === POPUP_PATH ? new URL(started) : new URL(`${origin}/`);
      back.searchParams.set('auth', issue?.reason ?? 'error');
      return c.redirect(back.href,303);
    }
  }
  if (path === '/api/auth/accounts' && c.req.method === 'GET') {
    const connection = c.req.query('connection');
    if (connection !== undefined && !/^[A-Za-z0-9_-]{1,200}$/.test(connection)) throw new ApiError(422,'AUTH_INPUT_INVALID','The connection ID is invalid.');
    return c.json(await accountList(runtime, c, await jar(), connection));
  }
  if (path === '/api/auth/accounts/switch' && c.req.method === 'POST') {
    // Only the browser's default (for new tabs and links) is stored; each tab sends its own account with X-Bane-Account.
    const { account } = await body(z.object({ account: z.string().regex(accountId) }).strict());
    const { accounts } = await connectedAccounts(runtime, await jar());
    if (!accounts.some(connected => connected.id === account)) throw signedOut();
    setCookie(c,cookieName(runtime,'account'),account,cookieOptions(runtime,SESSION_SECONDS));
    return c.json({account});
  }
  if (path === '/api/auth/sign-out' && c.req.method === 'POST') {
    // {} signs out of the account this request acts as (the tab's, or the default); {account} of that one; {all:true} of every one.
    const input = await body(z.object({ account: z.string().regex(accountId).optional(), all: z.literal(true).optional() }).strict());
    const browser = await jar();
    const { accounts } = await connectedAccounts(runtime, browser);
    const target = input.all ? null : input.account ?? (await currentSession(runtime, c.req.raw.headers))?.user_id;
    const leaving = input.all ? browser.slots : browser.slots.filter(s => accounts.some(account => account.hash === s.hash && account.id === target));
    if (leaving.length) await runtime.db.execute(sql`DELETE FROM bane_sessions WHERE token_hash=ANY(${sql.param(leaving.map(s => s.hash))}::text[])`);
    for (const s of leaving) setCookie(c,slotCookie(runtime,s.slot),'',cookieOptions(runtime,0));
    const remaining = accounts.filter(account => !leaving.some(s => s.slot === account.slot));
    const next = remaining.find(account => account.id === browser.preferred) ?? remaining[0];
    if (next) setCookie(c,cookieName(runtime,'account'),next.id,cookieOptions(runtime,SESSION_SECONDS));
    else setCookie(c,cookieName(runtime,'account'),'',cookieOptions(runtime,0));
    return c.json({success:true, accounts:[...new Set(remaining.map(account => account.id))], active:next?.id ?? null});
  }
  if (path === '/api/auth/get-session' && c.req.method === 'GET') return c.json(await accountSessionUser(runtime,c.req.raw.headers));
  throw new ApiError(404,'NOT_FOUND','Authentication endpoint was not found.');
}
