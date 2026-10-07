'use strict';

/*
 * Climate extras on top of the weather context: storm events linked to
 * windthrow (storms.js), regional phenology reference series (phenoref.js)
 * and nocturnal cooling in hollows (nightcool.js). Registered from app.js
 * with one line; returns the hooks the photo analysis calls.
 */

const express = require('express');
const { createStorms, likelyStorm, stormText, stormIrregularities, STORM_GUST } = require('../storms');
const { createNightCool, frostSummary } = require('../nightcool');
const { createPhenoRef } = require('../phenoref');
const { microShift } = require('../phenology');

const DAY = 86400000;
const LOOKBACK = 365 * DAY; // before the first photo: where windthrow on the first photo may come from
const RETRY_AFTER = 10 * 60000;

module.exports = function registerClimate(app, {
  db, weatherFetch = fetch, phenoFetch = weatherFetch, getPhoto, terrainOf, background = (p) => p, reassessSpot = () => {},
  now = () => Date.now(),
}) {
  const storms = createStorms({ db, fetchImpl: weatherFetch, now });
  const nightcool = createNightCool({ db, fetchImpl: weatherFetch, now });
  const phenoref = createPhenoRef({ db, fetchImpl: phenoFetch, now });

  const spotRow = db.prepare('SELECT id, lat, lon, elevation FROM spots WHERE id = ?');
  const spotPhotos = db.prepare('SELECT id, taken_at, change_json FROM photos WHERE spot_id = ? ORDER BY taken_at, id');
  const tagsOf = db.prepare('SELECT tag FROM photo_tags WHERE photo_id = ?');
  const iso = (t) => new Date(t).toISOString();

  const windthrowOf = (p) => {
    const change = p.change_json ? JSON.parse(p.change_json) : null;
    return Boolean((change?.summary || []).find((s) => s.class === 'windwurf' && s.area >= 0.02)) ||
      tagsOf.all(p.id).some((t) => t.tag === 'sturmschaden');
  };

  /**
   * Interval in which a storm could have caused what the photo shows: since
   * the latest earlier photo of the spot without windthrow (a 12-month look
   * back for the first photo).
   */
  function stormInterval(photo) {
    const earlier = spotPhotos.all(photo.spot_id).filter((p) => p.taken_at < photo.taken_at);
    const calm = [...earlier].reverse().find((p) => !windthrowOf(p));
    const from = calm ? calm.taken_at : (earlier[0]?.taken_at ?? photo.taken_at) - (earlier.length ? 0 : LOOKBACK);
    return { from: iso(from), to: iso(photo.taken_at) };
  }

  /** Adds storm events and model nights to a freshly computed photo context (network). */
  async function enrich(photo, ctx, { elevation = null } = {}) {
    const first = spotPhotos.all(photo.spot_id)[0]?.taken_at ?? photo.taken_at;
    try {
      ctx.storms = await storms.between(photo.lat, photo.lon, Math.min(first, photo.taken_at) - LOOKBACK, photo.taken_at);
    } catch (err) {
      ctx.storms = null;
      ctx.stormsError = err.message;
    }
    try {
      ctx.nights = await nightcool.nightsBefore(photo.lat, photo.lon, photo.taken_at, { elevation });
    } catch (err) {
      ctx.nights = null;
      ctx.nightsError = err.message;
    }
  }

  /** Reference colouring per species at a spot: { sci: reference at the spot's altitude }. */
  function phenoRefFor(spotId, sciList) {
    const spot = spotRow.get(spotId);
    if (!spot || !sciList.length) return {};
    return phenoref.forPlace(sciList, { lat: spot.lat, lon: spot.lon, elevation: spot.elevation });
  }

  /** Expected start of colouring of one species at a spot from the reference series, or null. */
  function colourHere(spotId, tree, terrain = terrainOf(spotId)) {
    if (!tree.colourDoy) return null;
    const ref = phenoRefFor(spotId, [tree.sci])[tree.sci];
    return ref ? { doy: ref.doy + microShift(terrain), ref } : null;
  }

  /**
   * Synchronous part, run whenever irregularities are (re)assessed: derives
   * the frost estimate and storm link from the stored context and returns
   * what assess() needs plus the storm irregularities.
   */
  function decorate(photo, ctx, terrain, species = []) {
    const nightFrost = ctx.nights ? frostSummary(ctx.nights, terrain, photo.taken_at) : null;
    ctx.nightFrost = nightFrost;
    const interval = ctx.storms ? stormInterval(photo) : null;
    const windthrow = windthrowOf(photo);
    const likely = interval ? likelyStorm(ctx.storms, Date.parse(interval.from), Date.parse(interval.to)) : null;
    ctx.stormLink = interval ? { ...interval, windthrow, storm: likely, text: likely ? `vermutlich ${stormText(likely)}` : null } : null;
    return {
      nightFrost,
      phenoRef: phenoRefFor(photo.spot_id, species.filter((t) => t.colourDoy).map((t) => t.sci)),
      irregularities: stormIrregularities({ events: ctx.storms, interval, windthrow, landform: terrain.landform }),
    };
  }

  /* ---------- Routes ---------- */

  const idOf = (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Ungültige ID' });
      return null;
    }
    return id;
  };

  /** Storm events at a spot since a year before its first photo, with links to windthrow photos. */
  app.get('/api/spots/:id/storms', async (req, res) => {
    const id = idOf(req, res);
    if (id === null) return;
    const spot = spotRow.get(id);
    const photos = spot ? spotPhotos.all(id) : [];
    if (!photos.length) return res.status(404).json({ error: 'Spot nicht gefunden' });
    const from = photos[0].taken_at - LOOKBACK;
    let events;
    try {
      events = await storms.between(spot.lat, spot.lon, from, now());
    } catch (err) {
      return res.json({ threshold: STORM_GUST, events: [], error: err.message });
    }
    const linked = new Map();
    for (const p of photos) {
      if (!windthrowOf(p)) continue;
      const full = getPhoto.get(p.id);
      const i = stormInterval(full);
      const s = likelyStorm(events, Date.parse(i.from), Date.parse(i.to));
      if (s) linked.set(s.date, [...(linked.get(s.date) || []), p.id]);
    }
    res.json({
      threshold: STORM_GUST,
      from: iso(from),
      // Before the first photo only storms that explain windthrow are of interest.
      events: events
        .filter((e) => Date.parse(`${e.date}T23:59:59Z`) >= photos[0].taken_at || linked.has(e.date))
        .map((e) => ({ ...e, text: stormText(e), windthrowPhotos: linked.get(e.date) || [] })),
    });
  });

  /** Most likely storm between two photos of a spot (for the before/after view). */
  app.get('/api/photos/:id/storm', async (req, res) => {
    const id = idOf(req, res);
    if (id === null) return;
    const a = getPhoto.get(id);
    const b = getPhoto.get(Number(req.query.to));
    if (!a || !b) return res.status(404).json({ error: 'Foto nicht gefunden' });
    const [from, to] = [Math.min(a.taken_at, b.taken_at), Math.max(a.taken_at, b.taken_at)];
    try {
      const events = await storms.between(a.lat, a.lon, from, to);
      const s = likelyStorm(events, from, to);
      res.json({ from: iso(from), to: iso(to), events, storm: s, text: s ? `vermutlich ${stormText(s)}` : null });
    } catch (err) {
      res.json({ from: iso(from), to: iso(to), events: [], storm: null, error: err.message });
    }
  });

  // Map badges come from the cache only; missing spots are looked up in the background.
  const failed = new Map();
  let queue = Promise.resolve();
  const queued = new Set();
  app.get('/api/storms/spots', (req, res) => {
    const rows = db.prepare(`
      SELECT s.id, s.lat, s.lon, MIN(p.taken_at) AS first FROM spots s JOIN photos p ON p.spot_id = s.id GROUP BY s.id`).all();
    const out = [];
    for (const r of rows) {
      const events = storms.cachedBetween(r.lat, r.lon, r.first, now());
      if (events === null) {
        const key = `${r.lat.toFixed(1)},${r.lon.toFixed(1)}`;
        if (!queued.has(key) && !(now() - (failed.get(key) || 0) < RETRY_AFTER)) {
          queued.add(key);
          queue = queue.then(() => storms.between(r.lat, r.lon, r.first, now()))
            .catch(() => failed.set(key, now()))
            .finally(() => queued.delete(key));
          background(queue);
        }
        continue;
      }
      if (!events.length) continue;
      const max = events.reduce((m, e) => (e.gust > m.gust ? e : m));
      const last = events[events.length - 1];
      out.push({ spotId: r.id, count: events.length, max: { ...max, text: stormText(max) }, last: { ...last, text: stormText(last) } });
    }
    res.json(out);
  });

  /* Phenology reference series */

  const reassessAll = () => {
    for (const { id } of db.prepare('SELECT id FROM spots').all()) reassessSpot(id);
  };

  app.get('/api/phenoref', (req, res) => res.json(phenoref.status()));

  app.get('/api/spots/:id/phenoref', (req, res) => {
    const id = idOf(req, res);
    if (id === null) return;
    const spot = spotRow.get(id);
    if (!spot) return res.status(404).json({ error: 'Spot nicht gefunden' });
    const { TREES } = require('../trees');
    const terrain = terrainOf(id);
    const refs = phenoRefFor(id, TREES.filter((t) => t.colourDoy).map((t) => t.sci));
    res.json(Object.values(refs).map((r) => ({ ...r, doyHere: r.doy + microShift(terrain) })));
  });

  /**
   * Reference data changes every spot's assessment: once accounts exist, only
   * admins may load or import it (without accounts the prototype stays open).
   */
  const adminOnly = (req, res, next) => {
    const hasUsers = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()
      && db.prepare('SELECT 1 FROM users LIMIT 1').get();
    if (hasUsers && req.user?.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' });
    return next();
  };

  /** Downloads the DWD annual-reporter series (needs access to opendata.dwd.de). */
  app.post('/api/phenoref/sync', adminOnly, async (req, res) => {
    try {
      const result = await phenoref.syncDwd();
      reassessAll();
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: `DWD-Daten nicht verfügbar: ${err.message}` });
    }
  });

  /**
   * Imports a file as text: `?format=generic` (CSV source;station_id;…;doy)
   * or `?format=dwd&kind=stations|plants|phases|observations&name=<DWD file name>`.
   * Description files (plants, phases) are kept for the following observation imports.
   */
  const pendingDwd = { plants: '', phases: '' };
  app.post('/api/phenoref/import', adminOnly, express.text({ type: () => true, limit: '80mb' }), (req, res) => {
    const text = typeof req.body === 'string' ? req.body : '';
    if (!text.trim()) return res.status(400).json({ error: 'Leere Datei' });
    let result;
    if (req.query.format === 'generic') {
      result = phenoref.importGeneric(text);
    } else if (req.query.format === 'dwd') {
      const kind = String(req.query.kind || 'observations');
      if (kind === 'plants' || kind === 'phases') {
        pendingDwd[kind] = text;
        return res.json({ stored: kind });
      }
      result = kind === 'stations'
        ? phenoref.importDwd({ stations: text })
        : phenoref.importDwd({ ...pendingDwd, files: [{ name: String(req.query.name || ''), text }] });
    } else {
      return res.status(400).json({ error: 'Parameter "format" (dwd oder generic) fehlt' });
    }
    reassessAll();
    res.json(result);
  });

  return { enrich, decorate, colourHere, stormInterval, storms, nightcool, phenoref };
};
