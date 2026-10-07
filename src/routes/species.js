'use strict';

/**
 * Species and neophyte routes: occurrence list (for hotspot maps), spread
 * fronts per species, and CSV exports for Info Flora / GBIF (Darwin Core)
 * and iNaturalist. Registered from app.js as `require('./routes/species')(app, ctx)`.
 */

const { listOccurrences, speciesSummary, parseFilters } = require('../occurrences');
const { spreadFronts } = require('../spread');
const { darwinCoreCsv, inaturalistCsv } = require('../export');

module.exports = function speciesRoutes(app, { db, spotRadiusM = 25, publicUrl = process.env.PUBLIC_URL } = {}) {
  /** Parses the shared filter parameters, answering 400 on bad input. */
  const filters = (req, res) => {
    try {
      return { ...parseFilters(req.query), spotRadiusM };
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
      url: `/uploads/${o.file}`,
    })));
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
