'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { createDwd, parseCapabilities, timeRange } = require('../src/dwd');

const CAPS = `<?xml version="1.0"?><WMS_Capabilities version="1.3.0"><Capability><Layer><Title>DWD</Title>
  <Layer queryable="1"><Name>dwd:Niederschlagsradar</Name><Title>Radar</Title>
    <Dimension name="time" default="current" units="ISO8601">2026-10-08T11:00:00.000Z/2026-10-10T11:00:00.000Z/PT5M</Dimension></Layer>
  <Layer><Name>dwd:Warnungen_Gemeinden</Name><Title>Warnungen</Title></Layer>
  <Layer><Name>dwd:Waldbrandgefahrenindex_Prognose</Name><Title>WBI</Title></Layer>
  <Layer><Name>dwd:Autobahn</Name><Title>Autobahn</Title></Layer>
</Layer></Capability></WMS_Capabilities>`;

test('capabilities: layers, titles and time ranges', () => {
  const layers = parseCapabilities(CAPS);
  assert.deepEqual(layers.map((l) => l.name), ['dwd:Niederschlagsradar', 'dwd:Warnungen_Gemeinden', 'dwd:Waldbrandgefahrenindex_Prognose', 'dwd:Autobahn']);
  assert.deepEqual(timeRange(layers[0].time), { from: Date.UTC(2026, 9, 8, 11), to: Date.UTC(2026, 9, 10, 11), stepMin: 5 });
  assert.deepEqual(timeRange('2026-10-10T10:00:00Z,2026-10-10T10:05:00Z'), { from: Date.UTC(2026, 9, 10, 10), to: Date.UTC(2026, 9, 10, 10, 5), stepMin: null });
  assert.equal(timeRange(null), null);
  assert.equal(timeRange('current'), null);
});

test('offered layers, cached for an hour, with a fallback when DWD is down', async () => {
  let calls = 0; let t = 0;
  const dwd = createDwd({ fetchImpl: async () => { calls++; return new Response(CAPS); }, now: () => t });
  const a = await dwd.layers();
  assert.deepEqual(a.layers.map((l) => [l.id, l.name]), [
    ['radar', 'dwd:Niederschlagsradar'], ['warnungen', 'dwd:Warnungen_Gemeinden'], ['waldbrand', 'dwd:Waldbrandgefahrenindex_Prognose'],
  ]);
  assert.equal(a.layers[0].stepMin, 5);
  assert.equal(a.attribution, 'Deutscher Wetterdienst');
  await dwd.layers();
  assert.equal(calls, 1);
  t = 3600001;
  await dwd.layers();
  assert.equal(calls, 2);

  const down = createDwd({ fetchImpl: async () => new Response('', { status: 503 }) });
  const b = await down.layers();
  assert.match(b.error, /503/);
  assert.deepEqual(b.layers.map((l) => l.name), ['dwd:Niederschlagsradar', 'dwd:Warnungen_Gemeinden']);
});

test('DWD layers endpoint', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-'));
  const app = createApp({ dataDir, weatherFetch: async () => new Response('', { status: 503 }), dwdFetch: async () => new Response(CAPS) });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/dwd/layers`);
    const body = await res.json();
    assert.equal(body.url, 'https://maps.dwd.de/geoserver/dwd/wms');
    assert.equal(body.layers.length, 3);
  } finally {
    await app.locals.idle();
    server.close();
    app.locals.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
