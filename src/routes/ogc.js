'use strict';

/**
 * OGC API – Features (Part 1 Core + GeoJSON, Part 2 CRS) under /ogc, so GIS
 * software (QGIS: "WFS / OGC API – Features", ArcGIS, GDAL) and geoportals
 * can read MyForrest directly. Collections: spots, photos, plant findings
 * and spread fronts. Coordinates in WGS84 (CRS84) or Swiss LV95
 * (EPSG:2056) via `crs`; `bbox` (with `bbox-crs`), `datetime`, `limit` and
 * `offset` filter and page. Plus the GeoPackage export of all collections.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createGeodata, COLLECTIONS, CRS84, LV95, toLv95, bboxOf } = require('../geodata');
const { writeGeoPackage } = require('../gpkg');
const { lv95ToWgs84 } = require('../lv95');
const { metadataRecord, recordUuid } = require('../metadata');
const { featureCatalogue, catalogueUuid, collectionUuid, COLLECTION_TEXT } = require('../featurecatalogue');
const { LICENSES, DEFAULT_LICENSE } = require('../moderation');

const CRS_LIST = [CRS84, LV95];
const CONFORMANCE = [
  'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core',
  'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/geojson',
  'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/oas30',
  'http://www.opengis.net/spec/ogcapi-features-2/1.0/conf/crs',
];
const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10000;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** `datetime` as [from, to] in ms (open ends as ±Infinity): an instant, "a/b", "../b" or "a/..". */
function parseDatetime(value) {
  if (value === undefined || value === '') return null;
  const parse = (v, end) => {
    if (v === '..' || v === '') return end ? Infinity : -Infinity;
    // A bare date covers the whole day.
    const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T${end ? '23:59:59.999' : '00:00:00'}Z` : v);
    if (!Number.isFinite(t)) throw new HttpError(400, `Ungültiges datetime: ${v}`);
    return t;
  };
  const parts = String(value).split('/');
  if (parts.length === 1) return [parse(parts[0], false), parse(parts[0], true)];
  if (parts.length !== 2) throw new HttpError(400, 'datetime: Zeitpunkt oder Intervall a/b angeben');
  return [parse(parts[0], false), parse(parts[1], true)];
}

/** bbox in WGS84 [w, s, e, n], converting from LV95 when bbox-crs says so. */
function parseBbox(value, bboxCrs) {
  if (value === undefined || value === '') return null;
  const v = String(value).split(',').map(Number);
  if (v.length !== 4 || !v.every(Number.isFinite)) throw new HttpError(400, 'bbox: vier Zahlen minX,minY,maxX,maxY');
  const crs = bboxCrs || CRS84;
  if (!CRS_LIST.includes(crs)) throw new HttpError(400, `bbox-crs nicht unterstützt: ${crs}`);
  if (crs === CRS84) return v;
  const [s, w] = lv95ToWgs84(v[0], v[1]);
  const [n, e] = lv95ToWgs84(v[2], v[3]);
  return [w, s, e, n];
}

/** Time range of a feature for `datetime` filtering. */
function featureTime(f, id) {
  const p = f.properties;
  if (id === 'spread_fronts') return [Date.UTC(p.year, 0, 1), Date.UTC(p.year, 11, 31, 23, 59, 59, 999)];
  if (id === 'spots') return [Date.parse(p.first_photo), Date.parse(p.last_photo)];
  const t = Date.parse(p.taken_at);
  return [t, t];
}

/** Contact and catalogue settings of the metadata record (docs/installation.md). */
function metadataFromEnv(env = process.env) {
  return {
    organisation: env.METADATA_ORGANISATION || 'MyForrest',
    email: env.METADATA_EMAIL || env.ADMIN_EMAIL || null,
    city: env.METADATA_CITY || null,
    country: env.METADATA_COUNTRY || 'CH',
    url: env.METADATA_URL || null,
    uuid: env.METADATA_UUID || null,
    owsUrl: env.METADATA_OWS_URL || null,
    opendataTerms: env.METADATA_OPENDATA_TERMS || null,
  };
}

module.exports = function registerOgc(app, {
  db, spotRadiusM, publicUrl = process.env.PUBLIC_URL, dataDir, background, tiles: tileOptions = {}, metadata = metadataFromEnv(),
}) {
  const geodata = createGeodata({ db, spotRadiusM });
  const baseUrl = (req) => (publicUrl ? String(publicUrl).replace(/\/+$/, '') : `${req.protocol}://${req.get('host')}`);
  const link = (href, rel, type, title) => ({ href, rel, type, ...(title ? { title } : {}) });

  function collectionJson(id, base) {
    const c = COLLECTIONS[id];
    const feats = geodata.features(id, base);
    let bbox = [5.9, 45.8, 10.5, 47.8]; // Switzerland until there is data
    if (feats.length) {
      bbox = [Infinity, Infinity, -Infinity, -Infinity];
      for (const f of feats) {
        const b = bboxOf(f.geometry);
        bbox = [Math.min(bbox[0], b[0]), Math.min(bbox[1], b[1]), Math.max(bbox[2], b[2]), Math.max(bbox[3], b[3])];
      }
    }
    const times = feats.map((f) => featureTime(f, id));
    const interval = times.length
      ? [new Date(Math.min(...times.map((t) => t[0]))).toISOString(), new Date(Math.max(...times.map((t) => t[1]))).toISOString()]
      : [null, null];
    const url = `${base}/ogc/collections/${id}`;
    return {
      id,
      title: c.title,
      description: c.description,
      itemType: 'feature',
      extent: { spatial: { bbox: [bbox], crs: CRS84 }, temporal: { interval: [interval] } },
      crs: CRS_LIST,
      storageCrs: CRS84,
      links: [
        link(url, 'self', 'application/json', c.title),
        link(`${url}/items`, 'items', 'application/geo+json', `${c.title} (GeoJSON)`),
        link(`${url}/items?crs=${encodeURIComponent(LV95)}`, 'items', 'application/geo+json', `${c.title} (GeoJSON, LV95)`),
        link(`${url}/tiles`, 'http://www.opengis.net/def/rel/ogc/1.0/tilesets-vector', 'application/json', `${c.title} (Vektorkacheln)`),
        link(`${base}/api/metadata/collections/${id}/geocat.xml`, 'describedby', 'application/xml', `Metadaten ${c.title} für geocat.ch (ISO 19139, GM03)`),
        link(`${base}/api/metadata/objektkatalog.xml`, 'describedby', 'application/xml', 'Objektkatalog (ISO 19110)'),
      ],
    };
  }

  const send = (res, fn) => {
    try {
      fn();
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      res.status(err.status).json({ code: err.status === 404 ? 'NotFound' : 'InvalidParameterValue', description: err.message });
    }
  };

  // Public, read-only data: geoportals and web maps on other domains may load it.
  app.use('/ogc', (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    next();
  });

  // Vector tiles (OGC API – Tiles, MVT) of the same collections.
  const tiles = require('./ogc-tiles')(app, {
    geodata, baseUrl, link, send, HttpError, dataDir, background,
    startupBase: publicUrl ? String(publicUrl).replace(/\/+$/, '') : undefined,
    ...tileOptions,
  });
  app.locals.ogcTiles = tiles;

  app.get('/ogc', (req, res) => {
    const base = baseUrl(req);
    res.json({
      title: 'MyForrest – Wald im Wandel',
      description: 'Spots, Fotos, Pflanzenfunde und Ausbreitungsfronten als OGC API – Features (WGS84 und LV95) '
        + 'und als Vektorkacheln nach OGC API – Tiles (MVT).',
      links: [
        link(`${base}/ogc`, 'self', 'application/json', 'Diese Seite'),
        link(`${base}/ogc/api`, 'service-desc', 'application/vnd.oai.openapi+json;version=3.0', 'API-Beschreibung (OpenAPI)'),
        link(`${base}/ogc/conformance`, 'conformance', 'application/json', 'Konformitätsklassen'),
        link(`${base}/ogc/collections`, 'data', 'application/json', 'Collections'),
        link(`${base}/ogc/tiles`, tiles.TILESETS_REL, 'application/json', 'Vektorkacheln (MVT)'),
        link(`${base}/ogc/tileMatrixSets`, 'http://www.opengis.net/def/rel/ogc/1.0/tiling-schemes', 'application/json', 'Kachelgitter'),
        link(`${base}/ogc/styles/myforrest`, 'http://www.opengis.net/def/rel/ogc/1.0/styles', 'application/vnd.mapbox.style+json', 'Kartenstil (MapLibre)'),
        link(`${base}/api/export/myforrest.gpkg`, 'enclosure', 'application/geopackage+sqlite3', 'Alles als GeoPackage (LV95)'),
        link(`${base}/api/export/myforrest.pmtiles`, 'enclosure', 'application/vnd.pmtiles', 'Vektorkacheln als PMTiles (WebMercatorQuad)'),
        link(`${base}/api/export/myforrest.mbtiles`, 'enclosure', 'application/vnd.sqlite3', 'Vektorkacheln als MBTiles (WebMercatorQuad)'),
        link(`${base}/api/metadata/geocat.xml`, 'describedby', 'application/xml', 'Metadaten für geocat.ch (ISO 19139, Profil GM03)'),
        link(`${base}/api/metadata/iso19139.xml`, 'describedby', 'application/xml', 'Metadaten (ISO 19139)'),
        link(`${base}/api/metadata/objektkatalog.xml`, 'describedby', 'application/xml', 'Objektkatalog: alle Collections und Felder (ISO 19110)'),
      ],
    });
  });

  app.get('/ogc/conformance', (req, res) => res.json({ conformsTo: [...CONFORMANCE, ...tiles.conformance] }));

  app.get('/ogc/api', (req, res) => {
    const base = baseUrl(req);
    const param = (name, description, schema = { type: 'string' }) => ({ name, in: 'query', required: false, description, schema });
    const items = {
      get: {
        summary: 'Features einer Collection',
        parameters: [
          { name: 'collectionId', in: 'path', required: true, schema: { type: 'string', enum: Object.keys(COLLECTIONS) } },
          param('limit', 'Anzahl Features (Standard 1000, höchstens 10000)', { type: 'integer', minimum: 1, maximum: MAX_LIMIT }),
          param('offset', 'Überspringen (Seiten)', { type: 'integer', minimum: 0 }),
          param('bbox', 'minX,minY,maxX,maxY'),
          param('bbox-crs', 'CRS der bbox', { type: 'string', enum: CRS_LIST }),
          param('crs', 'CRS der Ausgabe', { type: 'string', enum: CRS_LIST }),
          param('datetime', 'Zeitpunkt oder Intervall (RFC 3339, ".." für offen)'),
        ],
        responses: { 200: { description: 'GeoJSON FeatureCollection', content: { 'application/geo+json': {} } } },
      },
    };
    res.type('application/vnd.oai.openapi+json;version=3.0').json({
      openapi: '3.0.3',
      info: { title: 'MyForrest OGC API – Features', version: '1.0.0' },
      servers: [{ url: `${base}/ogc` }],
      paths: {
        '/': { get: { summary: 'Landing page', responses: { 200: { description: 'Links' } } } },
        '/conformance': { get: { summary: 'Konformitätsklassen', responses: { 200: { description: 'conformsTo' } } } },
        '/collections': { get: { summary: 'Collections', responses: { 200: { description: 'Collections' } } } },
        '/collections/{collectionId}': { get: { summary: 'Eine Collection', parameters: [items.get.parameters[0]], responses: { 200: { description: 'Collection' } } } },
        '/collections/{collectionId}/items': items,
        '/collections/{collectionId}/items/{featureId}': {
          get: {
            summary: 'Ein Feature',
            parameters: [items.get.parameters[0], { name: 'featureId', in: 'path', required: true, schema: { type: 'string' } }, items.get.parameters[5]],
            responses: { 200: { description: 'GeoJSON Feature' } },
          },
        },
      },
    });
  });

  app.get('/ogc/collections', (req, res) => {
    const base = baseUrl(req);
    res.json({
      links: [link(`${base}/ogc/collections`, 'self', 'application/json')],
      crs: CRS_LIST,
      collections: Object.keys(COLLECTIONS).map((id) => collectionJson(id, base)),
    });
  });

  app.get('/ogc/collections/:id', (req, res) => send(res, () => {
    if (!COLLECTIONS[req.params.id]) throw new HttpError(404, 'Collection nicht gefunden');
    res.json(collectionJson(req.params.id, baseUrl(req)));
  }));

  const outputCrs = (req) => {
    const crs = req.query.crs || CRS84;
    if (!CRS_LIST.includes(crs)) throw new HttpError(400, `crs nicht unterstützt: ${crs} (möglich: ${CRS_LIST.join(', ')})`);
    return crs;
  };
  const project = (f, crs) => (crs === LV95 ? { ...f, geometry: toLv95(f.geometry) } : f);

  app.get('/ogc/collections/:id/items', (req, res) => send(res, () => {
    const { id } = req.params;
    if (!COLLECTIONS[id]) throw new HttpError(404, 'Collection nicht gefunden');
    const crs = outputCrs(req);
    const limit = req.query.limit === undefined ? DEFAULT_LIMIT : Number(req.query.limit);
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
    if (!Number.isInteger(limit) || limit < 1) throw new HttpError(400, 'limit muss eine positive ganze Zahl sein');
    if (!Number.isInteger(offset) || offset < 0) throw new HttpError(400, 'offset muss eine ganze Zahl ≥ 0 sein');
    const bbox = parseBbox(req.query.bbox, req.query['bbox-crs']);
    const time = parseDatetime(req.query.datetime);
    const base = baseUrl(req);
    let feats = geodata.features(id, base);
    if (bbox) {
      feats = feats.filter((f) => {
        const b = bboxOf(f.geometry);
        return b[0] <= bbox[2] && b[2] >= bbox[0] && b[1] <= bbox[3] && b[3] >= bbox[1];
      });
    }
    if (time) feats = feats.filter((f) => { const [a, b] = featureTime(f, id); return a <= time[1] && b >= time[0]; });
    const n = Math.min(limit, MAX_LIMIT);
    const page = feats.slice(offset, offset + n).map((f) => project(f, crs));
    const self = new URL(`${base}/ogc/collections/${id}/items`);
    for (const [k, v] of Object.entries(req.query)) self.searchParams.set(k, String(v));
    const links = [link(self.href, 'self', 'application/geo+json'), link(`${base}/ogc/collections/${id}`, 'collection', 'application/json')];
    if (offset + n < feats.length) {
      const next = new URL(self.href);
      next.searchParams.set('offset', String(offset + n));
      next.searchParams.set('limit', String(n));
      links.push(link(next.href, 'next', 'application/geo+json', 'Nächste Seite'));
    }
    res.set('Content-Crs', `<${crs}>`);
    res.type('application/geo+json').send(JSON.stringify({
      type: 'FeatureCollection',
      timeStamp: new Date().toISOString(),
      numberMatched: feats.length,
      numberReturned: page.length,
      features: page,
      links,
    }));
  }));

  app.get('/ogc/collections/:id/items/:fid', (req, res) => send(res, () => {
    const { id, fid } = req.params;
    if (!COLLECTIONS[id]) throw new HttpError(404, 'Collection nicht gefunden');
    const crs = outputCrs(req);
    const f = geodata.features(id, baseUrl(req)).find((x) => x.id === fid);
    if (!f) throw new HttpError(404, 'Feature nicht gefunden');
    res.set('Content-Crs', `<${crs}>`);
    const base = baseUrl(req);
    res.type('application/geo+json').send(JSON.stringify({
      ...project(f, crs),
      links: [
        link(`${base}/ogc/collections/${id}/items/${encodeURIComponent(fid)}`, 'self', 'application/geo+json'),
        link(`${base}/ogc/collections/${id}`, 'collection', 'application/json'),
      ],
    }));
  }));

  /**
   * All collections as one GeoPackage (OGC GeoPackage 1.3), the format QGIS
   * Server, GeoServer or a geoportal publishes as WMS/WFS. LV95 by default
   * (Swiss geoportals), `crs=4326` for WGS84.
   */
  /**
   * Metadata record of the dataset (src/metadata.js): geocat.xml in the Swiss
   * profile GM03 (ISO19139.che) to import into geocat.ch, iso19139.xml as plain
   * ISO 19139 for other catalogues.
   */
  function metadataInfo(base, ids = ['spots', 'photos', 'spread_fronts']) {
    const feats = ids.flatMap((id) => geodata.features(id, base));
    let bbox = [5.9, 45.8, 10.5, 47.8]; // Switzerland until there is data
    if (feats.length) {
      bbox = [Infinity, Infinity, -Infinity, -Infinity];
      for (const f of feats) {
        const b = bboxOf(f.geometry);
        bbox = [Math.min(bbox[0], b[0]), Math.min(bbox[1], b[1]), Math.max(bbox[2], b[2]), Math.max(bbox[3], b[3])];
      }
    }
    const taken = geodata.features('photos', base).map((f) => Date.parse(f.properties.taken_at));
    const hidden = db.prepare('PRAGMA table_info(photos)').all().some((c) => c.name === 'protected') ? 'WHERE hidden_at IS NULL AND protected = 0' : '';
    const added = db.prepare(`SELECT MIN(created_at) AS first, MAX(created_at) AS last FROM photos ${hidden}`).get();
    const now = Date.now();
    return {
      base,
      bbox,
      firstPhoto: taken.length ? Math.min(...taken) : null,
      lastPhoto: taken.length ? Math.max(...taken) : null,
      created: added.first ?? now,
      updated: added.last ?? now,
    };
  }
  const contactOf = () => ({ organisation: metadata.organisation, email: metadata.email, city: metadata.city, country: metadata.country, url: metadata.url });
  const today = () => new Date().toISOString().slice(0, 10);
  const catalogueRef = (base, featureTypes) => ({ uuid: catalogueUuid(base), url: `${base}/api/metadata/objektkatalog.xml`, date: today(), featureTypes });
  const recordOptions = (profile) => {
    const license = LICENSES[DEFAULT_LICENSE];
    return {
      profile, uuid: metadata.uuid, owsUrl: metadata.owsUrl, opendataTerms: metadata.opendataTerms,
      licenseUrl: license.url.replace(/deed\.\w+$/, ''), licenseLabel: license.label,
    };
  };
  for (const [file, profile] of [['geocat.xml', 'che'], ['iso19139.xml', 'iso']]) {
    app.get(`/api/metadata/${file}`, (req, res) => {
      const base = baseUrl(req);
      res.set('Access-Control-Allow-Origin', '*');
      res.type('application/xml').send(metadataRecord(metadataInfo(base), contactOf(), {
        ...recordOptions(profile), catalogue: catalogueRef(base, Object.keys(COLLECTIONS)),
      }));
    });
    /** One record per collection, as a part of the dataset record (parentIdentifier). */
    app.get(`/api/metadata/collections/:id/${file}`, (req, res) => {
      const { id } = req.params;
      if (!COLLECTIONS[id]) return res.status(404).json({ error: 'Collection nicht gefunden' });
      const base = baseUrl(req);
      const url = `${base}/ogc/collections/${id}`;
      const text = COLLECTION_TEXT[id];
      const lang = (de) => ({ DE: de, FR: de, IT: de, EN: de });
      res.set('Access-Control-Allow-Origin', '*');
      res.type('application/xml').send(metadataRecord(metadataInfo(base, [id]), contactOf(), {
        ...recordOptions(profile),
        part: {
          id, uuid: collectionUuid(recordUuid(base, metadata.uuid), id), title: text.title, abstract: text.abstract,
          resources: [
            { url: `${url}/items`, protocol: 'WWW:DOWNLOAD-URL', fn: 'download', name: `${id}.geojson`, text: lang(`Download: ${COLLECTIONS[id].title} als GeoJSON (OGC API – Features)`) },
            { url: `${url}/tiles`, protocol: 'WWW:LINK', fn: 'information', name: `${id} (Vektorkacheln)`, text: lang(`${COLLECTIONS[id].title} als Vektorkacheln (OGC API – Tiles)`) },
          ],
        },
        catalogue: catalogueRef(base, [id]),
      }));
    });
  }
  app.get('/api/metadata/objektkatalog.xml', (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.type('application/xml').send(featureCatalogue({ base: baseUrl(req), contact: contactOf(), date: today() }));
  });

  app.get('/api/export/myforrest.gpkg', (req, res, next) => {
    const srs = req.query.crs === undefined || req.query.crs === '2056' ? 2056 : req.query.crs === '4326' ? 4326 : null;
    if (!srs) return res.status(400).json({ error: 'crs: 2056 (LV95) oder 4326 (WGS84)' });
    const base = baseUrl(req);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-gpkg-')), 'myforrest.gpkg');
    try {
      writeGeoPackage(file, Object.entries(COLLECTIONS).map(([id, c]) => ({
        name: id,
        title: c.title,
        description: c.description,
        geometryType: c.geometry,
        fields: c.fields,
        features: geodata.features(id, base).map((f) => (srs === 2056 ? { ...f, geometry: toLv95(f.geometry) } : f)),
      })), { srsId: srs });
    } catch (err) {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
      return next(err);
    }
    const day = new Date().toISOString().slice(0, 10);
    res.download(file, `myforrest-${srs === 2056 ? 'lv95' : 'wgs84'}-${day}.gpkg`, () => {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    });
    return undefined;
  });
};

module.exports.parseDatetime = parseDatetime;
