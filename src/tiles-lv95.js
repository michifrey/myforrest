'use strict';

/**
 * Vector tiles in the Swiss LV95 tile grid (EPSG:2056) – the grid of
 * swisstopo's WMTS (wmts.geo.admin.ch, tile matrix set "2056"): origin
 * top left at E 2'420'000 / N 1'350'000, 256-pixel tiles and the same 29
 * resolutions from 4000 m to 0.1 m per pixel. Tiles therefore line up with
 * the national maps of map.geo.admin.ch.
 *
 * The resolutions are not powers of two, so geojson-vt's quadtree does not
 * fit; features are projected to LV95 once and cut per tile here (rectangle
 * clipping with a buffer, Douglas–Peucker in tile units, MVT winding), then
 * encoded with vt-pbf like the WebMercatorQuad tiles.
 */

const vtpbf = require('vt-pbf');
const { toLv95, bboxOf } = require('./geodata');

const TMS_ID = 'SwissLV95';
// Not in the OGC registry, so no URI: tilesets point to our own definition instead (routes/ogc-tiles.js).
const TMS_URI = null;
const ORIGIN = [2420000, 1350000];
const EXTENT_LV95 = [2420000, 1030000, 2900000, 1350000];
const RESOLUTIONS = [4000, 3750, 3500, 3250, 3000, 2750, 2500, 2250, 2000, 1750, 1500, 1250, 1000, 750, 650, 500,
  250, 100, 50, 20, 10, 5, 2.5, 2, 1.5, 1, 0.5, 0.25, 0.1];
const MAX_ZOOM = RESOLUTIONS.length - 1;
const TILE = 256;
const EXTENT = 4096;
const BUFFER = 64; // in tile units, like the WebMercatorQuad tiles

const matrixSize = (z) => ({
  width: Math.ceil((EXTENT_LV95[2] - EXTENT_LV95[0]) / (TILE * RESOLUTIONS[z])),
  height: Math.ceil((EXTENT_LV95[3] - EXTENT_LV95[1]) / (TILE * RESOLUTIONS[z])),
});

/** The tile matrix set (OGC Two Dimensional Tile Matrix Set, JSON encoding). */
function tileMatrixSet() {
  return {
    id: TMS_ID,
    title: 'Schweizer Landeskoordinaten LV95 (Kachelgitter von swisstopo)',
    description: 'Gleiche Auflösungen und gleicher Ursprung wie das LV95-Kachelgitter (2056) von wmts.geo.admin.ch',
    crs: 'http://www.opengis.net/def/crs/EPSG/0/2056',
    orderedAxes: ['E', 'N'],
    boundingBox: { lowerLeft: [EXTENT_LV95[0], EXTENT_LV95[1]], upperRight: [EXTENT_LV95[2], EXTENT_LV95[3]], crs: 'http://www.opengis.net/def/crs/EPSG/0/2056' },
    tileMatrices: RESOLUTIONS.map((res, z) => ({
      id: String(z),
      scaleDenominator: res / 0.00028,
      cellSize: res,
      cornerOfOrigin: 'topLeft',
      pointOfOrigin: ORIGIN,
      tileWidth: TILE,
      tileHeight: TILE,
      matrixWidth: matrixSize(z).width,
      matrixHeight: matrixSize(z).height,
    })),
  };
}

const validTile = (z, y, x) => [z, y, x].every(Number.isInteger) && z >= 0 && z <= MAX_ZOOM
  && x >= 0 && y >= 0 && x < matrixSize(z).width && y < matrixSize(z).height;

/** LV95 bounds [minE, minN, maxE, maxN] → tile range at zoom z. */
function tileRange([w, s, e, n], z) {
  const span = TILE * RESOLUTIONS[z];
  const { width, height } = matrixSize(z);
  const clamp = (v, max) => Math.min(max - 1, Math.max(0, v));
  return {
    minCol: clamp(Math.floor((w - ORIGIN[0]) / span), width),
    maxCol: clamp(Math.floor((e - ORIGIN[0]) / span), width),
    minRow: clamp(Math.floor((ORIGIN[1] - n) / span), height),
    maxRow: clamp(Math.floor((ORIGIN[1] - s) / span), height),
  };
}

/** Sutherland–Hodgman clipping of a closed ring against an axis-aligned rectangle. */
function clipRing(ring, [x0, y0, x1, y1]) {
  let pts = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
  const edges = [
    (p) => p[0] >= x0, (p) => p[0] <= x1, (p) => p[1] >= y0, (p) => p[1] <= y1,
  ];
  const cut = [
    (a, b) => [x0, a[1] + ((x0 - a[0]) * (b[1] - a[1])) / (b[0] - a[0])],
    (a, b) => [x1, a[1] + ((x1 - a[0]) * (b[1] - a[1])) / (b[0] - a[0])],
    (a, b) => [a[0] + ((y0 - a[1]) * (b[0] - a[0])) / (b[1] - a[1]), y0],
    (a, b) => [a[0] + ((y1 - a[1]) * (b[0] - a[0])) / (b[1] - a[1]), y1],
  ];
  for (let e = 0; e < 4 && pts.length; e++) {
    const inside = edges[e];
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      if (inside(a)) {
        out.push(a);
        if (!inside(b)) out.push(cut[e](a, b));
      } else if (inside(b)) out.push(cut[e](a, b));
    }
    pts = out;
  }
  return pts;
}

