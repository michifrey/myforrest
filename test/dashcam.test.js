'use strict';

// GPS of dashcam videos: NMEA text and Novatek freeGPS blocks (src/dashcam.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { parseNmea, parseFreeGps, dashcamTrack, nmeaDeg } = require('../src/dashcam');
const { parseTrackFile } = require('../src/trackfile');
const { parseGpx } = require('../src/gpx');
const { createApp } = require('../src/app');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const hasFfmpeg = spawnSync(FFMPEG, ['-version']).status === 0;

const withSum = (body) => {
  let x = 0;
  for (const c of body) x ^= c.charCodeAt(0);
  return `$${body}*${x.toString(16).toUpperCase().padStart(2, '0')}`;
};
const ddmm = (deg) => {
  const d = Math.floor(Math.abs(deg));
  return (d * 100 + (Math.abs(deg) - d) * 60).toFixed(4);
};
const hms = (ms) => new Date(ms).toISOString().slice(11, 19).replace(/:/g, '');
const dmy = (ms) => { const d = new Date(ms).toISOString(); return d.slice(8, 10) + d.slice(5, 7) + d.slice(2, 4); };

/** NMEA for a drive north at 15 m/s, one fix per second, as BlackVue writes it ([unix ms] before each line). */
function nmeaDrive({ start = Date.UTC(2026, 9, 9, 6, 30, 0), seconds = 30, lat = 47.36, lon = 8.58, prefix = true } = {}) {
  const lines = [];
  for (let s = 0; s < seconds; s++) {
    const t = start + s * 1000;
    const la = lat + (s * 15) / 111320;
    const pre = prefix ? `[${t}]` : '';
    lines.push(`${pre}${withSum(`GPRMC,${hms(t)}.00,A,${ddmm(la)},N,${ddmm(lon)},E,29.16,0.5,${dmy(t)},,,A`)}`);
    lines.push(`${pre}${withSum(`GPGGA,${hms(t)}.00,${ddmm(la)},N,${ddmm(lon)},E,1,09,0.9,${(540 + s / 10).toFixed(1)},M,48.0,M,,`)}`);
  }
  return lines.join('\r\n');
}

/** Novatek freeGPS blocks as written by many dashcams: one `free` box per second. */
function freeGpsBoxes({ start = Date.UTC(2026, 9, 9, 6, 30, 0), seconds = 30, lat = 47.36, lon = 8.58, fixAt = 1 } = {}) {
  const boxes = [];
  for (let s = 0; s < seconds; s++) {
    const t = new Date(start + s * 1000);
    const b = Buffer.alloc(0x100);
    b.writeUInt32BE(b.length, 0);
    b.write('free', 4, 'latin1');
    b.write('GPS ', 8, 'latin1');
    b.writeUInt32LE(0x4c, 12);
    // "freeGPS " here, the fields 32 bytes on (typical Novatek layout).
    b.write('freeGPS ', 0x10, 'latin1');
    const o = 0x18 + 0x10;
    [t.getUTCHours(), t.getUTCMinutes(), t.getUTCSeconds(), t.getUTCFullYear() - 2000, t.getUTCMonth() + 1, t.getUTCDate()]
      .forEach((v, k) => b.writeUInt32LE(v, o + k * 4));
    b.write(s < fixAt ? 'V' : 'A', o + 24, 'latin1');
    b.write('N', o + 25, 'latin1');
    b.write('E', o + 26, 'latin1');
    b.writeFloatLE(Number(ddmm(lat + (s * 15) / 111320)), o + 28);
    b.writeFloatLE(Number(ddmm(lon)), o + 32);
    b.writeFloatLE(29.16, o + 36);
    b.writeFloatLE(0.5, o + 40);
    boxes.push(b);
  }
  return Buffer.concat(boxes);
}

test('NMEA: positions, speed, course and altitude; bad checksums and no fix are left out', () => {
  assert.ok(Math.abs(nmeaDeg('4721.6000', 'N') - 47.36) < 1e-9);
  assert.ok(nmeaDeg('00835.0000', 'W') < 0);
  const text = `${nmeaDrive({ seconds: 5 })}\r\n${withSum('GPRMC,063010.00,V,,,,,,,091026,,,N')}\r\n$GPRMC,063011.00,A,4721.6000,N,00834.8000,E,0,0,091026,,,A*00`;
  const pts = parseNmea(text);
  assert.equal(pts.length, 5);
  assert.ok(Math.abs(pts[0].lat - 47.36) < 1e-6 && Math.abs(pts[0].lon - 8.58) < 1e-6);
  assert.equal(pts[0].time, Date.UTC(2026, 9, 9, 6, 30, 0));
  assert.ok(Math.abs(pts[0].speed - 15) < 0.01, `speed ${pts[0].speed}`);
  assert.equal(pts[0].course, 0.5);
  assert.equal(pts[4].ele, 540.4);
  // As a sidecar file: for photos/videos (GPX field) and as a tour.
  assert.equal(parseGpx(nmeaDrive({ prefix: false })).length, 30);
  const tour = parseTrackFile(nmeaDrive({ seconds: 10 }), 'FILE0042.NMEA');
  assert.deepEqual([tour.format, tour.points.length, tour.hasTime], ['nmea', 10, true]);
});

