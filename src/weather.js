'use strict';

/*
 * Weather context for a spot and date from Open-Meteo's historical archive
 * (ERA5 reanalysis, free, no API key, CC BY 4.0): what fell and how warm it
 * was before a photo was taken, compared with the 1991–2020 normal for the
 * same place and season.
 */

const ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
const FORECAST = 'https://api.open-meteo.com/v1/forecast';
// Rain, snowfall (cm) and snow depth (m) for the weather drawn in a spot's "Licht & Wald".
const HOURLY = 'precipitation,shortwave_radiation,cloud_cover,temperature_2m,rain,snowfall,snow_depth';
const FORECAST_DAYS = 15;
// The spot's weather tab: the next hours and seven days, like a weather app.
const OUTLOOK_HOURLY = 'temperature_2m,precipitation,precipitation_probability,snowfall,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day';
const OUTLOOK_DAILY = 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,snowfall_sum,wind_gusts_10m_max,sunshine_duration';
const OUTLOOK_HOURS = 36;
const OUTLOOK_TTL = 30 * 60000;
const DAILY = 'precipitation_sum,temperature_2m_mean,temperature_2m_max,temperature_2m_min';
// Leaf-out to early summer (~15 April to ~14 June): fresh leaves are frost-tender.
const LEAF_OUT_FROM = 104;
const LEAF_OUT_TO = 164;
// The model sees the slopes; in a cold-air pool nights are often 3–5 °C colder.
const COLD_NIGHT = 3;
const NORMAL_FROM = 1991;
const NORMAL_TO = 2020;
const ARCHIVE_DELAY_DAYS = 6; // ERA5 data trails real time by a few days
const DAY = 86400000;

const isoDay = (t) => new Date(t).toISOString().slice(0, 10);
/** Day of year (0-based), Feb 29 shares Feb 28's slot so years line up. */
function doy(t) {
  const d = new Date(t);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  let n = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - start) / DAY);
  const leap = new Date(Date.UTC(d.getUTCFullYear(), 1, 29)).getUTCDate() === 29;
  if (leap && n >= 59) n -= 1;
  return n;
}
/** Weather grid cell (~10 km): nearby spots share cached data. */
const cell = (lat, lon) => `${lat.toFixed(1)},${lon.toFixed(1)}`;

