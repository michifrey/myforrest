'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { spreadFronts, convexHull, polygonArea } = require('../src/spread');
const { csvField } = require('../src/export');

/** Minimal RFC 4180 line parser for the assertions. */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') quoted = false; else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

const noWeather = async () => new Response('offline', { status: 503 });

async function withServer(fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-species-'));
  const app = createApp({ dataDir, weatherFetch: noWeather });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, app.locals.db);
  } finally {
    await app.locals.idle();
    server.close();
    app.locals.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

// Metres → degrees around 47° N.
const dLat = (m) => m / 110540;
const dLon = (m) => m / (111320 * Math.cos((47 * Math.PI) / 180));

/** Inserts a photo with Pl@ntNet candidates [[name, score, neophyte?], …]. */
function addFinding(db, { lat, lon, date, source = 'exif', note = null, candidates }) {
  const now = Date.now();
  const spot = db.prepare('INSERT INTO spots (lat, lon, created_at) VALUES (?, ?, ?)').run(lat, lon, now).lastInsertRowid;
  const photo = db.prepare(`
    INSERT INTO photos (spot_id, file, taken_at, lat, lon, location_source, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(spot, `f${spot}-${Math.random().toString(36).slice(2)}.jpg`, Date.parse(date), lat, lon, source, note, now).lastInsertRowid;
  const ins = db.prepare('INSERT INTO identifications (photo_id, scientific_name, common_name, score, neophyte, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (const [name, score, neo = null] of candidates) ins.run(photo, name, null, score, neo, now);
  return Number(photo);
}

const IMPATIENS = ['Impatiens glandulifera', 0.82, 'Drüsiges Springkraut'];

function seed(db) {
  const o = { lat: 47, lon: 8 };
  // 2021: three findings close together; then the front moves ~120 m/year to the north-east.
  addFinding(db, { ...o, date: '2021-07-01T09:00:00Z', candidates: [IMPATIENS] });
  addFinding(db, { lat: o.lat + dLat(10), lon: o.lon, date: '2021-07-02T09:00:00Z', candidates: [IMPATIENS] });
  addFinding(db, { lat: o.lat, lon: o.lon + dLon(10), date: '2021-08-01T09:00:00Z', candidates: [IMPATIENS] });
  const ne = (m) => ({ lat: o.lat + dLat(m / Math.SQRT2), lon: o.lon + dLon(m / Math.SQRT2) });
  addFinding(db, { ...ne(120), date: '2022-07-10T09:00:00Z', candidates: [IMPATIENS], note: '=SUM(A1) "Bestand" am Bach' });
  addFinding(db, { ...ne(240), date: '2023-07-10T09:00:00Z', source: 'gpx', candidates: [IMPATIENS, ['Impatiens noli-tangere', 0.1]] });
  // A beech: top candidate is not a neophyte even though a weaker neophyte candidate exists.
  addFinding(db, { lat: 47.01, lon: 8.01, date: '2022-05-01T09:00:00Z', source: 'manual', candidates: [['Fagus sylvatica', 0.7], ['Robinia pseudoacacia', 0.4, 'Robinie']] });
  // Too uncertain to count.
  addFinding(db, { lat: 47.02, lon: 8.02, date: '2022-05-01T09:00:00Z', candidates: [['Solidago canadensis', 0.08, 'Kanadische Goldrute']] });
}

test('occurrences use the best candidate per photo and respect filters', async () => {
  await withServer(async (base, db) => {
    seed(db);
    const all = await (await fetch(`${base}/api/occurrences`)).json();
    assert.equal(all.length, 6, 'low-score photo excluded by default');
    assert.ok(all.every((o) => o.scientificName !== 'Robinia pseudoacacia'), 'only the top candidate counts');

    const neo = await (await fetch(`${base}/api/occurrences?neophytes=1`)).json();
    assert.equal(neo.length, 5);
    assert.ok(neo.every((o) => o.neophyte === 'Drüsiges Springkraut'));

    const low = await (await fetch(`${base}/api/occurrences?minScore=0.05&neophytes=true`)).json();
    assert.equal(low.length, 6);

    const bySpecies = await (await fetch(`${base}/api/occurrences?species=${encodeURIComponent('Fagus sylvatica L.')}`)).json();
    assert.deepEqual(bySpecies.map((o) => o.scientificName), ['Fagus sylvatica']);

    const inBox = await (await fetch(`${base}/api/occurrences?bbox=7.999,46.999,8.0005,47.0005`)).json();
    assert.equal(inBox.length, 3);

    const dated = await (await fetch(`${base}/api/occurrences?from=2022-01-01&to=2022-12-31`)).json();
    assert.equal(dated.length, 2);

    assert.equal((await fetch(`${base}/api/occurrences?bbox=1,2,3`)).status, 400);
    assert.equal((await fetch(`${base}/api/occurrences?minScore=2`)).status, 400);
    assert.equal((await fetch(`${base}/api/occurrences?from=gestern`)).status, 400);

    const species = await (await fetch(`${base}/api/species`)).json();
    assert.equal(species[0].scientificName, 'Impatiens glandulifera');
    assert.equal(species[0].count, 5);
    assert.deepEqual(species[0].years, [2021, 2022, 2023]);
    assert.equal(species[1].scientificName, 'Fagus sylvatica');
  });
});

test('spread fronts: nested yearly hulls and rate towards north-east', async () => {
  await withServer(async (base, db) => {
    seed(db);
    const s = await (await fetch(`${base}/api/spread?species=Impatiens%20glandulifera`)).json();
    assert.equal(s.count, 5);
    assert.deepEqual(s.years.map((y) => y.year), [2021, 2022, 2023]);
    assert.deepEqual(s.years.map((y) => y.cumulativeCount), [3, 4, 5]);
    for (let i = 1; i < s.years.length; i++) assert.ok(s.years[i].areaM2 > s.years[i - 1].areaM2);
    assert.ok(s.rate.mPerYear > 100 && s.rate.mPerYear < 135, `rate ${s.rate.mPerYear}`);
    assert.equal(s.rate.compass, 'NO');
    assert.match(s.text, /^Ausbreitung ~1\d0 m\/Jahr nach NO \(2021–2023\)$/);
    assert.ok(s.years[0].hull.length >= 3);
    assert.ok(s.method.length > 20);

    assert.equal((await fetch(`${base}/api/spread`)).status, 400);
    const none = await (await fetch(`${base}/api/spread?species=Ailanthus%20altissima`)).json();
    assert.equal(none.count, 0);
    assert.deepEqual(none.years, []);
  });
});

test('Darwin Core and iNaturalist CSV exports', async () => {
  await withServer(async (base, db) => {
    seed(db);
    let res = await fetch(`${base}/api/export/dwc.csv?neophytes=1`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    assert.match(res.headers.get('content-disposition'), /attachment; filename="myforrest-darwin-core-/);
    const dwc = (await res.text()).trim().split('\r\n');
    const head = parseCsvLine(dwc[0]);
    assert.ok(['scientificName', 'eventDate', 'decimalLatitude', 'decimalLongitude', 'coordinateUncertaintyInMeters',
      'basisOfRecord', 'identificationRemarks', 'associatedMedia', 'license'].every((c) => head.includes(c)));
    assert.equal(dwc.length, 6);
    const row = parseCsvLine(dwc[1]);
    const col = (name) => row[head.indexOf(name)];
    assert.equal(col('basisOfRecord'), 'HumanObservation');
    assert.equal(col('scientificName'), 'Impatiens glandulifera');
    assert.equal(col('eventDate'), '2021-07-01T09:00:00Z');
    assert.equal(col('decimalLatitude'), '47');
    assert.equal(col('coordinateUncertaintyInMeters'), '15');
    assert.equal(col('establishmentMeans'), 'introduced');
    assert.equal(col('identificationRemarks'), 'Automatisch bestimmt mit Pl@ntNet, Score 0.82');
    assert.match(col('associatedMedia'), new RegExp(`^${base}/uploads/f\\d+-\\w+\\.jpg$`));
    assert.equal(col('license'), 'https://creativecommons.org/licenses/by-sa/4.0/', 'default licence as CC URI');
    // Note with quotes and a formula prefix is quoted and defused.
    assert.ok(dwc[4].includes('"\'=SUM(A1) ""Bestand"" am Bach"'));
    assert.ok(dwc[5].includes(',25,'), 'GPX-located photo has 25 m uncertainty');

    res = await fetch(`${base}/api/export/inaturalist.csv?species=Fagus%20sylvatica`);
    const inat = (await res.text()).trim().split('\r\n');
    assert.equal(inat[0], 'Taxon name,Date observed,Description,Place name,Latitude / y coord / northing,Longitude / x coord / easting,Tags,Geoprivacy');
    assert.equal(inat.length, 2);
    assert.match(inat[1], /^Fagus sylvatica,2022-05-01T09:00:00Z,"Automatisch bestimmt mit Pl@ntNet, Score 0\.70 · Foto: http:\/\/127\.0\.0\.1:\d+\/uploads\/[^"]+",,47\.01,8\.01,"myforrest,plantnet",open$/);
  });
});

test('export uses each photo\'s licence and leaves out hidden photos', async () => {
  await withServer(async (base, db) => {
    seed(db);
    db.exec("UPDATE photos SET license = 'cc0-1.0'");
    const dwc = (await (await fetch(`${base}/api/export/dwc.csv?species=Fagus%20sylvatica`)).text()).trim().split('\r\n');
    assert.ok(dwc[1].endsWith(',https://creativecommons.org/publicdomain/zero/1.0/'));
    const all = (await (await fetch(`${base}/api/occurrences`)).json());
    const count = (all.occurrences || all).length;
    db.exec(`UPDATE photos SET hidden_at = ${Date.now()} WHERE id = (SELECT MIN(id) FROM photos)`);
    const after = (await (await fetch(`${base}/api/occurrences`)).json());
    assert.equal((after.occurrences || after).length, count - 1);
  });
});

test('spread and CSV helpers', () => {
  const hull = convexHull([[0, 0], [10, 0], [10, 10], [0, 10], [5, 5]]);
  assert.equal(hull.length, 4);
  assert.equal(polygonArea(hull), 100);
  // A single year cannot give a rate.
  const one = spreadFronts([{ lat: 47, lon: 8, takenAt: Date.parse('2024-06-01') }]);
  assert.equal(one.rate, null);
  assert.match(one.text, /nur einem Jahr/);
  // A single buffered point covers about π·r².
  assert.ok(Math.abs(one.years[0].areaM2 - Math.PI * 625) < 80);
  assert.equal(csvField(-8.5), '-8.5');
  assert.equal(csvField('-x'), "'-x");
  assert.equal(csvField('a,b'), '"a,b"');
});

test('alpha shapes: separate patches, holes, nesting, and the convex limit', () => {
  const { alphaShape, createFrame, autoAlpha, distanceTransform } = require('../src/alphashape');
  // Exact distance transform on a tiny grid.
  const f = new Uint8Array(25); f[12] = 1;
  const d = distanceTransform(f, 5, 5);
  assert.deepEqual([d[12], d[13], d[18], d[0]], [0, 1, 2, 8]);

  // Two clusters 2 km apart stay two patches; together they are far smaller than their convex hull.
  const line = (x0) => Array.from({ length: 20 }, (_, i) => [x0 + i * 10, 0]);
  const two = [...line(0), ...line(2000)];
  const s = alphaShape(two, createFrame(two, { alpha: 60, buffer: 25 }));
  assert.equal(s.patches, 2);
  const expected = 2 * (190 * 50 + Math.PI * 25 * 25);
  assert.ok(Math.abs(s.areaM2 - expected) / expected < 0.25, `area ${s.areaM2} vs ${Math.round(expected)}`);

  // Findings around a pond: a ring with a hole, unless α is wider than the pond.
  const ring = Array.from({ length: 72 }, (_, k) => [500 * Math.cos((k * Math.PI) / 36), 500 * Math.sin((k * Math.PI) / 36)]);
  const r = alphaShape(ring, createFrame(ring, { alpha: 80, buffer: 25 }));
  assert.deepEqual([r.patches, r.polygons[0].length], [1, 2], 'outer ring plus one hole');
  const annulus = Math.PI * (525 ** 2 - 475 ** 2);
  assert.ok(Math.abs(r.areaM2 - annulus) / annulus < 0.1, `annulus ${r.areaM2} vs ${Math.round(annulus)}`);
  const full = alphaShape(ring, createFrame(ring, { alpha: 5000, buffer: 25 }));
  assert.deepEqual([full.patches, full.polygons[0].length], [1, 1], 'large α closes the hole');
  assert.ok(Math.abs(full.areaM2 - Math.PI * 525 ** 2) / (Math.PI * 525 ** 2) < 0.05);

  // Shapes in one frame grow with the point set (nesting), outer rings run counter-clockwise.
  const frame = createFrame(two, { alpha: 60, buffer: 25 });
  assert.ok(alphaShape(line(0), frame).areaM2 < s.areaM2);
  const outer = s.polygons[0][0];
  let a2 = 0;
  for (let i = 0; i < outer.length; i++) a2 += outer[i][0] * outer[(i + 1) % outer.length][1] - outer[(i + 1) % outer.length][0] * outer[i][1];
  assert.ok(a2 > 0);

  // Automatic α: 2.5 times the 90th percentile of neighbour distances, at least twice the buffer.
  assert.equal(autoAlpha(line(0), 25), 50);
  assert.equal(autoAlpha(Array.from({ length: 10 }, (_, i) => [i * 40, 0]), 25), 100);
});

test('spread fronts use alpha shapes by default, the convex hull on request', async () => {
  await withServer(async (base, db) => {
    seed(db);
    const alpha = await (await fetch(`${base}/api/spread?species=Impatiens%20glandulifera`)).json();
    assert.equal(alpha.shape, 'alpha');
    assert.ok(alpha.alphaM >= 50);
    for (const y of alpha.years) {
      assert.ok(y.areaM2 <= y.convexAreaM2 * 1.1, `${y.year}: alpha ${y.areaM2} vs convex ${y.convexAreaM2}`);
      assert.ok(y.polygons.length === y.patches && y.patches >= 1);
      assert.ok(y.polygons[0][0].length >= 3 && y.polygons[0][0][0].length === 2);
    }
    const tight = await (await fetch(`${base}/api/spread?species=Impatiens%20glandulifera&alpha=30`)).json();
    assert.ok(tight.years.at(-1).patches > 1, 'a small α splits the findings into patches');
    const convex = await (await fetch(`${base}/api/spread?species=Impatiens%20glandulifera&shape=convex`)).json();
    assert.equal(convex.shape, 'convex');
    assert.deepEqual(convex.years.map((y) => y.areaM2), convex.years.map((y) => y.convexAreaM2));
    assert.match(convex.method, /konvexe Hülle/);
    assert.equal((await fetch(`${base}/api/spread?species=Impatiens%20glandulifera&alpha=2`)).status, 400);
  });
});
