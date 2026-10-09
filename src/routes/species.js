'use strict';

/**
 * Species and neophyte routes: occurrence list (for hotspot maps), spread
 * fronts per species, and CSV exports for Info Flora / GBIF (Darwin Core)
 * and iNaturalist. Registered from app.js as `require('./routes/species')(app, ctx)`.
 *
 * Human review: verified PRO members and moderation confirm, correct or
 * reject the automatic identification of a photo (four eyes: not their own
 * photo, except moderation). Exports can be limited to reviewed finds.
 */

const { listOccurrences, speciesSummary, parseFilters, REVIEW_SCHEMA, binomial } = require('../occurrences');
const { canSeeProtected, isModerator } = require('../auth');
const { spreadFronts } = require('../spread');
const { darwinCoreCsv, inaturalistCsv } = require('../export');

module.exports = function speciesRoutes(app, { db, spotRadiusM = 25, publicUrl = process.env.PUBLIC_URL, visibleSql = null } = {}) {
  db.exec(REVIEW_SCHEMA);
  const mayReview = (user) => Boolean(user && (canSeeProtected(user) || isModerator(user)));
  /** Parses the shared filter parameters, answering 400 on bad input. */
  const filters = (req, res) => {
    try {
      return { ...parseFilters(req.query), spotRadiusM, ...(visibleSql ? { visibleSql: visibleSql(req, 'p') } : {}) };
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
      return null;
    }
  };

  const baseUrl = (req) => (publicUrl ? String(publicUrl).replace(/\/+$/, '') : `${req.protocol}://${req.get('host')}`);

  app.get('/api/species', (req, res) => {
    const f = filters(req, res);
    if (f) res.json(speciesSummary(db, f));
  });

  app.get('/api/occurrences', (req, res) => {
    const f = filters(req, res);
    if (!f) return;
    res.json(listOccurrences(db, f).map((o) => ({
      photoId: o.photoId,
      spotId: o.spotId,
      takenAt: new Date(o.takenAt).toISOString(),
      lat: o.lat,
      lon: o.lon,
      uncertaintyM: o.uncertaintyM,
      scientificName: o.scientificName,
      commonName: o.commonName,
      score: o.score,
      neophyte: o.neophyte || null,
      verification: o.verification,
      url: `/uploads/${o.file}`,
    })));
  });

  /* ---------- Human review ---------- */

  /**
   * Finds waiting for review (best candidate, not reviewed yet), newest first, with all
   * Pl@ntNet candidates of the photo; for reviewers only. Same filters as /api/occurrences.
   */
  app.get('/api/identifications/review', (req, res) => {
    if (!mayReview(req.user)) return res.status(req.user ? 403 : 401).json({ error: 'Prüfen dürfen verifizierte PRO-Mitglieder und die Moderation' });
    const f = filters(req, res);
    if (!f) return;
    const candidates = db.prepare('SELECT scientific_name, common_name, score, neophyte FROM identifications WHERE photo_id = ? ORDER BY score DESC, id');
    const uploader = db.prepare('SELECT uploader_id FROM photos WHERE id = ?');
    const open = listOccurrences(db, f).filter((o) => !o.verification).reverse().slice(0, 200);
    res.json(open.map((o) => ({
      photoId: o.photoId, spotId: o.spotId, takenAt: new Date(o.takenAt).toISOString(), url: `/uploads/${o.file}`,
      scientificName: o.scientificName, commonName: o.commonName, score: o.score, neophyte: o.neophyte || null,
      own: Boolean(req.user && uploader.get(o.photoId)?.uploader_id === req.user.id),
      candidates: candidates.all(o.photoId).map((c) => ({ scientificName: c.scientific_name, commonName: c.common_name, score: c.score, neophyte: c.neophyte })),
    })));
  });

  /** { status: 'bestaetigt' | 'abgelehnt' } or { status: 'korrigiert', scientificName } */
  app.put('/api/photos/:id/identification-review', (req, res) => {
    if (!mayReview(req.user)) return res.status(req.user ? 403 : 401).json({ error: 'Prüfen dürfen verifizierte PRO-Mitglieder und die Moderation' });
    const id = Number(req.params.id);
    const photo = Number.isSafeInteger(id) && db.prepare('SELECT id, uploader_id FROM photos WHERE id = ?').get(id);
    if (!photo) return res.status(404).json({ error: 'Foto nicht gefunden' });
    if (photo.uploader_id === req.user.id && !isModerator(req.user)) return res.status(403).json({ error: 'Die eigene Bestimmung prüft jemand anderes' });
    const best = db.prepare('SELECT scientific_name FROM identifications WHERE photo_id = ? ORDER BY score DESC, id LIMIT 1').get(id);
    if (!best) return res.status(409).json({ error: 'Das Foto hat keine Bestimmung' });
    const status = req.body?.status;
    let name = best.scientific_name;
    if (status === 'korrigiert') {
      name = String(req.body?.scientificName || '').trim().replace(/\s+/g, ' ');
      // A Latin name: genus, and species (and more) if known.
      if (!/^[A-Z][a-z-]+( [a-z-]+){0,3}( (subsp|var|f)\. [a-z-]+)?$/.test(name) || name.length > 100) {
        return res.status(400).json({ error: 'Lateinischen Artnamen angeben, z. B. "Impatiens glandulifera"' });
      }
      if (binomial(name) === binomial(best.scientific_name)) return res.status(400).json({ error: 'Das ist die vorgeschlagene Art: bitte bestätigen' });
    } else if (status !== 'bestaetigt' && status !== 'abgelehnt') {
      return res.status(400).json({ error: 'status: bestaetigt, korrigiert oder abgelehnt' });
    }
    db.prepare(`INSERT INTO identification_reviews (photo_id, status, scientific_name, reviewer_id, reviewed_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (photo_id) DO UPDATE SET status = excluded.status, scientific_name = excluded.scientific_name,
        reviewer_id = excluded.reviewer_id, reviewed_at = excluded.reviewed_at`)
      .run(id, status, status === 'abgelehnt' ? null : name, req.user.id, Date.now());
    res.json({ photoId: id, status, scientificName: status === 'abgelehnt' ? null : name });
  });

  app.delete('/api/photos/:id/identification-review', (req, res) => {
    if (!mayReview(req.user)) return res.status(req.user ? 403 : 401).json({ error: 'Prüfen dürfen verifizierte PRO-Mitglieder und die Moderation' });
    const row = db.prepare('SELECT reviewer_id FROM identification_reviews WHERE photo_id = ?').get(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Keine Prüfung vorhanden' });
    if (row.reviewer_id !== req.user.id && !isModerator(req.user)) return res.status(403).json({ error: 'Nur wer geprüft hat oder die Moderation' });
    db.prepare('DELETE FROM identification_reviews WHERE photo_id = ?').run(Number(req.params.id));
    res.status(204).end();
  });

  app.get('/api/spread', (req, res) => {
    if (!req.query.species) return res.status(400).json({ error: 'Parameter "species" fehlt' });
    const f = filters(req, res);
    if (!f) return;
    const buffer = req.query.buffer === undefined ? 25 : Number(req.query.buffer);
    if (!Number.isFinite(buffer) || buffer < 0 || buffer > 1000) return res.status(400).json({ error: 'buffer muss zwischen 0 und 1000 m liegen' });
    // shape=convex: convex hull; otherwise alpha shape with α in metres (`alpha`, default automatic).
    let alpha = 'auto';
    if (req.query.shape === 'convex') alpha = null;
    else if (req.query.alpha !== undefined && req.query.alpha !== '' && req.query.alpha !== 'auto') {
      alpha = Number(req.query.alpha);
      if (!Number.isFinite(alpha) || alpha < 10 || alpha > 5000) return res.status(400).json({ error: 'alpha muss zwischen 10 und 5000 m liegen' });
    }
    const occ = listOccurrences(db, f);
    const first = occ[0];
    res.json({
      scientificName: first ? first.scientificName : String(req.query.species),
      commonName: first ? (first.neophyte || first.commonName) : null,
      neophyte: first ? first.neophyte || null : null,
      count: occ.length,
      ...spreadFronts(occ, { buffer, alpha }),
    });
  });

  const exportRoute = (render, suffix) => (req, res) => {
    const f = filters(req, res);
    if (!f) return;
    const csv = render(listOccurrences(db, f), { base: baseUrl(req) });
    const day = new Date().toISOString().slice(0, 10);
    res.set('Content-Disposition', `attachment; filename="myforrest-${suffix}-${day}.csv"`);
    res.type('text/csv; charset=utf-8').send(csv);
  };
  app.get('/api/export/dwc.csv', exportRoute(darwinCoreCsv, 'darwin-core'));
  app.get('/api/export/inaturalist.csv', exportRoute(inaturalistCsv, 'inaturalist'));
};
