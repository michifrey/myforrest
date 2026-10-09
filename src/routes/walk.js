'use strict';

/**
 * Walk-through ("Durchgehen"): step from picture to picture like Street View.
 *
 *   GET /api/walk/:photoId?at=<ISO date>
 *
 * Returns the photo and the ways on from it:
 *   - `weg`:  the previous and next photo of the same recording (video, drive,
 *             upload batch; photos.sequence_id), when not farther than 500 m;
 *   - `spot`: other spots within 80 m, one photo each (a panorama if there is
 *             one, the one closest in time to `at`), at most one per 45° sector
 *             (the nearest), so the ring stays readable;
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

module.exports = function registerWalk(app, { db, accounts, thumbs }) {
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

  app.get('/api/walk/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Ungültige ID' });
    const photo = db.prepare(`SELECT * FROM photos p WHERE p.id = ? AND ${visible(req)}`).get(id);
    if (!photo) return res.status(404).json({ error: 'Foto nicht gefunden' });
    const at = req.query.at && Number.isFinite(Date.parse(req.query.at)) ? Date.parse(req.query.at) : photo.taken_at;
    const here = { lat: photo.lat, lon: photo.lon };
    const link = (p, kind, extra = {}) => ({
      kind,
      ...photoBrief(p),
      bearing: Math.round(bearing(here, p) * 10) / 10,
      distanceM: Math.round(distanceM(here, p)),
      ...extra,
    });

    const links = [];
    let sequence = null;
    let track = [];
    if (photo.sequence_id) {
      const seq = db.prepare(`SELECT * FROM photos p WHERE p.sequence_id = ? AND ${visible(req)}
        ORDER BY p.taken_at, COALESCE(p.video_time, 0), p.id`).all(photo.sequence_id);
      const i = seq.findIndex((p) => p.id === photo.id);
      sequence = { id: photo.sequence_id, index: i, length: seq.length };
      for (const [p, dir] of [[seq[i - 1], 'zurueck'], [seq[i + 1], 'vor']]) {
        if (p && distanceM(here, p) <= SEQUENCE_MAX_M) links.push(link(p, 'weg', { direction: dir }));
      }
      const step = Math.max(1, Math.ceil(seq.length / TRACK_MAX));
      track = seq.filter((_, k) => k % step === 0 || k === seq.length - 1).map((p) => [p.lat, p.lon]);
    }

    // Other spots nearby: one photo each, a panorama if possible, closest in time to `at`.
    const dLat = NEAR_M / 111320;
    const dLon = dLat / Math.cos((photo.lat * Math.PI) / 180);
    const near = db.prepare(`SELECT * FROM photos p WHERE p.lat BETWEEN ? AND ? AND p.lon BETWEEN ? AND ?
      AND p.spot_id != ? AND ${visible(req)}`).all(photo.lat - dLat, photo.lat + dLat, photo.lon - dLon, photo.lon + dLon, photo.spot_id);
    const linked = new Set(links.map((l) => l.spotId));
    const bySpot = new Map();
    for (const p of near) {
      if (linked.has(p.spot_id) || distanceM(here, p) > NEAR_M) continue;
      const best = bySpot.get(p.spot_id);
      const better = !best
        || (p.panorama && !best.panorama)
        || (Boolean(p.panorama) === Boolean(best.panorama) && Math.abs(p.taken_at - at) < Math.abs(best.taken_at - at));
      if (better) bySpot.set(p.spot_id, p);
    }
    const sectors = new Map();
    for (const p of bySpot.values()) {
      const l = link(p, 'spot');
      // Arrows of the recording keep their place; spots share the remaining sectors.
      const sector = Math.round(l.bearing / 45) % 8;
      if (links.some((w) => Math.round(w.bearing / 45) % 8 === sector && w.distanceM <= l.distanceM)) continue;
      const other = sectors.get(sector);
      if (!other || l.distanceM < other.distanceM) sectors.set(sector, l);
    }
    links.push(...[...sectors.values()].sort((a, b) => a.bearing - b.bearing));

    const times = db.prepare(`SELECT * FROM photos p WHERE p.spot_id = ? AND ${visible(req)} ORDER BY p.taken_at, p.id`)
      .all(photo.spot_id).map(photoBrief);

    res.json({ photo: photoBrief(photo), links, times, sequence, track });
  });

  return { bearing };
};
