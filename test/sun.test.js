'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Sun = require('../public/sun.js');

const ZRH = [47.3769, 8.5417];
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const minutes = (t) => new Date(t).getUTCHours() * 60 + new Date(t).getUTCMinutes();

test('sun at the summer solstice in Zurich', () => {
  const d = Sun.day(Date.UTC(2026, 5, 20, 22), ...ZRH);
  // Published values: sunrise 05:28, sunset 21:26 CEST; noon altitude 90 − 47.38 + 23.44 = 66.06°.
  near(minutes(d.sunrise), 3 * 60 + 28, 2, 'sunrise (UTC minutes)');
  near(minutes(d.sunset), 19 * 60 + 26, 2, 'sunset (UTC minutes)');
  near(d.maxAltitude, 66.06, 0.15, 'max altitude');
  near(Sun.position(d.solarNoon, ...ZRH).azimuth, 180, 1, 'noon azimuth');
});

test('equinox sunrise in the east, winter sun low in the south', () => {
  const eq = Sun.times(Date.UTC(2026, 2, 19, 23), ...ZRH);
  near(Sun.position(eq.sunrise, ...ZRH).azimuth, 90, 1.5, 'equinox sunrise azimuth');
  const winter = Sun.times(Date.UTC(2026, 11, 20, 23), ...ZRH);
  near(winter.maxAltitude, 90 - 47.38 - 23.44, 0.3, 'winter noon altitude');
});

test('clear-sky irradiance and slopes', () => {
  assert.deepEqual(Sun.clearSky(-5, 172), { dni: 0, dhi: 0, ghi: 0 });
  const high = Sun.clearSky(66, 172);
  assert.ok(high.ghi > 850 && high.ghi < 1050, `midsummer noon ${high.ghi}`);
  assert.ok(Sun.clearSky(66, 172, 2000).ghi > high.ghi, 'thinner air at altitude');
  const dec = Date.UTC(2026, 11, 20, 23);
  const south = Sun.day(dec, ...ZRH, { slope: 30, aspect: 180 });
  const north = Sun.day(dec, ...ZRH, { slope: 30, aspect: 0 });
  assert.ok(south.totalSlope > 2 * south.totalFlat, 'south slope gets more than twice the flat ground in winter');
  assert.ok(north.totalSlope < 0.5 * north.totalFlat, 'north slope gets less than half');
});

test('destination and compass helpers', () => {
  const [lat, lon] = Sun.destination(47, 8, 90, 1000);
  near(lat, 47, 1e-4, 'east keeps latitude');
  near((lon - 8) * 111320 * Math.cos(47 * Math.PI / 180), 1000, 2, 'east 1000 m');
  assert.equal(Sun.compass(0), 'N');
  assert.equal(Sun.compass(200), 'SSW');
});

test('terrain horizon: interpolation, delayed sunrise, valley in winter, interrupted sunshine', () => {
  const flat = { step: 10, angles: Array(36).fill(0), svf: 1 };
  const east = { step: 10, angles: Array.from({ length: 36 }, (_, k) => (k >= 3 && k <= 15 ? 10 : 0)), svf: 0.98 };
  assert.equal(Sun.horizonAt(east, 95), 10);
  assert.equal(Sun.horizonAt(east, 25), 5, 'halfway between 20° (0) and 30° (10)');
  assert.equal(Sun.horizonAt({ step: 10, angles: [4, ...Array(34).fill(0), 2] }, 355), 3, 'wraps around north');
  assert.equal(Sun.horizonAt(null, 90), 0);

  const june = Date.UTC(2026, 5, 20, 22);
  const open = Sun.day(june, ...ZRH);
  const withFlat = Sun.day(june, ...ZRH, { horizon: flat });
  near(withFlat.terrainRise, open.sunrise, 60000, 'flat horizon rises with the astronomical sun');
  assert.equal(withFlat.totalFlatTerrain, open.totalFlat);
  const hill = Sun.day(june, ...ZRH, { horizon: east });
  assert.ok(hill.terrainRise - open.sunrise > 45 * 60000, `a 10° hill in the east delays sunrise by ${(hill.terrainRise - open.sunrise) / 60000} min`);
  near(hill.terrainSet, open.sunset, 60000, 'west stays open');
  assert.ok(hill.totalFlatTerrain < open.totalFlat && hill.samples.some((s) => s.behind));

  // A deep valley: 25° ridge to the south keeps the December sun (max ~19°) away all day.
  const dec = Date.UTC(2026, 11, 20, 23);
  const valley = { step: 10, angles: Array.from({ length: 36 }, (_, k) => (k >= 9 && k <= 27 ? 25 : 5)), svf: 0.85 };
  const v = Sun.day(dec, ...ZRH, { horizon: valley });
  assert.deepEqual([v.periods.length, v.sunMinutes, v.terrainRise], [0, 0, null]);
  assert.ok(v.totalFlatTerrain > 0 && v.totalFlatTerrain < 0.35 * v.totalFlat, 'only diffuse light reaches the valley floor');

  // A single peak due south at noon interrupts the sunshine.
  const peak = { step: 10, angles: Array.from({ length: 36 }, (_, k) => (k === 18 ? 30 : 0)), svf: 0.99 };
  const p = Sun.day(dec, ...ZRH, { horizon: peak });
  assert.equal(p.periods.length, 2, 'sun before and after the peak');
  assert.ok(p.sunMinutes < (open.sunset - open.sunrise) / 60000);
});
