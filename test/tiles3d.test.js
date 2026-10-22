'use strict';

// Buildings and trees of swisstopo as 3D Tiles in the 3D map: configuration and the deck.gl bundle.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');

async function withServer(opts, fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-3dtiles-'));
  const app = createApp({ dataDir, weatherFetch: async () => new Response('offline', { status: 503 }), ...opts });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test('config names the 3D Tiles of swisstopo and the height shift; the deck.gl bundle is served', async () => {
  await withServer({}, async (base) => {
    const { tiles3d } = await (await fetch(`${base}/api/config`)).json();
    assert.deepEqual(tiles3d.layers.map((l) => [l.id, l.url]), [
      ['gebaeude', 'https://3d.geo.admin.ch/ch.swisstopo.swissbuildings3d.3d/v1/tileset.json'],
      ['baeume', 'https://3d.geo.admin.ch/ch.swisstopo.vegetation.3d/v1/tileset.json'],
    ]);
    assert.equal(tiles3d.height, -50);
    const res = await fetch(`${base}/vendor/deck/deck.min.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);
    assert.match((await res.text()).slice(0, 2000000), /Tile3DLayer/);
  });
});

test('3D Tiles can be switched off one by one, the height shift set', async () => {
  await withServer({ tiles3dBuildings: '', tiles3dHeight: -48.5 }, async (base) => {
    const { tiles3d } = await (await fetch(`${base}/api/config`)).json();
    assert.deepEqual(tiles3d.layers.map((l) => l.id), ['baeume']);
    assert.equal(tiles3d.height, -48.5);
  });
});
