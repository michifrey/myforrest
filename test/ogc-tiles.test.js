'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { tileMatrixSet, tileRange, validTile } = require('../src/tiles');

const noWeather = async () => new Response('offline', { status: 503 });

async function withServer(fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-tiles-'));
  const app = createApp({ dataDir, weatherFetch: noWeather });
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
    assert.equal((await fetch(`${base}/ogc/tileMatrixSets/SwissLV95`)).status, 404);

    const list = await (await fetch(`${base}/ogc/tiles`)).json();
    assert.equal(list.tilesets[0].dataType, 'vector');
    const ts = await (await fetch(`${base}/ogc/tiles/WebMercatorQuad`)).json();
    assert.equal(ts.tilejson, '3.0.0');
    assert.deepEqual(ts.vector_layers.map((l) => l.id), ['spread_fronts', 'spots', 'findings']);
    assert.equal(ts.vector_layers[1].fields.photos, 'Number');
    assert.match(ts.tiles[0], /\/ogc\/tiles\/WebMercatorQuad\/\{z\}\/\{y\}\/\{x\}$/);
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
