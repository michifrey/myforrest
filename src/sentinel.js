'use strict';

/*
 * Satellite context: Sentinel-2 L2A NDVI and NDMI time series for a spot,
 * with Landsat 5/7/8 (src/landsat.js) for the years before 2017.
 *
 * Scenes are found with the public Earth Search STAC API (Element 84, no key)
 * and read as Cloud-Optimized GeoTIFFs: only the few hundred bytes of header
 * and the one internal tile around the spot are fetched with HTTP range
 * requests. Per scene the red (B04) and near-infrared (B08) reflectance of a
 * ~30 m window (3 × 3 pixels of 10 m) is read, clouds, shadows and snow are
 * masked with the scene classification (SCL, 20 m), and the mean NDVI of the
 * clear pixels is cached. The moisture index NDMI ((B08 − B11) / (B08 + B11),
 * a common measure of water stress in canopies) is read the same way from the
 * 20 m SWIR pixels within ~20 m, with the mean of the four 10 m NIR pixels in
 * each (B08 is read anyway, so NDMI costs one band more, not two). Scenes are grouped per month; the
 * monthly value is the median of the clear scenes of that month.
 *
 * Besides drops between two photo dates (supporting evidence for what the
 * photos show), `currentAnomalies` compares the last months with the same
 * season of the years before: an early warning that does not need new photos.
 *
 * Without network access every step fails softly: the spot simply has no
 * satellite series and the cached values (if any) are kept.
 */

const { utmFromLatLon, latLonFromUtm } = require('./utm');
const { sensorMonths, adjust, fitHarmonization } = require('./harmonize');

const STAC_URL = 'https://earth-search.aws.element84.com/v1';
const COLLECTION = 'sentinel-2-l2a';
const MAX_CLOUD = 60; // % of the scene; clouds over the spot are masked per pixel anyway
const WINDOW_RADIUS_M = 15; // 3 × 3 pixels of 10 m
const MIN_CLEAR = 0.5; // share of clear pixels needed for a scene value
const SCENES_PER_MONTH = 2; // clear scenes used per month
const ATTEMPTS_PER_MONTH = 4; // scenes tried per month (lowest cloud cover first)
// SCL classes kept: 4 vegetation, 5 not vegetated, 6 water, 7 unclassified.
// Masked: 0 no data, 1 saturated, 2 dark/topographic shadow, 3 cloud shadow,
// 8/9 cloud medium/high probability, 10 thin cirrus, 11 snow/ice.
const SCL_CLEAR = new Set([4, 5, 6, 7]);
const NDVI_DROP = 0.1; // drop between photo dates flagged as supporting evidence
const NDVI_DROP_STRONG = 0.2;
// NDMI varies less than NDVI over the seasons; drops of this size mark water stress in canopies.
const NDMI_DROP = 0.08;
const NDMI_DROP_STRONG = 0.15;
const NDMI_RADIUS_M = 20; // 20 m pixels whose centre lies within 20 m: about 2 × 2 pixels
const THRESHOLDS = { ndvi: [NDVI_DROP, NDVI_DROP_STRONG], ndmi: [NDMI_DROP, NDMI_DROP_STRONG] };
// Bump when a scene's stored values gain a new index: older rows are evaluated again.
const INDEX_VERSION = 2;
const SENTINEL_START = '2017-01-01'; // Earth Search's Sentinel-2 L2A archive; earlier years come from Landsat
// Landsat is read on into these overlap years so it can be harmonised with Sentinel-2 (src/harmonize.js).
const OVERLAP_END = '2018-12-31';
const LANDSAT_PER_MONTH = 1; // clear scenes per Landsat sensor and month
const LANDSAT_ATTEMPTS = 2;

let geotiffModule = null;
async function geotiff() {
  // geotiff is an ES module package; load it lazily (also keeps startup fast).
  if (!geotiffModule) geotiffModule = await import('geotiff');
  return geotiffModule;
}

