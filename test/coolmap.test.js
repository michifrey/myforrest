'use strict';

// Map of cool stretches (src/coolmap.js): tour temperatures without weather, time of day and lag, combined over tours.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tourCells, tourClass, cellOf, LAG_S } = require('../src/coolmap');
const { createApp } = require('../src/app');

const T0 = Date.UTC(2026, 6, 1, 6, 0, 0);
const FOREST = [8.562, 8.568]; // a cooler stretch along the way

/**
 * A tour west → east along 47.36° N at 3 m/s, one point every 5 s. The watch reads the
 * place it passed LAG_S earlier, plus a level (weather, body heat) and a drift (morning).
 */
function tour({ level = 16, drift = 0.15, cool = -3, reverse = false } = {}) {
  const n = 160;
  const lonAt = (i) => {
    const f = Math.max(0, Math.min(1, i / (n - 1)));
    return reverse ? 8.58 - f * 0.03 : 8.55 + f * 0.03;
  };
  const env = (lon) => (lon >= FOREST[0] && lon <= FOREST[1] ? cool : 0);
  return Array.from({ length: n }, (_, i) => {
    const time = T0 + i * 5000;
    const lagged = lonAt(i - LAG_S / 5);
    return { lat: 47.36, lon: lonAt(i), time, temp: Math.round((level + drift * (i * 5 / 60) + env(lagged)) * 10) / 10 };
  });
}

test('one tour: deviations without level, drift and lag; not at the ends', () => {
  const cells = tourCells(tour());
  const at = (lon) => cells.get(cellOf(47.36, lon).key)?.delta;
  assert.ok(at(8.565) < -1.8, `forest ${at(8.565)}`);
  assert.ok(Math.abs(at(8.555)) < 1, `open ${at(8.555)}`);
  assert.ok(Math.abs(at(8.575)) < 1, `open ${at(8.575)}`);
  assert.equal(at(8.5505), undefined, 'first 200 m left out');
  assert.equal(at(8.5795), undefined, 'last 200 m left out');
  // A warmer day, another body: the same deviations.
  const other = tourCells(tour({ level: 24, drift: 0.4 }));
  assert.ok(Math.abs(other.get(cellOf(47.36, 8.565).key).delta - at(8.565)) < 0.3);
  // Too short or without temperatures: nothing.
  assert.equal(tourCells(tour().slice(0, 20)), null);
  assert.equal(tourCells(tour().map(({ temp, ...p }) => p)), null);
});

test('season and time of day of a tour, from its middle', () => {
  const c = tourClass(tour());
  assert.deepEqual([c.season, c.daytime], ['sommer', 'tag']); // 1 July, 08:00 in Zurich
  assert.ok(Math.abs(c.level - (16 + 0.15 * 6.6)) < 1, `level ${c.level}`);
  const night = tourClass(tour().map((p) => ({ ...p, time: p.time - 6 * 3600000 + 182 * 86400000 })));
  assert.deepEqual([night.season, night.daytime], ['winter', 'nacht']); // end of December, 02:00
});

