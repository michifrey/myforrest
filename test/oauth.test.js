'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');

const noWeather = async () => new Response('offline', { status: 503 });

/**
 * Fake Google and GitHub: a code is the key of a profile in `accounts`.
 * The token endpoint checks the PKCE verifier against the challenge sent to
 * the authorize URL (remembered in `challenges` by the test).
 */
function fakeProviders(accounts, challenges) {
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  return async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/token') || u.pathname.endsWith('/access_token')) {
      const body = new URLSearchParams(init.body);
      const account = accounts[body.get('code')];
      const challenge = crypto.createHash('sha256').update(body.get('code_verifier') || '').digest('base64url');
      if (!account || !challenges.has(challenge)) return json({ error: 'invalid_grant' }, 400);
      return json({ access_token: `at-${body.get('code')}`, token_type: 'bearer' });
    }
    const code = String(init.headers?.Authorization || '').replace('Bearer at-', '');
    const a = accounts[code];
    if (!a) return json({ message: 'Bad credentials' }, 401);
    if (u.host === 'openidconnect.googleapis.com') return json({ sub: a.sub, email: a.email, email_verified: a.verified, name: a.name });
    if (u.pathname === '/user') return json({ id: Number(a.sub), login: a.name });
    if (u.pathname === '/user/emails') return json([{ email: a.email, primary: true, verified: a.verified }]);
    return json({}, 404);
  };
}

async function withServer(accounts, fn, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-oauth-'));
  const challenges = new Set();
  const mails = [];
  const app = createApp({
    mailer: { send: async (m) => { mails.push(m); return { sent: true }; } },
    dataDir,
    weatherFetch: noWeather,
    oauthProviders: { google: { clientId: 'gid', clientSecret: 'gsecret' }, github: { clientId: 'hid', clientSecret: 'hsecret' }, ...extra.providers },
    oauthFetch: extra.fetch ? extra.fetch(accounts, challenges) : fakeProviders(accounts, challenges),
  });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, challenges, mails);
  } finally {
    await app.locals.idle();
    server.close();
    app.locals.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

/** A browser with a cookie jar that does not follow redirects. */
function browser(base) {
  const jar = new Map();
  const b = {
    csrf: null,
    async req(url, { method = 'GET', json } = {}) {
      const headers = {};
      if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      if (b.csrf && method !== 'GET') headers['X-CSRF-Token'] = b.csrf;
      if (json !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetch(url.startsWith('http') ? url : `${base}${url}`, {
        method, headers, redirect: 'manual', body: json === undefined ? undefined : JSON.stringify(json),
      });
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        const [k, v] = [pair.slice(0, i), pair.slice(i + 1)];
        if (v) jar.set(k, v); else jar.delete(k);
      }
      return res;
    },
    async me() {
      const me = await (await b.req('/api/auth/me')).json();
      b.csrf = me.csrfToken;
      return me;
    },
    /** Runs the whole flow with `code` as the provider's answer; returns the final redirect target. */
    async signIn(provider, code, challenges, { tamper } = {}) {
      const start = await b.req(`/api/auth/oauth/${provider}`);
      assert.equal(start.status, 303);
      const auth = new URL(start.headers.get('location'));
      challenges.add(auth.searchParams.get('code_challenge'));
      const state = tamper ? 'forged-state' : auth.searchParams.get('state');
      const back = await b.req(`/api/auth/oauth/${provider}/callback?code=${code}&state=${state}`);
      assert.equal(back.status, 303);
      return new URL(back.headers.get('location'), base);
    },
  };
  return b;
}

const ACCOUNTS = {
  anna: { sub: '1001', email: 'anna@example.org', verified: true, name: 'Anna Muster' },
  unverified: { sub: '1002', email: 'zora@example.org', verified: false, name: 'Zora' },
  bert: { sub: '1003', email: 'bert@example.org', verified: true, name: 'bert' },
  hub: { sub: '42', email: 'anna@example.org', verified: true, name: 'anna-gh' },
};

test('providers are listed and the authorize URL carries state and PKCE', async () => {
  await withServer(ACCOUNTS, async (base) => {
    const b = browser(base);
    const me = await b.me();
    assert.deepEqual(me.providers, [{ id: 'google', label: 'Google' }, { id: 'github', label: 'GitHub' }]);

    const res = await b.req('/api/auth/oauth/google');
    const url = new URL(res.headers.get('location'));
    assert.equal(url.host, 'accounts.google.com');
    assert.equal(url.searchParams.get('client_id'), 'gid');
    assert.equal(url.searchParams.get('redirect_uri'), `${base}/api/auth/oauth/google/callback`);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(url.searchParams.get('state').length >= 32);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('mf_oauth='));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Path=\/api\/auth\/oauth\//);

    assert.equal((await b.req('/api/auth/oauth/facebook')).status, 404);
  });
});

