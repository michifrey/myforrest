'use strict';

/**
 * Minimal GeoParquet writer (GeoParquet 1.1 on Apache Parquet), so the
 * collections can be published as cloud-native files without GDAL or Arrow:
 * one PLAIN-encoded data page per column and row group (GZIP or
 * uncompressed), the file metadata in Thrift compact protocol. Columns as in
 * the GeoPackage (TEXT → UTF-8 string, INTEGER → INT64, REAL → DOUBLE, all
 * nullable), the geometry as WKB in the column `geometry`, described by the
 * `geo` key of the file metadata. DuckDB, GDAL/QGIS, GeoPandas and
 * pyarrow read it.
 *
 * For large files read in parts (DuckDB, GDAL over HTTP): the rows are sorted
 * along a Hilbert curve, so neighbours share a row group, and every row has its
 * bounding box in the struct column `bbox` (xmin, ymin, xmax, ymax), named as
 * the `covering` of the geometry column. Its min/max statistics per row group
 * let a reader skip the groups outside a query box.
 */

const fs = require('node:fs');
const zlib = require('node:zlib');
const { wkb } = require('./gpkg');

/* ---------- Thrift compact protocol ---------- */

const T = { TRUE: 1, FALSE: 2, I32: 5, I64: 6, BINARY: 8, LIST: 9, STRUCT: 12 };

function varint(out, n) {
  let v = BigInt(n);
  while (v >= 0x80n) { out.push(Number(v & 0x7fn) | 0x80); v >>= 7n; }
  out.push(Number(v));
}
const zigzag = (n) => { const v = BigInt(n); return v >= 0n ? v << 1n : (-v << 1n) - 1n; };

/**
 * A struct as a list of [fieldId, type, value]; fields with undefined value
 * are left out. Values: numbers for I32/I64, strings or Buffers for BINARY,
 * booleans for TRUE, nested field lists for STRUCT, and for LIST
 * { type, items }.
 */
function struct(out, fields) {
  let last = 0;
  for (const [id, type, value] of fields) {
    if (value === undefined) continue;
    const t = type === T.TRUE ? (value ? T.TRUE : T.FALSE) : type;
    if (id > last && id - last <= 15) out.push(((id - last) << 4) | t);
    else { out.push(t); varint(out, zigzag(id)); }
    last = id;
    if (type !== T.TRUE) element(out, type, value);
  }
  out.push(0);
}

function element(out, type, value) {
  if (type === T.I32 || type === T.I64) varint(out, zigzag(value));
  else if (type === T.BINARY) {
    const b = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
    varint(out, b.length);
    for (const x of b) out.push(x);
  } else if (type === T.STRUCT) struct(out, value);
  else if (type === T.LIST) {
    const n = value.items.length;
    if (n < 15) out.push((n << 4) | value.type);
    else { out.push(0xf0 | value.type); varint(out, n); }
    for (const item of value.items) element(out, value.type, item);
  } else throw new Error(`Thrift-Typ ${type}`);
}

const thrift = (fields) => { const out = []; struct(out, fields); return Buffer.from(out); };

/* ---------- Parquet ---------- */

const TYPE = { INT64: 2, DOUBLE: 5, BYTE_ARRAY: 6 };
const ENCODING = { PLAIN: 0, RLE: 3 };
const CODEC = { none: 0, gzip: 2 };
const COLUMN_TYPE = { TEXT: TYPE.BYTE_ARRAY, INTEGER: TYPE.INT64, REAL: TYPE.DOUBLE };

/** Definition levels (bit width 1) as RLE runs of the hybrid encoding, with the 4-byte length of data page v1. */
function definitionLevels(defined) {
  const out = [];
  for (let i = 0; i < defined.length;) {
    let j = i;
    while (j < defined.length && defined[j] === defined[i]) j += 1;
    varint(out, (j - i) << 1);
    out.push(defined[i] ? 1 : 0);
    i = j;
  }
  const len = Buffer.alloc(4);
  len.writeUInt32LE(out.length);
  return Buffer.concat([len, Buffer.from(out)]);
}

function plain(type, values) {
  if (type === TYPE.BYTE_ARRAY) {
    return Buffer.concat(values.flatMap((v) => {
      const b = Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'utf8');
      const len = Buffer.alloc(4);
      len.writeUInt32LE(b.length);
      return [len, b];
    }));
  }
  const b = Buffer.alloc(values.length * 8);
  values.forEach((v, i) => (type === TYPE.INT64 ? b.writeBigInt64LE(BigInt(Math.trunc(v)), i * 8) : b.writeDoubleLE(Number(v), i * 8)));
  return b;
}

