'use strict';
// Demo server for the README screenshots: the real app with a synthetic Open-Meteo stand-in, so weather,
// storms, night cooling and the elevation model work without network access.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { createApp } = require('../../src/app');
const glacier = require('./glacier-demo');

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

const STORMS = { '2022-02-17': [118, 255], '2022-02-18': [92, 265], '2026-02-24': [101, 245], '2023-07-24': [84, 240], '2018-01-03': [129, 260] };

function elevation(lat, lon) {
  if (lat < 46.9) return glacier.elevation(lat, lon);
  // Hill (Adlisberg-like) north-east, hollow towards the south-west.
  const hill = 130 * Math.exp(-(((lat - 47.3765) / 0.006) ** 2 + ((lon - 8.578) / 0.009) ** 2));
  const hollow = -45 * Math.exp(-(((lat - 47.367) / 0.0025) ** 2 + ((lon - 8.566) / 0.0035) ** 2));
  return Math.round(560 + hill + hollow + (lat - 47.37) * 900);
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
    for (let t = Date.parse(`${q.get('start_date')}T00:00:00Z`); t <= Date.parse(`${q.get('end_date')}T00:00:00Z`); t += DAY) {
      days.push(new Date(t).toISOString().slice(0, 10));
    }
    if (q.get('daily')) {
      const vars = q.get('daily').split(',');
      const out = { time: days };
      for (const v of vars) {
        out[v] = days.map((d) => {
          const w = daily(d, lat);
          switch (v) {
            case 'precipitation_sum': return w.p;
            case 'temperature_2m_mean': return Math.round(w.tm * 10) / 10;
            case 'temperature_2m_max': return Math.round(w.tx * 10) / 10;
            case 'temperature_2m_min': return Math.round(w.tn * 10) / 10;
            case 'wind_gusts_10m_max': return STORMS[d]?.[0] ?? Math.round(22 + hash(`g${d}`) * 30);
            case 'wind_speed_10m_max': return Math.round(10 + hash(`w${d}`) * 15);
            case 'wind_direction_10m_dominant': return STORMS[d]?.[1] ?? Math.round(hash(`d${d}`) * 360);
            default: return null;
          }
        });
      }
      return json({ utc_offset_seconds: 0, timezone: 'UTC', daily: out });
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
          rows.push({
            temperature_2m: Math.round((w.tn + (w.tx - w.tn) * Math.max(0, Math.sin(((h - 6) / 18) * Math.PI))) * 10) / 10,
            wind_speed_10m: calm && (h < 8 || h > 19) ? 0.7 : Math.round((2 + hash(`v${d}${h}`) * 5) * 10) / 10,
            cloud_cover: cloud,
            shortwave_radiation: Math.round(peak * solar * (1 - (cloud / 100) * 0.7)),
            precipitation: w.p && h >= 14 && h <= 18 ? Math.round((w.p / 5) * 10) / 10 : 0,
          });
        }
      }
      const out = { time };
      for (const v of vars) out[v] = rows.map((r) => r[v] ?? null);
      return json({ utc_offset_seconds: offset, timezone: 'Europe/Zurich', hourly: out });
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
/** DWD capabilities: radar pictures every 5 minutes on 8 and 9 October 2026 (the day of the screenshot), warnings. */
async function dwdFetch() {
  return new Response(`<WMS_Capabilities version="1.3.0"><Capability><Layer><Title>DWD</Title>
    <Layer><Name>dwd:Niederschlagsradar</Name><Title>Radar</Title><Dimension name="time" units="ISO8601">2026-10-08T00:00:00Z/2026-10-09T23:55:00Z/PT5M</Dimension></Layer>
    <Layer><Name>dwd:Warnungen_Gemeinden</Name><Title>Warnungen</Title></Layer></Layer></Capability></WMS_Capabilities>`);
}

const app = createApp({
  dataDir: path.join(work, 'data'),
  dwdFetch,
  // DEMO_GLETSCHER=1: the glacier inventories of the demo glacier (written by seed-gletscher.js).
  ...(process.env.DEMO_MAPILLARY === '1' ? { mapillaryToken: 'MLY|demo', mapillaryFetch } : {}),
  glacierFiles: process.env.DEMO_GLETSCHER === '1' ? Object.keys(glacier.inventories()).map((f) => path.join(work, 'gletscher', f)).join(',') : '',
  ...(process.env.DEMO_GLETSCHER === '1' ? {
    glamosFiles: path.join(glacierDir, 'glamos-laenge.csv'), archiveFiles: path.join(glacierDir, 'archiv-katalog.csv'), archiveFetch,
  } : {}),
  weatherFetch,
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
});
const port = Number(process.env.PORT) || 3123;
app.listen(port, () => console.log(`Demo-Server auf http://localhost:${port}`));
