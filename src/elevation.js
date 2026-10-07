'use strict';

/*
 * Terrain elevation of a spot from Open-Meteo's elevation API (Copernicus
 * DEM GLO-90, ~90 m resolution). Cached per ~100 m cell in the shared
 * weather cache table, since terrain does not change.
 */

const ENDPOINT = 'https://api.open-meteo.com/v1/elevation';

function createElevation({ db, fetchImpl = fetch }) {
  db.exec('CREATE TABLE IF NOT EXISTS weather_cache (key TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at INTEGER NOT NULL)');
  const get = db.prepare('SELECT json FROM weather_cache WHERE key = ?');
  const set = db.prepare('INSERT OR REPLACE INTO weather_cache (key, json, fetched_at) VALUES (?, ?, ?)');

  /** Elevation in metres above sea level; throws when the service is unavailable. */
  async function lookup(lat, lon) {
    const key = `elev:${lat.toFixed(3)},${lon.toFixed(3)}`;
    const row = get.get(key);
    if (row) return JSON.parse(row.json);
    const res = await fetchImpl(`${ENDPOINT}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Höhendienst antwortete mit HTTP ${res.status}`);
    const value = (await res.json()).elevation?.[0];
    if (!Number.isFinite(value)) throw new Error('Höhendienst lieferte keinen Wert');
    const elevation = Math.round(value);
    set.run(key, JSON.stringify(elevation), Date.now());
    return elevation;
  }

  /**
   * Terrain at a spot from DEM samples fetched in one request: a 3×3 grid
   * 90 m apart for elevation, slope (°) and aspect (° clockwise from north,
   * the direction the slope faces, Horn's method), plus rings of 8 points at
   * 300 m and 600 m for the topographic position index (TPI: elevation minus
   * the mean of the ring). Strongly negative TPI marks hollows and valley
   * floors where cold air collects; positive TPI marks knolls and ridges.
   */
  async function terrain(lat, lon) {
    const key = `terrain2:${lat.toFixed(4)},${lon.toFixed(4)}`;
    const row = get.get(key);
    if (row) return JSON.parse(row.json);
    const mLat = 1 / 111320;
    const mLon = 1 / (111320 * Math.cos((lat * Math.PI) / 180));
    const pts = [];
    for (const r of [1, 0, -1]) for (const c of [-1, 0, 1]) pts.push([lat + r * SPACING * mLat, lon + c * SPACING * mLon]);
    for (const radius of RINGS) {
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4;
        pts.push([lat + Math.cos(a) * radius * mLat, lon + Math.sin(a) * radius * mLon]);
      }
    }
    const url = `${ENDPOINT}?latitude=${pts.map((p) => p[0].toFixed(5)).join(',')}` +
      `&longitude=${pts.map((p) => p[1].toFixed(5)).join(',')}`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Höhendienst antwortete mit HTTP ${res.status}`);
    const z = (await res.json()).elevation;
    if (!Array.isArray(z) || z.length !== pts.length || !z.every(Number.isFinite)) throw new Error('Höhendienst lieferte kein Raster');
    const tpi = (from) => Math.round((z[4] - z.slice(from, from + 8).reduce((a, b) => a + b, 0) / 8) * 10) / 10;
    const value = { elevation: Math.round(z[4]), ...slopeAspect(z.slice(0, 9), SPACING), tpi300: tpi(9), tpi600: tpi(17) };
    set.run(key, JSON.stringify(value), Date.now());
    return value;
  }

  /**
   * Terrain horizon around a place: for 36 directions (every 10°, from
   * north clockwise) the elevation angle of the highest terrain seen from
   * 2 m above ground, sampled at 12 distances from 120 m to 20 km. Earth
   * curvature and standard refraction lower distant terrain. Angles below
   * the flat horizon count as 0°. The sky view factor (share of the sky
   * hemisphere that is open, for diffuse light on flat ground) follows from
   * the horizon angles as the mean of cos²(h).
   */
  async function horizon(lat, lon) {
    const key = `horizon1:${lat.toFixed(4)},${lon.toFixed(4)}`;
    const row = get.get(key);
    if (row) return JSON.parse(row.json);
    const mLat = 1 / 111320;
    const mLon = 1 / (111320 * Math.cos((lat * Math.PI) / 180));
    const pts = [[lat, lon]];
    for (let k = 0; k < HORIZON_DIRS; k++) {
      const a = (k * 2 * Math.PI) / HORIZON_DIRS;
      for (const d of HORIZON_DIST) pts.push([lat + Math.cos(a) * d * mLat, lon + Math.sin(a) * d * mLon]);
    }
    const z = [];
    // The elevation API takes at most 100 coordinates per request.
    for (let i = 0; i < pts.length; i += 100) {
      const chunk = pts.slice(i, i + 100);
      const url = `${ENDPOINT}?latitude=${chunk.map((p) => p[0].toFixed(5)).join(',')}` +
        `&longitude=${chunk.map((p) => p[1].toFixed(5)).join(',')}`;
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`Höhendienst antwortete mit HTTP ${res.status}`);
      const part = (await res.json()).elevation;
      if (!Array.isArray(part) || part.length !== chunk.length || !part.every(Number.isFinite)) throw new Error('Höhendienst lieferte kein Profil');
      z.push(...part);
    }
    const eye = z[0] + 2;
    const angles = [];
    const distances = [];
    for (let k = 0; k < HORIZON_DIRS; k++) {
      let best = 0; let at = null;
      HORIZON_DIST.forEach((d, j) => {
        const drop = (d * d) / (2 * EARTH_R) * (1 - REFRACTION_K);
        const angle = (Math.atan2(z[1 + k * HORIZON_DIST.length + j] - drop - eye, d) * 180) / Math.PI;
        if (angle > best) { best = angle; at = d; }
      });
      angles.push(Math.round(best * 10) / 10);
      distances.push(at);
    }
    const svf = angles.reduce((s, h) => s + Math.cos((h * Math.PI) / 180) ** 2, 0) / angles.length;
    const value = { step: 360 / HORIZON_DIRS, angles, distances, svf: Math.round(svf * 1000) / 1000, elevation: Math.round(z[0]) };
    set.run(key, JSON.stringify(value), Date.now());
    return value;
  }

  return { lookup, terrain, horizon };
}

const HORIZON_DIRS = 36;
const HORIZON_DIST = [120, 250, 450, 750, 1200, 1900, 3000, 4500, 6500, 9500, 14000, 20000]; // m
const EARTH_R = 6371000;
const REFRACTION_K = 0.13;

const SPACING = 90; // m, the DEM's resolution
const RINGS = [300, 600]; // m, radii for the topographic position index

/**
 * Slope and aspect from a 3×3 grid in row-major order, north row first,
 * west column first (a b c / d e f / g h i), cell size `d` metres.
 */
function slopeAspect([a, b, c, d0, , f, g, h, i], d) {
  const east = ((c + 2 * f + i) - (a + 2 * d0 + g)) / (8 * d);
  const north = ((a + 2 * b + c) - (g + 2 * h + i)) / (8 * d);
  const slope = (Math.atan(Math.hypot(east, north)) * 180) / Math.PI;
  // The slope faces where the terrain falls away: opposite to the gradient.
  let aspect = (Math.atan2(-east, -north) * 180) / Math.PI;
  if (aspect < 0) aspect += 360;
  return { slope: Math.round(slope * 10) / 10, aspect: slope < 1 ? null : Math.round(aspect) };
}

module.exports = { createElevation, slopeAspect, HORIZON_DIRS, HORIZON_DIST };
