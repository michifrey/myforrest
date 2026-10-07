'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { encodeKlv, parseKlv, parseGpsu, gpsFromPayload, gpsTrack } = require('../src/gpmf');
const { readMp4, addGpmfTrack } = require('../src/mp4');
const { planByDistance, planByTime, bearing, isEquirectangular, createFfmpeg } = require('../src/video');
const { distanceM } = require('../src/geo');
const { createApp } = require('../src/app');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const hasFfmpeg = spawnSync(FFMPEG, ['-version']).status === 0;
const noWeather = async () => new Response('offline', { status: 503 });
const M_LAT = 1 / 111320; // degrees latitude per metre

/* ---------- Synthetic GoPro telemetry ---------- */

/** One GPMF payload (1 s) with `n` GPS5 samples moving north from `start`. */
function gps5Payload({ lat, lon, metresPerSample = 0.5, n = 10, gpsu = '240501083000.000', fix = 3, dop = 150 }) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push([Math.round((lat + i * metresPerSample * M_LAT) * 1e7), Math.round(lon * 1e7), 512345, 5000, 5010]);
  }
  return encodeKlv({
    key: 'DEVC',
    children: [
      { key: 'DVID', type: 'L', values: [[1]] },
      { key: 'DVNM', type: 'c', values: 'Camera' },
      {
        key: 'STRM',
        children: [
          { key: 'STMP', type: 'L', values: [[0]] },
          { key: 'STNM', type: 'c', values: 'GPS (Lat., Long., Alt., 2D speed, 3D speed)' },
          { key: 'UNIT', type: 'c', size: 3, values: 'degdegm\0\0m/sm/s' },
          { key: 'SCAL', type: 'l', values: [[10000000], [10000000], [1000], [1000], [100]] },
          { key: 'GPSF', type: 'L', values: [[fix]] },
          { key: 'GPSU', type: 'U', size: 16, values: gpsu },
          { key: 'GPSP', type: 'S', values: [[dop]] },
          { key: 'GPS5', type: 'l', values: rows },
        ],
      },
    ],
  });
}

/** `seconds` payloads walking north at `speed` m/s from 47.37 / 8.53, starting 2024-05-01 08:30:00Z. */
function walkNorth(seconds, speed = 5, startLat = 47.37) {
  const payloads = [];
  for (let s = 0; s < seconds; s++) {
    payloads.push(gps5Payload({
      lat: startLat + s * speed * M_LAT,
      lon: 8.53,
      metresPerSample: speed / 10,
      gpsu: `2405010830${String(s).padStart(2, '0')}.000`,
    }));
  }
  return payloads;
}

test('GPMF KLV: nested containers, padding and scaled GPS5 samples', () => {
  const buf = gps5Payload({ lat: 47.37, lon: 8.53 });
  assert.equal(buf.length % 4, 0);
  const tree = parseKlv(buf);
  assert.equal(tree[0].key, 'DEVC');
  assert.deepEqual(tree[0].children.map((n) => n.key), ['DVID', 'DVNM', 'STRM']);

  const pts = gpsFromPayload(buf, 10, 1);
  assert.equal(pts.length, 10);
  assert.ok(Math.abs(pts[0].lat - 47.37) < 1e-6);
  assert.ok(Math.abs(pts[0].lon - 8.53) < 1e-6);
  assert.equal(pts[0].alt, 512.345);
  assert.equal(pts[0].speed, 5);
  assert.equal(pts[0].fix, 3);
  assert.equal(pts[0].dop, 1.5);
  assert.equal(pts[0].t, 10);
  assert.ok(Math.abs(pts[5].t - 10.5) < 1e-9);
  assert.equal(pts[0].time, Date.parse('2024-05-01T08:30:00Z'));
  assert.equal(pts[5].time, Date.parse('2024-05-01T08:30:00.500Z'));
});

