import type { BetterAuthPlugin } from 'better-auth';
import type { OAuthProvider } from '@better-auth/core/oauth2';
import { getOAuthState } from 'better-auth/api';
import { and, eq } from 'drizzle-orm';
import * as oidc from 'oauth4webapi';
import type { Config, Runtime } from './core.js';
import { authAccount, authUser } from './db/google-auth.js';

export function accountPlugin(runtime: Runtime, config: NonNullable<Config['accountClient']>, callback?: URL): BetterAuthPlugin {
  const issuer = new URL(config.issuer);
  const client = { client_id: config.id, id_token_signed_response_alg: 'ES256' };
  const options = { signal: () => AbortSignal.timeout(6000), [oidc.customFetch]: (url: string, init: RequestInit) => {
    if (new URL(url).origin !== issuer.origin) throw Error('Unexpected issuer endpoint');
    return fetch(url, { ...init, redirect: 'error' });
  } };
  async function connect() {
    const as = await oidc.processDiscoveryResponse(issuer, await oidc.discoveryRequest(issuer, options));
    const jwk = JSON.parse(config.key);
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const auth = oidc.PrivateKeyJwt({ key, kid: jwk.kid });
    if (!as.userinfo_endpoint) throw Error('Missing account resource');
    return { as, auth, resource: as.userinfo_endpoint };
  }
  // Better Auth creates this provider per request. Keep the response here until its
  // callback supplies the nonce from the one-use, cookie-bound state record.
  let exchange: { as: oidc.AuthorizationServer; response: Response } | undefined;
  const provider: OAuthProvider = {
    id: 'account', name: 'Account', issuer: config.issuer, requiresIdTokenNonce: true,
    options: { disableSignUp: true },
    accountSubject: ({ profile }) => (profile as { subject: string }).subject,
    async createAuthorizationURL({ state, codeVerifier, idTokenNonce, redirectURI }) {
      if (!idTokenNonce) throw Error('Missing nonce');
      const { as, auth, resource } = await connect();
      const url = new URL(as.authorization_endpoint!);
      if (url.origin !== issuer.origin) throw Error('Unexpected authorization endpoint');
      let params = new URLSearchParams({ client_id: client.client_id, scope: 'openid', resource,
        response_type: 'code', redirect_uri: redirectURI, state, nonce: idTokenNonce, prompt: 'select_account',
        code_challenge_method: 'S256', code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier) });
      if (as.pushed_authorization_request_endpoint) {
        const pushed = await oidc.processPushedAuthorizationResponse(as, client,
          await oidc.pushedAuthorizationRequest(as, client, auth, params, options));
        params = new URLSearchParams({ client_id: client.client_id, request_uri: pushed.request_uri });
      } else if (as.require_pushed_authorization_requests) throw Error('Missing PAR endpoint');
      url.search = params.toString();
      return url;
    },
    async validateAuthorizationCode({ code, codeVerifier, redirectURI }) {
      if (!codeVerifier || !callback) return null;
      const { as, auth, resource } = await connect();
      // Better Auth already consumed the browser-bound state. Validate the issuer's actual response.
      const params = oidc.validateAuthResponse(as, client, callback, oidc.skipStateCheck);
      if (params.get('code') !== code) return null;
      const response = await oidc.authorizationCodeGrantRequest(as, client, auth, params, redirectURI, codeVerifier,
        { ...options, additionalParameters: { resource } });
      exchange = { as, response };
      return {};
    },
    async getUserInfo({ expectedIdTokenNonce }) {
      if (!exchange || !expectedIdTokenNonce) return null;
      const { as, response } = exchange;
      const tokens = await oidc.processAuthorizationCodeResponse(as, client, response, { expectedNonce: expectedIdTokenNonce, requireIdToken: true });
      await oidc.validateApplicationLevelSignature(as, response, options);
      const { iss, sub } = oidc.getValidatedIdTokenClaims(tokens)!;
      const subject = JSON.stringify([iss, sub]);
      const link = (await getOAuthState())?.link;
      const fields = { email: authUser.email, name: authUser.name, emailVerified: authUser.emailVerified };
      const [user] = link ? await runtime.db.select(fields).from(authUser).where(eq(authUser.id, link.userId)) :
        await runtime.db.select(fields).from(authAccount).innerJoin(authUser, eq(authUser.id, authAccount.userId))
          .where(and(eq(authAccount.providerId, 'account'), eq(authAccount.accountId, subject)));
      // Bane's verified local identity comes from the existing membership. Never
      // discover a user by an upstream email or let the issuer supply Google hd.
      return user?.emailVerified ? { user, data: { subject } } : null;
    },
  };
  return { id: 'bane-account', init: ctx => ({ context: { socialProviders: [provider, ...ctx.socialProviders] } }) };
}