async function withServer(fn, { weatherFetch = async () => new Response('', { status: 503 }) } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-cool-'));
  const app = createApp({ dataDir, routerUrl: '', weatherFetch });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`, app);
  } finally {
    await app.locals.idle();
    server.close();
    app.locals.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function client(base) {
  const c = {
    async req(url, { method = 'GET', json } = {}) {
      const h = {};
      if (c.cookie) h.Cookie = c.cookie;
      if (c.csrf && method !== 'GET') h['X-CSRF-Token'] = c.csrf;
      if (json !== undefined) h['Content-Type'] = 'application/json';
      const res = await fetch(`${base}${url}`, { method, headers: h, body: json === undefined ? undefined : JSON.stringify(json) });
      const set = res.headers.get('set-cookie');
      if (set) c.cookie = set.split(';')[0];
      return res;
    },
    json: async (url, opts) => (await c.req(url, opts)).json(),
    async register(name) {
      const b = await c.json('/api/auth/register', { method: 'POST', json: { email: `${name}@example.org`, name, password: 'geheim-1234' } });
      c.csrf = b.csrfToken;
    },
  };
  return c;
}

const save = (who, pts, shareTemp) => who.json('/api/tracks', {
  method: 'POST',
  json: {
    name: 'Morgenlauf', kind: 'importiert', shareTemp,
    points: pts.map((p) => [p.lat, p.lon, null, p.time, { temp: p.temp }]),
    sensors: [{ key: 'temp', label: 'Temperatur', unit: '°C', avg: 16, min: 13, max: 19, n: pts.length }],
  },
});

test('cool cells: only shared tours, at least 3 tours from 2 people, owner decides', async () => {
  await withServer(async (base) => {
    const anna = client(base);
    await anna.register('Anna');
    const ben = client(base);
    await ben.register('Benno');
    const cells = async () => (await anna.json('/api/cool-cells?bbox=8.54,47.35,8.59,47.37')).cells;

    const a1 = await save(anna, tour(), true);
    assert.deepEqual([a1.hasTemp, a1.shareTemp], [true, true]);
    await save(anna, tour({ level: 20, reverse: true }), true);
    await save(ben, tour({ level: 12 }), false); // not shared
    assert.deepEqual(await cells(), [], 'two tours of one person are not enough');

    // Benno shares his tour afterwards: now three tours from two people.
    const mine = await ben.json('/api/tracks?mine=1');
    assert.equal((await anna.req(`/api/tracks/${mine[0].id}`, { method: 'PATCH', json: { shareTemp: true } })).status, 403, 'not even moderation (Anna is the first account, an admin)');
    const patched = await ben.json(`/api/tracks/${mine[0].id}`, { method: 'PATCH', json: { shareTemp: true } });
    assert.equal(patched.shareTemp, true);
    const list = await cells();
    assert.ok(list.length > 10);
    assert.ok(list.every((c) => c.tours === 3 && Object.keys(c).join() === 'lat,lon,delta,tours'), 'no times, no names');
    const forest = list.filter((c) => c.lon > FOREST[0] + 0.001 && c.lon < FOREST[1] - 0.001);
    const open = list.filter((c) => c.lon < FOREST[0] - 0.002 || c.lon > FOREST[1] + 0.002);
    assert.ok(forest.length && forest.every((c) => c.delta < -1.5), JSON.stringify(forest));
    assert.ok(open.every((c) => Math.abs(c.delta) < 1.2), JSON.stringify(open));

    // A tour without temperatures cannot be shared; the bbox must be sensible.
    const plain = await anna.json('/api/tracks', { method: 'POST', json: { kind: 'gezeichnet', points: [[47.36, 8.55], [47.36, 8.56]], shareTemp: true } });
    assert.deepEqual([plain.hasTemp, plain.shareTemp], [false, false]);
    assert.equal((await anna.req(`/api/tracks/${plain.id}`, { method: 'PATCH', json: { shareTemp: true } })).status, 400);
    assert.equal((await anna.req('/api/cool-cells?bbox=6,45,10,48')).status, 400);
    // Withdrawn: gone again.
    await ben.json(`/api/tracks/${mine[0].id}`, { method: 'PATCH', json: { shareTemp: false } });
    assert.deepEqual(await cells(), []);
  });
});

test('calibration against the weather model; only tours of the asked season and time of day', async () => {
  const asked = [];
  // Open-Meteo stand-in: 15 °C air temperature all day.
  const weatherFetch = async (url) => {
    const u = new URL(url);
    asked.push(u);
    const d = u.searchParams.get('start_date');
    const time = Array.from({ length: 24 }, (_, h) => `${d}T${String(h).padStart(2, '0')}:00`);
    return Response.json({ utc_offset_seconds: 0, hourly: { time, temperature_2m: time.map(() => 15) } });
  };
  await withServer(async (base, app) => {
    const anna = client(base);
    await anna.register('Anna');
    const ben = client(base);
    await ben.register('Benno');
    const q = (extra = '') => anna.json(`/api/cool-cells?bbox=8.54,47.35,8.59,47.37${extra}`);
    await save(anna, tour({ level: 18 }), true); // a watch on the wrist: 3 °C above the air
    await save(anna, tour({ level: 21, reverse: true }), true);
    await save(ben, tour({ level: 17 }), true);
    const bag = await save(ben, tour({ level: 2 }), true); // in a bag in the cold car: 13 °C below the air
    const all = await q();
    assert.ok(all.cells.length > 10 && all.cells.every((c) => c.tours === 3), 'the bag tour does not count');
    assert.ok(asked.length >= 1 && asked.every((u) => u.pathname.endsWith('/archive')));
    const checks = app.locals.db.prepare('SELECT track_id, ok, model FROM cool_checks ORDER BY track_id').all();
    assert.deepEqual(checks.map((c) => [c.ok, c.model]), [[1, 15], [1, 15], [1, 15], [0, 15]]);
    assert.equal(checks.at(-1).track_id, bag.id);
    // Checked once: a second view asks the model nothing new.
    const before = asked.length;
    await q();
    assert.equal(asked.length, before);
    // All three are summer mornings.
    assert.equal((await q('&season=sommer&daytime=tag')).cells.length, all.cells.length);
    assert.deepEqual((await q('&season=winter')).cells, []);
    const night = await q('&daytime=nacht');
    assert.deepEqual([night.cells, night.daytime], [[], 'nacht']);
  }, { weatherFetch });
});
