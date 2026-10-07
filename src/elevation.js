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

  return { lookup };
}

module.exports = { createElevation };