const doubleBytes = (v) => { const b = Buffer.alloc(8); b.writeDoubleLE(v); return b; };

/** One column chunk (a single data page): bytes and its ColumnMetaData fields; `stats` adds min/max (DOUBLE). */
function columnChunk({ name, path, type, optional, stats }, values, offset, codec) {
  const defined = values.map((v) => v !== null && v !== undefined && (type === TYPE.BYTE_ARRAY || Number.isFinite(Number(v))));
  const present = values.filter((v, i) => defined[i]);
  const raw = Buffer.concat([...(optional ? [definitionLevels(defined)] : []), plain(type, present)]);
  const data = codec === CODEC.gzip ? zlib.gzipSync(raw) : raw;
  const header = thrift([
    [1, T.I32, 0], // DATA_PAGE
    [2, T.I32, raw.length],
    [3, T.I32, data.length],
    [5, T.STRUCT, [
      [1, T.I32, values.length],
      [2, T.I32, ENCODING.PLAIN],
      [3, T.I32, ENCODING.RLE],
      [4, T.I32, ENCODING.RLE],
    ]],
  ]);
  const bytes = Buffer.concat([header, data]);
  return {
    bytes,
    uncompressed: header.length + raw.length,
    meta: [
      [1, T.I32, type],
      [2, T.LIST, { type: T.I32, items: [ENCODING.PLAIN, ENCODING.RLE] }],
      [3, T.LIST, { type: T.BINARY, items: path || [name] }],
      [4, T.I32, codec],
      [5, T.I64, values.length],
      [6, T.I64, header.length + raw.length],
      [7, T.I64, bytes.length],
      [9, T.I64, offset],
      // Statistics: null_count, max_value, min_value.
      [12, T.STRUCT, stats && present.length ? [
        [3, T.I64, 0],
        [5, T.BINARY, doubleBytes(Math.max(...present))],
        [6, T.BINARY, doubleBytes(Math.min(...present))],
      ] : undefined],
    ],
  };
}

/** Bounding box [xmin, ymin, xmax, ymax] of one geometry. */
function geometryBox(geometry) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  const walk = (c) => {
    if (typeof c[0] === 'number') {
      box[0] = Math.min(box[0], c[0]); box[1] = Math.min(box[1], c[1]);
      box[2] = Math.max(box[2], c[0]); box[3] = Math.max(box[3], c[1]);
    } else c.forEach(walk);
  };
  walk(geometry.coordinates);
  return box;
}

/** Position on a Hilbert curve of order 16 for x, y in [0, 1]: near positions are near on the map. */
function hilbert(x, y) {
  const n = 65536;
  let xi = Math.max(0, Math.min(n - 1, Math.floor(x * n)));
  let yi = Math.max(0, Math.min(n - 1, Math.floor(y * n)));
  let d = 0;
  for (let s = n / 2; s >= 1; s /= 2) {
    const rx = (xi & s) > 0 ? 1 : 0;
    const ry = (yi & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) { xi = n - 1 - xi; yi = n - 1 - yi; }
      [xi, yi] = [yi, xi];
    }
  }
  return d;
}

function bboxOf(features) {
  if (!features.length) return undefined;
  const boxes = features.map((f) => geometryBox(f.geometry));
  return [0, 1].map((k) => Math.min(...boxes.map((b) => b[k]))).concat([2, 3].map((k) => Math.max(...boxes.map((b) => b[k]))));
}

const GEOMETRY_TYPE = { POINT: 'Point', MULTIPOLYGON: 'MultiPolygon' };

const BOX = ['xmin', 'ymin', 'xmax', 'ymax'];

/**
 * GeoParquet file of one layer ({ geometryType: 'POINT' | 'MULTIPOLYGON',
 * fields: { column: 'TEXT' | 'INTEGER' | 'REAL' }, features }) as a Buffer;
 * geometries must already be in `srsId` (4326: lon/lat, 2056: LV95 E/N).
 * `compression`: 'gzip' (default) or 'none'; `rowGroupSize`: rows per row
 * group (sorted by place).
 */
