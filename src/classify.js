'use strict';

/*
 * Classifies the changed regions found by change.js into forest-relevant
 * categories. Each region is described by how greenness, brightness,
 * texture, edge orientation and shape differ between before and after;
 * transparent rules turn that into a class with a confidence and a
 * suggested observation tag. Heuristics, not ground truth: the UI presents
 * them as suggestions.
 */

const { CHANGED } = require('./change');

const CLASSES = {
  windwurf: { label: 'Windwurf / liegende Stämme', tag: 'sturmschaden', color: '#c2611d' },
  auflichtung: { label: 'Auflichtung / Holzschlag', tag: 'holzschlag', color: '#d4a017' },
  verfaerbung: { label: 'Verfärbung (grün → gelb/braun)', tag: 'trockenschaden', color: '#8b5a2b' },
  bewuchs: { label: 'Neuer Bewuchs', tag: 'verjuengung', color: '#3f7a3c' },
  sonstiges: { label: 'Sonstige Veränderung', tag: null, color: '#7a7a7a' },
};

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Box blur (radius r) for grouping nearby changed pixels. */
function spread(src, w, h, r) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let dy = -r; dy <= r; dy += 2) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -r; dx <= r; dx += 2) m = Math.max(m, src[yy * w + Math.min(w - 1, Math.max(0, x + dx))]);
      }
      out[y * w + x] = m;
    }
  }
  return out;
}

/**
 * Groups changed pixels into regions: connected components of the changed
 * mask after a small dilation, so a patch split by a thin unchanged
 * structure (a trunk) stays one region. Returns the changed pixels per region.
 */
function regions(score, w, h, minArea) {
  const grown = spread(score, w, h, 8);
  const label = new Int32Array(w * h).fill(-1);
  const out = [];
  const stack = [];
  for (let start = 0; start < w * h; start++) {
    if (label[start] !== -1 || grown[start] < CHANGED) continue;
    const pixels = [];
    label[start] = out.length;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop();
      pixels.push(i);
      const x = i % w;
      const y = (i - x) / w;
      for (const j of [x > 0 && i - 1, x < w - 1 && i + 1, y > 0 && i - w, y < h - 1 && i + w]) {
        if (j !== false && label[j] === -1 && grown[j] >= CHANGED) {
          label[j] = out.length;
          stack.push(j);
        }
      }
    }
    const changed = pixels.filter((i) => score[i] >= CHANGED);
    if (changed.length >= minArea) out.push(changed);
  }
  return out;
}

/** Per-pixel helpers: excess green (chromaticity) and local texture. */
function excessGreen(P, i) {
  const s = P[0][i] + P[1][i] + P[2][i] + 1e-3;
  return (2 * P[1][i] - P[0][i] - P[2][i]) / s;
}

