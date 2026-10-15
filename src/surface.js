'use strict';

/*
 * Heights of trees and buildings for the shadows on the map: swisstopo's
 * surface model swissSURFACE3D Raster (everything, 0.5 m) minus the terrain
 * model swissALTI3D (bare ground), i.e. how far trees and roofs stand above
 * the ground. Both are free (OGD) Cloud Optimized GeoTIFFs in 1-km tiles of
 * the Swiss grid (LV95), listed in the STAC catalogue of geo.admin.ch; only
 * the needed part is read (HTTP range requests, overviews where the file has
 * them). Kept per km tile at 1 m in memory, and handed to the map as Web
 * Mercator tiles in the Terrarium encoding of the elevation tiles.
 * Switzerland and Liechtenstein only.
 */

const sharp = require('sharp');
const { wgs84ToLv95, lv95ToWgs84, inLv95Area } = require('./lv95');

const STAC = 'https://data.geo.admin.ch/api/stac/v1';
const SURFACE = 'ch.swisstopo.swisssurface3d-raster';
const TERRAIN = 'ch.swisstopo.swissalti3d';
const KM = 1000;
const RES = 1; // m per cell of the kept grid
const N = KM / RES;
const MAX_HEIGHT = 80; // m; higher are cranes, masts and noise
const TILE = 256;
const MIN_Z = 15; const MAX_Z = 17;

let geotiffModule = null;
async function geotiff() {
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

/** Web Mercator tile pixel → [lat, lon]. */
function pixelToLatLon(z, x, y, i, j) {
  const n = 2 ** z;
  const lon = ((x + i / TILE) / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + j / TILE)) / n))) * 180) / Math.PI;
  return [lat, lon];
}

/** Terrarium-encoded RGB of a height in metres (as the AWS elevation tiles). */
function terrarium(h, out, o) {
  const v = h + 32768;
  out[o] = Math.floor(v / 256); out[o + 1] = Math.floor(v) % 256; out[o + 2] = Math.floor((v % 1) * 256);
}

function createSurface({ fetchImpl = fetch, timeoutMs = 30000, cacheTiles = 24 } = {}) {
  const kmTiles = new Map(); // "e-n" → Promise<Float32Array | null>
  const pngs = new Map(); // "z/x/y" → Promise<Buffer | null>

  /** Newest file of a collection for the km tile (e, n in km), preferring the given resolutions in order. */
  async function assetHref(collection, e, n, resolutions) {
    const [lat, lon] = lv95ToWgs84((e + 0.5) * KM, (n + 0.5) * KM);
    const bbox = [lon - 0.001, lat - 0.001, lon + 0.001, lat + 0.001].map((v) => v.toFixed(5)).join(',');
    const res = await fetchImpl(`${STAC}/collections/${collection}/items?bbox=${bbox}&limit=50`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`geo.admin.ch antwortete mit HTTP ${res.status}`);
    const items = ((await res.json()).features || []).filter((f) => String(f.id).endsWith(`_${e}-${n}`));
    items.sort((a, b) => String(b.id).localeCompare(String(a.id))); // ids carry the year: newest first
    for (const item of items) {
      const hrefs = Object.values(item.assets || {}).map((a) => a.href).filter((h) => /\.tif$/i.test(h));
      for (const r of resolutions) {
        const href = hrefs.find((h) => h.includes(`_${r}_2056_`));
        if (href) return href;
      }
    }
    return null;
  }

  /** The raster of one file over the km tile, resampled to 1 m (the best fitting overview is read). */
  async function readKm(href, e, n) {
    const { fromCustomClient } = await geotiff();
    const tiff = await fromCustomClient(await makeClient(href, fetchImpl, timeoutMs), { allowFullFile: false });
    const [data] = await tiff.readRasters({ bbox: [e * KM, n * KM, (e + 1) * KM, (n + 1) * KM], width: N, height: N, resampleMethod: 'bilinear' });
    return data;
  }

  /** Height above ground per m² of a km tile (row 0 = north), or null where there is no surface model. */
  function kmTile(e, n) {
    const key = `${e}-${n}`;
    if (!kmTiles.has(key)) {
      if (kmTiles.size >= cacheTiles) kmTiles.delete(kmTiles.keys().next().value);
      const p = (async () => {
        const [surfaceHref, terrainHref] = await Promise.all([assetHref(SURFACE, e, n, ['0.5']), assetHref(TERRAIN, e, n, ['0.5', '2'])]);
        if (!surfaceHref || !terrainHref) return null;
        const [dsm, dtm] = await Promise.all([readKm(surfaceHref, e, n), readKm(terrainHref, e, n)]);
        const out = new Float32Array(N * N);
        for (let i = 0; i < out.length; i++) {
          const d = dsm[i] - dtm[i];
          // No-data (−9999 and the like) and noise below the ground count as bare ground.
          out[i] = dsm[i] > -1000 && dtm[i] > -1000 && d > 0 ? Math.min(MAX_HEIGHT, d) : 0;
        }
        return out;
      })();
      p.catch(() => kmTiles.delete(key)); // try again next time
      kmTiles.set(key, p);
    }
    return kmTiles.get(key);
  }

  /**
   * Web Mercator tile (256 px, Terrarium encoding) of the heights of trees
   * and buildings; null when the tile lies outside Switzerland. Throws when
   * geo.admin.ch cannot be reached.
   */
  function tile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (!pngs.has(key)) {
      if (pngs.size >= 512) pngs.delete(pngs.keys().next().value);
      const p = (async () => {
        const corners = [[0, 0], [TILE, 0], [0, TILE], [TILE, TILE]].map(([i, j]) => pixelToLatLon(z, x, y, i, j));
        if (!corners.some(([lat, lon]) => inLv95Area(lat, lon))) return null;
        // LV95 coordinates of every pixel centre, and the km tiles they fall into.
        const en = new Float64Array(TILE * TILE * 2);
        const need = new Map();
        for (let j = 0; j < TILE; j++) {
          for (let i = 0; i < TILE; i++) {
            const [e, n] = wgs84ToLv95(...pixelToLatLon(z, x, y, i + 0.5, j + 0.5));
            const k = (j * TILE + i) * 2;
            en[k] = e; en[k + 1] = n;
            const id = `${Math.floor(e / KM)},${Math.floor(n / KM)}`;
            if (!need.has(id)) need.set(id, null);
          }
        }
        await Promise.all([...need.keys()].map(async (id) => {
          const [e, n] = id.split(',').map(Number);
          need.set(id, await kmTile(e, n));
        }));
        if ([...need.values()].every((v) => !v)) return null;
        const rgb = Buffer.alloc(TILE * TILE * 3);
        for (let p = 0; p < TILE * TILE; p++) {
          const e = en[p * 2]; const n = en[p * 2 + 1];
          const grid = need.get(`${Math.floor(e / KM)},${Math.floor(n / KM)}`);
          let h = 0;
          if (grid) {
            const c = Math.min(N - 1, Math.floor((e - Math.floor(e / KM) * KM) / RES));
            const r = Math.min(N - 1, Math.floor(((Math.floor(n / KM) + 1) * KM - n) / RES));
            h = grid[r * N + c];
          }
          terrarium(Math.round(h * 4) / 4, rgb, p * 3);
        }
        return sharp(rgb, { raw: { width: TILE, height: TILE, channels: 3 } }).png().toBuffer();
      })();
      p.catch(() => pngs.delete(key));
      pngs.set(key, p);
    }
    return pngs.get(key);
  }

  return { tile, kmTile, MIN_Z, MAX_Z };
}

module.exports = { createSurface, MIN_Z, MAX_Z };