/** Douglas–Peucker on an open ring (closing point excluded), keeping at least a triangle. */
function simplify(pts, tol) {
  if (pts.length <= 4) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1; keep[pts.length - 1] = 1;
  const sq = tol * tol;
  const segDist2 = (p, a, b) => {
    const dx = b[0] - a[0]; const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    return (p[0] - a[0] - t * dx) ** 2 + (p[1] - a[1] - t * dy) ** 2;
  };
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let max = 0; let idx = -1;
    for (let k = i + 1; k < j; k++) {
      const d = segDist2(pts[k], pts[i], pts[j]);
      if (d > max) { max = d; idx = k; }
    }
    if (idx >= 0 && max > sq) { keep[idx] = 1; stack.push([i, idx], [idx, j]); }
  }
  const out = pts.filter((_, k) => keep[k]);
  return out.length >= 3 ? out : pts;
}

/** Signed area in tile coordinates (y down): positive = clockwise on screen = MVT exterior ring. */
const area = (pts) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]; const q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
};

/** Pre-projects WGS84 GeoJSON features to LV95, with their bounding boxes, for cutting tiles. */
function createIndex(features, { order } = {}) {
  const list = (order ? [...features].sort(order) : features).map((f, i) => {
    const geometry = toLv95(f.geometry);
    const props = {};
    for (const [k, v] of Object.entries(f.properties)) {
      if (v === null || v === undefined) continue;
      props[k] = typeof v === 'number' || typeof v === 'boolean' ? v : String(v);
    }
    const m = /(\d+)$/.exec(String(f.id));
    return { id: m && !String(f.id).startsWith('front.') ? Number(m[1]) : i + 1, geometry, bbox: bboxOf(geometry), props };
  });
  return { getTile: (z, x, y) => cutTile(list, z, x, y) };
}

/** Features of one tile in geojson-vt's tile format (what vt-pbf encodes). */
function cutTile(list, z, x, y) {
  const span = TILE * RESOLUTIONS[z];
  const minE = ORIGIN[0] + x * span;
  const maxN = ORIGIN[1] - y * span;
  const buf = (BUFFER / EXTENT) * span;
  const box = [minE - buf, maxN - span - buf, minE + span + buf, maxN + buf];
  const toTile = ([e, n]) => [Math.round(((e - minE) / span) * EXTENT), Math.round(((maxN - n) / span) * EXTENT)];
  const features = [];
  for (const f of list) {
    const b = f.bbox;
    if (b[2] < box[0] || b[0] > box[2] || b[3] < box[1] || b[1] > box[3]) continue;
    if (f.geometry.type === 'Point') {
      const [e, n] = f.geometry.coordinates;
      if (e < box[0] || e > box[2] || n < box[1] || n > box[3]) continue;
      features.push({ id: f.id, type: 1, geometry: [toTile([e, n])], tags: f.props });
      continue;
    }
    // MultiPolygon: clip every ring, outer rings clockwise, holes counter-clockwise (y down).
    const rings = [];
    for (const poly of f.geometry.coordinates) {
      poly.forEach((ring, k) => {
        const clipped = clipRing(ring, box);
        if (clipped.length < 3) return;
        let pts = simplify(clipped.map(toTile), 2).filter((p, i, a) => i === 0 || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]);
        if (pts.length < 3) return;
        const a = area(pts);
        if (a === 0) return;
        if ((k === 0) !== (a > 0)) pts = pts.reverse();
        rings.push([...pts, pts[0]]);
      });
    }
    if (rings.length) features.push({ id: f.id, type: 3, geometry: rings, tags: f.props });
  }
  return { features };
}

/** One MVT tile from named LV95 indexes; null when empty. */
function encodeTile(indexes, z, x, y) {
  const layers = {};
  for (const [name, index] of Object.entries(indexes)) {
    const tile = index.getTile(z, x, y);
    if (tile.features.length) layers[name] = tile;
  }
  if (!Object.keys(layers).length) return null;
  return Buffer.from(vtpbf.fromGeojsonVt(layers, { version: 2, extent: EXTENT }));
}

module.exports = {
  TMS_ID, TMS_URI, RESOLUTIONS, ORIGIN, EXTENT_LV95, MAX_ZOOM, tileMatrixSet, createIndex, encodeTile, validTile, tileRange, clipRing,
};
