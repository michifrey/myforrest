'use strict';

/*
 * Object detection on single photos: fallen trees / lying stems, root
 * plates, deadwood, log piles and skid trails.
 *
 * A proper detector (a fine-tuned YOLO or segmentation model) cannot be
 * bundled with this prototype, so detection is pluggable:
 *
 *  1. External detector (optional): with DETECTOR_URL set, every photo is
 *     sent as the raw request body
 *        POST <DETECTOR_URL>   Content-Type: image/jpeg | image/png | image/webp
 *     and the service answers with JSON
 *        { "detections": [ { "label": "liegender_stamm", "score": 0.87,
 *                            "box": [x0, y0, x1, y1] }, … ],
 *          "model": "yolo-forest-v3" }            (a bare array also works)
 *     Boxes are normalised to [0, 1] of the (EXIF-rotated) image; boxes in
 *     pixels (any value > 1.5) are normalised with the image size. Labels
 *     use the vocabulary below; common English names are mapped, unknown
 *     labels are kept as given. If the service fails, the built-in
 *     heuristics are used instead.
 *
 *  2. Built-in heuristics (always available, EXPERIMENTAL):
 *     - lying stems: a Hough transform over near-horizontal edges (±25°)
 *       finds long straight edges; two parallel edges of opposite polarity a
 *       stem's width apart, with bark-like (non-green, low-saturation,
 *       textured) pixels between them, make a lying stem;
 *     - log piles: many similar, roughly circular light-brown blobs (cut
 *       faces of stacked logs) clustered together.
 *     Root plates, deadwood in general and skid trails are not attempted by
 *     the heuristics – they need a learned model.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

const LABELS = {
  liegender_stamm: 'Liegender Stamm / umgestürzter Baum',
  wurzelteller: 'Wurzelteller',
  totholz: 'Totholz',
  holzpolter: 'Holzpolter',
  rueckegasse: 'Rückegasse',
};
const SYNONYMS = {
  fallen_tree: 'liegender_stamm', 'fallen tree': 'liegender_stamm', log: 'liegender_stamm', lying_stem: 'liegender_stamm',
  trunk: 'liegender_stamm', windthrow: 'liegender_stamm',
  root_plate: 'wurzelteller', 'root plate': 'wurzelteller', rootwad: 'wurzelteller', root_wad: 'wurzelteller',
  deadwood: 'totholz', dead_wood: 'totholz', 'dead wood': 'totholz', snag: 'totholz', stump: 'totholz',
  log_pile: 'holzpolter', 'log pile': 'holzpolter', woodpile: 'holzpolter', timber_stack: 'holzpolter',
  skid_trail: 'rueckegasse', 'skid trail': 'rueckegasse', forest_road: 'rueckegasse',
};
const WORK_SIZE = 320;
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const r3 = (v) => Math.round(v * 1000) / 1000;
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

function normaliseLabel(label) {
  const l = String(label || '').trim().toLowerCase();
  if (Object.hasOwn(LABELS, l)) return l;
  return SYNONYMS[l] || SYNONYMS[l.replace(/[-\s]+/g, '_')] || l.replace(/[^a-z0-9_äöüß -]/g, '').slice(0, 40) || 'objekt';
}

const iou = (a, b) => {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return ua > 0 ? inter / ua : 0;
};

/** Greedy non-maximum suppression per label. */
function suppress(dets, threshold = 0.4) {
  const out = [];
  for (const d of [...dets].sort((a, b) => b.score - a.score)) {
    if (!out.some((o) => o.label === d.label && iou(o.box, d.box) > threshold)) out.push(d);
  }
  return out;
}

async function loadImage(file) {
  const { data, info } = await sharp(file)
    .rotate()
    .resize(WORK_SIZE, WORK_SIZE, { fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width; const h = info.height; const n = w * h;
  const R = new Float32Array(n); const G = new Float32Array(n); const B = new Float32Array(n); const L = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    R[i] = data[i * 3] / 255; G[i] = data[i * 3 + 1] / 255; B[i] = data[i * 3 + 2] / 255;
    L[i] = 0.299 * R[i] + 0.587 * G[i] + 0.114 * B[i];
  }
  return { w, h, R, G, B, L };
}

/* ---------- Lying stems: Hough transform on near-horizontal edges ---------- */

/** 3×3 box blur, applied twice: suppresses leaf/needle-scale noise, keeps long edges. */
function smooth(src, w, h) {
  let cur = src;
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0; let m = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            s += cur[yy * w + xx]; m++;
          }
        }
        out[y * w + x] = s / m;
      }
    }
    cur = out;
  }
  return cur;
}

