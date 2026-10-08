'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { createApp } = require('../src/app');
const sphere = require('../src/sphere');
const { alignPanoramas } = require('../src/align');
const { sharpness, createFramePicker } = require('../src/video');

const FIX = path.join(__dirname, 'fixtures');
const W = 2048;
const H = 1024;
const maxDiff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

/** A synthetic 360° panorama: a forest photo stretched around the sphere, as raw RGB. */
async function panoramaPixels(file = 'align-a.jpg') {
  const { data } = await sharp(path.join(FIX, file)).resize(W, H, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return data;
}
const jpeg = (data, { xmp = null, width = W, height = H } = {}) => {
  let img = sharp(data, { raw: { width, height, channels: 3 } }).jpeg({ quality: 92 });
  if (xmp) img = img.withXmp(xmp);
  return img.toBuffer();
};
const GPANO = (heading) => `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:GPano="http://ns.google.com/photos/1.0/panorama/" GPano:ProjectionType="equirectangular" GPano:UsePanoramaViewer="True" GPano:PoseHeadingDegrees="${heading}"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;

test('sphere geometry: directions, rotations from matched points, resampling around the seam', () => {
  for (const [u, v] of [[0.5, 0.5], [0.1, 0.3], [0.99, 0.8]]) {
    const back = sphere.toUV(sphere.toVector(u, v));
    assert.ok(Math.abs(back[0] - u) < 1e-9 && Math.abs(back[1] - v) < 1e-9);
  }
  assert.deepEqual(sphere.toVector(0.5, 0.5).map((x) => Math.round(x * 1e9) / 1e9), [0, 0, 1], 'centre = straight ahead');
  const R = sphere.fromAngles(73, 6, -3);
  assert.deepEqual(sphere.describe(R), { yaw: 73, tilt: 6.7 });
  const from = Array.from({ length: 40 }, (_, i) => sphere.toVector((i * 0.137) % 1, 0.2 + ((i * 0.071) % 0.6)));
  const to = from.map((d) => sphere.rotate(R, d));
  assert.ok(maxDiff(sphere.fitRotation(from, to), R) < 1e-9);
  // A quarter of the matches wrong: RANSAC still finds the rotation.
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pairs = from.map((d, i) => [d, i % 4 === 0 ? sphere.toVector(rnd(), rnd()) : to[i]]);
  const r = sphere.ransacRotation(pairs, 0.01, rnd);
  assert.equal(r.inliers, 30);
  assert.ok(maxDiff(r.R, R) < 1e-9);
  assert.ok(maxDiff(sphere.multiply(R, sphere.transpose(R)), sphere.IDENTITY) < 1e-12);

  // Turning by 90° shifts the panorama by a quarter of its width, across the seam.
  const w = 64;
  const h = 32;
  const data = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[(y * w + x) * 3] = x * 4;
  const out = sphere.remap({ data, width: w, height: h }, sphere.fromAngles(90), w, h);
  assert.deepEqual([0, 8, 40, 48, 60].map((x) => out[(10 * w + x) * 3]), [0, 8, 40, 48, 60].map((x) => ((x + 16) % w) * 4));
});

test('panoramas are aligned by a rotation of the sphere', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-pano-'));
  try {
    const a = await panoramaPixels();
    const R = sphere.fromAngles(140, 4, -2); // turned round and held a little crooked
    fs.writeFileSync(path.join(dir, 'a.jpg'), await jpeg(a));
    fs.writeFileSync(path.join(dir, 'b.jpg'), await jpeg(sphere.remap({ data: a, width: W, height: H }, R, W, H)));
    const r = await alignPanoramas(path.join(dir, 'b.jpg'), path.join(dir, 'a.jpg'));
    assert.ok(r && r.inliers >= 50, `inliers ${r?.inliers}`);
    assert.ok(maxDiff(r.r, R) < 0.01, JSON.stringify(sphere.describe(r.r)));
    // A different place does not align.
    fs.writeFileSync(path.join(dir, 'c.jpg'), await jpeg(await panoramaPixels('align-other.jpg')));
    assert.equal(await alignPanoramas(path.join(dir, 'c.jpg'), path.join(dir, 'a.jpg')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('360° photos are recognised on upload, share a spot whatever their heading, and are compared turned', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-pano-'));
  const offline = async () => new Response('offline', { status: 503 });
  const app = createApp({ dataDir, weatherFetch: offline, tileOptions: { precompute: false } });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const upload = async (buf, name, takenAt) => {
    const fd = new FormData();
    fd.append('photos', new Blob([buf], { type: 'image/jpeg' }), name);
    fd.append('lat', '47.3601');
    fd.append('lon', '8.5802');
    fd.append('takenAt', takenAt);
    const res = await fetch(`${base}/api/photos`, { method: 'POST', body: fd });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    return body.created[0];
  };
  try {
    const a = await panoramaPixels();
    // The second visit: camera turned by 120°, and a new clearing (bright patch) in one direction.
    const later = sphere.remap({ data: a, width: W, height: H }, sphere.fromAngles(120, 2, 0), W, H);
    for (let y = 380; y < 560; y++) {
      for (let x = 1500; x < 1700; x++) later.set([235, 220, 170], (y * W + x) * 3);
    }
    const p1 = await upload(await jpeg(a, { xmp: GPANO(10) }), 'pano-2023.jpg', '2023-06-01T10:00:00Z');
    const p2 = await upload(await jpeg(later, { xmp: GPANO(190) }), 'pano-2024.jpg', '2024-06-01T10:00:00Z');
    assert.deepEqual([p1.panorama, p2.panorama, p1.heading, p2.heading], [true, true, 10, 190]);
    assert.equal(p2.spotId, p1.spotId, 'opposite headings, still one spot');
    assert.equal((await (await fetch(`${base}/api/spots/${p1.spotId}`)).json()).heading, null, 'panoramas give the spot no direction');
    assert.deepEqual([p1.alignment.kind, p1.alignment.yaw], ['rotation', 0]);
    assert.equal(p2.alignment.kind, 'rotation');
    // p2's view straight ahead is where p1 looks 120° further right.
    assert.ok(Math.abs(p2.alignment.yaw - 120) < 1 && Math.abs(p2.alignment.tilt - 2) < 1, JSON.stringify(p2.alignment));

    // The change is found where the clearing is, not along the seam or at the photographer.
    const change = await (await fetch(`${base}/api/photos/${p1.id}/change?to=${p2.id}`)).json();
    assert.ok(change.changedFraction > 0.01 && change.changedFraction < 0.1, `changed ${change.changedFraction}`);
    assert.ok(Math.abs(change.coverage - 0.85) < 0.01, `coverage ${change.coverage}`);
    const big = change.regions.filter((r) => r.area >= 0.005);
    assert.ok(big.length >= 1);
    // The patch sits at x 1500–1700 of the turned image: 120° further right in p1's view.
    const centreU = ((1600 / W) + 120 / 360) % 1;
    assert.ok(big.some((r) => r.bbox[0] - 0.02 <= centreU && centreU <= r.bbox[2] + 0.02), JSON.stringify(big.map((r) => r.bbox)));

    // The later panorama turned into the first one's orientation looks like it (outside the clearing).
    const res = await fetch(`${base}/api/photos/${p2.id}/aligned.jpg?frame=${p1.id}`);
    assert.equal(res.status, 200);
    const turned = await sharp(Buffer.from(await res.arrayBuffer())).raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([turned.info.width, turned.info.height], [W, H]);
    let diff = 0;
    let n = 0;
    for (let y = 200; y < 300; y++) for (let x = 0; x < W; x += 4) { diff += Math.abs(turned.data[(y * W + x) * 3 + 1] - a[(y * W + x) * 3 + 1]); n++; }
    assert.ok(diff / n < 12, `mean difference ${diff / n}`);
    const etag = res.headers.get('etag');
    assert.equal((await fetch(`${base}/api/photos/${p2.id}/aligned.jpg?frame=${p1.id}`, { headers: { 'If-None-Match': etag } })).status, 304);

    // A normal photo at the same place is neither aligned to nor compared with the panoramas.
    const flat = await upload(await sharp(path.join(FIX, 'align-a.jpg')).jpeg().toBuffer(), 'foto.jpg', '2024-07-01T10:00:00Z');
    assert.equal(flat.panorama, false);
    assert.equal(flat.spotId, p1.spotId);
    assert.deepEqual(flat.alignment.h, [1, 0, 0, 0, 1, 0, 0, 0, 1], 'first photo of its kind: the frame');
    assert.equal((await fetch(`${base}/api/photos/${p1.id}/change?to=${flat.id}`)).status, 422);
    assert.equal((await fetch(`${base}/api/photos/${flat.id}/aligned.jpg?frame=${p1.id}`)).status, 422);

    // Without GPano: a large 2:1 image is a panorama, a small one is not.
    const small = await upload(await sharp(path.join(FIX, 'align-a.jpg')).resize(1000, 500, { fit: 'fill' }).jpeg().toBuffer(), 'breit.jpg', '2024-08-01T10:00:00Z');
    assert.equal(small.panorama, false);
    const large = await upload(await sharp(path.join(FIX, 'align-a.jpg')).resize(4000, 2000, { fit: 'fill' }).jpeg().toBuffer(), 'theta.jpg', '2024-09-01T10:00:00Z');
    assert.equal(large.panorama, true);
  } finally {
    await app.locals.idle();
    server.close();
    app.locals.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('sharpness drops with blur; the picker takes a sharper neighbour or drops the frame', async () => {
  const img = sharp(path.join(FIX, 'align-a.jpg'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-sharp-'));
  try {
    await img.clone().toFile(path.join(dir, 'sharp.jpg'));
    await img.clone().blur(4).toFile(path.join(dir, 'blur.jpg'));
    const [s, b] = [await sharpness(path.join(dir, 'sharp.jpg')), await sharpness(path.join(dir, 'blur.jpg'))];
    assert.ok(b < s * 0.2, `sharp ${s}, blurred ${b}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // Frames: 100 everywhere, blurred (10) from 9.9 s to 10.1 s and from 20 to 21 s.
  const value = (t) => ((t > 9.9 && t < 10.1) || (t >= 20 && t <= 21) ? 10 : 100);
  const picker = createFramePicker();
  const discarded = [];
  const measure = async (t) => ({ sharpness: value(t), id: t });
  const results = [];
  for (const t of [0, 3, 5, 10, 15, 20.5]) results.push(await picker.pick(t, measure, async (c) => discarded.push(c.t)));
  assert.deepEqual(results.map((r) => [r.t, r.blurry]), [[0, false], [3, false], [5, false], [9.75, false], [15, false], [20.5, true]]);
  assert.deepEqual(discarded, [10, 10.25, 20.25, 20.75], 'blurry and equal candidates are thrown away');
});

