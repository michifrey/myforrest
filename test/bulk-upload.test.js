'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { parseMeta } = require('../src/photo-meta');
const { listFiles, parseArgs } = require('../scripts/upload-folder');

const fixture = (name) => new Blob([fs.readFileSync(path.join(__dirname, 'fixtures', name))], { type: 'image/jpeg' });
const noWeather = async () => new Response('offline', { status: 503 });

async function withServer(opts, fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-bulk-'));
  const app = createApp({ dataDir, weatherFetch: noWeather, ...opts });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await app.locals.idle();
    server.close();
    app.locals.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

const form = (files, fields = {}, meta = null) => {
  const fd = new FormData();
  for (const [name, fix] of files) fd.append('photos', fixture(fix), name);
  if (meta !== null) fd.append('meta', new Blob([typeof meta === 'string' ? meta : JSON.stringify(meta)], { type: 'application/json' }), 'myforrest.json');
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
};

test('the description (JSON) accepts lists, objects per file and GeoJSON', () => {
  const list = parseMeta(JSON.stringify([
    { file: 'Wald/IMG_1.JPG', latitude: '47.1', lng: 8.2, direction: -90, time: '2025-06-01T10:00:00Z', tags: 'totholz, verjuengung', description: 'Bach' },
    { name: 'b.jpg', lat: 95, lon: 8 },
    { file: 'c.jpg', lat: 47, lon: 8, heading: 'Nord' },
    { file: 'd.jpg', date: 'gestern' },
  ]));
  assert.deepEqual(list.get('img_1.jpg'), {
    lat: 47.1, lon: 8.2, heading: 270, takenAt: Date.parse('2025-06-01T10:00:00Z'), tags: ['totholz', ' verjuengung'], note: 'Bach',
  });
  assert.deepEqual(list.get('b.jpg'), { error: 'ungültige Koordinaten' });
  assert.deepEqual(list.get('c.jpg'), { error: 'ungültige Blickrichtung' });
  assert.deepEqual(list.get('d.jpg'), { error: 'ungültiges Datum' });

  assert.deepEqual(parseMeta('{"photos":[{"file":"a.jpg","lat":1,"lon":2}]}').get('a.jpg'), { lat: 1, lon: 2 });
  assert.deepEqual(parseMeta('﻿{"A.jpg":{"lat":1,"lon":2,"activity":"wandern"}}').get('a.jpg'), { lat: 1, lon: 2, activity: 'wandern' });
  const geo = parseMeta(JSON.stringify({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [8.5, 47.3] }, properties: { file: 'g.jpg', bearing: 45 } }],
  }));
  assert.deepEqual(geo.get('g.jpg'), { lat: 47.3, lon: 8.5, heading: 45 });
  assert.throws(() => parseMeta('{kaputt'), /Beschreibung \(JSON\) nicht lesbar/);
  assert.throws(() => parseMeta('42'), /erwartet eine Liste/);
});

