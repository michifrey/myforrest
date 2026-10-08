'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { isSensitive } = require('../src/sensitive');

const fixture = (name) => new Blob([fs.readFileSync(path.join(__dirname, 'fixtures', name))], { type: 'image/jpeg' });
const noWeather = async () => new Response('offline', { status: 503 });
// Pl@ntNet stand-in: everything is a lady's slipper orchid.
const orchid = async () => new Response(JSON.stringify({
  results: [{ score: 0.71, species: { scientificNameWithoutAuthor: 'Cypripedium calceolus', commonNames: ['Frauenschuh'] } }],
}));

async function withServer(opts, fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-prot-'));
  const app = createApp({ dataDir, weatherFetch: noWeather, routerUrl: '', ...opts });
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

function client(base) {
  const c = {
    cookie: null,
    csrf: null,
    async req(url, { method = 'GET', json, body } = {}) {
      const h = {};
      if (c.cookie) h.Cookie = c.cookie;
      if (c.csrf && method !== 'GET') h['X-CSRF-Token'] = c.csrf;
      if (json !== undefined) {
        h['Content-Type'] = 'application/json';
        body = JSON.stringify(json);
      }
      const res = await fetch(`${base}${url}`, { method, headers: h, body });
      const set = res.headers.get('set-cookie');
      if (set) c.cookie = set.split(';')[0];
      return res;
    },
    async json(url, opts) {
      return (await c.req(url, opts)).json();
    },
    async register(name) {
      const res = await c.req('/api/auth/register', { method: 'POST', json: { email: `${name}@example.org`, name, password: 'geheim-1234' } });
      const b = await res.json();
      c.csrf = b.csrfToken;
      return b.user;
    },
    upload(name, fields = {}) {
      const fd = new FormData();
      fd.append('photos', fixture(name), name);
      for (const [k, v] of Object.entries(fields)) fd.append(k, v);
      return c.json('/api/photos', { method: 'POST', body: fd });
    },
  };
  return c;
}

test('sensitive species list: genera, binomials, authors and extensions', () => {
  assert.equal(isSensitive('Cypripedium calceolus L.'), true);
  assert.equal(isSensitive('Ophrys apifera'), true);
  assert.equal(isSensitive('Lilium martagon'), true);
  assert.equal(isSensitive('Lilium candidum'), false);
  assert.equal(isSensitive('Fagus sylvatica'), false);
  assert.equal(isSensitive(''), false);
});

test('a protected find is invisible to the public, its uploader and verified PRO members see it', async () => {
  await withServer({}, async (base, db) => {
    const admin = client(base);
    await admin.register('admin'); // the first account becomes admin
    const ben = client(base);
    await ben.register('ben');
    const pub = client(base);

    // One public photo and, at another place, a protected one.
    const open = (await ben.upload('gps.jpg')).created[0];
    const up = await ben.upload('nogps.jpg', { lat: '47.40', lon: '8.60', protected: '1', note: 'Frauenschuh' });
    const prot = up.created[0];
    assert.equal(prot.protected, true);
    db.prepare("INSERT INTO identifications (photo_id, scientific_name, common_name, score, neophyte, created_at) VALUES (?, 'Cypripedium calceolus', 'Frauenschuh', 0.8, NULL, 0)").run(prot.id);
    const thumb = db.prepare('SELECT file, thumb_file FROM photos WHERE id = ?').get(prot.id);

    // Public: no spot, no photo, no files, no occurrence, no open data – only a coarse cell.
    assert.deepEqual((await pub.json('/api/spots')).map((s) => s.id), [open.spotId]);
    assert.equal((await pub.req(`/api/spots/${prot.spotId}`)).status, 404);
    assert.equal((await pub.req(`/api/photos/${prot.id}/context`)).status, 404);
    assert.equal((await pub.req(`/uploads/${thumb.file}`)).status, 404);
    assert.equal((await pub.req(`/thumbs/${thumb.thumb_file}`)).status, 404);
    assert.deepEqual(await pub.json('/api/occurrences'), []);
    assert.equal((await pub.json('/ogc/collections/photos/items')).features.length, 1);
    assert.equal((await pub.json('/ogc/collections/findings/items')).features.length, 0);
    const cells = await pub.json('/api/protected/cells');
    assert.equal(cells.length, 1);
    assert.equal(cells[0].spots, 1);
    const [w, s, e, n] = cells[0].bbox;
    assert.ok(w <= 8.60 && e >= 8.60 && s <= 47.40 && n >= 47.40);
    assert.ok(e - w > 0.06 && n - s > 0.04, 'about 5 km, not the exact place');

    // The uploader sees their own find.
    assert.deepEqual((await ben.json('/api/spots')).map((x) => x.id).sort(), [open.spotId, prot.spotId].sort());
    let res = await ben.req(`/uploads/${thumb.file}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');

    // PRO: apply, then verified by the admin.
    const carla = client(base);
    await carla.register('carla');
    assert.equal((await carla.req('/api/auth/pro', { method: 'POST', json: { organization: '' } })).status, 400);
    const applied = await carla.json('/api/auth/pro', { method: 'POST', json: { organization: 'Forstamt Zürich', note: 'Revierförsterin' } });
    assert.equal(applied.proStatus, 'angefragt');
    assert.equal(applied.pro, false);
    assert.equal((await carla.req(`/api/spots/${prot.spotId}`)).status, 404, 'not before verification');
    assert.equal((await ben.req(`/api/users/${applied.id}/pro`, { method: 'POST', json: { decision: 'verifiziert' } })).status, 403);
    const users = await admin.json('/api/users');
    assert.equal(users.find((u) => u.name === 'carla').organization, 'Forstamt Zürich');
    const verified = await admin.json(`/api/users/${applied.id}/pro`, { method: 'POST', json: { decision: 'verifiziert' } });
    assert.equal(verified.pro, true);
    assert.equal(verified.organization, 'Forstamt Zürich');

    const spot = await carla.json(`/api/spots/${prot.spotId}`);
    assert.equal(spot.photos.length, 1);
    assert.deepEqual(await carla.json('/api/protected/cells'), []);
    assert.equal((await carla.json('/api/occurrences')).length, 1);
    assert.equal((await carla.req(`/thumbs/${thumb.thumb_file}`)).status, 200);
    assert.equal((await carla.json('/ogc/collections/findings/items')).features.length, 0, 'open data stays without protected finds');

    // Releasing: not by the public, by PRO members.
    assert.equal((await pub.req(`/api/photos/${open.id}`, { method: 'PATCH', json: { protected: true } })).status, 401);
    await carla.req(`/api/photos/${prot.id}`, { method: 'PATCH', json: { protected: false } });
    assert.equal((await pub.req(`/api/spots/${prot.spotId}`)).status, 200);
    // … and revoking PRO takes the access away again.
    await carla.req(`/api/photos/${prot.id}`, { method: 'PATCH', json: { protected: true } });
    await admin.req(`/api/users/${applied.id}/pro`, { method: 'POST', json: { decision: 'entzogen' } });
    assert.equal((await carla.req(`/api/spots/${prot.spotId}`)).status, 404);
  });
});

test('a spot with public and protected photos shows the public ones only; requests at protected spots stay hidden', async () => {
  await withServer({}, async (base, db) => {
    const admin = client(base);
    await admin.register('admin');
    const ben = client(base);
    await ben.register('ben');
    const pub = client(base);
    const first = (await ben.upload('gps.jpg', { tags: 'totholz' })).created[0];
    const second = (await ben.upload('gps.jpg', { protected: '1', tags: 'neophyt' })).created[0];
    assert.equal(second.spotId, first.spotId);
    const spot = await pub.json(`/api/spots/${first.spotId}`);
    assert.deepEqual(spot.photos.map((p) => p.id), [first.id]);
    const listed = (await pub.json('/api/spots')).find((s) => s.id === first.spotId);
    assert.deepEqual(listed.tags, ['totholz'], 'tags of the protected photo do not leak');
    assert.deepEqual(await pub.json('/api/protected/cells'), [], 'the spot is public anyway');
    assert.equal((await pub.req(`/api/photos/${first.id}/change?to=${second.id}`)).status, 404);

    // A spot with only protected photos: its request is protected too.
    const hiddenSpot = (await ben.upload('nogps.jpg', { lat: '47.41', lon: '8.61', protected: '1' })).created[0].spotId;
    assert.equal((await pub.req('/api/photo-requests', { method: 'POST', json: { spotId: hiddenSpot, title: 'x' } })).status, 400);
    const r = await ben.json('/api/photo-requests', { method: 'POST', json: { spotId: hiddenSpot, title: 'Bitte wieder fotografieren' } });
    assert.equal(r.protected, true);
    assert.deepEqual(await pub.json('/api/photo-requests'), []);
    assert.equal((await ben.json('/api/photo-requests')).length, 1);
    const sug = await pub.json('/api/route-suggestions', { method: 'POST', json: { points: [[47.409, 8.61], [47.411, 8.61]] } });
    assert.deepEqual(sug.suggestions, []);
    assert.equal(db.prepare('SELECT protected FROM photo_requests WHERE id = ?').get(r.id).protected, 1);
  });
});

test('recognising a sensitive species protects the find automatically', async () => {
  await withServer({ plantnetKey: 'test', fetchImpl: orchid }, async (base) => {
    const anon = client(base);
    const p = (await anon.upload('gps.jpg')).created[0];
    assert.equal(p.protected, false);
    const after = await anon.json(`/api/photos/${p.id}/identify`, { method: 'POST', json: {} });
    assert.equal(after.protected, true);
    assert.equal(after.protectedReason, 'art');
    assert.deepEqual(await anon.json('/api/spots'), []);
  });
});
