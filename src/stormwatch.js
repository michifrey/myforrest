'use strict';

/**
 * Storm warnings from the forecast, and a reminder to visit the spots after
 * the storm.
 *
 * Every few hours (STURM_WARN_HOURS, default 3; 0 = off) the forecast of the
 * daily maximum gust for the next three days is fetched for every 0.1° cell
 * with spots, from a finely resolved model (STURM_MODELL, default
 * icon_seamless: ICON-D2 at ~2 km for the first two days, then ICON-EU; via
 * Open-Meteo, several cells per request). A day with gusts of at least
 * STORM_GUST (75 km/h, Beaufort 9) becomes a warning:
 *
 *   1. Before the storm: one push message to the people who follow a spot
 *      in the cell or photograph it regularly (push.recipients), grouped per
 *      person – with the advice to go only when it is safe again.
 *   2. After the storm (from the next day on): the measured gusts of that
 *      day (storms.between, ERA5 or the forecast API's recent past) decide.
 *      If the storm came, a second message asks to photograph the spots now;
 *      if it did not, the warning is closed without a message.
 *
 * The public list (GET /api/storm-warnings) names cells, days and gusts, not
 * spots: the app matches its own visible spots to the cells.
 */

const { STORM_GUST, beaufort, compass16 } = require('./storms');

const DAY = 86400000;
const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const FORECAST_DAYS = 3;
const BATCH = 50; // places per Open-Meteo request
const CONFIRM_GIVE_UP_DAYS = 5;
const LIST_DAYS_AFTER = 7; // "visit after the storm" stays on the list this long

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS storm_warnings (
    cell          TEXT NOT NULL,          -- "47.4,8.6": spots rounded to 0.1°
    date          TEXT NOT NULL,          -- UTC day of the forecast peak
    gust          REAL NOT NULL,          -- forecast maximum gust, km/h
    dir           REAL,                   -- dominant wind direction, °
    model         TEXT,
    first_seen    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    warned_at     INTEGER,                -- message before the storm sent
    outcome       TEXT NOT NULL DEFAULT 'offen' CHECK (outcome IN ('offen', 'bestaetigt', 'ausgeblieben', 'unbekannt')),
    observed_gust REAL,
    after_sent_at INTEGER,                -- message after the storm sent
    PRIMARY KEY (cell, date)
  );
