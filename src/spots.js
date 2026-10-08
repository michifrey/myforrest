'use strict';

const { distanceM } = require('./geo');

/** Default tolerance (±°) within which a photo's viewing direction matches a spot's. */
const HEADING_TOLERANCE_DEG = 45;
/** Below this mean resultant length the member headings disagree: the spot has no direction. */
const MIN_HEADING_AGREEMENT = 0.6;

/** Smallest angle between two compass directions (0…180°). */
function headingDiff(a, b) {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
}

/**
 * Circular mean of compass directions. Returns `{ mean, r }` where `r` (0…1)
 * says how well they agree, or null for an empty list.
 */
function circularMean(headings) {
  if (!headings.length) return null;
  let x = 0;
  let y = 0;
  for (const h of headings) {
    x += Math.cos((h * Math.PI) / 180);
    y += Math.sin((h * Math.PI) / 180);
  }
  const r = Math.hypot(x, y) / headings.length;
  const mean = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return { mean: Math.round(mean * 10) / 10, r };
}

/**
 * A spot groups all photos taken at (roughly) the same place and looking in
 * (roughly) the same direction, so they can be compared over time. Returns the
 * id of the spot a photo joins, creating a new one when there is none:
 *
 * - Without a heading the photo joins the nearest spot within `radiusM`,
 *   whatever its direction (the behaviour before directions existed).
 * - With a heading it joins the nearest spot within `radiusM` whose heading is
 *   within ±`toleranceDeg`; failing that, the nearest spot without a direction
 *   (older spots or photos without compass), which thereby gets one. Otherwise
 *   a new spot is created, so a place photographed in opposite directions
 *   yields two spots.
 *
 * The spot centre is kept at the mean position of its photos, its heading at
 * their circular mean (see `refreshSpot`).
 */
function assignSpot(db, lat, lon, radiusM, heading = null, toleranceDeg = HEADING_TOLERANCE_DEG) {
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
  const candidates = db
    .prepare('SELECT id, lat, lon, heading FROM spots WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?')
    .all(lat - dLat, lat + dLat, lon - dLon, lon + dLon);

  const hasHeading = Number.isFinite(heading);
  let best = null;
  for (const s of candidates) {
    const d = distanceM({ lat, lon }, s);
    if (d > radiusM) continue;
    // Rank 0: direction matches (or does not matter), rank 1: spot without direction.
    let rank = 0;
    if (hasHeading) {
      if (s.heading === null) rank = 1;
      else if (headingDiff(heading, s.heading) > toleranceDeg) continue;
    }
    if (!best || rank < best.rank || (rank === best.rank && d < best.d)) best = { id: s.id, d, rank };
  }
  if (!best) {
    return Number(db.prepare('INSERT INTO spots (lat, lon, heading, created_at) VALUES (?, ?, ?, ?)')
      .run(lat, lon, hasHeading ? heading : null, Date.now()).lastInsertRowid);
  }
  return best.id;
}

const hasPanorama = (db) => db.prepare('PRAGMA table_info(photos)').all().some((c) => c.name === 'panorama');

/**
 * Circular mean heading of a spot's photos, or null when unknown or
 * inconsistent. 360° panoramas look everywhere and do not count.
 */
function spotHeading(db, spotId) {
  const flat = hasPanorama(db) ? ' AND COALESCE(panorama, 0) = 0' : '';
  const hs = db.prepare(`SELECT heading FROM photos WHERE spot_id = ? AND heading IS NOT NULL${flat}`).all(spotId).map((r) => r.heading);
  const m = circularMean(hs);
  return m && m.r >= MIN_HEADING_AGREEMENT ? m.mean : null;
}

/** Recomputes a spot's centre and heading from its photos; deletes the spot when empty. */
function refreshSpot(db, spotId) {
  const c = db.prepare('SELECT AVG(lat) AS lat, AVG(lon) AS lon, COUNT(*) AS n FROM photos WHERE spot_id = ?').get(spotId);
  if (!c.n) db.prepare('DELETE FROM spots WHERE id = ?').run(spotId);
  else db.prepare('UPDATE spots SET lat = ?, lon = ?, heading = ? WHERE id = ?').run(c.lat, c.lon, spotHeading(db, spotId), spotId);
}

/**
 * Gives spots from before directions existed their heading. Existing spots are
 * never split; spots whose photos look in different directions stay without one.
 */
function backfillSpotHeadings(db) {
  const rows = db.prepare(`
    SELECT DISTINCT s.id FROM spots s JOIN photos p ON p.spot_id = s.id
    WHERE s.heading IS NULL AND p.heading IS NOT NULL`).all();
  const set = db.prepare('UPDATE spots SET heading = ? WHERE id = ?');
  for (const { id } of rows) set.run(spotHeading(db, id), id);
}

module.exports = {
  assignSpot, refreshSpot, backfillSpotHeadings, circularMean, headingDiff, HEADING_TOLERANCE_DEG,
};
