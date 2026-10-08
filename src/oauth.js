'use strict';

/**
 * Sign-in with external identity providers (OAuth 2.0 authorization code flow
 * with PKCE), without external dependencies.
 *
 * - Google (OpenID Connect): the profile comes from the userinfo endpoint with
 *   the access token, so no ID token signature has to be checked here.
 * - GitHub (OAuth App): the profile from /user, the e-mail address from
 *   /user/emails (only a primary, verified one).
 *
 * A provider is enabled when its client ID and secret are configured. The
 * `state` and the PKCE verifier travel in a short-lived httpOnly cookie bound
 * to the callback path; the callback only proceeds when the `state` in the
 * query matches the cookie, which stops login CSRF and code injection.
 */

const crypto = require('node:crypto');

const STATE_COOKIE = 'mf_oauth';
const STATE_TTL_MS = 10 * 60 * 1000;

const PROVIDERS = {
  google: {
    label: 'Google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    extraParams: { prompt: 'select_account' },
    async profile(token, get) {
      const p = await get('https://openidconnect.googleapis.com/v1/userinfo', token);
      return {
        subject: String(p.sub),
        email: p.email || null,
        emailVerified: p.email_verified === true || p.email_verified === 'true',
        name: p.name || p.given_name || null,
      };
    },
  },
  github: {
    label: 'GitHub',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scope: 'read:user user:email',
    extraParams: { allow_signup: 'true' },
    async profile(token, get) {
      const u = await get('https://api.github.com/user', token);
      const emails = await get('https://api.github.com/user/emails', token).catch(() => []);
      const primary = Array.isArray(emails) ? emails.find((e) => e.primary && e.verified) : null;
      return {
        subject: String(u.id),
        email: primary?.email || null,
        emailVerified: Boolean(primary),
        name: u.login || u.name || null,
      };
    },
  },
};

const base64url = (buf) => Buffer.from(buf).toString('base64url');

/**
 * Enabled providers from the configuration, e.g.
 * `{ google: { clientId, clientSecret }, github: { … } }`. Endpoints may be
 * overridden per provider (tests, GitHub Enterprise).
 */
function createOAuth({ providers = {}, publicUrl = null, fetchImpl = fetch } = {}) {
  const enabled = {};
  for (const [id, conf] of Object.entries(providers)) {
    if (PROVIDERS[id] && conf?.clientId && conf?.clientSecret) enabled[id] = { ...PROVIDERS[id], ...conf, id };
  }

  const redirectUri = (provider, origin) => `${(publicUrl || origin).replace(/\/+$/, '')}/api/auth/oauth/${provider.id}/callback`;

  async function getJson(url, token) {
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'MyForrest' },
    });
    if (!res.ok) throw new Error(`${new URL(url).host} antwortet mit HTTP ${res.status}`);
    return res.json();
  }

  return {
    /** Public list for the login dialog. */
    list: () => Object.values(enabled).map((p) => ({ id: p.id, label: p.label })),
    get: (id) => (Object.hasOwn(enabled, id) ? enabled[id] : null),

    /** Starts a flow: the provider URL to redirect to and the cookie value to set. */
    begin(provider, origin) {
      const state = base64url(crypto.randomBytes(24));
      const verifier = base64url(crypto.randomBytes(32));
      const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
      const url = new URL(provider.authorizeUrl);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: provider.clientId,
        redirect_uri: redirectUri(provider, origin),
        scope: provider.scope,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        ...provider.extraParams,
      }).toString();
      return { url: url.href, cookie: `${provider.id}.${state}.${verifier}` };
    },

    /**
     * Checks the callback against the cookie, exchanges the code and returns
     * the profile `{ subject, email, emailVerified, name }`. Throws with a
     * message for the user on any failure.
     */
    async finish(provider, origin, query, cookie) {
      if (query.error) throw new Error(query.error === 'access_denied' ? 'Anmeldung abgebrochen' : `${provider.label}: ${query.error}`);
      const [id, state, verifier] = String(cookie || '').split('.');
      const expected = Buffer.from(String(state || ''));
      const actual = Buffer.from(String(query.state || ''));
      if (id !== provider.id || !state || !verifier || expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
        throw new Error('Die Anmeldung ist abgelaufen oder wurde in einem anderen Fenster gestartet – bitte erneut versuchen');
      }
      if (typeof query.code !== 'string' || !query.code) throw new Error(`${provider.label} hat keinen Code geliefert`);

      const res = await fetchImpl(provider.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': 'MyForrest' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: query.code,
          redirect_uri: redirectUri(provider, origin),
          client_id: provider.clientId,
          client_secret: provider.clientSecret,
          code_verifier: verifier,
        }).toString(),
      });
      const tokens = await res.json().catch(() => ({}));
      if (!res.ok || !tokens.access_token) {
        throw new Error(`${provider.label} hat die Anmeldung nicht bestätigt${tokens.error ? ` (${tokens.error})` : ''}`);
      }
      const profile = await provider.profile(tokens.access_token, getJson);
      if (!profile.subject || profile.subject === 'undefined') throw new Error(`${provider.label} hat kein Konto geliefert`);
      return profile;
    },
  };
}

/** Provider configuration from the environment (GOOGLE_CLIENT_ID, GITHUB_CLIENT_SECRET, …). */
function providersFromEnv(env = process.env) {
  const out = {};
  for (const id of Object.keys(PROVIDERS)) {
    const key = id.toUpperCase();
    if (env[`${key}_CLIENT_ID`] && env[`${key}_CLIENT_SECRET`]) {
      out[id] = { clientId: env[`${key}_CLIENT_ID`], clientSecret: env[`${key}_CLIENT_SECRET`] };
    }
  }
  return out;
}

module.exports = { PROVIDERS, STATE_COOKIE, STATE_TTL_MS, createOAuth, providersFromEnv };
