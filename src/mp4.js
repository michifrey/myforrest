'use strict';

const fsp = require('node:fs/promises');

/**
 * Just enough of an ISO-BMFF (MP4/MOV) reader to find the GoPro telemetry
 * track ('gpmd' sample entry) and its samples, the recording start time and
 * duration, and whether the video declares itself spherical (360°). Only the
 * moov box is read into memory; sample data is read from the file as needed,
 * so multi-gigabyte videos are fine.
 */

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta', 'dinf']);
const MAC_EPOCH_OFFSET_S = 2082844800; // 1904-01-01 → 1970-01-01

/** Iterates the boxes in buf[start, end): yields { type, start, headerSize, end }. */
function* boxes(buf, start = 0, end = buf.length) {
  let pos = start;
  while (pos + 8 <= end) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    let headerSize = 8;
    if (size === 1) {
      if (pos + 16 > end) return;
      size = Number(buf.readBigUInt64BE(pos + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < headerSize || pos + size > end) return;
    yield { type, start: pos, headerSize, end: pos + size };
    pos += size;
  }
}

const child = (buf, box, type) => {
  for (const b of boxes(buf, box.start + box.headerSize, box.end)) if (b.type === type) return b;
  return null;
};
const children = (buf, box, type) =>
  [...boxes(buf, box.start + box.headerSize, box.end)].filter((b) => b.type === type);
const path = (buf, box, ...types) => types.reduce((b, t) => (b ? child(buf, b, t) : null), box);
const body = (box) => box.start + box.headerSize;

/** Reads the top-level box headers of a file and returns the moov box contents. */
async function readMoov(fh) {
  const { size: fileSize } = await fh.stat();
  const head = Buffer.alloc(16);
  let pos = 0;
  let isMp4 = false;
  while (pos + 8 <= fileSize) {
    await fh.read(head, 0, 16, pos);
    let size = head.readUInt32BE(0);
    const type = head.toString('latin1', 4, 8);
    if (pos === 0 && !['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip'].includes(type)) break;
    isMp4 = true;
    let headerSize = 8;
    if (size === 1) {
      size = Number(head.readBigUInt64BE(8));
      headerSize = 16;
    } else if (size === 0) {
      size = fileSize - pos;
    }
    if (size < headerSize) break;
    if (type === 'moov') {
      if (size > 256 * 1024 * 1024) throw new Error('moov-Box zu gross');
      const buf = Buffer.alloc(size);
      await fh.read(buf, 0, size, pos);
      return { buf, isMp4 };
    }
    pos += size;
  }
  return { buf: null, isMp4 };
}

function fullBoxTime(buf, box) {
  const p = body(box);
  const version = buf[p];
  if (version === 1) {
    return {
      created: Number(buf.readBigUInt64BE(p + 4)),
      timescale: buf.readUInt32BE(p + 20),
      duration: Number(buf.readBigUInt64BE(p + 24)),
    };
  }
  return { created: buf.readUInt32BE(p + 4), timescale: buf.readUInt32BE(p + 12), duration: buf.readUInt32BE(p + 16) };
}

/** Sample table of a trak: [{ offset, size, t, duration }] with times in seconds. */
function sampleTable(buf, trak) {
  const mdhd = path(buf, trak, 'mdia', 'mdhd');
  const stbl = path(buf, trak, 'mdia', 'minf', 'stbl');
  if (!mdhd || !stbl) return [];
  const { timescale } = fullBoxTime(buf, mdhd);

  const stsz = child(buf, stbl, 'stsz');
  const stsc = child(buf, stbl, 'stsc');
  const stts = child(buf, stbl, 'stts');
  const stco = child(buf, stbl, 'stco') || child(buf, stbl, 'co64');
  if (!stsz || !stsc || !stts || !stco) return [];

  let p = body(stsz) + 4;
  const fixedSize = buf.readUInt32BE(p);
  const count = buf.readUInt32BE(p + 4);
  const sizes = [];
  for (let i = 0; i < count; i++) sizes.push(fixedSize || buf.readUInt32BE(p + 8 + i * 4));

  p = body(stco) + 4;
  const nChunks = buf.readUInt32BE(p);
  const chunkOffsets = [];
  for (let i = 0; i < nChunks; i++) {
    chunkOffsets.push(stco.type === 'co64' ? Number(buf.readBigUInt64BE(p + 4 + i * 8)) : buf.readUInt32BE(p + 4 + i * 4));
  }

  p = body(stsc) + 4;
  const nStsc = buf.readUInt32BE(p);
  const runs = [];
  for (let i = 0; i < nStsc; i++) {
    runs.push({ first: buf.readUInt32BE(p + 4 + i * 12), perChunk: buf.readUInt32BE(p + 8 + i * 12) });
  }

  p = body(stts) + 4;
  const nStts = buf.readUInt32BE(p);
  const deltas = [];
  for (let i = 0; i < nStts && deltas.length < count; i++) {
    const n = buf.readUInt32BE(p + 4 + i * 8);
    const d = buf.readUInt32BE(p + 8 + i * 8);
    for (let k = 0; k < n && deltas.length < count; k++) deltas.push(d);
  }

  const samples = [];
  let sample = 0;
  let time = 0;
  for (let c = 0; c < nChunks && sample < count; c++) {
    const run = runs.filter((r) => r.first <= c + 1).pop();
    let offset = chunkOffsets[c];
    for (let k = 0; k < (run ? run.perChunk : 1) && sample < count; k++) {
      const d = deltas[sample] ?? deltas[deltas.length - 1] ?? 0;
      samples.push({ offset, size: sizes[sample], t: time / timescale, duration: d / timescale });
      offset += sizes[sample];
      time += d;
      sample++;
    }
  }
  return samples;
}

const sampleEntryType = (buf, trak) => {
  const stsd = path(buf, trak, 'mdia', 'minf', 'stbl', 'stsd');
  if (!stsd) return null;
  // Full box header (4) + entry count (4), then the first sample entry box.
  const p = body(stsd) + 8;
  return p + 8 <= stsd.end ? buf.toString('latin1', p + 4, p + 8) : null;
};
const handlerType = (buf, trak) => {
  const hdlr = path(buf, trak, 'mdia', 'hdlr');
  return hdlr ? buf.toString('latin1', body(hdlr) + 8, body(hdlr) + 12) : null;
};

/**
 * Inspects an MP4/MOV file. Returns { isMp4, createdAt (ms, from mvhd, or null),
 * duration (s), spherical, hasVideo, gpmf: [{ t, duration, data }] }.
 */
async function readMp4(file, { maxGpmfBytes = 64 * 1024 * 1024 } = {}) {
  const fh = await fsp.open(file, 'r');
  try {
    const { buf, isMp4 } = await readMoov(fh);
    const info = { isMp4, createdAt: null, duration: null, spherical: false, hasVideo: false, gpmf: [] };
    if (!buf) return info;
    const moov = { type: 'moov', start: 0, headerSize: 8, end: buf.length };
    const mvhd = child(buf, moov, 'mvhd');
    if (mvhd) {
      const { created, timescale, duration } = fullBoxTime(buf, mvhd);
      if (created > MAC_EPOCH_OFFSET_S) info.createdAt = (created - MAC_EPOCH_OFFSET_S) * 1000;
      if (timescale) info.duration = duration / timescale;
    }
    // Spherical video: the Spherical Video V2 'sv3d' box or the V1 XML in a uuid box.
    info.spherical = buf.includes('sv3d', 0, 'latin1') || /<GSpherical:Spherical>\s*true/i.test(buf.toString('latin1'));

    let total = 0;
    for (const trak of children(buf, moov, 'trak')) {
      if (handlerType(buf, trak) === 'vide') info.hasVideo = true;
      if (sampleEntryType(buf, trak) !== 'gpmd') continue;
      for (const s of sampleTable(buf, trak)) {
        if (!s.size || total + s.size > maxGpmfBytes) continue;
        const data = Buffer.alloc(s.size);
        await fh.read(data, 0, s.size, s.offset);
        info.gpmf.push({ t: s.t, duration: s.duration, data });
        total += s.size;
      }
      break;
    }
    return info;
  } finally {
    await fh.close();
  }
}

/* ---------- Writing (used by tests to add a synthetic GoPro track) ---------- */

function box(type, ...parts) {
  const payload = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, payload]);
}
const u32 = (...v) => {
  const b = Buffer.alloc(4 * v.length);
  v.forEach((x, i) => b.writeUInt32BE(x, i * 4));
  return b;
};
const fullBox = (type, ...parts) => box(type, u32(0), ...parts);

