'use strict';

/**
 * Glacier outlines of one or more inventories, e.g. the Swiss Glacier
 * Inventories of GLAMOS (SGI 1850, 1973, 2010, 2016) as GeoJSON files
 * (GLETSCHER_GEOJSON, comma-separated), in WGS84 or LV95 (EPSG:2056).
 *
 * The inventory year of an outline comes from a property (`year`, `jahr`,
 * `inventory`, `year_acq` …), else from the file name (`sgi_1973.geojson`).
 * With several years the app can tell for a spot where the ice was: "here was
 * ice in 1850 and 1973, not in 2016", and draw the outlines of each year.
 *
 * Read once, again when a file changes. Without files every lookup is empty.
 */

const fs = require('node:fs');
const path = require('node:path');
const { lv95ToWgs84 } = require('./lv95');
const { simplify, insideRing } = require('./wildlife');

const NEAR_M = 500; // a spot this close to a glacier of the latest inventory counts as a glacier spot
const MAX_FEATURES = 400;

const toRad = (d) => (d * Math.PI) / 180;

/** Distance (m) from a point to the edge of a ring ([lon, lat]), in a local plane around the point. */
function distanceToRing(ring, lat, lon) {
  const kx = Math.cos(toRad(lat)) * 6371000 * (Math.PI / 180);
  const ky = 6371000 * (Math.PI / 180);
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ax = (ring[j][0] - lon) * kx;
    const ay = (ring[j][1] - lat) * ky;
    const bx = (ring[i][0] - lon) * kx;
    const by = (ring[i][1] - lat) * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

/** Inside a polygon ([outer, ...holes]): inside the outer ring and in none of its holes. */
const insidePolygon = (poly, lat, lon) => insideRing(poly[0], lat, lon) && !poly.slice(1).some((h) => insideRing(h, lat, lon));

const YEAR_KEYS = /^(year|jahr|year_acq|acq_year|inventory|inventar|inv_year|sgi_year|date|datum)$/i;
const NAME_KEYS = ['name', 'Name', 'NAME', 'glacier_name', 'gletscher', 'Gletscher', 'gl_name', 'sgi-id', 'sgi_id', 'SGI'];

/** The inventory year in properties (1800–2100), or null. */
function yearOf(props) {
  for (const [k, v] of Object.entries(props || {})) {
    if (!YEAR_KEYS.test(k)) continue;
    const m = /(18|19|20)\d{2}/.exec(String(v));
    if (m) return Number(m[0]);
  }
  return null;
}

/** Outlines from GeoJSON text: [{ name, year, polygons: [[outer, ...holes]], bbox }]. */
function parseGlaciers(text, { year: fileYear = null } = {}) {
  const doc = JSON.parse(text);
  const crs = JSON.stringify(doc.crs || '');
  const features = doc.type === 'FeatureCollection' ? doc.features : [doc];
  const out = [];
  for (const f of features) {
    const g = f.geometry || f;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    if (!polys.length || !polys[0][0]?.length) continue;
    const lv95 = /2056/.test(crs) || Math.abs(polys[0][0][0][0]) > 1000;
    const polygons = polys.map((p) => p.map((ring) => ring.map(([x, y]) => (lv95 ? lv95ToWgs84(x, y).reverse() : [x, y]))));
    const props = f.properties || {};
    const nameKey = NAME_KEYS.find((k) => props[k] !== undefined && props[k] !== null && String(props[k]).trim());
    const all = polygons.flatMap((p) => p[0]);
    const lons = all.map((p) => p[0]);
    const lats = all.map((p) => p[1]);
    out.push({
      name: nameKey ? String(props[nameKey]).trim() : 'Gletscher',
      year: yearOf(props) ?? fileYear,
      polygons,
      bbox: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
    });
  }
  return out;
}

/** Year in a file name: "sgi_1973.geojson" → 1973. */
const fileYear = (file) => {
  const m = /(18|19|20)\d{2}/.exec(path.basename(file));
  return m ? Number(m[0]) : null;
};

function createGlaciers({ files = process.env.GLETSCHER_GEOJSON || '' } = {}) {
  const list = (Array.isArray(files) ? files : String(files).split(',')).map((f) => f.trim()).filter(Boolean);
  const cache = new Map(); // file → { mtime, glaciers }

  function all() {
    const out = [];
    for (const file of list) {
      let entry = cache.get(file);
      try {
        const { mtimeMs } = fs.statSync(file);
        if (!entry || entry.mtime !== mtimeMs) {
          entry = { mtime: mtimeMs, glaciers: parseGlaciers(fs.readFileSync(file, 'utf8'), { year: fileYear(file) }) };
          cache.set(file, entry);
        }
      } catch (err) {
        if (entry?.mtime !== -1) console.error(`Gletscherumrisse (${file}) konnten nicht gelesen werden: ${err.message}`);
        entry = { mtime: -1, glaciers: [] };
        cache.set(file, entry);
      }
      out.push(...entry.glaciers);
    }
    return out;
  }

  /** Inventory years, oldest first (outlines without a year are left out). */
  const years = () => [...new Set(all().map((g) => g.year).filter((y) => y !== null))].sort((a, b) => a - b);

  const near = (g, lat, lon, m) => {
    const dLat = m / 111320;
    const dLon = m / (111320 * Math.cos(toRad(lat)));
    return g.bbox[0] - dLon <= lon && lon <= g.bbox[2] + dLon && g.bbox[1] - dLat <= lat && lat <= g.bbox[3] + dLat;
  };
  const distanceTo = (g, lat, lon) => (g.polygons.some((p) => insidePolygon(p, lat, lon)) ? 0
    : Math.min(...g.polygons.map((p) => distanceToRing(p[0], lat, lon))));

  /**
   * What the inventories say about a place:
   *   { name, latestYear, distanceM (to the glacier of the latest inventory, 0 = on the ice),
   *     history: [{ year, ice, name }] per inventory year, oldest first }
   * or null when no glacier lies within `radiusM` in any inventory.
   */
  function at(lat, lon, { radiusM = 5000 } = {}) {
    const candidates = all().filter((g) => near(g, lat, lon, radiusM));
    if (!candidates.length) return null;
    const ys = [...new Set(candidates.map((g) => g.year))].sort((a, b) => (a ?? 0) - (b ?? 0));
    const history = ys.map((year) => {
      const hit = candidates.find((g) => g.year === year && distanceTo(g, lat, lon) === 0);
      return { year, ice: Boolean(hit), name: hit?.name ?? null };
    });
    const latestYear = ys[ys.length - 1];
    let closest = null;
    for (const g of candidates.filter((x) => x.year === latestYear)) {
      const d = distanceTo(g, lat, lon);
      if (!closest || d < closest.d) closest = { g, d };
    }
    // The name: the glacier of the latest inventory nearby, else the one the place lay in before.
    const named = closest && closest.d <= radiusM ? closest.g.name : [...history].reverse().find((h) => h.name)?.name ?? null;
    if (!named && (!closest || closest.d > radiusM)) return null;
    return {
      name: named,
      latestYear,
      distanceM: closest ? Math.round(closest.d) : null,
      history,
    };
  }

  /** Is the place a glacier spot: on or near the ice of the latest inventory, or on the ice of an earlier one. */
  function isGlacierPlace(lat, lon) {
    const info = at(lat, lon, { radiusM: NEAR_M });
    return Boolean(info && ((info.distanceM !== null && info.distanceM <= NEAR_M) || info.history.some((h) => h.ice)));
  }

  /** Outlines touching a box [west, south, east, north] as GeoJSON, simplified (`year`: only that inventory). */
  function geojson(box, { year = null } = {}) {
    const hits = all().filter((g) => (year === null || g.year === year)
      && g.bbox[0] <= box[2] && g.bbox[2] >= box[0] && g.bbox[1] <= box[3] && g.bbox[3] >= box[1]).slice(0, MAX_FEATURES);
    // Tolerance from the box size: ~1/2000 of its width, at least 5 m.
    const tol = Math.max(5, ((box[2] - box[0]) * 111320 * Math.cos(toRad((box[1] + box[3]) / 2))) / 2000);
    return {
      type: 'FeatureCollection',
      features: hits.map((g) => ({
        type: 'Feature',
        properties: { name: g.name, year: g.year },
        geometry: {
          type: 'MultiPolygon',
          coordinates: g.polygons.map((p) => p.map((ring) => simplify(ring, tol).map(([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6]))),
        },
      })),
    };
  }

  return { all, years, at, isGlacierPlace, geojson, enabled: () => list.length > 0 };
}

module.exports = { createGlaciers, parseGlaciers, distanceToRing, insidePolygon, NEAR_M };
