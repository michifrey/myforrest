'use strict';

/**
 * The own profile page: what the logged-in account has contributed.
 *
 *   GET /api/profile         figures (photos, spots, years, activities, tours, requests, followed spots)
 *   GET /api/profile/photos  own photos, newest first, in pages (?offset, ?limit, ?filter)
 *   GET /api/profile/export  everything about the account as a ZIP (?fotos=0 without the originals)
 *
 * Only for the account itself: a public list of one person's photos would
 * show where and when that person regularly runs, walks or rides.
 * Photos hidden by the moderation are listed with their reason but without
 * image URLs, since their files are not served to their uploader either.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const { createZip } = require('../zip');
const { createLimiter } = require('../auth');
const { toGpx } = require('../trackfile');

const FILTERS = {
  alle: '1 = 1',
  geschuetzt: 'COALESCE(p.protected, 0) = 1',
  ausgeblendet: 'p.hidden_at IS NOT NULL',
};

/* ---------- Export of the own data (data portability) ---------- */

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const safeName = (s) => String(s || '').normalize('NFC').replace(/[^\p{L}\p{N} ._-]+/gu, '').replace(/\s+/g, '-').slice(0, 60) || 'tour';
const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

const README = `MyForrest – Export deiner Daten
================================

konto.json           Dein Konto: Name, E-Mail, Rolle, Lizenz, Anmeldungen über Google/GitHub, PRO,
                     Mitgliedschaften in Organisationen
fotos.geojson        Deine Fotos mit Ort, Zeit, Blickrichtung, Tags, Notiz, Lizenz und Bestimmungen
                     (GeoJSON, WGS84; in QGIS oder geojson.io zu öffnen)
fotos/               Die Originaldateien, wie hochgeladen (inklusive ihrer EXIF-Daten)
touren/              Deine gespeicherten Touren als GPX
fotoauftraege.json   Deine Fotoaufträge
meldungen.json       Fotos, die du gemeldet hast
gefolgte-spots.json  Spots, denen du folgst oder die du stummgeschaltet hast

Nicht enthalten: dein Passwort (nur als Hash gespeichert, nie exportiert), Sitzungen und
Push-Schlüssel. Fotos anderer Personen an deinen Spots gehören ihnen und fehlen deshalb.
`;

