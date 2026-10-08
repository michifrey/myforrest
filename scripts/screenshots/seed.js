'use strict';
// Builds the demo dataset through the running demo server, then adds what needs the network
// (Pl@ntNet identifications, Sentinel/Landsat scenes) straight into the database.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { execFileSync } = require('child_process');
const scene = require('./scene');

const BASE = process.env.BASE || 'http://localhost:3123';
const WORK = process.env.DEMO_DIR || path.join(__dirname, '.demo');
const DATA = path.join(WORK, 'data');
const IMG = path.join(WORK, 'img');
fs.mkdirSync(IMG, { recursive: true });

async function upload(file, fields) {
  const fd = new FormData();
  fd.append('photos', new Blob([fs.readFileSync(file)], { type: 'image/jpeg' }), path.basename(file));
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) fd.append(k, String(v));
  const res = await fetch(`${BASE}/api/photos`, { method: 'POST', body: fd });
  const body = await res.json();
  if (!body.created?.length) throw new Error(`${file}: ${JSON.stringify(body)}`);
  return body.created[0];
}

const SPOTS = [
  {
    name: 'windwurf', lat: 47.37327, lon: 8.57203, heading: 35, lay: scene.layout(11, { kind: 'beech', trees: 9 }), activity: 'joggen',
    trees: ['Fagus sylvatica', 'Picea abies'],
    visits: [
      ['2021-07-14T10:10', { season: 'summer' }, [], 'Buchenhallenwald am Jogging-Weg'],
      ['2021-10-20T16:40', { season: 'autumn', light: 0.3 }, []],
      ['2022-03-05T11:20', { season: 'winter', fallen: [3, 4, 5] }, ['sturmschaden', 'totholz'], 'Nach dem Sturm im Februar: drei Buchen geworfen'],
      ['2022-09-03T12:00', { season: 'summer', fallen: [3, 4, 5] }, ['sturmschaden', 'totholz']],
      ['2023-06-18T09:30', { season: 'spring', fallen: [3, 4, 5], regrowth: 0.3 }, ['totholz', 'verjuengung']],
      ['2024-06-30T20:20', { season: 'summer', fallen: [3, 4, 5], regrowth: 0.55, light: -0.4 }, ['totholz', 'verjuengung']],
      ['2025-10-12T15:00', { season: 'autumn', fallen: [3, 4, 5], regrowth: 0.85 }, ['totholz', 'verjuengung']],
      ['2026-05-20T07:40', { season: 'spring', fallen: [3, 4, 5], regrowth: 1 }, ['totholz', 'verjuengung'], 'Jungwuchs schliesst die Lücke'],
    ],
  },
  {
    name: 'kaefer', lat: 47.37684, lon: 8.57951, heading: 200, lay: scene.layout(22, { kind: 'spruce', trees: 11, path: false }), activity: 'wandern',
    trees: ['Picea abies', 'Abies alba'],
    visits: [
      ['2023-06-10T14:00', { season: 'summer' }, []],
      ['2024-08-20T17:15', { season: 'summer', brown: [2, 4] }, ['borkenkaefer'], 'Zwei Fichten mit roter Krone, Bohrmehl am Stamm'],
      ['2025-07-15T10:45', { season: 'summer', brown: [6, 7, 8], grey: [2, 4] }, ['borkenkaefer', 'totholz']],
    ],
  },
  {
    name: 'springkraut', lat: 47.36852, lon: 8.56684, heading: 120, lay: scene.layout(33, { kind: 'mixed', trees: 8, path: false }), activity: 'biken',
    trees: ['Fraxinus excelsior', 'Alnus glutinosa'],
    visits: [
      ['2024-07-20T18:00', { season: 'summer', balsam: 0.22 }, ['neophyt']],
      ['2025-07-28T18:30', { season: 'summer', balsam: 0.55 }, ['neophyt']],
      ['2026-08-10T09:10', { season: 'summer', balsam: 0.95 }, ['neophyt'], 'Springkraut deckt jetzt die ganze Bachböschung'],
    ],
  },
  {
    name: 'buchen', lat: 47.37521, lon: 8.56893, heading: 290, lay: scene.layout(44, { kind: 'beech', trees: 10 }), activity: 'joggen',
    trees: ['Fagus sylvatica'],
    visits: [
      ['2024-06-12T08:00', { season: 'summer' }, []],
      ['2025-09-21T08:30', { season: 'summer' }, []],
      ['2026-06-02T08:15', { season: 'summer' }, []],
    ],
  },
  {
    name: 'mischwald', lat: 47.37112, lon: 8.57684, heading: 75, lay: scene.layout(55, { kind: 'mixed', trees: 9 }), activity: 'wandern',
    trees: ['Fagus sylvatica', 'Abies alba', 'Acer pseudoplatanus'],
    visits: [
      ['2025-06-18T11:00', { season: 'summer' }, []],
      ['2026-06-14T11:30', { season: 'summer' }, []],
    ],
  },
  {
    name: 'verfaerbung', lat: 47.37410, lon: 8.58262, heading: 160, lay: scene.layout(66, { kind: 'beech', trees: 8 }), activity: 'biken',
    trees: ['Fagus sylvatica', 'Betula pendula'],
    visits: [
      ['2025-06-20T19:00', { season: 'summer' }, []],
      ['2025-08-25T18:40', { season: 'earlyautumn' }, ['fruehverfaerbung', 'trockenschaden'], 'Buchen färben schon Ende August, Boden staubtrocken'],
    ],
  },
];

