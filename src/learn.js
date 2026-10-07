'use strict';

/*
 * Learning the classification of changed regions from what users confirmed,
 * instead of relying on hand-written rules alone.
 *
 * Training examples are region feature vectors (computed by classify.js and
 * stored with every change result) with a class confirmed by a user:
 *  - explicit region labels: "stimmt" / "stattdessen …" on a region in the
 *    before/after comparison (weight 1), or a confirmed object detection
 *    that overlaps a region (weight 0.7);
 *  - observation tags: a photo tagged e.g. "Sturmschaden" confirms the
 *    regions of that photo that were suggested as "Windwurf" (weight 0.5).
 * The model is a small multinomial logistic regression (softmax, L2,
 * standardised features, class-balanced weights, batch gradient descent),
 * pure JS, persisted as JSON in the database. A class takes part only with
 * at least MIN_PER_CLASS examples and at least two classes are needed;
 * otherwise the rules decide alone. classify.js blends rules and model with
 * a weight that grows with the number of examples.
 */

const { CLASSES, reclassify } = require('./classify');

const MIN_PER_CLASS = 5;
const MODEL_NAME = 'regionen';
const CLASS_KEYS = Object.keys(CLASSES);
const TAG_TO_CLASS = Object.fromEntries(Object.entries(CLASSES).filter(([, c]) => c.tag).map(([k, c]) => [c.tag, k]));

const FEATURES = [
  ['greenDelta', (r) => r.features.greenDelta],
  ['greenBefore', (r) => r.features.greenBefore],
  ['brightDelta', (r) => r.features.brightDelta],
  ['logTexture', (r) => Math.log(Math.max(1e-3, r.features.textureRatio))],
  ['horizontalShift', (r) => r.features.horizontalShift],
  ['logElongation', (r) => Math.log(Math.max(1, r.features.elongation))],
  ['horizontal', (r) => Math.cos((r.features.angle * Math.PI) / 90)], // 1 = lying, −1 = upright
  ['needleBefore', (r) => r.foliage?.needleBefore ?? 0.5],
  ['vegDelta', (r) => (r.foliage?.vegAfter ?? 0) - (r.foliage?.vegBefore ?? 0)],
  ['logArea', (r) => Math.log((r.area || 0) + 1e-3)],
];

/** Feature vector of a region, or null for regions stored before features existed. */
function featureVector(region) {
  if (!region?.features) return null;
  const v = FEATURES.map(([, f]) => Number(f(region)));
  return v.every(Number.isFinite) ? v : null;
}

const softmax = (z) => {
  const m = Math.max(...z);
  const e = z.map((v) => Math.exp(v - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
};

/**
 * Trains a softmax regression on `examples` ({ x, label, weight }).
 * Returns the serialisable model or null when there is not enough data.
 */
function train(examples, { minPerClass = MIN_PER_CLASS, iterations = 600, rate = 0.5, l2 = 0.01 } = {}) {
  const counts = {};
  for (const e of examples) counts[e.label] = (counts[e.label] || 0) + 1;
  const classes = CLASS_KEYS.filter((k) => (counts[k] || 0) >= minPerClass);
  if (classes.length < 2) return null;
  const data = examples.filter((e) => classes.includes(e.label));
  const d = FEATURES.length;
  const mean = Array(d).fill(0);
  const std = Array(d).fill(0);
  for (const e of data) e.x.forEach((v, j) => { mean[j] += v / data.length; });
  for (const e of data) e.x.forEach((v, j) => { std[j] += (v - mean[j]) ** 2 / data.length; });
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j]) || 1;
  const X = data.map((e) => [...e.x.map((v, j) => (v - mean[j]) / std[j]), 1]);
  const Y = data.map((e) => classes.indexOf(e.label));
  // Class-balanced sample weights times the confidence of the example's source.
  const W8 = data.map((e) => (e.weight ?? 1) * (data.length / (classes.length * counts[e.label])));
  const wSum = W8.reduce((a, b) => a + b, 0);
  const K = classes.length;
  const W = Array.from({ length: K }, () => Array(d + 1).fill(0));
  for (let it = 0; it < iterations; it++) {
    const grad = Array.from({ length: K }, () => Array(d + 1).fill(0));
    for (let n = 0; n < X.length; n++) {
      const p = softmax(W.map((w) => w.reduce((s, wj, j) => s + wj * X[n][j], 0)));
      for (let k = 0; k < K; k++) {
        const g = (p[k] - (Y[n] === k ? 1 : 0)) * W8[n];
        for (let j = 0; j <= d; j++) grad[k][j] += g * X[n][j];
      }
    }
    for (let k = 0; k < K; k++) {
      for (let j = 0; j <= d; j++) W[k][j] -= rate * (grad[k][j] / wSum + (j < d ? l2 * W[k][j] : 0));
    }
  }
  const model = {
    type: 'softmax-regression',
    features: FEATURES.map(([name]) => name),
    classes,
    mean,
    std,
    weights: W.map((w) => w.map((v) => Math.round(v * 1e5) / 1e5)),
    counts,
    examples: data.length,
  };
  let correct = 0;
  for (const e of data) if (predictVector(model, e.x).label === e.label) correct++;
  model.trainAccuracy = Math.round((correct / data.length) * 100) / 100;
  return model;
}

