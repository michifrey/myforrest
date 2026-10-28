'use strict';

/*
 * "Klima im Wandel": the climate of a region and what MyForrest saw there
 * (computations in src/klima.js).
 *
 *   - ERA5 daily values 1940 to the last complete year from Open-Meteo's
 *     archive, at the place and altitude, reduced to yearly indicators and
 *     cached for good (a new year makes a new cache key);
 *   - projections from the Open-Meteo climate API (CMIP6 HighResMIP, daily
 *     1991–2050 per model, `KLIMA_MODELS`, empty switches them off);
 *   - the homogeneous series of MeteoSchweiz (NBCN, from 1864) from the open
 *     data of data.geo.admin.ch (collection ch.meteoschweiz.ogd-nbcn), loaded
 *     by an admin, or imported as CSV;
 *   - changes for global warming levels (CH2025), imported as CSV;
 *   - the observations of the spots in the region, year by year: photos,
 *     notes of the weather context (drought, heat, early colouring …), storms,
 *     summer NDVI, snow melt and late-summer ice, neophyte finds and the
 *     phenology of beech at the nearest stations.
 */

const express = require('express');
const klima = require('../klima');
const { iceSeries } = require('../sentinel');
const { treeInfo } = require('../trees');
const { parseCapabilities } = require('../dwd');

const ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
const CLIMATE = 'https://climate-api.open-meteo.com/v1/climate';
const NBCN_STAC = 'https://data.geo.admin.ch/api/stac/v1/collections/ch.meteoschweiz.ogd-nbcn';
const DAILY = 'temperature_2m_mean,temperature_2m_max,temperature_2m_min,precipitation_sum,snowfall_sum';
const FIRST_YEAR = 1940;
// CMIP6 HighResMIP models of the Open-Meteo climate API (~10–50 km, 1950–2050, high emissions after 2014).
const DEFAULT_MODELS = 'CMCC_CM2_VHR4,FGOALS_f3_H,HiRAM_SIT_HR,MRI_AGCM3_2_S,EC_Earth3P_HR,MPI_ESM1_2_XR,NICAM16_8S';
const DEFAULT_RADIUS_KM = 15;
const MAX_RADIUS_KM = 60;
const STATION_MAX_KM = 80; // effective distance (altitude counts) to a homogeneous series
const SCENARIO_MAX_KM = 60;
const PHENO_MAX_KM = 50;
const FAILED_RETRY = 10 * 60000;
// Climate map: cells of 0.1° (the ERA5-Land grid), the models on cells of 0.5° (their own grid is coarser).
const CELL = 0.1;
const MODEL_CELL = 0.5;
const MAX_CELLS = 80;
// Climate analogues: how close the mean temperature must be (°C), and how far away a cell must at least lie (km).
const ANALOG_TOLERANCE = 0.4;
const ANALOG_MIN_KM = 5;
const DEFAULT_MAP_MODELS = 3; // the first models of KLIMA_MODELS; fewer requests per cell
// Official maps from geo.admin.ch (WMS): layers found in the capabilities by name.
const DEFAULT_WMS = 'https://wms.geo.admin.ch/';
const WMS_TTL = 24 * 3600000;
// Geneva (SITG, ArcGIS WMS per service): urban heat island at night and the tree canopy 2017 and 2023 from LiDAR,
// the canopy target of the tree strategy. Offered only around Geneva; every layer of these services is listed.
const DEFAULT_WMS_GENF = [
  'https://raster.sitg.ge.ch/arcgis/services/CLIMAT_ILOT_CHALEUR_4H00_P0_2020/MapServer/WMSServer',
  'https://vector.sitg.ge.ch/arcgis/services/SIPV_ICA_MNC_2023/MapServer/WMSServer',
  'https://vector.sitg.ge.ch/arcgis/services/SIPV_ICA_MNC_2017/MapServer/WMSServer',
  'https://vector.sitg.ge.ch/arcgis/services/FFP_STRAT_ARBO_AIRE_URB/MapServer/WMSServer',
].join(',');
const GENEVA_BBOX = [5.95, 46.12, 6.32, 46.37]; // west, south, east, north
const WMS_LAYERS = [
  { group: 'Klima heute (MeteoSchweiz)', match: /klimanormwerte/i },
  { group: 'Szenarien', match: /klimaszenarien|ch2018|ch2025/i },
  { group: 'Wald im Klimawandel (BAFU)', match: /vegetationshoehenstufen|hoehenstufen.*wald|wald.*klima/i },
  { group: 'Trockenheit und Waldbrand', match: /trockenheit|drought|waldbrand/i },
];
const DAY = 86400000;

