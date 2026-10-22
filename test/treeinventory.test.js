'use strict';

// Tree inventory (Geneva, SITG) as species suggestions for a spot.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { groupTrees, binomial } = require('../src/treeinventory');
const { createApp } = require('../src/app');

// An ArcGIS query result as the ICA layer answers it (WGS84 because of outSR=4326).
const SPOT = { lat: 46.2, lon: 6.14 };
const tree = (latin, common, dLat, extra = {}) => ({
  attributes: { OBJECTID: Math.round(dLat * 1e7), NOM_LATIN: latin, NOM_COMMUN: common, HAUTEUR_TOTALE: 18, DIAMETRE_COURONNE: 9, REMARQUABLE: 0, ...extra },
  geometry: { x: SPOT.lon, y: SPOT.lat + dLat },
});
const FEATURES = [
  tree('Fagus sylvatica L.', 'Hêtre commun', 0.0002, { HAUTEUR_TOTALE: 31, REMARQUABLE: 1 }),
  tree('Fagus sylvatica', 'Hêtre commun', 0.0003),
  tree('Quercus robur L.', 'Chêne pédonculé', 0.0001),
  tree('Platanus x hispanica Mill. ex Münchh.', 'Platane commun', 0.00025),
  tree('Acer pseudoplatanus', 'Erable sycomore', 0.00005, { ETAT: 'Abattu' }),
  tree('', '', 0.0001),
];

test('inventory trees are grouped by species, nearest first; felled trees and empty names are left out', () => {
  const { trees, species } = groupTrees(FEATURES, SPOT.lat, SPOT.lon);
  assert.equal(trees, 4);
  assert.deepEqual(species.map((s) => [s.scientificName, s.count, s.nearestM, s.known]), [
    ['Quercus robur', 1, 11, true],
    ['Fagus sylvatica', 2, 22, true],
    ['Platanus ×hispanica', 1, 28, false],
  ]);
  const beech = species[1];
  assert.deepEqual([beech.name, beech.commonName, beech.maxHeight, beech.remarkable], ['Rotbuche', 'Hêtre commun', 31, 1]);
  assert.equal(binomial('Tilia cordata Mill.'), 'Tilia cordata');
});

