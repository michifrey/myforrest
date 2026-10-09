'use strict';
// Demo dataset for the glacier screenshots, in its own demo directory (the forest screenshots keep their map):
// the inventories of the demo glacier, a spot at its tongue with photos since 2017 and two archive pictures,
// a spot on the lateral moraine, and the snow and ice share of the Sentinel-2 scenes straight into the database.
// Start the demo server with DEMO_DIR=…/.demo-gletscher DEMO_GLETSCHER=1 (see README.md).
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const scene = require('./scene');
const glacier = require('./glacier-demo');

const BASE = process.env.BASE || 'http://localhost:3124';
const WORK = process.env.DEMO_DIR || path.join(__dirname, '.demo-gletscher');
const IMG = path.join(WORK, 'img');
fs.mkdirSync(IMG, { recursive: true });
fs.mkdirSync(path.join(WORK, 'gletscher'), { recursive: true });

async function upload(file, fields) {
  const fd = new FormData();
  fd.append('photos', new Blob([fs.readFileSync(file)], { type: 'image/jpeg' }), path.basename(file));
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) fd.append(k, String(v));
  const res = await fetch(`${BASE}/api/photos`, { method: 'POST', body: fd });
  const body = await res.json();
  if (!body.created?.length) throw new Error(`${file}: ${JSON.stringify(body)}`);
  return body.created[0];
}

// The tongue (looking south up the valley): photos since 2017, the ice moving away, a lake forming.
const TONGUE = {
  lat: 46.6003, lon: 8.4003, heading: 180, seed: 41,
  visits: [
    ['2017-08-24T11:20', { tongue: 0.78 }, ['gletscherzunge'], 'Die Zunge reicht noch bis an den Moränenwall'],
    ['2019-08-30T10:40', { tongue: 0.64, lake: 0.15 }, ['gletscherzunge', 'gletschersee']],
    ['2021-09-02T12:05', { tongue: 0.5, lake: 0.4 }, ['gletscherzunge', 'gletschersee'], 'Vor der Zunge ist ein See entstanden'],
    ['2023-08-28T11:50', { tongue: 0.38, lake: 0.6, green: 0.2 }, ['gletscherzunge', 'gletschersee', 'pioniervegetation']],
    ['2025-09-05T10:30', { tongue: 0.27, lake: 0.8, green: 0.45 }, ['gletscherzunge', 'gletschersee', 'pioniervegetation'], 'Der See ist seit 2021 deutlich gewachsen, auf dem Schutt keimen Weidenröschen'],
  ],
  archive: [
    ['1928-08-15', { tongue: 1 }, 'Alte Postkarte (Scan)'],
    ['1973-08-20', { tongue: 0.92 }, 'Dia aus einem Familienalbum (Scan)'],
  ],
};
// The western lateral moraine: on the ice of 1850, free since.
const MORAINE = {
  lat: 46.6085, lon: 8.3955, heading: 170, seed: 77,
  visits: [
    ['2018-07-30T09:10', { tongue: 0.2 }, ['schuttbedeckung']],
    ['2025-08-02T16:40', { tongue: 0.08, lake: 0.3, green: 0.6 }, ['schuttbedeckung', 'murgang'], 'Murgang aus der Seitenmoräne nach einem Gewitter'],
  ],
};
// An alpine pasture high above the valley (a mountain spot by its height): shrubs moving in.
const PASTURE = {
  lat: 46.625, lon: 8.383, heading: 120, seed: 93,
  visits: [
    ['2018-08-12T14:00', { tongue: 0, green: 0.7 }, []],
    ['2025-08-18T13:30', { tongue: 0, green: 1 }, ['verbuschung'], 'Grünerlen breiten sich auf der Weide aus, seit sie nicht mehr bestossen wird'],
  ],
};
// Month the snow melts at the pasture: from June to May, 2025 already in April.
const MELT = { 2017: 6, 2018: 6, 2019: 6, 2020: 5, 2021: 6, 2022: 5, 2023: 5, 2024: 5, 2025: 4, 2026: 5 };
// Lowest monthly snow and ice share of late summer per year at the tongue: ice until 2020, free from 2021.
const SUMMER_ICE = { 2017: 0.93, 2018: 0.9, 2019: 0.86, 2020: 0.7, 2021: 0.32, 2022: 0.05, 2023: 0.08, 2024: 0.04, 2025: 0.03, 2026: 0.02 };

async function spot(def) {
  let first = null;
  for (const [i, [when, state, tags, note]] of def.visits.entries()) {
    const file = path.join(IMG, `gl-${def.seed}-${i}.jpg`);
    await scene.renderGlacier(def.seed, state, file);
    const p = await upload(file, {
      lat: def.lat, lon: def.lon, takenAt: `${when}:00+02:00`, utcOffsetMinutes: 120, activity: 'wandern',
      tags: tags.join(','), note, spotId: first?.spotId, refPhotoId: first?.id,
    });
    first ??= p;
    console.log('gletscher', def.seed, when, p.id, 'spot', p.spotId);
  }
  for (const [i, [date, state, note]] of (def.archive || []).entries()) {
    const file = path.join(IMG, `gl-${def.seed}-archiv-${i}.jpg`);
    await scene.renderGlacier(def.seed, { ...state, archive: true }, file);
    const p = await upload(file, { spotId: first.spotId, refPhotoId: first.id, archive: '1', takenAt: `${date}T12:00:00Z`, note });
    console.log('archiv', date, p.id);
  }
  return first.spotId;
}

