'use strict';

/*
 * Nocturnal cooling in hollows. On calm, clear nights the ground radiates
 * heat away, the air above it cools and drains downhill into hollows and
 * valley floors, where it pools: the minimum there can be several degrees
 * below what a weather model (which does not resolve the hollow) reports.
 * With wind the air stays mixed; under clouds the long-wave loss is small.
 *
 * Per night, the cooling potential (0..1) is the mean over the night hours
 * of calm × clear, with
 *   calm  = 1 at ≤ 1.5 m/s wind (10 m), 0 at ≥ 5 m/s,
 *   clear = 1 at ≤ 20 % cloud cover,   0 at ≥ 80 %.
 * The extra cooling in the hollow is potential × cold-pool strength (from
 * the topographic position index, phenology.js) × up to 7 °C. Values in
 * forest hollows reach 3–8 °C in studies; deep dolines far more, so this is
 * deliberately conservative and the text calls it an estimate.
 */

const { series, openCache, dayStart, DAY } = require('./openmeteo');
const { coldPoolStrength } = require('./phenology');

const MAX_DEFICIT = 7; // °C below the model minimum on an ideal night in a pronounced hollow
const CALM = [1.5, 5]; // m/s
const CLEAR = [20, 80]; // %
const FROST = 0; // °C, estimated minimum below which a night counts as frost
const HARD_FROST = -2; // °C, young beech and ash leaves are usually damaged below this
const HOURLY = ['temperature_2m', 'wind_speed_10m', 'cloud_cover'];
// Leaf-out to early summer, as in weather.js: mornings from ~15 April to ~14 June.
const WINDOW = [[3, 14], [5, 14]]; // [month (0-based), day]
const CURRENT_MAX_AGE = 6 * 3600000;

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const r1 = (v) => Math.round(v * 10) / 10;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

/** Radiative cooling potential of one hour (0..1). */
function hourPotential(wind, cloud) {
  if (!Number.isFinite(wind) || !Number.isFinite(cloud)) return null;
  const calm = clamp01((CALM[1] - wind) / (CALM[1] - CALM[0]));
  const clear = clamp01((CLEAR[1] - cloud) / (CLEAR[1] - CLEAR[0]));
  return calm * clear;
}

/**
 * Nights from local hourly rows `{ time: 'YYYY-MM-DDTHH:MM', temp, wind, cloud }`.
 * A night is named by its morning date; the model minimum is taken from
 * 18:00 to 08:00, wind and cloud from 21:00 to 06:00.
 */
