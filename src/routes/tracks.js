'use strict';

/**
 * Tours (tracks) and photo requests.
 *
 *   POST   /api/tracks/parse            read a GPX/TCX/KML/GeoJSON file ({ text, filename }), nothing is stored
 *   GET    /api/tracks                  public tours (summary, start point) – ?mine=1 for one's own
 *   POST   /api/tracks                  save a tour (login required): { name, kind, activity, visibility, points }
 *   GET    /api/tracks/:id              one tour with its points
 *   PATCH  /api/tracks/:id              name, activity, visibility
 *   DELETE /api/tracks/:id
 *   GET    /api/tracks/:id.gpx          download as GPX
 *   GET    /api/route                   path between waypoints from a routing service (ROUTER_URL, BRouter)
 *   POST   /api/route-suggestions       photo requests and spots worth a visit near a route (satellite early warning,
 *                                       series not continued for a year); the route is not stored
 *   GET    /api/photo-requests          open (and recently done) requests
 *   POST   /api/photo-requests          ask for a photo of a place: { lat, lon, heading?, spotId?, title, note? }
 *   DELETE /api/photo-requests/:id      withdraw (requester or moderation)
 *
 * Privacy: tours are private unless their owner makes them public. Others
 * see public tours without times and without the first and last 200 m
 * (start and finish are often at home). Photo requests carry a place, an
 * optional direction and a text, but no time and no public name of the
 * requester. Route suggestions are computed from the route sent with the
 * request and nothing of it is kept.
 *
 * A photo fulfils an open request when it is taken within the request's
 * radius (and, if both have one, roughly in its direction), or when the
 * upload names the request and was taken within 150 m of it.
 */

const { createLimiter, isModerator, canSeeProtected } = require('../auth');
const { distanceM, isValidCoord } = require('../geo');
const { parseTrackFile, toGpx, MAX_POINTS } = require('../trackfile');
const { lengthM, bbox, nearRoute, trimEnds } = require('../routegeo');

const KINDS = ['gezeichnet', 'aufgezeichnet', 'importiert'];
const VISIBILITY = ['privat', 'oeffentlich'];
const PRIVACY_ZONE_M = 200;
const REQUEST_RADIUS_M = 40;
const HEADING_TOLERANCE = 60;
const STALE_DAYS = 365;
const DAY = 86400000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tracks (
    id          INTEGER PRIMARY KEY,
    owner_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('gezeichnet', 'aufgezeichnet', 'importiert')),
    activity    TEXT,
    visibility  TEXT NOT NULL DEFAULT 'privat' CHECK (visibility IN ('privat', 'oeffentlich')),
    points_json TEXT NOT NULL, -- [[lat, lon, ele|null, time|null], …]
    distance_m  REAL NOT NULL,
    start_lat   REAL NOT NULL,
    start_lon   REAL NOT NULL,
    min_lat REAL NOT NULL, min_lon REAL NOT NULL, max_lat REAL NOT NULL, max_lon REAL NOT NULL,
    started_at  INTEGER, -- first point's time, for recorded or imported tracks
    ended_at    INTEGER,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS tracks_owner ON tracks (owner_id, created_at);
  CREATE INDEX IF NOT EXISTS tracks_public ON tracks (visibility, min_lat, max_lat);

  CREATE TABLE IF NOT EXISTS photo_requests (
    id           INTEGER PRIMARY KEY,
    lat          REAL NOT NULL,
    lon          REAL NOT NULL,
    heading      REAL, -- wished viewing direction (° from north)
    radius_m     REAL NOT NULL,
    spot_id      INTEGER REFERENCES spots (id) ON DELETE SET NULL, -- "please photograph this spot again"
    title        TEXT NOT NULL,
    note         TEXT,
    requester_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
    status       TEXT NOT NULL DEFAULT 'offen' CHECK (status IN ('offen', 'erledigt', 'zurueckgezogen')),
    photo_id     INTEGER REFERENCES photos (id) ON DELETE SET NULL,
    created_at   INTEGER NOT NULL,
    done_at      INTEGER
  );
  CREATE INDEX IF NOT EXISTS photo_requests_status ON photo_requests (status, lat, lon);
