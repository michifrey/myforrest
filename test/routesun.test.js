'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const RouteSun = require('../public/routesun.js');

const M = 111320;
/** A straight route from (47, 8) `km` kilometres to the east. */
const eastward = (km) => [{ lat: 47, lon: 8 }, { lat: 47, lon: 8 + (km * 1000) / (M * Math.cos(47 * Math.PI / 180)) }];
const flat = () => 400;
// Noon in Zurich on the summer solstice (sun ~66° high in the south) and an evening hour (sun low in the west-north-west).
const NOON = Date.UTC(2026, 5, 21, 11, 30);
const EVENING = Date.UTC(2026, 5, 21, 18, 30);

test('samples every 25 m with their share of the route and recorded times', () => {
  const s = RouteSun.sample(eastward(1));
  assert.equal(s.length, 41);
  assert.equal(s[0].d, 0);
  assert.ok(Math.abs(s.at(-1).d - 1000) < 1);
  const total = s.reduce((a, p) => a + p.w, 0);
  assert.ok(Math.abs(total - s.at(-1).d) < 1e-6, 'the weights add up to the length');
  const timed = RouteSun.sample([{ lat: 47, lon: 8, time: 0 }, { lat: 47.009, lon: 8, time: 600000 }]);
  assert.equal(timed[0].time, 0);
  assert.equal(timed.at(-1).time, 600000);
  assert.ok(Math.abs(timed[20].time - 300000) < 20000);
  assert.equal(RouteSun.sample([{ lat: 47, lon: 8 }]).length, 0);
  assert.ok(RouteSun.sample(eastward(100)).length <= 1601, 'long routes get a coarser step');
});

test('flat open land: sun by day, night after sunset', () => {
  const s = RouteSun.sample(eastward(2));
  const hz = RouteSun.horizons(s, { ground: flat });
  assert.ok(hz.every((h) => h.terrain.every((a) => a === 0) && h.objects === null));
  const day = RouteSun.along(s, hz, { start: NOON, speedKmh: 5 });
  assert.equal(day.sum.sonne, day.sum.total);
  assert.ok(day.points.every((p) => p.state === 'sonne'));
  const night = RouteSun.along(s, hz, { start: Date.UTC(2026, 5, 21, 22), speedKmh: 5 });
  assert.equal(night.sum.nacht, night.sum.total);
});

test('a ridge to the west shades the route in the evening, not at noon', () => {
  // 400 m flat, rising to 1400 m beyond 2 km west of the route's start.
  const westLon = 8 - 2000 / (M * Math.cos(47 * Math.PI / 180));
  const ground = (lat, lon) => (lon < westLon ? 1400 : 400);
  const s = RouteSun.sample(eastward(1));
  const hz = RouteSun.horizons(s, { ground });
  assert.ok(RouteSun.angleAt(hz[0].terrain, 270) > 20, 'high horizon in the west');
  assert.equal(RouteSun.angleAt(hz[0].terrain, 90), 0);
  assert.equal(RouteSun.along(s, hz, { start: NOON, speedKmh: 5 }).sum.schatten, 0);
  const evening = RouteSun.along(s, hz, { start: EVENING, speedKmh: 5 });
  assert.equal(evening.sum.gelaende, evening.sum.total, 'behind the ridge');
  assert.ok(evening.points.every((p) => p.altitude > 0), 'the sun is up, only the terrain hides it');
});

test('trees beside the route shade it, a crown above covers it', () => {
  const lonOf = (m) => 8 + m / (M * Math.cos(47 * Math.PI / 180));
  // A row of 20-m trees 5 m south of the route along its whole length.
  const row = (lat, lon) => (lat < 47 - 3 / M && lat > 47 - 8 / M ? 20 : 0);
  const s = RouteSun.sample(eastward(0.5));
  const hz = RouteSun.horizons(s, { ground: flat, objects: row });
  assert.ok(RouteSun.angleAt(hz[5].objects, 180) > 60, 'the trees stand high in the south');
  assert.equal(RouteSun.along(s, hz, { start: NOON, speedKmh: 5 }).sum.baeume, RouteSun.along(s, hz, { start: NOON, speedKmh: 5 }).sum.total);
  // A crown right above the path (forest): covered.
  const forest = (lat, lon) => (lon > lonOf(200) && lon < lonOf(300) ? 25 : 0);
  const f = RouteSun.horizons(s, { ground: flat, objects: forest });
  assert.ok(f.some((h) => h.covered) && f.some((h) => !h.covered));
  const r = RouteSun.along(s, f, { start: NOON, speedKmh: 5 });
  assert.ok(r.sum.baeume >= 50 && r.sum.baeume <= 125, `about 100 m under the trees: ${r.sum.baeume}`);
  // Where nothing is known about objects (null), only the terrain counts.
  const none = RouteSun.horizons(s, { ground: flat, objects: () => null });
  assert.ok(none.every((h) => h.objects === null));
});

