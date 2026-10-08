'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { hashPassword, verifyPassword, parseCookies, createLimiter } = require('../src/auth');

const fixture = (name) => new Blob([fs.readFileSync(path.join(__dirname, 'fixtures', name))], { type: 'image/jpeg' });
const noWeather = async () => new Response('offline', { status: 503 });

async function withServer(opts, fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-acc-'));
  const mails = [];
  const mailer = { send: async (m) => { mails.push(m); return { sent: true }; } };
  const app = createApp({ dataDir, weatherFetch: noWeather, mailer, ...opts });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, app.locals.db, mails);
  } finally {
    await app.locals.idle();
    server.close();
    app.locals.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

/** A tiny browser: keeps the session cookie and sends the CSRF token. */
function client(base) {
  const c = {
    cookie: null,
    csrf: null,
    async req(url, { method = 'GET', json, body, headers = {}, csrf = true } = {}) {
      const h = { ...headers };
      if (c.cookie) h.Cookie = c.cookie;
      if (csrf && c.csrf && method !== 'GET') h['X-CSRF-Token'] = c.csrf;
      if (json !== undefined) {
        h['Content-Type'] = 'application/json';
        body = JSON.stringify(json);
      }
      const res = await fetch(`${base}${url}`, { method, headers: h, body });
      const set = res.headers.get('set-cookie');
      if (set) {
        const [pair] = set.split(';');
        c.cookie = pair.endsWith('=') ? null : pair;
        c.setCookie = set;
      }
      return res;
    },
    async register(email, name, password = 'geheim-1234') {
      const res = await c.req('/api/auth/register', { method: 'POST', json: { email, name, password } });
      const b = await res.json();
      if (res.ok) c.csrf = b.csrfToken;
      return { res, body: b };
    },
    async login(login, password = 'geheim-1234') {
      const res = await c.req('/api/auth/login', { method: 'POST', json: { login, password } });
      const b = await res.json();
      if (res.ok) c.csrf = b.csrfToken;
      return { res, body: b };
    },
    upload(name, fields = {}) {
      const fd = new FormData();
      fd.append('photos', fixture(name), name);
      for (const [k, v] of Object.entries(fields)) fd.append(k, v);
      return c.req('/api/photos', { method: 'POST', body: fd });
    },
  };
  return c;
}

test('passwords are hashed with scrypt and a salt per hash', async () => {
  const a = await hashPassword('correct horse');
  const b = await hashPassword('correct horse');
  assert.match(a, /^scrypt\$16384\$8\$1\$/);
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('correct horse', a), true);
  assert.equal(await verifyPassword('wrong horse', a), false);
  assert.deepEqual(parseCookies('a=1; mf_session=x%3Dy; a=2'), { a: '1', mf_session: 'x=y' });
});

test('rate limiter blocks after the maximum and resets after the window', () => {
  let t = 0;
  const l = createLimiter({ max: 2, windowMs: 1000, now: () => t });
  l.hit('k');
  assert.equal(l.blocked('k'), 0);
  l.hit('k');
  assert.equal(l.blocked('k'), 1);
  t = 1000;
  assert.equal(l.blocked('k'), 0);
});

