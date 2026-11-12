import * as oidc from 'oauth4webapi';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError, digest, log, type Actor, type Ctx, type Runtime } from './core.js';
import { getCookie, setCookie } from 'hono/cookie';
import { onboardNewUser, pendingInvitation } from './workspaces.js';
import { isStaffSignIn, providerIdentity, type ProviderIdentity } from './account-policy.js';

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
  const client = { client_id: accountClient.id, id_token_signed_response_alg: accountClient.algorithm };
  const jwk = JSON.parse(accountClient.privateKey) as JsonWebKey & {kid:string};
  const key = await crypto.subtle.importKey('jwk', jwk, {name:'ECDSA', namedCurve:'P-256'}, false, ['sign']);
  const authentication = oidc.PrivateKeyJwt({ key, kid: jwk.kid });
  const callback = new URL('/api/auth/callback/account',publicUrl).href;
  return { metadata, client, authentication, callback, options };
}

export async function beginAccountLogin(runtime: Runtime, returnUrl: URL, peer: string) {
  const origin = new URL(runtime.config.publicUrl).origin;
  if (returnUrl.origin !== origin || returnUrl.username || returnUrl.password) throw loginFailed();
  const slots = await runtime.db.execute(sql`SELECT reserve_auth_state(${await digest(peer)}) AS ok`);
  if (!slots.rows[0]?.ok) throw new ApiError(429, 'AUTH_STATE_LIMIT', 'Too many pending sign-ins. Try again later.');
  const { metadata, client, authentication, callback, options } = await provider(runtime);
  const state = oidc.generateRandomState(), binding = oidc.generateRandomState();
  const verifier = oidc.generateRandomCodeVerifier(), nonce = oidc.generateRandomNonce();
  let params = new URLSearchParams({ client_id:client.client_id, response_type:'code', scope:'openid profile email', redirect_uri:callback,
    state, nonce, code_challenge_method:'S256', code_challenge:await oidc.calculatePKCECodeChallenge(verifier) });
  const requiredAcr = runtime.config.accountClient?.requiredAcr;
  if (requiredAcr) params.set('claims', JSON.stringify({id_token:{acr:{essential:true, values:[requiredAcr]}}}));
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

// A refused, otherwise verified sign-in: one row per subject for the operator (scripts/list-signin-attempts.ts),
// who may then admit that subject explicitly. The address and name are shown, never trusted.
async function recordAttempt(runtime: Runtime, claims: oidc.IDToken, upstream: ProviderIdentity | null, address: string | null, outcome: string) {
  const acr = typeof claims.acr === 'string' ? claims.acr.slice(0, 200) : null, name = typeof claims.name === 'string' ? claims.name.slice(0, 200) : null;
  log('warn', { code: 'SIGN_IN_NOT_APPROVED', reason: outcome, subject: claims.sub, acr });
  await runtime.db.execute(sql`INSERT INTO bane_signin_attempts(issuer,subject,acr,provider,provider_hd,email,name,outcome)
    VALUES(${claims.iss},${claims.sub},${acr},${upstream?.provider ?? null},${upstream?.hd ?? null},${address},${name},${outcome})
    ON CONFLICT(issuer,subject) DO UPDATE SET acr=excluded.acr,provider=excluded.provider,provider_hd=excluded.provider_hd,email=excluded.email,
      name=excluded.name,outcome=excluded.outcome,attempts=bane_signin_attempts.attempts+1,last_at=now()`).catch(() => {});
}

export async function finishAccountLogin(runtime: Runtime, url: URL, binding: string) {
  const state = url.searchParams.get('state');
  if (!state || state.length > 256 || !binding || binding.length > 256) throw loginFailed();
  const {rows:[flow]} = await runtime.db.execute<{nonce:string;verifier:string;return_url:string}>(sql`
    DELETE FROM bane_login_flows WHERE state_hash=${await digest(state)} AND cookie_hash=${await digest(binding)}
      AND issuer=${runtime.config.accountIssuer} AND client_id=${runtime.config.accountClient?.id} AND expires_at>now() RETURNING nonce,verifier,return_url`);
  if (!flow) throw loginFailed();
  const { metadata, client, authentication, callback, options } = await provider(runtime);
  const params = oidc.validateAuthResponse(metadata, client, url, state);
  const response = await oidc.authorizationCodeGrantRequest(metadata, client, authentication, params, callback, flow.verifier, options);
  const tokens = await oidc.processAuthorizationCodeResponse(metadata, client, response, {requireIdToken:true,expectedNonce:flow.nonce});
  await oidc.validateApplicationLevelSignature(metadata, response, options);
  const claims = oidc.getValidatedIdTokenClaims(tokens)!;
  const requiredAcr = runtime.config.accountClient?.requiredAcr;
  const needUserInfo = (claims.email === undefined || claims.email_verified === undefined || !providerIdentity(claims)) && !!metadata.userinfo_endpoint;
  const profile = needUserInfo
    ? await oidc.processUserInfoResponse(metadata, client, claims.sub, await oidc.userInfoRequest(metadata, client, tokens.access_token, options))
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
  try {
    await runtime.db.transaction(async db => {
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([claims.iss,claims.sub])},83062))`);
      const existing = await db.execute<{user_id:string}>(sql`SELECT user_id FROM bane_oidc_identities WHERE issuer=${claims.iss} AND subject=${claims.sub} FOR SHARE`);
      let userId: string | undefined = existing.rows[0]?.user_id;
      if (!userId) {
        // A new subject is admitted only by a sub-bound decision: hosted staff (the provider identity, see
        // account-policy.ts), the invitation link it followed, or a self-hosted subject allowlist. Operators bind
        // anyone else by subject (scripts/cutover-fresh-start.ts --owner-sub, or a bane_oidc_identities row).
        if (!emailAtLogin) throw new NotAdmitted('unverified_email');
        const selfHosted = !runtime.config.multiTenant && runtime.config.allowedSubjects.includes(claims.sub);
        const invited = runtime.config.multiTenant && !staff && !!invitation && await pendingInvitation(db, emailAtLogin, invitation);
        if (!staff && !invited && !selfHosted) throw new NotAdmitted(invitation ? 'invitation' : 'not_approved');
        userId = crypto.randomUUID();
        const name = typeof claims.name === 'string' && claims.name.trim() ? claims.name.slice(0,200) : emailAtLogin;
        await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(lower(${emailAtLogin}),80324))`);
        // Verified addresses stay unique for display; a taken one is stored unverified rather than refusing the subject.
        await db.execute(sql`INSERT INTO bane_users(id,name,email,email_verified) VALUES(${userId},${name},${emailAtLogin},
          NOT EXISTS(SELECT FROM bane_users WHERE email_verified AND lower(email)=lower(${emailAtLogin})))`);
        await db.execute(sql`INSERT INTO bane_oidc_identities(issuer,subject,user_id) VALUES(${claims.iss},${claims.sub},${userId})`);
        log('info', { code: 'SIGN_IN_USER_CREATED', userId, subject: claims.sub, admission: staff ? 'staff' : invited ? 'invitation' : 'subject' });
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
      await db.execute(sql`INSERT INTO bane_sessions(token_hash,user_id,issuer,subject,verified_email,staff,expires_at) VALUES
        (${await digest(session)},${userId},${claims.iss},${claims.sub},${emailAtLogin ?? null},${staff},now()+interval '7 days')`);
    });
  } catch (error) {
    if (!(error instanceof NotAdmitted)) throw error;
    await recordAttempt(runtime, claims, upstream, address, error.reason);
    throw loginFailed();
  }
  return {session, returnUrl:returnUrl.href};
}

