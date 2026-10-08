'use strict';

/**
 * OGC API – Tiles (Part 1: core, tileset, tilesets-list, dataset and
 * geodata tilesets, Mapbox Vector Tiles) on top of the feature collections
 * of routes/ogc.js, in two tile matrix sets:
 *
 *   WebMercatorQuad  web maps (MapLibre, OpenLayers, QGIS XYZ); tilesets double as TileJSON 3.0
 *   SwissLV95        swisstopo's LV95 grid (EPSG:2056), lines up with map.geo.admin.ch
 *
 *   /ogc/tileMatrixSets[/{tms}]                       tile matrix set definitions
 *   /ogc/tiles[/{tms}[/{z}/{y}/{x}]]                  whole dataset, one layer per collection
 *   /ogc/collections/{id}/tiles[/{tms}[/{z}/{y}/{x}]] one collection
 *   /ogc/styles/myforrest                             MapLibre style for the WebMercatorQuad tiles
 *
 * Empty tiles answer 204 No Content.
 */

const { COLLECTIONS } = require('../geodata');
const mercator = require('../tiles');
const lv95 = require('../tiles-lv95');
const { wgs84ToLv95 } = require('../lv95');

const MVT = 'application/vnd.mapbox-vector-tile';
const TILESETS_REL = 'http://www.opengis.net/def/rel/ogc/1.0/tilesets-vector';
// Map layers of the dataset tiles; photos are left to their own collection tiles.
const DATASET_LAYERS = ['spread_fronts', 'spots', 'findings'];
const MVT_TYPE = { INTEGER: 'Number', REAL: 'Number', TEXT: 'String' };

/** Newest fronts first, so older (smaller) outlines are drawn on top of them. */
const ORDER = { spread_fronts: (a, b) => b.properties.year - a.properties.year };

