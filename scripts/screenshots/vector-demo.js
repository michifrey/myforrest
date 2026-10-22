'use strict';
// Demo vector tiles for the base map «MyForrest» (OpenMapTiles layer names, as OpenFreeMap serves them): the forest,
// meadows, village, pond and streams of the demo area and the Alps of the demo glacier, built from the same rules as
// the placeholder raster tiles (tiles.js), plus a minimal style. Land cover comes as row runs of a 64 × 64 grid per
// tile; roads, paths and the stream as lines; houses as rectangles.
const vtpbf = require('vt-pbf');
const tiles = require('./tiles');

const EXTENT = 4096;
const GRID = 64;

const lonOf = (x, z) => (x / 2 ** z) * 360 - 180;
const latOf = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

/** One MVT tile: { layerName: { features: [{ type, geometry, tags }] } } encoded. */
function tile(z, x, y) {
  const layers = { landcover: [], landuse: [], water: [], waterway: [], transportation: [], building: [] };
  // Land cover by row runs.
  const step = EXTENT / GRID;
  for (let j = 0; j < GRID; j++) {
    let run = null;
    const flush = (i) => {
      if (!run) return;
      const x0 = run.i * step; const x1 = i * step; const y0 = j * step; const y1 = (j + 1) * step;
      const ring = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
      const target = run.kind === 'water' ? 'water' : run.kind === 'residential' ? 'landuse' : 'landcover';
      layers[target].push({ type: 3, geometry: [ring], tags: { class: run.kind } });
      run = null;
    };
    for (let i = 0; i <= GRID; i++) {
      const kind = i < GRID ? tiles.classAt(latOf(y + (j + 0.5) / GRID, z), lonOf(x + (i + 0.5) / GRID, z)) : null;
      if (run && kind === run.kind) continue;
      flush(i);
      if (kind && kind !== 'land') run = { kind, i };
    }
  }
  // Lines in tile coordinates.
  const px = (lat, lon) => [
    Math.round(((((lon + 180) / 360) * 2 ** z) - x) * EXTENT),
    Math.round((((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z - y) * EXTENT),
  ];
  for (const [name, pts, cls] of tiles.demoLines()) {
    const line = pts.map(([lat, lon]) => px(lat, lon));
    if (name === 'stream') layers.waterway.push({ type: 2, geometry: [line], tags: { class: 'stream' } });
    else layers.transportation.push({ type: 2, geometry: [line], tags: { class: cls } });
  }
  // Houses of the village (only where they are big enough to see).
  if (z >= 14) {
    for (const [lat0, lon0, lat1, lon1] of tiles.demoHouses(latOf(y + 1, z), lonOf(x, z), latOf(y, z), lonOf(x + 1, z))) {
      const [a, b] = [px(lat1, lon0), px(lat0, lon1)];
      layers.building.push({ type: 3, geometry: [[a, [b[0], a[1]], b, [a[0], b[1]], a]], tags: {} });
    }
  }
  const out = {};
  for (const [k, features] of Object.entries(layers)) if (features.length) out[k] = { features };
  return Buffer.from(vtpbf.fromGeojsonVt(out, { version: 2, extent: EXTENT }));
}

/** A minimal style in OpenMapTiles naming, like OpenFreeMap's «positron» (the app repaints it anyway). */
function style(base) {
  const fill = (id, layer, cls, color) => ({ id, type: 'fill', source: 'openmaptiles', 'source-layer': layer, ...(cls ? { filter: ['==', ['get', 'class'], cls] } : {}), paint: { 'fill-color': color } });
  const road = (id, classes, color, width) => ({
    id, type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', filter: ['in', ['get', 'class'], ['literal', classes]],
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': color, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, width / 3, 17, width] },
  });
  return {
    version: 8,
    sources: { openmaptiles: { type: 'vector', tiles: [`${base}/{z}/{x}/{y}.pbf`], minzoom: 0, maxzoom: 15 } },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#f8f4f0' } },
      fill('landcover_wood', 'landcover', 'wood', '#d8e8c8'),
      fill('landcover_grass', 'landcover', 'grass', '#e8efd8'),
      fill('landcover_rock', 'landcover', 'rock', '#eeeeee'),
      fill('landcover_ice', 'landcover', 'ice', '#ffffff'),
      fill('landuse_residential', 'landuse', 'residential', '#ececec'),
      fill('water', 'water', null, '#c2d7e0'),
      { id: 'waterway', type: 'line', source: 'openmaptiles', 'source-layer': 'waterway', paint: { 'line-color': '#c2d7e0', 'line-width': 2 } },
      { id: 'building', type: 'fill', source: 'openmaptiles', 'source-layer': 'building', paint: { 'fill-color': '#e0e0e0' } },
      { ...road('highway_path', ['path'], '#cccccc', 1.5), paint: { 'line-color': '#cccccc', 'line-width': 1.5, 'line-dasharray': [2, 2] } },
      road('highway_minor_casing', ['minor', 'track'], '#d9d9d9', 7),
      road('highway_minor', ['minor', 'track'], '#ffffff', 5),
      road('highway_major_casing', ['secondary'], '#d9d9d9', 10),
      road('highway_major', ['secondary'], '#ffffff', 8),
    ],
  };
}

module.exports = { tile, style };
