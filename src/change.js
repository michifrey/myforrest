'use strict';

/*
 * Change detection between two aligned photos of the same spot.
 *
 * Photo B is warped into photo A's view using the alignment homography and
 * compared per pixel with three signals:
 *  - structure: local normalised cross-correlation (tolerates ±1 px of
 *    residual misalignment and is insensitive to brightness and contrast),
 *    catches trees that fell, appeared or were cut;
 *  - colour: chromaticity, catches green turning brown (drought, bark beetle);
 *  - brightness, weighted down, after a global gain match between the photos.
 * The result is a score in [0, 1] per pixel of A's (downscaled) view.
 */

const sharp = require('sharp');
const { apply, invert } = require('./homography');

const WORK_SIZE = 320;
const CHANGED = 0.4;

async function loadRGB(file, size) {
  const { data, info } = await sharp(file)
    .rotate()
    .resize(size, size, { fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Box filter (radius r) with clamped edges. */
function blur(src, w, h, r) {
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

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Samples photo B (bilinear) at every pixel of A's view; returns RGB planes and a validity mask. */
function warpInto(a, b, hAtoB) {
  const n = a.width * a.height;
  const planes = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const valid = new Uint8Array(n);
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const [u, v] = apply(hAtoB, (x + 0.5) / a.width, (y + 0.5) / a.height);
      const bx = u * b.width - 0.5;
      const by = v * b.height - 0.5;
      if (!(bx >= 0 && by >= 0 && bx <= b.width - 1 && by <= b.height - 1)) continue;
      const x0 = Math.floor(bx);
      const y0 = Math.floor(by);
      const x1 = Math.min(b.width - 1, x0 + 1);
      const y1 = Math.min(b.height - 1, y0 + 1);
      const fx = bx - x0;
      const fy = by - y0;
      const i = y * a.width + x;
      for (let c = 0; c < 3; c++) {
        const p00 = b.data[(y0 * b.width + x0) * 3 + c];
        const p10 = b.data[(y0 * b.width + x1) * 3 + c];
        const p01 = b.data[(y1 * b.width + x0) * 3 + c];
        const p11 = b.data[(y1 * b.width + x1) * 3 + c];
        planes[c][i] = ((p00 * (1 - fx) + p10 * fx) * (1 - fy) + (p01 * (1 - fx) + p11 * fx) * fy) / 255;
      }
      valid[i] = 1;
    }
  }
  return { planes, valid };
}

/**
 * Computes the change score between photo A (`fileA`, the "before" view) and
 * photo B (`fileB`), where `hBtoA` maps B onto A in normalised coordinates.
 */
async function computeChange(fileA, fileB, hBtoA) {
  const hAtoB = invert(hBtoA);
  if (!hAtoB) throw new Error('Ausrichtung nicht invertierbar');
  const [a, b] = await Promise.all([loadRGB(fileA, WORK_SIZE), loadRGB(fileB, WORK_SIZE * 1.5)]);
  const { width: w, height: h } = a;
  const n = w * h;
  const A = [0, 1, 2].map((c) => Float32Array.from({ length: n }, (_, i) => a.data[i * 3 + c] / 255));
  const { planes: B, valid } = warpInto(a, b, hAtoB);

  // Global gain match per channel (lighting, exposure, white balance), then
  // fill areas B does not cover with A so they read as "unchanged".
  let count = 0;
  for (let i = 0; i < n; i++) count += valid[i];
  if (count < n * 0.2) return { width: w, height: h, score: new Float32Array(n), valid, changedFraction: 0, coverage: count / n };
  for (let c = 0; c < 3; c++) {
    let ma = 0; let mb = 0;
    for (let i = 0; i < n; i++) if (valid[i]) { ma += A[c][i]; mb += B[c][i]; }
    ma /= count; mb /= count;
    let va = 0; let vb = 0;
    for (let i = 0; i < n; i++) if (valid[i]) { va += (A[c][i] - ma) ** 2; vb += (B[c][i] - mb) ** 2; }
    const gain = Math.sqrt(va / Math.max(vb, 1e-9));
    for (let i = 0; i < n; i++) B[c][i] = valid[i] ? clamp01((B[c][i] - mb) * gain + ma) : A[c][i];
  }

  const gray = (P) => Float32Array.from({ length: n }, (_, i) => 0.299 * P[0][i] + 0.587 * P[1][i] + 0.114 * P[2][i]);
  const ga = gray(A);
  const gb = gray(B);

  // Structure: best local NCC over ±1 px shifts.
  const R = 3;
  const meanA = blur(ga, w, h, R);
  const varA = blur(ga.map((v) => v * v), w, h, R).map((v, i) => v - meanA[i] ** 2);
  const nccMax = new Float32Array(n).fill(-1);
  const shifted = new Float32Array(n);
  const prod = new Float32Array(n);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let y = 0; y < h; y++) {
        const sy = Math.min(h - 1, Math.max(0, y + dy));
        for (let x = 0; x < w; x++) shifted[y * w + x] = gb[sy * w + Math.min(w - 1, Math.max(0, x + dx))];
      }
      for (let i = 0; i < n; i++) prod[i] = ga[i] * shifted[i];
      const meanB = blur(shifted, w, h, R);
      const varB = blur(shifted.map((v) => v * v), w, h, R);
      const meanAB = blur(prod, w, h, R);
      for (let i = 0; i < n; i++) {
        const vb = varB[i] - meanB[i] ** 2;
        const va = varA[i];
        let ncc;
        if (va < 2e-4 && vb < 2e-4) ncc = 1; // both flat (sky, still water): no structural change
        else if (va < 2e-4 || vb < 2e-4) ncc = 0; // texture appeared or vanished
        else ncc = (meanAB[i] - meanA[i] * meanB[i]) / Math.sqrt(va * vb);
        if (ncc > nccMax[i]) nccMax[i] = ncc;
      }
    }
  }

  // Colour (chromaticity) and brightness, slightly smoothed.
  const chroma = (P, c) => Float32Array.from({ length: n }, (_, i) => P[c][i] / (P[0][i] + P[1][i] + P[2][i] + 1e-3));
  const [ra, rb, gA, gB] = [chroma(A, 0), chroma(B, 0), chroma(A, 1), chroma(B, 1)].map((p) => blur(p, w, h, 2));
  const la = blur(ga, w, h, 3);
  const lb = blur(gb, w, h, 3);

  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = clamp01((0.6 - nccMax[i]) / 0.6);
    const c = clamp01((Math.abs(ra[i] - rb[i]) + Math.abs(gA[i] - gB[i]) - 0.03) / 0.1);
    const l = clamp01((Math.abs(la[i] - lb[i]) - 0.12) / 0.25);
    raw[i] = Math.max(s, c, 0.6 * l);
  }
  const score = blur(raw, w, h, 2);

  // Ignore the uncovered area and a thin border around it.
  const cover = blur(Float32Array.from(valid), w, h, 3);
  let changed = 0;
  for (let i = 0; i < n; i++) {
    if (cover[i] < 0.999) { score[i] = 0; continue; }
    if (score[i] >= CHANGED) changed++;
  }
  return { width: w, height: h, score, valid, changedFraction: changed / count, coverage: count / n };
}

/** Transparent → yellow → orange → red overlay as PNG (A's view, downscaled). */
function renderHeatmap({ width, height, score }) {
  const stops = [[0.25, [255, 214, 90]], [0.6, [240, 125, 40]], [1, [196, 32, 44]]];
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = score[i];
    if (s < stops[0][0]) continue;
    let k = 0;
    while (k < stops.length - 2 && s > stops[k + 1][0]) k++;
    const [s0, c0] = stops[k];
    const [s1, c1] = stops[k + 1];
    const t = clamp01((s - s0) / (s1 - s0));
    for (let c = 0; c < 3; c++) rgba[i * 4 + c] = Math.round(c0[c] + (c1[c] - c0[c]) * t);
    rgba[i * 4 + 3] = Math.round(clamp01((s - 0.25) / 0.45) * 190);
  }
  return sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

module.exports = { computeChange, renderHeatmap, CHANGED };
