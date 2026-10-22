'use strict';

/**
 * OpenStreetMap and Wikimedia around a spot (src/wikimedia.js).
 *
 *   GET  /api/spots/:id/wikimedia          Wikidata items and OSM objects linked to them within 500 m,
 *                                          photos on Wikimedia Commons within 1 km
 *   POST /api/spots/:id/wikimedia/photos   { file } takes a Commons photo over as an archive photo of the spot
 *                                          (login; dated, with a licence MyForrest allows)
 */

module.exports = function registerWikimedia(app, { wikimedia, landscapes, idParam }) {
  const { importPicture, importedItems, visibleSpot } = landscapes;
  const importable = (p) => Boolean(p.licenseKey && p.takenAt !== null);

  app.get('/api/spots/:id/wikimedia', async (req, res) => {
    const id = idParam(req, res);
    if (id === null) return;
    const spot = visibleSpot(req, id);
    if (!spot) return res.status(404).json({ error: 'Spot nicht gefunden' });
    if (!wikimedia.enabled()) return res.json({ enabled: false, items: [], photos: [] });
    const done = importedItems(id);
    let d;
    try {
      d = await wikimedia.near(spot.lat, spot.lon);
    } catch (err) {
      return res.status(502).json({ error: `Wikimedia nicht erreichbar: ${err.message}` });
    }
    res.json({
      enabled: true, osm: d.osm, errors: d.errors, items: d.items,
      photos: d.photos.map(({ takenAt, licenseKey, image, ...p }) => ({ ...p, importable: importable({ takenAt, licenseKey }), photoId: done.get(p.id) ?? null })),
      editUrl: `https://www.openstreetmap.org/edit#map=19/${spot.lat.toFixed(6)}/${spot.lon.toFixed(6)}`,
    });
  });

  app.post('/api/spots/:id/wikimedia/photos', async (req, res) => {
    const id = idParam(req, res);
    if (id === null) return;
    if (!req.user) return res.status(401).json({ error: 'Bitte anmelden' });
    const spot = visibleSpot(req, id);
    if (!spot) return res.status(404).json({ error: 'Spot nicht gefunden' });
    if (!wikimedia.enabled()) return res.status(404).json({ error: 'Wikimedia ist ausgeschaltet' });
    const file = String(req.body?.file || '');
    // Only a photo the search around the spot found: the server never downloads an address from the browser.
    let photo;
    try {
      photo = (await wikimedia.near(spot.lat, spot.lon)).photos.find((p) => p.file === file);
    } catch (err) {
      return res.status(502).json({ error: `Wikimedia nicht erreichbar: ${err.message}` });
    }
    if (!photo) return res.status(404).json({ error: 'Foto nicht gefunden' });
    if (!importable(photo)) return res.status(409).json({ error: 'Ohne Aufnahmedatum oder mit dieser Lizenz lässt sich das Foto nicht übernehmen; der Link führt zu Commons' });
    await importPicture(req, res, id, {
      id: photo.id, title: photo.title, takenAt: photo.takenAt, licenseKey: photo.licenseKey,
      source: ['Wikimedia Commons', photo.author].filter(Boolean).join(', '), license: photo.license, page: photo.page,
    }, (dest) => wikimedia.download(photo, dest));
  });
};
