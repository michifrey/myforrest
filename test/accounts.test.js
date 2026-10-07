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
  const app = createApp({ dataDir, weatherFetch: noWeather, ...opts });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, app.locals.db);
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
