'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { DatabaseSync } = require('node:sqlite');
const { createApp } = require('../src/app');
const { createWaynet, parseOverpass, buildGraph, reachAlong } = require('../src/waynet');
const { alignImages } = require('../src/align');

// A T-shaped path network near 47.37 N, 8.54 E (1 m ≈ 0.000009° lat, 0.0000132° lon):
// a path from west to east through the start, and a branch north from 40 m east of it.
const LAT = 47.37;
const LON = 8.54;
const M_LAT = 1 / 111320;
const M_LON = M_LAT / Math.cos((LAT * Math.PI) / 180);
const at = (eastM, northM) => ({ lat: LAT + northM * M_LAT, lon: LON + eastM * M_LON });
const OVERPASS = {
  elements: [
    { type: 'way', id: 1, nodes: [10, 11, 12, 13], tags: { highway: 'path', name: 'Waldweg' }, geometry: [at(-120, 0), at(0, 0), at(40, 0), at(250, 0)] },
    { type: 'way', id: 2, nodes: [12, 20], tags: { highway: 'track' }, geometry: [at(40, 0), at(40, 120)] },
    { type: 'node', id: 99, lat: LAT, lon: LON },
  ],
};

test('path network: along the paths, in the direction the path leaves, the nearest per direction', () => {
  const ways = parseOverpass(OVERPASS);
  assert.deepEqual(ways.map((w) => [w.id, w.highway, w.nodes.length]), [[1, 'path', 4], [2, 'track', 2]]);
  const graph = buildGraph(ways);
  const targets = [
    { name: 'abzweigung', ...at(42, 60) }, // on the branch: 40 m east, then 60 m north
    { name: 'weit-ost', ...at(200, 2) }, // further along the main path, same leaving direction
    { name: 'west', ...at(-50, -3) },
    { name: 'neben', ...at(10, 40) }, // close, but 40 m from any path
  ];
  const r = reachAlong(graph, at(0, 4), targets);
  assert.equal(r.onPath, true);
  assert.deepEqual(r.links.map((l) => l.target.name), ['west', 'abzweigung']);
  const [west, branch] = r.links;
  assert.ok(Math.abs(west.bearing - 270) < 2, String(west.bearing));
  assert.ok(Math.abs(west.distanceM - 50) <= 1, String(west.distanceM));
  // The branch target lies north-east, but the path leaves to the east, 100 m along it.
  assert.ok(Math.abs(branch.bearing - 90) < 2, String(branch.bearing));
  assert.ok(Math.abs(branch.distanceM - 100) <= 2, String(branch.distanceM));
  assert.equal(branch.path.length, 4); // start, junction (node 12), … the snapped end
  // Beyond 300 m along the paths nothing is reached; off the network there are no arrows.
  assert.deepEqual(reachAlong(graph, at(0, 0), [at(40, 120)], { maxM: 100 }).links, []);
  assert.deepEqual(reachAlong(graph, at(0, 80), targets), { onPath: false, links: [] });
});

test('path network: fetched per cell from Overpass, cached', async () => {
  const db = new DatabaseSync(':memory:');
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, query: new URLSearchParams(opts.body).get('data') });
    return Response.json(OVERPASS);
  };
  const net = createWaynet({ db, url: 'https://overpass.example/api/interpreter', fetchImpl });
  assert.equal(net.enabled(), true);
  const r = await net.reach(at(0, 0), [{ id: 1, ...at(-50, 0) }]);
  assert.equal(r.links.length, 1);
  assert.ok(r.ways.length === 2);
  const first = calls.length;
  assert.ok(first >= 1 && first <= 4, String(first));
  assert.match(calls[0].query, /way\["highway"\]/);
  assert.match(calls[0].query, /out geom;$/);
  await net.reach(at(0, 0), []);
  assert.equal(calls.length, first, 'cells come from the cache');
  assert.equal(createWaynet({ db, url: '' }).enabled(), false);
  db.close();
});

/* ---------- API ---------- */

