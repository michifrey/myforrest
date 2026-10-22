'use strict';

/*
 * Climate change in the region of a spot or a map position ("Klima im Wandel"):
 * pure computations, without network or database (those are in routes/klima.js).
 *
 *   - Yearly indicators from daily values (ERA5 via Open-Meteo, 1940 to the
 *     last complete year): mean temperature, precipitation, hot days (max ≥ 30 °C),
 *     summer days (≥ 25 °C), tropical nights (min ≥ 20 °C), frost days (min < 0 °C),
 *     ice days (max < 0 °C), snowfall and days with snowfall, days with a mean
 *     of at least 5 °C (growing days), the longest dry spell, summer (JJA) and
 *     winter (DJF) temperature and precipitation.
 *   - Warming stripes and trends against 1961–1990, the reference MeteoSchweiz
 *     uses for its climate stripes, and the 1991–2020 normal.
 *   - Homogeneous series of MeteoSchweiz (NBCN, from 1864), read from the open
 *     data files (stations description and yearly values per station) or a
 *     plain CSV.
 *   - Projections: the change between 1991–2020 and 2031–2050 in each climate
 *     model (Open-Meteo climate API, CMIP6 HighResMIP), added to the observed
 *     normal (delta method), with the spread of the models; or the change for
 *     a global warming level from CH2025, loaded as a CSV.
 *   - The synthesis: statements that put the observations of MyForrest in the
 *     region (drought and heat notes, early colouring, storms, summer NDVI,
 *     snow melt, phenology) next to the climate of the same years.
 */

const REF = [1961, 1990]; // reference of the warming stripes (MeteoSchweiz)
const NORMAL = [1991, 2020]; // climate normal, also the reference of the projections
const PREINDUSTRIAL = [1871, 1900]; // MeteoSchweiz' pre-industrial reference (homogeneous series only)
const FUTURE = [2031, 2050]; // projection window around 2040
const RECENT_YEARS = 10;
const MIN_DAYS = 360; // a year counts when it is (almost) complete
const BEETLE_BASE = 8.3; // °C, development threshold of Ips typographus (PHENIPS)
const BEETLE_DD = 557; // degree days for one generation (PHENIPS)

// Indicators: label, unit, decimals; `kind` says how a projected change is applied.
const INDICATORS = {
  tmean: { label: 'Jahresmitteltemperatur', unit: '°C', digits: 1, kind: 'add' },
  hotDays: { label: 'Hitzetage (≥ 30 °C)', unit: 'Tage', digits: 0, kind: 'count' },
  summerDays: { label: 'Sommertage (≥ 25 °C)', unit: 'Tage', digits: 0, kind: 'count' },
  tropicalNights: { label: 'Tropennächte (≥ 20 °C)', unit: 'Nächte', digits: 0, kind: 'count' },
  frostDays: { label: 'Frosttage (< 0 °C)', unit: 'Tage', digits: 0, kind: 'count' },
  iceDays: { label: 'Eistage (Höchstwert < 0 °C)', unit: 'Tage', digits: 0, kind: 'count' },
  growingDays: { label: 'Vegetationstage (Mittel ≥ 5 °C)', unit: 'Tage', digits: 0, kind: 'count' },
  snowDays: { label: 'Tage mit Neuschnee (≥ 1 cm)', unit: 'Tage', digits: 0, kind: 'count' },
  snowfall: { label: 'Neuschnee pro Jahr', unit: 'cm', digits: 0, kind: 'ratio' },
  precip: { label: 'Jahresniederschlag', unit: 'mm', digits: 0, kind: 'ratio' },
  dryRun: { label: 'Längste Trockenphase', unit: 'Tage', digits: 0, kind: 'count' },
  summerT: { label: 'Sommertemperatur (Jun–Aug)', unit: '°C', digits: 1, kind: 'add' },
  summerP: { label: 'Sommerniederschlag (Jun–Aug)', unit: 'mm', digits: 0, kind: 'ratio' },
  winterT: { label: 'Wintertemperatur (Dez–Feb)', unit: '°C', digits: 1, kind: 'add' },
  winterP: { label: 'Winterniederschlag (Dez–Feb)', unit: 'mm', digits: 0, kind: 'ratio' },
  // Warmth for the spruce bark beetle: degree days above 8.3 °C, April–September, from the daily mean air
  // temperature (PHENIPS needs ~557 per generation; bark in the sun is warmer, so this is a lower bound).
  beetleDD: { label: 'Wärmesumme Borkenkäfer (Apr–Sep, über 8,3 °C)', unit: '°C-Tage', digits: 0, kind: 'add' },
};

