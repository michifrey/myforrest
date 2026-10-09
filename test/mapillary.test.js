'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { createApp } = require('../src/app');
const { normalise } = require('../src/mapillary');

const HERE = { lat: 47.37, lon: 8.54 };
const offline = async () => new Response('offline', { status: 503 });
let jpeg = null;
const picture = async () => (jpeg ??= await sharp({ create: { width: 64, height: 32, channels: 3, background: '#7a9a6a' } }).jpeg().toBuffer());

// Mapillary pictures around HERE: a sequence running north (A1 → A2 → A3), one picture east, one far away.
const m = (id, lat, lon, t, extra = {}) => ({
  id, computed_geometry: { type: 'Point', coordinates: [lon, lat] }, computed_compass_angle: 0,
  captured_at: Date.parse(t), is_pano: true, creator: { username: 'wanderer', id: '9' }, sequence: 'seqA', ...extra,
});
const IMAGES = [
  m('1001', 47.3698, 8.54, '2024-06-01T10:00:00Z'),
  m('1002', 47.3700, 8.54, '2024-06-01T10:00:05Z'),
  m('1003', 47.3702, 8.54, '2024-06-01T10:00:10Z'),
  m('2001', 47.3700, 8.5405, '2023-05-01T10:00:00Z', { sequence: 'seqB', is_pano: false, computed_compass_angle: 270 }),
  m('3001', 47.3800, 8.54, '2023-05-01T10:00:00Z', { sequence: 'seqC' }),
];

function mockMapillary(log) {
  return async (url) => {
    const u = new URL(url);
    log.push(u.pathname + (u.searchParams.has('bbox') ? '?bbox' : ''));
    if (u.hostname === 'graph.mapillary.com') assert.equal(u.searchParams.get('access_token'), 'MLY|test');
    else assert.equal(u.searchParams.get('access_token'), null, 'the token goes to the API only');
    if (u.hostname === 'graph.mapillary.com' && u.pathname === '/images') {
      const [w, s, e, n] = u.searchParams.get('bbox').split(',').map(Number);
      return Response.json({ data: IMAGES.filter((i) => { const [lon, lat] = i.computed_geometry.coordinates; return lon >= w && lon <= e && lat >= s && lat <= n; }) });
    }
    const one = /^\/(\d+)$/.exec(u.pathname);
    if (u.hostname === 'graph.mapillary.com' && one) {
      if (u.searchParams.get('fields') === 'thumb_2048_url') return Response.json({ id: one[1], thumb_2048_url: `https://cdn.example/${one[1]}.jpg` });
      const item = IMAGES.find((i) => i.id === one[1]);
      return item ? Response.json(item) : new Response('{}', { status: 404 });
    }
    if (u.hostname === 'cdn.example') return new Response(await picture(), { headers: { 'content-type': 'image/jpeg' } });
    return new Response('nope', { status: 404 });
  };
}

