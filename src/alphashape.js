'use strict';

/**
 * Alpha shapes for spread fronts: concave outlines that follow where a
 * species actually grows, split into separate patches and leave out gaps.
 *
 * Method (α-hull by morphological closing on a raster):
 *  1. Every finding is a seed on a grid in local metres.
 *  2. Dilation: all cells within α of a finding (union of α-discs).
 *  3. Erosion by α − buffer: keep only cells at least α − buffer away from
 *     the outside of that union.
 * Dilating by α and eroding by α is the closing of the point set, i.e. the
 * α-hull: everything that no empty disc of radius α can reach. Eroding a
 * little less widens the hull by the buffer, so single findings keep a disc
 * of `buffer` metres. Findings farther apart than 2α stay separate patches;
 * empty areas wider than 2α inside the range stay holes. A larger α tends to
 * the (buffered) convex hull, a smaller α to single discs.
 *
 * Both steps use exact Euclidean distance transforms (Felzenszwalb &
 * Huttenlocher), the outline comes from marching squares and is simplified
 * with Douglas–Peucker. Areas are counted on the raster.
 */

const MAX_CELLS_PER_SIDE = 360;
const INF = 1e20;

/** Squared distance transform of a 1-D function (lower envelope of parabolas). */
function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) ** 2 + f[v[k]];
  }
}

/** Squared Euclidean distance (in cells) from every cell to the nearest cell where `feature` is set. */
function distanceTransform(feature, w, h) {
  const out = new Float64Array(w * h);
  const n = Math.max(w, h);
  const f = new Float64Array(n); const d = new Float64Array(n);
  const v = new Int32Array(n); const z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = feature[y * w + x] ? 0 : INF;
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) out[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = out[y * w + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[y * w + x] = d[x];
  }
  return out;
}

