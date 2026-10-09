'use strict';

/**
 * Vector tiles in a GeoPackage, in the Swiss LV95 tile grid – one file for
 * QGIS, GDAL or an offline device instead of the OGC API Tiles.
 *
 * Layout after the OGC GeoPackage extensions for tiled feature data:
 *   - a tile pyramid table (zoom_level, tile_column, tile_row, tile_data)
 *     with Mapbox Vector Tiles, registered in gpkg_contents with data_type
 *     'vector-tiles', and the extensions "im_vector_tiles" and
 *     "im_vector_tiles_mapbox";
 *   - gpkgext_vt_layers and gpkgext_vt_fields: the layers in the tiles and
 *     their attributes;
 *   - gpkg_tile_matrix_set / gpkg_tile_matrix with the swisstopo resolutions.
 *     They are not powers of two, hence the extension "gpkg_zoom_other".
 *
 * GeoPackage wants every zoom level to cover exactly the bounds of the tile
 * matrix set (matrix width × 256 × pixel size = width). With the swisstopo
 * resolutions (650 m, 1.5 m …) no single box does that for all 29 levels.
 * gpkgTileGrid therefore takes the finest levels, as many as fit into a box
 * whose side is a common multiple of all their tile widths (at most
 * MAX_SPAN_M), anchored at the swisstopo origin top left: tile columns and
 * rows stay those of the national grid. Written after the published
 * extension, not yet checked against QGIS/GDAL.
 */

const fs = require('node:fs');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const { SRS } = require('./gpkg');

const TILE = 256;
const MAX_SPAN_M = 2000000;
const EXT_BASE = 'http://www.geopackage.org/extensions/';

const gcd = (a, b) => (b ? gcd(b, a % b) : a);
const lcm = (a, b) => (a / gcd(a, b)) * b;

/**
 * Levels and bounds of a GeoPackage tile grid: { levels: [{ zoom, res, width, height }], bounds: [minX, minY, maxX, maxY] }.
 * `resolutions` (m per pixel, coarse to fine), `origin` [x, y] top left, `extent` [minX, minY, maxX, maxY] to cover,
 * `maxZoom` the finest level wanted.
 */
function gpkgTileGrid({ resolutions, origin, extent, maxZoom, maxSpan = MAX_SPAN_M }) {
  // Tile widths in decimetres (all swisstopo resolutions are multiples of 0.1 m).
  const dm = (res) => Math.round(res * TILE * 10);
  let span = dm(resolutions[maxZoom]);
  let first = maxZoom;
  for (let z = maxZoom - 1; z >= 0; z--) {
    const next = lcm(span, dm(resolutions[z]));
    const w = Math.ceil(((extent[2] - extent[0]) * 10) / next) * next;
    const h = Math.ceil(((extent[3] - extent[1]) * 10) / next) * next;
    if (Math.max(w, h) / 10 > maxSpan) break;
    span = next;
    first = z;
  }
  const width = (Math.ceil(((extent[2] - extent[0]) * 10) / span) * span) / 10;
  const height = (Math.ceil(((extent[3] - extent[1]) * 10) / span) * span) / 10;
  const levels = [];
  for (let z = first; z <= maxZoom; z++) {
    const res = resolutions[z];
    levels.push({ zoom: z, res, width: Math.round(width / (TILE * res)), height: Math.round(height / (TILE * res)) });
  }
  return { levels, bounds: [origin[0], origin[1] - height, origin[0] + width, origin[1]] };
}

const quote = (name) => `"${String(name).replace(/"/g, '""')}"`;
const VT_TYPE = { TEXT: 'String', INTEGER: 'Number', REAL: 'Number' };

/**
 * Writes the GeoPackage. `tiles`: iterable of { z, x, y, data } (MVT, gzip-compressed or not; stored
 * uncompressed), only levels of `grid` are kept. `layers`: [{ name, description, fields: { column: 'TEXT' | … } }].
 * `dataBounds`: [minX, minY, maxX, maxY] of the data in LV95.
 */