const cookieName = (runtime: Runtime, name: string) => `${runtime.config.publicUrl.startsWith('https:') ? '__Host-' : ''}bane.${name}`;
const cookieOptions = (runtime: Runtime, maxAge: number) => ({ httpOnly:true, secure:runtime.config.publicUrl.startsWith('https:'), sameSite:'Lax' as const, path:'/', maxAge });

async function currentSession(runtime: Runtime, headers: Headers) {
  const name = cookieName(runtime, 'session_token');
  const cookies = headers.get('cookie')?.split(';').map(c=>c.trim()).filter(c=>c.startsWith(`${name}=`));
  if (cookies?.length !== 1) return null;
  const token = cookies[0]!.slice(name.length+1);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return digest(token);
}

export async function accountSessionUser(runtime: Runtime, headers: Headers, requireCurrentEmail = false) {
  const hash = await currentSession(runtime, headers);
  if (!hash) return null;
  const {rows:[user]} = await runtime.db.execute<{id:string;email:string}>(sql`SELECT u.id,u.email FROM bane_sessions s
    JOIN bane_users u ON u.id=s.user_id WHERE s.token_hash=${hash} AND s.issuer=${runtime.config.accountIssuer}
    AND s.expires_at>now() AND u.email_verified ${requireCurrentEmail ? sql`AND lower(u.email)=lower(s.verified_email)` : sql``}`);
  return user ?? null;
}

