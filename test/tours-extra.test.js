'use strict';

// Tours: FIT files, elevation profile, photo requests that run out or are done (with a push message).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseFit, writeFit } = require('../src/fit');
const { parseTrackFile, toGpx } = require('../src/trackfile');
const { sampleAlong, climb } = require('../src/routegeo');
const { createApp } = require('../src/app');

const T0 = Date.UTC(2026, 4, 1, 8, 0, 0);
const run = (n = 60) => Array.from({ length: n }, (_, i) => ({ lat: 47.36 + i * 0.0002, lon: 8.58, ele: 500 + 30 * Math.sin(i / 10), time: T0 + i * 5000 }));

test('FIT: records with positions, altitude and time, also with compressed timestamps', () => {
  const fit = writeFit(run(), { compressAfter: 20 });
  const { points } = parseFit(fit);
  assert.equal(points.length, 60);
  assert.ok(Math.abs(points[59].lat - (47.36 + 59 * 0.0002)) < 1e-6);
  assert.equal(points[59].time, T0 + 59 * 5000, 'time from the compressed header');
  assert.ok(Math.abs(points[30].ele - run()[30].ele) < 0.3);
  // As a tour: format, time order, name from the file.
  const t = parseTrackFile(fit, 'Morgenlauf.fit');
  assert.deepEqual([t.format, t.points.length, t.hasTime, t.name], ['fit', 60, true, 'Morgenlauf']);
  assert.throws(() => parseFit(Buffer.from('kein FIT')), /Keine FIT-Datei/);
});

test('FIT sensors: heart rate, power, cadence as steps for runs, temperature, and developer fields', () => {
  const pts = run(40).map((p, i) => ({
    ...p, hr: 130 + (i % 20), cadence: i < 2 ? 0 : 84, temp: 12 + (i % 5) - (i > 30 ? 20 : 0),
    dev: { Power: 240 + (i % 10), 'Form Power': 60 },
  }));
  // The foot pod's "Power" stands for the standard power field (7); "Form Power" is its own.
  const fit = writeFit(pts, { sport: 1, compressAfter: 25, developer: [{ name: 'Power', units: 'Watts', native: 7 }, { name: 'Form Power', units: 'Watts' }] });
  const { name, points, sensors } = parseFit(fit);
  assert.equal(name, 'Lauf');
  assert.equal(points.length, 40);
  const by = Object.fromEntries(sensors.map((s) => [s.key, s]));
  assert.deepEqual(Object.keys(by), ['hr', 'power', 'steps', 'temp', 'dev:Form Power']);
  assert.deepEqual([by.hr.label, by.hr.max, by.hr.n], ['Puls', 149, 40]);
  assert.deepEqual([by.steps.label, by.steps.avg, by.steps.n], ['Schrittfrequenz', 168, 38], 'strides × 2, standstill left out');
  assert.equal(by.temp.min, -8, 'below zero');
  assert.deepEqual([by.power.label, by.power.unit, by.power.max], ['Leistung', 'W', 249]);
  assert.deepEqual([by['dev:Form Power'].label, by['dev:Form Power'].unit, by['dev:Form Power'].avg], ['Form Power', 'Watts', 60]);
  // A watch with its own power: the foot pod's does not count twice.
  const both = parseFit(writeFit(pts.map((p) => ({ ...p, power: 300 })), { developer: [{ name: 'Power', units: 'Watts', native: 7 }] }));
  assert.equal(both.sensors.find((s) => s.key === 'power').avg, 300);
  assert.equal(both.sensors.find((s) => s.key === 'cadence').label, 'Trittfrequenz', 'not a run: as stored');
  // Without sensors: nothing.
  assert.deepEqual(parseFit(writeFit(run())).sensors, []);
  assert.equal(parseTrackFile(writeFit(run()), 'x.fit').sensors, undefined);
  assert.equal(parseTrackFile(fit, 'x.fit').sensors.length, 5);
});

