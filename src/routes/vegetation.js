'use strict';

/*
 * Vegetation density per photo and the satellite context per spot
 * (Sentinel-2 NDVI and NDMI, Landsat before 2017).
 *
 *   GET  /api/spots/:id/vegetation   per-photo metrics (computed in the background when missing)
 *   GET  /api/spots/:id/ndvi         monthly NDVI/NDMI series, drops between photo dates, current anomalies
 *   POST /api/spots/:id/ndvi         fetch the satellite series again
 *   GET  /api/satellite/alerts       spots whose last months dropped against earlier years (early warning)
 *   GET  /api/satellite/calibration  thresholds of the early warning, calibrated on confirmed damage
 *   POST /api/satellite/calibration  calibrate again now
 *   GET  /api/satellite/harmonization  how Landsat is mapped onto the Sentinel-2 scale (harmonize.js)
 *   POST /api/satellite/harmonization  fit it again now
 *
 * A watcher refreshes the series of all spots once a day (SATELLITE_WATCH_HOURS,
 * 0 = off), so drops show up without anyone opening the spot or taking a photo.
 * Drops and alerts carry the strongest storm of their period (storms.js).
 * New warnings go out as push messages to the people who visit the spot
 * regularly (routes/push.js).
 * After each round the thresholds of the early warning and of the drops
 * between photos are calibrated again (calibration.js) against the damage
 * photographers confirmed, on all spots and per forest type (forest-type.js).
 *
 * Usage in createApp: `const vegetation = require('./routes/vegetation')(app, ctx)`,
 * with ctx = { db, uploadDir, background, fetchImpl, push }. Returns { analyzePhoto, backfill };
 * `backfill(null, [photoId])` queues a new photo for analysis in the background.
 */

const path = require('node:path');
const { analyzeVegetation, imageAspect } = require('../vegetation');
const { createSentinel, indexDrops, pairDrop, currentAnomalies, STAC_URL } = require('../sentinel');
const { createLandsat, STAC_URL: LANDSAT_STAC_URL } = require('../landsat');
const { createStorms, likelyStorm, stormText } = require('../storms');
const { calibrateAll, calibrationFor, maxDropBetween } = require('../calibration');
const { forestType } = require('../forest-type');
const { treeInfo } = require('../trees');
const { DAMAGE_TAGS } = require('../geodata');

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

const DAY = 86400000;
const monthStart = (ym) => Date.parse(`${ym}-01T00:00:00Z`);

