'use strict';

// MeteoSwiss precipitation radar (src/routes/radar-ch.js): STAC listing, ODIM HDF5, PNG in Web Mercator.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { createApp } = require('../src/app');
const radar = require('../src/routes/radar-ch');

// A small composite in the MeteoSwiss layout (10 km cells, made with h5py): 2.5 mm/h around Aarau, 12 mm/h at its core.
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'RZC262881325VL.801.h5'));
const STAC = 'https://data.geo.admin.ch/api/stac/v1/collections/ch.meteoschweiz.ogd-radar-precip';
const offline = async () => new Response('offline', { status: 503 });

test('file names: RZCyyjjjHHMM… gives the time in UTC', () => {
  assert.equal(new Date(radar.timeOfFile('RZC262881325VL.801.h5')).toISOString(), '2026-10-15T13:25:00.000Z');
  assert.equal(new Date(radar.timeOfFile('https://x/y/rzc260010005vl.801.h5')).toISOString(), '2026-01-01T00:05:00.000Z');
  assert.equal(radar.timeOfFile('CPC262881325_00060.801.gif'), null);
  assert.equal(radar.timeOfFile('RZC269991325VL.801.h5'), null);
});

test('ODIM HDF5: grid, place in LV95, rain rate from gain and offset', async () => {
  const g = radar.decode(FIXTURE);
  assert.deepEqual([g.nx, g.ny, g.llx, g.lly, g.xscale, g.yscale], [71, 64, 2255000, 840000, 10000, 10000]);
  // Row 0 is the north; Aarau (E 2646 km, N 1249 km) lies in the core.
  const at = (e, n) => g.rate[(g.ny - 1 - Math.floor((n - g.lly) / g.yscale)) * g.nx + Math.floor((e - g.llx) / g.xscale)];
  assert.equal(Math.round(at(2646000, 1249000) * 10) / 10, 12);
  assert.equal(Math.round(at(2683000, 1247000) * 10) / 10, 2.5, 'Zurich, 37 km away');
  assert.equal(at(2600000, 1100000), 0, 'nothing detected in the Alps');
  assert.ok(Number.isNaN(g.rate[0]), 'nodata in the north-west corner');
  const [[s, w], [n, e]] = radar.boundsOf(g);
  assert.ok(s > 43 && s < 44.5 && n > 49 && n < 50 && w > 2 && w < 3.5 && e > 12 && e < 13, `bounds ${[s, w, n, e]}`);
});

test('rate between cells: exact at a cell centre, smooth in between, nothing outside', () => {
  const g = radar.decode(FIXTURE);
  const centre = (col, row) => [g.llx + (col + 0.5) * g.xscale, g.lly + (g.ny - row - 0.5) * g.yscale];
  const col = Math.floor((2646000 - g.llx) / g.xscale);
  const row = g.ny - 1 - Math.floor((1249000 - g.lly) / g.yscale);
  assert.equal(Math.round(radar.rateAt(g, ...centre(col, row)) * 10) / 10, 12);
  const between = radar.rateAt(g, centre(col, row)[0] + 2.5 * g.xscale, centre(col, row)[1]);
  assert.ok(between > 0 && between < 12, `between ${between}`);
  assert.ok(Number.isNaN(radar.rateAt(g, 2000000, 1000000)), 'outside the grid');
  assert.ok(Number.isNaN(radar.rateAt(g, ...centre(0, 0))), 'nodata stays nodata');
});

test('picture: Web Mercator between the bounds, coloured where it rains', async () => {
  const g = radar.decode(FIXTURE);
  const [[s, w], [n, e]] = radar.boundsOf(g);
  const { data, info } = await sharp(await radar.render(g)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const px = (lat, lon) => {
    const i = Math.floor(((lon - w) / (e - w)) * info.width);
    const j = Math.floor(((mercY(n) - mercY(lat)) / (mercY(n) - mercY(s))) * info.height);
    return [...data.subarray((j * info.width + i) * 4, (j * info.width + i) * 4 + 4)];
  };
  assert.equal(info.width, 1400);
  assert.deepEqual(px(47.392, 8.045).slice(0, 3), radar.colourOf(12), 'Aarau: 12 mm/h');
  // Zurich lies at the edge of the 2.5 mm/h ring: between the cells the rate is interpolated.
  const zurich = px(47.37, 8.54);
  assert.ok(zurich[3] > 0 && [1, 2.5].some((r) => radar.colourOf(r).join() === zurich.slice(0, 3).join()), `Zurich ${zurich}`);
  assert.equal(px(46.5, 9.8)[3], 0, 'dry Engadin: transparent');
});

async function start(options) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-radar-'));
  const app = createApp({ dataDir, weatherFetch: offline, fetchImpl: offline, routerUrl: '', mailer: { send: async () => ({}) }, ...options });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    dataDir,
    stop: async () => { await app.locals.idle(); server.close(); app.locals.db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); },
  };
}

