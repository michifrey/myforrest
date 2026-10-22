'use strict';
// Demo server for the README screenshots: the real app with a synthetic Open-Meteo stand-in, so weather,
// storms, night cooling and the elevation model work without network access.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { createApp } = require('../../src/app');
const glacier = require('./glacier-demo');
const tiles = require('./tiles');
const tiles3d = require('./tiles3d-demo');
const vectorDemo = require('./vector-demo');

// DEMO_MAPILLARY=1: a stand-in for the Mapillary API, a 360° sequence crossing the forest track of the
// walk-through (seed.js) from north-west to south-east, with panoramas drawn like the demo ones.
const MLY_CENTRE = { lat: 47.37388, lon: 8.57279 };
const MLY = [-3, -2, -1, 1, 2, 3].map((k, i) => ({
  id: String(4100 + i),
  computed_geometry: { type: 'Point', coordinates: [MLY_CENTRE.lon - 0.00024 * k, MLY_CENTRE.lat + 0.00018 * k] },
  computed_compass_angle: 135,
  captured_at: Date.parse(`2025-08-14T09:${String(20 + i).padStart(2, '0')}:00Z`),
  is_pano: true,
  creator: { username: 'waldlaeufer_zh' },
  sequence: 'demo-mly-quer',
}));
async function mapillaryFetch(url) {
  const u = new URL(url);
  if (u.hostname === 'graph.mapillary.com' && u.pathname === '/images') {
    const [w, s, e, n] = u.searchParams.get('bbox').split(',').map(Number);
    return Response.json({ data: MLY.filter((m) => { const [lon, lat] = m.computed_geometry.coordinates; return lon >= w && lon <= e && lat >= s && lat <= n; }) });
  }
  const one = /^\/(\d+)$/.exec(u.pathname);
  if (u.hostname === 'graph.mapillary.com' && one) {
    if (u.searchParams.get('fields') === 'thumb_2048_url') return Response.json({ thumb_2048_url: `https://mapillary.demo.invalid/${one[1]}.jpg` });
    const m = MLY.find((x) => x.id === one[1]);
    return m ? Response.json(m) : new Response('{}', { status: 404 });
  }
  if (u.hostname === 'mapillary.demo.invalid') {
    const id = Number(u.pathname.slice(1, -4));
    const file = path.join(work, `mly-${id}.jpg`);
    await require('./scene').renderPano(900 + id % 100 * 5, { season: 'summer', jitter: id }, file);
    const buf = await require('fs').promises.readFile(file);
    return new Response(buf, { headers: { 'content-type': 'image/jpeg' } });
  }
  return new Response('offline', { status: 503 });
}

const DAY = 86400000;
const hash = (s) => {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return ((h >>> 0) % 100000) / 100000;
};
const doy = (d) => (Date.parse(`${d}T00:00:00Z`) - Date.parse(`${d.slice(0, 4)}-01-01T00:00:00Z`)) / DAY;
const dry = (d) => d >= '2025-06-01' && d <= '2025-08-31';

function daily(d, lat) {
  const season = Math.sin(((doy(d) - 105) / 365) * 2 * Math.PI);
  // Around the forest the north is a little cooler; the demo glacier (below 47° N) lies high in the Alps.
  let tm = 9.5 + 9 * season + (hash(`t${d}`) - 0.5) * 6 - (lat > 47 ? (lat - 47.37) * 20 : 11);
  if (dry(d)) tm += 3.2;
  const wet = hash(`r${d}`) < (dry(d) ? 0.12 : 0.42);
  const p = wet ? Math.round((1 + hash(`p${d}`) * 14) * 10) / 10 : 0;
  return { tm, tx: tm + 5 + hash(`x${d}`) * 3, tn: tm - 5 - hash(`n${d}`) * 2, p };
}

