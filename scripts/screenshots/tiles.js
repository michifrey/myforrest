'use strict';
// Placeholder base map tiles (no tile servers reachable here): forest, meadows, a stream, roads,
// paths, a village edge and contour lines, rendered per pixel in Web Mercator or the Swiss LV95 grid.
const sharp = require('sharp');
const { lv95ToWgs84 } = require('../../src/lv95');
const { RESOLUTIONS, ORIGIN } = require('../../src/tiles-lv95');
const glacier = require('./glacier-demo');

const M_LAT = 111320;
const M_LON = 111320 * Math.cos((47.37 * Math.PI) / 180);

function hash2(x, y) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const s = (t) => t * t * (3 - 2 * t);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * s(fx) + (c - a) * s(fy) + (a - b - c + d) * s(fx) * s(fy);
}
const fbm = (x, y) => vnoise(x, y) * 0.55 + vnoise(x * 2.1, y * 2.1) * 0.3 + vnoise(x * 4.3, y * 4.3) * 0.15;

const { elevation } = (() => {
  const elev = (lat, lon) => {
    const hill = 130 * Math.exp(-(((lat - 47.3765) / 0.006) ** 2 + ((lon - 8.578) / 0.009) ** 2));
    const hollow = -45 * Math.exp(-(((lat - 47.367) / 0.0025) ** 2 + ((lon - 8.566) / 0.0035) ** 2));
    return 560 + hill + hollow + (lat - 47.37) * 900;
  };
  return { elevation: elev };
})();

const LINES = {
  stream: [[47.3712, 8.5735], [47.3700, 8.5712], [47.3693, 8.5697], [47.3688, 8.5680], [47.3684, 8.5662], [47.3679, 8.5642], [47.3673, 8.5622], [47.3668, 8.5602], [47.3664, 8.5580], [47.3655, 8.5550]],
  main: [[47.3618, 8.5480], [47.3640, 8.5560], [47.3652, 8.5640], [47.3660, 8.5720], [47.3672, 8.5800], [47.3690, 8.5900]],
  track: [[47.3652, 8.5640], [47.3700, 8.5690], [47.3733, 8.5722], [47.3760, 8.5760], [47.3786, 8.5802], [47.3815, 8.5840]],
  path1: [[47.3790, 8.5650], [47.3752, 8.5689], [47.3741, 8.5740], [47.3711, 8.5768], [47.3690, 8.5800], [47.3672, 8.5800]],
  path2: [[47.3760, 8.5760], [47.3768, 8.5795], [47.3741, 8.5826], [47.3715, 8.5860]],
  path3: [[47.3684, 8.5662], [47.3710, 8.5640], [47.3752, 8.5689]],
};
// Lines as metre segments
const SEG = Object.fromEntries(Object.entries(LINES).map(([k, pts]) => [k, pts.slice(1).map((p, i) => [pts[i][1] * M_LON, pts[i][0] * M_LAT, p[1] * M_LON, p[0] * M_LAT])]));
function dist(seg, x, y) {
  let best = Infinity;
  for (const [x0, y0, x1, y1] of seg) {
    const dx = x1 - x0, dy = y1 - y0;
    const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy)));
    const d = Math.hypot(x - x0 - t * dx, y - y0 - t * dy);
    if (d < best) best = d;
  }
  return best;
}
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

const STYLES = {
  osm: {
    land: '#f2efe9', meadow: '#cdebb0', forest: '#add19e', forestDot: '#9cc38c', water: '#aad3df', stream: '#8fc3d6',
    residential: '#e0dfdf', building: '#d9d0c9', buildingEdge: '#c4b6ab', main: '#fcd6a4', mainCase: '#c79a62', track: '#ffffff', trackCase: '#b8b0a2', path: '#fa8072', contour: null,
    rock: '#e4ddd2', scree: '#d3cabd', alpine: '#d8e8c2', ice: '#ddedf5', iceEdge: '#8fbfd9',
  },
  grau: {
    land: '#f4f4f2', meadow: '#f0f0ee', forest: '#d9dcd6', forestDot: '#c4c8c0', water: '#c9d3d8', stream: '#8899a3',
    residential: '#e6e6e4', building: '#8d8d8d', buildingEdge: '#6c6c6c', main: '#ffffff', mainCase: '#555555', track: '#ffffff', trackCase: '#777777', path: '#555555', contour: '#b0a69a',
    rock: '#eeeeec', scree: '#dededc', alpine: '#f0f0ee', ice: '#f6f9fb', iceEdge: '#8aa6b8',
  },
};

