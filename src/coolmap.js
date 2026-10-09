'use strict';

/**
 * Map of cool stretches: the temperature that sports watches record along a
 * tour, combined over many tours into cells of about 100 m.
 *
 * A single watch knows neither the weather nor the time of day, and it sits
 * on a warm wrist. So each tour only says how much warmer or cooler one
 * place was than the rest of the same tour:
 *
 *   1. Lag: the watch's sensor reacts slowly; the value at time t + LAG_S
 *      belongs to the place passed at t.
 *   2. Weather and time of day: a straight line through temperature over
 *      time (least squares) is the tour's level and its drift (a morning run
 *      gets warmer); what is left over is the local deviation. Body heat is
 *      part of the level and drops out too.
 *   3. Each tour gives one value per cell (its mean deviation there), so a
 *      long rest does not weigh more than passing by.
 *
 * A cell is shown with at least MIN_TOURS tours from at least MIN_PEOPLE
 * people, as the mean of their values. Only tours whose owner chose to
 * share their temperature count, without the first and last 200 m (start
 * and finish are often at home), and the cells carry no times or names.
 */

const { trimEnds } = require('./routegeo');

const CELL_M = 100;
const LAG_S = 60;
const MIN_TOURS = 3;
const MIN_PEOPLE = 2;
const MIN_POINTS = 30;
const MIN_MINUTES = 10;
const PRIVACY_ZONE_M = 200;
const M_PER_DEG = 111320;

/** Cell of a position: rows of CELL_M in latitude, columns of CELL_M at the row's latitude. */
function cellOf(lat, lon) {
  const row = Math.floor((lat * M_PER_DEG) / CELL_M);
  const cos = Math.cos(((row + 0.5) * CELL_M / M_PER_DEG) * (Math.PI / 180));
  const col = Math.floor((lon * M_PER_DEG * cos) / CELL_M);
  return { key: `${row}:${col}`, row, col, cos };
}
function cellCentre(row, col) {
  const lat = ((row + 0.5) * CELL_M) / M_PER_DEG;
  const cos = Math.cos(lat * (Math.PI / 180));
  return { lat, lon: ((col + 0.5) * CELL_M) / (M_PER_DEG * cos) };
}

/**
 * One tour's deviations per cell: Map(key → { row, col, delta }), or null when
 * the tour is too short or has too few temperatures.
 */
function tourCells(points) {
  const pts = points.filter((p) => Number.isFinite(p.time));
  const withTemp = pts.filter((p) => Number.isFinite(p.temp));
  if (withTemp.length < MIN_POINTS) return null;
  const t0 = withTemp[0].time;
  if ((withTemp.at(-1).time - t0) / 60000 < MIN_MINUTES) return null;
  // Temperature at a time, linear between readings.
  const tempAt = (t) => {
    if (t <= withTemp[0].time) return withTemp[0].temp;
    if (t >= withTemp.at(-1).time) return withTemp.at(-1).temp;
    let lo = 0;
    let hi = withTemp.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (withTemp[mid].time <= t) lo = mid; else hi = mid;
    }
    const a = withTemp[lo];
    const b = withTemp[hi];
    return a.temp + (b.temp - a.temp) * ((t - a.time) / ((b.time - a.time) || 1));
  };
  // 1. Lag, then 2. level and drift of the tour.
  const samples = pts.map((p) => ({ lat: p.lat, lon: p.lon, x: (p.time - t0) / 60000, y: tempAt(p.time + LAG_S * 1000) }));
  const n = samples.length;
  const mx = samples.reduce((s, p) => s + p.x, 0) / n;
  const my = samples.reduce((s, p) => s + p.y, 0) / n;
  const sxx = samples.reduce((s, p) => s + (p.x - mx) ** 2, 0);
  const slope = sxx ? samples.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / sxx : 0;
  // Privacy: not at the ends.
  const kept = new Set(trimEnds(pts, PRIVACY_ZONE_M));
  const cells = new Map();
  pts.forEach((p, i) => {
    if (!kept.has(p)) return;
    const s = samples[i];
    const residual = s.y - (my + slope * (s.x - mx));
    const c = cellOf(p.lat, p.lon);
    let e = cells.get(c.key);
    if (!e) cells.set(c.key, (e = { row: c.row, col: c.col, sum: 0, k: 0 }));
    e.sum += residual;
    e.k += 1;
  });
  for (const e of cells.values()) e.delta = e.sum / e.k;
  return cells;
}

function createCoolMap(db, { unpack }) {
  const cache = new Map(); // track id → { stamp, cells }
  const cellsOfTrack = (t) => {
    const hit = cache.get(t.id);
    if (hit && hit.stamp === t.updated_at) return hit.cells;
    const cells = tourCells(unpack(t.points_json));
    cache.set(t.id, { stamp: t.updated_at, cells });
    return cells;
  };

  /** Cells within a box [west, south, east, north]: [{ lat, lon, delta, tours }]. */
  function cells(box) {
    const [w, s, e, n] = box;
    const tracks = db.prepare(`SELECT id, owner_id, points_json, updated_at FROM tracks
      WHERE share_temp = 1 AND max_lat >= ? AND min_lat <= ? AND max_lon >= ? AND min_lon <= ?`).all(s, n, w, e);
    const agg = new Map();
    for (const t of tracks) {
      const tc = cellsOfTrack(t);
      if (!tc) continue;
      for (const [key, c] of tc) {
        let a = agg.get(key);
        if (!a) agg.set(key, (a = { row: c.row, col: c.col, sum: 0, tours: 0, people: new Set() }));
        a.sum += c.delta;
        a.tours += 1;
        a.people.add(t.owner_id);
      }
    }
    const out = [];
    for (const a of agg.values()) {
      if (a.tours < MIN_TOURS || a.people.size < MIN_PEOPLE) continue;
      const { lat, lon } = cellCentre(a.row, a.col);
      if (lat < s || lat > n || lon < w || lon > e) continue;
      out.push({ lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6, delta: Math.round((a.sum / a.tours) * 10) / 10, tours: a.tours });
    }
    return out;
  }

  return { cells, forget: (id) => cache.delete(id) };
}

module.exports = { createCoolMap, tourCells, cellOf, CELL_M, MIN_TOURS, MIN_PEOPLE, LAG_S };
