'use strict';

// Landschaft im Wandel: official maps through time, layers per theme, and the report per place.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');

const CAPS = `<?xml version="1.0"?><WMS_Capabilities><Service><Title>WMS BGDI</Title></Service><Capability><Layer><Title>WMS BGDI</Title>
${[
    ['ch.swisstopo.hiks-dufour', 'Dufourkarte Erstausgabe'],
    ['ch.swisstopo.geologie-eiszeit-lgm-raster', 'Letzteiszeitliches Maximum (LGM)'],
    ['ch.bafu.wald-vegetationshoehenstufen_1975', 'Vegetationshöhenstufen'],
    ['ch.bafu.wald-vegetationshoehenstufen_2085_trocken', 'Vegetationshöhenstufen 2085 trocken'],
    ['ch.bafu.landesforstinventar-waldmischungsgrad', 'Waldmischungsgrad'],
    ['ch.meteoschweiz.klimanormwerte-temperatur_aktuelle_periode', 'Klimanormwerte Temperatur'],
    ['ch.bfs.arealstatistik', 'Arealstatistik'],
    ['ch.swisstopo.pixelkarte-farbe', 'Landeskarte'],
  ].map(([n, t]) => `<Layer queryable="1"><Name>${n}</Name><Title>${t}</Title></Layer>`).join('\n')}
</Layer></Capability></WMS_Capabilities>`;

