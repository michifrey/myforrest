'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { createApp } = require('../src/app');
const { createGlamos, parseGlamos } = require('../src/glamos');
const { createArchives, parseCatalogue, licenseKey } = require('../src/archives');
const { alignOnHorizon, skyline } = require('../src/horizon-align');
const { wgs84ToLv95 } = require('../src/lv95');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-ar-'));

/* ---------- GLAMOS length change ---------- */

const GLAMOS = `# GLAMOS length change, test excerpt
glacier name;glacier id;start date of observation;end date of observation;length change
Testgletscher;B36-26;2010-09-01;2011-09-01;-12.5
Testgletscher;B36-26;2011-09-01;2012-09-01;-20
Testgletscher;B36-26;2012-09-01;2013-09-01;-7.5
Vadret da Morteratsch;E22-03;2012-09-01;2013-09-01;-30,5
`;

test('GLAMOS: columns by name, matched by SGI id or name, cumulative curve and recent rate', () => {
  const parsed = parseGlamos(GLAMOS);
  assert.deepEqual([...parsed.keys()], ['id:B36-26', 'id:E22-03']);
  assert.equal(parsed.get('id:E22-03').series[0].change, -30.5);
  assert.throws(() => parseGlamos('a;b\n1;2'), /Spalten/);

  const dir = tmp();
  try {
    const file = path.join(dir, 'laenge.csv');
    fs.writeFileSync(file, GLAMOS);
    const g = createGlamos({ files: file });
    assert.ok(g.enabled());
    const s = g.forGlacier({ id: 'B36-26', name: 'anders' });
    assert.equal(s.name, 'Testgletscher');
    assert.deepEqual([s.firstYear, s.lastYear, s.total, s.observations], [2010, 2013, -40, 3]);
    assert.deepEqual(s.points.map((p) => p.cumulative), [-12.5, -32.5, -40]);
    assert.equal(s.recentRate, -13.3);
    // By name, without "Vadret"/"Gletscher".
    assert.equal(g.forGlacier({ name: 'Morteratsch' }).total, -30);
    assert.equal(g.forGlacier({ name: 'Rhonegletscher' }), null);
    assert.equal(g.forGlacier(null), null);
    assert.equal(createGlamos({ files: '' }).forGlacier({ name: 'Testgletscher' }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- Archive catalogue ---------- */

test('archive catalogue: licences, dates, WGS84 or LV95, GeoJSON', () => {
  assert.equal(licenseKey('Public Domain Mark'), 'cc0-1.0');
  assert.equal(licenseKey('CC0'), 'cc0-1.0');
  assert.equal(licenseKey('CC BY-SA 4.0'), 'cc-by-sa-4.0');
  assert.equal(licenseKey('CC BY 4.0'), 'cc-by-4.0');
  assert.equal(licenseKey('CC BY-NC-SA 4.0'), 'cc-by-nc-sa-4.0');
  assert.equal(licenseKey('CC BY-ND 4.0'), null);
  assert.equal(licenseKey('Alle Rechte vorbehalten'), null);
  assert.equal(licenseKey(''), null);

  const [e, n] = wgs84ToLv95(46.601, 8.4);
  const items = parseCatalogue(`id;title;date;lat;lon;e;n;heading;license;image;page
a1;"Gletscher; Zunge";1932;46.6;8.4;;;350;Public Domain;https://archiv.example/a1.jpg;https://archiv.example/a1
a2;Im Tal;1950-08;;;${e};${n};;CC BY-ND;https://archiv.example/a2.jpg;
a3;Ohne Datum;;46.6;8.4;;;;CC0;https://archiv.example/a3.jpg;
a4;Unsicherer Link;1960-07-02;46.6;8.4;;;;CC0;http://archiv.example/a4.jpg;
`);
  assert.deepEqual(items.map((i) => i.id), ['a1', 'a2', 'a4']);
  assert.equal(items[0].title, 'Gletscher; Zunge');
  assert.equal(items[0].year, 1932);
  assert.equal(items[0].heading, 350);
  assert.ok(Math.abs(items[1].lat - 46.601) < 1e-4 && Math.abs(items[1].lon - 8.4) < 1e-4);
  assert.equal(new Date(items[1].takenAt).toISOString().slice(0, 10), '1950-08-15');
  assert.equal(items[1].licenseKey, null);
  assert.equal(items[2].image, null); // only https links are downloaded

  const geo = parseCatalogue(JSON.stringify({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: { id: 'g1', date: '1911-07-01', license: 'CC BY-SA 4.0' }, geometry: { type: 'Point', coordinates: [8.4, 46.6] } }],
  }));
  assert.deepEqual([geo[0].id, geo[0].lat, geo[0].lon, geo[0].licenseKey], ['g1', 46.6, 8.4, 'cc-by-sa-4.0']);
});

test('archive suggestions: within the radius and the viewing direction, nearest first', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'katalog.csv');
    fs.writeFileSync(file, `id,date,lat,lon,heading,license
nah,1930,46.601,8.4,10,CC0
weit,1930,46.7,8.4,,CC0
andersrum,1930,46.6,8.401,190,CC0
ohnerichtung,1930,46.605,8.4,,CC0
`);
    const a = createArchives({ files: file });
    assert.deepEqual(a.near({ lat: 46.6, lon: 8.4, heading: 0 }).map((i) => i.id), ['nah', 'ohnerichtung']);
    assert.deepEqual(a.near({ lat: 46.6, lon: 8.4, heading: null }).map((i) => i.id), ['andersrum', 'nah', 'ohnerichtung']);
    assert.equal(a.byId('weit').id, 'weit');
    assert.equal(createArchives({ files: '' }).enabled(), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- API ---------- */

async function withServer(opts, fn) {
  const dataDir = tmp();
  const app = createApp({ dataDir, weatherFetch: async () => new Response('offline', { status: 503 }), routerUrl: '', ...opts(dataDir) });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, app);
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
      return b.user;
    },
  };
  return c;
}

const jpeg = (color) => sharp({ create: { width: 64, height: 48, channels: 3, background: color } }).jpeg().toBuffer();

test('archive pictures via the API: suggested, taken over as a dated archive photo, licence and login checked; glacier length', async () => {
  const fetched = [];
  const archiveFetch = async (url) => {
    fetched.push(url);
    return new Response(await jpeg('#9aa4ad'), { headers: { 'content-type': 'image/jpeg' } });
  };
  await withServer((dir) => {
    const katalog = path.join(dir, 'katalog.csv');
    fs.writeFileSync(katalog, `id;title;date;lat;lon;source;license;image;page
eth-1;Testgletscher, Zunge;1932-08-14;46.601;8.4;ETH-Bibliothek;Public Domain Mark;https://archiv.example/eth-1.jpg;https://archiv.example/eth-1
eth-2;Hütte;1940;46.602;8.4;ETH-Bibliothek;Alle Rechte vorbehalten;https://archiv.example/eth-2.jpg;https://archiv.example/eth-2
`);
    const glamos = path.join(dir, 'laenge.csv');
    fs.writeFileSync(glamos, GLAMOS);
    // A glacier outline around the spot, with its SGI id.
    const ring = [[8.39, 46.59], [8.41, 46.59], [8.41, 46.61], [8.39, 46.61], [8.39, 46.59]];
    const outlines = path.join(dir, 'sgi2016.geojson');
    fs.writeFileSync(outlines, JSON.stringify({ type: 'FeatureCollection', features: [
      { type: 'Feature', properties: { 'sgi-id': 'B36-26', name: 'Anderer Name' }, geometry: { type: 'Polygon', coordinates: [ring] } },
    ] }));
    return { archiveFiles: katalog, archiveFetch, glamosFiles: glamos, glacierFiles: outlines };
  }, async (base) => {
    const anna = client(base);
    await anna.register('Anna');
    const fd = new FormData();
    fd.append('photos', new Blob([await jpeg('#dfe8ee')], { type: 'image/jpeg' }), 'x.jpg');
    for (const [k, v] of Object.entries({ lat: 46.6, lon: 8.4, takenAt: '2024-08-20T10:00:00Z', landscape: 'gletscher' })) fd.append(k, String(v));
    const up = await (await fetch(`${base}/api/photos`, { method: 'POST', body: fd })).json();
    const spotId = up.created[0].spotId;

    const list = await anna.json(`/api/spots/${spotId}/archive-suggestions`);
    assert.equal(list.enabled, true);
    assert.deepEqual(list.items.map((i) => [i.id, i.importable, i.year]), [['eth-1', true, 1932], ['eth-2', false, 1940]]);
    assert.equal(list.items[0].date, '1932-08-14');

    // Without login: refused. With a licence that does not allow it: only the link.
    assert.equal((await fetch(`${base}/api/spots/${spotId}/archive-suggestions/eth-1`, { method: 'POST' })).status, 401);
    assert.equal((await anna.req(`/api/spots/${spotId}/archive-suggestions/eth-2`, { method: 'POST' })).status, 409);
    assert.equal((await anna.req(`/api/spots/${spotId}/archive-suggestions/fremd`, { method: 'POST' })).status, 404);
    assert.deepEqual(fetched, []);

    const res = await anna.req(`/api/spots/${spotId}/archive-suggestions/eth-1`, { method: 'POST' });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    const photo = body.created[0];
    assert.deepEqual([photo.archive, photo.takenAt.slice(0, 10), photo.spotId, photo.license.id], [true, '1932-08-14', spotId, 'cc0-1.0']);
    assert.match(photo.note, /Archivbild: Testgletscher, Zunge · ETH-Bibliothek · Public Domain Mark/);
    assert.deepEqual(fetched, ['https://archiv.example/eth-1.jpg']);
    // The account's default licence is untouched.
    assert.notEqual((await anna.json('/api/auth/me')).user?.defaultLicense, 'cc0-1.0');
    // Once only; the list says which photo it became.
    assert.equal((await anna.req(`/api/spots/${spotId}/archive-suggestions/eth-1`, { method: 'POST' })).status, 409);
    assert.equal((await anna.json(`/api/spots/${spotId}/archive-suggestions`)).items[0].photoId, photo.id);

    // The glacier of the inventories, matched to its GLAMOS series by the SGI id.
    const g = await anna.json(`/api/spots/${spotId}/glacier`);
    assert.equal(g.glacier.id, 'B36-26');
    assert.deepEqual([g.length.name, g.length.total, g.length.points.length], ['Testgletscher', -40, 3]);
  });
});

/* ---------- Alignment on the horizon ---------- */

/** A desert picture: blue sky above a dune skyline y(x) (share of the height), sand below. */
async function desert(file, ridge, { width = 400, height = 300, shiftX = 0, shiftY = 0 } = {}) {
  const raw = Buffer.alloc(width * height * 3);
  for (let x = 0; x < width; x++) {
    const top = Math.round((ridge((x - shiftX) / width) + shiftY) * height);
    for (let y = 0; y < height; y++) {
      const [r, g, b] = y < top ? [120, 170, 230] : [200, 160, 100];
      raw.set([r, g, b], (y * width + x) * 3);
    }
  }
  await sharp(raw, { raw: { width, height, channels: 3 } }).png().toFile(file);
}

test('horizon alignment: the shift of a dune skyline, nothing for a flat horizon', async () => {
  const dir = tmp();
  try {
    const ridge = (u) => 0.4 + 0.08 * Math.sin(u * 9) + 0.04 * Math.sin(u * 23 + 1);
    const a = path.join(dir, 'a.png');
    const b = path.join(dir, 'b.png');
    await desert(a, ridge);
    // In B the skyline sits 40 px (10 %) further right and 5 % higher: column c of B lies at c − 40 of A.
    await desert(b, ridge, { shiftX: 40, shiftY: -0.05 });
    const sky = await skyline(a);
    assert.equal(sky.width, 320);
    assert.ok(Math.abs(sky.ys[0] - ridge(0)) < 0.02, String(sky.ys[0]));

    const r = await alignOnHorizon(b, a);
    assert.ok(r, 'aligned');
    assert.ok(r.correlation > 0.95, String(r.correlation));
    assert.ok(Math.abs(r.h[2] - -0.1) < 0.01, `dx ${r.h[2]}`);
    assert.ok(Math.abs(r.h[5] - 0.05) < 0.01, `dy ${r.h[5]}`);

    const flat = path.join(dir, 'flat.png');
    await desert(flat, () => 0.5);
    assert.equal(await alignOnHorizon(flat, a), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('photos of an arid spot without fixed points are aligned on the skyline', async () => {
  await withServer(() => ({}), async (base) => {
    const dir = tmp();
    try {
      const ridge = (u) => 0.4 + 0.08 * Math.sin(u * 9) + 0.04 * Math.sin(u * 23 + 1);
      await desert(path.join(dir, 'a.png'), ridge);
      await desert(path.join(dir, 'b.png'), ridge, { shiftX: 40, shiftY: -0.05 });
      const send = async (file, fields) => {
        const fd = new FormData();
        fd.append('photos', new Blob([await sharp(path.join(dir, file)).jpeg().toBuffer()], { type: 'image/jpeg' }), 'x.jpg');
        for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
        return (await (await fetch(`${base}/api/photos`, { method: 'POST', body: fd })).json()).created[0];
      };
      const a = await send('a.png', { lat: 24.1, lon: 55.6, takenAt: '2024-03-01T10:00:00Z', landscape: 'trocken' });
      const b = await send('b.png', { spotId: a.spotId, takenAt: '2025-03-01T10:00:00Z' });
      const spot = await (await fetch(`${base}/api/spots/${a.spotId}`)).json();
      const h = spot.photos.find((p) => p.id === b.id).alignment?.h;
      assert.ok(h, 'aligned');
      assert.ok(Math.abs(h[2] - -0.1) < 0.01 && Math.abs(h[5] - 0.05) < 0.01, JSON.stringify(h));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
