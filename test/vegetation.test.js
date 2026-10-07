'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { createApp } = require('../src/app');
const { analyzeVegetation, measure } = require('../src/vegetation');
const { monthlySeries, ndviDrops, sceneOf } = require('../src/sentinel');
const { utmFromLatLon, latLonFromUtm } = require('../src/utm');

const fixturePath = (name) => path.join(__dirname, 'fixtures', name);
const fixture = (name) => new Blob([fs.readFileSync(fixturePath(name))], { type: 'image/jpeg' });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-veg-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/* ---------- Synthetic forest photos ---------- */

/** W × H image: sky above `skyRows`, foliage below, brown trunks; colours scaled by `exposure`. */
async function scene(name, { skyRows = 0.4, sky = [135, 180, 235], exposure = 1, W = 120, H = 90 } = {}) {
  const buf = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let c;
      if (y < H * skyRows) c = sky;
      else if (x % 30 < 6) c = [92, 64, 44]; // trunk
      else c = [60, 130, 50];
      for (let k = 0; k < 3; k++) buf[(y * W + x) * 3 + k] = Math.min(255, Math.round(c[k] * exposure));
    }
  }
  const file = path.join(tmp, `${name}.png`);
  await sharp(buf, { raw: { width: W, height: H, channels: 3 } }).png().toFile(file);
  return file;
}

test('green fraction, canopy cover and gap fraction of a synthetic forest photo', async () => {
  const m = await analyzeVegetation(await scene('blue'));
  // 60 % of the rows are forest, of which 4/5 foliage (trunks every 30 px, 6 px wide).
  assert.ok(Math.abs(m.greenFraction - 0.6 * 0.8) < 0.02, `green ${m.greenFraction}`);
  assert.ok(Math.abs(m.gapFraction - 0.4) < 0.02, `gap ${m.gapFraction}`);
  // Upper half: 40 of 50 % rows are sky → 20 % covered.
  assert.ok(Math.abs(m.canopyCover - 0.2) < 0.03, `cover ${m.canopyCover}`);
  assert.equal(m.frame, 'photo');
  assert.equal(m.coverage, 1);
});

test('the metrics do not depend on exposure, overcast sky counts as sky', async () => {
  const ref = await analyzeVegetation(await scene('ref'));
  const dark = await analyzeVegetation(await scene('dark', { exposure: 0.45 }));
  const overcast = await analyzeVegetation(await scene('grey', { sky: [236, 236, 240] }));
  for (const m of [dark, overcast]) {
    for (const k of ['greenFraction', 'canopyCover', 'gapFraction']) assert.ok(Math.abs(m[k] - ref[k]) < 0.03, `${k}: ${m[k]} vs ${ref[k]}`);
  }
  const closed = await analyzeVegetation(await scene('closed', { skyRows: 0 }));
  assert.equal(closed.canopyCover, 1);
  assert.equal(closed.gapFraction, 0);
});

test('with an alignment the photo is measured in the spot frame', async () => {
  const file = await scene('shifted');
  // The photo maps onto the right half of the frame (shifted by half its width).
  const m = await analyzeVegetation(file, { h: [1, 0, 0.5, 0, 1, 0, 0, 0, 1], frameAspect: 120 / 90 });
  assert.equal(m.frame, 'spot');
  assert.ok(Math.abs(m.coverage - 0.5) < 0.02, `coverage ${m.coverage}`);
  assert.ok(Math.abs(m.gapFraction - 0.4) < 0.03);
  assert.equal(measure({ rgb: new Uint8Array(3), valid: new Uint8Array(1), width: 1, height: 1 }), null);
});

/* ---------- UTM ---------- */

test('UTM projection matches reference values and inverts', () => {
  const p = utmFromLatLon(45, 9);
  assert.equal(p.zone, 32);
  assert.ok(Math.abs(p.x - 500000) < 0.01 && Math.abs(p.y - 4982950.4) < 0.1);
  const q = utmFromLatLon(47.36, 8.58);
  const back = latLonFromUtm(q.x, q.y, 32);
  assert.ok(Math.abs(back.lat - 47.36) < 1e-7 && Math.abs(back.lon - 8.58) < 1e-7);
});

/* ---------- NDVI series and drops ---------- */

test('monthly NDVI takes the median of clear scenes, cloudy scenes are skipped', () => {
  const monthly = monthlySeries([
    { date: '2023-06-02', ndvi: 0.8 }, { date: '2023-06-20', ndvi: 0.84 }, { date: '2023-06-25', ndvi: 0.5 },
    { date: '2023-07-10', ndvi: null }, { date: '2023-08-01', ndvi: 0.82 },
  ]);
  assert.deepEqual(monthly.map((m) => [m.month, m.ndvi, m.scenes]), [['2023-06', 0.8, 3], ['2023-08', 0.82, 1]]);
});

