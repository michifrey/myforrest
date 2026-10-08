'use strict';

/*
 * Automatic fine alignment of repeat photos (image registration).
 *
 * Finds a homography that maps photo B onto photo A: ORB-style features
 * (Harris corners on a small image pyramid, intensity-centroid orientation,
 * rotated BRIEF descriptors), mutual nearest-neighbour matching with a ratio
 * test, and RANSAC. Changes in the scene (fallen trees, new growth, light)
 * only remove matches; as long as enough of the scene is unchanged the
 * remaining matches still pin down the transform.
 */

const sharp = require('sharp');
const { apply } = require('./homography');
const sphere = require('./sphere');

const WORK_SIZE = 800;
const LEVELS = 3;
const LEVEL_SCALE = 1.25;
const MAX_FEATURES = 1200;
const PATCH_MARGIN = 20;
const MIN_INLIERS = 20;

/* ---------- Deterministic random numbers ---------- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- BRIEF sampling pattern, pre-rotated in 12° steps ---------- */

const PAIRS = 256;
const ANGLE_BINS = 30;
const PATTERNS = (() => {
  const rnd = mulberry32(0x5eed);
  const gauss = () => {
    const v = Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd()) * (31 / 5);
    return Math.max(-13, Math.min(13, Math.round(v)));
  };
  const base = Array.from({ length: PAIRS * 4 }, gauss);
  return Array.from({ length: ANGLE_BINS }, (_, bin) => {
    const angle = (bin / ANGLE_BINS) * 2 * Math.PI;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const p = new Int16Array(PAIRS * 4);
    for (let i = 0; i < PAIRS * 4; i += 2) {
      p[i] = Math.round(c * base[i] - s * base[i + 1]);
      p[i + 1] = Math.round(s * base[i] + c * base[i + 1]);
    }
    return p;
  });
})();

/* ---------- Image helpers ---------- */

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / n;
      acc += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
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

/** Decodes an image (respecting EXIF orientation) into a greyscale pyramid. */
async function loadPyramid(file) {
  const base = await sharp(file)
    .rotate()
    .greyscale()
    .resize(WORK_SIZE, WORK_SIZE, { fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = base.info;
  const levels = [];
  for (let l = 0; l < LEVELS; l++) {
    const f = LEVEL_SCALE ** l;
    const w = Math.round(width / f);
    const h = Math.round(height / f);
    const data = l === 0
      ? base.data
      : await sharp(base.data, { raw: { width, height, channels: 1 } }).resize(w, h, { fit: 'fill' }).raw().toBuffer();
    levels.push({ data: Float32Array.from(data), width: w, height: h, scale: width / w });
  }
  return { width, height, levels };
}

/* ---------- Features ---------- */

function harris(img, w, h) {
  const ixx = new Float32Array(w * h);
  const iyy = new Float32Array(w * h);
  const ixy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = img[i - w + 1] + 2 * img[i + 1] + img[i + w + 1] - img[i - w - 1] - 2 * img[i - 1] - img[i + w - 1];
      const gy = img[i + w - 1] + 2 * img[i + w] + img[i + w + 1] - img[i - w - 1] - 2 * img[i - w] - img[i - w + 1];
      ixx[i] = gx * gx;
      iyy[i] = gy * gy;
      ixy[i] = gx * gy;
    }
  }
  const sxx = boxBlur(ixx, w, h, 2);
  const syy = boxBlur(iyy, w, h, 2);
  const sxy = boxBlur(ixy, w, h, 2);
  const r = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const tr = sxx[i] + syy[i];
    r[i] = sxx[i] * syy[i] - sxy[i] * sxy[i] - 0.04 * tr * tr;
  }
  return r;
}