// Neophyte findings (close-ups): Impatiens along the stream, spreading downstream; goldenrod in the windthrow gap.
const FINDINGS = [
  ['balsam', 2023, 47.36790, 8.56520],
  ['balsam', 2024, 47.36730, 8.56360], ['balsam', 2024, 47.36930, 8.56930],
  ['balsam', 2025, 47.36680, 8.56200], ['balsam', 2025, 47.36985, 8.57060],
  ['balsam', 2026, 47.36620, 8.56010], ['balsam', 2026, 47.37040, 8.57180],
  ['goldrute', 2024, 47.37400, 8.57120],
  ['goldrute', 2025, 47.37470, 8.57050], ['goldrute', 2025, 47.37280, 8.57330],
  ['goldrute', 2026, 47.37540, 8.56960], ['goldrute', 2026, 47.37230, 8.57440],
];
const SPECIES = {
  balsam: ['Impatiens glandulifera', 'Drüsiges Springkraut'],
  goldrute: ['Solidago canadensis', 'Kanadische Goldrute'],
};

async function main() {
  const db = new DatabaseSync(path.join(DATA, 'myforrest.db'));
  db.exec('PRAGMA busy_timeout = 15000'); // the server writes weather context in the background
  const identify = db.prepare(`INSERT INTO identifications (photo_id, scientific_name, common_name, score, neophyte, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  const spots = {};
  for (const s of SPOTS) {
    let first = null;
    for (const [i, [when, state, tags, note]] of s.visits.entries()) {
      const file = path.join(IMG, `${s.name}-${i}.jpg`);
      await scene.render(s.lay, { ...state, jitter: 100 + i * 7 + s.name.length }, file);
      const p = await upload(file, {
        lat: s.lat + (i ? (Math.random() - 0.5) * 0.00004 : 0), lon: s.lon,
        takenAt: `${when}:00+02:00`, utcOffsetMinutes: 120, activity: s.activity,
        tags: tags.join(','), note,
        spotId: first?.spotId, refPhotoId: first?.id,
      });
      db.prepare('UPDATE photos SET heading = ? WHERE id = ?').run(s.heading + (Math.random() - 0.5) * 8, p.id);
      if (s.name === 'springkraut') identify.run(p.id, ...SPECIES.balsam, 0.62 + i * 0.1, SPECIES.balsam[1], Date.now());
      first ??= p;
      console.log(s.name, when, p.id, 'spot', p.spotId, p.aligned ?? '');
    }
    db.prepare('UPDATE spots SET heading = ? WHERE id = ?').run(s.heading, first.spotId);
    spots[s.name] = first.spotId;
    for (const t of s.trees) {
      const r = await fetch(`${BASE}/api/spots/${first.spotId}/species`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scientificName: t }),
      });
      if (!r.ok) console.warn('tree', t, await r.text());
    }
  }
  for (const [i, [kind, year, lat, lon]] of FINDINGS.entries()) {
    const file = path.join(IMG, `fund-${i}.jpg`);
    await scene.renderCloseup(500 + i, kind === 'balsam' ? 'balsam' : 'goldrute', file);
    const month = kind === 'balsam' ? '08' : '09';
    const p = await upload(file, {
      lat, lon, takenAt: `${year}-${month}-${String(3 + i).padStart(2, '0')}T17:00:00+02:00`, utcOffsetMinutes: 120,
      activity: 'wandern', tags: 'neophyt',
    });
    identify.run(p.id, ...SPECIES[kind], 0.55 + (i % 4) * 0.1, SPECIES[kind][1], Date.now());
    console.log('fund', kind, year, p.id, 'spot', p.spotId);
  }
  seedSatellite(db, spots);
  // Live picture for the fake camera on the phone: spot 1 today, from a slightly different position.
  const live = path.join(IMG, 'live.jpg');
  await scene.render(SPOTS[0].lay, { season: 'summer', fallen: [3, 4, 5], regrowth: 1, jitter: 977 }, live);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-i', live, '-vf', 'scale=1280:960,format=yuv420p', '-t', '1', '-r', '10', path.join(IMG, 'live.y4m')]);
}

/** Monthly Sentinel-2 scenes (Landsat before 2017) with the real damage visible as drops. */
function seedSatellite(db, spots) {
  const ins = db.prepare(`INSERT OR REPLACE INTO spot_ndvi_scenes (spot_id, scene_id, date, cloud, ndvi, ndmi, clear_fraction, sensor, v)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2)`);
  const meta = db.prepare(`INSERT OR REPLACE INTO spot_ndvi (spot_id, lat, lon, from_date, to_date, fetched_at, complete, error)
    VALUES (?, ?, ?, ?, ?, ?, 1, NULL)`);
  const noise = (k) => (Math.sin(k * 12.9898) * 43758.5453) % 1 * 0.02;
  for (const [name, id] of Object.entries(spots)) {
    const spot = db.prepare('SELECT lat, lon FROM spots WHERE id = ?').get(id);
    let k = 0;
    for (let y = 2013; y <= 2026; y++) {
      for (let m = 1; m <= 12; m++) {
        if (y === 2026 && m > 10) break;
        const veg = Math.sin(((m - 4) / 12) * 2 * Math.PI); // −1 winter … +1 July
        let ndvi = 0.55 + 0.3 * Math.max(-0.6, veg);
        let ndmi = 0.18 + 0.2 * Math.max(-0.6, veg);
        const t = y + (m - 1) / 12;
        if (name === 'windwurf' && t >= 2022.1) { const f = Math.max(0, 1 - (t - 2022.1) / 4); ndvi -= 0.2 * f; ndmi -= 0.14 * f; }
        if (name === 'kaefer' && t >= 2024.55) { ndvi -= 0.05; ndmi -= 0.04; }
        if (name === 'kaefer' && y === 2026 && m >= 9) { ndvi -= 0.3; ndmi -= 0.17; }
        if (name === 'verfaerbung' && y === 2025 && m >= 7 && m <= 9) { ndvi -= 0.08; ndmi -= 0.1; }
        const sensor = y < 2017 ? 'L8' : 'S2';
        const day = String(5 + (k % 20)).padStart(2, '0');
        ins.run(id, `${sensor}_${id}_${y}${m}`, `${y}-${String(m).padStart(2, '0')}-${day}`, 8, +(ndvi + noise(++k)).toFixed(3), +(ndmi + noise(k + 99)).toFixed(3), 0.95, sensor);
      }
    }
    meta.run(id, spot.lat, spot.lon, '1984-04-01', '2026-10-08', Date.now() + 365 * 86400000);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
