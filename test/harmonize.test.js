'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { fitPairs, fitHarmonization, theilSen } = require('../src/harmonize');
const { monthlySeries } = require('../src/sentinel');

test('sensor fits: a robust line with enough pairs, an offset with few, nothing with fewer', () => {
  // Landsat 0.04 lower than Sentinel-2 with a little noise, and one outlier the robust line ignores.
  const pairs = Array.from({ length: 14 }, (_, i) => {
    const s2 = 0.45 + i * 0.03;
    return [s2 - 0.04 + (i % 3 - 1) * 0.002, s2];
  });
  pairs.push([0.2, 0.9]);
  const line = fitPairs(pairs);
  assert.equal(line.kind, 'linear');
  assert.ok(Math.abs(line.slope - 1) < 0.03, `slope ${line.slope}`);
  assert.ok(Math.abs(line.intercept + line.slope * 0.7 - 0.74) < 0.005, 'maps 0.70 to about 0.74');
  assert.equal(line.pairs, 15);
  assert.ok(Math.abs(line.before - 0.04) < 0.003);

  const few = fitPairs(pairs.slice(0, 5));
  assert.deepEqual([few.kind, few.slope], ['offset', 1]);
  assert.ok(Math.abs(few.intercept - 0.04) < 0.003);
  assert.equal(fitPairs(pairs.slice(0, 3)), null);

  // A slope far from 1 (here: one sensor saturating) is not trusted: offset instead.
  const steep = Array.from({ length: 14 }, (_, i) => [0.5 + i * 0.01, 0.2 + i * 0.05]);
  assert.equal(fitPairs(steep).kind, 'offset');
  assert.equal(theilSen([[0.5, 0.6], [0.5, 0.7]]), null, 'no slope from identical x');
});

const scene = (spot, date, sensor, ndvi, ndmi = null) => ({ spot, date, sensor, ndvi, ndmi });

test('harmonisation per sensor from overlap months, Landsat 5 through Landsat 7', () => {
  const spots = [];
  for (let k = 0; k < 4; k++) {
    const list = [];
    for (let m = 1; m <= 6; m++) {
      const v = 0.5 + 0.05 * m + 0.01 * k;
      const month = String(m + 3).padStart(2, '0');
      list.push(scene(k, `2017-${month}-05`, 'S2', v, v - 0.45));
      list.push(scene(k, `2017-${month}-12`, 'L8', v - 0.04, v - 0.47));
      list.push(scene(k, `2018-${month}-12`, 'L7', 0.95 * v - 0.01));
      list.push(scene(k, `2018-${month}-05`, 'S2', v));
      // Landsat 5 and 7 in 2010: L5 reads 0.02 above L7.
      list.push(scene(k, `2010-${month}-03`, 'L7', v - 0.1));
      list.push(scene(k, `2010-${month}-20`, 'L5', v - 0.08));
    }
    spots.push(list);
  }
  const fit = fitHarmonization(spots);
  const l8 = fit.ndvi.L8;
  assert.equal(l8.kind, 'linear');
  assert.equal(l8.pairs, 24);
  assert.ok(Math.abs(l8.slope - 1) < 1e-6 && Math.abs(l8.intercept - 0.04) < 1e-6, JSON.stringify(l8));
  const l7 = fit.ndvi.L7;
  assert.ok(Math.abs(l7.slope - 1 / 0.95) < 1e-3, JSON.stringify(l7));
  // Landsat 5 → Landsat 7 (−0.02) → Sentinel-2.
  const l5 = fit.ndvi.L5;
  assert.deepEqual([l5.kind, l5.via], ['chained', 'L7']);
  const v5 = 0.6;
  assert.ok(Math.abs(l5.intercept + l5.slope * v5 - (l7.intercept + l7.slope * (v5 - 0.02))) < 1e-3);
  assert.equal(fit.ndmi.L8.kind, 'linear');
  assert.equal(fit.ndmi.L7, null, 'no NDMI overlap for Landsat 7 here');
  assert.equal(fit.ndmi.L5, null, 'and so no chain for Landsat 5');

  // Monthly values: Sentinel-2 wins; Landsat alone is mapped onto its scale.
  const monthly = monthlySeries([
    scene(0, '2016-06-10', 'L8', 0.8), scene(0, '2017-06-05', 'S2', 0.86), scene(0, '2017-06-12', 'L8', 0.81),
    scene(0, '2016-07-10', 'L8', 0.8, 0.3),
  ], fit);
  const [jun16, jul16, jun17] = monthly;
  assert.deepEqual([jun16.month, jun16.ndvi, jun16.adjusted, jun16.raw.L8.ndvi], ['2016-06', 0.84, true, 0.8]);
  assert.deepEqual([jul16.ndmi, jul16.adjusted], [0.32, true]);
  assert.deepEqual([jun17.ndvi, jun17.sensors, jun17.adjusted], [0.86, ['S2', 'L8'], null]);
  // Without a fit for the sensor the value stays as measured and says so.
  const [raw] = monthlySeries([scene(0, '2009-06-10', 'L5', 0.7)], { ndvi: { L5: null } });
  assert.deepEqual([raw.ndvi, raw.adjusted], [0.7, false]);
});

