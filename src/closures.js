'use strict';

/**
 * Temporary closures for routing during forestry work (Holzerei): the path
 * magnet routes around them while they last.
 *
 *   - automatic: a public photo tagged "holzschlag" (by hand or by the
 *     detector) closes HOLZSCHLAG_SPERRE_TAGE days (default 42) from the day
 *     it was taken, 80 m around it. Protected finds never do: a closure would
 *     give their place away.
 *   - by hand: PRO members and moderation close a place with an end date
 *     (radius 20–500 m, at most a year), e.g. for the duration of a logging job.
 *
 * For BRouter they become no-go circles (`nogos=lon,lat,radius|…`).
 */

const DAY = 86400000;
const AUTO_RADIUS_M = 80;
const MAX_NOGOS = 60;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS closures (
    id INTEGER PRIMARY KEY,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    radius_m REAL NOT NULL,
    reason TEXT NOT NULL,
    until INTEGER NOT NULL,
    spot_id INTEGER,
    created_by INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS closures_until ON closures (until, lat, lon);
`;

const autoDays = () => Math.max(1, Number(process.env.HOLZSCHLAG_SPERRE_TAGE) || 42);

function createClosures(db, { now = () => Date.now() } = {}) {
  db.exec(SCHEMA);
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const hasTags = () => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'photo_tags'").get());
  const hasProtection = () => db.prepare('PRAGMA table_info(photos)').all().some((c) => c.name === 'protected');

  /** Active closures touching a box [west, south, east, north]: [{ id?, lat, lon, radiusM, reason, until, auto, spotId }]. */
  function active(box, at = now()) {
    const margin = 0.01; // a closure's circle may reach into the box
    const [w, s, e, n] = [box[0] - margin, box[1] - margin, box[2] + margin, box[3] + margin];
    const manual = db.prepare('SELECT * FROM closures WHERE until > ? AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? ORDER BY until')
      .all(at, s, n, w, e).map((c) => ({
        id: c.id, lat: c.lat, lon: c.lon, radiusM: c.radius_m, reason: c.reason, until: iso(c.until), auto: false, spotId: c.spot_id, createdBy: c.created_by,
      }));
    let auto = [];
    if (hasTags()) {
      const since = at - autoDays() * DAY;
      const visible = `p.hidden_at IS NULL${hasProtection() ? ' AND COALESCE(p.protected, 0) = 0' : ''}`;
      auto = db.prepare(`SELECT p.spot_id, MAX(p.taken_at) AS taken, s.lat, s.lon FROM photos p
        JOIN photo_tags t ON t.photo_id = p.id AND t.tag = 'holzschlag'
        JOIN spots s ON s.id = p.spot_id
        WHERE p.taken_at > ? AND p.taken_at <= ? AND ${visible} AND s.lat BETWEEN ? AND ? AND s.lon BETWEEN ? AND ?
        GROUP BY p.spot_id`).all(since, at, s, n, w, e)
        .map((r) => ({
          lat: r.lat, lon: r.lon, radiusM: AUTO_RADIUS_M, reason: `Holzschlag (Foto vom ${iso(r.taken).split('-').reverse().join('.')})`,
          until: iso(r.taken + autoDays() * DAY), auto: true, spotId: r.spot_id,
        }));
      // A spot closed by hand is not closed twice.
      auto = auto.filter((a) => !manual.some((m) => m.spotId === a.spotId));
    }
    return [...manual, ...auto];
  }

  /** Closures near a route (waypoints), as for BRouter; a waypoint inside one is named instead. */
  function near(points, at = now()) {
    const lats = points.map((p) => p.lat);
    const lons = points.map((p) => p.lon);
    const list = active([Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)], at);
    const dist = (a, b) => Math.hypot((b.lon - a.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180), (b.lat - a.lat) * 111320);
    const inside = list.filter((c) => points.some((p) => dist(c, p) <= c.radiusM));
    return { closures: list.filter((c) => !inside.includes(c)).slice(0, MAX_NOGOS), inside };
  }

  const nogosParam = (list) => list.map((c) => `${c.lon.toFixed(6)},${c.lat.toFixed(6)},${Math.round(c.radiusM)}`).join('|');

  function add({ lat, lon, radiusM, reason, until, spotId = null, userId }) {
    return Number(db.prepare('INSERT INTO closures (lat, lon, radius_m, reason, until, spot_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(lat, lon, radiusM, reason, until, spotId, userId, now()).lastInsertRowid);
  }
  const get = (id) => db.prepare('SELECT * FROM closures WHERE id = ?').get(id) || null;
  const remove = (id) => db.prepare('DELETE FROM closures WHERE id = ?').run(id).changes > 0;

  return { active, near, nogosParam, add, get, remove, AUTO_RADIUS_M };
}

module.exports = { createClosures, autoDays, AUTO_RADIUS_M };
