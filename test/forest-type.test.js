'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { forestType, seasonalAmplitude } = require('../src/forest-type');
const { calibrateAll, calibrationFor } = require('../src/calibration');
const { pairDrop, indexDrops } = require('../src/sentinel');
const { treeInfo } = require('../src/trees');

/** Monthly NDVI over three years: `summer` in June–August, `winter` in December–February. */
const seasons = (summer, winter) => [2021, 2022, 2023].flatMap((y) => [
  ...['01', '02', '12'].map((m) => ({ month: `${y}-${m}`, ndvi: winter })),
  ...['06', '07', '08'].map((m) => ({ month: `${y}-${m}`, ndvi: summer })),
]);

test('forest type from species, then the photos, then the satellite seasons', () => {
  const fichte = treeInfo('Picea abies');
  const buche = treeInfo('Fagus sylvatica');
  const tanne = treeInfo('Abies alba');
  assert.deepEqual(forestType({ species: [fichte, tanne, buche] }), { type: 'nadel', label: 'Nadelwald', source: 'arten', needleShare: 0.67, species: 3 });
  assert.equal(forestType({ species: [fichte, buche] }).type, 'misch');
  // Species win over the photos; photos over the satellite.
  assert.equal(forestType({ species: [buche], needleShares: [0.9], monthly: seasons(0.8, 0.7) }).type, 'laub');
  assert.deepEqual(forestType({ needleShares: [0.2, 0.3, 0.7], monthly: seasons(0.8, 0.7) }), { type: 'laub', label: 'Laubwald', source: 'fotos', needleShare: 0.3, photos: 3 });
  // Deciduous canopies lose their leaves in winter, evergreen conifers stay green.
  assert.deepEqual(forestType({ monthly: seasons(0.85, 0.4) }), { type: 'laub', label: 'Laubwald', source: 'satellit', amplitude: 0.45 });
  assert.equal(forestType({ monthly: seasons(0.8, 0.72) }).type, 'nadel');
  assert.equal(forestType({ monthly: seasons(0.8, 0.62) }).type, 'misch');
  assert.equal(seasonalAmplitude(seasons(0.8, 0.7).slice(0, 4)), null, 'too few months of each season');
  assert.deepEqual(forestType({}), { type: null, label: null, source: null });
});

test('the drop between two photos is the same-season comparison, with calibrated thresholds', () => {
  const monthly = [2021, 2022, 2023].map((y) => ({ month: `${y}-06`, ndvi: 0.86 }));
  monthly.push({ month: '2024-06', ndvi: 0.74 });
  assert.deepEqual(pairDrop(monthly, '2023-06-15', '2024-06-20', 'ndvi'), { before: 0.86, after: 0.74, drop: 0.12 });
  assert.equal(pairDrop(monthly, '2024-06-15', '2024-06-20', 'ndvi'), null, 'same month');
  const photos = [{ id: 1, takenAt: '2023-06-15T10:00:00Z' }, { id: 2, takenAt: '2024-06-20T10:00:00Z' }];
  assert.equal(indexDrops(monthly, photos)[0].severity, 'auffällig');
  assert.deepEqual(indexDrops(monthly, photos, { threshold: 0.13, strong: 0.26 }), []);
  assert.equal(indexDrops(monthly, photos, { threshold: 0.06, strong: 0.12 })[0].severity, 'stark');
});

/** A check per spot: [spot, damage, forest type, drop] (early warning and between photos alike). */
const check = ([spotId, damage, forestType, drop]) => ({ spotId, damage, forestType, warning: { ndvi: drop, ndmi: null }, photos: { ndvi: drop, ndmi: null } });

