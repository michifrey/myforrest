'use strict';

// Drive mode (dashcam): choosing the pictures worth keeping (public/drive-select.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load() {
  const self = {};
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'drive-select.js'), 'utf8'), vm.createContext({ self, Math }), { filename: 'drive-select.js' });
  return self.driveSelect;
}
const ds = load();
// Objects from the sandbox compare by value only after a round trip.
const plain = (x) => JSON.parse(JSON.stringify(x));

/** A hash that changes with the place (every ~50 m), so pictures along the road differ. */
const placeHash = (i) => ((i * 2654435761) >>> 0).toString(16).padStart(8, '0').repeat(2);

/**
 * A drive north along a forest road, a picture every 3 s at 15 m/s (45 m),
 * with a stop of two minutes in the middle and a stretch of blurred pictures.
 */
function drive() {
  const frames = [];
  let lat = 47.3;
  let t = Date.UTC(2026, 9, 9, 7, 0, 0);
  for (let i = 0; i < 400; i++) {
    const stopped = i >= 200 && i < 240;
    if (!stopped && i > 0) lat += 45 / 111320;
    frames.push({
      id: i, time: t, lat, lon: 8.5, accuracy: 6,
      hash: stopped ? placeHash(200) : placeHash(i),
      sharpness: i >= 300 && i < 310 ? 20 : 400 + (i % 7) * 10,
    });
    t += 3000;
  }
  return frames;
}

test('a day in the car: one picture every 150 m, nothing while standing or blurred', () => {
  const sel = ds.createSelector([], { everyM: 150 });
  const decisions = [...drive().flatMap((f) => sel.offer(f)), ...sel.finish()];
  assert.equal(decisions.length, 400, 'one decision per picture');
  assert.equal(new Set(decisions.map((d) => d.id)).size, 400);
  const s = sel.stats();
  // 360 moving pictures × 45 m ≈ 16 km; 150 m are reached every 4th picture (180 m) → about 90.
  assert.ok(s.kept >= 80 && s.kept <= 100, `kept ${s.kept}`);
  assert.equal(s.counts.stillstand, 40);
  assert.ok(s.counts.unscharf >= 8, `blurred ${s.counts.unscharf}`);
  assert.ok(s.kept / s.total < 0.3, 'most pictures are dropped');
  assert.ok(Math.abs(s.distanceM - 359 * 45) < 50);
  // Kept pictures are at least 150 m apart.
  const kept = decisions.filter((d) => d.keep).map((d) => d.id).sort((a, b) => a - b);
  const f = drive();
  for (let i = 1; i < kept.length; i++) assert.ok(ds.distanceM(f[kept[i - 1]], f[kept[i]]) >= 149, `${kept[i - 1]} → ${kept[i]}`);
});

test('at a known spot the closest picture looking its way is kept, once per drive', () => {
  const frames = drive();
  const spotAt = (i, heading) => ({ id: 100 + i, lat: frames[i].lat + 5 / 111320, lon: 8.5001, heading });
  // Spots 150 looking north (ahead), 220 looking south (behind), 320 without a direction where the car stops.
  const spots = [spotAt(50, 0), spotAt(120, 180), spotAt(220, null)];
  const sel = ds.createSelector(spots, { onlySpots: true });
  const decisions = [...frames.flatMap((fr) => sel.offer(fr)), ...sel.finish()];
  const kept = decisions.filter((d) => d.keep);
  // 320: taken while arriving (the last moving picture), not again while standing there.
  assert.deepEqual(plain(kept.map((d) => [d.id, d.spotId, d.reason])), [[50, 150, 'spot'], [199, 320, 'spot']]);
  assert.equal(sel.stats().spots, 2);
  // Driving back the same way the next day: the spot looking south gets its picture.
  const back = frames.slice(0, 200).reverse().map((fr, i) => ({ ...fr, id: 1000 + i, time: fr.time + 86400000 + i * 6000 }));
  const sel2 = ds.createSelector(spots, { onlySpots: true });
  const kept2 = [...back.flatMap((fr) => sel2.offer(fr)), ...sel2.finish()].filter((d) => d.keep);
  // The spot without a direction and the one looking south; not the one looking north.
  assert.deepEqual(plain(kept2.map((d) => d.spotId)), [320, 220]);
});

test('slow traffic: pictures that look the same are not kept twice', () => {
  const sel = ds.createSelector([], { everyM: 20 });
  const out = [];
  for (let i = 0; i < 30; i++) out.push(...sel.offer({ id: i, time: i * 3000, lat: 47 + (i * 10) / 111320, lon: 8, hash: 'ffff0000ffff0000', sharpness: 300 }));
  assert.equal(out.filter((d) => d.keep).length, 1);
  assert.ok(sel.stats().counts.doppelt > 5);
  // No GPS fix: dropped.
  assert.deepEqual(plain(sel.offer({ id: 99, time: 0, lat: NaN, lon: 8 })), [{ id: 99, keep: false, reason: 'kein-gps' }]);
});

