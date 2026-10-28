'use strict';

// Short links with a QR code (src/routes/shortlinks.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');

test('short links: own addresses only, the same address the same code, redirect and QR code', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-kurz-'));
  const app = createApp({ dataDir, weatherFetch: async () => new Response('offline', { status: 503 }), tileOptions: { precompute: false } });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url) => fetch(`${base}/api/kurzlink`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) });
  try {
    const view = `${base}/?center=2683000,1248000&z=8&layers=ch.bfs.arealstatistik,f,0.5`;
    const a = await (await post(view)).json();
    assert.match(a.code, /^[a-z2-9]{6}$/);
    assert.deepEqual([a.url, a.qr], [`${base}/k/${a.code}`, `/k/${a.code}.svg`]);
    assert.equal((await (await post(view)).json()).code, a.code, 'the same address, the same code');
    assert.equal((await (await post('/landschaft.html#bericht?lat=47.3&lon=8.5')).json()).code.length, 6, 'a path is enough');
    const r = await fetch(`${base}/k/${a.code}`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/?center=2683000,1248000&z=8&layers=ch.bfs.arealstatistik,f,0.5');
    const qr = await fetch(`${base}/k/${a.code}.svg`);
    assert.equal(qr.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
    assert.match(await qr.text(), /^<svg[\s\S]*<path/);
    // Never elsewhere: other hosts, other schemes, nothing.
    for (const bad of ['https://evil.example/', 'javascript:alert(1)', '//evil.example/x', '', 'x'.repeat(3000)]) {
      assert.equal((await post(bad)).status, 400, bad.slice(0, 30));
    }
    assert.equal((await fetch(`${base}/k/zzzzzz`)).status, 404);
    assert.equal((await fetch(`${base}/k/zzzzzz.svg`)).status, 404);
  } finally {
    await app.locals.idle();
    server.close();
    app.locals.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
