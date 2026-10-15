'use strict';

/*
 * Buildings from OpenStreetMap for the shadows on the map where swisstopo's
 * surface model does not reach (outside Switzerland): outlines and heights
 * through an Overpass API (GEBAEUDE_URL, by default the one of the path
 * network, WEGNETZ_URL), per Web Mercator tile of zoom 14 (about 1.6 km at
 * 47° N), kept 30 days in the database. Off without a URL.
 *
 * Height: the `height` tag (m, also "12 m" or feet like 40'), else the
 * storeys (`building:levels` × 3 m, plus a roof of 2 m, or `roof:levels`),
 * else a typical height for the kind of building.
 */

const CELL_Z = 14;
const CELL_DAYS = 30;
const DAY = 86400000;
const LEVEL_M = 3;
const ROOF_M = 2;
const MAX_M = 300;

/** Typical heights (m) by `building=*` when nothing else is known. */
const TYPICAL = {
  garage: 3, garages: 3, shed: 3, carport: 3, hut: 3, kiosk: 3, cabin: 4, roof: 4, toilets: 3, bunker: 3, container: 3, greenhouse: 4,
  farm_auxiliary: 7, barn: 8, stable: 7, cowshed: 7, house: 8, detached: 8, semidetached_house: 8, terrace: 9, bungalow: 5,
  residential: 10, apartments: 14, dormitory: 14, hotel: 15, office: 15, commercial: 10, retail: 8, supermarket: 7,
  industrial: 10, warehouse: 10, manufacture: 10, school: 12, university: 15, hospital: 18, public: 12, civic: 12,
  church: 20, chapel: 8, cathedral: 35, mosque: 15, temple: 12, train_station: 10, transportation: 8, sports_hall: 12,
  grandstand: 10, parking: 10, service: 4, transformer_tower: 6, water_tower: 25, tower: 25,
};
const DEFAULT_M = 8;

/** Number from an OSM length ("12", "12.5 m", "40'", "40 ft"), or null. */
function parseLength(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(',', '.');
  const ft = /^(\d+(?:\.\d+)?)\s*(?:'|ft|feet)$/i.exec(s);
  if (ft) return Number(ft[1]) * 0.3048;
  const m = /^(\d+(?:\.\d+)?)\s*(?:m|meter|metres?)?$/i.exec(s);
  return m ? Number(m[1]) : null;
}

/** Height of a building above ground (m) from its tags. */
function buildingHeight(tags = {}) {
  const h = parseLength(tags.height) ?? parseLength(tags['building:height']);
  if (h && h > 0) return Math.min(MAX_M, h);
  const levels = parseLength(tags['building:levels']);
  if (levels && levels > 0) {
    const roofLevels = parseLength(tags['roof:levels']);
    return Math.min(MAX_M, levels * LEVEL_M + (roofLevels != null ? roofLevels * LEVEL_M : ROOF_M));
  }
  return TYPICAL[tags.building] ?? DEFAULT_M;
}

/** Buildings `[{ h, rings: [[[lat, lon], …]] }]` from an Overpass answer (`out geom`), ways and multipolygons. */
function parseBuildings(body) {
  const out = [];
  const ring = (geometry) => (geometry || []).filter((g) => g && Number.isFinite(g.lat)).map((g) => [Math.round(g.lat * 1e6) / 1e6, Math.round(g.lon * 1e6) / 1e6]);
  for (const e of body.elements || []) {
    if (!e.tags?.building || e.tags.building === 'no') continue;
    if (e.tags.location === 'underground' || Number(e.tags.layer) < 0) continue;
    let rings = [];
    if (e.type === 'way') rings = [ring(e.geometry)];
    else if (e.type === 'relation') rings = (e.members || []).filter((m) => m.type === 'way' && m.role !== 'inner').map((m) => ring(m.geometry));
    rings = rings.filter((r) => r.length >= 3);
    if (rings.length) out.push({ h: Math.round(buildingHeight(e.tags) * 10) / 10, rings });
  }
  return out;
}

/** [south, west, north, east] of a Web Mercator tile. */
function tileBounds(z, x, y) {
  const n = 2 ** z;
  const lat = (t) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * t) / n))) * 180) / Math.PI;
  return [lat(y + 1), (x / n) * 360 - 180, lat(y), ((x + 1) / n) * 360 - 180];
}

