'use strict';

/**
 * Alignment on the horizon, for landscapes without fixed points: in a dune
 * field the sand moves, so the feature matching of align.js finds nothing
 * that stayed in place – but the line where the sky meets the ground (the
 * dune crests, a ridge, the far horizon) does stay recognisable.
 *
 * Per column of a small copy of each photo the skyline is the first row from
 * the top that is not sky (sky: bright and at least as blue as red, i.e. blue
 * or white-grey, unlike sand and rock). The two skylines are slid against
 * each other; the shift with the best correlation gives the horizontal
 * offset, the median height difference the vertical one. The result is a
 * translation in normalised image coordinates (photo B onto photo A), like
 * the homographies of align.js. It is only used when the correlation is
 * high and the skyline has enough shape (a flat horizon gives no offset).
 */

const sharp = require('sharp');

const WIDTH = 320;
const MAX_SHIFT = 0.3; // of the width
const MIN_OVERLAP = 0.5;
const MIN_CORRELATION = 0.85;
const MIN_RELIEF = 0.01; // standard deviation of the skyline, as a share of the height

/** Skyline of an image: { width, height, ys: [row or null per column] (normalised 0..1) }. */
async function skyline(file) {
  const { data, info } = await sharp(file).rotate().resize({ width: WIDTH }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const isSky = (x, y) => {
    const i = (y * width + x) * channels;
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    return (r + g + b) / 3 > 110 && b >= r - 8;
  };
  const ys = [];
  for (let x = 0; x < width; x++) {
    if (!isSky(x, 0) || !isSky(x, 1)) { ys.push(null); continue; }
    let found = null;
    for (let y = 2; y < height - 2; y++) {
      if (!isSky(x, y) && !isSky(x, y + 1) && !isSky(x, y + 2)) { found = y; break; }
    }
    ys.push(found === null ? null : found / height);
  }
  return { width, height, ys };
}

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

/** Pearson correlation of two equally long arrays. */
function correlation(a, b) {
  const ma = mean(a);
  const mb = mean(b);
  let sab = 0; let saa = 0; let sbb = 0;
  for (let i = 0; i < a.length; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
}

/**
 * Aligns photo B onto photo A on their skylines: { h: 3×3 translation (normalised), correlation, shift } or null.
 * `skylineOf` can be replaced (tests, caching).
 */
async function alignOnHorizon(fileB, fileA, { skylineOf = skyline } = {}) {
  const [a, b] = await Promise.all([skylineOf(fileA), skylineOf(fileB)]);
  const n = Math.min(a.ys.length, b.ys.length);
  const valid = (s) => s.ys.filter((v) => v !== null);
  const relief = (s) => { const v = valid(s); const m = mean(v); return Math.sqrt(mean(v.map((x) => (x - m) ** 2))); };
  if (valid(a).length < 0.6 * n || valid(b).length < 0.6 * n) return null;
  if (relief(a) < MIN_RELIEF || relief(b) < MIN_RELIEF) return null;
  let best = null;
  const maxShift = Math.round(MAX_SHIFT * n);
  for (let s = -maxShift; s <= maxShift; s++) {
    // Column c of B lies at column c + s of A.
    const pa = []; const pb = [];
    for (let c = 0; c < n; c++) {
      const ca = c + s;
      if (ca < 0 || ca >= n || a.ys[ca] === null || b.ys[c] === null) continue;
      pa.push(a.ys[ca]); pb.push(b.ys[c]);
    }
    if (pa.length < MIN_OVERLAP * n) continue;
    const r = correlation(pa, pb);
    if (!best || r > best.r) best = { s, r, pa, pb };
  }
  if (!best || best.r < MIN_CORRELATION) return null;
  const diffs = best.pa.map((v, i) => v - best.pb[i]).sort((x, y) => x - y);
  const dy = diffs[Math.floor(diffs.length / 2)];
  const dx = best.s / n;
  const round = (v) => Math.round(v * 1e9) / 1e9;
  return { h: [1, 0, round(dx), 0, 1, round(dy), 0, 0, 1], correlation: Math.round(best.r * 1000) / 1000, shift: best.s, columns: best.pa.length };
}

module.exports = { alignOnHorizon, skyline, correlation };
