'use strict';

/*
 * Tree species near a spot from a public tree inventory, as suggestions for
 * the spot's species. By default the inventory of the canton of Geneva
 * (Inventaire cantonal des arbres, SITG; layer 1 of the ArcGIS service ICA,
 * with NOM_LATIN), queried through the ArcGIS REST API: the trees within a
 * radius of the spot, grouped by species. Only trees outside the forest are
 * recorded there, and older entries may be off by up to ~25 m, hence the
 * generous default radius. Field names are found by pattern, so other
 * ArcGIS tree layers (a city's tree register) work the same way.
 * Results are cached per spot position for a month (the inventory changes weekly).
 */

const { treeInfo } = require('./trees');
const { distanceM } = require('./geo');

const DEFAULT_URL = 'https://ge.ch/terags/rest/services/ICA/MapServer/1';
const DEFAULT_NAME = 'Bauminventar des Kantons Genf (SITG)';
const DEFAULT_ATTRIBUTION = '© SITG / État de Genève, Inventaire cantonal des arbres';
const DEFAULT_BBOX = [5.95, 46.12, 6.32, 46.37]; // west, south, east, north
const DEFAULT_RADIUS = 40;
const TTL = 30 * 86400000;
const MAX_TREES = 500;

// Field names by pattern (upper or lower case): Latin name, common name, height, crown, remarkable, status.
const FIELDS = {
  latin: /^(nom_latin|nom_complet|espece|taxon|species|scientific_?name|art_lat)/i,
  common: /^(nom_commun|nom_francais|nom_fr|common_?name|art_de|baumart)/i,
  height: /^(hauteur_totale|hauteur|height|hoehe)/i,
  crown: /^(diametre_couronne|couronne|crown)/i,
  remarkable: /^remarquable/i,
  status: /^(etat|statut|status|zustand)/i,
};
const GONE = /abattu|disparu|supprim|mort|gef(ä|ae)llt|entfernt|removed|felled/i;

const field = (attrs, re) => Object.keys(attrs).find((k) => re.test(k));
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

/** Latin binomial of an inventory name ("Platanus x hispanica Mill. ex Münchh." → "Platanus ×hispanica"). */
function binomial(name) {
  const parts = String(name || '').replace(/\s+[x×]\s+/g, ' ×').trim().split(/\s+/);
  return parts.length >= 2 ? `${parts[0]} ${parts[1]}` : parts[0] || '';
}

/**
 * Trees of an ArcGIS query result (`features` with `attributes` and point `geometry` in WGS84),
 * grouped by species around (lat, lon): [{ scientificName, commonName, count, nearestM, maxHeight,
 * remarkable, known }] nearest first. Trees marked as felled or gone are left out.
 */
function groupTrees(features, lat, lon) {
  const bySpecies = new Map();
  let trees = 0;
  for (const f of features || []) {
    const a = f.attributes || {};
    const latinKey = field(a, FIELDS.latin);
    const name = latinKey ? String(a[latinKey] || '').trim() : '';
    if (!name) continue;
    const statusKey = field(a, FIELDS.status);
    if (statusKey && GONE.test(String(a[statusKey] || ''))) continue;
    const g = f.geometry || {};
    const d = Number.isFinite(g.y) && Number.isFinite(g.x) ? distanceM({ lat, lon }, { lat: g.y, lon: g.x }) : null;
    const tree = treeInfo(name);
    const key = tree ? tree.sci : binomial(name);
    if (!bySpecies.has(key)) {
      const commonKey = field(a, FIELDS.common);
      bySpecies.set(key, {
        scientificName: key, name: tree?.de || null, commonName: commonKey ? String(a[commonKey] || '').trim() || null : null,
        count: 0, nearestM: null, maxHeight: null, remarkable: 0, known: Boolean(tree),
      });
    }
    const s = bySpecies.get(key);
    trees++;
    s.count++;
    if (d !== null && (s.nearestM === null || d < s.nearestM)) s.nearestM = Math.round(d);
    const h = num(a[field(a, FIELDS.height)]);
    if (h !== null && h > 0 && (s.maxHeight === null || h > s.maxHeight)) s.maxHeight = Math.round(h);
    const r = a[field(a, FIELDS.remarkable)];
    if (r === 1 || r === true || /^(1|oui|yes|ja|true)$/i.test(String(r ?? ''))) s.remarkable++;
  }
  const species = [...bySpecies.values()].sort((x, y) => (x.nearestM ?? 1e9) - (y.nearestM ?? 1e9) || y.count - x.count);
  return { trees, species };
}

