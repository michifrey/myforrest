'use strict';

/*
 * Precipitation radar of MeteoSwiss for the whole of Switzerland, for the weather tab of a spot
 * (public/forecast.js). MeteoSwiss publishes the composite of its five radars as open data
 * ("Source: MeteoSwiss"): every 5 minutes a file RZCyyjjjHHMM….h5 (ODIM HDF5, precipitation
 * rate in mm/h on a 1 km grid in LV95, 710 × 640 km), for the last 14 days, in the STAC
 * collection ch.meteoschweiz.ogd-radar-precip of geo.admin.ch. Browsers cannot read HDF5, so the
 * server fetches a file once, reads it (jsfive, pure JavaScript), colours the rain like a
 * weather app and reprojects it to Web Mercator: one PNG per time, which Leaflet lays over the
 * map as an image between the composite's corners. MCH_RADAR_URL= (empty) turns it off; then
 * the weather tab shows the DWD radar.
 *
 *   GET /api/radar/ch                    { frames: [{ time, url }], bounds, attribution } of the last 2 hours
 *   GET /api/radar/ch/{YYYYMMDDHHMM}.png  the picture of one time (UTC)
 */

const fs = require('node:fs');
const path = require('node:path');
const hdf5 = require('jsfive');
const sharp = require('sharp');
const { wgs84ToLv95, lv95ToWgs84 } = require('../lv95');

const DEFAULT_URL = 'https://data.geo.admin.ch/api/stac/v1/collections/ch.meteoschweiz.ogd-radar-precip';
const LIST_TTL = 2 * 60000;
const WINDOW = 2 * 3600000; // frames offered: the last two hours
const KEEP = 6 * 3600000; // pictures kept on disk
const MAX_BYTES = 20 * 1024 * 1024;
const WIDTH = 1400; // px of a picture, ~0.5 km per pixel over Switzerland
// The composite's grid when a file does not say (MeteoSwiss Cartesian grid, LV95).
const GRID = { llx: 2255000, lly: 840000, xscale: 1000, yscale: 1000, nx: 710, ny: 640 };

/** Time (ms, UTC) of a radar file from its name RZCyyjjjHHMM…, null if it is no RZC file. */
function timeOfFile(name) {
  const m = /(?:^|\/)rzc(\d{2})(\d{3})(\d{2})(\d{2})/i.exec(name);
  if (!m) return null;
  const [, yy, doy, hh, mm] = m.map(Number);
  if (doy < 1 || doy > 366 || hh > 23 || mm > 59) return null;
  return Date.UTC(2000 + yy, 0, doy, hh, mm);
}

const stamp = (t) => new Date(t).toISOString().slice(0, 16).replace(/[-T:]/g, '');
const fromStamp = (s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12));

const attrsOf = (file, ...paths) => {
  for (const p of paths) {
    try { const g = file.get(p); if (g?.attrs && Object.keys(g.attrs).length) return g.attrs; } catch { /* not there */ }
  }
  return {};
};
const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/**
 * Reads an ODIM HDF5 radar file: the grid (first row = north) as rain rate in
 * mm/h (NaN where there is no data, 0 where nothing was detected) and where it lies in LV95.
 */
function decode(buffer) {
  const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const file = new hdf5.File(ab);
  const data = file.get('dataset1/data1/data') || file.get('dataset1/data');
  if (!data?.shape) throw new Error('Radardatei ohne Daten');
  const [ny, nx] = data.shape;
  const where = attrsOf(file, 'where', 'dataset1/where');
  const what = attrsOf(file, 'dataset1/data1/what', 'dataset1/what', 'what');
  let llx = num(where.LL_x, null);
  let lly = num(where.LL_y, null);
  if (llx === null || lly === null) {
    // Only the corner in WGS84: back to LV95, else the known grid.
    [llx, lly] = Number.isFinite(where.LL_lat) && Number.isFinite(where.LL_lon) && Math.abs(where.LL_lon - 3.17) > 0.5
      ? wgs84ToLv95(where.LL_lat, where.LL_lon) : [GRID.llx, GRID.lly];
  }
  const xscale = num(where.xscale, (GRID.nx * GRID.xscale) / nx);
  const yscale = num(where.yscale, (GRID.ny * GRID.yscale) / ny);
  const gain = num(what.gain, 1);
  const offset = num(what.offset, 0);
  const nodata = num(what.nodata, null);
  const undetect = num(what.undetect, null);
  const raw = data.value;
  const rate = new Float32Array(nx * ny);
  for (let i = 0; i < rate.length; i++) {
    const v = raw[i];
    rate[i] = v === nodata ? NaN : v === undetect ? 0 : Math.max(0, v * gain + offset);
  }
  return { nx, ny, llx, lly, xscale, yscale, rate };
}

