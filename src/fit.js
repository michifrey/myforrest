'use strict';

/**
 * Reads tracks from FIT files (Garmin, Wahoo, Polar, Coros, Suunto … — the
 * binary format of sports watches and bike computers), without dependencies.
 *
 * A FIT file is a 12/14-byte header, then records: definition messages say
 * which fields (number, size, base type) a local message type carries and in
 * which byte order; data messages follow them. Only "record" messages
 * (global number 20) matter here: timestamp (253, s since 1989-12-31 UTC),
 * position_lat/long (0/1, semicircles), altitude (2, or enhanced_altitude 78:
 * value / 5 − 500 m). Compressed-timestamp headers carry a 5-bit time offset.
 * Developer fields are skipped. The CRC is not checked (damaged files end
 * where the records stop making sense).
 *
 * parseFit(buffer) → { name, points: [{ lat, lon, ele?, time? }] }
 */

const FIT_EPOCH = Date.UTC(1989, 11, 31); // ms
const SEMI = 180 / 2 ** 31;
const RECORD = 20;
const SESSION = 18;

const INVALID = {
  1: 0xff, 2: 0xff, 0x83: 0x7fff, 0x84: 0xffff, 0x85: 0x7fffffff, 0x86: 0xffffffff, 0x8c: 0xffffffff, 0x8b: 0xffff,
};

function readValue(buf, off, size, baseType, little) {
  const bt = baseType & 0x9f;
  try {
    switch (bt) {
      case 0x00: case 0x02: case 0x0a: case 0x0d: return size === 1 ? buf.readUInt8(off) : null; // enum, uint8, uint8z, byte
      case 0x01: return size === 1 ? buf.readInt8(off) : null;
      case 0x83: return size === 2 ? (little ? buf.readInt16LE(off) : buf.readInt16BE(off)) : null;
      case 0x84: case 0x8b: return size === 2 ? (little ? buf.readUInt16LE(off) : buf.readUInt16BE(off)) : null;
      case 0x85: return size === 4 ? (little ? buf.readInt32LE(off) : buf.readInt32BE(off)) : null;
      case 0x86: case 0x8c: return size === 4 ? (little ? buf.readUInt32LE(off) : buf.readUInt32BE(off)) : null;
      default: return null; // strings, floats, 64-bit: not needed here
    }
  } catch {
    return null;
  }
}

const isFit = (buf) => buf.length >= 12 && buf.toString('latin1', 8, 12) === '.FIT';

