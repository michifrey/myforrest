'use strict';

// Own routing server: wildlife rest areas as no-go areas (src/wildlife.js),
// BRouter's lenient HTTP (src/lenient-fetch.js), the forest profile.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { parseZones, parseSeason, inSeason, simplify, insideRing, createWildlife } = require('../src/wildlife');
const { lenientFetch } = require('../src/lenient-fetch');
const { wgs84ToLv95 } = require('../src/lv95');
const { createApp } = require('../src/app');

const square = (lat, lon, d = 0.003) => [[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]];
const feature = (props, ring) => ({ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [ring] } });

test('wildlife rest areas: protection period, LV95, simplified polygons', () => {
  assert.deepEqual(parseSeason('Betretungsverbot vom 20.12. bis 30.4.'), { from: [12, 20], to: [4, 30] });
  assert.equal(parseSeason('immer'), null);
  const winter = parseSeason('12-20/04-30');
  assert.deepEqual([new Date('2027-01-15'), new Date('2026-10-09'), new Date('2026-12-20')].map((d) => inSeason(winter, d)), [true, false, true]);

  // As BAFU delivers it: LV95, the period in the regulations.
  const lv = square(47.365, 8.59).map(([lon, lat]) => wgs84ToLv95(lat, lon));
  const zones = parseZones(JSON.stringify({
    type: 'FeatureCollection', crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::2056' } },
    features: [
      feature({ wrz_name: 'Adlisberg', bestimmungen: 'Wege nicht verlassen vom 15.12. bis 15.4.' }, lv),
      feature({ name: 'Sihlwald', schutz: 'ganzjährig' }, square(47.25, 8.55)),
      feature({ name: 'Ohne Angabe' }, square(47.30, 8.50)),
    ],
  }));
  assert.deepEqual(zones.map((z) => z.name), ['Adlisberg', 'Sihlwald', 'Ohne Angabe']);
  assert.ok(Math.abs(zones[0].rings[0][0][0] - 8.587) < 1e-4 && Math.abs(zones[0].rings[0][0][1] - 47.362) < 1e-4, 'LV95 → WGS84');
  assert.deepEqual([zones[0].season, zones[1].season, zones[2].season], [{ from: [12, 15], to: [4, 15] }, null, { from: [12, 20], to: [4, 30] }]);

  assert.equal(insideRing(zones[0].rings[0], 47.365, 8.59), true);
  assert.equal(insideRing(zones[0].rings[0], 47.36, 8.58), false);
  // A wiggly line of 400 points along a straight edge: a few points remain.
  const wiggle = Array.from({ length: 400 }, (_, i) => [8.5 + i * 0.0001, 47.3 + (i % 2) * 0.00001]);
  assert.ok(simplify(wiggle, 10).length < 5);
});

