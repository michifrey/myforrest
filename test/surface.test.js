'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { createSurface, quadkey } = require('../src/surface');
const { createApp } = require('../src/app');
const { lv95ToWgs84 } = require('../src/lv95');

// Km tile 2645/1249 (near Aarau): flat ground at 400 m, a 20-m house at E 2645300–2645400, N 1249600–1249700
// and a 30-m forest edge in the east (E ≥ 2645800).
const E = 2645; const N = 1249;
async function cogBuffer(kind) {
  const { writeArrayBuffer } = await import('geotiff');
  const res = 10; const n = 100;
  const v = new Float32Array(n * n).fill(400);
  if (kind === 'surface') {
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (c >= 30 && c < 40 && r >= 30 && r < 40) v[r * n + c] = 420; // row 0 = north edge (N 1250000)
        if (c >= 80) v[r * n + c] = 430;
      }
    }
    v[0] = -9999; // no data
  }
  return Buffer.from(writeArrayBuffer(v, {
    width: n, height: n, ModelPixelScale: [res, res, 0], ModelTiepoint: [0, 0, 0, E * 1000, (N + 1) * 1000, 0],
    ProjectedCSTypeGeoKey: 2056, GTModelTypeGeoKey: 1, BitsPerSample: [32], SampleFormat: [3],
  }));
}

// Meta's canopy heights for the zoom-10 tile around a point in the Black Forest: one 256×256 image for the
// whole file (the real ones are 32768 px with overviews), 28-m crowns in the western half, nothing in the east.
const BLACK_FOREST = [47.9, 8.1];
const tileAt10 = tileAt(...BLACK_FOREST, 10);
const META_Q = quadkey(tileAt10.x, tileAt10.y, 10);
async function metaBuffer() {
  const { writeArrayBuffer } = await import('geotiff');
  const v = new Uint8Array(256 * 256);
  for (let r = 0; r < 256; r++) for (let c = 0; c < 128; c++) v[r * 256 + c] = 28;
  return Buffer.from(writeArrayBuffer(v, { width: 256, height: 256, BitsPerSample: [8], SampleFormat: [1], ProjectedCSTypeGeoKey: 3857, GTModelTypeGeoKey: 1 }));
}

function fakeGeoAdmin(log = []) {
  const files = {};
  return async (url, opts = {}) => {
    log.push(url);
    const u = new URL(url);
    if (u.pathname.endsWith('/items')) {
      const surface = u.pathname.includes('swisssurface3d');
      const id = `${surface ? 'swisssurface3d-raster' : 'swissalti3d'}_2021_${E}-${N}`;
      const old = `${surface ? 'swisssurface3d-raster' : 'swissalti3d'}_2015_${E}-${N}`;
      const asset = (y, r) => ({ href: `https://data.geo.admin.ch/x/${y}_${r}_2056_5728.tif` });
      return Response.json({ features: [
        { id: old, assets: { a: asset(`old-${surface ? 's' : 't'}`, '0.5') } },
        { id, assets: { a: asset(surface ? 'surface' : 'terrain', '0.5'), b: asset(`${surface ? 's' : 't'}2`, '2') } },
        { id: `x_2021_${E + 1}-${N}`, assets: {} },
      ] });
    }
    let name = /x\/(\w+?)_/.exec(u.pathname)?.[1];
    const q = /dinov3_global_chm_v2_ml3\/chm\/(\d+)\.tif$/.exec(u.pathname)?.[1];
    if (q) name = q === META_Q ? 'meta' : null;
    if (!['surface', 'terrain', 'meta'].includes(name)) return new Response('not found', { status: 404 });
    const buf = files[name] ??= name === 'meta' ? await metaBuffer() : await cogBuffer(name);
    const r = /bytes=(\d+)-(\d+)/.exec(opts.headers?.Range || '');
    if (!r) return new Response(buf);
    const end = Math.min(Number(r[2]), buf.length - 1);
    return new Response(buf.subarray(Number(r[1]), end + 1), { status: 206, headers: { 'content-range': `bytes ${r[1]}-${end}/${buf.length}` } });
  };
}

/** Web Mercator tile containing a point, and the pixel in it. */
function tileAt(lat, lon, z) {
  const n = 2 ** z;
  const fx = ((lon + 180) / 360) * n;
  const fy = ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n;
  return { x: Math.floor(fx), y: Math.floor(fy), i: Math.floor((fx % 1) * 256), j: Math.floor((fy % 1) * 256) };
}
async function heightAt(png, i, j) {
  const { data } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const o = (j * 256 + i) * 3;
  return data[o] * 256 + data[o + 1] + data[o + 2] / 256 - 32768;
}

