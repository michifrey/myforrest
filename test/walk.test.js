'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');

const sharp = require('sharp');

// A picture without EXIF, so the time comes from `takenAt`.
let plain = null;
const picture = async () => new Blob([plain ??= await sharp({ create: { width: 64, height: 48, channels: 3, background: '#4a6b3a' } }).jpeg().toBuffer()], { type: 'image/jpeg' });
const noWeather = async () => new Response('offline', { status: 503 });

async function withServer(fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-walk-'));
  const app = createApp({ dataDir, weatherFetch: noWeather, routerUrl: '' });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, app.locals.db);
  } finally {
    await app.locals.idle();
    server.close();
    app.locals.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function upload(base, fields) {
  const fd = new FormData();
  fd.append('photos', await picture(), 'x.jpg');
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  const body = await (await fetch(`${base}/api/photos`, { method: 'POST', body: fd })).json();
  assert.equal(body.created.length, 1, JSON.stringify(body.skipped));
  return body.created[0];
}

test('walk: the recording leads forward and back, nearby spots by direction, the spot through time', async () => {
  await withServer(async (base, db) => {
    // A recording heading north: three pictures ~45 m apart.
    const seq = 'fahrt-0001-abcd';
    const a = await upload(base, { lat: 47.3700, lon: 8.5400, takenAt: '2026-05-01T08:00:00Z', sequenceId: seq });
    const b = await upload(base, { lat: 47.3704, lon: 8.5400, takenAt: '2026-05-01T08:00:10Z', sequenceId: seq });
    const c = await upload(base, { lat: 47.3708, lon: 8.5400, takenAt: '2026-05-01T08:00:20Z', sequenceId: seq });
    assert.equal(b.sequenceId, seq);
    // A spot ~38 m east of b with two photos, the later one closer in time.
    await upload(base, { lat: 47.3704, lon: 8.5405, takenAt: '2024-05-01T08:00:00Z' });
    const east = await upload(base, { lat: 47.3704, lon: 8.5405, takenAt: '2026-04-20T08:00:00Z' });
    // A protected find ~30 m west: invisible to the public, also here.
    await upload(base, { lat: 47.3704, lon: 8.5396, takenAt: '2026-05-02T08:00:00Z', protected: '1' });
    // An earlier photo at b's spot: time travel on the spot.
    const old = await upload(base, { lat: 47.37041, lon: 8.54001, takenAt: '2023-06-01T08:00:00Z' });
    assert.equal(old.spotId, b.spotId);

    const w = await (await fetch(`${base}/api/walk/${b.id}`)).json();
    assert.equal(w.photo.id, b.id);
    assert.deepEqual(w.sequence, { id: seq, index: 1, length: 3 });
    const way = Object.fromEntries(w.links.filter((l) => l.kind === 'weg').map((l) => [l.direction, l]));
    assert.equal(way.vor.id, c.id);
    assert.equal(way.zurueck.id, a.id);
    assert.ok(way.vor.bearing < 1 || way.vor.bearing > 359, String(way.vor.bearing));
    assert.ok(Math.abs(way.zurueck.bearing - 180) < 1);
    assert.ok(Math.abs(way.vor.distanceM - 44) <= 2, String(way.vor.distanceM));
    const spots = w.links.filter((l) => l.kind === 'spot');
    assert.deepEqual(spots.map((l) => l.id), [east.id], 'one photo per spot, closest in time; the protected find is left out');
    assert.ok(Math.abs(spots[0].bearing - 90) < 2);
    assert.deepEqual(w.times.map((t) => t.id), [old.id, b.id]);
    assert.equal(w.track.length, 3);

    // The end of the recording has no way forward.
    const end = await (await fetch(`${base}/api/walk/${c.id}`)).json();
    assert.deepEqual(end.links.filter((l) => l.kind === 'weg').map((l) => l.direction), ['zurueck']);

    // `at` picks the spot's photo closest to the date being looked at.
    const past = await (await fetch(`${base}/api/walk/${b.id}?at=2024-06-01`)).json();
    assert.notEqual(past.links.find((l) => l.kind === 'spot').id, east.id);

    // Unknown, hidden or protected photos: 404.
    assert.equal((await fetch(`${base}/api/walk/999999`)).status, 404);
    const prot = db.prepare('SELECT id FROM photos WHERE protected = 1').get().id;
    assert.equal((await fetch(`${base}/api/walk/${prot}`)).status, 404);
    assert.equal((await fetch(`${base}/api/walk/abc`)).status, 400);
  });
});

test('walk: a far jump inside a recording is no step', async () => {
  await withServer(async (base) => {
    const seq = 'batch-far-0001';
    const a = await upload(base, { lat: 47.37, lon: 8.54, takenAt: '2026-05-01T08:00:00Z', sequenceId: seq });
    await upload(base, { lat: 47.40, lon: 8.54, takenAt: '2026-05-01T09:00:00Z', sequenceId: seq });
    const w = await (await fetch(`${base}/api/walk/${a.id}`)).json();
    assert.deepEqual(w.links, []);
    assert.equal(w.sequence.length, 2);
  });
});
