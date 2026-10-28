'use strict';

// Measuring on the map (public/measure.js); the reference values are from pyproj (Geod, WGS84).

const test = require('node:test');
const assert = require('node:assert/strict');
const Measure = require('../public/measure.js');

test('distance and azimuth on the WGS84 ellipsoid match pyproj to the millimetre', () => {
  const zb = Measure.inverse([47.3779, 8.5403], [46.9466, 7.4446]); // Zürich HB → Bern
  assert.ok(Math.abs(zb.distance - 95924.399) < 0.001, String(zb.distance));
  assert.ok(Math.abs(zb.azimuth - 240.41188) < 1e-5, String(zb.azimuth));
  const north = Measure.inverse([47, 8], [47.001, 8]);
  assert.ok(Math.abs(north.distance - 111.1709) < 0.0001);
  assert.equal(Math.round(north.azimuth), 0);
  assert.deepEqual(Measure.inverse([47, 8], [47, 8]), { distance: 0, azimuth: 0 });
});

test('length of a line, perimeter and area of a polygon', () => {
  // About 760 × 1110 m near Zürich: pyproj gives 840 742 m² and a perimeter of 3735,98 m.
  const sq = [[47.3, 8.5], [47.3, 8.51], [47.31, 8.51], [47.31, 8.5]];
  assert.ok(Math.abs(Measure.length(sq, true) - 3735.978) < 0.01);
  assert.ok(Math.abs(Measure.area(sq) / 840742.29 - 1) < 0.0002, String(Measure.area(sq)));
  assert.equal(Measure.area(sq.slice(0, 2)), 0);
  assert.equal(Measure.fmtLength(87.24), '87.2 m');
  assert.equal(Measure.fmtLength(1234.5), '1.23 km');
  assert.equal(Measure.fmtArea(840742), '84.07 ha');
  assert.equal(Measure.fmtArea(950), '950 m²');
  assert.equal(Measure.fmtAzimuth(240.4), '240° (WSW)');
});
