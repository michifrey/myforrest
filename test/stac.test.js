'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFile } = require('node:child_process');
const { createApp } = require('../src/app');
const { geoParquet } = require('../src/parquet');

const noWeather = async () => new Response('offline', { status: 503 });

/** Rows of a GeoParquet buffer (hyparquet, GZIP via zlib; geometries as GeoJSON) and its `geo` metadata. */
async function readParquet(buf) {
  const { parquetReadObjects, parquetMetadata } = await import('hyparquet');
  const file = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const meta = parquetMetadata(file);
  const geo = JSON.parse(meta.key_value_metadata.find((kv) => kv.key === 'geo').value);
  const rows = await parquetReadObjects({ file, compressors: { GZIP: (input) => new Uint8Array(zlib.gunzipSync(input)) } });
  return { rows, geo, meta };
}

/** hyparquet decodes the WKB of GeoParquet files to GeoJSON, by the `geo` metadata. */
const pointOf = (geometry) => geometry.coordinates;

test('GeoParquet: typed nullable columns, WKB points and polygons, geo metadata, both codecs', async () => {
  const layer = {
    geometryType: 'POINT',
    fields: { name: 'TEXT', n: 'INTEGER', x: 'REAL' },
    features: Array.from({ length: 20 }, (_, i) => ({
      geometry: { type: 'Point', coordinates: [8.5 + i / 1000, 47.3] },
      properties: { name: i % 3 ? `Föhre ${i}` : null, n: i % 5 ? i : null, x: i / 4 },
    })),
  };
  for (const compression of ['gzip', 'none']) {
    const { rows: sorted, geo, meta } = await readParquet(geoParquet(layer, { compression }));
    assert.equal(sorted.length, 20);
    assert.deepEqual(meta.schema.map((s) => s.name), ['schema', 'name', 'n', 'x', 'geometry', 'bbox', 'xmin', 'ymin', 'xmax', 'ymax']);
    // Rows come sorted by place; here back in the order they were written.
    const rows = [...sorted].sort((a, b) => a.x - b.x);
    assert.equal(rows[0].name, null);
    assert.equal(rows[1].name, 'Föhre 1');
    assert.equal(rows[5].n, null);
    assert.equal(rows[6].n, 6n);
    assert.equal(rows[3].x, 0.75);
    assert.deepEqual(pointOf(rows[2].geometry), [8.502, 47.3]);
    assert.equal(geo.version, '1.1.0');
    assert.equal(geo.primary_column, 'geometry');
    assert.deepEqual(geo.columns.geometry.geometry_types, ['Point']);
    assert.deepEqual(geo.columns.geometry.bbox, [8.5, 47.3, 8.519, 47.3]);
    assert.equal(geo.columns.geometry.crs, undefined, 'WGS84 is the GeoParquet default (OGC:CRS84)');
  }

  const lv95 = await readParquet(geoParquet({ ...layer, features: layer.features.slice(0, 1) }, { srsId: 2056 }));
  assert.equal(lv95.geo.columns.geometry.crs.id.code, 2056);

  const empty = await readParquet(geoParquet({ ...layer, features: [] }));
  assert.equal(empty.rows.length, 0);
  assert.equal(empty.geo.columns.geometry.bbox, undefined);

  const poly = await readParquet(geoParquet({
    geometryType: 'MULTIPOLYGON',
    fields: { year: 'INTEGER' },
    features: [{ geometry: { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] }, properties: { year: 2024 } }],
  }));
  assert.deepEqual(poly.geo.columns.geometry.geometry_types, ['MultiPolygon']);
  assert.deepEqual(poly.rows[0].geometry, { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] });
});

