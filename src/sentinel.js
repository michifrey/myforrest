'use strict';

/*
 * Satellite context: Sentinel-2 L2A NDVI time series for a spot.
 *
 * Scenes are found with the public Earth Search STAC API (Element 84, no key)
 * and read as Cloud-Optimized GeoTIFFs: only the few hundred bytes of header
 * and the one internal tile around the spot are fetched with HTTP range
 * requests. Per scene the red (B04) and near-infrared (B08) reflectance of a
 * ~30 m window (3 × 3 pixels of 10 m) is read, clouds, shadows and snow are
 * masked with the scene classification (SCL, 20 m), and the mean NDVI of the
 * clear pixels is cached. Scenes are grouped per month; the monthly value is
 * the median of the clear scenes of that month.
 *
 * Without network access every step fails softly: the spot simply has no
 * satellite series and the cached values (if any) are kept.
 */

const { utmFromLatLon, latLonFromUtm } = require('./utm');

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
  if (band && Number.isFinite(band.scale)) return { scale: band.scale, offset: Number.isFinite(band.offset) ? band.offset : 0 };
  // Processing baseline 04.00 (2022) added an offset of −1000 to the digital numbers.
  const baseline = Number.parseFloat(properties?.['s2:processing_baseline'] || '0');
  const applied = properties?.['earthsearch:boa_offset_applied'];
  return { scale: 1e-4, offset: baseline >= 4 && !applied ? -0.1 : 0 };
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
  const epsg = itemEpsg(item);
  const datetime = item.properties?.datetime;
  if (!red?.href || !nir?.href || !scl?.href || !epsg || !datetime) return null;
  return {
    id: item.id,
    date: datetime.slice(0, 10),
    cloud: item.properties['eo:cloud_cover'] ?? null,
    epsg,
    red: { href: red.href, ...reflectanceScale(red, item.properties) },
    nir: { href: nir.href, ...reflectanceScale(nir, item.properties) },
    scl: { href: scl.href },
  };
}

/** All scenes over a point within [from, to] (YYYY-MM-DD), following STAC paging. */
async function searchScenes({ lat, lon, from, to, fetchImpl, stacUrl = STAC_URL, maxPages = 20, timeoutMs = 20000 }) {
  let req = {
    url: `${stacUrl.replace(/\/$/, '')}/search`,
    method: 'POST',
    body: {
      collections: [COLLECTION],
      intersects: { type: 'Point', coordinates: [lon, lat] },
      datetime: `${from}T00:00:00Z/${to}T23:59:59Z`,
      query: { 'eo:cloud_cover': { lt: MAX_CLOUD } },
      limit: 100,
    },
  };
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
      const s = sceneOf(f);
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

/** Mean NDVI of the clear pixels within ~30 m of the point in one scene. */
async function sceneNdvi(scene, lat, lon, fetchImpl, { radiusM = WINDOW_RADIUS_M, timeoutMs } = {}) {
  const zone = scene.epsg % 100;
  const south = Math.floor(scene.epsg / 100) === 327;
  if (!(Math.floor(scene.epsg / 100) === 326 || south) || zone < 1 || zone > 60) {
    throw Object.assign(new Error(`Projektion EPSG:${scene.epsg} nicht unterstützt`), { permanent: true });
  }
  const { x, y } = utmFromLatLon(lat, lon, zone, south);
  const [red, nir, scl] = await Promise.all([
    readWindow(scene.red.href, x, y, radiusM, fetchImpl, timeoutMs),
    readWindow(scene.nir.href, x, y, radiusM, fetchImpl, timeoutMs),
    readWindow(scene.scl.href, x, y, radiusM + 20, fetchImpl, timeoutMs),
  ]);
  let total = 0;
  let clear = 0;
  let sum = 0;
  for (let r = 0; r < red.height; r++) {
    for (let c = 0; c < red.width; c++) {
      const px = red.ox + (red.c0 + c + 0.5) * red.rx;
      const py = red.oy + (red.r0 + r + 0.5) * red.ry;
      // Only pixels whose centre lies within the window radius (a 3 × 3 block at 10 m).
      if (Math.abs(px - x) > radiusM || Math.abs(py - y) > radiusM) continue;
      total++;
      const dnRed = red.data[r * red.width + c];
      const dnNir = nir.at(px, py);
      const cls = scl.at(px, py);
      if (!dnRed || !dnNir || !SCL_CLEAR.has(cls)) continue;
      const R = Math.max(0, dnRed * scene.red.scale + scene.red.offset);
      const N = Math.max(0, dnNir * scene.nir.scale + scene.nir.offset);
      if (R + N <= 0) continue;
      sum += Math.max(-1, Math.min(1, (N - R) / (N + R)));
      clear++;
    }
  }
  const clearFraction = total ? clear / total : 0;
  return {
    ndvi: clear && clearFraction >= MIN_CLEAR ? Math.round((sum / clear) * 1000) / 1000 : null,
    clearFraction: Math.round(clearFraction * 100) / 100,
  };
}

const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const monthIndex = (ym) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;

/** Monthly NDVI from per-scene values: median of the clear scenes of each month. */
function monthlySeries(scenes) {
  const byMonth = new Map();
  for (const s of scenes) {
    if (s.ndvi === null || s.ndvi === undefined) continue;
    const m = s.date.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(s);
  }
  return [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, list]) => ({
    month,
    ndvi: Math.round(median(list.map((s) => s.ndvi)) * 1000) / 1000,
    scenes: list.length,
    dates: list.map((s) => s.date),
  }));
}

