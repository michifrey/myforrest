'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');

const fixture = (name) => new Blob([fs.readFileSync(path.join(__dirname, 'fixtures', name))], { type: 'image/jpeg' });

// Weather lookups must never reach the network in tests.
const noWeather = async () => new Response('offline', { status: 503 });

async function withServer(opts, fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-'));
  const app = createApp({ dataDir, weatherFetch: noWeather, ...opts });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, dataDir);
  } finally {
    await app.locals.idle();
    server.close();
    app.locals.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

const upload = (base, files, fields = {}) => {
  const fd = new FormData();
  for (const [name, blob] of files) fd.append(name === 'gpx' ? 'gpx' : 'photos', blob, name);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fetch(`${base}/api/photos`, { method: 'POST', body: fd });
};

test('photos with EXIF GPS land in a spot, nearby photos share it', async () => {
  await withServer({}, async (base) => {
    let res = await upload(base, [['gps.jpg', fixture('gps.jpg')]], { tags: 'sturmschaden' });
    assert.equal(res.status, 201);
    const first = (await res.json()).created[0];
    assert.equal(first.locationSource, 'exif');
    assert.equal(first.takenAt, '2024-05-01T08:00:00.000Z');
    assert.deepEqual(first.tags, ['sturmschaden']);

    // ~10 m away, placed manually → same spot
    res = await upload(base, [['nogps.jpg', fixture('nogps.jpg')]], { lat: '47.37509', lon: '8.5375' });
    const second = (await res.json()).created[0];
    assert.equal(second.locationSource, 'manual');
    assert.equal(second.spotId, first.spotId);

    // ~1 km away → new spot
    res = await upload(base, [['nogps.jpg', fixture('nogps.jpg')]], { lat: '47.384', lon: '8.5375' });
    assert.notEqual((await res.json()).created[0].spotId, first.spotId);

    const spots = await (await fetch(`${base}/api/spots`)).json();
    assert.equal(spots.length, 2);
    const filtered = await (await fetch(`${base}/api/spots?tag=sturmschaden`)).json();
    assert.deepEqual(filtered.map((s) => s.id), [first.spotId]);

    const spot = await (await fetch(`${base}/api/spots/${first.spotId}`)).json();
    assert.deepEqual(spot.photos.map((p) => p.id), [first.id, second.id]);
    const img = await fetch(`${base}${first.url}`);
    assert.equal(img.status, 200);
  });
});

test('photos without GPS are placed via GPX track by capture time', async () => {
  await withServer({}, async (base) => {
    // nogps.jpg was taken 2024-05-01 10:30:00 +02:00 = 08:30:00Z
    const gpx = `<gpx><trk><trkseg>
      <trkpt lat="47.0" lon="8.0"><time>2024-05-01T08:20:00Z</time></trkpt>
      <trkpt lat="47.02" lon="8.02"><time>2024-05-01T08:40:00Z</time></trkpt>
    </trkseg></trk></gpx>`;
    const res = await upload(base, [
      ['nogps.jpg', fixture('nogps.jpg')],
      ['gpx', new Blob([gpx], { type: 'application/gpx+xml' })],
    ], { utcOffsetMinutes: '0' });
    assert.equal(res.status, 201);
    const p = (await res.json()).created[0];
    assert.equal(p.locationSource, 'gpx');
    assert.ok(Math.abs(p.lat - 47.01) < 1e-6 && Math.abs(p.lon - 8.01) < 1e-6);
  });
});

test('uploads without any location or with non-images are skipped', async () => {
  await withServer({}, async (base, dataDir) => {
    const res = await upload(base, [
      ['nogps.jpg', fixture('nogps.jpg')],
      ['evil.jpg', new Blob(['<script>alert(1)</script>'], { type: 'image/jpeg' })],
    ]);
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.created.length, 0);
    assert.equal(body.skipped.length, 2);
    assert.deepEqual(fs.readdirSync(path.join(dataDir, 'uploads')), []);
    assert.deepEqual(fs.readdirSync(path.join(dataDir, 'tmp')), []);
  });
});

