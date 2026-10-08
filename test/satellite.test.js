'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { currentAnomalies, indexDrops } = require('../src/sentinel');
const { createLandsat, landsatSceneOf } = require('../src/landsat');
const { utmFromLatLon } = require('../src/utm');

const ym = (y, m) => `${y}-${String(m).padStart(2, '0')}`;

/* ---------- Early warning and NDMI ---------- */

test('current anomalies compare the last months with the same season of earlier years', () => {
  const now = Date.UTC(2026, 6, 15); // mid July 2026
  const healthy = [2023, 2024, 2025].flatMap((y) => [
    { month: ym(y, 1), ndvi: 0.45, ndmi: 0.1 }, // winter: low, normal for the season
    { month: ym(y, 6), ndvi: 0.86, ndmi: 0.38 },
    { month: ym(y, 7), ndvi: 0.87, ndmi: 0.4 },
  ]);
  // Summer 2026: canopy still green, but drying out (NDMI down), then browning (NDVI down).
  const stressed = [...healthy, { month: '2026-06', ndvi: 0.82, ndmi: 0.25 }, { month: '2026-07', ndvi: 0.7, ndmi: 0.2 }];
  const alerts = currentAnomalies(stressed, { now });
  assert.deepEqual(alerts.map((a) => [a.index, a.severity, a.since, a.until]), [['ndvi', 'auffällig', '2026-06', '2026-07'], ['ndmi', 'stark', '2026-06', '2026-07']]);
  const ndmi = alerts[1];
  assert.equal(ndmi.baseline, 0.39);
  assert.equal(ndmi.now, 0.225);
  assert.equal(ndmi.baselineYears, 3);

  // A normal summer raises nothing, and neither does a normal winter.
  assert.deepEqual(currentAnomalies([...healthy, { month: '2026-07', ndvi: 0.86, ndmi: 0.39 }], { now }), []);
  assert.deepEqual(currentAnomalies([...healthy, { month: '2026-01', ndvi: 0.44, ndmi: 0.1 }], { now: Date.UTC(2026, 0, 20) }), []);
  // Old values are no current warning; one earlier year is not a baseline.
  assert.deepEqual(currentAnomalies(stressed, { now: Date.UTC(2026, 11, 1) }), []);
  assert.deepEqual(currentAnomalies([{ month: '2025-07', ndvi: 0.87 }, { month: '2026-07', ndvi: 0.5 }], { now }), []);
});

test('NDMI drops between photos use their own thresholds', () => {
  const monthly = [{ month: '2023-07', ndvi: 0.86, ndmi: 0.4 }, { month: '2024-07', ndvi: 0.84, ndmi: 0.3 }];
  const photos = [{ id: 1, takenAt: '2023-07-10T09:00:00Z' }, { id: 2, takenAt: '2024-07-12T09:00:00Z' }];
  assert.deepEqual(indexDrops(monthly, photos, { key: 'ndvi' }), [], 'NDVI barely moved');
  const [d] = indexDrops(monthly, photos, { key: 'ndmi' });
  assert.deepEqual([d.index, d.drop, d.severity], ['ndmi', 0.1, 'auffällig']);
});

/* ---------- Landsat via Planetary Computer (mocked) ---------- */

const SPOT = { lat: 47.36, lon: 8.58 };

/** A 30 m GeoTIFF around the spot with one value, like a Landsat Collection 2 band. */
async function landsatTiff(value, bits = 16) {
  const { writeArrayBuffer } = await import('geotiff');
  const { x, y } = utmFromLatLon(SPOT.lat, SPOT.lon, 32);
  const n = 10;
  const values = new Uint16Array(n * n).fill(value);
  return Buffer.from(writeArrayBuffer(values, {
    width: n, height: n, ModelPixelScale: [30, 30, 0], ModelTiepoint: [0, 0, 0, Math.floor(x / 30) * 30 - 150, Math.ceil(y / 30) * 30 + 150, 0],
    ProjectedCSTypeGeoKey: 32632, GTModelTypeGeoKey: 1, BitsPerSample: [bits], SampleFormat: [1],
  }));
}

// Reflectance = DN · 2.75e-5 − 0.2. Values per scene: red, nir08, swir16, qa_pixel.
const toDn = (r) => Math.round((r + 0.2) / 0.0000275);
const LANDSAT = {
  LC08_L2SP_195027_20150712_02_T1: [toDn(0.03), toDn(0.35), toDn(0.17), 21824], // clear (bit 6) → NDVI 0.842
  LE07_L2SP_194027_20150720_02_T1: [toDn(0.03), toDn(0.35), toDn(0.17), 22280], // cloud (bit 3) → masked
  LT05_L2SP_195027_20110704_02_T1: [toDn(0.04), toDn(0.36), toDn(0.18), 5440], // Landsat 5, clear
};
const item = (id, date, platform) => ({
  id,
  properties: { datetime: `${date}T10:00:00Z`, platform, 'eo:cloud_cover': 10, 'proj:epsg': 32632 },
  assets: Object.fromEntries(['red', 'nir08', 'swir16', 'qa_pixel'].map((k) => [k, {
    href: `https://landsateuwest.blob.core.windows.net/landsat-c2/${id}/${k}.TIF`,
    ...(k === 'qa_pixel' ? {} : { 'raster:bands': [{ scale: 0.0000275, offset: -0.2 }] }),
  }])),
});

