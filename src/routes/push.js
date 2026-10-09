'use strict';

/*
 * Push messages for the satellite early warning, to the people who visit a
 * spot regularly.
 *
 *   GET    /api/push                   public VAPID key, whether this account has subscriptions
 *   POST   /api/push/subscriptions     store a browser's subscription ({ endpoint, keys }) for the account
 *   DELETE /api/push/subscriptions     remove it again ({ endpoint })
 *   POST   /api/push/test              a test message to the account's subscriptions
 *   GET    /api/spots/:id/follow       whether the account gets warnings for this spot, and why
 *   PUT    /api/spots/:id/follow       { mode: 'folgen' | 'stumm' | null }
 *
 * Who gets a warning for a spot: accounts that photographed it on at least
 * REGULAR_DAYS different days in the last REGULAR_YEARS years ("regelmässig"),
 * and accounts that follow it; minus accounts that muted it. Each warning
 * (spot, index, since) is sent once; several new warnings for one account go
 * out as one message.
 *
 * The VAPID keys come from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY, else they
 * are generated once and kept in the database. Endpoints must use https and
 * belong to a known push service (PUSH_HOSTS adds more), so the server never
 * posts to arbitrary addresses.
 *
 * Usage in createApp: `const push = require('./routes/push')(app, ctx)`,
 * ctx = { db, idParam, publicUrl, adminEmail, fetchImpl, allowedHosts, allowHttp, now };
 * returns { notifyAlerts(list), send(userId, message) }.
 */

const { generateVapidKeys, sendNotification } = require('../webpush');
const { canSeeProtected } = require('../auth');
const { withOrgPro } = require('../orgs');