/** [[south, west], [north, east]] around the grid, in WGS84. */
function boundsOf(g) {
  const pts = [];
  for (let k = 0; k <= 10; k++) {
    const fx = g.llx + (k / 10) * g.nx * g.xscale;
    const fy = g.lly + (k / 10) * g.ny * g.yscale;
    pts.push(lv95ToWgs84(fx, g.lly), lv95ToWgs84(fx, g.lly + g.ny * g.yscale), lv95ToWgs84(g.llx, fy), lv95ToWgs84(g.llx + g.nx * g.xscale, fy));
  }
  const r = (v) => Math.round(v * 1e4) / 1e4;
  return [[r(Math.min(...pts.map((p) => p[0]))), r(Math.min(...pts.map((p) => p[1])))], [r(Math.max(...pts.map((p) => p[0]))), r(Math.max(...pts.map((p) => p[1])))]];
}

// Colours like a weather app, from light rain to downpour (mm/h).
const SCALE = [
  [0.1, [150, 205, 250]], [1, [80, 160, 240]], [2, [30, 100, 220]], [4, [60, 180, 80]],
  [6, [240, 220, 40]], [10, [245, 150, 30]], [20, [220, 40, 30]], [40, [170, 40, 170]],
];
function colourOf(rate) {
  let c = null;
  for (const [from, rgb] of SCALE) if (rate >= from) c = rgb;
  return c;
}

/**
 * Rain rate at LV95 (x, y), interpolated between the centres of the four nearest cells, so the
 * picture has smooth edges instead of 1 km blocks; NaN outside the grid or where the nearest
 * cell has no data. Cells without data count as dry for their neighbours.
 */
function rateAt(g, x, y) {
  const fx = (x - g.llx) / g.xscale - 0.5;
  const fy = g.ny - 1 - ((y - g.lly) / g.yscale - 0.5); // rows from the north
  const near = g.rate[Math.round(fy) * g.nx + Math.round(fx)];
  if (fx < -0.5 || fy < -0.5 || fx > g.nx - 0.5 || fy > g.ny - 0.5 || Number.isNaN(near)) return NaN;
  const c0 = Math.max(0, Math.min(g.nx - 1, Math.floor(fx)));
  const r0 = Math.max(0, Math.min(g.ny - 1, Math.floor(fy)));
  const c1 = Math.min(g.nx - 1, c0 + 1);
  const r1 = Math.min(g.ny - 1, r0 + 1);
  const tx = Math.max(0, Math.min(1, fx - c0));
  const ty = Math.max(0, Math.min(1, fy - r0));
  const v = (r, c) => { const z = g.rate[r * g.nx + c]; return Number.isNaN(z) ? 0 : z; };
  return (v(r0, c0) * (1 - tx) + v(r0, c1) * tx) * (1 - ty) + (v(r1, c0) * (1 - tx) + v(r1, c1) * tx) * ty;
}

/** The grid as a PNG in Web Mercator between `boundsOf(g)`, transparent where it does not rain. */
async function render(g, width = WIDTH) {
  const [[s, w], [n, e]] = boundsOf(g);
  const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const height = Math.round((width * (mercY(n) - mercY(s))) / ((e - w) * (Math.PI / 180)));
  const out = Buffer.alloc(width * height * 4);
  for (let j = 0; j < height; j++) {
    const lat = (Math.atan(Math.sinh(mercY(n) - ((j + 0.5) / height) * (mercY(n) - mercY(s)))) * 180) / Math.PI;
    for (let i = 0; i < width; i++) {
      const lon = w + ((i + 0.5) / width) * (e - w);
      const [x, y] = wgs84ToLv95(lat, lon);
      const c = colourOf(rateAt(g, x, y));
      if (!c) continue;
      const o = (j * width + i) * 4;
      out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 215;
    }
  }
  return sharp(out, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 9, palette: true }).toBuffer();
}

