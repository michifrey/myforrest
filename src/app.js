'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');

const { openDb, transaction } = require('./db');
const { distanceM, isValidCoord, positionAt } = require('./geo');
const { parseGpx } = require('./gpx');
const { readPhotoMeta, imageExtension } = require('./exif');
const { assignSpot, refreshSpot } = require('./spots');
const { TAGS, parseTags } = require('./tags');
const { identifyPlant } = require('./plantnet');
const { alignImages, extractFeatures } = require('./align');
const { IDENTITY, multiply, invert } = require('./homography');
const { computeChange, renderHeatmap } = require('./change');
const { classifyChange } = require('./classify');
const { createWeather } = require('./weather');
const { assess } = require('./irregularities');
const { TREES, treeInfo, treeJson } = require('./trees');
const { createElevation } = require('./elevation');
const {
  altitudeShift, aspectShift, coldPoolShift, expectedColourDoy, aspectLabel, aspectFromCompass, COMPASS, LANDFORMS, landform,
} = require('./phenology');

const ACTIVITIES = ['joggen', 'wandern', 'biken', 'sonstiges'];
const NEOPHYTE_MIN_SCORE = 0.3;
const TREE_MIN_SCORE = 0.25;

function createApp({
  dataDir = path.join(__dirname, '..', 'data'),
  spotRadiusM = 25,
  plantnetKey = process.env.PLANTNET_API_KEY,
  fetchImpl = fetch,
  weatherFetch = fetch,
} = {}) {
  const uploadDir = path.join(dataDir, 'uploads');
  const tmpDir = path.join(dataDir, 'tmp');
  fs.mkdirSync(uploadDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  const db = openDb(path.join(dataDir, 'myforrest.db'));
  const weather = createWeather({ db, fetchImpl: weatherFetch });
  const elevationService = createElevation({ db, fetchImpl: weatherFetch });

  const upload = multer({
    dest: tmpDir,
    limits: { fileSize: 40 * 1024 * 1024, files: 201 },
  }).fields([{ name: 'photos', maxCount: 200 }, { name: 'gpx', maxCount: 1 }]);

  const app = express();
  app.locals.db = db;
  app.use(express.json({ limit: '100kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/vendor/leaflet', express.static(path.dirname(require.resolve('leaflet/dist/leaflet.js'))));
  for (const font of ['fraunces', 'manrope']) {
    const dir = path.dirname(require.resolve(`@fontsource-variable/${font}/package.json`));
    app.use(`/vendor/fonts/${font}`, express.static(dir, { maxAge: '30d' }));
  }
  app.use('/uploads', express.static(uploadDir, { maxAge: '7d', immutable: true }));

  const tagsOf = db.prepare('SELECT tag FROM photo_tags WHERE photo_id = ? ORDER BY tag');
  const idsOf = db.prepare(
    'SELECT scientific_name, common_name, score, neophyte FROM identifications WHERE photo_id = ? ORDER BY score DESC',
  );
  const getPhoto = db.prepare('SELECT * FROM photos WHERE id = ?');

  const photoJson = (p) => ({
    id: p.id,
    spotId: p.spot_id,
    url: `/uploads/${p.file}`,
    originalName: p.original_name,
    takenAt: new Date(p.taken_at).toISOString(),
    lat: p.lat,
    lon: p.lon,
    heading: p.heading,
    locationSource: p.location_source,
    activity: p.activity,
    note: p.note,
    tags: tagsOf.all(p.id).map((r) => r.tag),
    alignment: p.align_h ? { h: JSON.parse(p.align_h), inliers: p.align_inliers } : null,
    change: p.change_json ? JSON.parse(p.change_json) : null,
    context: p.context_json ? JSON.parse(p.context_json) : null,
    identifications: idsOf.all(p.id).map((r) => {
      const tree = treeInfo(r.scientific_name);
      return {
        scientificName: r.scientific_name,
        commonName: r.common_name,
        score: r.score,
        neophyte: r.neophyte,
        tree: tree ? treeJson(tree) : null,
      };
    }),
  });

  const setTags = (photoId, tags) => {
    db.prepare('DELETE FROM photo_tags WHERE photo_id = ?').run(photoId);
    const ins = db.prepare('INSERT INTO photo_tags (photo_id, tag) VALUES (?, ?)');
    for (const t of tags) ins.run(photoId, t);
  };

  /* ---------- Alignment of photos within a spot ---------- */

  // Small cache so aligning against the same reference does not re-extract features.
  const featureCache = new Map();
  const cachedFeatures = async (file) => {
    if (featureCache.has(file)) return featureCache.get(file);
    const f = extractFeatures(file);
    featureCache.set(file, f);
    if (featureCache.size > 40) featureCache.delete(featureCache.keys().next().value);
    f.catch(() => featureCache.delete(file));
    return f;
  };
  const setAlignment = db.prepare('UPDATE photos SET align_h = ?, align_inliers = ? WHERE id = ?');

  /**
   * Aligns a photo into its spot's common frame (that of the first aligned
   * photo). Tries the reference photo first, then aligned photos closest in
   * time, and chains the transforms. Leaves the photo unaligned on failure.
   */
  async function alignPhoto(photoId, refPhotoId = null) {
    const photo = getPhoto.get(photoId);
    if (!photo) return;
    const aligned = db.prepare(
      'SELECT * FROM photos WHERE spot_id = ? AND id != ? AND align_h IS NOT NULL',
    ).all(photo.spot_id, photo.id);
    if (!aligned.length) {
      setAlignment.run(JSON.stringify(IDENTITY), null, photo.id);
      return;
    }
    aligned.sort((a, b) =>
      (b.id === refPhotoId) - (a.id === refPhotoId) ||
      Math.abs(a.taken_at - photo.taken_at) - Math.abs(b.taken_at - photo.taken_at));
    for (const ref of aligned.slice(0, 3)) {
      const r = await alignImages(path.join(uploadDir, photo.file), path.join(uploadDir, ref.file), {
        getFeatures: cachedFeatures,
      });
      if (r) {
        setAlignment.run(JSON.stringify(multiply(JSON.parse(ref.align_h), r.h)), r.inliers, photo.id);
        return;
      }
    }
    setAlignment.run(null, null, photo.id);
  }

  async function realignSpot(spotId) {
    db.prepare('UPDATE photos SET align_h = NULL, align_inliers = NULL WHERE spot_id = ?').run(spotId);
    const ids = db.prepare('SELECT id FROM photos WHERE spot_id = ? ORDER BY taken_at, id').all(spotId);
    for (const { id } of ids) await alignPhoto(id);
    for (const { id } of ids) {
      await analyzeChange(id);
      refreshIrregularities(id);
    }
  }

  /* ---------- Analysis per photo: classified change and weather context ---------- */

  const setChange = db.prepare('UPDATE photos SET change_json = ? WHERE id = ?');
  const setContext = db.prepare('UPDATE photos SET context_json = ? WHERE id = ?');

  /** Classifies the change of a photo against the spot's first aligned photo. */
  async function analyzeChange(photoId) {
    const photo = getPhoto.get(photoId);
    if (!photo) return;
    const base = db.prepare(
      'SELECT * FROM photos WHERE spot_id = ? AND align_h IS NOT NULL ORDER BY taken_at, id LIMIT 1',
    ).get(photo.spot_id);
    if (!photo.align_h || !base || base.id === photo.id || base.taken_at > photo.taken_at) {
      setChange.run(null, photoId);
      return;
    }
    const c = changeBetween(base.id, photo.id);
    if (c.error) return setChange.run(null, photoId);
    const r = await c.job;
    setChange.run(JSON.stringify({
      base: base.id,
      baseTakenAt: new Date(base.taken_at).toISOString(),
      fraction: Math.round(r.changedFraction * 1000) / 1000,
      summary: r.summary,
      regions: r.regions,
    }), photoId);
  }

  /* ---------- Tree species per spot ---------- */

  const speciesRows = db.prepare(
    'SELECT scientific_name, source, score, photo_id FROM spot_species WHERE spot_id = ? ORDER BY created_at, id',
  );
  /** Tree species known at a spot, merged across sources (manual and Pl@ntNet). */
  function spotSpecies(spotId) {
    const merged = new Map();
    const terrain = terrainOf(spotId);
    for (const r of speciesRows.all(spotId)) {
      const t = treeInfo(r.scientific_name);
      if (!t) continue;
      const e = merged.get(t.sci) || {
        ...treeJson(t),
        // Expected start of colouring at this spot's altitude.
        colourDoyHere: expectedColourDoy(t.colourDoy, terrain),
        sources: [],
        score: null,
      };
      e.sources.push(r.source);
      if (r.score !== null) e.score = Math.max(e.score ?? 0, r.score);
      merged.set(t.sci, e);
    }
    return [...merged.values()];
  }
  const spotTrees = (spotId) => spotSpecies(spotId).map((s) => treeInfo(s.scientificName));
  const addSpecies = db.prepare(`
    INSERT INTO spot_species (spot_id, scientific_name, source, photo_id, score, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (spot_id, scientific_name, source)
    DO UPDATE SET score = MAX(COALESCE(score, 0), COALESCE(excluded.score, 0)), photo_id = excluded.photo_id
  `);

  /** Elevation, slope and aspect of a spot (each may be null). */
  function terrainOf(spotId) {
    const t = db.prepare('SELECT elevation, slope, aspect, landform, tpi600 FROM spots WHERE id = ?').get(spotId) || {};
    return {
      elevation: t.elevation ?? null,
      slope: t.slope ?? null,
      aspect: t.aspect ?? null,
      landform: t.landform ?? null,
      tpi600: t.tpi600 ?? null,
    };
  }

  /**
   * Makes sure a spot has terrain data. The terrain model gives elevation,
   * slope and aspect in one go; without it the median GPS altitude of the
   * photos stands in for the elevation. Manual values are never overwritten.
   */
  async function ensureElevation(spotId) {
    const spot = db.prepare(
      'SELECT lat, lon, elevation, elevation_source, terrain_source, landform_source, tpi600 FROM spots WHERE id = ?',
    ).get(spotId);
    if (!spot) return null;
    // Also refetch spots analysed before the landform existed.
    if (spot.terrain_source === null || (spot.landform_source === null && spot.tpi600 === null)) {
      try {
        const t = await elevationService.terrain(spot.lat, spot.lon);
        db.prepare("UPDATE spots SET slope = ?, aspect = ?, terrain_source = 'dem' WHERE id = ? AND (terrain_source IS NULL OR terrain_source = 'dem')")
          .run(t.slope, t.aspect, spotId);
        const slope = db.prepare('SELECT slope FROM spots WHERE id = ?').get(spotId).slope;
        db.prepare("UPDATE spots SET tpi300 = ?, tpi600 = ?, landform = ?, landform_source = 'dem' WHERE id = ? AND (landform_source IS NULL OR landform_source = 'dem')")
          .run(t.tpi300, t.tpi600, landform({ tpi300: t.tpi300, tpi600: t.tpi600, slope }), spotId);
        db.prepare("UPDATE spots SET elevation = ?, elevation_source = 'dem' WHERE id = ? AND (elevation IS NULL OR elevation_source = 'gps')")
          .run(t.elevation, spotId);
      } catch {
        // Terrain service unavailable: fall back below and retry next time.
      }
    }
    if (terrainOf(spotId).elevation !== null) return terrainOf(spotId).elevation;
    let value = null;
    let source = null;
    try {
      value = await elevationService.lookup(spot.lat, spot.lon);
      source = 'dem';
    } catch {
      const alts = db.prepare('SELECT altitude FROM photos WHERE spot_id = ? AND altitude IS NOT NULL ORDER BY altitude')
        .all(spotId).map((r) => r.altitude);
      if (alts.length) {
        value = Math.round(alts[Math.floor(alts.length / 2)]);
        source = 'gps';
      }
    }
    if (value !== null) {
      db.prepare('UPDATE spots SET elevation = ?, elevation_source = ? WHERE id = ? AND elevation IS NULL').run(value, source, spotId);
    }
    return terrainOf(spotId).elevation;
  }

  const irregularitiesOf = (photo, weatherCtx) => assess({
    takenAt: photo.taken_at,
    tags: tagsOf.all(photo.id).map((t) => t.tag),
    change: photo.change_json ? JSON.parse(photo.change_json) : null,
    weather: weatherCtx,
    species: spotTrees(photo.spot_id),
    ...terrainOf(photo.spot_id),
  });

  /** Species changed: re-evaluate every photo of the spot. */
  function reassessSpot(spotId) {
    for (const { id } of db.prepare('SELECT id FROM photos WHERE spot_id = ?').all(spotId)) refreshIrregularities(id);
  }

  /** Fetches weather for the photo's place and date and records the irregularities. */
  async function analyzeContext(photoId) {
    const photo = getPhoto.get(photoId);
    if (!photo) return null;
    let weatherCtx = null;
    let weatherError = null;
    try {
      const elevation = await ensureElevation(photo.spot_id);
      weatherCtx = await weather.context(photo.lat, photo.lon, photo.taken_at, { elevation });
    } catch (err) {
      weatherError = err.message;
    }
    const ctx = {
      computedAt: new Date().toISOString(),
      weather: weatherCtx,
      weatherError,
      irregularities: irregularitiesOf(photo, weatherCtx),
    };
    setContext.run(JSON.stringify(ctx), photoId);
    return ctx;
  }

  /** Re-evaluates the irregularities (after tag or change updates) without refetching weather. */
  function refreshIrregularities(photoId) {
    const photo = getPhoto.get(photoId);
    if (!photo?.context_json) return;
    const ctx = JSON.parse(photo.context_json);
    ctx.irregularities = irregularitiesOf(photo, ctx.weather);
    setContext.run(JSON.stringify(ctx), photoId);
  }

  // Background work (weather lookups) is tracked so tests and shutdown can wait for it.
  const pending = new Set();
  const background = (promise) => {
    const p = promise.catch((err) => console.error('Hintergrundanalyse fehlgeschlagen:', err.message))
      .finally(() => pending.delete(p));
    pending.add(p);
  };
  app.locals.idle = () => Promise.all([...pending]);

  const safeAlign = (fn) => fn.catch((err) => console.error('Ausrichtung fehlgeschlagen:', err.message));

  const idParam = (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Ungültige ID' });
      return null;
    }
    return id;
  };

  app.get('/api/config', (req, res) => {
    res.json({ tags: TAGS, activities: ACTIVITIES, plantnet: Boolean(plantnetKey), spotRadiusM });
  });

  app.get('/api/spots', (req, res) => {
    const tag = req.query.tag ? String(req.query.tag) : null;
    const rows = db.prepare(`
      SELECT s.id, s.lat, s.lon, s.elevation,
             COUNT(DISTINCT p.id) AS photo_count,
             MIN(p.taken_at) AS first_taken,
             MAX(p.taken_at) AS last_taken,
             GROUP_CONCAT(DISTINCT t.tag) AS tags,
             (SELECT file FROM photos WHERE spot_id = s.id ORDER BY taken_at DESC LIMIT 1) AS latest_file,
             (SELECT change_json FROM photos WHERE spot_id = s.id ORDER BY taken_at DESC LIMIT 1) AS latest_change,
             (SELECT context_json FROM photos WHERE spot_id = s.id ORDER BY taken_at DESC LIMIT 1) AS latest_context
      FROM spots s
      JOIN photos p ON p.spot_id = s.id
      LEFT JOIN photo_tags t ON t.photo_id = p.id
      GROUP BY s.id
      HAVING ? IS NULL OR SUM(t.tag = ?) > 0
      ORDER BY s.id
    `).all(tag, tag);
    res.json(rows.map((r) => ({
      id: r.id,
      lat: r.lat,
      lon: r.lon,
      elevation: r.elevation,
      photoCount: r.photo_count,
      firstTaken: new Date(r.first_taken).toISOString(),
      lastTaken: new Date(r.last_taken).toISOString(),
      tags: r.tags ? r.tags.split(',').sort() : [],
      latestUrl: `/uploads/${r.latest_file}`,
      change: r.latest_change ? (({ fraction, summary }) => ({ fraction, top: summary[0]?.label || null }))(JSON.parse(r.latest_change)) : null,
      species: spotSpecies(r.id).map((t) => t.name),
      irregularities: r.latest_context
        ? JSON.parse(r.latest_context).irregularities.filter((i) => i.severity !== 'hinweis').map((i) => i.title)
        : [],
    })));
  });

  const spotJson = (id) => {
    const spot = db.prepare(`
      SELECT id, lat, lon, elevation, elevation_source, slope, aspect, terrain_source,
             tpi300, tpi600, landform, landform_source
      FROM spots WHERE id = ?`).get(id);
    if (!spot) return null;
    const photos = db.prepare('SELECT * FROM photos WHERE spot_id = ? ORDER BY taken_at, id').all(id);
    return {
      id: spot.id,
      lat: spot.lat,
      lon: spot.lon,
      elevation: spot.elevation,
      elevationSource: spot.elevation_source,
      slope: spot.slope,
      aspect: spot.aspect,
      exposition: spot.terrain_source ? aspectLabel(spot.aspect, spot.slope ?? 0) : null,
      terrainSource: spot.terrain_source,
      landform: spot.landform,
      landformLabel: spot.landform ? LANDFORMS[spot.landform] : null,
      landformSource: spot.landform_source,
      tpi300: spot.tpi300,
      tpi600: spot.tpi600,
      colourShift: {
        altitude: spot.elevation === null ? 0 : altitudeShift(spot.elevation),
        exposition: aspectShift(spot.aspect, spot.slope),
        coldPool: coldPoolShift(spot.landform, spot.tpi600),
      },
      colourShiftDays: spot.elevation === null && spot.terrain_source === null && spot.landform === null ? null
        : altitudeShift(spot.elevation) + aspectShift(spot.aspect, spot.slope) + coldPoolShift(spot.landform, spot.tpi600),
      species: spotSpecies(id),
      photos: photos.map(photoJson),
    };
  };

  app.get('/api/spots/:id', (req, res) => {
    const id = idParam(req, res);
    if (id === null) return;
    const spot = spotJson(id);
    if (!spot) return res.status(404).json({ error: 'Spot nicht gefunden' });
    res.json(spot);
  });

  app.post('/api/spots/:id/align', async (req, res, next) => {
    const id = idParam(req, res);
    if (id === null) return;
    if (!spotJson(id)) return res.status(404).json({ error: 'Spot nicht gefunden' });
    try {
      await realignSpot(id);
      res.json(spotJson(id));
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/photos', (req, res, next) => {
    upload(req, res, (err) => {
      if (err) return res.status(400).json({ error: `Upload fehlgeschlagen: ${err.message}` });
      handleUpload(req, res).catch(next);
    });
  });

  async function handleUpload(req, res) {
    const files = req.files?.photos || [];
    const gpxFile = req.files?.gpx?.[0];
    let status;
    let body;
    try {
      [status, body] = await processUpload(files, gpxFile, req.body || {});
    } finally {
      // Temp files of skipped photos (and the GPX) are removed before answering.
      await Promise.all([...files, ...(gpxFile ? [gpxFile] : [])].map((f) => fsp.rm(f.path, { force: true })));
    }
    res.status(status).json(body);
  }

  async function processUpload(files, gpxFile, b) {
    if (!files.length) return [400, { error: 'Keine Fotos übermittelt' }];

    const offsetMin = Number.isFinite(Number(b.utcOffsetMinutes)) ? Number(b.utcOffsetMinutes) : 0;
    const clockShiftMs = (Number(b.clockShiftSeconds) || 0) * 1000;
    const manual = b.lat !== undefined && b.lat !== '' ? { lat: Number(b.lat), lon: Number(b.lon) } : null;
    if (manual && !isValidCoord(manual.lat, manual.lon)) {
      return [400, { error: 'Ungültige Koordinaten' }];
    }
    const fallbackTime = b.takenAt ? Date.parse(b.takenAt) : NaN;
    const activity = ACTIVITIES.includes(b.activity) ? b.activity : null;
    const note = b.note ? String(b.note).slice(0, 2000) : null;
    const tags = parseTags(b.tags);
    // Repeat photos taken at a known spot (rephotography) are pinned to that spot.
    let targetSpot = null;
    if (b.spotId !== undefined && b.spotId !== '') {
      const sid = Number(b.spotId);
      targetSpot = Number.isSafeInteger(sid) && sid > 0
        ? db.prepare('SELECT id, lat, lon FROM spots WHERE id = ?').get(sid)
        : null;
      if (!targetSpot) return [400, { error: 'Spot nicht gefunden' }];
    }
    const refPhotoId = Number.isSafeInteger(Number(b.refPhotoId)) ? Number(b.refPhotoId) : null;
    const nearSpot = (p) => distanceM(p, targetSpot) <= Math.max(4 * spotRadiusM, 100);
    const track = gpxFile ? parseGpx(await fsp.readFile(gpxFile.path, 'utf8')) : [];
    if (gpxFile && !track.length) {
      return [400, { error: 'GPX-Datei enthält keine Punkte mit Zeitstempel' }];
    }

    const created = [];
    const skipped = [];
    const touchedSpots = new Set();
    for (const f of files) {
      const buf = await fsp.readFile(f.path);
      const ext = imageExtension(buf);
      if (!ext) {
        skipped.push({ name: f.originalname, reason: 'Kein unterstütztes Bildformat (JPEG, PNG, WebP)' });
        continue;
      }
      const meta = await readPhotoMeta(buf, offsetMin);
      let takenAt = meta.takenAt !== null ? meta.takenAt + clockShiftMs : null;
      if (takenAt === null) takenAt = Number.isFinite(fallbackTime) ? fallbackTime : Date.now();

      let pos = null;
      let source = null;
      const exifPos = isValidCoord(meta.lat, meta.lon) ? { lat: meta.lat, lon: meta.lon } : null;
      if (targetSpot) {
        // Keep the device position when it is plausible, otherwise use the spot centre.
        if (exifPos && nearSpot(exifPos)) [pos, source] = [exifPos, 'exif'];
        else if (manual && nearSpot(manual)) [pos, source] = [manual, 'spot'];
        else [pos, source] = [{ lat: targetSpot.lat, lon: targetSpot.lon }, 'spot'];
      } else if (exifPos) {
        pos = exifPos;
        source = 'exif';
      } else if (track.length && meta.takenAt !== null && (pos = positionAt(track, takenAt))) {
        source = 'gpx';
      } else if (manual) {
        pos = manual;
        source = 'manual';
      }
      if (!pos) {
        skipped.push({
          name: f.originalname,
          reason: track.length
            ? 'Aufnahmezeit liegt ausserhalb des GPX-Tracks und kein Standort gewählt'
            : 'Kein GPS im Foto – bitte GPX-Track hochladen oder Standort auf der Karte wählen',
        });
        continue;
      }

      const file = `${crypto.randomUUID()}.${ext}`;
      await fsp.rename(f.path, path.join(uploadDir, file));
      const photoId = transaction(db, () => {
        const spotId = targetSpot ? targetSpot.id : assignSpot(db, pos.lat, pos.lon, spotRadiusM);
        const id = Number(db.prepare(`
          INSERT INTO photos (spot_id, file, original_name, taken_at, lat, lon, heading, altitude,
                              location_source, activity, note, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(spotId, file, f.originalname.slice(0, 255), takenAt, pos.lat, pos.lon, meta.heading, meta.altitude,
          source, activity, note, Date.now()).lastInsertRowid);
        setTags(id, tags);
        refreshSpot(db, spotId);
        touchedSpots.add(spotId);
        return id;
      });
      await safeAlign(alignPhoto(photoId, refPhotoId));
      await safeAlign(analyzeChange(photoId));
      background(analyzeContext(photoId));
      created.push(photoJson(getPhoto.get(photoId)));
    }
    return [created.length ? 201 : 422, { created, skipped, spots: [...touchedSpots] }];
  }

  app.patch('/api/photos/:id', (req, res) => {
    const id = idParam(req, res);
    if (id === null) return;
    const photo = getPhoto.get(id);
    if (!photo) return res.status(404).json({ error: 'Foto nicht gefunden' });
    const body = req.body || {};
    transaction(db, () => {
      if (body.tags !== undefined) setTags(id, parseTags(body.tags));
      if (body.note !== undefined) {
        db.prepare('UPDATE photos SET note = ? WHERE id = ?').run(body.note ? String(body.note).slice(0, 2000) : null, id);
      }
    });
    refreshIrregularities(id);
    res.json(photoJson(getPhoto.get(id)));
  });

  app.delete('/api/photos/:id', async (req, res) => {
    const id = idParam(req, res);
    if (id === null) return;
    const photo = getPhoto.get(id);
    if (!photo) return res.status(404).json({ error: 'Foto nicht gefunden' });
    transaction(db, () => {
      db.prepare('DELETE FROM photos WHERE id = ?').run(id);
      refreshSpot(db, photo.spot_id);
    });
    await fsp.rm(path.join(uploadDir, photo.file), { force: true });
    // The spot's first photo may have gone: re-evaluate the others' change.
    const rest = db.prepare('SELECT id FROM photos WHERE spot_id = ?').all(photo.spot_id);
    background((async () => {
      for (const { id: other } of rest) {
        await analyzeChange(other);
        refreshIrregularities(other);
      }
    })());
    res.status(204).end();
  });

  app.get('/api/trees', (req, res) => {
    res.json(TREES.map(treeJson).sort((a, b) => a.name.localeCompare(b.name, 'de')));
  });

  /** Sets the spot's elevation by hand (`{ elevation: 950 }`), or `null` to determine it again. */
  app.patch('/api/spots/:id', async (req, res, next) => {
    const id = idParam(req, res);
    if (id === null) return;
    if (!db.prepare('SELECT 1 FROM spots WHERE id = ?').get(id)) return res.status(404).json({ error: 'Spot nicht gefunden' });
    const body = req.body || {};
    const hasElevation = Object.prototype.hasOwnProperty.call(body, 'elevation');
    const hasExposition = Object.prototype.hasOwnProperty.call(body, 'exposition');
    const value = body.elevation;
    if (hasElevation && value !== null && !(Number.isFinite(value) && value > -500 && value < 5000)) {
      return res.status(400).json({ error: 'Höhe muss eine Zahl zwischen -500 und 5000 m sein' });
    }
    const expo = body.exposition;
    if (hasExposition && expo !== null && expo !== 'eben' && !COMPASS.includes(expo)) {
      return res.status(400).json({ error: `Exposition muss eben, ${COMPASS.join(', ')} oder null sein` });
    }
    const hasLandform = Object.prototype.hasOwnProperty.call(body, 'landform');
    const form = body.landform;
    if (hasLandform && form !== null && !Object.hasOwn(LANDFORMS, form)) {
      return res.status(400).json({ error: `Geländeform muss ${Object.keys(LANDFORMS).join(', ')} oder null sein` });
    }
    if (!hasElevation && !hasExposition && !hasLandform) {
      return res.status(400).json({ error: 'elevation, exposition oder landform angeben' });
    }
    try {
      if (hasElevation) {
        db.prepare('UPDATE spots SET elevation = ?, elevation_source = ? WHERE id = ?')
          .run(value === null ? null : Math.round(value), value === null ? null : 'manual', id);
      }
      if (hasExposition) {
        // A chosen exposition stands for a clearly inclined slope (20°); "eben" for flat ground.
        if (expo === null) db.prepare('UPDATE spots SET slope = NULL, aspect = NULL, terrain_source = NULL WHERE id = ?').run(id);
        else db.prepare("UPDATE spots SET slope = ?, aspect = ?, terrain_source = 'manual' WHERE id = ?")
          .run(expo === 'eben' ? 0 : 20, expo === 'eben' ? null : aspectFromCompass(expo), id);
      }
      if (hasLandform) {
        // A hand-set landform has no measured TPI; the cold-pool shift then uses a typical value.
        if (form === null) db.prepare('UPDATE spots SET tpi300 = NULL, tpi600 = NULL, landform = NULL, landform_source = NULL WHERE id = ?').run(id);
        else db.prepare("UPDATE spots SET landform = ?, landform_source = 'manual', tpi600 = NULL, tpi300 = NULL WHERE id = ?").run(form, id);
      }
      if (value === null || expo === null || form === null) await ensureElevation(id);
      reassessSpot(id);
      // Weather is downscaled to the altitude: refresh the spot's contexts in the background.
      for (const { id: photoId } of db.prepare('SELECT id FROM photos WHERE spot_id = ? AND context_json IS NOT NULL').all(id)) {
        background(analyzeContext(photoId));
      }
      res.json(spotJson(id));
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/spots/:id/species', (req, res) => {
    const id = idParam(req, res);
    if (id === null) return;
    if (!db.prepare('SELECT 1 FROM spots WHERE id = ?').get(id)) return res.status(404).json({ error: 'Spot nicht gefunden' });
    const tree = treeInfo(req.body?.scientificName);
    if (!tree) return res.status(400).json({ error: 'Unbekannte Baumart' });
    addSpecies.run(id, tree.sci, 'manual', null, null, Date.now());
    reassessSpot(id);
    res.status(201).json(spotSpecies(id));
  });

  app.delete('/api/spots/:id/species', (req, res) => {
    const id = idParam(req, res);
    if (id === null) return;
    const tree = treeInfo(req.query.name);
    if (!tree) return res.status(400).json({ error: 'Unbekannte Baumart' });
    db.prepare('DELETE FROM spot_species WHERE spot_id = ? AND scientific_name = ?').run(id, tree.sci);
    reassessSpot(id);
    res.json(spotSpecies(id));
  });

  app.get('/api/photos/:id/context', async (req, res, next) => {
    const id = idParam(req, res);
    if (id === null) return;
    const photo = getPhoto.get(id);
    if (!photo) return res.status(404).json({ error: 'Foto nicht gefunden' });
    try {
      const stored = photo.context_json ? JSON.parse(photo.context_json) : null;
      // Retry missing weather after an hour; recent periods may still have been incomplete.
      const stale = !stored || (!stored.weather && Date.now() - Date.parse(stored.computedAt) > 3600000);
      res.json(stale ? await analyzeContext(id) : stored);
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/photos/:id/context', async (req, res, next) => {
    const id = idParam(req, res);
    if (id === null) return;
    if (!getPhoto.get(id)) return res.status(404).json({ error: 'Foto nicht gefunden' });
    try {
      res.json(await analyzeContext(id));
    } catch (err) {
      next(err);
    }
  });

  /* ---------- Change detection between two aligned photos ---------- */

  const changeCache = new Map();
  /** Change between photo `fromId` (before, defines the view) and `toId`. */
  function changeBetween(fromId, toId) {
    const a = getPhoto.get(fromId);
    const b = getPhoto.get(toId);
    if (!a || !b) return { status: 404, error: 'Foto nicht gefunden' };
    if (a.spot_id !== b.spot_id) return { status: 422, error: 'Fotos gehören zu verschiedenen Spots' };
    if (!a.align_h || !b.align_h) return { status: 422, error: 'Mindestens eines der Fotos ist nicht ausgerichtet' };
    const key = `${a.id}:${b.id}:${a.align_h}:${b.align_h}`;
    if (!changeCache.has(key)) {
      const hAinv = invert(JSON.parse(a.align_h));
      const job = (async () => {
        if (!hAinv) throw new Error('Ausrichtung nicht invertierbar');
        const result = await computeChange(
          path.join(uploadDir, a.file),
          path.join(uploadDir, b.file),
          multiply(hAinv, JSON.parse(b.align_h)),
        );
        // Keep only what the routes need; the per-pixel scores are large.
        return {
          changedFraction: result.changedFraction,
          coverage: result.coverage,
          ...classifyChange(result),
          png: await renderHeatmap(result),
        };
      })();
      job.catch(() => changeCache.delete(key));
      changeCache.set(key, job);
      if (changeCache.size > 30) changeCache.delete(changeCache.keys().next().value);
    }
    return { job: changeCache.get(key) };
  }

  const changeRoute = (handler) => async (req, res, next) => {
    const id = idParam(req, res);
    if (id === null) return;
    const to = Number(req.query.to);
    if (!Number.isSafeInteger(to) || to <= 0) return res.status(400).json({ error: 'Parameter "to" fehlt' });
    const c = changeBetween(id, to);
    if (c.error) return res.status(c.status).json({ error: c.error });
    try {
      handler(res, await c.job, id, to);
    } catch (err) {
      next(err);
    }
  };

  app.get('/api/photos/:id/change', changeRoute((res, r, id, to) => {
    res.json({
      from: id,
      to,
      changedFraction: Math.round(r.changedFraction * 1000) / 1000,
      coverage: Math.round(r.coverage * 1000) / 1000,
      heatmap: `/api/photos/${id}/change.png?to=${to}`,
      summary: r.summary,
      regions: r.regions,
    });
  }));

  app.get('/api/photos/:id/change.png', changeRoute((res, r) => {
    res.type('png').set('Cache-Control', 'private, max-age=300').send(r.png);
  }));

  app.post('/api/photos/:id/identify', async (req, res, next) => {
    const id = idParam(req, res);
    if (id === null) return;
    if (!plantnetKey) return res.status(501).json({ error: 'Pflanzenerkennung nicht konfiguriert (PLANTNET_API_KEY)' });
    const photo = getPhoto.get(id);
    if (!photo) return res.status(404).json({ error: 'Foto nicht gefunden' });
    try {
      const organ = ['leaf', 'flower', 'fruit', 'bark', 'habit', 'auto'].includes(req.body?.organ) ? req.body.organ : 'auto';
      const results = await identifyPlant(path.join(uploadDir, photo.file), { apiKey: plantnetKey, organ, fetchImpl });
      transaction(db, () => {
        db.prepare('DELETE FROM identifications WHERE photo_id = ?').run(id);
        const ins = db.prepare(`
          INSERT INTO identifications (photo_id, scientific_name, common_name, score, neophyte, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const r of results) ins.run(id, r.scientificName, r.commonName, r.score, r.neophyte, Date.now());
        if (results.some((r) => r.neophyte && r.score >= NEOPHYTE_MIN_SCORE)) {
          db.prepare('INSERT OR IGNORE INTO photo_tags (photo_id, tag) VALUES (?, ?)').run(id, 'neophyt');
        }
        // Confidently recognised trees join the spot's species inventory.
        for (const r of results) {
          const tree = treeInfo(r.scientificName);
          if (tree && r.score >= TREE_MIN_SCORE) addSpecies.run(photo.spot_id, tree.sci, 'plantnet', id, r.score, Date.now());
        }
      });
      reassessSpot(photo.spot_id);
      res.json(photoJson(getPhoto.get(id)));
    } catch (err) {
      next(err);
    }
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Nicht gefunden' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Interner Fehler' });
  });

  return app;
}

module.exports = { createApp };