`;

const cellKey = (lat, lon) => `${lat.toFixed(1)},${lon.toFixed(1)}`;
const isoDay = (t) => new Date(t).toISOString().slice(0, 10);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const dayDe = (iso) => {
  const d = new Date(`${iso}T12:00:00Z`);
  return `${['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][d.getUTCDay()]} ${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;
};

function createStormWatch({ db, fetchImpl = fetch, now = () => Date.now(), push = null, storms = null,
  model = process.env.STURM_MODELL ?? 'icon_seamless', threshold = STORM_GUST } = {}) {
  db.exec(SCHEMA);
  const upsert = db.prepare(`INSERT INTO storm_warnings (cell, date, gust, dir, model, first_seen, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (cell, date) DO UPDATE SET gust = MAX(gust, excluded.gust), dir = excluded.dir, model = excluded.model, updated_at = excluded.updated_at`);

  /** Spots per cell: Map(cell → [{ id, lat, lon }]). */
  function spotCells() {
    const out = new Map();
    for (const s of db.prepare('SELECT id, lat, lon FROM spots').all()) {
      const k = cellKey(s.lat, s.lon);
      if (!out.has(k)) out.set(k, []);
      out.get(k).push(s);
    }
    return out;
  }

  /** Forecast daily gusts for the cells: Map(cell → [{ date, gust, dir }]). */
  async function forecast(cells) {
    const out = new Map();
    for (let i = 0; i < cells.length; i += BATCH) {
      const batch = cells.slice(i, i + BATCH);
      const lats = batch.map((c) => c.split(',')[0]).join(',');
      const lons = batch.map((c) => c.split(',')[1]).join(',');
      const url = `${FORECAST}?latitude=${lats}&longitude=${lons}&daily=wind_gusts_10m_max,wind_direction_10m_dominant`
        + `&forecast_days=${FORECAST_DAYS}&timezone=UTC&wind_speed_unit=kmh${model && model !== 'best_match' ? `&models=${encodeURIComponent(model)}` : ''}`;
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`Open-Meteo antwortete mit HTTP ${res.status}`);
      const body = await res.json();
      const list = Array.isArray(body) ? body : [body];
      batch.forEach((cell, j) => {
        const d = list[j]?.daily;
        if (!d?.time) return;
        // Model names may be suffixed (wind_gusts_10m_max_icon_seamless) when several are asked for.
        const col = (name) => d[name] || d[Object.keys(d).find((k) => k.startsWith(`${name}_`))] || [];
        const gusts = col('wind_gusts_10m_max');
        const dirs = col('wind_direction_10m_dominant');
        out.set(cell, d.time.map((date, k) => ({ date, gust: gusts[k], dir: dirs[k] })).filter((x) => Number.isFinite(x.gust)));
      });
    }
    return out;
  }

  /** Recipients of a set of spots: Map(userId → [spotId, …]). */
  function recipientsOf(spotIds) {
    const out = new Map();
    for (const id of spotIds) {
      for (const userId of push.recipients(id).keys()) {
        if (!out.has(userId)) out.set(userId, []);
        out.get(userId).push(id);
      }
    }
    return out;
  }
  const spotList = (ids) => (ids.length === 1 ? `Spot ${ids[0]}` : `${ids.length} Spots (${ids.slice(0, 4).map((id) => id).join(', ')}${ids.length > 4 ? ', …' : ''})`);

  /** One message per person for a set of warnings, built by `text(warnings, spotIds)`. */
  async function notify(rows, cells, text) {
    if (!push) return 0;
    const perUser = new Map(); // userId → { rows: Set, spots: [] }
    for (const w of rows) {
      for (const [userId, ids] of recipientsOf((cells.get(w.cell) || []).map((s) => s.id))) {
        if (!perUser.has(userId)) perUser.set(userId, { rows: new Set(), spots: [] });
        const e = perUser.get(userId);
        e.rows.add(w);
        for (const id of ids) if (!e.spots.includes(id)) e.spots.push(id);
      }
    }
    let sent = 0;
    for (const [userId, e] of perUser) {
      const message = text([...e.rows], e.spots.sort((a, b) => a - b));
      try { sent += (await push.send(userId, message)) > 0 ? 1 : 0; } catch { /* the next person still gets theirs */ }
    }
    return sent;
  }

  async function run() {
    const t = now();
    const today = isoDay(t);
    const cells = spotCells();
    const result = { cells: cells.size, warnings: 0, warned: 0, confirmed: 0, calm: 0, after: 0 };
    if (!cells.size) return result;

    // 1. Forecast → warnings.
    const fc = await forecast([...cells.keys()]);
    for (const [cell, days] of fc) {
      for (const d of days) {
        if (d.date < today || d.gust < threshold) continue;
        upsert.run(cell, d.date, Math.round(d.gust), Number.isFinite(d.dir) ? Math.round(d.dir) : null, model || null, t, t);
      }
    }
    const fresh = db.prepare("SELECT * FROM storm_warnings WHERE warned_at IS NULL AND date >= ? AND outcome = 'offen'").all(today);
    result.warnings = fresh.length;
    result.warned = await notify(fresh, cells, (rows, ids) => {
      const top = rows.reduce((a, b) => (b.gust > a.gust ? b : a));
      const dates = [...new Set(rows.map((w) => w.date))].sort();
      return {
        title: `Sturmwarnung: Böen bis ${top.gust} km/h`,
        body: `${cap(beaufort(top.gust).label)} ${dates.length === 1 ? `am ${dayDe(dates[0])}` : `von ${dayDe(dates[0])} bis ${dayDe(dates.at(-1))}`}`
          + ` bei ${spotList(ids)}. Nach dem Sturm hilft ein Foto – aber erst hingehen, wenn es sicher ist.`,
        url: ids.length === 1 ? `./?spot=${ids[0]}` : './?filter=sturm',
        tag: 'sturm',
      };
    });
    const markWarned = db.prepare('UPDATE storm_warnings SET warned_at = ? WHERE cell = ? AND date = ?');
    for (const w of fresh) markWarned.run(t, w.cell, w.date);

    // 2. After the storm: did it come?
    const due = db.prepare("SELECT * FROM storm_warnings WHERE outcome = 'offen' AND date < ?").all(today);
    const confirmed = [];
    const setOutcome = db.prepare('UPDATE storm_warnings SET outcome = ?, observed_gust = ? WHERE cell = ? AND date = ?');
    for (const w of due) {
      const [lat, lon] = w.cell.split(',').map(Number);
      const from = Date.parse(`${w.date}T00:00:00Z`);
      let events = null;
      try {
        // A day either side: the peak may fall a day off the forecast.
        events = storms ? await storms.between(lat, lon, from - DAY, from + 2 * DAY, { threshold }) : null;
      } catch {
        events = null;
      }
      if (events === null) {
        if (t - from > CONFIRM_GIVE_UP_DAYS * DAY) setOutcome.run('unbekannt', null, w.cell, w.date);
        continue;
      }
      const peak = events.reduce((a, b) => (!a || b.gust > a.gust ? b : a), null);
      if (peak) {
        setOutcome.run('bestaetigt', Math.round(peak.gust), w.cell, w.date);
        confirmed.push({ ...w, observed_gust: Math.round(peak.gust) });
        result.confirmed += 1;
      } else {
        setOutcome.run('ausgeblieben', null, w.cell, w.date);
        result.calm += 1;
      }
    }
    result.after = await notify(confirmed, cells, (rows, ids) => {
      const top = rows.reduce((a, b) => (b.observed_gust > a.observed_gust ? b : a));
      return {
        title: 'Nach dem Sturm: Spots besuchen',
        body: `Am ${dayDe(top.date)} gab es Böen bis ${top.observed_gust} km/h bei ${spotList(ids)}. Ein Foto zeigt jetzt, was der Wind`
          + ' angerichtet hat. Bitte erst gehen, wenn Wege freigegeben sind, und Abstand zu angeschobenen Bäumen halten.',
        url: ids.length === 1 ? `./?spot=${ids[0]}` : './?filter=sturm',
        tag: 'sturm',
      };
    });
    const markAfter = db.prepare('UPDATE storm_warnings SET after_sent_at = ? WHERE cell = ? AND date = ?');
    for (const w of confirmed) markAfter.run(t, w.cell, w.date);
    return result;
  }

  /** Warnings for the app: coming storms and storms of the last days whose spots want a visit. */
  function list() {
    const t = now();
    const today = isoDay(t);
    const since = isoDay(t - LIST_DAYS_AFTER * DAY);
    return db.prepare(`SELECT cell, date, gust, dir, outcome, observed_gust FROM storm_warnings
      WHERE (date >= ? AND outcome = 'offen') OR (date >= ? AND outcome = 'bestaetigt') ORDER BY date, cell`).all(today, since)
      .map((w) => {
        const [lat, lon] = w.cell.split(',').map(Number);
        const gust = w.outcome === 'bestaetigt' ? w.observed_gust : w.gust;
        return {
          cell: w.cell, lat, lon, date: w.date, gust, from16: Number.isFinite(w.dir) ? compass16(w.dir) : null,
          label: beaufort(gust).label, phase: w.outcome === 'bestaetigt' ? 'nachher' : 'vorher',
        };
      });
  }

  return { run, list, forecast, model: model || 'best_match', threshold };
}

module.exports = { createStormWatch, cellKey };
