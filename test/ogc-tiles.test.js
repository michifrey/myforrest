'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const { createApp } = require('../src/app');
const { zxyToTileId, writePmtiles, writePmtilesFile } = require('../src/pmtiles');
const { gpkgTileGrid } = require('../src/gpkg-tiles');
const lv95 = require('../src/tiles-lv95');
const { tileMatrixSet, tileRange, validTile } = require('../src/tiles');

const noWeather = async () => new Response('offline', { status: 503 });

async function withServer(fn, tileOptions = { delayMs: 0 }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-tiles-'));
  const app = createApp({ dataDir, weatherFetch: noWeather, tileOptions });
  app.locals.dataDirForTests = dataDir;
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, app.locals.db, app);
  } finally {
    await app.locals.idle();
    app.locals.ogcTiles.close();
    server.close();
    app.locals.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

/* ---------- A small, independent Mapbox Vector Tile decoder ---------- */

function reader(buf) {
  let pos = 0;
  const varint = () => {
    let v = 0; let shift = 0; let b;
    do { b = buf[pos++]; v += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80);
    return v;
  };
  return {
    done: () => pos >= buf.length,
    tag: () => { const t = varint(); return [Math.floor(t / 8), t % 8]; },
    varint,
    bytes: () => { const n = varint(); const out = buf.subarray(pos, pos + n); pos += n; return out; },
    double: () => { const v = buf.readDoubleLE(pos); pos += 8; return v; },
    float: () => { const v = buf.readFloatLE(pos); pos += 4; return v; },
    skip: (wire) => { if (wire === 0) varint(); else if (wire === 1) pos += 8; else if (wire === 2) pos += varint(); else if (wire === 5) pos += 4; },
  };
}
const packed = (bytes) => { const r = reader(bytes); const out = []; while (!r.done()) out.push(r.varint()); return out; };
const zigzag = (n) => (n % 2 ? -(n + 1) / 2 : n / 2);

function decodeValue(bytes) {
  const r = reader(bytes);
  const [field, wire] = r.tag();
  if (field === 1) return r.bytes().toString('utf8');
  if (field === 2) return r.float();
  if (field === 3) return r.double();
  if (field === 4 || field === 5) return r.varint();
  if (field === 6) return zigzag(r.varint());
  if (field === 7) return Boolean(r.varint());
  r.skip(wire);
  return null;
}

/** Geometry commands → rings/points in tile coordinates. */
function decodeGeometry(cmds) {
  const parts = [];
  let x = 0; let y = 0; let cur = null;
  for (let i = 0; i < cmds.length;) {
    const id = cmds[i] & 7; const count = cmds[i] >> 3; i++;
    if (id === 7) { cur.push([...cur[0]]); continue; }
    for (let k = 0; k < count; k++) {
      x += zigzag(cmds[i++]); y += zigzag(cmds[i++]);
      if (id === 1) { cur = [[x, y]]; parts.push(cur); } else cur.push([x, y]);
    }
  }
  return parts;
}

function decodeTile(buf) {
  const layers = {};
  const t = reader(buf);
  while (!t.done()) {
    const [field, wire] = t.tag();
    if (field !== 3) { t.skip(wire); continue; }
    const l = reader(t.bytes());
    const layer = { name: null, extent: 4096, version: 1, keys: [], values: [], raw: [] };
    while (!l.done()) {
      const [f, w] = l.tag();
      if (f === 1) layer.name = l.bytes().toString('utf8');
      else if (f === 2) layer.raw.push(l.bytes());
      else if (f === 3) layer.keys.push(l.bytes().toString('utf8'));
      else if (f === 4) layer.values.push(decodeValue(l.bytes()));
      else if (f === 5) layer.extent = l.varint();
      else if (f === 15) layer.version = l.varint();
      else l.skip(w);
    }
    layer.features = layer.raw.map((bytes) => {
      const r = reader(bytes);
      const feat = { id: null, type: 0, properties: {}, geometry: [] };
      while (!r.done()) {
        const [f, w] = r.tag();
        if (f === 1) feat.id = r.varint();
        else if (f === 2) { const tags = packed(r.bytes()); for (let i = 0; i < tags.length; i += 2) feat.properties[layer.keys[tags[i]]] = layer.values[tags[i + 1]]; }
        else if (f === 3) feat.type = r.varint();
        else if (f === 4) feat.geometry = decodeGeometry(packed(r.bytes()));
        else r.skip(w);
      }
      return feat;
    });
    delete layer.raw;
    layers[layer.name] = layer;
  }
  return layers;
}

/* ---------- Data ---------- */

const dLat = (m) => m / 110540;
const dLon = (m) => m / (111320 * Math.cos((47.37 * Math.PI) / 180));

function seed(db) {
  const now = Date.now();
  const add = ({ lat, lon, date, tags = [], plant = null, spot = null }) => {
    const spotId = spot ?? db.prepare('INSERT INTO spots (lat, lon, created_at) VALUES (?, ?, ?)').run(lat, lon, now).lastInsertRowid;
    const photo = db.prepare(`INSERT INTO photos (spot_id, file, taken_at, lat, lon, location_source, created_at)
      VALUES (?, ?, ?, ?, ?, 'exif', ?)`).run(spotId, `p${Math.random().toString(36).slice(2)}.jpg`, Date.parse(date), lat, lon, now).lastInsertRowid;
    for (const t of tags) db.prepare('INSERT INTO photo_tags (photo_id, tag) VALUES (?, ?)').run(photo, t);
    if (plant) db.prepare('INSERT INTO identifications (photo_id, scientific_name, common_name, score, neophyte, created_at) VALUES (?, ?, ?, 0.8, ?, ?)').run(photo, ...plant, now);
    return Number(spotId);
  };
  const o = { lat: 47.37, lon: 8.54 };
  const spotId = add({ ...o, date: '2023-05-01T10:00:00Z', tags: ['sturmschaden'] });
  const balsam = ['Impatiens glandulifera', 'Drüsiges Springkraut', 'Drüsiges Springkraut'];
  for (const [k, year] of [[0, 2023], [1, 2024], [2, 2025]]) add({ lat: o.lat + dLat(300), lon: o.lon + dLon(40 * k), date: `${year}-07-01T10:00:00Z`, plant: balsam });
  return spotId;
}

/** Web mercator tile containing a position. */
function tileOf(lat, lon, z) {
  const n = 2 ** z;
  const r = (lat * Math.PI) / 180;
  return { z, x: Math.floor(((lon + 180) / 360) * n), y: Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n) };
}

