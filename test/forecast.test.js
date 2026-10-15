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

test('MeteoSwiss frames: every 15 minutes back from the newest, gaps skipped', () => {
  const t0 = Date.UTC(2026, 9, 15, 11, 30);
  const frames = Array.from({ length: 25 }, (_, i) => ({ time: new Date(t0 + i * 300000).toISOString(), url: `/api/radar/ch/${i}.png` }))
    .filter((_, i) => i !== 9); // 12:15 is missing
  const picked = Forecast.pickFrames(frames);
  assert.equal(picked.length, 8, 'nine wanted, one missing');
  assert.equal(picked[picked.length - 1].time, '2026-10-15T13:30:00.000Z');
  assert.equal(picked[0].time, '2026-10-15T11:30:00.000Z');
  assert.ok(!picked.some((f) => f.time === '2026-10-15T12:15:00.000Z'));
  assert.deepEqual(Forecast.pickFrames([]), []);
});