// "Klima im Wandel" asks for the years since 1940 and for the climate models to 2050 (daily values with snowfall
// and a date range): those carry a warming like the Swiss lowlands', hot and dry summers; the 1991–2020 mean stays
// the plain demo weather, and every other request keeps it unchanged.
const HOT_SUMMERS = { 1947: 1.9, 1952: 1.1, 1976: 1.3, 1983: 1.4, 1994: 1.2, 2003: 4.2, 2015: 2.3, 2018: 2.6, 2019: 1.9, 2022: 3.0, 2023: 2.2, 2025: 1.8 };
const DRY_SUMMERS = new Set([1947, 1976, 1991, 2003, 2015, 2018, 2022]);
function climateShift(d, w, model, elev, lat = 47.37) {
  const year = Number(d.slice(0, 4));
  const month = Number(d.slice(5, 7));
  const pace = model ? 0.75 + hash(`m${model}`) * 0.7 : 1; // the models warm faster or slower
  const trend = year < 1980 ? (year - 1940) * 0.004 : 0.16 + (year - 1980) * 0.048 * pace;
  const shift = trend + (hash(`y${year}${model || ''}`) - 0.5) * 1.1 - 1.36 +
    (!model && month >= 6 && month <= 8 ? HOT_SUMMERS[year] || 0 : 0);
  const dry = !model && month >= 6 && month <= 8 && DRY_SUMMERS.has(year);
  // Downscaled to the requested altitude (0.55 °C per 100 m), like Open-Meteo; the models without it.
  // The plain demo weather cools 2 °C per 0.1° northwards; across a region that is too much.
  const lapse = (Number.isFinite(elev) && elev > 0 ? -(elev - 600) * 0.0055 : 0) + (lat > 47 ? (lat - 47.37) * 17 : 0);
  return { tm: w.tm + shift + lapse, tx: w.tx + shift * 1.15 + lapse, tn: w.tn + shift * 0.9 + lapse, p: dry ? Math.round(w.p * 0.3 * 10) / 10 : w.p };
}

// Days with drawn weather for "Licht & Wald": a snowy winter morning and a rainy November day.
const WEATHER_DAYS = {
  '2026-02-10': { temp: (h) => -3 + h * 0.08, precip: (h) => (h >= 5 && h <= 17 ? 0.5 : 0), cloud: 96, depth: 0.28 },
  '2025-11-21': { temp: (h) => 5 + Math.sin(((h - 6) / 18) * Math.PI) * 2, precip: (h) => (h >= 6 && h <= 20 ? 1.8 : 0), cloud: 100, depth: 0 },
};

const STORMS = { '2022-02-17': [118, 255], '2022-02-18': [92, 265], '2026-02-24': [101, 245], '2023-07-24': [84, 240], '2018-01-03': [129, 260] };

function elevation(lat, lon) {
  if (lat < 46.9) return glacier.elevation(lat, lon);
  // Hill (Adlisberg-like) north-east, hollow towards the south-west.
  const hill = 130 * Math.exp(-(((lat - 47.3765) / 0.006) ** 2 + ((lon - 8.578) / 0.009) ** 2));
  const hollow = -45 * Math.exp(-(((lat - 47.367) / 0.0025) ** 2 + ((lon - 8.566) / 0.0035) ** 2));
  // Hills and valleys of the wider region, for the climate map; flat out to ~4 km around the forest.
  const r = Math.hypot(lat - 47.373, (lon - 8.575) * 0.68);
  const far = Math.max(0, Math.min(1, (r - 0.04) / 0.08));
  const relief = far * (260 * Math.sin((lon - 8.3) * 14) * Math.cos((lat - 47.2) * 11) + 180 * Math.sin((lat - 47.1) * 19));
  return Math.round(560 + hill + hollow + (lat - 47.37) * 900 + relief);
}

