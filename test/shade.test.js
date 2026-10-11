'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Shade = require('../public/shade.js');

/** Flat grid at 400 m with a 100-m-high wall (two cells thick) running north–south in column 10. */
function wall() {
  const gw = 30; const gh = 20;
  const elev = new Float32Array(gw * gh).fill(400);
  for (let y = 0; y < gh; y++) { elev[y * gw + 10] = 500; elev[y * gw + 11] = 500; }
  return { elev, gw, gh, cellM: 10 };
}

test('terrarium decoding and pixel size', () => {
  assert.equal(Shade.terrarium(128, 0, 0), 0);
  assert.equal(Shade.terrarium(129, 144, 128), 400.5);
  const m = Shade.metresPerPixel(47, 12);
  assert.ok(m > 25 && m < 28, `${m} m per pixel at z12`);
});

test('a wall throws its shadow away from the sun', () => {
  const g = wall();
  // Sun in the west at 45°: the wall (100 m) shades about 100 m = 10 cells to its east.
  const west = Shade.light({ ...g, altitude: 45, azimuth: 270 });
  const row = (y) => Array.from(west.slice(y * g.gw, (y + 1) * g.gw));
  const r = row(10);
  assert.ok(r.slice(0, 9).every((v) => Math.abs(v - 1) < 1e-6), 'west of the wall in full sun, as on flat ground');
  assert.ok(r.slice(12, 20).every((v) => v === 0), 'shadow right behind the wall');
  assert.ok(r.slice(23).every((v) => v > 0), 'sun again beyond the shadow');
  // A low sun throws a longer shadow.
  const low = Shade.light({ ...g, altitude: 10, azimuth: 270 });
  assert.ok(Array.from(low.slice(10 * g.gw + 12, 11 * g.gw)).every((v) => v === 0), 'low sun: everything east in shadow');
  // From the east, the shadow falls to the west.
  const east = Shade.light({ ...g, altitude: 45, azimuth: 90 });
  assert.equal(east[10 * g.gw + 5], 0);
  assert.ok(east[10 * g.gw + 20] > 0);
});

test('slopes towards the sun get more light, the sun down none', () => {
  const gw = 20; const gh = 20;
  // Plane rising towards the north: a south-facing slope of 20 %.
  const elev = new Float32Array(gw * gh).map((_, i) => 1000 + (gh - Math.floor(i / gw)) * 2);
  const g = { elev, gw, gh, cellM: 10 };
  const sunSouth = Shade.light({ ...g, altitude: 20, azimuth: 180, x0: 5, y0: 5, w: 10, h: 10 });
  assert.equal(sunSouth.length, 100);
  assert.ok(sunSouth.every((v) => v > 1.3), 'south slope in a low southern sun');
  const sunNorth = Shade.light({ ...g, altitude: 8, azimuth: 0, x0: 5, y0: 5, w: 10, h: 10 });
  assert.ok(sunNorth.every((v) => v === 0), 'slope turned away from a low northern sun');
  assert.ok(Shade.light({ ...g, altitude: -3, azimuth: 180 }).every((v) => v === 0));
});

test('night and twilight darkening', () => {
  assert.equal(Shade.night(10), 0);
  assert.equal(Shade.night(0), 0);
  assert.equal(Shade.night(-12), 1);
  assert.equal(Shade.night(-20), 1);
  const civil = Shade.night(-6);
  assert.ok(civil > 0.4 && civil < 0.6, `end of civil twilight ${civil}`);
  assert.ok(Shade.night(-3) < civil && Shade.night(-9) > civil);
});
