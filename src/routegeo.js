'use strict';

/**
 * Geometry on routes and tracks given as [{lat, lon}]: length, distance of a
 * point to the route and where along the route it lies, and trimming of the
 * ends (privacy zone around start and finish of public tracks).
 */

const { distanceM } = require('./geo');

const M_PER_DEG = 111320;

function lengthM(points) {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += distanceM(points[i - 1], points[i]);
  return d;
}

function bbox(points) {
  let [s, w, n, e] = [90, 180, -90, -180];
  for (const p of points) {
    s = Math.min(s, p.lat); n = Math.max(n, p.lat);
    w = Math.min(w, p.lon); e = Math.max(e, p.lon);
  }
  return [w, s, e, n];
}

/**
 * For each target {lat, lon}: the shortest distance to the route (m) and the
 * distance along the route to the closest point (m), or null when farther
 * than `maxM`. Local equirectangular projection per target, which is exact
 * enough for the few hundred metres that matter here.
 */
function nearRoute(route, targets, maxM) {
  if (route.length === 0) return targets.map(() => null);
  const cum = [0];
  for (let i = 1; i < route.length; i++) cum.push(cum[i - 1] + distanceM(route[i - 1], route[i]));
  const [w, s, e, n] = bbox(route);
  const padLat = maxM / M_PER_DEG;
  return targets.map((t) => {
    const padLon = padLat / Math.cos((t.lat * Math.PI) / 180);
    if (t.lat < s - padLat || t.lat > n + padLat || t.lon < w - padLon || t.lon > e + padLon) return null;
    const kx = M_PER_DEG * Math.cos((t.lat * Math.PI) / 180);
    let best = { distanceM: Infinity, alongM: 0 };
    const xy = (p) => [(p.lon - t.lon) * kx, (p.lat - t.lat) * M_PER_DEG];
    let [ax, ay] = xy(route[0]);
    if (route.length === 1) best = { distanceM: Math.hypot(ax, ay), alongM: 0 };
    for (let i = 1; i < route.length; i++) {
      const [bx, by] = xy(route[i]);
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const f = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      const d = Math.hypot(ax + f * dx, ay + f * dy);
      if (d < best.distanceM) best = { distanceM: d, alongM: cum[i - 1] + f * (cum[i] - cum[i - 1]) };
      [ax, ay] = [bx, by];
    }
    return best.distanceM <= maxM ? { distanceM: Math.round(best.distanceM), alongM: Math.round(best.alongM) } : null;
  });
}

/** The route without its first and last `m` metres (whole route gone when shorter than 2 m). */
function trimEnds(points, m) {
  if (m <= 0 || points.length < 2) return points;
  const total = lengthM(points);
  if (total <= 2 * m) return [];
  let from = 0;
  for (let d = 0; from < points.length - 1 && d < m; from++) d += distanceM(points[from], points[from + 1]);
  let to = points.length - 1;
  for (let d = 0; to > 0 && d < m; to--) d += distanceM(points[to], points[to - 1]);
  return points.slice(from, to + 1);
}

/**
 * Points every `step` metres along a route (`n` at most), with the distance
 * from the start (`d`, m) and the elevation interpolated where both
 * neighbours have one.
 */
function sampleAlong(points, n = 100) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + distanceM(points[i - 1], points[i]));
  const total = cum.at(-1) || 0;
  const count = Math.max(2, Math.min(n, Math.round(total / 10) + 1));
  const out = [];
  let j = 1;
  for (let k = 0; k < count; k++) {
    const d = (total * k) / (count - 1);
    while (j < points.length - 1 && cum[j] < d) j++;
    const a = points[j - 1];
    const b = points[j] || a;
    const f = cum[j] > cum[j - 1] ? (d - cum[j - 1]) / (cum[j] - cum[j - 1]) : 0;
    const p = { d: Math.round(d), lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
    if (Number.isFinite(a.ele) && Number.isFinite(b.ele)) p.ele = Math.round((a.ele + (b.ele - a.ele) * f) * 10) / 10;
    out.push(p);
  }
  return out;
}

/**
 * Elevation profile from samples with `ele`: ascent and descent count a change
 * only once it exceeds `threshold` metres (GPS and model noise), min and max.
 */
function climb(samples, threshold = 3) {
  const z = samples.map((s) => s.ele).filter(Number.isFinite);
  if (z.length < 2) return { ascent: null, descent: null, min: null, max: null };
  let ascent = 0;
  let descent = 0;
  let ref = z[0];
  for (const v of z.slice(1)) {
    if (v - ref >= threshold) { ascent += v - ref; ref = v; } else if (ref - v >= threshold) { descent += ref - v; ref = v; }
  }
  return { ascent: Math.round(ascent), descent: Math.round(descent), min: Math.round(Math.min(...z)), max: Math.round(Math.max(...z)) };
}

module.exports = {
  sampleAlong, climb, lengthM, bbox, nearRoute, trimEnds };
