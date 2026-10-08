'use strict';

/**
 * The canton of a spot, for the cantonal protection lists (src/sensitive.js):
 * one lookup per spot at swisstopo's identify service (canton areas of
 * swissBOUNDARIES3D), stored on the spot. '' means outside Switzerland;
 * null means not known (yet), and the lookup is tried again later.
 *
 *   CANTON_LOOKUP_URL  identify service (default api3.geo.admin.ch), empty = off
 */

const { wgs84ToLv95 } = require('./lv95');

const DEFAULT_URL = 'https://api3.geo.admin.ch/rest/services/api/MapServer/identify';
const LAYER = 'ch.swisstopo.swissboundaries3d-kanton-flaeche.fill';
const RETRY_MS = 6 * 3600 * 1000;

function createCantons({ db, fetchImpl = fetch, url = process.env.CANTON_LOOKUP_URL ?? DEFAULT_URL, now = () => Date.now() }) {
  const cols = new Set(db.prepare('PRAGMA table_info(spots)').all().map((c) => c.name));
  if (!cols.has('canton')) db.exec('ALTER TABLE spots ADD COLUMN canton TEXT');
  if (!cols.has('canton_checked_at')) db.exec('ALTER TABLE spots ADD COLUMN canton_checked_at INTEGER');

  /** Canton code at a place ('ZH'), '' outside Switzerland; throws when the service fails. */
  async function lookup(lat, lon) {
    const [e, n] = wgs84ToLv95(lat, lon);
    const q = new URLSearchParams({
      geometry: `${e},${n}`, geometryType: 'esriGeometryPoint', layers: `all:${LAYER}`, sr: '2056',
      tolerance: '0', mapExtent: `${e - 1},${n - 1},${e + 1},${n + 1}`, imageDisplay: '2,2,96', returnGeometry: 'false',
    });
    const res = await fetchImpl(`${url}?${q}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Kantonsabfrage: HTTP ${res.status}`);
    const body = await res.json();
    const code = body?.results?.map((r) => r.attributes?.ak).find((ak) => /^[A-Z]{2}$/.test(ak || ''));
    return code || '';
  }

  /** The stored canton of a spot, looked up once when missing (null when unknown). */
  async function ofSpot(spotId) {
    const s = db.prepare('SELECT lat, lon, canton, canton_checked_at FROM spots WHERE id = ?').get(spotId);
    if (!s) return null;
    if (s.canton !== null || !url) return s.canton;
    if (s.canton_checked_at && now() - s.canton_checked_at < RETRY_MS) return null;
    try {
      const canton = await lookup(s.lat, s.lon);
      db.prepare('UPDATE spots SET canton = ?, canton_checked_at = ? WHERE id = ?').run(canton, now(), spotId);
      return canton;
    } catch {
      db.prepare('UPDATE spots SET canton_checked_at = ? WHERE id = ?').run(now(), spotId);
      return null;
    }
  }

  return { lookup, ofSpot };
}

module.exports = { createCantons, LAYER };
