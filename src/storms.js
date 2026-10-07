'use strict';

/*
 * Storm events at a spot from daily maximum wind gusts (Open-Meteo: ERA5
 * archive, forecast API for the last days). A day with gusts of at least
 * 75 km/h (Beaufort 9, "Sturmböen" in the DWD warning scale) counts as a
 * storm day; consecutive storm days form one event. Windthrow found between
 * two photos is linked to the strongest storm in that interval.
 *
 * ERA5 has a ~25–30 km grid and smooths gust peaks, especially on ridges and
 * in thunderstorm gusts; the values are a lower bound for what hit the spot.
 */

const { series, openCache, isoDay, dayStart, DAY } = require('./openmeteo');

const STORM_GUST = 75; // km/h
const KEEP_GUST = 62; // km/h, Beaufort 8: kept in the cache so the threshold can be lowered
const CURRENT_MAX_AGE = 6 * 3600000;
const DAILY = ['wind_gusts_10m_max', 'wind_speed_10m_max', 'wind_direction_10m_dominant'];

// Gust classes of the DWD warning scale (km/h lower bounds).
const BEAUFORT = [
  [118, 12, 'Orkanböen'],
  [103, 11, 'orkanartige Böen'],
  [89, 10, 'schwere Sturmböen'],
  [75, 9, 'Sturmböen'],
  [62, 8, 'stürmische Böen'],
  [50, 7, 'steife Böen'],
];
function beaufort(kmh) {
  if (!Number.isFinite(kmh)) return null;
  const hit = BEAUFORT.find(([min]) => kmh >= min);
  return hit ? { bft: hit[1], label: hit[2] } : { bft: Math.max(0, Math.min(6, Math.round(Math.cbrt((kmh / 3.6 / 0.836) ** 2)))), label: 'Wind' };
}

