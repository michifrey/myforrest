'use strict';

/*
 * OpenStreetMap and Wikimedia around a spot: what the place is known as in
 * Wikipedia, Wikidata and Wikimedia Commons, and how far OSM and Wikidata
 * are linked there.
 *
 *  - OSM objects within RADIUS_M that carry a `wikidata`, `wikipedia` or
 *    `species:wikidata` tag (forest, nature reserve, peak, glacier, a
 *    remarkable tree …), through the Overpass API of the path network
 *    (WEGNETZ_URL); without one this part is left out.
 *  - Wikidata items with coordinates within RADIUS_M (SPARQL,
 *    wikibase:around), so items that no OSM object links to yet show up too,
 *    as a hint for mappers.
 *  - For all of them, from Wikidata: name, description, picture (P18),
 *    Commons category (P373) and the Wikipedia article (de, fr, it, en).
 *  - Photos on Wikimedia Commons taken within PHOTO_RADIUS_M (geosearch on the
 *    camera position), with date, author and licence; a dated one with a
 *    licence MyForrest allows can become an archive photo of the spot.
 *
 * Results are cached per place for a week. WIKIMEDIA=0 turns all of it off.
 * Requests carry a User-Agent as the Wikimedia API rules ask.
 */

const { distanceM } = require('./geo');
const { licenseKey } = require('./archives');

const RADIUS_M = 500;
const PHOTO_RADIUS_M = 1000;
const TTL = 7 * 86400000;
const LANGS = ['de', 'fr', 'it', 'en'];
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const SPARQL = 'https://query.wikidata.org/sparql';
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const USER_AGENT = 'MyForrest/1.0 (https://github.com/michifrey/myforrest)';
const QID = /^Q[1-9]\d{0,11}$/;

// What an OSM object is, from its main tag (first match wins).
const KINDS = [
  ['natural', { tree: 'Baum', peak: 'Gipfel', glacier: 'Gletscher', wood: 'Wald', water: 'Gewässer', spring: 'Quelle', cave_entrance: 'Höhle', rock: 'Fels', stone: 'Findling', cliff: 'Felswand', wetland: 'Feuchtgebiet', ridge: 'Grat', valley: 'Tal', saddle: 'Pass', gorge: 'Schlucht' }],
  ['boundary', { protected_area: 'Schutzgebiet', national_park: 'Nationalpark' }],
  ['leisure', { nature_reserve: 'Naturschutzgebiet', park: 'Park' }],
  ['landuse', { forest: 'Wald' }],
  ['waterway', { river: 'Fluss', stream: 'Bach', waterfall: 'Wasserfall' }],
  ['historic', null], ['tourism', null], ['place', null], ['mountain_pass', null], ['amenity', null], ['building', null], ['man_made', null],
];
const GENERIC = { historic: 'Denkmal', tourism: 'Sehenswürdigkeit', place: 'Ort', mountain_pass: 'Pass', amenity: 'Einrichtung', building: 'Gebäude', man_made: 'Bauwerk' };

function kindOf(tags) {
  for (const [key, values] of KINDS) {
    const v = tags[key];
    if (!v || v === 'no') continue;
    if (values?.[v]) return values[v];
    if (!values) return GENERIC[key];
  }
  return null;
}

/** "de:Sihlwald" → { lang, title, url }, or null. */
function wikipediaOf(tag) {
  const m = /^([a-z]{2,3}(?:-[a-z]+)?):(.+)$/.exec(String(tag || '').trim());
  if (!m) return null;
  const title = m[2].trim();
  return { lang: m[1], title, url: `https://${m[1]}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}` };
}

/** Overpass answer → [{ osm, name, kind, lat, lon, wikidata, wikipedia, species }]. */
function parseOsm(body) {
  const out = [];
  for (const e of body?.elements || []) {
    const tags = e.tags || {};
    const lat = e.lat ?? e.center?.lat; const lon = e.lon ?? e.center?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const wikidata = QID.test(tags.wikidata || '') ? tags.wikidata : null;
    const species = QID.test(tags['species:wikidata'] || '') ? tags['species:wikidata'] : null;
    const wikipedia = wikipediaOf(tags.wikipedia);
    if (!wikidata && !species && !wikipedia) continue;
    out.push({
      osm: `${e.type}/${e.id}`, name: tags.name || tags['name:de'] || null, kind: kindOf(tags), lat, lon, wikidata, wikipedia, species,
    });
  }
  return out;
}

