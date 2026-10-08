'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { parseTrackFile, toGpx } = require('../src/trackfile');
const { lengthM, nearRoute, trimEnds } = require('../src/routegeo');

const fixture = (name) => new Blob([fs.readFileSync(path.join(__dirname, 'fixtures', name))], { type: 'image/jpeg' });
const noWeather = async () => new Response('offline', { status: 503 });

async function withServer(opts, fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-tracks-'));
  const app = createApp({ dataDir, weatherFetch: noWeather, ...opts });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, app.locals.db);
  } finally {
    await app.locals.idle();
    server.close();
    app.locals.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

/** Keeps the session cookie and sends the CSRF token. */
function client(base) {
  const c = {
    cookie: null,
    csrf: null,
    async req(url, { method = 'GET', json, body } = {}) {
      const h = {};
      if (c.cookie) h.Cookie = c.cookie;
      if (c.csrf && method !== 'GET') h['X-CSRF-Token'] = c.csrf;
      if (json !== undefined) {
        h['Content-Type'] = 'application/json';
        body = JSON.stringify(json);
      }
      const res = await fetch(`${base}${url}`, { method, headers: h, body });
      const set = res.headers.get('set-cookie');
      if (set) c.cookie = set.split(';')[0];
      return res;
    },
    async register(name) {
      const res = await c.req('/api/auth/register', { method: 'POST', json: { email: `${name}@example.org`, name, password: 'geheim-1234' } });
      c.csrf = (await res.json()).csrfToken;
    },
  };
  return c;
}

// A straight line north, ~1.1 km, one point every ~111 m, one minute apart.
const LINE = Array.from({ length: 11 }, (_, i) => ({ lat: 47.37 + i * 0.001, lon: 8.54, time: Date.UTC(2026, 4, 1, 8, i) }));

/* ---------- Files ---------- */

test('GPX tracks, routes and waypoints are read with elevation and time', () => {
  const gpx = `<?xml version="1.0"?><gpx><metadata><name>Meta</name></metadata><trk><name>Abendrunde &amp; Wald</name><trkseg>
    <trkpt lat="47.1" lon="8.1"><ele>500</ele><time>2026-05-01T08:01:00Z</time></trkpt>
    <trkpt lat="47.0" lon="8.0"><ele>501.25</ele><time>2026-05-01T08:00:00Z</time></trkpt>
  </trkseg></trk></gpx>`;
  const t = parseTrackFile(gpx, 'x.gpx');
  assert.equal(t.format, 'gpx');
  assert.equal(t.name, 'Abendrunde & Wald');
  assert.equal(t.hasTime, true);
  assert.deepEqual(t.points.map((p) => p.lat), [47.0, 47.1], 'sorted by time');
  assert.equal(t.points[0].ele, 501.3);

  const route = parseTrackFile('<gpx><rte><rtept lat="47" lon="8"/><rtept lat="47.01" lon="8"/></rte></gpx>', 'planung.gpx');
  assert.equal(route.points.length, 2);
  assert.equal(route.hasTime, false);
  assert.equal(route.name, 'planung', 'file name when the file has none');

  const wpts = parseTrackFile('<gpx><wpt lat="47" lon="8"></wpt><wpt lat="47.01" lon="8.01"></wpt></gpx>');
  assert.equal(wpts.points.length, 2);
});

test('TCX, KML (LineString and gx:Track) and GeoJSON', () => {
  const tcx = `<TrainingCenterDatabase><Activities><Activity><Id>2026-05-01T08:00:00Z</Id><Lap><Track>
    <Trackpoint><Time>2026-05-01T08:00:00Z</Time><Position><LatitudeDegrees>47</LatitudeDegrees><LongitudeDegrees>8</LongitudeDegrees></Position><AltitudeMeters>400</AltitudeMeters></Trackpoint>
    <Trackpoint><Time>2026-05-01T08:00:05Z</Time><Position><LatitudeDegrees>47.001</LatitudeDegrees><LongitudeDegrees>8</LongitudeDegrees></Position></Trackpoint>
    <Trackpoint><Time>2026-05-01T08:00:06Z</Time></Trackpoint>
  </Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
  const a = parseTrackFile(tcx, 'lauf.tcx');
  assert.equal(a.format, 'tcx');
  assert.equal(a.points.length, 2, 'points without position are skipped');
  assert.equal(a.points[0].ele, 400);
  assert.equal(a.points[1].time, Date.UTC(2026, 4, 1, 8, 0, 5));

  const kml = `<kml><Document><name>Tour</name><Placemark><LineString><coordinates>8,47,400 8.01,47.01,410</coordinates></LineString></Placemark></Document></kml>`;
  const k = parseTrackFile(kml, 'tour.kml');
  assert.deepEqual(k.points, [{ lat: 47, lon: 8, ele: 400 }, { lat: 47.01, lon: 8.01, ele: 410 }]);
  assert.equal(k.name, 'Tour');

  const gx = `<kml xmlns:gx="http://www.google.com/kml/ext/2.2"><Placemark><gx:Track>
    <when>2026-05-01T08:00:00Z</when><when>2026-05-01T08:01:00Z</when>
    <gx:coord>8 47 400</gx:coord><gx:coord>8 47.001 401</gx:coord></gx:Track></Placemark></kml>`;
  assert.equal(parseTrackFile(gx).points[1].time, Date.UTC(2026, 4, 1, 8, 1));

  const geo = JSON.stringify({ type: 'Feature', properties: { name: 'Geo', coordTimes: ['2026-05-01T08:00:00Z', '2026-05-01T08:00:10Z'] },
    geometry: { type: 'LineString', coordinates: [[8, 47], [8, 47.001]] } });
  const g = parseTrackFile(geo, 'x.geojson');
  assert.equal(g.name, 'Geo');
  assert.equal(g.points[1].time, Date.UTC(2026, 4, 1, 8, 0, 10));

  assert.throws(() => parseTrackFile('hallo', 'x.txt'), /Unbekanntes Format/);
  assert.throws(() => parseTrackFile('<gpx><trk><trkpt lat="47" lon="8"/></trk></gpx>'), /mindestens zwei Punkten/);
});

test('GPX export round-trips', () => {
  const back = parseTrackFile(toGpx({ name: 'A <B>', points: LINE.slice(0, 3).map((p) => ({ ...p, ele: 500 })) }));
  assert.equal(back.name, 'A <B>');
  assert.equal(back.points.length, 3);
  assert.equal(back.points[2].time, LINE[2].time);
  assert.equal(back.points[0].ele, 500);
});

/* ---------- Geometry ---------- */

test('distance to the route, position along it and the privacy zone', () => {
  assert.ok(Math.abs(lengthM(LINE) - 1112) < 3);
  const [beside, far, end] = nearRoute(LINE, [
    { lat: 47.3745, lon: 8.5413 }, // ~100 m east of the 500 m mark
    { lat: 47.3745, lon: 8.55 },
    { lat: 47.3805, lon: 8.54 }, // ~56 m beyond the end
  ], 150);
  assert.ok(Math.abs(beside.distanceM - 98) <= 2, String(beside.distanceM));
  assert.ok(Math.abs(beside.alongM - 500) <= 3, String(beside.alongM));
  assert.equal(far, null);
  assert.ok(Math.abs(end.alongM - 1112) <= 3);

  const trimmed = trimEnds(LINE, 200);
  assert.equal(trimmed[0].lat, LINE[2].lat);
  assert.equal(trimmed.at(-1).lat, LINE[8].lat);
  assert.deepEqual(trimEnds(LINE.slice(0, 3), 200), [], 'short tours vanish entirely');
});

/* ---------- API ---------- */

test('tours: parse without storing, save with login, privacy for others, GPX download', async () => {
  await withServer({}, async (base) => {
    const anna = client(base);
    const gpx = toGpx({ name: 'Morgenlauf', points: LINE });
    let res = await anna.req('/api/tracks/parse', { method: 'POST', json: { text: gpx, filename: 'lauf.gpx' } });
    const parsed = await res.json();
    assert.equal(res.status, 200);
    assert.equal(parsed.points.length, 11);
    assert.ok(Math.abs(parsed.distanceM - 1112) < 3);
    assert.equal((await anna.req('/api/tracks/parse', { method: 'POST', json: { text: 'x' } })).status, 422);

    res = await anna.req('/api/tracks', { method: 'POST', json: { name: 'x', points: LINE } });
    assert.equal(res.status, 401, 'saving needs an account');

    await anna.register('anna');
    res = await anna.req('/api/tracks', { method: 'POST', json: { name: 'Morgenlauf', kind: 'aufgezeichnet', activity: 'joggen', points: parsed.points } });
    assert.equal(res.status, 201);
    const tour = await res.json();
    assert.equal(tour.visibility, 'privat');
    assert.equal(tour.startedAt, '2026-05-01T08:00:00.000Z');
    assert.equal((await anna.req('/api/tracks', { method: 'POST', json: { points: [LINE[0]] } })).status, 400);

    const ben = client(base);
    assert.equal((await ben.req(`/api/tracks/${tour.id}`)).status, 404, 'private tours are invisible to others');
    assert.deepEqual(await (await ben.req('/api/tracks')).json(), []);
    const mine = await (await anna.req('/api/tracks?mine=1')).json();
    assert.deepEqual(mine.map((t) => t.id), [tour.id]);

    res = await anna.req(`/api/tracks/${tour.id}`, { method: 'PATCH', json: { visibility: 'oeffentlich', name: 'Runde' } });
    assert.equal((await res.json()).visibility, 'oeffentlich');
    const pub = await (await ben.req('/api/tracks')).json();
    assert.equal(pub.length, 1);
    assert.equal(pub[0].owner, 'anna');
    assert.equal(pub[0].startedAt, null, 'no times for others');
    assert.equal(pub[0].start.lat, LINE[2].lat, 'start shown after the privacy zone');
    const seen = await (await ben.req(`/api/tracks/${tour.id}`)).json();
    assert.equal(seen.points.length, 7);
    assert.ok(seen.points.every((p) => p.time === undefined));
    const own = await (await anna.req(`/api/tracks/${tour.id}`)).json();
    assert.equal(own.points.length, 11);
    assert.equal(own.points[0].time, LINE[0].time);

    assert.equal((await ben.req(`/api/tracks/${tour.id}`, { method: 'DELETE' })).status, 401);
    res = await anna.req(`/api/tracks/${tour.id}.gpx`);
    assert.match(res.headers.get('content-type'), /gpx/);
    assert.match(await res.text(), /<name>Runde<\/name>[\s\S]*<time>2026-05-01T08:00:00.000Z<\/time>/);
    assert.equal((await anna.req(`/api/tracks/${tour.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await anna.req(`/api/tracks/${tour.id}`)).status, 404);
  });
});

