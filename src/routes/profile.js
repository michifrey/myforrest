'use strict';

/**
 * The own profile page: what the logged-in account has contributed.
 *
 *   GET /api/profile         figures (photos, spots, years, activities, tours, requests, followed spots)
 *   GET /api/profile/photos  own photos, newest first, in pages (?offset, ?limit, ?filter)
 *
 * Only for the account itself: a public list of one person's photos would
 * show where and when that person regularly runs, walks or rides.
 * Photos hidden by the moderation are listed with their reason but without
 * image URLs, since their files are not served to their uploader either.
 */

const FILTERS = {
  alle: '1 = 1',
  geschuetzt: 'COALESCE(p.protected, 0) = 1',
  ausgeblendet: 'p.hidden_at IS NOT NULL',
};

module.exports = function profileRoutes(app, { db, thumbs, accounts }) {
  const fail = (res, status, error) => res.status(status).json({ error });
  const loggedIn = (req, res, next) => (req.user ? next() : fail(res, 401, 'Bitte zuerst anmelden'));
  const count = (sql, ...args) => db.prepare(sql).get(...args).n;

  app.get('/api/profile', loggedIn, (req, res) => {
    const id = req.user.id;
    const range = db.prepare('SELECT MIN(taken_at) AS first, MAX(taken_at) AS last FROM photos WHERE uploader_id = ?').get(id);
    const years = db.prepare(`SELECT strftime('%Y', taken_at / 1000, 'unixepoch') AS year, COUNT(*) AS n
      FROM photos WHERE uploader_id = ? GROUP BY year ORDER BY year`).all(id);
    const activities = db.prepare(`SELECT COALESCE(activity, 'sonstiges') AS activity, COUNT(*) AS n
      FROM photos WHERE uploader_id = ? GROUP BY 1 ORDER BY n DESC`).all(id);
    res.set('Cache-Control', 'no-store');
    res.json({
      name: req.user.name,
      memberSince: new Date(req.user.created_at).toISOString(),
      photos: count('SELECT COUNT(*) AS n FROM photos WHERE uploader_id = ?', id),
      spots: count('SELECT COUNT(DISTINCT spot_id) AS n FROM photos WHERE uploader_id = ?', id),
      // Spots where this account added to someone else's series: the repeat photos that make time series.
      repeatSpots: count(`SELECT COUNT(DISTINCT p.spot_id) AS n FROM photos p WHERE p.uploader_id = ?
        AND EXISTS (SELECT 1 FROM photos o WHERE o.spot_id = p.spot_id
          AND (o.taken_at < p.taken_at OR (o.taken_at = p.taken_at AND o.id < p.id))
          AND (o.uploader_id IS NULL OR o.uploader_id != p.uploader_id))`, id),
      hidden: count('SELECT COUNT(*) AS n FROM photos WHERE uploader_id = ? AND hidden_at IS NOT NULL', id),
      protected: count('SELECT COUNT(*) AS n FROM photos WHERE uploader_id = ? AND COALESCE(protected, 0) = 1', id),
      firstAt: range.first ? new Date(range.first).toISOString() : null,
      lastAt: range.last ? new Date(range.last).toISOString() : null,
      years: years.map((y) => ({ year: Number(y.year), photos: y.n })),
      activities: activities.map((a) => ({ activity: a.activity, photos: a.n })),
      tracks: count('SELECT COUNT(*) AS n FROM tracks WHERE owner_id = ?', id),
      requests: {
        open: count("SELECT COUNT(*) AS n FROM photo_requests WHERE requester_id = ? AND status = 'offen'", id),
        done: count("SELECT COUNT(*) AS n FROM photo_requests WHERE requester_id = ? AND status = 'erledigt'", id),
        // Requests of others that one of this account's photos fulfilled.
        fulfilled: count(`SELECT COUNT(*) AS n FROM photo_requests r JOIN photos p ON p.id = r.photo_id
          WHERE p.uploader_id = ? AND (r.requester_id IS NULL OR r.requester_id != ?)`, id, id),
      },
      followedSpots: count("SELECT COUNT(*) AS n FROM spot_follows WHERE user_id = ? AND mode = 'folgen'", id),
    });
  });

  app.get('/api/profile/photos', loggedIn, (req, res) => {
    const filter = Object.hasOwn(FILTERS, req.query.filter) ? req.query.filter : 'alle';
    const limit = Math.min(Math.max(Number(req.query.limit) || 60, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const where = `p.uploader_id = ? AND ${FILTERS[filter]}`;
    const total = count(`SELECT COUNT(*) AS n FROM photos p WHERE ${where}`, req.user.id);
    const rows = db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM photos o WHERE o.spot_id = p.spot_id) AS spot_photos
      FROM photos p WHERE ${where} ORDER BY p.taken_at DESC, p.id DESC LIMIT ? OFFSET ?`).all(req.user.id, limit, offset);
    const tagsOf = db.prepare('SELECT tag FROM photo_tags WHERE photo_id = ? ORDER BY tag');
    res.set('Cache-Control', 'no-store');
    res.json({
      total,
      offset,
      photos: rows.map((p) => {
        const extras = accounts.photoExtras(p);
        return {
          id: p.id,
          spotId: p.spot_id,
          spotPhotos: p.spot_photos,
          // A hidden photo's files are withheld from its uploader as well.
          ...(p.hidden_at ? {} : { url: `/uploads/${p.file}`, ...thumbs.urls(p) }),
          takenAt: new Date(p.taken_at).toISOString(),
          activity: p.activity,
          panorama: Boolean(p.panorama),
          tags: tagsOf.all(p.id).map((r) => r.tag),
          license: extras.license,
          hidden: extras.hidden,
          ...(extras.hidden ? { hiddenReason: extras.hiddenReason } : {}),
          protected: extras.protected,
        };
      }),
    });
  });
};