/** The current dashboard session's subject and hosted staff status (decided at sign-in from the provider identity). */
export async function accountSessionPolicy(runtime: Runtime, headers: Headers) {
  const hash = await currentSession(runtime, headers);
  if (!hash) return null;
  const {rows:[row]} = await runtime.db.execute<{subject:string;staff:boolean}>(sql`SELECT subject,staff FROM bane_sessions
    WHERE token_hash=${hash} AND issuer=${runtime.config.accountIssuer} AND expires_at>now()`);
  return row ?? null;
}

export async function accountSessionActor(runtime: Runtime, headers: Headers): Promise<Actor|null> {
  const hash = await currentSession(runtime, headers);
  if (!hash) return null;
  const selected = headers.get('x-bane-workspace') ?? headers.get('x-opensend-workspace');
  const {rows:[m]} = await runtime.db.execute<{id:string;email:string;name:string;workspace:string;role:string}>(sql`
    WITH member AS (SELECT u.id,u.email,u.name,m.workspace_id AS workspace,m.role FROM bane_sessions s JOIN bane_users u ON s.user_id=u.id
      JOIN workspace_members m ON m.user_id=u.id WHERE s.token_hash=${hash} AND s.issuer=${runtime.config.accountIssuer} AND s.expires_at>now()
      AND u.email_verified AND m.role IN ('owner','admin','member')
      ${runtime.config.multiTenant ? sql`` : sql`AND m.role IN ('owner','admin') AND ${JSON.stringify(runtime.config.allowedSubjects)}::jsonb ? s.subject`}
      ${selected && runtime.config.multiTenant ? sql`AND m.workspace_id=${selected}` : sql``}
      ORDER BY (m.workspace_id=u.selected_workspace_id) DESC NULLS LAST,m.created_at,m.id LIMIT 1
    ), selected AS (UPDATE bane_users u SET selected_workspace_id=member.workspace FROM member WHERE u.id=member.id AND u.selected_workspace_id IS DISTINCT FROM member.workspace)
    SELECT * FROM member`);
  if (!m) {
    if (selected && runtime.config.multiTenant && await accountSessionUser(runtime,headers)) throw new ApiError(403,'WORKSPACE_ACCESS_DENIED','This workspace is not available to your session.');
    return null;
  }
  return { keyId:`user_${m.id}`, email:m.email, name:m.name, workspaceId:m.workspace, role:m.role, permissions:m.role==='member'?['read','send']:['manage'], domains:[],credential:'dashboard' };
}

export async function accountBrowserRoute(c: Ctx) {
  const runtime = c.env, path = c.req.path, origin = new URL(runtime.config.publicUrl).origin;
  c.header('Cache-Control','no-store');
  if (c.req.method === 'POST' && c.req.header('origin') !== origin) throw new ApiError(403,'CSRF_ORIGIN_INVALID','Use the dashboard to sign in or out.');
  if (path === '/api/auth/sign-in/account' && c.req.method === 'POST') {
    const input = z.object({ callbackURL:z.url().max(2048) }).strict().safeParse(await c.req.json().catch(()=>null));
    if (!input.success) throw new ApiError(422,'AUTH_INPUT_INVALID','Supply the dashboard return URL.');
    const start = await beginAccountLogin(runtime,new URL(input.data.callbackURL),c.req.header('x-bane-client-ip') ?? 'unknown').catch(error=>{
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
    try {
      const { session,returnUrl } = await finishAccountLogin(runtime,new URL(c.req.url),binding);
      setCookie(c,cookieName(runtime,'session_token'),session,cookieOptions(runtime,604800));
      return c.redirect(returnUrl,303);
    } catch (error) {
      const issue = loginIssue(error, runtime.config.accountClient?.requiredAcr);
      log('warn', { code: 'SIGN_IN_DENIED', reason: issue?.reason ?? (error instanceof ApiError ? error.code : 'error') });
      return c.redirect(`${origin}/?auth=${issue?.reason ?? 'error'}`,303);
    }
  }
  if (path === '/api/auth/sign-out' && c.req.method === 'POST') {
    const hash = await currentSession(runtime,c.req.raw.headers);
    if (hash) await runtime.db.execute(sql`DELETE FROM bane_sessions WHERE token_hash=${hash}`);
    setCookie(c,cookieName(runtime,'session_token'),'',cookieOptions(runtime,0));
    return c.json({success:true});
  }
  if (path === '/api/auth/get-session' && c.req.method === 'GET') return c.json(await accountSessionUser(runtime,c.req.raw.headers));
  throw new ApiError(404,'NOT_FOUND','Authentication endpoint was not found.');
}