test('a drop across 2017 hidden by the sensor difference shows after harmonisation', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-harm-'));
  const offline = async () => new Response('offline', { status: 503 });
  const app = createApp({ dataDir, weatherFetch: offline, tileOptions: { precompute: false } });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const db = app.locals.db;
  try {
    const now = Date.now();
    const insertScene = db.prepare(`INSERT INTO spot_ndvi_scenes (spot_id, scene_id, date, cloud, ndvi, ndmi, sensor, v, clear_fraction)
      VALUES (?, ?, ?, 5, ?, NULL, ?, 2, 1)`);
    const addSpot = (photos) => {
      const spot = Number(db.prepare('INSERT INTO spots (lat, lon, created_at) VALUES (47.36, 8.58, ?)').run(now).lastInsertRowid);
      for (const iso of photos) {
        db.prepare(`INSERT INTO photos (spot_id, file, taken_at, lat, lon, location_source, created_at) VALUES (?, ?, ?, 47.36, 8.58, 'exif', ?)`)
          .run(spot, `p${spot}-${iso}.jpg`, Date.parse(`${iso}T10:00:00Z`), now);
      }
      db.prepare(`INSERT INTO spot_ndvi (spot_id, lat, lon, from_date, to_date, fetched_at, complete) VALUES (?, 47.36, 8.58, '2014-01-01', ?, ?, 1)`)
        .run(spot, new Date(now).toISOString().slice(0, 10), now);
      return spot;
    };
    // Overlap 2017–2018 at four spots: Landsat 8 reads 0.04 below Sentinel-2.
    for (let k = 0; k < 4; k++) {
      const spot = addSpot(['2017-04-01']);
      for (let m = 4; m <= 9; m++) {
        const v = 0.5 + 0.05 * (m - 3) + 0.01 * k;
        insertScene.run(spot, `s${m}`, `2017-0${m}-05`, v, 'S2');
        insertScene.run(spot, `l${m}`, `2017-0${m}-12`, Math.round((v - 0.04) * 1000) / 1000, 'L8');
      }
    }
    // A spot photographed in July 2016 and July 2017; the canopy lost 0.10 NDVI in between (0.84 → 0.74).
    const spot = addSpot(['2016-07-10', '2017-07-12']);
    for (const y of [2014, 2015, 2016]) insertScene.run(spot, `l${y}`, `${y}-07-08`, 0.8, 'L8'); // 0.84 on the Sentinel-2 scale
    insertScene.run(spot, 's2017', '2017-07-06', 0.74, 'S2');

    const ndviOf = async () => (await fetch(`${base}/api/spots/${spot}/ndvi`)).json();
    // The fit is made on first use from the overlap months.
    const fit = await (await fetch(`${base}/api/satellite/harmonization`)).json();
    assert.deepEqual([fit.ndvi.L8.kind, fit.ndvi.L8.pairs], ['linear', 24]);
    assert.ok(Math.abs(fit.ndvi.L8.intercept - 0.04) < 0.002 && Math.abs(fit.ndvi.L8.slope - 1) < 0.01, JSON.stringify(fit.ndvi.L8));
    const after = await ndviOf();
    const jul16 = after.monthly.find((m) => m.month === '2016-07');
    assert.deepEqual([jul16.ndvi, jul16.raw.L8.ndvi, jul16.adjusted], [0.84, 0.8, true]);
    assert.deepEqual(after.drops.map((d) => [d.index, d.drop, d.severity]), [['ndvi', 0.1, 'auffällig']]);

    // Measured as is, Landsat's lower reading would have hidden it: 0.80 → 0.74 is only 0.06.
    db.prepare(`UPDATE satellite_harmonization SET json = '{"ndvi":{"L8":null,"L7":null,"L5":null},"ndmi":{"L8":null,"L7":null,"L5":null}}'`).run();
    const before = await ndviOf();
    assert.deepEqual(before.drops, []);
    assert.equal(before.monthly.find((m) => m.month === '2016-07').adjusted, false);
    // Fitting again restores it.
    await fetch(`${base}/api/satellite/harmonization`, { method: 'POST' });
    assert.equal((await ndviOf()).drops.length, 1);
  } finally {
    await app.locals.idle();
    server.close();
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