async function main() {
  for (const [file, doc] of Object.entries(glacier.inventories())) {
    fs.writeFileSync(path.join(WORK, 'gletscher', file), JSON.stringify(doc));
  }
  const db = new DatabaseSync(path.join(WORK, 'data', 'myforrest.db'));
  db.exec('PRAGMA busy_timeout = 15000');
  const ids = { tongue: await spot(TONGUE), moraine: await spot(MORAINE), pasture: await spot(PASTURE) };
  for (const [def, id] of [[TONGUE, ids.tongue], [MORAINE, ids.moraine]]) db.prepare('UPDATE spots SET heading = ? WHERE id = ?').run(def.heading, id);
  db.prepare('UPDATE photos SET heading = ? WHERE spot_id = ?').run(TONGUE.heading, ids.tongue);
  db.prepare('UPDATE photos SET heading = ? WHERE spot_id = ?').run(MORAINE.heading, ids.moraine);
  seedIce(db, ids.tongue, SUMMER_ICE);
  seedIce(db, ids.moraine, Object.fromEntries(Object.keys(SUMMER_ICE).map((y) => [y, 0.03])));
  seedSnow(db, ids.pasture, MELT);
}

/** Monthly Sentinel-2 scenes with the snow and ice share (winter white, late summer what is left). */
function seedIce(db, spotId, summers) {
  const spot = db.prepare('SELECT lat, lon FROM spots WHERE id = ?').get(spotId);
  const ins = db.prepare(`INSERT OR REPLACE INTO spot_ndvi_scenes (spot_id, scene_id, date, cloud, ndvi, ndmi, snow, clear_fraction, sensor, v)
    VALUES (?, ?, ?, 10, NULL, NULL, ?, 0, 'S2', 3)`);
  for (let y = 2017; y <= 2026; y++) {
    for (let m = 1; m <= 12; m++) {
      if (y === 2026 && m > 10) break;
      const s = summers[y];
      const snow = m >= 11 || m <= 5 ? 1 : m === 6 ? Math.min(1, s + 0.4) : m === 7 ? Math.min(1, s + 0.2) : m === 8 ? s : m === 9 ? s + 0.01 : Math.min(1, s + 0.35);
      ins.run(spotId, `S2_${spotId}_${y}${m}`, `${y}-${String(m).padStart(2, '0')}-${String(8 + (m % 10)).padStart(2, '0')}`, Math.round(snow * 100) / 100);
    }
  }
  db.prepare(`INSERT OR REPLACE INTO spot_ndvi (spot_id, lat, lon, from_date, to_date, fetched_at, complete, error)
    VALUES (?, ?, ?, '1984-04-01', '2026-10-08', ?, 1, NULL)`).run(spotId, spot.lat, spot.lon, Date.now() + 365 * 86400000);
}

/** A pasture: white winters, snow-free from the melt-out month, green in summer (NDVI). */
function seedSnow(db, spotId, melt) {
  const spot = db.prepare('SELECT lat, lon FROM spots WHERE id = ?').get(spotId);
  const ins = db.prepare(`INSERT OR REPLACE INTO spot_ndvi_scenes (spot_id, scene_id, date, cloud, ndvi, ndmi, snow, clear_fraction, sensor, v)
    VALUES (?, ?, ?, 10, ?, ?, ?, ?, 'S2', 3)`);
  for (let y = 2017; y <= 2026; y++) {
    for (let m = 1; m <= 12; m++) {
      if (y === 2026 && m > 10) break;
      const snow = m >= 11 || m < melt[y] ? 1 : m === melt[y] ? 0.3 : 0;
      const ndvi = snow ? null : Math.round((0.35 + 0.3 * Math.sin(((m - melt[y]) / 6) * Math.PI) + (y - 2017) * 0.006) * 1000) / 1000;
      ins.run(spotId, `S2_${spotId}_${y}${m}`, `${y}-${String(m).padStart(2, '0')}-12`, ndvi, ndvi === null ? null : Math.round((ndvi - 0.25) * 1000) / 1000, snow, ndvi === null ? 0 : 0.9);
    }
  }
  db.prepare(`INSERT OR REPLACE INTO spot_ndvi (spot_id, lat, lon, from_date, to_date, fetched_at, complete, error)
    VALUES (?, ?, ?, '1984-04-01', '2026-10-08', ?, 1, NULL)`).run(spotId, spot.lat, spot.lon, Date.now() + 365 * 86400000);
}

main().catch((e) => { console.error(e); process.exit(1); });
