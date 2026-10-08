'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { planSplit } = require('../src/spots');

test('a spot splits by viewing direction; photos without one stay with the largest group', () => {
  const p = (id, heading, extra = {}) => ({ id, heading, takenAt: id * 1000, panorama: false, ...extra });
  const plan = planSplit([p(1, 10), p(2, 190), p(3, 20), p(4, null), p(5, 200), p(6, 15), p(7, 100, { panorama: true }), p(8, 355)]);
  assert.equal(plan.mixed, true);
  assert.deepEqual(plan.groups, [
    { heading: 10, photoIds: [1, 3, 6, 8, 4, 7] },
    { heading: 195, photoIds: [2, 5] },
  ]);
  // One direction (within ±45°), or none at all: nothing to split.
  assert.equal(planSplit([p(1, 80), p(2, 110), p(3, null)]).mixed, false);
  assert.deepEqual(planSplit([p(1, null), p(2, null)]), { mixed: false, groups: [{ heading: null, photoIds: [1, 2] }] });
  // A tighter tolerance splits more.
  assert.equal(planSplit([p(1, 80), p(2, 110)], 20).groups.length, 2);
});

test('splitting a spot moves the photos, keeps the place data and realigns', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-split-'));
  const offline = async () => new Response('offline', { status: 503 });
  const app = createApp({ dataDir, weatherFetch: offline, tileOptions: { precompute: false } });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const db = app.locals.db;
  const json = async (url, opts) => {
    const res = await fetch(`${base}${url}`, opts);
    return { status: res.status, body: await res.json() };
  };
  const post = (url, body) => json(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    // A spot from before directions existed: two photos to the east, two to the west, one without compass.
    const spot = Number(db.prepare('INSERT INTO spots (lat, lon, elevation, elevation_source, created_at) VALUES (47.36, 8.58, 640, \'manual\', 0)').run().lastInsertRowid);
    const photo = (heading, i) => {
      const file = `split-${i}.jpg`;
      fs.copyFileSync(path.join(__dirname, 'fixtures', i % 2 ? 'align-b.jpg' : 'align-a.jpg'), path.join(dataDir, 'uploads', file));
      return Number(db.prepare(`INSERT INTO photos (spot_id, file, taken_at, lat, lon, heading, location_source, created_at)
        VALUES (?, ?, ?, ?, 8.58, ?, 'exif', 0)`).run(spot, file, Date.UTC(2020 + i, 5, 1), 47.36 + i * 1e-5, heading).lastInsertRowid);
    };
    const [e1, w1, e2, w2, none] = [90, 270, 95, 265, null].map(photo);
    db.prepare("INSERT INTO spot_species (spot_id, scientific_name, source, created_at) VALUES (?, 'Fagus sylvatica', 'manual', 0)").run(spot);
    db.prepare("INSERT INTO spot_ndvi (spot_id, lat, lon, from_date, to_date, fetched_at, complete) VALUES (?, 47.36, 8.58, '2020-01-01', '2025-01-01', 0, 1)").run(spot);
    db.prepare("INSERT INTO spot_ndvi_scenes (spot_id, scene_id, date, cloud, ndvi, sensor, v, clear_fraction) VALUES (?, 's1', '2024-06-01', 3, 0.8, 'S2', 2, 1)").run(spot);
    // The spot has no direction: its photos disagree.
    assert.equal((await json(`/api/spots/${spot}`)).body.heading, null);

    const plan = (await json(`/api/spots/${spot}/split`)).body;
    assert.deepEqual(plan, { mixed: true, toleranceDeg: 45, groups: [{ heading: 93, photoIds: [e1, e2, none] }, { heading: 268, photoIds: [w1, w2] }] });

    const versionBefore = (await json('/api/spots')).body.length;
    const { status, body } = await post(`/api/spots/${spot}/split`);
    assert.equal(status, 200, JSON.stringify(body));
    const [east, west] = body.spots;
    assert.equal(east.id, spot, 'the larger group keeps the spot');
    assert.deepEqual(east.photos.map((p) => p.id), [e1, e2, none]);
    assert.deepEqual(west.photos.map((p) => p.id), [w1, w2]);
    assert.deepEqual([east.heading, west.heading].map(Math.round), [93, 268]);
    // Same place: terrain, species and satellite series come along.
    assert.equal(west.elevation, 640);
    assert.deepEqual(west.species.map((s) => s.scientificName), ['Fagus sylvatica']);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM spot_ndvi_scenes WHERE spot_id = ?').get(west.id).n, 1);
    // Each spot is aligned in its own frame again: its first photo is the frame.
    assert.deepEqual(west.photos[0].alignment.h, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    assert.ok(west.photos[1].alignment, 'the second westward photo aligns to the first');
    assert.equal((await json('/api/spots')).body.length, versionBefore + 1);

    // Nothing left to split.
    assert.equal((await json(`/api/spots/${spot}/split`)).body.mixed, false);
    assert.equal((await post(`/api/spots/${spot}/split`)).status, 422);

    // By hand: move a chosen photo into a new spot.
    assert.equal((await post(`/api/spots/${spot}/split`, { photoIds: [w1] })).status, 400, 'not a photo of this spot');
    assert.equal((await post(`/api/spots/${spot}/split`, { photoIds: [e1, e2, none] })).status, 400, 'one must stay');
    assert.equal((await post(`/api/spots/${spot}/split`, { photoIds: [] })).status, 400);
    const manual = (await post(`/api/spots/${spot}/split`, { photoIds: [none] })).body;
    assert.deepEqual(manual.spots.map((s) => s.photos.map((p) => p.id)), [[e1, e2], [none]]);
    assert.equal((await json('/api/spots/999/split')).status, 404);
  } finally {
    await app.locals.idle();
    server.close();
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
