'use strict';

/**
 * Minimal GeoPackage writer (OGC GeoPackage 1.3, features only) on top of
 * node:sqlite, so exports need no GDAL. Writes the mandatory metadata tables,
 * one feature table per layer with typed columns, and geometries as
 * GeoPackage binary (header with envelope + little-endian WKB). Supports
 * Point and MultiPolygon, the geometry types MyForrest publishes.
 */

const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const SRS = {
  4326: {
    name: 'WGS 84 geodetic',
    definition: 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],'
      + 'AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,'
      + 'AUTHORITY["EPSG","9122"]],AXIS["Latitude",NORTH],AXIS["Longitude",EAST],AUTHORITY["EPSG","4326"]]',
    description: 'longitude/latitude coordinates in decimal degrees on the WGS 84 spheroid',
  },
  2056: {
    name: 'CH1903+ / LV95',
    definition: 'PROJCS["CH1903+ / LV95",GEOGCS["CH1903+",DATUM["CH1903+",SPHEROID["Bessel 1841",6377397.155,299.1528128,'
      + 'AUTHORITY["EPSG","7004"]],TOWGS84[674.374,15.056,405.346,0,0,0,0],AUTHORITY["EPSG","6150"]],PRIMEM["Greenwich",0,'
      + 'AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4150"]],'
      + 'PROJECTION["Hotine_Oblique_Mercator_Azimuth_Center"],PARAMETER["latitude_of_center",46.9524055555556],'
      + 'PARAMETER["longitude_of_center",7.43958333333333],PARAMETER["azimuth",90],PARAMETER["rectified_grid_angle",90],'
      + 'PARAMETER["scale_factor",1],PARAMETER["false_easting",2600000],PARAMETER["false_northing",1200000],'
      + 'UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Easting",EAST],AXIS["Northing",NORTH],AUTHORITY["EPSG","2056"]]',
    description: 'Schweizer Landeskoordinaten LV95 (swisstopo)',
  },
};

/** Little-endian WKB of a GeoJSON Point or MultiPolygon. */
function wkb(geometry) {
  const parts = [];
  const u8 = (v) => parts.push(Buffer.from([v]));
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); parts.push(b); };
  const xy = ([x, y]) => { const b = Buffer.alloc(16); b.writeDoubleLE(x, 0); b.writeDoubleLE(y, 8); parts.push(b); };
  if (geometry.type === 'Point') {
    u8(1); u32(1); xy(geometry.coordinates);
  } else if (geometry.type === 'MultiPolygon') {
    u8(1); u32(6); u32(geometry.coordinates.length);
    for (const poly of geometry.coordinates) {
      u8(1); u32(3); u32(poly.length);
      for (const ring of poly) { u32(ring.length); ring.forEach(xy); }
    }
  } else {
    throw new Error(`Geometrietyp ${geometry.type} wird nicht unterstützt`);
  }
  return Buffer.concat(parts);
}

function envelope(geometry) {
  const e = [Infinity, -Infinity, Infinity, -Infinity]; // minx, maxx, miny, maxy
  const walk = (c) => {
    if (typeof c[0] === 'number') {
      e[0] = Math.min(e[0], c[0]); e[1] = Math.max(e[1], c[0]);
      e[2] = Math.min(e[2], c[1]); e[3] = Math.max(e[3], c[1]);
    } else c.forEach(walk);
  };
  walk(geometry.coordinates);
  return e;
}

/** GeoPackage binary: "GP", version 0, flags (little endian, xy envelope except for points), srs id, envelope, WKB. */
function gpkgGeometry(geometry, srsId) {
  const withEnvelope = geometry.type !== 'Point';
  const head = Buffer.alloc(8 + (withEnvelope ? 32 : 0));
  head.write('GP', 0, 'ascii');
  head.writeUInt8(0, 2);
  head.writeUInt8(((withEnvelope ? 1 : 0) << 1) | 1, 3);
  head.writeInt32LE(srsId, 4);
  if (withEnvelope) envelope(geometry).forEach((v, i) => head.writeDoubleLE(v, 8 + i * 8));
  return Buffer.concat([head, wkb(geometry)]);
}