async function weatherFetch(url) {
  const u = new URL(url);
  const q = u.searchParams;
  const json = (o) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
  if (u.pathname.includes('/elevation')) {
    const lats = q.get('latitude').split(',').map(Number);
    const lons = q.get('longitude').split(',').map(Number);
    return json({ elevation: lats.map((la, i) => elevation(la, lons[i])) });
  }
  if (u.hostname.includes('open-meteo')) {
    const lat = Number(q.get('latitude'));
    const days = [];
    // A date range, or for a forecast the days from today (forecast_days).
    const from = q.get('start_date') ? Date.parse(`${q.get('start_date')}T00:00:00Z`) : Math.floor(Date.now() / DAY) * DAY;
    const to = q.get('end_date') ? Date.parse(`${q.get('end_date')}T00:00:00Z`) : from + (Number(q.get('forecast_days') || 7) - 1) * DAY;
    for (let t = from; t <= to; t += DAY) days.push(new Date(t).toISOString().slice(0, 10));
    const kmh = q.get('wind_speed_unit') === 'kmh' ? 3.6 : 1;
    const code = (precip, temp, cloud) => (precip >= 0.1 ? (temp <= 0.5 ? (precip > 1 ? 73 : 71) : precip > 2 ? 65 : precip > 0.5 ? 63 : 61) : cloud > 85 ? 3 : cloud > 45 ? 2 : cloud > 15 ? 1 : 0);
    let dailyOut = null;
    if (q.get('daily')) {
      const vars = q.get('daily').split(',');
      const out = { time: days };
      const climate = q.get('start_date') && vars.includes('snowfall_sum') && vars.includes('temperature_2m_min');
      for (const v of vars) {
        out[v] = days.map((d) => {
          const w = climate ? climateShift(d, daily(d, lat), q.get('models'), Number(q.get('elevation')), lat) : daily(d, lat);
          switch (v) {
            case 'precipitation_sum': return w.p;
            case 'temperature_2m_mean': return Math.round(w.tm * 10) / 10;
            case 'temperature_2m_max': return Math.round(w.tx * 10) / 10;
            case 'temperature_2m_min': return Math.round(w.tn * 10) / 10;
            case 'wind_gusts_10m_max': return STORMS[d]?.[0] ?? Math.round(22 + hash(`g${d}`) * 30);
            case 'wind_speed_10m_max': return Math.round(10 + hash(`w${d}`) * 15);
            case 'wind_direction_10m_dominant': return STORMS[d]?.[1] ?? Math.round(hash(`d${d}`) * 360);
            case 'weather_code': return code(w.p / 5, w.tm, hash(`c${d}`) * 100);
            case 'precipitation_probability_max': return w.p ? Math.round(60 + hash(`q${d}`) * 35) : Math.round(hash(`q${d}`) * 20);
            case 'snowfall_sum': return w.tm <= 0.5 ? Math.round(w.p * 0.7 * 10) / 10 : 0;
            case 'sunshine_duration': return Math.round((1 - hash(`c${d}`)) * 9 * 3600);
            default: return null;
          }
        });
      }
      if (!q.get('hourly')) return json({ utc_offset_seconds: 0, timezone: 'UTC', daily: out });
      dailyOut = out;
    }
    if (q.get('hourly')) {
      const utc = q.get('timezone') === 'UTC';
      const summer = (d) => d.slice(5) >= '03-29' && d.slice(5) <= '10-25';
      const offset = utc ? 0 : summer(days[0]) ? 7200 : 3600;
      const vars = q.get('hourly').split(',');
      const time = [];
      const rows = [];
      for (const d of days) {
        const w = daily(d, lat);
        const cloudy = hash(`c${d}`);
        const dayLen = 12 + 3.5 * Math.sin(((doy(d) - 80) / 365) * 2 * Math.PI);
        const peak = 250 + 600 * Math.max(0, Math.sin(((doy(d) - 80) / 365) * 2 * Math.PI + 0.9));
        for (let h = 0; h < 24; h++) {
          time.push(`${d}T${String(h).padStart(2, '0')}:00`);
          const solar = Math.max(0, Math.cos(((h - 13) / dayLen) * Math.PI));
          const cloud = Math.round(Math.min(100, Math.max(0, cloudy * 100 + Math.sin(h / 3 + cloudy * 9) * 25)));
          const calm = cloudy < 0.25;
          const special = WEATHER_DAYS[d];
          const temp = special ? Math.round(special.temp(h) * 10) / 10 : Math.round((w.tn + (w.tx - w.tn) * Math.max(0, Math.sin(((h - 6) / 18) * Math.PI))) * 10) / 10;
          const precip = special ? special.precip(h) : w.p && h >= 14 && h <= 18 ? Math.round((w.p / 5) * 10) / 10 : 0;
          const cover = special ? special.cloud : cloud;
          const winter = /-(12|01|02)-/.test(d);
          rows.push({
            temperature_2m: temp,
            wind_speed_10m: calm && (h < 8 || h > 19) ? 0.7 : Math.round((2 + hash(`v${d}${h}`) * 5) * 10) / 10,
            cloud_cover: cover,
            shortwave_radiation: Math.round(peak * solar * (1 - (cover / 100) * 0.7)),
            precipitation: precip,
            rain: temp > 0.5 ? precip : 0,
            snowfall: temp <= 0.5 ? Math.round(precip * 0.7 * 100) / 100 : 0,
            snow_depth: special ? special.depth : winter && w.tm < 2 ? 0.06 : 0,
            weather_code: code(precip, temp, cover),
            precipitation_probability: precip >= 0.1 ? Math.round(65 + hash(`r${d}${h}`) * 30) : Math.round(hash(`r${d}${h}`) * 15),
            wind_direction_10m: Math.round(220 + hash(`dir${d}`) * 60),
            wind_gusts_10m: Math.round((14 + hash(`v${d}${h}`) * 25) * 10) / 10,
            is_day: solar > 0 ? 1 : 0,
          });
          rows[rows.length - 1].wind_speed_10m = Math.round(rows[rows.length - 1].wind_speed_10m * kmh * 10) / 10;
        }
      }
      const out = { time };
      for (const v of vars) out[v] = rows.map((r) => r[v] ?? null);
      return json({ utc_offset_seconds: offset, timezone: 'Europe/Zurich', hourly: out, ...(dailyOut ? { daily: dailyOut } : {}) });
    }
  }
  return new Response('offline', { status: 503 });
}

