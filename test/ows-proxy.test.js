'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');

async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}

test('QGIS Server behind /ows/: requests passed on with the public address, answers streamed back with CORS', async () => {
  const seen = [];
  // A stand-in for the QGIS Server container (its nginx answers /ows/).
  const qgis = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url.includes('REQUEST=GetMap')) {
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=60' });
        return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      }
      res.writeHead(200, { 'content-type': 'text/xml' });
      res.end(`<WMS_Capabilities><OnlineResource href="${req.headers['x-qgis-service-url']}"/></WMS_Capabilities>`);
    });
  });
  const upstream = await listen(qgis);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-ows-'));
  const app = createApp({ dataDir, weatherFetch: async () => new Response('', { status: 503 }), routerUrl: '', owsUpstream: upstream });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const caps = await fetch(`${base}/ows/?SERVICE=WMS&REQUEST=GetCapabilities`, { headers: { 'x-forwarded-proto': 'https' } });
    assert.equal(caps.status, 200);
    assert.equal(caps.headers.get('access-control-allow-origin'), '*');
    assert.match(await caps.text(), /OnlineResource href="http:\/\/127\.0\.0\.1:\d+\/ows\/"/);
    assert.equal(seen[0].url, '/ows/?SERVICE=WMS&REQUEST=GetCapabilities');
    assert.equal(seen[0].headers['x-forwarded-host'], new URL(base).host);

    const png = await fetch(`${base}/ows?SERVICE=WMS&REQUEST=GetMap&LAYERS=spots`);
    assert.equal(png.headers.get('content-type'), 'image/png');
    assert.equal(png.headers.get('cache-control'), 'max-age=60');
    assert.deepEqual([...Buffer.from(await png.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47]);
    assert.equal(seen[1].url, '/ows/?SERVICE=WMS&REQUEST=GetMap&LAYERS=spots');

    // WFS GetFeature as XML in the body.
    const xml = '<wfs:GetFeature service="WFS" version="1.1.0"/>';
    await fetch(`${base}/ows/`, { method: 'POST', headers: { 'content-type': 'text/xml' }, body: xml });
    assert.deepEqual([seen[2].method, seen[2].body, seen[2].headers['content-type']], ['POST', xml, 'text/xml']);
    assert.equal((await fetch(`${base}/ows/`, { method: 'DELETE' })).status, 405);

    // QGIS Server down: a clear error.
    await new Promise((r) => qgis.close(r));
    const down = await fetch(`${base}/ows/?SERVICE=WMS&REQUEST=GetCapabilities`);
    assert.equal(down.status, 502);
    assert.match((await down.json()).error, /Kartenserver nicht erreichbar/);
  } finally {
    await app.locals.idle();
    server.close();
    app.locals.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('without OWS_UPSTREAM there is no /ows/', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-ows-'));
  const app = createApp({ dataDir, weatherFetch: async () => new Response('', { status: 503 }), routerUrl: '' });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/ows/?SERVICE=WMS&REQUEST=GetCapabilities`);
    assert.notEqual(r.headers.get('access-control-allow-origin'), '*');
    assert.ok(r.status === 404 || !(r.headers.get('content-type') || '').includes('xml'));
  } finally {
    await app.locals.idle();
    server.close();
    app.locals.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