const quote = (name) => `"${String(name).replace(/"/g, '""')}"`;

/**
 * Writes layers ({ name, title, description, geometryType: 'POINT' |
 * 'MULTIPOLYGON', fields: { column: 'TEXT' | 'INTEGER' | 'REAL' }, features })
 * to a new GeoPackage file; feature geometries must already be in `srsId`.
 */
function writeGeoPackage(file, layers, { srsId = 4326 } = {}) {
  if (!SRS[srsId]) throw new Error(`Unbekanntes Koordinatensystem ${srsId}`);
  fs.rmSync(file, { force: true });
  const db = new DatabaseSync(file);
  try {
    db.exec(`
      PRAGMA application_id = 1196444487;
      PRAGMA user_version = 10300;
      CREATE TABLE gpkg_spatial_ref_sys (
        srs_name TEXT NOT NULL, srs_id INTEGER NOT NULL PRIMARY KEY, organization TEXT NOT NULL,
        organization_coordsys_id INTEGER NOT NULL, definition TEXT NOT NULL, description TEXT);
      CREATE TABLE gpkg_contents (
        table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL, identifier TEXT UNIQUE, description TEXT DEFAULT '',
        last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE, srs_id INTEGER,
        CONSTRAINT fk_gc_r_srs_id FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id));
      CREATE TABLE gpkg_geometry_columns (
        table_name TEXT NOT NULL, column_name TEXT NOT NULL, geometry_type_name TEXT NOT NULL, srs_id INTEGER NOT NULL,
        z TINYINT NOT NULL, m TINYINT NOT NULL,
        CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name),
        CONSTRAINT fk_gc_tn FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name),
        CONSTRAINT fk_gc_srs FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys (srs_id));
    `);
    const srs = db.prepare('INSERT INTO gpkg_spatial_ref_sys VALUES (?, ?, ?, ?, ?, ?)');
    srs.run('Undefined cartesian SRS', -1, 'NONE', -1, 'undefined', 'undefined cartesian coordinate reference system');
    srs.run('Undefined geographic SRS', 0, 'NONE', 0, 'undefined', 'undefined geographic coordinate reference system');
    for (const id of new Set([4326, srsId])) srs.run(SRS[id].name, id, 'EPSG', id, SRS[id].definition, SRS[id].description);

    db.exec('BEGIN');
    for (const layer of layers) {
      const cols = Object.entries(layer.fields);
      db.exec(`CREATE TABLE ${quote(layer.name)} (fid INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, geom ${layer.geometryType}${
        cols.map(([c, t]) => `, ${quote(c)} ${t}`).join('')})`);
      const insert = db.prepare(`INSERT INTO ${quote(layer.name)} (geom${cols.map(([c]) => `, ${quote(c)}`).join('')}) VALUES (?${', ?'.repeat(cols.length)})`);
      const box = [Infinity, Infinity, -Infinity, -Infinity];
      for (const f of layer.features) {
        const e = envelope(f.geometry);
        box[0] = Math.min(box[0], e[0]); box[1] = Math.min(box[1], e[2]);
        box[2] = Math.max(box[2], e[1]); box[3] = Math.max(box[3], e[3]);
        insert.run(gpkgGeometry(f.geometry, srsId), ...cols.map(([c]) => f.properties[c] ?? null));
      }
      const has = layer.features.length > 0;
      db.prepare(`INSERT INTO gpkg_contents (table_name, data_type, identifier, description, min_x, min_y, max_x, max_y, srs_id)
        VALUES (?, 'features', ?, ?, ?, ?, ?, ?, ?)`)
        .run(layer.name, layer.title || layer.name, layer.description || '', ...(has ? box : [null, null, null, null]), srsId);
      db.prepare('INSERT INTO gpkg_geometry_columns VALUES (?, ?, ?, ?, 0, 0)').run(layer.name, 'geom', layer.geometryType, srsId);
    }
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

module.exports = { writeGeoPackage, gpkgGeometry, wkb };
