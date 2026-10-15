'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Forecast = require('../public/forecast.js');

test('weather codes: wording and icon', () => {
  assert.equal(Forecast.wmoLabel(0), 'klar');
  assert.equal(Forecast.wmoLabel(66), 'gefrierender Regen');
  assert.equal(Forecast.wmoLabel(42), 'unbekannt');
  assert.deepEqual([0, 2, 3, 45, 53, 63, 81, 67, 73, 86, 96].map(Forecast.iconKind),
    ['clear', 'partly', 'cloud', 'fog', 'drizzle', 'rain', 'rain', 'freezing', 'snow', 'snow', 'thunder']);
});

test('radar frames: the last two hours in 15-minute steps, ending with the newest picture', () => {
  const to = Date.UTC(2026, 9, 15, 10, 5);
  const frames = Forecast.radarFrames({ from: Date.UTC(2026, 9, 15, 8), to });
  assert.equal(frames.length, 9);
  assert.equal(frames[0], '2026-10-15T08:05:00Z');
  assert.equal(frames[8], '2026-10-15T10:05:00Z');
  // DWD keeps less than two hours: only frames it has.
  assert.equal(Forecast.radarFrames({ from: Date.UTC(2026, 9, 15, 9, 30), to }).length, 3);
  // Without a time range, the newest picture only.
  assert.deepEqual(Forecast.radarFrames({ name: 'dwd:Niederschlagsradar' }), [null]);
});
