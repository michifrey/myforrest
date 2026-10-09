'use strict';

/**
 * Landscape profiles of spots and the glacier view (src/landscapes.js, src/glaciers.js).
 *
 *   PUT /api/spots/:id/landscape   { landscape: 'wald' | 'gletscher' | null } sets the profile by hand;
 *                                  null determines it again (glacier outlines)
 *   GET /api/glaciers?bbox=&year=  glacier outlines as GeoJSON (all inventories, or one year)
 *   GET /api/spots/:id/archive-suggestions        archive pictures near the spot (ARCHIV_KATALOG)
 *   POST /api/spots/:id/archive-suggestions/:item take one over as an archive photo of the spot
 *   GET /api/spots/:id/glacier     the glacier at a spot: name, distance to the ice of the latest
 *                                  inventory, where the ice was in each inventory year, and the
 *                                  snow and ice share of late summer from Sentinel-2
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isLandscape, landscapeOf } = require('../landscapes');

module.exports = function registerLandscapes(app, {
  db, glaciers, glamos = null, archives = null, processUpload = null, tmpDir = null, vegetation, accounts, classifySpot, spotJson, idParam,
}) {
  db.exec(`CREATE TABLE IF NOT EXISTS archive_imports (
    spot_id INTEGER NOT NULL REFERENCES spots (id) ON DELETE CASCADE, item_id TEXT NOT NULL,
    photo_id INTEGER REFERENCES photos (id) ON DELETE CASCADE, created_at INTEGER NOT NULL,
    PRIMARY KEY (spot_id, item_id))`);
  /** The spot, when `req` may see at least one of its photos. */
  const visibleSpot = (req, id) => db.prepare(`SELECT s.id, s.lat, s.lon, s.landscape, s.heading FROM spots s
    WHERE s.id = ? AND EXISTS (SELECT 1 FROM photos p WHERE p.spot_id = s.id AND ${accounts.visibleSql(req, 'p')})`).get(id);

  app.put('/api/spots/:id/landscape', (req, res) => {
    const id = idParam(req, res);
    if (id === null) return;
    if (!visibleSpot(req, id)) return res.status(404).json({ error: 'Spot nicht gefunden' });
    const value = req.body?.landscape ?? null;
    if (value !== null && !isLandscape(value)) return res.status(400).json({ error: 'Unbekannte Landschaft' });
    if (value === null) {
      db.prepare('UPDATE spots SET landscape = NULL, landscape_source = NULL WHERE id = ?').run(id);
      classifySpot(id);
    } else {
      classifySpot(id, value, 'manual');
    }
    res.json(spotJson(id, req));
  });

  app.get('/api/glaciers', (req, res) => {
    const b = String(req.query.bbox || '').split(',').map(Number);
    if (b.length !== 4 || b.some((v) => !Number.isFinite(v)) || b[0] >= b[2] || b[1] >= b[3]) {
      return res.status(400).json({ error: 'bbox=west,süd,ost,nord angeben' });
    }
    const year = req.query.year ? Number(req.query.year) : null;
    if (year !== null && !Number.isInteger(year)) return res.status(400).json({ error: 'Ungültiges Jahr' });
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ years: glaciers.years(), ...glaciers.geojson(b, { year }) });
  });

  app.get('/api/spots/:id/glacier', (req, res) => {
    const id = idParam(req, res);
    if (id === null) return;
    const spot = visibleSpot(req, id);
    if (!spot) return res.status(404).json({ error: 'Spot nicht gefunden' });
    const glacier = glaciers.at(spot.lat, spot.lon);
    res.json({
      landscape: landscapeOf(spot.landscape),
      outlines: glaciers.enabled(),
      glacier,
      // Length change of the tongue (GLAMOS_CSV), matched by SGI id or name.
      length: glamos ? glamos.forGlacier(glacier) : null,
      satellite: vegetation.ice(id),
    });
  });

  /* ---------- Archive pictures from open collections (src/archives.js) ---------- */

  const imported = db.prepare('SELECT item_id, photo_id FROM archive_imports WHERE spot_id = ?');
  const itemJson = (it, done) => ({
    id: it.id, title: it.title, year: it.year, date: new Date(it.takenAt).toISOString().slice(0, 10), distanceM: it.distanceM,
    heading: it.heading, source: it.source, license: it.license, page: it.page,
    importable: Boolean(it.licenseKey && it.image), photoId: done ?? null,
  });

  /** Archive pictures near the spot, from the catalogue (ARCHIV_KATALOG). */
  app.get('/api/spots/:id/archive-suggestions', (req, res) => {
    const id = idParam(req, res);
    if (id === null) return;
    const spot = visibleSpot(req, id);
    if (!spot) return res.status(404).json({ error: 'Spot nicht gefunden' });
    if (!archives?.enabled()) return res.json({ enabled: false, items: [] });
    const done = new Map(imported.all(id).map((r) => [r.item_id, r.photo_id]));
    res.json({ enabled: true, items: archives.near(spot).slice(0, 20).map((it) => itemJson(it, done.get(it.id))) });
  });

  /** Takes a catalogue picture over as an archive photo of the spot (login; licence must allow it). */
  app.post('/api/spots/:id/archive-suggestions/:itemId', async (req, res) => {
    const id = idParam(req, res);
    if (id === null) return;
    if (!req.user) return res.status(401).json({ error: 'Bitte anmelden' });
    const spot = visibleSpot(req, id);
    if (!spot) return res.status(404).json({ error: 'Spot nicht gefunden' });
    const item = archives?.byId(String(req.params.itemId));
    if (!item || !archives.near(spot).some((it) => it.id === item.id)) return res.status(404).json({ error: 'Archivbild nicht gefunden' });
    if (!item.licenseKey || !item.image) return res.status(409).json({ error: 'Die Lizenz dieses Bilds erlaubt keine Übernahme; der Link führt zum Bildarchiv' });
    if (imported.all(id).some((r) => r.item_id === item.id)) return res.status(409).json({ error: 'Schon übernommen' });
    const file = path.join(tmpDir, `archiv-${crypto.randomUUID()}`);
    try {
      await archives.download(item, file);
      const ref = db.prepare('SELECT id FROM photos WHERE spot_id = ? AND hidden_at IS NULL ORDER BY taken_at DESC LIMIT 1').get(id);
      const note = [`Archivbild: ${item.title}`, item.source, item.license, item.page].filter(Boolean).join(' · ');
      const [status, body] = await processUpload([{ path: file, originalname: `${item.id}.jpg` }], null, {
        spotId: String(id), archive: '1', takenAt: new Date(item.takenAt).toISOString(), note, refPhotoId: ref ? String(ref.id) : undefined,
        // The picture's own licence; given as the default so the account's default licence stays as it is.
      }, { user: { ...req.user, default_license: item.licenseKey }, body: { license: item.licenseKey } });
      if (status === 201 && body.created?.length) {
        db.prepare('INSERT INTO archive_imports (spot_id, item_id, photo_id, created_at) VALUES (?, ?, ?, ?)').run(id, item.id, body.created[0].id, Date.now());
      }
      res.status(status).json(body);
    } catch (err) {
      res.status(502).json({ error: `Archivbild nicht übernommen: ${err.message}` });
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
};
