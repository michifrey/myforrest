'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createApp } = require('../src/app');
const { wgs84ToLv95, lv95ToWgs84 } = require('../src/lv95');
const { parseDatetime } = require('../src/routes/ogc');

const noWeather = async () => new Response('offline', { status: 503 });
const LV95 = 'http://www.opengis.net/def/crs/EPSG/0/2056';

async function withServer(fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-ogc-'));
  const app = createApp({ dataDir, weatherFetch: noWeather });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, app.locals.db, dataDir);
  } finally {
    await app.locals.idle();
    server.close();
    app.locals.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

const dLat = (m) => m / 110540;
const dLon = (m) => m / (111320 * Math.cos((47.37 * Math.PI) / 180));

/** Zurich-area photos: a spot with two photos, and a balsam stand spreading over three years. */
function seed(db) {
  const now = Date.now();
  const add = ({ lat, lon, date, tags = [], plant = null, spot = null }) => {
    const spotId = spot ?? db.prepare('INSERT INTO spots (lat, lon, created_at) VALUES (?, ?, ?)').run(lat, lon, now).lastInsertRowid;
    const photo = db.prepare(`INSERT INTO photos (spot_id, file, taken_at, lat, lon, location_source, created_at)
      VALUES (?, ?, ?, ?, ?, 'exif', ?)`).run(spotId, `p${Math.random().toString(36).slice(2)}.jpg`, Date.parse(date), lat, lon, now).lastInsertRowid;
    for (const t of tags) db.prepare('INSERT INTO photo_tags (photo_id, tag) VALUES (?, ?)').run(photo, t);
    if (plant) db.prepare('INSERT INTO identifications (photo_id, scientific_name, common_name, score, neophyte, created_at) VALUES (?, ?, ?, 0.8, ?, ?)').run(photo, ...plant, now);
    return { spotId: Number(spotId), photo: Number(photo) };
  };
  const o = { lat: 47.37, lon: 8.54 };
  const first = add({ ...o, date: '2023-05-01T10:00:00Z', tags: ['sturmschaden'] });
  add({ ...o, date: '2025-05-01T10:00:00Z', spot: first.spotId });
  const balsam = ['Impatiens glandulifera', 'Drüsiges Springkraut', 'Drüsiges Springkraut'];
  add({ lat: o.lat + dLat(500), lon: o.lon, date: '2023-07-01T10:00:00Z', plant: balsam });
  add({ lat: o.lat + dLat(500), lon: o.lon + dLon(40), date: '2024-07-01T10:00:00Z', plant: balsam });
  add({ lat: o.lat + dLat(500), lon: o.lon + dLon(80), date: '2025-07-01T10:00:00Z', plant: balsam });
  return first;
}

test('LV95 conversion matches swisstopo\'s reference point both ways', () => {
  // swisstopo example: 46°2'38.87" N, 8°43'49.79" E ↔ E 2'699'999.76, N 1'099'999.97.
  const [e, n] = wgs84ToLv95(46 + 2 / 60 + 38.87 / 3600, 8 + 43 / 60 + 49.79 / 3600);
  assert.ok(Math.abs(e - 2699999.76) < 0.05 && Math.abs(n - 1099999.97) < 0.05, `${e}, ${n}`);
  const [lat, lon] = lv95ToWgs84(2700000, 1100000);
  assert.ok(Math.abs(lat * 3600 - (46 * 3600 + 2 * 60 + 38.86)) < 0.05 && Math.abs(lon * 3600 - (8 * 3600 + 43 * 60 + 49.80)) < 0.05);
  assert.deepEqual(parseDatetime('2024-07-01'), [Date.parse('2024-07-01T00:00:00Z'), Date.parse('2024-07-01T23:59:59.999Z')]);
  assert.deepEqual(parseDatetime('../2024-01-01T00:00:00Z'), [-Infinity, Date.parse('2024-01-01T00:00:00Z')]);
});

test('OGC API – Features: landing page, conformance, collections, items in WGS84 and LV95', async () => {
  await withServer(async (base, db) => {
    const { spotId } = seed(db);
    const landing = await (await fetch(`${base}/ogc`)).json();
    assert.ok(['service-desc', 'conformance', 'data'].every((rel) => landing.links.some((l) => l.rel === rel)));
    const conf = await (await fetch(`${base}/ogc/conformance`)).json();
    assert.ok(conf.conformsTo.includes('http://www.opengis.net/spec/ogcapi-features-2/1.0/conf/crs'));
    assert.equal((await (await fetch(`${base}/ogc/api`)).json()).openapi, '3.0.3');

    const cols = await (await fetch(`${base}/ogc/collections`)).json();
    assert.deepEqual(cols.collections.map((c) => c.id), ['spots', 'photos', 'findings', 'spread_fronts']);
    const spots = cols.collections[0];
    assert.ok(spots.crs.includes(LV95));
    assert.deepEqual(spots.extent.temporal.interval[0], ['2023-05-01T10:00:00.000Z', '2025-07-01T10:00:00.000Z']);

    let res = await fetch(`${base}/ogc/collections/spots/items`);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.match(res.headers.get('content-type'), /application\/geo\+json/);
    assert.equal(res.headers.get('content-crs'), '<http://www.opengis.net/def/crs/OGC/1.3/CRS84>');
    const fc = await res.json();
    assert.equal(fc.numberMatched, 4);
    const spot = fc.features.find((f) => f.properties.spot_id === spotId);
    assert.deepEqual(spot.geometry.coordinates, [8.54, 47.37]);
    assert.deepEqual([spot.properties.photos, spot.properties.years, spot.properties.tags], [2, 2, 'sturmschaden']);

    res = await fetch(`${base}/ogc/collections/spots/items/spot.${spotId}?crs=${encodeURIComponent(LV95)}`);
    assert.equal(res.headers.get('content-crs'), `<${LV95}>`);
    const lv = await res.json();
    const [e, n] = lv.geometry.coordinates;
    assert.ok(e > 2680000 && e < 2685000 && n > 1246000 && n < 1250000, `Zürich in LV95: ${e}, ${n}`);

    // Filters and paging.
    const page = await (await fetch(`${base}/ogc/collections/photos/items?limit=2`)).json();
    assert.deepEqual([page.numberMatched, page.numberReturned], [5, 2]);
    assert.ok(page.links.some((l) => l.rel === 'next' && l.href.includes('offset=2')));
    const in2024 = await (await fetch(`${base}/ogc/collections/photos/items?datetime=2024-01-01/2024-12-31`)).json();
    assert.equal(in2024.numberMatched, 1);
    const [w, s] = wgs84ToLv95(47.37 + dLat(400), 8.53);
    const [ee, nn] = wgs84ToLv95(47.37 + dLat(600), 8.56);
    const box = await (await fetch(`${base}/ogc/collections/findings/items?bbox=${w},${s},${ee},${nn}&bbox-crs=${encodeURIComponent(LV95)}`)).json();
    assert.equal(box.numberMatched, 3);
    assert.equal(box.features[0].properties.neophyte, 1);

    const fronts = await (await fetch(`${base}/ogc/collections/spread_fronts/items`)).json();
    assert.deepEqual(fronts.features.map((f) => f.properties.year), [2023, 2024, 2025]);
    const ring = fronts.features[2].geometry.coordinates[0][0];
    assert.equal(fronts.features[2].geometry.type, 'MultiPolygon');
    assert.deepEqual(ring[0], ring[ring.length - 1], 'rings are closed');

    // Errors.
    assert.equal((await fetch(`${base}/ogc/collections/wald/items`)).status, 404);
    assert.equal((await fetch(`${base}/ogc/collections/spots/items?crs=EPSG:21781`)).status, 400);
    assert.equal((await fetch(`${base}/ogc/collections/spots/items?bbox=1,2,3`)).status, 400);
    assert.equal((await fetch(`${base}/ogc/collections/spots/items?datetime=gestern`)).status, 400);
    assert.equal((await fetch(`${base}/ogc/collections/spots/items/spot.999`)).status, 404);

    // Hidden photos are not published.
    db.exec(`UPDATE photos SET hidden_at = ${Date.now()} WHERE spot_id = ${spotId}`);
    const after = await (await fetch(`${base}/ogc/collections/spots/items`)).json();
    assert.equal(after.numberMatched, 3);
  });
});

test('GeoPackage export in LV95 with typed tables and valid geometry blobs', async () => {
  await withServer(async (base, db, dataDir) => {
    seed(db);
    const res = await fetch(`${base}/api/export/myforrest.gpkg`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /myforrest-lv95-\d{4}-\d{2}-\d{2}\.gpkg/);
    const file = path.join(dataDir, 'out.gpkg');
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    const g = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(g.prepare('PRAGMA application_id').get().application_id, 1196444487);
      assert.equal(g.prepare('PRAGMA user_version').get().user_version, 10300);
      const contents = g.prepare('SELECT table_name, data_type, srs_id FROM gpkg_contents ORDER BY table_name').all().map((r) => ({ ...r }));
      assert.deepEqual(contents.map((c) => [c.table_name, c.data_type, c.srs_id]),
        [['findings', 'features', 2056], ['photos', 'features', 2056], ['spots', 'features', 2056], ['spread_fronts', 'features', 2056]]);
      assert.ok(g.prepare('SELECT definition FROM gpkg_spatial_ref_sys WHERE srs_id = 2056').get().definition.includes('LV95'));
      assert.deepEqual(g.prepare('SELECT geometry_type_name FROM gpkg_geometry_columns WHERE table_name = ?').get('spread_fronts').geometry_type_name, 'MULTIPOLYGON');
      const row = g.prepare('SELECT geom, photos FROM spots ORDER BY fid LIMIT 1').get();
      const blob = Buffer.from(row.geom);
      assert.equal(blob.toString('ascii', 0, 2), 'GP');
      assert.equal(blob.readInt32LE(4), 2056);
      // Point: no envelope, WKB right after the 8-byte header.
      assert.deepEqual([blob.readUInt8(8), blob.readUInt32LE(9)], [1, 1]);
      const e = blob.readDoubleLE(13);
      assert.ok(e > 2680000 && e < 2685000);
      assert.equal(row.photos, 2);
      const poly = Buffer.from(g.prepare('SELECT geom FROM spread_fronts ORDER BY fid DESC LIMIT 1').get().geom);
      assert.equal(poly.readUInt8(3), 0b011, 'little endian with an xy envelope');
      assert.equal(poly.readUInt32LE(8 + 32 + 1), 6, 'MultiPolygon');
    } finally {
      g.close();
    }
    assert.equal((await fetch(`${base}/api/export/myforrest.gpkg?crs=3857`)).status, 400);
  });
});