/** The Alps around the demo glacier: rock, scree, alpine meadows, today's ice and the lake in front of it. */
function alpineColorAt(lat, lon, mpp, st) {
  const x = lon * M_LON;
  const y = lat * M_LAT;
  const e = glacier.elevation(lat, lon);
  let c;
  if (glacier.iceToday(lat, lon)) {
    c = hex(st.ice);
    // Crevasses as faint stripes across the flow.
    if (Math.abs(Math.sin(y / 9 + fbm(x / 60, y / 60) * 6)) < 0.08) c = mix(c, hex(st.iceEdge), 0.5);
  } else if (glacier.inLake(lat + (fbm(x / 90, y / 90) - 0.5) * 0.0005, lon + (fbm(x / 90 + 7, y / 90) - 0.5) * 0.0012)) {
    c = hex(st.water);
  } else if (e < 2180 + fbm(x / 120 + 3, y / 120) * 260 && fbm(x / 180, y / 180) > 0.42) {
    c = hex(st.alpine);
  } else {
    c = hex(st.rock);
    if (hash2(Math.floor(x / 7), Math.floor(y / 7)) < 0.12) c = hex(st.scree);
  }
  // Edge of the ice.
  const dLat = (1.1 * mpp) / M_LAT;
  const dLon = (1.1 * mpp) / M_LON;
  const near = [[dLat, 0], [-dLat, 0], [0, dLon], [0, -dLon]].some(([dy, dx]) => glacier.iceToday(lat + dy, lon + dx) !== glacier.iceToday(lat, lon));
  if (near) c = hex(st.iceEdge);
  const e0 = e;
  const sx = glacier.elevation(lat, lon + 0.0004) - e0;
  const sy = glacier.elevation(lat + 0.0004, lon) - e0;
  const shade = Math.max(-1, Math.min(1, (sx - sy) * 0.012));
  c = mix(c, shade > 0 ? [255, 255, 255] : [60, 70, 80], Math.abs(shade) * 0.35);
  // The hiking path up the valley floor to the lake.
  const pathLon = 8.4003 + 0.0012 * Math.sin((lat - 46.6) * 900);
  if (lat > 46.5998 && Math.abs(lon - pathLon) * M_LON < Math.max(1, 0.8 * mpp)) {
    if (Math.floor(y / (mpp * 6)) % 2 === 0) c = hex(st.path);
  }
  return c;
}