`;
// Requests at protected finds are shown to verified PRO members only.
const REQUEST_MIGRATIONS = [['protected', 'INTEGER NOT NULL DEFAULT 0']];

const angleDiff = (a, b) => Math.abs((((a - b) % 360) + 540) % 360 - 180);
const dayDe = (ms) => new Date(ms).toISOString().slice(0, 10).split('-').reverse().join('.');
const clean = (v, max) => (v === undefined || v === null ? null : String(v).trim().slice(0, max) || null);

/** [{lat, lon}] or [[lat, lon, ele?, time?]] → validated points, or null. */
function readPoints(input) {
  if (!Array.isArray(input) || input.length < 2 || input.length > MAX_POINTS) return null;
  const out = [];
  for (const p of input) {
    const [lat, lon, ele, time] = Array.isArray(p) ? p : [p?.lat, p?.lon, p?.ele, p?.time];
    if (!isValidCoord(Number(lat), Number(lon))) return null;
    const q = { lat: Number(lat), lon: Number(lon) };
    if (ele !== null && ele !== undefined && Number.isFinite(Number(ele))) q.ele = Math.round(Number(ele) * 10) / 10;
    const t = typeof time === 'string' ? Date.parse(time) : Number(time);
    if (time !== null && time !== undefined && Number.isFinite(t)) q.time = t;
    out.push(q);
  }
  return out;
}
const packPoints = (points) => JSON.stringify(points.map((p) => [
  Math.round(p.lat * 1e7) / 1e7, Math.round(p.lon * 1e7) / 1e7, p.ele ?? null, p.time ?? null,
]));
const unpackPoints = (json) => JSON.parse(json).map(([lat, lon, ele, time]) => {
  const p = { lat, lon };
  if (ele !== null) p.ele = ele;
  if (time !== null) p.time = time;
  return p;
});

module.exports = function registerTracks(app, ctx) {
  const { db, spotRadiusM, satelliteAlerts = () => [], routerUrl = null, routerFetch = fetch, routerProfile = 'hiking-mountain', accounts = null } = ctx;
  db.exec(SCHEMA);
  const reqCols = new Set(db.prepare('PRAGMA table_info(photo_requests)').all().map((c) => c.name));
  for (const [col, type] of REQUEST_MIGRATIONS) if (!reqCols.has(col)) db.exec(`ALTER TABLE photo_requests ADD COLUMN ${col} ${type}`);
  // What the request may see; without the accounts module (tests of this file alone): the public view.
  const photoVisible = (req, alias = 'p') => (accounts ? accounts.visibleSql(req, alias) : `${alias}.hidden_at IS NULL AND COALESCE(${alias}.protected, 0) = 0`);
  const spotVisible = (req, spotId) => spotId === null
    || Boolean(db.prepare(`SELECT 1 FROM photos p WHERE p.spot_id = ? AND ${photoVisible(req)} LIMIT 1`).get(spotId));
  const requestVisible = (req, r) => (r.protected ? canSeeProtected(req.user) || Boolean(req.user && r.requester_id === req.user.id) : true)
    && spotVisible(req, r.spot_id);
  const requestLimit = createLimiter({ db, name: 'requestLimit', max: 20, windowMs: 3600 * 1000 });
  const fail = (res, status, error) => res.status(status).json({ error });
  const idOf = (req) => {
    const id = Number(req.params.id);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  };

  /* ---------- Tours ---------- */

  const ownerName = db.prepare('SELECT name FROM users WHERE id = ?');
  const mayRead = (user, t) => t.visibility === 'oeffentlich' || (user && (user.id === t.owner_id || isModerator(user)));
  const mayWrite = (user, t) => Boolean(user && (user.id === t.owner_id || isModerator(user)));

  function summary(t, user) {
    const own = Boolean(user && user.id === t.owner_id);
    return {
      id: t.id,
      name: t.name,
      kind: t.kind,
      activity: t.activity,
      visibility: t.visibility,
      distanceM: Math.round(t.distance_m),
      start: own ? { lat: t.start_lat, lon: t.start_lon } : null,
      bbox: [t.min_lon, t.min_lat, t.max_lon, t.max_lat],
      // Times only for the owner: a public tour should not tell when someone is out.
      startedAt: own && t.started_at ? new Date(t.started_at).toISOString() : null,
      endedAt: own && t.ended_at ? new Date(t.ended_at).toISOString() : null,
      hasTime: Boolean(t.started_at),
      owner: t.visibility === 'oeffentlich' ? ownerName.get(t.owner_id)?.name ?? null : null,
      own,
      createdAt: new Date(t.created_at).toISOString(),
    };
  }

  /** Points as the viewer may see them: owners get everything, others no times and no ends. */
  function visiblePoints(t, user) {
    const points = unpackPoints(t.points_json);
    if (user && (user.id === t.owner_id)) return points;
    return trimEnds(points, PRIVACY_ZONE_M).map(({ lat, lon, ele }) => (ele === undefined ? { lat, lon } : { lat, lon, ele }));
  }

  app.post('/api/tracks/parse', (req, res) => {
    const text = req.body?.text;
    if (typeof text !== 'string' || !text.trim()) return fail(res, 400, 'Keine Datei übermittelt');
    try {
      const t = parseTrackFile(text, clean(req.body.filename, 200) || '');
      res.json({ ...t, distanceM: Math.round(lengthM(t.points)) });
    } catch (err) {
      fail(res, 422, err.message);
    }
  });

  app.get('/api/tracks', (req, res) => {
    if (req.query.mine !== undefined) {
      if (!req.user) return fail(res, 401, 'Bitte zuerst anmelden');
      const rows = db.prepare('SELECT * FROM tracks WHERE owner_id = ? ORDER BY COALESCE(started_at, created_at) DESC').all(req.user.id);
      return res.json(rows.map((t) => summary(t, req.user)));
    }
    // Public tours, optionally within a bbox (west,south,east,north); start points of others are the trimmed start.
    const b = String(req.query.bbox || '').split(',').map(Number);
    const rows = b.length === 4 && b.every(Number.isFinite)
      ? db.prepare(`SELECT * FROM tracks WHERE visibility = 'oeffentlich' AND max_lat >= ? AND min_lat <= ? AND max_lon >= ? AND min_lon <= ?
          ORDER BY created_at DESC LIMIT 500`).all(b[1], b[3], b[0], b[2])
      : db.prepare("SELECT * FROM tracks WHERE visibility = 'oeffentlich' ORDER BY created_at DESC LIMIT 500").all();
    res.json(rows.map((t) => {
      const s = summary(t, req.user);
      if (!s.start) {
        const first = visiblePoints(t, req.user)[0];
        s.start = first ? { lat: first.lat, lon: first.lon } : null;
      }
      return s;
    }).filter((s) => s.start));
  });

  app.post('/api/tracks', (req, res) => {
    if (!req.user) return fail(res, 401, 'Bitte anmelden, um Touren zu speichern');
    const b = req.body || {};
    const points = readPoints(b.points);
    if (!points) return fail(res, 400, `Eine Tour braucht 2 bis ${MAX_POINTS} gültige Punkte`);
    const kind = KINDS.includes(b.kind) ? b.kind : 'gezeichnet';
    const visibility = VISIBILITY.includes(b.visibility) ? b.visibility : 'privat';
    const times = points.map((p) => p.time).filter(Number.isFinite);
    const [w, s, e, n] = bbox(points);
    const now = Date.now();
    const id = Number(db.prepare(`
      INSERT INTO tracks (owner_id, name, kind, activity, visibility, points_json, distance_m, start_lat, start_lon,
                          min_lat, min_lon, max_lat, max_lon, started_at, ended_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.user.id, clean(b.name, 120) || 'Tour', kind, clean(b.activity, 40), visibility, packPoints(points),
      lengthM(points), points[0].lat, points[0].lon, s, w, n, e,
      times.length ? Math.min(...times) : null, times.length ? Math.max(...times) : null, now, now).lastInsertRowid);
    const t = db.prepare('SELECT * FROM tracks WHERE id = ?').get(id);
    res.status(201).json({ ...summary(t, req.user), points });
  });

  const trackById = db.prepare('SELECT * FROM tracks WHERE id = ?');

  app.get('/api/tracks/:id.gpx', (req, res) => {
    const id = idOf(req);
    const t = id && trackById.get(id);
    if (!t || !mayRead(req.user, t)) return fail(res, 404, 'Tour nicht gefunden');
    const name = t.name.replace(/[^\w\- äöüÄÖÜß]/g, '').trim() || 'tour';
    res.type('application/gpx+xml').attachment(`${name}.gpx`)
      .send(toGpx({ name: t.name, activity: t.activity, points: visiblePoints(t, req.user) }));
  });

  app.get('/api/tracks/:id', (req, res) => {
    const id = idOf(req);
    const t = id && trackById.get(id);
    if (!t || !mayRead(req.user, t)) return fail(res, 404, 'Tour nicht gefunden');
    res.json({ ...summary(t, req.user), points: visiblePoints(t, req.user) });
  });

  app.patch('/api/tracks/:id', (req, res) => {
    const id = idOf(req);
    const t = id && trackById.get(id);
    if (!t || !mayRead(req.user, t)) return fail(res, 404, 'Tour nicht gefunden');
    if (!mayWrite(req.user, t)) return fail(res, req.user ? 403 : 401, 'Nur die eigene Tour lässt sich ändern');
    const b = req.body || {};
    if (b.visibility !== undefined && !VISIBILITY.includes(b.visibility)) return fail(res, 400, 'Sichtbarkeit muss privat oder oeffentlich sein');
    db.prepare(`UPDATE tracks SET name = COALESCE(?, name), activity = CASE WHEN ? THEN ? ELSE activity END,
      visibility = COALESCE(?, visibility), updated_at = ? WHERE id = ?`)
      .run(clean(b.name, 120), b.activity !== undefined ? 1 : 0, clean(b.activity, 40), b.visibility ?? null, Date.now(), id);
    res.json(summary(trackById.get(id), req.user));
  });

  app.delete('/api/tracks/:id', (req, res) => {
    const id = idOf(req);
    const t = id && trackById.get(id);
    if (!t || !mayRead(req.user, t)) return fail(res, 404, 'Tour nicht gefunden');
    if (!mayWrite(req.user, t)) return fail(res, req.user ? 403 : 401, 'Nur die eigene Tour lässt sich löschen');
    db.prepare('DELETE FROM tracks WHERE id = ?').run(id);
    res.status(204).end();
  });

  /* ---------- Routing along paths (optional) ---------- */

  app.get('/api/route', async (req, res) => {
    if (!routerUrl) return fail(res, 501, 'Kein Routing-Dienst eingerichtet (ROUTER_URL)');
    const pts = String(req.query.points || '').split(';').map((s) => s.split(',').map(Number));
    if (pts.length < 2 || pts.length > 50 || !pts.every(([la, lo]) => isValidCoord(la, lo))) {
      return fail(res, 400, 'points: 2 bis 50 Punkte als lat,lon;lat,lon');
    }
    const lonlats = pts.map(([la, lo]) => `${lo.toFixed(6)},${la.toFixed(6)}`).join('|');
    const url = `${routerUrl}?lonlats=${encodeURIComponent(lonlats)}&profile=${encodeURIComponent(routerProfile)}&alternativeidx=0&format=geojson`;
    try {
      const r = await routerFetch(url, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) return fail(res, 502, `Routing-Dienst antwortete mit HTTP ${r.status}`);
      const geo = await r.json();
      const coords = geo.features?.[0]?.geometry?.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) return fail(res, 502, 'Routing-Dienst lieferte keine Strecke');
      const points = coords.map(([lon, lat, ele]) => (Number.isFinite(ele) ? { lat, lon, ele } : { lat, lon }));
      res.json({ points, distanceM: Math.round(lengthM(points)) });
    } catch (err) {
      fail(res, 502, `Routing-Dienst nicht erreichbar (${err.message})`);
    }
  });

  /* ---------- Photo requests ---------- */

  function requestJson(r, user) {
    return {
      id: r.id,
      lat: r.lat,
      lon: r.lon,
      heading: r.heading,
      radiusM: r.radius_m,
      spotId: r.spot_id,
      title: r.title,
      note: r.note,
      status: r.status,
      protected: Boolean(r.protected),
      photoId: r.photo_id,
      createdAt: new Date(r.created_at).toISOString().slice(0, 10), // day only
      doneAt: r.done_at ? new Date(r.done_at).toISOString().slice(0, 10) : null,
      own: Boolean(user && r.requester_id === user.id),
    };
  }

  app.get('/api/photo-requests', (req, res) => {
    const status = req.query.status === 'alle' ? null : 'offen';
    const rows = db.prepare(`SELECT * FROM photo_requests WHERE (? IS NULL AND status != 'zurueckgezogen') OR status = ?
      ORDER BY created_at DESC LIMIT 2000`).all(status, status);
    const photoOk = (pid) => Boolean(db.prepare(`SELECT 1 FROM photos p WHERE p.id = ? AND ${photoVisible(req)}`).get(pid));
    res.json(rows.filter((r) => requestVisible(req, r)).map((r) => {
      const j = requestJson(r, req.user);
      if (j.photoId !== null && !photoOk(j.photoId)) j.photoId = null; // answered with a protected photo
      return j;
    }));
  });

  app.post('/api/photo-requests', (req, res) => {
    const b = req.body || {};
    let lat = Number(b.lat);
    let lon = Number(b.lon);
    let heading = b.heading === undefined || b.heading === null || b.heading === '' ? null : Number(b.heading);
    let spotId = null;
    let protect = Boolean(b.protected) && canSeeProtected(req.user);
    if (b.spotId !== undefined && b.spotId !== null && b.spotId !== '') {
      const spot = db.prepare('SELECT id, lat, lon, heading FROM spots WHERE id = ?').get(Number(b.spotId));
      if (!spot || !spotVisible(req, spot.id)) return fail(res, 400, 'Spot nicht gefunden');
      // A spot the public cannot see stays hidden behind its request too.
      if (!spotVisible({ user: null }, spot.id)) protect = true;
      [spotId, lat, lon] = [spot.id, spot.lat, spot.lon];
      heading ??= spot.heading;
    }
    if (!isValidCoord(lat, lon)) return fail(res, 400, 'Ungültige Koordinaten');
    if (heading !== null && !Number.isFinite(heading)) return fail(res, 400, 'Ungültige Blickrichtung');
    const title = clean(b.title, 120);
    if (!title) return fail(res, 400, 'Bitte kurz beschreiben, was fotografiert werden soll');
    const key = req.user ? `u${req.user.id}` : req.ip;
    const wait = requestLimit.blocked(key);
    if (wait) return res.status(429).set('Retry-After', String(wait)).json({ error: 'Zu viele Aufträge – bitte später wieder' });
    requestLimit.hit(key);
    const id = Number(db.prepare(`INSERT INTO photo_requests (lat, lon, heading, radius_m, spot_id, title, note, requester_id, created_at, protected)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(lat, lon, heading === null ? null : ((heading % 360) + 360) % 360,
      Math.max(REQUEST_RADIUS_M, spotRadiusM), spotId, title, clean(b.note, 1000), req.user?.id ?? null, Date.now(), protect ? 1 : 0).lastInsertRowid);
    res.status(201).json(requestJson(db.prepare('SELECT * FROM photo_requests WHERE id = ?').get(id), req.user));
  });

  app.delete('/api/photo-requests/:id', (req, res) => {
    const id = idOf(req);
    const r = id && db.prepare('SELECT * FROM photo_requests WHERE id = ?').get(id);
    if (!r || !requestVisible(req, r)) return fail(res, 404, 'Auftrag nicht gefunden');
    const own = req.user && r.requester_id === req.user.id;
    if (!own && !isModerator(req.user)) return fail(res, req.user ? 403 : 401, 'Nur wer den Auftrag erstellt hat, kann ihn zurückziehen');
    db.prepare("UPDATE photo_requests SET status = 'zurueckgezogen', done_at = ? WHERE id = ? AND status = 'offen'").run(Date.now(), id);
    res.status(204).end();
  });

  /** Marks the open requests a new photo fulfils. Returns their ids. */
  function fulfil(photoId, requestId = null) {
    const p = db.prepare('SELECT id, spot_id, lat, lon, heading FROM photos WHERE id = ?').get(photoId);
    if (!p) return [];
    const open = db.prepare("SELECT * FROM photo_requests WHERE status = 'offen' AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?")
      .all(p.lat - 0.002, p.lat + 0.002, p.lon - 0.003, p.lon + 0.003);
    const done = open.filter((r) => {
      const d = distanceM(p, r);
      if (r.id === Number(requestId) && d <= 150) return true;
      if (r.spot_id !== null && r.spot_id === p.spot_id) return true;
      if (d > r.radius_m) return false;
      return r.heading === null || p.heading === null || angleDiff(r.heading, p.heading) <= HEADING_TOLERANCE;
    });
    const mark = db.prepare("UPDATE photo_requests SET status = 'erledigt', photo_id = ?, done_at = ? WHERE id = ?");
    for (const r of done) mark.run(photoId, Date.now(), r.id);
    return done.map((r) => r.id);
  }

  /* ---------- Suggestions along a route ---------- */

  app.post('/api/route-suggestions', (req, res) => {
    const b = req.body || {};
    const route = readPoints(b.points);
    if (!route) return fail(res, 400, `Die Route braucht 2 bis ${MAX_POINTS} gültige Punkte`);
    const maxM = Math.min(1000, Math.max(20, Number(b.maxDistanceM) || 150));
    const candidates = [];
    for (const r of db.prepare("SELECT * FROM photo_requests WHERE status = 'offen'").all().filter((x) => requestVisible(req, x))) {
      candidates.push({ kind: 'auftrag', requestId: r.id, spotId: r.spot_id, lat: r.lat, lon: r.lon, heading: r.heading, title: r.title, text: r.note });
    }
    const alerted = new Set();
    for (const a of satelliteAlerts(req)) {
      alerted.add(a.spotId);
      const strongest = a.alerts.find((x) => x.severity === 'stark') || a.alerts[0];
      const spot = db.prepare('SELECT heading FROM spots WHERE id = ?').get(a.spotId);
      candidates.push({
        kind: 'satellit', spotId: a.spotId, lat: a.lat, lon: a.lon, heading: spot?.heading ?? null,
        title: `Spot ${a.spotId}: Satellit meldet Rückgang`,
        text: `${strongest.index.toUpperCase()} seit ${strongest.since} um ${strongest.drop.toFixed(2)} tiefer als in den Vorjahren`,
      });
    }
    const stale = db.prepare(`SELECT s.id, s.lat, s.lon, s.heading, MAX(p.taken_at) AS last FROM spots s
      JOIN photos p ON p.spot_id = s.id AND ${photoVisible(req)} GROUP BY s.id HAVING COUNT(p.id) >= 2 AND last < ?`).all(Date.now() - STALE_DAYS * DAY);
    for (const s of stale) {
      if (alerted.has(s.id)) continue;
      const years = Math.floor((Date.now() - s.last) / (365.25 * DAY));
      candidates.push({
        kind: 'lange_nicht', spotId: s.id, lat: s.lat, lon: s.lon, heading: s.heading,
        title: `Spot ${s.id}: lange nicht besucht`,
        text: `Letztes Foto vom ${dayDe(s.last)}${years >= 2 ? ` (vor ${years} Jahren)` : ''}`,
      });
    }
    const near = nearRoute(route, candidates, maxM);
    const suggestions = candidates.map((c, i) => (near[i] ? { ...c, ...near[i] } : null)).filter(Boolean)
      .sort((a, z) => a.alongM - z.alongM);
    res.json({ lengthM: Math.round(lengthM(route)), maxDistanceM: maxM, suggestions });
  });

  return { fulfil, routing: Boolean(routerUrl) };
};
