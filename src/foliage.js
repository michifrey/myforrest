'use strict';

/*
 * Conifer vs broadleaf share of the foliage in an image region – a
 * HEURISTIC, not a trained classifier. In ordinary daylight photos of
 * Central European forest, needle foliage (spruce, fir, pine, Douglas fir)
 * tends to be
 *  - darker (dense crowns, little light passes through),
 *  - bluish green (relatively more blue, less red than leaves),
 *  - finely textured: lots of high-frequency contrast at the scale of a few
 *    pixels and comparatively little at coarser scales;
 * while broadleaf foliage (beech, oak, maple, birch) is lighter,
 * yellow-green and coarser (whole leaves and leaf clusters catch the light).
 * Each vegetation pixel gets a needle score in [0, 1] from these cues; a
 * region's needle share is the mean over its vegetation pixels. Lighting,
 * camera white balance, distance and season shift all cues, so the values
 * are indicative only. Discoloured regions are judged on the "before" photo
 * (still green), because browned needles no longer look like needles.
 *
 * The share, together with the tree species recorded at the spot, is used to
 * attribute a discolouration to the most plausible species.
 */

const sharp = require('sharp');
const { doy } = require('./weather');
const { expectedColourDoy } = require('./phenology');

const WORK_SIZE = 320;
const VEG_MIN_EXG = 0.04; // excess green above which a pixel counts as foliage
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

/** Box filter (radius r) with clamped edges. */
function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / n;
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / n;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/**
 * Per-pixel needle score for RGB planes (Float32 in [0, 1]) of a w × h
 * image. Returns { needle, veg } where veg marks foliage pixels.
 */
function needleMap(P, w, h, gray = null) {
  const n = w * h;
  const g = gray || Float32Array.from({ length: n }, (_, i) => 0.299 * P[0][i] + 0.587 * P[1][i] + 0.114 * P[2][i]);
  // Texture at two scales: fine = deviation from a 3×3 mean, coarse = 3×3 mean vs 7×7 mean.
  const b1 = boxBlur(g, w, h, 1);
  const b3 = boxBlur(g, w, h, 3);
  const fineRaw = new Float32Array(n);
  const coarseRaw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    fineRaw[i] = Math.abs(g[i] - b1[i]);
    coarseRaw[i] = Math.abs(b1[i] - b3[i]);
  }
  const fine = boxBlur(fineRaw, w, h, 3);
  const coarse = boxBlur(coarseRaw, w, h, 3);
  const needle = new Float32Array(n);
  const veg = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = P[0][i]; const gg = P[1][i]; const b = P[2][i];
    const s = r + gg + b + 1e-3;
    const exg = (2 * gg - r - b) / s;
    const L = g[i];
    if (exg < VEG_MIN_EXG || L < 0.03 || L > 0.95) continue;
    veg[i] = 1;
    const blue = b / (gg + 1e-3); // needles ~0.6–0.9, leaves ~0.25–0.5
    const yellow = r / (gg + 1e-3); // leaves ~0.6–0.8, needles ~0.35–0.55
    const tex = fine[i] / (coarse[i] + 0.004); // >1: fine grain dominates
    const contrast = fine[i] / (L + 0.05); // relative fine contrast
    const z = 1.0 * ((0.33 - L) / 0.1)
      + 1.1 * ((blue - 0.55) / 0.12)
      + 0.8 * ((0.6 - yellow) / 0.1)
      + 0.7 * ((tex - 1.1) / 0.35)
      + 0.4 * ((contrast - 0.12) / 0.08);
    needle[i] = sigmoid(z / 1.6);
  }
  return { needle, veg };
}

/** Needle share over the given pixel indices (null when hardly any foliage). */
function shareOver(map, pixels) {
  let sum = 0; let m = 0;
  for (const i of pixels) {
    if (!map.veg[i]) continue;
    sum += map.needle[i];
    m++;
  }
  return {
    needleShare: m >= 12 ? Math.round((sum / m) * 100) / 100 : null,
    vegetation: pixels.length ? Math.round((m / pixels.length) * 100) / 100 : 0,
  };
}

/**
 * Whole-photo estimate: overall needle/broadleaf share plus a coarse grid
 * (cols × rows cells, row-major) so the UI can show where conifers dominate.
 */
