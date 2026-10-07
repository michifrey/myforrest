'use strict';

/**
 * MyForrest data as GIS feature collections, for the OGC API – Features
 * service (routes/ogc.js) and the GeoPackage export (gpkg.js). Geometries
 * are GeoJSON in WGS84 (lon, lat); `reproject` turns them into LV95
 * (EPSG:2056, E/N) for Swiss services. Photos hidden by moderators never
 * appear.
 */

const { wgs84ToLv95 } = require('./lv95');
const { listOccurrences, speciesSummary, licenseForExport } = require('./occurrences');
const { spreadFronts } = require('./spread');

const CRS84 = 'http://www.opengis.net/def/crs/OGC/1.3/CRS84';
const LV95 = 'http://www.opengis.net/def/crs/EPSG/0/2056';

/** Columns of every collection with their SQL type, so the GeoPackage gets typed tables even when empty. */
const COLLECTIONS = {
  spots: {
    title: 'Spots',
    description: 'Orte, an denen über die Zeit Fotos entstanden sind (Wiederholungsfoto-Standorte).',
    geometry: 'POINT',
    fields: {
      spot_id: 'INTEGER', photos: 'INTEGER', first_photo: 'TEXT', last_photo: 'TEXT', years: 'INTEGER',
      heading: 'REAL', elevation: 'REAL', tags: 'TEXT', latest_photo_url: 'TEXT',
    },
    time: ['first_photo', 'last_photo'],
  },
  photos: {
    title: 'Fotos',
    description: 'Einzelne Fotos mit Aufnahmezeit, Blickrichtung, Tags und Lizenz.',
    geometry: 'POINT',
    fields: {
      photo_id: 'INTEGER', spot_id: 'INTEGER', taken_at: 'TEXT', heading: 'REAL', location_source: 'TEXT',
      activity: 'TEXT', tags: 'TEXT', note: 'TEXT', url: 'TEXT', license: 'TEXT', author: 'TEXT',
    },
    time: ['taken_at'],
  },
  findings: {
    title: 'Pflanzenfunde',
    description: 'Automatische Pflanzenbestimmungen (Pl@ntNet, bestes Ergebnis pro Foto ab Score 0,2), Neophyten markiert.',
    geometry: 'POINT',
    fields: {
      photo_id: 'INTEGER', scientific_name: 'TEXT', common_name: 'TEXT', neophyte: 'INTEGER', score: 'REAL',
      taken_at: 'TEXT', uncertainty_m: 'REAL', url: 'TEXT', license: 'TEXT',
    },
    time: ['taken_at'],
  },
  spread_fronts: {
    title: 'Ausbreitungsfronten',
    description: 'Besiedelte Fläche pro Art und Jahr (Alpha-Shape aller Funde bis zu diesem Jahr, 25 m Puffer).',
    geometry: 'MULTIPOLYGON',
    fields: {
      scientific_name: 'TEXT', common_name: 'TEXT', neophyte: 'INTEGER', year: 'INTEGER', findings: 'INTEGER',
      area_m2: 'REAL', patches: 'INTEGER', front_radius_m: 'REAL', alpha_m: 'REAL',
    },
    time: ['year'],
  },
};

const iso = (ms) => new Date(ms).toISOString();