function describe(pixels, r) {
  const { width: w, before: A, after: B, grayBefore: ga, grayAfter: gb, score } = r;
  // Colour and texture are measured on the region's core: its rim straddles
  // the boundary, where the new edge itself would read as texture.
  const core = pixels.filter((i) => score[i] >= 0.75);
  const inner = core.length >= pixels.length * 0.3 ? new Set(core) : null;
  let exgA = 0; let exgB = 0; let lA = 0; let lB = 0;
  let tA = 0; let tB = 0; let hA = 0; let vA = 0; let hB = 0; let vB = 0;
  let sx = 0; let sy = 0; let sxx = 0; let syy = 0; let sxy = 0;
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  let m = 0;
  for (const i of pixels) {
    const x = i % w;
    const y = (i - x) / w;
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (inner && !inner.has(i)) continue;
    m++;
    exgA += excessGreen(A, i);
    exgB += excessGreen(B, i);
    lA += ga[i];
    lB += gb[i];
    // Gradients (central differences); |gy| dominates on horizontal structures such as lying trunks.
    const gxA = (ga[i + 1] ?? ga[i]) - (ga[i - 1] ?? ga[i]);
    const gyA = (ga[i + w] ?? ga[i]) - (ga[i - w] ?? ga[i]);
    const gxB = (gb[i + 1] ?? gb[i]) - (gb[i - 1] ?? gb[i]);
    const gyB = (gb[i + w] ?? gb[i]) - (gb[i - w] ?? gb[i]);
    tA += Math.hypot(gxA, gyA);
    tB += Math.hypot(gxB, gyB);
    hA += Math.abs(gyA); vA += Math.abs(gxA);
    hB += Math.abs(gyB); vB += Math.abs(gxB);
  }
  const n = pixels.length;
  const mx = sx / n;
  const my = sy / n;
  const cxx = sxx / n - mx * mx;
  const cyy = syy / n - my * my;
  const cxy = sxy / n - mx * my;
  const tr = cxx + cyy;
  const det = cxx * cyy - cxy * cxy;
  const l1 = tr / 2 + Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l2 = tr / 2 - Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const angle = (0.5 * Math.atan2(2 * cxy, cxx - cyy) * 180) / Math.PI; // 0° = horizontal
  return {
    n,
    bbox: [minX, minY, maxX + 1, maxY + 1],
    greenDelta: (exgB - exgA) / m,
    greenBefore: exgA / m,
    brightDelta: (lB - lA) / m,
    textureRatio: (tB + 1e-3) / (tA + 1e-3),
    horizontalShift: hB / (hB + vB + 1e-6) - hA / (hA + vA + 1e-6),
    elongation: Math.sqrt(l1 / Math.max(l2, 1e-6)),
    angle,
  };
}

function scores(f) {
  const lying = f.elongation >= 2.5 && Math.abs(f.angle) <= 40 ? clamp01((f.elongation - 2.5) / 2 + 0.6) : 0;
  return {
    windwurf: Math.max(lying, clamp01((f.horizontalShift - 0.08) / 0.15)) * (f.greenDelta > 0.12 ? 0.5 : 1),
    auflichtung: clamp01(f.brightDelta / 0.12) * clamp01((1 - f.textureRatio) / 0.5),
    verfaerbung: clamp01(-f.greenDelta / 0.1) * clamp01(f.greenBefore / 0.06 + 0.3) * (f.textureRatio > 0.5 ? 1 : 0.6),
    bewuchs: clamp01(f.greenDelta / 0.1),
  };
}

/**
 * Turns a change result into classified regions (largest first) and a
 * per-class summary. Bounding boxes are normalised to the "before" view.
 */
function classifyChange(r) {
  if (!r.before || !r.changedFraction) return { regions: [], summary: [] };
  let valid = 0;
  for (let i = 0; i < r.valid.length; i++) valid += r.valid[i];
  const minArea = Math.max(40, Math.round(valid * 0.004));
  const found = regions(r.score, r.width, r.height, minArea).map((px) => {
    const f = describe(px, r);
    const s = scores(f);
    const [best, conf] = Object.entries(s).sort((a, b) => b[1] - a[1])[0];
    const cls = conf >= 0.35 ? best : 'sonstiges';
    const [x0, y0, x1, y1] = f.bbox;
    return {
      class: cls,
      label: CLASSES[cls].label,
      confidence: Math.round((cls === 'sonstiges' ? 1 - conf : conf) * 100) / 100,
      area: Math.round((f.n / valid) * 1000) / 1000,
      bbox: [x0 / r.width, y0 / r.height, x1 / r.width, y1 / r.height].map((v) => Math.round(v * 1000) / 1000),
    };
  }).sort((a, b) => b.area - a.area);

  const byClass = new Map();
  for (const g of found) byClass.set(g.class, (byClass.get(g.class) || 0) + g.area);
  const summary = [...byClass].map(([cls, area]) => ({
    class: cls, label: CLASSES[cls].label, area: Math.round(area * 1000) / 1000, tag: CLASSES[cls].tag,
  })).sort((a, b) => b.area - a.area);
  return { regions: found, summary };
}

module.exports = { classifyChange, CLASSES };
