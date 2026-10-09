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
 * - Microsoft (personal, work and school accounts): the profile comes from
 *   the ID token, received directly from the token endpoint over TLS (so,
 *   as OpenID Connect allows, without checking its signature; audience,
 *   expiry, issuer and tenant are checked). Microsoft sends no
 *   `email_verified`, and in other tenants anybody can enter any address
 *   ("nOAuth"): the address counts as verified only with the optional claim
 *   `xms_edov` (domain owner verified), which the app registration has to
 *   add to the ID token together with `email`.
 * - AGOV (authentication service of Swiss authorities): an OpenID Connect
 *   provider like the generic one, with its issuer from the configuration.
 *
 * Instead of a client secret, any OpenID Connect provider can take a private
 * key (`privateKey`, PEM, RSA or EC P-256): the app then authenticates at the
 * token endpoint with a signed assertion (`private_key_jwt`, RFC 7523) and
 * publishes the public keys at /api/auth/jwks.json for the registration.
 * `acrValues` asks for an authentication quality (`acr_values`); it is
 * requested, not enforced, since nothing in the app depends on it.
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
  // AGOV, the login of Swiss authorities: the issuer comes from the registration in AGOV connect.
  agov: { label: 'AGOV', scope: 'openid profile email', profile: oidcProfile },
});

const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true';

/** Profile from Microsoft's ID token; throws when the token does not belong to this app and tenant. */
function microsoftProfile(token, get, provider, tokens) {
  const parts = String(tokens?.id_token || '').split('.');
  let c;
  try {
    c = JSON.parse(Buffer.from(parts[1] || '', 'base64url').toString('utf8'));
  } catch {
    throw new Error('Microsoft hat kein gültiges ID-Token geliefert');
  }
  const iss = /^https:\/\/login\.microsoftonline\.com\/([0-9a-f-]{36})\/v2\.0$/.exec(String(c.iss || ''));
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  const tenantFixed = /^[0-9a-f-]{36}$/.test(provider.tenant);
  if (!iss || iss[1] !== c.tid || !aud.includes(provider.clientId) || !(Number(c.exp) * 1000 > Date.now() - 60_000)
    || (tenantFixed && c.tid !== provider.tenant)) {
    throw new Error('Microsoft hat ein ID-Token für eine andere Anwendung oder Organisation geliefert');
  }
  const email = c.email || null;
  return {
    subject: c.sub === undefined ? null : String(c.sub),
    email,
    emailVerified: Boolean(email) && truthy(c.xms_edov),
    name: c.name || c.preferred_username || null,
  };
}

// Microsoft: endpoints per tenant ('common' = personal and organisation accounts, 'organizations',
// 'consumers' or one tenant's id).
PROVIDERS.microsoft = {
  label: 'Microsoft',
  tenant: 'common',
  scope: 'openid email profile',
  extraParams: { prompt: 'select_account' },
  urls: (p) => ({
    authorizeUrl: `https://login.microsoftonline.com/${encodeURIComponent(p.tenant)}/oauth2/v2.0/authorize`,
    tokenUrl: `https://login.microsoftonline.com/${encodeURIComponent(p.tenant)}/oauth2/v2.0/token`,
  }),
  profile: microsoftProfile,
};

const base64url = (buf) => Buffer.from(buf).toString('base64url');

/** A signing key from PEM: algorithm, public JWK with its RFC 7638 thumbprint as `kid`. */
function signingKey(pem) {
  const key = crypto.createPrivateKey(pem);
  const jwk = crypto.createPublicKey(key).export({ format: 'jwk' });
  let alg;
  if (jwk.kty === 'RSA') alg = 'RS256';
  else if (jwk.kty === 'EC' && jwk.crv === 'P-256') alg = 'ES256';
  else throw new Error('Privater Schlüssel: nur RSA oder EC P-256');
  const members = jwk.kty === 'RSA' ? { e: jwk.e, kty: jwk.kty, n: jwk.n } : { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
  const kid = base64url(crypto.createHash('sha256').update(JSON.stringify(members)).digest());
  return { key, alg, publicJwk: { ...members, kid, alg, use: 'sig' } };
}

/** A client assertion for the token endpoint (private_key_jwt). */
function clientAssertion(provider, audience) {
  const { key, alg, publicJwk } = provider.signing;
  const t = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg, kid: publicJwk.kid, typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: provider.clientId, sub: provider.clientId, aud: audience, jti: base64url(crypto.randomBytes(16)), iat: t, exp: t + 60,
  }));
  const input = `${header}.${payload}`;
  const signature = crypto.sign('sha256', Buffer.from(input), alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key);
  return `${input}.${base64url(signature)}`;
}
const sameIssuer = (a, b) => String(a || '').replace(/\/+$/, '') === String(b || '').replace(/\/+$/, '');

