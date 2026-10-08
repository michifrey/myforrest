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
 * The numbers are measured on the same checks the threshold was chosen on,
 * so they are optimistic, the more so the fewer checks there are.
 */

const { anomalyScores, THRESHOLDS } = require('./sentinel');

const GRID = Array.from({ length: 28 }, (_, i) => Math.round((0.03 + i * 0.01) * 100) / 100); // 0.03 … 0.30
const MIN_POSITIVES = 5;
const MIN_NEGATIVES = 5;
const DAY = 86400000;

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
    let tp = 0; let fp = 0; let fn = 0; let tn = 0;
    for (const s of samples) {
      const alert = s.drop !== null && s.drop >= threshold;
      if (s.damage) { if (alert) tp++; else fn++; } else if (alert) fp++; else tn++;
    }
    const recall = tp + fn ? tp / (tp + fn) : 0;
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    const r3 = (v) => Math.round(v * 1000) / 1000;
    return { threshold, tp, fp, fn, tn, recall: r3(recall), precision: r3(precision), f1: r3(f1) };
  });
}

/**
 * Thresholds per index from samples { ndvi: [{ drop, damage }], ndmi: [...] }.
 * The best F1 wins (on ties the higher threshold: fewer false alarms); the
 * "strong" threshold keeps the ratio of the starting values. Without
 * MIN_POSITIVES damaged and MIN_NEGATIVES undamaged checks the starting value
 * stays (source 'standard').
 */
function calibrate(samplesByIndex, { minPositives = MIN_POSITIVES, minNegatives = MIN_NEGATIVES } = {}) {
  const out = {};
  for (const key of ['ndvi', 'ndmi']) {
    const samples = (samplesByIndex[key] || []).filter((s) => s.drop !== null);
    const positives = samples.filter((s) => s.damage).length;
    const negatives = samples.length - positives;
    const [defThreshold, defStrong] = THRESHOLDS[key];
    const rows = sweep(samples);
    const enough = positives >= minPositives && negatives >= minNegatives;
    const best = enough
      ? rows.reduce((b, r) => (r.f1 > b.f1 || (r.f1 === b.f1 && r.threshold > b.threshold) ? r : b))
      : rows.find((r) => r.threshold === defThreshold) || null;
    const calibrated = enough && best.f1 > 0;
    const threshold = calibrated ? best.threshold : defThreshold;
    out[key] = {
      index: key,
      source: calibrated ? 'kalibriert' : 'standard',
      threshold,
      strong: Math.round(threshold * (defStrong / defThreshold) * 100) / 100,
      positives,
      negatives,
      // Hits and false alarms at the threshold in use, on these checks.
      at: rows.find((r) => r.threshold === threshold) || null,
      sweep: rows,
    };
  }
  return out;
}

module.exports = { calibrate, sweep, maxDropBetween, GRID, MIN_POSITIVES, MIN_NEGATIVES };