test('GeoParquet: rows sorted by place in row groups, a bbox column as covering with min/max per group', async () => {
  // A 10 × 10 grid of points; ten row groups of ten.
  const features = Array.from({ length: 100 }, (_, i) => ({
    geometry: { type: 'Point', coordinates: [8 + (i % 10) / 10, 47 + Math.floor(i / 10) / 10] },
    properties: { n: i },
  }));
  const { rows, geo, meta } = await readParquet(geoParquet({ geometryType: 'POINT', fields: { n: 'INTEGER' }, features }, { rowGroupSize: 10 }));
  assert.equal(rows.length, 100);
  assert.equal(meta.row_groups.length, 10);
  assert.deepEqual(geo.columns.geometry.covering, { bbox: { xmin: ['bbox', 'xmin'], ymin: ['bbox', 'ymin'], xmax: ['bbox', 'xmax'], ymax: ['bbox', 'ymax'] } });
  const p = rows.find((r) => r.n === 37n);
  assert.deepEqual(p.bbox, { xmin: 8.7, ymin: 47.3, xmax: 8.7, ymax: 47.3 });
  // Each row group covers a small part of the grid: on a Hilbert curve ten neighbours span at most 4 × 4 cells.
  for (const g of meta.row_groups) {
    const stat = (k) => g.columns.find((c) => c.meta_data.path_in_schema.join('.') === `bbox.${k}`).meta_data.statistics;
    assert.ok(stat('xmax').max_value - stat('xmin').min_value <= 0.4 + 1e-9, 'compact in x');
    assert.ok(stat('ymax').max_value - stat('ymin').min_value <= 0.4 + 1e-9, 'compact in y');
  }
  // The statistics say which groups a query box needs: the corner 8.0–8.1 / 47.0–47.1 lies in one group only.
  const hits = meta.row_groups.filter((g) => {
    const s = (k) => g.columns.find((c) => c.meta_data.path_in_schema.join('.') === `bbox.${k}`).meta_data.statistics;
    return s('xmin').min_value <= 8.1 && s('xmax').max_value >= 8.0 && s('ymin').min_value <= 47.1 && s('ymax').max_value >= 47.0;
  });
  assert.equal(hits.length, 1);
  assert.throws(() => geoParquet({ geometryType: 'POINT', fields: { bbox: 'TEXT' }, features: [] }), /reserviert/);
});

function seed(db) {
  const now = Date.now();
  const spot = db.prepare('INSERT INTO spots (lat, lon, created_at) VALUES (47.37, 8.54, ?)').run(now).lastInsertRowid;
  for (const date of ['2023-05-01T10:00:00Z', '2025-05-01T10:00:00Z']) {
    db.prepare(`INSERT INTO photos (spot_id, file, taken_at, lat, lon, location_source, created_at)
      VALUES (?, ?, ?, 47.37, 8.54, 'exif', ?)`).run(spot, `p${date.slice(0, 4)}.jpg`, Date.parse(date), now);
  }
}