function sobel({ w, h, L: raw }) {
  const L = smooth(raw, w, h);
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      gx[i] = (L[i - w + 1] + 2 * L[i + 1] + L[i + w + 1]) - (L[i - w - 1] + 2 * L[i - 1] + L[i + w - 1]);
      gy[i] = (L[i + w - 1] + 2 * L[i + w] + L[i + w + 1]) - (L[i - w - 1] + 2 * L[i - w] + L[i - w + 1]);
    }
  }
  return { gx, gy };
}

const MAX_TILT = 25; // degrees from horizontal

/**
 * Long straight near-horizontal edge segments: { a (tilt in degrees), y at
 * x = 0, x0, x1, polarity (+1: brighter below), support }.
 */
function horizontalSegments(img, { gx, gy }) {
  const { w, h } = img;
  const n = w * h;
  const mag = new Float32Array(n);
  for (let i = 0; i < n; i++) mag[i] = Math.hypot(gx[i], gy[i]);
  const sorted = Float32Array.from(mag).sort();
  const thr = Math.max(0.12, sorted[Math.floor(n * 0.88)]);
  // Parametrise lines as y = y0 + x·tan(a); accumulate per (a, y0) on a 1° × 1 px grid.
  const angles = [];
  for (let a = -MAX_TILT; a <= MAX_TILT; a += 1) angles.push(a);
  const tans = angles.map((a) => Math.tan((a * Math.PI) / 180));
  const yMin = -Math.ceil(w * Math.tan((MAX_TILT * Math.PI) / 180));
  const yRange = h - yMin + 1;
  const acc = new Float32Array(angles.length * yRange);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (mag[i] < thr) continue;
      // Edge orientation from the gradient: the edge is perpendicular to it.
      const edgeTilt = (Math.atan2(-gx[i], gy[i]) * 180) / Math.PI; // 0 = horizontal edge
      const t = ((edgeTilt + 90) % 180 + 180) % 180 - 90;
      if (Math.abs(t) > MAX_TILT + 8) continue;
      for (let k = 0; k < angles.length; k++) {
        if (Math.abs(angles[k] - t) > 8) continue;
        const y0 = Math.round(y - x * tans[k]);
        acc[k * yRange + (y0 - yMin)] += 1;
      }
    }
  }
  // Peaks: local maxima above a minimum support, strongest first.
  const minVotes = w * 0.2;
  const peaks = [];
  for (let k = 0; k < angles.length; k++) {
    for (let j = 0; j < yRange; j++) {
      const v = acc[k * yRange + j];
      if (v < minVotes) continue;
      let isMax = true;
      for (let dk = -2; dk <= 2 && isMax; dk++) {
        for (let dj = -2; dj <= 2; dj++) {
          const kk = k + dk; const jj = j + dj;
          if ((dk || dj) && kk >= 0 && kk < angles.length && jj >= 0 && jj < yRange && acc[kk * yRange + jj] > v) { isMax = false; break; }
        }
      }
      if (isMax) peaks.push({ k, y0: j + yMin, v });
    }
  }
  peaks.sort((a, b) => b.v - a.v);
  const segments = [];
  for (const p of peaks.slice(0, 40)) {
    const tan = tans[p.k];
    // Walk along the line, collect supported x positions and the polarity of the edge.
    let runStart = -1; let lastHit = -1; let best = null; let pol = 0; let polRun = 0; let hits = 0;
    for (let x = 1; x < w - 1; x++) {
      const yc = p.y0 + x * tan;
      let hit = false; let s = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const y = Math.round(yc + dy);
        if (y < 1 || y >= h - 1) continue;
        const i = y * w + x;
        if (mag[i] >= thr * 0.8) { hit = true; s = Math.sign(gy[i]); break; }
      }
      if (hit) {
        if (runStart < 0 || x - lastHit > 6) { runStart = x; polRun = 0; hits = 0; }
        lastHit = x;
        polRun += s;
        hits++;
        if (!best || lastHit - runStart > best.x1 - best.x0) best = { x0: runStart, x1: lastHit, pol: polRun, hits };
      }
      pol += s;
    }
    if (!best || best.x1 - best.x0 < w * 0.25 || best.hits < (best.x1 - best.x0) * 0.6) continue;
    if (Math.abs(best.pol) < best.hits * 0.5) continue; // mixed polarity: texture, not one boundary
    segments.push({ a: angles[p.k], tan, y0: p.y0, x0: best.x0, x1: best.x1, polarity: Math.sign(best.pol), support: best.hits });
  }
  return segments;
}