function writeVectorTilesGpkg(file, { table = 'myforrest', title, description, grid, layers, tiles, dataBounds, srsId = 2056 }) {
  fs.rmSync(file, { force: true });
  const db = new DatabaseSync(file);
  const zooms = new Set(grid.levels.map((l) => l.zoom));
  let count = 0;
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
        z TINYINT NOT NULL, m TINYINT NOT NULL, CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name));
      CREATE TABLE gpkg_tile_matrix_set (
        table_name TEXT NOT NULL PRIMARY KEY, srs_id INTEGER NOT NULL,
        min_x DOUBLE NOT NULL, min_y DOUBLE NOT NULL, max_x DOUBLE NOT NULL, max_y DOUBLE NOT NULL,
        CONSTRAINT fk_gtms_table_name FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name),
        CONSTRAINT fk_gtms_srs FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys (srs_id));
      CREATE TABLE gpkg_tile_matrix (
        table_name TEXT NOT NULL, zoom_level INTEGER NOT NULL, matrix_width INTEGER NOT NULL, matrix_height INTEGER NOT NULL,
        tile_width INTEGER NOT NULL, tile_height INTEGER NOT NULL, pixel_x_size DOUBLE NOT NULL, pixel_y_size DOUBLE NOT NULL,
        CONSTRAINT pk_ttm PRIMARY KEY (table_name, zoom_level),
        CONSTRAINT fk_tmm_table_name FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name));
      CREATE TABLE gpkg_extensions (
        table_name TEXT, column_name TEXT, extension_name TEXT NOT NULL, definition TEXT NOT NULL, scope TEXT NOT NULL,
        CONSTRAINT ge_tce UNIQUE (table_name, column_name, extension_name));
      CREATE TABLE gpkgext_vt_layers (
        id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL, name TEXT NOT NULL, description TEXT,
        minzoom INTEGER, maxzoom INTEGER, attributes_table_name TEXT,
        CONSTRAINT fk_gvl_table_name FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name));
      CREATE TABLE gpkgext_vt_fields (
        id INTEGER PRIMARY KEY AUTOINCREMENT, layer_id INTEGER NOT NULL, name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('String', 'Number', 'Boolean')),
        CONSTRAINT fk_gvf_layer_id FOREIGN KEY (layer_id) REFERENCES gpkgext_vt_layers(id));
      CREATE TABLE ${quote(table)} (
        id INTEGER PRIMARY KEY AUTOINCREMENT, zoom_level INTEGER NOT NULL, tile_column INTEGER NOT NULL,
        tile_row INTEGER NOT NULL, tile_data BLOB NOT NULL, UNIQUE (zoom_level, tile_column, tile_row));
    `);
    const srs = db.prepare('INSERT INTO gpkg_spatial_ref_sys VALUES (?, ?, ?, ?, ?, ?)');
    srs.run('Undefined cartesian SRS', -1, 'NONE', -1, 'undefined', 'undefined cartesian coordinate reference system');
    srs.run('Undefined geographic SRS', 0, 'NONE', 0, 'undefined', 'undefined geographic coordinate reference system');
    for (const id of new Set([4326, srsId])) srs.run(SRS[id].name, id, 'EPSG', id, SRS[id].definition, SRS[id].description);

    const minZoom = grid.levels[0].zoom;
    const maxZoom = grid.levels[grid.levels.length - 1].zoom;
    db.exec('BEGIN');
    db.prepare(`INSERT INTO gpkg_contents (table_name, data_type, identifier, description, min_x, min_y, max_x, max_y, srs_id)
      VALUES (?, 'vector-tiles', ?, ?, ?, ?, ?, ?, ?)`).run(table, title || table, description || '', ...(dataBounds || grid.bounds), srsId);
    db.prepare('INSERT INTO gpkg_tile_matrix_set VALUES (?, ?, ?, ?, ?, ?)').run(table, srsId, ...grid.bounds);
    const tm = db.prepare('INSERT INTO gpkg_tile_matrix VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const l of grid.levels) tm.run(table, l.zoom, l.width, l.height, TILE, TILE, l.res, l.res);
    const ext = db.prepare('INSERT INTO gpkg_extensions VALUES (?, ?, ?, ?, ?)');
    ext.run(table, 'tile_data', 'im_vector_tiles', 'https://docs.ogc.org/per/20-019r1.html', 'read-write');
    ext.run(table, 'tile_data', 'im_vector_tiles_mapbox', 'https://docs.ogc.org/per/20-019r1.html', 'read-write');
    ext.run('gpkgext_vt_layers', null, 'im_vector_tiles', 'https://docs.ogc.org/per/20-019r1.html', 'read-write');
    ext.run('gpkgext_vt_fields', null, 'im_vector_tiles', 'https://docs.ogc.org/per/20-019r1.html', 'read-write');
    ext.run(table, 'tile_data', 'gpkg_zoom_other', `${EXT_BASE}zoom_other.html`, 'read-write');
    const addLayer = db.prepare('INSERT INTO gpkgext_vt_layers (table_name, name, description, minzoom, maxzoom) VALUES (?, ?, ?, ?, ?)');
    const addField = db.prepare('INSERT INTO gpkgext_vt_fields (layer_id, name, type) VALUES (?, ?, ?)');
    for (const layer of layers) {
      const id = addLayer.run(table, layer.name, layer.description || null, minZoom, maxZoom).lastInsertRowid;
      for (const [name, type] of Object.entries(layer.fields || {})) addField.run(id, name, VT_TYPE[type] || 'String');
    }
    const put = db.prepare(`INSERT INTO ${quote(table)} (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)`);
    for (const t of tiles) {
      if (!zooms.has(t.z)) continue;
      const data = t.data[0] === 0x1f && t.data[1] === 0x8b ? zlib.gunzipSync(t.data) : t.data;
      put.run(t.z, t.x, t.y, data);
      if (++count % 1000 === 0) { db.exec('COMMIT'); db.exec('BEGIN'); }
    }
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  return { tiles: count, zooms: [...zooms] };
}

module.exports = { gpkgTileGrid, writeVectorTilesGpkg };
