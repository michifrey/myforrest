'use strict';

/**
 * Protected finds (rare plants, fungi): photos with `protected = 1` are seen
 * exactly only by verified PRO members, moderation and their uploader (see
 * visibleSql in src/moderation.js). Everyone else gets a coarse grid, so the
 * map still shows that something protected was found in a 5-km square:
 *
 *   GET /api/protected/cells   [{ bbox: [w, s, e, n], spots }] for the cells with protected finds
 *                              the viewer cannot see; [] for PRO members and moderation
 *   GET    /api/protected-species              loaded protection lists per canton
 *   GET    /api/protected-species/check?name=&spot=  whether (and by which list) a species is protected there
 *   POST   /api/protected-species/import       admins: CSV `kanton;art;status;quelle` (replaces those cantons)
 *   DELETE /api/protected-species/:canton      admins: remove a canton's list
 *
 * The grid is fixed in degrees (0.045° latitude × 0.065° longitude, about
 * 5 × 5 km in Central Europe), so a cell never moves with the data.
 */

const CELL_LAT = 0.045;
const CELL_LON = 0.065;

const express = require('express');

module.exports = function registerProtection(app, { db, accounts, sensitiveLists, cantons, reprotect }) {
  /** Admins only (a server without accounts, the prototype, stays open). */
  const adminOnly = (req, res, next) => {
    const hasUsers = db.prepare('SELECT 1 FROM users LIMIT 1').get();
    if (hasUsers && req.user?.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' });
    return next();
  };

  app.get('/api/protected-species', (req, res) => res.json(sensitiveLists.status()));

  app.get('/api/protected-species/check', async (req, res) => {
    const name = String(req.query.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Parameter "name" fehlt' });
    const spot = Number(req.query.spot);
    const canton = Number.isSafeInteger(spot) && spot > 0 ? await cantons.ofSpot(spot) : null;
    res.json({ name, canton, protected: sensitiveLists.why(name, canton) });
  });

  app.post('/api/protected-species/import', adminOnly, express.text({ type: () => true, limit: '5mb' }), (req, res) => {
    try {
      const result = sensitiveLists.importCsv(typeof req.body === 'string' ? req.body : '', { replace: req.query.replace !== '0' });
      // Finds already identified as one of these species are protected now.
      res.json({ ...result, protectedPhotos: reprotect() });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/protected-species/:canton', adminOnly, (req, res) => {
    res.json({ removed: sensitiveLists.remove(req.params.canton) });
  });

  app.get('/api/protected/cells', (req, res) => {
    if (accounts.canSeeProtected(req)) return res.json([]);
    // Spots with a protected photo that this viewer may not see; spots that are visible anyway are left out.
    const visible = accounts.visibleSpotIds(req);
    const rows = db.prepare(`SELECT DISTINCT s.id, s.lat, s.lon FROM spots s JOIN photos p ON p.spot_id = s.id
      WHERE p.hidden_at IS NULL AND p.protected = 1`).all().filter((s) => !visible.has(s.id));
    const cells = new Map();
    for (const s of rows) {
      const i = Math.floor(s.lat / CELL_LAT);
      const j = Math.floor(s.lon / CELL_LON);
      const key = `${i}:${j}`;
      if (!cells.has(key)) cells.set(key, { bbox: [j * CELL_LON, i * CELL_LAT, (j + 1) * CELL_LON, (i + 1) * CELL_LAT].map((v) => Math.round(v * 1e6) / 1e6), spots: 0 });
      cells.get(key).spots += 1;
    }
    res.set('Cache-Control', 'private, max-age=60').json([...cells.values()]);
  });
};
