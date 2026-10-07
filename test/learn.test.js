'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const { createApp } = require('../src/app');
const { train, predictVector, asPredictor, featureVector, MIN_PER_CLASS } = require('../src/learn');
const { reclassify } = require('../src/classify');
const { analyzeFoliage, attributeRegion } = require('../src/foliage');
const { detectHeuristic, detectObjects, normaliseLabel } = require('../src/detect');
const { assess } = require('../src/irregularities');
const { TREES } = require('../src/trees');

const tree = (de) => TREES.find((t) => t.de === de);
const fixture = (name) => path.join(__dirname, 'fixtures', name);

/* ---------- Synthetic images ---------- */

function rng(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

async function synth(w, h, fn) {
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = fn(x, y);
      for (let k = 0; k < 3; k++) buf[(y * w + x) * 3 + k] = Math.max(0, Math.min(255, Math.round(c[k])));
    }
  }
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}

const W = 480;
const H = 360;
function forestFloor(seed) {
  const rnd = rng(seed);
  const noise = Float32Array.from({ length: W * H }, () => (rnd() - 0.5) * 60);
  return (x, y) => { const n = noise[y * W + x]; return [55 + n * 0.6, 105 + n, 45 + n * 0.5]; };
}

/** A barked stem lying across the floor (tilted by `tilt`°), or standing upright. */
function stemImage({ upright = false, tilt = 6, seed = 7 } = {}) {
  const bg = forestFloor(seed);
  const rnd = rng(seed + 1);
  const tan = Math.tan((tilt * Math.PI) / 180);
  return synth(W, H, (x, y) => {
    const inside = upright
      ? Math.abs(x - 240) < 16 && y > 30 && y < 340
      : x > 60 && x < 420 && Math.abs(y - (200 + (x - 240) * tan)) < 14;
    if (!inside) return bg(x, y);
    const n = (rnd() - 0.5) * 40 + 12 * Math.sin(y * 1.7);
    return [150 + n, 128 + n, 105 + n];
  });
}

/** Stacked logs: rows of light cut faces with darker bark rims. */
function pileImage() {
  const bg = forestFloor(3);
  const rnd = rng(5);
  return synth(W, H, (x, y) => {
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 7; c++) {
        const d = Math.hypot(x - (120 + c * 36 + (r % 2) * 18), y - (140 + r * 32));
        if (d < 14) return d > 12 ? [120, 85, 50] : [215, 175, 120 + (rnd() - 0.5) * 20];
      }
    }
    return y > 115 && y < 260 && x > 95 && x < 390 ? [60, 45, 30] : bg(x, y);
  });
}

/** Needle foliage: dark, bluish green, fine grain. Broadleaf: light yellow-green, coarse blobs. */
function needleImage() {
  const rnd = rng(11);
  return synth(320, 240, () => { const n = (rnd() - 0.5) * 50; return [30 + n * 0.6, 72 + n, 62 + n * 0.8]; });
}
function broadleafImage() {
  const rnd = rng(13);
  const field = new Float32Array(320 * 240);
  for (let k = 0; k < 300; k++) {
    const bx = rnd() * 320; const by = rnd() * 240; const r = 4 + rnd() * 8; const v = (rnd() - 0.5) * 60;
    for (let y = Math.max(0, Math.floor(by - r)); y < Math.min(240, by + r); y++) {
      for (let x = Math.max(0, Math.floor(bx - r)); x < Math.min(320, bx + r); x++) {
        if ((x - bx) ** 2 + (y - by) ** 2 < r * r) field[y * 320 + x] += v;
      }
    }
  }
  return synth(320, 240, (x, y) => { const n = field[y * 320 + x]; return [110 + n * 0.7, 160 + n, 55 + n * 0.4]; });
}

/* ---------- Synthetic region features ---------- */

