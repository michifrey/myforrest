'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { distanceM, positionAt } = require('../src/geo');
const { parseGpx } = require('../src/gpx');
const { exifDateToUtc, parseOffset } = require('../src/exif');
const { neophyteName } = require('../src/neophytes');
const { parseTags } = require('../src/tags');

test('distanceM is roughly correct', () => {
  // 0.001° latitude ≈ 111 m
  const d = distanceM({ lat: 47, lon: 8 }, { lat: 47.001, lon: 8 });
  assert.ok(Math.abs(d - 111.2) < 0.5, `got ${d}`);
});

test('parseGpx reads timestamped track points in either attribute order', () => {
  const gpx = `<?xml version="1.0"?><gpx><trk><trkseg>
    <trkpt lon="8.0002" lat="47.0002"><ele>500</ele><time>2024-05-01T08:00:20Z</time></trkpt>
    <trkpt lat="47.0000" lon="8.0000"><time>2024-05-01T08:00:00Z</time></trkpt>
    <trkpt lat="47.1" lon="8.1"></trkpt>
  </trkseg></trk></gpx>`;
  const pts = parseGpx(gpx);
  assert.equal(pts.length, 2);
  assert.deepEqual(pts[0], { lat: 47, lon: 8, time: Date.parse('2024-05-01T08:00:00Z') });
});

test('positionAt interpolates and respects the tolerance', () => {
  const t0 = Date.parse('2024-05-01T08:00:00Z');
  const track = [{ lat: 47, lon: 8, time: t0 }, { lat: 47.002, lon: 8.002, time: t0 + 20000 }];
  const mid = positionAt(track, t0 + 10000);
  assert.ok(Math.abs(mid.lat - 47.001) < 1e-9 && Math.abs(mid.lon - 8.001) < 1e-9);
  assert.deepEqual(positionAt(track, t0 - 60000), { lat: 47, lon: 8 });
  assert.equal(positionAt(track, t0 + 60 * 60 * 1000), null);
});

test('EXIF wall-clock time is converted to UTC using the offset', () => {
  assert.equal(parseOffset('+02:00'), 120);
  assert.equal(parseOffset('-0530'), -330);
  assert.equal(parseOffset('nonsense'), null);
  assert.equal(exifDateToUtc('2024:05:01 10:00:00', 120), Date.parse('2024-05-01T08:00:00Z'));
  assert.equal(exifDateToUtc(undefined, 0), null);
});

test('neophyteName matches binomials, authors and hybrid notation', () => {
  assert.equal(neophyteName('Impatiens glandulifera Royle'), 'Drüsiges Springkraut');
  assert.equal(neophyteName('Reynoutria x bohemica'), 'Bastard-Staudenknöterich');
  assert.equal(neophyteName('Fagus sylvatica'), null);
  assert.equal(neophyteName('Taxus baccata'), null);
});

test('parseTags keeps only known tags', () => {
  assert.deepEqual(parseTags('Sturmschaden, neophyt,foo,neophyt'), ['sturmschaden', 'neophyt']);
  assert.deepEqual(parseTags(['totholz', 1]), ['totholz']);
});

test('terrain horizon from DEM profiles: mountain to the east, curvature, batching, cache', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const { createElevation, HORIZON_DIRS, HORIZON_DIST } = require('../src/elevation');
  const [lat0, lon0] = [47, 8];
  const calls = [];
  // Flat 500 m plain with a 1500 m mountain 3 km east and a hill of 100 m everywhere at 20 km (hidden by curvature).
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const lats = u.searchParams.get('latitude').split(',').map(Number);
    const lons = u.searchParams.get('longitude').split(',').map(Number);
    calls.push(lats.length);
    const elevation = lats.map((la, i) => {
      const dx = (lons[i] - lon0) * 111320 * Math.cos((lat0 * Math.PI) / 180);
      const dy = (la - lat0) * 111320;
      if (Math.abs(dy) < 300 && dx > 2500 && dx < 3500) return 1500;
      return Math.hypot(dx, dy) > 19000 ? 600 : 500;
    });
    return new Response(JSON.stringify({ elevation }));
  };
  const db = new DatabaseSync(':memory:');
  const svc = createElevation({ db, fetchImpl });
  const h = await svc.horizon(lat0, lon0);
  assert.equal(calls.reduce((a, b) => a + b, 0), 1 + HORIZON_DIRS * HORIZON_DIST.length);
  assert.ok(calls.every((n) => n <= 100), 'at most 100 points per request');
  assert.equal(h.angles.length, 36);
  const expected = (Math.atan2(1000 - 2 - 3000 ** 2 / (2 * 6371000) * 0.87, 3000) * 180) / Math.PI;
  assert.ok(Math.abs(h.angles[9] - expected) < 0.1, `east ${h.angles[9]} vs ${expected}`);
  assert.equal(h.distances[9], 3000);
  // 100 m at 20 km: 100 − 2 − 27 m curvature drop → ~0.2°, the other directions stay low.
  assert.ok(h.angles[27] < 0.5 && h.angles[0] < 0.5, `west ${h.angles[27]}`);
  assert.ok(h.svf < 1 && h.svf > 0.95);
  const before = calls.length;
  await svc.horizon(lat0, lon0);
  assert.equal(calls.length, before, 'cached');
});
