'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');

const fixture = (name) => new Blob([fs.readFileSync(path.join(__dirname, 'fixtures', name))], { type: 'image/jpeg' });

async function withServer(opts, fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-'));
  const app = createApp({ dataDir, ...opts });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, dataDir);
  } finally {
    server.close();
    app.locals.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

const upload = (base, files, fields = {}) => {
  const fd = new FormData();
  for (const [name, blob] of files) fd.append(name === 'gpx' ? 'gpx' : 'photos', blob, name);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fetch(`${base}/api/photos`, { method: 'POST', body: fd });
};

test('photos with EXIF GPS land in a spot, nearby photos share it', async () => {
  await withServer({}, async (base) => {
    let res = await upload(base, [['gps.jpg', fixture('gps.jpg')]], { tags: 'sturmschaden' });
    assert.equal(res.status, 201);
    const first = (await res.json()).created[0];
    assert.equal(first.locationSource, 'exif');
    assert.equal(first.takenAt, '2024-05-01T08:00:00.000Z');
    assert.deepEqual(first.tags, ['sturmschaden']);

    // ~10 m away, placed manually → same spot
    res = await upload(base, [['nogps.jpg', fixture('nogps.jpg')]], { lat: '47.37509', lon: '8.5375' });
    const second = (await res.json()).created[0];
    assert.equal(second.locationSource, 'manual');
    assert.equal(second.spotId, first.spotId);

    // ~1 km away → new spot
    res = await upload(base, [['nogps.jpg', fixture('nogps.jpg')]], { lat: '47.384', lon: '8.5375' });
    assert.notEqual((await res.json()).created[0].spotId, first.spotId);

    const spots = await (await fetch(`${base}/api/spots`)).json();
    assert.equal(spots.length, 2);
    const filtered = await (await fetch(`${base}/api/spots?tag=sturmschaden`)).json();
    assert.deepEqual(filtered.map((s) => s.id), [first.spotId]);

    const spot = await (await fetch(`${base}/api/spots/${first.spotId}`)).json();
    assert.deepEqual(spot.photos.map((p) => p.id), [first.id, second.id]);
    const img = await fetch(`${base}${first.url}`);
    assert.equal(img.status, 200);
  });
});

test('photos without GPS are placed via GPX track by capture time', async () => {
  await withServer({}, async (base) => {
    // nogps.jpg was taken 2024-05-01 10:30:00 +02:00 = 08:30:00Z
    const gpx = `<gpx><trk><trkseg>
      <trkpt lat="47.0" lon="8.0"><time>2024-05-01T08:20:00Z</time></trkpt>
      <trkpt lat="47.02" lon="8.02"><time>2024-05-01T08:40:00Z</time></trkpt>
    </trkseg></trk></gpx>`;
    const res = await upload(base, [
      ['nogps.jpg', fixture('nogps.jpg')],
      ['gpx', new Blob([gpx], { type: 'application/gpx+xml' })],
    ], { utcOffsetMinutes: '0' });
    assert.equal(res.status, 201);
    const p = (await res.json()).created[0];
    assert.equal(p.locationSource, 'gpx');
    assert.ok(Math.abs(p.lat - 47.01) < 1e-6 && Math.abs(p.lon - 8.01) < 1e-6);
  });
});

test('uploads without any location or with non-images are skipped', async () => {
  await withServer({}, async (base, dataDir) => {
    const res = await upload(base, [
      ['nogps.jpg', fixture('nogps.jpg')],
      ['evil.jpg', new Blob(['<script>alert(1)</script>'], { type: 'image/jpeg' })],
    ]);
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.created.length, 0);
    assert.equal(body.skipped.length, 2);
    assert.deepEqual(fs.readdirSync(path.join(dataDir, 'uploads')), []);
    assert.deepEqual(fs.readdirSync(path.join(dataDir, 'tmp')), []);
  });
});

test('tags can be edited and deleting the last photo removes the spot', async () => {
  await withServer({}, async (base) => {
    const p = (await (await upload(base, [['gps.jpg', fixture('gps.jpg')]])).json()).created[0];
    let res = await fetch(`${base}/api/photos/${p.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: ['neophyt', 'unknown'], note: 'Springkraut am Bach' }),
    });
    const updated = await res.json();
    assert.deepEqual(updated.tags, ['neophyt']);
    assert.equal(updated.note, 'Springkraut am Bach');

    res = await fetch(`${base}/api/photos/${p.id}`, { method: 'DELETE' });
    assert.equal(res.status, 204);
    assert.deepEqual(await (await fetch(`${base}/api/spots`)).json(), []);
    assert.equal((await fetch(`${base}${p.url}`)).status, 404);
  });
});

test('plant identification flags neophytes and tags the photo', async () => {
  const fakeFetch = async (url, init) => {
    assert.match(url, /my-api\.plantnet\.org/);
    assert.ok(init.body instanceof FormData);
    return new Response(JSON.stringify({
      results: [
        { score: 0.82, species: { scientificNameWithoutAuthor: 'Impatiens glandulifera', commonNames: ['Indisches Springkraut'] } },
        { score: 0.05, species: { scientificNameWithoutAuthor: 'Impatiens noli-tangere', commonNames: [] } },
      ],
    }), { status: 200 });
  };
  await withServer({ plantnetKey: 'test', fetchImpl: fakeFetch }, async (base) => {
    const p = (await (await upload(base, [['gps.jpg', fixture('gps.jpg')]])).json()).created[0];
    const res = await fetch(`${base}/api/photos/${p.id}/identify`, { method: 'POST' });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.identifications[0].neophyte, 'Drüsiges Springkraut');
    assert.deepEqual(body.tags, ['neophyt']);
  });
});

test('plant identification reports when not configured', async () => {
  await withServer({ plantnetKey: '' }, async (base) => {
    const res = await fetch(`${base}/api/photos/1/identify`, { method: 'POST' });
    assert.equal(res.status, 501);
  });
});

test('repeat photos are pinned to the chosen spot', async () => {
  await withServer({}, async (base) => {
    const first = (await (await upload(base, [['gps.jpg', fixture('gps.jpg')]])).json()).created[0];

    // Device position ~30 m away (outside the 25 m radius) but plausible → kept, same spot.
    let res = await upload(base, [['nogps.jpg', fixture('nogps.jpg')]],
      { spotId: String(first.spotId), lat: '47.37527', lon: '8.5375' });
    assert.equal(res.status, 201);
    let p = (await res.json()).created[0];
    assert.equal(p.spotId, first.spotId);
    assert.equal(p.locationSource, 'spot');
    assert.equal(p.lat, 47.37527);

    // Implausible position → spot centre instead.
    const spot = await (await fetch(`${base}/api/spots/${first.spotId}`)).json();
    res = await upload(base, [['nogps.jpg', fixture('nogps.jpg')]], { spotId: String(first.spotId), lat: '48', lon: '9' });
    p = (await res.json()).created[0];
    assert.equal(p.spotId, first.spotId);
    assert.deepEqual([p.lat, p.lon], [spot.lat, spot.lon]);

    res = await upload(base, [['nogps.jpg', fixture('nogps.jpg')]], { spotId: '999' });
    assert.equal(res.status, 400);
    assert.equal((await (await fetch(`${base}/api/spots`)).json()).length, 1);
  });
});
