'use strict';

/*
 * Small helper for Open-Meteo time series that may reach into the last few
 * days: the ERA5 archive trails real time by ~6 days, so the most recent
 * days come from the forecast API (which also serves the recent past).
 * Used by the storm and night-cooling modules; values are cached in the
 * shared weather_cache table.
 */

const ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const ARCHIVE_DELAY_DAYS = 6;
const FORECAST_PAST_DAYS = 90; // the forecast API serves roughly the last three months
const DAY = 86400000;

const isoDay = (t) => new Date(t).toISOString().slice(0, 10);
const dayStart = (t) => Math.floor(t / DAY) * DAY;

function openCache(db, now) {
  db.exec('CREATE TABLE IF NOT EXISTS weather_cache (key TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at INTEGER NOT NULL)');
  const get = db.prepare('SELECT json, fetched_at FROM weather_cache WHERE key = ?');
  const set = db.prepare('INSERT OR REPLACE INTO weather_cache (key, json, fetched_at) VALUES (?, ?, ?)');
  return async (key, maxAgeMs, load) => {
    const row = get.get(key);
    if (row && (maxAgeMs === Infinity || now() - row.fetched_at < maxAgeMs)) return JSON.parse(row.json);
    const value = await load();
    set.run(key, JSON.stringify(value), now());
    return value;
  };
}

/**
 * Fetches `kind` ('daily' | 'hourly') variables between two ISO days,
 * splitting the request between archive and forecast. Returns the raw
 * column arrays merged, keyed like Open-Meteo's response (`time`, …),
 * plus `utc_offset_seconds`.
 */
async function series({ lat, lon, start, end, kind, vars, extra = '', elevation = null, fetchImpl, now }) {
  const today = dayStart(now());
  const archiveEnd = Math.min(Date.parse(`${end}T00:00:00Z`), today - ARCHIVE_DELAY_DAYS * DAY);
  const parts = [];
  if (Date.parse(`${start}T00:00:00Z`) <= archiveEnd) parts.push([ARCHIVE, start, isoDay(archiveEnd)]);
  const recentStart = Math.max(Date.parse(`${start}T00:00:00Z`), archiveEnd + DAY, today - FORECAST_PAST_DAYS * DAY);
  const recentEnd = Math.min(Date.parse(`${end}T00:00:00Z`), today);
  if (recentStart <= recentEnd) parts.push([FORECAST, isoDay(recentStart), isoDay(recentEnd)]);
  const out = { time: [], utc_offset_seconds: 0 };
  for (const v of vars) out[v] = [];
  for (const [base, s, e] of parts) {
    const url = `${base}?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}` +
      (Number.isFinite(elevation) ? `&elevation=${Math.round(elevation)}` : '') +
      `&start_date=${s}&end_date=${e}&${kind}=${vars.join(',')}${extra}`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`Open-Meteo antwortete mit HTTP ${res.status}`);
    const body = await res.json();
    const block = body[kind];
    if (!block?.time) throw new Error('Open-Meteo lieferte keine Werte');
    out.utc_offset_seconds = body.utc_offset_seconds || 0;
    out.time.push(...block.time);
    for (const v of vars) out[v].push(...block.time.map((_, i) => block[v]?.[i] ?? null));
  }
  return out;
}

module.exports = { series, openCache, isoDay, dayStart, DAY, ARCHIVE_DELAY_DAYS };
