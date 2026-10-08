'use strict';

/**
 * Precomputed vector tiles. Every tileset (tile matrix set × layer set ×
 * base URL) is cut once per data version into a separate SQLite file
 * (data/tiles.db), gzip-compressed; requests then read a row instead of
 * cutting the tile. Only tiles with data are stored: a tile up to the
 * precomputed zoom without a row is known to be empty.
 *
 * A new version is written next to the old one and switched over at the
 * end, so requests always see a complete pyramid. Building yields to the
 * event loop between batches, so the server keeps answering meanwhile.
 */

const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');

const BATCH = 64;
const tick = () => new Promise((resolve) => setImmediate(resolve));

function createTileCache(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS tiles (
      tileset TEXT NOT NULL, version TEXT NOT NULL, z INTEGER NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL,
      data BLOB NOT NULL,
      PRIMARY KEY (tileset, version, z, x, y)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS builds (
      tileset TEXT PRIMARY KEY, version TEXT NOT NULL, max_zoom INTEGER NOT NULL,
      tiles INTEGER NOT NULL, bytes INTEGER NOT NULL, built_at INTEGER NOT NULL, millis INTEGER NOT NULL
    );`);
  const getBuild = db.prepare('SELECT * FROM builds WHERE tileset = ?');
  const getTile = db.prepare('SELECT data FROM tiles WHERE tileset = ? AND version = ? AND z = ? AND x = ? AND y = ?');
  const putTile = db.prepare('INSERT OR REPLACE INTO tiles (tileset, version, z, x, y, data) VALUES (?, ?, ?, ?, ?, ?)');
  const dropOthers = db.prepare('DELETE FROM tiles WHERE tileset = ? AND version <> ?');
  const dropVersion = db.prepare('DELETE FROM tiles WHERE tileset = ? AND version = ?');
  const putBuild = db.prepare(`INSERT OR REPLACE INTO builds (tileset, version, max_zoom, tiles, bytes, built_at, millis)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const allTiles = db.prepare('SELECT z, x, y, data FROM tiles WHERE tileset = ? AND version = ? ORDER BY z, x, y');
  let closed = false;

  /** The build of a tileset when it is current (matches `version`), else null. */
  function current(tileset, version) {
    const b = getBuild.get(tileset);
    return b && b.version === version ? b : null;
  }

  return {
    current,

    /**
     * A precomputed tile: gzip-compressed Buffer, null when the tile is known
     * to be empty, undefined when it was not precomputed (other version, deeper zoom).
     */
    lookup(tileset, version, z, x, y) {
      const b = current(tileset, version);
      if (!b || z > b.max_zoom) return undefined;
      const row = getTile.get(tileset, version, z, x, y);
      return row ? Buffer.from(row.data) : null;
    },

    /**
     * Cuts a tileset: `candidates(z)` lists the [x, y] that may hold data at
     * zoom z, `encode(z, x, y)` returns the MVT Buffer or null.
     */
    async build(tileset, version, maxZoom, candidates, encode) {
      const started = Date.now();
      dropVersion.run(tileset, version); // leftovers of an interrupted build
      let tiles = 0;
      let bytes = 0;
      let n = 0;
      let open = false;
      const begin = () => { db.exec('BEGIN'); open = true; };
      const commit = () => { db.exec('COMMIT'); open = false; };
      begin();
      try {
        for (let z = 0; z <= maxZoom; z++) {
          for (const [x, y] of candidates(z)) {
            const pbf = encode(z, x, y);
            if (pbf) {
              const gz = zlib.gzipSync(pbf);
              putTile.run(tileset, version, z, x, y, gz);
              tiles += 1;
              bytes += gz.length;
            }
            if (++n % BATCH === 0) {
              commit();
              await tick();
              if (closed) return null;
              begin();
            }
          }
        }
        putBuild.run(tileset, version, maxZoom, tiles, bytes, Date.now(), Date.now() - started);
        dropOthers.run(tileset, version);
        commit();
      } catch (err) {
        if (open) db.exec('ROLLBACK');
        throw err;
      }
      return { tiles, bytes, millis: Date.now() - started };
    },

    /** All stored tiles of a current build ([{ z, x, y, data }], gzip-compressed). */
    tiles(tileset, version) {
      return allTiles.all(tileset, version).map((r) => ({ ...r, data: Buffer.from(r.data) }));
    },

    /** Removes every tileset whose key does not start with one of these prefixes. */
    keepOnly(prefixes) {
      for (const { tileset } of db.prepare('SELECT tileset FROM builds').all()) {
        if (prefixes.some((p) => tileset.startsWith(p))) continue;
        db.prepare('DELETE FROM tiles WHERE tileset = ?').run(tileset);
        db.prepare('DELETE FROM builds WHERE tileset = ?').run(tileset);
      }
    },

    close() {
      closed = true;
      db.close();
    },
  };
}

module.exports = { createTileCache };
