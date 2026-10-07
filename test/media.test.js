'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { createApp } = require('../src/app');
const { openDb } = require('../src/db');
const { circularMean, headingDiff } = require('../src/spots');
const { isHeic, heicExif, heicToJpeg } = require('../src/heic');
const { readPhotoMeta } = require('../src/exif');

const read = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name));
const fixture = (name) => new Blob([read(name)], { type: name.endsWith('.heic') ? 'image/heic' : 'image/jpeg' });
const noWeather = async () => new Response('offline', { status: 503 });

async function withServer(opts, fn, dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-media-'))) {
  const app = createApp({ dataDir, weatherFetch: noWeather, ...opts });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, dataDir, app);
  } finally {
    await app.locals.idle();
    server.close();
    app.locals.db.close();
  }
  return dataDir;
}
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });

const upload = async (base, name, fields = {}) => {
  const fd = new FormData();
  fd.append('photos', fixture(name), name);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const res = await fetch(`${base}/api/photos`, { method: 'POST', body: fd });
  return { status: res.status, body: await res.json() };
};

/* ---------- Viewing direction ---------- */

test('headingDiff and circularMean handle the wrap-around at north', () => {
  assert.equal(headingDiff(350, 10), 20);
  assert.equal(headingDiff(10, 350), 20);
  assert.equal(headingDiff(90, 270), 180);
  assert.equal(headingDiff(-90, 270), 0);
  const m = circularMean([350, 10]);
  assert.ok(m.mean < 0.01 || m.mean > 359.99);
  assert.ok(m.r > 0.98);
  assert.ok(circularMean([0, 180]).r < 0.01);
  assert.equal(circularMean([]), null);
});

test('photos at the same place but looking in other directions get their own spot', async () => {
  cleanup(await withServer({}, async (base) => {
    const east = (await upload(base, 'heading-090.jpg')).body.created[0];
    assert.equal(east.heading, 90);
    // 20° further right: same view, same spot.
    const east2 = (await upload(base, 'heading-110.jpg')).body.created[0];
    assert.equal(east2.spotId, east.spotId);
    // Opposite direction at the same position: separate spot.
    const west = (await upload(base, 'heading-270.jpg')).body.created[0];
    assert.notEqual(west.spotId, east.spotId);
    // Without a compass the photo joins the nearest spot, as before.
    const plain = (await upload(base, 'gps.jpg')).body.created[0];
    assert.ok([east.spotId, west.spotId].includes(plain.spotId));

    const spots = await (await fetch(`${base}/api/spots`)).json();
    assert.equal(spots.length, 2);
    const byId = Object.fromEntries(spots.map((s) => [s.id, s]));
    assert.equal(byId[west.spotId].heading, 270);
    const spot = await (await fetch(`${base}/api/spots/${east.spotId}`)).json();
    // Circular mean of 90° and 110°.
    assert.ok(Math.abs(spot.heading - 100) < 0.5, `heading ${spot.heading}`);
  }));
});

test('a narrower tolerance separates directions sooner; rephotos stay pinned', async () => {
  cleanup(await withServer({ headingToleranceDeg: 10 }, async (base) => {
    const a = (await upload(base, 'heading-090.jpg')).body.created[0];
    const b = (await upload(base, 'heading-110.jpg')).body.created[0];
    assert.notEqual(a.spotId, b.spotId);
    const pinned = (await upload(base, 'heading-270.jpg', { spotId: String(a.spotId) })).body.created[0];
    assert.equal(pinned.spotId, a.spotId);
  }));
});

test('existing spots get a heading and previews without being split', async () => {
  // A database from before: one spot holding photos in two directions, no previews.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-media-'));
  fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'align-a.jpg'), path.join(dataDir, 'uploads', 'old-a.jpg'));
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'align-b.jpg'), path.join(dataDir, 'uploads', 'old-b.jpg'));
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'align-other.jpg'), path.join(dataDir, 'uploads', 'old-c.jpg'));
  const db = openDb(path.join(dataDir, 'myforrest.db'));
  const now = Date.now();
  db.prepare('INSERT INTO spots (id, lat, lon, created_at) VALUES (1, 47.3, 8.5, ?), (2, 47.4, 8.5, ?)').run(now, now);
  const ins = db.prepare(`INSERT INTO photos (spot_id, file, taken_at, lat, lon, heading, location_source, created_at)
                          VALUES (?, ?, ?, ?, 8.5, ?, 'exif', ?)`);
  ins.run(1, 'old-a.jpg', now, 47.3, 80, now);
  ins.run(1, 'old-b.jpg', now, 47.3, 100, now);
  ins.run(2, 'old-c.jpg', now, 47.4, 0, now);
  db.prepare("INSERT INTO photos (spot_id, file, taken_at, lat, lon, heading, location_source, created_at) VALUES (2, 'old-c.jpg2', ?, 47.4, 8.5, 180, 'exif', ?)").run(now, now);
  db.close();

  cleanup(await withServer({}, async (base, dir, app) => {
    await app.locals.idle();
    const spots = await (await fetch(`${base}/api/spots`)).json();
    assert.equal(spots.length, 2);
    assert.ok(Math.abs(spots[0].heading - 90) < 0.5);
    // Photos looking north and south: no common direction, the spot stays as it is.
    assert.equal(spots[1].heading, null);

    const spot = await (await fetch(`${base}/api/spots/1`)).json();
    for (const p of spot.photos) {
      assert.match(p.thumbUrl, /^\/thumbs\/old-[ab]-320\.webp$/);
      const img = await fetch(`${base}${p.thumbUrl}`);
      assert.equal(img.status, 200);
      const meta = await sharp(Buffer.from(await img.arrayBuffer())).metadata();
      assert.equal(meta.format, 'webp');
      assert.ok(Math.max(meta.width, meta.height) <= 320);
    }
    // A missing original cannot be previewed: it keeps pointing at the original.
    const broken = (await (await fetch(`${base}/api/spots/2`)).json()).photos.find((p) => p.url.endsWith('.jpg2'));
    assert.equal(broken.thumbUrl, broken.url);
  }, dataDir));
});

