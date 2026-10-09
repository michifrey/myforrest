'use strict';

/**
 * GPS of dashcam videos, read straight from the file (no GPX needed):
 *
 *   - NMEA sentences ($GPRMC/$GNRMC, altitude from $GPGGA) as text anywhere in
 *     the file. BlackVue and others store them in a box of the MP4 (often with
 *     a `[unix ms]` prefix per line); many cameras also write a `.nmea` file
 *     next to the video, which `parseNmea` reads as well.
 *   - Novatek "freeGPS" blocks (Viofo, Kenwood, many unbranded cameras): one
 *     `free` box per second holding time, fix, latitude and longitude as
 *     NMEA-style degrees·100 + minutes (float), speed in knots and course.
 *     The layout differs slightly between models; the block is searched for
 *     the fix/hemisphere letters ("A", "N"/"S", "E"/"W") with the date fields
 *     before and the floats after them, and every value is checked.
 *     Encrypted variants (some newer Viofo firmware) are not read.
 *
 * The file is scanned in chunks, so large videos need little memory.
 */

const fsp = require('node:fs/promises');

const KNOTS = 0.514444; // m/s

/** "4724.1234", "N" → 47.40205… (NMEA ddmm.mmmm) */
function nmeaDeg(value, hemi) {
  const v = Number(value);
  if (!Number.isFinite(v) || !value) return NaN;
  const deg = Math.floor(v / 100);
  const d = deg + (v - deg * 100) / 60;
  return hemi === 'S' || hemi === 'W' ? -d : d;
}

const checksumOk = (sentence) => {
  const m = sentence.match(/^\$([^*]*)\*([0-9A-Fa-f]{2})$/);
  if (!m) return !sentence.includes('*'); // without a checksum: accepted
  let x = 0;
  for (const c of m[1]) x ^= c.charCodeAt(0);
  return x === parseInt(m[2], 16);
};

/** UTC time from RMC fields hhmmss(.ss) and ddmmyy. */
function rmcTime(hms, dmy) {
  const t = /^(\d{2})(\d{2})(\d{2})(\.\d+)?$/.exec(hms || '');
  const d = /^(\d{2})(\d{2})(\d{2})$/.exec(dmy || '');
  if (!t || !d) return NaN;
  const ms = t[4] ? Math.round(Number(t[4]) * 1000) : 0;
  return Date.UTC(2000 + Number(d[3]), Number(d[2]) - 1, Number(d[1]), Number(t[1]), Number(t[2]), Number(t[3]), ms);
}

const valid = (p) => Number.isFinite(p.time) && Number.isFinite(p.lat) && Number.isFinite(p.lon)
  && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180 && !(p.lat === 0 && p.lon === 0);

/**
 * Points from NMEA text: [{ time, lat, lon, speed (m/s), course, ele? }],
 * sorted by time, one per second of fix ("A"). Altitude comes from GGA
 * sentences at the same time of day.
 */
function parseNmea(text) {
  const points = new Map();
  const altitude = new Map(); // hhmmss → m
  const re = /\$G[PNLAB](RMC|GGA),[^\r\n$]*/g;
  let m;
  while ((m = re.exec(text))) {
    const sentence = m[0].trim();
    if (!checksumOk(sentence)) continue;
    const f = sentence.replace(/\*[0-9A-Fa-f]{2}$/, '').split(',');
    if (m[1] === 'GGA') {
      if (Number(f[6]) > 0 && f[9] !== '') altitude.set(f[1].slice(0, 6), Number(f[9]));
      continue;
    }
    if (f[2] !== 'A') continue; // no fix
    const p = {
      time: rmcTime(f[1], f[9]),
      lat: nmeaDeg(f[3], f[4]),
      lon: nmeaDeg(f[5], f[6]),
      speed: f[7] !== '' ? Number(f[7]) * KNOTS : null,
      course: f[8] !== '' && Number.isFinite(Number(f[8])) ? Number(f[8]) : null,
      hms: f[1].slice(0, 6),
    };
    if (valid(p)) points.set(p.time, p);
  }
  return [...points.values()].sort((a, b) => a.time - b.time).map(({ hms, ...p }) => {
    const ele = altitude.get(hms);
    return Number.isFinite(ele) ? { ...p, ele } : p;
  });
}