test('GPMF GPSU timestamps and GPS9 with per-sample time', () => {
  assert.equal(parseGpsu('240501083012.345'), Date.parse('2024-05-01T08:30:12.345Z'));
  assert.equal(parseGpsu('garbage'), null);

  const days = Math.floor((Date.parse('2024-05-01T00:00:00Z') - Date.UTC(2000, 0, 1)) / 86400000);
  const row = (i) => [473700000 + i, 85300000, 500000, 1000, 1000, days, 30600000 + i * 100, 120, 3];
  const buf = encodeKlv({
    key: 'DEVC',
    children: [{
      key: 'STRM',
      children: [
        // A GPS5 stream next to GPS9 (as on HERO11+) must be ignored.
        { key: 'GPS5', type: 'l', values: [[1, 2, 3, 4, 5]] },
      ],
    }, {
      key: 'STRM',
      children: [
        { key: 'SCAL', type: 'l', values: [[1e7], [1e7], [1000], [1000], [100], [1], [1000], [100], [1]] },
        { key: 'TYPE', type: 'c', values: 'lllllllSS' },
        { key: 'GPS9', type: '?', structType: 'lllllllSS', values: [row(0), row(1)] },
      ],
    }],
  });
  const pts = gpsFromPayload(buf, 0, 1);
  assert.equal(pts.length, 2);
  assert.ok(Math.abs(pts[0].lat - 47.37) < 1e-6);
  assert.equal(pts[0].time, Date.parse('2024-05-01T08:30:00Z'));
  assert.equal(pts[1].time, Date.parse('2024-05-01T08:30:00.100Z'));
  assert.equal(pts[0].dop, 1.2);
  assert.equal(pts[0].fix, 3);
});

test('GPS track drops samples without fix and finds the video→UTC offset', () => {
  const payloads = walkNorth(4).map((data, i) => ({ t: i, duration: 1, data }));
  payloads.push({ t: 4, duration: 1, data: gps5Payload({ lat: 47.5, lon: 8.5, fix: 0 }) });
  payloads.push({ t: 5, duration: 1, data: gps5Payload({ lat: 47.5, lon: 8.5, dop: 2500 }) });
  payloads.push({ t: 6, duration: 1, data: Buffer.from('broken payload!!') });
  const { points, utcOffsetMs } = gpsTrack(payloads);
  assert.equal(points.length, 40);
  assert.ok(points.every((p) => p.lat < 47.4));
  assert.equal(utcOffsetMs, Date.parse('2024-05-01T08:30:00Z'));
});

/* ---------- Frame planning ---------- */

const straightTrack = (metres, speed = 5) => {
  const pts = [];
  for (let t = 0; t <= metres / speed; t += 0.1) pts.push({ t, lat: 47.37 + t * speed * M_LAT, lon: 8.53 });
  return pts;
};

test('frames every N metres, each far enough apart for its own spot, heading from the track', () => {
  const frames = planByDistance(straightTrack(200), { everyM: 25, radiusM: 25 });
  assert.ok(frames.length >= 6 && frames.length <= 8, `got ${frames.length}`);
  for (let i = 1; i < frames.length; i++) {
    assert.ok(frames[i].t > frames[i - 1].t);
    assert.ok(distanceM(frames[i], frames[i - 1]) > 25);
    assert.ok(distanceM(frames[i], frames[i - 1]) < 30);
  }
  for (const f of frames) assert.ok(f.heading < 1 || f.heading > 359, `heading ${f.heading}`);
  assert.ok(Math.abs(bearing({ lat: 47, lon: 8 }, { lat: 47, lon: 8.01 }) - 90) < 0.1);
});

test('frames snap to existing spots the route passes', () => {
  const spot = { lat: 47.37 + 40 * M_LAT, lon: 8.53 + 10 / (111320 * Math.cos((47.37 * Math.PI) / 180)) };
  const frames = planByDistance(straightTrack(100), { everyM: 25, radiusM: 25, anchors: [spot] });
  const atSpot = frames.filter((f) => f.atSpot);
  assert.equal(atSpot.length, 1);
  // Taken at the closest approach: 10 m beside the spot.
  assert.ok(Math.abs(distanceM(atSpot[0], spot) - 10) < 1, `${distanceM(atSpot[0], spot)}`);
  for (const f of frames) if (!f.atSpot) assert.ok(distanceM(f, spot) > 25);
});

test('frames every N seconds without track; 2:1 means equirectangular', () => {
  assert.deepEqual(planByTime(25, { everyS: 10 }).map((f) => f.t), [0, 10, 20]);
  assert.equal(planByTime(0).length, 1);
  assert.ok(isEquirectangular(5760, 2880));
  assert.ok(!isEquirectangular(3840, 2160));
});

/* ---------- MP4 + ffmpeg ---------- */