async function analyzeFoliage(file, { cols = 4, rows = 3 } = {}) {
  const { data, info } = await sharp(file)
    .rotate()
    .resize(WORK_SIZE, WORK_SIZE, { fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width; const h = info.height; const n = w * h;
  const P = [0, 1, 2].map((c) => Float32Array.from({ length: n }, (_, i) => data[i * 3 + c] / 255));
  const map = needleMap(P, w, h);
  const all = shareOver(map, Array.from({ length: n }, (_, i) => i));
  const grid = [];
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const px = [];
      const x0 = Math.floor((cx * w) / cols); const x1 = Math.floor(((cx + 1) * w) / cols);
      const y0 = Math.floor((cy * h) / rows); const y1 = Math.floor(((cy + 1) * h) / rows);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px.push(y * w + x);
      grid.push(shareOver(map, px));
    }
  }
  return {
    method: 'heuristik',
    needleShare: all.needleShare,
    broadleafShare: all.needleShare === null ? null : Math.round((1 - all.needleShare) * 100) / 100,
    vegetation: all.vegetation,
    cols,
    rows,
    grid,
  };
}

/* ---------- Attributing a discolouration to a species ---------- */

/**
 * Most plausible species for a discoloured region with needle share
 * `needleShare` (measured before the colouring), among the `species`
 * recorded at the spot (trees.js entries), on date `takenAt`.
 * Plausibility = group fit (needle share for conifers, its complement for
 * broadleaves) × timing: deciduous species become plausible as their
 * expected colouring date (corrected for the terrain) approaches; colouring
 * evergreen conifers are always possible but abnormal (damage), so they get a
 * flat weight. Without species the result names only the group.
 */
function attributeRegion({ needleShare, species = [], takenAt, terrain = {} }) {
  if (needleShare === null || needleShare === undefined) return null;
  const pN = Math.min(0.95, Math.max(0.05, needleShare));
  if (!species.length) {
    if (pN > 0.4 && pN < 0.6) return null;
    const nadel = pN >= 0.6;
    return {
      sci: null,
      name: nadel ? 'Nadelholz' : 'Laubholz',
      group: nadel ? 'nadel' : 'laub',
      evergreen: null,
      probability: Math.round((nadel ? pN : 1 - pN) * 100) / 100,
      needleShare,
      method: 'heuristik',
    };
  }
  const d = doy(takenAt);
  const scored = species.map((t) => {
    const group = t.group === 'nadel' ? pN : 1 - pN;
    let timing;
    if (t.evergreen || !t.colourDoy) timing = 0.35;
    else {
      const expected = expectedColourDoy(t.colourDoy, terrain);
      timing = 0.2 + 0.8 * sigmoid((d - (expected - 20)) / 7);
      if (t.drought === 'hoch' && d < expected - 20) timing += 0.1; // drought-sensitive species colour early under stress
    }
    return { t, w: group * timing };
  });
  const total = scored.reduce((s, x) => s + x.w, 0) || 1;
  scored.sort((a, b) => b.w - a.w);
  const best = scored[0];
  return {
    sci: best.t.sci,
    name: best.t.de,
    group: best.t.group,
    evergreen: Boolean(best.t.evergreen),
    probability: Math.round((best.w / total) * 100) / 100,
    needleShare,
    alternatives: scored.slice(1, 3).map((x) => ({ name: x.t.de, probability: Math.round((x.w / total) * 100) / 100 })),
    method: 'heuristik',
  };
}

/**
 * Attribution for the discolouration in a stored change result: the
 * area-weighted needle share of its 'verfaerbung' regions (before the change).
 */
function attributeChange(change, { species = [], takenAt, terrain = {} } = {}) {
  const regions = (change?.regions || []).filter((r) => r.class === 'verfaerbung' && Number.isFinite(r.foliage?.needleBefore));
  if (!regions.length) return null;
  let sum = 0; let area = 0;
  for (const r of regions) { sum += r.foliage.needleBefore * r.area; area += r.area; }
  if (area <= 0) return null;
  return attributeRegion({ needleShare: Math.round((sum / area) * 100) / 100, species, takenAt, terrain });
}

module.exports = { needleMap, shareOver, analyzeFoliage, attributeRegion, attributeChange };
