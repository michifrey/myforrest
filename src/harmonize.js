'use strict';

/*
 * Harmonisation of Landsat with Sentinel-2. The sensors see the same canopy
 * through different bands, so their NDVI and NDMI differ slightly (Landsat
 * NDVI runs a little lower over forest; Landsat 5 and 7 differ from 8). To
 * read a series across 2017 as one, Landsat values are mapped onto the
 * Sentinel-2 scale with a fit from months where both sensors saw the same
 * spot ("overlap"):
 *
 *   Landsat 8, Landsat 7 → Sentinel-2   directly (overlap 2017 onwards)
 *   Landsat 5 → Landsat 7 → Sentinel-2  chained (Landsat 5 ended in 2011)
 *
 * The fit pools all spots: with at least MIN_LINEAR month pairs a robust line
 * (Theil–Sen: median of pairwise slopes, intercept from the median residual),
 * with at least MIN_OFFSET pairs only a constant offset (median difference).
 * A line whose slope leaves 0.8–1.25 is not trusted and the offset is used
 * instead. Sensors without enough overlap stay unadjusted, and the months say
 * so.
 */

const MIN_LINEAR = 12;
const MIN_OFFSET = 4;
const SLOPE_RANGE = [0.8, 1.25];
const INDICES = ['ndvi', 'ndmi'];

const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r4 = (v) => Math.round(v * 10000) / 10000;
const has = (v) => v !== null && v !== undefined;

/** Per month and sensor the median NDVI and NDMI of a spot's scenes: Map month → { sensor: { ndvi, ndmi, scenes } }. */
function sensorMonths(scenes) {
  const groups = new Map();
  for (const s of scenes) {
    if (!has(s.ndvi) && !has(s.ndmi)) continue;
    const key = `${s.date.slice(0, 7)}|${s.sensor || 'S2'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const out = new Map();
  for (const [key, list] of groups) {
    const [month, sensor] = key.split('|');
    if (!out.has(month)) out.set(month, {});
    const value = (k) => {
      const v = list.filter((s) => has(s[k])).map((s) => s[k]);
      return v.length ? median(v) : null;
    };
    out.get(month)[sensor] = { ndvi: value('ndvi'), ndmi: value('ndmi'), scenes: list.filter((s) => has(s.ndvi)).length };
  }
  return out;
}

/** Theil–Sen line y = intercept + slope · x through pairs [[x, y]]. */
function theilSen(pairs) {
  const slopes = [];
  for (let i = 0; i < pairs.length; i++) {
    for (let j = i + 1; j < pairs.length; j++) {
      const dx = pairs[j][0] - pairs[i][0];
      if (Math.abs(dx) > 1e-9) slopes.push((pairs[j][1] - pairs[i][1]) / dx);
    }
  }
  if (!slopes.length) return null;
  const slope = median(slopes);
  return { slope, intercept: median(pairs.map(([x, y]) => y - slope * x)) };
}

/** One sensor-to-sensor fit from month pairs [[from, to]], or null with too few pairs. */
function fitPairs(pairs) {
  if (pairs.length < MIN_OFFSET) return null;
  let fit = null;
  if (pairs.length >= MIN_LINEAR) {
    const line = theilSen(pairs);
    if (line && line.slope >= SLOPE_RANGE[0] && line.slope <= SLOPE_RANGE[1]) fit = { kind: 'linear', ...line };
  }
  if (!fit) fit = { kind: 'offset', slope: 1, intercept: median(pairs.map(([x, y]) => y - x)) };
  const residual = median(pairs.map(([x, y]) => Math.abs(fit.intercept + fit.slope * x - y)));
  // How far apart the sensors were before: what the adjustment removes.
  const before = median(pairs.map(([x, y]) => y - x));
  return { kind: fit.kind, slope: r4(fit.slope), intercept: r4(fit.intercept), pairs: pairs.length, before: r4(before), residual: r4(residual) };
}

/** Month pairs of two sensors over all spots for one index. */
function pairsOf(spots, from, to, key) {
  const pairs = [];
  for (const months of spots) {
    for (const bySensor of months.values()) {
      const a = bySensor[from]?.[key];
      const b = bySensor[to]?.[key];
      if (has(a) && has(b)) pairs.push([a, b]);
    }
  }
  return pairs;
}

/**
 * The harmonisation from the scenes of all spots ([scenes of spot 1, …]):
 * per index { L8, L7, L5 } → fit onto the Sentinel-2 scale or null.
 */
function fitHarmonization(scenesBySpot) {
  const spots = scenesBySpot.map(sensorMonths);
  const out = {};
  for (const key of INDICES) {
    const l8 = fitPairs(pairsOf(spots, 'L8', 'S2', key));
    const l7 = fitPairs(pairsOf(spots, 'L7', 'S2', key));
    const l5to7 = fitPairs(pairsOf(spots, 'L5', 'L7', key));
    // Landsat 5 never overlapped Sentinel-2: through Landsat 7 (S2 = a7 + b7 · (a5 + b5 · L5)).
    const l5 = l5to7 && l7 ? {
      kind: 'chained',
      slope: r4(l7.slope * l5to7.slope),
      intercept: r4(l7.intercept + l7.slope * l5to7.intercept),
      pairs: l5to7.pairs,
      via: 'L7',
      before: l5to7.before,
      residual: l5to7.residual,
    } : null;
    out[key] = { L8: l8, L7: l7, L5: l5 };
  }
  return out;
}

/** A Landsat value on the Sentinel-2 scale, or null when there is no fit for that sensor. */
function adjust(value, fit) {
  if (!has(value) || !fit) return null;
  return Math.max(-1, Math.min(1, fit.intercept + fit.slope * value));
}

module.exports = { fitHarmonization, sensorMonths, theilSen, fitPairs, adjust, MIN_LINEAR, MIN_OFFSET };
