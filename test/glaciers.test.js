'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { createApp } = require('../src/app');
const { createGlaciers, parseGlaciers, distanceToRing } = require('../src/glaciers');
const { iceSeries, sceneIndices } = require('../src/sentinel');
const { wgs84ToLv95 } = require('../src/lv95');
const { utmFromLatLon } = require('../src/utm');
const { TAGS } = require('../src/tags');
const { LANDSCAPES } = require('../src/landscapes');

// A glacier tongue near 46.60 N, 8.40 E that shrank over three inventories.
const SPOT = { lat: 46.6, lon: 8.4 };
const box = (lat0, lon0, lat1, lon1) => [[lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1], [lon0, lat0]];
const feature = (props, ...rings) => ({ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: rings } });

function writeInventories(dir) {
  // 1850 and 1973 cover the spot (1973 with a rock island elsewhere); 2016 ends ~330 m further north.
  const y1850 = { type: 'FeatureCollection', features: [feature({ name: 'Testgletscher' }, box(46.59, 8.39, 46.63, 8.41))] };
  const y1973 = {
    type: 'FeatureCollection',
    features: [feature({ name: 'Testgletscher', year: 1973 }, box(46.595, 8.395, 46.625, 8.405), box(46.61, 8.398, 46.612, 8.402))],
  };
  // 2016 in LV95 metres, as GLAMOS publishes it.
  const lv = box(46.603, 8.397, 46.62, 8.403).map(([lon, lat]) => wgs84ToLv95(lat, lon));
  const y2016 = {
    type: 'FeatureCollection',
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::2056' } },
    features: [feature({ 'sgi-id': 'B36-26', name: 'Testgletscher', year_acq: '2016-09-01' }, lv)],
  };
  const files = { 'sgi_1850.geojson': y1850, 'inventar.geojson': y1973, 'sgi2016.geojson': y2016 };
  for (const [f, doc] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), JSON.stringify(doc));
  return Object.keys(files).map((f) => path.join(dir, f));
}

test('glacier inventories: years from properties or file names, LV95, holes, where the ice was', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-gl-'));
  try {
    const g = createGlaciers({ files: writeInventories(dir).join(',') });
    assert.deepEqual(g.years(), [1850, 1973, 2016]);
    const info = g.at(SPOT.lat, SPOT.lon);
    assert.equal(info.name, 'Testgletscher');
    assert.equal(info.latestYear, 2016);
    assert.deepEqual(info.history.map((h) => [h.year, h.ice]), [[1850, true], [1973, true], [2016, false]]);
    // ~3 km of latitude per 0.027°: the 2016 tongue ends 0.003° (≈ 334 m) north.
    assert.ok(Math.abs(info.distanceM - 334) < 5, String(info.distanceM));
    assert.ok(g.isGlacierPlace(SPOT.lat, SPOT.lon));
    // The rock island of 1973 was free of ice.
    assert.deepEqual(g.at(46.611, 8.4).history.map((h) => h.ice), [true, false, true]);
    // Far from any glacier: nothing.
    assert.equal(g.at(47.37, 8.54), null);
    assert.equal(g.isGlacierPlace(47.37, 8.54), false);
    // Outlines for the map, per year.
    const fc = g.geojson([8.38, 46.58, 8.42, 46.64], { year: 2016 });
    assert.equal(fc.features.length, 1);
    assert.deepEqual(fc.features[0].properties, { name: 'Testgletscher', year: 2016 });
    assert.ok(Math.abs(fc.features[0].geometry.coordinates[0][0][0][0] - 8.397) < 1e-4);
    assert.equal(g.geojson([8.38, 46.58, 8.42, 46.64]).features.length, 3);
    // No files: everything empty.
    const none = createGlaciers({ files: '' });
    assert.equal(none.enabled(), false);
    assert.equal(none.at(SPOT.lat, SPOT.lon), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('glacier parsing: MultiPolygons, names and the distance to an edge', () => {
  const doc = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: { Gletscher: 'Zwilling', jahr: 2010 }, geometry: { type: 'MultiPolygon', coordinates: [[box(0, 0, 0.01, 0.01)], [box(0, 0.02, 0.01, 0.03)]] } }],
  };
  const [g] = parseGlaciers(JSON.stringify(doc));
  assert.equal(g.name, 'Zwilling');
  assert.equal(g.year, 2010);
  assert.equal(g.polygons.length, 2);
  assert.deepEqual(g.bbox, [0, 0, 0.03, 0.01]);
  // 0.001° of latitude ≈ 111 m.
  assert.ok(Math.abs(distanceToRing(box(0, 0, 0.01, 0.01), 0.011, 0.005) - 111) < 1);
});

