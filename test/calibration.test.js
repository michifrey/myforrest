'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { calibrate, sweep, maxDropBetween } = require('../src/calibration');

const d = (iso) => Date.parse(`${iso}T10:00:00Z`);

test('the threshold with the best F1 wins; too few checks keep the starting value', () => {
  const damaged = [0.16, 0.14, 0.12, 0.2, 0.11, 0.05].map((drop) => ({ drop, damage: true }));
  const healthy = [0, 0.02, 0.04, 0.06, 0.09, -0.03].map((drop) => ({ drop, damage: false }));
  const cal = calibrate({ ndvi: [...damaged, ...healthy], ndmi: [] });
  // 0.10 and 0.11 both catch 5 of 6 without false alarms: the higher one is kept (fewer false alarms later).
  assert.equal(cal.ndvi.source, 'kalibriert');
  assert.equal(cal.ndvi.threshold, 0.11);
  assert.equal(cal.ndvi.strong, 0.22, 'keeps the ratio strong/threshold of the starting values');
  assert.deepEqual([cal.ndvi.positives, cal.ndvi.negatives, cal.ndvi.at.tp, cal.ndvi.at.fn, cal.ndvi.at.fp], [6, 6, 5, 1, 0]);
  assert.equal(cal.ndmi.source, 'standard');
  assert.equal(cal.ndmi.threshold, 0.08);

  const few = calibrate({ ndvi: damaged.slice(0, 3).concat(healthy) });
  assert.equal(few.ndvi.source, 'standard', 'three damaged checks are not enough');
  assert.equal(few.ndvi.threshold, 0.1);

  const rows = sweep([{ drop: 0.1, damage: true }, { drop: null, damage: true }, { drop: 0.2, damage: false }]);
  const at10 = rows.find((r) => r.threshold === 0.1);
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
    // Damage confirmed on the later photo: new tags, or a region confirmed as windthrow.
    for (const v of [0.7, 0.72, 0.74, 0.66]) addSpot(v, { tags: ['sturmschaden'] });
    addSpot(0.75, { confirmed: 'windwurf' });
    addSpot(0.81, { tags: ['borkenkaefer'] }); // damage the satellite barely saw: a miss
    // No damage.
    for (const v of [0.86, 0.84, 0.82, 0.8, 0.77]) addSpot(v);
    // The same damage tag on both photos says nothing about the interval: left out.
    addSpot(0.6, { tags: ['holzschlag'], tagsBefore: ['holzschlag'] });

    const cal = await (await fetch(`${base}/api/satellite/calibration`, { method: 'POST' })).json();
    assert.equal(cal.checks, 11);
    assert.equal(cal.ndvi.source, 'kalibriert');
    assert.deepEqual([cal.ndvi.positives, cal.ndvi.negatives], [6, 5]);
    assert.equal(cal.ndvi.threshold, 0.11);
    assert.deepEqual([cal.ndvi.at.tp, cal.ndvi.at.fn, cal.ndvi.at.fp], [5, 1, 0]);
    assert.equal(cal.ndmi.source, 'standard', 'no NDMI in this series');
    assert.deepEqual(await (await fetch(`${base}/api/satellite/calibration`)).json().then((c) => c.ndvi.threshold), 0.11);

    // A current drop of 0.105 would raise the starting threshold 0.10, but not the calibrated 0.11.
    const nowDate = new Date(now);
    const ym = (y) => `${y}-${String(nowDate.getUTCMonth() + 1).padStart(2, '0')}`;
    const watch = Number(db.prepare('INSERT INTO spots (lat, lon, created_at) VALUES (47.36, 8.58, ?)').run(now).lastInsertRowid);
    addPhoto(watch, '2021-05-01');
    db.prepare(`INSERT INTO spot_ndvi (spot_id, lat, lon, from_date, to_date, fetched_at, complete) VALUES (?, 47.36, 8.58, '2020-01-01', ?, ?, 1)`)
      .run(watch, nowDate.toISOString().slice(0, 10), now);
    const y = nowDate.getUTCFullYear();
    for (const yy of [y - 3, y - 2, y - 1]) scene.run(watch, `w${yy}`, `${ym(yy)}-05`, 0.86);
    scene.run(watch, 'wnow', `${ym(y)}-01`, 0.755);
    const quiet = (await (await fetch(`${base}/api/satellite/alerts`)).json()).find((x) => x.spotId === watch);
    assert.equal(quiet, undefined);
    db.prepare("UPDATE spot_ndvi_scenes SET ndvi = 0.74 WHERE spot_id = ? AND scene_id = 'wnow'").run(watch);
    const alert = (await (await fetch(`${base}/api/satellite/alerts`)).json()).find((x) => x.spotId === watch).alerts[0];
    assert.deepEqual([alert.index, alert.drop, alert.severity], ['ndvi', 0.12, 'auffällig']);
    assert.deepEqual(alert.calibration, { source: 'kalibriert', threshold: 0.11, positives: 6, negatives: 5, hits: 5, falseAlarms: 0 });
  } finally {
    await app.locals.idle();
    server.close();
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