async function fetchDaily(lat, lon, start, end, fetchImpl, elevation = null) {
  // With `elevation`, Open-Meteo downscales temperatures to the spot's altitude.
  const url = `${ARCHIVE}?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}` +
    (Number.isFinite(elevation) ? `&elevation=${Math.round(elevation)}` : '') +
    `&start_date=${start}&end_date=${end}&daily=${DAILY}&timezone=UTC`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Open-Meteo antwortete mit HTTP ${res.status}`);
  const { daily } = await res.json();
  if (!daily?.time) throw new Error('Open-Meteo lieferte keine Tageswerte');
  return daily.time.map((t, i) => ({
    t: Date.parse(`${t}T00:00:00Z`),
    p: daily.precipitation_sum[i],
    tm: daily.temperature_2m_mean[i],
    tx: daily.temperature_2m_max[i],
    tn: daily.temperature_2m_min?.[i] ?? null,
  })).filter((d) => d.p !== null && d.tm !== null);
}

/** Mean precipitation, temperature and hot-day share per day of year, 1991–2020. */
function climatology(days) {
  const sum = Array.from({ length: 365 }, () => ({ p: 0, tm: 0, hot: 0, n: 0 }));
  for (const d of days) {
    const s = sum[doy(d.t)];
    s.p += d.p; s.tm += d.tm; s.hot += d.tx >= 30 ? 1 : 0; s.n++;
  }
  return sum.map((s) => (s.n ? [s.p / s.n, s.tm / s.n, s.hot / s.n].map((v) => Math.round(v * 1000) / 1000) : [0, 0, 0]));
}

function createWeather({ db, fetchImpl = fetch, now = () => Date.now() }) {
  db.exec('CREATE TABLE IF NOT EXISTS weather_cache (key TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at INTEGER NOT NULL)');
  const getCache = db.prepare('SELECT json, fetched_at FROM weather_cache WHERE key = ?');
  const setCache = db.prepare('INSERT OR REPLACE INTO weather_cache (key, json, fetched_at) VALUES (?, ?, ?)');

  async function cached(key, maxAgeMs, load) {
    const row = getCache.get(key);
    if (row && (maxAgeMs === Infinity || now() - row.fetched_at < maxAgeMs)) return JSON.parse(row.json);
    const value = await load();
    setCache.run(key, JSON.stringify(value), now());
    return value;
  }

  // Spots in one grid cell share data unless their altitude differs by more than ~100 m.
  const place = (lat, lon, elevation) => `${cell(lat, lon)}${Number.isFinite(elevation) ? `@${Math.round(elevation / 100) * 100}` : ''}`;
  const normals = (lat, lon, elevation) => cached(`normal:${place(lat, lon, elevation)}`, Infinity, async () =>
    climatology(await fetchDaily(lat, lon, `${NORMAL_FROM}-01-01`, `${NORMAL_TO}-12-31`, fetchImpl, elevation)));

  /**
   * Weather before `date` at (lat, lon): last 90 days, year to date and the
   * last 12 months by month, each against the 1991–2020 normal.
   */
  async function context(lat, lon, date, { elevation = null } = {}) {
    // Whole days in UTC: the archive's daily values start at midnight.
    const end = Math.floor(Math.min(date, now() - ARCHIVE_DELAY_DAYS * DAY) / DAY) * DAY;
    const start = end - 364 * DAY;
    const fresh = now() - end < 30 * DAY; // recent data may still be revised
    const [norm, days] = await Promise.all([
      normals(lat, lon, elevation),
      cached(`obs:${place(lat, lon, elevation)}:${isoDay(start)}:${isoDay(end)}`, fresh ? DAY : Infinity,
        () => fetchDaily(lat, lon, isoDay(start), isoDay(end), fetchImpl, elevation)),
    ]);
    if (!days.length) throw new Error('Keine Wetterdaten für diesen Zeitraum');

    const window = (from) => {
      const sel = days.filter((d) => d.t >= from);
      const p = sel.reduce((a, d) => a + d.p, 0);
      const pn = sel.reduce((a, d) => a + norm[doy(d.t)][0], 0);
      const tm = sel.reduce((a, d) => a + d.tm, 0) / sel.length;
      const tn = sel.reduce((a, d) => a + norm[doy(d.t)][1], 0) / sel.length;
      const hot = sel.filter((d) => d.tx >= 30).length;
      const hotNormal = sel.reduce((a, d) => a + norm[doy(d.t)][2], 0);
      let dry = 0; let run = 0;
      for (const d of sel) { run = d.p < 1 ? run + 1 : 0; dry = Math.max(dry, run); }
      const withMin = sel.filter((d) => Number.isFinite(d.tn));
      const spring = withMin.filter((d) => doy(d.t) >= LEAF_OUT_FROM && doy(d.t) <= LEAF_OUT_TO);
      const coldest = spring.reduce((m, d) => (!m || d.tn < m.tn ? d : m), null);
      const r1 = (v) => Math.round(v * 10) / 10;
      return {
        from: isoDay(sel[0].t), to: isoDay(sel[sel.length - 1].t), days: sel.length,
        precip: r1(p), precipNormal: r1(pn), precipRatio: pn > 0 ? Math.round((p / pn) * 100) / 100 : null,
        tempMean: r1(tm), tempNormal: r1(tn), tempAnomaly: r1(tm - tn),
        hotDays: hot, hotDaysNormal: r1(hotNormal), longestDrySpell: dry,
        frostNights: withMin.length ? withMin.filter((d) => d.tn < 0).length : null,
        // Nights after leaf-out cold enough for frost in a cold-air pool.
        coldNightsAfterLeafOut: spring.length ? spring.filter((d) => d.tn < COLD_NIGHT).length : null,
        coldestAfterLeafOut: coldest ? { date: isoDay(coldest.t), tmin: r1(coldest.tn) } : null,
      };
    };

    const months = new Map();
    for (const d of days) {
      const key = isoDay(d.t).slice(0, 7);
      const m = months.get(key) || { month: key, precip: 0, normal: 0, days: 0 };
      m.precip += d.p; m.normal += norm[doy(d.t)][0]; m.days++;
      months.set(key, m);
    }
    const yearStart = Date.UTC(new Date(end).getUTCFullYear(), 0, 1);
    return {
      cell: cell(lat, lon),
      elevation: Number.isFinite(elevation) ? Math.round(elevation) : null,
      until: isoDay(end),
      last90: window(end - 89 * DAY),
      yearToDate: window(yearStart),
      // Partial months at either end compare against the normal of the same days.
      monthly: [...months.values()]
        .filter((m) => m.days >= 10)
        .slice(-12)
        .map((m) => ({ month: m.month, precip: Math.round(m.precip), normal: Math.round(m.normal), days: m.days })),
      source: 'Open-Meteo.com (ERA5), Normalperiode 1991–2020',
    };
  }

  /**
   * Hourly weather of one local calendar day: measured (archive) for the
   * past, forecast for the coming ~16 days, nothing beyond. Times are
   * returned as UTC milliseconds; the day boundaries follow the location's
   * time zone.
   */
  async function day(lat, lon, date, { elevation = null } = {}) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Datum im Format JJJJ-MM-TT erwartet');
    const offset = Math.round((Date.parse(`${date}T12:00:00Z`) - now()) / DAY);
    const source = offset <= -ARCHIVE_DELAY_DAYS ? 'archive' : offset <= FORECAST_DAYS ? 'forecast' : null;
    if (!source || offset < -365 * 85) return { date, source: null, hourly: [], totals: null };
    const key = `day2:${source}:${place(lat, lon, elevation)}:${date}`;
    return cached(key, source === 'archive' ? Infinity : 3600000, async () => {
      const base = source === 'archive' ? ARCHIVE : FORECAST;
      const url = `${base}?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}` +
        (Number.isFinite(elevation) ? `&elevation=${Math.round(elevation)}` : '') +
        `&start_date=${date}&end_date=${date}&hourly=${HOURLY}&timezone=auto`;
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`Open-Meteo antwortete mit HTTP ${res.status}`);
      const body = await res.json();
      const h = body.hourly;
      if (!h?.time) throw new Error('Open-Meteo lieferte keine Stundenwerte');
      const shift = (body.utc_offset_seconds || 0) * 1000;
      const hourly = h.time.map((t, i) => ({
        t: Date.parse(`${t}:00Z`) - shift,
        precip: h.precipitation?.[i] ?? null,
        radiation: h.shortwave_radiation?.[i] ?? null,
        cloud: h.cloud_cover?.[i] ?? null,
        temp: h.temperature_2m?.[i] ?? null,
        rain: h.rain?.[i] ?? null,
        snowfall: h.snowfall?.[i] ?? null, // cm
        snowDepth: Number.isFinite(h.snow_depth?.[i]) ? Math.round(h.snow_depth[i] * 1000) / 10 : null, // m → cm
      }));
      const vals = (k) => hourly.map((x) => x[k]).filter(Number.isFinite);
      const sum = (k) => vals(k).reduce((a, b) => a + b, 0);
      const r1 = (v) => Math.round(v * 10) / 10;
      return {
        date,
        source,
        timezone: body.timezone || null,
        hourly,
        totals: {
          precip: vals('precip').length ? r1(sum('precip')) : null,
          radiationKwh: vals('radiation').length ? Math.round(sum('radiation') / 10) / 100 : null,
          cloudMean: vals('cloud').length ? Math.round(sum('cloud') / vals('cloud').length) : null,
          tmin: vals('temp').length ? r1(Math.min(...vals('temp'))) : null,
          tmax: vals('temp').length ? r1(Math.max(...vals('temp'))) : null,
          snowfall: vals('snowfall').length ? r1(sum('snowfall')) : null,
          snowDepthMax: vals('snowDepth').length ? r1(Math.max(...vals('snowDepth'))) : null,
        },
      };
    });
  }

  /**
   * Forecast for a place: the next 36 hours (from the current hour) and the
   * next seven days, in the place's time zone. Weather codes are WMO codes
   * as Open-Meteo gives them. Cached for half an hour per ~10 km cell.
   */
  async function outlook(lat, lon, { elevation = null } = {}) {
    const all = await cached(`outlook:${place(lat, lon, elevation)}`, OUTLOOK_TTL, async () => {
      const url = `${FORECAST}?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}` +
        (Number.isFinite(elevation) ? `&elevation=${Math.round(elevation)}` : '') +
        `&hourly=${OUTLOOK_HOURLY}&daily=${OUTLOOK_DAILY}&forecast_days=7&timezone=auto&wind_speed_unit=kmh`;
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`Open-Meteo antwortete mit HTTP ${res.status}`);
      const body = await res.json();
      const h = body.hourly;
      const d = body.daily;
      if (!h?.time || !d?.time) throw new Error('Open-Meteo lieferte keine Vorhersage');
      const shift = (body.utc_offset_seconds || 0) * 1000;
      const at = (arr, i) => (Number.isFinite(arr?.[i]) ? arr[i] : null);
      const hourly = h.time.map((t, i) => ({
        t: Date.parse(`${t}:00Z`) - shift,
        temp: at(h.temperature_2m, i),
        precip: at(h.precipitation, i),
        prob: at(h.precipitation_probability, i),
        snowfall: at(h.snowfall, i),
        code: at(h.weather_code, i),
        wind: at(h.wind_speed_10m, i),
        dir: at(h.wind_direction_10m, i),
        gust: at(h.wind_gusts_10m, i),
        day: h.is_day ? h.is_day[i] === 1 : null,
      }));
      const daily = d.time.map((date, i) => ({
        date,
        code: at(d.weather_code, i),
        tmax: at(d.temperature_2m_max, i),
        tmin: at(d.temperature_2m_min, i),
        precip: at(d.precipitation_sum, i),
        prob: at(d.precipitation_probability_max, i),
        snowfall: at(d.snowfall_sum, i),
        gust: at(d.wind_gusts_10m_max, i),
        sunHours: Number.isFinite(d.sunshine_duration?.[i]) ? Math.round(d.sunshine_duration[i] / 360) / 10 : null,
      }));
      return { timezone: body.timezone || null, issued: now(), hourly, daily, source: 'Open-Meteo.com (Wettermodelle der Wetterdienste, u. a. MeteoSchweiz und DWD)' };
    });
    // From the current hour on, also when the cached forecast is up to half an hour old.
    const hour = Math.floor(now() / 3600000) * 3600000;
    return { ...all, hourly: all.hourly.filter((r) => r.t >= hour).slice(0, OUTLOOK_HOURS) };
  }

  return { context, day, outlook };
}

module.exports = { createWeather, doy, climatology };