test('NDVI drops are compared within the same season', () => {
  const monthly = [
    { month: '2022-06', ndvi: 0.85 }, { month: '2022-12', ndvi: 0.45 },
    { month: '2023-06', ndvi: 0.84 }, { month: '2023-12', ndvi: 0.44 },
    { month: '2024-06', ndvi: 0.55 },
  ];
  const photos = [
    { id: 1, takenAt: '2023-06-20T09:00:00Z' },
    { id: 2, takenAt: '2023-12-10T09:00:00Z' }, // winter: low, but normal for the season
    { id: 3, takenAt: '2024-06-18T09:00:00Z' }, // summer after a storm: clearly lower
  ];
  const drops = ndviDrops(monthly, photos);
  assert.equal(drops.length, 1);
  assert.deepEqual([drops[0].fromPhotoId, drops[0].toPhotoId, drops[0].severity], [2, 3, 'stark']);
  assert.equal(drops[0].before, 0.845);
  assert.equal(drops[0].after, 0.55);
});

test('STAC items are read with old and new projection fields', () => {
  const { pages } = JSON.parse(fs.readFileSync(fixturePath('stac-search.json'), 'utf8'));
  const [a, , c] = [...pages[0].features, ...pages[1].features].map(sceneOf);
  assert.equal(a.epsg, 32632);
  assert.equal(c.epsg, 32632);
  assert.deepEqual([a.red.scale, a.red.offset], [0.0001, -0.1]);
  assert.equal(sceneOf({ id: 'x', properties: {}, assets: {} }), null);
});

/* ---------- API with mocked Earth Search ---------- */

const SPOT = { lat: 47.36, lon: 8.58 };
// Digital numbers per scene: [red, nir, scl]. Reflectance = DN · 1e-4 − 0.1.
const SCENES = {
  S2A_32TMT_20230612_0_L2A: [1300, 4500, 4], // dense forest: NDVI 0.84
  S2B_32TMT_20230717_0_L2A: [2000, 2200, 9], // cloud over the spot: masked
  S2A_32TMT_20240616_0_L2A: [1800, 3400, 4], // after windthrow: NDVI 0.5
};

async function geotiffFor(sceneId, band) {
  const { writeArrayBuffer } = await import('geotiff');
  const { x, y } = utmFromLatLon(SPOT.lat, SPOT.lon, 32);
  const res = band === 'SCL' ? 20 : 10;
  const n = band === 'SCL' ? 10 : 20;
  const ox = Math.floor(x / 20) * 20 - 100;
  const oy = Math.ceil(y / 20) * 20 + 100;
  const [red, nir, scl] = SCENES[sceneId];
  const value = { B04: red, B08: nir, SCL: scl }[band];
  const values = band === 'SCL' ? new Uint8Array(n * n).fill(value) : new Uint16Array(n * n).fill(value);
  return Buffer.from(writeArrayBuffer(values, {
    width: n,
    height: n,
    ModelPixelScale: [res, res, 0],
    ModelTiepoint: [0, 0, 0, ox, oy, 0],
    ProjectedCSTypeGeoKey: 32632,
    GTModelTypeGeoKey: 1,
    BitsPerSample: [band === 'SCL' ? 8 : 16],
    SampleFormat: [1],
  }));
}

/** fetch replacement: Earth Search fixtures and range requests on generated COGs; everything else offline. */
function mockEarthSearch(log) {
  const { pages } = JSON.parse(fs.readFileSync(fixturePath('stac-search.json'), 'utf8'));
  return async (url, opts = {}) => {
    const u = String(url);
    log.push({ url: u, range: opts.headers?.Range || opts.headers?.range || null, method: opts.method || 'GET' });
    if (u === 'https://earth-search.aws.element84.com/v1/search' && opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      assert.deepEqual(body.collections, ['sentinel-2-l2a']);
      assert.deepEqual(body.intersects.coordinates, [SPOT.lon, SPOT.lat]);
      return Response.json(pages[0]);
    }
    if (u.endsWith('/search?page=2')) return Response.json(pages[1]);
    const m = /\/([^/]+)\/(B04|B08|SCL)\.tif$/.exec(u);
    if (m) {
      const buf = await geotiffFor(m[1], m[2]);
      const range = /bytes=(\d+)-(\d+)/.exec(opts.headers?.Range || '');
      if (!range) return new Response(buf);
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), buf.length - 1);
      return new Response(buf.subarray(start, end + 1), {
        status: 206,
        headers: { 'content-range': `bytes ${start}-${end}/${buf.length}`, 'content-type': 'image/tiff' },
      });
    }
    return new Response('offline', { status: 503 });
  };
}

