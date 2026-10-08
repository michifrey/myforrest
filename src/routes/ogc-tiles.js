'use strict';

/**
 * OGC API – Tiles (Part 1: core, tileset, tilesets-list, dataset and
 * geodata tilesets, Mapbox Vector Tiles) on top of the feature collections
 * of routes/ogc.js:
 *
 *   /ogc/tileMatrixSets[/WebMercatorQuad]          tile matrix set definition
 *   /ogc/tiles[/WebMercatorQuad[/{z}/{y}/{x}]]     whole dataset, one layer per collection
 *   /ogc/collections/{id}/tiles[/WebMercatorQuad[/{z}/{y}/{x}]]   one collection
 *   /ogc/styles/myforrest                          MapLibre style for the dataset tiles
 *
 * The tileset documents double as TileJSON 3.0 (`tilejson`, `tiles`,
 * `vector_layers`), so MapLibre, OpenLayers and QGIS can use them directly.
 * Empty tiles answer 204 No Content.
 */

const { COLLECTIONS } = require('../geodata');
const { TMS_ID, TMS_URI, MAX_ZOOM, tileMatrixSet, createIndex, encodeTile, validTile, tileRange } = require('../tiles');

const MVT = 'application/vnd.mapbox-vector-tile';
const TILESETS_REL = 'http://www.opengis.net/def/rel/ogc/1.0/tilesets-vector';
// Map layers of the dataset tiles; photos are left to their own collection tiles.
const DATASET_LAYERS = ['spread_fronts', 'spots', 'findings'];
const ZOOM_RANGE = { min: 0, max: MAX_ZOOM };
const MVT_TYPE = { INTEGER: 'Number', REAL: 'Number', TEXT: 'String' };

/** Newest fronts first, so older (smaller) outlines are drawn on top of them. */
const ORDER = { spread_fronts: (a, b) => b.properties.year - a.properties.year };

function bboxOfFeatures(features) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  const walk = (c) => {
    if (typeof c[0] === 'number') {
      b[0] = Math.min(b[0], c[0]); b[1] = Math.min(b[1], c[1]);
      b[2] = Math.max(b[2], c[0]); b[3] = Math.max(b[3], c[1]);
    } else c.forEach(walk);
  };
  for (const f of features) walk(f.geometry.coordinates);
  return Number.isFinite(b[0]) ? b : [5.9, 45.8, 10.5, 47.8]; // Switzerland until there is data
}