/**
 * Strong NDVI drops between consecutive photo dates. NDVI follows the
 * seasons (deciduous forest is low in winter), so the value around the later
 * photo is compared with the same season (±1 month) during the two years up
 * to the earlier photo. `photos` are { id, takenAt (ISO) } sorted by time.
 */
function ndviDrops(monthly, photos, { threshold = NDVI_DROP } = {}) {
  const byIndex = new Map(monthly.map((m) => [monthIndex(m.month), m.ndvi]));
  const drops = [];
  for (let k = 1; k < photos.length; k++) {
    const a = photos[k - 1];
    const b = photos[k];
    const ia = monthIndex(a.takenAt.slice(0, 7));
    const ib = monthIndex(b.takenAt.slice(0, 7));
    if (ib - ia < 1) continue;
    const after = [ib - 1, ib, ib + 1].filter((i) => i > ia && byIndex.has(i)).map((i) => byIndex.get(i));
    const before = [];
    for (let i = ia - 24; i <= ia; i++) {
      const d = Math.abs((((i - ib) % 12) + 12) % 12);
      if (Math.min(d, 12 - d) <= 1 && byIndex.has(i)) before.push(byIndex.get(i));
    }
    if (!after.length || !before.length) continue;
    const vBefore = median(before);
    const vAfter = median(after);
    const drop = vBefore - vAfter;
    if (drop >= threshold) {
      drops.push({
        fromPhotoId: a.id,
        toPhotoId: b.id,
        fromDate: a.takenAt.slice(0, 10),
        toDate: b.takenAt.slice(0, 10),
        before: Math.round(vBefore * 1000) / 1000,
        after: Math.round(vAfter * 1000) / 1000,
        drop: Math.round(drop * 1000) / 1000,
        severity: drop >= NDVI_DROP_STRONG ? 'stark' : 'auffällig',
      });
    }
  }
  return drops;
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

const DAY = 86400000;
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * NDVI service with a per-spot cache in the database. `refresh(spotId)`
 * searches scenes over the spot's photo period (from a year before the first
 * photo until today) and evaluates the scenes not evaluated yet, at most
 * `maxScenes` per call so a long history is filled in over several refreshes.
 */