function createTreeInventory({
  db, fetchImpl = fetch, now = () => Date.now(),
  url = process.env.BAUMINVENTAR_URL ?? DEFAULT_URL,
  name = process.env.BAUMINVENTAR_NAME || DEFAULT_NAME,
  attribution = process.env.BAUMINVENTAR_QUELLE || DEFAULT_ATTRIBUTION,
  bbox = process.env.BAUMINVENTAR_BBOX ? process.env.BAUMINVENTAR_BBOX.split(',').map(Number) : DEFAULT_BBOX,
  radiusM = Number(process.env.BAUMINVENTAR_RADIUS_M) || DEFAULT_RADIUS,
} = {}) {
  db.exec('CREATE TABLE IF NOT EXISTS weather_cache (key TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at INTEGER NOT NULL)');
  const get = db.prepare('SELECT json, fetched_at FROM weather_cache WHERE key = ?');
  const set = db.prepare('INSERT OR REPLACE INTO weather_cache (key, json, fetched_at) VALUES (?, ?, ?)');
  const enabled = Boolean(url);
  const covers = (lat, lon) => enabled && lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];

  /** The species within the radius of (lat, lon); throws when the service does not answer. */
  async function near(lat, lon) {
    const key = `baeume:${url}:${lat.toFixed(5)},${lon.toFixed(5)}:${radiusM}`;
    const row = get.get(key);
    if (row && now() - row.fetched_at < TTL) return JSON.parse(row.json);
    const q = new URLSearchParams({
      geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
      distance: String(radiusM), units: 'esriSRUnit_Meter', outFields: '*', returnGeometry: 'true', outSR: '4326',
      resultRecordCount: String(MAX_TREES), f: 'json',
    });
    const res = await fetchImpl(`${url.replace(/\/$/, '')}/query?${q}`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`Bauminventar antwortete mit HTTP ${res.status}`);
    const body = await res.json();
    if (body.error) throw new Error(`Bauminventar: ${body.error.message || 'Fehler'}`);
    const value = groupTrees(body.features, lat, lon);
    set.run(key, JSON.stringify(value), now());
    return value;
  }

  return { enabled, covers, near, name, attribution, radiusM, url };
}

/**
 * GET /api/spots/:id/tree-inventory: the species of the inventory near a spot that `req` may see, with
 * whether each is already recorded at the spot and whether MyForrest knows it (only those can be added).
 */
function registerTreeInventory(app, { db, inventory, accounts, idParam }) {
  app.get('/api/spots/:id/tree-inventory', async (req, res) => {
    const id = idParam(req, res);
    if (id === null) return;
    const spot = db.prepare(`SELECT s.id, s.lat, s.lon FROM spots s WHERE s.id = ?
      AND EXISTS (SELECT 1 FROM photos p WHERE p.spot_id = s.id AND ${accounts.visibleSql(req, 'p')})`).get(id);
    if (!spot) return res.status(404).json({ error: 'Spot nicht gefunden' });
    const base = { name: inventory.name, attribution: inventory.attribution, radiusM: inventory.radiusM };
    if (!inventory.covers(spot.lat, spot.lon)) return res.json({ ...base, covered: false, trees: 0, species: [] });
    const recorded = new Set(db.prepare('SELECT scientific_name FROM spot_species WHERE spot_id = ?').all(id).map((r) => r.scientific_name));
    try {
      const { trees, species } = await inventory.near(spot.lat, spot.lon);
      res.json({ ...base, covered: true, trees, species: species.map((s) => ({ ...s, atSpot: recorded.has(s.scientificName) })) });
    } catch (err) {
      res.json({ ...base, covered: true, trees: 0, species: [], error: err.message });
    }
  });
}

module.exports = { createTreeInventory, registerTreeInventory, groupTrees, binomial, DEFAULT_URL, DEFAULT_BBOX };