module.exports = function registerKlima(app, {
  db, fetchImpl = fetch, elevation = null, accounts = null, models = process.env.KLIMA_MODELS ?? DEFAULT_MODELS,
  mapModels = Number(process.env.KLIMA_KARTE_MODELLE ?? DEFAULT_MAP_MODELS),
  cellsPerDay = Number(process.env.KLIMA_KARTE_PRO_TAG ?? 30),
  wmsUrl = (process.env.KLIMA_WMS_URL ?? DEFAULT_WMS) || null, wmsFetch = fetchImpl,
  wmsGenf = process.env.KLIMA_WMS_GENF ?? DEFAULT_WMS_GENF,
  background = (p) => p, now = () => Date.now(),
}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS weather_cache (key TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS klima_stations (
      id TEXT PRIMARY KEY, name TEXT, lat REAL NOT NULL, lon REAL NOT NULL, elevation REAL, source TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS klima_station_years (
      station TEXT NOT NULL, year INTEGER NOT NULL, temp REAL, precip REAL, PRIMARY KEY (station, year));
    CREATE TABLE IF NOT EXISTS klima_scenarios (
      place TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, elevation REAL, indicator TEXT NOT NULL, level TEXT NOT NULL,
      value REAL NOT NULL, low REAL, high REAL, PRIMARY KEY (place, indicator, level));
  `);
  const modelList = String(models || '').split(',').map((m) => m.trim()).filter(Boolean);
  const getCache = db.prepare('SELECT json FROM weather_cache WHERE key = ?');
  const setCache = db.prepare('INSERT OR REPLACE INTO weather_cache (key, json, fetched_at) VALUES (?, ?, ?)');
  const failed = new Map();
  const inflight = new Map();

  /** Value under `key`, else loaded once (concurrent callers share the request) and kept for good. */
  async function cachedForever(key, load) {
    const row = getCache.get(key);
    if (row) return JSON.parse(row.json);
    if (now() - (failed.get(key) || 0) < FAILED_RETRY) throw new Error('Quelle eben nicht erreichbar, später erneut versuchen');
    if (!inflight.has(key)) {
      inflight.set(key, load().then((value) => {
        setCache.run(key, JSON.stringify(value), now());
        return value;
      }).catch((err) => {
        failed.set(key, now());
        throw err;
      }).finally(() => inflight.delete(key)));
    }
    return inflight.get(key);
  }

  const lastYear = () => new Date(now() - 7 * DAY).getUTCFullYear() - 1; // ERA5 trails real time by a few days
  const placeKey = (lat, lon, elev) => `${lat.toFixed(1)},${lon.toFixed(1)}${Number.isFinite(elev) ? `@${Math.round(elev / 100) * 100}` : ''}`;
  const getJson = async (url) => {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(90000) });
    if (!res.ok) throw new Error(`${new URL(url).hostname} antwortete mit HTTP ${res.status}`);
    return res.json();
  };
  const elevParam = (elev) => (Number.isFinite(elev) ? `&elevation=${Math.round(elev)}` : '');

  /** Yearly indicators from ERA5 at the place (1940 to the last complete year), in three requests. */
  function era5(lat, lon, elev) {
    const to = lastYear();
    return cachedForever(`klima:era5:v2:${placeKey(lat, lon, elev)}:${to}`, async () => {
      const daily = { time: [] };
      for (const k of DAILY.split(',')) daily[k] = [];
      for (let from = FIRST_YEAR; from <= to; from += 30) {
        const end = Math.min(from + 29, to);
        const body = await getJson(`${ARCHIVE}?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}${elevParam(elev)}` +
          `&start_date=${from}-01-01&end_date=${end}-12-31&daily=${DAILY}&timezone=UTC`);
        if (!body.daily?.time) throw new Error('Open-Meteo lieferte keine Werte');
        daily.time.push(...body.daily.time);
        for (const k of DAILY.split(',')) daily[k].push(...body.daily.time.map((_, i) => body.daily[k]?.[i] ?? null));
      }
      return klima.yearlyIndicators(daily);
    });
  }

  /** Yearly indicators of one climate model, 1991–2050. Keys may carry the model's name as suffix. */
  function model(lat, lon, elev, name) {
    return cachedForever(`klima:model:v2:${name}:${placeKey(lat, lon, elev)}`, async () => {
      const body = await getJson(`${CLIMATE}?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}${elevParam(elev)}` +
        `&start_date=${klima.NORMAL[0]}-01-01&end_date=${klima.FUTURE[1]}-12-31&models=${name}&daily=${DAILY}`);
      const d = body.daily;
      if (!d?.time) throw new Error(`Klimamodell ${name}: keine Werte`);
      const daily = { time: d.time };
      for (const k of DAILY.split(',')) daily[k] = d[k] ?? d[`${k}_${name}`] ?? [];
      return klima.yearlyIndicators(daily);
    });
  }

  async function projections(lat, lon, elev) {
    const out = {};
    const errors = [];
    for (const name of modelList) {
      try {
        out[name] = await model(lat, lon, elev, name);
      } catch (err) {
        errors.push(err.message);
      }
    }
    return { models: out, errors };
  }

  /* ---------- Homogeneous series and scenarios ---------- */

  const insStation = db.prepare('INSERT OR REPLACE INTO klima_stations (id, name, lat, lon, elevation, source) VALUES (?, ?, ?, ?, ?, ?)');
  const insYear = db.prepare('INSERT OR REPLACE INTO klima_station_years (station, year, temp, precip) VALUES (?, ?, ?, ?)');
  const insScenario = db.prepare(`INSERT OR REPLACE INTO klima_scenarios (place, lat, lon, elevation, indicator, level, value, low, high)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  function storeStations(stations, values, source) {
    db.exec('BEGIN');
    try {
      for (const s of stations) insStation.run(s.id, s.name, s.lat, s.lon, s.elevation, source);
      for (const v of values) insYear.run(v.station, v.year, v.temp, v.precip);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return { stations: stations.length, years: values.length };
  }

  /** Downloads the homogeneous series through the STAC API: the stations file and each station's yearly file. */
  async function syncNbcn() {
    const decode = (buf) => {
      try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('latin1').decode(buf); }
    };
    const getText = async (url) => {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new Error(`data.geo.admin.ch antwortete mit HTTP ${res.status} für ${url}`);
      return decode(new Uint8Array(await res.arrayBuffer()));
    };
    const collection = await getJson(NBCN_STAC);
    const stationsUrl = Object.values(collection.assets || {}).map((a) => a.href || '').find((h) => /meta_stations.*\.csv$/i.test(h));
    if (!stationsUrl) throw new Error('MeteoSchweiz: Stationsbeschreibung nicht gefunden');
    const stations = klima.parseNbcnStations(await getText(stationsUrl));
    const values = [];
    let files = 0;
    let next = `${NBCN_STAC}/items?limit=100`;
    for (let page = 0; next && page < 10; page++) {
      const items = await getJson(next);
      for (const item of items.features || []) {
        for (const a of Object.values(item.assets || {})) {
          if (!/_y\.csv$/i.test(a.href || '')) continue;
          values.push(...klima.parseNbcnYearly(await getText(a.href)));
          files++;
        }
      }
      next = (items.links || []).find((l) => l.rel === 'next')?.href || null;
    }
    if (!values.length) throw new Error('MeteoSchweiz: keine Jahreswerte gefunden');
    const known = new Set(values.map((v) => v.station));
    return { ...storeStations(stations.filter((s) => known.has(s.id)), values, 'meteoschweiz'), files };
  }

  const allStations = db.prepare('SELECT id, name, lat, lon, elevation, source FROM klima_stations');
  const stationYears = db.prepare('SELECT year, temp, precip FROM klima_station_years WHERE station = ? ORDER BY year');

  function stationFor(at) {
    const s = klima.nearest(allStations.all(), at, STATION_MAX_KM);
    if (!s) return null;
    const summary = klima.stationSummary(stationYears.all(s.id));
    return summary && { id: s.id, name: s.name, km: s.km, elevation: s.elevation, source: s.source, ...summary };
  }

  function scenariosFor(at) {
    const places = db.prepare('SELECT place, lat, lon, elevation FROM klima_scenarios GROUP BY place').all();
    const p = klima.nearest(places, at, SCENARIO_MAX_KM);
    if (!p) return null;
    const rows = db.prepare('SELECT indicator, level, value, low, high FROM klima_scenarios WHERE place = ? ORDER BY level, indicator').all(p.place);
    const levels = {};
    for (const r of rows) {
      const ind = klima.INDICATORS[r.indicator];
      (levels[r.level] ||= []).push({ key: r.indicator, label: ind?.label || r.indicator, unit: ind?.kind === 'ratio' ? '%' : ind?.unit || '', value: r.value, low: r.low, high: r.high });
    }
    return { place: p.place, km: p.km, levels };
  }
  /** CH2025 changes per level as scenarioLevels() reads them. */
  const ch2025Of = (sc) => (sc ? Object.fromEntries(Object.entries(sc.levels).map(([l, rows]) => [l, rows.map((r) => ({ key: r.key, value: r.value, low: r.low, high: r.high }))])) : null);

  /** Tree species found at the spots (Pl@ntNet or by hand), as trees.js entries. */
  function speciesOf(spots) {
    if (!spots.length) return [];
    const ids = spots.map((s) => s.id);
    return db.prepare(`SELECT DISTINCT scientific_name FROM spot_species WHERE spot_id IN (${ids.map(() => '?').join(',')})`).all(...ids)
      .map((r) => treeInfo(r.scientific_name)).filter((t, i, all) => t && all.findIndex((x) => x?.sci === t.sci) === i);
  }

  /* ---------- Observations of the region ---------- */

  const visible = (req, alias) => (accounts ? accounts.visibleSql(req, alias) : '1 = 1');
  const yearOfMs = (t) => new Date(t).getUTCFullYear();

  /** Spots within `radiusKm` of the centre that `req` may see, with landscape. */
  function regionSpots(req, at, radiusKm) {
    const dLat = radiusKm / 111.2;
    const dLon = radiusKm / (111.2 * Math.cos((at.lat * Math.PI) / 180));
    return db.prepare(`SELECT s.id, s.lat, s.lon, s.landscape FROM spots s
      WHERE s.lat BETWEEN ? AND ? AND s.lon BETWEEN ? AND ?
        AND EXISTS (SELECT 1 FROM photos p WHERE p.spot_id = s.id AND ${visible(req, 'p')})`)
      .all(at.lat - dLat, at.lat + dLat, at.lon - dLon, at.lon + dLon)
      .filter((s) => klima.nearest([s], { lat: at.lat, lon: at.lon }, radiusKm));
  }

  function observations(req, spots, at) {
    const obs = {};
    const of = (y) => (obs[y] ||= { photos: 0, spots: 0, notes: {}, storms: [], neophytes: 0 });
    if (spots.length) {
      const ids = spots.map((s) => s.id);
      const marks = ids.map(() => '?').join(',');
      const photos = db.prepare(`SELECT p.id, p.spot_id, p.taken_at, p.context_json FROM photos p
        WHERE p.spot_id IN (${marks}) AND ${visible(req, 'p')} AND p.taken_at > 0 ORDER BY p.taken_at`).all(...ids);
      const firstOf = new Map();
      const seen = new Set();
      const storms = new Map();
      const windthrow = new Set();
      const visits = new Set();
      const heat = new Set();
      for (const p of photos) {
        const y = yearOfMs(p.taken_at);
        of(y).photos++;
        if (!visits.has(`${p.spot_id}|${y}`)) { visits.add(`${p.spot_id}|${y}`); of(y).visited = (of(y).visited || 0) + 1; }
        if (!firstOf.has(p.spot_id)) { firstOf.set(p.spot_id, y); of(y).spots++; }
        const ctx = p.context_json ? JSON.parse(p.context_json) : null;
        // Each note once per spot and year: ten photos of the same drought are one drought.
        for (const i of ctx?.irregularities || []) {
          if (i.severity === 'hinweis') continue;
          const k = `${p.spot_id}|${y}|${i.type}`;
          if (seen.has(k)) continue;
          seen.add(k);
          of(y).notes[i.type] = (of(y).notes[i.type] || 0) + 1;
          if (klima.HEAT_NOTES.includes(i.type) && !heat.has(`${p.spot_id}|${y}`)) {
            heat.add(`${p.spot_id}|${y}`);
            of(y).heatSpots = (of(y).heatSpots || 0) + 1;
          }
        }
        for (const e of ctx?.storms || []) if (!storms.has(e.date)) storms.set(e.date, e);
        if (ctx?.stormLink?.windthrow && ctx.stormLink.storm?.date) windthrow.add(ctx.stormLink.storm.date);
      }
      for (const e of storms.values()) {
        of(Number(e.date.slice(0, 4))).storms.push({ date: e.date, gust: e.gust, windthrow: windthrow.has(e.date) });
      }
      // Bark beetle: spots with a photo tagged «borkenkaefer» per year (next to the generations the warmth allowed).
      const hasTags = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'photo_tags'").get();
      if (hasTags) {
        for (const r of db.prepare(`SELECT p.taken_at, p.spot_id FROM photo_tags t JOIN photos p ON p.id = t.photo_id
          WHERE t.tag = 'borkenkaefer' AND p.spot_id IN (${marks}) AND ${visible(req, 'p')} AND p.taken_at > 0`).all(...ids)) {
          const y = yearOfMs(r.taken_at);
          (of(y).beetleSet ||= new Set()).add(r.spot_id);
        }
        for (const o of Object.values(obs)) if (o.beetleSet) { o.beetleSpots = o.beetleSet.size; delete o.beetleSet; }
      }
      // Neophyte finds (one per photo and species).
      for (const r of db.prepare(`SELECT p.taken_at FROM identifications i JOIN photos p ON p.id = i.photo_id
        WHERE p.spot_id IN (${marks}) AND i.neophyte IS NOT NULL AND ${visible(req, 'p')}`).all(...ids)) {
        of(yearOfMs(r.taken_at)).neophytes++;
      }
      // Satellite: mean NDVI of July and August over the forest spots, snow melt and late-summer ice.
      const hasNdvi = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'spot_ndvi_scenes'").get();
      if (hasNdvi) {
        const forest = spots.filter((s) => !s.landscape || s.landscape === 'wald').map((s) => s.id);
        if (forest.length) {
          const rows = db.prepare(`SELECT substr(date, 1, 4) AS y, AVG(ndvi) AS ndvi, COUNT(*) AS n FROM spot_ndvi_scenes
            WHERE spot_id IN (${forest.map(() => '?').join(',')}) AND ndvi IS NOT NULL AND substr(date, 6, 2) IN ('07', '08')
              AND COALESCE(clear_fraction, 1) >= 0.5 GROUP BY y`).all(...forest);
          for (const r of rows) if (r.n >= 2) of(Number(r.y)).ndviSummer = Math.round(r.ndvi * 1000) / 1000;
        }
        const scenes = db.prepare('SELECT date, snow, sensor FROM spot_ndvi_scenes WHERE spot_id = ?');
        const melt = {};
        const ice = {};
        for (const s of spots.filter((x) => x.landscape === 'gebirge' || x.landscape === 'gletscher')) {
          const series = iceSeries(scenes.all(s.id));
          if (s.landscape === 'gebirge') for (const m of series.meltOut) (melt[m.year] ||= []).push(m.month);
          if (s.landscape === 'gletscher') for (const m of series.summers) (ice[m.year] ||= []).push(m.ice);
        }
        const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
        for (const [y, ms] of Object.entries(melt)) of(Number(y)).meltMonth = Math.round(avg(ms) * 10) / 10;
        for (const [y, vs] of Object.entries(ice)) of(Number(y)).iceShare = Math.round(avg(vs) * 100) / 100;
      }
    }
    // Phenology of beech at the nearest stations (also without spots).
    const hasPheno = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pheno_stations'").get();
    const pheno = [];
    if (hasPheno) {
      const stations = db.prepare('SELECT source, id, name, lat, lon, elevation FROM pheno_stations').all()
        .map((s) => ({ ...s, d: klima.nearest([s], at, PHENO_MAX_KM) })).filter((s) => s.d)
        .sort((a, b) => a.d.effective - b.d.effective).slice(0, 3);
      for (const [table, key] of [['pheno_leafout', 'leafOut'], ['pheno_obs', 'colour']]) {
        const byYear = {};
        for (const s of stations) {
          for (const r of db.prepare(`SELECT year, doy FROM ${table} WHERE source = ? AND station_id = ? AND species = 'Fagus sylvatica'`).all(s.source, s.id)) {
            (byYear[r.year] ||= []).push(r.doy);
          }
        }
        for (const [y, ds] of Object.entries(byYear)) of(Number(y))[key] = Math.round(ds.reduce((a, b) => a + b, 0) / ds.length);
      }
      for (const s of stations) pheno.push({ source: s.source, id: s.id, name: s.name, km: s.d.km });
    }
    for (const y of Object.keys(obs)) {
      const o = obs[y];
      if (!o.photos && !o.storms.length && !o.neophytes && o.ndviSummer === undefined && o.meltMonth === undefined &&
        o.iceShare === undefined && o.leafOut === undefined && o.colour === undefined) delete obs[y];
    }
    return { obs, pheno };
  }

  /* ---------- Routes ---------- */

  const parseCentre = (req) => {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat, lon };
  };

  /**
   * The dossier of a region: `?lat=&lon=` (or `?spot=`) and `?radius=` in km
   * (default 15). Climate since 1940, the nearest homogeneous series,
   * projections, scenarios, the observations per year and the synthesis.
   */
  app.get('/api/klima', async (req, res) => {
    let at = parseCentre(req);
    let spotId = null;
    if (req.query.spot !== undefined) {
      spotId = Number(req.query.spot);
      const spot = Number.isSafeInteger(spotId) && db.prepare(`SELECT s.id, s.lat, s.lon, s.elevation FROM spots s WHERE s.id = ?
        AND EXISTS (SELECT 1 FROM photos p WHERE p.spot_id = s.id AND ${visible(req, 'p')})`).get(spotId);
      if (!spot) return res.status(404).json({ error: 'Spot nicht gefunden' });
      at = { lat: spot.lat, lon: spot.lon, elevation: spot.elevation };
    }
    if (!at) return res.status(400).json({ error: 'lat und lon (oder spot) angeben' });
    const radiusKm = Math.min(MAX_RADIUS_KM, Math.max(1, Number(req.query.radius) || DEFAULT_RADIUS_KM));
    res.json(await dossier(req, at, { spotId, radiusKm }));
  });

  /**
   * Climate analogues: per warming level the cells of the climate map (those computed so far) whose mean
   * temperature 1991–2020 is what this place reaches at that level, nearest match first, at least ANALOG_MIN_KM away.
   * { cells, levels: [{ level, title, target, places: [{ lat, lon, elevation, tmean, hotDays, distanceKm }] }] }
   * or null without levels.
   */
  const cellsOfYear = db.prepare("SELECT json FROM weather_cache WHERE key LIKE 'klima:cell:v1:%' AND key LIKE ?");
  function analogsFor(at, levels) {
    if (!levels?.length) return null;
    const cells = cellsOfYear.all(`%:${lastYear()}`).map((r) => JSON.parse(r.json)).filter((c) => Number.isFinite(c.tmean));
    const km = (c) => Math.round(Math.hypot((c.lat - at.lat) * 111.32, (c.lon - at.lon) * 111.32 * Math.cos((at.lat * Math.PI) / 180)));
    return {
      cells: cells.length,
      levels: levels.map((l) => {
        const t = l.indicators.find((i) => i.key === 'tmean');
        const target = t && Number.isFinite(t.value) ? t.value : null;
        const places = target === null ? [] : cells
          .map((c) => ({ c, diff: Math.abs(c.tmean - target), distanceKm: km(c) }))
          .filter((x) => x.diff <= ANALOG_TOLERANCE && x.distanceKm >= ANALOG_MIN_KM)
          // Within 0,1 °C a near place beats a slightly better match far away.
          .sort((a, b) => Math.round(a.diff * 10) - Math.round(b.diff * 10) || a.distanceKm - b.distanceKm)
          .slice(0, 3)
          .map(({ c, distanceKm }) => ({ lat: c.lat, lon: c.lon, elevation: c.elevation, tmean: c.tmean, hotDays: c.hotDays, distanceKm }));
        return { level: l.level, title: l.title, target, places };
      }),
    };
  }

  /**
   * The climate dossier of a place (or a spot): climate then and now, scenarios, what they mean for the forest, the
   * spots and observations in the region. Also used by the PDF report of «Landschaft im Wandel».
   */
  async function dossier(req, at, { spotId = null, radiusKm = DEFAULT_RADIUS_KM } = {}) {
    at = { ...at };
    if (!Number.isFinite(at.elevation) && elevation) {
      try { at.elevation = await elevation.lookup(at.lat, at.lon); } catch { at.elevation = null; }
    }
    const elev = Number.isFinite(at.elevation) ? at.elevation : null;

    let rows = [];
    let climateError = null;
    try {
      rows = await era5(at.lat, at.lon, elev);
    } catch (err) {
      climateError = err.message;
    }
    const climate = klima.climateSummary(rows);
    let projection = null;
    let modelSeries = null;
    let projectionErrors = [];
    if (modelList.length && rows.length) {
      const { models: m, errors } = await projections(at.lat, at.lon, elev);
      projection = klima.projectDelta(rows, m);
      modelSeries = klima.modelAnomalies(m);
      projectionErrors = errors;
    }
    const station = stationFor({ ...at, elevation: elev });
    const spots = regionSpots(req, at, radiusKm);
    const { obs, pheno } = observations(req, spots, { ...at, elevation: elev });
    const scenarios = scenariosFor({ ...at, elevation: elev });
    const levels = klima.scenarioLevels(projection, ch2025Of(scenarios));
    // For a spot its own trees, else those of the spots in the region.
    const species = speciesOf(spotId ? [{ id: spotId }] : spots);
    const analogs = analogsFor(at, levels);
    return {
      centre: { lat: at.lat, lon: at.lon, elevation: elev },
      spot: spotId,
      radiusKm,
      spots: spots.length,
      climate,
      climateError,
      years: rows,
      station,
      projection,
      modelSeries,
      projectionErrors: projectionErrors.length ? projectionErrors : undefined,
      scenarios,
      levels,
      species: species.map((t) => ({ scientificName: t.sci, name: t.de, drought: t.drought })),
      forest: klima.forestImpacts({ elevation: elev, levels, species }),
      analogs,
      observations: obs,
      phenoStations: pheno,
      synthesis: klima.synthesize({ climate, rows, obs, projection, station }),
      indicators: klima.INDICATORS,
      sources: {
        era5: 'ERA5 / ERA5-Land über Open-Meteo (CC BY 4.0)',
        models: modelList.length ? 'CMIP6 HighResMIP über die Klima-API von Open-Meteo (CC BY 4.0)' : null,
        station: station ? (station.source === 'meteoschweiz' ? 'Homogene Messreihen, Quelle: MeteoSchweiz' : 'Eigene Messreihe (CSV)') : null,
      },
    };
  }

  /* ---------- Climate map ---------- */

  const snap = (v, step) => Math.round((Math.floor(v / step) * step + step / 2) * 1000) / 1000;
  const cellKey = (lat, lon) => `klima:cell:v1:${lat.toFixed(3)},${lon.toFixed(3)}:${lastYear()}`;
  const queue = [];
  const queued = new Set();
  let running = null;
  let budget = { day: '', used: 0 };

  /** What the map shows for a cell: climate now, the change since 1961–1990 and at each warming level. */
  async function computeCell(lat, lon) {
    let elev = null;
    if (elevation) {
      try { elev = await elevation.lookup(lat, lon); } catch { elev = null; }
    }
    const rows = await era5(lat, lon, elev);
    const c = klima.climateSummary(rows);
    if (!c) throw new Error('keine Klimareihe');
    const ch = (k) => c.changes.find((x) => x.key === k);
    const m = {};
    for (const name of modelList.slice(0, Math.max(0, mapModels))) {
      try { m[name] = await model(snap(lat, MODEL_CELL), snap(lon, MODEL_CELL), null, name); } catch { /* fewer models */ }
    }
    const levels = klima.scenarioLevels(klima.projectDelta(rows, m), ch2025Of(scenariosFor({ lat, lon, elevation: elev })));
    const pick = (l, k) => l.indicators.find((i) => i.key === k);
    return {
      lat, lon, elevation: elev,
      tmean: ch('tmean').normal, warming: c.warming, hotDays: ch('hotDays').recent, frostDays: ch('frostDays').recent,
      beetle: klima.beetleGenerations(ch('beetleDD').normal),
      levels: Object.fromEntries(levels.map((l) => {
        const sp = pick(l, 'summerP');
        return [l.level, {
          dT: Math.round((pick(l, 'tmean').value - pick(l, 'tmean').normal) * 10) / 10,
          hotDays: pick(l, 'hotDays').value,
          frostDays: pick(l, 'frostDays').value,
          summerP: sp?.normal ? Math.round(((sp.value - sp.normal) / sp.normal) * 100) : null,
          beetle: klima.beetleGenerations(pick(l, 'beetleDD')?.value),
          shiftM: l.shiftM,
          source: l.source,
        }];
      })),
    };
  }

  /** Works through the queued cells one by one, at most `cellsPerDay` new ones per day (Open-Meteo's free tier). */
  function pump() {
    if (running || !queue.length) return;
    const day = new Date(now()).toISOString().slice(0, 10);
    if (budget.day !== day) budget = { day, used: 0 };
    if (budget.used >= cellsPerDay) return;
    const { lat, lon, key } = queue.shift();
    budget.used++;
    running = computeCell(lat, lon)
      .then((cell) => setCache.run(key, JSON.stringify(cell), now()))
      .catch(() => failed.set(key, now()))
      .finally(() => { queued.delete(key); running = null; pump(); });
    background(running);
  }

  /**
   * Cells of the climate map in a bounding box (`?bbox=west,south,east,north`): the computed ones, and
   * how many are still queued. Missing cells are computed in the background, the nearest to the centre first.
   */
  app.get('/api/klima/karte', (req, res) => {
    const b = String(req.query.bbox || '').split(',').map(Number);
    if (b.length !== 4 || b.some((v) => !Number.isFinite(v)) || b[0] >= b[2] || b[1] >= b[3]) {
      return res.status(400).json({ error: 'bbox=west,süd,ost,nord angeben' });
    }
    const lats = [];
    const lons = [];
    for (let v = snap(b[1], CELL); v <= b[3] + CELL / 2; v = Math.round((v + CELL) * 1000) / 1000) lats.push(v);
    for (let v = snap(b[0], CELL); v <= b[2] + CELL / 2; v = Math.round((v + CELL) * 1000) / 1000) lons.push(v);
    if (lats.length * lons.length > MAX_CELLS) return res.json({ cell: CELL, tooLarge: true, cells: [], pending: 0 });
    const cells = [];
    const missing = [];
    const centre = { lat: (b[1] + b[3]) / 2, lon: (b[0] + b[2]) / 2 };
    for (const lat of lats) {
      for (const lon of lons) {
        const key = cellKey(lat, lon);
        const row = getCache.get(key);
        if (row) cells.push(JSON.parse(row.json));
        else if (!queued.has(key) && !(now() - (failed.get(key) || 0) < FAILED_RETRY)) missing.push({ lat, lon, key });
      }
    }
    missing.sort((a, c) => Math.hypot(a.lat - centre.lat, a.lon - centre.lon) - Math.hypot(c.lat - centre.lat, c.lon - centre.lon));
    for (const m of missing) { queue.push(m); queued.add(m.key); }
    pump();
    const day = new Date(now()).toISOString().slice(0, 10);
    res.json({
      cell: CELL,
      cells,
      pending: queued.size,
      budgetLeft: budget.day === day ? Math.max(0, cellsPerDay - budget.used) : cellsPerDay,
      levels: klima.WARMING_LEVELS.map((l) => ({ level: l.level, title: l.title })),
    });
  });

  /**
   * Official climate and forest maps: from geo.admin.ch those found by name in the capabilities, from the
   * services of Geneva (SITG) every layer, with the area they cover. Each source is read once a day; one
   * that does not answer is left out.
   */
  const sources = [
    ...(wmsUrl ? [{ url: wmsUrl, filter: true, attribution: '© geo.admin.ch' }] : []),
    ...String(wmsGenf || '').split(',').map((u) => u.trim()).filter(Boolean)
      .map((url) => ({ url, group: 'Stadtklima und Bäume Genf (SITG)', bbox: GENEVA_BBOX, attribution: '© SITG / État de Genève' })),
  ];
  let wms = { at: 0, layers: null, errors: [] };
  async function readSource(src) {
    const sep = src.url.includes('?') ? '&' : '?';
    const r = await wmsFetch(`${src.url}${sep}SERVICE=WMS&VERSION=1.3.0&REQUEST=GetCapabilities&lang=de`, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const xml = await r.text();
    const service = xml.match(/<Service>[\s\S]*?<Title>([^<]*)<\/Title>/)?.[1]?.trim();
    const out = [];
    for (const l of parseCapabilities(xml)) {
      const g = src.filter ? WMS_LAYERS.find((w) => w.match.test(l.name)) : { group: src.group };
      if (!g || out.some((x) => x.name === l.name)) continue;
      // ArcGIS names its layers 0, 1, …: the title says what it is, with the service's title in front.
      const title = !src.filter && service && /^\d+$/.test(l.name) && !l.title.includes(service) ? `${service}: ${l.title}` : l.title;
      out.push({ url: src.url, name: l.name, title, group: g.group, attribution: src.attribution, bbox: src.bbox || null });
    }
    return out;
  }
  app.get('/api/klima/layers', async (req, res) => {
    if (!sources.length) return res.json({ url: null, layers: [] });
    if (!wms.layers || now() - wms.at > WMS_TTL) {
      const layers = [];
      const errors = [];
      for (const src of sources) {
        try {
          layers.push(...await readSource(src));
        } catch (err) {
          errors.push(`${new URL(src.url).hostname}: ${err.message}`);
        }
      }
      const order = (l) => (l.bbox ? 99 : WMS_LAYERS.findIndex((w) => w.group === l.group));
      layers.sort((a, c) => order(a) - order(c) || a.group.localeCompare(c.group, 'de') || a.title.localeCompare(c.title, 'de'));
      if (layers.length || !wms.layers) wms = { at: now(), layers, errors };
    }
    res.json({
      url: wmsUrl, layers: wms.layers,
      ...(wms.errors.length ? { error: wms.layers.length ? undefined : `Kartendienste nicht erreichbar (${wms.errors.join('; ')})`, errors: wms.errors } : {}),
    });
  });

  app.get('/api/klima/status', (req, res) => {
    res.json({
      stations: db.prepare('SELECT COUNT(*) AS n FROM klima_stations').get().n,
      stationYears: db.prepare('SELECT COUNT(*) AS n FROM klima_station_years').get().n,
      scenarioPlaces: db.prepare('SELECT COUNT(DISTINCT place) AS n FROM klima_scenarios').get().n,
      models: modelList,
    });
  });

  // Reference data for everyone: once accounts exist, only admins load it.
  const adminOnly = (req, res, next) => {
    const hasUsers = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()
      && db.prepare('SELECT 1 FROM users LIMIT 1').get();
    if (hasUsers && req.user?.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' });
    return next();
  };

  /** Loads the homogeneous series of MeteoSchweiz (data.geo.admin.ch). */
  app.post('/api/klima/sync', adminOnly, async (req, res) => {
    try {
      res.json(await syncNbcn());
    } catch (err) {
      res.status(502).json({ error: `MeteoSchweiz-Daten nicht verfügbar: ${err.message}` });
    }
  });

  /**
   * Imports a file as text: `?format=nbcn&kind=stations|yearly` (MeteoSchweiz
   * open data files), `?format=stations` (station;name;lat;lon;elevation;year;temp[;precip])
   * or `?format=ch2025` (place;lat;lon;elevation;indicator;level;value;low;high).
   */
  const pendingNbcn = { stations: [] };
  app.post('/api/klima/import', adminOnly, express.text({ type: () => true, limit: '40mb' }), (req, res) => {
    const text = typeof req.body === 'string' ? req.body : '';
    if (!text.trim()) return res.status(400).json({ error: 'Leere Datei' });
    const format = String(req.query.format || '');
    if (format === 'ch2025') {
      const rows = klima.parseScenarioCsv(text);
      if (!rows.length) return res.status(400).json({ error: 'Keine Zeilen erkannt (place;lat;lon;elevation;indicator;level;value;low;high)' });
      for (const r of rows) insScenario.run(r.place, r.lat, r.lon, r.elevation, r.indicator, r.level, r.value, r.low, r.high);
      return res.json({ scenarios: rows.length, places: new Set(rows.map((r) => r.place)).size });
    }
    if (format === 'stations') {
      const { stations, values } = klima.parseStationCsv(text);
      if (!values.length) return res.status(400).json({ error: 'Keine Jahreswerte erkannt (station;name;lat;lon;elevation;year;temp)' });
      return res.json(storeStations(stations, values, 'csv'));
    }
    if (format === 'nbcn') {
      if (req.query.kind === 'stations') {
        pendingNbcn.stations = klima.parseNbcnStations(text);
        return res.json({ stored: 'stations', stations: pendingNbcn.stations.length });
      }
      const values = klima.parseNbcnYearly(text);
      if (!values.length) return res.status(400).json({ error: 'Keine Jahreswerte erkannt (ths200y0 bzw. rhs150y0)' });
      const ids = new Set(values.map((v) => v.station));
      const stations = pendingNbcn.stations.filter((s) => ids.has(s.id));
      const known = new Set(allStations.all().map((s) => s.id));
      const result = storeStations(stations, values, 'meteoschweiz');
      if (![...ids].every((id) => known.has(id) || stations.some((s) => s.id === id))) result.hint = 'Zuerst die Stationsbeschreibung laden (kind=stations)';
      return res.json(result);
    }
    return res.status(400).json({ error: 'Parameter "format" (nbcn, stations oder ch2025) fehlt' });
  });

  return { era5, syncNbcn, dossier };
};
