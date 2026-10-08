'use strict';

/**
 * MBTiles 1.3 writer (SQLite) for vector tiles in WebMercatorQuad, the
 * format QGIS, GDAL and tile servers (tileserver-gl, martin) open directly.
 * https://github.com/mapbox/mbtiles-spec/blob/master/1.3/spec.md
 *
 * Tiles come in gzip-compressed, as the spec expects for pbf tiles. Rows
 * count from the south (TMS), unlike the XYZ/OGC rows of the API.
 */

const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

/**
 * tiles: [{ z, x, y, data }] (y from the north); meta: { name, description, attribution,
 * minzoom, maxzoom, bounds: [w, s, e, n], center: [lon, lat, zoom], vector_layers }.
 */
function writeMbtiles(file, tiles, meta) {
  fs.rmSync(file, { force: true });
  const db = new DatabaseSync(file);
  try {
    db.exec(`
      PRAGMA application_id = 0x4d504258; -- "MPBX"
      CREATE TABLE metadata (name TEXT, value TEXT);
      CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);
      CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);`);
    const setMeta = db.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)');
    const rows = {
      name: meta.name,
      description: meta.description,
      attribution: meta.attribution,
      format: 'pbf',
      type: 'overlay',
      version: '1.3',
      minzoom: String(meta.minzoom),
      maxzoom: String(meta.maxzoom),
      bounds: meta.bounds.join(','),
      center: meta.center.join(','),
      json: JSON.stringify({ vector_layers: meta.vector_layers }),
    };
    const addTile = db.prepare('INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)');
    db.exec('BEGIN');
    for (const [k, v] of Object.entries(rows)) if (v !== undefined) setMeta.run(k, v);
    for (const t of tiles) addTile.run(t.z, t.x, 2 ** t.z - 1 - t.y, t.data);
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

module.exports = { writeMbtiles };
