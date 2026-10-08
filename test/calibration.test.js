'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { calibrate, sweep, maxDropBetween } = require('../src/calibration');

const d = (iso) => Date.parse(`${iso}T10:00:00Z`);

/** Samples from [group, drop, damage] rows. */
const rows = (list) => list.map(([group, drop, damage]) => ({ group, drop, damage }));

test('a calibrated threshold is used when it beats the starting value on held-out spots', () => {
  // The starting value 0.10 raises 5 false alarms (healthy drops of 0.11–0.13); 0.15 separates cleanly.
  const damaged = [0.15, 0.16, 0.18, 0.2, 0.22, 0.25, 0.17, 0.19, 0.21, 0.15].map((drop, i) => [2 * i, drop, true]);
  const healthy = [0, 0.02, 0.04, 0.11, 0.12, 0.13, 0.05, 0.11, 0.12, 0.03].map((drop, i) => [2 * i + 1, drop, false]);
  const cal = calibrate({ ndvi: rows([...damaged, ...healthy]), ndmi: [] });
  const c = cal.ndvi;
  assert.deepEqual([c.source, c.reason, c.threshold, c.candidate, c.strong], ['kalibriert', null, 0.15, 0.15, 0.3]);
  assert.deepEqual([c.positives, c.negatives, c.spots], [10, 10, 20]);
  // Five folds of four spots, each choosing its own threshold.
  assert.deepEqual([c.cv.folds, c.cv.fitted, c.cv.f1, c.cv.fp], [5, 5, 1, 0]);
  assert.deepEqual([c.standard.threshold, c.standard.tp, c.standard.fp, c.standard.f1], [0.1, 10, 5, 0.8]);
  assert.deepEqual([cal.ndmi.source, cal.ndmi.reason, cal.ndmi.threshold], ['standard', 'zu-wenige-kontrollen', 0.08]);
});

test('an overfitted threshold that does worse on held-out spots is not used', () => {
  // The two faint damages (0.11, 0.12) share a fold: without them the other folds pick 0.30 and miss them.
  const faint = [[0, 0.11, true], [5, 0.12, true]];
  const clear = [2, 4, 7, 9, 12, 14, 16, 18, 21, 23].map((g) => [g, 0.3, true]);
  const healthy = [1, 3, 6, 8, 10, 11, 13, 15, 17, 19, 20, 22].map((g) => [g, g === 11 ? 0.105 : 0, false]);
  const c = calibrate({ ndvi: rows([...faint, ...clear, ...healthy]) }).ndvi;
  assert.equal(c.candidate, 0.11, 'on all checks 0.11 looks perfect');
  assert.deepEqual([c.cv.thresholds[0], c.cv.fn, c.cv.f1, c.standard.f1], [0.3, 2, 0.909, 0.96]);
  assert.deepEqual([c.source, c.reason, c.threshold], ['standard', 'nicht-besser', 0.1]);
});

test('too few checks per fold or too few spots keep the starting value', () => {
  // Enough checks overall, but no fold keeps five damaged and five undamaged ones for itself.
  const small = rows([[0, 0.11, true], [5, 0.12, true], [2, 0.3, true], [4, 0.3, true], [7, 0.3, true], [9, 0.3, true],
    [1, 0, false], [3, 0, false], [6, 0, false], [8, 0, false], [10, 0, false], [11, 0.105, false]]);
  const c = calibrate({ ndvi: small }).ndvi;
  assert.deepEqual([c.source, c.reason, c.threshold, c.cv.fitted], ['standard', 'zu-wenige-kontrollen', 0.1, 0]);
  // All checks from two spots: nothing to hold out.
  const two = calibrate({ ndvi: small.map((x) => ({ ...x, group: x.group % 2 })) }).ndvi;
  assert.deepEqual([two.source, two.reason, two.cv], ['standard', 'zu-wenige-spots', null]);
  assert.deepEqual([calibrate({ ndvi: small.slice(0, 3) }).ndvi.reason], ['zu-wenige-kontrollen']);

  const swept = sweep([{ drop: 0.1, damage: true }, { drop: null, damage: true }, { drop: 0.2, damage: false }]);
  const at10 = swept.find((r) => r.threshold === 0.1);
  assert.deepEqual([at10.tp, at10.fn, at10.fp, at10.tn], [1, 1, 1, 0], 'no satellite value counts as a miss');
});

test('the drop during an interval uses only the months known at each point in time', () => {
  const monthly = [2020, 2021, 2022, 2023].map((y) => ({ month: `${y}-06`, ndvi: 0.86 }));
  monthly.push({ month: '2024-06', ndvi: 0.7 }, { month: '2025-06', ndvi: 0.5 });
  assert.equal(maxDropBetween(monthly, d('2023-06-20'), d('2024-06-25'), 'ndvi'), 0.16);
  // The collapse of 2025 lies after the interval and must not leak into it.
  assert.equal(maxDropBetween(monthly, d('2023-06-20'), d('2024-05-30'), 'ndvi'), 0);
  assert.equal(maxDropBetween([], d('2023-06-20'), d('2024-06-25'), 'ndvi'), null);
});