test('start times: the shadiest start avoids the sun, none runs into the night', () => {
  const westLon = 8 - 2000 / (M * Math.cos(47 * Math.PI / 180));
  const ground = (lat, lon) => (lon < westLon ? 1400 : 400);
  const s = RouteSun.sample(eastward(5));
  const hz = RouteSun.horizons(s, { ground });
  const from = Date.UTC(2026, 5, 21, 4); const to = Date.UTC(2026, 5, 21, 20);
  const r = RouteSun.starts(s, hz, { from, to, speedKmh: 5, stepMin: 30 });
  assert.equal(r.list.length, 33);
  assert.ok(r.shadiest.schatten > 0.9, `evening behind the ridge: ${r.shadiest.schatten}`);
  assert.ok(new Date(r.shadiest.start).getUTCHours() >= 16);
  assert.equal(r.sunniest.sonne, 1);
  assert.equal(r.shadiest.nacht, 0);
  assert.ok(r.list.some((x) => x.nacht > 0), 'late starts end in the dark');
  // Recorded times win over the pace when asked for.
  const timed = s.map((p, i) => ({ ...p, time: NOON + i * 1000 }));
  assert.equal(RouteSun.timesOf(timed, { start: 0, speedKmh: 5, recorded: true })[3], NOON + 3000);
  assert.equal(RouteSun.timesOf(timed, { start: 0, speedKmh: 3.6 })[1], s[1].d * 1000);
});

test('tile sampler and tiles near a route', () => {
  // One zoom-1 tile with a gradient: value = x.
  const tile = new Float32Array(65536).map((_, i) => i % 256);
  const get = (x, y) => (x === 1 && y === 0 ? tile : null);
  const smooth = RouteSun.tileSampler(1, get);
  const v = smooth(40, 90); // x pixel 128 of tile 1 → 128 - 0.5 interpolated
  assert.ok(Math.abs(v - 127.5) < 1, `${v}`);
  assert.ok(Number.isNaN(smooth(40, -90)), 'no tile there');
  assert.equal(RouteSun.tileSampler(1, get, { smooth: false, none: null })(-40, -90), null);
  const tiles = RouteSun.tilesNear(eastward(1), 16, 120);
  assert.ok(tiles.length >= 3 && tiles.length <= 12, tiles.join(' '));
  assert.ok(tiles.every((k) => /^\d+\/\d+$/.test(k)));
});

test('pace after the slope: slower uphill, fastest slightly downhill (Tobler), the flat speed unchanged', () => {
  assert.equal(RouteSun.toblerRel(0), 1);
  assert.ok(RouteSun.toblerRel(-0.05) > 1.18 && RouteSun.toblerRel(-0.05) < 1.2, 'gentle descent ~19 % faster');
  assert.ok(RouteSun.toblerRel(0.2) < 0.5, '20 % uphill less than half the speed');
  assert.ok(RouteSun.toblerRel(-0.3) < 1, 'steep descents are slow again');
  const s = RouteSun.sample(eastward(1));
  const flatTimes = RouteSun.timesOf(s, { start: 0, speedKmh: 4, slope: true });
  assert.ok(Math.abs(flatTimes.at(-1) - 15 * 60000) < 1000, 'no heights: 1 km at 4 km/h is 15 min');
  // 1 km rising 100 m: Tobler gives ~3,6 km/h at 10 % for 5 km/h on the flat.
  const up = s.map((p) => ({ ...p, z: 400 + p.d * 0.1 }));
  const upTime = RouteSun.timesOf(up, { start: 0, speedKmh: 5, slope: true }).at(-1);
  assert.ok(Math.abs(upTime / 60000 - 60 / (5 * RouteSun.toblerRel(0.1))) < 0.5, `${upTime / 60000} min`);
  assert.ok(upTime > 12 * 60000 * 1.3, 'uphill clearly slower than on the flat');
  assert.ok(Math.abs(RouteSun.timesOf(up, { start: 0, speedKmh: 5 }).at(-1) - 12 * 60000) < 1, 'without slope: as before');
  // The start times keep the longer duration.
  const hz = RouteSun.horizons(up, { ground: flat });
  const st = RouteSun.starts(up, hz, { from: NOON, to: NOON, speedKmh: 5, slope: true });
  assert.ok(Math.abs(st.list[0].end - NOON - upTime) < 1);
});