test('broadleaf and conifer spots get their own threshold when it does better on held-out spots', () => {
  // Broadleaf crowns swing more: healthy drops up to 0.13, damage from 0.18. Bark beetles in
  // conifers lower NDVI only a little: damage from 0.06, healthy below 0.03.
  const laub = Array.from({ length: 20 }, (_, i) => [i, i % 2 === 0, 'laub', i % 2 === 0 ? 0.18 + (i % 5) * 0.01 : 0.09 + (i % 5) * 0.01]);
  const nadel = Array.from({ length: 20 }, (_, i) => [100 + i, i % 2 === 0, 'nadel', i % 2 === 0 ? 0.06 + (i % 4) * 0.01 : (i % 3) * 0.01]);
  const mixed = [[200, true, 'misch', 0.2], [201, false, null, 0.02]];
  const cal = calibrateAll([...laub, ...nadel, ...mixed].map(check));
  assert.equal(cal.checks, 42);
  // On all spots one threshold has to compromise between the two.
  assert.equal(cal.ndvi.source, 'kalibriert');
  const overall = cal.ndvi.threshold;
  assert.ok(cal.ndvi.at.f1 < 1, `all spots: F1 ${cal.ndvi.at.f1} at ${overall}`);
  const l = cal.forestTypes.laub;
  const n = cal.forestTypes.nadel;
  assert.deepEqual([l.checks, l.spots, n.checks, n.spots], [20, 20, 20, 20]);
  assert.deepEqual([l.ndvi.source, l.ndvi.baseline, l.ndvi.standard.threshold], ['kalibriert', 'alle-spots', overall]);
  assert.deepEqual([n.ndvi.source, n.ndvi.threshold, n.ndvi.cv.f1], ['kalibriert', 0.06, 1]);
  assert.ok(l.ndvi.threshold > 0.13 && l.ndvi.threshold <= 0.18, `broadleaf ${l.ndvi.threshold}`);
  assert.equal(l.photos.ndvi.threshold, l.ndvi.threshold, 'the drop between photos is calibrated the same way');
  // NDMI: nothing to calibrate anywhere, the starting value everywhere.
  assert.deepEqual([cal.ndmi.threshold, l.ndmi.threshold, l.ndmi.reason], [0.08, 0.08, 'zu-wenige-kontrollen']);

  // Which calibration applies: the forest type's own, else the one of all spots.
  assert.deepEqual(Object.values(calibrationFor(cal, { type: 'nadel', key: 'ndvi' })).slice(0, 2).map((x) => x.threshold ?? x), [0.06, 'waldtyp']);
  const misch = calibrationFor(cal, { type: 'misch', key: 'ndvi' });
  assert.deepEqual([misch.entry.threshold, misch.scope, misch.typeEntry], [overall, 'alle', null]);
  assert.equal(calibrationFor(cal, { measure: 'photos', type: 'laub', key: 'ndvi' }).entry, l.photos.ndvi);
  const ndmi = calibrationFor(cal, { type: 'laub', key: 'ndmi' });
  assert.deepEqual([ndmi.scope, ndmi.typeEntry.reason], ['alle', 'zu-wenige-kontrollen']);
});