test('STAC catalog under /stac links collection, items and GeoParquet downloads', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-stac-'));
  const app = createApp({ dataDir, weatherFetch: noWeather, tileOptions: { precompute: false } });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    seed(app.locals.db);
    const catalog = await (await fetch(`${base}/stac`)).json();
    assert.equal(catalog.type, 'Catalog');
    assert.equal(catalog.stac_version, '1.1.0');
    assert.equal(catalog.links.find((l) => l.rel === 'self').href, `${base}/stac/catalog.json`);

    const collectionUrl = catalog.links.find((l) => l.rel === 'child').href;
    assert.equal(collectionUrl, `${base}/stac/myforrest/collection.json`);
    const collection = await (await fetch(collectionUrl)).json();
    assert.equal(collection.license, 'CC-BY-SA-4.0');
    assert.deepEqual(collection.extent.temporal.interval[0], ['2023-05-01T10:00:00.000Z', '2025-05-01T10:00:00.000Z']);
    assert.equal(collection.assets.geopackage.href, `${base}/api/export/myforrest.gpkg`);
    const items = collection.links.filter((l) => l.rel === 'item');
    assert.deepEqual(items.map((l) => l.href.split('/').pop()), ['spots.json', 'photos.json', 'findings.json', 'spread_fronts.json']);

    const item = await (await fetch(items[1].href)).json();
    assert.equal(item.type, 'Feature');
    assert.equal(item.id, 'photos');
    assert.equal(item.properties['table:row_count'], 2);
    assert.ok(item.properties['table:columns'].some((c) => c.name === 'taken_at' && c.type === 'string'));
    assert.equal(item.links.find((l) => l.rel === 'collection').href, collectionUrl);

    const pq = await fetch(item.assets.geoparquet.href);
    assert.equal(pq.status, 200);
    assert.equal(pq.headers.get('content-type'), 'application/vnd.apache.parquet');
    assert.equal(pq.headers.get('access-control-allow-origin'), '*');
    const { rows } = await readParquet(Buffer.from(await pq.arrayBuffer()));
    assert.deepEqual(rows.map((r) => r.taken_at).sort(), ['2023-05-01T10:00:00.000Z', '2025-05-01T10:00:00.000Z']);

    const lv = await readParquet(Buffer.from(await (await fetch(item.assets['geoparquet-lv95'].href)).arrayBuffer()));
    const [e, n] = pointOf(lv.rows[0].geometry);
    assert.ok(e > 2680000 && e < 2690000 && n > 1240000 && n < 1250000, `${e}, ${n}`);
    assert.equal(lv.geo.columns.geometry.crs.id.code, 2056);

    const gj = await (await fetch(item.assets.geojson.href)).json();
    assert.equal(gj.features.length, 2);

    assert.equal((await fetch(`${base}/stac/myforrest/nope/nope.json`)).status, 404);
    assert.equal((await fetch(`${base}/api/export/parquet/nope.parquet`)).status, 404);
    assert.equal((await fetch(`${base}/api/export/parquet/spots.parquet?crs=3857`)).status, 400);
    const landing = await (await fetch(`${base}/ogc`)).json();
    assert.ok(landing.links.some((l) => l.href === `${base}/stac/catalog.json`));
  } finally {
    await app.locals.idle();
    server.close();
    app.locals.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('scripts/export-stac.js writes a self-contained static catalog', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-stac-data-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-stac-out-'));
  try {
    const app = createApp({ dataDir, weatherFetch: noWeather, tileOptions: { precompute: false } });
    seed(app.locals.db);
    await app.locals.idle();
    app.locals.db.close();

    await new Promise((resolve, reject) => {
      execFile(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'scripts', 'export-stac.js'), out, 'https://example.org'],
        { env: { ...process.env, DATA_DIR: dataDir } }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
    });

    // Every link and asset is relative and points to a file of the folder.
    const seen = new Set();
    const walk = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      const doc = JSON.parse(fs.readFileSync(path.join(out, file), 'utf8'));
      for (const l of doc.links) {
        if (/^https?:/.test(l.href)) { assert.equal(l.rel, 'license'); continue; }
        const target = path.join(path.dirname(file), l.href);
        assert.ok(fs.existsSync(path.join(out, target)), `${file}: ${l.href}`);
        if (['child', 'item'].includes(l.rel)) walk(target);
      }
      for (const a of Object.values(doc.assets || {})) {
        assert.ok(!/^https?:/.test(a.href) && fs.existsSync(path.join(out, path.dirname(file), a.href)), `${file}: ${a.href}`);
      }
    };
    walk('catalog.json');
    assert.equal(seen.size, 6);
    const collection = JSON.parse(fs.readFileSync(path.join(out, 'myforrest/collection.json'), 'utf8'));
    assert.deepEqual(Object.keys(collection.assets).sort(), ['geopackage', 'pmtiles']);

    const { rows } = await readParquet(fs.readFileSync(path.join(out, 'myforrest/spots/spots.parquet')));
    assert.equal(rows.length, 1);
    assert.match(rows[0].latest_photo_url, /^https:\/\/example\.org\//);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});