module.exports = function registerVegetation(app, {
  db, uploadDir, background, fetchImpl = fetch, stacUrl = process.env.SENTINEL_STAC_URL ?? STAC_URL,
  landsatStacUrl = process.env.LANDSAT_STAC_URL ?? LANDSAT_STAC_URL, landsatTokenUrl = process.env.LANDSAT_TOKEN_URL,
  watchHours = Number(process.env.SATELLITE_WATCH_HOURS ?? 24), now = () => Date.now(), push = null, accounts = null,
}) {
  // Photo rows the request may see (hidden and protected ones only for those allowed); public without accounts.
  const visibleTo = (req) => (accounts && req ? accounts.visibleSql(req, 'p') : "p.hidden_at IS NULL AND COALESCE(p.protected, 0) = 0");
  db.exec(SCHEMA);
  const landsat = stacUrl && landsatStacUrl
    ? createLandsat({ fetchImpl, stacUrl: landsatStacUrl, ...(landsatTokenUrl ? { tokenUrl: landsatTokenUrl } : {}), now })
    : null;
  const sentinel = stacUrl ? createSentinel({ db, fetchImpl, stacUrl, landsat, now }) : null;
  const storms = createStorms({ db, fetchImpl, now });

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
    const photos = db.prepare(`SELECT id, taken_at FROM photos p WHERE spot_id = ? AND ${visibleTo(req)} ORDER BY taken_at, id`).all(id);
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

  /**
   * The strongest storm (gusts ≥ 75 km/h) at the spot between two times, from
   * the weather cache. Missing years are fetched in the background, so the
   * storm shows up on the next look; until then `undefined`.
   */
  const stormFetches = new Set();
  function stormBetween(lat, lon, from, to) {
    const events = storms.cachedBetween(lat, lon, from, to);
    if (events === null) {
      const key = `${lat.toFixed(1)},${lon.toFixed(1)}`;
      if (!stormFetches.has(key)) {
        stormFetches.add(key);
        background(storms.between(lat, lon, from, to).catch(() => null).finally(() => stormFetches.delete(key)));
      }
      return undefined;
    }
    const e = likelyStorm(events, from, to);
    return e ? { date: e.date, gust: e.gust, class: e.class, text: stormText(e) } : null;
  }

  /* ---------- Forest type and calibration ---------- */

  /** Laub-, Nadel- or Mischwald from the species, the photos' needle share or the satellite seasons. */
  function forestTypeOf(spotId, monthly) {
    const species = db.prepare('SELECT DISTINCT scientific_name FROM spot_species WHERE spot_id = ?').all(spotId)
      .map((r) => treeInfo(r.scientific_name)).filter(Boolean);
    let needleShares = [];
    try {
      needleShares = db.prepare(`SELECT a.foliage_json FROM photo_analysis a JOIN photos p ON p.id = a.photo_id
        WHERE p.spot_id = ? AND a.foliage_json IS NOT NULL`).all(spotId).map((r) => JSON.parse(r.foliage_json).needleShare);
    } catch { /* photo analysis not set up */ }
    return forestType({ species, needleShares, monthly });
  }

  db.exec('CREATE TABLE IF NOT EXISTS satellite_calibration (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, computed_at INTEGER NOT NULL)');
  const DAMAGE_CLASSES = ['windwurf', 'auflichtung', 'verfaerbung'];
  const MIN_INTERVAL = 30 * DAY;
  const hasHidden = db.prepare('PRAGMA table_info(photos)').all().some((c) => c.name === 'hidden_at');

  /**
   * The ground truth: consecutive visible photos of spots with a satellite
   * series. Damage = a damage tag new on the later photo, or a region of it
   * confirmed as windthrow, clearing or discolouration. No damage = neither
   * a damage tag nor such a region. Damage tags carried over unchanged from
   * the earlier photo say nothing about the interval and are left out.
   */
  function checks() {
    const tagsOf = db.prepare('SELECT tag FROM photo_tags WHERE photo_id = ?');
    const confirmed = db.prepare(`SELECT 1 FROM region_labels WHERE photo_id = ? AND class IN (${DAMAGE_CLASSES.map(() => '?').join(',')}) LIMIT 1`);
    const out = [];
    for (const { spot_id: spotId } of db.prepare('SELECT spot_id FROM spot_ndvi').all()) {
      const monthly = sentinel.series(spotId).monthly;
      if (!monthly.length) continue;
      const type = forestTypeOf(spotId, monthly).type;
      const photos = db.prepare(`SELECT id, taken_at FROM photos WHERE spot_id = ? ${hasHidden ? 'AND hidden_at IS NULL' : ''} ORDER BY taken_at, id`).all(spotId);
      for (let k = 1; k < photos.length; k++) {
        const a = photos[k - 1];
        const b = photos[k];
        if (b.taken_at - a.taken_at < MIN_INTERVAL) continue;
        const before = new Set(tagsOf.all(a.id).map((r) => r.tag).filter((t) => DAMAGE_TAGS.includes(t)));
        const after = tagsOf.all(b.id).map((r) => r.tag).filter((t) => DAMAGE_TAGS.includes(t));
        const newTag = after.some((t) => !before.has(t));
        const region = Boolean(confirmed.get(b.id, ...DAMAGE_CLASSES));
        if (after.length && !newTag && !region) continue; // damage seen before already
        const iso = (t) => new Date(t).toISOString();
        const pair = (key) => pairDrop(monthly, iso(a.taken_at), iso(b.taken_at), key)?.drop ?? null;
        out.push({
          spotId, fromPhotoId: a.id, toPhotoId: b.id, damage: newTag || region, forestType: type,
          // What the early warning saw during the interval, and the drop between the two photos themselves.
          warning: { ndvi: maxDropBetween(monthly, a.taken_at, b.taken_at, 'ndvi'), ndmi: maxDropBetween(monthly, a.taken_at, b.taken_at, 'ndmi') },
          photos: { ndvi: pair('ndvi'), ndmi: pair('ndmi') },
        });
      }
    }
    return out;
  }

  /** Calibrates on all checks and stores the result. */
  function recalibrate() {
    const result = calibrateAll(sentinel ? checks() : []);
    db.prepare('INSERT OR REPLACE INTO satellite_calibration (id, json, computed_at) VALUES (1, ?, ?)').run(JSON.stringify(result), now());
    return { ...result, computedAt: new Date(now()).toISOString() };
  }

  /** The stored calibration (computed on first use, and again when stored before forest types). */
  function calibration() {
    const row = db.prepare('SELECT json, computed_at FROM satellite_calibration WHERE id = 1').get();
    return row && JSON.parse(row.json).forestTypes ? { ...JSON.parse(row.json), computedAt: new Date(row.computed_at).toISOString() } : recalibrate();
  }

  /**
   * What a warning or drop says about its threshold (see calibration.js):
   * the entry used, and for a forest type without its own threshold why not.
   */
  function calibrationSummary({ entry: c, scope, typeEntry }, type) {
    return {
      source: c.source, reason: c.reason, threshold: c.threshold, candidate: c.candidate,
      positives: c.positives, negatives: c.negatives, spots: c.spots, baseline: c.baseline,
      // 'waldtyp': calibrated for this forest type; 'alle': the threshold of all spots.
      scope,
      forestType: type ? { type: type.type, label: type.label, source: type.source, reason: typeEntry?.reason ?? null } : null,
      cv: c.cv ? { folds: c.cv.folds, hits: c.cv.tp, misses: c.cv.fn, falseAlarms: c.cv.fp, f1: c.cv.f1 } : null,
      standard: c.standard ? { threshold: c.standard.threshold, hits: c.standard.tp, misses: c.standard.fn, falseAlarms: c.standard.fp, f1: c.standard.f1 } : null,
    };
  }

  /** The thresholds of a measure at a spot of this forest type, per index. */
  function thresholdsFor(cal, measure, type) {
    const sel = Object.fromEntries(['ndvi', 'ndmi'].map((key) => [key, calibrationFor(cal, { measure, type: type?.type, key })]));
    return {
      thresholds: Object.fromEntries(Object.entries(sel).map(([k, v]) => [k, [v.entry.threshold, v.entry.strong]])),
      summary: (key) => calibrationSummary(sel[key], type),
    };
  }

  /** Early warnings of a spot from its cached series: index, since when, how strong, storm, whether to visit. */
  function alertsOf(spotId, monthly, spot, cal = calibration(), type = forestTypeOf(spotId, monthly)) {
    const last = db.prepare('SELECT MAX(taken_at) AS t FROM photos WHERE spot_id = ?').get(spotId)?.t ?? null;
    const { thresholds, summary } = thresholdsFor(cal, 'warning', type);
    return currentAnomalies(monthly, { now: now(), thresholds }).map((a) => ({
      ...a,
      // Which threshold raised it (forest type or all spots), and how it did on held-out spots next to the fallback.
      calibration: summary(a.index),
      lastPhoto: last ? new Date(last).toISOString().slice(0, 10) : null,
      // A photo taken after the drop began would already show it.
      visit: !last || last < monthStart(a.since),
      // Storms from three months before the drop until now.
      storm: stormBetween(spot.lat, spot.lon, monthStart(a.since) - 92 * DAY, now()),
    }));
  }

  const ndviJson = (id, req = null) => {
    const photos = db.prepare(`SELECT id, taken_at FROM photos p WHERE spot_id = ? AND ${visibleTo(req)} ORDER BY taken_at, id`).all(id)
      .map((p) => ({ id: p.id, takenAt: new Date(p.taken_at).toISOString() }));
    if (!sentinel) return { status: 'disabled', monthly: [], drops: [], alerts: [], photos };
    const spot = db.prepare('SELECT lat, lon FROM spots WHERE id = ?').get(id);
    const s = sentinel.series(id);
    const cal = calibration();
    const type = forestTypeOf(id, s.monthly);
    const { thresholds, summary } = thresholdsFor(cal, 'photos', type);
    const drops = ['ndvi', 'ndmi'].flatMap((key) => indexDrops(s.monthly, photos, { key, threshold: thresholds[key][0], strong: thresholds[key][1] })).map((d) => ({
      ...d,
      calibration: summary(d.index),
      evidence: photoEvidence(d.fromPhotoId, d.toPhotoId),
      storm: stormBetween(spot.lat, spot.lon, Date.parse(d.fromDate), Date.parse(d.toDate) + DAY - 1),
    }));
    const running = refreshing.has(id);
    let status = 'ready';
    if (running) status = 'pending';
    else if (s.error) status = 'offline';
    const sensors = new Set(s.monthly.flatMap((m) => m.sensors));
    return {
      status,
      source: [
        'Copernicus Sentinel-2 L2A über Earth Search (Element 84)',
        ...([...sensors].some((x) => x.startsWith('L')) ? ['Landsat Collection 2 (USGS) über Microsoft Planetary Computer'] : []),
      ].join('; '),
      resolutionM: 10,
      windowM: 30,
      ...s,
      forestType: type,
      drops,
      alerts: alertsOf(id, s.monthly, spot, cal, type),
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
    res.json(ndviJson(id, req));
  });

  app.post('/api/spots/:id/ndvi', async (req, res, next) => {
    const id = idParam(req, res);
    if (id === null) return;
    if (!sentinel) return res.json(ndviJson(id, req));
    try {
      db.prepare('UPDATE spot_ndvi SET fetched_at = NULL WHERE spot_id = ?').run(id);
      await refreshNdvi(id);
      res.json(ndviJson(id, req));
    } catch (err) {
      next(err);
    }
  });

  /* ---------- Early warning for all spots ---------- */

  /** Early warnings of the spots `req` may see (all spots without a request). */
  function allAlerts(req = null) {
    if (!sentinel) return [];
    const visible = accounts && req ? accounts.visibleSpotIds(req) : null;
    const spots = db.prepare('SELECT s.id, s.lat, s.lon FROM spots s JOIN spot_ndvi n ON n.spot_id = s.id').all()
      .filter((s) => !visible || visible.has(s.id));
    const cal = calibration();
    return spots.map((spot) => ({ spotId: spot.id, lat: spot.lat, lon: spot.lon, alerts: alertsOf(spot.id, sentinel.series(spot.id).monthly, spot, cal) }))
      .filter((x) => x.alerts.length);
  }
  app.get('/api/satellite/alerts', (req, res) => res.json(allAlerts(req)));

  app.get('/api/satellite/calibration', (req, res) => res.json(calibration()));
  app.get('/api/satellite/harmonization', (req, res) => res.json(sentinel ? sentinel.harmonization() : {}));
  app.post('/api/satellite/harmonization', (req, res) => res.json(sentinel ? sentinel.harmonize() : {}));
  app.post('/api/satellite/calibration', (req, res) => res.json(recalibrate()));

  /** Refreshes the satellite series of every spot that is due, one after the other. */
  let watching = null;
  function watchOnce() {
    if (!sentinel) return Promise.resolve(0);
    if (!watching) {
      watching = (async () => {
        let refreshed = 0;
        for (const { id } of db.prepare('SELECT id FROM spots ORDER BY id').all()) {
          if (!sentinel.needsRefresh(id)) continue;
          await refreshNdvi(id);
          refreshed++;
        }
        // New scenes or new photos since the last round: harmonise Landsat again, then calibrate on the result.
        sentinel.harmonize();
        recalibrate();
        // New warnings to the people who visit those spots regularly.
        if (push) await push.notifyAlerts(allAlerts()).catch((err) => console.warn(`Push der Frühwarnungen: ${err.message}`));
        return refreshed;
      })().finally(() => { watching = null; });
      background(watching);
    }
    return watching;
  }
  app.locals.satelliteWatch = watchOnce;
  if (sentinel && watchHours > 0) {
    // First round a few minutes after startup, then daily; timers never keep the process alive.
    setTimeout(watchOnce, 5 * 60000).unref?.();
    setInterval(watchOnce, watchHours * 3600000).unref?.();
  }

  /** Snow and ice share of a glacier spot (src/sentinel.js iceSeries), fetching the scenes when due. */
  function ice(id) {
    if (!sentinel) return { status: 'disabled', monthly: [], summers: [], iceFreeSince: null, meltOut: [] };
    if (sentinel.needsRefresh(id)) refreshNdvi(id);
    const st = sentinel.series(id);
    return { status: refreshing.has(id) ? 'pending' : st.error ? 'offline' : 'ready', error: st.error, ...sentinel.ice(id) };
  }
  /** The spot became a glacier spot: its scenes are read again for the snow and ice share. */
  const satelliteDue = (id) => db.prepare('UPDATE spot_ndvi SET complete = 0 WHERE spot_id = ?').run(id);

  return { analyzePhoto, backfill, alerts: allAlerts, ice, satelliteDue };
};
