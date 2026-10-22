'use strict';

/**
 * Static STAC catalog (SpatioTemporal Asset Catalog 1.1) of the open
 * MyForrest data, the entry point of serverless geodata infrastructures such
 * as Portolan: catalog.json → myforrest/collection.json → one item per
 * collection (spots, photos, findings, spread_fronts) whose assets are the
 * GeoParquet files (WGS84 and LV95) and the GeoJSON; the collection carries
 * the GeoPackage and the vector tiles. All links between the documents are
 * relative, so the same set of files works served by the app (/stac/…) and
 * copied as a folder to an object storage (scripts/export-stac.js).
 */

const path = require('node:path');

const STAC_VERSION = '1.1.0';
const EXT = {
  table: 'https://stac-extensions.github.io/table/v1.2.0/schema.json',
  proj: 'https://stac-extensions.github.io/projection/v2.0.0/schema.json',
};
const PARQUET = 'application/vnd.apache.parquet';
const TABLE_TYPE = { TEXT: 'string', INTEGER: 'int64', REAL: 'double' };

const CATALOG = 'catalog.json';
const COLLECTION = 'myforrest/collection.json';
const itemPath = (id) => `myforrest/${id}/${id}.json`;

/** Href of `to` relative to the document at `from` (both paths inside the catalog). */
function relative(from, to) {
  const rel = path.posix.relative(path.posix.dirname(from), to);
  return rel.startsWith('.') ? rel : `./${rel}`;
}

const polygon = ([w, s, e, n]) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });

/**
 * All documents of the catalog as { path: json }.
 *
 * collections: { id: { title, description, fields, bbox, interval: [from, to] | [null, null], count } }
 * asset(file): href of a data file of the catalog (e.g. "myforrest/spots/spots.parquet"), or null when
 * this file is not published; files are spots.parquet, spots-lv95.parquet, spots.geojson per collection
 * and myforrest.gpkg, myforrest.pmtiles, geocat.xml at the collection.
 */
function stacDocuments({ collections, asset, title, description, provider, license, now = new Date() }) {
  const docs = {};
  const add = (list) => list.filter(([href]) => href).map(([href, rel, type, t]) => ({ rel, href, type, ...(t ? { title: t } : {}) }));
  const assets = (from, list) => Object.fromEntries(list
    .map(([key, file, a]) => [key, asset(path.posix.join(path.posix.dirname(from), file)), a])
    .filter(([, href]) => href)
    .map(([key, href, a]) => [key, { href: /^[a-z]+:/.test(href) ? href : relative(from, href), ...a }]));

  const ids = Object.keys(collections);
  const boxes = ids.map((id) => collections[id].bbox);
  const bbox = [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
  const starts = ids.map((id) => collections[id].interval[0]).filter(Boolean).sort();
  const ends = ids.map((id) => collections[id].interval[1]).filter(Boolean).sort();
  const interval = [starts[0] ?? null, ends.at(-1) ?? null];

  docs[CATALOG] = {
    type: 'Catalog',
    stac_version: STAC_VERSION,
    id: 'myforrest-katalog',
    title,
    description: `${description} Einstieg für Geodaten-Infrastrukturen ohne Server (STAC, GeoParquet, PMTiles).`,
    links: add([
      ['./catalog.json', 'root', 'application/json', title],
      ['./catalog.json', 'self', 'application/json'],
      [relative(CATALOG, COLLECTION), 'child', 'application/json', 'MyForrest – offene Daten'],
    ]),
  };

  docs[COLLECTION] = {
    type: 'Collection',
    stac_version: STAC_VERSION,
    stac_extensions: [EXT.proj],
    id: 'myforrest',
    title: 'MyForrest – offene Daten',
    description,
    keywords: ['Wald', 'Wiederholungsfotos', 'Neophyten', 'Waldschäden', 'Citizen Science', 'Schweiz'],
    license: license.spdx,
    providers: [{ name: provider.name, roles: ['producer', 'licensor', 'host'], ...(provider.url ? { url: provider.url } : {}) }],
    extent: { spatial: { bbox: [bbox] }, temporal: { interval: [interval] } },
    assets: assets(COLLECTION, [
      ['geopackage', 'myforrest.gpkg', { type: 'application/geopackage+sqlite3', title: 'Alle Collections als GeoPackage (LV95)', roles: ['data'], 'proj:code': 'EPSG:2056' }],
      ['pmtiles', 'myforrest.pmtiles', { type: 'application/vnd.pmtiles', title: 'Vektorkacheln (WebMercatorQuad, Zoom 0–18)', roles: ['visual'] }],
      ['metadata', 'geocat.xml', { type: 'application/xml', title: 'Metadaten für geocat.ch (ISO 19139, Profil GM03)', roles: ['metadata'] }],
    ]),
    links: add([
      [relative(COLLECTION, CATALOG), 'root', 'application/json', title],
      [relative(COLLECTION, CATALOG), 'parent', 'application/json'],
      ['./collection.json', 'self', 'application/json'],
      ...(license.url ? [[license.url, 'license', 'text/html', license.label]] : []),
      ...ids.map((id) => [relative(COLLECTION, itemPath(id)), 'item', 'application/geo+json', collections[id].title]),
    ]),
  };

  for (const id of ids) {
    const c = collections[id];
    const from = itemPath(id);
    const time = c.interval[0]
      ? { datetime: null, start_datetime: c.interval[0], end_datetime: c.interval[1] }
      : { datetime: now.toISOString() };
    docs[from] = {
      type: 'Feature',
      stac_version: STAC_VERSION,
      stac_extensions: [EXT.table, EXT.proj],
      id,
      collection: 'myforrest',
      geometry: polygon(c.bbox),
      bbox: c.bbox,
      properties: {
        title: c.title,
        description: c.description,
        ...time,
        'table:row_count': c.count,
        'table:primary_geometry': 'geometry',
        'table:columns': [
          ...Object.entries(c.fields).map(([name, t]) => ({ name, type: TABLE_TYPE[t] })),
          { name: 'geometry', type: 'binary', description: 'Geometrie als WKB (GeoParquet)' },
        ],
      },
      assets: assets(from, [
        ['geoparquet', `${id}.parquet`, { type: PARQUET, title: `${c.title} als GeoParquet (WGS84)`, roles: ['data'], 'proj:code': 'EPSG:4326' }],
        ['geoparquet-lv95', `${id}-lv95.parquet`, { type: PARQUET, title: `${c.title} als GeoParquet (LV95)`, roles: ['data'], 'proj:code': 'EPSG:2056' }],
        ['geojson', `${id}.geojson`, { type: 'application/geo+json', title: `${c.title} als GeoJSON (WGS84)`, roles: ['data'], 'proj:code': 'EPSG:4326' }],
      ]),
      links: add([
        [relative(from, CATALOG), 'root', 'application/json', title],
        [relative(from, COLLECTION), 'parent', 'application/json'],
        [relative(from, COLLECTION), 'collection', 'application/json'],
        [`./${id}.json`, 'self', 'application/geo+json'],
      ]),
    };
  }
  return docs;
}

/** Makes the relative links and assets of a document absolute, for the document served at `url`. */
function absolutize(doc, url) {
  const abs = (o) => ({ ...o, href: new URL(o.href, url).href });
  return {
    ...doc,
    links: doc.links.map(abs),
    ...(doc.assets ? { assets: Object.fromEntries(Object.entries(doc.assets).map(([k, a]) => [k, abs(a)])) } : {}),
  };
}

module.exports = { stacDocuments, absolutize, STAC_VERSION, CATALOG, COLLECTION, itemPath };