function colorAt(lat, lon, mpp, st) {
  if (lat < 46.9) return alpineColorAt(lat, lon, mpp, st);
  const x = lon * M_LON;
  const y = lat * M_LAT;
  // Forest: a large wood around the hill with ragged edges and a few meadows.
  const dc = Math.hypot((lat - 47.3722) * M_LAT, (lon - 8.5735) * M_LON * 0.8);
  const edge = 1250 + (fbm(x / 400, y / 400) - 0.5) * 700;
  let forest = dc < edge;
  const clearing = fbm(x / 160 + 50, y / 160 + 20);
  if (clearing > 0.74) forest = false;
  const village = lon < 8.5585 + (fbm(x / 500, y / 500) - 0.5) * 0.004 && !forest;
  let c;
  if (forest) {
    c = hex(st.forest);
    if (hash2(Math.floor(x / 9), Math.floor(y / 9)) < 0.08) c = hex(st.forestDot);
  } else if (village) {
    c = hex(st.residential);
    const bx = Math.floor(x / 38), by = Math.floor(y / 30);
    const fx = x / 38 - bx, fy = y / 30 - by;
    if (hash2(bx, by) < 0.6 && fx > 0.2 && fx < 0.75 && fy > 0.25 && fy < 0.75) {
      c = hex(st.building);
      if (fx < 0.24 || fx > 0.71 || fy < 0.29 || fy > 0.71) c = hex(st.buildingEdge);
    }
  } else {
    c = hex(fbm(x / 250, y / 250) > 0.45 ? st.meadow : st.land);
  }
  // Pond
  const pond = Math.hypot((lat - 47.3749) * M_LAT, (lon - 8.5755) * M_LON * 0.7);
  if (pond < 35 + (fbm(x / 30, y / 30) - 0.5) * 20) c = hex(st.water);
  // Contours (10 m)
  if (st.contour) {
    const e = elevation(lat, lon);
    const gx = (elevation(lat, lon + 0.0001) - e) / (0.0001 * M_LON);
    const gy = (elevation(lat + 0.0001, lon) - e) / (0.0001 * M_LAT);
    const grad = Math.max(1e-4, Math.hypot(gx, gy));
    const nearest = Math.round(e / 10) * 10;
    const major = nearest % 50 === 0;
    const px = Math.abs(e - nearest) / grad / mpp; // distance to the contour in pixels
    if (px < (major ? 0.9 : 0.55)) c = mix(c, hex(st.contour), major ? 0.95 : 0.75);
  } else {
    // Light hillshade
    const e0 = elevation(lat, lon);
    const sx = elevation(lat, lon + 0.0002) - e0;
    const sy = elevation(lat + 0.0002, lon) - e0;
    const shade = Math.max(-1, Math.min(1, (sx - sy) * 0.08));
    c = mix(c, shade > 0 ? [255, 255, 255] : [60, 70, 60], Math.abs(shade) * 0.25);
  }
  // Lines, widths in pixels (at least a minimum on screen)
  const px = (m, minPx) => Math.max(m, minPx * mpp);
  const ds = dist(SEG.stream, x, y);
  if (ds < px(3, 2.6)) c = hex(st.stream);
  const dm = dist(SEG.main, x, y);
  if (dm < px(5, 3.2)) c = hex(st.mainCase);
  if (dm < px(4, 2.4)) c = hex(st.main);
  const dt = dist(SEG.track, x, y);
  if (dt < px(3.5, 3.4)) c = hex(st.trackCase);
  if (dt < px(2.6, 2.2)) c = hex(st.track);
  for (const k of ['path1', 'path2', 'path3']) {
    const d = dist(SEG[k], x, y);
    if (d < px(1, 0.8)) {
      const along = Math.floor((x + y) / (mpp * 6));
      if (along % 2 === 0) c = hex(st.path);
    }
  }
  return c;
}

const TILE = 256;
async function render(pixelToLatLon, mpp, style) {
  const st = STYLES[style];
  const buf = Buffer.alloc(TILE * TILE * 3);
  for (let j = 0; j < TILE; j++) {
    for (let i = 0; i < TILE; i++) {
      const [lat, lon] = pixelToLatLon(i + 0.5, j + 0.5);
      const c = colorAt(lat, lon, mpp, st);
      const o = (j * TILE + i) * 3;
      buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2];
    }
  }
  return sharp(buf, { raw: { width: TILE, height: TILE, channels: 3 } }).png().toBuffer();
}

function mercatorTile(z, x, y, style = 'osm') {
  const n = 2 ** z;
  const toLatLon = (i, j) => {
    const lon = ((x + i / TILE) / n) * 360 - 180;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + j / TILE)) / n))) * 180) / Math.PI;
    return [lat, lon];
  };
  const mpp = (156543.03 * Math.cos((47.37 * Math.PI) / 180)) / n;
  return render(toLatLon, mpp, style);
}

function lv95Tile(z, x, y, style = 'grau') {
  const res = RESOLUTIONS[z];
  const toLatLon = (i, j) => {
    const e = ORIGIN[0] + (x * TILE + i) * res;
    const nn = ORIGIN[1] - (y * TILE + j) * res;
    const p = lv95ToWgs84(e, nn);
    return Array.isArray(p) ? p : [p.lat, p.lon];
  };
  return render(toLatLon, res, style);
}

module.exports = { mercatorTile, lv95Tile };
