'use strict';

/**
 * Vector tiles (Mapbox Vector Tile 2.1, OGC API – Tiles) in the
 * WebMercatorQuad tile matrix set, the grid web maps and geoportals use
 * (map.geo.admin.ch's vector maps too). Features are cut into tiles with
 * geojson-vt (clipping, simplification per zoom) and encoded with vt-pbf.
 */

const geojsonvt = require('geojson-vt');
const vtpbf = require('vt-pbf');

const TMS_ID = 'WebMercatorQuad';
const TMS_URI = 'http://www.opengis.net/def/tilematrixset/OGC/1.0/WebMercatorQuad';
const MAX_ZOOM = 20;
const EXTENT = 4096;
const ORIGIN = 20037508.3427892;

/** The WebMercatorQuad definition (OGC Two Dimensional Tile Matrix Set, JSON encoding). */
function tileMatrixSet() {
  return {
    id: TMS_ID,
    title: 'Google Maps Compatible for the World',
    uri: TMS_URI,
    crs: 'http://www.opengis.net/def/crs/EPSG/0/3857',
    orderedAxes: ['X', 'Y'],
    wellKnownScaleSet: 'http://www.opengis.net/def/wkss/OGC/1.0/GoogleMapsCompatible',
    tileMatrices: Array.from({ length: MAX_ZOOM + 1 }, (_, z) => ({
      id: String(z),
      scaleDenominator: 559082264.0287178 / 2 ** z,
      cellSize: 156543.03392804097 / 2 ** z,
      cornerOfOrigin: 'topLeft',
      pointOfOrigin: [-ORIGIN, ORIGIN],
      tileWidth: 256,
      tileHeight: 256,
      matrixWidth: 2 ** z,
      matrixHeight: 2 ** z,
    })),
  };
}

/** MVT attributes are strings, numbers or booleans: drop nulls, keep the rest. */
function cleanProperties(props) {
  const out = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined) continue;
    out[k] = typeof v === 'number' || typeof v === 'boolean' ? v : String(v);
  }
  return out;
}

/** Numeric feature ids (MVT ids are unsigned integers): the number in "spot.12", else the position. */
const numericId = (id, i) => {
  const m = /(\d+)$/.exec(String(id));
  return m && !String(id).startsWith('front.') ? Number(m[1]) : i + 1;
};

/**
 * A tile index for a set of WGS84 GeoJSON features. `order` sorts the
 * features (drawing order inside a tile follows the input order).
 */
function createIndex(features, { order } = {}) {
  const list = order ? [...features].sort(order) : features;
  return geojsonvt({
    type: 'FeatureCollection',
    features: list.map((f, i) => ({ type: 'Feature', id: numericId(f.id, i), geometry: f.geometry, properties: cleanProperties(f.properties) })),
  }, {
    maxZoom: MAX_ZOOM, // keep detail down to single trees
    indexMaxZoom: 6,
    indexMaxPoints: 100000,
    extent: EXTENT,
    buffer: 64,
    tolerance: 3,
  });
}

/** Valid tile coordinates in WebMercatorQuad? */
const validTile = (z, y, x) => [z, y, x].every(Number.isInteger) && z >= 0 && z <= MAX_ZOOM && x >= 0 && y >= 0 && x < 2 ** z && y < 2 ** z;

/**
 * One MVT tile from named indexes ({ layerName: index }); null when no layer
 * has features there.
 */
function encodeTile(indexes, z, x, y) {
  const layers = {};
  for (const [name, index] of Object.entries(indexes)) {
    const tile = index.getTile(z, x, y);
    if (tile && tile.features.length) layers[name] = tile;
  }
  if (!Object.keys(layers).length) return null;
  return Buffer.from(vtpbf.fromGeojsonVt(layers, { version: 2, extent: EXTENT }));
}

/** Longitude/latitude bounds → web mercator tile range at zoom z. */
function tileRange([w, s, e, n], z) {
  const n2 = 2 ** z;
  const x = (lon) => Math.min(n2 - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n2)));
  const y = (lat) => {
    const r = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
    return Math.min(n2 - 1, Math.max(0, Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n2)));
  };
  return { minCol: x(w), maxCol: x(e), minRow: y(n), maxRow: y(s) };
}

module.exports = { TMS_ID, TMS_URI, MAX_ZOOM, tileMatrixSet, createIndex, encodeTile, validTile, tileRange };