test('image measures: difference hash and sharpness', () => {
  const ramp = Array.from({ length: 72 }, (_, i) => i % 9);
  assert.equal(ds.dhash(ramp), '0000000000000000');
  assert.equal(ds.dhash(ramp.map((v) => -v)), 'ffffffffffffffff');
  assert.equal(ds.hamming('ff00', 'f0f0'), 8);
  assert.equal(ds.hamming('ff', null), 64);
  const w = 40;
  const sharp = Array.from({ length: w * w }, (_, i) => ((i % w) + Math.floor(i / w)) % 2 ? 255 : 0);
  const flat = Array.from({ length: w * w }, (_, i) => (i % w) * 6);
  assert.ok(ds.sharpness(sharp, w, w) > 100 * ds.sharpness(flat, w, w) + 1);
});

test('server: drive pictures take the course as heading and are not stored twice at a place', async () => {
  const os = require('node:os');
  const { createApp } = require('../src/app');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-drive-'));
  const offline = async () => new Response('offline', { status: 503 });
  const app = createApp({ dataDir, weatherFetch: offline, fetchImpl: offline, routerUrl: '', mailer: { send: async () => ({}) } });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const reg = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'forst@example.org', name: 'Forst', password: 'geheim-1234' }) });
    const cookie = reg.headers.get('set-cookie').split(';')[0];
    const { csrfToken } = await reg.json();
    // A frame from the camera stream: no EXIF at all, time and place come with the upload.
    const jpeg = await require('sharp')({ create: { width: 64, height: 48, channels: 3, background: '#335533' } }).jpeg().toBuffer();
    const send = async (lat, takenAt, heading) => {
      const fd = new FormData();
      fd.append('photos', new Blob([jpeg], { type: 'image/jpeg' }), 'fahrt.jpg');
      fd.append('lat', String(lat)); fd.append('lon', '8.5'); fd.append('heading', String(heading));
      fd.append('takenAt', takenAt); fd.append('activity', 'fahren');
      return (await fetch(`${base}/api/photos`, { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken }, body: fd })).json();
    };
    const first = await send(47.3, '2026-10-09T07:00:00Z', 352);
    assert.equal(first.created.length, 1);
    assert.deepEqual([first.created[0].heading, first.created[0].activity], [352, 'fahren']);
    // The same place an hour later (a second device, a resent queue): skipped.
    const again = await send(47.30005, '2026-10-09T08:00:00Z', 350);
    assert.equal(again.created.length, 0);
    assert.match(again.skipped[0].reason, /schon ein Bild/);
    // 500 m further, or the next day: stored.
    assert.equal((await send(47.3045, '2026-10-09T08:00:00Z', 0)).created.length, 1);
    assert.equal((await send(47.3, '2026-10-10T07:00:00Z', 352)).created.length, 1);
  } finally {
    await app.locals.idle();
    server.close();
    app.locals.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

/**
 * The Android app (android/, DriveSelector.java) runs the same selection in its background service. Both
 * are checked against the cases in test/fixtures/drive-select-cases.json: here the web version, in
 * `./gradlew test` the Java one. UPDATE_FIXTURES=1 writes the file anew from drive-select.js.
 */
test('the same decisions as the Android app (shared cases)', () => {
  const file = path.join(__dirname, 'fixtures', 'drive-select-cases.json');
  const frames = drive();
  const spotAt = (i, heading) => ({ id: 100 + i, lat: frames[i].lat + 5 / 111320, lon: 8.5001, heading });
  // JSON has no NaN: missing values are null, as the app passes them.
  const json = (x) => JSON.parse(JSON.stringify(x));
  const cases = [
    { name: 'strecke', spots: [], options: { everyM: 150 }, frames },
    { name: 'spots', spots: [spotAt(50, 0), spotAt(120, 180), spotAt(220, null)], options: { onlySpots: true }, frames },
    { name: 'gemischt', spots: [spotAt(80, 0), spotAt(260, null)], options: { everyM: 100 },
      frames: frames.map((f, i) => ({ ...f, accuracy: i % 37 === 5 ? 80 : f.accuracy, lat: i % 53 === 7 ? null : f.lat, hash: i % 3 ? f.hash : 'ffff0000ffff0000', speed: i % 11 === 0 ? 12 : null })) },
    { name: 'rueckweg', spots: [spotAt(50, 0), spotAt(120, 180), spotAt(220, null)], options: { onlySpots: true },
      frames: frames.slice(0, 200).reverse().map((f, i) => ({ ...f, id: 1000 + i, time: f.time + 86400000 + i * 6000 })) },
  ].map((c) => {
    const sel = ds.createSelector(c.spots, c.options);
    const decisions = [...json(c.frames).flatMap((f) => sel.offer(f)), ...sel.finish()];
    const s = sel.stats();
    return json({ ...c, frames: c.frames, decisions, stats: { kept: s.kept, total: s.total, counts: s.counts, spots: s.spots, distanceM: Math.round(s.distanceM) } });
  });
  if (process.env.UPDATE_FIXTURES) fs.writeFileSync(file, `${JSON.stringify(json(cases))}\n`);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), json(cases));
});