test('heights of trees and buildings: surface minus terrain, per km tile', async () => {
  const s = createSurface({ fetchImpl: fakeGeoAdmin() });
  const grid = await s.kmTile(E, N);
  assert.equal(grid.length, 1000 * 1000);
  const at = (e, n) => grid[(1000 - 1 - Math.floor(n)) * 1000 + Math.floor(e)];
  assert.ok(Math.abs(at(350, 650) - 20) < 0.5, `house ${at(350, 650)}`);
  assert.ok(Math.abs(at(900, 500) - 30) < 0.5, `forest ${at(900, 500)}`);
  assert.equal(at(100, 100), 0);
  assert.equal(at(1, 999), 0, 'no data counts as bare ground');
});

test('surface tiles in Web Mercator, empty outside Switzerland', async () => {
  const log = [];
  const s = createSurface({ fetchImpl: fakeGeoAdmin(log) });
  const [lat, lon] = lv95ToWgs84(2645350, 1249650);
  const t = tileAt(lat, lon, 16);
  const { png, source } = await s.tile(16, t.x, t.y);
  assert.equal(source, 'swisstopo');
  assert.ok(Math.abs((await heightAt(png, t.i, t.j)) - 20) < 0.5, 'the house');
  const [la2, lo2] = lv95ToWgs84(2645150, 1249150);
  const t2 = tileAt(la2, lo2, 16);
  if (t2.x === t.x && t2.y === t.y) assert.equal(await heightAt(png, t2.i, t2.j), 0);
  assert.ok(log.some((u) => u.includes('/x/surface_0.5_')) && log.some((u) => u.includes('/x/terrain_0.5_')), 'newest files, 0.5 m');
  assert.ok(!log.some((u) => u.includes('old-')));
  // Paris: nothing at swisstopo, and Meta has no file there either.
  const n = log.length;
  const p = tileAt(48.85, 2.35, 15);
  assert.equal(await s.tile(15, p.x, p.y), null);
  assert.ok(!log.slice(n).some((u) => u.includes('geo.admin.ch')), 'no requests to swisstopo outside Switzerland');
  assert.ok(log.slice(n).some((u) => u.includes('dinov3_global_chm_v2_ml3')));
});

test('outside Switzerland: crown heights from Meta, a window of the zoom-10 file', async () => {
  assert.equal(quadkey(0, 0, 1), '0');
  assert.equal(quadkey(1, 1, 1), '3');
  assert.equal(quadkey(3, 5, 3), '213');
  const s = createSurface({ fetchImpl: fakeGeoAdmin() });
  const lon0 = (tileAt10.x / 1024) * 360 - 180; // west edge of the file; it is 0.35° wide
  const west = tileAt(BLACK_FOREST[0], lon0 + 0.05, 16);
  const east = tileAt(BLACK_FOREST[0], lon0 + 0.3, 16);
  for (const [t, h] of [[west, 28], [east, 0]]) {
    assert.equal(quadkey(t.x >> 6, t.y >> 6, 10), META_Q, 'same Meta file');
    const r = await s.tile(16, t.x, t.y);
    if (h) {
      assert.equal(r.source, 'meta');
      assert.equal(await heightAt(r.png, 100, 100), h);
    } else {
      assert.equal(await heightAt(r.png, 100, 100), 0);
    }
  }
});

test('surface endpoint', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-'));
  const app = createApp({ dataDir, weatherFetch: async () => new Response('', { status: 503 }), surfaceFetch: fakeGeoAdmin() });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const [lat, lon] = lv95ToWgs84(2645350, 1249650);
    const t = tileAt(lat, lon, 16);
    const res = await fetch(`${base}/api/surface/16/${t.x}/${t.y}.png`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('x-surface-source'), 'swisstopo');
    assert.ok(Math.abs((await heightAt(Buffer.from(await res.arrayBuffer()), t.i, t.j)) - 20) < 0.5);
    const p = tileAt(48.85, 2.35, 15);
    assert.equal((await fetch(`${base}/api/surface/15/${p.x}/${p.y}.png`)).status, 204);
    assert.equal((await fetch(`${base}/api/surface/12/1/1.png`)).status, 400);
  } finally {
    await app.locals.idle();
    server.close();
    app.locals.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