test('ice share of late summer: the lowest month of July–October per year, and since when the place is free of ice', () => {
  const scenes = [
    ['2019-02-10', 1], ['2019-08-12', 0.95], ['2019-09-03', 0.9],
    ['2020-08-20', 0.8], ['2020-09-15', 0.85],
    ['2021-08-05', 0.3], ['2021-09-08', 0.1],
    ['2022-08-25', 0], ['2022-12-01', 1],
    ['2023-08-01', 0.05, 'L8'], // Landsat has no share: ignored
  ].map(([date, snow, sensor = 'S2']) => ({ date, snow, sensor }));
  const s = iceSeries(scenes);
  assert.deepEqual(s.summers.map((x) => [x.year, x.ice]), [[2019, 0.9], [2020, 0.8], [2021, 0.1], [2022, 0]]);
  assert.equal(s.iceFreeSince, 2021);
  assert.equal(s.monthly.find((m) => m.month === '2019-02').snow, 1);
  // Always ice, or never: no change to report.
  assert.equal(iceSeries([{ date: '2020-08-01', snow: 1 }, { date: '2021-08-01', snow: 0.9 }]).iceFreeSince, null);
  assert.equal(iceSeries([{ date: '2020-08-01', snow: 0 }, { date: '2021-08-01', snow: 0 }]).iceFreeSince, null);
  assert.deepEqual(iceSeries([]), { monthly: [], summers: [], iceFreeSince: null, meltOut: [] });
  // A glacier keeps its snow all summer: no melt-out in 2019; in 2022 the place is free in August.
  assert.deepEqual(s.meltOut, []);
  const mountain = iceSeries([
    ['2018-01-10', 1], ['2018-04-10', 0.9], ['2018-05-12', 0.8], ['2018-06-10', 0.2],
    ['2025-02-10', 0.95], ['2025-04-11', 0.4], ['2025-05-10', 0.1],
    ['2026-03-01', 0.1], // no winter month: not counted
  ].map(([date, snow]) => ({ date, snow })));
  assert.deepEqual(mountain.meltOut, [{ year: 2018, month: 6 }, { year: 2025, month: 4 }]);
});

test('outside the forest a change keeps no forest class', () => {
  const { unclassified } = require('../src/classify');
  const c = unclassified({
    regions: [{ class: 'windwurf', label: 'Windwurf / liegende Stämme', area: 0.1 }, { class: 'auflichtung', label: 'Auflichtung', area: 0.05 }],
    summary: [{ class: 'windwurf', area: 0.1, tag: 'sturmschaden' }],
  });
  assert.deepEqual(c.regions.map((g) => g.class), ['sonstiges', 'sonstiges']);
  assert.deepEqual(c.summary, [{ class: 'sonstiges', label: 'Veränderung', area: 0.15, tag: null }]);
  assert.deepEqual(unclassified({ regions: [], summary: [] }).summary, []);
});

/* ---------- Snow share from the scene classification ---------- */

async function cog(band, value, lat, lon) {
  const { writeArrayBuffer } = await import('geotiff');
  const { x, y } = utmFromLatLon(lat, lon, 32);
  const res = band === 'SCL' || band === 'B11' ? 20 : 10;
  const n = res === 20 ? 10 : 20;
  const values = band === 'SCL' ? new Uint8Array(n * n).fill(value) : new Uint16Array(n * n).fill(value);
  return Buffer.from(writeArrayBuffer(values, {
    width: n, height: n, ModelPixelScale: [res, res, 0], ModelTiepoint: [0, 0, 0, Math.floor(x / 20) * 20 - 100, Math.ceil(y / 20) * 20 + 100, 0],
    ProjectedCSTypeGeoKey: 32632, GTModelTypeGeoKey: 1, BitsPerSample: [band === 'SCL' ? 8 : 16], SampleFormat: [1],
  }));
}

test('scene values: snow and ice share of the observed classification pixels', async () => {
  for (const [scl, snow, ndvi] of [[11, 1, null], [4, 0, 'number'], [9, null, null]]) {
    const fetchImpl = async (url, opts = {}) => {
      const band = /\/(\w+)\.tif$/.exec(url)[1];
      const buf = await cog(band, { B04: 400, B08: 3000, SCL: scl, B11: 1500 }[band], SPOT.lat, SPOT.lon);
      const r = /bytes=(\d+)-(\d+)/.exec(opts.headers?.Range || '');
      if (!r) return new Response(buf);
      const end = Math.min(Number(r[2]), buf.length - 1);
      return new Response(buf.subarray(Number(r[1]), end + 1), { status: 206, headers: { 'content-range': `bytes ${r[1]}-${end}/${buf.length}` } });
    };
    const band = (b) => ({ href: `https://example.test/s/${b}.tif`, scale: 0.0001, offset: 0 });
    const scene = { epsg: 32632, red: band('B04'), nir: band('B08'), scl: band('SCL'), swir16: band('B11') };
    const v = await sceneIndices(scene, SPOT.lat, SPOT.lon, fetchImpl);
    assert.equal(v.snow, snow, `SCL ${scl}`);
    assert.equal(ndvi === null ? v.ndvi : typeof v.ndvi, ndvi, `SCL ${scl}`);
  }
});