const round = (v, d = 1) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const mean = (xs) => {
  const v = xs.filter(Number.isFinite);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const median = (xs) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

/**
 * Yearly indicators from daily values: `daily` holds parallel arrays like
 * Open-Meteo's response (`time` as YYYY-MM-DD, `temperature_2m_mean`, `_max`,
 * `_min`, `precipitation_sum`, `snowfall_sum` in cm). Returns complete years
 * only, ascending: [{ year, tmean, hotDays, … }]. December counts to the next
 * year's winter; a winter needs its December.
 */
function yearlyIndicators(daily) {
  const col = (k) => daily[k] || [];
  const tm = col('temperature_2m_mean');
  const tx = col('temperature_2m_max');
  const tn = col('temperature_2m_min');
  const p = col('precipitation_sum');
  const sn = col('snowfall_sum');
  const years = new Map();
  const get = (y) => {
    if (!years.has(y)) {
      years.set(y, {
        days: 0, tm: [], hot: 0, summer: 0, tropical: 0, frost: 0, ice: 0, grow: 0, snowDays: 0, snow: 0, snowN: 0,
        p: 0, pN: 0, dry: 0, run: 0, sT: [], sP: 0, sPN: 0, wT: [], wP: 0, wPN: 0, wDec: 0, dd: 0, ddN: 0,
      });
    }
    return years.get(y);
  };
  const time = col('time');
  for (let i = 0; i < time.length; i++) {
    const y = Number(time[i].slice(0, 4));
    const m = Number(time[i].slice(5, 7));
    const a = get(y);
    a.days++;
    const [mean_, max, min, rain, snow] = [tm[i], tx[i], tn[i], p[i], sn[i]];
    if (Number.isFinite(mean_)) {
      a.tm.push(mean_);
      if (mean_ >= 5) a.grow++;
    }
    if (Number.isFinite(max)) {
      if (max >= 30) a.hot++;
      if (max >= 25) a.summer++;
      if (max < 0) a.ice++;
    }
    if (Number.isFinite(min)) {
      if (min >= 20) a.tropical++;
      if (min < 0) a.frost++;
    }
    if (Number.isFinite(rain)) {
      a.p += rain;
      a.pN++;
      a.run = rain < 1 ? a.run + 1 : 0;
      a.dry = Math.max(a.dry, a.run);
    }
    if (Number.isFinite(snow)) {
      a.snow += snow;
      a.snowN++;
      if (snow >= 1) a.snowDays++;
    }
    if (m >= 4 && m <= 9 && Number.isFinite(mean_)) {
      a.dd += Math.max(0, mean_ - BEETLE_BASE);
      a.ddN++;
    }
    if (m >= 6 && m <= 8) {
      if (Number.isFinite(mean_)) a.sT.push(mean_);
      if (Number.isFinite(rain)) { a.sP += rain; a.sPN++; }
    }
    // Winter December–February belongs to the year of its January.
    const w = m === 12 ? get(y + 1) : m <= 2 ? a : null;
    if (w) {
      if (Number.isFinite(mean_)) w.wT.push(mean_);
      if (Number.isFinite(rain)) { w.wP += rain; w.wPN++; }
      if (m === 12) w.wDec++;
    }
  }
  const out = [];
  for (const [year, a] of [...years.entries()].sort((x, y) => x[0] - y[0])) {
    if (a.days < MIN_DAYS || a.tm.length < MIN_DAYS) continue;
    const rainOk = a.pN >= MIN_DAYS;
    out.push({
      year,
      tmean: round(mean(a.tm), 2),
      hotDays: a.hot,
      summerDays: a.summer,
      tropicalNights: a.tropical,
      frostDays: a.frost,
      iceDays: a.ice,
      growingDays: a.grow,
      snowDays: a.snowN >= MIN_DAYS ? a.snowDays : null,
      snowfall: a.snowN >= MIN_DAYS ? round(a.snow, 0) : null,
      precip: rainOk ? round(a.p, 0) : null,
      dryRun: rainOk ? a.dry : null,
      summerT: a.sT.length >= 85 ? round(mean(a.sT), 2) : null,
      summerP: a.sPN >= 85 ? round(a.sP, 0) : null,
      winterT: a.wDec >= 28 && a.wT.length >= 85 ? round(mean(a.wT), 2) : null,
      winterP: a.wDec >= 28 && a.wPN >= 85 ? round(a.wP, 0) : null,
      beetleDD: a.ddN >= 180 ? round(a.dd, 0) : null,
    });
  }
  return out;
}

const inPeriod = (rows, [from, to]) => rows.filter((r) => r.year >= from && r.year <= to);

/** Mean of each indicator over a period (null when fewer than half the years have it). */
function periodMeans(rows, period) {
  const sel = inPeriod(rows, period);
  const need = Math.max(1, Math.floor((period[1] - period[0] + 1) / 2));
  const out = { from: period[0], to: period[1], years: sel.length };
  for (const k of Object.keys(INDICATORS)) {
    const v = sel.map((r) => r[k]).filter(Number.isFinite);
    out[k] = v.length >= need ? round(mean(v), INDICATORS[k].digits + 1) : null;
  }
  return out;
}

/** Least-squares slope of `key` over the years from `from`, per decade; null with fewer than 15 years. */
function trend(rows, key, from = REF[0]) {
  const pts = rows.filter((r) => r.year >= from && Number.isFinite(r[key])).map((r) => [r.year, r[key]]);
  if (pts.length < 15) return null;
  const mx = mean(pts.map((q) => q[0]));
  const my = mean(pts.map((q) => q[1]));
  let sxy = 0; let sxx = 0;
  for (const [x, y] of pts) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; }
  return sxx ? (sxy / sxx) * 10 : null;
}

/** Temperature anomalies against a reference period: [{ year, anomaly }] (the warming stripes). */
function stripes(rows, key = 'tmean', ref = REF) {
  const base = mean(inPeriod(rows, ref).map((r) => r[key]));
  if (!Number.isFinite(base)) return [];
  return rows.filter((r) => Number.isFinite(r[key])).map((r) => ({ year: r.year, value: r[key], anomaly: round(r[key] - base, 2) }));
}

/** The `n` years with the highest (or lowest) value of `key`, as [{ year, value }]. */
function ranked(rows, key, n = 5, dir = 'desc') {
  return rows.filter((r) => Number.isFinite(r[key]))
    .sort((a, b) => (dir === 'desc' ? b[key] - a[key] : a[key] - b[key]) || b.year - a.year)
    .slice(0, n).map((r) => ({ year: r.year, value: r[key] }));
}

/**
 * Climate of a place from its yearly indicators: stripes, the means of
 * 1961–1990, 1991–2020 and the last ten years, the change between the
 * reference and today per indicator, trends and record years.
 */
function climateSummary(rows) {
  if (!rows.length) return null;
  const last = rows[rows.length - 1].year;
  const recentPeriod = [last - RECENT_YEARS + 1, last];
  const ref = periodMeans(rows, REF);
  const normal = periodMeans(rows, NORMAL);
  const recent = periodMeans(rows, recentPeriod);
  const changes = Object.entries(INDICATORS).map(([key, ind]) => {
    const then = ref[key];
    const now = recent[key];
    const delta = Number.isFinite(then) && Number.isFinite(now) ? now - then : null;
    return {
      key, label: ind.label, unit: ind.unit,
      ref: round(then, ind.digits), normal: round(normal[key], ind.digits), recent: round(now, ind.digits),
      delta: round(delta, ind.digits),
      percent: ind.kind === 'ratio' && then ? round((delta / then) * 100, 0) : null,
      trend: round(trend(rows, key), ind.digits + 1),
    };
  });
  return {
    first: rows[0].year,
    last,
    periods: { ref: REF, normal: NORMAL, recent: recentPeriod },
    warming: changes.find((c) => c.key === 'tmean').delta,
    trendPerDecade: round(trend(rows, 'tmean'), 2),
    stripes: stripes(rows),
    changes,
    records: {
      warmest: ranked(rows, 'tmean'),
      hottestSummers: ranked(rows, 'summerT'),
      driestSummers: ranked(rows, 'summerP', 5, 'asc'),
      mostHotDays: ranked(rows, 'hotDays'),
    },
  };
}