module.exports = function registerOgcTiles(app, { geodata, baseUrl, link, send, HttpError }) {
  const indexCache = new Map();
  /** Tile index of a collection, rebuilt when the data changes. */
  function indexOf(id, base) {
    const key = `${id}|${base}|${geodata.version()}`;
    if (!indexCache.has(key)) {
      for (const k of indexCache.keys()) if (k.startsWith(`${id}|${base}|`)) indexCache.delete(k);
      indexCache.set(key, createIndex(geodata.features(id, base), { order: ORDER[id] }));
    }
    return indexCache.get(key);
  }

  const vectorLayer = (id) => ({
    id,
    description: COLLECTIONS[id].title,
    minzoom: ZOOM_RANGE.min,
    maxzoom: ZOOM_RANGE.max,
    geometry_type: COLLECTIONS[id].geometry === 'POINT' ? 'points' : 'polygons',
    fields: Object.fromEntries(Object.entries(COLLECTIONS[id].fields).map(([k, t]) => [k, MVT_TYPE[t] || 'String'])),
  });

  /** Tileset metadata (OGC API – Tiles) that is also valid TileJSON 3.0. */
  function tileset(base, layers, path, title) {
    const bbox = bboxOfFeatures(layers.flatMap((id) => geodata.features(id, base)));
    const template = `${base}${path}/${TMS_ID}/{z}/{y}/{x}`;
    return {
      title,
      dataType: 'vector',
      crs: 'http://www.opengis.net/def/crs/EPSG/0/3857',
      tileMatrixSetURI: TMS_URI,
      tileMatrixSetLimits: [ZOOM_RANGE.min, 8, 12, 16, ZOOM_RANGE.max].filter((z, i, a) => a.indexOf(z) === i).map((z) => {
        const r = tileRange(bbox, z);
        return { tileMatrix: String(z), minTileRow: r.minRow, maxTileRow: r.maxRow, minTileCol: r.minCol, maxTileCol: r.maxCol };
      }),
      boundingBox: { lowerLeft: [bbox[0], bbox[1]], upperRight: [bbox[2], bbox[3]], crs: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84' },
      layers: layers.map((id) => ({ id, title: COLLECTIONS[id].title, dataType: 'vector', geometryDimension: COLLECTIONS[id].geometry === 'POINT' ? 0 : 2 })),
      links: [
        link(`${base}${path}/${TMS_ID}`, 'self', 'application/json', title),
        link(`${base}/ogc/tileMatrixSets/${TMS_ID}`, 'http://www.opengis.net/def/rel/ogc/1.0/tiling-scheme', 'application/json', 'WebMercatorQuad'),
        { href: template, rel: 'item', type: MVT, templated: true, title: 'Kachel (MVT)' },
      ],
      // TileJSON 3.0
      tilejson: '3.0.0',
      name: title,
      attribution: '© MyForrest-Mitwirkende (Lizenz pro Foto, Standard CC BY-SA 4.0)',
      scheme: 'xyz',
      tiles: [template],
      minzoom: ZOOM_RANGE.min,
      maxzoom: ZOOM_RANGE.max,
      bounds: bbox,
      center: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2, 14],
      vector_layers: layers.map(vectorLayer),
    };
  }

  const tilesetsList = (base, path, title) => ({
    links: [link(`${base}${path}`, 'self', 'application/json')],
    tilesets: [{
      title,
      dataType: 'vector',
      crs: 'http://www.opengis.net/def/crs/EPSG/0/3857',
      tileMatrixSetURI: TMS_URI,
      links: [
        link(`${base}${path}/${TMS_ID}`, 'self', 'application/json', `${title} (WebMercatorQuad)`),
        link(`${base}/ogc/tileMatrixSets/${TMS_ID}`, 'http://www.opengis.net/def/rel/ogc/1.0/tiling-scheme', 'application/json'),
      ],
    }],
  });

  function sendTile(res, indexes, params) {
    const [z, y, x] = [params.z, params.y, params.x].map(Number);
    if (!validTile(z, y, x)) throw new HttpError(404, `Keine Kachel ${params.z}/${params.y}/${params.x} in ${TMS_ID} (Zoom 0–${MAX_ZOOM})`);
    const pbf = encodeTile(indexes, z, x, y);
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'public, max-age=300');
    if (!pbf) return res.status(204).end();
    return res.type(MVT).send(pbf);
  }

  /* ---------- Tile matrix sets ---------- */

  app.get('/ogc/tileMatrixSets', (req, res) => {
    const base = baseUrl(req);
    res.json({
      tileMatrixSets: [{
        id: TMS_ID,
        title: 'Google Maps Compatible for the World',
        uri: TMS_URI,
        links: [link(`${base}/ogc/tileMatrixSets/${TMS_ID}`, 'self', 'application/json')],
      }],
    });
  });
  app.get(`/ogc/tileMatrixSets/${TMS_ID}`, (req, res) => res.json(tileMatrixSet()));
  app.get('/ogc/tileMatrixSets/:id', (req, res) => res.status(404).json({ code: 'NotFound', description: `Nur ${TMS_ID} wird angeboten` }));

  /* ---------- Dataset tiles ---------- */

  const DATASET_TITLE = 'MyForrest – Ausbreitungsfronten, Spots und Pflanzenfunde';
  app.get('/ogc/tiles', (req, res) => res.json(tilesetsList(baseUrl(req), '/ogc/tiles', DATASET_TITLE)));
  app.get(`/ogc/tiles/${TMS_ID}`, (req, res) => res.json(tileset(baseUrl(req), DATASET_LAYERS, '/ogc/tiles', DATASET_TITLE)));
  app.get(`/ogc/tiles/${TMS_ID}/:z/:y/:x`, (req, res) => send(res, () => {
    const base = baseUrl(req);
    sendTile(res, Object.fromEntries(DATASET_LAYERS.map((id) => [id, indexOf(id, base)])), req.params);
  }));

  /* ---------- Collection tiles ---------- */

  const collection = (id) => {
    if (!COLLECTIONS[id]) throw new HttpError(404, 'Collection nicht gefunden');
    return id;
  };
  app.get('/ogc/collections/:id/tiles', (req, res) => send(res, () => {
    const id = collection(req.params.id);
    res.json(tilesetsList(baseUrl(req), `/ogc/collections/${id}/tiles`, COLLECTIONS[id].title));
  }));
  app.get(`/ogc/collections/:id/tiles/${TMS_ID}`, (req, res) => send(res, () => {
    const id = collection(req.params.id);
    res.json(tileset(baseUrl(req), [id], `/ogc/collections/${id}/tiles`, COLLECTIONS[id].title));
  }));
  app.get(`/ogc/collections/:id/tiles/${TMS_ID}/:z/:y/:x`, (req, res) => send(res, () => {
    const id = collection(req.params.id);
    sendTile(res, { [id]: indexOf(id, baseUrl(req)) }, req.params);
  }));

  /* ---------- Style ---------- */

  /**
   * MapLibre style (also usable in QGIS: "Vector Tiles → New Generic
   * Connection" with this style URL) in the colours of the app and the QGIS
   * project: fronts violet from light (first year) to dark (newest), spots
   * green or orange with damage, neophytes violet.
   */
  app.get('/ogc/styles/myforrest', (req, res) => {
    const base = baseUrl(req);
    // Expressions limited to what QGIS' import of MapLibre styles understands as well: `match` with list
    // labels, interpolation on zoom, filters with fixed colours for circles.
    const ramp = ['match', ['get', 'recency_class'], [0], '#c4bfde', [1], '#a59dce', [2], '#8678b8', [3], '#6a49a3', '#4a1486'];
    const circle = (id, sourceLayer, filter, color, radius) => ({
      id, type: 'circle', source: 'myforrest', 'source-layer': sourceLayer, filter,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, radius[0], 16, radius[1]],
        'circle-color': color,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.2,
      },
    });
    res.set('Access-Control-Allow-Origin', '*');
    res.type('application/vnd.mapbox.style+json').send(JSON.stringify({
      version: 8,
      name: 'MyForrest',
      metadata: { 'myforrest:legend': 'Ausbreitungsfronten hell = früher, dunkel = neuer; Spots grün ohne Befund, orange mit Schäden; Neophyten violett' },
      sources: {
        osm: {
          type: 'raster',
          tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
          tileSize: 256,
          maxzoom: 19,
          attribution: '© OpenStreetMap-Mitwirkende',
        },
        myforrest: { type: 'vector', url: `${base}/ogc/tiles/${TMS_ID}` },
      },
      layers: [
        { id: 'basemap', type: 'raster', source: 'osm', paint: { 'raster-saturation': -0.4, 'raster-opacity': 0.85 } },
        {
          id: 'spread-fronts-fill', type: 'fill', source: 'myforrest', 'source-layer': 'spread_fronts',
          paint: { 'fill-color': ramp, 'fill-opacity': 0.22 },
        },
        {
          id: 'spread-fronts-line', type: 'line', source: 'myforrest', 'source-layer': 'spread_fronts',
          paint: { 'line-color': ramp, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.8, 16, 2] },
        },
        circle('spots', 'spots', ['==', ['get', 'status'], 'ohne'], '#2f5d34', [3.5, 6]),
        circle('spots-damage', 'spots', ['==', ['get', 'status'], 'schaden'], '#c2611d', [3.5, 6]),
        circle('findings', 'findings', ['==', ['get', 'neophyte'], 0], '#5c8f4a', [2, 3.5]),
        circle('findings-neophytes', 'findings', ['==', ['get', 'neophyte'], 1], '#8650c8', [3, 5]),
      ],
    }));
  });

  return {
    conformance: [
      'http://www.opengis.net/spec/ogcapi-tiles-1/1.0/conf/core',
      'http://www.opengis.net/spec/ogcapi-tiles-1/1.0/conf/tileset',
      'http://www.opengis.net/spec/ogcapi-tiles-1/1.0/conf/tilesets-list',
      'http://www.opengis.net/spec/ogcapi-tiles-1/1.0/conf/dataset-tilesets',
      'http://www.opengis.net/spec/ogcapi-tiles-1/1.0/conf/geodata-tilesets',
      'http://www.opengis.net/spec/ogcapi-tiles-1/1.0/conf/mvt',
    ],
    TILESETS_REL,
  };
};
