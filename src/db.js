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

  CREATE TABLE IF NOT EXISTS spot_species (
    id              INTEGER PRIMARY KEY,
    spot_id         INTEGER NOT NULL REFERENCES spots (id) ON DELETE CASCADE,
    scientific_name TEXT NOT NULL,
    source          TEXT NOT NULL CHECK (source IN ('plantnet', 'manual')),
    photo_id        INTEGER REFERENCES photos (id) ON DELETE CASCADE,
    score           REAL,
    created_at      INTEGER NOT NULL,
    UNIQUE (spot_id, scientific_name, source)
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

/** Columns added after the first version; added in place to existing databases. */
const MIGRATIONS = [
  ['photos', 'align_h', 'TEXT'], // JSON homography into the spot's common frame
  ['photos', 'align_inliers', 'INTEGER'],
  ['photos', 'change_json', 'TEXT'], // classified change against the spot's first aligned photo
  ['photos', 'context_json', 'TEXT'], // weather context and irregularities at capture time
  ['photos', 'altitude', 'REAL'], // GPS altitude from EXIF (m)
  ['spots', 'elevation', 'REAL'], // terrain elevation (m a.s.l.)
  ['spots', 'elevation_source', 'TEXT'], // 'dem' | 'gps' | 'manual'
  ['spots', 'slope', 'REAL'], // terrain slope (°)
  ['spots', 'aspect', 'REAL'], // direction the slope faces (° from north), null when flat
  ['spots', 'terrain_source', 'TEXT'], // 'dem' | 'manual'
  ['spots', 'tpi300', 'REAL'], // topographic position index (m) within 300 m
  ['spots', 'tpi600', 'REAL'], // … within 600 m
  ['spots', 'landform', 'TEXT'], // 'senke' | 'hang' | 'kuppe' | 'ebene'
  ['spots', 'landform_source', 'TEXT'], // 'dem' | 'manual'
  ['spots', 'heading', 'REAL'], // viewing direction (° from north): circular mean of the photos' headings
  ['photos', 'thumb_file', 'TEXT'], // 320 px WebP preview in data/thumbs
  ['photos', 'large_file', 'TEXT'], // 1280 px WebP preview in data/thumbs
  ['photos', 'panorama', 'INTEGER'], // 1 = equirectangular 360° image
  ['photos', 'video_time', 'REAL'], // position (s) in the source video for frames taken from a video
];

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  for (const [table, column, type] of MIGRATIONS) {
    const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
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
