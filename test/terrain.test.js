'use strict';

// Terrain tiles for the 3D map (src/routes/terrain.js): fetched once, kept on disk, validated.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');

const offline = async () => new Response('offline', { status: 503 });

async function start(options) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-terrain-'));
  const app = createApp({ dataDir, weatherFetch: offline, fetchImpl: offline, routerUrl: '', mailer: { send: async () => ({}) }, ...options });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const stop = async () => {
    await app.locals.idle();
    server.close();
    app.locals.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return { base, dataDir, stop };
}

test('terrain tiles: fetched once from the source, then from disk', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);
  const asked = [];
  const terrainFetch = async (url) => {
    asked.push(url);
    if (url.includes('/9/')) return new Response('nope', { status: 404 });
    return new Response(png, { status: 200, headers: { 'Content-Type': 'image/png' } });
  };
  const { base, dataDir, stop } = await start({ terrainUrl: 'https://dem.example/{z}/{x}/{y}.png', terrainFetch });
  try {
    assert.equal((await (await fetch(`${base}/api/config`)).json()).terrain, true);
    // Two requests at the same time: one download.
    const [a, b] = await Promise.all([fetch(`${base}/api/terrain/12/2140/1438.png`), fetch(`${base}/api/terrain/12/2140/1438.png`)]);
    assert.equal(a.status, 200);
    assert.equal(a.headers.get('content-type'), 'image/png');
    assert.match(a.headers.get('cache-control'), /immutable/);
    assert.deepEqual(Buffer.from(await a.arrayBuffer()), png);
    assert.equal(b.status, 200);
    assert.deepEqual(asked, ['https://dem.example/12/2140/1438.png']);
    assert.ok(fs.existsSync(path.join(dataDir, 'terrain', '12', '2140', '1438.png')));
    // Again: from disk, no new download.
    assert.equal((await fetch(`${base}/api/terrain/12/2140/1438.png`)).status, 200);
    assert.equal(asked.length, 1);
    // No data at the source, out of range, not a number.
    assert.equal((await fetch(`${base}/api/terrain/9/268/179.png`)).status, 404);
    assert.equal((await fetch(`${base}/api/terrain/3/8/1.png`)).status, 400);
    assert.equal((await fetch(`${base}/api/terrain/16/1/1.png`)).status, 400);
    assert.equal((await fetch(`${base}/api/terrain/a/1/1.png`)).status, 400);
  } finally {
    await stop();
  }
});

test('terrain tiles: the source sends something else than a PNG, or nothing is set up', async () => {
  const html = async () => new Response('<html>Fehler</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
  let s = await start({ terrainUrl: 'https://dem.example/{z}/{x}/{y}.png', terrainFetch: html });
  try {
    assert.equal((await fetch(`${s.base}/api/terrain/5/16/11.png`)).status, 502);
    assert.equal(fs.existsSync(path.join(s.dataDir, 'terrain', '5', '16', '11.png')), false);
  } finally {
    await s.stop();
  }
  s = await start({ terrainUrl: null });
  try {
    assert.equal((await (await fetch(`${s.base}/api/config`)).json()).terrain, false);
    assert.equal((await fetch(`${s.base}/api/terrain/5/16/11.png`)).status, 404);
  } finally {
    await s.stop();
  }
});
