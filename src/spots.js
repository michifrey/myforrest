'use strict';

const { distanceM } = require('./geo');

/**
 * A spot groups all photos taken at (roughly) the same place, so they can be
 * compared over time. Returns the id of the nearest spot within `radiusM`,
 * creating a new one when there is none. The spot centre is kept at the mean
 * position of its photos.
 */
function assignSpot(db, lat, lon, radiusM) {
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
  const candidates = db
    .prepare('SELECT id, lat, lon FROM spots WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?')
    .all(lat - dLat, lat + dLat, lon - dLon, lon + dLon);

  let best = null;
  for (const s of candidates) {
    const d = distanceM({ lat, lon }, s);
    if (d <= radiusM && (!best || d < best.d)) best = { id: s.id, d };
  }
  if (!best) {
    return Number(db.prepare('INSERT INTO spots (lat, lon, created_at) VALUES (?, ?, ?)').run(lat, lon, Date.now()).lastInsertRowid);
  }
  return best.id;
}

/** Recomputes a spot's centre from its photos; deletes the spot when empty. */
function refreshSpot(db, spotId) {
  const c = db.prepare('SELECT AVG(lat) AS lat, AVG(lon) AS lon, COUNT(*) AS n FROM photos WHERE spot_id = ?').get(spotId);
  if (!c.n) db.prepare('DELETE FROM spots WHERE id = ?').run(spotId);
  else db.prepare('UPDATE spots SET lat = ?, lon = ? WHERE id = ?').run(c.lat, c.lon, spotId);
}

module.exports = { assignSpot, refreshSpot };