async function withServer(opts, fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-baeume-'));
  const app = createApp({ dataDir, weatherFetch: async () => new Response('offline', { status: 503 }), ...opts });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`, dataDir);
  } finally {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test('GET /api/spots/:id/tree-inventory: suggestions inside the area, cached, with what the spot already has', async () => {
  const urls = [];
  const treeInventoryFetch = async (url) => {
    urls.push(url);
    return Response.json({ features: FEATURES });
  };
  await withServer({ treeInventoryFetch, treeInventoryOptions: { url: 'https://ge.example/ICA/MapServer/1' }, treeInventoryZurich: '' }, async (base, dataDir) => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(dataDir, 'myforrest.db'));
    const spot = (lat, lon) => {
      const id = Number(db.prepare('INSERT INTO spots (lat, lon, created_at) VALUES (?, ?, 0)').run(lat, lon).lastInsertRowid);
      db.prepare(`INSERT INTO photos (spot_id, file, taken_at, lat, lon, location_source, created_at) VALUES (?, ?, 1, ?, ?, 'exif', 0)`).run(id, `f${id}.jpg`, lat, lon);
      return id;
    };
    const geneva = spot(SPOT.lat, SPOT.lon);
    const zurich = spot(47.37, 8.55);
    db.prepare("INSERT INTO spot_species (spot_id, scientific_name, source, created_at) VALUES (?, 'Fagus sylvatica', 'manual', 0)").run(geneva);
    db.close();

    const d = await (await fetch(`${base}/api/spots/${geneva}/tree-inventory`)).json();
    assert.equal(d.covered, true);
    assert.equal(d.radiusM, 40);
    assert.equal(d.trees, 4);
    assert.deepEqual(d.species.map((s) => [s.scientificName, s.atSpot]), [['Quercus robur', false], ['Fagus sylvatica', true], ['Platanus ×hispanica', false]]);
    const q = new URL(urls[0]);
    assert.equal(q.pathname, '/ICA/MapServer/1/query');
    assert.deepEqual([q.searchParams.get('geometry'), q.searchParams.get('distance'), q.searchParams.get('outSR')], ['6.14,46.2', '40', '4326']);
    await fetch(`${base}/api/spots/${geneva}/tree-inventory`);
    assert.equal(urls.length, 1, 'cached');

    const outside = await (await fetch(`${base}/api/spots/${zurich}/tree-inventory`)).json();
    assert.deepEqual([outside.covered, outside.species], [false, []]);
    assert.equal(urls.length, 1, 'no query outside Geneva');
    assert.equal((await fetch(`${base}/api/spots/999/tree-inventory`)).status, 404);
  });
});

test('tree inventory not reachable: an error to show, no suggestions', async () => {
  const treeInventoryFetch = async () => Response.json({ error: { code: 500, message: 'Service unavailable' } });
  await withServer({ treeInventoryFetch }, async (base, dataDir) => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(dataDir, 'myforrest.db'));
    const id = Number(db.prepare('INSERT INTO spots (lat, lon, created_at) VALUES (46.2, 6.14, 0)').run().lastInsertRowid);
    db.prepare("INSERT INTO photos (spot_id, file, taken_at, lat, lon, location_source, created_at) VALUES (?, 'a.jpg', 1, 46.2, 6.14, 'exif', 0)").run(id);
    db.close();
    const d = await (await fetch(`${base}/api/spots/${id}/tree-inventory`)).json();
    assert.deepEqual([d.covered, d.species, d.error], [true, [], 'Bauminventar: Service unavailable']);
    assert.equal(d.name, 'Bauminventar des Kantons Genf (SITG)');
  });
});

test('the tree register of Zürich through WFS: feature type from the capabilities, genus and species put together, LV95 to WGS84', async () => {
  const { wgs84ToLv95 } = require('../src/lv95');
  const spot = { lat: 47.3744, lon: 8.5410 };
  const at = (dE, dN) => { const [e, n] = wgs84ToLv95(spot.lat, spot.lon); return [e + dE, n + dN]; };
  const urls = [];
  const treeInventoryFetch = async (url) => {
    urls.push(url);
    if (url.includes('GetCapabilities')) {
      return new Response('<wfs:WFS_Capabilities><FeatureTypeList><FeatureType><Name>poi_x</Name></FeatureType><FeatureType><Name>baumkataster_baumstandorte</Name></FeatureType></FeatureTypeList></wfs:WFS_Capabilities>');
    }
    return Response.json({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { baumgattunglat: 'Tilia', baumartlat: 'cordata', baumnamedeu: 'Winter-Linde', baumtyp: 'Strassenbaum' }, geometry: { type: 'Point', coordinates: at(8, 6) } },
        { type: 'Feature', properties: { baumgattunglat: 'Acer', baumartlat: 'platanoides', baumnamedeu: 'Spitz-Ahorn' }, geometry: { type: 'Point', coordinates: at(-20, 15) } },
        { type: 'Feature', properties: { baumgattunglat: 'Acer', baumartlat: 'platanoides', baumnamedeu: 'Spitz-Ahorn' }, geometry: { type: 'Point', coordinates: at(39, 39) } }, // corner of the square, beyond the radius
      ],
    });
  };
  await withServer({ treeInventoryFetch, treeInventoryZurich: 'https://zh.example/wfs/geoportal/Baumkataster' }, async (base, dataDir) => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(dataDir, 'myforrest.db'));
    const id = Number(db.prepare('INSERT INTO spots (lat, lon, created_at) VALUES (?, ?, 0)').run(spot.lat, spot.lon).lastInsertRowid);
    db.prepare("INSERT INTO photos (spot_id, file, taken_at, lat, lon, location_source, created_at) VALUES (?, 'a.jpg', 1, ?, ?, 'exif', 0)").run(id, spot.lat, spot.lon);
    db.close();
    const d = await (await fetch(`${base}/api/spots/${id}/tree-inventory`)).json();
    assert.equal(d.name, 'Baumkataster der Stadt Zürich');
    assert.deepEqual(d.species.map((s) => [s.scientificName, s.name, s.commonName, s.count, s.nearestM]), [
      ['Tilia cordata', 'Winterlinde', 'Winter-Linde', 1, 10],
      ['Acer platanoides', 'Spitzahorn', 'Spitz-Ahorn', 1, 25],
    ]);
    const q = new URL(urls[1]).searchParams;
    assert.deepEqual([q.get('TYPENAME'), q.get('SRSNAME'), q.get('OUTPUTFORMAT')], ['baumkataster_baumstandorte', 'EPSG:2056', 'GeoJSON']);
  });
});