/** Fraction of bark-like pixels (not green, low saturation, some texture) in a band between two lines. */
function bandStats(img, top, bottom, x0, x1, { gx, gy }) {
  const { w, h, R, G, B } = img;
  let m = 0; let bark = 0; let tex = 0; let green = 0;
  for (let x = x0; x <= x1; x++) {
    const ya = Math.ceil(top.y0 + x * top.tan) + 1;
    const yb = Math.floor(bottom.y0 + x * bottom.tan) - 1;
    for (let y = Math.max(0, ya); y <= Math.min(h - 1, yb); y++) {
      const i = y * w + x;
      const s = R[i] + G[i] + B[i] + 1e-3;
      const exg = (2 * G[i] - R[i] - B[i]) / s;
      const mx = Math.max(R[i], G[i], B[i]); const mn = Math.min(R[i], G[i], B[i]);
      const sat = mx > 0 ? (mx - mn) / mx : 0;
      m++;
      if (exg > 0.08) green++;
      if (exg < 0.06 && sat < 0.7 && mx > 0.12) bark++;
      tex += Math.hypot(gx[i], gy[i]);
    }
  }
  return m ? { bark: bark / m, green: green / m, texture: tex / m, pixels: m } : null;
}

function lyingStems(img) {
  const grad = sobel(img);
  const segs = horizontalSegments(img, grad);
  const { w, h } = img;
  const found = [];
  for (let i = 0; i < segs.length; i++) {
    for (let j = 0; j < segs.length; j++) {
      const a = segs[i]; const b = segs[j];
      if (i === j || Math.abs(a.a - b.a) > 4 || a.polarity === b.polarity) continue;
      const x0 = Math.max(a.x0, b.x0); const x1 = Math.min(a.x1, b.x1);
      const shorter = Math.min(a.x1 - a.x0, b.x1 - b.x0);
      if (x1 - x0 < shorter * 0.6 || x1 - x0 < w * 0.25) continue;
      const xm = (x0 + x1) / 2;
      const gap = (b.y0 + xm * b.tan) - (a.y0 + xm * a.tan); // b below a
      if (gap < 4 || gap > h * 0.25) continue;
      const band = bandStats(img, a, b, x0, x1, grad);
      if (!band || band.pixels < 40) continue;
      const length = (x1 - x0) / w;
      const score = sigmoid(
        3 * (length - 0.35) + 4 * (band.bark - 0.5) - 5 * band.green + 2 * Math.min(1, band.texture / 0.15) - 0.6,
      );
      if (score < 0.4) continue;
      const ys = [a.y0 + x0 * a.tan, a.y0 + x1 * a.tan, b.y0 + x0 * b.tan, b.y0 + x1 * b.tan];
      const pad = 2;
      found.push({
        label: 'liegender_stamm',
        score: Math.round(score * 100) / 100,
        box: [x0 / w, (Math.min(...ys) - pad) / h, (x1 + 1) / w, (Math.max(...ys) + pad) / h].map((v) => r3(clamp01(v))),
        info: { tilt: a.a, widthPx: Math.round(gap), barkShare: Math.round(band.bark * 100) / 100 },
      });
    }
  }
  return suppress(found, 0.3).slice(0, 6);
}

/* ---------- Log piles: clusters of round, light-brown cut faces ---------- */

function logPiles(img) {
  const { w, h, R, G, B, L } = img;
  const n = w * h;
  const cut = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const s = R[i] + G[i] + B[i] + 1e-3;
    const exg = (2 * G[i] - R[i] - B[i]) / s;
    cut[i] = R[i] >= G[i] && G[i] >= B[i] && R[i] - B[i] >= 0.15 && L[i] >= 0.4 && L[i] <= 0.95 && exg < 0.05 ? 1 : 0;
  }
  const label = new Int32Array(n).fill(-1);
  const blobs = [];
  const stack = [];
  for (let s = 0; s < n; s++) {
    if (!cut[s] || label[s] !== -1) continue;
    let area = 0; let minX = w; let maxX = 0; let minY = h; let maxY = 0;
    label[s] = blobs.length;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop();
      area++;
      const x = i % w; const y = (i - x) / w;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      for (const j of [x > 0 && i - 1, x < w - 1 && i + 1, y > 0 && i - w, y < h - 1 && i + w]) {
        if (j !== false && cut[j] && label[j] === -1) { label[j] = blobs.length; stack.push(j); }
      }
    }
    const bw = maxX - minX + 1; const bh = maxY - minY + 1;
    const fill = area / (bw * bh);
    const aspect = bw / bh;
    if (area >= 12 && area <= n * 0.02 && aspect >= 0.6 && aspect <= 1.6 && fill >= 0.6 && fill <= 0.95) {
      blobs.push({ cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, r: (bw + bh) / 4, box: [minX, minY, maxX + 1, maxY + 1] });
    } else {
      blobs.push(null); // keep indices aligned with labels
    }
  }
  const round = blobs.filter(Boolean);
  if (round.length < 6) return [];
  // Single-linkage clustering of blobs closer than 3 radii.
  const group = round.map((_, i) => i);
  const find = (i) => (group[i] === i ? i : (group[i] = find(group[i])));
  for (let i = 0; i < round.length; i++) {
    for (let j = i + 1; j < round.length; j++) {
      const a = round[i]; const b = round[j];
      if (Math.hypot(a.cx - b.cx, a.cy - b.cy) <= 1.8 * (a.r + b.r)) group[find(i)] = find(j);
    }
  }
  const clusters = new Map();
  round.forEach((b, i) => { const g = find(i); if (!clusters.has(g)) clusters.set(g, []); clusters.get(g).push(b); });
  const out = [];
  for (const members of clusters.values()) {
    if (members.length < 6) continue;
    const radii = members.map((b) => b.r).sort((a, b) => a - b);
    const med = radii[Math.floor(radii.length / 2)];
    const similar = members.filter((b) => b.r >= med * 0.5 && b.r <= med * 2);
    if (similar.length < 6) continue;
    const x0 = Math.min(...similar.map((b) => b.box[0])); const y0 = Math.min(...similar.map((b) => b.box[1]));
    const x1 = Math.max(...similar.map((b) => b.box[2])); const y1 = Math.max(...similar.map((b) => b.box[3]));
    const covered = similar.reduce((s, b) => s + Math.PI * b.r * b.r, 0) / ((x1 - x0) * (y1 - y0));
    if (covered < 0.2) continue;
    const score = clamp01(0.35 + similar.length / 30 + (covered - 0.2));
    out.push({
      label: 'holzpolter',
      score: Math.round(Math.min(0.9, score) * 100) / 100,
      box: [x0 / w, y0 / h, x1 / w, y1 / h].map(r3),
      info: { crossSections: similar.length },
    });
  }
  return out;
}