function predictVector(model, x) {
  const z = [...x.map((v, j) => (v - model.mean[j]) / model.std[j]), 1];
  const p = softmax(model.weights.map((w) => w.reduce((s, wj, j) => s + wj * z[j], 0)));
  const probs = Object.fromEntries(model.classes.map((k, i) => [k, p[i]]));
  const best = p.indexOf(Math.max(...p));
  return { label: model.classes[best], probs };
}

/** k-fold cross-validated accuracy (honest estimate of how well the model generalises). */
function crossValidate(examples, k = 5, options = {}) {
  if (examples.length < 2 * k) return null;
  const order = examples.map((e, i) => [e, (i * 7919) % examples.length]).sort((a, b) => a[1] - b[1]).map(([e]) => e);
  let correct = 0; let total = 0;
  for (let f = 0; f < k; f++) {
    const test = order.filter((_, i) => i % k === f);
    const model = train(order.filter((_, i) => i % k !== f), { ...options, minPerClass: Math.max(2, (options.minPerClass ?? MIN_PER_CLASS) - 1) });
    if (!model) continue;
    for (const e of test) {
      if (!model.classes.includes(e.label)) continue;
      total++;
      if (predictVector(model, e.x).label === e.label) correct++;
    }
  }
  return total ? Math.round((correct / total) * 100) / 100 : null;
}

/** Blend weight of the model against the rules: grows with the examples, never all the way to 1. */
const blendWeight = (n) => Math.min(0.85, n / (n + 15));

/** Wraps a stored model as the `model` argument of classify.js. */
function asPredictor(model) {
  if (!model) return null;
  return {
    examples: model.examples,
    predict(region) {
      const x = featureVector(region);
      if (!x) return null;
      const { probs } = predictVector(model, x);
      return { probs, classes: model.classes, examples: model.examples, alpha: blendWeight(model.examples) };
    },
  };
}

/* ---------- Training data and background retraining ---------- */

const regionKey = (bbox) => (bbox || []).map((v) => Math.round(v * 1000)).join(',');

/**
 * The learner of one app instance. `background(promise)` tracks async work
 * (app.locals.idle), `onRelabel(photoId)` is called for every photo whose
 * stored change classification changed after retraining.
 */