test('signing in with Google creates a verified account without password, then logs in again', async () => {
  await withServer(ACCOUNTS, async (base, challenges) => {
    const b = browser(base);
    const first = await b.signIn('google', 'anna', challenges);
    assert.equal(first.pathname, '/');
    assert.equal(first.searchParams.get('auth'), 'created');
    const me = await b.me();
    assert.equal(me.user.email, 'anna@example.org');
    assert.equal(me.user.name, 'Anna Muster');
    assert.equal(me.user.role, 'admin'); // the first account
    assert.equal(me.user.emailVerified, true);
    assert.equal(me.user.hasPassword, false);
    assert.deepEqual(me.user.identities, ['google']);

    // No password: the e-mail/password login does not open this account.
    const pw = await browser(base).req('/api/auth/login', { method: 'POST', json: { login: 'anna@example.org', password: '' } });
    assert.equal(pw.status, 401);

    // The only login cannot be removed.
    assert.equal((await b.req('/api/auth/identities/google', { method: 'DELETE' })).status, 400);

    const again = browser(base);
    assert.equal((await again.signIn('google', 'anna', challenges)).searchParams.get('auth'), 'ok');
    assert.equal((await again.me()).user.id, me.user.id);
  });
});

test('a forged state, an unverified address or a taken address is refused', async () => {
  await withServer(ACCOUNTS, async (base, challenges, mails) => {
    const forged = await browser(base).signIn('google', 'anna', challenges, { tamper: true });
    assert.match(forged.searchParams.get('auth_error'), /abgelaufen/);

    const unverified = await browser(base).signIn('github', 'unverified', challenges);
    assert.match(unverified.searchParams.get('auth_error'), /bestätigte E-Mail/);

    // A password account with the same address is not taken over automatically.
    const local = browser(base);
    const reg = await local.req('/api/auth/register', {
      method: 'POST', json: { email: 'anna@example.org', name: 'Anna', password: 'geheim-1234' },
    });
    assert.equal(reg.status, 201);
    const taken = await browser(base).signIn('google', 'anna', challenges);
    assert.match(taken.searchParams.get('auth_error'), /schon ein Konto/);

    // Once the account has confirmed the address by link, Google signs into it.
    const token = mails.at(-1).text.match(/token=(\S+)/)[1];
    await fetch(`${base}/api/auth/verify?token=${token}`, { redirect: 'manual' });
    const linked = browser(base);
    assert.equal((await linked.signIn('google', 'anna', challenges)).searchParams.get('auth'), 'linked');
    assert.equal((await linked.me()).user.name, 'Anna');
  });
});