/* ---------- Projections ---------- */

/**
 * Projection by the delta method: for each model the change of each
 * indicator between 1991–2020 and 2031–2050 (absolute for temperatures and
 * counts, relative for precipitation and snowfall), applied to the observed
 * 1991–2020 mean. `models`: { name: yearlyIndicators(...) }. Returns per
 * indicator the observed normal, the median and range of the projections
 * and the median change.
 */
function projectDelta(observedRows, models, { normal = NORMAL, future = FUTURE } = {}) {
  const obs = periodMeans(observedRows, normal);
  const names = Object.keys(models).filter((m) => models[m]?.length);
  if (!names.length) return null;
  const perModel = names.map((name) => ({ name, ref: periodMeans(models[name], normal), fut: periodMeans(models[name], future) }));
  const indicators = Object.entries(INDICATORS).map(([key, ind]) => {
    const values = [];
    const deltas = [];
    for (const m of perModel) {
      const a = m.ref[key];
      const b = m.fut[key];
      const base = obs[key];
      if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(base)) continue;
      let v;
      if (ind.kind === 'ratio') v = a > 0 ? base * (b / a) : base;
      else if (ind.kind === 'count') v = Math.min(366, Math.max(0, base + (b - a)));
      else v = base + (b - a);
      values.push(v);
      deltas.push(v - base);
    }
    if (!values.length) return null;
    return {
      key, label: ind.label, unit: ind.unit,
      normal: round(obs[key], ind.digits),
      value: round(median(values), ind.digits),
      low: round(Math.min(...values), ind.digits),
      high: round(Math.max(...values), ind.digits),
      delta: round(median(deltas), ind.digits),
      percent: ind.kind === 'ratio' && obs[key] ? round((median(deltas) / obs[key]) * 100, 0) : null,
      models: values.length,
    };
  }).filter(Boolean);
  return { normal, future, models: names, indicators };
}

/** Model series for the chart: yearly mean temperature of each model as anomaly against its own 1991–2020 mean. */
function modelAnomalies(models, key = 'tmean') {
  const out = {};
  for (const [name, rows] of Object.entries(models)) {
    const base = mean(inPeriod(rows, NORMAL).map((r) => r[key]));
    if (!Number.isFinite(base)) continue;
    out[name] = rows.filter((r) => Number.isFinite(r[key])).map((r) => ({ year: r.year, anomaly: round(r[key] - base, 2) }));
  }
  return out;
}

/* ---------- Files ---------- */

/** "Zürich / Fluntern" → "zurichfluntern" (for header names and matching). */
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9_]/g, '');

/** Semicolon (or comma) table with a header row → objects keyed by normalised header names. */
function parseTable(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { header: [], rows: [] };
  const sep = lines[0].includes(';') ? ';' : ',';
  const header = lines[0].split(sep).map((h) => norm(h.trim().replace(/^"(.*)"$/, '$1')));
  const rows = lines.slice(1).map((line) => {
    const cells = line.split(sep).map((c) => c.trim().replace(/^"(.*)"$/, '$1'));
    const row = {};
    header.forEach((h, i) => { if (h) row[h] = cells[i] ?? ''; });
    return row;
  });
  return { header, rows };
}
const num = (v) => {
  const s = String(v ?? '').trim().replace(',', '.');
  const n = Number(s);
  return s !== '' && s !== '-' && Number.isFinite(n) ? n : null;
};
const pick = (row, ...keys) => {
  for (const k of keys) if (row[k] !== undefined && row[k] !== '') return row[k];
  return undefined;
};
/** Year from "01.01.1864 00:00", "1864-01-01…" or "1864". */
function yearOf(v) {
  const s = String(v || '').trim();
  const ch = /^\d{1,2}\.\d{1,2}\.(\d{4})/.exec(s);
  const iso = /^(\d{4})/.exec(s);
  return ch ? Number(ch[1]) : iso ? Number(iso[1]) : null;
}

/**
 * Stations of the MeteoSchweiz open data ("ogd-nbcn_meta_stations.csv"):
 * station_abbr, station_name, station_coordinates_wgs84_lat/_lon,
 * station_height_masl. Columns are found by name.
 */
function parseNbcnStations(text) {
  return parseTable(text).rows.map((r) => ({
    id: String(pick(r, 'station_abbr', 'stn', 'station') || '').toUpperCase(),
    name: pick(r, 'station_name', 'name') || null,
    lat: num(pick(r, 'station_coordinates_wgs84_lat', 'lat', 'latitude')),
    lon: num(pick(r, 'station_coordinates_wgs84_lon', 'lon', 'longitude')),
    elevation: num(pick(r, 'station_height_masl', 'elevation', 'height')),
  })).filter((s) => s.id && Number.isFinite(s.lat) && Number.isFinite(s.lon));
}

/**
 * Yearly values of a homogeneous series ("ogd-nbcn_ber_y.csv"): station_abbr,
 * reference_timestamp and one column per parameter. The yearly mean
 * temperature is the homogenised `ths200y0` (else the raw `tre200y0`), the
 * precipitation `rhs150y0` (else `rre150y0`). Returns [{ station, year, temp, precip }].
 */