/** Built-in heuristic detections for an image file. */
async function detectHeuristic(file) {
  const img = await loadImage(file);
  return [...lyingStems(img), ...logPiles(img)].map((d) => ({ ...d, source: 'heuristik' }));
}

/** Sends the image to an external detector (contract in the header comment). */
async function detectExternal(file, { url, fetchImpl = fetch, timeoutMs = 30000 }) {
  const body = await fsp.readFile(file);
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', Accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Detektor antwortet mit HTTP ${res.status}`);
  const json = await res.json();
  const list = Array.isArray(json) ? json : json?.detections;
  if (!Array.isArray(list)) throw new Error('Detektor-Antwort ohne "detections"');
  let size = null;
  const out = [];
  for (const d of list) {
    const box = Array.isArray(d?.box) && d.box.length === 4 ? d.box.map(Number) : null;
    if (!box || !box.every(Number.isFinite)) continue;
    let b = box;
    if (box.some((v) => v > 1.5)) {
      if (!size) {
        const m = await sharp(file).metadata();
        size = (m.orientation || 1) >= 5 ? { w: m.height, h: m.width } : { w: m.width, h: m.height };
      }
      b = [box[0] / size.w, box[1] / size.h, box[2] / size.w, box[3] / size.h];
    }
    b = [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])].map((v) => r3(clamp01(v)));
    if (b[2] - b[0] <= 0 || b[3] - b[1] <= 0) continue;
    out.push({
      label: normaliseLabel(d.label),
      score: Math.round(clamp01(Number(d.score) || 0) * 100) / 100,
      box: b,
      source: 'extern',
      info: json?.model ? { model: String(json.model).slice(0, 80) } : undefined,
    });
  }
  return out;
}

/**
 * Detects objects on a photo: the external detector when configured (falls
 * back to the heuristics on errors), otherwise the heuristics.
 * Returns { detector, detections, error? }.
 */
async function detectObjects(file, { url = null, fetchImpl = fetch } = {}) {
  if (url) {
    try {
      return { detector: 'extern', detections: await detectExternal(file, { url, fetchImpl }) };
    } catch (err) {
      return { detector: 'heuristik', detections: await detectHeuristic(file), error: err.message };
    }
  }
  return { detector: 'heuristik', detections: await detectHeuristic(file) };
}

/**
 * Change classes a confirmed detection supports when it overlaps a changed
 * region (used as training examples for learn.js).
 */
const DETECTION_CLASS = { liegender_stamm: 'windwurf', wurzelteller: 'windwurf', holzpolter: 'auflichtung', rueckegasse: 'auflichtung' };
const DETECTION_TAG = { liegender_stamm: 'sturmschaden', wurzelteller: 'sturmschaden', totholz: 'totholz', holzpolter: 'holzschlag', rueckegasse: 'holzschlag' };

module.exports = {
  detectObjects, detectHeuristic, detectExternal, normaliseLabel, iou, LABELS, DETECTION_CLASS, DETECTION_TAG,
  _internal: { loadImage, sobel, horizontalSegments, bandStats, lyingStems, logPiles },
};
