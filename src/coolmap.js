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
 *
 * Calibration against the weather model (Open-Meteo, hourly 2 m air
 * temperature at the tour's middle): a tour whose level is far from the
 * air temperature then (a watch under a sleeve or in a bag: more than 3 °C
 * colder or 15 °C warmer) does not count. Each tour also gets a season
 * (summer April–September, winter October–March) and a time of day (sun
 * above or below the horizon at its middle): a forest is cooler than a
 * meadow on a summer afternoon but often warmer in a clear night, so the
 * map can be asked for one combination only.
 */

const { trimEnds } = require('./routegeo');
const Sun = require('../public/sun');

const CELL_M = 100;
const LAG_S = 60;
const MIN_TOURS = 3;
const MIN_PEOPLE = 2;
const MIN_POINTS = 30;
const MIN_MINUTES = 10;
const PRIVACY_ZONE_M = 200;
const M_PER_DEG = 111320;
const MODEL_RANGE = [-3, 15]; // watch level minus model air temperature, °C
const SEASONS = ['sommer', 'winter'];
const DAYTIMES = ['tag', 'nacht'];

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

/**
 * Season, time of day and level of a tour, at its middle: { mid, lat, lon, season, daytime, level },
 * or null without enough temperatures.
 */
function tourClass(points) {
  const pts = points.filter((p) => Number.isFinite(p.time) && Number.isFinite(p.temp));
  if (pts.length < MIN_POINTS) return null;
  const mid = (pts[0].time + pts.at(-1).time) / 2;
  const at = pts.reduce((a, b) => (Math.abs(b.time - mid) < Math.abs(a.time - mid) ? b : a));
  const month = new Date(mid).getUTCMonth() + 1;
  // The level: the median temperature of the middle half of the tour.
  const middle = pts.filter((p) => Math.abs(p.time - mid) <= (pts.at(-1).time - pts[0].time) / 4).map((p) => p.temp).sort((a, b) => a - b);
  return {
    mid, lat: at.lat, lon: at.lon,
    season: month >= 4 && month <= 9 ? 'sommer' : 'winter',
    daytime: Sun.position(mid, at.lat, at.lon).altitude > 0 ? 'tag' : 'nacht',
    level: middle[Math.floor(middle.length / 2)],
  };
}

function createCoolMap(db, { unpack, weather = null }) {
  db.exec(`CREATE TABLE IF NOT EXISTS cool_checks (
    track_id INTEGER PRIMARY KEY, stamp INTEGER NOT NULL, season TEXT, daytime TEXT, level REAL, model REAL, ok INTEGER NOT NULL
  )`);
  const cache = new Map(); // track id → { stamp, cells, cls }
  const ofTrack = (t) => {
    const hit = cache.get(t.id);
    if (hit && hit.stamp === t.updated_at) return hit;
    const points = unpack(t.points_json);
    const entry = { stamp: t.updated_at, cells: tourCells(points), cls: tourClass(points) };
    cache.set(t.id, entry);
    return entry;
  };
  const checkOf = db.prepare('SELECT * FROM cool_checks WHERE track_id = ? AND stamp = ?');
  const saveCheck = db.prepare(`INSERT INTO cool_checks (track_id, stamp, season, daytime, level, model, ok) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (track_id) DO UPDATE SET stamp = excluded.stamp, season = excluded.season, daytime = excluded.daytime,
      level = excluded.level, model = excluded.model, ok = excluded.ok`);

  /** Air temperature of the weather model at the tour's middle, or null (no model, too recent, offline). */
  async function modelAt(cls) {
    if (!weather) return null;
    try {
      // Only a ~2 km grid point and the day go to the weather service, not the tour.
      const grid = (v) => Math.round(v * 50) / 50;
      const d = await weather.day(grid(cls.lat), grid(cls.lon), new Date(cls.mid).toISOString().slice(0, 10));
      const h = (d.hourly || []).filter((x) => Number.isFinite(x.temp))
        .reduce((a, b) => (!a || Math.abs(b.t - cls.mid) < Math.abs(a.t - cls.mid) ? b : a), null);
      return h && Math.abs(h.t - cls.mid) <= 90 * 60000 ? h.temp : null;
    } catch {
      return null;
    }
  }
  /** Checked once per version of a tour; a tour the model cannot check counts. */
  async function check(t, cls) {
    const row = checkOf.get(t.id, t.updated_at);
    if (row) return row;
    const model = await modelAt(cls);
    const diff = model === null ? null : cls.level - model;
    const ok = diff === null || (diff >= MODEL_RANGE[0] && diff <= MODEL_RANGE[1]) ? 1 : 0;
    // Only a real comparison is kept: without the model, it is tried again next time.
    if (model !== null) saveCheck.run(t.id, t.updated_at, cls.season, cls.daytime, cls.level, model, ok);
    return { ok, model };
  }

  /**
   * Cells within a box [west, south, east, north]: [{ lat, lon, delta, tours }]. `season`
   * ('sommer'/'winter') and `daytime` ('tag'/'nacht') limit it to tours of that kind.
   */
  async function cells(box, { season = null, daytime = null } = {}) {
    const [w, s, e, n] = box;
    const tracks = db.prepare(`SELECT id, owner_id, points_json, updated_at FROM tracks
      WHERE share_temp = 1 AND max_lat >= ? AND min_lat <= ? AND max_lon >= ? AND min_lon <= ?`).all(s, n, w, e);
    const agg = new Map();
    for (const t of tracks) {
      const { cells: tc, cls } = ofTrack(t);
      if (!tc || !cls) continue;
      if ((season && cls.season !== season) || (daytime && cls.daytime !== daytime)) continue;
      if (!(await check(t, cls)).ok) continue;
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

  const forget = (id) => {
    cache.delete(id);
    db.prepare('DELETE FROM cool_checks WHERE track_id = ?').run(id);
  };
  return { cells, forget };
}

module.exports = { createCoolMap, tourCells, tourClass, cellOf, CELL_M, MIN_TOURS, MIN_PEOPLE, LAG_S, SEASONS, DAYTIMES, MODEL_RANGE };
