'use strict';

/**
 * HEIC/HEIF support (iPhone photos). sharp's prebuilt binaries cannot decode
 * HEVC-coded images, so uploads are converted to JPEG with the pure
 * JavaScript/WebAssembly decoder of `heic-convert`. The EXIF block is read
 * from the original file beforehand, since the converted JPEG carries none.
 */

const HEVC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs']);

/** Brands of the `ftyp` box (major brand first), or [] when there is none. */
function brands(buffer) {
  if (buffer.length < 16 || buffer.toString('latin1', 4, 8) !== 'ftyp') return [];
  const size = buffer.readUInt32BE(0);
  if (size < 16 || size > Math.min(buffer.length, 512)) return [];
  const out = [buffer.toString('latin1', 8, 12)];
  for (let o = 16; o + 4 <= size; o += 4) out.push(buffer.toString('latin1', o, o + 4));
  return out;
}

/** True for HEIC/HEIF stills (not AVIF, which uses the same container). */
function isHeic(buffer) {
  const b = brands(buffer);
  if (b.some((x) => HEVC_BRANDS.has(x))) return true;
  return (b.includes('mif1') || b.includes('msf1')) && !b.includes('avif') && !b.includes('avis');
}

/* ---------- Minimal ISO-BMFF reader for the EXIF item ---------- */

function* boxes(buf, start, end) {
  let o = start;
  while (o + 8 <= end) {
    let size = buf.readUInt32BE(o);
    const type = buf.toString('latin1', o + 4, o + 8);
    let header = 8;
    if (size === 1) {
      if (o + 16 > end) return;
      size = Number(buf.readBigUInt64BE(o + 8));
      header = 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (size < header || o + size > end) return;
    yield { type, start: o + header, end: o + size };
    o += size;
  }
}

const find = (buf, start, end, type) => {
  for (const b of boxes(buf, start, end)) if (b.type === type) return b;
  return null;
};

function readUint(buf, o, n) {
  if (n === 0) return 0;
  if (n === 2) return buf.readUInt16BE(o);
  if (n === 4) return buf.readUInt32BE(o);
  if (n === 8) return Number(buf.readBigUInt64BE(o));
  throw new Error(`Ungültige Feldgrösse ${n}`);
}

/**
 * Extracts the TIFF/EXIF block of a HEIC file, or null. Unlike exifr's own
 * HEIC reader this honours the `iloc` base offset and `idat` storage, which
 * libheif-written files use.
 */
function heicExif(buf) {
  try {
    const meta = find(buf, 0, buf.length, 'meta');
    if (!meta) return null;
    const mStart = meta.start + 4; // full box: version + flags
    const iinf = find(buf, mStart, meta.end, 'iinf');
    const iloc = find(buf, mStart, meta.end, 'iloc');
    if (!iinf || !iloc) return null;

    // Item id of the 'Exif' item.
    let o = iinf.start;
    const iinfVersion = buf[o];
    o += 4;
    o += iinfVersion === 0 ? 2 : 4;
    let exifId = null;
    for (const infe of boxes(buf, o, iinf.end)) {
      if (infe.type !== 'infe') continue;
      const v = buf[infe.start];
      if (v < 2) continue;
      const idSize = v === 3 ? 4 : 2;
      const id = readUint(buf, infe.start + 4, idSize);
      if (buf.toString('latin1', infe.start + 4 + idSize + 2, infe.start + 4 + idSize + 6) === 'Exif') {
        exifId = id;
        break;
      }
    }
    if (exifId === null) return null;

    // Its location.
    o = iloc.start;
    const v = buf[o];
    o += 4;
    const offsetSize = buf[o] >> 4;
    const lengthSize = buf[o] & 15;
    const baseSize = buf[o + 1] >> 4;
    const indexSize = v === 1 || v === 2 ? buf[o + 1] & 15 : 0;
    o += 2;
    const count = readUint(buf, o, v < 2 ? 2 : 4);
    o += v < 2 ? 2 : 4;
    for (let i = 0; i < count; i++) {
      const id = readUint(buf, o, v < 2 ? 2 : 4);
      o += v < 2 ? 2 : 4;
      let method = 0;
      if (v === 1 || v === 2) {
        method = buf.readUInt16BE(o) & 15;
        o += 2;
      }
      o += 2; // data reference index
      const base = readUint(buf, o, baseSize);
      o += baseSize;
      const extents = buf.readUInt16BE(o);
      o += 2;
      const parts = [];
      for (let e = 0; e < extents; e++) {
        o += indexSize;
        const off = readUint(buf, o, offsetSize);
        o += offsetSize;
        const len = readUint(buf, o, lengthSize);
        o += lengthSize;
        parts.push([off, len]);
      }
      if (id !== exifId) continue;
      let source = buf;
      let origin = 0;
      if (method === 1) {
        const idat = find(buf, mStart, meta.end, 'idat');
        if (!idat) return null;
        source = buf.subarray(idat.start, idat.end);
      } else if (method !== 0) {
        return null;
      }
      origin += base;
      const data = Buffer.concat(parts.map(([off, len]) =>
        source.subarray(origin + off, len ? origin + off + len : source.length)));
      // Exif item: 4-byte offset to the TIFF header (usually skipping "Exif\0\0").
      const tiff = data.subarray(4 + data.readUInt32BE(0));
      const magic = tiff.toString('latin1', 0, 2);
      return magic === 'II' || magic === 'MM' ? tiff : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Decodes the primary image of a HEIC file into a JPEG buffer. */
async function heicToJpeg(buffer, { quality = 0.92, convert = require('heic-convert') } = {}) {
  const out = await convert({ buffer, format: 'JPEG', quality });
  return Buffer.from(out);
}

module.exports = { isHeic, heicExif, heicToJpeg };