/**
 * Returns a copy of an MP4 (with its moov at the end, as ffmpeg writes it) that
 * carries an additional GoPro telemetry track with the given GPMF payloads,
 * one per `sampleDuration` seconds.
 */
function addGpmfTrack(mp4, payloads, { sampleDuration = 1, timescale = 1000 } = {}) {
  const top = [...boxes(mp4)];
  const moovBox = top.find((b) => b.type === 'moov');
  if (!moovBox || moovBox !== top[top.length - 1]) throw new Error('moov muss die letzte Box sein');
  const mvhd = child(mp4, moovBox, 'mvhd');
  const nextTrackId = mp4.readUInt32BE(mvhd.end - 4);

  const delta = Math.round(sampleDuration * timescale);
  const dur = delta * payloads.length;
  const stbl = (offsets) => box('stbl',
    fullBox('stsd', u32(1), box('gpmd', Buffer.alloc(6), Buffer.from([0, 1]))),
    fullBox('stts', u32(1, payloads.length, delta)),
    fullBox('stsc', u32(1, 1, 1, 1)),
    fullBox('stsz', u32(0, payloads.length, ...payloads.map((p) => p.length))),
    fullBox('stco', u32(payloads.length, ...offsets)));
  const trak = (offsets) => box('trak',
    fullBox('tkhd', u32(0, 0, nextTrackId, 0, dur), Buffer.alloc(60)),
    box('mdia',
      fullBox('mdhd', u32(0, 0, timescale, dur), Buffer.from([0x55, 0xc4, 0, 0])),
      fullBox('hdlr', u32(0), Buffer.from('meta'), Buffer.alloc(12), Buffer.from('GoPro MET\0')),
      box('minf', fullBox('gmhd'), stbl(offsets))));

  const moovBody = mp4.subarray(moovBox.start + moovBox.headerSize, moovBox.end);
  const size = trak(payloads.map(() => 0)).length;
  const mdatStart = moovBox.start + 8 + moovBody.length + size;
  const offsets = [];
  let pos = mdatStart + 8;
  for (const p of payloads) {
    offsets.push(pos);
    pos += p.length;
  }
  const moov = box('moov', moovBody, trak(offsets));
  // Bump next_track_ID in mvhd.
  const mvhdEnd = mvhd.end - moovBox.start;
  moov.writeUInt32BE(nextTrackId + 1, mvhdEnd - 4);
  return Buffer.concat([mp4.subarray(0, moovBox.start), moov, box('mdat', ...payloads)]);
}

module.exports = { readMp4, addGpmfTrack, boxes };