test('photo requests: suggestions along a route, fulfilled by a photo nearby', async () => {
  await withServer({}, async (base, db) => {
    const anon = client(base);
    let res = await anon.req('/api/photo-requests', { method: 'POST', json: { lat: 47.3745, lon: 8.5405, heading: 90, title: 'Bachufer nach Osten' } });
    assert.equal(res.status, 201);
    const req1 = await res.json();
    assert.equal(req1.status, 'offen');
    assert.equal(req1.own, false);
    assert.equal((await anon.req('/api/photo-requests', { method: 'POST', json: { lat: 47, lon: 8 } })).status, 400);
    await anon.req('/api/photo-requests', { method: 'POST', json: { lat: 47.40, lon: 8.54, title: 'Weit weg' } });

    // Suggestions: only the request near the route, with its position along it; nothing about the route is stored.
    res = await anon.req('/api/route-suggestions', { method: 'POST', json: { points: LINE.map((p) => [p.lat, p.lon]), maxDistanceM: 150 } });
    const sug = await res.json();
    assert.deepEqual(sug.suggestions.map((s) => s.title), ['Bachufer nach Osten']);
    assert.ok(Math.abs(sug.suggestions[0].alongM - 500) < 5);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tracks").get().n, 0);

    const fd = (lat, lon, extra = {}) => {
      const f = new FormData();
      f.append('photos', fixture('nogps.jpg'), 'x.jpg');
      for (const [k, v] of Object.entries({ lat, lon, ...extra })) f.append(k, v);
      return f;
    };
    // nogps.jpg has no heading, so direction cannot rule it out: it fulfils the request.
    res = await anon.req('/api/photos', { method: 'POST', body: fd('47.37455', '8.5406') });
    const up = await res.json();
    assert.deepEqual(up.requestsDone, [req1.id]);
    const all = await (await anon.req('/api/photo-requests?status=alle')).json();
    const done = all.find((r) => r.id === req1.id);
    assert.equal(done.status, 'erledigt');
    assert.equal(done.photoId, up.created[0].id);
    const open = await (await anon.req('/api/photo-requests')).json();
    assert.deepEqual(open.map((r) => r.title), ['Weit weg']);

    // Naming the request fulfils it from up to 150 m.
    res = await anon.req('/api/photos', { method: 'POST', body: fd('47.4010', '8.54', { requestId: String(open[0].id) }) });
    assert.equal((await res.json()).requestsDone.length, 1);
  });
});