test('the spot view uses the calibrated threshold of its forest type for drops between photos', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-forest-'));
  const offline = async () => new Response('offline', { status: 503 });
  const app = createApp({ dataDir, weatherFetch: offline, tileOptions: { precompute: false } });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const db = app.locals.db;
  try {
    const now = Date.now();
    const d = (iso) => Date.parse(`${iso}T10:00:00Z`);
    const scene = db.prepare(`INSERT INTO spot_ndvi_scenes (spot_id, scene_id, date, cloud, ndvi, ndmi, sensor, v, clear_fraction)
      VALUES (?, ?, ?, 5, ?, NULL, 'S2', 2, 1)`);
    /** A spot with photos in June 2023 and June 2024 and NDVI 0.86 every June before; `after` in June 2024. */
    const addSpot = (after, { tags = [], species = null } = {}) => {
      const spot = Number(db.prepare('INSERT INTO spots (lat, lon, created_at) VALUES (47.36, 8.58, ?)').run(now).lastInsertRowid);
      for (const [iso, t] of [['2023-06-15', []], ['2024-06-20', tags]]) {
        const id = Number(db.prepare(`INSERT INTO photos (spot_id, file, taken_at, lat, lon, location_source, created_at)
          VALUES (?, ?, ?, 47.36, 8.58, 'exif', ?)`).run(spot, `p${spot}-${iso}.jpg`, d(iso), now).lastInsertRowid);
        for (const tag of t) db.prepare('INSERT INTO photo_tags (photo_id, tag) VALUES (?, ?)').run(id, tag);
      }
      if (species) {
        db.prepare("INSERT INTO spot_species (spot_id, scientific_name, source, created_at) VALUES (?, ?, 'manual', ?)").run(spot, species, now);
      }
      db.prepare(`INSERT INTO spot_ndvi (spot_id, lat, lon, from_date, to_date, fetched_at, complete) VALUES (?, 47.36, 8.58, '2020-01-01', ?, ?, 1)`)
        .run(spot, new Date(now).toISOString().slice(0, 10), now);
      for (const y of [2020, 2021, 2022, 2023]) scene.run(spot, `s${y}`, `${y}-06-10`, 0.86);
      scene.run(spot, 's2024', '2024-06-10', after);
      return spot;
    };
    // Spruce stands: bark-beetle damage lowers NDVI by 0.06–0.09, healthy stands by at most 0.02.
    for (let i = 0; i < 10; i++) {
      addSpot(0.86 - (0.06 + (i % 4) * 0.01), { tags: ['borkenkaefer'], species: 'Picea abies' });
      addSpot(0.86 - (i % 3) * 0.01, { species: 'Picea abies' });
    }
    // Beech stands swing more: healthy ones drop by up to 0.13, damage from 0.18.
    for (let i = 0; i < 40; i++) {
      if (i % 4 === 0) addSpot(0.86 - (0.18 + (i % 3) * 0.01), { tags: ['sturmschaden'], species: 'Fagus sylvatica' });
      else addSpot(0.86 - (0.09 + (i % 5) * 0.01), { species: 'Fagus sylvatica' });
    }
    const cal = await (await fetch(`${base}/api/satellite/calibration`, { method: 'POST' })).json();
    assert.ok(cal.ndvi.threshold >= 0.1, `all spots: ${cal.ndvi.threshold}`);
    assert.deepEqual([cal.forestTypes.nadel.spots, cal.forestTypes.nadel.photos.ndvi.source, cal.forestTypes.nadel.photos.ndvi.threshold], [20, 'kalibriert', 0.06]);

    // A new spruce spot dropping 0.07: below the starting value 0.10, above the conifer threshold.
    const spruce = addSpot(0.79, { species: 'Picea abies' });
    const view = await (await fetch(`${base}/api/spots/${spruce}/ndvi`)).json();
    assert.deepEqual([view.forestType.type, view.forestType.source], ['nadel', 'arten']);
    assert.equal(view.drops.length, 1);
    const [drop] = view.drops;
    assert.deepEqual([drop.drop, drop.severity, drop.calibration.scope, drop.calibration.threshold, drop.calibration.forestType.label], [0.07, 'auffällig', 'waldtyp', 0.06, 'Nadelwald']);
    // The same drop at a beech spot is within what healthy beech stands do.
    const beech = addSpot(0.79, { species: 'Fagus sylvatica' });
    const other = await (await fetch(`${base}/api/spots/${beech}/ndvi`)).json();
    assert.equal(other.forestType.type, 'laub');
    assert.deepEqual(other.drops, []);
    // A spot of unknown type uses the threshold of all spots.
    const unknown = await (await fetch(`${base}/api/spots/${addSpot(0.6)}/ndvi`)).json();
    assert.deepEqual([unknown.forestType.type, unknown.drops[0].calibration.scope, unknown.drops[0].calibration.threshold], [null, 'alle', cal.ndvi.threshold]);
  } finally {
    await app.locals.idle();
    server.close();
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
