'use strict';

// Links in the syntax of map.geo.admin.ch (public/geoadmin-link.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../public/geoadmin-link.js');

const EXAMPLE = 'https://map.geo.admin.ch/#/map?lang=de&center=2729391.35,1137982.74&z=1.34&topic=ech&layers=ch.swisstopo.zeitreihen@year=1864,f;ch.bfs.gebaeude_wohnungs_register,f;ch.bav.haltestellen-oev,f;ch.swisstopo.swisstlm3d-wanderwege,f;ch.vbs.schiessanzeigen,f;ch.astra.wanderland-sperrungen_umleitungen,f&bgLayer=ch.swisstopo.pixelkarte-farbe';

test('a link of map.geo.admin.ch: place in LV95, zoom of the LV95 pyramid, layers with year and visibility', () => {
  const r = G.read(EXAMPLE);
  assert.ok(Math.abs(r.lat - 46.3807) < 1e-3 && Math.abs(r.lon - 9.1206) < 1e-3, `${r.lat} ${r.lon}`);
  // z 1.34: between 500 and 250 m per pixel, about Web Mercator zoom 8.1 at this latitude.
  assert.ok(Math.abs(r.zoom - 8.09) < 0.02, String(r.zoom));
  assert.deepEqual([r.bgLayer, r.topic, r.lang], ['ch.swisstopo.pixelkarte-farbe', 'ech', 'de']);
  assert.equal(r.layers.length, 6);
  assert.deepEqual(r.layers[0], { id: 'ch.swisstopo.zeitreihen', visible: false, opacity: null, params: { year: 1864 }, external: null });
  // Back: the same layers, and the same place within the precision of the formulas.
  const back = G.read(G.link({ lat: r.lat, lon: r.lon, zoom: r.zoom, layers: r.layers }));
  assert.deepEqual(back.layers, r.layers);
  assert.ok(Math.abs(back.lat - r.lat) < 1e-5 && Math.abs(back.zoom - r.zoom) < 0.01);
  assert.match(G.link({ lat: r.lat, lon: r.lon, zoom: r.zoom, layers: r.layers }), /layers=ch\.swisstopo\.zeitreihen@year=1864,f;ch\.bfs/);
});

test('the layers parameter: opacity, hidden, @year=none, external services with separators inside', () => {
  const list = [
    { id: 'ch.bafu.waldreservate', visible: true, opacity: 0.6, params: {} },
    { id: 'ch.swisstopo.swissimage-product', visible: false, opacity: 0.8, params: { year: null } },
    { id: 'x', visible: true, opacity: 1, params: {}, external: { type: 'WMS', url: 'https://wms.geo.gr.ch/natur?a=1,2;b@c', name: 'Wald;reservat' } },
    { id: 'k', visible: true, opacity: null, params: {}, external: { type: 'KML', url: 'https://example.org/a.kml', name: null } },
  ];
  const p = G.layersParam(list);
  assert.equal(p.split(';').length, 4, 'the separators inside are encoded');
  assert.match(p, /^ch\.bafu\.waldreservate,,0\.6;ch\.swisstopo\.swissimage-product@year=none,f,0\.8;WMS\|/);
  const back = G.parseLayers(p);
  assert.deepEqual(back.map((l) => [l.id, l.visible, l.opacity, l.params]), [
    ['ch.bafu.waldreservate', true, 0.6, {}], ['ch.swisstopo.swissimage-product', false, 0.8, { year: null }],
    ['Wald;reservat', true, null, {}], ['https://example.org/a.kml', true, null, {}],
  ]);
  assert.deepEqual(back[2].external, { type: 'WMS', url: 'https://wms.geo.gr.ch/natur?a=1,2;b@c', name: 'Wald;reservat' });
  assert.deepEqual(G.parseLayers(''), []);
});

test('zoom between the pyramids: Swiss z ↔ Web Mercator, old links with E/N in LV03', () => {
  for (const z of [0, 1.34, 7, 10.5, 13]) assert.ok(Math.abs(G.toSwissZoom(G.toMercatorZoom(z, 47), 47) - z) < 0.01, String(z));
  assert.equal(G.resolutionOf(8), 2.5);
  const old = G.read('?E=683000&N=248000&zoom=7');
  assert.ok(Math.abs(old.lat - 47.3776) < 1e-3 && Math.abs(old.lon - 8.5377) < 1e-3);
  assert.equal(G.read('?layers=a').lat, null);
});
