'use strict';

/*
 * Weather context for a spot and date from Open-Meteo's historical archive
 * (ERA5 reanalysis, free, no API key, CC BY 4.0): what fell and how warm it
 * was before a photo was taken, compared with the 1991–2020 normal for the
 * same place and season.
 */

const ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
const DAILY = 'precipitation_sum,temperature_2m_mean,temperature_2m_max';
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
      const r1 = (v) => Math.round(v * 10) / 10;
      return {
        from: isoDay(sel[0].t), to: isoDay(sel[sel.length - 1].t), days: sel.length,
        precip: r1(p), precipNormal: r1(pn), precipRatio: pn > 0 ? Math.round((p / pn) * 100) / 100 : null,
        tempMean: r1(tm), tempNormal: r1(tn), tempAnomaly: r1(tm - tn),
        hotDays: hot, hotDaysNormal: r1(hotNormal), longestDrySpell: dry,
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

  return { context };
}

module.exports = { createWeather, doy, climatology };
