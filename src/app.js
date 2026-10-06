'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');

const { openDb, transaction } = require('./db');
const { isValidCoord, positionAt } = require('./geo');
const { parseGpx } = require('./gpx');
const { readPhotoMeta, imageExtension } = require('./exif');
const { assignSpot, refreshSpot } = require('./spots');
const { TAGS, parseTags } = require('./tags');
const { identifyPlant } = require('./plantnet');

const ACTIVITIES = ['joggen', 'wandern', 'biken', 'sonstiges'];
const NEOPHYTE_MIN_SCORE = 0.3;

function createApp({
  dataDir = path.join(__dirname, '..', 'data'),
  spotRadiusM = 25,
  plantnetKey = process.env.PLANTNET_API_KEY,
  fetchImpl = fetch,
} = {}) {
  const uploadDir = path.join(dataDir, 'uploads');
  const tmpDir = path.join(dataDir, 'tmp');
  fs.mkdirSync(uploadDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  const db = openDb(path.join(dataDir, 'myforrest.db'));

  const upload = multer({
    dest: tmpDir,
    limits: { fileSize: 40 * 1024 * 1024, files: 201 },
  }).fields([{ name: 'photos', maxCount: 200 }, { name: 'gpx', maxCount: 1 }]);

  const app = express();
  app.locals.db = db;
  app.use(express.json({ limit: '100kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/vendor/leaflet', express.static(path.dirname(require.resolve('leaflet/dist/leaflet.js'))));
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
    identifications: idsOf.all(p.id).map((r) => ({
      scientificName: r.scientific_name,
      commonName: r.common_name,
      score: r.score,
      neophyte: r.neophyte,
    })),
  });

  const setTags = (photoId, tags) => {
    db.prepare('DELETE FROM photo_tags WHERE photo_id = ?').run(photoId);
    const ins = db.prepare('INSERT INTO photo_tags (photo_id, tag) VALUES (?, ?)');
    for (const t of tags) ins.run(photoId, t);
  };

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
      SELECT s.id, s.lat, s.lon,
             COUNT(DISTINCT p.id) AS photo_count,
             MIN(p.taken_at) AS first_taken,
             MAX(p.taken_at) AS last_taken,
             GROUP_CONCAT(DISTINCT t.tag) AS tags,
             (SELECT file FROM photos WHERE spot_id = s.id ORDER BY taken_at DESC LIMIT 1) AS latest_file
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
      photoCount: r.photo_count,
      firstTaken: new Date(r.first_taken).toISOString(),
      lastTaken: new Date(r.last_taken).toISOString(),
      tags: r.tags ? r.tags.split(',').sort() : [],
      latestUrl: `/uploads/${r.latest_file}`,
    })));
  });

  app.get('/api/spots/:id', (req, res) => {
    const id = idParam(req, res);
    if (id === null) return;
    const spot = db.prepare('SELECT id, lat, lon FROM spots WHERE id = ?').get(id);
    if (!spot) return res.status(404).json({ error: 'Spot nicht gefunden' });
    const photos = db.prepare('SELECT * FROM photos WHERE spot_id = ? ORDER BY taken_at, id').all(id);
    res.json({ ...spot, photos: photos.map(photoJson) });
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
      if (isValidCoord(meta.lat, meta.lon)) {
        pos = { lat: meta.lat, lon: meta.lon };
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
      const photo = transaction(db, () => {
        const spotId = assignSpot(db, pos.lat, pos.lon, spotRadiusM);
        const id = Number(db.prepare(`
          INSERT INTO photos (spot_id, file, original_name, taken_at, lat, lon, heading,
                              location_source, activity, note, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(spotId, file, f.originalname.slice(0, 255), takenAt, pos.lat, pos.lon, meta.heading,
          source, activity, note, Date.now()).lastInsertRowid);
        setTags(id, tags);
        refreshSpot(db, spotId);
        touchedSpots.add(spotId);
        return getPhoto.get(id);
      });
      created.push(photoJson(photo));
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
    res.status(204).end();
  });

  app.post('/api/photos/:id/identify', async (req, res, next) => {
    const id = idParam(req, res);
    if (id === null) return;
    if (!plantnetKey) return res.status(501).json({ error: 'Pflanzenerkennung nicht konfiguriert (PLANTNET_API_KEY)' });
    const photo = getPhoto.get(id);
    if (!photo) return res.status(404).json({ error: 'Foto nicht gefunden' });
    try {
      const organ = ['leaf', 'flower', 'fruit', 'bark', 'auto'].includes(req.body?.organ) ? req.body.organ : 'auto';
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
      });
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