async function withApp(weatherFetch, fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-'));
  const app = createApp({ dataDir, weatherFetch });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, app);
  } finally {
    await app.locals.idle();
    server.close();
    app.locals.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

const upload = async (base, name, fields) => {
  const fd = new FormData();
  fd.append('photos', fixture(name), name);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return (await (await fetch(`${base}/api/photos`, { method: 'POST', body: fd })).json()).created[0];
};
const getJson = async (url) => (await fetch(url)).json();

test('vegetation density and the NDVI series of a spot, with the drop backed by the photos', async () => {
  const log = [];
  await withApp(mockEarthSearch(log), async (base, app) => {
    const a = await upload(base, 'canopy-a.jpg', { lat: String(SPOT.lat), lon: String(SPOT.lon), takenAt: '2023-06-20T09:00:00Z' });
    const b = await upload(base, 'canopy-b.jpg', { spotId: String(a.spotId), refPhotoId: String(a.id), takenAt: '2024-06-20T09:00:00Z' });
    assert.ok(b.alignment);
    await app.locals.idle();

    const veg = await getJson(`${base}/api/spots/${a.spotId}/vegetation`);
    assert.equal(veg.pending, 0);
    const [va, vb] = veg.photos;
    assert.deepEqual([va.photoId, vb.photoId], [a.id, b.id]);
    assert.equal(va.frame, 'spot');
    assert.equal(vb.frame, 'spot');
    // Browned crowns and the clearing replace green foliage.
    assert.ok(va.greenFraction > 0.6, `before ${va.greenFraction}`);
    assert.ok(vb.greenFraction < va.greenFraction - 0.15, `after ${vb.greenFraction}`);

    let ndvi = await getJson(`${base}/api/spots/${a.spotId}/ndvi`);
    assert.equal(ndvi.status, 'pending');
    await app.locals.idle();
    ndvi = await getJson(`${base}/api/spots/${a.spotId}/ndvi`);
    assert.equal(ndvi.status, 'ready');
    assert.equal(ndvi.error, null);
    assert.equal(ndvi.resolutionM, 10);
    assert.deepEqual(ndvi.monthly.map((m) => [m.month, m.ndvi]), [['2023-06', 0.842], ['2024-06', 0.5]]);
    assert.equal(ndvi.scenesEvaluated, 3); // the cloudy July scene is cached without value
    assert.equal(ndvi.drops.length, 1);
    const d = ndvi.drops[0];
    assert.deepEqual([d.fromPhotoId, d.toPhotoId, d.severity], [a.id, b.id, 'stark']);
    assert.ok(d.evidence.some((e) => e.kind === 'change' && e.class === 'auflichtung'), JSON.stringify(d.evidence));

    // Only small range requests reach the COGs, never the whole file.
    const tifs = log.filter((r) => r.url.endsWith('.tif'));
    assert.ok(tifs.length >= 9);
    assert.ok(tifs.every((r) => /^bytes=\d+-\d+$/.test(r.range)));

    // Cached: a second look does not search again.
    const searches = log.filter((r) => r.url.includes('/search')).length;
    await getJson(`${base}/api/spots/${a.spotId}/ndvi`);
    await app.locals.idle();
    assert.equal(log.filter((r) => r.url.includes('/search')).length, searches);
  });
});

test('without network the NDVI context degrades gracefully', async () => {
  const offline = async () => { throw new TypeError('fetch failed'); };
  await withApp(offline, async (base, app) => {
    const p = await upload(base, 'gps.jpg', {});
    await app.locals.idle();
    const veg = await getJson(`${base}/api/spots/${p.spotId}/vegetation`);
    assert.equal(typeof veg.photos[0].greenFraction, 'number');
    await getJson(`${base}/api/spots/${p.spotId}/ndvi`);
    await app.locals.idle();
    const ndvi = await getJson(`${base}/api/spots/${p.spotId}/ndvi`);
    assert.equal(ndvi.status, 'offline');
    assert.match(ndvi.error, /fetch failed/);
    assert.deepEqual(ndvi.monthly, []);
    assert.deepEqual(ndvi.drops, []);
    assert.equal((await fetch(`${base}/api/spots/999/ndvi`)).status, 404);
  });
});

test('photos uploaded before the feature are backfilled at startup', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-'));
  const offline = async () => new Response('offline', { status: 503 });
  try {
    let app = createApp({ dataDir, weatherFetch: offline });
    let server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    let base = `http://127.0.0.1:${server.address().port}`;
    const p = await upload(base, 'gps.jpg', {});
    await app.locals.idle();
    // Simulate an old database without vegetation data.
    app.locals.db.exec('DELETE FROM photo_vegetation');
    server.close();
    app.locals.db.close();

    app = createApp({ dataDir, weatherFetch: offline });
    await app.locals.idle();
    const row = app.locals.db.prepare('SELECT json FROM photo_vegetation WHERE photo_id = ?').get(p.id);
    assert.ok(row && JSON.parse(row.json).greenFraction >= 0);
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
    // Deleting the photo removes its metrics.
    assert.equal((await fetch(`${base}/api/photos/${p.id}`, { method: 'DELETE' })).status, 204);
    assert.equal(app.locals.db.prepare('SELECT COUNT(*) AS n FROM photo_vegetation').get().n, 0);
    await app.locals.idle();
    server.close();
    app.locals.db.close();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