function nightsFromHourly(rows) {
  const byMorning = new Map();
  for (const r of rows) {
    const date = r.time.slice(0, 10);
    const hour = Number(r.time.slice(11, 13));
    let morning;
    if (hour >= 18) morning = new Date(Date.parse(`${date}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
    else if (hour <= 8) morning = date;
    else continue;
    const n = byMorning.get(morning) || { temps: [], pots: [], winds: [], clouds: [] };
    if (Number.isFinite(r.temp)) n.temps.push(r.temp);
    if (hour >= 21 || hour <= 6) {
      const p = hourPotential(r.wind, r.cloud);
      if (p !== null) n.pots.push(p);
      if (Number.isFinite(r.wind)) n.winds.push(r.wind);
      if (Number.isFinite(r.cloud)) n.clouds.push(r.cloud);
    }
    byMorning.set(morning, n);
  }
  return [...byMorning.entries()]
    .filter(([, n]) => n.temps.length >= 10 && n.pots.length >= 6) // complete nights only
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, n]) => ({
      date,
      tmin: r1(Math.min(...n.temps)),
      wind: r1(mean(n.winds)),
      cloud: Math.round(mean(n.clouds)),
      potential: Math.round(mean(n.pots) * 100) / 100,
    }));
}

/** Estimated minimum in the hollow for each night, given the spot's terrain. */
function estimateNights(nights, { landform = null, tpi600 = null } = {}) {
  const strength = coldPoolStrength(landform, tpi600);
  return nights.map((n) => {
    const deficit = r1(MAX_DEFICIT * strength * n.potential);
    return { ...n, deficit, est: r1(n.tmin - deficit) };
  });
}

/**
 * Frost nights after leaf-out up to `until` (ms) for a spot's terrain:
 * nights whose estimated minimum in the hollow falls below 0 °C.
 */
function frostSummary(nights, terrain = {}, until = Infinity) {
  if (!Array.isArray(nights) || !nights.length) return null;
  const est = estimateNights(nights.filter((n) => Date.parse(`${n.date}T08:00:00Z`) <= until), terrain);
  if (!est.length) return null;
  const frost = est.filter((n) => n.est < FROST);
  const coldest = est.reduce((m, n) => (!m || n.est < m.est ? n : m), null);
  return {
    strength: Math.round(coldPoolStrength(terrain.landform, terrain.tpi600) * 100) / 100,
    nights: est.length,
    calmClear: est.filter((n) => n.potential >= 0.6).length,
    frostNights: frost.map(({ date, tmin, est: e, wind, cloud, potential }) => ({ date, tmin, est: e, wind, cloud, potential })),
    hardFrost: frost.filter((n) => n.est <= HARD_FROST).length,
    coldest: coldest ? { date: coldest.date, tmin: coldest.tmin, est: coldest.est, wind: coldest.wind, cloud: coldest.cloud } : null,
  };
}

function createNightCool({ db, fetchImpl = fetch, now = () => Date.now() }) {
  const cached = openCache(db, now);
  const getRow = db.prepare('SELECT json, fetched_at FROM weather_cache WHERE key = ?');
  const place = (lat, lon, elevation) => `${lat.toFixed(1)},${lon.toFixed(1)}${Number.isFinite(elevation) ? `@${Math.round(elevation / 100) * 100}` : ''}`;

  /** Model nights of the leaf-out window of `year` (cached per weather cell and altitude band). */
  async function season(lat, lon, year, { elevation = null } = {}) {
    const key = `nights:${place(lat, lon, elevation)}:${year}`;
    const row = getRow.get(key);
    if (row) {
      const v = JSON.parse(row.json);
      if (v.complete || now() - row.fetched_at < CURRENT_MAX_AGE) return v.nights;
    }
    const today = dayStart(now());
    const start = Date.UTC(year, WINDOW[0][0], WINDOW[0][1]);
    const end = Math.min(Date.UTC(year, WINDOW[1][0], WINDOW[1][1]), today);
    if (start > end) return [];
    return (await cached(key, 0, async () => {
      const s = await series({
        lat, lon, start: new Date(start).toISOString().slice(0, 10), end: new Date(end).toISOString().slice(0, 10),
        kind: 'hourly', vars: HOURLY, extra: '&timezone=auto&wind_speed_unit=ms', elevation, fetchImpl, now,
      });
      const rows = s.time.map((time, i) => ({ time, temp: s.temperature_2m[i], wind: s.wind_speed_10m[i], cloud: s.cloud_cover[i] }));
      return { complete: Date.UTC(year, WINDOW[1][0], WINDOW[1][1]) < today - 7 * DAY, nights: nightsFromHourly(rows) };
    })).nights;
  }

  /** Nights after leaf-out in the year of `date`, up to `date`; null before leaf-out. */
  async function nightsBefore(lat, lon, date, opts = {}) {
    const year = new Date(date).getUTCFullYear();
    if (date < Date.UTC(year, WINDOW[0][0], WINDOW[0][1] + 1)) return null;
    const all = await season(lat, lon, year, opts);
    return all.filter((n) => Date.parse(`${n.date}T08:00:00Z`) <= date);
  }

  return { season, nightsBefore };
}

module.exports = {
  createNightCool, nightsFromHourly, estimateNights, frostSummary, hourPotential, MAX_DEFICIT, FROST, HARD_FROST,
};