// A stand-in for the Overpass API (path network of the walk-through): the forest track of the 360° recording
// (seed.js), which starts at the windthrow spot and first runs north before it turns north-east, and a side path.
const track = (i) => ({ lat: 47.37360 + i * 0.00028, lon: 8.57245 + i * 0.00034 });
const WAYS = [
  [[47.37300, 8.57180], [47.37327, 8.57203], [47.37362, 8.57210], ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => [track(i).lat, track(i).lon])],
  [[47.37327, 8.57203], [47.37290, 8.57262], [47.37262, 8.57340]],
  [[track(3).lat, track(3).lon], [47.37490, 8.57300], [47.37560, 8.57270]],
];
async function overpassFetch() {
  let node = 1;
  const ids = new Map();
  const idOf = ([lat, lon]) => { const k = `${lat},${lon}`; if (!ids.has(k)) ids.set(k, node++); return ids.get(k); };
  return Response.json({
    elements: WAYS.map((w, i) => ({
      type: 'way', id: 100 + i, tags: { highway: i === 0 ? 'track' : 'path' },
      nodes: w.map(idOf), geometry: w.map(([lat, lon]) => ({ lat, lon })),
    })),
  });
}

const work = process.env.DEMO_DIR || path.join(__dirname, '.demo');
// DEMO_GLETSCHER=1 also gets the GLAMOS length change and an archive catalogue; the archive pictures are drawn.
const glacierDir = path.join(work, 'gletscher');
if (process.env.DEMO_GLETSCHER === '1') {
  fs.mkdirSync(glacierDir, { recursive: true });
  fs.writeFileSync(path.join(glacierDir, 'glamos-laenge.csv'), glacier.glamosCsv());
  fs.writeFileSync(path.join(glacierDir, 'archiv-katalog.csv'), glacier.archiveCsv());
}
const archiveFetch = async () => new Response(await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#8a7d68' } }).jpeg().toBuffer(), { headers: { 'content-type': 'image/jpeg' } });
/** DWD capabilities: radar pictures every 5 minutes from 8 October 2026 (the light-and-shadow screenshot) until now, warnings. */
async function dwdFetch() {
  const newest = new Date(Math.floor((Date.now() - 4 * 60000) / 300000) * 300000).toISOString().replace('.000Z', 'Z');
  return new Response(`<WMS_Capabilities version="1.3.0"><Capability><Layer><Title>DWD</Title>
    <Layer><Name>dwd:Niederschlagsradar</Name><Title>Radar</Title><Dimension name="time" units="ISO8601">2026-10-08T00:00:00Z/${newest}/PT5M</Dimension></Layer>
    <Layer><Name>dwd:Warnungen_Gemeinden</Name><Title>Warnungen</Title></Layer></Layer></Capability></WMS_Capabilities>`);
}

/**
 * MeteoSwiss radar stand-in: the STAC listing has a file every 5 minutes for the last three hours; the files are
 * the four steps of a rain front crossing the demo forest (radar-ch/make.py), the newest with the front over it.
 */
const RADAR_STAC = require('../../src/routes/radar-ch').DEFAULT_URL;
const radarNewest = () => Math.floor((Date.now() - 4 * 60000) / 300000) * 300000;
async function mchRadarFetch(url) {
  if (url.startsWith(`${RADAR_STAC}/items`)) {
    const assets = {};
    for (let t = radarNewest() - 3 * 3600000; t <= radarNewest(); t += 300000) {
      const d = new Date(t);
      const doyUtc = Math.floor((t - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY) + 1;
      const name = `rzc${String(d.getUTCFullYear()).slice(2)}${String(doyUtc).padStart(3, '0')}${d.toISOString().slice(11, 13)}${d.toISOString().slice(14, 16)}vl.801.h5`;
      assets[name] = { href: `https://data.geo.admin.ch/ch.meteoschweiz.ogd-radar-precip/demo/${name}` };
    }
    return new Response(JSON.stringify({ features: [{ id: 'demo', assets }], links: [] }));
  }
  const t = require('../../src/routes/radar-ch').timeOfFile(url);
  if (t === null) return new Response('nope', { status: 404 });
  const step = Math.max(0, Math.min(3, Math.floor((t - (radarNewest() - 2 * 3600000)) / 1800000)));
  return new Response(fs.readFileSync(path.join(__dirname, 'radar-ch', `front-${step}.h5`)));
}

/**
 * geo.admin.ch for the heights of trees and buildings (src/surface.js): a STAC item per km tile and
 * GeoTIFFs at 2 m drawn from the demo forest and village; the terrain model is flat, so the surface
 * model carries just the heights above ground.
 */
const { lv95ToWgs84, wgs84ToLv95 } = require('../../src/lv95');
const surfaceFiles = new Map();
async function surfaceFetch(url, opts = {}) {
  const u = new URL(url);
  if (u.pathname.endsWith('/items')) {
    const [w, sth, e, nth] = u.searchParams.get('bbox').split(',').map(Number);
    const [E, N] = wgs84ToLv95((sth + nth) / 2, (w + e) / 2).map((v) => Math.floor(v / 1000));
    const kind = u.pathname.includes('swisssurface3d') ? 'surface' : 'terrain';
    return Response.json({ features: [{ id: `${kind}_2021_${E}-${N}`, assets: { tif: { href: `https://data.geo.admin.ch/demo/${kind}-${E}-${N}_0.5_2056_5728.tif` } } }] });
  }
  const m = /(surface|terrain)-(\d+)-(\d+)_/.exec(u.pathname);
  if (!m) return new Response('not found', { status: 404 }); // e.g. Meta's canopy heights outside the demo area
  const [, kind, E, N] = m;
  const key = `${kind}-${E}-${N}`;
  if (!surfaceFiles.has(key)) {
    const { writeArrayBuffer } = await import('geotiff');
    const n = 500; const res = 2;
    const v = new Float32Array(n * n);
    if (kind === 'surface') {
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) v[r * n + c] = tiles.objectHeight(...lv95ToWgs84(E * 1000 + (c + 0.5) * res, (Number(N) + 1) * 1000 - (r + 0.5) * res));
      }
    }
    surfaceFiles.set(key, Buffer.from(writeArrayBuffer(v, {
      width: n, height: n, ModelPixelScale: [res, res, 0], ModelTiepoint: [0, 0, 0, E * 1000, (Number(N) + 1) * 1000, 0],
      ProjectedCSTypeGeoKey: 2056, GTModelTypeGeoKey: 1, BitsPerSample: [32], SampleFormat: [3],
    })));
  }
  const buf = surfaceFiles.get(key);
  const r = /bytes=(\d+)-(\d+)/.exec(opts.headers?.Range || '');
  if (!r) return new Response(buf);
  const end = Math.min(Number(r[2]), buf.length - 1);
  return new Response(buf.subarray(Number(r[1]), end + 1), { status: 206, headers: { 'content-range': `bytes ${r[1]}-${end}/${buf.length}` } });
}