/** Signed area (positive = counter-clockwise in x-right/y-up coordinates). */
function signedArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function pointInRing([px, py], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Douglas–Peucker simplification of a closed ring. */
function simplifyRing(ring, tol) {
  if (ring.length <= 4) return ring;
  const closed = [...ring, ring[0]];
  const last = closed.length - 1;
  const keep = new Uint8Array(closed.length);
  const segDist = (p, a, b) => {
    const dx = b[0] - a[0]; const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  };
  const run = (i, j) => {
    let max = 0; let idx = -1;
    for (let k = i + 1; k < j; k++) {
      const dist = segDist(closed[k], closed[i], closed[j]);
      if (dist > max) { max = dist; idx = k; }
    }
    if (idx >= 0 && max > tol) { keep[idx] = 1; run(i, idx); run(idx, j); }
  };
  // Anchor the closed ring at its first point and the point farthest from it.
  let far = 1;
  for (let k = 2; k < last; k++) {
    if (Math.hypot(closed[k][0] - closed[0][0], closed[k][1] - closed[0][1])
      > Math.hypot(closed[far][0] - closed[0][0], closed[far][1] - closed[0][1])) far = k;
  }
  keep[0] = 1; keep[far] = 1;
  run(0, far);
  run(far, last);
  const out = closed.filter((_, k) => keep[k] && k < last);
  return out.length >= 3 ? out : ring;
}

/**
 * Outline rings of a binary grid by marching squares over cell centres.
 * Returns closed rings in grid coordinates (cell centre of (i, j) at (i, j)).
 */
function traceRings(mask, w, h) {
  const at = (x, y) => (x >= 0 && y >= 0 && x < w && y < h ? mask[y * w + x] : 0);
  // Segment endpoints are edge midpoints, keyed as integers on a doubled grid.
  const key = (x2, y2) => (y2 + 2) * (2 * w + 8) + (x2 + 2);
  const next = new Map(); // from key -> [to key, point]
  const addSeg = (a, b) => next.set(key(a[0], a[1]), { to: key(b[0], b[1]), p: a });
  for (let y = -1; y < h; y++) {
    for (let x = -1; x < w; x++) {
      // Corners: a = (x, y), b = (x+1, y), c = (x+1, y+1), d = (x, y+1).
      const a = at(x, y); const b = at(x + 1, y); const c = at(x + 1, y + 1); const d = at(x, y + 1);
      const code = a | (b << 1) | (c << 2) | (d << 3);
      if (code === 0 || code === 15) continue;
      // Edge midpoints on the doubled grid.
      const S = [2 * x + 1, 2 * y]; const E = [2 * x + 2, 2 * y + 1];
      const N = [2 * x + 1, 2 * y + 2]; const W = [2 * x, 2 * y + 1];
      // Segments keep the inside on their left (y up), so outer rings run counter-clockwise.
      switch (code) {
        case 1: addSeg(S, W); break;
        case 2: addSeg(E, S); break;
        case 3: addSeg(E, W); break;
        case 4: addSeg(N, E); break;
        case 5: addSeg(S, W); addSeg(N, E); break; // saddle: corners kept apart
        case 6: addSeg(N, S); break;
        case 7: addSeg(N, W); break;
        case 8: addSeg(W, N); break;
        case 9: addSeg(S, N); break;
        case 10: addSeg(W, N); addSeg(E, S); break; // saddle
        case 11: addSeg(E, N); break;
        case 12: addSeg(W, E); break;
        case 13: addSeg(S, E); break;
        case 14: addSeg(W, S); break;
        default: break;
      }
    }
  }
  const rings = [];
  while (next.size) {
    const [startKey] = next.keys();
    const ring = [];
    let k = startKey;
    while (next.has(k)) {
      const seg = next.get(k);
      next.delete(k);
      ring.push([seg.p[0] / 2, seg.p[1] / 2]);
      k = seg.to;
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

/**
 * Default α from the spacing of the findings: 2.5 times the 90th percentile
 * of the distances to the nearest neighbouring finding, so nearly every
 * finding joins its neighbours and only real outliers stay apart; at least
 * twice the buffer, 30 m–1.5 km.
 */
function autoAlpha(xy, buffer) {
  if (xy.length < 2) return Math.max(2 * buffer, 30);
  const step = Math.ceil(xy.length / 1500);
  const nn = xy.filter((_, i) => i % step === 0).map((p) => {
    let best = Infinity;
    for (const q of xy) {
      const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
      if (d > 0 && d < best) best = d;
    }
    return best;
  }).filter(Number.isFinite).sort((a, b) => a - b);
  const p90 = nn.length ? nn[Math.min(nn.length - 1, Math.floor(nn.length * 0.9))] : 0;
  return Math.round(Math.min(1500, Math.max(30, 2 * buffer, 2.5 * p90)));
}

/**
 * A raster frame shared by several point sets (e.g. the cumulative findings
 * of every year), so that their shapes are directly comparable and nested.
 */
function createFrame(allXY, { alpha, buffer }) {
  const reach = Math.max(alpha, buffer);
  const minX = Math.min(...allXY.map((p) => p[0])) - reach;
  const maxX = Math.max(...allXY.map((p) => p[0])) + reach;
  const minY = Math.min(...allXY.map((p) => p[1])) - reach;
  const maxY = Math.max(...allXY.map((p) => p[1])) + reach;
  // Cells small enough to draw the buffer, but at most MAX_CELLS_PER_SIDE per side.
  const cell = Math.max(1, (Math.max(maxX - minX, maxY - minY)) / MAX_CELLS_PER_SIDE, Math.min(buffer, alpha) / 6);
  const pad = 2;
  const x0 = minX - pad * cell;
  const y0 = minY - pad * cell;
  const w = Math.ceil((maxX - minX) / cell) + 2 * pad + 1;
  const h = Math.ceil((maxY - minY) / cell) + 2 * pad + 1;
  return { x0, y0, w, h, cell, alpha, buffer };
}

/**
 * Alpha shape of points (local metres) in a frame. Returns polygons (each
 * [outer, ...holes], rings as [x, y] in metres, outer counter-clockwise),
 * the area in m² and the number of separate patches.
 */
function alphaShape(xy, frame) {
  const { x0, y0, w, h, cell, alpha, buffer } = frame;
  const seeds = new Uint8Array(w * h);
  for (const [x, y] of xy) {
    const i = Math.round((x - x0) / cell);
    const j = Math.round((y - y0) / cell);
    if (i >= 0 && j >= 0 && i < w && j < h) seeds[j * w + i] = 1;
  }
  const d1 = distanceTransform(seeds, w, h);
  const mask = new Uint8Array(w * h);
  if (buffer >= alpha) {
    const r2 = (buffer / cell) ** 2;
    for (let k = 0; k < mask.length; k++) mask[k] = d1[k] <= r2 ? 1 : 0;
  } else {
    const a2 = (alpha / cell) ** 2;
    const outside = new Uint8Array(w * h);
    for (let k = 0; k < outside.length; k++) outside[k] = d1[k] <= a2 ? 0 : 1;
    const d2 = distanceTransform(outside, w, h);
    const e2 = ((alpha - buffer) / cell) ** 2;
    for (let k = 0; k < mask.length; k++) mask[k] = d2[k] > e2 ? 1 : 0;
  }
  let cells = 0;
  for (let k = 0; k < mask.length; k++) cells += mask[k];

  // Grid rows run with y up in metres, so ring orientation flips; sort out
  // outer rings and holes by nesting depth rather than by direction.
  const rings = traceRings(mask, w, h)
    .map((r) => simplifyRing(r.map(([i, j]) => [x0 + i * cell, y0 + j * cell]), cell * 0.6))
    .filter((r) => r.length >= 3 && Math.abs(signedArea(r)) > cell * cell);
  const depth = rings.map((r, i) => rings.reduce((n, other, k) => (k !== i && pointInRing(r[0], other) ? n + 1 : n), 0));
  const polygons = [];
  rings.forEach((r, i) => {
    if (depth[i] % 2) return;
    const outer = signedArea(r) < 0 ? [...r].reverse() : r;
    polygons.push({ outer, holes: [], depth: depth[i] });
  });
  rings.forEach((r, i) => {
    if (!(depth[i] % 2)) return;
    // The hole belongs to the innermost outer ring that contains it.
    const owner = polygons
      .filter((p) => p.depth === depth[i] - 1 && pointInRing(r[0], p.outer))
      .sort((a, b) => Math.abs(signedArea(a.outer)) - Math.abs(signedArea(b.outer)))[0];
    if (owner) owner.holes.push(signedArea(r) > 0 ? [...r].reverse() : r);
  });
  return {
    polygons: polygons.map((p) => [p.outer, ...p.holes]),
    areaM2: Math.round(cells * cell * cell),
    patches: polygons.length,
  };
}

module.exports = { alphaShape, createFrame, autoAlpha, distanceTransform, traceRings, simplifyRing, signedArea };