/** The two tile matrix sets: how to describe them, index features, encode tiles and convert bounds. */
const TMS = {
  [mercator.TMS_ID]: {
    module: mercator,
    title: 'Google Maps Compatible for the World',
    crs: 'http://www.opengis.net/def/crs/EPSG/0/3857',
    range: (bbox, z) => mercator.tileRange(bbox, z),
    boundingBox: (bbox) => ({ lowerLeft: [bbox[0], bbox[1]], upperRight: [bbox[2], bbox[3]], crs: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84' }),
    tilejson: true,
  },
  [lv95.TMS_ID]: {
    module: lv95,
    title: 'Schweizer Landeskoordinaten LV95 (Kachelgitter von swisstopo)',
    crs: 'http://www.opengis.net/def/crs/EPSG/0/2056',
    range: (bbox, z) => lv95.tileRange(lv95Bbox(bbox), z),
    // In LV95, so clients of this grid need no reprojection (the OpenLayers viewer frames the map with it).
    boundingBox: (bbox) => {
      const b = lv95Bbox(bbox);
      return { lowerLeft: [b[0], b[1]], upperRight: [b[2], b[3]], crs: 'http://www.opengis.net/def/crs/EPSG/0/2056' };
    },
    tilejson: false,
  },
};

/** WGS84 bounds [w, s, e, n] → LV95 bounds [minE, minN, maxE, maxN] over all four corners. */
function lv95Bbox([w, s, e, n]) {
  const corners = [[s, w], [s, e], [n, w], [n, e]].map(([lat, lon]) => wgs84ToLv95(lat, lon));
  return [
    Math.min(...corners.map((c) => c[0])), Math.min(...corners.map((c) => c[1])),
    Math.max(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[1])),
  ];
}

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
  /** Tile index of a collection in a tile matrix set, rebuilt when the data changes. */
  function indexOf(tmsId, id, base) {
    const prefix = `${tmsId}|${id}|${base}|`;
    const key = prefix + geodata.version();
    if (!indexCache.has(key)) {
      for (const k of indexCache.keys()) if (k.startsWith(prefix)) indexCache.delete(k);
      indexCache.set(key, TMS[tmsId].module.createIndex(geodata.features(id, base), { order: ORDER[id] }));
    }
    return indexCache.get(key);
  }

  const tms = (id) => {
    if (!TMS[id]) throw new HttpError(404, `Kachelgitter ${id} wird nicht angeboten (möglich: ${Object.keys(TMS).join(', ')})`);
    return id;
  };

  const vectorLayer = (id, maxzoom) => ({
    id,
    description: COLLECTIONS[id].title,
    minzoom: 0,
    maxzoom,
    geometry_type: COLLECTIONS[id].geometry === 'POINT' ? 'points' : 'polygons',
    fields: Object.fromEntries(Object.entries(COLLECTIONS[id].fields).map(([k, t]) => [k, MVT_TYPE[t] || 'String'])),
  });

  // Registered grids carry their OGC URI; SwissLV95 is not registered, so its URI is our own definition (resolvable, which GDAL needs).
  const tmsUri = (base, tmsId) => TMS[tmsId].module.TMS_URI || `${base}/ogc/tileMatrixSets/${tmsId}`;

  /** Tileset metadata (OGC API – Tiles); for WebMercatorQuad also valid TileJSON 3.0. */
  function tileset(base, tmsId, layers, path, title) {
    const t = TMS[tmsId];
    const max = t.module.MAX_ZOOM;
    const bbox = bboxOfFeatures(layers.flatMap((id) => geodata.features(id, base)));
    // OGC API – Tiles names the template variables {tileMatrix}/{tileRow}/{tileCol}; TileJSON uses {z}/{y}/{x}.
    const template = `${base}${path}/${tmsId}/{tileMatrix}/{tileRow}/{tileCol}`;
    const out = {
      title,
      dataType: 'vector',
      crs: t.crs,
      tileMatrixSetURI: tmsUri(base, tmsId),
      // Every tile matrix with data; GDAL offers exactly these as layers.
      tileMatrixSetLimits: Array.from({ length: max + 1 }, (_, z) => {
        const r = t.range(bbox, z);
        return { tileMatrix: String(z), minTileRow: r.minRow, maxTileRow: r.maxRow, minTileCol: r.minCol, maxTileCol: r.maxCol };
      }),
      boundingBox: t.boundingBox(bbox),
      layers: layers.map((id) => ({ id, title: COLLECTIONS[id].title, dataType: 'vector', geometryDimension: COLLECTIONS[id].geometry === 'POINT' ? 0 : 2 })),
      links: [
        link(`${base}${path}/${tmsId}`, 'self', 'application/json', title),
        link(`${base}/ogc/tileMatrixSets/${tmsId}`, 'http://www.opengis.net/def/rel/ogc/1.0/tiling-scheme', 'application/json', tmsId),
        { href: template, rel: 'item', type: MVT, templated: true, title: 'Kachel (MVT)' },
      ],
      vector_layers: layers.map((id) => vectorLayer(id, max)),
    };
    if (!t.tilejson) return out;
    return {
      ...out,
      // TileJSON 3.0
      tilejson: '3.0.0',
      name: title,
      attribution: '© MyForrest-Mitwirkende (Lizenz pro Foto, Standard CC BY-SA 4.0)',
      scheme: 'xyz',
      tiles: [`${base}${path}/${tmsId}/{z}/{y}/{x}`],
      minzoom: 0,
      maxzoom: max,
      bounds: bbox,
      center: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2, 14],
    };
  }

  const tilesetsList = (base, path, title) => ({
    links: [link(`${base}${path}`, 'self', 'application/json')],
    tilesets: Object.entries(TMS).map(([tmsId, t]) => ({
      title: `${title} (${tmsId})`,
      dataType: 'vector',
      crs: t.crs,
      tileMatrixSetURI: tmsUri(base, tmsId),
      links: [
        link(`${base}${path}/${tmsId}`, 'self', 'application/json', `${title} (${tmsId})`),
        link(`${base}/ogc/tileMatrixSets/${tmsId}`, 'http://www.opengis.net/def/rel/ogc/1.0/tiling-scheme', 'application/json'),
      ],
    })),
  });

  function sendTile(res, tmsId, indexes, params) {
    const m = TMS[tmsId].module;
    const [z, y, x] = [params.z, params.y, params.x].map(Number);
    if (!m.validTile(z, y, x)) throw new HttpError(404, `Keine Kachel ${params.z}/${params.y}/${params.x} in ${tmsId} (Zoom 0–${m.MAX_ZOOM})`);
    const pbf = m.encodeTile(indexes, z, x, y);
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'public, max-age=300');
    if (!pbf) return res.status(204).end();
    return res.type(MVT).send(pbf);
  }

  /* ---------- Tile matrix sets ---------- */

  app.get('/ogc/tileMatrixSets', (req, res) => {
    const base = baseUrl(req);
    res.json({
      tileMatrixSets: Object.entries(TMS).map(([id, t]) => ({
        id,
        title: t.title,
        ...(t.module.TMS_URI ? { uri: t.module.TMS_URI } : {}),
        crs: t.crs,
        links: [link(`${base}/ogc/tileMatrixSets/${id}`, 'self', 'application/json')],
      })),
    });
  });
  app.get('/ogc/tileMatrixSets/:tms', (req, res) => send(res, () => res.json(TMS[tms(req.params.tms)].module.tileMatrixSet())));

  /* ---------- Dataset tiles ---------- */

  const DATASET_TITLE = 'MyForrest – Ausbreitungsfronten, Spots und Pflanzenfunde';
  app.get('/ogc/tiles', (req, res) => res.json(tilesetsList(baseUrl(req), '/ogc/tiles', DATASET_TITLE)));
  app.get('/ogc/tiles/:tms', (req, res) => send(res, () => {
    res.json(tileset(baseUrl(req), tms(req.params.tms), DATASET_LAYERS, '/ogc/tiles', DATASET_TITLE));
  }));
  app.get('/ogc/tiles/:tms/:z/:y/:x', (req, res) => send(res, () => {
    const tmsId = tms(req.params.tms);
    const base = baseUrl(req);
    sendTile(res, tmsId, Object.fromEntries(DATASET_LAYERS.map((id) => [id, indexOf(tmsId, id, base)])), req.params);
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
  app.get('/ogc/collections/:id/tiles/:tms', (req, res) => send(res, () => {
    const id = collection(req.params.id);
    res.json(tileset(baseUrl(req), tms(req.params.tms), [id], `/ogc/collections/${id}/tiles`, COLLECTIONS[id].title));
  }));
  app.get('/ogc/collections/:id/tiles/:tms/:z/:y/:x', (req, res) => send(res, () => {
    const id = collection(req.params.id);
    const tmsId = tms(req.params.tms);
    sendTile(res, tmsId, { [id]: indexOf(tmsId, id, baseUrl(req)) }, req.params);
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
        myforrest: { type: 'vector', url: `${base}/ogc/tiles/${mercator.TMS_ID}` },
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