test('tags can be edited and deleting the last photo removes the spot', async () => {
  await withServer({}, async (base) => {
    const p = (await (await upload(base, [['gps.jpg', fixture('gps.jpg')]])).json()).created[0];
    let res = await fetch(`${base}/api/photos/${p.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: ['neophyt', 'unknown'], note: 'Springkraut am Bach' }),
    });
    const updated = await res.json();
    assert.deepEqual(updated.tags, ['neophyt']);
    assert.equal(updated.note, 'Springkraut am Bach');

    res = await fetch(`${base}/api/photos/${p.id}`, { method: 'DELETE' });
    assert.equal(res.status, 204);
    assert.deepEqual(await (await fetch(`${base}/api/spots`)).json(), []);
    assert.equal((await fetch(`${base}${p.url}`)).status, 404);
  });
});

test('plant identification flags neophytes and tags the photo', async () => {
  const fakeFetch = async (url, init) => {
    assert.match(url, /my-api\.plantnet\.org/);
    assert.ok(init.body instanceof FormData);
    return new Response(JSON.stringify({
      results: [
        { score: 0.82, species: { scientificNameWithoutAuthor: 'Impatiens glandulifera', commonNames: ['Indisches Springkraut'] } },
        { score: 0.05, species: { scientificNameWithoutAuthor: 'Impatiens noli-tangere', commonNames: [] } },
      ],
    }), { status: 200 });
  };
  await withServer({ plantnetKey: 'test', fetchImpl: fakeFetch }, async (base) => {
    const p = (await (await upload(base, [['gps.jpg', fixture('gps.jpg')]])).json()).created[0];
    const res = await fetch(`${base}/api/photos/${p.id}/identify`, { method: 'POST' });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.identifications[0].neophyte, 'Drüsiges Springkraut');
    assert.deepEqual(body.tags, ['neophyt']);
  });
});

test('plant identification reports when not configured', async () => {
  await withServer({ plantnetKey: '' }, async (base) => {
    const res = await fetch(`${base}/api/photos/1/identify`, { method: 'POST' });
    assert.equal(res.status, 501);
  });
});

test('repeat photos are pinned to the chosen spot', async () => {
  await withServer({}, async (base) => {
    const first = (await (await upload(base, [['gps.jpg', fixture('gps.jpg')]])).json()).created[0];

    // Device position ~30 m away (outside the 25 m radius) but plausible → kept, same spot.
    let res = await upload(base, [['nogps.jpg', fixture('nogps.jpg')]],
      { spotId: String(first.spotId), lat: '47.37527', lon: '8.5375' });
    assert.equal(res.status, 201);
    let p = (await res.json()).created[0];
    assert.equal(p.spotId, first.spotId);
    assert.equal(p.locationSource, 'spot');
    assert.equal(p.lat, 47.37527);

    // Implausible position → spot centre instead.
    const spot = await (await fetch(`${base}/api/spots/${first.spotId}`)).json();
    res = await upload(base, [['nogps.jpg', fixture('nogps.jpg')]], { spotId: String(first.spotId), lat: '48', lon: '9' });
    p = (await res.json()).created[0];
    assert.equal(p.spotId, first.spotId);
    assert.deepEqual([p.lat, p.lon], [spot.lat, spot.lon]);

    res = await upload(base, [['nogps.jpg', fixture('nogps.jpg')]], { spotId: '999' });
    assert.equal(res.status, 400);
    assert.equal((await (await fetch(`${base}/api/spots`)).json()).length, 1);
  });
});

test('photos of a spot are aligned into a common frame', async () => {
  const blob = (name) => new Blob([fs.readFileSync(path.join(__dirname, 'fixtures', name))], { type: 'image/jpeg' });
  await withServer({}, async (base) => {
    const at = { lat: '47.1', lon: '8.1' };
    const a = (await (await upload(base, [['a.jpg', blob('align-a.jpg')]], at)).json()).created[0];
    assert.deepEqual(a.alignment.h, [1, 0, 0, 0, 1, 0, 0, 0, 1]);

    const b = (await (await upload(base, [['b.jpg', blob('align-b.jpg')]],
      { spotId: String(a.spotId), refPhotoId: String(a.id) })).json()).created[0];
    assert.ok(b.alignment && b.alignment.inliers >= 20);
    // B's top-left corner lands where the generator put it in A (−18 px, 12 px).
    const h = b.alignment.h;
    assert.ok(Math.abs((h[2] / h[8]) * 640 + 18) < 2 && Math.abs((h[5] / h[8]) * 480 - 12) < 2);

    const other = (await (await upload(base, [['o.jpg', blob('align-other.jpg')]],
      { spotId: String(a.spotId) })).json()).created[0];
    assert.equal(other.alignment, null);

    const res = await fetch(`${base}/api/spots/${a.spotId}/align`, { method: 'POST' });
    const spot = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(spot.photos.map((p) => Boolean(p.alignment)), [true, true, false]);
  });
});

test('change between aligned photos is reported with a heatmap', async () => {
  const blob = (name) => new Blob([fs.readFileSync(path.join(__dirname, 'fixtures', name))], { type: 'image/jpeg' });
  await withServer({}, async (base) => {
    const a = (await (await upload(base, [['a.jpg', blob('align-a.jpg')]], { lat: '47.1', lon: '8.1' })).json()).created[0];
    const b = (await (await upload(base, [['b.jpg', blob('align-b.jpg')]],
      { spotId: String(a.spotId), refPhotoId: String(a.id) })).json()).created[0];

    let res = await fetch(`${base}/api/photos/${a.id}/change?to=${b.id}`);
    assert.equal(res.status, 200);
    const change = await res.json();
    // The fixture adds a fallen trunk and a shrub (~8 % of the frame) and darkens everything.
    assert.ok(change.changedFraction > 0.04 && change.changedFraction < 0.2, `changed ${change.changedFraction}`);

    res = await fetch(`${base}${change.heatmap}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(Buffer.from(await res.arrayBuffer()).subarray(1, 4).toString(), 'PNG');

    const same = await (await fetch(`${base}/api/photos/${a.id}/change?to=${a.id}`)).json();
    assert.equal(same.changedFraction, 0);

    const other = (await (await upload(base, [['o.jpg', blob('align-other.jpg')]], { spotId: String(a.spotId) })).json()).created[0];
    assert.equal((await fetch(`${base}/api/photos/${a.id}/change?to=${other.id}`)).status, 422);
    assert.equal((await fetch(`${base}/api/photos/${a.id}/change`)).status, 400);
  });
});

test('changes are classified and early colouring in a drought is recorded as an irregularity', async () => {
  const blob = (name) => new Blob([fs.readFileSync(path.join(__dirname, 'fixtures', name))], { type: 'image/jpeg' });
  const DAY = 86400000;
  // Open-Meteo stand-in: normal 3 mm/day and 15 °C; from June 2026 no rain and 4 °C warmer.
  const dryFrom = Date.UTC(2026, 5, 1);
  const weatherFetch = async (url) => {
    const q = new URL(url).searchParams;
    const time = [];
    for (let t = Date.parse(`${q.get('start_date')}T00:00:00Z`); t <= Date.parse(`${q.get('end_date')}T00:00:00Z`); t += DAY) {
      time.push(new Date(t).toISOString().slice(0, 10));
    }
    const dry = (d) => Date.parse(`${d}T00:00:00Z`) >= dryFrom;
    return new Response(JSON.stringify({ daily: {
      time,
      precipitation_sum: time.map((d) => (dry(d) ? 0 : 3)),
      temperature_2m_mean: time.map((d) => (dry(d) ? 19 : 15)),
      temperature_2m_max: time.map((d) => (dry(d) ? 31 : 21)),
    } }));
  };
  await withServer({ weatherFetch }, async (base) => {
    const a = (await (await upload(base, [['a.jpg', blob('canopy-a.jpg')]],
      { lat: '47.36', lon: '8.58', takenAt: '2026-05-20T09:00:00Z' })).json()).created[0];
    const b = (await (await upload(base, [['b.jpg', blob('canopy-b.jpg')]],
      { spotId: String(a.spotId), refPhotoId: String(a.id), takenAt: '2026-08-12T09:00:00Z' })).json()).created[0];

    assert.ok(b.alignment, 'canopy photos align');
    const classes = b.change.summary.map((x) => x.class).sort();
    assert.deepEqual(classes, ['auflichtung', 'verfaerbung']);

    const ctx = await (await fetch(`${base}/api/photos/${b.id}/context`)).json();
    assert.ok(ctx.weather.last90.precipRatio < 0.3);
    const types = ctx.irregularities.map((i) => i.type);
    assert.ok(types.includes('trockenheit') && types.includes('fruehe_verfaerbung'), types.join(','));
    assert.match(ctx.irregularities.find((i) => i.type === 'fruehe_verfaerbung').text, /Trockenstress/);

    const spots = await (await fetch(`${base}/api/spots`)).json();
    assert.ok(spots[0].change.fraction > 0.2);
    assert.ok(spots[0].irregularities.includes('Frühe Laubverfärbung'));

    const change = await (await fetch(`${base}/api/photos/${a.id}/change?to=${b.id}`)).json();
    assert.equal(change.regions[0].bbox.length, 4);
  });
});

test('weather outages are recorded without failing the upload', async () => {
  await withServer({}, async (base) => {
    const p = (await (await upload(base, [['gps.jpg', fixture('gps.jpg')]])).json()).created[0];
    const ctx = await (await fetch(`${base}/api/photos/${p.id}/context`)).json();
    assert.equal(ctx.weather, null);
    assert.match(ctx.weatherError, /503/);
  });
});

test('tree species are recorded per spot, manually or from plant identification', async () => {
  const plantnet = async () => new Response(JSON.stringify({ results: [
    { score: 0.71, species: { scientificNameWithoutAuthor: 'Picea abies', commonNames: ['Gemeine Fichte'] } },
    { score: 0.12, species: { scientificNameWithoutAuthor: 'Abies alba', commonNames: [] } },
  ] }));
  await withServer({ plantnetKey: 'test', fetchImpl: plantnet }, async (base) => {
    const p = (await (await upload(base, [['gps.jpg', fixture('gps.jpg')]])).json()).created[0];
    const trees = await (await fetch(`${base}/api/trees`)).json();
    assert.ok(trees.some((t) => t.name === 'Rotbuche' && t.group === 'laub'));

    let res = await fetch(`${base}/api/spots/${p.spotId}/species`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scientificName: 'Fagus sylvatica' }),
    });
    assert.equal(res.status, 201);
    res = await fetch(`${base}/api/spots/${p.spotId}/species`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scientificName: 'Bellis perennis' }),
    });
    assert.equal(res.status, 400);

    const identified = await (await fetch(`${base}/api/photos/${p.id}/identify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ organ: 'bark' }),
    })).json();
    assert.equal(identified.identifications[0].tree.name, 'Fichte');

    let spot = await (await fetch(`${base}/api/spots/${p.spotId}`)).json();
    assert.deepEqual(spot.species.map((s) => [s.name, s.sources.join()]), [['Rotbuche', 'manual'], ['Fichte', 'plantnet']]);
    const spots = await (await fetch(`${base}/api/spots`)).json();
    assert.deepEqual(spots[0].species, ['Rotbuche', 'Fichte']);

    await fetch(`${base}/api/spots/${p.spotId}/species?name=${encodeURIComponent('Fagus sylvatica')}`, { method: 'DELETE' });
    spot = await (await fetch(`${base}/api/spots/${p.spotId}`)).json();
    assert.deepEqual(spot.species.map((s) => s.name), ['Fichte']);
  });
});

test('spot elevation comes from the terrain model, GPS altitude or by hand', async () => {
  const blob = (name) => new Blob([fs.readFileSync(path.join(__dirname, 'fixtures', name))], { type: 'image/jpeg' });
  const calls = [];
  const dem = async (url) => {
    calls.push(url);
    if (url.includes('/v1/elevation')) return new Response(JSON.stringify({ elevation: [1012.4] }));
    return new Response('offline', { status: 503 });
  };
  await withServer({ weatherFetch: dem }, async (base) => {
    const p = (await (await upload(base, [['gps.jpg', fixture('gps.jpg')]])).json()).created[0];
    await fetch(`${base}/api/photos/${p.id}/context`);
    let spot = await (await fetch(`${base}/api/spots/${p.spotId}`)).json();
    assert.deepEqual([spot.elevation, spot.elevationSource, spot.colourShiftDays], [1012, 'dem', -15]);
    assert.ok(calls.some((u) => u.includes('latitude=47.3750')));

    await fetch(`${base}/api/spots/${p.spotId}/species`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scientificName: 'Fagus sylvatica' }),
    });
    spot = await (await fetch(`${base}/api/spots/${p.spotId}`)).json();
    assert.equal(spot.species[0].colourDoy - spot.species[0].colourDoyHere, 15);

    let res = await fetch(`${base}/api/spots/${p.spotId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ elevation: 640 }),
    });
    spot = await res.json();
    assert.deepEqual([spot.elevation, spot.elevationSource], [640, 'manual']);
    res = await fetch(`${base}/api/spots/${p.spotId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ elevation: 'hoch' }),
    });
    assert.equal(res.status, 400);
  });

  // Without the terrain service the photos' GPS altitude is used.
  await withServer({}, async (base) => {
    const p = (await (await upload(base, [['alt.jpg', blob('gps-alt.jpg')]])).json()).created[0];
    await fetch(`${base}/api/photos/${p.id}/context`);
    const spot = await (await fetch(`${base}/api/spots/${p.spotId}`)).json();
    assert.deepEqual([spot.elevation, spot.elevationSource], [949, 'gps']);
  });
});

test('slope and aspect come from the terrain model and can be set by hand', async () => {
  // DEM grid around the spot: rises to the north → south-facing, ~12° steep.
  const grid = [1040, 1040, 1040, 1020, 1020, 1020, 1000, 1000, 1000];
  const dem = async (url) => {
    if (url.includes('/v1/elevation')) {
      const n = new URL(url).searchParams.get('latitude').split(',').length;
      // 3×3 grid plus two rings of 8 at the centre's height: an even slope, TPI 0.
      return new Response(JSON.stringify({ elevation: n === 25 ? [...grid, ...Array(16).fill(1020)] : [1020] }));
    }
    return new Response('offline', { status: 503 });
  };
  await withServer({ weatherFetch: dem }, async (base) => {
    const p = (await (await upload(base, [['gps.jpg', fixture('gps.jpg')]])).json()).created[0];
    await fetch(`${base}/api/photos/${p.id}/context`);
    let spot = await (await fetch(`${base}/api/spots/${p.spotId}`)).json();
    assert.equal(spot.elevation, 1020);
    assert.equal(spot.aspect, 180);
    assert.equal(spot.exposition, 'Südhang');
    assert.equal(spot.terrainSource, 'dem');
    // 1020 m: −15.5 → −15 days; 12.5° south slope: +2.5 → +3 days (Math.round rounds halves up).
    assert.deepEqual(spot.colourShift, { altitude: -15, exposition: 3, coldPool: 0 });
    assert.equal(spot.colourShiftDays, -12);
    assert.deepEqual([spot.landform, spot.tpi600], ['hang', 0]);

    const patch = (body) => fetch(`${base}/api/spots/${p.spotId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    spot = await (await patch({ exposition: 'N' })).json();
    assert.deepEqual([spot.exposition, spot.terrainSource, spot.colourShift.exposition, spot.elevation], ['Nordhang', 'manual', -4, 1020]);
    spot = await (await patch({ exposition: 'eben' })).json();
    assert.deepEqual([spot.exposition, spot.colourShift.exposition], ['eben', 0]);
    assert.equal((await patch({ exposition: 'Süd' })).status, 400);
    spot = await (await patch({ exposition: null })).json();
    assert.deepEqual([spot.exposition, spot.terrainSource], ['Südhang', 'dem']);
  });
});