/* ---------- Previews ---------- */

test('uploads get WebP previews in two sizes, deleted together with the photo', async () => {
  cleanup(await withServer({}, async (base, dataDir) => {
    const { status, body } = await upload(base, 'align-a.jpg', { lat: '47.1', lon: '8.1' });
    assert.equal(status, 201);
    const p = body.created[0];
    assert.match(p.thumbUrl, /^\/thumbs\/[0-9a-f-]+-320\.webp$/);
    assert.match(p.largeUrl, /^\/thumbs\/[0-9a-f-]+-1280\.webp$/);
    const small = await sharp(Buffer.from(await (await fetch(`${base}${p.thumbUrl}`)).arrayBuffer())).metadata();
    assert.deepEqual([small.format, small.width, small.height], ['webp', 320, 240]);
    // Never enlarged beyond the original (640 × 480).
    const large = await sharp(Buffer.from(await (await fetch(`${base}${p.largeUrl}`)).arrayBuffer())).metadata();
    assert.deepEqual([large.width, large.height], [640, 480]);

    const spots = await (await fetch(`${base}/api/spots`)).json();
    assert.equal(spots[0].latestThumbUrl, p.thumbUrl);

    assert.equal((await fetch(`${base}/api/photos/${p.id}`, { method: 'DELETE' })).status, 204);
    assert.deepEqual(fs.readdirSync(path.join(dataDir, 'thumbs')), []);
    assert.equal((await fetch(`${base}${p.thumbUrl}`)).status, 404);
  }));
});

/* ---------- HEIC ---------- */

test('HEIC detection and EXIF extraction from the original file', async () => {
  const heic = read('gps-heading.heic');
  assert.equal(isHeic(heic), true);
  assert.equal(isHeic(read('gps.jpg')), false);
  // AVIF shares the container but is not HEIC.
  const avif = Buffer.from('000000206674797061766966000000006d696631617669666d69616600000000', 'hex');
  assert.equal(isHeic(avif), false);

  const tiff = heicExif(heic);
  assert.ok(tiff && tiff.toString('latin1', 0, 2) === 'MM');
  const meta = await readPhotoMeta(tiff);
  assert.equal(new Date(meta.takenAt).toISOString(), '2024-05-01T08:00:00.000Z');
  assert.equal(meta.lat, 47.375);
  assert.equal(meta.lon, 8.5375);
  assert.equal(meta.heading, 45);
  assert.equal(heicExif(read('gps.jpg')), null);
});

test('heicToJpeg passes the file to the decoder and returns a Buffer', async () => {
  let seen = null;
  const out = await heicToJpeg(Buffer.from('x'), {
    quality: 0.5,
    convert: async (opts) => {
      seen = opts;
      return new Uint8Array([0xff, 0xd8, 0xff]).buffer;
    },
  });
  assert.equal(seen.format, 'JPEG');
  assert.equal(seen.quality, 0.5);
  assert.ok(Buffer.isBuffer(out));
  assert.deepEqual([...out], [0xff, 0xd8, 0xff]);
});

test('HEIC uploads are converted to JPEG and keep position, time and direction', async () => {
  cleanup(await withServer({}, async (base, dataDir) => {
    const { status, body } = await upload(base, 'gps-heading.heic');
    assert.equal(status, 201, JSON.stringify(body));
    const p = body.created[0];
    assert.equal(p.originalName, 'gps-heading.heic');
    assert.equal(p.locationSource, 'exif');
    assert.equal(p.takenAt, '2024-05-01T08:00:00.000Z');
    assert.equal(p.heading, 45);
    assert.match(p.url, /\.jpg$/);
    const img = await fetch(`${base}${p.url}`);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
    const meta = await sharp(Buffer.from(await img.arrayBuffer())).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ['jpeg', 128, 96]);
    assert.match(p.thumbUrl, /-320\.webp$/);
    assert.deepEqual(fs.readdirSync(path.join(dataDir, 'tmp')), []);

    // A broken HEIC is skipped with a reason.
    const broken = Buffer.concat([read('gps-heading.heic').subarray(0, 300), Buffer.alloc(200)]);
    const fd = new FormData();
    fd.append('photos', new Blob([broken]), 'kaputt.heic');
    fd.append('lat', '47.2');
    fd.append('lon', '8.2');
    const res = await fetch(`${base}/api/photos`, { method: 'POST', body: fd });
    assert.equal(res.status, 422);
    assert.match((await res.json()).skipped[0].reason, /HEIC/);
    assert.equal(fs.readdirSync(path.join(dataDir, 'uploads')).length, 1);
  }));
});