test('WebMercatorQuad definition and tile helpers', () => {
  const tms = tileMatrixSet();
  assert.equal(tms.tileMatrices.length, 21);
  assert.equal(tms.tileMatrices[0].matrixWidth, 1);
  assert.equal(tms.tileMatrices[18].matrixWidth, 2 ** 18);
  assert.ok(Math.abs(tms.tileMatrices[0].scaleDenominator - 559082264.0287178) < 1e-6);
  assert.deepEqual([validTile(0, 0, 0), validTile(3, 8, 0), validTile(21, 0, 0), validTile(2.5, 0, 0)], [true, false, false, false]);
  const t = tileOf(47.37, 8.54, 16);
  assert.deepEqual(tileRange([8.54, 47.37, 8.54, 47.37], 16), { minCol: t.x, maxCol: t.x, minRow: t.y, maxRow: t.y });
});

test('OGC API – Tiles: tilesets, TileJSON, MVT tiles for the dataset and per collection, style', async () => {
  await withServer(async (base, db) => {
    const spotId = seed(db);
    const conf = await (await fetch(`${base}/ogc/conformance`)).json();
    assert.ok(conf.conformsTo.includes('http://www.opengis.net/spec/ogcapi-tiles-1/1.0/conf/mvt'));
    const landing = await (await fetch(`${base}/ogc`)).json();
    assert.ok(landing.links.some((l) => l.rel === 'http://www.opengis.net/def/rel/ogc/1.0/tilesets-vector'));
    const tmsList = await (await fetch(`${base}/ogc/tileMatrixSets`)).json();
    assert.equal(tmsList.tileMatrixSets[0].id, 'WebMercatorQuad');
    assert.equal((await fetch(`${base}/ogc/tileMatrixSets/MarsQuad`)).status, 404);

    const list = await (await fetch(`${base}/ogc/tiles`)).json();
    assert.equal(list.tilesets[0].dataType, 'vector');
    const ts = await (await fetch(`${base}/ogc/tiles/WebMercatorQuad`)).json();
    assert.equal(ts.tilejson, '3.0.0');
    assert.deepEqual(ts.vector_layers.map((l) => l.id), ['spread_fronts', 'spots', 'findings']);
    assert.equal(ts.vector_layers[1].fields.photos, 'Number');
    assert.match(ts.tiles[0], /\/ogc\/tiles\/WebMercatorQuad\/\{z\}\/\{y\}\/\{x\}$/);
    assert.match(ts.links.find((l) => l.rel === 'item').href, /\/WebMercatorQuad\/\{tileMatrix\}\/\{tileRow\}\/\{tileCol\}$/);
    assert.ok(ts.bounds[0] <= 8.54 && ts.bounds[2] >= 8.54 + dLon(80) - 1e-9);
    const z16 = ts.tileMatrixSetLimits.find((l) => l.tileMatrix === '16');
    const t16 = tileOf(47.37, 8.54, 16);
    assert.ok(z16.minTileCol <= t16.x && t16.x <= z16.maxTileCol && z16.minTileRow <= t16.y && t16.y <= z16.maxTileRow);
    // Zoom 15 (~750 m per tile) holds the spot and the stand 300 m north of it.
    const t = tileOf(47.37 + dLat(150), 8.54, 15);

    // The dataset tile around the spot has all three layers.
    let res = await fetch(`${base}/ogc/tiles/WebMercatorQuad/${t.z}/${t.y}/${t.x}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/vnd.mapbox-vector-tile');
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    const layers = decodeTile(Buffer.from(await res.arrayBuffer()));
    assert.deepEqual(Object.keys(layers).sort(), ['findings', 'spots', 'spread_fronts']);
    assert.deepEqual([layers.spots.version, layers.spots.extent], [2, 4096]);
    const spot = layers.spots.features.find((f) => f.id === spotId);
    assert.deepEqual([spot.type, spot.properties.photos, spot.properties.tags], [1, 1, 'sturmschaden']);
    assert.ok(!('heading' in spot.properties), 'null attributes are left out');
    const [[px, py]] = spot.geometry[0];
    assert.ok(px >= 0 && px <= 4096 && py >= 0 && py <= 4096, `point inside the tile: ${px}, ${py}`);
    assert.equal(layers.findings.features.length, 3);
    assert.ok(layers.findings.features.every((f) => f.properties.neophyte === 1 && f.type === 1));
    const fronts = layers.spread_fronts.features;
    assert.deepEqual(fronts.map((f) => f.properties.year), [2025, 2024, 2023], 'newest first, so older outlines are drawn on top');
    assert.deepEqual(fronts.map((f) => f.properties.recency), [1, 0.5, 0]);
    assert.ok(fronts.every((f) => f.type === 3 && f.geometry.every((ring) => ring.length >= 4)));

    // Collection tiles carry only their layer; photos are available that way.
    const photoTile = decodeTile(Buffer.from(await (await fetch(`${base}/ogc/collections/photos/tiles/WebMercatorQuad/${t.z}/${t.y}/${t.x}`)).arrayBuffer()));
    assert.deepEqual(Object.keys(photoTile), ['photos']);
    const colTs = await (await fetch(`${base}/ogc/collections/photos/tiles/WebMercatorQuad`)).json();
    assert.deepEqual(colTs.vector_layers.map((l) => l.id), ['photos']);
    assert.ok((await (await fetch(`${base}/ogc/collections/spots`)).json()).links.some((l) => l.href.endsWith('/ogc/collections/spots/tiles')));

    // Low zoom still holds the points; an empty tile is 204, an invalid one 404.
    const z5 = tileOf(47.37, 8.54, 5);
    const low = decodeTile(Buffer.from(await (await fetch(`${base}/ogc/tiles/WebMercatorQuad/5/${z5.y}/${z5.x}`)).arrayBuffer()));
    assert.equal(low.findings.features.length, 3);
    assert.equal((await fetch(`${base}/ogc/tiles/WebMercatorQuad/16/0/0`)).status, 204);
    assert.equal((await fetch(`${base}/ogc/tiles/WebMercatorQuad/3/9/0`)).status, 404);
    assert.equal((await fetch(`${base}/ogc/collections/wald/tiles`)).status, 404);

    // Tiles follow the data: a hidden photo's spot disappears.
    db.exec(`UPDATE photos SET hidden_at = ${Date.now()} WHERE spot_id = ${spotId}`);
    const after = decodeTile(Buffer.from(await (await fetch(`${base}/ogc/tiles/WebMercatorQuad/${t.z}/${t.y}/${t.x}`)).arrayBuffer()));
    assert.ok(!after.spots || !after.spots.features.some((f) => f.id === spotId));

    // MapLibre style pointing at the tileset.
    res = await fetch(`${base}/ogc/styles/myforrest`);
    assert.match(res.headers.get('content-type'), /application\/vnd\.mapbox\.style\+json/);
    const style = await res.json();
    assert.equal(style.version, 8);
    assert.equal(style.sources.myforrest.url, `${base}/ogc/tiles/WebMercatorQuad`);
    assert.deepEqual(style.layers.filter((l) => l.source === 'myforrest').map((l) => l['source-layer']),
      ['spread_fronts', 'spread_fronts', 'spots', 'spots', 'findings', 'findings']);
    assert.deepEqual(fronts.map((f) => f.properties.recency_class), [4, 2, 0]);
    assert.equal(spot.properties.status, 'schaden');
  });
});

test('Swiss LV95 tile grid: swisstopo resolutions, clipping, winding, tiles at the right place', async () => {
  // (lv95 from the top)
  const { wgs84ToLv95 } = require('../src/lv95');
  const tms = lv95.tileMatrixSet();
  assert.equal(tms.tileMatrices.length, 29);
  assert.deepEqual(tms.tileMatrices[0].pointOfOrigin, [2420000, 1350000]);
  assert.deepEqual([tms.tileMatrices[0].cellSize, tms.tileMatrices[28].cellSize], [4000, 0.1]);
  assert.deepEqual([tms.tileMatrices[0].matrixWidth, tms.tileMatrices[0].matrixHeight], [1, 1]);
  assert.deepEqual([tms.tileMatrices[20].matrixWidth, tms.tileMatrices[20].matrixHeight], [188, 125]); // 10 m/px
  assert.deepEqual(lv95.clipRing([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [5, -1, 20, 20]), [[5, 0], [10, 0], [10, 10], [5, 10]]);

  await withServer(async (base, db) => {
    const spotId = seed(db);
    const list = await (await fetch(`${base}/ogc/tileMatrixSets`)).json();
    assert.deepEqual(list.tileMatrixSets.map((t) => t.id), ['WebMercatorQuad', 'SwissLV95']);
    assert.equal((await (await fetch(`${base}/ogc/tileMatrixSets/SwissLV95`)).json()).crs, 'http://www.opengis.net/def/crs/EPSG/0/2056');
    const sets = await (await fetch(`${base}/ogc/tiles`)).json();
    assert.deepEqual(sets.tilesets.map((t) => t.crs), ['http://www.opengis.net/def/crs/EPSG/0/3857', 'http://www.opengis.net/def/crs/EPSG/0/2056']);
    const ts = await (await fetch(`${base}/ogc/tiles/SwissLV95`)).json();
    assert.equal(ts.tilejson, undefined, 'TileJSON only for web mercator');
    assert.equal(ts.vector_layers[0].maxzoom, 28);
    // GDAL needs a resolvable TMS URI and lists one layer per tileMatrixSetLimits entry.
    assert.equal(ts.tileMatrixSetURI, `${base}/ogc/tileMatrixSets/SwissLV95`);
    assert.deepEqual(ts.tileMatrixSetLimits.map((l) => l.tileMatrix), Array.from({ length: 29 }, (_, z) => String(z)));
    assert.equal(ts.boundingBox.crs, 'http://www.opengis.net/def/crs/EPSG/0/2056');
    assert.ok(ts.boundingBox.lowerLeft[0] > 2600000 && ts.boundingBox.upperRight[1] < 1350000, 'bounding box in LV95 metres');

    // Zoom 22 = 2.5 m/px, 640 m tiles: the tile containing the spot.
    const [e, n] = wgs84ToLv95(47.37, 8.54);
    const col = Math.floor((e - 2420000) / 640);
    const row = Math.floor((1350000 - n) / 640);
    const z22 = ts.tileMatrixSetLimits.find((l) => l.tileMatrix === '22');
    assert.ok(z22.minTileCol <= col && col <= z22.maxTileCol && z22.minTileRow <= row && row <= z22.maxTileRow);
    const res = await fetch(`${base}/ogc/tiles/SwissLV95/22/${row}/${col}`);
    assert.equal(res.status, 200);
    const layers = decodeTile(Buffer.from(await res.arrayBuffer()));
    const spot = layers.spots.features.find((f) => f.id === spotId);
    // The point lands where LV95 puts it inside the tile (4096 units over 640 m).
    const [[px, py]] = spot.geometry[0];
    assert.ok(Math.abs(px - ((e - 2420000 - col * 640) / 640) * 4096) <= 1 && Math.abs(py - ((1350000 - row * 640 - n) / 640) * 4096) <= 1);
    // Polygons: exterior rings clockwise on screen (positive area with y down), closed.
    for (const f of layers.spread_fronts.features) {
      const ring = f.geometry[0];
      let a = 0;
      for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
      assert.ok(a > 0, 'exterior ring clockwise');
      assert.deepEqual(ring[0], ring[ring.length - 1]);
    }
    // A tile cut through a front keeps it inside the buffer.
    const half = await fetch(`${base}/ogc/tiles/SwissLV95/25/${Math.floor((1350000 - n) / 256)}/${Math.floor((e - 2420000) / 256)}`);
    assert.ok([200, 204].includes(half.status));
    assert.equal((await fetch(`${base}/ogc/tiles/SwissLV95/0/1/0`)).status, 404, 'zoom 0 has a single tile');
    assert.equal((await fetch(`${base}/ogc/tiles/SwissLV95/22/0/0`)).status, 204);
    assert.equal((await fetch(`${base}/ogc/tiles/Mars/1/0/0`)).status, 404);
    const photos = decodeTile(Buffer.from(await (await fetch(`${base}/ogc/collections/photos/tiles/SwissLV95/22/${row}/${col}`)).arrayBuffer()));
    assert.deepEqual(Object.keys(photos), ['photos']);
    // OpenLayers for the LV95 map page.
    const ol = await fetch(`${base}/vendor/ol/ol.js`);
    assert.equal(ol.status, 200);
    assert.equal((await fetch(`${base}/vendor/ol/ol.css`)).status, 200);
    assert.equal((await fetch(`${base}/vektorkarte-lv95.html`)).status, 200);
  });
});

/* ---------- Precomputed tiles ---------- */

/** A small PMTiles v3 reader (header, gzip directories with leaves, tile lookup), independent of the writer. */
function readPmtiles(buf) {
  assert.equal(buf.toString('ascii', 0, 7), 'PMTiles');
  const u64 = (at) => Number(buf.readBigUInt64LE(at));
  const h = {
    version: buf[7], rootOffset: u64(8), rootLength: u64(16), metaOffset: u64(24), metaLength: u64(32),
    leafOffset: u64(40), dataOffset: u64(56), addressed: u64(72), internalCompression: buf[97],
    tileCompression: buf[98], tileType: buf[99], minZoom: buf[100], maxZoom: buf[101],
    bounds: [102, 106, 110, 114].map((at) => buf.readInt32LE(at) / 1e7),
  };
  const dir = (offset, length) => {
    const raw = zlib.gunzipSync(buf.subarray(offset, offset + length));
    const r = reader(raw);
    const n = r.varint();
    const e = Array.from({ length: n }, () => ({}));
    let id = 0;
    for (const x of e) { id += r.varint(); x.tileId = id; }
    for (const x of e) x.runLength = r.varint();
    for (const x of e) x.length = r.varint();
    e.forEach((x, i) => { const v = r.varint(); x.offset = v === 0 && i > 0 ? e[i - 1].offset + e[i - 1].length : v - 1; });
    return e;
  };
  const metadata = JSON.parse(zlib.gunzipSync(buf.subarray(h.metaOffset, h.metaOffset + h.metaLength)));
  const tile = (z, x, y) => {
    const id = zxyToTileId(z, x, y);
    let entries = dir(h.rootOffset, h.rootLength);
    for (let depth = 0; depth < 4; depth++) {
      let found = null;
      for (const e of entries) if (e.tileId <= id) found = e;
      if (!found) return null;
      if (found.runLength === 0) { entries = dir(h.leafOffset + found.offset, found.length); continue; }
      if (id >= found.tileId + found.runLength) return null;
      return zlib.gunzipSync(buf.subarray(h.dataOffset + found.offset, h.dataOffset + found.offset + found.length));
    }
    return null;
  };
  return { header: h, metadata, tile };
}

test('PMTiles tile ids follow the Hilbert curve of the spec', () => {
  // Values from the PMTiles specification / reference implementation.
  assert.deepEqual([[0, 0, 0], [1, 0, 0], [1, 0, 1], [1, 1, 1], [1, 1, 0], [2, 0, 0]].map((t) => zxyToTileId(...t)), [0, 1, 2, 3, 4, 5]);
  // Each zoom level fills its own id range without gaps or duplicates.
  for (let z = 1; z <= 4; z++) {
    const start = (4 ** z - 1) / 3;
    const ids = [];
    for (let x = 0; x < 2 ** z; x++) for (let y = 0; y < 2 ** z; y++) ids.push(zxyToTileId(z, x, y) - start);
    assert.deepEqual(ids.sort((a, b) => a - b), Array.from({ length: 4 ** z }, (_, i) => i));
  }
});

test('PMTiles writer: leaf directories, run lengths for repeated tiles, deduplicated contents', () => {
  const gz = (s) => zlib.gzipSync(Buffer.from(s));
  const tiles = [];
  for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) tiles.push({ z: 5, x, y, data: gz(y < 16 ? 'water' : `land ${x}/${y}`) });
  const meta = { minzoom: 5, maxzoom: 5, bounds: [-180, -85, 180, 85], center: [0, 0, 5], metadata: { name: 't' } };
  for (const options of [{}, { rootMaxBytes: 60 }]) {
    const buf = writePmtiles(tiles, meta, options);
    const pm = readPmtiles(buf);
    if (options.rootMaxBytes) assert.ok(Number(buf.readBigUInt64LE(48)) > 0, 'leaf directories written');
    assert.equal(pm.header.addressed, 1024);
    for (const [x, y] of [[0, 0], [31, 15], [3, 16], [31, 31], [17, 22]]) {
      assert.equal(pm.tile(5, x, y).toString(), y < 16 ? 'water' : `land ${x}/${y}`, `${options.rootMaxBytes ? 'leaf' : 'root'} ${x}/${y}`);
    }
    assert.equal(pm.tile(4, 0, 0), null);
    assert.equal(Number(buf.readBigUInt64LE(88)), 1 + 512, 'identical tiles stored once');
    // Streamed to a file, tile by tile in any order: the same bytes.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmtiles-'));
    const file = path.join(dir, 'x.pmtiles');
    const byKey = new Map(tiles.map((t) => [`${t.z}/${t.x}/${t.y}`, t.data]));
    const keys = [...tiles].reverse().map(({ z, x, y }) => ({ z, x, y }));
    const info = writePmtilesFile(file, { keys, read: (z, x, y) => byKey.get(`${z}/${x}/${y}`) }, meta, options);
    assert.deepEqual(fs.readFileSync(file), buf);
    assert.deepEqual([info.tiles, info.contents], [1024, 513]);
    assert.ok(!fs.existsSync(`${file}.data`), 'temporary data removed');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GeoPackage tile grid for LV95: the finest levels whose tiles cover the same box exactly', () => {
  const grid = gpkgTileGrid({ resolutions: lv95.RESOLUTIONS, origin: lv95.ORIGIN, extent: lv95.EXTENT_LV95, maxZoom: 26 });
  assert.deepEqual(grid.levels.map((l) => l.zoom), [15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26]);
  const [minX, minY, maxX, maxY] = grid.bounds;
  assert.deepEqual([minX, maxY], lv95.ORIGIN, 'anchored at the swisstopo origin: same columns and rows');
  assert.ok(maxX >= lv95.EXTENT_LV95[2] && minY <= lv95.EXTENT_LV95[1], 'covers Switzerland');
  for (const l of grid.levels) {
    assert.equal(l.width * 256 * l.res, maxX - minX, `width at ${l.zoom}`);
    assert.equal(l.height * 256 * l.res, maxY - minY, `height at ${l.zoom}`);
  }
});

test('Precomputed tiles: same bytes as live tiles, gzip, 204 from the store, PMTiles and MBTiles exports, rebuilt after changes', async () => {
  await withServer(async (base, db, app) => {
    seed(db);
    const t15 = tileOf(47.37 + dLat(300), 8.54, 15);
    const url = `${base}/ogc/tiles/WebMercatorQuad/15/${t15.y}/${t15.x}`;
    const live = await fetch(url);
    assert.equal(live.headers.get('x-tile-source'), 'live');
    const liveBytes = Buffer.from(await live.arrayBuffer());
    assert.equal((await fetch(`${base}/api/export/myforrest.pmtiles`)).status, 503, 'export not ready before the first build');

    const built = await app.locals.ogcTiles.precompute(base);
    assert.equal(built.length, 10, 'two grids × (dataset + 4 collections)');
    assert.ok(built.every((b) => b.tiles > 0));
    assert.deepEqual(await app.locals.ogcTiles.precompute(base), [], 'nothing to do while the data is unchanged');

    const pre = await fetch(url);
    assert.equal(pre.headers.get('x-tile-source'), 'precomputed');
    assert.equal(pre.headers.get('content-encoding'), 'gzip', 'fetch asks for gzip and decodes it');
    assert.deepEqual(Buffer.from(await pre.arrayBuffer()), liveBytes);
    // Without gzip in Accept-Encoding the tile comes uncompressed.
    const plain = await fetch(url, { headers: { 'Accept-Encoding': 'identity' } });
    assert.equal(plain.headers.get('content-encoding'), null);
    assert.deepEqual(Buffer.from(await plain.arrayBuffer()), liveBytes);
    // Empty tiles are known from the store; deeper zooms are still cut live.
    const empty = await fetch(`${base}/ogc/tiles/WebMercatorQuad/15/0/0`);
    assert.equal(empty.status, 204);
    assert.equal(empty.headers.get('x-tile-source'), 'precomputed');
    const t20 = tileOf(47.37 + dLat(300), 8.54, 20);
    assert.equal((await fetch(`${base}/ogc/tiles/WebMercatorQuad/20/${t20.y}/${t20.x}`)).headers.get('x-tile-source'), 'live');
    // LV95 and collection tiles are precomputed too.
    const [e, n] = require('../src/lv95').wgs84ToLv95(47.37 + dLat(300), 8.54);
    const lv = await fetch(`${base}/ogc/collections/findings/tiles/SwissLV95/22/${Math.floor((1350000 - n) / 640)}/${Math.floor((e - 2420000) / 640)}`);
    assert.equal(lv.status, 200);
    assert.equal(lv.headers.get('x-tile-source'), 'precomputed');
    assert.equal(decodeTile(Buffer.from(await lv.arrayBuffer())).findings.features.length, 3);

    // PMTiles: header, metadata and a tile identical to the API's.
    const pmRes = await fetch(`${base}/api/export/myforrest.pmtiles`);
    assert.equal(pmRes.status, 200);
    assert.equal(pmRes.headers.get('content-type'), 'application/vnd.pmtiles');
    const pm = readPmtiles(Buffer.from(await pmRes.arrayBuffer()));
    assert.deepEqual([pm.header.version, pm.header.tileType, pm.header.tileCompression, pm.header.internalCompression], [3, 1, 2, 2]);
    assert.deepEqual([pm.header.minZoom, pm.header.maxZoom], [0, 18]);
    assert.ok(pm.header.bounds[0] <= 8.54 && pm.header.bounds[3] >= 47.37 + dLat(300) - 1e-6);
    assert.deepEqual(pm.metadata.vector_layers.map((l) => l.id), ['spread_fronts', 'spots', 'findings']);
    assert.deepEqual(pm.tile(15, t15.x, t15.y), liveBytes);
    assert.equal(pm.tile(15, 0, 0), null);
    // Range requests, as PMTiles clients make them.
    const range = await fetch(`${base}/api/export/myforrest.pmtiles`, { headers: { Range: 'bytes=0-126' } });
    assert.equal(range.status, 206);
    assert.equal((await range.arrayBuffer()).byteLength, 127);

    // MBTiles: TMS rows, gzip tiles, metadata.
    const mbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mbtiles-')), 'x.mbtiles');
    fs.writeFileSync(mbFile, Buffer.from(await (await fetch(`${base}/api/export/myforrest.mbtiles`)).arrayBuffer()));
    const mb = new DatabaseSync(mbFile);
    const meta = Object.fromEntries(mb.prepare('SELECT name, value FROM metadata').all().map((r) => [r.name, r.value]));
    assert.equal(meta.format, 'pbf');
    assert.equal(meta.maxzoom, '18');
    assert.deepEqual(JSON.parse(meta.json).vector_layers.map((l) => l.id), ['spread_fronts', 'spots', 'findings']);
    const row = mb.prepare('SELECT tile_data FROM tiles WHERE zoom_level = 15 AND tile_column = ? AND tile_row = ?').get(t15.x, 2 ** 15 - 1 - t15.y);
    assert.deepEqual(zlib.gunzipSync(row.tile_data), liveBytes);
    mb.close();
    fs.rmSync(path.dirname(mbFile), { recursive: true, force: true });

    // GeoPackage with the LV95 tiles: vector-tiles extension, grid, the same tile as the API (uncompressed).
    const gpRes = await fetch(`${base}/api/export/myforrest-kacheln-lv95.gpkg`);
    assert.equal(gpRes.status, 200);
    assert.equal(gpRes.headers.get('content-type'), 'application/geopackage+sqlite3');
    const gpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gpkg-tiles-')), 'x.gpkg');
    fs.writeFileSync(gpFile, Buffer.from(await gpRes.arrayBuffer()));
    const gp = new DatabaseSync(gpFile);
    assert.equal(gp.prepare('PRAGMA application_id').get().application_id, 1196444487);
    assert.deepEqual({ ...gp.prepare('SELECT data_type, srs_id FROM gpkg_contents').get() }, { data_type: 'vector-tiles', srs_id: 2056 });
    assert.deepEqual(gp.prepare('SELECT DISTINCT extension_name FROM gpkg_extensions ORDER BY 1').all().map((x) => x.extension_name),
      ['gpkg_zoom_other', 'im_vector_tiles', 'im_vector_tiles_mapbox']);
    assert.deepEqual(gp.prepare('SELECT name FROM gpkgext_vt_layers ORDER BY id').all().map((x) => x.name), ['spread_fronts', 'spots', 'findings']);
    assert.ok(gp.prepare("SELECT COUNT(*) n FROM gpkgext_vt_fields WHERE name = 'scientific_name'").get().n >= 2);
    const z22 = gp.prepare('SELECT * FROM gpkg_tile_matrix WHERE zoom_level = 22').get();
    assert.deepEqual([z22.pixel_x_size, z22.tile_width], [2.5, 256]);
    const col = Math.floor((e - 2420000) / 640);
    const rowLv = Math.floor((1350000 - n) / 640);
    const lvDataset = Buffer.from(await (await fetch(`${base}/ogc/tiles/SwissLV95/22/${rowLv}/${col}`)).arrayBuffer());
    const stored = gp.prepare('SELECT tile_data FROM myforrest WHERE zoom_level = 22 AND tile_column = ? AND tile_row = ?').get(col, rowLv);
    assert.deepEqual(Buffer.from(stored.tile_data), lvDataset);
    assert.equal(gp.prepare('SELECT COUNT(*) n FROM myforrest WHERE zoom_level < 15').get().n, 0, 'only levels of the GeoPackage grid');
    gp.close();
    fs.rmSync(path.dirname(gpFile), { recursive: true, force: true });

    // New data: the stored version no longer counts, tiles are cut live until the rebuild.
    db.prepare('INSERT INTO photo_tags (photo_id, tag) VALUES ((SELECT MIN(id) FROM photos), ?)').run('borkenkaefer');
    assert.equal((await fetch(url)).headers.get('x-tile-source'), 'live');
    assert.equal((await fetch(`${base}/api/export/myforrest.pmtiles`)).status, 503);
    assert.equal((await app.locals.ogcTiles.precompute(base)).length, 10);
    assert.equal((await fetch(url)).headers.get('x-tile-source'), 'precomputed');
    assert.equal((await fetch(`${base}/api/export/myforrest.pmtiles`)).status, 200);
  }, { delayMs: null });
});

test('Precomputation starts by itself after a tile request', async () => {
  await withServer(async (base, db, app) => {
    seed(db);
    const t = tileOf(47.37, 8.54, 15);
    const url = `${base}/ogc/tiles/WebMercatorQuad/15/${t.y}/${t.x}`;
    assert.equal((await fetch(url)).headers.get('x-tile-source'), 'live');
    await app.locals.idle();
    assert.equal((await fetch(url)).headers.get('x-tile-source'), 'precomputed');
    assert.equal((await fetch(`${base}/api/export/myforrest.mbtiles`)).status, 200);
  });
});

test('Precomputed tilesets of old base URLs are dropped (at most two names are kept)', async () => {
  await withServer(async (base, db, app) => {
    seed(db);
    for (const b of [base, 'http://b.example', 'http://c.example']) await app.locals.ogcTiles.precompute(b);
    const kept = new DatabaseSync(path.join(app.locals.dataDirForTests, 'tiles', 'tiles.db'))
      .prepare('SELECT DISTINCT substr(tileset, 1, instr(tileset, \'|\') - 1) AS base FROM builds ORDER BY base').all().map((r) => r.base);
    assert.deepEqual(kept, ['http://b.example', 'http://c.example']);
    assert.equal((await fetch(`${base}/ogc/tiles/WebMercatorQuad/0/0/0`)).headers.get('x-tile-source'), 'live');
  }, { delayMs: null });
});

test('Precomputation can be switched off', async () => {
  await withServer(async (base, db) => {
    seed(db);
    const t = tileOf(47.37, 8.54, 15);
    assert.equal((await fetch(`${base}/ogc/tiles/WebMercatorQuad/15/${t.y}/${t.x}`)).headers.get('x-tile-source'), 'live');
    assert.equal((await fetch(`${base}/api/export/myforrest.pmtiles`)).status, 404);
  }, { precompute: false });
});
