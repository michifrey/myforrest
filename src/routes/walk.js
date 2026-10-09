'use strict';

/**
 * Walk-through ("Durchgehen"): step from picture to picture like Street View.
 *
 *   GET /api/walk/:photoId?at=<ISO date>
 *   GET /api/walk/mapillary/:imageId        a Mapillary picture as the place one stands
 *   GET /api/mapillary/images?bbox=         Mapillary pictures for the map layer
 *   GET /api/mapillary/images/:id/file      the picture itself (served from here, cached)
 *
 * Returns the photo and the ways on from it:
 *   - `weg`:  the previous and next photo of the same recording (video, drive,
 *             upload batch; photos.sequence_id; for Mapillary its sequence),
 *             when not farther than 500 m;
 *   - `spot`: other spots within 80 m, one photo each (a panorama if there is
 *             one, the one closest in time to `at`), at most one per 45° sector
 *             (the nearest), so the ring stays readable;
 *   - `mapillary`: Mapillary pictures within 80 m (src/mapillary.js, with a
 *             token), in the sectors left free by own pictures: they fill the
 *             gaps, own pictures keep the lead;
 *   - `times`: the other photos of the same spot, for time travel on the spot.
 * Each way carries its bearing (° from north) and distance, so the client
 * places the arrows. `track` is the recording's path for the mini map.
 * Only photos the viewer may see are used (hidden and protected ones per
 * accounts.visibleSql).
 */

const { distanceM } = require('../geo');

const SEQUENCE_MAX_M = 500;
const NEAR_M = 80;
const TRACK_MAX = 400;

function bearing(a, b) {
  const rad = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * rad) * Math.cos(b.lat * rad);
  const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lon - a.lon) * rad);
  return ((Math.atan2(y, x) / rad) + 360) % 360;
}

const sectorOf = (deg) => Math.round(deg / 45) % 8;

/**
 * Adds `candidates` (the nearest per sector) to `links` in sectors no closer link holds yet; with
 * `freeOnly` only in sectors without any link (Mapillary leaves the lead to own pictures). Pictures
 * closer than 3 m have no direction to show, and none comes within 25° of an arrow already there.
 */
function fillSectors(links, candidates, { freeOnly = false } = {}) {
  const sectors = new Map();
  for (const l of candidates) {
    const sector = sectorOf(l.bearing);
    if (l.distanceM < 3) continue;
    // Two arrows almost on top of each other cannot be told apart: the one already there stays.
    if (links.some((w) => Math.abs(((w.bearing - l.bearing + 540) % 360) - 180) < 25)) continue;
    if (links.some((w) => sectorOf(w.bearing) === sector && (freeOnly || w.distanceM <= l.distanceM))) continue;
    const other = sectors.get(sector);
    if (!other || l.distanceM < other.distanceM) sectors.set(sector, l);
  }
  links.push(...[...sectors.values()].sort((a, b) => a.bearing - b.bearing));
}

