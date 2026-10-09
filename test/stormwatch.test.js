'use strict';

// Storm warnings from the forecast and the visit after the storm (src/stormwatch.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createStormWatch } = require('../src/stormwatch');
const { createApp } = require('../src/app');

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 9, 12, 0, 0); // Friday 9 October 2026

function setup({ gusts }) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE spots (id INTEGER PRIMARY KEY, lat REAL, lon REAL)');
  // Two spots on the Zürichberg (one cell), one in the Sihlwald (another cell).
  db.prepare('INSERT INTO spots VALUES (1, 47.372, 8.574), (2, 47.381, 8.561), (3, 47.268, 8.551)').run();
  const asked = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    asked.push(u);
    const lats = u.searchParams.get('latitude').split(',');
    return Response.json(lats.map((la) => {
      const g = gusts[la] || [40, 40, 40];
      return { daily: { time: ['2026-10-09', '2026-10-10', '2026-10-11'], wind_gusts_10m_max: g, wind_direction_10m_dominant: [250, 250, 250] } };
    }));
  };
  const sent = [];
  // Anna follows spots 1 and 3, Benno photographs spot 2 regularly.
  const followers = { 1: [10], 2: [11], 3: [10] };
  const push = {
    recipients: (spotId) => new Map((followers[spotId] || []).map((u) => [u, 'folgen'])),
    send: async (userId, message) => { sent.push({ userId, ...message }); return 1; },
  };
  let observed = {};
  const storms = { between: async (lat) => observed[lat.toFixed(1)] ?? [] };
  let now = NOW;
  const watch = createStormWatch({ db, fetchImpl, push, storms, now: () => now, model: 'icon_seamless' });
  return { db, watch, asked, sent, setNow: (t) => { now = t; }, setObserved: (o) => { observed = o; } };
}

test('a storm in the forecast: one warning per person, then a visit reminder if it came', async () => {
  const s = setup({ gusts: { 47.4: [40, 96, 70], 47.3: [40, 81, 40] } });
  const r1 = await s.watch.run();
  assert.deepEqual([r1.cells, r1.warnings, r1.warned], [2, 2, 2]);
  const u = s.asked[0];
  assert.equal(u.searchParams.get('models'), 'icon_seamless');
  assert.equal(u.searchParams.get('forecast_days'), '3');
  assert.equal(u.searchParams.get('latitude'), '47.4,47.3', 'both cells in one request');
  const anna = s.sent.find((m) => m.userId === 10);
  assert.equal(anna.title, 'Sturmwarnung: Böen bis 96 km/h');
  assert.match(anna.body, /^Schwere Sturmböen am Sa 10\.10\. bei 2 Spots \(1, 3\)\. .*erst hingehen, wenn es sicher ist/);
  assert.equal(anna.url, './?filter=sturm');
  const benno = s.sent.find((m) => m.userId === 11);
  assert.equal(benno.url, './?spot=2');

  // The forecast is checked again: no second warning for the same storm.
  await s.watch.run();
  assert.equal(s.sent.length, 2);
  const list = s.watch.list();
  assert.deepEqual(list.map((w) => [w.cell, w.date, w.gust, w.phase, w.from16]), [
    ['47.3,8.6', '2026-10-10', 81, 'vorher', 'WSW'], ['47.4,8.6', '2026-10-10', 96, 'vorher', 'WSW']]);

  // Sunday: on the Zürichberg the storm came (102 km/h measured), in the Sihlwald it did not.
  s.setNow(NOW + 2 * DAY);
  s.setObserved({ 47.4: [{ date: '2026-10-10', gust: 102.4 }] });
  const r3 = await s.watch.run();
  assert.deepEqual([r3.confirmed, r3.calm, r3.after], [1, 1, 2]);
  const after = s.sent.slice(2);
  assert.deepEqual(after.map((m) => m.title), ['Nach dem Sturm: Spots besuchen', 'Nach dem Sturm: Spots besuchen']);
  assert.match(after.find((m) => m.userId === 10).body, /Böen bis 102 km\/h bei Spot 1\. /, 'only the spot where it came');
  assert.deepEqual(s.watch.list().map((w) => [w.cell, w.gust, w.phase, w.label]), [['47.4,8.6', 102, 'nachher', 'schwere Sturmböen']]);
  await s.watch.run();
  assert.equal(s.sent.length, 4, 'no second reminder');
});

test('below storm strength, no spots, or measurements missing for days', async () => {
  const calm = setup({ gusts: { 47.4: [60, 74, 70] } });
  assert.equal((await calm.watch.run()).warnings, 0);
  assert.deepEqual(calm.sent, []);
  // No measurements (offline) for more than five days: closed as unknown, no message.
  const s = setup({ gusts: { 47.4: [40, 90, 40] } });
  s.watch = createStormWatch({ db: s.db, fetchImpl: async () => Response.json([]), push: { recipients: () => new Map(), send: async () => 0 },
    storms: { between: async () => { throw new Error('offline'); } }, now: () => NOW + 7 * DAY });
  s.db.prepare("INSERT INTO storm_warnings (cell, date, gust, first_seen, updated_at, warned_at) VALUES ('47.4,8.6', '2026-10-10', 90, 0, 0, 0)").run();
  await s.watch.run();
  assert.equal(s.db.prepare('SELECT outcome FROM storm_warnings').get().outcome, 'unbekannt');
});

test('the warnings in the app: cells and days, no spots', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-storm-'));
  const app = createApp({ dataDir, routerUrl: '', stormWarnHours: 0, weatherFetch: async () => new Response('', { status: 503 }) });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    app.locals.db.prepare("INSERT INTO storm_warnings (cell, date, gust, dir, first_seen, updated_at) VALUES ('47.4,8.6', '2999-01-01', 88, 270, 0, 0)").run();
    const body = await (await fetch(`http://127.0.0.1:${server.address().port}/api/storm-warnings`)).json();
    assert.deepEqual([body.model, body.threshold], ['icon_seamless', 75]);
    assert.deepEqual(body.warnings, [{ cell: '47.4,8.6', lat: 47.4, lon: 8.6, date: '2999-01-01', gust: 88, from16: 'W', label: 'Sturmböen', phase: 'vorher' }]);
  } finally {
    await app.locals.idle();
    server.close();
    app.locals.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