function parseNbcnYearly(text) {
  const { header, rows } = parseTable(text);
  const col = (...re) => {
    for (const r of re) {
      const hit = header.find((h) => r.test(h));
      if (hit) return hit;
    }
    return null;
  };
  const t = col(/^ths200y0$/, /^tre200y0$/, /^(ths|tre)200y/);
  const p = col(/^rhs150y0$/, /^rre150y0$/, /^(rhs|rre)150y/);
  if (!t && !p) return [];
  return rows.map((r) => ({
    station: String(pick(r, 'station_abbr', 'stn') || '').toUpperCase(),
    year: yearOf(pick(r, 'reference_timestamp', 'time', 'date', 'year')),
    temp: t ? num(r[t]) : null,
    precip: p ? num(r[p]) : null,
  })).filter((r) => r.station && r.year && (r.temp !== null || r.precip !== null));
}

/** Plain CSV of yearly station values: station;name;lat;lon;elevation;year;temp[;precip]. */
function parseStationCsv(text) {
  const stations = new Map();
  const values = [];
  for (const r of parseTable(text).rows) {
    const id = String(pick(r, 'station', 'station_abbr', 'id') || '').toUpperCase();
    const year = num(r.year);
    if (!id || !year) continue;
    if (!stations.has(id)) {
      stations.set(id, { id, name: pick(r, 'name', 'station_name') || id, lat: num(r.lat), lon: num(r.lon), elevation: num(pick(r, 'elevation', 'height')) });
    }
    values.push({ station: id, year, temp: num(pick(r, 'temp', 'tmean', 'temperature')), precip: num(pick(r, 'precip', 'precipitation')) });
  }
  return { stations: [...stations.values()].filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon)), values };
}

const LEVELS = { gwl15: 'GWL1.5', 15: 'GWL1.5', gwl20: 'GWL2.0', gwl2: 'GWL2.0', 20: 'GWL2.0', 2: 'GWL2.0', gwl30: 'GWL3.0', gwl3: 'GWL3.0', 30: 'GWL3.0', 3: 'GWL3.0' };
const levelOf = (v) => LEVELS[norm(String(v).replace('.', ''))] || null;

/**
 * Changes for global warming levels, e.g. from the CH2025 web atlas, as CSV:
 * place;lat;lon;elevation;indicator;level;value;low;high with the indicator
 * keys of INDICATORS, the level GWL1.5, GWL2.0 or GWL3.0 (also 1.5, 2, 3) and
 * the change against 1991–2020 (°C, days, or % for precipitation and snowfall).
 */
function parseScenarioCsv(text) {
  const keys = new Map(Object.keys(INDICATORS).map((k) => [norm(k), k]));
  return parseTable(text).rows.map((r) => ({
    place: pick(r, 'place', 'ort', 'station', 'region') || '',
    lat: num(r.lat), lon: num(r.lon), elevation: num(pick(r, 'elevation', 'height')),
    indicator: keys.get(norm(pick(r, 'indicator', 'indikator'))) || null,
    level: levelOf(pick(r, 'level', 'gwl', 'szenario')),
    value: num(pick(r, 'value', 'change', 'median')),
    low: num(pick(r, 'low', 'q05', 'min')),
    high: num(pick(r, 'high', 'q95', 'max')),
  })).filter((r) => r.place && Number.isFinite(r.lat) && Number.isFinite(r.lon) && r.indicator && r.level && r.value !== null);
}

/* ---------- Stations nearby ---------- */

const KM_PER_100M = 10; // 100 m of altitude weigh like 10 km, as for the phenology stations
function effectiveKm(a, b) {
  const dy = (a.lat - b.lat) * 111.2;
  const dx = (a.lon - b.lon) * 111.2 * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  const km = Math.hypot(dx, dy);
  const dz = Number.isFinite(a.elevation) && Number.isFinite(b.elevation) ? Math.abs(a.elevation - b.elevation) : 0;
  return { km, effective: km + (dz / 100) * KM_PER_100M };
}
/** The nearest of `places` ({ lat, lon, elevation }) within `maxKm` effective distance, with its distance. */
function nearest(places, at, maxKm) {
  let best = null;
  for (const p of places) {
    const d = effectiveKm(at, p);
    if (d.effective <= maxKm && (!best || d.effective < best.effective)) best = { ...p, km: round(d.km, 1), effective: d.effective };
  }
  return best;
}

/** Summary of a homogeneous station series: stripes against 1961–1990 and warming since 1871–1900. */
function stationSummary(values) {
  const rows = values.filter((v) => Number.isFinite(v.temp)).map((v) => ({ year: v.year, tmean: v.temp, precip: v.precip }))
    .sort((a, b) => a.year - b.year);
  if (rows.length < 30) return null;
  const last = rows[rows.length - 1].year;
  const recent = mean(inPeriod(rows, [last - RECENT_YEARS + 1, last]).map((r) => r.tmean));
  const pre = inPeriod(rows, PREINDUSTRIAL);
  const preMean = pre.length >= 20 ? mean(pre.map((r) => r.tmean)) : null;
  return {
    first: rows[0].year,
    last,
    stripes: stripes(rows),
    sinceIndustrial: preMean !== null ? round(recent - preMean, 1) : null,
    preindustrial: PREINDUSTRIAL,
    trendPerDecade: round(trend(rows, 'tmean'), 2),
    warmest: ranked(rows, 'tmean'),
  };
}

/* ---------- Synthesis with the observations ---------- */

