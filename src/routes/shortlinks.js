'use strict';

/*
 * Short links with a QR code, as map.geo.admin.ch shares a map: a long address of this site (a map view with its
 * layers, a report) gets a short one to print on a poster or a forest notice board.
 *
 *   POST /api/kurzlink { url }   → { code, url, qr } (the same address always gets the same code)
 *   GET  /k/:code                → redirect to the address
 *   GET  /k/:code.svg            → QR code of the short link (SVG)
 *
 * Only addresses of this site are taken (a path, or a full address with the same host), so a short link never
 * leads elsewhere.
 */

const crypto = require('node:crypto');
const QRCode = require('qrcode');

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o, 1/l/i: easy to type from paper
const MAX_URL = 2000;
const PER_HOUR = 60;

module.exports = function registerShortlinks(app, { db, json, now = () => Date.now() }) {
  db.exec(`CREATE TABLE IF NOT EXISTS short_links (
    code TEXT PRIMARY KEY, target TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, hits INTEGER NOT NULL DEFAULT 0)`);
  const byTarget = db.prepare('SELECT code FROM short_links WHERE target = ?');
  const byCode = db.prepare('SELECT target FROM short_links WHERE code = ?');
  const insert = db.prepare('INSERT INTO short_links (code, target, created_at) VALUES (?, ?, ?)');
  const hit = db.prepare('UPDATE short_links SET hits = hits + 1 WHERE code = ?');
  const base = (req) => `${req.protocol}://${req.get('host')}`;
  const recent = new Map(); // ip → [times], a simple limit against filling the table

  /** The path of an address of this site (path, query and fragment), or null. */
  function ownPath(raw, req) {
    if (typeof raw !== 'string' || !raw || raw.length > MAX_URL) return null;
    let u;
    try { u = new URL(raw, base(req)); } catch { return null; }
    if (u.host !== req.get('host') || !/^https?:$/.test(u.protocol)) return null;
    return `${u.pathname}${u.search}${u.hash}`;
  }

  app.post('/api/kurzlink', json, (req, res) => {
    const target = ownPath(req.body?.url, req);
    if (!target) return res.status(400).json({ error: 'Nur Adressen dieser Seite' });
    const ip = req.ip || 'x';
    const times = (recent.get(ip) || []).filter((t) => now() - t < 3600000);
    let code = byTarget.get(target)?.code;
    if (!code) {
      if (times.length >= PER_HOUR) return res.status(429).json({ error: 'Zu viele Kurzlinks, bitte später' });
      times.push(now());
      recent.set(ip, times);
      for (let i = 0; i < 5 && !code; i++) {
        const c = [...crypto.randomBytes(6)].map((b) => ALPHABET[b % ALPHABET.length]).join('');
        try { insert.run(c, target, now()); code = c; } catch { /* taken: next */ }
      }
      if (!code) return res.status(500).json({ error: 'Kein Kurzlink frei' });
    }
    res.json({ code, url: `${base(req)}/k/${code}`, qr: `/k/${code}.svg` });
  });

  app.get('/k/:code.svg', async (req, res) => {
    if (!byCode.get(req.params.code)) return res.status(404).end();
    const svg = await QRCode.toString(`${base(req)}/k/${req.params.code}`, { type: 'svg', margin: 2, errorCorrectionLevel: 'M', color: { dark: '#16301f', light: '#ffffff' } });
    res.set('Cache-Control', 'public, max-age=86400').type('image/svg+xml').send(svg);
  });

  app.get('/k/:code', (req, res) => {
    const row = byCode.get(req.params.code);
    if (!row) return res.status(404).type('text/plain').send('Kurzlink unbekannt');
    hit.run(req.params.code);
    res.redirect(302, row.target);
  });
};