function makeVideo(dir, name, { size = '320x240', seconds = 12, gpmf = null, extra = [] } = {}) {
  const file = path.join(dir, name);
  const r = spawnSync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=5:duration=${seconds}`,
    '-c:v', 'mpeg4', '-q:v', '5', ...extra, file,
  ]);
  assert.equal(r.status, 0, String(r.stderr));
  if (gpmf) fs.writeFileSync(file, addGpmfTrack(fs.readFileSync(file), gpmf));
  return file;
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-video-'));

test('MP4 reader finds the GoPro telemetry track', { skip: !hasFfmpeg && 'ffmpeg fehlt' }, async () => {
  const dir = tmp();
  try {
    const file = makeVideo(dir, 'gopro.mp4', { gpmf: walkNorth(12) });
    const info = await readMp4(file);
    assert.ok(info.isMp4);
    assert.ok(info.hasVideo);
    assert.ok(Math.abs(info.duration - 12) < 0.5, `duration ${info.duration}`);
    assert.equal(info.gpmf.length, 12);
    assert.equal(info.gpmf[3].t, 3);
    assert.equal(info.spherical, false);
    const { points } = gpsTrack(info.gpmf);
    assert.equal(points.length, 120);

    // ffmpeg still decodes the file with the extra track.
    const out = path.join(dir, 'frame.jpg');
    await createFfmpeg(FFMPEG).extractFrame(file, 5, out);
    assert.ok(fs.statSync(out).size > 1000);

    const plain = await readMp4(makeVideo(dir, 'plain.mp4', { seconds: 2 }));
    assert.equal(plain.gpmf.length, 0);
    const notMp4 = path.join(dir, 'x.txt');
    fs.writeFileSync(notMp4, 'hello world, not a video');
    assert.equal((await readMp4(notMp4)).isMp4, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function withServer(fn, opts = {}) {
  const dataDir = tmp();
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

const postVideo = (base, file, fields = {}, name = path.basename(file), gpx = null) => {
  const fd = new FormData();
  fd.append('video', new Blob([fs.readFileSync(file)], { type: 'video/mp4' }), name);
  if (gpx) fd.append('gpx', new Blob([gpx], { type: 'application/gpx+xml' }), 'track.gpx');
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fetch(`${base}/api/videos`, { method: 'POST', body: fd });
};

test('GoPro video with GPMF becomes photos along the route, one spot each', { skip: !hasFfmpeg && 'ffmpeg fehlt' }, async () => {
  const dir = tmp();
  try {
    const file = makeVideo(dir, 'GX010042.MP4', { gpmf: walkNorth(12) });
    await withServer(async (base) => {
      const cfg = await (await fetch(`${base}/api/videos/config`)).json();
      assert.equal(cfg.ffmpeg, true);
      assert.equal(cfg.frameDistanceM, 25);

      const res = await postVideo(base, file, { tags: 'sturmschaden', activity: 'joggen' });
      const body = await res.json();
      assert.equal(res.status, 201, JSON.stringify(body));
      assert.equal(body.video.track, 'gpmf');
      assert.equal(body.video.panorama, false);
      assert.equal(body.created.length, 3); // ~55 m walked: 0, ~27, ~54 m
      assert.equal(new Set(body.created.map((p) => p.spotId)).size, 3);
      assert.deepEqual(body.spots.length, 3);
      const first = body.created[0];
      assert.equal(first.locationSource, 'exif');
      assert.equal(first.panorama, false);
      assert.deepEqual(first.tags, ['sturmschaden']);
      assert.equal(first.activity, 'joggen');
      assert.ok(Math.abs(Date.parse(first.takenAt) - Date.parse('2024-05-01T08:30:00Z')) < 2000, first.takenAt);
      assert.ok(first.heading < 1 || first.heading > 359);
      assert.ok(first.videoTime < 1);
      assert.match(first.originalName, /^GX010042\.MP4 · 0:0\d$/);
      assert.ok(body.created[2].videoTime > 9);
      const img = await fetch(`${base}${first.url}`);
      assert.equal(img.status, 200);
      assert.equal(img.headers.get('content-type'), 'image/jpeg');

      // A second run along the same route feeds the same spots.
      const again = await (await postVideo(base, file, { async: '0' })).json();
      assert.deepEqual(again.created.map((p) => p.spotId).sort(), body.created.map((p) => p.spotId).sort());
      const spot = await (await fetch(`${base}/api/spots/${first.spotId}`)).json();
      assert.equal(spot.photos.length, 2);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('360° video (2:1) is marked as panorama; async upload reports progress', { skip: !hasFfmpeg && 'ffmpeg fehlt' }, async () => {
  const dir = tmp();
  try {
    const file = makeVideo(dir, 'max.mp4', { size: '400x200', gpmf: walkNorth(12) });
    await withServer(async (base) => {
      const res = await postVideo(base, file, { async: '1' });
      assert.equal(res.status, 202);
      let job = await res.json();
      assert.ok(job.id);
      for (let i = 0; i < 200 && !['fertig', 'fehler'].includes(job.status); i++) {
        await new Promise((r) => setTimeout(r, 100));
        job = await (await fetch(`${base}/api/videos/jobs/${job.id}`)).json();
      }
      assert.equal(job.status, 'fertig', job.error);
      assert.equal(job.done, job.total);
      assert.equal(job.result.video.panorama, true);
      assert.ok(job.result.created.every((p) => p.panorama));
      assert.equal((await fetch(`${base}/api/videos/jobs/nope`)).status, 404);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('video without GPMF is placed via GPX, or every N seconds at a chosen place', { skip: !hasFfmpeg && 'ffmpeg fehlt' }, async () => {
  const dir = tmp();
  try {
    const file = makeVideo(dir, 'cam.mp4', { seconds: 20, extra: ['-metadata', 'creation_time=2024-05-01T08:30:00Z'] });
    const gpx = `<gpx><trk><trkseg>
      <trkpt lat="47.37" lon="8.53"><time>2024-05-01T08:29:50Z</time></trkpt>
      <trkpt lat="${47.37 + 150 * M_LAT}" lon="8.53"><time>2024-05-01T08:30:30Z</time></trkpt>
    </trkseg></trk></gpx>`;
    await withServer(async (base) => {
      let res = await postVideo(base, file, {}, 'cam.mp4', gpx);
      let body = await res.json();
      assert.equal(res.status, 201, JSON.stringify(body));
      assert.equal(body.video.track, 'gpx');
      assert.ok(body.created.length >= 3, `got ${body.created.length}`);
      assert.ok(body.created.every((p) => p.locationSource === 'gpx'));
      assert.equal(body.created[0].takenAt, '2024-05-01T08:30:00.000Z');

      // Wrong day: outside the track.
      res = await postVideo(base, file, { takenAt: '2023-01-01T10:00:00Z' }, 'cam.mp4', gpx);
      assert.equal(res.status, 422);
      assert.match((await res.json()).error, /ausserhalb des GPX-Tracks/);

      // No GPS at all.
      res = await postVideo(base, file);
      assert.equal(res.status, 422);
      assert.match((await res.json()).error, /Kein GPS im Video/);

      // Fixed place: every N seconds.
      res = await postVideo(base, file, { lat: '46.9', lon: '7.4', frameIntervalS: '10' });
      body = await res.json();
      assert.equal(body.video.track, 'manual');
      assert.equal(body.video.frames, 2);
      assert.equal(body.created.length, 1); // same place → one spot per video
      assert.equal(body.created[0].locationSource, 'manual');
      assert.match(body.skipped[0].reason, /Gleicher Spot/);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('video upload errors: .insv, non-video, missing file, missing ffmpeg', { skip: !hasFfmpeg && 'ffmpeg fehlt' }, async () => {
  const dir = tmp();
  try {
    const file = makeVideo(dir, 'a.mp4', { seconds: 2 });
    await withServer(async (base) => {
      let res = await postVideo(base, file, {}, 'VID_20240501_083000_00_001.insv');
      assert.equal(res.status, 415);
      assert.match((await res.json()).error, /Insta360 Studio/);

      const txt = path.join(dir, 'notes.txt');
      fs.writeFileSync(txt, 'kein Video, nur Text '.repeat(10));
      res = await postVideo(base, txt, {}, 'notes.mp4');
      assert.equal(res.status, 415);

      res = await fetch(`${base}/api/videos`, { method: 'POST', body: new FormData() });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error, 'Kein Video übermittelt');
    });

    const saved = process.env.FFMPEG_PATH;
    process.env.FFMPEG_PATH = path.join(dir, 'gibt-es-nicht', 'ffmpeg');
    try {
      await withServer(async (base) => {
        const cfg = await (await fetch(`${base}/api/videos/config`)).json();
        assert.equal(cfg.ffmpeg, false);
        const res = await postVideo(base, file, { lat: '47', lon: '8' });
        assert.equal(res.status, 503);
        assert.match((await res.json()).error, /ffmpeg wurde nicht gefunden.*FFMPEG_PATH/);
      });
    } finally {
      if (saved === undefined) delete process.env.FFMPEG_PATH;
      else process.env.FFMPEG_PATH = saved;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
