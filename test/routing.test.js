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
    assert.deepEqual(w.near(route, new Date('2027-01-10')).zones.map((z) => z.name), ['Adlisberg', 'Zürichberg']);
    assert.deepEqual(w.near(route, new Date('2026-10-09')).zones.map((z) => z.name), ['Zürichberg']);
    const inside = w.near([{ lat: 47.365, lon: 8.59 }, { lat: 47.36, lon: 8.60 }], new Date('2027-01-10'));
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