function parseFit(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (!isFit(buf)) throw new Error('Keine FIT-Datei');
  const headerSize = buf[0];
  const dataSize = buf.readUInt32LE(4);
  const end = Math.min(buf.length, headerSize + dataSize);
  const defs = new Map();
  const points = [];
  let sport = null;
  let lastTimestamp = null; // s since FIT epoch, for compressed headers
  let off = headerSize;

  while (off < end) {
    const header = buf[off++];
    if (header & 0x80) {
      // Compressed timestamp header: local type in bits 5–6, time offset in bits 0–4.
      const local = (header >> 5) & 0x03;
      const def = defs.get(local);
      if (!def) break;
      const msg = readMessage(def, off);
      off += def.size;
      if (lastTimestamp !== null) {
        const offset = header & 0x1f;
        let t = (lastTimestamp & ~0x1f) + offset;
        if (offset < (lastTimestamp & 0x1f)) t += 0x20;
        lastTimestamp = t;
        msg.fields[253] = t;
      }
      collect(def, msg);
      continue;
    }
    const local = header & 0x0f;
    if (header & 0x40) {
      // Definition message.
      const hasDev = Boolean(header & 0x20);
      const little = buf[off + 1] === 0;
      const global = little ? buf.readUInt16LE(off + 2) : buf.readUInt16BE(off + 2);
      const n = buf[off + 4];
      off += 5;
      const fields = [];
      let size = 0;
      for (let i = 0; i < n; i++) {
        fields.push({ num: buf[off], size: buf[off + 1], type: buf[off + 2], at: size });
        size += buf[off + 1];
        off += 3;
      }
      let devSize = 0;
      if (hasDev) {
        const nd = buf[off++];
        for (let i = 0; i < nd; i++) { devSize += buf[off + 1]; off += 3; }
      }
      defs.set(local, { global, little, fields, size: size + devSize });
      continue;
    }
    const def = defs.get(local);
    if (!def) break; // data without a definition: damaged
    const msg = readMessage(def, off);
    off += def.size;
    if (msg.fields[253] !== undefined && msg.fields[253] !== null) lastTimestamp = msg.fields[253];
    collect(def, msg);
  }

  function readMessage(def, at) {
    const fields = {};
    for (const f of def.fields) {
      if (at + f.at + f.size > buf.length) break;
      const v = readValue(buf, at + f.at, f.size, f.type, def.little);
      fields[f.num] = v === null || v === INVALID[f.type & 0x9f] || (f.type === 0x8c && v === 0) ? null : v;
    }
    return { fields };
  }

  function collect(def, msg) {
    const f = msg.fields;
    if (def.global === SESSION && f[5] !== null && f[5] !== undefined) sport = f[5];
    if (def.global !== RECORD || f[0] === null || f[1] === null || f[0] === undefined || f[1] === undefined) return;
    const p = { lat: f[0] * SEMI, lon: f[1] * SEMI };
    if (Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180 || (p.lat === 0 && p.lon === 0)) return;
    const ele = f[78] ?? f[2];
    if (ele !== null && ele !== undefined) p.ele = Math.round((ele / 5 - 500) * 10) / 10;
    if (f[253] !== null && f[253] !== undefined) p.time = FIT_EPOCH + f[253] * 1000;
    points.push(p);
  }

  const SPORTS = { 1: 'Lauf', 2: 'Velofahrt', 11: 'Spaziergang', 17: 'Wanderung' };
  return { name: SPORTS[sport] || null, points };
}

/** Writes a minimal FIT file with record messages (for tests): points [{ lat, lon, ele?, time }]. */
function writeFit(points, { compressAfter = Infinity } = {}) {
  const parts = [];
  // Definition: local 0 = record (timestamp uint32, lat sint32, lon sint32, altitude uint16), little endian.
  const def = Buffer.from([0x40, 0, 0, RECORD, 0, 4, 253, 4, 0x86, 0, 4, 0x85, 1, 4, 0x85, 2, 2, 0x84]);
  parts.push(def);
  // Local 1: the same without timestamp, for compressed headers.
  parts.push(Buffer.from([0x41, 0, 0, RECORD, 0, 3, 0, 4, 0x85, 1, 4, 0x85, 2, 2, 0x84]));
  points.forEach((p, i) => {
    const ts = Math.round((p.time - FIT_EPOCH) / 1000);
    const lat = Math.round(p.lat / SEMI);
    const lon = Math.round(p.lon / SEMI);
    const alt = p.ele === undefined ? 0xffff : Math.round((p.ele + 500) * 5);
    if (i >= compressAfter) {
      const b = Buffer.alloc(11);
      b[0] = 0x80 | (1 << 5) | (ts & 0x1f);
      b.writeInt32LE(lat, 1); b.writeInt32LE(lon, 5); b.writeUInt16LE(alt, 9);
      parts.push(b);
    } else {
      const b = Buffer.alloc(15);
      b[0] = 0x00;
      b.writeUInt32LE(ts, 1); b.writeInt32LE(lat, 5); b.writeInt32LE(lon, 9); b.writeUInt16LE(alt, 13);
      parts.push(b);
    }
  });
  const data = Buffer.concat(parts);
  const header = Buffer.alloc(14);
  header[0] = 14; header[1] = 0x20; header.writeUInt16LE(2132, 2); header.writeUInt32LE(data.length, 4);
  header.write('.FIT', 8, 'latin1');
  return Buffer.concat([header, data, Buffer.alloc(2)]);
}

module.exports = { parseFit, writeFit, isFit };