/** SPARQL JSON → [{ qid, lat, lon, osmRelation }]. */
function parseAround(body) {
  const out = [];
  for (const b of body?.results?.bindings || []) {
    const qid = /\/(Q\d+)$/.exec(b.item?.value || '')?.[1];
    const m = /Point\(([-\d.eE]+) ([-\d.eE]+)\)/.exec(b.coord?.value || '');
    if (!qid || !m) continue;
    if (out.some((o) => o.qid === qid)) continue; // items with several coordinates
    out.push({ qid, lat: Number(m[2]), lon: Number(m[1]), osmRelation: b.osm?.value ? `relation/${b.osm.value}` : null });
  }
  return out;
}

const first = (obj) => LANGS.map((l) => obj?.[l]?.value).find(Boolean) || null;
const claimString = (claims, p) => claims?.[p]?.find((c) => c.mainsnak?.datavalue)?.mainsnak.datavalue.value ?? null;

/** Commons file name → thumbnail URL of the given width (through Special:FilePath, which redirects to the file). */
const filePath = (file, width) => `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(String(file).replace(/ /g, '_'))}${width ? `?width=${width}` : ''}`;

/** wbgetentities answer → Map(qid → { label, description, image, commonsCategory, wikipedia }). */
function parseEntities(body) {
  const map = new Map();
  for (const [qid, e] of Object.entries(body?.entities || {})) {
    if (e.missing !== undefined) continue;
    const image = claimString(e.claims, 'P18');
    const category = claimString(e.claims, 'P373');
    const site = LANGS.map((l) => e.sitelinks?.[`${l}wiki`]).find(Boolean);
    map.set(qid, {
      label: first(e.labels), description: first(e.descriptions),
      image: image ? { file: image, thumb: filePath(image, 320), page: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(image.replace(/ /g, '_'))}` } : null,
      commonsCategory: category ? { name: category, url: `https://commons.wikimedia.org/wiki/Category:${encodeURIComponent(category.replace(/ /g, '_'))}` } : null,
      wikipedia: site ? { lang: site.site.replace(/wiki$/, ''), title: site.title, url: site.url || `https://${site.site.replace(/wiki$/, '')}.wikipedia.org/wiki/${encodeURIComponent(site.title.replace(/ /g, '_'))}` } : null,
    });
  }
  return map;
}

const stripHtml = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/** "2009-07-14 10:32:00", "1932", "14 July 1932" … → { date: 'YYYY[-MM[-DD]]', takenAt } or null. */
function commonsDate(v) {
  const s = stripHtml(v);
  const iso = /(\d{4})(?:[-:](\d{2})(?:[-:](\d{2}))?)?/.exec(s);
  if (!iso) return null;
  const y = Number(iso[1]);
  if (y < 1826 || y > 2100) return null; // the first photographs
  const mo = iso[2] ? Number(iso[2]) : null; const d = iso[3] ? Number(iso[3]) : null;
  const date = [iso[1], mo && String(mo).padStart(2, '0'), d && String(d).padStart(2, '0')].filter(Boolean).join('-');
  return { date, year: y, takenAt: Date.UTC(y, (mo || 7) - 1, d || (mo ? 15 : 1), 12) };
}

/** Commons geosearch answer → photos [{ id, file, title, page, thumb, image, date, year, takenAt, author, license, licenseKey, lat, lon }]. */
function parseCommons(body) {
  const out = [];
  for (const p of body?.query?.pages || []) {
    const info = p.imageinfo?.[0];
    const c = p.coordinates?.[0];
    if (!info || !c || !/^image\/(jpeg|png|tiff|webp)$/.test(info.mime || '')) continue;
    const m = info.extmetadata || {};
    const file = String(p.title || '').replace(/^File:/, '');
    const when = commonsDate(m.DateTimeOriginal?.value);
    const license = stripHtml(m.LicenseShortName?.value) || null;
    out.push({
      id: `commons:${file}`, file, title: stripHtml(m.ObjectName?.value) || file.replace(/\.[a-z]+$/i, '').replace(/_/g, ' '),
      page: info.descriptionurl || `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(file.replace(/ /g, '_'))}`,
      thumb: info.thumburl || filePath(file, 320), image: filePath(file, 2560),
      date: when?.date || null, year: when?.year || null, takenAt: when?.takenAt ?? null,
      author: stripHtml(m.Artist?.value).slice(0, 200) || null, license, licenseKey: licenseKey(license),
      lat: c.lat, lon: c.lon,
    });
  }
  return out;
}