/** Region with the feature layout of classify.js; `kind` picks a typical cluster with some jitter. */
function region(kind, rnd) {
  const j = (s) => (rnd() - 0.5) * s;
  const base = {
    windwurf: { greenDelta: -0.02, greenBefore: 0.08, brightDelta: 0.02, textureRatio: 1.4, horizontalShift: 0.2, elongation: 4, angle: 5 },
    verfaerbung: { greenDelta: -0.15, greenBefore: 0.12, brightDelta: 0.03, textureRatio: 0.95, horizontalShift: 0, elongation: 1.3, angle: 60 },
    bewuchs: { greenDelta: 0.14, greenBefore: 0.02, brightDelta: -0.02, textureRatio: 1.3, horizontalShift: -0.02, elongation: 1.5, angle: 80 },
  }[kind];
  const features = {
    greenDelta: base.greenDelta + j(0.04),
    greenBefore: base.greenBefore + j(0.03),
    brightDelta: base.brightDelta + j(0.03),
    textureRatio: base.textureRatio + j(0.2),
    horizontalShift: base.horizontalShift + j(0.06),
    elongation: base.elongation + j(0.6),
    angle: base.angle + j(20),
  };
  // Deliberately weak rule scores: the rules would call all of these "sonstiges".
  return {
    area: 0.03 + rnd() * 0.05,
    bbox: [0.1, 0.1, 0.4, 0.3],
    ruleScores: { windwurf: 0.2, auflichtung: 0.1, verfaerbung: 0.2, bewuchs: 0.2 },
    features,
    foliage: { needleBefore: 0.3, needleAfter: 0.3, vegBefore: 0.8, vegAfter: 0.8 },
  };
}

/* ---------- Learning ---------- */

test('softmax regression learns region classes from confirmed examples', () => {
  const rnd = rng(42);
  const kinds = ['windwurf', 'verfaerbung', 'bewuchs'];
  const examples = [];
  for (let i = 0; i < 30; i++) {
    const kind = kinds[i % 3];
    examples.push({ x: featureVector(region(kind, rnd)), label: kind, weight: 1 });
  }
  const model = train(examples);
  assert.deepEqual(model.classes, ['windwurf', 'verfaerbung', 'bewuchs']);
  assert.equal(model.examples, 30);
  assert.ok(model.trainAccuracy >= 0.9, `train accuracy ${model.trainAccuracy}`);
  let correct = 0;
  for (let i = 0; i < 30; i++) {
    const kind = kinds[i % 3];
    if (predictVector(model, featureVector(region(kind, rnd))).label === kind) correct++;
  }
  assert.ok(correct >= 27, `held-out ${correct}/30`);

  // Too few examples per class: no model, the rules decide alone.
  const few = examples.filter((e) => e.label !== 'bewuchs').slice(0, 2 * (MIN_PER_CLASS - 1));
  assert.equal(few.filter((e) => e.label === 'windwurf').length, MIN_PER_CLASS - 1);
  assert.equal(train(few), null);
});

test('learned model and rules are blended, and the deciding source is recorded', () => {
  const rnd = rng(7);
  const kinds = ['windwurf', 'verfaerbung', 'bewuchs'];
  const model = train(Array.from({ length: 42 }, (_, i) => ({ x: featureVector(region(kinds[i % 3], rnd)), label: kinds[i % 3] })));
  const predictor = asPredictor(model);
  const lying = region('windwurf', rnd);

  const byRules = reclassify([lying]).regions[0];
  assert.equal(byRules.class, 'sonstiges');
  assert.equal(byRules.decidedBy, 'regel');
  assert.equal(byRules.learned, null);

  const blended = reclassify([lying], predictor).regions[0];
  assert.equal(blended.class, 'windwurf');
  assert.equal(blended.decidedBy, 'gelernt');
  assert.equal(blended.ruleClass, 'sonstiges');
  assert.equal(blended.learned.examples, 42);
  assert.ok(blended.confidence > 0.4 && blended.confidence <= 1);

  // Strong rule evidence for a class the model does not know stays with the rules.
  const cleared = { ...region('bewuchs', rnd), ruleScores: { windwurf: 0, auflichtung: 0.95, verfaerbung: 0, bewuchs: 0 } };
  assert.equal(reclassify([cleared], predictor).regions[0].class, 'auflichtung');
  // Regions stored before features existed are left alone.
  const old = { class: 'windwurf', label: 'x', area: 0.1, bbox: [0, 0, 1, 1] };
  assert.equal(reclassify([old], predictor).regions[0], old);
});

/* ---------- Conifer / broadleaf ---------- */

