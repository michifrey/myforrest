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
 *
 * Tiles are precomputed (src/tile-cache.js): after the data changes, every
 * tileset is cut again in the background up to a zoom per grid and stored
 * gzip-compressed; requests read the stored tile and only deeper zooms (or
 * tiles of a version still being built) are cut on the fly. The dataset in
 * WebMercatorQuad is also written as PMTiles and MBTiles for static hosting
 * and desktop GIS:
 *
 *   /api/export/myforrest.pmtiles   one file, read with HTTP range requests
 *   /api/export/myforrest.mbtiles   SQLite, for QGIS, GDAL, tile servers
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { COLLECTIONS, toLv95, bboxOf } = require('../geodata');
const mercator = require('../tiles');
const lv95 = require('../tiles-lv95');
const { wgs84ToLv95 } = require('../lv95');
const { createTileCache } = require('../tile-cache');
const { writePmtiles } = require('../pmtiles');
const { writeMbtiles } = require('../mbtiles');

const MVT = 'application/vnd.mapbox-vector-tile';
const TILESETS_REL = 'http://www.opengis.net/def/rel/ogc/1.0/tilesets-vector';
// Map layers of the dataset tiles; photos are left to their own collection tiles.
const DATASET_LAYERS = ['spread_fronts', 'spots', 'findings'];
// Everything that is precomputed: the dataset and each collection on its own.
const SETS = [['dataset', DATASET_LAYERS], ...Object.keys(COLLECTIONS).map((id) => [id, [id]])];
const ATTRIBUTION = '© MyForrest-Mitwirkende (Lizenz pro Foto, Standard CC BY-SA 4.0)';
// Candidate tiles reach this far beyond a feature's bounds (twice the 64/4096 tile buffer), so no tile with data is missed.
const PAD = 128 / 4096;
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
    // ~0.4 m per pixel in Switzerland; deeper zooms are cut on request (MapLibre overzooms anyway).
    precomputeZoom: 18,
    // Feature bounds in the grid's coordinates, and their tile range with padding at zoom z.
    project: (geometry) => bboxOf(geometry),
    tilesOf: ([w, s, e, n], z) => {
      const pad = (360 / 2 ** z) * PAD; // a tile is never taller in degrees than wide
      return mercator.tileRange([w - pad, s - pad, e + pad, n + pad], z);
    },
    boundingBox: (bbox) => ({ lowerLeft: [bbox[0], bbox[1]], upperRight: [bbox[2], bbox[3]], crs: 'http://www.opengis.net/def/crs/OGC/1.3/CRS84' }),
    tilejson: true,
  },
  [lv95.TMS_ID]: {
    module: lv95,
    title: 'Schweizer Landeskoordinaten LV95 (Kachelgitter von swisstopo)',
    crs: 'http://www.opengis.net/def/crs/EPSG/0/2056',
    range: (bbox, z) => lv95.tileRange(lv95Bbox(bbox), z),
    precomputeZoom: 26, // 0.5 m per pixel
    project: (geometry) => bboxOf(toLv95(geometry)),
    tilesOf: ([w, s, e, n], z) => {
      const pad = 256 * lv95.RESOLUTIONS[z] * PAD;
      return lv95.tileRange([w - pad, s - pad, e + pad, n + pad], z);
    },
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

/** Tiles at zoom z that may hold data: the union of the padded tile ranges of all features. */
function candidates(t, bboxes, z) {
  const seen = new Set();
  const out = [];
  for (const b of bboxes) {
    const r = t.tilesOf(b, z);
    for (let x = r.minCol; x <= r.maxCol; x++) {
      for (let y = r.minRow; y <= r.maxRow; y++) {
        const k = `${x}/${y}`;
        if (!seen.has(k)) { seen.add(k); out.push([x, y]); }
      }
    }
  }
  return out;
}

/**
 * dataDir: where tiles.db and the PMTiles/MBTiles exports live; precompute:
 * false serves every tile on the fly; delayMs: wait after a change before
 * cutting (uploads come in batches), null: only when precompute() is called; startupBase: precompute for this base
 * URL right away (PUBLIC_URL); background: tracks the builds (app.locals.idle).
 */
module.exports = function registerOgcTiles(app, {
  geodata, baseUrl, link, send, HttpError, dataDir, precompute = true, delayMs = 10000, startupBase, background = (p) => p,
}) {
  const tilesDir = dataDir && path.resolve(dataDir, 'tiles'); // absolute, as res.sendFile wants it
  let cache = null;
  if (precompute && dataDir) {
    fs.mkdirSync(tilesDir, { recursive: true });
    cache = createTileCache(path.join(tilesDir, 'tiles.db'));
  }
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
      attribution: ATTRIBUTION,
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

  /* ---------- Precomputation ---------- */

  const tilesetKey = (base, tmsId, set) => `${base}|${tmsId}|${set}`;
  const indexesOf = (tmsId, layers, base) => Object.fromEntries(layers.map((id) => [id, indexOf(tmsId, id, base)]));
  const exportFile = (ext) => path.join(tilesDir, `myforrest.${ext}`);
  const exportInfoFile = () => path.join(tilesDir, 'export.json');
  const readExportInfo = () => {
    try { return JSON.parse(fs.readFileSync(exportInfoFile(), 'utf8')); } catch { return null; }
  };

  /** PMTiles and MBTiles of the WebMercatorQuad dataset tiles, replaced atomically. */
  function writeExports(base, version) {
    const key = tilesetKey(base, mercator.TMS_ID, 'dataset');
    const tiles = cache.tiles(key, version);
    const bbox = bboxOfFeatures(DATASET_LAYERS.flatMap((id) => geodata.features(id, base)));
    const maxzoom = TMS[mercator.TMS_ID].precomputeZoom;
    const center = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2, Math.min(14, maxzoom)];
    const vectorLayers = DATASET_LAYERS.map((id) => vectorLayer(id, maxzoom));
    const name = 'MyForrest';
    const description = 'Ausbreitungsfronten, Spots und Pflanzenfunde als Vektorkacheln (WebMercatorQuad)';
    const tmp = (ext) => `${exportFile(ext)}.part`;
    fs.writeFileSync(tmp('pmtiles'), writePmtiles(tiles, {
      minzoom: 0, maxzoom, bounds: bbox, center,
      metadata: { name, description, attribution: ATTRIBUTION, vector_layers: vectorLayers },
    }));
    writeMbtiles(tmp('mbtiles'), tiles, {
      name, description, attribution: ATTRIBUTION, minzoom: 0, maxzoom, bounds: bbox, center, vector_layers: vectorLayers,
    });
    for (const ext of ['pmtiles', 'mbtiles']) fs.renameSync(tmp(ext), exportFile(ext));
    fs.writeFileSync(exportInfoFile(), JSON.stringify({ base, version, tiles: tiles.length, written_at: new Date().toISOString() }));
  }

  /** Cuts every tileset that is not current for this base URL, then refreshes the exports. */
  async function buildAll(base) {
    const version = geodata.version();
    const built = [];
    for (const [tmsId, t] of Object.entries(TMS)) {
      for (const [set, layers] of SETS) {
        const key = tilesetKey(base, tmsId, set);
        if (cache.current(key, version)) continue;
        const indexes = indexesOf(tmsId, layers, base);
        const bboxes = layers.flatMap((id) => geodata.features(id, base)).map((f) => t.project(f.geometry));
        const result = await cache.build(key, version, t.precomputeZoom, (z) => candidates(t, bboxes, z),
          (z, x, y) => t.module.encodeTile(indexes, z, x, y));
        if (!result) return built; // shutting down
        built.push({ tileset: `${tmsId}/${set}`, ...result });
      }
    }
    // Tiles carry links with the base URL, so each base URL has its own tilesets. Keep the current one and the one
    // before (a server reached under two names), so unknown Host headers cannot fill the disk.
    const previous = readExportInfo()?.base;
    cache.keepOnly([`${base}|`, ...(startupBase ? [`${startupBase}|`] : []), ...(previous && previous !== base ? [`${previous}|`] : [])]);
    const info = readExportInfo();
    if (built.length || !info || info.base !== base || info.version !== version) writeExports(base, version);
    // The data changed while cutting: go again for the new version.
    if (geodata.version() !== version) schedule(base);
    return built;
  }

  let chain = Promise.resolve();
  /** Runs one precomputation after another (never two at once). */
  function precomputeNow(base) {
    if (!cache) return Promise.resolve([]);
    const run = chain.then(() => buildAll(base));
    chain = run.catch(() => {});
    return run;
  }

  const scheduled = new Set();
  /** Precompute for this base URL after `delayMs` (once, however many requests ask meanwhile). */
  function schedule(base) {
    // With PUBLIC_URL set, other names of the server get live tiles only.
    if (!cache || delayMs === null || scheduled.has(base) || (startupBase && base !== startupBase)) return;
    scheduled.add(base);
    const wait = new Promise((resolve) => { setTimeout(resolve, delayMs).unref?.(); });
    background(wait.then(() => {
      scheduled.delete(base);
      return precomputeNow(base);
    }));
  }
  if (cache && startupBase) schedule(startupBase);

  /** A tile from the precomputed store, else cut now (and schedule the precomputation). */
  function sendTile(req, res, tmsId, set, layers) {
    const t = TMS[tmsId];
    const m = t.module;
    const { params } = req;
    const [z, y, x] = [params.z, params.y, params.x].map(Number);
    if (!m.validTile(z, y, x)) throw new HttpError(404, `Keine Kachel ${params.z}/${params.y}/${params.x} in ${tmsId} (Zoom 0–${m.MAX_ZOOM})`);
    const base = baseUrl(req);
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'public, max-age=300');
    if (cache) {
      const stored = cache.lookup(tilesetKey(base, tmsId, set), geodata.version(), z, x, y);
      if (stored !== undefined) {
        res.set('X-Tile-Source', 'precomputed');
        if (stored === null) return res.status(204).end();
        res.vary('Accept-Encoding');
        if (req.acceptsEncodings('gzip')) {
          res.set('Content-Encoding', 'gzip');
          return res.type(MVT).send(stored);
        }
        return res.type(MVT).send(zlib.gunzipSync(stored));
      }
      if (z <= t.precomputeZoom) schedule(base);
    }
    res.set('X-Tile-Source', 'live');
    const pbf = m.encodeTile(indexesOf(tmsId, layers, base), z, x, y);
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
    sendTile(req, res, tms(req.params.tms), 'dataset', DATASET_LAYERS);
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
    sendTile(req, res, tms(req.params.tms), id, [id]);
  }));

  /* ---------- PMTiles and MBTiles ---------- */

  const EXPORTS = { pmtiles: 'application/vnd.pmtiles', mbtiles: 'application/vnd.sqlite3' };
  app.get('/api/export/myforrest.:ext(pmtiles|mbtiles)', (req, res) => {
    const { ext } = req.params;
    res.set('Access-Control-Allow-Origin', '*');
    if (!cache) return res.status(404).json({ error: 'Die Vorberechnung der Kacheln ist ausgeschaltet (TILES_PRECOMPUTE=0)' });
    const base = baseUrl(req);
    const info = readExportInfo();
    if (!info || info.base !== base || info.version !== geodata.version() || !fs.existsSync(exportFile(ext))) {
      schedule(base);
      res.set('Retry-After', '30');
      return res.status(503).json({ error: 'Die Kacheln werden gerade berechnet, bitte gleich nochmals versuchen' });
    }
    // Range requests (PMTiles clients read single tiles) are handled by sendFile.
    res.set('Access-Control-Expose-Headers', 'Content-Range, Content-Length, ETag');
    return res.sendFile(exportFile(ext), { headers: { 'Content-Type': EXPORTS[ext], 'Cache-Control': 'public, max-age=300' } });
  });

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
    precompute: precomputeNow,
    close: () => cache?.close(),
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