/* ---------- API ---------- */

const offline = async () => new Response('offline', { status: 503 });
let jpeg = null;
const picture = async () => new Blob([jpeg ??= await sharp({ create: { width: 64, height: 48, channels: 3, background: '#dfe8ee' } }).jpeg().toBuffer()], { type: 'image/jpeg' });

async function withServer(opts, fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-gl-'));
  const app = createApp({ dataDir, weatherFetch: offline, routerUrl: '', ...opts(dataDir) });
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

async function upload(base, fields) {
  const fd = new FormData();
  fd.append('photos', await picture(), 'x.jpg');
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  const body = await (await fetch(`${base}/api/photos`, { method: 'POST', body: fd })).json();
  assert.equal(body.created.length, 1, JSON.stringify(body.skipped));
  return body.created[0];
}
const json = async (url, opts) => (await fetch(url, opts)).json();
const put = (url, body) => fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('glacier spots: recognised from the outlines, chosen at upload or by hand; the glacier at a spot', async () => {
  await withServer((dir) => ({ glacierFiles: writeInventories(dir).join(',') }), async (base, app) => {
    const config = await json(`${base}/api/config`);
    assert.deepEqual(config.glaciers, { years: [1850, 1973, 2016] });
    assert.ok(config.landscapes.gletscher.tags.includes('gletschersee'));
    for (const l of Object.values(config.landscapes)) assert.ok(l.tags.every((t) => TAGS[t]), l.label);

    // On the former ice: a glacier spot by itself.
    const a = await upload(base, { lat: SPOT.lat, lon: SPOT.lon, takenAt: '2024-08-20T10:00:00Z', tags: 'gletschersee' });
    let spot = await json(`${base}/api/spots/${a.spotId}`);
    assert.deepEqual([spot.landscape, spot.landscapeSource], ['gletscher', 'auto']);
    assert.deepEqual(a.tags, ['gletschersee']);
    // In town: forest (the default) …
    const b = await upload(base, { lat: 47.37, lon: 8.54, takenAt: '2024-08-20T10:00:00Z' });
    spot = await json(`${base}/api/spots/${b.spotId}`);
    assert.deepEqual([spot.landscape, spot.landscapeSource], ['wald', null]);
    // … unless the uploader says otherwise.
    const c = await upload(base, { lat: 47.40, lon: 8.54, takenAt: '2024-08-20T10:00:00Z', landscape: 'gletscher' });
    spot = await json(`${base}/api/spots/${c.spotId}`);
    assert.deepEqual([spot.landscape, spot.landscapeSource], ['gletscher', 'upload']);
    // A later uploader's choice does not override the first one.
    await upload(base, { spotId: c.spotId, takenAt: '2025-08-20T10:00:00Z', landscape: 'wald' });
    assert.equal((await json(`${base}/api/spots/${c.spotId}`)).landscape, 'gletscher');

    // By hand; null determines it again.
    spot = await (await put(`${base}/api/spots/${a.spotId}/landscape`, { landscape: 'wald' })).json();
    assert.deepEqual([spot.landscape, spot.landscapeSource], ['wald', 'manual']);
    spot = await (await put(`${base}/api/spots/${a.spotId}/landscape`, { landscape: null })).json();
    assert.deepEqual([spot.landscape, spot.landscapeSource], ['gletscher', 'auto']);
    assert.equal((await put(`${base}/api/spots/${a.spotId}/landscape`, { landscape: 'mond' })).status, 400);
    assert.equal((await put(`${base}/api/spots/9999/landscape`, { landscape: 'wald' })).status, 404);

    // The list carries the profile for the map.
    const list = await json(`${base}/api/spots`);
    assert.deepEqual(list.map((s) => s.landscape), ['gletscher', 'wald', 'gletscher']);

    // The glacier at the spot.
    const g = await json(`${base}/api/spots/${a.spotId}/glacier`);
    assert.equal(g.landscape, 'gletscher');
    assert.equal(g.glacier.name, 'Testgletscher');
    assert.deepEqual(g.glacier.history.map((h) => h.ice), [true, true, false]);
    assert.ok(['pending', 'offline', 'ready'].includes(g.satellite.status));
    await app.locals.idle();
    const g2 = await json(`${base}/api/spots/${a.spotId}/glacier`);
    assert.deepEqual(g2.satellite.summers, []);
    assert.equal((await fetch(`${base}/api/spots/9999/glacier`)).status, 404);

    // Outlines for the map.
    const fc = await json(`${base}/api/glaciers?bbox=8.38,46.58,8.42,46.64&year=1973`);
    assert.deepEqual(fc.years, [1850, 1973, 2016]);
    assert.equal(fc.features.length, 1);
    assert.equal((await fetch(`${base}/api/glaciers?bbox=1,2,3`)).status, 400);
  });
});

test('mountain spots: above the tree line without signs of forest', async () => {
  await withServer(() => ({}), async (base) => {
    const patch = (id, body) => fetch(`${base}/api/spots/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const a = await upload(base, { lat: 46.7, lon: 8.6, takenAt: '2024-07-20T10:00:00Z', tags: 'lawine' });
    assert.equal((await (await patch(a.spotId, { elevation: 2400 })).json()).landscape, 'gebirge');
    assert.equal((await json(`${base}/api/spots/${a.spotId}`)).landscapeSource, 'auto');
    // A larch wood at 2200 m stays forest.
    const b = await upload(base, { lat: 46.5, lon: 9.8, takenAt: '2024-07-20T10:00:00Z' });
    await fetch(`${base}/api/spots/${b.spotId}/species`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scientificName: 'Larix decidua' }) });
    assert.equal((await (await patch(b.spotId, { elevation: 2200 })).json()).landscape, 'wald');
    // Low down nothing changes.
    const c = await upload(base, { lat: 47.3, lon: 8.5, takenAt: '2024-07-20T10:00:00Z' });
    assert.equal((await (await patch(c.spotId, { elevation: 600 })).json()).landscape, 'wald');
    const config = await json(`${base}/api/config`);
    assert.ok(config.landscapes.gebirge.tags.includes('lawine'));
    // Drylands only by choice.
    const d = await upload(base, { lat: 30.1, lon: -2.1, takenAt: '2024-07-20T10:00:00Z', landscape: 'trocken', tags: 'wanderduene,sturmschaden' });
    assert.equal((await json(`${base}/api/spots/${d.spotId}`)).landscape, 'trocken');
    assert.deepEqual(d.tags, ['sturmschaden', 'wanderduene']);
  });
});

test('archive photos: dated by hand (not by the scan), placed at the spot', async () => {
  await withServer(() => ({}), async (base) => {
    const a = await upload(base, { lat: SPOT.lat, lon: SPOT.lon, takenAt: '2024-08-20T10:00:00Z' });
    // nogps.jpg carries an EXIF date of 2024: the scan date, which an archive picture ignores.
    const fd = new FormData();
    fd.append('photos', new Blob([fs.readFileSync(path.join(__dirname, 'fixtures', 'nogps.jpg'))], { type: 'image/jpeg' }), 'postkarte.jpg');
    for (const [k, v] of Object.entries({ spotId: a.spotId, archive: '1', takenAt: '1930-08-01T12:00:00Z', refPhotoId: a.id })) fd.append(k, String(v));
    const res = await (await fetch(`${base}/api/photos`, { method: 'POST', body: fd })).json();
    const old = res.created?.[0];
    assert.ok(old, JSON.stringify(res));
    assert.equal(old.takenAt, '1930-08-01T12:00:00.000Z');
    assert.equal(old.archive, true);
    assert.equal(old.spotId, a.spotId);
    const spot = await json(`${base}/api/spots/${a.spotId}`);
    assert.deepEqual(spot.photos.map((p) => p.id), [old.id, a.id]);
    // Without a date or a spot an archive picture is refused.
    const bad = new FormData();
    bad.append('photos', await picture(), 'x.jpg');
    bad.append('archive', '1');
    bad.append('spotId', String(a.spotId));
    assert.equal((await fetch(`${base}/api/photos`, { method: 'POST', body: bad })).status, 400);
  });
});

test('without glacier outlines: no automatic glacier spots, the profile still works', async () => {
  await withServer(() => ({}), async (base) => {
    const config = await json(`${base}/api/config`);
    assert.equal(config.glaciers, null);
    assert.deepEqual(Object.keys(config.landscapes).slice(0, 2), ['wald', 'gletscher']);
    assert.deepEqual(Object.keys(LANDSCAPES), Object.keys(config.landscapes));
    const a = await upload(base, { lat: SPOT.lat, lon: SPOT.lon, takenAt: '2024-08-20T10:00:00Z' });
    assert.equal((await json(`${base}/api/spots/${a.spotId}`)).landscape, 'wald');
    const g = await json(`${base}/api/spots/${a.spotId}/glacier`);
    assert.deepEqual([g.outlines, g.glacier], [false, null]);
  });
});