test('needle foliage reads as conifer, light coarse foliage as broadleaf (heuristic)', async () => {
  const needle = await analyzeFoliage(await needleImage());
  const broad = await analyzeFoliage(await broadleafImage());
  assert.ok(needle.needleShare > 0.7, `needle ${needle.needleShare}`);
  assert.ok(broad.needleShare < 0.3, `broadleaf ${broad.needleShare}`);
  assert.equal(needle.grid.length, needle.cols * needle.rows);
  assert.equal(needle.method, 'heuristik');
  assert.ok(Math.abs(needle.needleShare + needle.broadleafShare - 1) < 0.011);
});

test('discolouration is attributed to the most plausible species of the spot', () => {
  const species = [tree('Fichte'), tree('Rotbuche')];
  const aug = Date.UTC(2026, 7, 20);
  assert.equal(attributeRegion({ needleShare: 0.2, species, takenAt: aug }).name, 'Rotbuche');
  assert.equal(attributeRegion({ needleShare: 0.85, species, takenAt: aug }).name, 'Fichte');
  // Without an inventory only the group is named; an undecided share gives nothing.
  assert.equal(attributeRegion({ needleShare: 0.15, species: [], takenAt: aug }).name, 'Laubholz');
  assert.equal(attributeRegion({ needleShare: 0.5, species: [], takenAt: aug }), null);
  assert.equal(attributeRegion({ needleShare: null, species, takenAt: aug }), null);
});

test('species attribution sharpens the needle and early-colouring irregularities', () => {
  const change = (needleBefore) => ({
    summary: [{ class: 'verfaerbung', area: 0.12 }],
    regions: [{ class: 'verfaerbung', area: 0.12, foliage: { needleBefore } }],
  });
  // Mixed stand, conifer-like region: the hint becomes a warning about the spruce.
  const mixed = [tree('Fichte'), tree('Rotbuche')];
  const conifer = assess({ takenAt: Date.UTC(2026, 6, 20), change: change(0.85), species: mixed });
  const needle = conifer.find((i) => i.type === 'nadelverfaerbung');
  assert.equal(needle.severity, 'stark');
  assert.match(needle.title, /Fichte/);
  assert.match(needle.text, /Nadelholzanteil ≈ 85 %/);
  assert.ok(!conifer.some((i) => i.type === 'fruehe_verfaerbung'), 'needles are no early leaf colouring');
  // Without foliage data the old, cautious rule applies.
  const plain = assess({ takenAt: Date.UTC(2026, 6, 20), change: { summary: change(0).summary }, species: mixed });
  assert.equal(plain.find((i) => i.type === 'nadelverfaerbung').severity, 'hinweis');

  // Larch colours ~12 Oct; birch already mid-September. Colouring needle-like foliage on 1 Oct is early larch colouring.
  const stand = [tree('Hängebirke'), tree('Fichte'), tree('Europäische Lärche')];
  const oct1 = Date.UTC(2026, 9, 1);
  const larch = assess({ takenAt: oct1, change: change(0.85), species: stand }).find((i) => i.type === 'fruehe_verfaerbung');
  assert.ok(larch, 'early larch colouring');
  assert.match(larch.text, /Europäische Lärche/);
  assert.equal(larch.attribution.name, 'Europäische Lärche');
  // The same date with broadleaf-like foliage is the birch's normal autumn.
  assert.ok(!assess({ takenAt: oct1, change: change(0.1), species: stand }).some((i) => i.type === 'fruehe_verfaerbung'));
});

/* ---------- Object detection ---------- */

test('heuristics find a lying stem and a log pile, not an upright trunk', async () => {
  const lying = await detectHeuristic(await stemImage());
  const stem = lying.find((d) => d.label === 'liegender_stamm');
  assert.ok(stem, JSON.stringify(lying));
  assert.equal(stem.source, 'heuristik');
  // The stem spans x 60–420 of 480 around y = 200 of 360.
  assert.ok(stem.box[0] < 0.2 && stem.box[2] > 0.8, `box ${stem.box}`);
  assert.ok(stem.box[1] < 0.55 && stem.box[3] > 0.55, `box ${stem.box}`);

  assert.ok(!(await detectHeuristic(await stemImage({ upright: true }))).some((d) => d.label === 'liegender_stamm'));
  assert.deepEqual(await detectHeuristic(await synth(W, H, forestFloor(9))), []);

  const pile = (await detectHeuristic(await pileImage())).find((d) => d.label === 'holzpolter');
  assert.ok(pile && pile.info.crossSections >= 20, JSON.stringify(pile));
  // The fallen trunk drawn into the alignment fixture is found too.
  assert.ok((await detectHeuristic(fixture('align-b.jpg'))).some((d) => d.label === 'liegender_stamm'));
});

