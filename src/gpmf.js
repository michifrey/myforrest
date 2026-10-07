'use strict';

/**
 * Minimal parser for GoPro's GPMF telemetry (the "GoPro MET" / gpmd track of
 * an MP4). GPMF is a KLV format:
 *
 *   4 bytes key (FourCC) · 1 byte type · 1 byte struct size · 2 bytes repeat (BE)
 *   then size × repeat bytes of big-endian data, padded to a multiple of 4.
 *
 * Type 0 marks a nested container (DEVC → STRM → …). Only what is needed for
 * positions is interpreted: GPS5 / GPS9 with SCAL, GPSU, GPSF, GPSP and TYPE.
 * Reference: https://github.com/gopro/gpmf-parser (format description).
 */

const TYPE_SIZE = {
  b: 1, B: 1, c: 1, s: 2, S: 2, l: 4, L: 4, f: 4, d: 8, j: 8, J: 8, q: 4, Q: 8, F: 4, G: 16, U: 16,
};

/** Parses a GPMF buffer into a tree of { key, type, size, repeat, data | children }. */
function parseKlv(buf, start = 0, end = buf.length) {
  const out = [];
  let pos = start;
  while (pos + 8 <= end) {
    const key = buf.toString('latin1', pos, pos + 4);
    const typeByte = buf[pos + 4];
    const size = buf[pos + 5];
    const repeat = buf.readUInt16BE(pos + 6);
    const len = size * repeat;
    const dataStart = pos + 8;
    const dataEnd = dataStart + len;
    if (dataEnd > end) break; // truncated payload: keep what was readable
    if (key === '\0\0\0\0') break; // padding at the end of a payload
    const node = { key, type: typeByte === 0 ? null : String.fromCharCode(typeByte), size, repeat };
    if (typeByte === 0) node.children = parseKlv(buf, dataStart, dataEnd);
    else node.data = buf.subarray(dataStart, dataEnd);
    out.push(node);
    pos = dataStart + Math.ceil(len / 4) * 4;
  }
  return out;
}

function readScalar(buf, off, type) {
  switch (type) {
    case 'b': return buf.readInt8(off);
    case 'B': return buf.readUInt8(off);
    case 'c': return buf.readUInt8(off);
    case 's': return buf.readInt16BE(off);
    case 'S': return buf.readUInt16BE(off);
    case 'l': return buf.readInt32BE(off);
    case 'L': return buf.readUInt32BE(off);
    case 'f': return buf.readFloatBE(off);
    case 'd': return buf.readDoubleBE(off);
    case 'j': return Number(buf.readBigInt64BE(off));
    case 'J': return Number(buf.readBigUInt64BE(off));
    case 'q': return buf.readInt32BE(off) / 65536;
    case 'Q': return Number(buf.readBigInt64BE(off)) / 2 ** 32;
    default: throw new Error(`GPMF-Typ ${type} nicht unterstützt`);
  }
}

/**
 * Decodes a leaf node into an array of samples; each sample is an array of
 * numbers. `structType` is the TYPE string for complex ('?') nodes.
 */
function values(node, structType = null) {
  const types = node.type === '?' ? structType : null;
  if (node.type === '?' && !types) return [];
  const sampleTypes = types ? [...types] : null;
  const out = [];
  for (let r = 0; r < node.repeat; r++) {
    const base = r * node.size;
    const sample = [];
    if (sampleTypes) {
      let off = base;
      for (const t of sampleTypes) {
        sample.push(readScalar(node.data, off, t));
        off += TYPE_SIZE[t];
      }
    } else {
      const w = TYPE_SIZE[node.type];
      for (let off = base; off + w <= base + node.size; off += w) sample.push(readScalar(node.data, off, node.type));
    }
    out.push(sample);
  }
  return out;
}

const asString = (node) => node.data.toString('latin1').replace(/\0+$/, '');

/** "yymmddhhmmss.sss" (GPSU) → ms since epoch (UTC), or null. */
function parseGpsu(text) {
  const m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2}(?:\.\d+)?)/.exec(text);
  if (!m) return null;
  const sec = Number(m[6]);
  const t = Date.UTC(2000 + Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0) + Math.round(sec * 1000);
  return Number.isFinite(t) ? t : null;
}

const GPS9_EPOCH = Date.UTC(2000, 0, 1);
const MAX_DOP = 5; // GPSP is DOP × 100; GoPro calls < 500 a good fix

/**
 * Extracts GPS samples from one GPMF payload. `t0`/`duration` (seconds) place
 * the payload on the video timeline; samples are spread evenly across it.
 * Returns [{ t, time, lat, lon, alt, speed, fix }], `time` being the UTC time
 * from the receiver (ms) when known.
 */