test('calibration from confirmed damage at the spots, used by the early warning', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-cal-'));
  const offline = async () => new Response('offline', { status: 503 });
  const app = createApp({ dataDir, weatherFetch: offline, tileOptions: { precompute: false } });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const db = app.locals.db;
  try {
    const now = Date.now();
    const addPhoto = (spot, iso, tags = []) => {
      const id = Number(db.prepare(`INSERT INTO photos (spot_id, file, taken_at, lat, lon, location_source, created_at)
        VALUES (?, ?, ?, 47.36, 8.58, 'exif', ?)`).run(spot, `p${spot}-${iso}.jpg`, d(iso), now).lastInsertRowid);
      for (const t of tags) db.prepare('INSERT INTO photo_tags (photo_id, tag) VALUES (?, ?)').run(id, t);
      return id;
    };
    const scene = db.prepare(`INSERT INTO spot_ndvi_scenes (spot_id, scene_id, date, cloud, ndvi, ndmi, sensor, v, clear_fraction)
      VALUES (?, ?, ?, 5, ?, NULL, 'S2', 2, 1)`);
    /** A spot photographed in June 2023 and June 2024; NDVI 0.86 every June, `after` in June 2024. */
    const addSpot = (after, { tags = [], tagsBefore = [], confirmed = null } = {}) => {
      const spot = Number(db.prepare('INSERT INTO spots (lat, lon, created_at) VALUES (47.36, 8.58, ?)').run(now).lastInsertRowid);
      const a = addPhoto(spot, '2023-06-15', tagsBefore);
      const b = addPhoto(spot, '2024-06-20', tags);
      if (confirmed) {
        db.prepare(`INSERT INTO region_labels (photo_id, base_id, region_key, class, source, region_json, created_at)
          VALUES (?, ?, '0,0,500,500', ?, 'nutzer', '{}', ?)`).run(b, a, confirmed, now);
      }
      db.prepare(`INSERT INTO spot_ndvi (spot_id, lat, lon, from_date, to_date, fetched_at, complete) VALUES (?, 47.36, 8.58, '2020-01-01', ?, ?, 1)`)
        .run(spot, new Date(now).toISOString().slice(0, 10), now);
      for (const y of [2020, 2021, 2022, 2023]) scene.run(spot, `s${y}`, `${y}-06-10`, 0.86);
      scene.run(spot, 's2024', '2024-06-10', after);
      return spot;
    };
    // Damage confirmed on the later photo (new tags, or a region confirmed as windthrow) and healthy spots,
    // alternating so every fold gets both. The starting value 0.10 would raise 3 false alarms.
    const damagedAfter = [0.7, 0.68, 0.66, 0.64, 0.61, 0.69, 0.67, 0.65];
    const healthyAfter = [0.74, 0.75, 0.73, 0.84, 0.82, 0.86, 0.81, 0.83];
    damagedAfter.forEach((v, i) => {
      addSpot(v, i === 4 ? { confirmed: 'windwurf' } : { tags: ['sturmschaden'] });
      addSpot(healthyAfter[i]);
    });
    // The same damage tag on both photos says nothing about the interval: left out.
    addSpot(0.6, { tags: ['holzschlag'], tagsBefore: ['holzschlag'] });

    const cal = await (await fetch(`${base}/api/satellite/calibration`, { method: 'POST' })).json();
    assert.equal(cal.checks, 16);
    const c = cal.ndvi;
    assert.deepEqual([c.source, c.reason, c.positives, c.negatives, c.spots], ['kalibriert', null, 8, 8, 16]);
    assert.equal(c.threshold, 0.16);
    assert.deepEqual([c.cv.folds, c.cv.fitted], [5, 5]);
    assert.ok(c.cv.f1 > c.standard.f1, `cross-validated ${c.cv.f1} vs starting value ${c.standard.f1}`);
    assert.equal(c.standard.fp, 3);
    assert.equal(cal.ndmi.source, 'standard', 'no NDMI in this series');
    assert.equal((await (await fetch(`${base}/api/satellite/calibration`)).json()).ndvi.threshold, 0.16);

    // A current drop of 0.12 would raise the starting threshold 0.10, but not the calibrated 0.16.
    const nowDate = new Date(now);
    const ym = (y) => `${y}-${String(nowDate.getUTCMonth() + 1).padStart(2, '0')}`;
    const watch = Number(db.prepare('INSERT INTO spots (lat, lon, created_at) VALUES (47.36, 8.58, ?)').run(now).lastInsertRowid);
    addPhoto(watch, '2021-05-01');
    db.prepare(`INSERT INTO spot_ndvi (spot_id, lat, lon, from_date, to_date, fetched_at, complete) VALUES (?, 47.36, 8.58, '2020-01-01', ?, ?, 1)`)
      .run(watch, nowDate.toISOString().slice(0, 10), now);
    const y = nowDate.getUTCFullYear();
    for (const yy of [y - 3, y - 2, y - 1]) scene.run(watch, `w${yy}`, `${ym(yy)}-05`, 0.86);
    scene.run(watch, 'wnow', `${ym(y)}-01`, 0.74);
    const quiet = (await (await fetch(`${base}/api/satellite/alerts`)).json()).find((x) => x.spotId === watch);
    assert.equal(quiet, undefined);
    db.prepare("UPDATE spot_ndvi_scenes SET ndvi = 0.66 WHERE spot_id = ? AND scene_id = 'wnow'").run(watch);
    const alert = (await (await fetch(`${base}/api/satellite/alerts`)).json()).find((x) => x.spotId === watch).alerts[0];
    assert.deepEqual([alert.index, alert.drop, alert.severity], ['ndvi', 0.2, 'auffällig']);
    const k = alert.calibration;
    assert.deepEqual([k.source, k.threshold, k.positives, k.negatives, k.spots, k.cv.folds], ['kalibriert', 0.16, 8, 8, 16, 5]);
    assert.deepEqual([k.standard.threshold, k.standard.falseAlarms], [0.1, 3]);
    assert.equal(k.cv.hits + k.cv.misses, 8);
  } finally {
    await app.locals.idle();
    server.close();
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
