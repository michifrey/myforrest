'use strict';

/**
 * Minimal GeoParquet writer (GeoParquet 1.1 on Apache Parquet), so the
 * collections can be published as cloud-native files without GDAL or Arrow:
 * one row group, one PLAIN-encoded data page per column (GZIP or
 * uncompressed), the file metadata in Thrift compact protocol. Columns as in
 * the GeoPackage (TEXT → UTF-8 string, INTEGER → INT64, REAL → DOUBLE, all
 * nullable), the geometry as WKB in the column `geometry`, described by the
 * `geo` key of the file metadata. DuckDB, GDAL/QGIS, GeoPandas and
 * pyarrow read it.
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

/** One column chunk (a single data page): bytes and its ColumnMetaData fields. */
function columnChunk({ name, type, optional }, values, offset, codec) {
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
      [3, T.LIST, { type: T.BINARY, items: [name] }],
      [4, T.I32, codec],
      [5, T.I64, values.length],
      [6, T.I64, header.length + raw.length],
      [7, T.I64, bytes.length],
      [9, T.I64, offset],
    ],
  };
}

function bboxOf(features) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  const walk = (c) => {
    if (typeof c[0] === 'number') {
      box[0] = Math.min(box[0], c[0]); box[1] = Math.min(box[1], c[1]);
      box[2] = Math.max(box[2], c[0]); box[3] = Math.max(box[3], c[1]);
    } else c.forEach(walk);
  };
  for (const f of features) walk(f.geometry.coordinates);
  return features.length ? box : undefined;
}

const GEOMETRY_TYPE = { POINT: 'Point', MULTIPOLYGON: 'MultiPolygon' };

/**
 * GeoParquet file of one layer ({ geometryType: 'POINT' | 'MULTIPOLYGON',
 * fields: { column: 'TEXT' | 'INTEGER' | 'REAL' }, features }) as a Buffer;
 * geometries must already be in `srsId` (4326: lon/lat, 2056: LV95 E/N).
 * `compression`: 'gzip' (default) or 'none'.
 */
function geoParquet(layer, { srsId = 4326, compression = 'gzip' } = {}) {
  const codec = CODEC[compression];
  if (codec === undefined) throw new Error(`Unbekannte Kompression ${compression}`);
  if (srsId !== 4326 && srsId !== 2056) throw new Error(`Unbekanntes Koordinatensystem ${srsId}`);
  const columns = [
    ...Object.entries(layer.fields).map(([name, t]) => ({ name, type: COLUMN_TYPE[t], text: t === 'TEXT', optional: true })),
    { name: 'geometry', type: TYPE.BYTE_ARRAY, optional: false },
  ];
  if (columns.some((c) => c.type === undefined)) throw new Error('Spaltentyp nicht unterstützt');
  const rows = layer.features;
  const geo = {
    version: '1.1.0',
    primary_column: 'geometry',
    columns: {
      geometry: {
        encoding: 'WKB',
        geometry_types: [GEOMETRY_TYPE[layer.geometryType]],
        // Without `crs` GeoParquet means OGC:CRS84 (lon/lat), our WGS84 order.
        ...(srsId === 2056 ? { crs: require('./projjson-2056.json') } : {}),
        ...(bboxOf(rows) ? { bbox: bboxOf(rows) } : {}),
      },
    },
  };

  const chunks = [Buffer.from('PAR1')];
  let offset = 4;
  const metas = [];
  let total = 0;
  if (rows.length) {
    for (const c of columns) {
      const values = c.name === 'geometry' ? rows.map((f) => wkb(f.geometry)) : rows.map((f) => f.properties[c.name] ?? null);
      const chunk = columnChunk(c, values, offset, codec);
      chunks.push(chunk.bytes);
      metas.push([[2, T.I64, offset], [3, T.STRUCT, chunk.meta]]);
      offset += chunk.bytes.length;
      total += chunk.uncompressed;
    }
  }
  const schema = [
    [[4, T.BINARY, 'schema'], [5, T.I32, columns.length]],
    ...columns.map((c) => [
      [1, T.I32, c.type],
      [3, T.I32, c.optional ? 1 : 0], // OPTIONAL / REQUIRED
      [4, T.BINARY, c.name],
      [6, T.I32, c.text ? 0 : undefined], // converted type UTF8
      [10, T.STRUCT, c.text ? [[1, T.STRUCT, []]] : undefined], // logical type STRING
    ]),
  ];
  const footer = thrift([
    [1, T.I32, 1],
    [2, T.LIST, { type: T.STRUCT, items: schema }],
    [3, T.I64, rows.length],
    [4, T.LIST, { type: T.STRUCT, items: rows.length ? [[[1, T.LIST, { type: T.STRUCT, items: metas }], [2, T.I64, total], [3, T.I64, rows.length]]] : [] }],
    [5, T.LIST, { type: T.STRUCT, items: [[[1, T.BINARY, 'geo'], [2, T.BINARY, JSON.stringify(geo)]]] }],
    [6, T.BINARY, 'MyForrest'],
  ]);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(footer.length);
  return Buffer.concat([...chunks, footer, len, Buffer.from('PAR1')]);
}

function writeGeoParquet(file, layer, options) {
  fs.writeFileSync(file, geoParquet(layer, options));
}

module.exports = { geoParquet, writeGeoParquet };