module.exports = function profileRoutes(app, { db, thumbs, accounts, uploadDir, rateLimits = {} }) {
  const fail = (res, status, error) => res.status(status).json({ error });
  const loggedIn = (req, res, next) => (req.user ? next() : fail(res, 401, 'Bitte zuerst anmelden'));
  const count = (sql, ...args) => db.prepare(sql).get(...args).n;
  const exportPerAccount = createLimiter({ max: rateLimits.exportPerAccount ?? 5, windowMs: 3600 * 1000 });

  app.get('/api/profile', loggedIn, async (req, res) => {
    const id = req.user.id;
    const range = db.prepare('SELECT MIN(taken_at) AS first, MAX(taken_at) AS last FROM photos WHERE uploader_id = ?').get(id);
    const years = db.prepare(`SELECT strftime('%Y', taken_at / 1000, 'unixepoch') AS year, COUNT(*) AS n
      FROM photos WHERE uploader_id = ? GROUP BY year ORDER BY year`).all(id);
    const activities = db.prepare(`SELECT COALESCE(activity, 'sonstiges') AS activity, COUNT(*) AS n
      FROM photos WHERE uploader_id = ? GROUP BY 1 ORDER BY n DESC`).all(id);
    // Size of the originals, for the export button.
    let photoBytes = 0;
    for (const { file } of db.prepare('SELECT file FROM photos WHERE uploader_id = ?').all(id)) {
      photoBytes += await fsp.stat(path.join(uploadDir, path.basename(file))).then((st) => st.size, () => 0);
    }
    res.set('Cache-Control', 'no-store');
    res.json({
      name: req.user.name,
      photoBytes,
      memberSince: new Date(req.user.created_at).toISOString(),
      photos: count('SELECT COUNT(*) AS n FROM photos WHERE uploader_id = ?', id),
      spots: count('SELECT COUNT(DISTINCT spot_id) AS n FROM photos WHERE uploader_id = ?', id),
      // Spots where this account added to someone else's series: the repeat photos that make time series.
      repeatSpots: count(`SELECT COUNT(DISTINCT p.spot_id) AS n FROM photos p WHERE p.uploader_id = ?
        AND EXISTS (SELECT 1 FROM photos o WHERE o.spot_id = p.spot_id
          AND (o.taken_at < p.taken_at OR (o.taken_at = p.taken_at AND o.id < p.id))
          AND (o.uploader_id IS NULL OR o.uploader_id != p.uploader_id))`, id),
      hidden: count('SELECT COUNT(*) AS n FROM photos WHERE uploader_id = ? AND hidden_at IS NOT NULL', id),
      protected: count('SELECT COUNT(*) AS n FROM photos WHERE uploader_id = ? AND COALESCE(protected, 0) = 1', id),
      firstAt: range.first ? new Date(range.first).toISOString() : null,
      lastAt: range.last ? new Date(range.last).toISOString() : null,
      years: years.map((y) => ({ year: Number(y.year), photos: y.n })),
      activities: activities.map((a) => ({ activity: a.activity, photos: a.n })),
      tracks: count('SELECT COUNT(*) AS n FROM tracks WHERE owner_id = ?', id),
      requests: {
        open: count("SELECT COUNT(*) AS n FROM photo_requests WHERE requester_id = ? AND status = 'offen'", id),
        done: count("SELECT COUNT(*) AS n FROM photo_requests WHERE requester_id = ? AND status = 'erledigt'", id),
        // Requests of others that one of this account's photos fulfilled.
        fulfilled: count(`SELECT COUNT(*) AS n FROM photo_requests r JOIN photos p ON p.id = r.photo_id
          WHERE p.uploader_id = ? AND (r.requester_id IS NULL OR r.requester_id != ?)`, id, id),
      },
      followedSpots: count("SELECT COUNT(*) AS n FROM spot_follows WHERE user_id = ? AND mode = 'folgen'", id),
    });
  });

  app.get('/api/profile/photos', loggedIn, (req, res) => {
    const filter = Object.hasOwn(FILTERS, req.query.filter) ? req.query.filter : 'alle';
    const limit = Math.min(Math.max(Number(req.query.limit) || 60, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const where = `p.uploader_id = ? AND ${FILTERS[filter]}`;
    const total = count(`SELECT COUNT(*) AS n FROM photos p WHERE ${where}`, req.user.id);
    const rows = db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM photos o WHERE o.spot_id = p.spot_id) AS spot_photos
      FROM photos p WHERE ${where} ORDER BY p.taken_at DESC, p.id DESC LIMIT ? OFFSET ?`).all(req.user.id, limit, offset);
    const tagsOf = db.prepare('SELECT tag FROM photo_tags WHERE photo_id = ? ORDER BY tag');
    res.set('Cache-Control', 'no-store');
    res.json({
      total,
      offset,
      photos: rows.map((p) => {
        const extras = accounts.photoExtras(p);
        return {
          id: p.id,
          spotId: p.spot_id,
          spotPhotos: p.spot_photos,
          // A hidden photo's files are withheld from its uploader as well.
          ...(p.hidden_at ? {} : { url: `/uploads/${p.file}`, ...thumbs.urls(p) }),
          takenAt: new Date(p.taken_at).toISOString(),
          activity: p.activity,
          panorama: Boolean(p.panorama),
          tags: tagsOf.all(p.id).map((r) => r.tag),
          license: extras.license,
          hidden: extras.hidden,
          ...(extras.hidden ? { hiddenReason: extras.hiddenReason } : {}),
          protected: extras.protected,
        };
      }),
    });
  });

  app.get('/api/profile/export', loggedIn, async (req, res, next) => {
    const user = req.user;
    const withPhotos = req.query.fotos !== '0';
    const wait = exportPerAccount.blocked(user.id);
    if (wait) return res.set('Retry-After', String(wait)).status(429).json({ error: 'Schon mehrere Exporte in dieser Stunde – bitte später erneut versuchen' });
    exportPerAccount.hit(user.id);

    const photos = db.prepare('SELECT * FROM photos WHERE uploader_id = ? ORDER BY taken_at, id').all(user.id);
    const tagsOf = db.prepare('SELECT tag FROM photo_tags WHERE photo_id = ? ORDER BY tag');
    const idsOf = db.prepare('SELECT scientific_name, common_name, score, neophyte FROM identifications WHERE photo_id = ? ORDER BY score DESC');
    const fileName = (p) => `fotos/${new Date(p.taken_at).toISOString().slice(0, 10)}_${p.id}${path.extname(p.file).toLowerCase() || '.jpg'}`;

    const day = new Date().toISOString().slice(0, 10);
    res.set({ 'Cache-Control': 'no-store', 'Content-Type': 'application/zip' });
    res.attachment(`myforrest-export-${day}.zip`);
    const zip = createZip(res);
    try {
      const identities = db.prepare('SELECT provider, email, created_at FROM identities WHERE user_id = ? ORDER BY provider').all(user.id);
      await zip.add('LIESMICH.txt', README);
      await zip.add('konto.json', json({
        exportiertAm: new Date().toISOString(),
        id: user.id,
        name: user.name,
        email: user.email,
        emailBestaetigtAm: iso(user.email_verified_at),
        rolle: user.role,
        standardLizenz: user.default_license || null,
        registriertAm: iso(user.created_at),
        passwort: String(user.password_hash || '').startsWith('scrypt$') ? 'gesetzt (nicht exportiert)' : 'keins',
        anmeldungen: identities.map((i) => ({ anbieter: i.provider, email: i.email, verknuepftAm: iso(i.created_at) })),
        pro: user.pro_status ? { status: user.pro_status, organisation: user.organization, angefragtAm: iso(user.pro_requested_at) } : null,
        organisationen: db.prepare(`SELECT o.name, m.role, m.added_at FROM org_members m JOIN organizations o ON o.id = m.org_id
          WHERE m.user_id = ? ORDER BY o.name`).all(user.id).map((m) => ({ name: m.name, rolle: m.role, seit: iso(m.added_at) })),
      }));
      await zip.add('fotos.geojson', json({
        type: 'FeatureCollection',
        features: photos.map((p) => ({
          type: 'Feature',
          geometry: Number.isFinite(p.lat) && Number.isFinite(p.lon) ? { type: 'Point', coordinates: [p.lon, p.lat] } : null,
          properties: {
            id: p.id,
            spot: p.spot_id,
            datei: withPhotos ? fileName(p) : null,
            originalName: p.original_name,
            aufgenommen: iso(p.taken_at),
            hoehe: p.altitude ?? null,
            blickrichtung: p.heading ?? null,
            aktivitaet: p.activity,
            notiz: p.note,
            tags: tagsOf.all(p.id).map((r) => r.tag),
            lizenz: accounts.photoExtras(p).license,
            geschuetzt: Boolean(p.protected),
            ausgeblendet: p.hidden_at ? { am: iso(p.hidden_at), grund: p.hidden_reason } : null,
            bestimmungen: idsOf.all(p.id).map((r) => ({ art: r.scientific_name, name: r.common_name, sicherheit: r.score, neophyt: r.neophyte })),
          },
        })),
      }));
      const tracks = db.prepare('SELECT * FROM tracks WHERE owner_id = ? ORDER BY created_at, id').all(user.id);
      for (const t of tracks) {
        const points = JSON.parse(t.points_json).map(([lat, lon, ele, time]) => ({ lat, lon, ...(ele !== null ? { ele } : {}), ...(time !== null ? { time } : {}) }));
        await zip.add(`touren/${t.id}_${safeName(t.name)}.gpx`, toGpx({ name: t.name, activity: t.activity, points }), { date: new Date(t.created_at) });
      }
      await zip.add('fotoauftraege.json', json(db.prepare(`SELECT id, title, note, lat, lon, heading, spot_id, status, photo_id, created_at, done_at
        FROM photo_requests WHERE requester_id = ? ORDER BY created_at`).all(user.id).map((r) => ({
        id: r.id, titel: r.title, notiz: r.note, lat: r.lat, lon: r.lon, blickrichtung: r.heading, spot: r.spot_id,
        status: r.status, foto: r.photo_id, erstellt: iso(r.created_at), erledigt: iso(r.done_at),
      }))));
      await zip.add('meldungen.json', json(db.prepare('SELECT photo_id, reason, note, created_at, resolved_at, resolution FROM reports WHERE user_id = ? ORDER BY created_at')
        .all(user.id).map((r) => ({ foto: r.photo_id, grund: r.reason, notiz: r.note, gemeldet: iso(r.created_at), erledigt: iso(r.resolved_at), ergebnis: r.resolution }))));
      await zip.add('gefolgte-spots.json', json(db.prepare('SELECT spot_id, mode, created_at FROM spot_follows WHERE user_id = ? ORDER BY created_at')
        .all(user.id).map((f) => ({ spot: f.spot_id, modus: f.mode, seit: iso(f.created_at) }))));
      const missing = [];
      if (withPhotos) {
        for (const p of photos) {
          let data;
          try {
            data = await fsp.readFile(path.join(uploadDir, path.basename(p.file)));
          } catch {
            missing.push(p.id);
            continue;
          }
          await zip.add(fileName(p), data, { date: new Date(p.taken_at) });
        }
      }
      if (missing.length) await zip.add('fehlende-dateien.txt', `Diese Fotos haben keine Datei mehr auf dem Server: ${missing.join(', ')}\n`);
      await zip.finish();
      res.end();
    } catch (err) {
      // Headers are out: the download simply breaks off, which the browser shows as failed.
      if (!res.headersSent) return next(err);
      console.error(`Export für Konto ${user.id} abgebrochen: ${err.message}`);
      res.destroy(err);
    }
  });
};