const list = (xs) => (xs.length < 2 ? String(xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} und ${xs[xs.length - 1]}`);
const signed = (v, unit, digits = 1) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(digits)}${unit ? ` ${unit}` : ''}`;

const HEAT_NOTES = ['trockenheit', 'waerme', 'fruehe_verfaerbung', 'borkenkaefer_risiko', 'nadelverfaerbung'];

/**
 * Statements that join the climate of the region with what MyForrest saw
 * there. `climate`: climateSummary(); `rows`: yearly indicators; `obs`: per
 * year { photos, notes: { type: n }, storms, ndviSummer, meltMonth, iceShare,
 * leafOut, colour, neophytes } (see routes/klima.js); `projection`:
 * projectDelta(). Each statement: { kind, title, text }. Wording stays with
 * "fällt zusammen": a coincidence, not a proof.
 */
function synthesize({ climate, rows = [], obs = {}, projection = null, station = null }) {
  const out = [];
  if (!climate) return out;
  const ch = (k) => climate.changes.find((c) => c.key === k);
  const [r0, r1] = climate.periods.ref;
  const [n0, n1] = climate.periods.recent;

  if (Number.isFinite(climate.warming)) {
    const since = station?.sinceIndustrial;
    out.push({
      kind: 'klima',
      title: `${signed(climate.warming, '°C')} gegenüber ${r0}–${r1}`,
      text: `In der Region war es ${n0}–${n1} im Mittel ${signed(climate.warming, '°C')} wärmer als ${r0}–${r1}` +
        (Number.isFinite(climate.trendPerDecade) ? `, ein Trend von ${signed(climate.trendPerDecade, '°C', 2)} pro Jahrzehnt seit ${r0}.` : '.') +
        (Number.isFinite(since) ? ` Die homogene Messreihe ${station.name} zeigt ${signed(since, '°C')} gegenüber der vorindustriellen Zeit (${station.preindustrial.join('–')}).` : ''),
    });
  }
  const hot = ch('hotDays');
  const frost = ch('frostDays');
  const snow = ch('snowDays');
  const parts = [];
  if (hot && Number.isFinite(hot.delta) && (hot.ref >= 0.5 || hot.recent >= 1)) parts.push(`Hitzetage ${hot.ref} → ${hot.recent}`);
  if (ch('tropicalNights')?.recent >= 1) parts.push(`Tropennächte ${ch('tropicalNights').ref} → ${ch('tropicalNights').recent}`);
  if (frost && Number.isFinite(frost.delta)) parts.push(`Frosttage ${frost.ref} → ${frost.recent}`);
  if (snow && Number.isFinite(snow.delta) && snow.ref >= 1) parts.push(`Tage mit Neuschnee ${snow.ref} → ${snow.recent}`);
  if (ch('growingDays') && Number.isFinite(ch('growingDays').delta)) parts.push(`Vegetationstage ${ch('growingDays').ref} → ${ch('growingDays').recent}`);
  if (parts.length) {
    out.push({ kind: 'klima', title: 'Mehr Hitze, weniger Frost', text: `Pro Jahr, ${r0}–${r1} gegenüber ${n0}–${n1}: ${parts.join(', ')}.` });
  }

  // Observations in the hottest/driest summers against the other years with photos.
  const obsYears = Object.keys(obs).map(Number).filter((y) => obs[y]?.photos > 0);
  if (obsYears.length >= 2) {
    const byYear = new Map(rows.map((r) => [r.year, r]));
    const scored = obsYears.filter((y) => byYear.get(y)?.summerT !== undefined && byYear.get(y)?.summerT !== null);
    // Summer heat and dryness against the normal: the years with photos ordered by summer temperature.
    const normalT = mean(inPeriod(rows, NORMAL).map((r) => r.summerT));
    const normalP = mean(inPeriod(rows, NORMAL).map((r) => r.summerP));
    const stress = scored.filter((y) => byYear.get(y).summerT - normalT >= 1 || (normalP && byYear.get(y).summerP / normalP <= 0.75));
    const calm = scored.filter((y) => !stress.includes(y));
    const notes = (ys) => ys.reduce((n, y) => n + HEAT_NOTES.reduce((m, k) => m + (obs[y].notes?.[k] || 0), 0), 0);
    // Spots photographed in a year, and those of them with a heat or drought note (per spot and year).
    const visited = (ys) => ys.reduce((n, y) => n + (obs[y].visited ?? obs[y].photos), 0);
    const struck = (ys) => ys.reduce((n, y) => n + (obs[y].heatSpots ?? Math.min(obs[y].visited ?? obs[y].photos, HEAT_NOTES.reduce((m, k) => m + (obs[y].notes?.[k] || 0), 0))), 0);
    if (stress.length && notes(stress) > 0) {
      const desc = stress.map((y) => {
        const r = byYear.get(y);
        const dT = r.summerT - normalT;
        const dP = normalP ? Math.round((r.summerP / normalP) * 100) : null;
        return `${y} (Sommer ${signed(dT, '°C')}${dP !== null ? `, ${dP} % Regen` : ''})`;
      });
      out.push({
        kind: 'beobachtung',
        title: 'Hitzesommer in den Fotos',
        text: `In den heissen oder trockenen Sommern ${list(desc)} zeigten die Fotos an ${struck(stress)} von ${visited(stress)} besuchten Spots ` +
          `Hinweise auf Trockenheit, Hitze, frühe Verfärbung oder Borkenkäfer-Risiko (${notes(stress)} Hinweise)` +
          (calm.length ? `, in den übrigen Jahren mit Fotos an ${struck(calm)} von ${visited(calm)}.` : '.'),
      });
    }
    // Summer NDVI in stress years against the others.
    const nd = (ys) => mean(ys.map((y) => obs[y]?.ndviSummer));
    const ndYears = Object.keys(obs).map(Number).filter((y) => Number.isFinite(obs[y]?.ndviSummer) && byYear.get(y)?.summerT != null);
    const ndStress = ndYears.filter((y) => byYear.get(y).summerT - normalT >= 1 || (normalP && byYear.get(y).summerP / normalP <= 0.75));
    const ndCalm = ndYears.filter((y) => !ndStress.includes(y));
    if (ndStress.length && ndCalm.length && nd(ndCalm) - nd(ndStress) >= 0.02) {
      out.push({
        kind: 'satellit',
        title: 'Weniger Grün in Hitzesommern',
        text: `Der NDVI der Wald-Spots im Hochsommer lag in ${list(ndStress)} bei ${nd(ndStress).toFixed(2)}, in den anderen Jahren bei ${nd(ndCalm).toFixed(2)}.`,
      });
    }
  }

  // Storms the spots of the region lived through.
  const storms = Object.keys(obs).flatMap((y) => (obs[y].storms || []).map((s) => ({ ...s, year: Number(y) })));
  if (storms.length) {
    const top = [...storms].sort((a, b) => b.gust - a.gust).slice(0, 3);
    const windthrow = storms.filter((s) => s.windthrow).length;
    out.push({
      kind: 'beobachtung',
      title: `${storms.length} ${storms.length === 1 ? 'Sturm' : 'Stürme'} an den Spots`,
      text: `Die stärksten: ${list(top.map((s) => `${s.date.split('-').reverse().join('.')} (${s.gust} km/h)`))}` +
        (windthrow ? `; ${windthrow} davon mit Windwurf auf späteren Fotos.` : '.'),
    });
  }

  // Phenology: leaf-out and colouring at the nearest stations, a trend once ten years are known.
  for (const [key, label, phase, verb] of [['leafOut', 'Blattaustrieb der Buche', 'der Blattaustrieb', 'früher'], ['colour', 'Blattverfärbung der Buche', 'die Blattverfärbung', 'später']]) {
    const pts = Object.keys(obs).map(Number).filter((y) => Number.isFinite(obs[y]?.[key])).map((y) => ({ year: y, v: obs[y][key] }));
    if (pts.length < 10) continue;
    const t = trend(pts.map((p) => ({ year: p.year, v: p.v })), 'v', pts[0].year);
    if (!Number.isFinite(t) || Math.abs(t) < 1) continue;
    const dirWord = t < 0 ? 'früher' : 'später';
    out.push({
      kind: 'phaenologie',
      title: `${label}: ${Math.abs(round(t, 1))} Tage pro Jahrzehnt ${dirWord}`,
      text: `Nach den Phänologie-Stationen der Region (${pts[0].year}–${pts[pts.length - 1].year}) kommt ${phase} der Buche ` +
        `um ${Math.abs(t).toFixed(1)} Tage pro Jahrzehnt ${dirWord}${verb === dirWord ? ', wie es die Erwärmung erwarten lässt' : ''}.`,
    });
  }

  // Snow melt on mountain spots and late-summer ice on glacier spots (Sentinel-2).
  const melt = Object.keys(obs).map(Number).filter((y) => Number.isFinite(obs[y]?.meltMonth)).sort((a, b) => a - b);
  if (melt.length >= 4) {
    const half = Math.floor(melt.length / 2);
    const early = mean(melt.slice(0, half).map((y) => obs[y].meltMonth));
    const late = mean(melt.slice(-half).map((y) => obs[y].meltMonth));
    if (early - late >= 0.5) {
      out.push({
        kind: 'satellit',
        title: 'Schnee schmilzt früher',
        text: `Auf den Gebirge-Spots der Region schmilzt der Schnee ${melt[melt.length - half]}–${melt[melt.length - 1]} im Mittel ` +
          `${Math.round((early - late) * 30)} Tage früher als ${melt[0]}–${melt[half - 1]} (Sentinel-2).`,
      });
    }
  }
  const ice = Object.keys(obs).map(Number).filter((y) => Number.isFinite(obs[y]?.iceShare)).sort((a, b) => a - b);
  if (ice.length >= 3 && obs[ice[0]].iceShare - obs[ice[ice.length - 1]].iceShare >= 0.1) {
    out.push({
      kind: 'satellit',
      title: 'Weniger Eis im Spätsommer',
      text: `An den Gletscher-Spots der Region sank der Anteil Schnee und Eis im Spätsommer von ${Math.round(obs[ice[0]].iceShare * 100)} % (${ice[0]}) ` +
        `auf ${Math.round(obs[ice[ice.length - 1]].iceShare * 100)} % (${ice[ice.length - 1]}).`,
    });
  }
  const neo = Object.keys(obs).map(Number).filter((y) => obs[y]?.neophytes > 0);
  if (neo.length >= 2) {
    const total = neo.reduce((n, y) => n + obs[y].neophytes, 0);
    out.push({
      kind: 'beobachtung',
      title: `${total} Neophyten-Funde`,
      text: `Seit ${neo[0]} bestimmten Fotos der Region ${total} Funde invasiver Neophyten. Einige invasive Arten profitieren von milderen Wintern und längeren Vegetationsperioden.`,
    });
  }

  if (projection) {
    const p = (k) => projection.indicators.find((i) => i.key === k);
    const pt = p('tmean');
    const ph = p('hotDays');
    const ps = p('summerP');
    const bits = [];
    if (pt) bits.push(`Jahresmittel ${pt.value} °C (${signed(pt.delta, '°C')}; Modelle ${pt.low}–${pt.high} °C)`);
    if (ph) bits.push(`${ph.value} Hitzetage (heute im Mittel 1991–2020: ${ph.normal}; Spanne ${ph.low}–${ph.high})`);
    if (ps && Number.isFinite(ps.percent)) bits.push(`Sommerniederschlag ${ps.percent > 0 ? '+' : ''}${ps.percent} %`);
    if (bits.length) {
      out.push({
        kind: 'zukunft',
        title: `Um ${Math.floor((projection.future[0] + projection.future[1]) / 2)}`,
        text: `Nach ${projection.models.length} Klimamodellen (${projection.future.join('–')} gegenüber ${projection.normal.join('–')}): ${bits.join(', ')}.`,
      });
    }
  }
  return out;
}

/* ---------- Scenarios: global warming levels ---------- */

// Global warming (°C above 1850–1900) of the normal and of the projection window, after IPCC AR6 WG I (SPM, Table SPM.1):
// 1991–2020 about 0.9 °C; 2031–2050 on the high emission path SSP5-8.5 about 2.0 °C (2021–2040: 1.6, 2041–2060: 2.4).
const GWL_NORMAL = 0.9;
const GWL_FUTURE = 2.0;
const LAPSE = 0.55; // °C per 100 m: mean annual lapse rate, for "the climate moves uphill"

/** The warming levels of CH2025, with when the world reaches them according to IPCC AR6 (best estimates). */
const WARMING_LEVELS = [
  {
    level: 'GWL1.5', gwl: 1.5, title: '+1,5 °C weltweit', pathway: 'Pariser Ziel, sehr starker Klimaschutz',
    when: 'Nach dem IPCC in allen Szenarien Anfang der 2030er-Jahre erreicht; nur mit sehr starkem Klimaschutz (SSP1-1.9) bleibt es dabei.',
  },
  {
    level: 'GWL2.0', gwl: 2.0, title: '+2 °C weltweit', pathway: 'Mittlere bis hohe Emissionen um die Jahrhundertmitte',
    when: 'Mit hohen Emissionen (SSP5-8.5) um 2040–2050, mit mittleren (SSP2-4.5) um 2050–2060; mit starkem Klimaschutz (SSP1-2.6) wahrscheinlich nicht.',
  },
  {
    level: 'GWL3.0', gwl: 3.0, title: '+3 °C weltweit', pathway: 'Ohne zusätzlichen Klimaschutz',
    when: 'Mit mittleren Emissionen (SSP2-4.5: 2,7 °C) gegen Ende des Jahrhunderts, mit hohen (SSP5-8.5) um 2060–2070.',
  },
];

/**
 * The indicators at the global warming levels of CH2025 (+1.5, +2, +3 °C). Where CH2025 changes were
 * imported (`ch2025`: { 'GWL2.0': [{ key, value, low, high }] }), those count; otherwise the change of
 * the models between 1991–2020 and 2031–2050 is scaled with the global warming (pattern scaling:
 * the local change grows in proportion to the global one). Each level: { level, gwl, title, pathway,
 * when, source, shiftM, indicators: [{ key, label, unit, normal, value, low, high }] }.
 */
function scenarioLevels(projection, ch2025 = null) {
  if (!projection) return [];
  return WARMING_LEVELS.map((l) => {
    const factor = (l.gwl - GWL_NORMAL) / (GWL_FUTURE - GWL_NORMAL);
    const official = ch2025?.[l.level] || [];
    const indicators = projection.indicators.map((i) => {
      const ind = INDICATORS[i.key];
      const ch = official.find((o) => o.key === i.key);
      const apply = (v, scale) => {
        if (!Number.isFinite(v)) return null;
        if (ind.kind === 'ratio') return i.normal ? i.normal * (1 + (((v - i.normal) / i.normal) * scale)) : v;
        const out = i.normal + (v - i.normal) * scale;
        return ind.kind === 'count' ? Math.min(366, Math.max(0, out)) : out;
      };
      // CH2025 gives changes: °C and days absolute, precipitation and snow in %.
      const fromCh = (d) => (Number.isFinite(d) ? (ind.kind === 'ratio' ? i.normal * (1 + d / 100) : ind.kind === 'count' ? Math.max(0, i.normal + d) : i.normal + d) : null);
      const [value, low, high] = ch ? [fromCh(ch.value), fromCh(ch.low), fromCh(ch.high)] : [apply(i.value, factor), apply(i.low, factor), apply(i.high, factor)];
      const [lo, hi] = [low, high].filter(Number.isFinite).sort((a, b) => a - b);
      return { key: i.key, label: i.label, unit: i.unit, normal: i.normal, value: round(value, ind.digits), low: round(lo ?? value, ind.digits), high: round(hi ?? value, ind.digits), source: ch ? 'CH2025' : 'Modelle' };
    });
    const t = indicators.find((i) => i.key === 'tmean');
    return {
      ...l,
      factor: round(factor, 2),
      source: official.length ? 'CH2025' : 'Modelle',
      shiftM: t ? Math.round(((t.value - t.normal) / LAPSE) * 10) * 10 : null, // metres, to 10 m
      indicators,
    };
  });
}

/** Generations of the spruce bark beetle a degree-day sum allows (rough, from air temperature). */
const beetleGenerations = (dd) => (Number.isFinite(dd) ? Math.round((dd / BEETLE_DD) * 10) / 10 : null);

// Species that cope with warmth and drought and gain ground (cf. the Tree-App of BAFU and WSL); only the native ones.
const GAINERS = ['Quercus petraea', 'Quercus robur', 'Acer campestre', 'Sorbus torminalis', 'Tilia cordata', 'Prunus avium', 'Castanea sativa', 'Pinus sylvestris'];

/**
 * What the scenarios mean for the forest at a place: rules of thumb from the research programme
 * "Wald und Klimawandel" (BAFU, WSL) and the Tree-App, applied to the elevation, the indicators of
 * each warming level and the tree species found there. Each topic: { key, title, text, levels:
 * { 'GWL1.5': 'gering' | 'mittel' | 'hoch', … }, species?: [names] }. Not a site assessment: the
 * soil (water storage) decides as much as the climate.
 */
function forestImpacts({ elevation, levels, normal = null, species = [] }) {
  if (!levels.length) return [];
  const out = [];
  const val = (l, k) => l.indicators.find((i) => i.key === k);
  const elev = Number.isFinite(elevation) ? elevation : null;
  const names = new Set(species.map((t) => t.sci));
  const name = (sci) => species.find((t) => t.sci === sci)?.de;
  const effective = (l) => (elev !== null && Number.isFinite(l.shiftM) ? elev - l.shiftM : null);
  const levelsOf = (fn) => Object.fromEntries(levels.map((l) => [l.level, fn(l)]));
  const mid = levels.find((l) => l.level === 'GWL2.0') || levels[0];

  // The climate moves uphill: the vegetation belts follow, with a delay of decades.
  if (elev !== null && Number.isFinite(mid.shiftM)) {
    const belt = (m) => (m < 600 ? 'kollin (Eichen, Linden, Hainbuchen)' : m < 1000 ? 'submontan bis untermontan (Buchenwälder)' : m < 1400 ? 'obermontan (Tannen-Buchenwälder)' : m < 1800 ? 'subalpin (Fichtenwälder)' : 'hochsubalpin bis alpin (Lärchen, Arven, Waldgrenze)');
    out.push({
      key: 'hoehenstufen',
      title: 'Das Klima steigt den Hang hinauf',
      text: `Bei ${mid.title} entspricht das Klima auf ${elev} m dem heutigen Klima auf rund ${Math.max(0, Math.round(effective(mid) / 10) * 10)} m ` +
        `(${mid.shiftM} m tiefer; ${levels.map((l) => `${l.title.replace(' weltweit', '')}: ${l.shiftM} m`).join(', ')}). ` +
        `Die Höhenstufe wechselt damit von ${belt(elev)} gegen ${belt(effective(mid))}. Wälder folgen langsam, über Jahrzehnte; ` +
        'wer heute pflanzt, pflanzt für dieses künftige Klima.',
      levels: levelsOf((l) => (l.shiftM >= 400 ? 'hoch' : l.shiftM >= 200 ? 'mittel' : 'gering')),
    });
  }

  // Spruce: drought and bark beetles; in the lowlands it is the first tree to lose.
  const dd = (l) => val(l, 'beetleDD');
  const genNow = beetleGenerations(normal?.beetleDD ?? dd(mid)?.normal);
  if (dd(mid)) {
    const gens = levels.map((l) => `${l.title.replace(' weltweit', '')}: ${beetleGenerations(dd(l).value)}`).join(', ');
    out.push({
      key: 'fichte',
      title: names.has('Picea abies') ? 'Fichte und Borkenkäfer: hier betroffen' : 'Fichte und Borkenkäfer',
      text: `Die Wärme reicht 1991–2020 rechnerisch für ${genNow} Generationen des Buchdruckers pro Jahr, künftig für ${gens} ` +
        '(grobe Schätzung aus der Lufttemperatur). Jede zusätzliche Generation vervielfacht den Befall, und trockengestresste Fichten wehren sich schlecht. ' +
        (elev !== null ? `Die Fichte gilt unter rund 1000 m künftig als stark gefährdet; ${effective(mid) < 1000 ? `der Ort liegt klimatisch bei ${mid.title} auf rund ${Math.round(effective(mid) / 10) * 10} m.` : 'der Ort liegt auch künftig darüber.'}` : ''),
      levels: levelsOf((l) => {
        const g = beetleGenerations(dd(l).value);
        const e = effective(l);
        return g >= 2.5 || (e !== null && e < 800) ? 'hoch' : g >= 1.8 || (e !== null && e < 1100) ? 'mittel' : 'gering';
      }),
      species: names.has('Picea abies') ? [name('Picea abies')] : [],
    });
  }

  // Beech and other drought-sensitive broadleaves: summer heat and less summer rain.
  const sp = (l) => val(l, 'summerP');
  const st = (l) => val(l, 'summerT');
  const hot = (l) => val(l, 'hotDays');
  if (st(mid) && sp(mid)) {
    const sensitive = species.filter((t) => t.drought === 'hoch' && t.sci !== 'Picea abies').map((t) => t.de);
    const pct = (l) => (sp(l).normal ? Math.round(((sp(l).value - sp(l).normal) / sp(l).normal) * 100) : 0);
    out.push({
      key: 'trockenheit',
      title: 'Sommertrockenheit',
      text: `Der Sommer wird bei ${mid.title} ${signed(st(mid).value - st(mid).normal, '°C')} wärmer, mit ${hot(mid) ? `${hot(mid).value} statt ${hot(mid).normal} Hitzetagen und ` : ''}` +
        `${pct(mid) > 0 ? '+' : ''}${pct(mid)} % Sommerregen. Mehr Verdunstung bei kaum mehr Regen heisst trockenere Böden. ` +
        `Buchen in tiefen Lagen und auf flachgründigen Böden reagieren mit früher Verfärbung, Kronenverlichtung und Absterben wie 2018 und 2022.` +
        (sensitive.length ? ` Trockenheitsempfindlich am Ort: ${list(sensitive)}.` : ''),
      levels: levelsOf((l) => {
        const dT = st(l).value - st(l).normal;
        const e = effective(l);
        return dT >= 2.5 || (pct(l) <= -10 && dT >= 1.5) || (e !== null && e < 400) ? 'hoch' : dT >= 1.2 ? 'mittel' : 'gering';
      }),
      species: sensitive,
    });
  }

  // Winter: fewer frost days and less snow; earlier leaf-out keeps late frost a risk.
  const frost = (l) => val(l, 'frostDays');
  const snowD = (l) => val(l, 'snowDays');
  if (frost(mid)) {
    out.push({
      key: 'winter',
      title: 'Milde Winter, früher Austrieb',
      text: `Frosttage ${frost(mid).normal} → ${frost(mid).value}${snowD(mid) && snowD(mid).normal >= 1 ? `, Tage mit Neuschnee ${snowD(mid).normal} → ${snowD(mid).value}` : ''} (bei ${mid.title}). ` +
        'Schädlinge überwintern besser, Schneebruch wird seltener. Weil die Bäume früher austreiben, bleiben späte Fröste gefährlich, gerade in Senken.',
      levels: levelsOf((l) => (frost(l).normal - frost(l).value >= 30 ? 'mittel' : 'gering')),
    });
  }

  // Who gains: native species that cope with warmth and drought.
  const gain = GAINERS.map((sci) => ({ sci, t: species.find((x) => x.sci === sci) }));
  const present = gain.filter((g) => g.t).map((g) => g.t.de);
  out.push({
    key: 'chancen',
    title: 'Wer profitiert',
    text: 'Wärme- und trockenheitsertragende Arten wie Traubeneiche, Stieleiche, Feldahorn, Elsbeere, Winterlinde, Kirsche und in tieferen Lagen die Edelkastanie gewinnen; ' +
      'eine Mischung vieler Arten verteilt das Risiko. ' +
      (present.length ? `Schon am Ort: ${list(present)}. ` : '') +
      'Auch invasive Neophyten wie Götterbaum und Robinie profitieren und brauchen Aufmerksamkeit. Welche Arten genau passen, zeigt die Tree-App von BAFU und WSL für jeden Standort.',
    levels: levelsOf(() => 'chance'),
    species: present,
  });
  return out;
}


module.exports = {
  INDICATORS, HEAT_NOTES, REF, NORMAL, FUTURE, PREINDUSTRIAL,
  yearlyIndicators, periodMeans, trend, stripes, ranked, climateSummary, projectDelta, modelAnomalies,
  parseNbcnStations, parseNbcnYearly, parseStationCsv, parseScenarioCsv, nearest, stationSummary, synthesize,
  parseTable, yearOf, WARMING_LEVELS, GWL_NORMAL, GWL_FUTURE, LAPSE, BEETLE_DD, scenarioLevels, forestImpacts, beetleGenerations,
};
