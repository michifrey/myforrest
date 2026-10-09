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
 * The CRC is not checked (damaged files end where the records stop making sense).
 *
 * Sensor data of the records is summed up for the tour: heart rate (3),
 * cadence (4, doubled to steps per minute for runs), power (7) and
 * temperature (13). Developer fields — values that apps and add-on sensors
 * (e.g. a Stryd foot pod, a CORE body temperature sensor) put into the file —
 * are described by "field_description" messages (206: name, units, base
 * type, scale, offset, and the standard field they stand for, if any); one
 * that stands for a standard field fills in where the watch has none (e.g.
 * running power from the foot pod), the others are listed under their name.
 *
 * parseFit(buffer) → { name, points: [{ lat, lon, ele?, time? }], sensors: [{ key, label, unit, avg, min, max, n }] }
 */

const FIT_EPOCH = Date.UTC(1989, 11, 31); // ms
const SEMI = 180 / 2 ** 31;
const RECORD = 20;
const SESSION = 18;
const FIELD_DESCRIPTION = 206;
const RUNNING = 1;
// Standard record fields summed up for the tour: field number → key.
const STANDARD = { 3: 'hr', 4: 'cadence', 7: 'power', 13: 'temp' };
const LABELS = {
  hr: ['Puls', '/min'], cadence: ['Trittfrequenz', '/min'], steps: ['Schrittfrequenz', '/min'], power: ['Leistung', 'W'], temp: ['Temperatur', '°C'],
};

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
      case 0x07: { // string, zero-terminated
        const raw = buf.subarray(off, off + size);
        const z = raw.indexOf(0);
        return raw.subarray(0, z < 0 ? raw.length : z).toString('utf8');
      }
      case 0x88: return size === 4 ? (little ? buf.readFloatLE(off) : buf.readFloatBE(off)) : null;
      default: return null; // 64-bit: not needed here
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
  const devDescs = new Map(); // "devIndex:field" → { name, units, type, scale, offset, native }
  const stats = new Map(); // key → { label, unit, sum, min, max, n }
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
      const dev = [];
      if (hasDev) {
        const nd = buf[off++];
        for (let i = 0; i < nd; i++) {
          dev.push({ num: buf[off], size: buf[off + 1], index: buf[off + 2], at: size });
          size += buf[off + 1];
          off += 3;
        }
      }
      defs.set(local, { global, little, fields, dev, size });
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
    const dev = [];
    for (const f of def.dev) {
      const d = devDescs.get(`${f.index}:${f.num}`);
      if (!d || at + f.at + f.size > buf.length) continue;
      const v = readValue(buf, at + f.at, f.size, d.type, def.little);
      if (typeof v !== 'number' || !Number.isFinite(v) || v === INVALID[d.type & 0x9f]) continue;
      dev.push({ d, value: v / (d.scale || 1) - (d.offset || 0) });
    }
    return { fields, dev };
  }

  function add(key, label, unit, value) {
    if (!Number.isFinite(value)) return;
    let s = stats.get(key);
    if (!s) stats.set(key, (s = { label, unit, sum: 0, min: Infinity, max: -Infinity, n: 0 }));
    s.sum += value; s.n += 1;
    s.min = Math.min(s.min, value); s.max = Math.max(s.max, value);
  }

  function collect(def, msg) {
    const f = msg.fields;
    if (def.global === SESSION && f[5] !== null && f[5] !== undefined) sport = f[5];
    if (def.global === FIELD_DESCRIPTION && f[0] !== null && f[1] !== null && f[2] !== null) {
      devDescs.set(`${f[0]}:${f[1]}`, {
        name: typeof f[3] === 'string' && f[3].trim() ? f[3].trim().slice(0, 40) : `Feld ${f[1]}`,
        units: typeof f[8] === 'string' ? f[8].trim().slice(0, 12) : '',
        type: f[2], scale: f[6] || 1, offset: f[7] || 0, native: f[14] ?? null,
      });
    }
    if (def.global === RECORD) {
      const own = new Set();
      for (const [num, key] of Object.entries(STANDARD)) {
        const v = f[num];
        if (v === null || v === undefined || ((key === 'hr' || key === 'cadence') && v === 0)) continue;
        own.add(Number(num));
        add(key, null, null, v);
      }
      for (const { d, value } of msg.dev) {
        // Stands for a standard field: fills in where the watch has none.
        if (d.native !== null && STANDARD[d.native]) {
          if (!own.has(d.native)) add(STANDARD[d.native], null, null, value);
        } else add(`dev:${d.name}`, d.name, d.units, value);
      }
    }
    if (def.global !== RECORD || f[0] === null || f[1] === null || f[0] === undefined || f[1] === undefined) return;
    const p = { lat: f[0] * SEMI, lon: f[1] * SEMI };
    if (Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180 || (p.lat === 0 && p.lon === 0)) return;
    const ele = f[78] ?? f[2];
    if (ele !== null && ele !== undefined) p.ele = Math.round((ele / 5 - 500) * 10) / 10;
    if (f[253] !== null && f[253] !== undefined) p.time = FIT_EPOCH + f[253] * 1000;
    points.push(p);
  }

  const SPORTS = { 1: 'Lauf', 2: 'Velofahrt', 11: 'Spaziergang', 17: 'Wanderung' };
  return { name: SPORTS[sport] || null, points, sensors: summarize(stats, sport) };
}