async function withServer(opts, fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-wn-'));
  const app = createApp({ dataDir, weatherFetch: async () => new Response('offline', { status: 503 }), routerUrl: '', ...opts });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await app.locals.idle();
    server.close();
    app.locals.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function upload(base, blob, fields) {
  const fd = new FormData();
  fd.append('photos', blob, 'x.jpg');
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  const body = await (await fetch(`${base}/api/photos`, { method: 'POST', body: fd })).json();
  assert.equal(body.created?.length, 1, JSON.stringify(body));
  return body.created[0];
}
const plain = async (color) => new Blob([await sharp({ create: { width: 64, height: 48, channels: 3, background: color } }).jpeg().toBuffer()], { type: 'image/jpeg' });
const fixture = (name) => new Blob([fs.readFileSync(path.join(__dirname, 'fixtures', name))], { type: 'image/jpeg' });

test('walk API: arrows along the path network to spots up to 300 m away, the paths for the mini map', async () => {
  const waynetFetch = async () => Response.json(OVERPASS);
  await withServer({ waynetUrl: 'https://overpass.example/api/interpreter', waynetFetch }, async (base) => {
    const here = await upload(base, await plain('#4a6b3a'), { ...at(0, 3), takenAt: '2026-05-01T08:00:00Z' });
    const branch = await upload(base, await plain('#6b4a3a'), { ...at(41, 150 - 40), takenAt: '2026-05-01T08:05:00Z' });
    const near = await upload(base, await plain('#3a4a6b'), { ...at(-60, 1), takenAt: '2026-05-01T08:10:00Z' });
    const w = await (await fetch(`${base}/api/walk/${here.id}`)).json();
    const pfad = w.links.filter((l) => l.kind === 'pfad');
    assert.deepEqual(pfad.map((l) => l.id).sort((a, b) => a - b), [branch.id, near.id].sort((a, b) => a - b));
    const toBranch = pfad.find((l) => l.id === branch.id);
    assert.ok(Math.abs(toBranch.bearing - 90) < 2, String(toBranch.bearing));
    assert.ok(Math.abs(toBranch.distanceM - 150) <= 3, String(toBranch.distanceM));
    assert.ok(toBranch.straightM < toBranch.distanceM);
    assert.ok(toBranch.path.length >= 3);
    // A spot reached along a path is not shown a second time as a spot nearby.
    assert.equal(w.links.filter((l) => l.kind === 'spot' && l.id === near.id).length, 0);
    assert.equal(w.paths.length, 2);
  });
});

test('walk API: without the network (Overpass down) the other arrows remain', async () => {
  const waynetFetch = async () => new Response('busy', { status: 429 });
  await withServer({ waynetUrl: 'https://overpass.example/api/interpreter', waynetFetch }, async (base) => {
    const here = await upload(base, await plain('#4a6b3a'), { ...at(0, 3), takenAt: '2026-05-01T08:00:00Z' });
    const near = await upload(base, await plain('#3a4a6b'), { ...at(-60, 1), takenAt: '2026-05-01T08:10:00Z' });
    const w = await (await fetch(`${base}/api/walk/${here.id}`)).json();
    assert.deepEqual(w.links.map((l) => [l.kind, l.id]), [['spot', near.id]]);
    assert.deepEqual(w.paths, []);
  });
});

test('walk API: how one flat photo lies in another, for a step with depth', async () => {
  await withServer({}, async (base) => {
    const a = await upload(base, fixture('align-a.jpg'), { ...at(0, 0), takenAt: '2025-05-01T08:00:00Z', heading: 0 });
    // 40 m further: another spot, seeing the same scene.
    const b = await upload(base, fixture('align-b.jpg'), { ...at(0, 40), takenAt: '2026-05-01T08:00:00Z', heading: 180 });
    assert.notEqual(a.spotId, b.spotId);
    const r = await (await fetch(`${base}/api/walk/transition/${b.id}/${a.id}`)).json();
    const direct = await alignImages(path.join(__dirname, 'fixtures', 'align-b.jpg'), path.join(__dirname, 'fixtures', 'align-a.jpg'));
    assert.ok(r.h, 'transform found');
    r.h.forEach((v, i) => assert.ok(Math.abs(v - direct.h[i]) < 1e-6, `h[${i}]`));
    // Asked again: from the table.
    assert.deepEqual((await (await fetch(`${base}/api/walk/transition/${b.id}/${a.id}`)).json()).h, r.h);
    // Unrelated pictures: no transform. Bad and unknown ids.
    const other = await upload(base, fixture('align-other.jpg'), { ...at(0, 80), takenAt: '2026-05-02T08:00:00Z' });
    assert.equal((await (await fetch(`${base}/api/walk/transition/${other.id}/${a.id}`)).json()).h, null);
    assert.equal((await fetch(`${base}/api/walk/transition/${a.id}/${a.id}`)).status, 400);
    assert.equal((await fetch(`${base}/api/walk/transition/${a.id}/9999`)).status, 404);
  });
});

test('walk API: between two panoramas the rotation of the sphere, so one looks at the same scenery', async () => {
  const sphere = require('../src/sphere');
  const { alignPanoramas } = require('../src/align');
  const [PW, PH] = [2048, 1024];
  const { data } = await sharp(path.join(__dirname, 'fixtures', 'align-a.jpg')).resize(PW, PH, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const xmp = '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:GPano="http://ns.google.com/photos/1.0/panorama/" GPano:ProjectionType="equirectangular"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
  const jpeg = (raw) => sharp(raw, { raw: { width: PW, height: PH, channels: 3 } }).jpeg({ quality: 92 }).withXmp(xmp).toBuffer();
  const bufA = await jpeg(data);
  const bufB = await jpeg(sphere.remap({ data, width: PW, height: PH }, sphere.fromAngles(70, 3, 0), PW, PH));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-wnp-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.jpg'), bufA);
    fs.writeFileSync(path.join(dir, 'b.jpg'), bufB);
    const direct = await alignPanoramas(path.join(dir, 'a.jpg'), path.join(dir, 'b.jpg'));
    assert.ok(direct, 'the two panoramas match');
    await withServer({}, async (base) => {
      const blob = (buf) => new Blob([buf], { type: 'image/jpeg' });
      const a = await upload(base, blob(bufA), { ...at(0, 0), takenAt: '2025-05-01T08:00:00Z' });
      const b = await upload(base, blob(bufB), { ...at(0, 40), takenAt: '2026-05-01T08:00:00Z' });
      assert.equal(a.panorama, true);
      assert.notEqual(a.spotId, b.spotId);
      const r = await (await fetch(`${base}/api/walk/transition/${a.id}/${b.id}`)).json();
      assert.ok(r.r, 'rotation found');
      assert.equal(r.h, undefined);
      r.r.forEach((v, i) => assert.ok(Math.abs(v - direct.r[i]) < 1e-6, `r[${i}]`));
      // Between a panorama and a flat photo: nothing.
      const flat = await upload(base, fixture('align-a.jpg'), { ...at(0, 80), takenAt: '2026-05-02T08:00:00Z' });
      assert.deepEqual(await (await fetch(`${base}/api/walk/transition/${a.id}/${flat.id}`)).json(), { r: null, inliers: null });
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('walk API: from a Mapillary picture, arrows along the paths to own pictures', async () => {
  const item = { id: '5001', computed_geometry: { type: 'Point', coordinates: [at(0, 3).lon, at(0, 3).lat] }, computed_compass_angle: 90, captured_at: Date.parse('2024-06-01T10:00:00Z'), is_pano: true, sequence: 'seqX' };
  const mapillaryFetch = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/images') return Response.json({ data: [item] });
    if (u.pathname === '/5001') return Response.json(item);
    return new Response('{}', { status: 404 });
  };
  await withServer({ waynetUrl: 'https://overpass.example/api/interpreter', waynetFetch: async () => Response.json(OVERPASS), mapillaryToken: 'MLY|test', mapillaryFetch }, async (base) => {
    const branch = await upload(base, await plain('#6b4a3a'), { ...at(41, 110), takenAt: '2026-05-01T08:05:00Z' });
    const w = await (await fetch(`${base}/api/walk/mapillary/5001`)).json();
    const pfad = w.links.filter((l) => l.kind === 'pfad');
    assert.deepEqual(pfad.map((l) => l.id), [branch.id]);
    assert.ok(Math.abs(pfad[0].bearing - 90) < 2 && Math.abs(pfad[0].distanceM - 150) <= 3, JSON.stringify(pfad[0]));
    assert.equal(w.paths.length, 2);
  });
});