function createLearner({ db, background = (p) => p, onRelabel = () => {} }) {
  const signature = () => {
    const rev = db.prepare('SELECT revision FROM learn_state WHERE id = 1').get()?.revision ?? 0;
    const c = db.prepare('SELECT COUNT(*) AS n, MAX(id) AS m FROM photos WHERE change_json IS NOT NULL').get();
    return `${rev}:${c.n}:${c.m ?? 0}`;
  };
  const stored = db.prepare('SELECT json FROM learned_models WHERE name = ?').get(MODEL_NAME);
  let model = stored ? JSON.parse(stored.json) : null;
  let predictor = asPredictor(model);
  let trainedSignature = model?.signature ?? null;
  let training = null;

  /** All confirmed examples: explicit region labels first, then tag confirmations. */
  function collectExamples() {
    const out = [];
    const explicit = new Set();
    for (const r of db.prepare('SELECT photo_id, base_id, region_key, class, source, region_json FROM region_labels').all()) {
      const x = featureVector(JSON.parse(r.region_json));
      explicit.add(`${r.photo_id}:${r.base_id}:${r.region_key}`);
      if (x && CLASS_KEYS.includes(r.class)) out.push({ x, label: r.class, weight: r.source === 'objekt' ? 0.7 : 1, source: r.source });
    }
    const tagsOf = db.prepare('SELECT tag FROM photo_tags WHERE photo_id = ?');
    for (const p of db.prepare('SELECT id, change_json FROM photos WHERE change_json IS NOT NULL').all()) {
      const tags = new Set(tagsOf.all(p.id).map((t) => t.tag));
      if (!tags.size) continue;
      const change = JSON.parse(p.change_json);
      for (const g of change.regions || []) {
        const tag = CLASSES[g.class]?.tag;
        if (!tag || !tags.has(tag) || g.area < 0.01) continue;
        if (explicit.has(`${p.id}:${change.base}:${regionKey(g.bbox)}`)) continue;
        const x = featureVector(g);
        if (x) out.push({ x, label: TAG_TO_CLASS[tag], weight: 0.5, source: 'tag' });
      }
    }
    return out;
  }

  /** Re-decides every stored change result with the current model. */
  function relabelAll() {
    const set = db.prepare('UPDATE photos SET change_json = ? WHERE id = ?');
    for (const p of db.prepare('SELECT id, change_json FROM photos WHERE change_json IS NOT NULL').all()) {
      const change = JSON.parse(p.change_json);
      if (!change.regions?.some((g) => g.ruleScores)) continue;
      const next = { ...change, ...reclassify(change.regions, predictor) };
      const json = JSON.stringify(next);
      if (json !== p.change_json) {
        set.run(json, p.id);
        onRelabel(p.id);
      }
    }
  }

  async function retrain() {
    await new Promise((r) => setImmediate(r));
    for (let round = 0; round < 3; round++) {
      const sig = signature();
      const examples = collectExamples();
      const next = train(examples);
      const hadModel = Boolean(model);
      if (next) {
        next.signature = sig;
        next.trainedAt = new Date().toISOString();
        next.sources = examples.reduce((acc, e) => ({ ...acc, [e.source]: (acc[e.source] || 0) + 1 }), {});
        next.cvAccuracy = crossValidate(examples.filter((e) => next.classes.includes(e.label)));
        next.version = (model?.version || 0) + 1;
        db.prepare(`INSERT INTO learned_models (name, json, trained_at) VALUES (?, ?, ?)
          ON CONFLICT (name) DO UPDATE SET json = excluded.json, trained_at = excluded.trained_at`)
          .run(MODEL_NAME, JSON.stringify(next), Date.now());
        model = next;
      } else {
        db.prepare('DELETE FROM learned_models WHERE name = ?').run(MODEL_NAME);
        model = null;
      }
      predictor = asPredictor(model);
      trainedSignature = sig;
      if (next || hadModel) relabelAll();
      if (signature() === sig) break;
    }
  }

  /** Starts a background retrain unless one is running; returns its promise. */
  function schedule() {
    if (!training) {
      training = retrain().finally(() => { training = null; });
      background(training);
    }
    return training;
  }

  return {
    /** Predictor for classify.js (or null); schedules a retrain when confirmations changed. */
    current() {
      if (!training && signature() !== trainedSignature) schedule();
      return predictor;
    },
    /** Changes whenever the model does (for caches of classified results). */
    version: () => (model ? `m${model.version}` : 'regel'),
    schedule,
    examples: collectExamples,
    status() {
      const examples = collectExamples();
      const counts = {};
      for (const e of examples) counts[e.label] = (counts[e.label] || 0) + 1;
      return {
        active: Boolean(model),
        minPerClass: MIN_PER_CLASS,
        examples: examples.length,
        counts,
        classes: CLASS_KEYS.map((k) => ({
          class: k, label: CLASSES[k].label, examples: counts[k] || 0, learned: Boolean(model?.classes.includes(k)),
        })),
        model: model ? {
          version: model.version,
          trainedAt: model.trainedAt,
          examples: model.examples,
          classes: model.classes,
          trainAccuracy: model.trainAccuracy,
          cvAccuracy: model.cvAccuracy,
          blendWeight: Math.round(blendWeight(model.examples) * 100) / 100,
          sources: model.sources,
        } : null,
        training: Boolean(training),
      };
    },
  };
}

module.exports = {
  createLearner, train, predictVector, crossValidate, featureVector, asPredictor, blendWeight, regionKey,
  FEATURES, MIN_PER_CLASS, TAG_TO_CLASS,
};