function registerMchRadar(app, { dataDir, url = DEFAULT_URL, fetchImpl = fetch, now = () => Date.now() }) {
  const dir = path.join(dataDir, 'radar-ch');
  const host = url ? new URL(url).host : null;
  let listing = null; // { at, files: Map(time → href), error }
  const running = new Map();
  let bounds = null;

  /** Radar files of the last hours from the STAC collection: time → href. */
  async function files() {
    if (listing && now() - listing.at < LIST_TTL) return listing;
    const since = new Date(now() - WINDOW - 3600000);
    // Daily items (and items per file alike): everything from the start of that day on.
    let next = `${url}/items?datetime=${since.toISOString().slice(0, 10)}T00:00:00Z/..&limit=100`;
    const found = new Map();
    try {
      for (let page = 0; next && page < 5; page++) {
        const res = await fetchImpl(next, { signal: AbortSignal.timeout(20000) });
        if (!res.ok) throw new Error(`MeteoSchweiz antwortete mit HTTP ${res.status}`);
        const body = await res.json();
        for (const item of body.features || []) {
          for (const [key, asset] of Object.entries(item.assets || {})) {
            const t = timeOfFile(key) ?? timeOfFile(asset.href || '');
            if (t === null || !asset.href) continue;
            const href = new URL(asset.href, next);
            if (href.host !== host || href.protocol !== 'https:') continue; // only files of the open data service
            if (t > now() - WINDOW - 600000) found.set(t, href.href);
          }
        }
        next = (body.links || []).find((l) => l.rel === 'next')?.href || null;
        if (next && new URL(next).host !== host) next = null;
      }
      listing = { at: now(), files: found };
    } catch (err) {
      listing = { at: now() - LIST_TTL + 30000, files: listing?.files || new Map(), error: err.message };
    }
    return listing;
  }

  async function picture(t, href) {
    const file = path.join(dir, `${stamp(t)}.png`);
    if (fs.existsSync(file)) return fs.readFileSync(file);
    const res = await fetchImpl(href, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`Radardatei: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('Radardatei zu gross');
    const grid = decode(buf);
    bounds = boundsOf(grid);
    const png = await render(grid);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, png);
    fs.renameSync(tmp, file);
    // Older pictures go.
    for (const f of fs.readdirSync(dir)) {
      const m = /^(\d{12})\.png$/.exec(f);
      if (m && fromStamp(m[1]) < now() - KEEP) fs.rmSync(path.join(dir, f), { force: true });
    }
    return png;
  }

  app.get('/api/radar/ch', async (req, res) => {
    if (!url) return res.status(404).json({ error: 'Kein Radar der MeteoSchweiz eingerichtet' });
    const l = await files();
    const times = [...l.files.keys()].filter((t) => t >= now() - WINDOW).sort((a, b) => a - b);
    res.set('Cache-Control', 'no-cache');
    res.json({
      frames: times.map((t) => ({ time: new Date(t).toISOString(), url: `/api/radar/ch/${stamp(t)}.png` })),
      bounds: bounds || boundsOf({ ...GRID }),
      attribution: 'MeteoSchweiz',
      ...(l.error ? { error: l.error } : {}),
    });
  });

  app.get('/api/radar/ch/:stamp.png', async (req, res) => {
    if (!url) return res.status(404).json({ error: 'Kein Radar der MeteoSchweiz eingerichtet' });
    if (!/^\d{12}$/.test(req.params.stamp)) return res.status(400).json({ error: 'Zeit als JJJJMMTTHHMM (UTC) angeben' });
    const t = fromStamp(req.params.stamp);
    try {
      const href = (await files()).files.get(t);
      const file = path.join(dir, `${req.params.stamp}.png`);
      if (!href && !fs.existsSync(file)) return res.status(404).json({ error: 'Für diese Zeit gibt es kein Radarbild' });
      if (!running.has(t)) running.set(t, picture(t, href).finally(() => running.delete(t)));
      const png = await running.get(t);
      // A radar picture of a past time does not change.
      res.set('Cache-Control', 'public, max-age=86400, immutable');
      return res.type('png').send(png);
    } catch (err) {
      return res.status(502).json({ error: err.message });
    }
  });

  return { enabled: () => Boolean(url) };
}

module.exports = registerMchRadar;
module.exports.DEFAULT_URL = DEFAULT_URL;
module.exports.decode = decode;
module.exports.render = render;
module.exports.boundsOf = boundsOf;
module.exports.timeOfFile = timeOfFile;
module.exports.colourOf = colourOf;
module.exports.rateAt = rateAt;