/** Range-request client for geotiff that goes through an injectable fetch. */
async function makeClient(url, fetchImpl, timeoutMs) {
  const { BaseClient, BaseResponse } = await geotiff();
  class Res extends BaseResponse {
    constructor(r) { super(); this.r = r; }
    get status() { return this.r.status; }
    getHeader(name) { return this.r.headers.get(name) || undefined; }
    async getData() { return this.r.arrayBuffer(); }
  }
  class Client extends BaseClient {
    async request({ headers } = {}) {
      return new Res(await fetchImpl(this.url, { headers, signal: AbortSignal.timeout(timeoutMs) }));
    }
  }
  return new Client(url);
}

/** Scale and offset that turn the asset's digital numbers into reflectance. */
function reflectanceScale(asset, properties) {
  const band = asset?.['raster:bands']?.[0];
  const scale = band && Number.isFinite(band.scale) ? band.scale : 1e-4;
  // Processing baseline 04.00 (2022) added an offset of −1000 to the digital numbers. Earth Search
  // removes it from the COGs and then says so in `earthsearch:boa_offset_applied`, while raster:bands
  // still lists the −0.1: applying it again would push dark forest red below zero (NDVI ≈ 1).
  if (properties?.['earthsearch:boa_offset_applied'] === true) return { scale, offset: 0 };
  if (band && Number.isFinite(band.scale)) return { scale, offset: Number.isFinite(band.offset) ? band.offset : 0 };
  const baseline = Number.parseFloat(properties?.['s2:processing_baseline'] || '0');
  return { scale, offset: baseline >= 4 ? -0.1 : 0 };
}

/** EPSG code of an item (STAC projection extension, old and new field names). */
function itemEpsg(item) {
  const p = item.properties || {};
  if (Number.isFinite(p['proj:epsg'])) return p['proj:epsg'];
  const code = /^EPSG:(\d+)$/.exec(p['proj:code'] || '');
  return code ? Number(code[1]) : null;
}

/** Normalises a STAC item to what the NDVI computation needs (or null). */
function sceneOf(item) {
  const a = item.assets || {};
  const red = a.red || a.B04;
  const nir = a.nir || a.B08;
  const scl = a.scl || a.SCL;
  const swir16 = a.swir16 || a.B11;
  const epsg = itemEpsg(item);
  const datetime = item.properties?.datetime;
  if (!red?.href || !nir?.href || !scl?.href || !epsg || !datetime) return null;
  return {
    id: item.id,
    sensor: 'S2',
    date: datetime.slice(0, 10),
    cloud: item.properties['eo:cloud_cover'] ?? null,
    epsg,
    red: { href: red.href, ...reflectanceScale(red, item.properties) },
    nir: { href: nir.href, ...reflectanceScale(nir, item.properties) },
    scl: { href: scl.href },
    // SWIR at 20 m for the moisture index (absent in old fixtures: then NDVI only).
    swir16: swir16?.href ? { href: swir16.href, ...reflectanceScale(swir16, item.properties) } : null,
  };
}

/** All scenes over a point within [from, to] (YYYY-MM-DD), following STAC paging. */
async function searchScenes({ lat, lon, from, to, fetchImpl, stacUrl = STAC_URL, maxPages = 20, timeoutMs = 20000 }) {
  return stacSearch({
    stacUrl, fetchImpl, maxPages, timeoutMs, toScene: sceneOf,
    body: {
      collections: [COLLECTION],
      intersects: { type: 'Point', coordinates: [lon, lat] },
      datetime: `${from}T00:00:00Z/${to}T23:59:59Z`,
      query: { 'eo:cloud_cover': { lt: MAX_CLOUD } },
      limit: 100,
    },
  });
}

/**
 * A STAC item search (POST, following `next` links) mapped to scenes with
 * `toScene`; one scene per day (the least cloudy, as overlapping tiles repeat
 * the same acquisition), sorted by date.
 */
