'use strict';

// OpenStreetMap and Wikimedia around a spot: OSM objects with wikidata tags, Wikidata items nearby,
// photos on Wikimedia Commons, and a Commons photo taken over as an archive photo.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { createApp } = require('../src/app');
const { parseOsm, parseAround, parseEntities, parseCommons, commonsDate, wikipediaOf } = require('../src/wikimedia');

const SPOT = { lat: 47.3, lon: 8.53 };
const OVERPASS = {
  elements: [
    { type: 'way', id: 11, center: { lat: 47.301, lon: 8.53 }, tags: { landuse: 'forest', name: 'Sihlwald', wikidata: 'Q672998', wikipedia: 'de:Sihlwald' } },
    { type: 'node', id: 12, lat: 47.3002, lon: 8.5301, tags: { natural: 'tree', 'species:wikidata': 'Q165145', denotation: 'natural_monument' } },
    { type: 'node', id: 13, lat: 47.3001, lon: 8.53, tags: { tourism: 'viewpoint', name: 'Hochwacht', wikipedia: 'de:Hochwacht (Albis)' } },
    { type: 'node', id: 14, lat: 47.3, lon: 8.53, tags: { name: 'kaputt', wikidata: 'nicht-qid' } },
  ],
};
const SPARQL = {
  results: { bindings: [
    { item: { value: 'http://www.wikidata.org/entity/Q672998' }, coord: { value: 'Point(8.531 47.302)' } },
    { item: { value: 'http://www.wikidata.org/entity/Q999' }, coord: { value: 'Point(8.532 47.3)' }, osm: { value: '4242' } },
    { item: { value: 'http://www.wikidata.org/entity/Q1000' }, coord: { value: 'Point(8.5305 47.3)' } },
  ] },
};
const label = (de) => ({ de: { language: 'de', value: de } });
const ENTITIES = {
  entities: {
    Q672998: {
      labels: label('Sihlwald'), descriptions: label('Wald im Kanton Zürich'),
      claims: { P18: [{ mainsnak: { datavalue: { value: 'Sihlwald Herbst.jpg' } } }], P373: [{ mainsnak: { datavalue: { value: 'Sihlwald' } } }] },
      sitelinks: { dewiki: { site: 'dewiki', title: 'Sihlwald', url: 'https://de.wikipedia.org/wiki/Sihlwald' } },
    },
    Q165145: { labels: label('Stieleiche'), descriptions: label('Baumart'), claims: {}, sitelinks: {} },
    Q999: { labels: { fr: { value: 'Rocher' } }, claims: {}, sitelinks: { frwiki: { site: 'frwiki', title: 'Rocher' } } },
    Q1000: { labels: label('Findling am Weg'), claims: {}, sitelinks: {} },
  },
};
const meta = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v }]));
const COMMONS = {
  query: { pages: [
    { title: 'File:Sihlwald 1932.jpg', coordinates: [{ lat: 47.3005, lon: 8.53 }], imageinfo: [{ mime: 'image/jpeg', thumburl: 'https://upload.example/thumb/a.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Sihlwald_1932.jpg',
      extmetadata: meta({ DateTimeOriginal: '1932-08-14', LicenseShortName: 'Public domain', Artist: '<a href="x">Jakob Meier</a>', ObjectName: 'Sihlwald im Sommer' }) }] },
    { title: 'File:Hochwacht.jpg', coordinates: [{ lat: 47.302, lon: 8.53 }], imageinfo: [{ mime: 'image/jpeg', thumburl: 'https://upload.example/thumb/b.jpg',
      extmetadata: meta({ DateTimeOriginal: '2019-05-02 10:11:12', LicenseShortName: 'CC BY-ND 4.0', Artist: 'Eva' }) }] },
    { title: 'File:Ohne Datum.jpg', coordinates: [{ lat: 47.301, lon: 8.53 }], imageinfo: [{ mime: 'image/jpeg', extmetadata: meta({ LicenseShortName: 'CC BY-SA 4.0' }) }] },
    { title: 'File:Karte.svg', coordinates: [{ lat: 47.3, lon: 8.53 }], imageinfo: [{ mime: 'image/svg+xml', extmetadata: {} }] },
  ] },
};