function createSentinel({ db, fetchImpl = fetch, stacUrl = STAC_URL, maxScenes = 60, timeoutMs = 20000 }) {
  db.exec(SCHEMA);
  const getStatus = db.prepare('SELECT * FROM spot_ndvi WHERE spot_id = ?');
  const sceneRows = db.prepare('SELECT scene_id, date, cloud, ndvi, clear_fraction FROM spot_ndvi_scenes WHERE spot_id = ? ORDER BY date');

  function period(spotId) {
    const r = db.prepare('SELECT MIN(taken_at) AS first, MAX(taken_at) AS last FROM photos WHERE spot_id = ?').get(spotId);
    if (r?.first === null || r?.first === undefined) return null;
    // Sentinel-2 L2A coverage starts in 2017; a year of history before the first photo gives the baseline.
    const from = Math.max(Date.parse('2017-01-01'), r.first - 365 * DAY);
    return { from: isoDate(from), to: isoDate(Date.now()) };
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
    const age = Date.now() - st.fetched_at;
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
    const save = (complete, error) => db.prepare(`
      INSERT INTO spot_ndvi (spot_id, lat, lon, from_date, to_date, fetched_at, complete, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (spot_id) DO UPDATE SET lat = excluded.lat, lon = excluded.lon, from_date = excluded.from_date,
        to_date = excluded.to_date, fetched_at = excluded.fetched_at, complete = excluded.complete, error = excluded.error
    `).run(spotId, spot.lat, spot.lon, p.from, p.to, Date.now(), complete ? 1 : 0, error);

    let scenes;
    try {
      scenes = await searchScenes({ lat: spot.lat, lon: spot.lon, from: p.from, to: p.to, fetchImpl, stacUrl, timeoutMs });
    } catch (err) {
      save(false, err.message);
      return;
    }
    const done = new Map(sceneRows.all(spotId).map((r) => [r.scene_id, r]));
    const insert = db.prepare(`
      INSERT OR REPLACE INTO spot_ndvi_scenes (spot_id, scene_id, date, cloud, ndvi, clear_fraction)
      VALUES (?, ?, ?, ?, ?, ?)`);
    // Per month: lowest cloud cover first, until enough clear scenes or attempts.
    const byMonth = new Map();
    for (const s of scenes) {
      const m = s.date.slice(0, 7);
      if (!byMonth.has(m)) byMonth.set(m, []);
      byMonth.get(m).push(s);
    }
    let budget = maxScenes;
    let complete = true;
    let lastError = null;
    let failures = 0;
    // Newest months first: the recent past matters most for fresh photos.
    for (const month of [...byMonth.keys()].sort().reverse()) {
      const list = byMonth.get(month).sort((a, b) => (a.cloud ?? 100) - (b.cloud ?? 100));
      let clear = 0;
      let tried = 0;
      for (const s of list) {
        if (clear >= SCENES_PER_MONTH || tried >= ATTEMPTS_PER_MONTH) break;
        tried++;
        const cached = done.get(s.id);
        if (cached) {
          if (cached.ndvi !== null) clear++;
          continue;
        }
        if (budget <= 0) { complete = false; break; }
        budget--;
        try {
          const r = await sceneNdvi(s, spot.lat, spot.lon, fetchImpl, { timeoutMs });
          insert.run(spotId, s.id, s.date, s.cloud, r.ndvi, r.clearFraction);
          if (r.ndvi !== null) clear++;
        } catch (err) {
          // A scene that cannot cover the spot is recorded as without value.
          if (err.permanent) { insert.run(spotId, s.id, s.date, s.cloud, null, 0); continue; }
          // Network trouble: leave the scene for the next refresh.
          lastError = err.message;
          complete = false;
          if (++failures >= 3) { save(false, `Szenen nicht lesbar: ${lastError}`); return; }
        }
      }
    }
    save(complete, null);
  }

  /** Cached series of a spot with status information. */
  function series(spotId) {
    const st = getStatus.get(spotId);
    const scenes = sceneRows.all(spotId).map((r) => ({
      id: r.scene_id, date: r.date, cloud: r.cloud, ndvi: r.ndvi, clearFraction: r.clear_fraction,
    }));
    return {
      fetchedAt: st?.fetched_at ? new Date(st.fetched_at).toISOString() : null,
      from: st?.from_date ?? null,
      to: st?.to_date ?? null,
      complete: Boolean(st?.complete),
      error: st?.error ?? null,
      scenesEvaluated: scenes.length,
      monthly: monthlySeries(scenes),
    };
  }

  return { refresh, needsRefresh, series };
}

module.exports = {
  createSentinel, searchScenes, sceneNdvi, readWindow, monthlySeries, ndviDrops, sceneOf, reflectanceScale,
  latLonFromUtm, STAC_URL, NDVI_DROP,
};
