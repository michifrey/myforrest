'use strict';

// Closures during forestry work (src/closures.js): from photos tagged "holzschlag" and set by hand; routing goes around them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');

const DAY = 86400000;
const FIXTURE_TIME = Date.parse('2024-05-01T08:30:00Z'); // EXIF time of nogps.jpg

async function withServer(fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-closures-'));
  const asked = [];
  const routerFetch = async (url) => {
    asked.push(new URL(url));
    return new Response(JSON.stringify({ features: [{ geometry: { coordinates: [[8.58, 47.36], [8.59, 47.355], [8.60, 47.36]] } }] }));
  };
  const app = createApp({ dataDir, routerUrl: 'http://brouter/brouter', routerFetch, weatherFetch: async () => new Response('', { status: 503 }) });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`, app, asked);
  } finally {
    await app.locals.idle();
    server.close();
    app.locals.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function client(base) {
  const c = {
    async req(url, { method = 'GET', json, body } = {}) {
      const h = {};
      if (c.cookie) h.Cookie = c.cookie;
      if (c.csrf && method !== 'GET') h['X-CSRF-Token'] = c.csrf;
      if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
      const res = await fetch(`${base}${url}`, { method, headers: h, body });
      const set = res.headers.get('set-cookie');
      if (set) c.cookie = set.split(';')[0];
      return res;
    },
    json: async (url, opts) => (await c.req(url, opts)).json(),
    async register(name) {
      const b = await c.json('/api/auth/register', { method: 'POST', json: { email: `${name}@example.org`, name, password: 'geheim-1234' } });
      c.csrf = b.csrfToken;
      return b.user;
    },
  };
  return c;
}

const photo = (who, { lat, lon, tags = '', daysAgo = 3, protect = false }) => {
  const fd = new FormData();
  fd.append('photos', new Blob([fs.readFileSync(path.join(__dirname, 'fixtures', 'nogps.jpg'))], { type: 'image/jpeg' }), 'foto.jpg');
  fd.append('lat', String(lat)); fd.append('lon', String(lon)); fd.append('tags', tags);
  if (protect) fd.append('protected', '1');
  fd.append('clockShiftSeconds', String((Date.now() - daysAgo * DAY - FIXTURE_TIME) / 1000));
  return who.json('/api/photos', { method: 'POST', body: fd });
};

test('a recent photo tagged "holzschlag" closes 80 m for six weeks; old, protected or untagged ones do not', async () => {
  await withServer(async (base, app, asked) => {
    const admin = client(base);
    await admin.register('Admina');
    const anna = client(base);
    await anna.register('Anna');
    await photo(anna, { lat: 47.3656, lon: 8.59, tags: 'holzschlag', daysAgo: 7 });
    await photo(anna, { lat: 47.3600, lon: 8.59, tags: 'holzschlag', daysAgo: 60 }); // over: six weeks are past
    await photo(anna, { lat: 47.3550, lon: 8.59, tags: 'sturmschaden', daysAgo: 2 });
    await photo(anna, { lat: 47.3500, lon: 8.59, tags: 'holzschlag', daysAgo: 1, protect: true }); // would give the place away
    const { closures } = await anna.json('/api/closures?bbox=8.57,47.34,8.61,47.37');
    assert.equal(closures.length, 1);
    assert.deepEqual([closures[0].lat, closures[0].radiusM, closures[0].auto, closures[0].removable], [47.3656, 80, true, false]);
    assert.match(closures[0].reason, /^Holzschlag \(Foto vom /);
    const until = Date.parse(closures[0].until);
    assert.ok(Math.abs(until - (Date.now() + 35 * DAY)) < 2 * DAY, closures[0].until);

    // Routing: the closure goes to BRouter as a no-go circle.
    const r = await anna.json('/api/route?points=47.36,8.58;47.36,8.60');
    assert.equal(asked.at(-1).searchParams.get('nogos'), '8.590000,47.365600,80');
    assert.equal(r.closures.length, 1);
    // A waypoint inside the closure: not sent, named.
    const inside = await anna.json('/api/route?points=47.3656,8.5901;47.36,8.60');
    assert.equal(asked.at(-1).searchParams.get('nogos'), null);
    assert.equal(inside.insideClosures.length, 1);
  });
});

test('closures by hand: PRO members and moderation, with an end date; the creator or moderation lifts them', async () => {
  await withServer(async (base) => {
    const admin = client(base);
    await admin.register('Admina');
    const forst = client(base);
    const forstUser = await forst.register('Forst');
    const anna = client(base);
    await anna.register('Anna');
    const until = new Date(Date.now() + 20 * DAY).toISOString().slice(0, 10);
    const body = { lat: 47.37, lon: 8.55, until, reason: 'Holzerei Adlisberg' };
    assert.equal((await anna.req('/api/closures', { method: 'POST', json: body })).status, 403, 'members without PRO');
    // Verified forest service.
    await forst.json('/api/auth/pro', { method: 'POST', json: { organization: 'Forstrevier Adlisberg' } });
    await admin.json(`/api/users/${forstUser.id}/pro`, { method: 'POST', json: { decision: 'verifiziert' } });
    assert.equal((await forst.req('/api/closures', { method: 'POST', json: { ...body, until: '2020-01-01' } })).status, 400, 'in the past');
    assert.equal((await forst.req('/api/closures', { method: 'POST', json: { ...body, radiusM: 5000 } })).status, 400, 'too large');
    const res = await forst.req('/api/closures', { method: 'POST', json: body });
    assert.equal(res.status, 201);
    const c = await res.json();
    assert.deepEqual([c.radiusM, c.until, c.reason], [100, until, 'Holzerei Adlisberg']);
    const seen = await anna.json('/api/closures?bbox=8.5,47.3,8.6,47.4');
    assert.equal(seen.closures.length, 1);
    assert.deepEqual([seen.closures[0].removable, seen.mayClose], [false, false]);
    const mine = await forst.json('/api/closures?bbox=8.5,47.3,8.6,47.4');
    assert.deepEqual([mine.closures[0].removable, mine.closures[0].mine, mine.mayClose], [true, true, true]);
    assert.equal((await anna.req(`/api/closures/${c.id}`, { method: 'DELETE' })).status, 403);
    assert.equal((await admin.req(`/api/closures/${c.id}`, { method: 'DELETE' })).status, 204, 'moderation');
    assert.equal((await anna.json('/api/closures?bbox=8.5,47.3,8.6,47.4')).closures.length, 0);
  });
});