test('parsing: OSM tags, SPARQL, entities and Commons metadata', () => {
  const osm = parseOsm(OVERPASS);
  assert.deepEqual(osm.map((o) => [o.osm, o.kind, o.wikidata, o.species, o.wikipedia?.title]), [
    ['way/11', 'Wald', 'Q672998', null, 'Sihlwald'], ['node/12', 'Baum', null, 'Q165145', undefined], ['node/13', 'Sehenswürdigkeit', null, null, 'Hochwacht (Albis)'],
  ]);
  assert.equal(wikipediaOf('de:Hochwacht (Albis)').url, 'https://de.wikipedia.org/wiki/Hochwacht_(Albis)');
  assert.equal(wikipediaOf('ohne Sprache'), null);
  assert.deepEqual(parseAround(SPARQL).map((a) => [a.qid, a.lat, a.osmRelation]), [['Q672998', 47.302, null], ['Q999', 47.3, 'relation/4242'], ['Q1000', 47.3, null]]);
  const e = parseEntities(ENTITIES);
  assert.equal(e.get('Q672998').image.thumb, 'https://commons.wikimedia.org/wiki/Special:FilePath/Sihlwald_Herbst.jpg?width=320');
  assert.equal(e.get('Q672998').commonsCategory.url, 'https://commons.wikimedia.org/wiki/Category:Sihlwald');
  assert.equal(e.get('Q999').label, 'Rocher', 'falls back to French');
  assert.equal(e.get('Q999').wikipedia.url, 'https://fr.wikipedia.org/wiki/Rocher');
  const photos = parseCommons(COMMONS);
  assert.deepEqual(photos.map((p) => [p.file, p.date, p.licenseKey, p.author]), [
    ['Sihlwald 1932.jpg', '1932-08-14', 'cc0-1.0', 'Jakob Meier'], ['Hochwacht.jpg', '2019-05-02', null, 'Eva'], ['Ohne Datum.jpg', null, 'cc-by-sa-4.0', null],
  ]);
  assert.equal(photos[0].title, 'Sihlwald im Sommer');
  assert.equal(photos[0].image, 'https://commons.wikimedia.org/wiki/Special:FilePath/Sihlwald_1932.jpg?width=2560');
  assert.equal(commonsDate('um 1900').year, 1900);
  assert.equal(commonsDate('1650'), null, 'before photography');
});

