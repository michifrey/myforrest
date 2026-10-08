'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const sharp = require('sharp');

const { transaction } = require('../db');
const { isValidCoord, positionAt } = require('../geo');
const { parseGpx } = require('../gpx');
const { parseTags } = require('../tags');
const { assignSpot, refreshSpot } = require('../spots');
const { readMp4 } = require('../mp4');
const { gpsTrack } = require('../gpmf');
const { planByDistance, planByTime, isEquirectangular, sharpness, createFramePicker, createFfmpeg } = require('../video');

const MAX_FRAMES = 300;
const JOB_TTL_MS = 60 * 60 * 1000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const clamp = (v, lo, hi, fallback) => {
  const n = Number(v);
  return v === undefined || v === '' || !Number.isFinite(n) ? fallback : Math.min(hi, Math.max(lo, n));
};
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/**
 * Video upload: GoPro (with GPMF telemetry) and 360° videos become a series of
 * photos along the route, each going through the normal photo pipeline.
 *
 *   POST /api/videos            multipart `video` (+ optional `gpx` and the photo fields)
 *   GET  /api/videos/jobs/:id   progress of an upload sent with `async=1`
 *   GET  /api/videos/config     whether ffmpeg is available, defaults
 */
module.exports = function videoRoutes(app, ctx) {
  const {
    db, uploadDir, tmpDir, spotRadiusM, activities, photoJson, getPhoto, setTags,
    alignPhoto, analyzeChange, analyzeContext, background, safeAlign,
  } = ctx;
  const ffmpeg = ctx.ffmpeg || createFfmpeg();
  const maxMb = Number(process.env.VIDEO_MAX_MB) || 4096;
  const defaultEveryM = spotRadiusM;
  const defaultEveryS = 10;

  const upload = multer({
    dest: tmpDir,
    limits: { fileSize: maxMb * 1024 * 1024, files: 2 },
  }).fields([{ name: 'video', maxCount: 1 }, { name: 'gpx', maxCount: 1 }]);

  const jobs = new Map();
  let queue = Promise.resolve();

  app.get('/api/videos/config', async (req, res) => {
    res.json({
      ffmpeg: await ffmpeg.available(),
      frameDistanceM: defaultEveryM,
      frameIntervalS: defaultEveryS,
      maxFrames: MAX_FRAMES,
      maxMb,
    });
  });

  app.get('/api/videos/jobs/:id', (req, res) => {
    const job = jobs.get(String(req.params.id));
    if (!job) return res.status(404).json({ error: 'Auftrag nicht gefunden' });
    res.json(jobJson(job));
  });

  app.post('/api/videos', (req, res, next) => {
    upload(req, res, (err) => {
      if (err) {
        const msg = err.code === 'LIMIT_FILE_SIZE' ? `Video ist grösser als ${maxMb} MB` : err.message;
        return res.status(400).json({ error: `Upload fehlgeschlagen: ${msg}` });
      }
      handle(req, res).catch(next);
    });
  });

  const jobJson = (job) => ({
    id: job.id,
    status: job.status,
    phase: job.phase,
    total: job.total,
    done: job.done,
    error: job.error,
    result: job.result,
  });

  async function handle(req, res) {
    const video = req.files?.video?.[0];
    const gpxFile = req.files?.gpx?.[0];
    const cleanup = () => Promise.all([video, gpxFile].filter(Boolean).map((f) => fsp.rm(f.path, { force: true })));
    if (!video) {
      await cleanup();
      return res.status(400).json({ error: 'Kein Video übermittelt' });
    }
    const job = {
      id: crypto.randomUUID(), status: 'wartet', phase: 'In der Warteschlange', total: 0, done: 0, error: null, result: null,
    };
    jobs.set(job.id, job);
    const work = queue.then(async () => {
      job.status = 'läuft';
      try {
        job.result = await processVideo(job, video, gpxFile, req.body || {});
        job.status = 'fertig';
        job.phase = 'Fertig';
      } catch (err) {
        job.status = 'fehler';
        job.error = err.message;
        job.httpStatus = err.status || 500;
        if (!err.status) console.error('Video-Verarbeitung fehlgeschlagen:', err);
      } finally {
        await cleanup();
        setTimeout(() => jobs.delete(job.id), JOB_TTL_MS).unref();
      }
    });
    queue = work;

    if (req.body?.async === '1' || req.body?.async === 'true') {
      background(work);
      return res.status(202).json(jobJson(job));
    }
    await work;
    if (job.status === 'fehler') return res.status(job.httpStatus).json({ error: job.error });
    res.status(job.result.created.length ? 201 : 422).json(job.result);
  }

  async function processVideo(job, video, gpxFile, b) {
    const name = String(video.originalname || 'video').slice(0, 200);
    const ext = path.extname(name).toLowerCase();
    if (ext === '.insv') {
      throw new HttpError(415, 'Insta360-Rohdateien (.insv) enthalten zwei ungestitchte Fischaugen-Bilder. ' +
        'Bitte das Video zuerst in Insta360 Studio oder der Insta360-App als 360°-Video (MP4, equirektangulär) exportieren.');
    }
    if (ext === '.360') {
      throw new HttpError(415, 'GoPro-MAX-Rohdateien (.360) bitte zuerst in GoPro Player als 360°-MP4 (equirektangulär) exportieren.');
    }

    job.phase = 'Video wird gelesen';
    const info = await readMp4(video.path);
    if (!info.isMp4) throw new HttpError(415, 'Kein unterstütztes Videoformat – bitte MP4 oder MOV hochladen');
    if (!info.hasVideo) throw new HttpError(422, 'Die Datei enthält keine Videospur');
    if (!(await ffmpeg.available())) {
      throw new HttpError(503, `ffmpeg wurde nicht gefunden (${ffmpeg.bin}). Bitte ffmpeg installieren oder den Pfad über FFMPEG_PATH angeben.`);
    }
    const duration = info.duration ?? 0;

    const everyM = clamp(b.frameDistanceM, 5, 500, defaultEveryM);
    const everyS = clamp(b.frameIntervalS, 1, 600, defaultEveryS);
    const clockShiftMs = (Number(b.clockShiftSeconds) || 0) * 1000;
    const manual = b.lat !== undefined && b.lat !== '' ? { lat: Number(b.lat), lon: Number(b.lon) } : null;
    if (manual && !isValidCoord(manual.lat, manual.lon)) throw new HttpError(400, 'Ungültige Koordinaten');
    const fallbackTime = b.takenAt ? Date.parse(b.takenAt) : NaN;
    const activity = activities.includes(b.activity) ? b.activity : null;
    const note = b.note ? String(b.note).slice(0, 2000) : null;
    const tags = parseTags(b.tags);
    const panoramaChoice = ['0', '1'].includes(String(b.panorama)) ? String(b.panorama) : 'auto';

    // Positions: GPMF telemetry of the camera, else a GPX track, else a fixed place.
    const gps = gpsTrack(info.gpmf);
    let startMs;
    if (gps.utcOffsetMs !== null) startMs = gps.utcOffsetMs;
    else startMs = (Number.isFinite(fallbackTime) ? fallbackTime : info.createdAt ?? Date.now()) + clockShiftMs;
    const timeAt = (t) => Math.round(startMs + t * 1000);

    const anchorsNear = (points) => {
      const lats = points.map((p) => p.lat);
      const lons = points.map((p) => p.lon);
      const dLat = spotRadiusM / 111320;
      const dLon = spotRadiusM / (111320 * Math.cos((lats[0] * Math.PI) / 180));
      return db.prepare('SELECT id, lat, lon FROM spots WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?')
        .all(Math.min(...lats) - dLat, Math.max(...lats) + dLat, Math.min(...lons) - dLon, Math.max(...lons) + dLon);
    };
    const plan = (points) => planByDistance(points, {
      everyM, radiusM: spotRadiusM, anchors: anchorsNear(points), maxFrames: MAX_FRAMES, duration,
    });

    let frames = [];
    let source;
    let trackKind;
    if (gps.points.length >= 2) {
      frames = plan(gps.points);
      [source, trackKind] = ['exif', 'gpmf'];
    }
    if (!frames.length && gpxFile) {
      const track = parseGpx(await fsp.readFile(gpxFile.path, 'utf8'));
      if (!track.length) throw new HttpError(400, 'GPX-Datei enthält keine Punkte mit Zeitstempel');
      // Position every second of the video on the track (interpolated, as for photos).
      const points = [];
      for (let t = 0; t <= duration; t += 1) {
        const p = positionAt(track, timeAt(t), 30000);
        if (p) points.push({ t, ...p });
      }
      if (points.length >= 2) frames = plan(points);
      if (!frames.length && !manual) {
        throw new HttpError(422, 'Die Aufnahmezeit des Videos liegt ausserhalb des GPX-Tracks. ' +
          'Startzeit prüfen (Datum-Feld) oder die Kamera-Uhr unter „Zeitabgleich“ korrigieren.');
      }
      if (frames.length) [source, trackKind] = ['gpx', 'gpx'];
    }
    if (!frames.length && manual) {
      frames = planByTime(duration, { everyS, maxFrames: MAX_FRAMES })
        .map((f) => ({ ...f, lat: manual.lat, lon: manual.lon }));
      [source, trackKind] = ['manual', 'manual'];
    }
    if (!frames.length) {
      throw new HttpError(422, 'Kein GPS im Video – bitte GPX-Track hochladen oder Standort auf der Karte wählen');
    }

    job.total = frames.length;
    job.phase = 'Bilder werden extrahiert';
    const created = [];
    const skipped = [];
    const touchedSpots = new Set();
    let panorama = panoramaChoice === '1' ? true : panoramaChoice === '0' ? false : null;
    // Motion blur (shaky bike, fast turns): the sharpest frame within ±0.25 s, blurry ones are dropped.
    const picker = createFramePicker({ duration: duration > 0.05 ? duration - 0.05 : Infinity });
    const extract = async (t) => {
      const file = path.join(tmpDir, `${crypto.randomUUID()}.jpg`);
      try {
        await ffmpeg.extractFrame(video.path, t, file);
        return { file, sharpness: await sharpness(file) };
      } catch (err) {
        await fsp.rm(file, { force: true });
        throw err;
      }
    };
    for (const planned of frames) {
      let frame = planned;
      let label = `${name} · ${clock(frame.t)}`;
      let out;
      try {
        const best = await picker.pick(planned.t, extract, (c) => fsp.rm(c.file, { force: true }));
        out = best.file;
        // A neighbouring frame was sharper: a quarter second does not move the position noticeably.
        frame = { ...planned, t: best.t };
        label = `${name} · ${clock(frame.t)}`;
        if (best.blurry) {
          await fsp.rm(out, { force: true });
          skipped.push({ name: label, reason: 'Bild unscharf (Bewegungsunschärfe), auch in den Nachbarbildern' });
          job.done++;
          continue;
        }
        const meta = await sharp(out).metadata();
        if (panorama === null) panorama = info.spherical || isEquirectangular(meta.width, meta.height);
      } catch (err) {
        if (out) await fsp.rm(out, { force: true });
        skipped.push({ name: label, reason: `Bild konnte nicht extrahiert werden: ${err.message}` });
        job.done++;
        continue;
      }

      const file = path.basename(out);
      const stored = path.join(uploadDir, file);
      await fsp.rename(out, stored);
      // Several frames of one video never share a spot (e.g. when passing a place twice).
      const photoId = transaction(db, () => {
        const spotId = assignSpot(db, frame.lat, frame.lon, spotRadiusM);
        if (touchedSpots.has(spotId)) return null;
        const id = Number(db.prepare(`
          INSERT INTO photos (spot_id, file, original_name, taken_at, lat, lon, heading, altitude,
                              location_source, activity, note, created_at, panorama, video_time)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(spotId, file, label.slice(0, 255), timeAt(frame.t), frame.lat, frame.lon, frame.heading,
          frame.alt === null ? null : Math.round(frame.alt * 10) / 10, source, activity, note, Date.now(),
          panorama ? 1 : 0, Math.round(frame.t * 1000) / 1000).lastInsertRowid);
        setTags(id, tags);
        refreshSpot(db, spotId);
        touchedSpots.add(spotId);
        return id;
      });
      if (photoId === null) {
        await fsp.rm(stored, { force: true });
        skipped.push({ name: label, reason: 'Gleicher Spot wie ein anderes Bild aus diesem Video' });
        job.done++;
        continue;
      }
      job.phase = 'Bilder werden ausgerichtet';
      await safeAlign(alignPhoto(photoId));
      await safeAlign(analyzeChange(photoId));
      background(analyzeContext(photoId));
      created.push(photoJson(getPhoto.get(photoId)));
      job.done++;
      job.phase = 'Bilder werden extrahiert';
    }

    return {
      created,
      skipped,
      spots: [...touchedSpots],
      video: {
        name,
        durationS: Math.round(duration * 10) / 10,
        track: trackKind,
        gpsPoints: gps.points.length,
        panorama: Boolean(panorama),
        spherical: info.spherical,
        frames: frames.length,
        frameDistanceM: trackKind === 'manual' ? null : everyM,
        frameIntervalS: trackKind === 'manual' ? everyS : null,
        distanceM: trackKind === 'manual' ? null : frames.reduce((m, f) => Math.max(m, f.distanceM ?? 0), 0),
      },
    };
  }
};