test('Novatek freeGPS blocks: time and position, no fix skipped', () => {
  const pts = parseFreeGps(freeGpsBoxes({ seconds: 10, fixAt: 2 }));
  assert.equal(pts.length, 8);
  assert.equal(pts[0].time, Date.UTC(2026, 9, 9, 6, 30, 2));
  assert.ok(Math.abs(pts[0].lat - (47.36 + 30 / 111320)) < 2e-5, pts[0].lat);
  assert.ok(Math.abs(pts[0].lon - 8.58) < 2e-5);
  assert.ok(Math.abs(pts[0].speed - 15) < 0.01);
  // Junk around it does not produce points.
  assert.equal(parseFreeGps(Buffer.concat([Buffer.from('freeGPS '), Buffer.alloc(200, 0x41)])).length, 0);
});

test('a whole file is scanned in chunks, also across chunk borders', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-dash-'));
  try {
    const file = path.join(dir, 'blackvue.mp4');
    fs.writeFileSync(file, Buffer.concat([Buffer.alloc(5000, 7), Buffer.from(nmeaDrive()), Buffer.alloc(3000, 9)]));
    const r = await dashcamTrack(file, { chunkBytes: 1500 });
    assert.deepEqual([r.kind, r.points.length], ['nmea', 30]);
    const nv = path.join(dir, 'viofo.mp4');
    fs.writeFileSync(nv, Buffer.concat([Buffer.alloc(777), freeGpsBoxes()]));
    const r2 = await dashcamTrack(nv, { chunkBytes: 1000 });
    assert.deepEqual([r2.kind, r2.points.length], ['novatek', 29]);
    fs.writeFileSync(file, Buffer.alloc(1000));
    assert.deepEqual((await dashcamTrack(file)).points, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A test video with the GPS of a dashcam in a box after the movie data. */
function dashcamVideo(dir, name, gps) {
  const file = path.join(dir, name);
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=5:duration=30',
    '-c:v', 'mpeg4', '-q:v', '5', file]);
  assert.equal(r.status, 0, String(r.stderr));
  const head = Buffer.alloc(8);
  head.writeUInt32BE(gps.length + 8, 0);
  head.write('gps ', 4, 'latin1');
  fs.appendFileSync(file, Buffer.concat([head, gps]));
  return file;
}

test('dashcam video: GPS from the file, pictures along the road, marked as a drive', { skip: !hasFfmpeg && 'ffmpeg fehlt' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-dash-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-dash-data-'));
  const offline = async () => new Response('offline', { status: 503 });
  const app = createApp({ dataDir, weatherFetch: offline, fetchImpl: offline, routerUrl: '' });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (file) => {
    const fd = new FormData();
    fd.append('video', new Blob([fs.readFileSync(file)], { type: 'video/mp4' }), path.basename(file));
    fd.append('frameDistanceM', '100');
    const res = await fetch(`${base}/api/videos`, { method: 'POST', body: fd });
    return [res.status, await res.json()];
  };
  try {
    // 30 s at 15 m/s = 435 m: a picture every 100 m.
    const [status, body] = await post(dashcamVideo(dir, '20261009_063000_NF.mp4', Buffer.from(nmeaDrive())));
    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(body.video.track, 'nmea');
    assert.equal(body.created.length, 5);
    const first = body.created[0];
    assert.equal(first.activity, 'fahren');
    assert.equal(first.locationSource, 'exif');
    assert.equal(first.takenAt, '2026-10-09T06:30:00.000Z');
    assert.ok(first.heading < 1 || first.heading > 359, `heading ${first.heading}`);
    assert.ok(Math.abs(body.created[1].lat - (47.36 + 100 / 111320)) < 3 / 111320);
    // Novatek blocks: same road, same spots.
    const [s2, nv] = await post(dashcamVideo(dir, 'VIOFO_0001.MP4', freeGpsBoxes({ start: Date.UTC(2026, 9, 10, 6, 30, 0) })));
    assert.equal(s2, 201, JSON.stringify(nv));
    assert.equal(nv.video.track, 'novatek');
    assert.ok(nv.created.filter((p) => body.created.some((q) => q.spotId === p.spotId)).length >= 4);
  } finally {
    await app.locals.idle();
    server.close();
    app.locals.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