/** STAC stand-in: one daily item with the files of the last three hours every 5 minutes, and a foreign one. */
function stacFetch(asked) {
  return async (url) => {
    asked.push(url);
    if (url.startsWith(`${STAC}/items`)) {
      const assets = {};
      const newest = Math.floor((Date.now() - 4 * 60000) / 300000) * 300000;
      for (let t = newest - 3 * 3600000; t <= newest; t += 300000) {
        const d = new Date(t);
        const doy = Math.floor((t - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000) + 1;
        const name = `rzc${String(d.getUTCFullYear()).slice(2)}${String(doy).padStart(3, '0')}${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}vl.801.h5`;
        assets[name] = { href: `https://data.geo.admin.ch/ch.meteoschweiz.ogd-radar-precip/day/${name}` };
      }
      assets['rzc000010000vl.801.h5'] = { href: 'https://evil.example/rzc000010000vl.801.h5' };
      return new Response(JSON.stringify({ features: [{ id: 'day', assets }], links: [] }));
    }
    if (url.startsWith('https://data.geo.admin.ch/ch.meteoschweiz.ogd-radar-precip/')) return new Response(FIXTURE);
    return new Response('nope', { status: 404 });
  };
}

test('route: frames of the last two hours, pictures fetched once and kept', async () => {
  const asked = [];
  const { base, dataDir, stop } = await start({ mchRadarUrl: STAC, mchRadarFetch: stacFetch(asked) });
  try {
    assert.equal((await (await fetch(`${base}/api/config`)).json()).radarCh, true);
    const list = await (await fetch(`${base}/api/radar/ch`)).json();
    assert.equal(list.attribution, 'MeteoSchweiz');
    assert.ok(list.frames.length >= 22 && list.frames.length <= 25, `${list.frames.length} frames`);
    const times = list.frames.map((f) => Date.parse(f.time));
    assert.ok(times.every((t, i) => i === 0 || t - times[i - 1] === 300000), 'every 5 minutes, oldest first');
    assert.ok(Date.now() - times[0] <= 2 * 3600000 + 300000);
    assert.match(asked[0], /\/items\?datetime=\d{4}-\d{2}-\d{2}T00:00:00Z\/\.\.&limit=100$/);

    const newest = list.frames[list.frames.length - 1].url;
    const [a, b] = await Promise.all([fetch(`${base}${newest}`), fetch(`${base}${newest}`)]);
    assert.equal(a.status, 200);
    assert.equal(a.headers.get('content-type'), 'image/png');
    assert.match(a.headers.get('cache-control'), /immutable/);
    assert.equal(b.status, 200);
    const downloads = asked.filter((u) => u.endsWith('.h5'));
    assert.equal(downloads.length, 1, 'two requests, one download');
    assert.ok(fs.existsSync(path.join(dataDir, 'radar-ch', `${newest.match(/(\d{12})\.png$/)[1]}.png`)));
    await fetch(`${base}${newest}`);
    assert.equal(asked.filter((u) => u.endsWith('.h5')).length, 1, 'then from disk');
    // The listing is cached for two minutes.
    assert.equal(asked.filter((u) => u.includes('/items')).length, 1);
    // Bounds from the file once one was read.
    const again = await (await fetch(`${base}/api/radar/ch`)).json();
    assert.ok(again.bounds[0][0] > 43 && again.bounds[1][0] < 50);

    assert.equal((await fetch(`${base}/api/radar/ch/200001010000.png`)).status, 404, 'files of other hosts are not taken');
    assert.ok(!asked.some((u) => u.includes('evil.example')));
    assert.equal((await fetch(`${base}/api/radar/ch/2026.png`)).status, 400);
  } finally {
    await stop();
  }
});

test('route: MCH_RADAR_URL empty turns it off; a failing listing says why', async () => {
  let s = await start({ mchRadarUrl: null });
  try {
    assert.equal((await (await fetch(`${s.base}/api/config`)).json()).radarCh, false);
    assert.equal((await fetch(`${s.base}/api/radar/ch`)).status, 404);
  } finally {
    await s.stop();
  }
  s = await start({ mchRadarUrl: STAC, mchRadarFetch: async () => new Response('down', { status: 503 }) });
  try {
    const list = await (await fetch(`${s.base}/api/radar/ch`)).json();
    assert.deepEqual(list.frames, []);
    assert.match(list.error, /HTTP 503/);
  } finally {
    await s.stop();
  }
});