/** One Novatek freeGPS block (the bytes after the magic) → point or null. */
function parseFreeGpsBlock(buf) {
  for (let i = 24; i + 20 <= buf.length && i < 160; i++) {
    const fix = buf[i];
    const ns = buf[i + 1];
    const ew = buf[i + 2];
    if ((fix !== 0x41 && fix !== 0x56) || (ns !== 0x4e && ns !== 0x53) || (ew !== 0x45 && ew !== 0x57)) continue;
    if (fix !== 0x41) return null; // "V": no fix
    for (const gap of [0, 4]) {
      const o = i - 24 - gap;
      if (o < 0) continue;
      const [h, mi, s, y, mo, d] = [0, 4, 8, 12, 16, 20].map((k) => buf.readUInt32LE(o + k));
      if (h > 23 || mi > 59 || s > 60 || mo < 1 || mo > 12 || d < 1 || d > 31) continue;
      const year = y < 100 ? 2000 + y : y;
      if (year < 2000 || year > 2100) continue;
      for (const at of [i + 3, i + 4]) {
        if (at + 16 > buf.length) continue;
        const lat = nmeaDeg(String(buf.readFloatLE(at)), String.fromCharCode(ns));
        const lon = nmeaDeg(String(buf.readFloatLE(at + 4)), String.fromCharCode(ew));
        const knots = buf.readFloatLE(at + 8);
        const course = buf.readFloatLE(at + 12);
        const p = {
          time: Date.UTC(year, mo - 1, d, h, mi, s),
          lat, lon,
          speed: Number.isFinite(knots) && knots >= 0 && knots < 500 ? knots * KNOTS : null,
          course: Number.isFinite(course) && course >= 0 && course <= 360 ? course : null,
        };
        if (valid(p)) return p;
      }
    }
    return null;
  }
  return null;
}

const MAGIC = Buffer.from('freeGPS ', 'latin1');

/**
 * Points of all freeGPS blocks in a buffer. The box type `free` followed by
 * `GPS ` already spells the magic, and some cameras repeat it inside the box:
 * one point per second.
 */
function parseFreeGps(buf) {
  const out = new Map();
  for (let at = buf.indexOf(MAGIC); at !== -1; at = buf.indexOf(MAGIC, at + MAGIC.length)) {
    const p = parseFreeGpsBlock(buf.subarray(at + MAGIC.length, at + MAGIC.length + 256));
    if (p && !out.has(p.time)) out.set(p.time, p);
  }
  return [...out.values()];
}

/**
 * The GPS track of a dashcam video file: { points, kind: 'nmea' | 'novatek' | null }.
 * Points as from parseNmea, sorted by time, without duplicates.
 */
async function dashcamTrack(file, { chunkBytes = 16 * 1024 * 1024 } = {}) {
  const fh = await fsp.open(file, 'r');
  const nmea = new Map();
  const novatek = new Map();
  try {
    const { size } = await fh.stat();
    const overlap = 4096; // a sentence or block cut at a chunk border is read whole in the next one
    const buf = Buffer.alloc(chunkBytes + overlap);
    for (let pos = 0; pos < size; pos += chunkBytes) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(chunkBytes + overlap, size - pos), pos);
      const chunk = buf.subarray(0, bytesRead);
      for (const p of parseFreeGps(chunk)) novatek.set(p.time, p);
      if (chunk.includes('$G')) for (const p of parseNmea(chunk.toString('latin1'))) nmea.set(p.time, p);
    }
  } finally {
    await fh.close();
  }
  const [kind, map] = novatek.size >= nmea.size ? ['novatek', novatek] : ['nmea', nmea];
  if (map.size < 2) return { points: [], kind: null };
  return { points: [...map.values()].sort((a, b) => a.time - b.time), kind };
}

/**
 * Video time for each point of a dashcam track: the cameras write one
 * position per second from the start of each file, so the first fix is t = 0.
 */
const toVideoPoints = (points) => points.map((p) => ({
  t: (p.time - points[0].time) / 1000, lat: p.lat, lon: p.lon, alt: p.ele ?? null, time: p.time,
}));

/** NMEA text (a .nmea/.log file) or GPX: timestamped points [{ lat, lon, time }]. */
const looksLikeNmea = (text) => /\$G[PNLAB]RMC,/.test(text);

module.exports = { parseNmea, parseFreeGps, parseFreeGpsBlock, dashcamTrack, toVideoPoints, looksLikeNmea, nmeaDeg };
