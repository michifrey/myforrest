'use strict';

const EARTH_RADIUS_M = 6371000;
const toRad = (deg) => (deg * Math.PI) / 180;

/** Distance in metres between two {lat, lon} points (haversine). */
function distanceM(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

function isValidCoord(lat, lon) {
  return (
    Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
  );
}

/**
 * Position on a GPS track at time `t` (ms since epoch), linearly interpolated
 * between the two surrounding track points. `track` must be sorted by time.
 * Returns null when `t` lies further than `toleranceMs` outside the track.
 */
function positionAt(track, t, toleranceMs = 5 * 60 * 1000) {
  if (!track.length) return null;
  const first = track[0];
  const last = track[track.length - 1];
  if (t < first.time) return first.time - t <= toleranceMs ? { lat: first.lat, lon: first.lon } : null;
  if (t > last.time) return t - last.time <= toleranceMs ? { lat: last.lat, lon: last.lon } : null;

  let lo = 0;
  let hi = track.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (track[mid].time <= t) lo = mid; else hi = mid;
  }
  const a = track[lo];
  const b = track[hi];
  const span = b.time - a.time;
  const f = span > 0 ? (t - a.time) / span : 0;
  return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
}

module.exports = { distanceM, isValidCoord, positionAt };