/**
 * Enabled providers from the configuration, e.g.
 * `{ google: { clientId, clientSecret }, github: { … } }`. Endpoints may be
 * overridden per provider (tests, GitHub Enterprise).
 */
function createOAuth({ providers = {}, publicUrl = null, fetchImpl = fetch } = {}) {
  const enabled = {};
  for (const [id, conf] of Object.entries(providers)) {
    if (!PROVIDERS[id] || !conf?.clientId || !(conf.clientSecret || conf.privateKey)) continue;
    const p = { ...PROVIDERS[id], ...Object.fromEntries(Object.entries(conf).filter(([, v]) => v)), id };
    if (p.profile === oidcProfile && !p.issuer && !p.authorizeUrl) continue; // a generic provider needs its issuer
    if (p.privateKey) {
      if (p.profile !== oidcProfile) throw new Error(`${p.label}: Anmeldung mit Schlüssel nur bei OpenID-Connect-Anbietern`);
      p.signing = signingKey(p.privateKey);
    }
    if (p.acrValues) p.extraParams = { ...p.extraParams, acr_values: p.acrValues };
    if (p.urls && !conf.authorizeUrl) Object.assign(p, p.urls(p));
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
        if (provider.signing && Array.isArray(methods) && !methods.includes('private_key_jwt')) {
          throw new Error(`${provider.label} unterstützt keine Anmeldung mit Schlüssel (private_key_jwt)`);
        }
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
    /** Public keys for private_key_jwt, to register with the providers (JWKS). */
    jwks: () => ({ keys: Object.values(enabled).filter((p) => p.signing).map((p) => p.signing.publicJwk) }),

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
      if (ep.signing) {
        form.client_assertion_type = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
        form.client_assertion = clientAssertion(ep, ep.tokenUrl);
      } else if (ep.basicAuth) {
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
      const profile = await ep.profile(tokens.access_token, getJson, ep, tokens);
      if (!profile.subject || profile.subject === 'undefined') throw new Error(`${provider.label} hat kein Konto geliefert`);
      return profile;
    },
  };
}

/**
 * Provider configuration from the environment: GOOGLE_, GITHUB_, MICROSOFT_,
 * EDUID_ and OIDC_CLIENT_ID / _CLIENT_SECRET; the generic provider also takes
 * OIDC_ISSUER and OIDC_LABEL (EDUID_ISSUER may point to a test system), and
 * MICROSOFT_TENANT limits the accounts (default 'common'). AGOV_ (and the
 * other OpenID Connect providers) may take _PRIVATE_KEY_FILE (PEM) instead of
 * the secret, and _ACR_VALUES.
 */
function providersFromEnv(env = process.env) {
  const out = {};
  for (const id of Object.keys(PROVIDERS)) {
    const key = id.toUpperCase();
    const keyFile = env[`${key}_PRIVATE_KEY_FILE`];
    const privateKey = keyFile ? require('node:fs').readFileSync(keyFile, 'utf8') : undefined;
    if (env[`${key}_CLIENT_ID`] && (env[`${key}_CLIENT_SECRET`] || privateKey)) {
      out[id] = {
        clientId: env[`${key}_CLIENT_ID`],
        clientSecret: env[`${key}_CLIENT_SECRET`] || undefined,
        privateKey,
        acrValues: env[`${key}_ACR_VALUES`] || undefined,
        issuer: env[`${key}_ISSUER`] || undefined,
        label: env[`${key}_LABEL`] || undefined,
        tenant: env[`${key}_TENANT`] || undefined,
      };
    }
  }
  return out;
}

module.exports = { PROVIDERS, STATE_COOKIE, STATE_TTL_MS, createOAuth, providersFromEnv };
