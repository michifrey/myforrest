'use strict';

/*
 * Landsat 5, 7 and 8 (Collection 2, Level 2 surface reflectance) for the
 * satellite context before Sentinel-2, i.e. for photos from before 2018.
 *
 * Scenes come from Microsoft's Planetary Computer: its STAC API finds them
 * and a free, anonymous SAS token (no account) signs the links to the
 * Cloud-Optimized GeoTIFFs, which are read with the same range requests as
 * Sentinel-2 (src/sentinel.js). Pixels are 30 m; clouds, cloud shadow,
 * cirrus and snow are masked with the QA_PIXEL bits; the stripes of
 * Landsat 7 after 2003 (SLC off) have no data and drop out like clouds.
 *
 * NDVI from Landsat runs slightly lower than from Sentinel-2 over forest
 * (other band widths); the series mark the sensor of each month.
 */

const { stacSearch, readWindow, projectToScene, windowMean, reflectance, normalisedDifference } = require('./sentinel');

const STAC_URL = 'https://planetarycomputer.microsoft.com/api/stac/v1';
const TOKEN_URL = 'https://planetarycomputer.microsoft.com/api/sas/v1/token/landsat-c2-l2';
const COLLECTION = 'landsat-c2-l2';
const PLATFORMS = ['landsat-5', 'landsat-7', 'landsat-8'];
const MAX_CLOUD = 60;
const WINDOW_RADIUS_M = 15; // pixel centres within 15 m: one to four 30 m pixels
// QA_PIXEL bits 0–5: fill, dilated cloud, cirrus, cloud, cloud shadow, snow. Water (bit 7) is kept, like in Sentinel-2.
const QA_MASK = 0b111111;
const SENSOR = { 'landsat-5': 'L5', 'landsat-7': 'L7', 'landsat-8': 'L8' };

/** Scale and offset of Collection 2 surface reflectance (from the item, else the documented values). */
function scaleOf(asset) {
  const band = asset?.['raster:bands']?.[0];
  if (band && Number.isFinite(band.scale)) return { scale: band.scale, offset: Number.isFinite(band.offset) ? band.offset : 0 };
  return { scale: 0.0000275, offset: -0.2 };
}

/** Normalises a Planetary Computer Landsat item to what the indices need (or null). */
function landsatSceneOf(item) {
  const a = item.assets || {};
  const p = item.properties || {};
  const epsg = Number.isFinite(p['proj:epsg']) ? p['proj:epsg'] : Number((/^EPSG:(\d+)$/.exec(p['proj:code'] || '') || [])[1]) || null;
  if (!a.red?.href || !a.nir08?.href || !a.qa_pixel?.href || !epsg || !p.datetime) return null;
  return {
    id: item.id,
    sensor: SENSOR[p.platform] || 'L',
    date: p.datetime.slice(0, 10),
    cloud: p['eo:cloud_cover'] ?? null,
    epsg,
    red: { href: a.red.href, ...scaleOf(a.red) },
    nir: { href: a.nir08.href, ...scaleOf(a.nir08) },
    swir16: a.swir16?.href ? { href: a.swir16.href, ...scaleOf(a.swir16) } : null,
    qa: { href: a.qa_pixel.href },
  };
}

/**
 * Landsat source with a cached SAS token. `scenes(lat, lon, from, to)`
 * searches, `indices(scene, lat, lon)` reads NDVI and NDMI at the point.
 */
function createLandsat({ fetchImpl = fetch, stacUrl = STAC_URL, tokenUrl = TOKEN_URL, timeoutMs = 20000, now = () => Date.now() } = {}) {
  let token = null;
  let expires = 0;
  async function sign(href) {
    if (!token || now() > expires - 5 * 60000) {
      const res = await fetchImpl(tokenUrl, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`Planetary-Computer-Token: HTTP ${res.status}`);
      const json = await res.json();
      if (!json.token) throw new Error('Planetary Computer lieferte kein Token');
      token = json.token;
      expires = Date.parse(json['msft:expiry']) || now() + 30 * 60000;
    }
    return `${href}${href.includes('?') ? '&' : '?'}${token}`;
  }

  function scenes(lat, lon, from, to) {
    return stacSearch({
      stacUrl, fetchImpl, timeoutMs, toScene: landsatSceneOf,
      body: {
        collections: [COLLECTION],
        intersects: { type: 'Point', coordinates: [lon, lat] },
        datetime: `${from}T00:00:00Z/${to}T23:59:59Z`,
        query: { 'eo:cloud_cover': { lt: MAX_CLOUD }, platform: { in: PLATFORMS } },
        limit: 100,
      },
    });
  }

  async function indices(scene, lat, lon) {
    const { x, y } = projectToScene(scene, lat, lon);
    const r = WINDOW_RADIUS_M;
    const [red, nir, qa, swir16] = await Promise.all([
      readWindow(await sign(scene.red.href), x, y, r, fetchImpl, timeoutMs),
      readWindow(await sign(scene.nir.href), x, y, r, fetchImpl, timeoutMs),
      readWindow(await sign(scene.qa.href), x, y, r + 30, fetchImpl, timeoutMs),
      scene.swir16 ? readWindow(await sign(scene.swir16.href), x, y, r, fetchImpl, timeoutMs) : null,
    ]);
    const clearAt = (px, py) => {
      const q = qa.at(px, py);
      return q !== null && (q & QA_MASK) === 0;
    };
    // All bands share the 30 m grid.
    const index = (other, band) => (px, py) => (clearAt(px, py)
      ? normalisedDifference(reflectance(nir.at(px, py), scene.nir), reflectance(other.at(px, py), band)) : null);
    const v = windowMean(nir, x, y, r, index(red, scene.red));
    const m = swir16 ? windowMean(nir, x, y, r, index(swir16, scene.swir16)) : null;
    return { ndvi: v.value, ndmi: m ? m.value : null, clearFraction: v.clearFraction };
  }

  return { scenes, indices };
}

module.exports = { createLandsat, landsatSceneOf, STAC_URL, TOKEN_URL };