async function withServer(opts, fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-wiki-'));
  const app = createApp({ dataDir, weatherFetch: async () => new Response('offline', { status: 503 }), routerUrl: '', ...opts });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await app.locals.idle();
    server.close();
    app.locals.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function upload(base) {
  const fd = new FormData();
  fd.append('photos', new Blob([await sharp({ create: { width: 64, height: 48, channels: 3, background: '#3a5' } }).jpeg().toBuffer()], { type: 'image/jpeg' }), 'x.jpg');
  for (const [k, v] of Object.entries({ lat: SPOT.lat, lon: SPOT.lon, takenAt: '2025-08-20T10:00:00Z' })) fd.append(k, String(v));
  return (await (await fetch(`${base}/api/photos`, { method: 'POST', body: fd })).json()).created[0].spotId;
}

function fakes() {
  const calls = [];
  const wikimediaFetch = async (url, init = {}) => {
    calls.push(String(url));
    assert.match(init.headers['User-Agent'], /^MyForrest\//);
    const u = new URL(url);
    if (u.host === 'query.wikidata.org') return Response.json(SPARQL);
    if (u.host === 'www.wikidata.org') return Response.json(ENTITIES);
    if (u.host === 'commons.wikimedia.org' && u.pathname === '/w/api.php') return Response.json(COMMONS);
    if (u.pathname.startsWith('/wiki/Special:FilePath/')) {
      return new Response(await sharp({ create: { width: 80, height: 60, channels: 3, background: '#887766' } }).jpeg().toBuffer(), { headers: { 'content-type': 'image/jpeg' } });
    }
    return new Response('?', { status: 404 });
  };
  const overpass = [];
  const waynetFetch = async (url, init) => { overpass.push(String(init.body)); return Response.json(OVERPASS); };
  return { calls, overpass, opts: { wikimediaFetch, waynetFetch, waynetUrl: 'https://overpass.example/api/interpreter' } };
}

test('GET /api/spots/:id/wikimedia: OSM and Wikidata merged per item, Commons photos, cached', async () => {
  const f = fakes();
  await withServer(f.opts, async (base) => {
    const id = await upload(base);
    const d = await (await fetch(`${base}/api/spots/${id}/wikimedia`)).json();
    assert.equal(d.enabled, true);
    assert.deepEqual(d.errors, []);
    assert.match(decodeURIComponent(f.overpass[0]), /around:500,47\.300000,8\.530000/);
    // Linked in both: the forest. Only in Wikidata: the boulder (a hint for mappers). The tree's species comes last.
    const by = Object.fromEntries(d.items.map((i) => [i.label, i]));
    assert.deepEqual(by.Sihlwald.osm, ['way/11']);
    assert.equal(by.Sihlwald.inOsm, true);
    assert.equal(by.Sihlwald.kind, 'Wald');
    assert.equal(by.Sihlwald.wikipedia.url, 'https://de.wikipedia.org/wiki/Sihlwald');
    assert.equal(by['Findling am Weg'].inOsm, false);
    assert.deepEqual(by.Rocher.osm, ['relation/4242'], 'P402 counts as linked');
    assert.equal(by.Stieleiche.relation, 'art');
    assert.equal(d.items.at(-1).label, 'Stieleiche');
    assert.equal(by.Hochwacht.qid, null, 'only a wikipedia tag');
    assert.equal(by.Hochwacht.wikipedia.title, 'Hochwacht (Albis)');
    assert.deepEqual(d.photos.map((p) => [p.file, p.importable, p.distanceM]), [['Sihlwald 1932.jpg', true, 56], ['Ohne Datum.jpg', false, 111], ['Hochwacht.jpg', false, 222]]);
    assert.equal(d.photos[0].image, undefined, 'the download address stays on the server');
    assert.match(d.editUrl, /openstreetmap\.org\/edit#map=19\/47\.300000\/8\.530000/);
    const n = f.calls.length;
    await fetch(`${base}/api/spots/${id}/wikimedia`);
    assert.equal(f.calls.length, n, 'cached');
    assert.equal((await fetch(`${base}/api/spots/999/wikimedia`)).status, 404);
  });
});

test('a Commons photo becomes an archive photo of the spot: login, date and licence checked, once', async () => {
  const f = fakes();
  await withServer(f.opts, async (base) => {
    const id = await upload(base);
    const post = (file, cookie) => fetch(`${base}/api/spots/${id}/wikimedia/photos`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie || {}) }, body: JSON.stringify({ file }),
    });
    assert.equal((await post('Sihlwald 1932.jpg')).status, 401);
    const reg = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'eva@example.org', name: 'Eva', password: 'geheim-1234' }) });
    const auth = { Cookie: reg.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': (await reg.json()).csrfToken };
    assert.equal((await post('Hochwacht.jpg', auth)).status, 409, 'CC BY-ND');
    assert.equal((await post('Ohne Datum.jpg', auth)).status, 409, 'no date');
    assert.equal((await post('https://evil.example/x.jpg', auth)).status, 404);
    const res = await post('Sihlwald 1932.jpg', auth);
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    const p = body.created[0];
    assert.deepEqual([p.archive, p.takenAt.slice(0, 10), p.spotId, p.license.id], [true, '1932-08-14', id, 'cc0-1.0']);
    assert.match(p.note, /Archivbild: Sihlwald im Sommer · Wikimedia Commons, Jakob Meier · Public domain · https:\/\/commons/);
    assert.ok(f.calls.some((u) => u === 'https://commons.wikimedia.org/wiki/Special:FilePath/Sihlwald_1932.jpg?width=2560'));
    assert.equal((await post('Sihlwald 1932.jpg', auth)).status, 409, 'once');
    const d = await (await fetch(`${base}/api/spots/${id}/wikimedia`)).json();
    assert.equal(d.photos[0].photoId, p.id);
  });
});

test('parts that fail leave a message, the rest stands; WIKIMEDIA off', async () => {
  const wikimediaFetch = async (url) => (new URL(url).host === 'commons.wikimedia.org' ? Response.json(COMMONS) : new Response('busy', { status: 503 }));
  await withServer({ wikimediaFetch }, async (base) => {
    const id = await upload(base);
    const d = await (await fetch(`${base}/api/spots/${id}/wikimedia`)).json();
    assert.equal(d.osm, false, 'no Overpass configured');
    assert.deepEqual(d.items, []);
    assert.equal(d.photos.length, 3);
    assert.deepEqual(d.errors, ['Wikidata (SPARQL) antwortete mit HTTP 503']);
  });
  await withServer({ wikimediaOptions: { enabled: false } }, async (base) => {
    const id = await upload(base);
    assert.deepEqual(await (await fetch(`${base}/api/spots/${id}/wikimedia`)).json(), { enabled: false, items: [], photos: [] });
  });
});