async function withServer(opts, fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-mly-'));
  const app = createApp({ dataDir, weatherFetch: offline, routerUrl: '', ...opts() });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, dataDir);
  } finally {
    await app.locals.idle();
    server.close();
    app.locals.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function upload(base, fields) {
  const fd = new FormData();
  fd.append('photos', new Blob([await picture()], { type: 'image/jpeg' }), 'x.jpg');
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  const body = await (await fetch(`${base}/api/photos`, { method: 'POST', body: fd })).json();
  return body.created[0];
}
const json = async (url) => (await fetch(url)).json();

test('Mapillary pictures are read with computed position and heading', () => {
  const p = normalise({ id: 5, geometry: { coordinates: [8, 47] }, computed_geometry: { coordinates: [8.1, 47.1] }, compass_angle: -10, captured_at: 0, creator: { username: 'x' }, sequence: { id: 's' } });
  assert.deepEqual([p.id, p.lat, p.lon, p.heading, p.creator, p.sequence, p.panorama], ['5', 47.1, 8.1, 350, 'x', 's', false]);
  assert.equal(normalise({ id: 6 }), null);
});

test('walk-through: Mapillary fills the directions without own pictures, and one walks on along its sequence', async () => {
  const log = [];
  await withServer(() => ({ mapillaryToken: 'MLY|test', mapillaryFetch: mockMapillary(log) }), async (base, dataDir) => {
    assert.equal((await json(`${base}/api/config`)).mapillary, true);
    // An own photo 23 m east of the Mapillary sequence, and an own spot ~30 m north of it.
    const a = await upload(base, { lat: HERE.lat, lon: 8.5403, takenAt: '2025-06-01T10:00:00Z' });
    const north = await upload(base, { lat: 47.37027, lon: 8.5403, takenAt: '2025-06-01T10:00:00Z' });

    const w = await json(`${base}/api/walk/${a.id}`);
    const kinds = w.links.map((l) => [l.kind, l.id]);
    // North: the own spot; the sequence west (south-west, west, north-west) and east are Mapillary's.
    assert.deepEqual(kinds.find(([k]) => k === 'spot'), ['spot', north.id]);
    const mly = w.links.filter((l) => l.kind === 'mapillary');
    assert.deepEqual(mly.map((l) => l.id).sort(), ['m1001', 'm1002', 'm1003', 'm2001']);
    assert.ok(!mly.some((l) => Math.round(l.bearing / 45) % 8 === 0), 'the own spot keeps the north');
    const east = mly.find((l) => l.id === 'm2001');
    assert.ok(Math.abs(east.bearing - 90) < 2);
    assert.equal(east.creator, 'wanderer');
    assert.equal(east.license, 'CC BY-SA 4.0');
    assert.equal(east.pageUrl, 'https://www.mapillary.com/app/?pKey=2001');
    assert.equal(east.url, '/api/mapillary/images/2001/file');

    // Standing on a Mapillary picture: along its sequence, to the own spots, to other Mapillary pictures.
    const mw = await json(`${base}/api/walk/mapillary/1002`);
    assert.equal(mw.photo.id, 'm1002');
    assert.equal(mw.photo.panorama, true);
    const way = Object.fromEntries(mw.links.filter((l) => l.kind === 'weg').map((l) => [l.direction, l.id]));
    assert.deepEqual(way, { zurueck: 'm1001', vor: 'm1003' });
    assert.ok(mw.links.some((l) => l.kind === 'spot' && l.id === a.id));
    // East the own picture leads: the Mapillary picture behind it is left out.
    assert.ok(!mw.links.some((l) => l.id === 'm2001'));
    assert.ok(!mw.links.some((l) => l.id === 'm3001'), 'far away');

    // The map layer and the picture file (downloaded once, then from disk).
    const box = await json(`${base}/api/mapillary/images?bbox=8.539,47.369,8.541,47.371`);
    assert.deepEqual(box.map((x) => x.id).sort(), ['m1001', 'm1002', 'm1003', 'm2001']);
    assert.equal((await fetch(`${base}/api/mapillary/images?bbox=8,47,8.5,47.5`)).status, 400);
    const f1 = await fetch(`${base}/api/mapillary/images/2001/file`);
    assert.equal(f1.status, 200);
    assert.match(f1.headers.get('content-type'), /jpeg/);
    const downloads = log.filter((x) => x === '/2001.jpg').length;
    await (await fetch(`${base}/api/mapillary/images/2001/file`)).arrayBuffer();
    assert.equal(log.filter((x) => x === '/2001.jpg').length, downloads);
    assert.ok(fs.existsSync(path.join(dataDir, 'mapillary', '2001.jpg')));
    // Searches are cached per cell: the walk again asks Mapillary nothing.
    const searches = log.filter((x) => x.endsWith('?bbox')).length;
    await json(`${base}/api/walk/${a.id}`);
    assert.equal(log.filter((x) => x.endsWith('?bbox')).length, searches);

    assert.equal((await fetch(`${base}/api/walk/mapillary/abc`)).status, 400);
    assert.equal((await fetch(`${base}/api/walk/mapillary/999`)).status, 404);
  });
});

test('without a token or without network the walk-through works with own pictures only', async () => {
  await withServer(() => ({}), async (base) => {
    assert.equal((await json(`${base}/api/config`)).mapillary, false);
    const a = await upload(base, { lat: HERE.lat, lon: HERE.lon, takenAt: '2025-06-01T10:00:00Z' });
    assert.deepEqual((await json(`${base}/api/walk/${a.id}`)).links, []);
    assert.equal((await fetch(`${base}/api/walk/mapillary/1002`)).status, 404);
    assert.equal((await fetch(`${base}/api/mapillary/images?bbox=8.539,47.369,8.541,47.371`)).status, 404);
  });
  await withServer(() => ({ mapillaryToken: 'MLY|test', mapillaryFetch: offline }), async (base) => {
    const a = await upload(base, { lat: HERE.lat, lon: HERE.lon, takenAt: '2025-06-01T10:00:00Z' });
    assert.deepEqual((await json(`${base}/api/walk/${a.id}`)).links, []);
    assert.equal((await fetch(`${base}/api/mapillary/images?bbox=8.539,47.369,8.541,47.371`)).status, 502);
  });
});
