'use strict';

/**
 * Landscape profiles of spots and the glacier view (src/landscapes.js, src/glaciers.js).
 *
 *   PUT /api/spots/:id/landscape   { landscape: 'wald' | 'gletscher' | null } sets the profile by hand;
 *                                  null determines it again (glacier outlines)
 *   GET /api/glaciers?bbox=&year=  glacier outlines as GeoJSON (all inventories, or one year)
 *   GET /api/spots/:id/glacier     the glacier at a spot: name, distance to the ice of the latest
 *                                  inventory, where the ice was in each inventory year, and the
 *                                  snow and ice share of late summer from Sentinel-2
 */

const { isLandscape, landscapeOf } = require('../landscapes');

module.exports = function registerLandscapes(app, { db, glaciers, vegetation, accounts, classifySpot, spotJson, idParam }) {
  /** The spot, when `req` may see at least one of its photos. */
  const visibleSpot = (req, id) => db.prepare(`SELECT s.id, s.lat, s.lon, s.landscape FROM spots s
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
    res.json({
      landscape: landscapeOf(spot.landscape),
      outlines: glaciers.enabled(),
      glacier: glaciers.at(spot.lat, spot.lon),
      satellite: vegetation.ice(id),
    });
  });
};