test('hollows are recognised as cold-air pools and can be set by hand', async () => {
  // Flat centre at 600 m, surroundings 25 m (300 m ring) and 45 m (600 m ring) higher: a hollow.
  const dem = async (url) => {
    if (url.includes('/v1/elevation')) {
      return new Response(JSON.stringify({ elevation: [...Array(9).fill(600), ...Array(8).fill(625), ...Array(8).fill(645)] }));
    }
    return new Response('offline', { status: 503 });
  };
  await withServer({ weatherFetch: dem }, async (base) => {
    const p = (await (await upload(base, [['gps.jpg', fixture('gps.jpg')]])).json()).created[0];
    await fetch(`${base}/api/photos/${p.id}/context`);
    let spot = await (await fetch(`${base}/api/spots/${p.spotId}`)).json();
    assert.deepEqual([spot.landform, spot.tpi300, spot.tpi600, spot.landformSource], ['senke', -25, -45, 'dem']);
    assert.equal(spot.landformLabel, 'Senke / Talboden (Kaltluftsee)');
    assert.equal(spot.colourShift.coldPool, -5);

    const patch = (body) => fetch(`${base}/api/spots/${p.spotId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    spot = await (await patch({ landform: 'kuppe' })).json();
    assert.deepEqual([spot.landform, spot.landformSource, spot.colourShift.coldPool], ['kuppe', 'manual', 0]);
    assert.equal((await patch({ landform: 'tal' })).status, 400);
    spot = await (await patch({ landform: null })).json();
    assert.deepEqual([spot.landform, spot.landformSource], ['senke', 'dem']);
  });
});