function detect(level, budget) {
  const { data, width: w, height: h } = level;
  const smooth = boxBlur(data, w, h, 2);
  const resp = harris(boxBlur(data, w, h, 1), w, h);
  let max = 0;
  for (let i = 0; i < resp.length; i++) if (resp[i] > max) max = resp[i];
  const threshold = max * 1e-4;

  const cands = [];
  const m = PATCH_MARGIN;
  for (let y = m; y < h - m; y++) {
    for (let x = m; x < w - m; x++) {
      const v = resp[y * w + x];
      if (v <= threshold) continue;
      let isMax = true;
      for (let dy = -3; dy <= 3 && isMax; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          if ((dx || dy) && resp[(y + dy) * w + x + dx] >= v) { isMax = false; break; }
        }
      }
      if (isMax) cands.push({ x, y, r: v });
    }
  }
  cands.sort((a, b) => b.r - a.r);

  // Spread features over the image so one busy area cannot dominate.
  const gx = 8;
  const gy = 6;
  const cap = Math.ceil((budget / (gx * gy)) * 2);
  const cells = new Uint16Array(gx * gy);
  const picked = [];
  for (const c of cands) {
    if (picked.length >= budget) break;
    const cell = Math.min(gy - 1, Math.floor((c.y / h) * gy)) * gx + Math.min(gx - 1, Math.floor((c.x / w) * gx));
    if (cells[cell] >= cap) continue;
    cells[cell]++;
    picked.push(c);
  }

  return picked.map(({ x, y }) => {
    let m10 = 0;
    let m01 = 0;
    for (let dy = -15; dy <= 15; dy++) {
      const span = Math.floor(Math.sqrt(225 - dy * dy));
      for (let dx = -span; dx <= span; dx++) {
        const v = smooth[(y + dy) * w + x + dx];
        m10 += dx * v;
        m01 += dy * v;
      }
    }
    const angle = Math.atan2(m01, m10);
    const bin = ((Math.round((angle / (2 * Math.PI)) * ANGLE_BINS) % ANGLE_BINS) + ANGLE_BINS) % ANGLE_BINS;
    const p = PATTERNS[bin];
    const desc = new Uint32Array(PAIRS / 32);
    for (let k = 0; k < PAIRS; k++) {
      const a = smooth[(y + p[k * 4 + 1]) * w + x + p[k * 4]];
      const b = smooth[(y + p[k * 4 + 3]) * w + x + p[k * 4 + 2]];
      if (a < b) desc[k >> 5] |= 1 << (k & 31);
    }
    return { x: x * level.scale, y: y * level.scale, desc };
  });
}

async function extractFeatures(file) {
  const pyr = await loadPyramid(file);
  const features = [];
  let budget = MAX_FEATURES;
  pyr.levels.forEach((level, l) => {
    const share = l === LEVELS - 1 ? budget : Math.round(MAX_FEATURES * (l === 0 ? 0.5 : 0.3));
    const found = detect(level, share);
    budget -= found.length;
    features.push(...found);
  });
  return { width: pyr.width, height: pyr.height, features };
}

/* ---------- Matching ---------- */

function popcount(v) {
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24);
}

function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += popcount(a[i] ^ b[i]);
  return d;
}

function bestMatches(from, to) {
  return from.map((f) => {
    let best = Infinity;
    let second = Infinity;
    let idx = -1;
    for (let j = 0; j < to.length; j++) {
      const d = hamming(f.desc, to[j].desc);
      if (d < best) { second = best; best = d; idx = j; } else if (d < second) second = d;
    }
    return { idx, best, second };
  });
}

/** Mutual nearest neighbours that also pass Lowe's ratio test. */
function match(fa, fb) {
  const ab = bestMatches(fa, fb);
  const ba = bestMatches(fb, fa);
  const out = [];
  ab.forEach((m, i) => {
    if (m.idx < 0 || ba[m.idx].idx !== i) return;
    if (m.best > 80 || m.best > 0.85 * m.second) return;
    out.push([i, m.idx]);
  });
  return out;
}

/* ---------- Homography estimation ---------- */

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

/** Least-squares DLT with h22 = 1 for pairs [[x, y], [u, v]] (src → dst). */
function fitHomography(pairs) {
  const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const Atb = new Array(8).fill(0);
  const addRow = (row, rhs) => {
    for (let i = 0; i < 8; i++) {
      Atb[i] += row[i] * rhs;
      for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j];
    }
  };
  for (const [[x, y], [u, v]] of pairs) {
    addRow([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
    addRow([0, 0, 0, x, y, 1, -v * x, -v * y], v);
  }
  const h = solve(AtA, Atb);
  return h && h.every(Number.isFinite) ? [...h, 1] : null;
}

/** Rejects transforms that fold, flip or wildly rescale the image. */
function plausible(H) {
  const q = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => apply(H, x, y));
  if (q.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) return false;
  let area = 0;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i];
    const [bx, by] = q[(i + 1) % 4];
    const [cx, cy] = q[(i + 2) % 4];
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (sign && Math.sign(cross) !== sign) return false;
    sign = Math.sign(cross);
    area += ax * by - bx * ay;
  }
  area = Math.abs(area) / 2;
  return sign > 0 && area > 0.25 && area < 4;
}