async function withServer(fn, { wmts = null } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-landschaft-'));
  const identified = [];
  const layersFetch = async (url) => {
    if (url.startsWith('https://identify.example/')) {
      const names = new URL(url).searchParams.get('layers').replace(/^all:/, '').split(',');
      identified.push(names);
      const results = [];
      if (names.includes('ch.bafu.wald-vegetationshoehenstufen_1975')) results.push({ layerBodId: 'ch.bafu.wald-vegetationshoehenstufen_1975', layerName: 'Vegetationshöhenstufen', attributes: { id: 7, hoehenstufe: 'obermontan' } });
      if (names.includes('ch.bafu.wald-vegetationshoehenstufen_2085_trocken')) results.push({ layerBodId: 'ch.bafu.wald-vegetationshoehenstufen_2085_trocken', layerName: 'Vegetationshöhenstufen 2085 trocken', attributes: { hoehenstufe: 'submontan' } });
      if (names.includes('ch.bfs.arealstatistik')) results.push({ layerBodId: 'ch.bfs.arealstatistik', layerName: 'Arealstatistik', attributes: { nutzung: 'Wald' } });
      return Response.json({ results });
    }
    if (url.startsWith('https://wms.example/')) return new Response(CAPS);
    if (wmts && url === 'https://wmts.example/WMTSCapabilities.xml') return new Response(wmts);
    return new Response('', { status: 503 });
  };
  const app = createApp({
    dataDir, weatherFetch: async () => new Response('offline', { status: 503 }), tileOptions: { precompute: false },
    layersFetch, layersOptions: { geoadminUrl: 'https://wms.example/', identifyUrl: 'https://identify.example/identify', regional: [] },
    landschaftOptions: { zeitreiseUrl: 'https://wmts.example/WMTSCapabilities.xml' },
  });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`, app.locals.db, identified);
  } finally {
    await app.locals.idle();
    server.close();
    app.locals.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test('Landschaft im Wandel: maps through time where the layers exist, layers per theme', async () => {
  await withServer(async (base) => {
    const d = await (await fetch(`${base}/api/landschaft/karten`)).json();
    // Siegfried and the 2085 «less dry» map are missing in these capabilities, so they are left out.
    assert.deepEqual(d.timeline.map((t) => t.id), ['eiszeit', 'dufour', 'heute', 'wald-heute', 'wald-2085-t']);
    const heute = d.timeline.find((t) => t.id === 'heute');
    assert.ok(heute.base && !heute.layer, 'today is the Landeskarte underneath');
    const dufour = d.timeline.find((t) => t.id === 'dufour');
    assert.deepEqual([dufour.layer.name, dufour.layer.url], ['ch.swisstopo.hiks-dufour', 'https://wms.example/']);
    assert.match(dufour.layer.legend, /GetLegendGraphic.*LAYER=ch\.swisstopo\.hiks-dufour/);
    const themes = Object.fromEntries(d.themes.map((t) => [t.id, t.layers.map((l) => l.name)]));
    assert.deepEqual(themes.wald, ['ch.bafu.wald-vegetationshoehenstufen_1975', 'ch.bafu.wald-vegetationshoehenstufen_2085_trocken', 'ch.bafu.landesforstinventar-waldmischungsgrad']);
    assert.deepEqual(themes.boden, ['ch.bfs.arealstatistik']);
    assert.deepEqual(themes.klima, ['ch.meteoschweiz.klimanormwerte-temperatur_aktuelle_periode']);
    assert.deepEqual(themes.wasser, []);
  });
});

test('Landschaft im Wandel: the report asks the layers of each theme at the place and adds what MyForrest saw', async () => {
  await withServer(async (base, db, identified) => {
    const now = Date.now();
    const spot = db.prepare('INSERT INTO spots (lat, lon, created_at) VALUES (46.4, 8.0, ?)').run(now).lastInsertRowid;
    for (const [year, tag] of [[2021, 'borkenkaefer'], [2024, null]]) {
      const photo = db.prepare(`INSERT INTO photos (spot_id, file, taken_at, lat, lon, location_source, created_at) VALUES (?, ?, ?, 46.4, 8.0, 'exif', ?)`)
        .run(spot, `p${year}.jpg`, Date.UTC(year, 5, 1), now).lastInsertRowid;
      if (tag) db.prepare('INSERT INTO photo_tags (photo_id, tag) VALUES (?, ?)').run(photo, tag);
    }
    // Far away: not in the report.
    const far = db.prepare('INSERT INTO spots (lat, lon, created_at) VALUES (47.4, 8.5, ?)').run(now).lastInsertRowid;
    db.prepare(`INSERT INTO photos (spot_id, file, taken_at, lat, lon, location_source, created_at) VALUES (?, 'far.jpg', ?, 47.4, 8.5, 'exif', ?)`).run(far, now, now);

    const r = await (await fetch(`${base}/api/landschaft/bericht?lat=46.4&lon=8.001`)).json();
    const wald = r.themes.find((t) => t.id === 'wald');
    assert.deepEqual(wald.items.map((i) => [i.title, i.attributes]), [
      ['Vegetationshöhenstufen', [['hoehenstufe', 'obermontan']]],
      ['Vegetationshöhenstufen 2085 trocken', [['hoehenstufe', 'submontan']]],
    ], 'ids are left out');
    assert.deepEqual(r.themes.find((t) => t.id === 'boden').items[0].attributes, [['nutzung', 'Wald']]);
    assert.deepEqual(r.themes.find((t) => t.id === 'wasser').items, []);
    assert.ok(identified.some((names) => names.includes('ch.meteoschweiz.klimanormwerte-temperatur_aktuelle_periode')));
    assert.equal(r.glacier, null, 'no inventories on this server');
    assert.deepEqual([r.observed.photos, r.observed.spots, r.observed.firstYear, r.observed.lastYear], [2, 1, 2021, 2024]);
    assert.deepEqual(r.observed.tags, [{ tag: 'borkenkaefer', label: 'Borkenkäfer', spots: 1 }]);

    assert.equal((await fetch(`${base}/api/landschaft/bericht?lat=x&lon=8`)).status, 400);
  });
});

test('Landschaft im Wandel is a page of its own, linked from the start page and cached for offline use', async () => {
  await withServer(async (base) => {
    const html = await (await fetch(`${base}/landschaft.html`)).text();
    for (const id of ['karte', 'bericht', 'daten']) assert.ok(html.includes(`id="${id}"`), id);
    for (const file of ['landschaft.js', 'landschaft.css', 'vendor/leaflet/leaflet.js']) {
      assert.ok(html.includes(file), file);
      assert.equal((await fetch(`${base}/${file}`)).status, 200, file);
    }
    const start = await (await fetch(`${base}/`)).text();
    assert.ok(start.includes('href="landschaft.html"'));
    assert.ok(start.includes('id="perspektiven"'));
    const sw = await (await fetch(`${base}/sw.js`)).text();
    for (const file of ['landschaft.html', 'landschaft.js', 'landschaft.css']) assert.ok(sw.includes(`'${file}'`), file);
    assert.ok(!sw.includes('landschaft-model.js') && !sw.includes('landschaft-oben.js'));
  });
});

test('Landschaft im Wandel: the «Zeitreise» of the Landeskarte with the years of the WMTS capabilities', async () => {
  const wmts = `<?xml version="1.0"?><Capabilities xmlns:ows="http://www.opengis.net/ows/1.1"><Contents>
<Layer><ows:Title>Landeskarte</ows:Title><ows:Identifier>ch.swisstopo.pixelkarte-farbe</ows:Identifier>
<Dimension><ows:Identifier>Time</ows:Identifier><Default>current</Default><Value>current</Value></Dimension></Layer>
<Layer><ows:Title>Zeitreise</ows:Title><ows:Identifier>ch.swisstopo.zeitreihen</ows:Identifier>
<Dimension><ows:Identifier>Time</ows:Identifier><Default>20211231</Default><Value>20211231</Value><Value>18641231</Value><Value>19501231</Value><Value>19501231</Value></Dimension></Layer>
</Contents></Capabilities>`;
  await withServer(async (base) => {
    const d = await (await fetch(`${base}/api/landschaft/karten`)).json();
    assert.deepEqual(d.timeline.map((t) => t.id), ['eiszeit', 'dufour', 'zeitreise', 'heute', 'wald-heute', 'wald-2085-t']);
    const z = d.timeline.find((t) => t.id === 'zeitreise');
    assert.equal(z.when, '1864–2021');
    assert.deepEqual(z.zeitreise.years, [{ year: 1864, time: '18641231' }, { year: 1950, time: '19501231' }, { year: 2021, time: '20211231' }], 'sorted, once each');
    assert.equal(z.zeitreise.tiles, 'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.zeitreihen/default/{time}/3857/{z}/{x}/{y}.png');
  }, { wmts });
  // Without capabilities there is no «Zeitreise», the rest stays.
  await withServer(async (base) => {
    const d = await (await fetch(`${base}/api/landschaft/karten`)).json();
    assert.ok(!d.timeline.some((t) => t.id === 'zeitreise'));
  });
});
