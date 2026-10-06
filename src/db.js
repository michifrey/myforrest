'use strict';

const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS spots (
    id         INTEGER PRIMARY KEY,
    lat        REAL NOT NULL,
    lon        REAL NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS spots_lat_lon ON spots (lat, lon);

  CREATE TABLE IF NOT EXISTS photos (
    id              INTEGER PRIMARY KEY,
    spot_id         INTEGER NOT NULL REFERENCES spots (id),
    file            TEXT NOT NULL UNIQUE,
    original_name   TEXT,
    taken_at        INTEGER NOT NULL,
    lat             REAL NOT NULL,
    lon             REAL NOT NULL,
    heading         REAL,
    location_source TEXT NOT NULL CHECK (location_source IN ('exif', 'gpx', 'manual', 'spot')),
    activity        TEXT,
    note            TEXT,
    created_at      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS photos_spot ON photos (spot_id, taken_at);

  CREATE TABLE IF NOT EXISTS photo_tags (
    photo_id INTEGER NOT NULL REFERENCES photos (id) ON DELETE CASCADE,
    tag      TEXT NOT NULL,
    PRIMARY KEY (photo_id, tag)
  );

  CREATE TABLE IF NOT EXISTS identifications (
    id              INTEGER PRIMARY KEY,
    photo_id        INTEGER NOT NULL REFERENCES photos (id) ON DELETE CASCADE,
    scientific_name TEXT NOT NULL,
    common_name     TEXT,
    score           REAL NOT NULL,
    neophyte        TEXT,
    created_at      INTEGER NOT NULL
  );
`;

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

/** Runs `fn` inside a transaction, rolling back on error. */
function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDb, transaction };
