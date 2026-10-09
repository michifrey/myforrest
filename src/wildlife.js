'use strict';

/**
 * Wildlife rest areas (Wildruhezonen) for routing: the wege magnet routes
 * around them during their protection period. The areas come from a GeoJSON
 * file the operator provides (WILDRUHE_GEOJSON), e.g. the federal dataset
 * "Wild- und Vogelschutzgebiete / Wildruhezonen" of BAFU from geo.admin.ch,
 * in WGS84 or LV95 (EPSG:2056). OpenStreetMap does not hold them reliably.
 *
 * Protection period: a text like "20.12.–30.04." in any property of an area
 * (the federal data names it in the regulations), else WILDRUHE_SEASON
 * (default "12-20/04-30", over the turn of the year); "immer" = all year.
 *
 * For BRouter the areas become no-go polygons (`polygons=lon,lat,…|…`),
 * simplified to a few metres and limited in number to keep the URL short.
 */

const fs = require('node:fs');
const { lv95ToWgs84 } = require('./lv95');

const MAX_ZONES = 40;
const MAX_VERTICES = 200;
const NEAR_M = 3000; // zones this close to the route's box are sent along

const toRad = (d) => (d * Math.PI) / 180;
const metres = (a, b) => Math.hypot(toRad(b.lon - a.lon) * Math.cos(toRad((a.lat + b.lat) / 2)), toRad(b.lat - a.lat)) * 6371000;