// A stand-in for the WMS of geo.admin.ch: capabilities with three demo layers and maps drawn from the demo
// terrain: the climate normal (temperature by altitude) and the forest belts today and with a warmer climate.
const DEMO_WMS_LAYERS = [
  ['ch.meteoschweiz.klimanormwerte-temperatur_aktuelle_periode', 'Klimanormwerte Temperatur 1991–2020 (Demo)'],
  ['ch.bafu.wald-vegetationshoehenstufen_1975', 'Vegetationshöhenstufen heute (Demo)'],
  ['ch.bafu.wald-vegetationshoehenstufen_2085_trocken', 'Vegetationshöhenstufen 2085, trockeneres Klima (Demo)'],
  // Panel «Ebenen»: one demo layer per theme.
  ['ch.bafu.gefahren-waldbrand_warnung', 'Waldbrandgefahr (Demo)'],
  ['ch.bafu.landesforstinventar-vegetationshoehenmodell', 'Vegetationshöhenmodell (Demo)'],
  ['ch.bfs.volkszaehlung-bevoelkerungsstatistik_einwohner', 'Bevölkerung pro Hektare (Demo)'],
  ['ch.bfs.arealstatistik', 'Arealstatistik: Bodennutzung (Demo)'],
  ['ch.are.belastung-personenverkehr-strasse', 'Personenverkehr auf der Strasse (Demo)'],
];
const ZH_LAYERS = [['baumkataster_baumstandorte', 'Baumstandorte (Demo)']];
// Residents of a hectare cell in the demo village (none in the forest).
const residents = (lat, lon) => (tiles.classAt(lat, lon) === 'residential' ? 8 + Math.floor(hash(`${Math.floor(lat * 900)}|${Math.floor(lon * 660)}`) * 70) : 0);
const AREAL = { wood: [[79, 140, 70], 'Wald'], grass: [[190, 215, 120], 'Landwirtschaftsfläche'], residential: [[215, 90, 80], 'Siedlungsfläche'],
  water: [[90, 150, 210], 'Gewässer'], land: [[230, 215, 140], 'Landwirtschaftsfläche'], ice: [[230, 240, 250], 'Gletscher'], rock: [[180, 180, 180], 'Unproduktive Fläche'] };
