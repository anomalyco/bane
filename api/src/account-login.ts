import * as oidc from 'oauth4webapi';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError, digest, type Actor, type Ctx, type Runtime } from './core.js';
import { getCookie, setCookie } from 'hono/cookie';
import { onboardNewUser, pendingInvitation } from './workspaces.js';

const verifiedEmail = z.email().max(320);
const loginFailed = () => new ApiError(403, 'SIGN_IN_DENIED', 'This account cannot sign in.');

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
  const returnUrl = new URL(flow.return_url);
  if (returnUrl.origin !== new URL(runtime.config.publicUrl).origin) throw loginFailed();
  const invitation = returnUrl.pathname === '/' ? returnUrl.searchParams.get('invitation') : null;
  const session = oidc.generateRandomState();
  await runtime.db.transaction(async db => {
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([claims.iss,claims.sub])},83062))`);
    const existing = await db.execute<{user_id:string}>(sql`SELECT user_id FROM bane_oidc_identities WHERE issuer=${claims.iss} AND subject=${claims.sub} FOR SHARE`);
    let userId: string | undefined = existing.rows[0]?.user_id;
    if (!userId) {
      const verified = verifiedEmail.safeParse(claims.email);
      if (claims.email_verified !== true || !verified.success) throw loginFailed();
      const email = verified.data;
      const migrated = await db.execute<{id:string|null}>(sql`SELECT claim_bane_legacy_user(${claims.iss},${claims.sub},${email},true) AS id`);
      userId = migrated.rows[0]?.id ?? undefined;
      if (!userId) {
        const allowed = runtime.config.allowedEmails.includes(email.toLowerCase());
        if (!allowed && (!runtime.config.multiTenant || !invitation || !await pendingInvitation(db,email,invitation))) throw loginFailed();
        userId = crypto.randomUUID();
        const name = typeof claims.name === 'string' ? claims.name.slice(0,200) : email;
        // A colliding legacy email is reserved; only the reviewed claim above can adopt it.
        const inserted = await db.execute(sql`INSERT INTO bane_users(id,name,email,email_verified) SELECT ${userId},${name},${email},true
          WHERE NOT EXISTS(SELECT FROM bane_users WHERE lower(email)=lower(${email})) ON CONFLICT DO NOTHING RETURNING id`);
        if (!inserted.rowCount) throw loginFailed();
        await db.execute(sql`INSERT INTO bane_oidc_identities(issuer,subject,user_id) VALUES(${claims.iss},${claims.sub},${userId})`);
        if (runtime.config.multiTenant) {
          if (!await onboardNewUser(db,{id:userId,email,name},allowed,runtime.config.regions[0]!,invitation)) throw loginFailed();
        } else if (runtime.config.defaultWorkspaceOwners === '*' || runtime.config.defaultWorkspaceOwners.includes(email.toLowerCase())) {
          await db.execute(sql`INSERT INTO workspace_members(id,user_id,workspace_id,role) VALUES(${crypto.randomUUID()},${userId},'default','owner')`);
        }
      }
    }
    await db.execute(sql`INSERT INTO bane_sessions(token_hash,user_id,issuer,subject,expires_at) VALUES
      (${await digest(session)},${userId},${claims.iss},${claims.sub},now()+interval '7 days')`);
  });
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

export async function accountSessionUser(runtime: Runtime, headers: Headers) {
  const hash = await currentSession(runtime, headers);
  if (!hash) return null;
  const {rows:[user]} = await runtime.db.execute<{id:string;email:string}>(sql`SELECT u.id,u.email FROM bane_sessions s
    JOIN bane_users u ON u.id=s.user_id WHERE s.token_hash=${hash} AND s.issuer=${runtime.config.accountIssuer}
    AND s.expires_at>now() AND u.email_verified`);
  return user ?? null;
}

export async function accountSessionActor(runtime: Runtime, headers: Headers): Promise<Actor|null> {
  const hash = await currentSession(runtime, headers);
  if (!hash) return null;
  const selected = headers.get('x-bane-workspace') ?? headers.get('x-opensend-workspace');
  const {rows:[m]} = await runtime.db.execute<{id:string;email:string;name:string;workspace:string;role:string}>(sql`
    WITH member AS (SELECT u.id,u.email,u.name,m.workspace_id AS workspace,m.role FROM bane_sessions s JOIN bane_users u ON s.user_id=u.id
      JOIN workspace_members m ON m.user_id=u.id WHERE s.token_hash=${hash} AND s.issuer=${runtime.config.accountIssuer} AND s.expires_at>now()
      AND u.email_verified AND m.role IN ('owner','admin','member')
      ${runtime.config.multiTenant ? sql`` : sql`AND m.role IN ('owner','admin') AND ${JSON.stringify(runtime.config.allowedEmails)}::jsonb ? lower(u.email)`}
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
    const start = await beginAccountLogin(runtime,new URL(input.data.callbackURL),c.req.header('x-bane-client-ip') ?? 'unknown');
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
    } catch { return c.redirect(`${origin}/?auth=error`,303); }
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
