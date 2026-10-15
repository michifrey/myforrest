'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { createSurface } = require('../src/surface');
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
    const name = /x\/(\w+?)_/.exec(u.pathname)[1];
    if (!['surface', 'terrain'].includes(name)) return new Response('wrong file', { status: 404 });
    const buf = files[name] ??= await cogBuffer(name);
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
  const png = await s.tile(16, t.x, t.y);
  assert.ok(Math.abs((await heightAt(png, t.i, t.j)) - 20) < 0.5, 'the house');
  const [la2, lo2] = lv95ToWgs84(2645150, 1249150);
  const t2 = tileAt(la2, lo2, 16);
  if (t2.x === t.x && t2.y === t.y) assert.equal(await heightAt(png, t2.i, t2.j), 0);
  assert.ok(log.some((u) => u.includes('/x/surface_0.5_')) && log.some((u) => u.includes('/x/terrain_0.5_')), 'newest files, 0.5 m');
  assert.ok(!log.some((u) => u.includes('old-')));
  // Paris: no request at all.
  const n = log.length;
  const p = tileAt(48.85, 2.35, 15);
  assert.equal(await s.tile(15, p.x, p.y), null);
  assert.equal(log.length, n);
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
