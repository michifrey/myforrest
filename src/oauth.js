'use strict';

/**
 * Sign-in with external identity providers (OAuth 2.0 authorization code flow
 * with PKCE), without external dependencies.
 *
 * - Google (OpenID Connect): the profile comes from the userinfo endpoint with
 *   the access token, so no ID token signature has to be checked here.
 * - GitHub (OAuth App): the profile from /user, the e-mail address from
 *   /user/emails (only a primary, verified one).
 * - SWITCH edu-ID and any other OpenID Connect provider (`oidc`): the
 *   endpoints come from the provider's discovery document
 *   (`<issuer>/.well-known/openid-configuration`, fetched once and checked
 *   against the configured issuer), the profile from its userinfo endpoint.
 *   An address counts as verified only with `email_verified: true`.
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

/** Profile from a standard OpenID Connect userinfo response. */
async function oidcProfile(token, get, provider) {
  const p = await get(provider.userinfoUrl, token);
  const name = p.name || [p.given_name, p.family_name].filter(Boolean).join(' ') || p.preferred_username || null;
  return {
    subject: p.sub === undefined ? null : String(p.sub),
    email: p.email || null,
    emailVerified: p.email_verified === true || p.email_verified === 'true',
    name,
  };
}

// OpenID Connect providers whose endpoints are discovered from their issuer.
Object.assign(PROVIDERS, {
  // Switch edu-ID: the login of Swiss universities, colleges and research; also open to everyone.
  eduid: { label: 'SWITCH edu-ID', issuer: 'https://login.eduid.ch/', scope: 'openid email profile', profile: oidcProfile },
  // Any further provider, e.g. the Microsoft account of an organisation or a Keycloak (issuer and label from the config).
  oidc: { label: 'OpenID Connect', scope: 'openid email profile', profile: oidcProfile },
});

const base64url = (buf) => Buffer.from(buf).toString('base64url');
const sameIssuer = (a, b) => String(a || '').replace(/\/+$/, '') === String(b || '').replace(/\/+$/, '');

/**
 * Enabled providers from the configuration, e.g.
 * `{ google: { clientId, clientSecret }, github: { … } }`. Endpoints may be
 * overridden per provider (tests, GitHub Enterprise).
 */
function createOAuth({ providers = {}, publicUrl = null, fetchImpl = fetch } = {}) {
  const enabled = {};
  for (const [id, conf] of Object.entries(providers)) {
    if (!PROVIDERS[id] || !conf?.clientId || !conf?.clientSecret) continue;
    const p = { ...PROVIDERS[id], ...Object.fromEntries(Object.entries(conf).filter(([, v]) => v)), id };
    if (p.profile === oidcProfile && !p.issuer && !p.authorizeUrl) continue; // a generic provider needs its issuer
    enabled[id] = p;
  }

  /** Endpoints of an OpenID Connect provider from its discovery document (cached; retried after a failure). */
  const discovered = new Map();
  async function endpoints(provider) {
    if (provider.authorizeUrl) return provider;
    if (!discovered.has(provider.id)) {
      discovered.set(provider.id, (async () => {
        const url = `${provider.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
        const res = await fetchImpl(url, { headers: { Accept: 'application/json', 'User-Agent': 'MyForrest' } });
        if (!res.ok) throw new Error(`${provider.label} ist gerade nicht erreichbar (HTTP ${res.status})`);
        const d = await res.json();
        if (!sameIssuer(d.issuer, provider.issuer)) throw new Error(`${provider.label}: der Anbieter meldet einen anderen Aussteller`);
        const https = (u) => typeof u === 'string' && u.startsWith('https://');
        if (![d.authorization_endpoint, d.token_endpoint, d.userinfo_endpoint].every(https)) {
          throw new Error(`${provider.label}: unvollständige Konfiguration des Anbieters`);
        }
        const methods = d.token_endpoint_auth_methods_supported;
        return {
          ...provider,
          authorizeUrl: d.authorization_endpoint,
          tokenUrl: d.token_endpoint,
          userinfoUrl: d.userinfo_endpoint,
          // client_secret_post when offered (or when nothing is said), otherwise HTTP Basic.
          basicAuth: Array.isArray(methods) && !methods.includes('client_secret_post') && methods.includes('client_secret_basic'),
        };
      })().catch((err) => { discovered.delete(provider.id); throw err; }));
    }
    return discovered.get(provider.id);
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
    async begin(provider, origin) {
      const ep = await endpoints(provider);
      const state = base64url(crypto.randomBytes(24));
      const verifier = base64url(crypto.randomBytes(32));
      const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
      const url = new URL(ep.authorizeUrl);
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

      const ep = await endpoints(provider);
      const form = {
        grant_type: 'authorization_code',
        code: query.code,
        redirect_uri: redirectUri(provider, origin),
        client_id: provider.clientId,
        code_verifier: verifier,
      };
      const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': 'MyForrest' };
      if (ep.basicAuth) {
        const enc = (v) => encodeURIComponent(v);
        headers.Authorization = `Basic ${Buffer.from(`${enc(provider.clientId)}:${enc(provider.clientSecret)}`).toString('base64')}`;
      } else {
        form.client_secret = provider.clientSecret;
      }
      const res = await fetchImpl(ep.tokenUrl, { method: 'POST', headers, body: new URLSearchParams(form).toString() });
      const tokens = await res.json().catch(() => ({}));
      if (!res.ok || !tokens.access_token) {
        throw new Error(`${provider.label} hat die Anmeldung nicht bestätigt${tokens.error ? ` (${tokens.error})` : ''}`);
      }
      const profile = await ep.profile(tokens.access_token, getJson, ep);
      if (!profile.subject || profile.subject === 'undefined') throw new Error(`${provider.label} hat kein Konto geliefert`);
      return profile;
    },
  };
}

/**
 * Provider configuration from the environment: GOOGLE_, GITHUB_, EDUID_ and
 * OIDC_CLIENT_ID / _CLIENT_SECRET; the generic provider also takes
 * OIDC_ISSUER and OIDC_LABEL (and EDUID_ISSUER may point to a test system).
 */
function providersFromEnv(env = process.env) {
  const out = {};
  for (const id of Object.keys(PROVIDERS)) {
    const key = id.toUpperCase();
    if (env[`${key}_CLIENT_ID`] && env[`${key}_CLIENT_SECRET`]) {
      out[id] = {
        clientId: env[`${key}_CLIENT_ID`],
        clientSecret: env[`${key}_CLIENT_SECRET`],
        issuer: env[`${key}_ISSUER`] || undefined,
        label: env[`${key}_LABEL`] || undefined,
      };
    }
  }
  return out;
}

module.exports = { PROVIDERS, STATE_COOKIE, STATE_TTL_MS, createOAuth, providersFromEnv };