function mockPlanetary(log) {
  return async (url, opts = {}) => {
    const u = String(url);
    log.push({ url: u, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    if (u.endsWith('/api/sas/v1/token/landsat-c2-l2')) return Response.json({ token: 'se=2030&sig=abc', 'msft:expiry': '2030-01-01T00:00:00Z' });
    if (u === 'https://planetarycomputer.microsoft.com/api/stac/v1/search') {
      const [from, to] = JSON.parse(opts.body).datetime.split('/');
      return Response.json({
        type: 'FeatureCollection',
        features: [
          item('LC08_L2SP_195027_20150712_02_T1', '2015-07-12', 'landsat-8'),
          item('LE07_L2SP_194027_20150720_02_T1', '2015-07-20', 'landsat-7'),
          item('LT05_L2SP_195027_20110704_02_T1', '2011-07-04', 'landsat-5'),
        ].filter((f) => f.properties.datetime >= from && f.properties.datetime <= to),
      });
    }
    const m = /landsat-c2\/([^/]+)\/(red|nir08|swir16|qa_pixel)\.TIF\?se=2030&sig=abc$/.exec(u);
    if (m) {
      const [red, nir, swir, qa] = LANDSAT[m[1]];
      const buf = await landsatTiff({ red, nir08: nir, swir16: swir, qa_pixel: qa }[m[2]]);
      const range = /bytes=(\d+)-(\d+)/.exec(opts.headers?.Range || '');
      if (!range) return new Response(buf);
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), buf.length - 1);
      return new Response(buf.subarray(start, end + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${buf.length}` } });
    }
    return new Response('offline', { status: 503 });
  };
}

test('Landsat scenes: Planetary Computer search, signed links, QA_PIXEL cloud mask, 30 m indices', async () => {
  const log = [];
  const ls = createLandsat({ fetchImpl: mockPlanetary(log) });
  const scenes = await ls.scenes(SPOT.lat, SPOT.lon, '2010-01-01', '2016-12-31');
  assert.deepEqual(scenes.map((s) => [s.date, s.sensor]), [['2011-07-04', 'L5'], ['2015-07-12', 'L8'], ['2015-07-20', 'L7']]);
  const search = log.find((r) => r.url.endsWith('/search')).body;
  assert.deepEqual(search.collections, ['landsat-c2-l2']);
  assert.deepEqual(search.query.platform.in, ['landsat-5', 'landsat-7', 'landsat-8']);

  const clear = await ls.indices(scenes[1], SPOT.lat, SPOT.lon);
  assert.equal(clear.ndvi, 0.842);
  assert.equal(clear.ndmi, 0.346);
  const cloudy = await ls.indices(scenes[2], SPOT.lat, SPOT.lon);
  assert.deepEqual([cloudy.ndvi, cloudy.clearFraction], [null, 0]);
  // One token for all reads, every COG link signed.
  assert.equal(log.filter((r) => r.url.includes('/token/')).length, 1);
  assert.ok(log.filter((r) => r.url.includes('.TIF')).every((r) => r.url.endsWith('?se=2030&sig=abc')));
  assert.equal(landsatSceneOf({ id: 'x', properties: {}, assets: {} }), null);
});

/* ---------- Spots: Landsat history, alerts with storms, the daily watcher ---------- */

async function withApp(fetchImpl, fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-sat-'));
  const app = createApp({ dataDir, weatherFetch: fetchImpl, tileOptions: { precompute: false } });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, app, app.locals.db);
  } finally {
    await app.locals.idle();
    server.close();
    app.locals.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

const addSpot = (db, takenAt) => {
  const spot = Number(db.prepare('INSERT INTO spots (lat, lon, created_at) VALUES (?, ?, ?)').run(SPOT.lat, SPOT.lon, Date.now()).lastInsertRowid);
  for (const t of takenAt) {
    db.prepare(`INSERT INTO photos (spot_id, file, taken_at, lat, lon, location_source, created_at)
      VALUES (?, ?, ?, ?, ?, 'exif', ?)`).run(spot, `p${spot}-${t}.jpg`, Date.parse(t), SPOT.lat, SPOT.lon, Date.now());
  }
  return spot;
};

test('photos from before 2017 get Landsat history; Sentinel-2 covers 2017 onwards', async () => {
  const log = [];
  const planetary = mockPlanetary(log);
  const fetchImpl = async (url, opts) => {
    // Earth Search: no Sentinel-2 scenes in this test.
    if (String(url).startsWith('https://earth-search')) return Response.json({ type: 'FeatureCollection', features: [] });
    return planetary(url, opts);
  };
  await withApp(fetchImpl, async (base, app, db) => {
    const spot = addSpot(db, ['2015-07-15T09:00:00Z', '2016-07-10T09:00:00Z']);
    await (await fetch(`${base}/api/spots/${spot}/ndvi`)).json();
    await app.locals.idle();
    const ndvi = await (await fetch(`${base}/api/spots/${spot}/ndvi`)).json();
    assert.equal(ndvi.status, 'ready');
    assert.equal(ndvi.from, '2014-07-15');
    assert.deepEqual(ndvi.monthly.map((m) => [m.month, m.ndvi, m.sensors.join()]), [['2015-07', 0.842, 'L8']]);
    assert.match(ndvi.source, /Landsat/);
    const landsatSearch = log.find((r) => r.url.endsWith('/search')).body;
    // Landsat reaches into the overlap years with Sentinel-2 (harmonisation).
    assert.equal(landsatSearch.datetime, '2014-07-15T00:00:00Z/2018-12-31T23:59:59Z');
  });
});

test('alerts: spots whose last months dropped, with the storm before, and the watcher that refreshes all spots', async () => {
  const offline = async () => new Response('offline', { status: 503 });
  await withApp(offline, async (base, app, db) => {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth() + 1;
    const spot = addSpot(db, [`${y - 3}-${String(m).padStart(2, '0')}-10T09:00:00Z`]);
    // A cached series: healthy in this season for three years, clearly lower this month.
    db.prepare(`INSERT INTO spot_ndvi (spot_id, lat, lon, from_date, to_date, fetched_at, complete) VALUES (?, ?, ?, ?, ?, ?, 1)`)
      .run(spot, SPOT.lat, SPOT.lon, `${y - 4}-01-01`, now.toISOString().slice(0, 10), Date.now());
    const scene = db.prepare(`INSERT INTO spot_ndvi_scenes (spot_id, scene_id, date, cloud, ndvi, ndmi, sensor, v, clear_fraction)
      VALUES (?, ?, ?, 5, ?, ?, 'S2', 2, 1)`);
    for (const yy of [y - 3, y - 2, y - 1]) scene.run(spot, `s${yy}`, `${yy}-${String(m).padStart(2, '0')}-05`, 0.86, 0.38);
    scene.run(spot, 'now', `${y}-${String(m).padStart(2, '0')}-01`, 0.55, 0.12);
    // A storm two weeks before, in the weather cache (as storms.js stores it).
    const stormDay = new Date(Date.UTC(y, m - 1, 1) - 14 * 86400000).toISOString().slice(0, 10);
    const cell = `${SPOT.lat.toFixed(1)},${SPOT.lon.toFixed(1)}`;
    const years = [...new Set([new Date(Date.UTC(y, m - 1, 1) - 92 * 86400000).getUTCFullYear(), Number(stormDay.slice(0, 4)), y])];
    for (const yy of years) {
      db.prepare('INSERT OR REPLACE INTO weather_cache (key, json, fetched_at) VALUES (?, ?, ?)')
        .run(`storm:${cell}:${yy}`, JSON.stringify({ complete: true, days: yy === Number(stormDay.slice(0, 4)) ? [[stormDay, 112, 250, 60]] : [] }), Date.now());
    }

    const alerts = await (await fetch(`${base}/api/satellite/alerts`)).json();
    assert.equal(alerts.length, 1);
    const [a, b] = alerts[0].alerts;
    assert.deepEqual([alerts[0].spotId, a.index, a.severity, b.index, b.severity], [spot, 'ndvi', 'stark', 'ndmi', 'stark']);
    assert.equal(a.visit, true, 'the last photo is three years old');
    assert.equal(a.storm.gust, 112);
    assert.match(a.storm.text, /Böen 112 km\/h aus WSW/);
    // The spot page carries the same alerts.
    const ndvi = await (await fetch(`${base}/api/spots/${spot}/ndvi`)).json();
    assert.deepEqual(ndvi.alerts.map((x) => x.index), ['ndvi', 'ndmi']);

    // The watcher refreshes spots that are due (here: offline, so the status records the error).
    db.prepare('UPDATE spot_ndvi SET fetched_at = NULL WHERE spot_id = ?').run(spot);
    const other = addSpot(db, ['2024-05-01T09:00:00Z']);
    assert.equal(await app.locals.satelliteWatch(), 2);
    const st = db.prepare('SELECT spot_id, error FROM spot_ndvi ORDER BY spot_id').all();
    assert.deepEqual(st.map((r) => r.spot_id), [spot, other]);
    assert.ok(st.every((r) => /HTTP 503/.test(r.error)));
    assert.equal(await app.locals.satelliteWatch(), 0, 'nothing due right after');
  });
});