test('an upload with a description places photos without GPS and overrides EXIF', async () => {
  await withServer({}, async (base) => {
    const meta = [
      { file: 'ohne-gps.jpg', lat: 47.2, lon: 8.3, heading: 135, takenAt: '2025-04-02T09:30:00Z', note: 'Lichtung', tags: ['totholz'] },
      { file: 'mit-gps.jpg', lat: 46.9, lon: 7.4 }, // JSON wins over EXIF
      { file: 'falsch.jpg', lat: 'x', lon: 8 },
    ];
    const res = await fetch(`${base}/api/photos`, {
      method: 'POST',
      body: form([['ohne-gps.jpg', 'nogps.jpg'], ['mit-gps.jpg', 'gps.jpg'], ['falsch.jpg', 'heading-090.jpg'], ['frei.jpg', 'gps-alt.jpg']], { tags: 'sturmschaden' }, meta),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    const by = Object.fromEntries(body.created.map((p) => [p.originalName, p]));
    assert.equal(by['ohne-gps.jpg'].locationSource, 'manual');
    assert.deepEqual([by['ohne-gps.jpg'].lat, by['ohne-gps.jpg'].lon, by['ohne-gps.jpg'].heading], [47.2, 8.3, 135]);
    assert.equal(by['ohne-gps.jpg'].takenAt, '2025-04-02T09:30:00.000Z');
    assert.equal(by['ohne-gps.jpg'].note, 'Lichtung');
    assert.deepEqual([...by['ohne-gps.jpg'].tags].sort(), ['sturmschaden', 'totholz']);
    assert.deepEqual([by['mit-gps.jpg'].lat, by['mit-gps.jpg'].lon], [46.9, 7.4]);
    assert.equal(by['mit-gps.jpg'].takenAt, '2024-05-01T08:00:00.000Z'); // time still from EXIF
    assert.equal(by['frei.jpg'].locationSource, 'exif'); // not in the description
    assert.deepEqual(body.skipped, [{ name: 'falsch.jpg', reason: 'Beschreibung: ungültige Koordinaten' }]);

    const bad = await fetch(`${base}/api/photos`, { method: 'POST', body: form([['a.jpg', 'nogps.jpg']], {}, '{nicht json') });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /Beschreibung \(JSON\) nicht lesbar/);

    // As a text field, for scripts without files.
    const fd = form([['text.jpg', 'nogps.jpg']]);
    fd.append('meta', JSON.stringify({ 'text.jpg': { lat: 47.5, lon: 8.7 } }));
    const t = (await (await fetch(`${base}/api/photos`, { method: 'POST', body: fd })).json()).created[0];
    assert.deepEqual([t.lat, t.lon], [47.5, 8.7]);
  });
});

test('API keys: created in the browser, used by scripts without CSRF, deleted', async () => {
  await withServer({ requireLogin: true }, async (base) => {
    let res = await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'anna@example.org', name: 'Anna Wald', password: 'geheim-1234' }),
    });
    const { csrfToken } = await res.json();
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const browser = (url, init = {}) => fetch(`${base}${url}`, {
      ...init, headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json', ...init.headers },
    });

    res = await browser('/api/auth/tokens', { method: 'POST', body: JSON.stringify({ name: 'Laptop' }) });
    assert.equal(res.status, 201);
    const key = await res.json();
    assert.match(key.token, /^mf_[\w-]{20,}$/);
    assert.equal(key.name, 'Laptop');
    let list = (await (await browser('/api/auth/tokens')).json()).tokens;
    assert.deepEqual(list.map((t) => [t.name, t.lastUsedAt]), [['Laptop', null]]);
    assert.equal(list[0].token, undefined);

    const bearer = { Authorization: `Bearer ${key.token}` };
    res = await fetch(`${base}/api/photos`, { method: 'POST', headers: bearer, body: form([['a.jpg', 'gps.jpg']]) });
    assert.equal(res.status, 201);
    const photo = (await res.json()).created[0];
    assert.equal(photo.uploader.name, 'Anna Wald');
    assert.equal((await (await fetch(`${base}/api/auth/me`, { headers: bearer })).json()).user.name, 'Anna Wald');
    res = await fetch(`${base}/api/photos/${photo.id}`, {
      method: 'PATCH', headers: { ...bearer, 'Content-Type': 'application/json' }, body: JSON.stringify({ note: 'per Skript' }),
    });
    assert.equal(res.status, 200);
    list = (await (await browser('/api/auth/tokens')).json()).tokens;
    assert.ok(list[0].lastUsedAt);

    // A key cannot change the account or make more keys.
    res = await fetch(`${base}/api/auth/tokens`, { method: 'POST', headers: { ...bearer, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 403);
    res = await fetch(`${base}/api/auth/password/change`, { method: 'POST', headers: { ...bearer, 'Content-Type': 'application/json' }, body: '{"current":"geheim-1234","password":"neu-geheim-99"}' });
    assert.equal(res.status, 403);

    res = await fetch(`${base}/api/photos`, { method: 'POST', headers: { Authorization: 'Bearer mf_falsch' }, body: form([['b.jpg', 'nogps.jpg']]) });
    assert.equal(res.status, 401);
    assert.match((await res.json()).error, /API-Schlüssel/);

    res = await browser(`/api/auth/tokens/${key.id}`, { method: 'DELETE' });
    assert.equal(res.status, 204);
    res = await fetch(`${base}/api/photos`, { method: 'POST', headers: bearer, body: form([['c.jpg', 'nogps.jpg']]) });
    assert.equal(res.status, 401);
    assert.equal((await browser('/api/auth/tokens/999', { method: 'DELETE' })).status, 404);
  });
});

test('upload-folder: options and the files of a folder in natural order', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-folder-'));
  try {
    for (const f of ['IMG_10.jpg', 'IMG_2.jpg', '.DS_Store', 'Tag 2/b.jpg', 'Tag 2/a.JPG', '.versteckt/x.jpg']) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), '');
    }
    assert.deepEqual(listFiles(dir), ['IMG_2.jpg', 'IMG_10.jpg', 'Tag 2/a.JPG', 'Tag 2/b.jpg']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const o = parseArgs(['fotos', '--server', 'https://x.example/', '--token=mf_1', '--batch', '500', '--protected']);
  assert.deepEqual([o.dir, o.server, o.token, o.batch, o.protected], ['fotos', 'https://x.example', 'mf_1', 200, true]);
  assert.throws(() => parseArgs(['--gibts-nicht']), /Unbekannte Option/);
});