test('sensor values per point: FIT, Garmin GPX extensions, TCX; GPX export and back', () => {
  const pts = run(10).map((p, i) => ({ ...p, hr: 120 + i, cadence: 85, temp: 15 - i, dev: { Power: 200 + i } }));
  const fit = parseFit(writeFit(pts, { sport: 1, developer: [{ name: 'Power', units: 'Watts', native: 7 }] }));
  assert.deepEqual(['hr', 'steps', 'temp', 'power'].map((k) => fit.points[3][k]), [123, 170, 12, 203]);
  assert.equal(fit.points[3].cadence, undefined, 'runs: steps instead of strides');

  const gpx = `<?xml version="1.0"?><gpx xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"><trk><trkseg>
    <trkpt lat="47.36" lon="8.58"><ele>500</ele><time>2026-05-01T08:00:00Z</time><extensions><power>210</power><gpxtpx:TrackPointExtension><gpxtpx:atemp>18</gpxtpx:atemp><gpxtpx:hr>131</gpxtpx:hr><gpxtpx:cad>88</gpxtpx:cad></gpxtpx:TrackPointExtension></extensions></trkpt>
    <trkpt lat="47.361" lon="8.58"><ele>505</ele><time>2026-05-01T08:00:30Z</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>139</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
  </trkseg></trk></gpx>`;
  const g = parseTrackFile(gpx, 'lauf.gpx');
  assert.deepEqual([g.points[0].hr, g.points[0].cadence, g.points[0].temp, g.points[0].power, g.points[1].hr], [131, 88, 18, 210, 139]);
  assert.deepEqual(g.sensors.map((x) => [x.key, x.avg]), [['hr', 135], ['power', 210], ['cadence', 88], ['temp', 18]]);
  // Out as GPX with the same extensions, and back in.
  const again = parseTrackFile(toGpx({ name: 'x', points: g.points }), 'x.gpx');
  assert.deepEqual(again.points.map((p) => [p.hr, p.power, p.cadence, p.temp]), g.points.map((p) => [p.hr, p.power, p.cadence, p.temp]));

  const tcx = `<TrainingCenterDatabase><Activities><Activity Sport="Running"><Lap><Track>
    <Trackpoint><Time>2026-05-01T08:00:00Z</Time><Position><LatitudeDegrees>47.36</LatitudeDegrees><LongitudeDegrees>8.58</LongitudeDegrees></Position><HeartRateBpm><Value>142</Value></HeartRateBpm><Extensions><ns3:TPX><ns3:RunCadence>82</ns3:RunCadence><ns3:Watts>250</ns3:Watts></ns3:TPX></Extensions></Trackpoint>
    <Trackpoint><Time>2026-05-01T08:00:05Z</Time><Position><LatitudeDegrees>47.3602</LatitudeDegrees><LongitudeDegrees>8.58</LongitudeDegrees></Position><HeartRateBpm><Value>144</Value></HeartRateBpm></Trackpoint>
  </Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
  const t = parseTrackFile(tcx, 'lauf.tcx');
  assert.deepEqual([t.points[0].hr, t.points[0].steps, t.points[0].power, t.points[1].hr, t.points[1].steps], [142, 164, 250, 144, undefined]);
  // Without sensor values: nothing extra.
  assert.equal(parseTrackFile(toGpx({ name: 'x', points: run(3) }), 'x.gpx').sensors, undefined);
});

test('elevation profile: samples along the route, ascent and descent without noise', () => {
  const pts = run(100).map((p, i) => ({ ...p, ele: 500 + i + (i % 2 ? 1.5 : 0) })); // 99 m up, with 1.5 m jitter
  const s = sampleAlong(pts, 50);
  assert.equal(s.length, 50);
  assert.equal(s[0].d, 0);
  const c = climb(s);
  assert.ok(c.ascent >= 95 && c.ascent <= 101, `ascent ${c.ascent}`);
  assert.ok(c.descent <= 3, `descent ${c.descent}`);
});

function withServer(fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-tours-'));
  const asked = [];
  // Open-Meteo stand-in: the elevation model rises 1 m per 10 m north.
  const weatherFetch = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/elevation')) {
      asked.push(u);
      const lats = u.searchParams.get('latitude').split(',').map(Number);
      return Response.json({ elevation: lats.map((la) => 400 + (la - 47.36) * 11132) });
    }
    return new Response('offline', { status: 503 });
  };
  const app = createApp({ dataDir, weatherFetch, routerUrl: '' });
  const server = app.listen(0);
  return new Promise((r) => server.once('listening', r)).then(async () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      await fn(base, app, asked);
    } finally {
      await app.locals.idle();
      server.close();
      app.locals.db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
}

function client(base) {
  const c = {
    async req(url, { method = 'GET', json, body } = {}) {
      const h = {};
      if (c.cookie) h.Cookie = c.cookie;
      if (c.csrf && method !== 'GET') h['X-CSRF-Token'] = c.csrf;
      if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
      const res = await fetch(`${base}${url}`, { method, headers: h, body });
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

test('FIT through the API: tour import as base64, and as the track for photos without GPS', async () => {
  await withServer(async (base) => {
    const fit = writeFit(run());
    const t = await (await fetch(`${base}/api/tracks/parse`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base64: fit.toString('base64'), filename: 'lauf.fit' }),
    })).json();
    assert.deepEqual([t.format, t.points.length], ['fit', 60]);
    // A photo without GPS, taken at 08:02:30 UTC: placed on the FIT track.
    const fd = new FormData();
    fd.append('photos', new Blob([fs.readFileSync(path.join(__dirname, 'fixtures', 'nogps.jpg'))], { type: 'image/jpeg' }), 'foto.jpg');
    fd.append('gpx', new Blob([fit]), 'lauf.fit');
    fd.append('clockShiftSeconds', String((T0 + 150000 - Date.parse('2024-05-01T08:30:00Z')) / 1000)); // the fixture's EXIF time → 08:02:30
    const up = await (await fetch(`${base}/api/photos`, { method: 'POST', body: fd })).json();
    assert.equal(up.created.length, 1, JSON.stringify(up));
    assert.equal(up.created[0].locationSource, 'gpx');
    assert.ok(Math.abs(up.created[0].lat - (47.36 + 30 * 0.0002)) < 2e-5, `lat ${up.created[0].lat}`);
  });
});

test('FIT sensors are kept with an imported tour, for its owner only', async () => {
  await withServer(async (base) => {
    const anna = client(base);
    await anna.register('Anna');
    const ben = client(base);
    await ben.register('Benno');
    const fit = writeFit(run().map((p) => ({ ...p, hr: 140 })), { sport: 1 });
    const t = await anna.json('/api/tracks/parse', { method: 'POST', json: { base64: fit.toString('base64'), filename: 'lauf.fit' } });
    assert.deepEqual(t.sensors.map((s) => [s.key, s.avg]), [['hr', 140]]);
    const points = t.points.map((p) => [p.lat, p.lon, p.ele, p.time]);
    const saved = await anna.json('/api/tracks', { method: 'POST', json: { name: 'Lauf', kind: 'importiert', visibility: 'oeffentlich', points, sensors: t.sensors } });
    assert.equal(saved.sensors[0].avg, 140);
    assert.equal((await anna.json(`/api/tracks/${saved.id}`)).sensors[0].label, 'Puls');
    assert.equal((await ben.json(`/api/tracks/${saved.id}`)).sensors, null, 'health data: not for others');
    assert.equal((await ben.json('/api/tracks')).find((x) => x.id === saved.id).sensors, null);
    // The values along the route: for the owner (also in the GPX download), not for others.
    const withValues = t.points.map((p) => [p.lat, p.lon, p.ele, p.time, { hr: p.hr }]);
    const along = await anna.json('/api/tracks', { method: 'POST', json: { name: 'Lauf 2', kind: 'importiert', visibility: 'oeffentlich', points: withValues } });
    assert.equal((await anna.json(`/api/tracks/${along.id}`)).points[10].hr, 140);
    assert.ok((await ben.json(`/api/tracks/${along.id}`)).points.every((p) => p.hr === undefined));
    assert.match(await (await anna.req(`/api/tracks/${along.id}.gpx`)).text(), /<gpxtpx:hr>140<\/gpxtpx:hr>/);
    assert.doesNotMatch(await (await ben.req(`/api/tracks/${along.id}.gpx`)).text(), /gpxtpx:hr>/);
    // Implausible values are dropped.
    const odd = await anna.json('/api/tracks', { method: 'POST', json: { kind: 'importiert', points: withValues.map((p) => [...p.slice(0, 4), { hr: 999, temp: 12 }]) } });
    assert.deepEqual([odd.points[0].hr, odd.points[0].temp], [undefined, 12]);
    // Drawn tours carry none, and junk is dropped.
    const drawn = await anna.json('/api/tracks', { method: 'POST', json: { kind: 'gezeichnet', points, sensors: t.sensors } });
    assert.equal(drawn.sensors, null);
    const junk = await anna.json('/api/tracks', { method: 'POST', json: { kind: 'importiert', points, sensors: [{ key: 'x' }, 'y'] } });
    assert.equal(junk.sensors, null);
  });
});

test('route profile: own elevations, or the elevation model for a drawn line', async () => {
  await withServer(async (base, app, asked) => {
    const post = (points) => fetch(`${base}/api/route-profile`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ points }) }).then((r) => r.json());
    const own = await post(run().map((p) => [p.lat, p.lon, p.ele]));
    assert.equal(own.source, 'route');
    assert.equal(asked.length, 0, 'no model needed');
    assert.ok(own.max - own.min > 50);
    // Two clicked points, no elevations: the model, sampled along the line (1 km north = 100 m up).
    const drawn = await post([[47.36, 8.58], [47.369, 8.58]]);
    assert.equal(drawn.source, 'modell');
    assert.equal(asked.length, 1, 'one request for all samples');
    assert.ok(drawn.samples.length > 50);
    assert.ok(Math.abs(drawn.ascent - 100) <= 2, `ascent ${drawn.ascent}`);
    assert.equal(drawn.descent, 0);
    // Cached: the same line again needs no request.
    await post([[47.36, 8.58], [47.369, 8.58]]);
    assert.equal(asked.length, 1);
  });
});

test('photo requests run out after their time; a done one sends a push message to whoever asked', async () => {
  await withServer(async (base, app) => {
    const sent = [];
    app.locals.push.send = async (userId, message) => { sent.push({ userId, message }); return 1; };
    const anna = client(base);
    const annaUser = await anna.register('Anna');
    const ben = client(base);
    await ben.register('Benno');
    const make = (title, extra) => anna.json('/api/photo-requests', { method: 'POST', json: { lat: 47.37, lon: 8.55, title, ...extra } });
    const a = await make('Bachufer', { expiresInDays: 30 });
    const b = await make('Lichtung', { expiresInDays: 7, lat: 47.38 });
    assert.equal((await anna.req('/api/photo-requests', { method: 'POST', json: { lat: 47.37, lon: 8.55, title: 'x', expiresInDays: 3 } })).status, 400);
    const days = (Date.parse(a.expiresAt) - Date.now()) / 86400000;
    assert.ok(days > 28 && days < 31, `expires in ${days} days`);

    // "Lichtung" runs out: no longer open, "abgelaufen" in the full list, and a photo there no longer counts.
    app.locals.db.prepare('UPDATE photo_requests SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, b.id);
    const open = await anna.json('/api/photo-requests');
    assert.deepEqual(open.map((r) => r.title), ['Bachufer']);
    const all = await anna.json('/api/photo-requests?status=alle');
    assert.equal(all.find((r) => r.id === b.id).status, 'abgelaufen');

    // Benno photographs the brook: done, Anna gets a message with a link to the photo.
    const upload = async (who, lat) => {
      const fd = new FormData();
      fd.append('photos', new Blob([fs.readFileSync(path.join(__dirname, 'fixtures', 'nogps.jpg'))], { type: 'image/jpeg' }), 'foto.jpg');
      fd.append('lat', String(lat)); fd.append('lon', '8.55');
      return who.json('/api/photos', { method: 'POST', body: fd });
    };
    const up = await upload(ben, 47.37);
    assert.deepEqual(up.requestsDone, [a.id]);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].userId, annaUser.id);
    assert.equal(sent[0].message.title, 'Fotoauftrag erledigt');
    assert.match(sent[0].message.body, /Bachufer/);
    assert.equal(sent[0].message.url, `./?spot=${up.created[0].spotId}&photo=${up.created[0].id}`);
    // At the expired place: nothing done, no message.
    const late = await upload(ben, 47.38);
    assert.deepEqual(late.requestsDone, []);
    // Anna fulfils her own request: no message to herself.
    await make('Brücke', { lat: 47.39 });
    await upload(anna, 47.39);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(sent.length, 1);
  });
});