/** Sums of the sensor fields → [{ key, label, unit, avg, min, max, n }], standard fields first. */
function summarize(stats, sport) {
  const out = [];
  const round = (v) => Math.round(v * 10) / 10;
  for (const [key, s] of stats) {
    // Watches store running cadence per leg (strides); people count steps.
    const k = key === 'cadence' && sport === RUNNING ? 'steps' : key;
    const x = k === 'steps' ? 2 : 1;
    const [label, unit] = LABELS[k] || [s.label, s.unit];
    out.push({ key: k, label, unit, avg: round((s.sum / s.n) * x), min: round(s.min * x), max: round(s.max * x), n: s.n });
  }
  const ORDER = ['hr', 'power', 'cadence', 'steps', 'temp'];
  const order = (e) => (ORDER.includes(e.key) ? ORDER.indexOf(e.key) : ORDER.length);
  return out.sort((a, b) => order(a) - order(b)).slice(0, 20);
}

/**
 * Writes a minimal FIT file with record messages (for tests): points [{ lat, lon, ele?, time, hr?, power?,
 * cadence?, temp?, dev?: { name: value } }]; `developer` describes the developer fields
 * [{ name, units, native? }] (uint16, scale 1), `sport` adds a session message.
 */
function writeFit(points, { compressAfter = Infinity, developer = [], sport = null } = {}) {
  const parts = [];
  const sensors = [[3, 1, 0x02, 'hr'], [4, 1, 0x02, 'cadence'], [7, 2, 0x84, 'power'], [13, 1, 0x01, 'temp']]
    .filter(([, , , k]) => points.some((p) => p[k] !== undefined));
  const fieldDef = (num, size, type) => [num, size, type];
  const defMsg = (local, global, fields, dev = []) => Buffer.from([
    0x40 | (dev.length ? 0x20 : 0) | local, 0, 0, global & 0xff, global >> 8, fields.length, ...fields.flat(),
    ...(dev.length ? [dev.length, ...dev.flat()] : []),
  ]);
  const name = (s, n) => { const b = Buffer.alloc(n); b.write(s.slice(0, n - 1), 'utf8'); return b; };
  // Developer field descriptions (local 2): dev index, field number, base type, name, units, native field.
  if (developer.length) {
    parts.push(defMsg(2, FIELD_DESCRIPTION, [fieldDef(0, 1, 0x02), fieldDef(1, 1, 0x02), fieldDef(2, 1, 0x02), fieldDef(3, 32, 0x07), fieldDef(8, 16, 0x07), fieldDef(14, 1, 0x02)]));
    developer.forEach((d, i) => parts.push(Buffer.concat([Buffer.from([2, 0, i, 0x84]), name(d.name, 32), name(d.units || '', 16), Buffer.from([d.native ?? 0xff])])));
  }
  const dev = developer.map((d, i) => [i, 2, 0]);
  const extra = sensors.map(([num, size, type]) => fieldDef(num, size, type));
  // Local 0 = record (timestamp, lat, lon, altitude, sensors), little endian; local 1 the same without timestamp.
  parts.push(defMsg(0, RECORD, [[253, 4, 0x86], [0, 4, 0x85], [1, 4, 0x85], [2, 2, 0x84], ...extra], dev));
  parts.push(defMsg(1, RECORD, [[0, 4, 0x85], [1, 4, 0x85], [2, 2, 0x84], ...extra], dev));
  const sensorBytes = (p) => Buffer.concat([
    ...sensors.map(([, size, type, k]) => {
      const b = Buffer.alloc(size);
      const v = p[k];
      if (size === 1) b[0] = v === undefined ? 0xff : type === 0x01 ? v & 0xff : v;
      else b.writeUInt16LE(v === undefined ? 0xffff : v);
      return b;
    }),
    ...developer.map((d) => { const b = Buffer.alloc(2); b.writeUInt16LE(p.dev?.[d.name] ?? 0xffff); return b; }),
  ]);
  points.forEach((p, i) => {
    const ts = Math.round((p.time - FIT_EPOCH) / 1000);
    const lat = Math.round(p.lat / SEMI);
    const lon = Math.round(p.lon / SEMI);
    const alt = p.ele === undefined ? 0xffff : Math.round((p.ele + 500) * 5);
    const pos = Buffer.alloc(10);
    pos.writeInt32LE(lat, 0); pos.writeInt32LE(lon, 4); pos.writeUInt16LE(alt, 8);
    if (i >= compressAfter) {
      parts.push(Buffer.from([0x80 | (1 << 5) | (ts & 0x1f)]), pos, sensorBytes(p));
    } else {
      const t = Buffer.alloc(5);
      t.writeUInt32LE(ts, 1);
      parts.push(t, pos, sensorBytes(p));
    }
  });
  if (sport !== null) parts.push(defMsg(3, SESSION, [[5, 1, 0x00]]), Buffer.from([3, sport]));
  const data = Buffer.concat(parts);
  const header = Buffer.alloc(14);
  header[0] = 14; header[1] = 0x20; header.writeUInt16LE(2132, 2); header.writeUInt32LE(data.length, 4);
  header.write('.FIT', 8, 'latin1');
  return Buffer.concat([header, data, Buffer.alloc(2)]);
}

module.exports = { parseFit, writeFit, isFit };
