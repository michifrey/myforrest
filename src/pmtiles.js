'use strict';

/**
 * PMTiles v3 writer: one file with all tiles of a WebMercatorQuad pyramid
 * that any static web server (or object storage) can host; clients read
 * single tiles with HTTP range requests (MapLibre with the pmtiles protocol,
 * GDAL ≥ 3.8, in QGIS as an OGR layer). Specification:
 * https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md
 *
 * Tiles come in already gzip-compressed (as the tile cache stores them).
 * Directories are gzip-compressed too; identical tiles are stored once.
 */

const zlib = require('node:zlib');
const crypto = require('node:crypto');

const HEADER_BYTES = 127;
const ROOT_MAX_BYTES = 16384 - HEADER_BYTES;
const COMPRESSION_GZIP = 2;
const TILE_TYPE_MVT = 1;

/** Tile id along the Hilbert curve of each zoom level, counted over all lower zooms first. */
function zxyToTileId(z, x, y) {
  let acc = 0;
  for (let i = 0; i < z; i++) acc += 4 ** i;
  const n = 2 ** z;
  let d = 0;
  let [tx, ty] = [x, y];
  for (let s = n / 2; s >= 1; s /= 2) {
    const rx = (tx & s) > 0 ? 1 : 0;
    const ry = (ty & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) { tx = s - 1 - tx; ty = s - 1 - ty; }
      [tx, ty] = [ty, tx];
    }
  }
  return acc + d;
}

function varints(values) {
  const bytes = [];
  for (let v of values) {
    while (v >= 0x80) { bytes.push((v % 0x80) | 0x80); v = Math.floor(v / 0x80); }
    bytes.push(v);
  }
  return Buffer.from(bytes);
}

/** A directory (entries sorted by tile id) in the spec's columnar varint form, gzip-compressed. */
function encodeDirectory(entries) {
  const values = [entries.length];
  let last = 0;
  for (const e of entries) { values.push(e.tileId - last); last = e.tileId; }
  for (const e of entries) values.push(e.runLength);
  for (const e of entries) values.push(e.length);
  entries.forEach((e, i) => {
    const prev = entries[i - 1];
    values.push(i > 0 && e.offset === prev.offset + prev.length ? 0 : e.offset + 1);
  });
  return zlib.gzipSync(varints(values));
}

/** Root directory, plus leaf directories when the root alone would exceed 16 KiB. */
function buildDirectories(entries, rootMaxBytes) {
  const root = encodeDirectory(entries);
  if (root.length <= rootMaxBytes) return { root, leaves: Buffer.alloc(0) };
  for (let leafSize = 64; ; leafSize *= 2) {
    const rootEntries = [];
    const leafParts = [];
    let offset = 0;
    for (let i = 0; i < entries.length; i += leafSize) {
      const leaf = encodeDirectory(entries.slice(i, i + leafSize));
      rootEntries.push({ tileId: entries[i].tileId, offset, length: leaf.length, runLength: 0 });
      leafParts.push(leaf);
      offset += leaf.length;
    }
    const rootDir = encodeDirectory(rootEntries);
    if (rootDir.length <= rootMaxBytes) return { root: rootDir, leaves: Buffer.concat(leafParts) };
  }
}

const e7 = (deg) => Math.round(deg * 1e7);

/**
 * tiles: [{ z, x, y, data }] with gzip-compressed MVT data.
 * meta: { minzoom, maxzoom, bounds: [w, s, e, n], center: [lon, lat, zoom], metadata: object (JSON metadata) }.
 * rootMaxBytes only for tests (leaf directories without hundreds of thousands of tiles).
 */
function writePmtiles(tiles, { minzoom, maxzoom, bounds, center, metadata }, { rootMaxBytes = ROOT_MAX_BYTES } = {}) {
  const sorted = tiles.map((t) => ({ ...t, tileId: zxyToTileId(t.z, t.x, t.y) })).sort((a, b) => a.tileId - b.tileId);
  const entries = [];
  const parts = [];
  const seen = new Map(); // content hash → { offset, length }
  let offset = 0;
  for (const t of sorted) {
    const hash = crypto.createHash('sha1').update(t.data).digest('hex');
    let loc = seen.get(hash);
    if (!loc) {
      loc = { offset, length: t.data.length };
      seen.set(hash, loc);
      parts.push(t.data);
      offset += t.data.length;
    }
    const last = entries[entries.length - 1];
    // Consecutive tile ids with identical content share one entry (run length).
    if (last && last.offset === loc.offset && last.tileId + last.runLength === t.tileId) last.runLength += 1;
    else entries.push({ tileId: t.tileId, offset: loc.offset, length: loc.length, runLength: 1 });
  }
  const tileData = Buffer.concat(parts);
  const { root, leaves } = buildDirectories(entries, rootMaxBytes);
  const meta = zlib.gzipSync(Buffer.from(JSON.stringify(metadata)));

  const header = Buffer.alloc(HEADER_BYTES);
  header.write('PMTiles', 0, 'ascii');
  header.writeUInt8(3, 7);
  let pos = HEADER_BYTES;
  const section = (at, length) => {
    header.writeBigUInt64LE(BigInt(pos), at);
    header.writeBigUInt64LE(BigInt(length), at + 8);
    pos += length;
  };
  section(8, root.length);
  section(24, meta.length);
  section(40, leaves.length);
  section(56, tileData.length);
  header.writeBigUInt64LE(BigInt(sorted.length), 72); // addressed tiles
  header.writeBigUInt64LE(BigInt(entries.length), 80); // tile entries
  header.writeBigUInt64LE(BigInt(seen.size), 88); // tile contents
  header.writeUInt8(1, 96); // clustered: tile data in tile id order
  header.writeUInt8(COMPRESSION_GZIP, 97); // directories and metadata
  header.writeUInt8(COMPRESSION_GZIP, 98); // tiles
  header.writeUInt8(TILE_TYPE_MVT, 99);
  header.writeUInt8(minzoom, 100);
  header.writeUInt8(maxzoom, 101);
  header.writeInt32LE(e7(bounds[0]), 102);
  header.writeInt32LE(e7(bounds[1]), 106);
  header.writeInt32LE(e7(bounds[2]), 110);
  header.writeInt32LE(e7(bounds[3]), 114);
  header.writeUInt8(center[2], 118);
  header.writeInt32LE(e7(center[0]), 119);
  header.writeInt32LE(e7(center[1]), 123);
  return Buffer.concat([header, root, meta, leaves, tileData]);
}

module.exports = { writePmtiles, zxyToTileId };