test('panoramas aligned by a homography before are aligned again as a rotation on start', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-pano-'));
  const offline = async () => new Response('offline', { status: 503 });
  try {
    let app = createApp({ dataDir, weatherFetch: offline, tileOptions: { precompute: false } });
    const db = app.locals.db;
    const a = await panoramaPixels();
    const files = ['old-a.jpg', 'old-b.jpg'];
    fs.writeFileSync(path.join(dataDir, 'uploads', files[0]), await jpeg(a));
    fs.writeFileSync(path.join(dataDir, 'uploads', files[1]), await jpeg(sphere.remap({ data: a, width: W, height: H }, sphere.fromAngles(50), W, H)));
    const spot = Number(db.prepare('INSERT INTO spots (lat, lon, created_at) VALUES (47.36, 8.58, 0)').run().lastInsertRowid);
    const insert = db.prepare(`INSERT INTO photos (spot_id, file, taken_at, lat, lon, location_source, created_at, panorama, align_h)
      VALUES (?, ?, ?, 47.36, 8.58, 'manual', 0, 1, ?)`);
    insert.run(spot, files[0], Date.UTC(2023, 5, 1), JSON.stringify([1, 0, 0, 0, 1, 0, 0, 0, 1]));
    const old = Number(insert.run(spot, files[1], Date.UTC(2024, 5, 1), JSON.stringify([1.1, 0.02, -0.13, 0.01, 1, 0, 0, 0, 1])).lastInsertRowid);
    await app.locals.idle();
    db.close();

    app = createApp({ dataDir, weatherFetch: offline, tileOptions: { precompute: false } });
    await app.locals.idle();
    const row = app.locals.db.prepare('SELECT align_h FROM photos WHERE id = ?').get(old);
    const r = JSON.parse(row.align_h);
    assert.equal(Math.round(sphere.describe(r).yaw), 50);
    app.locals.db.close();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