/** "12-20/04-30" or a text with "20.12.–30.04." → { from: [m, d], to: [m, d] }, or null (all year). */
function parseSeason(text) {
  const s = String(text || '').trim();
  if (!s || /^(immer|ganzj)/i.test(s)) return null;
  let m = /^(\d{1,2})-(\d{1,2})\s*\/\s*(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return { from: [Number(m[1]), Number(m[2])], to: [Number(m[3]), Number(m[4])] };
  m = /(\d{1,2})\.\s*(\d{1,2})\.?\s*(?:[-–—]|bis)\s*(\d{1,2})\.\s*(\d{1,2})\./.exec(s);
  if (m) return { from: [Number(m[2]), Number(m[1])], to: [Number(m[4]), Number(m[3])] };
  return undefined; // no period in this text
}

/** Is `date` within the season (inclusive, possibly over the turn of the year)? */
function inSeason(season, date) {
  if (!season) return true;
  const md = (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
  const from = season.from[0] * 100 + season.from[1];
  const to = season.to[0] * 100 + season.to[1];
  return from <= to ? md >= from && md <= to : md >= from || md <= to;
}

/** Douglas–Peucker on [lon, lat] points with a tolerance in metres. */
function simplify(ring, tolM) {
  if (ring.length <= 4) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = 1;
  keep[ring.length - 1] = 1;
  const pt = ([lon, lat]) => ({ lat, lon });
  const stack = [[0, ring.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const A = pt(ring[a]);
    const B = pt(ring[b]);
    const ab = metres(A, B);
    let best = -1;
    let bestD = 0;
    for (let i = a + 1; i < b; i++) {
      const P = pt(ring[i]);
      // Distance to the line A–B in a local plane (metres): |AB × AP| / |AB|.
      const k = Math.cos(toRad(A.lat)) * 6371000;
      const [bx, by] = [toRad(B.lon - A.lon) * k, toRad(B.lat - A.lat) * 6371000];
      const [px, py] = [toRad(P.lon - A.lon) * k, toRad(P.lat - A.lat) * 6371000];
      const d = ab < 1e-6 ? metres(A, P) : Math.abs(bx * py - by * px) / ab;
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best > 0 && bestD > tolM) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return ring.filter((_, i) => keep[i]);
}

/** Ray casting: is the point inside the ring ([lon, lat])? */
function insideRing(ring, lat, lon) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Zones from GeoJSON text: [{ name, season, rings: [[lon, lat]…] (outer rings), bbox }]. */
function parseZones(text, { defaultSeason = '12-20/04-30' } = {}) {
  const doc = JSON.parse(text);
  const crs = JSON.stringify(doc.crs || '');
  const features = doc.type === 'FeatureCollection' ? doc.features : [doc];
  const fallback = parseSeason(defaultSeason);
  const zones = [];
  for (const f of features) {
    const g = f.geometry || f;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    if (!polys.length) continue;
    // LV95 when declared or when the numbers are metres.
    const lv95 = /2056/.test(crs) || Math.abs(polys[0][0][0][0]) > 1000;
    const rings = polys.map((p) => p[0].map(([x, y]) => (lv95 ? lv95ToWgs84(x, y).reverse() : [x, y])));
    const props = f.properties || {};
    const name = String(props.name || props.Name || props.wrz_name || props.WRZ_Name || props.bezeichnung || props.Bezeichnung || 'Wildruhezone');
    // The first property naming a period ("20.12.–30.04.") or "ganzjährig"; else the default.
    let season = fallback;
    for (const v of Object.values(props)) {
      if (typeof v !== 'string') continue;
      if (/ganzjährig|ganzjaehrig/i.test(v)) { season = null; break; }
      const found = /\d/.test(v) ? parseSeason(v) : undefined;
      if (found) { season = found; break; }
    }
    const all = rings.flat();
    const lons = all.map((p) => p[0]);
    const lats = all.map((p) => p[1]);
    zones.push({ name, season, rings, bbox: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)] });
  }
  return zones;
}

/**
 * Wildlife rest areas from a file (read once, again when it changes).
 * near(points, date) → { zones (in season, near the route), inside (names of zones containing a waypoint) }.
 */
function createWildlife({ file = process.env.WILDRUHE_GEOJSON || '', season = process.env.WILDRUHE_SEASON || '12-20/04-30' } = {}) {
  let cache = { mtime: -1, zones: [] };
  function zones() {
    if (!file) return [];
    try {
      const { mtimeMs } = fs.statSync(file);
      if (mtimeMs !== cache.mtime) cache = { mtime: mtimeMs, zones: parseZones(fs.readFileSync(file, 'utf8'), { defaultSeason: season }) };
    } catch (err) {
      if (cache.mtime !== -2) console.error(`Wildruhezonen (${file}) konnten nicht gelesen werden: ${err.message}`);
      cache = { mtime: -2, zones: [] };
    }
    return cache.zones;
  }

  /** Zones in their protection period that touch a box [west, south, east, north]. */
  const within = (box, date = new Date()) => zones()
    .filter((z) => inSeason(z.season, date) && z.bbox[0] <= box[2] && z.bbox[2] >= box[0] && z.bbox[1] <= box[3] && z.bbox[3] >= box[1]);

  function near(points, date = new Date()) {
    const lats = points.map((p) => p.lat);
    const lons = points.map((p) => p.lon);
    const dLat = NEAR_M / 111320;
    const dLon = NEAR_M / (111320 * Math.cos(toRad(lats[0])));
    const hits = within([Math.min(...lons) - dLon, Math.min(...lats) - dLat, Math.max(...lons) + dLon, Math.max(...lats) + dLat], date);
    // A waypoint inside a zone: routing around it is impossible, so it is not sent (and named).
    const inside = hits.filter((z) => points.some((p) => z.rings.some((r) => insideRing(r, p.lat, p.lon))));
    return { zones: hits.filter((z) => !inside.includes(z)).slice(0, MAX_ZONES), inside: inside.map((z) => z.name) };
  }

  /** BRouter's `polygons` parameter for zones. */
  function polygonsParam(list) {
    return list.flatMap((z) => z.rings).map((ring) => {
      let r = simplify(ring, 10);
      for (let tol = 25; r.length > MAX_VERTICES; tol *= 2) r = simplify(ring, tol);
      return r.map(([lon, lat]) => `${lon.toFixed(6)},${lat.toFixed(6)}`).join(',');
    }).join('|');
  }

  return { zones, within, near, polygonsParam, enabled: () => Boolean(file) };
}

module.exports = { createWildlife, parseZones, parseSeason, inSeason, simplify, insideRing };