test('photo requests for a spot, withdrawal by the requester, stale spots in suggestions', async () => {
  await withServer({}, async (base, db) => {
    const anna = client(base);
    await anna.register('anna');
    let photo;
    for (let i = 0; i < 2; i++) { // a series of two photos, 2024-05-01 at 47.375, 8.5375
      const f = new FormData();
      f.append('photos', fixture('gps.jpg'), 'gps.jpg');
      photo = (await (await anna.req('/api/photos', { method: 'POST', body: f })).json()).created[0];
    }

    let res = await anna.req('/api/photo-requests', { method: 'POST', json: { spotId: photo.spotId, title: 'Bitte wieder fotografieren' } });
    const r = await res.json();
    assert.equal(r.spotId, photo.spotId);
    assert.equal(r.own, true);

    const route = [[47.374, 8.5375], [47.376, 8.5375]];
    const sug = (await (await anna.req('/api/route-suggestions', { method: 'POST', json: { points: route } })).json()).suggestions;
    assert.deepEqual(sug.map((s) => s.kind).sort(), ['auftrag', 'lange_nicht']);
    assert.match(sug.find((s) => s.kind === 'lange_nicht').text, /Letztes Foto vom 01\.05\.2024/);

    const ben = client(base);
    await ben.register('ben');
    assert.equal((await ben.req(`/api/photo-requests/${r.id}`, { method: 'DELETE' })).status, 403);
    assert.equal((await anna.req(`/api/photo-requests/${r.id}`, { method: 'DELETE' })).status, 204);
    assert.equal(db.prepare('SELECT status FROM photo_requests WHERE id = ?').get(r.id).status, 'zurueckgezogen');
  });
});

test('routing along paths through a BRouter-compatible service', async () => {
  let asked = null;
  const routerFetch = async (url) => {
    asked = url;
    return new Response(JSON.stringify({ features: [{ geometry: { coordinates: [[8.54, 47.37, 500], [8.541, 47.371, 505], [8.54, 47.372, 510]] } }] }));
  };
  await withServer({ routerUrl: 'https://router.example/brouter', routerFetch }, async (base) => {
    assert.equal((await (await fetch(`${base}/api/config`)).json()).routing, true);
    const res = await fetch(`${base}/api/route?points=47.37,8.54;47.372,8.54`);
    const body = await res.json();
    assert.equal(body.points.length, 3);
    assert.equal(body.points[1].ele, 505);
    assert.match(asked, /lonlats=8\.540000%2C47\.370000%7C8\.540000%2C47\.372000&profile=hiking-mountain/);
    assert.equal((await fetch(`${base}/api/route?points=47.37,8.54`)).status, 400);
  });
  await withServer({ routerUrl: '' }, async (base) => {
    assert.equal((await fetch(`${base}/api/config`).then((r) => r.json())).routing, false);
    assert.equal((await fetch(`${base}/api/route?points=47.37,8.54;47.372,8.54`)).status, 501);
  });
});
