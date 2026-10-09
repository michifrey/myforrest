'use strict';

/**
 * Mapillary street-level imagery (API v4, graph.mapillary.com) as an extra
 * view where there are no own pictures. Needs a client token (MAPILLARY_TOKEN,
 * from the developer dashboard of mapillary.com); without one everything is off.
 *
 * Only the server talks to Mapillary: the token stays here, and the pictures
 * are served from this server (`/api/mapillary/images/:id/file`), so 360°
 * pictures load into WebGL without CORS trouble and keep working offline once
 * seen (service worker). Searches are cached per ~450 m cell for a week,
 * picture files on disk for `FILE_DAYS`.
 *
 * Mapillary pictures are CC BY-SA 4.0: every picture carries its creator and
 * a link to it on mapillary.com, and the app shows both.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const GRAPH = 'https://graph.mapillary.com';
const FIELDS = 'id,computed_geometry,geometry,computed_compass_angle,compass_angle,captured_at,is_pano,creator,sequence';
const CELL = 0.004; // ° (~450 m north–south): searches are cached per cell
const SEARCH_DAYS = 7;
const FILE_DAYS = 30;
const MAX_BYTES = 12 * 1024 * 1024;
const MAX_BBOX = 0.01; // ° per side: the API refuses larger boxes

const DAY = 86400000;
const ID = /^\d{1,20}$/;

/** A picture of the API as the app uses it, or null without a position. */
function normalise(item) {
  const g = item.computed_geometry || item.geometry;
  if (!g?.coordinates) return null;
  const [lon, lat] = g.coordinates;
  const heading = item.computed_compass_angle ?? item.compass_angle;
  return {
    id: String(item.id),
    lat,
    lon,
    heading: Number.isFinite(heading) ? ((heading % 360) + 360) % 360 : null,
    takenAt: item.captured_at ? new Date(item.captured_at).toISOString() : null,
    panorama: Boolean(item.is_pano),
    creator: item.creator?.username || null,
    sequence: typeof item.sequence === 'string' ? item.sequence : item.sequence?.id || null,
  };
}

function createMapillary({ db, dataDir, token = process.env.MAPILLARY_TOKEN || '', fetchImpl = fetch, now = () => Date.now(), timeoutMs = 15000 }) {
  const enabled = Boolean(token);
  const fileDir = path.join(dataDir, 'mapillary');
  db.exec(`CREATE TABLE IF NOT EXISTS mapillary_cells (
    cell TEXT PRIMARY KEY, fetched_at INTEGER NOT NULL, json TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS mapillary_images (
    id TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at INTEGER NOT NULL
  )`);
  const getCell = db.prepare('SELECT fetched_at, json FROM mapillary_cells WHERE cell = ?');
  const putCell = db.prepare('INSERT OR REPLACE INTO mapillary_cells (cell, fetched_at, json) VALUES (?, ?, ?)');
  const getImage = db.prepare('SELECT json FROM mapillary_images WHERE id = ?');
  const putImage = db.prepare('INSERT OR REPLACE INTO mapillary_images (id, json, fetched_at) VALUES (?, ?, ?)');

  async function graph(pathAndQuery) {
    const url = `${GRAPH}${pathAndQuery}${pathAndQuery.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    if (!res.ok) throw Object.assign(new Error(`Mapillary antwortet mit HTTP ${res.status}`), { httpStatus: res.status });
    return res.json();
  }

  /** The pictures in one cell (cached): [normalised picture]. */
  async function cell(cx, cy) {
    const key = `${cx}:${cy}`;
    const row = getCell.get(key);
    if (row && now() - row.fetched_at < SEARCH_DAYS * DAY) return JSON.parse(row.json);
    const bbox = [cx * CELL, cy * CELL, (cx + 1) * CELL, (cy + 1) * CELL].map((v) => v.toFixed(4)).join(',');
    let list;
    try {
      const body = await graph(`/images?fields=${FIELDS}&bbox=${bbox}&limit=1000`);
      list = (body.data || []).map(normalise).filter(Boolean);
    } catch (err) {
      if (row) return JSON.parse(row.json); // offline: the older answer is better than none
      throw err;
    }
    putCell.run(key, now(), JSON.stringify(list));
    for (const p of list) putImage.run(p.id, JSON.stringify(p), now());
    return list;
  }

  /** Pictures in a box [west, south, east, north] (at most MAX_BBOX per side). */
  async function inBox([w, s, e, n]) {
    if (!enabled) return [];
    if (e - w > MAX_BBOX || n - s > MAX_BBOX) throw Object.assign(new Error('Ausschnitt zu gross für Mapillary'), { status: 400 });
    const out = new Map();
    for (let cx = Math.floor(w / CELL); cx <= Math.floor(e / CELL); cx++) {
      for (let cy = Math.floor(s / CELL); cy <= Math.floor(n / CELL); cy++) {
        for (const p of await cell(cx, cy)) if (p.lon >= w && p.lon <= e && p.lat >= s && p.lat <= n) out.set(p.id, p);
      }
    }
    return [...out.values()];
  }

  /** Pictures within `radiusM` of a place. */
  function near(lat, lon, radiusM = 80) {
    const dLat = radiusM / 111320;
    const dLon = dLat / Math.cos((lat * Math.PI) / 180);
    return inBox([lon - dLon, lat - dLat, lon + dLon, lat + dLat]);
  }

  /** One picture (from the cache of searches, else asked for). */
  async function image(id) {
    if (!enabled || !ID.test(String(id))) return null;
    const row = getImage.get(String(id));
    if (row) return JSON.parse(row.json);
    let item;
    try {
      item = await graph(`/${id}?fields=${FIELDS}`);
    } catch (err) {
      if (err.httpStatus === 404) return null; // no such picture
      throw err;
    }
    const p = normalise(item);
    if (p) putImage.run(p.id, JSON.stringify(p), now());
    return p;
  }

  /**
   * The picture file (2048 px; panoramas as 2:1), from disk or downloaded.
   * The download link of Mapillary expires, so it is asked for each time.
   */
  async function file(id) {
    if (!enabled || !ID.test(String(id))) return null;
    const target = path.join(fileDir, `${id}.jpg`);
    const st = await fsp.stat(target).catch(() => null);
    if (st && now() - st.mtimeMs < FILE_DAYS * DAY) return target;
    const meta = await graph(`/${id}?fields=thumb_2048_url`);
    if (!meta.thumb_2048_url || !/^https:\/\//.test(meta.thumb_2048_url)) throw new Error('Mapillary liefert kein Bild');
    const res = await fetchImpl(meta.thumb_2048_url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`Bild von Mapillary: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('Bild von Mapillary ist kein JPEG');
    fs.mkdirSync(fileDir, { recursive: true });
    await fsp.writeFile(target, buf);
    return target;
  }

  /** Link to the picture on mapillary.com (attribution). */
  const pageUrl = (id) => `https://www.mapillary.com/app/?pKey=${id}`;

  return { enabled: () => enabled, near, inBox, image, file, pageUrl };
}

module.exports = { createMapillary, normalise };
