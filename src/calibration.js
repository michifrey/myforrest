'use strict';

/*
 * Calibration of the satellite early warning (sentinel.js: currentAnomalies)
 * against what photographers confirmed on the ground.
 *
 * Each pair of consecutive photos at a spot is one check: did damage appear
 * between the two visits (a damage tag new on the later photo, or a region
 * confirmed as windthrow, clearing or discolouration), or not? For every
 * check the strongest drop the early warning saw during the interval is
 * computed month by month, each month only with the data available then.
 * Sweeping the threshold over these drops gives hits, misses and false
 * alarms; the threshold with the best F1 score wins. With too few checks
 * the starting values stay.
 *
 * Numbers measured on the checks a threshold was chosen on are optimistic.
 * So the choice is cross-validated: the spots are split into up to five
 * groups (checks of one spot are not independent and stay together); for
 * each group the threshold is chosen on the other groups and tried on the
 * held-out one. The calibrated threshold is used only when it does at least
 * as well there as the starting value; otherwise the starting value stays.
 *
 * Two measures are calibrated on the same checks: the early warning
 * ('warning', see above) and the drop between the two photos themselves
 * ('photos', sentinel.js: pairDrop), which marks drops in the spot's chart.
 * Each is calibrated on all spots, and again per forest type (Laub-,
 * Nadelwald; forest-type.js) against the threshold of all spots: a forest
 * type gets its own threshold only when it does at least as well on its
 * held-out spots.
 */

const { anomalyScores, THRESHOLDS } = require('./sentinel');

const GRID = Array.from({ length: 28 }, (_, i) => Math.round((0.03 + i * 0.01) * 100) / 100); // 0.03 … 0.30
const MIN_POSITIVES = 5;
const MIN_NEGATIVES = 5;
const MAX_FOLDS = 5;
const MIN_SPOTS = 3; // fewer spots cannot be split into a meaningful cross-validation
const DAY = 86400000;
const MEASURES = ['warning', 'photos'];
const FOREST_TYPES = ['laub', 'nadel']; // Mischwald and unknown spots use the threshold of all spots

/**
 * The strongest early-warning drop of an index during (from, to] (ms): the
 * comparison is repeated at the middle of every month in the interval, each
 * time only with the months known by then. null when nothing was comparable.
 */
function maxDropBetween(monthly, from, to, key) {
  let best = null;
  const d = new Date(from);
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 15);
  if (t <= from) t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 15);
  for (; t <= to + 15 * DAY; t = Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth() + 1, 15)) {
    const s = anomalyScores(monthly, { now: Math.min(t, to) })[key];
    if (s && (best === null || s.drop > best)) best = s.drop;
  }
  return best;
}

/** Hits, misses and false alarms per threshold for samples [{ drop, damage }]. */
function sweep(samples) {
  return GRID.map((threshold) => {
    const counts = { tp: 0, fp: 0, fn: 0, tn: 0 };
    for (const s of samples) {
      const alert = s.drop !== null && s.drop >= threshold;
      if (s.damage) counts[alert ? 'tp' : 'fn']++;
      else counts[alert ? 'fp' : 'tn']++;
    }
    return { threshold, ...scores(counts) };
  });
}

const r3 = (v) => Math.round(v * 1000) / 1000;
/** Recall, precision and F1 of counted hits, misses and false alarms. */
function scores({ tp, fp, fn, tn }) {
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { tp, fp, fn, tn, recall: r3(recall), precision: r3(precision), f1: r3(f1) };
}

/**
 * The threshold with the best F1 on these samples (on ties the higher one:
 * fewer false alarms), or null when there are too few damaged or undamaged
 * checks or nothing scores.
 */
function chooseThreshold(samples, { minPositives = MIN_POSITIVES, minNegatives = MIN_NEGATIVES } = {}) {
  const positives = samples.filter((s) => s.damage).length;
  if (positives < minPositives || samples.length - positives < minNegatives) return null;
  const best = sweep(samples).reduce((b, r) => (r.f1 > b.f1 || (r.f1 === b.f1 && r.threshold > b.threshold) ? r : b));
  return best.f1 > 0 ? best.threshold : null;
}

/**
 * Grouped k-fold cross-validation by spot: the threshold is chosen on the
 * other folds (falling back to `fallback` when they are too few) and counted
 * on the held-out fold. Spots go round-robin into the folds in id order, so
 * the result is the same on every run. null with fewer than MIN_SPOTS spots.
 */
function crossValidate(samples, fallback, opts = {}) {
  const groups = [...new Set(samples.map((s) => s.group))].sort((a, b) => a - b);
  if (groups.length < MIN_SPOTS) return null;
  const k = Math.min(MAX_FOLDS, groups.length);
  const foldOf = new Map(groups.map((g, i) => [g, i % k]));
  const counts = { tp: 0, fp: 0, fn: 0, tn: 0 };
  const thresholds = [];
  let fitted = 0;
  for (let f = 0; f < k; f++) {
    const train = samples.filter((s) => foldOf.get(s.group) !== f);
    const chosen = chooseThreshold(train, opts);
    if (chosen !== null) fitted++;
    const threshold = chosen ?? fallback;
    thresholds.push(threshold);
    for (const s of samples.filter((x) => foldOf.get(x.group) === f)) {
      const alert = s.drop >= threshold;
      if (s.damage) counts[alert ? 'tp' : 'fn']++;
      else counts[alert ? 'fp' : 'tn']++;
    }
  }
  // `fitted`: folds whose own training checks were enough to choose a threshold.
  return { folds: k, fitted, thresholds, ...scores(counts) };
}