module.exports = function registerWalk(app, { db, accounts, thumbs, mapillary = null }) {
  const visible = (req, alias = 'p') => accounts.visibleSql(req, alias);
  const photoBrief = (p) => ({
    id: p.id,
    spotId: p.spot_id,
    url: `/uploads/${p.file}`,
    ...thumbs.urls(p),
    lat: p.lat,
    lon: p.lon,
    heading: p.heading,
    panorama: Boolean(p.panorama),
    takenAt: new Date(p.taken_at).toISOString(),
    sequenceId: p.sequence_id ?? null,
  });
  // A Mapillary picture in the same shape; its id is "m<id>" so the client tells the two apart.
  const mapillaryBrief = (m) => ({
    id: `m${m.id}`,
    source: 'mapillary',
    spotId: null,
    url: `/api/mapillary/images/${m.id}/file`,
    largeUrl: `/api/mapillary/images/${m.id}/file`,
    lat: m.lat,
    lon: m.lon,
    heading: m.heading,
    panorama: m.panorama,
    takenAt: m.takenAt,
    sequenceId: m.sequence,
    creator: m.creator,
    pageUrl: mapillary.pageUrl(m.id),
    license: 'CC BY-SA 4.0',
  });
  const linkFrom = (here) => (brief, kind, extra = {}) => ({
    kind,
    ...brief,
    bearing: Math.round(bearing(here, brief) * 10) / 10,
    distanceM: Math.round(distanceM(here, brief)),
    ...extra,
  });

  /** Own spots near a place, one photo each (a panorama first, then the one closest in time to `at`). */
  function ownNear(req, here, at, excludeSpot = null) {
    const dLat = NEAR_M / 111320;
    const dLon = dLat / Math.cos((here.lat * Math.PI) / 180);
    const near = db.prepare(`SELECT * FROM photos p WHERE p.lat BETWEEN ? AND ? AND p.lon BETWEEN ? AND ?
      AND p.spot_id IS NOT ? AND ${visible(req)}`).all(here.lat - dLat, here.lat + dLat, here.lon - dLon, here.lon + dLon, excludeSpot);
    const bySpot = new Map();
    for (const p of near) {
      if (distanceM(here, p) > NEAR_M) continue;
      const best = bySpot.get(p.spot_id);
      const better = !best
        || (p.panorama && !best.panorama)
        || (Boolean(p.panorama) === Boolean(best.panorama) && Math.abs(p.taken_at - at) < Math.abs(best.taken_at - at));
      if (better) bySpot.set(p.spot_id, p);
    }
    return [...bySpot.values()];
  }

  /** Mapillary pictures near a place (none without a token or when Mapillary cannot be reached). */
  async function mapillaryNear(here) {
    if (!mapillary?.enabled()) return [];
    try {
      return (await mapillary.near(here.lat, here.lon, NEAR_M)).filter((m) => distanceM(here, m) <= NEAR_M);
    } catch {
      return [];
    }
  }

  app.get('/api/walk/:id', async (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Ungültige ID' });
    const photo = db.prepare(`SELECT * FROM photos p WHERE p.id = ? AND ${visible(req)}`).get(id);
    if (!photo) return res.status(404).json({ error: 'Foto nicht gefunden' });
    try {
      const at = req.query.at && Number.isFinite(Date.parse(req.query.at)) ? Date.parse(req.query.at) : photo.taken_at;
      const here = { lat: photo.lat, lon: photo.lon };
      const link = linkFrom(here);

      const links = [];
      let sequence = null;
      let track = [];
      if (photo.sequence_id) {
        const seq = db.prepare(`SELECT * FROM photos p WHERE p.sequence_id = ? AND ${visible(req)}
          ORDER BY p.taken_at, COALESCE(p.video_time, 0), p.id`).all(photo.sequence_id);
        const i = seq.findIndex((p) => p.id === photo.id);
        sequence = { id: photo.sequence_id, index: i, length: seq.length };
        for (const [p, dir] of [[seq[i - 1], 'zurueck'], [seq[i + 1], 'vor']]) {
          if (p && distanceM(here, p) <= SEQUENCE_MAX_M) links.push(link(photoBrief(p), 'weg', { direction: dir }));
        }
        const step = Math.max(1, Math.ceil(seq.length / TRACK_MAX));
        track = seq.filter((_, k) => k % step === 0 || k === seq.length - 1).map((p) => [p.lat, p.lon]);
      }

      // Other spots nearby; the spots of the recording's own steps are linked already.
      const linked = new Set(links.map((l) => l.spotId));
      fillSectors(links, ownNear(req, here, at, photo.spot_id).filter((p) => !linked.has(p.spot_id)).map((p) => link(photoBrief(p), 'spot')));
      fillSectors(links, (await mapillaryNear(here)).map((m) => link(mapillaryBrief(m), 'mapillary')), { freeOnly: true });

      const times = db.prepare(`SELECT * FROM photos p WHERE p.spot_id = ? AND ${visible(req)} ORDER BY p.taken_at, p.id`)
        .all(photo.spot_id).map(photoBrief);

      res.json({ photo: photoBrief(photo), links, times, sequence, track });
    } catch (err) {
      next(err);
    }
  });

  /* ---------- Mapillary ---------- */

  const mapillaryOff = (res) => res.status(404).json({ error: 'Mapillary ist nicht eingerichtet (MAPILLARY_TOKEN)' });

  app.get('/api/walk/mapillary/:id', async (req, res, next) => {
    if (!mapillary?.enabled()) return mapillaryOff(res);
    if (!/^\d{1,20}$/.test(req.params.id)) return res.status(400).json({ error: 'Ungültige ID' });
    try {
      const m = await mapillary.image(req.params.id);
      if (!m) return res.status(404).json({ error: 'Bild nicht gefunden' });
      const here = { lat: m.lat, lon: m.lon };
      const link = linkFrom(here);
      const around = await mapillaryNear(here);
      const links = [];
      // Along its sequence: the neighbours in time among the pictures nearby.
      const seq = around.filter((x) => x.sequence && x.sequence === m.sequence && x.id !== m.id);
      const before = seq.filter((x) => x.takenAt < m.takenAt).sort((a, b) => b.takenAt.localeCompare(a.takenAt))[0];
      const after = seq.filter((x) => x.takenAt > m.takenAt).sort((a, b) => a.takenAt.localeCompare(b.takenAt))[0];
      if (before) links.push(link(mapillaryBrief(before), 'weg', { direction: 'zurueck' }));
      if (after) links.push(link(mapillaryBrief(after), 'weg', { direction: 'vor' }));
      // Own spots first, then other Mapillary pictures.
      fillSectors(links, ownNear(req, here, Date.parse(m.takenAt) || Date.now()).map((p) => link(photoBrief(p), 'spot')));
      fillSectors(links, around.filter((x) => x.id !== m.id && x.sequence !== m.sequence).map((x) => link(mapillaryBrief(x), 'mapillary')), { freeOnly: true });
      res.json({ photo: mapillaryBrief(m), links, times: [], sequence: null, track: [] });
    } catch (err) {
      if (err.httpStatus || err.name === 'TimeoutError' || err instanceof TypeError) {
        return res.status(502).json({ error: `Mapillary nicht erreichbar (${err.message})` });
      }
      next(err);
    }
  });

  app.get('/api/mapillary/images', async (req, res, next) => {
    if (!mapillary?.enabled()) return mapillaryOff(res);
    const b = String(req.query.bbox || '').split(',').map(Number);
    if (b.length !== 4 || b.some((v) => !Number.isFinite(v)) || b[0] >= b[2] || b[1] >= b[3]) {
      return res.status(400).json({ error: 'bbox=west,süd,ost,nord angeben' });
    }
    try {
      res.json((await mapillary.inBox(b)).map(mapillaryBrief));
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      res.status(502).json({ error: `Mapillary nicht erreichbar (${err.message})` });
    }
  });

  app.get('/api/mapillary/images/:id/file', async (req, res) => {
    if (!mapillary?.enabled()) return mapillaryOff(res);
    if (!/^\d{1,20}$/.test(req.params.id)) return res.status(400).json({ error: 'Ungültige ID' });
    try {
      const file = await mapillary.file(req.params.id);
      res.set('Cache-Control', 'public, max-age=604800');
      res.type('jpeg').sendFile(file);
    } catch (err) {
      res.status(502).json({ error: `Bild von Mapillary nicht verfügbar (${err.message})` });
    }
  });

  return { bearing };
};
