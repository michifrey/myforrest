'use strict';

/*
 * Automatic evaluation (roadmap phase 3): learned region classification,
 * conifer/broadleaf share and species attribution, object detection.
 * Registered from app.js as `require('./routes/analysis')(app, ctx)`.
 */

const path = require('node:path');
const { createLearner, regionKey } = require('../learn');
const { CLASSES } = require('../classify');
const { analyzeFoliage, attributeRegion } = require('../foliage');
const { detectObjects, LABELS, DETECTION_CLASS, DETECTION_TAG, iou } = require('../detect');
const { multiply, invert, apply } = require('../homography');

const STATUSES = ['offen', 'bestaetigt', 'abgelehnt'];
const HEURISTIC_LABELS = ['liegender_stamm', 'holzpolter'];

module.exports = function registerAnalysis(app, ctx) {
  const {
    db, uploadDir, getPhoto, idParam, background, changeBetween, spotTrees, terrainOf, refreshIrregularities,
    detectorUrl = null, detectorFetch = fetch,
  } = ctx;

  const learner = createLearner({ db, background, onRelabel: (photoId) => refreshIrregularities(photoId) });
  app.locals.learner = learner;

  const labelRow = db.prepare('SELECT class, source FROM region_labels WHERE photo_id = ? AND base_id = ? AND region_key = ?');

  /* ---------- Learned classification ---------- */

  const detectionStats = () => {
    const rows = db.prepare('SELECT label, source, status, COUNT(*) AS n FROM detections GROUP BY label, source, status').all();
    const out = {};
    for (const r of rows) {
      const e = (out[r.label] ||= { label: r.label, text: LABELS[r.label] || r.label, offen: 0, bestaetigt: 0, abgelehnt: 0 });
      e[r.status] += r.n;
    }
    return Object.values(out).map((e) => ({
      ...e,
      precision: e.bestaetigt + e.abgelehnt ? Math.round((e.bestaetigt / (e.bestaetigt + e.abgelehnt)) * 100) / 100 : null,
    }));
  };

  app.get('/api/analysis/status', (req, res) => {
    learner.current(); // schedules a retrain if confirmations changed
    res.json({
      learning: learner.status(),
      detector: {
        external: Boolean(detectorUrl),
        heuristics: HEURISTIC_LABELS,
        labels: LABELS,
        experimental: true,
        stats: detectionStats(),
      },
    });
  });

  app.post('/api/analysis/retrain', async (req, res, next) => {
    try {
      await learner.schedule();
      res.json(learner.status());
    } catch (err) {
      next(err);
    }
  });

  /** Change regions between two photos with the deciding source, species attribution and user labels. */
  app.get('/api/photos/:id/regions', async (req, res, next) => {
    const id = idParam(req, res);
    if (id === null) return;
    const to = Number(req.query.to);
    if (!Number.isSafeInteger(to) || to <= 0) return res.status(400).json({ error: 'Parameter "to" fehlt' });
    const c = changeBetween(id, to);
    if (c.error) return res.status(c.status).json({ error: c.error });
    try {
      const r = await c.job;
      const later = getPhoto.get(to);
      const species = spotTrees(later.spot_id);
      const terrain = terrainOf(later.spot_id);
      const status = learner.status();
      res.json({
        from: id,
        to,
        learning: { active: status.active, examples: status.examples, model: status.model },
        regions: r.regions.map((g, index) => {
          const label = labelRow.get(to, id, regionKey(g.bbox));
          return {
            index,
            class: g.class,
            label: g.label,
            confidence: g.confidence,
            area: g.area,
            bbox: g.bbox,
            ruleClass: g.ruleClass,
            decidedBy: g.decidedBy || 'regel',
            learned: g.learned || null,
            foliage: g.foliage || null,
            attribution: g.class === 'verfaerbung' && g.foliage
              ? attributeRegion({ needleShare: g.foliage.needleBefore, species, takenAt: later.taken_at, terrain })
              : null,
            userLabel: label ? { class: label.class, label: CLASSES[label.class]?.label, source: label.source } : null,
          };
        }),
      });
    } catch (err) {
      next(err);
    }
  });

  const upsertLabel = db.prepare(`
    INSERT INTO region_labels (photo_id, base_id, region_key, class, source, region_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (photo_id, base_id, region_key)
    DO UPDATE SET class = excluded.class, source = excluded.source, region_json = excluded.region_json, created_at = excluded.created_at
  `);

  /**
   * Confirms or corrects the class of a region: `{ to, index, class }`
   * (`class: null` removes the label). Features are taken from the server's
   * own analysis, never from the request.
   */
  app.post('/api/photos/:id/region-labels', async (req, res, next) => {
    const id = idParam(req, res);
    if (id === null) return;
    const { to, index } = req.body || {};
    const cls = req.body?.class ?? null;
    if (!Number.isSafeInteger(to) || !Number.isSafeInteger(index) || index < 0) {
      return res.status(400).json({ error: '"to" und "index" angeben' });
    }
    if (cls !== null && !Object.hasOwn(CLASSES, cls)) return res.status(400).json({ error: 'Unbekannte Klasse' });
    const c = changeBetween(id, to);
    if (c.error) return res.status(c.status).json({ error: c.error });
    try {
      const r = await c.job;
      const g = r.regions[index];
      if (!g) return res.status(404).json({ error: 'Region nicht gefunden' });
      const key = regionKey(g.bbox);
      if (cls === null) {
        db.prepare('DELETE FROM region_labels WHERE photo_id = ? AND base_id = ? AND region_key = ?').run(to, id, key);
      } else {
        const { area, bbox, ruleScores, features, foliage } = g;
        upsertLabel.run(to, id, key, cls, 'nutzer', JSON.stringify({ area, bbox, ruleScores, features, foliage }), Date.now());
      }
      learner.schedule();
      res.json({ index, userLabel: cls ? { class: cls, label: CLASSES[cls].label, source: 'nutzer' } : null, learning: learner.status() });
    } catch (err) {
      next(err);
    }
  });

  /* ---------- Conifer / broadleaf share ---------- */

  const analysisRow = db.prepare('SELECT * FROM photo_analysis WHERE photo_id = ?');
  const ensureAnalysisRow = db.prepare('INSERT OR IGNORE INTO photo_analysis (photo_id) VALUES (?)');
  const foliageJobs = new Map();

  app.get('/api/photos/:id/foliage', async (req, res, next) => {
    const id = idParam(req, res);
    if (id === null) return;
    const photo = getPhoto.get(id);
    if (!photo) return res.status(404).json({ error: 'Foto nicht gefunden' });
    try {
      const stored = analysisRow.get(id);
      if (stored?.foliage_json) return res.json(JSON.parse(stored.foliage_json));
      if (!foliageJobs.has(id)) {
        foliageJobs.set(id, analyzeFoliage(path.join(uploadDir, photo.file)).finally(() => foliageJobs.delete(id)));
      }
      const result = await foliageJobs.get(id);
      if (getPhoto.get(id)) {
        ensureAnalysisRow.run(id);
        db.prepare('UPDATE photo_analysis SET foliage_json = ? WHERE photo_id = ?').run(JSON.stringify(result), id);
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  /* ---------- Object detection ---------- */

  const detectionJson = (d) => ({
    id: d.id,
    photoId: d.photo_id,
    label: d.label,
    text: LABELS[d.label] || d.label,
    score: d.score,
    box: [d.x0, d.y0, d.x1, d.y1],
    source: d.source,
    status: d.status,
    info: d.info_json ? JSON.parse(d.info_json) : null,
    suggestedTag: DETECTION_TAG[d.label] || null,
  });
  const detectionsOf = db.prepare('SELECT * FROM detections WHERE photo_id = ? ORDER BY score DESC, id');
  const insertDetection = db.prepare(`
    INSERT INTO detections (photo_id, label, score, x0, y0, x1, y1, source, info_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const detectJobs = new Map();

  /** Runs the detector on a photo; keeps detections users already confirmed or rejected. */
  function runDetection(photo) {
    if (detectJobs.has(photo.id)) return detectJobs.get(photo.id);
    const job = (async () => {
      const result = await detectObjects(path.join(uploadDir, photo.file), { url: detectorUrl, fetchImpl: detectorFetch });
      if (!getPhoto.get(photo.id)) return result;
      const kept = db.prepare("SELECT * FROM detections WHERE photo_id = ? AND status != 'offen'").all(photo.id);
      db.prepare("DELETE FROM detections WHERE photo_id = ? AND status = 'offen'").run(photo.id);
      for (const d of result.detections) {
        if (kept.some((k) => k.label === d.label && iou([k.x0, k.y0, k.x1, k.y1], d.box) > 0.5)) continue;
        insertDetection.run(photo.id, d.label, d.score, ...d.box, d.source, d.info ? JSON.stringify(d.info) : null, Date.now());
      }
      ensureAnalysisRow.run(photo.id);
      db.prepare('UPDATE photo_analysis SET detected_at = ?, detector = ? WHERE photo_id = ?').run(Date.now(), result.detector, photo.id);
      return result;
    })().finally(() => detectJobs.delete(photo.id));
    detectJobs.set(photo.id, job);
    return job;
  }

  const detectionResponse = (photoId, extra = {}) => {
    const a = analysisRow.get(photoId);
    return {
      photoId,
      detector: a?.detector || null,
      detectedAt: a?.detected_at ? new Date(a.detected_at).toISOString() : null,
      experimental: true,
      detections: detectionsOf.all(photoId).map(detectionJson),
      ...extra,
    };
  };

  app.get('/api/photos/:id/detections', async (req, res, next) => {
    const id = idParam(req, res);
    if (id === null) return;
    const photo = getPhoto.get(id);
    if (!photo) return res.status(404).json({ error: 'Foto nicht gefunden' });
    try {
      let extra = {};
      if (!analysisRow.get(id)?.detected_at) {
        const r = await runDetection(photo);
        if (r.error) extra = { warning: `Externer Detektor nicht erreichbar (${r.error}) – Heuristik verwendet` };
      }
      res.json(detectionResponse(id, extra));
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/photos/:id/detections', async (req, res, next) => {
    const id = idParam(req, res);
    if (id === null) return;
    const photo = getPhoto.get(id);
    if (!photo) return res.status(404).json({ error: 'Foto nicht gefunden' });
    try {
      const r = await runDetection(photo);
      res.json(detectionResponse(id, r.error ? { warning: `Externer Detektor nicht erreichbar (${r.error}) – Heuristik verwendet` } : {}));
    } catch (err) {
      next(err);
    }
  });

  /** Region bbox (in the base photo's view) mapped into the later photo's own view. */
  function regionInPhoto(bbox, base, photo) {
    if (!base?.align_h || !photo?.align_h) return null;
    const inv = invert(JSON.parse(photo.align_h));
    if (!inv) return null;
    const h = multiply(inv, JSON.parse(base.align_h));
    const pts = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[3]]].map(([x, y]) => apply(h, x, y));
    return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
  }
  const overlap = (a, b) => {
    const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
    const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    const small = Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]));
    return small > 0 ? (ix * iy) / small : 0;
  };

  /**
   * A confirmed detection supports the class of changed regions it overlaps
   * (e.g. a lying stem → "Windwurf"); these become training examples with
   * source 'objekt'. User labels on the same region take precedence.
   */
  function syncDetectionLabels(d) {
    db.prepare("DELETE FROM region_labels WHERE source = 'objekt' AND json_extract(region_json, '$.detectionId') = ?").run(d.id);
    const cls = DETECTION_CLASS[d.label];
    if (d.status !== 'bestaetigt' || !cls) return 0;
    const photo = getPhoto.get(d.photo_id);
    const change = photo?.change_json ? JSON.parse(photo.change_json) : null;
    if (!change?.regions?.length) return 0;
    const base = getPhoto.get(change.base);
    let n = 0;
    for (const g of change.regions) {
      if (!g.features) continue;
      const box = regionInPhoto(g.bbox, base, photo);
      if (!box || overlap(box, [d.x0, d.y0, d.x1, d.y1]) < 0.3) continue;
      const { area, bbox, ruleScores, features, foliage } = g;
      const r = db.prepare(`
        INSERT INTO region_labels (photo_id, base_id, region_key, class, source, region_json, created_at)
        VALUES (?, ?, ?, ?, 'objekt', ?, ?) ON CONFLICT (photo_id, base_id, region_key) DO NOTHING
      `).run(photo.id, base.id, regionKey(bbox), cls, JSON.stringify({ area, bbox, ruleScores, features, foliage, detectionId: d.id }), Date.now());
      n += Number(r.changes);
    }
    return n;
  }

  app.patch('/api/detections/:id', (req, res) => {
    const id = idParam(req, res);
    if (id === null) return;
    const status = req.body?.status;
    if (!STATUSES.includes(status)) return res.status(400).json({ error: `status muss ${STATUSES.join(', ')} sein` });
    const d = db.prepare('SELECT * FROM detections WHERE id = ?').get(id);
    if (!d) return res.status(404).json({ error: 'Erkennung nicht gefunden' });
    db.prepare('UPDATE detections SET status = ? WHERE id = ?').run(status, id);
    const updated = db.prepare('SELECT * FROM detections WHERE id = ?').get(id);
    const trainingExamples = syncDetectionLabels(updated);
    learner.schedule();
    res.json({ ...detectionJson(updated), trainingExamples });
  });
};