function geoParquet(layer, { srsId = 4326, compression = 'gzip', rowGroupSize = 10000 } = {}) {
  const codec = CODEC[compression];
  if (codec === undefined) throw new Error(`Unbekannte Kompression ${compression}`);
  if (srsId !== 4326 && srsId !== 2056) throw new Error(`Unbekanntes Koordinatensystem ${srsId}`);
  const columns = [
    ...Object.entries(layer.fields).map(([name, t]) => ({ name, type: COLUMN_TYPE[t], text: t === 'TEXT', optional: true })),
    { name: 'geometry', type: TYPE.BYTE_ARRAY, optional: false },
    ...BOX.map((k, i) => ({ name: k, path: ['bbox', k], type: TYPE.DOUBLE, optional: false, stats: true, box: i })),
  ];
  if (columns.some((c) => c.type === undefined)) throw new Error('Spaltentyp nicht unterstützt');
  if (Object.keys(layer.fields).includes('bbox')) throw new Error('Die Spalte bbox ist für die Ausdehnung reserviert');
  // Sorted along a Hilbert curve over the extent, so each row group covers a compact area.
  const all = bboxOf(layer.features);
  const rows = layer.features.map((f) => ({ f, box: geometryBox(f.geometry) }));
  if (all) {
    const w = all[2] - all[0] || 1; const h = all[3] - all[1] || 1;
    for (const r of rows) r.h = hilbert(((r.box[0] + r.box[2]) / 2 - all[0]) / w, ((r.box[1] + r.box[3]) / 2 - all[1]) / h);
    rows.sort((a, b) => a.h - b.h);
  }
  const geo = {
    version: '1.1.0',
    primary_column: 'geometry',
    columns: {
      geometry: {
        encoding: 'WKB',
        geometry_types: [GEOMETRY_TYPE[layer.geometryType]],
        // Without `crs` GeoParquet means OGC:CRS84 (lon/lat), our WGS84 order.
        ...(srsId === 2056 ? { crs: require('./projjson-2056.json') } : {}),
        ...(all ? { bbox: all } : {}),
        covering: { bbox: Object.fromEntries(BOX.map((k) => [k, ['bbox', k]])) },
      },
    },
  };

  const chunks = [Buffer.from('PAR1')];
  let offset = 4;
  const groups = [];
  for (let start = 0; start < rows.length; start += Math.max(1, rowGroupSize)) {
    const part = rows.slice(start, start + Math.max(1, rowGroupSize));
    const metas = [];
    let total = 0;
    for (const c of columns) {
      const values = c.name === 'geometry' ? part.map((r) => wkb(r.f.geometry))
        : c.box !== undefined ? part.map((r) => r.box[c.box]) : part.map((r) => r.f.properties[c.name] ?? null);
      const chunk = columnChunk(c, values, offset, codec);
      chunks.push(chunk.bytes);
      metas.push([[2, T.I64, offset], [3, T.STRUCT, chunk.meta]]);
      offset += chunk.bytes.length;
      total += chunk.uncompressed;
    }
    groups.push([[1, T.LIST, { type: T.STRUCT, items: metas }], [2, T.I64, total], [3, T.I64, part.length]]);
  }
  const leaf = (c) => [
    [1, T.I32, c.type],
    [3, T.I32, c.optional ? 1 : 0], // OPTIONAL / REQUIRED
    [4, T.BINARY, c.name],
    [6, T.I32, c.text ? 0 : undefined], // converted type UTF8
    [10, T.STRUCT, c.text ? [[1, T.STRUCT, []]] : undefined], // logical type STRING
  ];
  const plainColumns = columns.filter((c) => c.box === undefined);
  const schema = [
    [[4, T.BINARY, 'schema'], [5, T.I32, plainColumns.length + 1]],
    ...plainColumns.map(leaf),
    // The bounding box: a required group of four required doubles.
    [[3, T.I32, 0], [4, T.BINARY, 'bbox'], [5, T.I32, BOX.length]],
    ...columns.filter((c) => c.box !== undefined).map(leaf),
  ];
  const footer = thrift([
    [1, T.I32, 1],
    [2, T.LIST, { type: T.STRUCT, items: schema }],
    [3, T.I64, rows.length],
    [4, T.LIST, { type: T.STRUCT, items: groups }],
    [5, T.LIST, { type: T.STRUCT, items: [[[1, T.BINARY, 'geo'], [2, T.BINARY, JSON.stringify(geo)]]] }],
    [6, T.BINARY, 'MyForrest'],
    // Column orders (type-defined for every leaf), without which readers ignore min_value/max_value.
    [7, T.LIST, { type: T.STRUCT, items: columns.map(() => [[1, T.STRUCT, []]]) }],
  ]);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(footer.length);
  return Buffer.concat([...chunks, footer, len, Buffer.from('PAR1')]);
}

function writeGeoParquet(file, layer, options) {
  fs.writeFileSync(file, geoParquet(layer, options));
}

module.exports = { geoParquet, writeGeoParquet };
