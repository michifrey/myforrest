'use strict';
// Demo server for the README screenshots: the real app with a synthetic Open-Meteo stand-in, so weather,
// storms, night cooling and the elevation model work without network access.
const path = require('path');
const { createApp } = require('../../src/app');

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
  let tm = 9.5 + 9 * season + (hash(`t${d}`) - 0.5) * 6 - (lat - 47.37) * 20;
  if (dry(d)) tm += 3.2;
  const wet = hash(`r${d}`) < (dry(d) ? 0.12 : 0.42);
  const p = wet ? Math.round((1 + hash(`p${d}`) * 14) * 10) / 10 : 0;
  return { tm, tx: tm + 5 + hash(`x${d}`) * 3, tn: tm - 5 - hash(`n${d}`) * 2, p };
}

const STORMS = { '2022-02-17': [118, 255], '2022-02-18': [92, 265], '2026-02-24': [101, 245], '2023-07-24': [84, 240], '2018-01-03': [129, 260] };

function elevation(lat, lon) {
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

const app = createApp({
  dataDir: path.join(process.env.DEMO_DIR || path.join(__dirname, '.demo'), 'data'),
  weatherFetch,
  tileOptions: { precompute: false },
  // Sign-in buttons for the screenshots; the demo never talks to Google, GitHub or Switch.
  oauthProviders: {
    google: { clientId: 'demo', clientSecret: 'demo' },
    github: { clientId: 'demo', clientSecret: 'demo' },
    eduid: { clientId: 'demo', clientSecret: 'demo' },
  },
  mailer: { send: async () => ({ sent: true }) },
});
const port = Number(process.env.PORT) || 3123;
app.listen(port, () => console.log(`Demo-Server auf http://localhost:${port}`));