const REGULAR_DAYS = 2;
const REGULAR_YEARS = 3;
const MAX_SUBSCRIPTIONS = 10; // per account (one per browser/device)
const FAILURES_BEFORE_DROP = 5;
const DAY = 86400000;
// Push services of the common browsers (Chrome/Edge/Android, Firefox, Safari/iOS, Windows).
const PUSH_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'push.services.mozilla.com', 'web.push.apple.com',
  'push.apple.com', 'notify.windows.com'];

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS push_keys (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    public_key  TEXT NOT NULL,
    private_key TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    endpoint   TEXT NOT NULL UNIQUE,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    sent_at    INTEGER,
    failures   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions (user_id);
  CREATE TABLE IF NOT EXISTS spot_follows (
    user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    spot_id    INTEGER NOT NULL REFERENCES spots (id) ON DELETE CASCADE,
    mode       TEXT NOT NULL CHECK (mode IN ('folgen', 'stumm')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, spot_id)
  );
  CREATE TABLE IF NOT EXISTS push_alerts_sent (
    spot_id    INTEGER NOT NULL REFERENCES spots (id) ON DELETE CASCADE,
    idx        TEXT NOT NULL,
    since      TEXT NOT NULL,
    sent_at    INTEGER NOT NULL,
    recipients INTEGER NOT NULL,
    PRIMARY KEY (spot_id, idx, since)
  );
`;

const INDEX_NAME = { ndvi: 'NDVI (Grün)', ndmi: 'NDMI (Feuchte)' };
const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const monthLabel = (ym) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const isB64u = (s, bytes) => typeof s === 'string' && /^[A-Za-z0-9_-]+={0,2}$/.test(s) && Buffer.from(s, 'base64url').length === bytes;

module.exports = function registerPush(app, {
  db, idParam, publicUrl = process.env.PUBLIC_URL || null, adminEmail = process.env.ADMIN_EMAIL || null, fetchImpl = fetch,
  allowedHosts = (process.env.PUSH_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean), allowHttp = false, now = () => Date.now(),
}) {
  db.exec(SCHEMA);

  /* ---------- VAPID keys ---------- */

  function vapidKeys() {
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
      return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
    }
    let row = db.prepare('SELECT public_key, private_key FROM push_keys WHERE id = 1').get();
    if (!row) {
      const k = generateVapidKeys();
      db.prepare('INSERT OR IGNORE INTO push_keys (id, public_key, private_key, created_at) VALUES (1, ?, ?, ?)').run(k.publicKey, k.privateKey, now());
      row = db.prepare('SELECT public_key, private_key FROM push_keys WHERE id = 1').get();
    }
    return { publicKey: row.public_key, privateKey: row.private_key };
  }
  const keys = vapidKeys();
  // The push service may contact this address about misbehaving senders (RFC 8292: mailto: or https:).
  const subject = process.env.VAPID_SUBJECT
    || (adminEmail ? `mailto:${adminEmail}` : publicUrl?.startsWith('https://') ? publicUrl : 'mailto:webmaster@myforrest.invalid');
  const vapid = { ...keys, subject };

  /** Only https endpoints of known push services (plus PUSH_HOSTS). */
  function endpointAllowed(endpoint) {
    let url;
    try {
      url = new URL(endpoint);
    } catch {
      return false;
    }
    if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) return false;
    if (url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    return [...PUSH_HOSTS, ...allowedHosts].some((h) => host === h || host.endsWith(`.${h}`));
  }

  /* ---------- Who gets warnings for a spot ---------- */

  const hasUploader = () => db.prepare('PRAGMA table_info(photos)').all().some((c) => c.name === 'uploader_id');
  /** Days on which each account photographed the spot in the last years: Map userId → days. */
  function visitDays(spotId) {
    if (!hasUploader()) return new Map();
    const since = now() - REGULAR_YEARS * 365 * DAY;
    const rows = db.prepare(`SELECT uploader_id AS user, COUNT(DISTINCT date(taken_at / 1000, 'unixepoch')) AS days
      FROM photos WHERE spot_id = ? AND uploader_id IS NOT NULL AND taken_at >= ? GROUP BY uploader_id`).all(spotId, since);
    return new Map(rows.map((r) => [r.user, r.days]));
  }

  /** May the account still see the spot (protected finds: PRO, moderation, own photos only)? */
  const hasProtection = () => db.prepare('PRAGMA table_info(photos)').all().some((c) => c.name === 'protected');
  function seesSpot(userId, spotId) {
    if (!hasProtection()) return true;
    const u = withOrgPro(db, db.prepare('SELECT * FROM users WHERE id = ?').get(userId));
    if (canSeeProtected(u)) return true;
    return Boolean(db.prepare(`SELECT 1 FROM photos WHERE spot_id = ? AND hidden_at IS NULL
      AND (protected = 0 OR uploader_id = ?) LIMIT 1`).get(spotId, userId));
  }

  /** Accounts that get warnings for a spot, with why: Map userId → 'regelmaessig' | 'folgen'. */
  function recipients(spotId) {
    const out = new Map();
    for (const [user, days] of visitDays(spotId)) if (days >= REGULAR_DAYS) out.set(user, 'regelmaessig');
    for (const r of db.prepare('SELECT user_id, mode FROM spot_follows WHERE spot_id = ?').all(spotId)) {
      if (r.mode === 'stumm') out.delete(r.user_id);
      else out.set(r.user_id, 'folgen');
    }
    // Followers of a spot that has since been protected learn nothing more about it.
    for (const user of [...out.keys()]) if (!seesSpot(user, spotId)) out.delete(user);
    return out;
  }

  /* ---------- Sending ---------- */

  const subscriptionsOf = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?');

  /**
   * Sends `message` ({ title, body, url, tag }) to all subscriptions of an
   * account. Expired subscriptions are deleted, ones that keep failing too.
   * Resolves to the number of browsers that accepted it.
   */
  async function send(userId, message) {
    let delivered = 0;
    for (const s of subscriptionsOf.all(userId)) {
      try {
        const r = await sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(message), {
          vapid, fetchImpl, topic: message.tag ? message.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) : null, now: now(),
        });
        if (r.gone) {
          db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
        } else if (r.ok) {
          db.prepare('UPDATE push_subscriptions SET sent_at = ?, failures = 0 WHERE id = ?').run(now(), s.id);
          delivered++;
        } else {
          throw new Error(`Push-Dienst antwortet ${r.status}`);
        }
      } catch (err) {
        db.prepare('UPDATE push_subscriptions SET failures = failures + 1 WHERE id = ?').run(s.id);
        db.prepare('DELETE FROM push_subscriptions WHERE id = ? AND failures >= ?').run(s.id, FAILURES_BEFORE_DROP);
        console.warn(`Push an Konto ${userId} fehlgeschlagen: ${err.message}`);
      }
    }
    return delivered;
  }

  /** The text of one warning, e.g. "NDVI (Grün) 0.07 unter den Vorjahren seit Aug 2026". */
  const alertLine = (a) => `${INDEX_NAME[a.index] || a.index} ${a.drop.toFixed(2)} unter den Vorjahren seit ${monthLabel(a.since)}`;

  /**
   * Sends the warnings not sent yet: `list` = [{ spotId, alerts }] as from
   * /api/satellite/alerts. Only warnings that call for a visit (no photo
   * since the drop began) are sent. Resolves to { alerts, messages }.
   */
  async function notifyAlerts(list) {
    const isSent = db.prepare('SELECT 1 FROM push_alerts_sent WHERE spot_id = ? AND idx = ? AND since = ?');
    const markSent = db.prepare('INSERT OR IGNORE INTO push_alerts_sent (spot_id, idx, since, sent_at, recipients) VALUES (?, ?, ?, ?, ?)');
    const byUser = new Map();
    let fresh = 0;
    for (const { spotId, alerts } of list) {
      const todo = alerts.filter((a) => a.visit && !isSent.get(spotId, a.index, a.since));
      if (!todo.length) continue;
      const who = recipients(spotId);
      for (const a of todo) markSent.run(spotId, a.index, a.since, now(), who.size);
      fresh += todo.length;
      for (const [user, why] of who) {
        if (!byUser.has(user)) byUser.set(user, []);
        byUser.get(user).push({ spotId, alerts: todo, why });
      }
    }
    let messages = 0;
    for (const [user, spots] of byUser) {
      if (!subscriptionsOf.all(user).length) continue;
      const strong = spots.some((s) => s.alerts.some((a) => a.severity === 'stark'));
      const message = spots.length === 1
        ? {
          title: `Satellit: Rückgang an Spot ${spots[0].spotId}${strong ? ' (stark)' : ''}`,
          body: `${spots[0].alerts.map(alertLine).join('; ')}. Ein neues Foto würde zeigen, was dahinter steckt.`,
          url: `./?spot=${spots[0].spotId}`,
          tag: `spot-${spots[0].spotId}`,
        }
        : {
          title: `Satellit: Rückgang an ${spots.length} deiner Spots${strong ? ' (teils stark)' : ''}`,
          body: `${spots.map((s) => `Spot ${s.spotId}: ${s.alerts.map(alertLine).join('; ')}`).join('. ')}.`,
          url: './?filter=satellite',
          tag: 'satellit',
        };
      if (await send(user, message)) messages++;
    }
    return { alerts: fresh, messages };
  }

  /* ---------- API ---------- */

  const needUser = (req, res) => {
    if (req.user) return true;
    res.status(401).json({ error: 'Bitte anmelden' });
    return false;
  };

  app.get('/api/push', (req, res) => {
    res.json({
      publicKey: vapid.publicKey,
      subscriptions: req.user ? subscriptionsOf.all(req.user.id).length : 0,
      regularDays: REGULAR_DAYS,
      regularYears: REGULAR_YEARS,
    });
  });

  app.post('/api/push/subscriptions', (req, res) => {
    if (!needUser(req, res)) return;
    const { endpoint, keys: k } = req.body || {};
    if (typeof endpoint !== 'string' || endpoint.length > 1000 || !endpointAllowed(endpoint)) {
      return res.status(400).json({ error: 'Unbekannter Push-Dienst' });
    }
    if (!isB64u(k?.p256dh, 65) || !isB64u(k?.auth, 16)) return res.status(400).json({ error: 'Ungültige Schlüssel' });
    const existing = db.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').get(endpoint);
    if (!existing && subscriptionsOf.all(req.user.id).length >= MAX_SUBSCRIPTIONS) {
      // The oldest browser makes room: subscriptions of reinstalled apps never say goodbye.
      db.prepare('DELETE FROM push_subscriptions WHERE id = (SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY created_at, id LIMIT 1)').run(req.user.id);
    }
    // A browser belongs to whoever is logged in on it now.
    db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, failures = 0`)
      .run(req.user.id, endpoint, k.p256dh, k.auth, now());
    res.status(existing ? 200 : 201).json({ subscriptions: subscriptionsOf.all(req.user.id).length });
  });

  app.delete('/api/push/subscriptions', (req, res) => {
    if (!needUser(req, res)) return;
    db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(req.user.id, String(req.body?.endpoint || ''));
    res.json({ subscriptions: subscriptionsOf.all(req.user.id).length });
  });

  app.post('/api/push/test', async (req, res, next) => {
    if (!needUser(req, res)) return;
    try {
      const delivered = await send(req.user.id, {
        title: 'MyForrest: Testnachricht',
        body: 'Push-Nachrichten kommen an. Du erfährst hier, wenn der Satellit an deinen Spots einen Rückgang sieht.',
        url: './',
        tag: 'test',
      });
      res.json({ delivered });
    } catch (err) {
      next(err);
    }
  });

  /** The account's relation to a spot: followed, muted or a regular visit, and how many days. */
  function followJson(userId, spotId) {
    const row = db.prepare('SELECT mode FROM spot_follows WHERE user_id = ? AND spot_id = ?').get(userId, spotId);
    const days = visitDays(spotId).get(userId) || 0;
    const regular = days >= REGULAR_DAYS;
    const mode = row?.mode ?? null;
    return { mode, regular, days, regularDays: REGULAR_DAYS, notified: mode === 'folgen' || (regular && mode !== 'stumm'), subscriptions: subscriptionsOf.all(userId).length };
  }

  app.get('/api/spots/:id/follow', (req, res) => {
    const id = idParam(req, res);
    if (id === null) return;
    if (!db.prepare('SELECT 1 FROM spots WHERE id = ?').get(id)) return res.status(404).json({ error: 'Spot nicht gefunden' });
    if (!req.user) return res.json({ mode: null, regular: false, days: 0, regularDays: REGULAR_DAYS, notified: false, subscriptions: 0 });
    res.json(followJson(req.user.id, id));
  });

  app.put('/api/spots/:id/follow', (req, res) => {
    if (!needUser(req, res)) return;
    const id = idParam(req, res);
    if (id === null) return;
    if (!db.prepare('SELECT 1 FROM spots WHERE id = ?').get(id)) return res.status(404).json({ error: 'Spot nicht gefunden' });
    const mode = req.body?.mode ?? null;
    if (mode !== null && mode !== 'folgen' && mode !== 'stumm') return res.status(400).json({ error: 'mode: folgen, stumm oder null' });
    if (mode === null) db.prepare('DELETE FROM spot_follows WHERE user_id = ? AND spot_id = ?').run(req.user.id, id);
    else {
      db.prepare(`INSERT INTO spot_follows (user_id, spot_id, mode, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (user_id, spot_id) DO UPDATE SET mode = excluded.mode`).run(req.user.id, id, mode, now());
    }
    res.json(followJson(req.user.id, id));
  });

  return { notifyAlerts, send, recipients, endpointAllowed };
};