function ransac(pairs, threshold, rnd) {
  const n = pairs.length;
  const inliersOf = (H) => {
    const ids = [];
    for (let i = 0; i < n; i++) {
      const [[x, y], [u, v]] = pairs[i];
      const [px, py] = apply(H, x, y);
      if (Math.hypot((px - u) * threshold.sx, (py - v) * threshold.sy) < threshold.px) ids.push(i);
    }
    return ids;
  };

  let best = [];
  let maxIter = 4000;
  for (let it = 0; it < maxIter; it++) {
    const sample = new Set();
    while (sample.size < 4) sample.add(Math.floor(rnd() * n));
    const pts = [...sample].map((i) => pairs[i]);
    const H = fitHomography(pts);
    if (!H || !plausible(H)) continue;
    const ids = inliersOf(H);
    if (ids.length > best.length) {
      best = ids;
      const ratio = ids.length / n;
      maxIter = Math.min(maxIter, Math.ceil(Math.log(0.005) / Math.log(1 - ratio ** 4 + 1e-12)));
    }
  }
  if (best.length < 4) return null;

  // Refine on all inliers, then re-collect inliers once more.
  let H = fitHomography(best.map((i) => pairs[i]));
  if (!H) return null;
  let ids = inliersOf(H);
  const refined = fitHomography(ids.map((i) => pairs[i]));
  if (refined) {
    H = refined;
    ids = inliersOf(H);
  }
  return plausible(H) ? { H, inliers: ids.length } : null;
}

/**
 * Estimates the homography mapping photo `fileB` onto photo `fileA`, in
 * normalised coordinates. Returns { h, inliers, matches } or null when the
 * photos cannot be aligned reliably (different view, too much change).
 */
async function alignImages(fileB, fileA, { getFeatures = extractFeatures } = {}) {
  const [a, b] = await Promise.all([getFeatures(fileA), getFeatures(fileB)]);
  const matches = match(b.features, a.features);
  if (matches.length < MIN_INLIERS) return null;
  const pairs = matches.map(([ib, ia]) => [
    [b.features[ib].x / b.width, b.features[ib].y / b.height],
    [a.features[ia].x / a.width, a.features[ia].y / a.height],
  ]);
  const result = ransac(pairs, { px: 3, sx: a.width, sy: a.height }, mulberry32(42));
  if (!result || result.inliers < MIN_INLIERS || result.inliers < 0.15 * matches.length) return null;
  return {
    h: result.H.map((v) => Math.round(v * 1e9) / 1e9),
    inliers: result.inliers,
    matches: matches.length,
  };
}

const MAX_TILT_DEG = 25; // a repeat panorama held more crooked than this is a wrong match

/**
 * Aligns 360° panorama B to panorama A (equirectangular): the same features,
 * but the model is a rotation of the sphere (see sphere.js) instead of a
 * homography. Returns { r, inliers, matches } with `r` mapping B's
 * directions onto A's, or null.
 */
async function alignPanoramas(fileB, fileA, { getFeatures = extractFeatures } = {}) {
  const [a, b] = await Promise.all([getFeatures(fileA), getFeatures(fileB)]);
  const matches = match(b.features, a.features);
  if (matches.length < MIN_INLIERS) return null;
  const pairs = matches.map(([ib, ia]) => [
    sphere.toVector(b.features[ib].x / b.width, b.features[ib].y / b.height),
    sphere.toVector(a.features[ia].x / a.width, a.features[ia].y / a.height),
  ]);
  // 3 px of the work image, as for photos.
  const result = sphere.ransacRotation(pairs, (3 / a.width) * 2 * Math.PI, mulberry32(42));
  if (!result || result.inliers < MIN_INLIERS || result.inliers < 0.15 * matches.length) return null;
  if (sphere.describe(result.R).tilt > MAX_TILT_DEG) return null;
  return { r: result.R.map((v) => Math.round(v * 1e9) / 1e9), inliers: result.inliers, matches: matches.length };
}

module.exports = { alignImages, alignPanoramas, extractFeatures };
