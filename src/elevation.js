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
   * Terrain at a spot from a 3×3 grid of DEM samples 90 m apart: elevation,
   * slope (°) and aspect (° clockwise from north, the direction the slope
   * faces), using Horn's method as in common GIS tools.
   */
  async function terrain(lat, lon) {
    const key = `terrain:${lat.toFixed(4)},${lon.toFixed(4)}`;
    const row = get.get(key);
    if (row) return JSON.parse(row.json);
    const dLat = SPACING / 111320;
    const dLon = SPACING / (111320 * Math.cos((lat * Math.PI) / 180));
    const pts = [];
    for (const r of [1, 0, -1]) for (const c of [-1, 0, 1]) pts.push([lat + r * dLat, lon + c * dLon]);
    const url = `${ENDPOINT}?latitude=${pts.map((p) => p[0].toFixed(5)).join(',')}` +
      `&longitude=${pts.map((p) => p[1].toFixed(5)).join(',')}`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Höhendienst antwortete mit HTTP ${res.status}`);
    const z = (await res.json()).elevation;
    if (!Array.isArray(z) || z.length !== 9 || !z.every(Number.isFinite)) throw new Error('Höhendienst lieferte kein Raster');
    const value = { elevation: Math.round(z[4]), ...slopeAspect(z, SPACING) };
    set.run(key, JSON.stringify(value), Date.now());
    return value;
  }

  return { lookup, terrain };
}

const SPACING = 90; // m, the DEM's resolution

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

module.exports = { createElevation, slopeAspect };
