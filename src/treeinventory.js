'use strict';

/*
 * Tree species near a spot from a public tree inventory, as suggestions for
 * the spot's species. By default the inventory of the canton of Geneva
 * (Inventaire cantonal des arbres, SITG; layer 1 of the ArcGIS service ICA,
 * with NOM_LATIN), queried through the ArcGIS REST API: the trees within a
 * radius of the spot, grouped by species. Only trees outside the forest are
 * recorded there, and older entries may be off by up to ~25 m, hence the
 * generous default radius. Field names are found by pattern, so other
 * ArcGIS tree layers work the same way. A WFS (`type: 'wfs'`) is asked for
 * the trees in a square around the spot in LV95, like the tree register of
 * the city of Zürich (Baumkataster, Grün Stadt Zürich), which is set up as a
 * second inventory by default.
 * Results are cached per spot position for a month (the inventory changes weekly).
 */

const { treeInfo } = require('./trees');
const { distanceM } = require('./geo');
const { wgs84ToLv95, lv95ToWgs84 } = require('./lv95');

const DEFAULT_URL = 'https://ge.ch/terags/rest/services/ICA/MapServer/1';
const DEFAULT_NAME = 'Bauminventar des Kantons Genf (SITG)';
const DEFAULT_ATTRIBUTION = '© SITG / État de Genève, Inventaire cantonal des arbres';
const DEFAULT_BBOX = [5.95, 46.12, 6.32, 46.37]; // west, south, east, north
const DEFAULT_RADIUS = 40;
// The tree register of the city of Zürich (WFS of the city's open data); the feature type is read from its capabilities.
const ZURICH = {
  type: 'wfs', url: 'https://www.ogd.stadt-zuerich.ch/wfs/geoportal/Baumkataster', name: 'Baumkataster der Stadt Zürich',
  attribution: '© Grün Stadt Zürich, Baumkataster (Open Data)', bbox: [8.44, 47.32, 8.63, 47.44],
};
const TTL = 30 * 86400000;
const MAX_TREES = 500;

// Field names by pattern (upper or lower case): Latin name, common name, height, crown, remarkable, status.
const FIELDS = {
  latin: /^(nom_latin|nom_complet|espece|taxon|species|scientific_?name|art_lat|baumart_?lat|baumartlat)/i,
  genus: /^(baumgattung_?lat|gattung_?lat|genus)/i,
  common: /^(nom_commun|nom_francais|nom_fr|common_?name|art_de|baumname_?deu|baumname_?d|baumart$)/i,
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
    let name = latinKey ? String(a[latinKey] || '').trim() : '';
    // Genus and species in two fields ("Acer" and "platanoides"): put together.
    const genusKey = field(a, FIELDS.genus);
    const genus = genusKey ? String(a[genusKey] || '').trim() : '';
    if (genus && (!name || !name.includes(' ')) && !name.toLowerCase().startsWith(genus.toLowerCase())) name = name ? `${genus} ${name}` : genus;
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
  type = 'arcgis', typeName = null,
} = {}) {
  db.exec('CREATE TABLE IF NOT EXISTS weather_cache (key TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at INTEGER NOT NULL)');
  const get = db.prepare('SELECT json, fetched_at FROM weather_cache WHERE key = ?');
  const set = db.prepare('INSERT OR REPLACE INTO weather_cache (key, json, fetched_at) VALUES (?, ?, ?)');
  const enabled = Boolean(url);
  const covers = (lat, lon) => enabled && lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];

  /** WFS: the feature type with trees, from the capabilities (the first whose name speaks of trees, else the first). */
  let featureType = typeName;
  async function wfsType() {
    if (featureType) return featureType;
    const res = await fetchImpl(`${url}${url.includes('?') ? '&' : '?'}SERVICE=WFS&VERSION=1.1.0&REQUEST=GetCapabilities`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`Bauminventar antwortete mit HTTP ${res.status}`);
    const names = [...(await res.text()).matchAll(/<(?:wfs:)?FeatureType\b[\s\S]*?<(?:wfs:)?Name>([^<]+)<\/(?:wfs:)?Name>/g)].map((m) => m[1].trim());
    featureType = names.find((n) => /baum|tree|arbre/i.test(n)) || names[0];
    if (!featureType) throw new Error('Bauminventar: keine Ebene im WFS');
    return featureType;
  }
  /** WFS: the trees in a square of twice the radius around the point, in LV95, as ArcGIS-like features in WGS84. */
  async function wfsFeatures(lat, lon) {
    const { e, n } = (() => { const p = wgs84ToLv95(lat, lon); return Array.isArray(p) ? { e: p[0], n: p[1] } : p; })();
    const q = new URLSearchParams({
      SERVICE: 'WFS', VERSION: '1.1.0', REQUEST: 'GetFeature', TYPENAME: await wfsType(), SRSNAME: 'EPSG:2056',
      BBOX: `${e - radiusM},${n - radiusM},${e + radiusM},${n + radiusM},EPSG:2056`, OUTPUTFORMAT: 'GeoJSON', MAXFEATURES: String(MAX_TREES),
    });
    const res = await fetchImpl(`${url}${url.includes('?') ? '&' : '?'}${q}`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`Bauminventar antwortete mit HTTP ${res.status}`);
    const body = await res.json();
    return (body.features || []).map((f) => {
      const c = f.geometry?.type === 'Point' ? f.geometry.coordinates : f.geometry?.coordinates?.[0];
      let geometry = {};
      if (Array.isArray(c) && Number.isFinite(c[0])) {
        // LV95 as asked; some servers answer in WGS84 anyway.
        const p = c[0] > 1e6 ? lv95ToWgs84(c[0], c[1]) : [c[1], c[0]];
        const [la, lo] = Array.isArray(p) ? p : [p.lat, p.lon];
        geometry = { x: lo, y: la };
      }
      return { attributes: f.properties || {}, geometry };
    }).filter((f) => Number.isFinite(f.geometry.x) && distanceM({ lat, lon }, { lat: f.geometry.y, lon: f.geometry.x }) <= radiusM);
  }

  /** The species within the radius of (lat, lon); throws when the service does not answer. */
  async function near(lat, lon) {
    const key = `baeume:${url}:${lat.toFixed(5)},${lon.toFixed(5)}:${radiusM}`;
    const row = get.get(key);
    if (row && now() - row.fetched_at < TTL) return JSON.parse(row.json);
    if (type === 'wfs') {
      const value = groupTrees(await wfsFeatures(lat, lon), lat, lon);
      set.run(key, JSON.stringify(value), now());
      return value;
    }
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
function registerTreeInventory(app, { db, inventory, inventories = [inventory], accounts, idParam }) {
  app.get('/api/spots/:id/tree-inventory', async (req, res) => {
    const id = idParam(req, res);
    if (id === null) return;
    const spot = db.prepare(`SELECT s.id, s.lat, s.lon FROM spots s WHERE s.id = ?
      AND EXISTS (SELECT 1 FROM photos p WHERE p.spot_id = s.id AND ${accounts.visibleSql(req, 'p')})`).get(id);
    if (!spot) return res.status(404).json({ error: 'Spot nicht gefunden' });
    // The first inventory whose area holds the spot.
    const inventory = inventories.find((inv) => inv.covers(spot.lat, spot.lon)) || inventories[0];
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

module.exports = { createTreeInventory, registerTreeInventory, groupTrees, binomial, DEFAULT_URL, DEFAULT_BBOX, ZURICH };