test('external detector: contract, pixel boxes, synonyms and fallback', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, type: opts.headers['Content-Type'], bytes: opts.body.length });
    return new Response(JSON.stringify({
      model: 'mock-yolo',
      detections: [
        { label: 'fallen_tree', score: 0.91, box: [60, 180, 540, 300] }, // pixels of the 600×450 fixture
        { label: 'wurzelteller', score: 0.7, box: [0.5, 0.5, 0.6, 0.7] },
        { label: 'kaputt', score: 0.5, box: [0.5, 0.5] },
      ],
    }));
  };
  const r = await detectObjects(fixture('align-b.jpg'), { url: 'http://detector.test/detect', fetchImpl });
  assert.equal(r.detector, 'extern');
  assert.equal(calls[0].url, 'http://detector.test/detect');
  assert.equal(calls[0].type, 'image/jpeg');
  assert.ok(calls[0].bytes > 1000);
  assert.deepEqual(r.detections.map((d) => d.label), ['liegender_stamm', 'wurzelteller']);
  assert.deepEqual(r.detections[0].box, [0.1, 0.4, 0.9, 0.667]);
  assert.equal(r.detections[0].info.model, 'mock-yolo');

  const down = await detectObjects(fixture('align-b.jpg'), { url: 'http://x', fetchImpl: async () => new Response('', { status: 503 }) });
  assert.equal(down.detector, 'heuristik');
  assert.match(down.error, /503/);
  assert.equal(normaliseLabel('Log pile'), 'holzpolter');
});

/* ---------- API ---------- */

const noWeather = async () => new Response('offline', { status: 503 });

