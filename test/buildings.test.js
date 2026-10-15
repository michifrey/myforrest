'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const sharp = require('sharp');
const { createBuildings, parseBuildings, buildingHeight, parseLength, rasterize, tileBounds } = require('../src/buildings');
const { createSurface } = require('../src/surface');

test('heights from tags: height, storeys, kind of building', () => {
  assert.equal(parseLength('12'), 12);
  assert.equal(parseLength('12,5 m'), 12.5);
  assert.ok(Math.abs(parseLength("40'") - 12.19) < 0.01);
  assert.equal(parseLength('hoch'), null);
  assert.equal(buildingHeight({ building: 'yes', height: '23 m' }), 23);
  assert.equal(buildingHeight({ building: 'apartments', 'building:levels': '5' }), 17, '5 × 3 m + roof');
  assert.equal(buildingHeight({ building: 'house', 'building:levels': '2', 'roof:levels': '1' }), 9);
  assert.equal(buildingHeight({ building: 'garage' }), 3);
  assert.equal(buildingHeight({ building: 'church' }), 20);
  assert.equal(buildingHeight({ building: 'yes' }), 8);
});

const square = (lat, lon, d) => [[lat, lon], [lat, lon + d], [lat + d, lon + d], [lat + d, lon], [lat, lon]].map(([a, b]) => ({ lat: a, lon: b }));

test('Overpass answer: ways and multipolygons, nothing underground', () => {
  const list = parseBuildings({ elements: [
    { type: 'way', tags: { building: 'house' }, geometry: square(48, 8, 0.0001) },
    { type: 'way', tags: { building: 'yes', location: 'underground' }, geometry: square(48, 8, 0.0001) },
    { type: 'way', tags: { building: 'no' }, geometry: square(48, 8, 0.0001) },
    { type: 'way', tags: { highway: 'path' }, geometry: square(48, 8, 0.0001) },
    { type: 'relation', tags: { building: 'office', height: '30' }, members: [
      { type: 'way', role: 'outer', geometry: square(48.001, 8.001, 0.0002) },
      { type: 'way', role: 'inner', geometry: square(48.00105, 8.00105, 0.00005) },
    ] },
  ] });
  assert.deepEqual(list.map((b) => [b.h, b.rings.length]), [[8, 1], [30, 1]]);
});

/** Tile z/x/y containing a point, and the pixel. */
function tileAt(lat, lon, z) {
  const n = 2 ** z;
  const fx = ((lon + 180) / 360) * n;
  const fy = ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n;
  return { x: Math.floor(fx), y: Math.floor(fy), i: Math.floor((fx % 1) * 256), j: Math.floor((fy % 1) * 256) };
}

test('outlines burnt into a tile, where allowed', () => {
  const z = 17; const t = tileAt(48.0003, 8.0003, z);
  const [s, w, n, e] = tileBounds(z, t.x, t.y);
  // A 20 × 20 m house in the middle of the tile.
  const lat = (s + n) / 2; const lon = (w + e) / 2;
  const house = { h: 11, rings: [[[lat, lon], [lat, lon + 0.00027], [lat + 0.00018, lon + 0.00027], [lat + 0.00018, lon], [lat, lon]]] };
  const grid = new Float32Array(256 * 256).fill(4);
  assert.equal(rasterize(grid, [house], z, t.x, t.y), 1);
  const lit = grid.filter((v) => v === 11).length;
  assert.ok(lit > 500 && lit < 750, `about 25 × 25 px (0.8 m per px): ${lit}`);
  assert.equal(grid[0], 4, 'trees outside stay');
  assert.equal(grid[120 * 256 + 140], 11);
  const blocked = new Float32Array(256 * 256);
  assert.equal(rasterize(blocked, [house], z, t.x, t.y, () => false), 0);
  assert.ok(blocked.every((v) => v === 0));
});

test('one Overpass request per zoom-14 cell, kept 30 days', async () => {
  const db = new DatabaseSync(':memory:');
  const calls = [];
  let t = 0;
  const fetchImpl = async (url, opts) => {
    calls.push(String(opts.body));
    return Response.json({ elements: [{ type: 'way', tags: { building: 'house' }, geometry: square(48, 8, 0.0001) }] });
  };
  const b = createBuildings({ db, url: 'https://overpass.test/api/interpreter', fetchImpl, now: () => t });
  const p = tileAt(48, 8, 16);
  const [a, c] = await Promise.all([b.forTile(16, p.x, p.y), b.forTile(17, p.x * 2 + 1, p.y * 2)]);
  assert.equal(calls.length, 1, 'both tiles lie in the same cell');
  assert.match(decodeURIComponent(calls[0]), /way\["building"\]/);
  assert.equal(a[0].h, 8);
  assert.deepEqual(a, c);
  t = 31 * 86400000;
  await b.forTile(16, p.x, p.y);
  assert.equal(calls.length, 2, 'fetched again after 30 days');
  assert.deepEqual(await createBuildings({ db, url: '' }).forTile(16, p.x, p.y), [], 'off without a URL');
});

test('surface tiles outside Switzerland: buildings from OpenStreetMap on top of the crowns', async () => {
  const z = 17; const t = tileAt(48.0003, 8.0003, z);
  const [s, w, n, e] = tileBounds(z, t.x, t.y);
  const lat = (s + n) / 2; const lon = (w + e) / 2;
  const buildings = { enabled: true, forTile: async () => [{ h: 14, rings: [[[lat, lon], [lat, lon + 0.0003], [lat + 0.0002, lon + 0.0003], [lat + 0.0002, lon], [lat, lon]]] }] };
  // swisstopo has nothing here (empty catalogue) and Meta no file (404), so only the building counts.
  const nothing = async (url) => (url.includes('data.geo.admin.ch') ? Response.json({ features: [] }) : new Response('', { status: 404 }));
  const surface = createSurface({ fetchImpl: nothing, buildings });
  const r = await surface.tile(z, t.x, t.y);
  assert.equal(r.source, 'osm');
  const { data } = await sharp(r.png).raw().toBuffer({ resolveWithObject: true });
  const at = (i, j) => { const o = (j * 256 + i) * 3; return data[o] * 256 + data[o + 1] + data[o + 2] / 256 - 32768; };
  assert.equal(at(135, 120), 14);
  assert.equal(at(5, 5), 0);
  // Overpass down: the tile goes on without buildings (here: nothing at all).
  const down = createSurface({ fetchImpl: nothing, buildings: { enabled: true, forTile: async () => { throw new Error('504'); } } });
  assert.equal(await down.tile(z, t.x, t.y), null);
});