async function stacSearch({ stacUrl, body, toScene, fetchImpl, maxPages = 20, timeoutMs = 20000 }) {
  let req = { url: `${stacUrl.replace(/\/$/, '')}/search`, method: 'POST', body };
  const scenes = [];
  for (let page = 0; req && page < maxPages; page++) {
    const res = await fetchImpl(req.url, {
      method: req.method,
      headers: { 'content-type': 'application/json', accept: 'application/geo+json' },
      body: req.method === 'POST' ? JSON.stringify(req.body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`STAC-Suche: HTTP ${res.status}`);
    const json = await res.json();
    for (const f of json.features || []) {
      const s = toScene(f);
      if (s) scenes.push(s);
    }
    const next = (json.links || []).find((l) => l.rel === 'next');
    req = next?.href
      ? { url: next.href, method: (next.method || 'GET').toUpperCase(), body: next.merge ? { ...req.body, ...next.body } : next.body || req.body }
      : null;
  }
  // The same acquisition can appear in two overlapping MGRS tiles: keep one per day.
  const byDay = new Map();
  for (const s of scenes) {
    const prev = byDay.get(s.date);
    if (!prev || (s.cloud ?? 100) < (prev.cloud ?? 100)) byDay.set(s.date, s);
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Reads the pixels of the full-resolution image within `radiusM` of the
 * projected point (x, y). Returns the values with their pixel geometry.
 */
async function readWindow(href, x, y, radiusM, fetchImpl, timeoutMs = 20000) {
  const { fromCustomClient } = await geotiff();
  const tiff = await fromCustomClient(await makeClient(href, fetchImpl, timeoutMs), { allowFullFile: false });
  const image = await tiff.getImage(0);
  const [ox, oy] = image.getOrigin();
  const [rx, ry] = image.getResolution(); // ry < 0 for north-up rasters
  const W = image.getWidth();
  const H = image.getHeight();
  const c0 = Math.max(0, Math.floor((x - radiusM - ox) / rx));
  const c1 = Math.min(W, Math.ceil((x + radiusM - ox) / rx));
  const rA = Math.floor((y + radiusM - oy) / ry);
  const rB = Math.ceil((y - radiusM - oy) / ry);
  const r0 = Math.max(0, Math.min(rA, rB));
  const r1 = Math.min(H, Math.max(rA, rB));
  if (c1 <= c0 || r1 <= r0) throw Object.assign(new Error('Spot liegt ausserhalb der Szene'), { permanent: true });
  const [data] = await image.readRasters({ window: [c0, r0, c1, r1] });
  return {
    data, c0, r0, width: c1 - c0, height: r1 - r0, ox, oy, rx, ry,
    /** Value at projected coordinates, or null outside the window. */
    at(px, py) {
      const c = Math.floor((px - ox) / rx) - c0;
      const r = Math.floor((py - oy) / ry) - r0;
      return c >= 0 && r >= 0 && c < this.width && r < this.height ? data[r * this.width + c] : null;
    },
  };
}

/** The point in the scene's UTM projection; scenes in other projections cannot be read. */
function projectToScene(scene, lat, lon) {
  const zone = scene.epsg % 100;
  const south = Math.floor(scene.epsg / 100) === 327;
  if (!(Math.floor(scene.epsg / 100) === 326 || south) || zone < 1 || zone > 60) {
    throw Object.assign(new Error(`Projektion EPSG:${scene.epsg} nicht unterstützt`), { permanent: true });
  }
  return utmFromLatLon(lat, lon, zone, south);
}

/**
 * Mean over the pixels of `grid` whose centre lies within `radiusM` of
 * (x, y) of `valueAt(px, py)` (null for masked pixels), with the share of
 * pixels that had a value. Too few clear pixels give no value.
 */
function windowMean(grid, x, y, radiusM, valueAt) {
  let total = 0;
  let clear = 0;
  let sum = 0;
  for (let r = 0; r < grid.height; r++) {
    for (let c = 0; c < grid.width; c++) {
      const px = grid.ox + (grid.c0 + c + 0.5) * grid.rx;
      const py = grid.oy + (grid.r0 + r + 0.5) * grid.ry;
      if (Math.abs(px - x) > radiusM || Math.abs(py - y) > radiusM) continue;
      total++;
      const v = valueAt(px, py);
      if (v === null) continue;
      sum += v;
      clear++;
    }
  }
  const clearFraction = total ? clear / total : 0;
  return {
    value: clear && clearFraction >= MIN_CLEAR ? Math.round((sum / clear) * 1000) / 1000 : null,
    clearFraction: Math.round(clearFraction * 100) / 100,
  };
}

/** Surface reflectance of a digital number (0 = no data → null). */
const reflectance = (dn, band) => (dn ? Math.max(0, dn * band.scale + band.offset) : null);
/** (a − b) / (a + b) of two reflectances, null when either is missing. */
const normalisedDifference = (a, b) => (a === null || b === null || a + b <= 0 ? null : Math.max(-1, Math.min(1, (a - b) / (a + b))));

/**
 * NDVI of the clear pixels within ~30 m of the point in one scene, and NDMI
 * of the clear 20 m pixels within ~20 m (when the scene has B11).
 */
async function sceneIndices(scene, lat, lon, fetchImpl, { radiusM = WINDOW_RADIUS_M, timeoutMs } = {}) {
  const { x, y } = projectToScene(scene, lat, lon);
  const nirRadius = scene.swir16 ? Math.max(radiusM, NDMI_RADIUS_M + 10) : radiusM;
  const [red, nir, scl, swir16] = await Promise.all([
    readWindow(scene.red.href, x, y, radiusM, fetchImpl, timeoutMs),
    readWindow(scene.nir.href, x, y, nirRadius, fetchImpl, timeoutMs),
    readWindow(scene.scl.href, x, y, radiusM + 20, fetchImpl, timeoutMs),
    scene.swir16 ? readWindow(scene.swir16.href, x, y, NDMI_RADIUS_M, fetchImpl, timeoutMs) : null,
  ]);
  const clearAt = (px, py) => SCL_CLEAR.has(scl.at(px, py));
  // NDVI over the 10 m pixels.
  const v = windowMean(nir, x, y, radiusM, (px, py) => (clearAt(px, py)
    ? normalisedDifference(reflectance(nir.at(px, py), scene.nir), reflectance(red.at(px, py), scene.red)) : null));
  // NDMI over the 20 m SWIR pixels, NIR as the mean of the four 10 m pixels inside each.
  const nirMean = (px, py) => {
    const values = [[-5, -5], [5, -5], [-5, 5], [5, 5]].map(([dx, dy]) => reflectance(nir.at(px + dx, py + dy), scene.nir));
    return values.includes(null) ? null : values.reduce((a, b) => a + b, 0) / 4;
  };
  const m = swir16 ? windowMean(swir16, x, y, NDMI_RADIUS_M, (px, py) => (clearAt(px, py)
    ? normalisedDifference(nirMean(px, py), reflectance(swir16.at(px, py), scene.swir16)) : null)) : null;
  return { ndvi: v.value, ndmi: m ? m.value : null, clearFraction: v.clearFraction };
}

const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const monthIndex = (ym) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;

/**
 * Monthly values from per-scene values: per sensor and index the median of
 * the clear scenes of the month. Sentinel-2 wins where it has a value;
 * otherwise the Landsat sensors of the month count, mapped onto the
 * Sentinel-2 scale with `harmonization` (src/harmonize.js) where it has a fit
 * for the sensor. A month appears when it has an NDVI or an NDMI.
 * `adjusted`: null when only Sentinel-2 counts, true when every Landsat value
 * used was adjusted, false when one was used as measured; `raw` keeps the
 * per-sensor medians.
 */
function monthlySeries(scenes, harmonization = null) {
  const months = sensorMonths(scenes);
  const round = (v) => Math.round(v * 1000) / 1000;
  const datesOf = new Map();
  for (const s of scenes) {
    const m = s.date.slice(0, 7);
    if (months.has(m)) datesOf.set(m, [...(datesOf.get(m) || []), s.date]);
  }
  return [...months.keys()].sort().map((month) => {
    const by = months.get(month);
    let adjusted = null;
    let scenesUsed = 0;
    const pick = (key) => {
      if (by.S2 && by.S2[key] !== null) {
        if (key === 'ndvi') scenesUsed += by.S2.scenes;
        return by.S2[key];
      }
      const values = [];
      for (const sensor of Object.keys(by).filter((x) => x !== 'S2').sort()) {
        const raw = by[sensor][key];
        if (raw === null) continue;
        const fit = harmonization?.[key]?.[sensor] || null;
        values.push(fit ? adjust(raw, fit) : raw);
        adjusted = (adjusted ?? true) && Boolean(fit);
        if (key === 'ndvi') scenesUsed += by[sensor].scenes;
      }
      return values.length ? median(values) : null;
    };
    const ndvi = pick('ndvi');
    const ndmi = pick('ndmi');
    return {
      month,
      ndvi: ndvi === null ? null : round(ndvi),
      ndmi: ndmi === null ? null : round(ndmi),
      scenes: scenesUsed,
      dates: datesOf.get(month) || [],
      sensors: Object.keys(by).sort((a, b) => (a === 'S2' ? -1 : b === 'S2' ? 1 : a.localeCompare(b))),
      adjusted,
      raw: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, { ndvi: v.ndvi === null ? null : round(v.ndvi), ndmi: v.ndmi === null ? null : round(v.ndmi) }])),
    };
  });
}

const indexOf = (monthly, key) => new Map(monthly.filter((m) => m[key] !== null && m[key] !== undefined).map((m) => [monthIndex(m.month), m[key]]));
/** Month indices of `byIndex` in the season (±1 month) of month index `target` within [lo, hi]. */
const seasonMonths = (byIndex, target, lo, hi) => {
  const out = [];
  for (let i = lo; i <= hi; i++) {
    const d = Math.abs((((i - target) % 12) + 12) % 12);
    if (Math.min(d, 12 - d) <= 1 && byIndex.has(i)) out.push(i);
  }
  return out;
};
const severityOf = (key, drop) => (drop >= THRESHOLDS[key][1] ? 'stark' : 'auffällig');

/**
 * Strong drops of an index (`key`: 'ndvi' or 'ndmi') between consecutive
 * photo dates. Both follow the seasons (deciduous forest is low in winter),
 * so the value around the later photo is compared with the same season
 * (±1 month) during the two years up to the earlier photo. `photos` are
 * { id, takenAt (ISO) } sorted by time.
 */
function indexDrops(monthly, photos, { key = 'ndvi', threshold = THRESHOLDS[key][0] } = {}) {
  const byIndex = indexOf(monthly, key);
  const drops = [];
  for (let k = 1; k < photos.length; k++) {
    const a = photos[k - 1];
    const b = photos[k];
    const ia = monthIndex(a.takenAt.slice(0, 7));
    const ib = monthIndex(b.takenAt.slice(0, 7));
    if (ib - ia < 1) continue;
    const after = [ib - 1, ib, ib + 1].filter((i) => i > ia && byIndex.has(i)).map((i) => byIndex.get(i));
    const before = seasonMonths(byIndex, ib, ia - 24, ia).map((i) => byIndex.get(i));
    if (!after.length || !before.length) continue;
    const vBefore = median(before);
    const vAfter = median(after);
    // Rounded before comparing: 0.84 − 0.74 is 0.0999… in floating point and must count as 0.10.
    const drop = Math.round((vBefore - vAfter) * 1000) / 1000;
    if (drop >= threshold) {
      drops.push({
        index: key,
        fromPhotoId: a.id,
        toPhotoId: b.id,
        fromDate: a.takenAt.slice(0, 10),
        toDate: b.takenAt.slice(0, 10),
        before: Math.round(vBefore * 1000) / 1000,
        after: Math.round(vAfter * 1000) / 1000,
        drop: Math.round(drop * 1000) / 1000,
        severity: severityOf(key, drop),
      });
    }
  }
  return drops;
}

/** NDVI drops between photo dates (see indexDrops). */
const ndviDrops = (monthly, photos, opts = {}) => indexDrops(monthly, photos, { key: 'ndvi', ...opts });

/**
 * The early-warning comparison per index, without a threshold: the median of
 * the last `recentMonths` months with data (ending at most `maxAgeMonths`
 * before `now`) against the same season (±1 month) in the years before (up
 * to five). Needs at least two baseline values; uses no data after `now`.
 * Returns { ndvi, ndmi } with null where there is nothing to compare.
 */
function anomalyScores(monthly, { now = Date.now(), recentMonths = 2, maxAgeMonths = 3 } = {}) {
  const d = new Date(now);
  const current = d.getUTCFullYear() * 12 + d.getUTCMonth();
  const out = { ndvi: null, ndmi: null };
  for (const key of ['ndvi', 'ndmi']) {
    const byIndex = indexOf(monthly, key);
    const recent = [...byIndex.keys()].filter((i) => i <= current && i > current - maxAgeMonths).sort((a, b) => b - a).slice(0, recentMonths);
    if (!recent.length) continue;
    const newest = recent[0];
    const oldest = recent[recent.length - 1];
    // Same season, from one year before the recent window back five years.
    const baseline = seasonMonths(byIndex, newest, newest - 60, oldest - 11);
    if (baseline.length < 2) continue;
    const vNow = median(recent.map((i) => byIndex.get(i)));
    const vBase = median(baseline.map((i) => byIndex.get(i)));
    const ym = (i) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
    out[key] = {
      index: key,
      since: ym(oldest),
      until: ym(newest),
      now: Math.round(vNow * 1000) / 1000,
      baseline: Math.round(vBase * 1000) / 1000,
      baselineYears: new Set(baseline.map((i) => Math.floor(i / 12))).size,
      drop: Math.round((vBase - vNow) * 1000) / 1000,
    };
  }
  return out;
}

/**
 * Early warning without photos: the indices whose drop (anomalyScores)
 * reaches its threshold. `thresholds` maps index → [threshold, strong]
 * (calibrated ones from src/calibration.js, else the starting values).
 */
function currentAnomalies(monthly, { thresholds = THRESHOLDS, ...opts } = {}) {
  const scores = anomalyScores(monthly, opts);
  return ['ndvi', 'ndmi'].filter((k) => scores[k] && scores[k].drop >= thresholds[k][0]).map((k) => ({
    ...scores[k],
    severity: scores[k].drop >= thresholds[k][1] ? 'stark' : 'auffällig',
  }));
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS spot_ndvi (
    spot_id    INTEGER PRIMARY KEY REFERENCES spots (id) ON DELETE CASCADE,
    lat        REAL NOT NULL,
    lon        REAL NOT NULL,
    from_date  TEXT,
    to_date    TEXT,
    fetched_at INTEGER,
    complete   INTEGER NOT NULL DEFAULT 0,
    error      TEXT
  );
  CREATE TABLE IF NOT EXISTS spot_ndvi_scenes (
    spot_id        INTEGER NOT NULL REFERENCES spots (id) ON DELETE CASCADE,
    scene_id       TEXT NOT NULL,
    date           TEXT NOT NULL,
    cloud          REAL,
    ndvi           REAL,
    clear_fraction REAL,
    PRIMARY KEY (spot_id, scene_id)
  );
`;
// Added with NDMI and Landsat: the moisture index, the sensor and which index version a row holds.
const MIGRATIONS = [
  ['spot_ndvi_scenes', 'ndmi', 'REAL'],
  ['spot_ndvi_scenes', 'sensor', "TEXT NOT NULL DEFAULT 'S2'"],
  ['spot_ndvi_scenes', 'v', 'INTEGER NOT NULL DEFAULT 1'],
  ['spot_ndvi', 'landsat_error', 'TEXT'],
];

const DAY = 86400000;
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const LANDSAT_START = '1984-04-01'; // Landsat 5 Thematic Mapper

/**
 * Satellite service with a per-spot cache in the database. `refresh(spotId)`
 * searches scenes over the spot's photo period (from a year before the first
 * photo until today: Sentinel-2 from 2017, Landsat before when `landsat` is
 * given) and evaluates the scenes not evaluated yet, at most `maxScenes` per
 * call so a long history is filled in over several refreshes. Scenes cached
 * by an older index version are evaluated again (newest first) within the
 * same budget.
 */
function createSentinel({ db, fetchImpl = fetch, stacUrl = STAC_URL, landsat = null, maxScenes = 60, timeoutMs = 20000, now = () => Date.now() }) {
  db.exec(SCHEMA);
  for (const [table, column, type] of MIGRATIONS) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  const getStatus = db.prepare('SELECT * FROM spot_ndvi WHERE spot_id = ?');
  const sceneRows = db.prepare('SELECT scene_id, date, cloud, ndvi, ndmi, sensor, v, clear_fraction FROM spot_ndvi_scenes WHERE spot_id = ? ORDER BY date');

  function period(spotId) {
    const r = db.prepare('SELECT MIN(taken_at) AS first, MAX(taken_at) AS last FROM photos WHERE spot_id = ?').get(spotId);
    if (r?.first === null || r?.first === undefined) return null;
    // A year of history before the first photo gives the baseline; before 2017 only Landsat has it.
    const from = Math.max(Date.parse(landsat ? LANDSAT_START : SENTINEL_START), r.first - 365 * DAY);
    return { from: isoDate(from), to: isoDate(now()) };
  }

  /** Whether the cached series should be (re)fetched. */
  function needsRefresh(spotId) {
    const spot = db.prepare('SELECT lat, lon FROM spots WHERE id = ?').get(spotId);
    const p = period(spotId);
    if (!spot || !p) return false;
    const st = getStatus.get(spotId);
    if (!st || st.fetched_at === null) return true;
    const moved = Math.abs(st.lat - spot.lat) > 1e-4 || Math.abs(st.lon - spot.lon) > 1e-4;
    if (moved || p.from < st.from_date) return true;
    const age = now() - st.fetched_at;
    if (st.error) return age > 3600000; // offline: retry after an hour
    if (!st.complete) return true; // more scenes waiting
    return age > 7 * DAY; // new acquisitions every few days
  }

  async function refresh(spotId) {
    const spot = db.prepare('SELECT lat, lon FROM spots WHERE id = ?').get(spotId);
    const p = period(spotId);
    if (!spot || !p) return;
    const st = getStatus.get(spotId);
    if (st && (Math.abs(st.lat - spot.lat) > 1e-4 || Math.abs(st.lon - spot.lon) > 1e-4)) {
      // The spot centre moved (new photos): the cached window no longer fits.
      db.prepare('DELETE FROM spot_ndvi_scenes WHERE spot_id = ?').run(spotId);
    }
    const save = (complete, error, landsatError = null) => db.prepare(`
      INSERT INTO spot_ndvi (spot_id, lat, lon, from_date, to_date, fetched_at, complete, error, landsat_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (spot_id) DO UPDATE SET lat = excluded.lat, lon = excluded.lon, from_date = excluded.from_date,
        to_date = excluded.to_date, fetched_at = excluded.fetched_at, complete = excluded.complete, error = excluded.error,
        landsat_error = excluded.landsat_error
    `).run(spotId, spot.lat, spot.lon, p.from, p.to, now(), complete ? 1 : 0, error, landsatError);

    // Sentinel-2 from 2017; Landsat for the years before, when the photos reach back that far, and on through
    // the overlap years, where both sensors see the spot and can be harmonised.
    let scenes;
    try {
      const from = p.from > SENTINEL_START ? p.from : SENTINEL_START;
      scenes = await searchScenes({ lat: spot.lat, lon: spot.lon, from, to: p.to, fetchImpl, stacUrl, timeoutMs });
    } catch (err) {
      save(false, err.message);
      return;
    }
    let landsatError = null;
    if (landsat && p.from < SENTINEL_START) {
      try {
        scenes.push(...await landsat.scenes(spot.lat, spot.lon, p.from, p.to < OVERLAP_END ? p.to : OVERLAP_END));
      } catch (err) {
        // Landsat is extra history: Sentinel-2 goes ahead, Landsat is tried again later.
        landsatError = err.message;
      }
    }
    const read = (s) => (s.sensor === 'S2' ? sceneIndices(s, spot.lat, spot.lon, fetchImpl, { timeoutMs }) : landsat.indices(s, spot.lat, spot.lon));
    const done = new Map(sceneRows.all(spotId).map((r) => [r.scene_id, r]));
    const insert = db.prepare(`
      INSERT OR REPLACE INTO spot_ndvi_scenes (spot_id, scene_id, date, cloud, ndvi, ndmi, sensor, v, clear_fraction)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    // Per month and sensor: lowest cloud cover first, until enough clear scenes or attempts. Each Landsat
    // sensor gets its own scene in a month, so months seen by two sensors pair up for the harmonisation.
    const byMonth = new Map();
    for (const s of scenes) {
      const key = `${s.date.slice(0, 7)}|${s.sensor}`;
      if (!byMonth.has(key)) byMonth.set(key, []);
      byMonth.get(key).push(s);
    }
    let budget = maxScenes;
    let complete = !landsatError;
    let lastError = null;
    let failures = 0;
    // Newest months first: the recent past matters most for fresh photos and the early warning.
    for (const key of [...byMonth.keys()].sort().reverse()) {
      const list = byMonth.get(key).sort((a, b) => (a.cloud ?? 100) - (b.cloud ?? 100));
      const sentinel2 = key.endsWith('|S2');
      const quota = sentinel2 ? SCENES_PER_MONTH : LANDSAT_PER_MONTH;
      const attempts = sentinel2 ? ATTEMPTS_PER_MONTH : LANDSAT_ATTEMPTS;
      let clear = 0;
      let tried = 0;
      for (const s of list) {
        if (clear >= quota || tried >= attempts) break;
        tried++;
        const cached = done.get(s.id);
        // Rows of the current version (or scenes without the bands for more) need no new read.
        if (cached && (cached.v >= INDEX_VERSION || (s.sensor === 'S2' && !s.swir16))) {
          if (cached.ndvi !== null) clear++;
          continue;
        }
        if (budget <= 0) { complete = false; break; }
        budget--;
        try {
          const r = await read(s);
          insert.run(spotId, s.id, s.date, s.cloud, r.ndvi, r.ndmi, s.sensor, INDEX_VERSION, r.clearFraction);
          if (r.ndvi !== null) clear++;
        } catch (err) {
          // A scene that cannot cover the spot is recorded as without value.
          if (err.permanent) { insert.run(spotId, s.id, s.date, s.cloud, null, null, s.sensor, INDEX_VERSION, 0); continue; }
          // Network trouble: an old row keeps its NDVI; the scene is tried again on the next refresh.
          if (cached && cached.ndvi !== null) clear++;
          lastError = err.message;
          complete = false;
          if (++failures >= 3) { save(false, `Szenen nicht lesbar: ${lastError}`, landsatError); return; }
        }
      }
    }
    save(complete, null, landsatError);
  }

  /** Cached series of a spot with status information. */
  function series(spotId) {
    const st = getStatus.get(spotId);
    const scenes = sceneRows.all(spotId).map((r) => ({
      id: r.scene_id, date: r.date, cloud: r.cloud, ndvi: r.ndvi, ndmi: r.ndmi, sensor: r.sensor, clearFraction: r.clear_fraction,
    }));
    return {
      fetchedAt: st?.fetched_at ? new Date(st.fetched_at).toISOString() : null,
      from: st?.from_date ?? null,
      to: st?.to_date ?? null,
      complete: Boolean(st?.complete),
      error: st?.error ?? null,
      landsatError: st?.landsat_error ?? null,
      scenesEvaluated: scenes.length,
      monthly: monthlySeries(scenes, harmonization()),
    };
  }

  /* ---------- Harmonisation of Landsat with Sentinel-2 ---------- */

  db.exec('CREATE TABLE IF NOT EXISTS satellite_harmonization (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, computed_at INTEGER NOT NULL)');
  const allScenes = db.prepare('SELECT spot_id, date, ndvi, ndmi, sensor FROM spot_ndvi_scenes ORDER BY spot_id');

  /** Fits the harmonisation on the month pairs of all spots and stores it. */
  function harmonize() {
    const bySpot = new Map();
    for (const r of allScenes.all()) {
      if (!bySpot.has(r.spot_id)) bySpot.set(r.spot_id, []);
      bySpot.get(r.spot_id).push(r);
    }
    const fit = fitHarmonization([...bySpot.values()]);
    db.prepare('INSERT OR REPLACE INTO satellite_harmonization (id, json, computed_at) VALUES (1, ?, ?)').run(JSON.stringify(fit), now());
    return { ...fit, computedAt: new Date(now()).toISOString() };
  }

  /** The stored harmonisation (fitted on first use). */
  function harmonization() {
    const row = db.prepare('SELECT json, computed_at FROM satellite_harmonization WHERE id = 1').get();
    return row ? { ...JSON.parse(row.json), computedAt: new Date(row.computed_at).toISOString() } : harmonize();
  }

  return { refresh, needsRefresh, series, harmonize, harmonization };
}

module.exports = {
  createSentinel, searchScenes, stacSearch, sceneIndices, readWindow, projectToScene, windowMean, reflectance, normalisedDifference,
  monthlySeries, indexDrops, ndviDrops, anomalyScores, currentAnomalies, sceneOf, reflectanceScale,
  latLonFromUtm, STAC_URL, NDVI_DROP, NDMI_DROP, THRESHOLDS, SENTINEL_START, OVERLAP_END,
};