test('registration, login, session cookie and logout', async () => {
  await withServer({}, async (base, db) => {
    const anna = client(base);
    let me = await (await anna.req('/api/auth/me')).json();
    assert.equal(me.user, null);
    assert.equal(me.requireLogin, false);
    assert.ok(me.licenses.some((l) => l.id === 'cc0-1.0'));

    const { res, body } = await anna.register('anna@example.org', 'Anna Wald');
    assert.equal(res.status, 201);
    assert.equal(body.user.role, 'admin', 'first account becomes admin');
    assert.match(anna.setCookie, /HttpOnly/);
    assert.match(anna.setCookie, /SameSite=Lax/);
    // Only the hash of the token is stored.
    const token = anna.cookie.split('=')[1];
    const stored = db.prepare('SELECT token_hash FROM sessions').all();
    assert.equal(stored.length, 1);
    assert.notEqual(stored[0].token_hash, token);
    assert.match(db.prepare('SELECT password_hash FROM users').get().password_hash, /^scrypt\$/);

    me = await (await anna.req('/api/auth/me')).json();
    assert.equal(me.user.name, 'Anna Wald');
    assert.equal(me.user.email, 'anna@example.org');
    assert.equal(me.csrfToken, anna.csrf);

    const ben = client(base);
    assert.equal((await ben.register('ANNA@example.org', 'Jemand')).res.status, 409);
    assert.equal((await ben.register('ben@example.org', 'anna wald')).res.status, 409);
    assert.equal((await ben.register('kaputt', 'Ben')).res.status, 400);
    assert.equal((await ben.register('ben@example.org', 'Ben Berg', 'kurz')).res.status, 400);
    const r = await ben.register('ben@example.org', 'Ben Berg');
    assert.equal(r.body.user.role, 'user');

    // Login by name or e-mail.
    const again = client(base);
    assert.equal((await again.login('Anna Wald', 'falsch-falsch')).res.status, 401);
    assert.equal((await again.login('nobody@example.org')).res.status, 401);
    const ok = await again.login('anna@EXAMPLE.org');
    assert.equal(ok.res.status, 200);
    assert.equal(ok.body.user.id, body.user.id);

    // Logout ends the session server-side.
    const oldCookie = again.cookie;
    assert.equal((await again.req('/api/auth/logout', { method: 'POST' })).status, 204);
    const stale = await fetch(`${base}/api/auth/me`, { headers: { Cookie: oldCookie } });
    assert.equal((await stale.json()).user, null);

    // Login only accepts JSON (no cross-site form posts).
    const form = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'login=Anna+Wald&password=geheim-1234',
    });
    assert.equal(form.status, 415);
  });
});

test('ADMIN_EMAIL decides who becomes admin', async () => {
  await withServer({ adminEmail: 'chefin@example.org' }, async (base) => {
    assert.equal((await client(base).register('erster@example.org', 'Erster')).body.user.role, 'user');
    assert.equal((await client(base).register('Chefin@example.org', 'Chefin')).body.user.role, 'admin');
  });
});

test('login attempts are rate limited', async () => {
  await withServer({ rateLimits: { loginPerAccount: 3 } }, async (base) => {
    await client(base).register('anna@example.org', 'Anna Wald');
    const c = client(base);
    for (let i = 0; i < 3; i++) assert.equal((await c.login('Anna Wald', 'falsch-falsch')).res.status, 401);
    const blocked = await c.login('Anna Wald');
    assert.equal(blocked.res.status, 429);
    assert.ok(Number(blocked.res.headers.get('retry-after')) > 0);
  });
});