function createBuildings({ db, url = '', fetchImpl = fetch, now = () => Date.now(), timeoutMs = 30000 } = {}) {
  const enabled = Boolean(url);
  db.exec('CREATE TABLE IF NOT EXISTS building_cells (cell TEXT PRIMARY KEY, fetched_at INTEGER NOT NULL, json TEXT NOT NULL)');
  const getCell = db.prepare('SELECT fetched_at, json FROM building_cells WHERE cell = ?');
  const putCell = db.prepare('INSERT OR REPLACE INTO building_cells (cell, fetched_at, json) VALUES (?, ?, ?)');
  const pending = new Map();

  async function fetchCell(x, y) {
    const [s, w, n, e] = tileBounds(CELL_Z, x, y).map((v) => v.toFixed(5));
    const box = `(${s},${w},${n},${e})`;
    const query = `[out:json][timeout:25];(way["building"]${box};relation["building"]["type"="multipolygon"]${box};);out geom;`;
    const res = await fetchImpl(url, {
      method: 'POST',
      body: new URLSearchParams({ data: query }),
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Gebäude (Overpass) antworten mit HTTP ${res.status}`);
    return parseBuildings(await res.json());
  }

  /** Buildings of the zoom-14 cell containing tile z/x/y (z ≥ 14); [] when off. */
  async function forTile(z, x, y) {
    if (!enabled) return [];
    const cx = x >> (z - CELL_Z); const cy = y >> (z - CELL_Z);
    const key = `${cx}:${cy}`;
    const row = getCell.get(key);
    if (row && now() - row.fetched_at < CELL_DAYS * DAY) return JSON.parse(row.json);
    if (!pending.has(key)) {
      pending.set(key, fetchCell(cx, cy)
        .then((list) => { putCell.run(key, now(), JSON.stringify(list)); return list; })
        .catch((err) => { if (row) return JSON.parse(row.json); throw err; })
        .finally(() => pending.delete(key)));
    }
    return pending.get(key);
  }

  return { enabled, forTile };
}

/**
 * Burns buildings into a 256×256 height grid of tile z/x/y (row-major, north
 * up): every pixel whose centre lies inside an outline takes the building's
 * height (the roof hides trees beneath). Only where `free(p)` allows.
 */
function rasterize(grid, buildings, z, x, y, free = () => true) {
  const n = 2 ** z;
  const px = (lon) => (((lon + 180) / 360) * n - x) * 256;
  const py = (lat) => {
    const s = Math.sin((lat * Math.PI) / 180);
    return ((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n - y) * 256;
  };
  let count = 0;
  for (const b of buildings) {
    for (const r of b.rings) {
      const pts = r.map(([lat, lon]) => [px(lon), py(lat)]);
      let y0 = Infinity; let y1 = -Infinity;
      for (const [, v] of pts) { if (v < y0) y0 = v; if (v > y1) y1 = v; }
      if (y1 < 0 || y0 > 256) continue;
      let touched = false;
      for (let row = Math.max(0, Math.floor(y0)); row < Math.min(256, Math.ceil(y1)); row++) {
        const cy = row + 0.5;
        const xs = [];
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const [ax, ay] = pts[i]; const [bx, by] = pts[j];
          if ((ay > cy) !== (by > cy)) xs.push(ax + ((cy - ay) / (by - ay)) * (bx - ax));
        }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          for (let col = Math.max(0, Math.ceil(xs[k] - 0.5)); col < Math.min(256, Math.ceil(xs[k + 1] - 0.5)); col++) {
            const p = row * 256 + col;
            if (!free(p)) continue;
            grid[p] = b.h;
            touched = true;
          }
        }
      }
      if (touched) count++;
    }
  }
  return count;
}

module.exports = { createBuildings, parseBuildings, buildingHeight, parseLength, rasterize, tileBounds, CELL_Z };