async function withServer(opts, fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-learn-'));
  const app = createApp({ dataDir, weatherFetch: noWeather, ...opts });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, app);
  } finally {
    await app.locals.idle();
    server.close();
    app.locals.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

const upload = (base, name, buf, fields) => {
  const fd = new FormData();
  fd.append('photos', new Blob([buf], { type: 'image/jpeg' }), name);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fetch(`${base}/api/photos`, { method: 'POST', body: fd }).then((r) => r.json()).then((j) => j.created[0]);
};
const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('confirmed regions and tags train the model, which then decides with its source shown', async () => {
  await withServer({}, async (base, app) => {
    const a = await upload(base, 'a.jpg', fs.readFileSync(fixture('canopy-a.jpg')), { lat: '47.36', lon: '8.58', takenAt: '2026-05-20T09:00:00Z' });
    const b = await upload(base, 'b.jpg', fs.readFileSync(fixture('canopy-b.jpg')),
      { spotId: String(a.spotId), refPhotoId: String(a.id), takenAt: '2026-08-12T09:00:00Z' });
    await fetch(`${base}/api/spots/${a.spotId}/species`, json('POST', { scientificName: 'Fagus sylvatica' }));

    let regions = await (await fetch(`${base}/api/photos/${a.id}/regions?to=${b.id}`)).json();
    assert.ok(regions.regions.length >= 2);
    assert.ok(regions.regions.every((g) => g.decidedBy === 'regel'));
    assert.equal(regions.learning.active, false);
    const coloured = regions.regions.find((g) => g.class === 'verfaerbung');
    assert.ok(coloured.foliage.needleBefore !== null);
    assert.equal(coloured.attribution.name, 'Rotbuche');

    // A user confirms one region; the label is returned with the region.
    let res = await fetch(`${base}/api/photos/${a.id}/region-labels`, json('POST', { to: b.id, index: coloured.index, class: 'verfaerbung' }));
    assert.equal(res.status, 200);
    assert.equal((await fetch(`${base}/api/photos/${a.id}/region-labels`, json('POST', { to: b.id, index: 0, class: 'quatsch' }))).status, 400);
    assert.equal((await fetch(`${base}/api/photos/${a.id}/region-labels`, json('POST', { to: b.id, index: 99, class: 'bewuchs' }))).status, 404);
    regions = await (await fetch(`${base}/api/photos/${a.id}/regions?to=${b.id}`)).json();
    assert.equal(regions.regions.find((g) => g.index === coloured.index).userLabel.class, 'verfaerbung');

    // Tagging the photo confirms the matching suggestion as well.
    await fetch(`${base}/api/photos/${b.id}`, json('PATCH', { tags: ['holzschlag'] }));
    await app.locals.idle();
    let status = await (await fetch(`${base}/api/analysis/status`)).json();
    assert.equal(status.learning.examples, 2);
    assert.equal(status.learning.active, false);

    // More confirmed examples from other spots (inserted directly) make the model active.
    const rnd = rng(3);
    const ins = app.locals.db.prepare(`INSERT INTO region_labels (photo_id, base_id, region_key, class, source, region_json, created_at)
      VALUES (?, ?, ?, ?, 'nutzer', ?, 0)`);
    for (let i = 0; i < 24; i++) {
      const kind = ['windwurf', 'verfaerbung', 'bewuchs'][i % 3];
      ins.run(b.id, a.id, `synthetic-${i}`, kind, JSON.stringify(region(kind, rnd)));
    }
    status = await (await fetch(`${base}/api/analysis/retrain`, { method: 'POST' })).json();
    assert.equal(status.active, true);
    assert.equal(status.examples, 26);
    assert.equal(status.model.examples, 25); // the single 'auflichtung' example is below the minimum
    assert.ok(status.model.classes.includes('verfaerbung'));
    await app.locals.idle();

    regions = await (await fetch(`${base}/api/photos/${a.id}/regions?to=${b.id}`)).json();
    assert.equal(regions.learning.examples, 26);
    assert.ok(regions.regions.some((g) => g.learned && g.learned.examples === 25));
    // Stored results were re-decided with the model too.
    const spot = await (await fetch(`${base}/api/spots/${a.spotId}`)).json();
    assert.ok(spot.photos[1].change.regions.some((g) => g.learned));
  });
});

test('detections are stored per photo and can be confirmed or rejected', async () => {
  await withServer({}, async (base) => {
    const p = await upload(base, 'stem.jpg', await stemImage(), { lat: '47.1', lon: '8.1' });
    let res = await fetch(`${base}/api/photos/${p.id}/detections`);
    assert.equal(res.status, 200);
    let body = await res.json();
    assert.equal(body.detector, 'heuristik');
    assert.equal(body.experimental, true);
    const stem = body.detections.find((d) => d.label === 'liegender_stamm');
    assert.ok(stem, JSON.stringify(body));
    assert.equal(stem.status, 'offen');
    assert.equal(stem.suggestedTag, 'sturmschaden');

    res = await fetch(`${base}/api/detections/${stem.id}`, json('PATCH', { status: 'bestaetigt' }));
    assert.equal((await res.json()).status, 'bestaetigt');
    assert.equal((await fetch(`${base}/api/detections/${stem.id}`, json('PATCH', { status: 'vielleicht' }))).status, 400);

    // Re-running keeps the confirmed detection and does not duplicate it.
    body = await (await fetch(`${base}/api/photos/${p.id}/detections`, { method: 'POST' })).json();
    assert.equal(body.detections.filter((d) => d.label === 'liegender_stamm').length, 1);
    assert.equal(body.detections.find((d) => d.label === 'liegender_stamm').status, 'bestaetigt');

    const status = await (await fetch(`${base}/api/analysis/status`)).json();
    assert.equal(status.detector.stats.find((s) => s.label === 'liegender_stamm').bestaetigt, 1);

    const foliage = await (await fetch(`${base}/api/photos/${p.id}/foliage`)).json();
    assert.equal(foliage.grid.length, 12);
    assert.equal((await fetch(`${base}/api/photos/99999/detections`)).status, 404);
  });

  // With DETECTOR_URL the external service answers.
  const detectorFetch = async () => new Response(JSON.stringify([{ label: 'holzpolter', score: 0.8, box: [0.1, 0.1, 0.3, 0.3] }]));
  await withServer({ detectorUrl: 'http://detector.test', detectorFetch }, async (base) => {
    const p = await upload(base, 'stem.jpg', await stemImage(), { lat: '47.1', lon: '8.1' });
    const body = await (await fetch(`${base}/api/photos/${p.id}/detections`)).json();
    assert.equal(body.detector, 'extern');
    assert.deepEqual(body.detections.map((d) => [d.label, d.source]), [['holzpolter', 'extern']]);
  });
});