/** A zones file and a fake BRouter that records what it was asked. */
function withZones(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-wrz-'));
  const file = path.join(dir, 'wrz.geojson');
  fs.writeFileSync(file, JSON.stringify({ type: 'FeatureCollection', features: [
    feature({ name: 'Adlisberg', schutz: '20.12.–30.4.' }, square(47.365, 8.59)),
    feature({ name: 'Zürichberg', schutz: 'ganzjährig' }, square(47.38, 8.56)),
  ] }));
  return Promise.resolve(fn(file)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test('routing goes around zones in their protection period; a waypoint inside one is named', async () => {
  await withZones(async (file) => {
    const w = createWildlife({ file });
    const route = [{ lat: 47.36, lon: 8.58 }, { lat: 47.36, lon: 8.60 }];
    assert.deepEqual((await w.near(route, new Date('2027-01-10'))).zones.map((z) => z.name), ['Adlisberg', 'Zürichberg']);
    assert.deepEqual((await w.near(route, new Date('2026-10-09'))).zones.map((z) => z.name), ['Zürichberg']);
    const inside = await w.near([{ lat: 47.365, lon: 8.59 }, { lat: 47.36, lon: 8.60 }], new Date('2027-01-10'));
    assert.deepEqual([inside.zones.map((z) => z.name), inside.inside], [['Zürichberg'], ['Adlisberg']]);
    assert.match(w.polygonsParam(inside.zones), /^8\.557000,47\.377000,8\.563000,47\.377000,/);

    // Through the API: the zones go to BRouter as `polygons`.
    const asked = [];
    const routerFetch = async (url) => {
      asked.push(new URL(url));
      return new Response(JSON.stringify({ features: [{ geometry: { coordinates: [[8.58, 47.36, 500], [8.59, 47.355, 510], [8.60, 47.36, 505]] } }] }));
    };
    process.env.WILDRUHE_GEOJSON = file;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-route-'));
    const app = createApp({ dataDir, routerUrl: 'http://brouter:17777/brouter', routerFetch, routerProfile: 'myforrest-wald', weatherFetch: async () => new Response('', { status: 503 }) });
    delete process.env.WILDRUHE_GEOJSON;
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const r = await (await fetch(`${base}/api/route?points=47.36,8.58;47.36,8.60`)).json();
      assert.equal(r.points.length, 3);
      assert.equal(asked[0].searchParams.get('profile'), 'myforrest-wald');
      assert.ok(asked[0].searchParams.get('polygons').split('|').length >= 1);
      assert.ok(r.wildlifeZones.includes('Zürichberg'));
      const cfg = await (await fetch(`${base}/api/config`)).json();
      assert.equal(cfg.wildlifeZones, true);
      const map = await (await fetch(`${base}/api/wildlife-zones?bbox=8.5,47.3,8.7,47.4`)).json();
      assert.ok(map.features.some((f) => f.properties.name === 'Zürichberg' && f.properties.season === 'ganzjährig'));
    } finally {
      await app.locals.idle();
      server.close();
      app.locals.db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

test('wildlife rest areas straight from geo.admin.ch: per cell, kept, asked again after a week', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const asked = [];
  let up = true;
  // The identify service as geo.admin.ch answers: GeoJSON features in LV95, the period in an attribute.
  const lv = square(47.365, 8.59).map(([lon, lat]) => wgs84ToLv95(lat, lon));
  const fetchImpl = async (url) => {
    const u = new URL(url);
    asked.push(u);
    if (!up) return new Response('busy', { status: 503 });
    return Response.json({ results: [
      { type: 'Feature', featureId: 4711, layerBodId: 'ch.bafu.wrz-wildruhezonen_portal', properties: { wrz_name: 'Adlisberg', bestimmungen: 'vom 20.12. bis 30.4.' }, geometry: { type: 'Polygon', coordinates: [lv] } },
      { type: 'Feature', featureId: 4712, properties: { wrz_name: 'Ohne Fläche' } },
    ] });
  };
  let t = Date.parse('2027-01-10T08:00:00Z');
  const make = () => createWildlife({ file: '', layer: 'ch.bafu.wrz-wildruhezonen_portal', db, fetchImpl, now: () => t });
  const w = make();
  assert.equal(w.enabled(), true);
  const route = [{ lat: 47.36, lon: 8.58 }, { lat: 47.36, lon: 8.60 }];
  const r = await w.near(route, new Date('2027-01-10'));
  assert.deepEqual(r.zones.map((z) => z.name), ['Adlisberg']);
  const first = asked.length;
  assert.ok(first >= 1 && first <= 4, String(first));
  const q = asked[0].searchParams;
  assert.equal(q.get('layers'), 'all:ch.bafu.wrz-wildruhezonen_portal');
  assert.equal(q.get('geometryFormat'), 'geojson');
  assert.equal(q.get('sr'), '2056');
  assert.ok(Number(q.get('geometry').split(',')[0]) > 2e6, 'box in LV95');
  // Zones spanning several cells count once; out of season they are not sent.
  assert.equal((await w.within([8.0, 47.0, 9.0, 47.6], new Date('2027-01-10'))).length, 1);
  assert.deepEqual((await w.near(route, new Date('2026-10-09'))).zones, []);
  // Kept in the database: a restarted server asks nothing within the week …
  const again = make();
  assert.deepEqual((await again.near(route, new Date('2027-01-10'))).zones.map((z) => z.name), ['Adlisberg']);
  assert.equal(asked.length, first);
  // … and after it asks again; when geo.admin.ch fails, the kept zones stay in use.
  t += 8 * 86400000;
  up = false;
  assert.deepEqual((await again.near(route, new Date('2027-01-10'))).zones.map((z) => z.name), ['Adlisberg']);
  assert.ok(asked.length > first);
  // A large map section does not fetch cells it has never seen.
  const fresh = createWildlife({ file: '', layer: 'x', fetchImpl, now: () => t });
  asked.length = 0;
  assert.deepEqual(await fresh.within([5.9, 45.8, 10.5, 47.8]), []);
  assert.equal(asked.length, 0);
  db.close();
});

test("BRouter's own server: header lines with a bare \\n, gzip body", async () => {
  const body = zlib.gzipSync(JSON.stringify({ type: 'FeatureCollection', features: [] }));
  const server = net.createServer((sock) => {
    sock.once('data', () => {
      sock.write('HTTP/1.1 200 OK\nConnection: close\nContent-Type: application/geo+json; charset=utf-8\nContent-Encoding: gzip\n\n');
      sock.end(body);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/brouter?lonlats=8.58,47.36|8.6,47.36`;
  try {
    await assert.rejects(fetch(url), 'the plain fetch refuses it');
    const r = await lenientFetch(url);
    assert.equal(r.ok, true);
    assert.deepEqual(await r.json(), { type: 'FeatureCollection', features: [] });
  } finally {
    server.close();
  }
});

test('the forest profile is in the BRouter image and uses only values BRouter knows', () => {
  const dir = path.join(__dirname, '..', 'deploy', 'brouter');
  const profile = fs.readFileSync(path.join(dir, 'profiles', 'myforrest-wald.brf'), 'utf8');
  assert.match(fs.readFileSync(path.join(dir, 'Dockerfile'), 'utf8'), /COPY profiles\/\*\.brf \/opt\/brouter\/profiles2\//);
  for (const ctx of ['---context:global', '---context:way', '---context:node']) assert.ok(profile.includes(ctx), ctx);
  assert.match(profile, /assign costfactor/);
  // BRouter's lookups.dat knows "forestry" only as a synonym of "agricultural": using it breaks the profile.
  assert.doesNotMatch(profile.replace(/#.*$/gm, ''), /access=[^\s]*forestry/);
});