function createGeodata({ db, spotRadiusM = 25 }) {
  const hasHidden = db.prepare('PRAGMA table_info(photos)').all().some((c) => c.name === 'hidden_at');
  const visible = (alias) => (hasHidden ? `${alias}.hidden_at IS NULL` : '1 = 1');
  const hasUsers = () => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get());
  const tagsOf = db.prepare('SELECT tag FROM photo_tags WHERE photo_id = ? ORDER BY tag');

  /** Changes whenever photos or identifications change; keys the cache of computed collections. */
  const version = () => {
    const p = db.prepare(`SELECT COUNT(*) n, COALESCE(MAX(id), 0) m, COALESCE(SUM(${hasHidden ? 'hidden_at IS NOT NULL' : 0}), 0) h FROM photos`).get();
    const i = db.prepare('SELECT COUNT(*) n, COALESCE(MAX(id), 0) m FROM identifications').get();
    const t = db.prepare('SELECT COUNT(*) n FROM photo_tags').get();
    return `${p.n}:${p.m}:${p.h}:${i.n}:${i.m}:${t.n}`;
  };
  const cache = new Map();

  function spots(base) {
    const rows = db.prepare(`
      SELECT s.id, s.lat, s.lon, ${cols('spots').has('heading') ? 's.heading' : 'NULL'} AS heading,
             ${cols('spots').has('elevation') ? 's.elevation' : 'NULL'} AS elevation,
             COUNT(p.id) AS photos, MIN(p.taken_at) AS first, MAX(p.taken_at) AS last
      FROM spots s JOIN photos p ON p.spot_id = s.id AND ${visible('p')}
      GROUP BY s.id ORDER BY s.id`).all();
    return rows.map((r) => {
      const latest = db.prepare(`SELECT id, file FROM photos p WHERE spot_id = ? AND ${visible('p')} ORDER BY taken_at DESC LIMIT 1`).get(r.id);
      const tags = db.prepare(`SELECT DISTINCT t.tag FROM photo_tags t JOIN photos p ON p.id = t.photo_id WHERE p.spot_id = ? AND ${visible('p')} ORDER BY t.tag`).all(r.id);
      return feature(`spot.${r.id}`, point(r.lat, r.lon), {
        spot_id: r.id,
        photos: r.photos,
        first_photo: iso(r.first),
        last_photo: iso(r.last),
        years: new Date(r.last).getUTCFullYear() - new Date(r.first).getUTCFullYear(),
        heading: r.heading ?? null,
        elevation: r.elevation ?? null,
        tags: tags.map((t) => t.tag).join(', ') || null,
        latest_photo_url: latest ? `${base}/uploads/${latest.file}` : null,
      });
    });
  }

  const colsCache = new Map();
  function cols(table) {
    if (!colsCache.has(table)) colsCache.set(table, new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)));
    return colsCache.get(table);
  }

  function photos(base) {
    const pc = cols('photos');
    const author = pc.has('uploader_id') && hasUsers() ? '(SELECT name FROM users u WHERE u.id = p.uploader_id)' : 'NULL';
    const rows = db.prepare(`
      SELECT p.id, p.spot_id, p.file, p.taken_at, p.lat, p.lon, p.heading, p.location_source, p.activity, p.note,
             ${pc.has('license') ? 'p.license' : 'NULL'} AS license, ${author} AS author
      FROM photos p WHERE ${visible('p')} ORDER BY p.taken_at, p.id`).all();
    return rows.map((r) => feature(`photo.${r.id}`, point(r.lat, r.lon), {
      photo_id: r.id,
      spot_id: r.spot_id,
      taken_at: iso(r.taken_at),
      heading: r.heading ?? null,
      location_source: r.location_source,
      activity: r.activity ?? null,
      tags: tagsOf.all(r.id).map((t) => t.tag).join(', ') || null,
      note: r.note ?? null,
      url: `${base}/uploads/${r.file}`,
      license: licenseForExport(r.license),
      author: r.author ?? null,
    }));
  }

  function findings(base) {
    return listOccurrences(db, { spotRadiusM }).map((o) => feature(`finding.${o.photoId}`, point(o.lat, o.lon), {
      photo_id: o.photoId,
      scientific_name: o.scientificName,
      common_name: o.neophyte || o.commonName || null,
      neophyte: o.neophyte ? 1 : 0,
      score: Math.round(o.score * 1000) / 1000,
      taken_at: iso(o.takenAt),
      uncertainty_m: o.uncertaintyM,
      url: `${base}/uploads/${o.file}`,
      license: o.license,
    }));
  }

  function fronts() {
    const out = [];
    for (const sp of speciesSummary(db, {})) {
      const occ = listOccurrences(db, { species: sp.scientificName, spotRadiusM });
      if (!occ.length) continue;
      const s = spreadFronts(occ);
      for (const y of s.years) {
        // Leaflet-style [lat, lon] rings → GeoJSON [lon, lat].
        const coordinates = y.polygons.map((poly) => poly.map((ring) => closeRing(ring.map(([la, lo]) => [lo, la]))));
        out.push(feature(`front.${slug(sp.scientificName)}.${y.year}`, { type: 'MultiPolygon', coordinates }, {
          scientific_name: sp.scientificName,
          common_name: sp.neophyte || sp.commonName || null,
          neophyte: sp.neophyte ? 1 : 0,
          year: y.year,
          findings: y.cumulativeCount,
          area_m2: y.areaM2,
          patches: y.patches,
          front_radius_m: y.frontRadiusM,
          alpha_m: s.alphaM,
        }));
      }
    }
    return out;
  }

  /** All features of a collection (WGS84), cached until the data changes. */
  function features(id, base) {
    if (!COLLECTIONS[id]) return null;
    const key = `${id}|${base}|${version()}`;
    if (!cache.has(key)) {
      if (cache.size > 20) cache.clear();
      const make = { spots, photos, findings, spread_fronts: fronts }[id];
      cache.set(key, make(base));
    }
    return cache.get(key);
  }

  return { features, version };
}

const slug = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const point = (lat, lon) => ({ type: 'Point', coordinates: [round6(lon), round6(lat)] });
const round6 = (v) => Math.round(v * 1e6) / 1e6;
const feature = (id, geometry, properties) => ({ type: 'Feature', id, geometry, properties });
const closeRing = (ring) => {
  const [a, b] = [ring[0], ring[ring.length - 1]];
  return a[0] === b[0] && a[1] === b[1] ? ring : [...ring, a];
};

/** Applies a coordinate function to every position of a GeoJSON geometry. */
function mapCoords(geometry, fn) {
  const walk = (c) => (typeof c[0] === 'number' ? fn(c) : c.map(walk));
  return { ...geometry, coordinates: walk(geometry.coordinates) };
}

/** GeoJSON geometry in WGS84 → LV95 (E, N). */
const toLv95 = (geometry) => mapCoords(geometry, ([lon, lat]) => wgs84ToLv95(lat, lon));

/** Bounding box [minX, minY, maxX, maxY] of a geometry. */
function bboxOf(geometry) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  mapCoords(geometry, ([x, y]) => {
    if (x < b[0]) b[0] = x;
    if (y < b[1]) b[1] = y;
    if (x > b[2]) b[2] = x;
    if (y > b[3]) b[3] = y;
    return [x, y];
  });
  return b;
}

module.exports = { createGeodata, COLLECTIONS, CRS84, LV95, toLv95, bboxOf, mapCoords };