test('a logged-in account links and unlinks providers', async () => {
  await withServer(ACCOUNTS, async (base, challenges) => {
    const b = browser(base);
    await b.req('/api/auth/register', { method: 'POST', json: { email: 'anna@example.org', name: 'Anna', password: 'geheim-1234' } });
    let me = await b.me();
    assert.equal(me.user.emailVerified, false);

    const linked = await b.signIn('github', 'hub', challenges);
    assert.equal(linked.searchParams.get('auth'), 'linked');
    assert.equal(linked.searchParams.get('provider'), 'github');
    me = await b.me();
    assert.deepEqual(me.user.identities, ['github']);
    assert.equal(me.user.emailVerified, true); // GitHub confirmed the same address

    // GitHub now logs into this account from another browser.
    const other = browser(base);
    assert.equal((await other.signIn('github', 'hub', challenges)).searchParams.get('auth'), 'ok');
    assert.equal((await other.me()).user.name, 'Anna');

    // Somebody else's Google account cannot be linked to a second account.
    const bert = browser(base);
    await bert.signIn('google', 'bert', challenges);
    const steal = await b.signIn('google', 'bert', challenges);
    assert.match(steal.searchParams.get('auth_error'), /anderen Konto/);

    // With a password, the provider can be removed.
    const del = await b.req('/api/auth/identities/github', { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.deepEqual((await del.json()).user.identities, []);
    // The address is confirmed now, so signing in with GitHub links it again.
    const after = browser(base);
    assert.equal((await after.signIn('github', 'hub', challenges)).searchParams.get('auth'), 'linked');
    assert.equal((await after.me()).user.name, 'Anna');
  });
});

/**
 * A fake OpenID Connect provider at `issuer`: discovery, a token endpoint that
 * only takes HTTP Basic client authentication, and userinfo.
 */
function fakeOidc(issuer, { reportedIssuer = issuer } = {}) {
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const host = new URL(issuer).origin;
  return (accounts, challenges) => async (url, init = {}) => {
    const u = new URL(url);
    if (u.href === `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`) {
      return json({
        issuer: reportedIssuer,
        authorization_endpoint: `${host}/idp/authorize`,
        token_endpoint: `${host}/idp/token`,
        userinfo_endpoint: `${host}/idp/userinfo`,
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
      });
    }
    if (u.pathname === '/idp/token') {
      const body = new URLSearchParams(init.body);
      const basic = String(init.headers?.Authorization || '');
      if (!basic.startsWith('Basic ') || body.has('client_secret')) return json({ error: 'invalid_client' }, 401);
      const challenge = crypto.createHash('sha256').update(body.get('code_verifier') || '').digest('base64url');
      if (!accounts[body.get('code')] || !challenges.has(challenge)) return json({ error: 'invalid_grant' }, 400);
      return json({ access_token: `at-${body.get('code')}`, token_type: 'Bearer' });
    }
    if (u.pathname === '/idp/userinfo') {
      const a = accounts[String(init.headers?.Authorization || '').replace('Bearer at-', '')];
      if (!a) return json({}, 401);
      return json({ sub: a.sub, email: a.email, email_verified: a.verified, given_name: a.given, family_name: a.family });
    }
    return json({}, 404);
  };
}

const EDU = {
  lea: { sub: 'pairwise-lea', email: 'lea.muster@uzh.ch', verified: true, given: 'Lea', family: 'Muster' },
  raw: { sub: 'pairwise-raw', email: 'raw@example.org', verified: false, given: 'Raw', family: 'Ohne' },
};

test('SWITCH edu-ID: endpoints from discovery, HTTP Basic at the token endpoint, verified address', async () => {
  const eduid = { eduid: { clientId: 'eid', clientSecret: 'esecret' } };
  await withServer(EDU, async (base, challenges) => {
    const b = browser(base);
    assert.ok((await b.me()).providers.some((p) => p.id === 'eduid' && p.label === 'SWITCH edu-ID'));
    const start = await b.req('/api/auth/oauth/eduid');
    const auth = new URL(start.headers.get('location'));
    assert.equal(auth.origin + auth.pathname, 'https://login.eduid.ch/idp/authorize');
    assert.equal(auth.searchParams.get('scope'), 'openid email profile');

    const signIn = await b.signIn('eduid', 'lea', challenges);
    assert.equal(signIn.searchParams.get('auth'), 'created');
    const me = await b.me();
    assert.equal(me.user.name, 'Lea Muster');
    assert.equal(me.user.email, 'lea.muster@uzh.ch');
    assert.deepEqual(me.user.identities, ['eduid']);

    // Without email_verified: no new account.
    const raw = await browser(base).signIn('eduid', 'raw', challenges);
    assert.match(raw.searchParams.get('auth_error'), /bestätigte E-Mail/);
  }, { providers: eduid, fetch: fakeOidc('https://login.eduid.ch/') });
});

test('generic OpenID Connect provider from issuer and label; a wrong issuer is refused', async () => {
  const providers = { oidc: { clientId: 'oid', clientSecret: 'osecret', issuer: 'https://login.example.org/realms/wald', label: 'Forstamt' } };
  await withServer(EDU, async (base, challenges) => {
    const b = browser(base);
    assert.ok((await b.me()).providers.some((p) => p.id === 'oidc' && p.label === 'Forstamt'));
    assert.equal((await b.signIn('oidc', 'lea', challenges)).searchParams.get('auth'), 'created');
  }, { providers, fetch: fakeOidc('https://login.example.org/realms/wald') });

  await withServer(EDU, async (base) => {
    const start = await browser(base).req('/api/auth/oauth/oidc');
    assert.equal(start.status, 303);
    assert.match(new URL(start.headers.get('location'), base).searchParams.get('auth_error'), /anderen Aussteller/);
  }, { providers, fetch: fakeOidc('https://login.example.org/realms/wald', { reportedIssuer: 'https://evil.example/' }) });
});