test('requests with a session need the CSRF token and a same-origin Origin', async () => {
  await withServer({}, async (base) => {
    const anna = client(base);
    await anna.register('anna@example.org', 'Anna Wald');
    const p = (await (await anna.upload('nogps.jpg', { lat: '47.1', lon: '8.1' })).json()).created[0];

    let res = await anna.req(`/api/photos/${p.id}`, { method: 'PATCH', json: { note: 'x' }, csrf: false });
    assert.equal(res.status, 403);
    res = await anna.req(`/api/photos/${p.id}`, { method: 'PATCH', json: { note: 'x' }, headers: { 'X-CSRF-Token': 'falsch' }, csrf: false });
    assert.equal(res.status, 403);
    res = await anna.req(`/api/photos/${p.id}`, { method: 'PATCH', json: { note: 'x' }, headers: { Origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
    res = await anna.req(`/api/photos/${p.id}`, { method: 'PATCH', json: { note: 'x' }, headers: { Origin: base } });
    assert.equal(res.status, 200);
    // An upload without the token is refused, too.
    const fd = new FormData();
    fd.append('photos', fixture('nogps.jpg'), 'x.jpg');
    fd.append('lat', '47.1');
    fd.append('lon', '8.1');
    res = await fetch(`${base}/api/photos`, { method: 'POST', body: fd, headers: { Cookie: anna.cookie } });
    assert.equal(res.status, 403);
  });
});

test('photos record uploader and licence; only the uploader may change them', async () => {
  await withServer({}, async (base, db) => {
    const anna = client(base);
    await anna.register('anna@example.org', 'Anna Wald');
    const ben = client(base);
    await ben.register('ben@example.org', 'Ben Berg');

    // Anonymous: default licence, no uploader.
    const anon = (await (await client(base).upload('nogps.jpg', { lat: '47.1', lon: '8.1' })).json()).created[0];
    assert.equal(anon.uploader, null);
    assert.deepEqual(anon.license, {
      id: 'cc-by-sa-4.0', label: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/deed.de',
    });
    assert.equal(anon.hidden, false);

    let res = await ben.upload('nogps.jpg', { lat: '47.1', lon: '8.1', license: 'gpl' });
    assert.equal(res.status, 400);

    res = await ben.upload('nogps.jpg', { lat: '47.1', lon: '8.1', license: 'cc0-1.0' });
    const mine = (await res.json()).created[0];
    assert.deepEqual(mine.uploader, { id: 2, name: 'Ben Berg' });
    assert.equal(mine.license.id, 'cc0-1.0');
    // The chosen licence becomes Ben's default, e.g. for repeat photos.
    const repeat = (await (await ben.upload('nogps.jpg', { spotId: String(mine.spotId) })).json()).created[0];
    assert.equal(repeat.license.id, 'cc0-1.0');
    const spot = await (await fetch(`${base}/api/spots/${mine.spotId}`)).json();
    assert.equal(spot.photos.find((x) => x.id === mine.id).uploader.name, 'Ben Berg');
    assert.equal(db.prepare('SELECT uploader_id FROM photos WHERE id = ?').get(mine.id).uploader_id, 2);

    // Others may not edit or delete Ben's photo; anonymous photos stay open (prototype default).
    const stranger = client(base);
    await stranger.register('cleo@example.org', 'Cleo');
    assert.equal((await stranger.req(`/api/photos/${mine.id}`, { method: 'PATCH', json: { note: 'nö' } })).status, 403);
    assert.equal((await fetch(`${base}/api/photos/${mine.id}`, { method: 'DELETE' })).status, 401);
    assert.equal((await stranger.req(`/api/photos/${mine.id}`, { method: 'DELETE' })).status, 403);
    assert.equal((await stranger.req(`/api/photos/${anon.id}`, { method: 'PATCH', json: { note: 'ok' } })).status, 200);
    // Nobody but the uploader changes a licence.
    assert.equal((await anna.req(`/api/photos/${mine.id}`, { method: 'PATCH', json: { license: 'cc-by-4.0' } })).status, 403);
    assert.equal((await stranger.req(`/api/photos/${anon.id}`, { method: 'PATCH', json: { license: 'cc0-1.0' } })).status, 403);

    res = await ben.req(`/api/photos/${mine.id}`, { method: 'PATCH', json: { license: 'all-rights-reserved', note: 'meins' } });
    const updated = await res.json();
    assert.equal(updated.license.id, 'all-rights-reserved');
    assert.equal(updated.license.url, null);
    assert.equal(updated.note, 'meins');
    assert.equal((await ben.req(`/api/photos/${mine.id}`, { method: 'PATCH', json: { license: 'xyz' } })).status, 400);

    // The uploader deletes; the admin (moderator) may delete others' photos, which is logged.
    assert.equal((await ben.req(`/api/photos/${repeat.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await anna.req(`/api/photos/${mine.id}`, { method: 'DELETE' })).status, 204);
    const log = await (await anna.req('/api/moderation/log')).json();
    assert.ok(log.some((l) => l.action === 'delete' && l.photoId === mine.id && l.actor === 'Anna Wald' && l.targetUser === 'Ben Berg'));
  });
});

test('reports, moderation queue, hiding and the audit log', async () => {
  await withServer({}, async (base) => {
    const admin = client(base);
    await admin.register('anna@example.org', 'Anna Wald');
    const modr = client(base);
    const { body: m } = await modr.register('mia@example.org', 'Mia Moderiert');
    const user = client(base);
    await user.register('ben@example.org', 'Ben Berg');

    const at = { lat: '47.2', lon: '8.2' };
    const a = (await (await user.upload('nogps.jpg', at)).json()).created[0];
    const b = (await (await client(base).upload('nogps.jpg', at)).json()).created[0];
    assert.equal(a.spotId, b.spotId);

    // Anyone can report, with a known reason.
    assert.equal((await client(base).req(`/api/photos/${b.id}/report`, { method: 'POST', json: { reason: 'nope' } })).status, 400);
    let res = await client(base).req(`/api/photos/${b.id}/report`, { method: 'POST', json: { reason: 'personen', note: 'Gesicht sichtbar' } });
    assert.equal(res.status, 201);
    res = await user.req(`/api/photos/${b.id}/report`, { method: 'POST', json: { reason: 'spam' } });
    assert.equal(res.status, 201);
    assert.equal((await user.req(`/api/photos/${b.id}/report`, { method: 'POST', json: { reason: 'spam' } })).status, 200);

    // Only moderators see the queue; the admin promotes Mia.
    assert.equal((await modr.req('/api/moderation/queue')).status, 403);
    assert.equal((await fetch(`${base}/api/moderation/queue`)).status, 401);
    assert.equal((await user.req(`/api/users/${m.user.id}`, { method: 'PATCH', json: { role: 'moderator' } })).status, 403);
    res = await admin.req(`/api/users/${m.user.id}`, { method: 'PATCH', json: { role: 'moderator' } });
    assert.equal((await res.json()).role, 'moderator');
    const users = await (await admin.req('/api/users')).json();
    assert.equal(users.find((u) => u.name === 'Ben Berg').photos, 1);

    let queue = await (await modr.req('/api/moderation/queue')).json();
    assert.equal(queue.reported.length, 1);
    assert.equal(queue.reported[0].photo.id, b.id);
    assert.deepEqual(queue.reported[0].reports.map((r) => r.reason), ['personen', 'spam']);
    assert.equal(queue.reported[0].reports[1].reporter, 'Ben Berg');

    // Hide: gone from all public responses, still visible to moderators.
    res = await modr.req(`/api/moderation/photos/${b.id}/hide`, { method: 'POST', json: { reason: 'Gesicht' } });
    assert.equal((await res.json()).hidden, true);
    let spots = await (await fetch(`${base}/api/spots`)).json();
    assert.equal(spots[0].photoCount, 1);
    assert.equal(spots[0].latestUrl, a.url);
    let spot = await (await fetch(`${base}/api/spots/${a.spotId}`)).json();
    assert.deepEqual(spot.photos.map((p) => p.id), [a.id]);
    assert.equal((await fetch(`${base}${b.url}`)).status, 404);
    assert.equal((await fetch(`${base}/api/photos/${b.id}/context`)).status, 404);
    assert.equal((await fetch(`${base}/api/photos/${a.id}/change?to=${b.id}`)).status, 404);
    assert.equal((await user.req(`/api/photos/${b.id}/report`, { method: 'POST', json: { reason: 'spam' } })).status, 404);

    spot = await (await modr.req(`/api/spots/${a.spotId}`)).json();
    assert.deepEqual(spot.photos.map((p) => [p.id, p.hidden]), [[a.id, false], [b.id, true]]);
    assert.equal(spot.photos[1].hiddenReason, 'Gesicht');
    spots = await (await modr.req('/api/spots')).json();
    assert.equal(spots[0].photoCount, 2);
    assert.equal((await modr.req(b.url)).status, 200);

    queue = await (await modr.req('/api/moderation/queue')).json();
    assert.equal(queue.reported.length, 0, 'hiding resolves the reports');
    assert.deepEqual(queue.hidden.map((p) => p.id), [b.id]);

    // A spot whose photos are all hidden disappears entirely.
    await modr.req(`/api/moderation/photos/${a.id}/hide`, { method: 'POST', json: {} });
    assert.deepEqual(await (await fetch(`${base}/api/spots`)).json(), []);
    assert.equal((await fetch(`${base}/api/spots/${a.spotId}`)).status, 404);
    assert.equal((await modr.req(`/api/spots/${a.spotId}`)).status, 200);
    await modr.req(`/api/moderation/photos/${a.id}/unhide`, { method: 'POST' });

    res = await modr.req(`/api/moderation/photos/${b.id}/unhide`, { method: 'POST' });
    assert.equal((await res.json()).hidden, false);
    spot = await (await fetch(`${base}/api/spots/${a.spotId}`)).json();
    assert.equal(spot.photos.length, 2);

    // Dismissing a report.
    await client(base).req(`/api/photos/${a.id}/report`, { method: 'POST', json: { reason: 'sonstiges' } });
    await modr.req(`/api/moderation/photos/${a.id}/dismiss`, { method: 'POST' });
    assert.equal((await (await modr.req('/api/moderation/queue')).json()).reported.length, 0);

    const log = await (await modr.req('/api/moderation/log')).json();
    assert.deepEqual(log.map((l) => l.action).slice(0, 6), ['dismiss', 'unhide', 'unhide', 'hide', 'hide', 'role']);
    assert.equal(log.find((l) => l.action === 'role' && l.targetUser === 'Mia Moderiert').detail, 'user → moderator');
  });
});

test('requireLogin enforces accounts for uploads and edits', async () => {
  await withServer({ requireLogin: true }, async (base) => {
    const anon = client(base);
    assert.equal((await (await anon.req('/api/auth/me')).json()).requireLogin, true);
    let res = await anon.upload('nogps.jpg', { lat: '47.1', lon: '8.1' });
    assert.equal(res.status, 401);

    const ben = client(base);
    await ben.register('ben@example.org', 'Ben Berg');
    res = await ben.upload('nogps.jpg', { lat: '47.1', lon: '8.1' });
    assert.equal(res.status, 201);
    const p = (await res.json()).created[0];

    assert.equal((await anon.req(`/api/photos/${p.id}`, { method: 'PATCH', json: { note: 'x' } })).status, 401);
    assert.equal((await anon.req(`/api/spots/${p.spotId}`, { method: 'PATCH', json: { elevation: 500 } })).status, 401);
    // Reading and reporting stay open.
    assert.equal((await anon.req(`/api/spots/${p.spotId}`)).status, 200);
    assert.equal((await anon.req(`/api/photos/${p.id}/report`, { method: 'POST', json: { reason: 'spam' } })).status, 201);
    assert.equal((await ben.req(`/api/photos/${p.id}`, { method: 'PATCH', json: { note: 'x' } })).status, 200);
  });
});

test('once accounts exist, only admins may import phenology reference data', async () => {
  await withServer({}, async (base) => {
    const csv = 'source;station_id;station_name;lat;lon;elevation;species;year;doy\ntest;1;X;47;8;500;Fagus sylvatica;2024;280\n';
    const post = (headers = {}) => fetch(`${base}/api/phenoref/import?format=generic`, { method: 'POST', body: csv, headers: { 'Content-Type': 'text/plain', ...headers } });
    assert.equal((await post()).status, 200, 'open without accounts');
    await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@b.ch', name: 'Admin', password: 'geheim1234' }) });
    assert.equal((await post()).status, 403, 'anonymous refused once accounts exist');
  });
});

/** The token from the last confirmation link mailed to `to`. */
const linkFor = (mails, to) => {
  const mail = mails.filter((m) => m.to === to).at(-1);
  const url = mail.text.match(/https?:\/\/\S+/)[0];
  return new URL(url);
};

test('registering mails a confirmation link that verifies the address once', async () => {
  await withServer({}, async (base, db, mails) => {
    const anna = client(base);
    const { body } = await anna.register('anna@example.org', 'Anna Wald');
    assert.equal(body.verification, 'sent');
    assert.equal(body.user.emailVerified, false);
    assert.equal(mails.length, 1);
    assert.match(mails[0].subject, /bestätigen/);
    const link = linkFor(mails, 'anna@example.org');
    assert.equal(link.pathname, '/api/auth/verify');
    // Only the hash of the token is stored.
    assert.notEqual(db.prepare('SELECT token_hash FROM email_tokens').get().token_hash, link.searchParams.get('token'));

    // The link works without a session (another device) and only once.
    const res = await fetch(link, { redirect: 'manual' });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/?auth=verified');
    const me = await (await anna.req('/api/auth/me')).json();
    assert.equal(me.user.emailVerified, true);
    const twice = await fetch(link, { redirect: 'manual' });
    assert.match(new URL(twice.headers.get('location'), base).searchParams.get('auth_error'), /ungültig/);

    // Already confirmed: no new link.
    assert.equal((await anna.req('/api/auth/verify/resend', { method: 'POST' })).status, 400);
    const bogus = await fetch(`${base}/api/auth/verify?token=nope`, { redirect: 'manual' });
    assert.match(bogus.headers.get('location'), /auth_error=/);
  });
});

test('a new link replaces the old one, expired links fail, resending is limited', async () => {
  await withServer({ rateLimits: { verifyPerAccount: 2 } }, async (base, db, mails) => {
    const ben = client(base);
    await ben.register('ben@example.org', 'Ben Berg');
    const first = linkFor(mails, 'ben@example.org');
    assert.equal((await ben.req('/api/auth/verify/resend', { method: 'POST' })).status, 200);
    const second = linkFor(mails, 'ben@example.org');
    assert.notEqual(first.href, second.href);
    const old = await fetch(first, { redirect: 'manual' });
    assert.match(old.headers.get('location'), /auth_error=/);

    db.prepare('UPDATE email_tokens SET expires_at = ?').run(Date.now() - 1);
    const expired = await fetch(second, { redirect: 'manual' });
    assert.match(new URL(expired.headers.get('location'), base).searchParams.get('auth_error'), /abgelaufen/);

    assert.equal((await ben.req('/api/auth/verify/resend', { method: 'POST' })).status, 200);
    assert.equal((await ben.req('/api/auth/verify/resend', { method: 'POST' })).status, 429);
    assert.equal((await client(base).req('/api/auth/verify/resend', { method: 'POST' })).status, 401);
  });
});

test('a failing mail server does not block the registration', async () => {
  const mailer = { send: async () => { throw new Error('SMTP down'); } };
  await withServer({ mailer }, async (base) => {
    const { res, body } = await client(base).register('cleo@example.org', 'Cleo');
    assert.equal(res.status, 201);
    assert.equal(body.verification, 'failed');
  });
});

test('requireVerifiedEmail: writes need a confirmed address', async () => {
  await withServer({ requireVerifiedEmail: true }, async (base, db, mails) => {
    const anon = client(base);
    const me = await (await anon.req('/api/auth/me')).json();
    assert.equal(me.requireVerifiedEmail, true);
    assert.equal(me.requireLogin, true);
    assert.equal((await anon.upload('nogps.jpg', { lat: '47.1', lon: '8.1' })).status, 401);

    const dora = client(base);
    await dora.register('dora@example.org', 'Dora');
    let res = await dora.upload('nogps.jpg', { lat: '47.1', lon: '8.1' });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /bestätigen/);
    // Account routes stay usable.
    assert.equal((await dora.req('/api/auth/verify/resend', { method: 'POST' })).status, 200);

    await fetch(linkFor(mails, 'dora@example.org'), { redirect: 'manual' });
    res = await dora.upload('nogps.jpg', { lat: '47.1', lon: '8.1' });
    assert.equal(res.status, 201);
  });
});

/** The token from the last reset link mailed to `to` (`/#reset=<token>`). */
const resetTokenFor = (mails, to) => mails.filter((m) => m.to === to && /Passwort/.test(m.subject)).at(-1)?.text.match(/#reset=([\w-]+)/)[1];

test('a forgotten password is reset with a one-time link that ends all sessions', async () => {
  await withServer({}, async (base, db, mails) => {
    const anna = client(base);
    await anna.register('anna@example.org', 'Anna Wald');
    const laptop = client(base);
    await laptop.login('anna@example.org');

    const anon = client(base);
    const forgot = (email) => anon.req('/api/auth/password/forgot', { method: 'POST', json: { email } });
    // Same answer whether or not an account exists.
    const unknown = await forgot('niemand@example.org');
    assert.equal(unknown.status, 200);
    assert.deepEqual(await unknown.json(), { ok: true });
    assert.equal(mails.filter((m) => /Passwort/.test(m.subject)).length, 0);
    const known = await forgot('ANNA@example.org');
    assert.deepEqual(await known.json(), { ok: true });
    const token = resetTokenFor(mails, 'anna@example.org');
    assert.ok(token);
    assert.match(mails.at(-1).text, new RegExp(`^${base}/#reset=`, 'm'));

    // The page checks the link before showing the form.
    const check = await anon.req(`/api/auth/password/reset?token=${token}`);
    assert.deepEqual(await check.json(), { name: 'Anna Wald', email: 'anna@example.org' });
    assert.equal((await anon.req('/api/auth/password/reset?token=falsch')).status, 400);

    const reset = (t, password) => anon.req('/api/auth/password/reset', { method: 'POST', json: { token: t, password } });
    assert.equal((await reset(token, 'kurz')).status, 400);
    const ok = await reset(token, 'neues-passwort-1');
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.user.email, 'anna@example.org');
    assert.equal(body.user.emailVerified, true, 'the link proves control of the address');
    assert.ok(anon.cookie, 'logged in with the new password');
    anon.csrf = body.csrfToken;

    // Used up; old sessions and the old password are gone.
    assert.equal((await reset(token, 'noch-ein-passwort')).status, 400);
    assert.equal((await (await laptop.req('/api/auth/me')).json()).user, null);
    assert.equal((await (await anna.req('/api/auth/me')).json()).user, null);
    assert.equal((await client(base).login('anna@example.org')).res.status, 401);
    assert.equal((await client(base).login('anna@example.org', 'neues-passwort-1')).res.status, 200);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM email_tokens WHERE purpose = 'reset'").get().n, 0);
  });
});

test('reset links expire, a newer one replaces the older, and requests are limited', async () => {
  await withServer({ rateLimits: { forgotPerAddress: 2 } }, async (base, db, mails) => {
    await client(base).register('ben@example.org', 'Ben Berg');
    const anon = client(base);
    const forgot = () => anon.req('/api/auth/password/forgot', { method: 'POST', json: { email: 'ben@example.org' } });
    await forgot();
    const first = resetTokenFor(mails, 'ben@example.org');
    await forgot();
    const second = resetTokenFor(mails, 'ben@example.org');
    assert.notEqual(first, second);
    const reset = (t) => anon.req('/api/auth/password/reset', { method: 'POST', json: { token: t, password: 'neues-passwort-1' } });
    assert.equal((await reset(first)).status, 400);

    // A third request within the hour answers the same but sends nothing.
    const count = mails.length;
    assert.equal((await forgot()).status, 200);
    assert.equal(mails.length, count);

    // Resetting does not touch the confirmation link and vice versa.
    const verifyToken = linkFor(mails, 'ben@example.org').searchParams.get('token');
    assert.equal((await reset(verifyToken)).status, 400);

    db.prepare("UPDATE email_tokens SET expires_at = ? WHERE purpose = 'reset'").run(Date.now() - 1);
    const expired = await reset(second);
    assert.equal(expired.status, 400);
    assert.match((await expired.json()).error, /abgelaufen/);
  });
});

test('an account from Google can set a password by reset; forgot works with requireLogin', async () => {
  await withServer({ requireLogin: true }, async (base, db, mails) => {
    await client(base).register('cleo@example.org', 'Cleo');
    db.prepare("UPDATE users SET password_hash = '' WHERE email = 'cleo@example.org'").run(); // like an account from a provider
    const anon = client(base);
    assert.equal((await anon.req('/api/auth/password/forgot', { method: 'POST', json: { email: 'cleo@example.org' } })).status, 200);
    const res = await anon.req('/api/auth/password/reset', {
      method: 'POST', json: { token: resetTokenFor(mails, 'cleo@example.org'), password: 'endlich-ein-passwort' },
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).user.hasPassword, true);
    // Cross-site posts are refused like login.
    const cross = await fetch(`${base}/api/auth/password/forgot`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ email: 'cleo@example.org' }),
    });
    assert.equal(cross.status, 403);
  });
});

test('a logged-in account changes its password; other sessions end, a notice is mailed', async () => {
  await withServer({ rateLimits: { loginPerAccount: 3 } }, async (base, db, mails) => {
    const anna = client(base);
    await anna.register('anna@example.org', 'Anna Wald');
    const phone = client(base);
    await phone.login('anna@example.org');
    const change = (c, current, password) => c.req('/api/auth/password/change', { method: 'POST', json: { current, password } });

    assert.equal((await change(client(base), 'geheim-1234', 'neues-passwort-1')).status, 401);
    assert.equal((await change(anna, 'geheim-1234', 'kurz')).status, 400);
    const wrong = await change(anna, 'falsch-falsch', 'neues-passwort-1');
    assert.equal(wrong.status, 403);
    assert.match((await wrong.json()).error, /aktuelle Passwort/);
    // Without the CSRF token the session cannot change it.
    assert.equal((await anna.req('/api/auth/password/change', { method: 'POST', json: { current: 'geheim-1234', password: 'x'.repeat(10) }, csrf: false })).status, 403);

    const ok = await change(anna, 'geheim-1234', 'neues-passwort-1');
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).endedSessions, 1);
    assert.equal((await (await anna.req('/api/auth/me')).json()).user.name, 'Anna Wald', 'this session stays');
    assert.equal((await (await phone.req('/api/auth/me')).json()).user, null, 'the other one ended');
    assert.equal((await client(base).login('anna@example.org')).res.status, 401);
    assert.equal((await client(base).login('anna@example.org', 'neues-passwort-1')).res.status, 200);
    assert.match(mails.at(-1).subject, /Passwort geändert/);
    assert.equal(mails.at(-1).to, 'anna@example.org');

    // Wrong current passwords are limited like logins.
    for (const attempt of ['falsch-1', 'falsch-2', 'falsch-3']) assert.equal((await change(anna, attempt, 'neues-passwort-2')).status, 403);
    assert.equal((await change(anna, 'neues-passwort-1', 'neues-passwort-2')).status, 429);
  });
});

test('an account without password cannot use change, only the e-mail link', async () => {
  await withServer({}, async (base, db) => {
    const cleo = client(base);
    await cleo.register('cleo@example.org', 'Cleo');
    db.prepare("UPDATE users SET password_hash = '' WHERE email = 'cleo@example.org'").run(); // like an account from a provider
    const res = await cleo.req('/api/auth/password/change', { method: 'POST', json: { current: '', password: 'neues-passwort-1' } });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /kein Passwort/);
  });
});