// Street trees along the main road, every ~25 m (the demo «Baumkataster»).
const STREET_TREES = (() => {
  const out = [];
  const main = tiles.demoLines().find(([k]) => k === 'main')[1];
  for (let k = 1; k < main.length; k++) {
    const [a, b] = [main[k - 1], main[k]];
    const n = Math.round(Math.hypot((b[0] - a[0]) * 111320, (b[1] - a[1]) * 75500) / 45);
    for (let i = 0; i < n; i++) {
      const t = i / n;
      out.push({ lat: a[0] + (b[0] - a[0]) * t + 0.00009, lon: a[1] + (b[1] - a[1]) * t, art: ['Tilia cordata', 'Acer platanoides', 'Platanus ×hispanica'][(k + i) % 3] });
    }
  }
  return out;
})();
const TREE_NAMES = { 'Tilia cordata': 'Winter-Linde', 'Acer platanoides': 'Spitz-Ahorn', 'Platanus ×hispanica': 'Ahornblättrige Platane' };
const BELTS = [[600, [205, 170, 90]], [1000, [150, 180, 90]], [1400, [80, 140, 80]], [1800, [60, 105, 110]], [Infinity, [150, 150, 170]]];
async function demoWms(url) {
  const q = new URL(url).searchParams;
  const get = (k) => q.get(k) ?? q.get(k.toLowerCase());
  const zh = q.get('src') === 'zh';
  if (/getfeatureinfo/i.test(get('REQUEST') || '')) {
    // The nearest street tree within ~15 m of the clicked pixel.
    const [bx0, by0, bx1, by1] = get('BBOX').split(',').map(Number);
    const R = 6378137;
    const lon = (((bx0 + bx1) / 2) / R) * 180 / Math.PI;
    const lat = (Math.atan(Math.sinh(((by0 + by1) / 2) / R)) * 180) / Math.PI;
    const t = STREET_TREES.map((x) => ({ ...x, d: Math.hypot((x.lat - lat) * 111320, (x.lon - lon) * 75500) })).sort((a, b) => a.d - b.d)[0];
    return Response.json({ type: 'FeatureCollection', features: t && t.d < 40 ? [{ properties: { baumnamedeu: TREE_NAMES[t.art], baumartlat: t.art, pflanzjahr: 1960 + Math.floor(t.lat * 1e5) % 55, kronendurchmesser: 6 + Math.floor(t.lon * 1e5) % 7 } }] : [] });
  }
  if (/getlegendgraphic/i.test(get('REQUEST') || '')) return new Response('', { status: 404 });
  if (/getcapabilities/i.test(get('REQUEST') || '')) {
    const layers = (zh ? ZH_LAYERS : DEMO_WMS_LAYERS).map(([n, t]) => `<Layer queryable="1"><Name>${n}</Name><Title>${t}</Title></Layer>`).join('');
    return new Response(`<?xml version="1.0"?><WMS_Capabilities version="1.3.0"><Capability><Layer><Title>geo.admin.ch (Demo)</Title>${layers}</Layer></Capability></WMS_Capabilities>`,
      { headers: { 'content-type': 'text/xml' } });
  }
  const [x0, y0, x1, y1] = get('BBOX').split(',').map(Number);
  const w = Number(get('WIDTH')); const h = Number(get('HEIGHT'));
  const layer = get('LAYERS');
  const shift = layer.endsWith('2085_trocken') ? 600 : 0;
  const R = 6378137;
  const px = Buffer.alloc(w * h * 4);
  for (let j = 0; j < h; j += 2) {
    const lat = (Math.atan(Math.sinh((y1 - (j / h) * (y1 - y0)) / R)) * 180) / Math.PI;
    for (let i = 0; i < w; i += 2) {
      const lon = ((x0 + (i / w) * (x1 - x0)) / R) * 180 / Math.PI;
      const z = elevation(lat, lon);
      let c;
      let alpha = 170;
      if (layer.includes('waldbrand')) {
        // Warning levels by region: 3 (considerable) in the west, 2 (moderate) in the east.
        c = lon < 8.585 ? [240, 150, 40] : [250, 215, 70];
        alpha = 120;
      } else if (layer.includes('vegetationshoehenmodell')) {
        const hgt = tiles.objectHeight(lat, lon);
        if (hgt < 2) { c = null; } else { const t = Math.min(1, hgt / 35); c = [Math.round(200 - 160 * t), Math.round(220 - 90 * t), Math.round(120 - 80 * t)]; }
      } else if (layer.includes('bevoelkerung')) {
        const n = residents(lat, lon);
        c = n ? (n > 55 ? [130, 30, 90] : n > 30 ? [200, 70, 120] : [240, 150, 180]) : null;
      } else if (layer.includes('arealstatistik')) {
        c = AREAL[tiles.classAt(lat, lon)][0];
        alpha = 150;
      } else if (layer.includes('personenverkehr')) {
        const m = (lat - 47.3618) / (47.3690 - 47.3618);
        const main = tiles.demoLines().find(([k]) => k === 'main')[1];
        let d = Infinity;
        for (let k = 1; k < main.length; k++) {
          const [a, b] = [main[k - 1], main[k]];
          const ax = a[1] * 75500, ay = a[0] * 111320, bx = b[1] * 75500, by = b[0] * 111320, x = lon * 75500, y = lat * 111320;
          const tt = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
          d = Math.min(d, Math.hypot(x - ax - tt * (bx - ax), y - ay - tt * (by - ay)));
        }
        const mpp = (x1 - x0) / w;
        c = d < Math.max(6, mpp * 3) ? (m < 0.5 ? [200, 40, 40] : [240, 140, 40]) : null;
        alpha = 230;
      } else if (zh) {
        const mpp = (x1 - x0) / w;
        const hit = STREET_TREES.some((t) => Math.hypot((t.lat - lat) * 111320, (t.lon - lon) * 75500) < Math.max(4, mpp * 2.2));
        c = hit ? [40, 120, 50] : null;
        alpha = 255;
      } else if (layer.includes('klimanormwerte')) {
        const t = Math.max(0, Math.min(1, (11 - (z - 400) * 0.0055 - 4) / 7));
        c = [Math.round(60 + 190 * t), Math.round(120 + 40 * (1 - Math.abs(t - 0.5) * 2)), Math.round(220 - 180 * t)];
      } else {
        c = BELTS.find(([top]) => z + shift < top)[1];
      }
      if (!c) continue;
      for (const [di, dj] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        if (i + di >= w || j + dj >= h) continue;
        const o = ((j + dj) * w + i + di) * 4;
        px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = alpha;
      }
    }
  }
  const png = await sharp(px, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
  return new Response(png, { headers: { 'content-type': 'image/png' } });
}

// A stand-in for a tree inventory (ArcGIS query) around the demo forest: trees outside the stand at the windthrow
// spot, as Geneva's inventory lists them (Latin and French names, height, remarkable trees).
const INVENTORY = [
  ['Acer pseudoplatanus', 'Erable sycomore', 0.00012, 0.00005, 22], ['Acer pseudoplatanus', 'Erable sycomore', 0.0002, -0.0001, 19],
  ['Carpinus betulus', 'Charme', -0.00008, 0.00015, 14], ['Quercus robur L.', 'Chêne pédonculé', 0.00025, 0.0002, 27, 1],
  ['Fagus sylvatica', 'Hêtre commun', -0.0002, -0.00012, 29], ['Platanus x hispanica Mill. ex Münchh.', 'Platane commun', 0.0003, -0.00025, 24],
  ['Tilia cordata Mill.', 'Tilleul à petites feuilles', -0.00028, 0.00026, 17],
];
async function inventoryFetch(url) {
  const q = new URL(url).searchParams;
  const [lon, lat] = q.get('geometry').split(',').map(Number);
  return Response.json({
    features: INVENTORY.map(([latin, common, dLat, dLon, h, rem = 0], i) => ({
      attributes: { OBJECTID: i + 1, NOM_LATIN: latin, NOM_COMMUN: common, HAUTEUR_TOTALE: h, REMARQUABLE: rem },
      geometry: { x: lon + dLon, y: lat + dLat },
    })),
  });
}

// identify of geo.admin.ch for the demo layers: fire danger, residents of the hectare, land use.
function demoIdentify(url) {
  const q = new URL(url).searchParams;
  const [lon, lat] = q.get('geometry').split(',').map(Number);
  const names = q.get('layers').replace(/^all:/, '').split(',');
  const results = [];
  for (const n of names) {
    if (n.includes('waldbrand')) results.push({ layerBodId: n, layerName: 'Waldbrandgefahr (Demo)', attributes: { gefahrenstufe: lon < 8.585 ? 3 : 2, beschreibung: lon < 8.585 ? 'erhebliche Gefahr' : 'mässige Gefahr', region: 'Zürich (Demo)' } });
    if (n.includes('bevoelkerung')) results.push({ layerBodId: n, layerName: 'Bevölkerung pro Hektare (Demo)', attributes: { einwohner: residents(lat, lon), jahr: 2024 } });
    if (n.includes('arealstatistik')) results.push({ layerBodId: n, layerName: 'Arealstatistik: Bodennutzung (Demo)', attributes: { nutzung: AREAL[tiles.classAt(lat, lon)][1], erhebung: '2013/18' } });
  }
  return Response.json({ results });
}

const app = createApp({
  dataDir: path.join(work, 'data'),
  dwdFetch,
  mchRadarFetch,
  surfaceFetch,
  // DEMO_GLETSCHER=1: the glacier inventories of the demo glacier (written by seed-gletscher.js).
  ...(process.env.DEMO_MAPILLARY === '1' ? { mapillaryToken: 'MLY|demo', mapillaryFetch } : {}),
  glacierFiles: process.env.DEMO_GLETSCHER === '1' ? Object.keys(glacier.inventories()).map((f) => path.join(work, 'gletscher', f)).join(',') : '',
  ...(process.env.DEMO_GLETSCHER === '1' ? {
    glamosFiles: path.join(glacierDir, 'glamos-laenge.csv'), archiveFiles: path.join(glacierDir, 'archiv-katalog.csv'), archiveFetch,
  } : {}),
  weatherFetch,
  // Terrain of the 3D map from the demo terrain (the same hills as the placeholder map and the shadows).
  terrainFetch: async (url) => {
    const [z, x, y] = url.match(/\/(\d+)\/(\d+)\/(\d+)\.png$/).slice(1).map(Number);
    return new Response(await tiles.terrariumTile(z, x, y), { headers: { 'Content-Type': 'image/png' } });
  },
  waynetUrl: 'https://overpass.demo.invalid/api/interpreter', waynetFetch: overpassFetch,
  tileOptions: { precompute: false },
  // Sign-in buttons for the screenshots; the demo never talks to Google, GitHub, Microsoft, Switch or AGOV.
  oauthProviders: {
    google: { clientId: 'demo', clientSecret: 'demo' },
    github: { clientId: 'demo', clientSecret: 'demo' },
    microsoft: { clientId: 'demo', clientSecret: 'demo' },
    eduid: { clientId: 'demo', clientSecret: 'demo' },
    agov: { clientId: 'demo', clientSecret: 'demo', issuer: 'https://agov.example' },
  },
  mailer: { send: async () => ({ sent: true }) },
  // Climate map: every cell at once in the demo, and the demo WMS below instead of geo.admin.ch.
  // The tree inventory stand-in, covering the demo forest instead of Geneva.
  // Buildings and trees as 3D Tiles: a hamlet and tree crowns at the demo forest instead of swisstopo's.
  tiles3dBuildings: `http://localhost:${Number(process.env.PORT) || 3123}/demo-3d/gebaeude/tileset.json`,
  tiles3dVegetation: `http://localhost:${Number(process.env.PORT) || 3123}/demo-3d/baeume/tileset.json`,
  treeInventoryFetch: inventoryFetch,
  treeInventoryOptions: { url: 'https://inventar.demo.invalid/MapServer/1', name: 'Bauminventar (Demo)', attribution: 'Demo-Daten im Format des Genfer Bauminventars (SITG)', bbox: [8.5, 47.3, 8.65, 47.45] },
  // The base map «MyForrest» from demo vector tiles, and the panel «Ebenen» from the demo WMS and identify.
  basemapStyle: `http://localhost:${Number(process.env.PORT) || 3123}/demo-vt/style.json`,
  basemapAttribution: 'Demo-Vektorkacheln im Format von OpenMapTiles',
  layersFetch: async (url) => (url.startsWith('http://demo.invalid/identify') ? demoIdentify(url) : demoWms(url)),
  layersOptions: {
    geoadminUrl: `http://localhost:${Number(process.env.PORT) || 3123}/demo-wms`,
    identifyUrl: 'http://demo.invalid/identify',
    regional: [{ url: `http://localhost:${Number(process.env.PORT) || 3123}/demo-wms?src=zh`, group: 'Bäume Stadt Zürich', bbox: [8.44, 47.32, 8.63, 47.44], attribution: 'Demo im Format des Baumkatasters der Stadt Zürich' }],
  },
  klimaOptions: { cellsPerDay: 500, wmsUrl: `http://localhost:${Number(process.env.PORT) || 3123}/demo-wms`, wmsFetch: demoWms, wmsGenf: '' },
});
app.get('/demo-3d/:kind/:file', (req, res) => {
  const kind = req.params.kind === 'gebaeude' ? 'gebaeude' : 'baeume';
  res.set('access-control-allow-origin', '*');
  if (req.params.file === 'tileset.json') return res.json(tiles3d.tileset(kind, elevation));
  const { content } = kind === 'gebaeude' ? tiles3d.buildings(elevation) : tiles3d.trees(elevation);
  return res.type('application/octet-stream').send(content);
});
app.get('/demo-vt/style.json', (req, res) => res.json(vectorDemo.style(`http://localhost:${Number(process.env.PORT) || 3123}/demo-vt`)));
app.get('/demo-vt/:z/:x/:y.pbf', (req, res) => {
  res.set('access-control-allow-origin', '*');
  res.type('application/x-protobuf').send(vectorDemo.tile(Number(req.params.z), Number(req.params.x), Number(req.params.y)));
});
app.get('/demo-wms', async (req, res) => {
  const r = await demoWms(`http://x/demo-wms?${new URLSearchParams(req.query)}`);
  res.type(r.headers.get('content-type')).send(Buffer.from(await r.arrayBuffer()));
});
const port = Number(process.env.PORT) || 3123;
app.listen(port, () => console.log(`Demo-Server auf http://localhost:${port}`));