function createWikimedia({
  db, fetchImpl = fetch, now = () => Date.now(), overpassUrl = process.env.WEGNETZ_URL || '', overpassFetch = fetchImpl,
  enabled = !['0', 'aus', 'false', 'off'].includes(String(process.env.WIKIMEDIA ?? '').toLowerCase()), timeoutMs = 20000,
} = {}) {
  db.exec('CREATE TABLE IF NOT EXISTS weather_cache (key TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at INTEGER NOT NULL)');
  const get = db.prepare('SELECT json, fetched_at FROM weather_cache WHERE key = ?');
  const set = db.prepare('INSERT OR REPLACE INTO weather_cache (key, json, fetched_at) VALUES (?, ?, ?)');
  const headers = { 'User-Agent': USER_AGENT, 'Api-User-Agent': USER_AGENT, accept: 'application/json' };

  async function getJson(url, what, init = {}, via = fetchImpl) {
    const res = await via(url, { ...init, headers: { ...headers, ...(init.headers || {}) }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`${what} antwortete mit HTTP ${res.status}`);
    return res.json();
  }

  async function osmNear(lat, lon) {
    const query = `[out:json][timeout:20];nwr(around:${RADIUS_M},${lat.toFixed(6)},${lon.toFixed(6)})[~"^(wikidata|wikipedia|species:wikidata)$"~"."];out tags center 80;`;
    return parseOsm(await getJson(overpassUrl, 'OpenStreetMap (Overpass)', {
      method: 'POST', body: new URLSearchParams({ data: query }), headers: { 'content-type': 'application/x-www-form-urlencoded' },
    }, overpassFetch));
  }

  async function wikidataNear(lat, lon) {
    const query = `SELECT ?item ?coord ?osm WHERE {
  SERVICE wikibase:around { ?item wdt:P625 ?coord . bd:serviceParam wikibase:center "Point(${lon.toFixed(6)} ${lat.toFixed(6)})"^^geo:wktLiteral ;
    wikibase:radius "${RADIUS_M / 1000}" . }
  OPTIONAL { ?item wdt:P402 ?osm . }
} LIMIT 60`;
    return parseAround(await getJson(`${SPARQL}?${new URLSearchParams({ query, format: 'json' })}`, 'Wikidata (SPARQL)', { headers: { accept: 'application/sparql-results+json' } }));
  }

  async function entities(qids) {
    const map = new Map();
    for (let i = 0; i < qids.length; i += 50) {
      const q = new URLSearchParams({
        action: 'wbgetentities', ids: qids.slice(i, i + 50).join('|'), props: 'labels|descriptions|claims|sitelinks/urls',
        languages: LANGS.join('|'), sitefilter: LANGS.map((l) => `${l}wiki`).join('|'), format: 'json',
      });
      for (const [k, v] of parseEntities(await getJson(`${WIKIDATA_API}?${q}`, 'Wikidata'))) map.set(k, v);
    }
    return map;
  }

  async function commonsNear(lat, lon) {
    const q = new URLSearchParams({
      action: 'query', format: 'json', formatversion: '2', generator: 'geosearch', ggscoord: `${lat.toFixed(6)}|${lon.toFixed(6)}`,
      ggsradius: String(PHOTO_RADIUS_M), ggsnamespace: '6', ggslimit: '50', prop: 'imageinfo|coordinates', iiprop: 'url|extmetadata|mime',
      iiurlwidth: '320', iiextmetadatafilter: 'DateTimeOriginal|LicenseShortName|Artist|ObjectName', colimit: '50',
    });
    return parseCommons(await getJson(`${COMMONS_API}?${q}`, 'Wikimedia Commons'));
  }

  /**
   * What OSM and Wikimedia know around (lat, lon): { items, photos, errors }.
   * items: [{ qid, label, description, kind, distanceM, osm: ['way/1'], inOsm, wikipedia, image, commonsCategory, relation }]
   * (relation 'art' for the species of a tree), nearest first; photos nearest first. A part that fails leaves
   * its message in `errors` and the rest stands.
   */
  async function near(lat, lon) {
    const key = `wikimedia1:${lat.toFixed(4)},${lon.toFixed(4)}:${overpassUrl ? 'osm' : ''}`;
    const row = get.get(key);
    if (row && now() - row.fetched_at < TTL) return JSON.parse(row.json);
    const errors = [];
    const soft = (p) => p.catch((err) => { errors.push(err.message); return []; });
    const [osm, around, photos] = await Promise.all([
      overpassUrl ? soft(osmNear(lat, lon)) : [], soft(wikidataNear(lat, lon)), soft(commonsNear(lat, lon)),
    ]);
    // One entry per Wikidata item; OSM objects without one (only a wikipedia tag) stand on their own.
    const byQid = new Map();
    const loose = [];
    const here = { lat, lon };
    for (const o of osm) {
      const d = Math.round(distanceM(here, o));
      for (const [qid, relation] of [[o.wikidata, null], [o.species, 'art']]) {
        if (!qid) continue;
        const e = byQid.get(qid) || { qid, osm: [], kind: null, name: null, distanceM: d, relation };
        if (!e.osm.includes(o.osm)) e.osm.push(o.osm);
        if (!relation) { e.kind = e.kind || o.kind; e.name = e.name || o.name; e.relation = null; e.osmWikipedia = e.osmWikipedia || o.wikipedia; }
        e.distanceM = Math.min(e.distanceM, d);
        byQid.set(qid, e);
      }
      if (!o.wikidata && !o.species) loose.push({ qid: null, osm: [o.osm], kind: o.kind, name: o.name, distanceM: d, relation: null, wikipedia: o.wikipedia });
    }
    for (const a of around) {
      const d = Math.round(distanceM(here, a));
      const e = byQid.get(a.qid) || { qid: a.qid, osm: [], kind: null, name: null, distanceM: d, relation: null };
      if (a.osmRelation && !e.osm.includes(a.osmRelation)) e.osm.push(a.osmRelation);
      e.distanceM = Math.min(e.distanceM, d);
      e.wikidataCoords = true;
      byQid.set(a.qid, e);
    }
    let info = new Map();
    if (byQid.size) {
      try { info = await entities([...byQid.keys()].slice(0, 150)); } catch (err) { errors.push(err.message); }
    }
    const items = [...byQid.values()].map((e) => {
      const w = info.get(e.qid) || {};
      return {
        qid: e.qid, url: `https://www.wikidata.org/wiki/${e.qid}`, label: w.label || e.name || e.qid, description: w.description || null,
        kind: e.kind, relation: e.relation, distanceM: e.distanceM, osm: e.osm, inOsm: e.osm.length > 0,
        wikipedia: w.wikipedia || e.osmWikipedia || null, image: w.image || null, commonsCategory: w.commonsCategory || null,
      };
    }).concat(loose.map((o) => ({ ...o, url: null, label: o.name || o.wikipedia?.title || o.osm[0], description: null, inOsm: true, image: null, commonsCategory: null })));
    items.sort((a, b) => (a.relation === 'art') - (b.relation === 'art') || a.distanceM - b.distanceM);
    const value = {
      items: items.slice(0, 40),
      photos: photos.map((p) => ({ ...p, distanceM: Math.round(distanceM(here, p)) })).sort((a, b) => a.distanceM - b.distanceM).slice(0, 30),
      osm: Boolean(overpassUrl), errors,
    };
    // A failed part is asked again next time, not after a week.
    if (!errors.length) set.run(key, JSON.stringify(value), now());
    return value;
  }

  /** Downloads a Commons photo (≤ 2560 px, through Special:FilePath) to `file`. */
  async function download(photo, file) {
    const res = await fetchImpl(photo.image, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow', signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`Wikimedia Commons antwortete mit HTTP ${res.status}`);
    if (!/^image\//.test(res.headers.get('content-type') || '')) throw new Error('Commons liefert kein Bild');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 30 * 1024 * 1024) throw new Error('Bild zu gross (höchstens 30 MB)');
    await require('node:fs').promises.writeFile(file, buf);
  }

  return { enabled: () => enabled, near, download, osm: Boolean(overpassUrl) };
}

module.exports = { createWikimedia, parseOsm, parseAround, parseEntities, parseCommons, commonsDate, wikipediaOf, kindOf, RADIUS_M, PHOTO_RADIUS_M };