/**
 * Thresholds per index from samples { ndvi: [{ drop, damage, group }], ndmi: [...] }
 * (`group`: the spot). The best F1 on all checks is the candidate; it is used
 * when the cross-validation shows it at least as good as the fallback on
 * held-out spots: the starting value, or `opts.fallback[index]` (the
 * threshold of all spots, when calibrating one forest type). Otherwise the
 * fallback stays, with the reason: 'zu-wenige-kontrollen' (also when fewer
 * than half of the folds had enough checks to choose a threshold of their
 * own: then the cross-validation would mostly measure the fallback),
 * 'zu-wenige-spots' or 'nicht-besser'. The "strong" threshold keeps the
 * ratio of the starting values.
 */
function calibrate(samplesByIndex, opts = {}) {
  const out = {};
  for (const key of ['ndvi', 'ndmi']) {
    const samples = (samplesByIndex[key] || []).filter((s) => s.drop !== null && s.drop !== undefined);
    const positives = samples.filter((s) => s.damage).length;
    const negatives = samples.length - positives;
    const spots = new Set(samples.map((s) => s.group)).size;
    const [startThreshold, startStrong] = THRESHOLDS[key];
    const fallback = opts.fallback?.[key] ?? startThreshold;
    const rows = sweep(samples);
    const candidate = chooseThreshold(samples, opts);
    const cv = candidate === null ? null : crossValidate(samples, fallback, opts);
    // The starting value is not fitted to these checks: its numbers on all of them are already out-of-sample.
    // (The threshold of all spots was fitted on them among others, which makes the comparison stricter.)
    const standard = rows.find((r) => r.threshold === fallback) || null;
    let reason = null;
    if (candidate === null) reason = 'zu-wenige-kontrollen';
    else if (!cv) reason = 'zu-wenige-spots';
    else if (cv.fitted * 2 < cv.folds) reason = 'zu-wenige-kontrollen';
    else if (cv.f1 < (standard?.f1 ?? 0)) reason = 'nicht-besser';
    const threshold = reason ? fallback : candidate;
    out[key] = {
      index: key,
      source: reason ? 'standard' : 'kalibriert',
      reason,
      threshold,
      strong: Math.round(threshold * (startStrong / startThreshold) * 100) / 100,
      candidate,
      positives,
      negatives,
      spots,
      // What `standard` is: the starting value, or the threshold of all spots.
      baseline: opts.fallback?.[key] === undefined ? 'anfangswert' : 'alle-spots',
      // On all checks (optimistic for a calibrated threshold), …
      at: rows.find((r) => r.threshold === threshold) || null,
      // … on held-out spots, and the fallback for comparison.
      cv,
      standard,
      sweep: rows,
    };
  }
  return out;
}

/**
 * Both measures, on all spots and per forest type, from checks
 * [{ spotId, damage, forestType, warning: { ndvi, ndmi }, photos: { ndvi, ndmi } }]:
 * { checks, ndvi, ndmi (early warning, all spots), photos: { ndvi, ndmi },
 *   forestTypes: { laub: { checks, spots, ndvi, ndmi, photos: { ndvi, ndmi } }, nadel: … } }.
 */
function calibrateAll(checks, opts = {}) {
  const samples = (list, measure) => Object.fromEntries(['ndvi', 'ndmi'].map((key) => [
    key, list.map((c) => ({ drop: c[measure]?.[key] ?? null, damage: c.damage, group: c.spotId })),
  ]));
  const all = Object.fromEntries(MEASURES.map((m) => [m, calibrate(samples(checks, m), opts)]));
  const forestTypes = {};
  for (const type of FOREST_TYPES) {
    const list = checks.filter((c) => c.forestType === type);
    const per = Object.fromEntries(MEASURES.map((m) => [m, calibrate(samples(list, m), {
      ...opts, fallback: { ndvi: all[m].ndvi.threshold, ndmi: all[m].ndmi.threshold },
    })]));
    forestTypes[type] = { checks: list.length, spots: new Set(list.map((c) => c.spotId)).size, ...per.warning, photos: per.photos };
  }
  return { checks: checks.length, ...all.warning, photos: all.photos, forestTypes };
}

/**
 * The calibration that applies to an index at a spot of forest type `type`
 * for `measure` ('warning' or 'photos'): the forest type's own when it was
 * calibrated, else the one of all spots. { entry, scope: 'waldtyp' | 'alle', typeEntry }.
 */
function calibrationFor(cal, { measure = 'warning', type = null, key }) {
  const pick = (c) => (c ? (measure === 'photos' ? c.photos?.[key] : c[key]) : null);
  const overall = pick(cal);
  const typeEntry = type ? pick(cal.forestTypes?.[type]) : null;
  if (typeEntry?.source === 'kalibriert') return { entry: typeEntry, scope: 'waldtyp', typeEntry };
  return { entry: overall, scope: 'alle', typeEntry };
}

module.exports = { calibrate, calibrateAll, calibrationFor, FOREST_TYPES, crossValidate, chooseThreshold, sweep, maxDropBetween, GRID, MIN_POSITIVES, MIN_NEGATIVES, MIN_SPOTS };
