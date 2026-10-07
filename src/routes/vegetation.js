'use strict';

/*
 * Vegetation density per photo and the Sentinel-2 NDVI context per spot.
 *
 *   GET  /api/spots/:id/vegetation   per-photo metrics (computed in the background when missing)
 *   GET  /api/spots/:id/ndvi         monthly NDVI series, drops between photo dates
 *   POST /api/spots/:id/ndvi         fetch the satellite series again
 *
 * Usage in createApp: `const vegetation = require('./routes/vegetation')(app, ctx)`,
 * with ctx = { db, uploadDir, background, fetchImpl }. Returns { analyzePhoto, backfill };
 * `backfill(null, [photoId])` queues a new photo for analysis in the background.
 */

const path = require('node:path');
const { analyzeVegetation, imageAspect } = require('../vegetation');
const { createSentinel, ndviDrops, STAC_URL } = require('../sentinel');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS photo_vegetation (
    photo_id    INTEGER PRIMARY KEY REFERENCES photos (id) ON DELETE CASCADE,
    frame_key   TEXT NOT NULL,
    json        TEXT,
    error       TEXT,
    computed_at INTEGER NOT NULL
  );
`;

const SUPPORT_CLASSES = ['windwurf', 'auflichtung'];
const SUPPORT_TAGS = ['sturmschaden', 'holzschlag', 'borkenkaefer'];

const isIdentity = (h) => h.every((v, i) => Math.abs(v - [1, 0, 0, 0, 1, 0, 0, 0, 1][i]) < 1e-9);

module.exports = function registerVegetation(app, {
  db, uploadDir, background, fetchImpl = fetch, stacUrl = process.env.SENTINEL_STAC_URL ?? STAC_URL,
}) {
  db.exec(SCHEMA);
  const sentinel = stacUrl ? createSentinel({ db, fetchImpl, stacUrl }) : null;

  const getPhoto = db.prepare('SELECT * FROM photos WHERE id = ?');
  const stored = db.prepare('SELECT * FROM photo_vegetation WHERE photo_id = ?');
  const save = db.prepare(`
    INSERT INTO photo_vegetation (photo_id, frame_key, json, error, computed_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (photo_id) DO UPDATE SET frame_key = excluded.frame_key, json = excluded.json,
      error = excluded.error, computed_at = excluded.computed_at`);

  /**
   * The spot's common frame: the aligned photo with the identity transform
   * (the first aligned one). Falls back to the earliest aligned photo.
   */
  function frameOf(spotId) {
    const aligned = db.prepare('SELECT id, file, align_h FROM photos WHERE spot_id = ? AND align_h IS NOT NULL ORDER BY taken_at, id').all(spotId);
    return aligned.find((p) => isIdentity(JSON.parse(p.align_h))) || aligned[0] || null;
  }

  /** Key of the frame a photo's metrics refer to; changes after re-alignment. */
  function frameKey(photo, frame) {
    return photo.align_h && frame ? `${frame.id}:${photo.align_h}` : 'photo';
  }

  const aspects = new Map();
  const aspectOf = async (file) => {
    if (!aspects.has(file)) aspects.set(file, await imageAspect(path.join(uploadDir, file)));
    return aspects.get(file);
  };

  const inFlight = new Map();
  /** Computes (or recomputes after re-alignment) a photo's vegetation metrics. */
  function analyzePhoto(photoId) {
    if (inFlight.has(photoId)) return inFlight.get(photoId);
    const job = (async () => {
      const photo = getPhoto.get(photoId);
      if (!photo) return null;
      const frame = frameOf(photo.spot_id);
      const key = frameKey(photo, frame);
      const prev = stored.get(photoId);
      if (prev && prev.frame_key === key) return prev;
      try {
        const opts = photo.align_h && frame
          ? { h: JSON.parse(photo.align_h), frameAspect: await aspectOf(frame.file) }
          : {};
        const m = await analyzeVegetation(path.join(uploadDir, photo.file), opts);
        save.run(photoId, key, JSON.stringify(m), null, Date.now());
      } catch (err) {
        if (!getPhoto.get(photoId)) return null; // deleted meanwhile
        save.run(photoId, key, null, err.message, Date.now());
      }
      return stored.get(photoId);
    })().finally(() => inFlight.delete(photoId));
    inFlight.set(photoId, job);
    return job;
  }

  /** Photos of a spot (or all spots) whose metrics are missing or stale. */
  function staleIds(spotId = null) {
    const photos = spotId === null
      ? db.prepare('SELECT id, spot_id, align_h FROM photos ORDER BY spot_id, taken_at').all()
      : db.prepare('SELECT id, spot_id, align_h FROM photos WHERE spot_id = ? ORDER BY taken_at').all(spotId);
    const frames = new Map();
    return photos.filter((p) => {
      if (!frames.has(p.spot_id)) frames.set(p.spot_id, frameOf(p.spot_id));
      const s = stored.get(p.id);
      return !s || s.frame_key !== frameKey(p, frames.get(p.spot_id));
    }).map((p) => p.id);
  }

  // One worker analyses queued photos one after the other.
  const queue = new Set();
  let worker = null;
  /** Queues photos for analysis; without ids all missing or stale photos (of a spot). */
  function backfill(spotId = null, ids = staleIds(spotId)) {
    for (const id of ids) queue.add(id);
    if (!worker && queue.size) {
      worker = (async () => {
        while (queue.size) {
          const id = queue.values().next().value;
          queue.delete(id);
          await analyzePhoto(id);
        }
      })().finally(() => { worker = null; });
      background(worker);
    }
    return worker || Promise.resolve();
  }
  // Existing photos (e.g. uploaded before this feature) are analysed after startup.
  backfill();

  const idParam = (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Ungültige ID' });
      return null;
    }
    if (!db.prepare('SELECT 1 FROM spots WHERE id = ?').get(id)) {
      res.status(404).json({ error: 'Spot nicht gefunden' });
      return null;
    }
    return id;
  };

  app.get('/api/spots/:id/vegetation', (req, res) => {
    const id = idParam(req, res);
    if (id === null) return;
    const pending = staleIds(id);
    if (pending.length) backfill(id, pending);
    const photos = db.prepare('SELECT id, taken_at FROM photos WHERE spot_id = ? ORDER BY taken_at, id').all(id);
    const pendingSet = new Set(pending);
    res.json({
      pending: pending.length,
      photos: photos.map((p) => {
        const s = stored.get(p.id);
        const fresh = s && !pendingSet.has(p.id);
        return {
          photoId: p.id,
          takenAt: new Date(p.taken_at).toISOString(),
          ...(fresh && s.json ? JSON.parse(s.json) : {}),
          error: fresh ? s.error : null,
          pending: pendingSet.has(p.id),
        };
      }),
    });
  });

  /** Supporting evidence from the photos for an NDVI drop: classified change or tags. */
  function photoEvidence(fromId, toId) {
    const summaryOf = (pid) => {
      const p = getPhoto.get(pid);
      return p?.change_json ? JSON.parse(p.change_json).summary || [] : [];
    };
    const before = new Map(summaryOf(fromId).map((s) => [s.class, s.area]));
    const evidence = summaryOf(toId)
      .filter((s) => SUPPORT_CLASSES.includes(s.class) && s.area > (before.get(s.class) || 0) + 0.01)
      .map((s) => ({ kind: 'change', class: s.class, label: s.label, area: s.area }));
    const tags = db.prepare('SELECT tag FROM photo_tags WHERE photo_id = ?').all(toId).map((r) => r.tag);
    for (const t of tags.filter((x) => SUPPORT_TAGS.includes(x))) evidence.push({ kind: 'tag', tag: t });
    return evidence;
  }

  const ndviJson = (id) => {
    const photos = db.prepare('SELECT id, taken_at FROM photos WHERE spot_id = ? ORDER BY taken_at, id').all(id)
      .map((p) => ({ id: p.id, takenAt: new Date(p.taken_at).toISOString() }));
    if (!sentinel) return { status: 'disabled', monthly: [], drops: [], photos };
    const s = sentinel.series(id);
    const drops = ndviDrops(s.monthly, photos).map((d) => ({ ...d, evidence: photoEvidence(d.fromPhotoId, d.toPhotoId) }));
    const running = refreshing.has(id);
    let status = 'ready';
    if (running) status = 'pending';
    else if (s.error) status = 'offline';
    return {
      status,
      source: 'Copernicus Sentinel-2 L2A über Earth Search (Element 84)',
      resolutionM: 10,
      windowM: 30,
      ...s,
      drops,
      photos,
    };
  };

  const refreshing = new Map();
  function refreshNdvi(id) {
    if (!refreshing.has(id)) {
      const job = sentinel.refresh(id).finally(() => refreshing.delete(id));
      refreshing.set(id, job);
      background(job);
    }
    return refreshing.get(id);
  }

  app.get('/api/spots/:id/ndvi', (req, res) => {
    const id = idParam(req, res);
    if (id === null) return;
    if (sentinel && sentinel.needsRefresh(id)) refreshNdvi(id);
    res.json(ndviJson(id));
  });

  app.post('/api/spots/:id/ndvi', async (req, res, next) => {
    const id = idParam(req, res);
    if (id === null) return;
    if (!sentinel) return res.json(ndviJson(id));
    try {
      db.prepare('UPDATE spot_ndvi SET fetched_at = NULL WHERE spot_id = ?').run(id);
      await refreshNdvi(id);
      res.json(ndviJson(id));
    } catch (err) {
      next(err);
    }
  });

  return { analyzePhoto, backfill };
};
