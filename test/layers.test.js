'use strict';

// Panel «Ebenen»: layers of external sources by theme, and what they say at a point.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');

const caps = (service, names) => `<?xml version="1.0"?><WMS_Capabilities><Service><Title>${service}</Title></Service><Capability><Layer><Title>${service}</Title>
${names.map(([n, t]) => `<Layer queryable="1"><Name>${n}</Name><Title>${t}</Title></Layer>`).join('\n')}
</Layer></Capability></WMS_Capabilities>`;
const GEOADMIN = caps('WMS BGDI', [
  ['ch.bafu.landesforstinventar-waldmischungsgrad', 'Waldmischungsgrad'],
  ['ch.bafu.gefahren-waldbrand_warnung', 'Waldbrandgefahr'],
  ['ch.bfs.volkszaehlung-bevoelkerungsstatistik_einwohner', 'Bevölkerung (STATPOP)'],
  ['ch.bfs.arealstatistik', 'Arealstatistik'],
  ['ch.are.gueteklassen_oev', 'ÖV-Güteklassen'],
  ['ch.swisstopo.pixelkarte-farbe', 'Landeskarte'],
]);
const ZH = caps('Baumkataster', [['baumkataster_baumstandorte', 'Baumstandorte']]);

async function withServer(opts, fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-layers-'));
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

test('layers by theme from geo.admin.ch, the most useful first; regional services with their area; a source that fails is named', async () => {
  const urls = [];
  const layersFetch = async (url) => {
    urls.push(url);
    if (url.startsWith('https://wms.example/')) return new Response(GEOADMIN);
    if (url.startsWith('https://zh.example/')) return new Response(ZH);
    return new Response('', { status: 503 });
  };
  const layersOptions = {
    geoadminUrl: 'https://wms.example/',
    regional: [
      { url: 'https://zh.example/wms/Baumkataster', group: 'Bäume Stadt Zürich', bbox: [8.44, 47.32, 8.63, 47.44], attribution: '© Grün Stadt Zürich' },
      { url: 'https://effis.example/effis', group: 'Waldbrände Europa (EFFIS)', bbox: [-25, 34, 45, 72], attribution: 'EFFIS' },
    ],
  };
  await withServer({ layersFetch, layersOptions }, async (base) => {
    const d = await (await fetch(`${base}/api/layers`)).json();
    assert.deepEqual(d.groups.map((g) => g.title), ['Wald und Waldbrand', 'Bevölkerung', 'Bodennutzung', 'Verkehr', 'Bäume Stadt Zürich']);
    assert.deepEqual(d.groups[0].layers.map((l) => l.title), ['Waldbrandgefahr', 'Waldmischungsgrad'], 'the fire danger first');
    const zh = d.groups[4].layers[0];
    assert.deepEqual([zh.name, zh.bbox, zh.attribution, zh.info], ['baumkataster_baumstandorte', [8.44, 47.32, 8.63, 47.44], '© Grün Stadt Zürich', true]);
    assert.match(d.groups[1].layers[0].legend, /REQUEST=GetLegendGraphic&.*LAYER=ch\.bfs\.volkszaehlung-bevoelkerungsstatistik_einwohner/);
    assert.deepEqual(d.errors, ['effis.example: HTTP 503']);
    assert.ok(!JSON.stringify(d).includes('pixelkarte'), 'base maps are no theme');
    const n = urls.length;
    await fetch(`${base}/api/layers`);
    assert.equal(urls.length, n, 'capabilities read once a day');
  });
});

test('what is here: geo.admin.ch layers through identify, others through GetFeatureInfo, noise left out', async () => {
  const asked = [];
  const layersFetch = async (url) => {
    asked.push(url);
    if (url.includes('GetCapabilities')) return new Response(url.startsWith('https://zh.example/') ? ZH : GEOADMIN);
    if (url.startsWith('https://identify.example/')) {
      return Response.json({ results: [{ layerBodId: 'ch.bfs.volkszaehlung-bevoelkerungsstatistik_einwohner', layerName: 'Bevölkerung (STATPOP)', attributes: { id: 4711, reli: 67251234, number: 38, i_year: 2023 } }] });
    }
    if (url.includes('GetFeatureInfo')) {
      return Response.json({ type: 'FeatureCollection', features: [{ properties: { objectid: 9, baumnamedeu: 'Spitz-Ahorn', pflanzjahr: 1987, geometry: null } }] });
    }
    return new Response('', { status: 404 });
  };
  const layersOptions = {
    geoadminUrl: 'https://wms.example/', identifyUrl: 'https://identify.example/identify',
    regional: [{ url: 'https://zh.example/wms/Baumkataster', group: 'Bäume Stadt Zürich', bbox: [8.44, 47.32, 8.63, 47.44] }],
  };
  await withServer({ layersFetch, layersOptions }, async (base) => {
    const { groups } = await (await fetch(`${base}/api/layers`)).json();
    const ids = [groups[1].layers[0].id, groups.at(-1).layers[0].id];
    assert.equal((await fetch(`${base}/api/layers/info?lat=x`)).status, 400);
    const d = await (await fetch(`${base}/api/layers/info?lat=47.37&lon=8.54&layers=${ids.join(',')}`)).json();
    assert.deepEqual(d.items, [
      { id: ids[0], title: 'Bevölkerung (STATPOP)', attributes: [['reli', '67251234'], ['number', '38'], ['i year', '2023']] },
      { id: ids[1], title: 'Baumstandorte', attributes: [['baumnamedeu', 'Spitz-Ahorn'], ['pflanzjahr', '1987']] },
    ]);
    const identify = new URL(asked.find((u) => u.startsWith('https://identify.example/')));
    assert.equal(identify.searchParams.get('layers'), 'all:ch.bfs.volkszaehlung-bevoelkerungsstatistik_einwohner');
    const gfi = new URL(asked.find((u) => u.includes('GetFeatureInfo')));
    assert.deepEqual([gfi.searchParams.get('QUERY_LAYERS'), gfi.searchParams.get('INFO_FORMAT'), gfi.searchParams.get('I')], ['baumkataster_baumstandorte', 'application/json', '50']);
  });
});

test('every layer of geo.admin.ch by search or by name (shared links), identify for them, heights of points', async () => {
  const asked = [];
  const layersFetch = async (url) => {
    asked.push(url);
    if (url.includes('GetCapabilities')) return new Response(GEOADMIN);
    if (url.startsWith('https://identify.example/')) return Response.json({ results: [{ layerBodId: 'ch.are.gueteklassen_oev', layerName: 'ÖV-Güteklassen', attributes: { klasse: 'B' } }] });
    if (url.startsWith('https://height.example/')) {
      const q = new URL(url).searchParams;
      return Number(q.get('easting')) > 2700000 ? new Response('', { status: 500 }) : Response.json({ height: '408.7' });
    }
    return new Response('', { status: 404 });
  };
  const layersOptions = { geoadminUrl: 'https://wms.example/', identifyUrl: 'https://identify.example/identify', heightUrl: 'https://height.example/height', regional: [] };
  await withServer({ layersFetch, layersOptions }, async (base) => {
    // The search: every word in the title or name, titles first; the base maps are found too.
    const s = await (await fetch(`${base}/api/layers/geoadmin?q=${encodeURIComponent('güte')}`)).json();
    assert.deepEqual(s.layers.map((l) => [l.id, l.name, l.title, l.geoadmin, l.info]), [['ga:ch.are.gueteklassen_oev', 'ch.are.gueteklassen_oev', 'ÖV-Güteklassen', true, true]]);
    assert.match(s.layers[0].legend, /GetLegendGraphic/);
    assert.equal((await (await fetch(`${base}/api/layers/geoadmin?q=landeskarte`)).json()).layers[0].name, 'ch.swisstopo.pixelkarte-farbe');
    assert.equal((await fetch(`${base}/api/layers/geoadmin`)).status, 400);
    // By name, as a link of map.geo.admin.ch names them; unknown ones are listed.
    const ids = await (await fetch(`${base}/api/layers/geoadmin?ids=ch.are.gueteklassen_oev,ch.bav.haltestellen-oev,<script>`)).json();
    assert.deepEqual(ids.layers.map((l) => l.id), ['ga:ch.are.gueteklassen_oev']);
    assert.deepEqual(ids.missing, ['ch.bav.haltestellen-oev']);
    // What is here also for those layers.
    const d = await (await fetch(`${base}/api/layers/info?lat=47.37&lon=8.54&layers=ga:ch.are.gueteklassen_oev`)).json();
    assert.deepEqual(d.items, [{ id: 'ga:ch.are.gueteklassen_oev', title: 'ÖV-Güteklassen', attributes: [['klasse', 'B']] }]);
    // Height: swissALTI3D through geo.admin.ch in LV95; where it fails, the terrain model (offline here: none).
    const h = await (await fetch(`${base}/api/layers/hoehe?lat=47.37&lon=8.54`)).json();
    assert.deepEqual(h, { elevation: 408.7, source: 'swissALTI3D (swisstopo)' });
    const q = new URL(asked.find((u) => u.startsWith('https://height.example/'))).searchParams;
    assert.equal(q.get('sr'), '2056');
    assert.ok(Math.abs(Number(q.get('easting')) - 2683000) < 1000);
    assert.deepEqual(await (await fetch(`${base}/api/layers/hoehe?lat=46.5&lon=9.9`)).json(), { elevation: null, source: null });
    assert.equal((await fetch(`${base}/api/layers/hoehe?lat=x&lon=1`)).status, 400);
  });
});

test('config names the vector style of the base map; maplibre-gl-leaflet is served', async () => {
  await withServer({}, async (base) => {
    const { basemap } = await (await fetch(`${base}/api/config`)).json();
    assert.equal(basemap.style, 'https://tiles.openfreemap.org/styles/positron');
    assert.match(basemap.attribution, /OpenStreetMap/);
    const res = await fetch(`${base}/vendor/maplibre-leaflet/leaflet-maplibre-gl.js`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /maplibreGL/);
  });
});