function gpsFromPayload(buf, t0 = 0, duration = 1) {
  const points = [];
  const streams = [];
  const collect = (nodes) => {
    for (const n of nodes) {
      if (n.key === 'STRM' && n.children) streams.push(n.children);
      else if (n.children) collect(n.children);
    }
  };
  collect(parseKlv(buf));

  // Newer cameras write GPS9 next to GPS5; GPS9 (with per-sample time) wins.
  const hasGps9 = streams.some((nodes) => nodes.some((n) => n.key === 'GPS9'));
  for (const nodes of streams) {
    if (hasGps9 && !nodes.some((n) => n.key === 'GPS9')) continue;
    const gps9 = nodes.find((n) => n.key === 'GPS9');
    const gps5 = nodes.find((n) => n.key === 'GPS5');
    const data = gps9 || gps5;
    if (!data) continue;
    // Sticky metadata precedes the data; take the last value before it.
    const before = nodes.slice(0, nodes.indexOf(data));
    const last = (key) => before.filter((n) => n.key === key).pop();
    const typeNode = last('TYPE');
    const scalNode = last('SCAL');
    const scal = scalNode ? values(scalNode).map((s) => s[0]) : [1];
    const gpsuNode = last('GPSU');
    const gpsu = gpsuNode ? parseGpsu(asString(gpsuNode)) : null;
    const fixNode = last('GPSF');
    const streamFix = fixNode ? values(fixNode)[0][0] : null;
    const precNode = last('GPSP');
    const streamDop = precNode ? values(precNode)[0][0] / 100 : null;

    const samples = values(data, typeNode ? asString(typeNode) : null);
    const n = samples.length;
    samples.forEach((raw, k) => {
      const v = raw.map((x, i) => x / (scal.length > 1 ? scal[i] : scal[0]) || 0);
      const t = t0 + (duration * k) / n;
      const p = { t, lat: v[0], lon: v[1], alt: v[2], speed: v[3], time: null, fix: streamFix, dop: streamDop };
      if (data.key === 'GPS9') {
        // lat, lon, alt, speed2d, speed3d, days since 2000, seconds since midnight, DOP, fix
        p.time = Math.round(GPS9_EPOCH + raw[5] / (scal[5] || 1) * 86400000 + (raw[6] / (scal[6] || 1)) * 1000);
        p.dop = v[7];
        p.fix = v[8];
      } else if (gpsu !== null) {
        p.time = gpsu + Math.round((t - t0) * 1000);
      }
      points.push(p);
    });
  }
  return points;
}

const goodFix = (p) =>
  (p.fix === null || p.fix >= 2) &&
  (p.dop === null || p.dop <= MAX_DOP) &&
  Number.isFinite(p.lat) && Number.isFinite(p.lon) &&
  Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180 &&
  !(p.lat === 0 && p.lon === 0);

/**
 * GPS track from all GPMF payloads of a video ([{ t, duration, data }]).
 * Returns { points, utcOffsetMs } where `points` holds only samples with a
 * usable fix, and `utcOffsetMs` maps video time to UTC (time = t·1000 + offset),
 * the median over all samples with a receiver time (null without).
 */
function gpsTrack(payloads) {
  const all = [];
  for (const p of payloads) {
    try {
      all.push(...gpsFromPayload(p.data, p.t, p.duration));
    } catch {
      // A damaged payload must not spoil the rest of the track.
    }
  }
  const points = all.filter(goodFix).sort((a, b) => a.t - b.t);
  const offsets = points.filter((p) => p.time !== null).map((p) => p.time - p.t * 1000).sort((a, b) => a - b);
  const utcOffsetMs = offsets.length ? offsets[Math.floor(offsets.length / 2)] : null;
  return { points, utcOffsetMs };
}

/* ---------- Writing (used by tests to build synthetic telemetry) ---------- */

/** Encodes a KLV node: `{ key, type, size?, values }` or `{ key, children }`. */
function encodeKlv(node) {
  let data;
  let type = 0;
  let size;
  let repeat;
  if (node.children) {
    data = Buffer.concat(node.children.map(encodeKlv));
    size = 4;
    repeat = data.length / 4;
  } else if (typeof node.values === 'string') {
    type = node.type.charCodeAt(0);
    data = Buffer.from(node.values, 'latin1');
    size = node.size || data.length;
    repeat = data.length / size;
  } else {
    type = node.type.charCodeAt(0);
    const types = node.structType ? [...node.structType] : null;
    const rows = node.values.map((v) => [].concat(v));
    const parts = [];
    for (const row of rows) {
      row.forEach((x, i) => {
        const t = types ? types[i] : node.type;
        const b = Buffer.alloc(TYPE_SIZE[t]);
        if (t === 'l') b.writeInt32BE(x);
        else if (t === 'L') b.writeUInt32BE(x);
        else if (t === 's') b.writeInt16BE(x);
        else if (t === 'S') b.writeUInt16BE(x);
        else if (t === 'B' || t === 'c') b.writeUInt8(x);
        else if (t === 'b') b.writeInt8(x);
        else if (t === 'f') b.writeFloatBE(x);
        else if (t === 'd') b.writeDoubleBE(x);
        else throw new Error(`encode ${t}`);
        parts.push(b);
      });
    }
    data = Buffer.concat(parts);
    size = data.length / rows.length;
    repeat = rows.length;
  }
  const head = Buffer.alloc(8);
  head.write(node.key, 0, 'latin1');
  head[4] = type;
  head[5] = size;
  head.writeUInt16BE(repeat, 6);
  const pad = Buffer.alloc((4 - (data.length % 4)) % 4);
  return Buffer.concat([head, data, pad]);
}

module.exports = { parseKlv, values, parseGpsu, gpsFromPayload, gpsTrack, encodeKlv };