const COMPASS16 = ['N', 'NNO', 'NO', 'ONO', 'O', 'OSO', 'SO', 'SSO', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
/** "WSW" for a direction the wind comes from (° clockwise from north). */
const compass16 = (deg) => (Number.isFinite(deg) ? COMPASS16[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16] : null);

const fmtDay = (iso) => {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
};

/**
 * Storm events from daily rows `{ date, gust, dir }`: consecutive days at or
 * above `threshold` merge into one event, described by its peak day.
 */
function detectStorms(days, { threshold = STORM_GUST } = {}) {
  const events = [];
  let current = null;
  let lastT = null;
  for (const d of [...days].sort((a, b) => a.date.localeCompare(b.date))) {
    if (!(d.gust >= threshold)) continue;
    const t = Date.parse(`${d.date}T00:00:00Z`);
    if (current && t - lastT <= DAY) {
      current.to = d.date;
      current.days++;
      if (d.gust > current.gust) Object.assign(current, { date: d.date, gust: d.gust, dir: d.dir });
    } else {
      current = { date: d.date, from: d.date, to: d.date, days: 1, gust: d.gust, dir: d.dir };
      events.push(current);
    }
    lastT = t;
  }
  return events.map((e) => {
    const b = beaufort(e.gust);
    return { ...e, gust: Math.round(e.gust), dir: Number.isFinite(e.dir) ? Math.round(e.dir) : null, from16: compass16(e.dir), bft: b.bft, class: b.label };
  });
}

/** Strongest storm with its peak in (from, to], both ms; null when none. */
function likelyStorm(events, from, to) {
  const inside = events.filter((e) => {
    const t = Date.parse(`${e.date}T12:00:00Z`);
    return t > from && t <= to + DAY / 2;
  });
  return inside.reduce((m, e) => (!m || e.gust > m.gust ? e : m), null);
}

/** "Sturm am 12.03.2026, Böen 104 km/h aus WSW" */
function stormText(e) {
  const kind = e.bft >= 12 ? 'Orkan' : 'Sturm';
  return `${kind} am ${fmtDay(e.date)}, Böen ${e.gust} km/h${e.from16 ? ` aus ${e.from16}` : ''}`;
}

/** Trees thrown by a storm mostly fall downwind. */
const downwind = (e) => (Number.isFinite(e.dir) ? compass16(e.dir + 180) : null);

/**
 * Irregularities for one photo: storms in the interval since the last
 * photo without windthrow, linked to windthrow when present.
 */
function stormIrregularities({ events, interval, windthrow = false, landform = null }) {
  if (!events || !interval) return [];
  const from = Date.parse(interval.from);
  const to = Date.parse(interval.to);
  const inside = events.filter((e) => {
    const t = Date.parse(`${e.date}T12:00:00Z`);
    return t > from && t <= to + DAY / 2;
  });
  const span = `${fmtDay(isoDay(from))} und ${fmtDay(isoDay(to))}`;
  const likely = likelyStorm(events, from, to);
  const ridge = landform === 'kuppe' ? ' Die Kuppenlage ist dem Wind zusätzlich ausgesetzt.' : '';
  if (windthrow && likely) {
    const fall = downwind(likely);
    return [{
      type: 'sturm_windwurf',
      severity: likely.bft >= 11 ? 'stark' : 'auffällig',
      title: 'Windwurf nach Sturm',
      text: `Zwischen ${span} zeigt das Wettermodell ${inside.length === 1 ? 'ein Sturmereignis' : `${inside.length} Sturmereignisse`} mit Böen ab ${STORM_GUST} km/h. ` +
        `Vermutlich ${stormText(likely)} (${likely.class}, Beaufort ${likely.bft}).` +
        (fall ? ` Geworfene Bäume liegen meist in Windrichtung, hier also Richtung ${fall}.` : '') +
        ridge +
        ' Modellböen (Raster ~25 km) unterschätzen lokale Spitzen eher.',
      suggestedTag: 'sturmschaden',
      storm: likely,
    }];
  }
  if (windthrow) {
    return [{
      type: 'windwurf_ohne_sturm',
      severity: 'hinweis',
      title: 'Windwurf ohne Sturm im Modell',
      text: `Zwischen ${span} zeigt das Wettermodell keine Böen ab ${STORM_GUST} km/h. ` +
        'Liegende Stämme können auch von Holzschlag, Schnee- oder Eisbruch, Fäulnis oder einer lokalen Gewitterböe stammen, die das grobe Modellraster nicht erfasst.',
    }];
  }
  if (likely) {
    return [{
      type: 'sturm',
      severity: likely.bft >= 11 ? 'auffällig' : 'hinweis',
      title: inside.length === 1 ? 'Sturm vor der Aufnahme' : `${inside.length} Stürme vor der Aufnahme`,
      text: `Zwischen ${span}: ${stormText(likely)} (${likely.class}, Beaufort ${likely.bft})` +
        (inside.length > 1 ? `, dazu ${inside.length - 1} ${inside.length === 2 ? 'weiteres Ereignis' : 'weitere Ereignisse'}` : '') +
        '. Auf Windwurf, abgebrochene Kronen und angeschobene Bäume achten.' + ridge,
      storm: likely,
    }];
  }
  return [];
}

function createStorms({ db, fetchImpl = fetch, now = () => Date.now() }) {
  const cached = openCache(db, now);
  const getRow = db.prepare('SELECT json, fetched_at FROM weather_cache WHERE key = ?');
  const cell = (lat, lon) => `${lat.toFixed(1)},${lon.toFixed(1)}`;
  const keyOf = (lat, lon, year) => `storm:${cell(lat, lon)}:${year}`;

  /** Windy days (gusts ≥ 62 km/h) of one calendar year at the cell, as compact rows. */
  async function year(lat, lon, y) {
    const key = keyOf(lat, lon, y);
    const row = getRow.get(key);
    if (row) {
      const v = JSON.parse(row.json);
      if (v.complete || now() - row.fetched_at < CURRENT_MAX_AGE) return v;
    }
    return cached(key, 0, async () => {
      const today = dayStart(now());
      const end = Math.min(Date.UTC(y, 11, 31), today);
      const s = await series({
        lat, lon, start: `${y}-01-01`, end: isoDay(end), kind: 'daily', vars: DAILY,
        extra: '&timezone=UTC&wind_speed_unit=kmh', fetchImpl, now,
      });
      const days = s.time.map((t, i) => ({ date: t, gust: s.wind_gusts_10m_max[i], dir: s.wind_direction_10m_dominant[i], wmax: s.wind_speed_10m_max[i] }))
        .filter((d) => d.gust >= KEEP_GUST)
        .map((d) => [d.date, Math.round(d.gust), Number.isFinite(d.dir) ? Math.round(d.dir) : null, Number.isFinite(d.wmax) ? Math.round(d.wmax) : null]);
      return { complete: Date.UTC(y, 11, 31) < today - 7 * DAY, days };
    });
  }

  const rowsToDays = (rows) => rows.map(([date, gust, dir, wmax]) => ({ date, gust, dir, wmax }));
  const years = (from, to) => {
    const ys = [];
    const last = new Date(Math.min(to, now())).getUTCFullYear();
    for (let y = new Date(from).getUTCFullYear(); y <= last; y++) ys.push(y);
    return ys;
  };
  const clip = (events, from, to) => events.filter((e) => {
    const t = Date.parse(`${e.date}T00:00:00Z`);
    return t >= dayStart(from) && t <= to;
  });

  /** Storm events between two times (ms), fetched as needed. */
  async function between(lat, lon, from, to, opts = {}) {
    const days = [];
    for (const y of years(from, to)) days.push(...rowsToDays((await year(lat, lon, y)).days));
    return clip(detectStorms(days, opts), from, to);
  }

  /** Same from the cache only: null if a year is missing (no network). */
  function cachedBetween(lat, lon, from, to, opts = {}) {
    const days = [];
    for (const y of years(from, to)) {
      const row = getRow.get(keyOf(lat, lon, y));
      if (!row) return null;
      days.push(...rowsToDays(JSON.parse(row.json).days));
    }
    return clip(detectStorms(days, opts), from, to);
  }

  return { between, cachedBetween };
}

module.exports = {
  createStorms, detectStorms, likelyStorm, stormText, stormIrregularities, beaufort, compass16, STORM_GUST,
};
