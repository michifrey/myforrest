'use strict';

// "Klima im Wandel": yearly indicators, stripes and trends, projections, MeteoSchweiz files and the dossier API.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const klima = require('../src/klima');
const { createApp } = require('../src/app');

const DAY = 86400000;

/** Daily values like Open-Meteo's: a seasonal cycle warming by `perDecade` °C, dry summers in `dry` years. */
function synthDaily(from, to, { perDecade = 0.4, base = 9, dry = [] } = {}) {
  const out = { time: [], temperature_2m_mean: [], temperature_2m_max: [], temperature_2m_min: [], precipitation_sum: [], snowfall_sum: [] };
  for (let t = Date.UTC(from, 0, 1); t <= Date.UTC(to, 11, 31); t += DAY) {
    const d = new Date(t);
    const y = d.getUTCFullYear();
    const doy = (t - Date.UTC(y, 0, 1)) / DAY;
    const tm = base + (y - 1960) * perDecade / 10 + 10 * Math.sin(((doy - 105) / 365) * 2 * Math.PI);
    const summer = d.getUTCMonth() >= 5 && d.getUTCMonth() <= 7;
    const p = dry.includes(y) && summer ? 0 : doy % 3 === 0 ? 8 : 0;
    out.time.push(d.toISOString().slice(0, 10));
    out.temperature_2m_mean.push(tm);
    out.temperature_2m_max.push(tm + 10);
    out.temperature_2m_min.push(tm - 6);
    out.precipitation_sum.push(p);
    out.snowfall_sum.push(tm < 0 && p ? 5 : 0);
  }
  return out;
}

test('yearly indicators count hot days, frost, dry spells and seasons; incomplete years are left out', () => {
  const daily = synthDaily(1990, 1991, { perDecade: 0, base: 11 });
  daily.time.push('1992-01-01'); // a single day of the next year
  for (const k of Object.keys(daily)) if (k !== 'time') daily[k].push(0);
  const rows = klima.yearlyIndicators(daily);
  assert.deepEqual(rows.map((r) => r.year), [1990, 1991]);
  const r = rows[1];
  assert.ok(Math.abs(r.tmean - 11) < 0.2, `mean ~11 °C, got ${r.tmean}`);
  assert.ok(r.hotDays > 0 && r.hotDays < r.summerDays, 'hot days are a part of the summer days');
  assert.ok(r.frostDays > r.iceDays && r.iceDays === 0, 'max never below 0 with this cycle');
  assert.equal(r.dryRun, 2, 'rain every third day');
  assert.ok(r.summerT > r.winterT + 15);
  assert.ok(r.winterT !== null && rows[0].winterT === null, 'the first winter lacks its December');
});

test('climate summary: stripes against 1961–1990, warming of the last ten years, trend per decade and records', () => {
  const rows = klima.yearlyIndicators(synthDaily(1940, 2025, { perDecade: 0.5, dry: [2003, 2018] }));
  const c = klima.climateSummary(rows);
  assert.equal(c.first, 1940);
  assert.equal(c.last, 2025);
  assert.deepEqual(c.periods.recent, [2016, 2025]);
  // Mid-reference 1975.5, mid-recent 2020.5: 45 years × 0.05 °C.
  assert.ok(Math.abs(c.warming - 2.25) < 0.1, `warming ${c.warming}`);
  assert.ok(Math.abs(c.trendPerDecade - 0.5) < 0.02, `trend ${c.trendPerDecade}`);
  assert.ok(c.stripes[0].anomaly < 0 && c.stripes[c.stripes.length - 1].anomaly > 2);
  assert.equal(c.records.warmest[0].year, 2025);
  assert.deepEqual(c.records.driestSummers.slice(0, 2).map((r) => r.year).sort(), [2003, 2018]);
  const hot = c.changes.find((x) => x.key === 'hotDays');
  assert.ok(hot.recent > hot.ref, 'more hot days today');
  const frost = c.changes.find((x) => x.key === 'frostDays');
  assert.ok(frost.delta < 0, 'fewer frost days');
});

test('projection: model changes 1991–2020 → 2031–2050 applied to the observed normal, with the model spread', () => {
  const observed = klima.yearlyIndicators(synthDaily(1985, 2025, { perDecade: 0.4 }));
  // Two models with a cold bias and different warming; the bias must not matter.
  const models = {
    A: klima.yearlyIndicators(synthDaily(1991, 2050, { perDecade: 0.3, base: 5 })),
    B: klima.yearlyIndicators(synthDaily(1991, 2050, { perDecade: 0.6, base: 6 })),
  };
  const p = klima.projectDelta(observed, models);
  assert.deepEqual(p.models, ['A', 'B']);
  const t = p.indicators.find((i) => i.key === 'tmean');
  // Change between the window means: 35 years × 0.03 resp. 0.06 °C.
  assert.ok(Math.abs(t.low - (t.normal + 1.05)) < 0.1 && Math.abs(t.high - (t.normal + 2.1)) < 0.1, JSON.stringify(t));
  assert.equal(t.models, 2);
  const precip = p.indicators.find((i) => i.key === 'precip');
  assert.equal(precip.percent, 0, 'unchanged rain stays unchanged');
  assert.equal(klima.projectDelta(observed, {}), null);
  const anomalies = klima.modelAnomalies(models);
  assert.equal(anomalies.A.length, 60);
});

// MeteoSchweiz open data files as described (semicolon CSV).
const NBCN_STATIONS = [
  'station_abbr;station_name;station_canton;station_wigos_id;station_type_de;station_dataowner;station_data_since;station_height_masl;station_height_barometer_masl;station_coordinates_lv95_east;station_coordinates_lv95_north;station_coordinates_wgs84_lat;station_coordinates_wgs84_lon',
  'SMA;Zürich / Fluntern;ZH;0-20000-0-06660;Klimastation;MeteoSchweiz;01.01.1864;556;557;2685089;1248065;47.377925;8.565742',
  'SAE;Säntis;AI;0-20000-0-06680;Klimastation;MeteoSchweiz;01.01.1864;2502;2504;2744200;1234920;47.249447;9.343469',
].join('\n');
function nbcnYearly(abbr, base) {
  const rows = ['station_abbr;reference_timestamp;ths200y0;rhs150y0;tre200y0'];
  for (let y = 1864; y <= 2025; y++) {
    const warm = y < 1980 ? (y - 1864) * 0.004 : 0.46 + (y - 1980) * 0.045;
    rows.push(`${abbr};01.01.${y} 00:00;${(base + warm).toFixed(1)};${1100 + (y % 7) * 10};${(base + warm + 0.3).toFixed(1)}`);
  }
  rows.push(`${abbr};01.01.2026 00:00;;;`); // year without values
  return rows.join('\n');
}

test('MeteoSchweiz homogeneous series: stations and yearly values by column name, the homogenised column first', () => {
  const st = klima.parseNbcnStations(NBCN_STATIONS);
  assert.deepEqual(st[0], { id: 'SMA', name: 'Zürich / Fluntern', lat: 47.377925, lon: 8.565742, elevation: 556 });
  const y = klima.parseNbcnYearly(nbcnYearly('SMA', 8.0));
  assert.equal(y.length, 162);
  assert.deepEqual(y[0], { station: 'SMA', year: 1864, temp: 8, precip: 1120 });
  const s = klima.stationSummary(y);
  assert.equal(s.first, 1864);
  assert.ok(s.sinceIndustrial > 2 && s.sinceIndustrial < 2.6, `since 1871–1900: ${s.sinceIndustrial}`);
  // The nearest station counts altitude: Säntis is closer than 80 km but 2000 m higher.
  const near = klima.nearest(st, { lat: 47.3, lon: 9.2, elevation: 600 }, 80);
  assert.equal(near.id, 'SMA');
});

test('CH2025 scenarios as CSV: indicators, warming levels in several spellings', () => {
  const rows = klima.parseScenarioCsv([
    'place;lat;lon;elevation;indicator;level;value;low;high',
    'Zürich;47.38;8.57;556;tmean;GWL2.0;1.4;1.0;1.9',
    'Zürich;47.38;8.57;556;hotDays;3;17;10;26',
    'Zürich;47.38;8.57;556;summerP;1.5;-6;-15;3',
    'Zürich;47.38;8.57;556;unbekannt;2;1;;',
  ].join('\n'));
  assert.deepEqual(rows.map((r) => [r.indicator, r.level, r.value]), [['tmean', 'GWL2.0', 1.4], ['hotDays', 'GWL3.0', 17], ['summerP', 'GWL1.5', -6]]);
});

test('synthesis joins hot summers with the notes of the photos, storms and phenology', () => {
  const rows = klima.yearlyIndicators(synthDaily(1940, 2025, { perDecade: 0.5, dry: [2018, 2022] }));
  const climate = klima.climateSummary(rows);
  const obs = {
    2018: { photos: 10, visited: 4, heatSpots: 3, notes: { trockenheit: 3, fruehe_verfaerbung: 2 }, storms: [{ date: '2018-01-03', gust: 129, windthrow: true }], ndviSummer: 0.71 },
    2020: { photos: 10, visited: 4, heatSpots: 0, notes: {}, storms: [], ndviSummer: 0.82 },
    2021: { photos: 10, visited: 4, heatSpots: 0, notes: { naesse: 1 }, storms: [], ndviSummer: 0.83 },
    2022: { photos: 10, visited: 5, heatSpots: 2, notes: { trockenheit: 2 }, storms: [], ndviSummer: 0.73 },
  };
  for (let y = 2010; y <= 2025; y++) (obs[y] ||= { photos: 0, notes: {}, storms: [] }).leafOut = 120 - (y - 2010);
  const s = klima.synthesize({ climate, rows, obs });
  const titles = s.map((x) => x.title);
  assert.match(s[0].title, /^\+2\.\d °C gegenüber 1961–1990/);
  const heat = s.find((x) => x.title === 'Hitzesommer in den Fotos');
  assert.match(heat.text, /2018 \(Sommer/);
  assert.match(heat.text, /an 5 von 9 besuchten Spots/);
  assert.match(heat.text, /\(7 Hinweise\)/);
  assert.match(heat.text, /übrigen Jahren mit Fotos an 0 von 8/, 'wetness is not a heat note');
  assert.ok(titles.includes('Weniger Grün in Hitzesommern'));
  assert.ok(titles.some((t) => /1 Sturm an den Spots/.test(t)));
  assert.ok(titles.some((t) => /Blattaustrieb der Buche: 10 Tage pro Jahrzehnt früher/.test(t)), titles.join(' | '));
});

/* ---------- API ---------- */

async function withServer(opts, fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-klima-'));
  const app = createApp({ dataDir, ...opts });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`, dataDir);
  } finally {
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test('dossier API: ERA5 indicators, projections, a loaded homogeneous series and the synthesis', async () => {
  const calls = [];
  const weatherFetch = async (url) => {
    const u = new URL(url);
    calls.push(u.hostname);
    const q = u.searchParams;
    if (u.pathname.includes('/elevation')) return Response.json({ elevation: [600] });
    if (u.hostname === 'archive-api.open-meteo.com' || u.hostname === 'climate-api.open-meteo.com') {
      const from = Number(q.get('start_date').slice(0, 4));
      const to = Number(q.get('end_date').slice(0, 4));
      const model = q.get('models');
      const d = synthDaily(from, to, { perDecade: model === 'B' ? 0.6 : 0.45, base: model ? 6 : 9 });
      // Several models answer with the model name as suffix; one model without.
      if (model === 'B') for (const k of Object.keys(d)) if (k !== 'time') { d[`${k}_B`] = d[k]; delete d[k]; }
      return Response.json({ daily: d });
    }
    return new Response('offline', { status: 503 });
  };
  await withServer({ weatherFetch, klimaModels: 'A,B' }, async (base) => {
    const bad = await fetch(`${base}/api/klima?lat=x`);
    assert.equal(bad.status, 400);
    // A station series loaded from the MeteoSchweiz files.
    let r = await fetch(`${base}/api/klima/import?format=nbcn&kind=stations`, { method: 'POST', body: NBCN_STATIONS });
    assert.deepEqual(await r.json(), { stored: 'stations', stations: 2 });
    r = await fetch(`${base}/api/klima/import?format=nbcn`, { method: 'POST', body: nbcnYearly('SMA', 8.2) });
    assert.deepEqual(await r.json(), { stations: 1, years: 162 });
    r = await fetch(`${base}/api/klima/import?format=ch2025`, { method: 'POST', body: 'place;lat;lon;elevation;indicator;level;value;low;high\nZürich;47.38;8.57;556;hotDays;GWL2.0;9;5;14' });
    assert.deepEqual(await r.json(), { scenarios: 1, places: 1 });

    const res = await fetch(`${base}/api/klima?lat=47.37&lon=8.55&radius=10`);
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(d.centre.elevation, 600);
    assert.equal(d.climate.first, 1940);
    assert.equal(d.climate.last, 2025, 'last complete year before October 2026');
    assert.ok(d.climate.warming > 1.5);
    assert.deepEqual(d.projection.models, ['A', 'B']);
    assert.equal(d.station.id, 'SMA');
    assert.ok(d.station.sinceIndustrial > 2);
    assert.equal(d.scenarios.levels['GWL2.0'][0].value, 9);
    assert.equal(d.spots, 0);
    assert.match(d.synthesis[0].text, /homogene Messreihe Zürich \/ Fluntern/);
    assert.ok(d.synthesis.some((s) => s.kind === 'zukunft'));
    const before = calls.length;
    await (await fetch(`${base}/api/klima?lat=47.37&lon=8.55`)).json();
    assert.equal(calls.length, before, 'second call from the cache');
    const status = await (await fetch(`${base}/api/klima/status`)).json();
    assert.deepEqual([status.stations, status.scenarioPlaces, status.models], [1, 1, ['A', 'B']]);
  });
});

test('dossier API without network: climate error, no projection, still the observations', async () => {
  const weatherFetch = async () => new Response('offline', { status: 503 });
  await withServer({ weatherFetch, klimaModels: '' }, async (base) => {
    const d = await (await fetch(`${base}/api/klima?lat=47.37&lon=8.55`)).json();
    assert.equal(d.climate, null);
    assert.match(d.climateError, /HTTP 503/);
    assert.equal(d.projection, null);
    assert.deepEqual(d.synthesis, []);
    const missing = await fetch(`${base}/api/klima?spot=999`);
    assert.equal(missing.status, 404);
  });
});

test('dossier API: observations of the spots in the region, per year and spot', async () => {
  const weatherFetch = async (url) => {
    const u = new URL(url);
    if (u.hostname === 'archive-api.open-meteo.com') {
      const q = u.searchParams;
      return Response.json({ daily: synthDaily(Number(q.get('start_date').slice(0, 4)), Number(q.get('end_date').slice(0, 4)), { dry: [2022] }) });
    }
    return new Response('offline', { status: 503 });
  };
  await withServer({ weatherFetch, klimaModels: '' }, async (base, dataDir) => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(dataDir, 'myforrest.db'));
    const spot = (lat, lon) => Number(db.prepare('INSERT INTO spots (lat, lon, created_at) VALUES (?, ?, 0)').run(lat, lon).lastInsertRowid);
    let n = 0;
    const photo = (spotId, iso, ctx) => db.prepare(`INSERT INTO photos (spot_id, file, taken_at, lat, lon, location_source, created_at, context_json)
      VALUES (?, ?, ?, 47.37, 8.55, 'exif', 0, ?)`).run(spotId, `f${++n}.jpg`, Date.parse(iso), JSON.stringify(ctx));
    const drought = { type: 'trockenheit', severity: 'auffaellig' };
    const storm = { date: '2022-02-17', gust: 118 };
    const a = spot(47.37, 8.55);
    const b = spot(47.38, 8.56);
    const far = spot(47.9, 9.4); // outside the radius
    photo(a, '2022-08-10T10:00:00Z', { irregularities: [drought, { type: 'waerme', severity: 'auffaellig' }], storms: [storm], stormLink: { windthrow: true, storm } });
    photo(a, '2022-08-20T10:00:00Z', { irregularities: [drought], storms: [storm] }); // same spot and year: counted once
    photo(b, '2022-07-01T10:00:00Z', { irregularities: [{ type: 'trockenheit', severity: 'hinweis' }] }); // a mere note does not count
    photo(b, '2023-06-01T10:00:00Z', { irregularities: [] });
    photo(far, '2022-08-01T10:00:00Z', { irregularities: [drought] });
    db.close();
    const d = await (await fetch(`${base}/api/klima?lat=47.37&lon=8.55&radius=5`)).json();
    assert.equal(d.spots, 2);
    assert.deepEqual(d.observations['2022'], {
      photos: 3, spots: 2, visited: 2, notes: { trockenheit: 1, waerme: 1 }, heatSpots: 1, neophytes: 0,
      storms: [{ date: '2022-02-17', gust: 118, windthrow: true }],
    });
    assert.equal(d.observations['2023'].visited, 1);
    const heat = d.synthesis.find((s) => s.title === 'Hitzesommer in den Fotos');
    assert.match(heat.text, /2022 \(Sommer .*0 % Regen\) zeigten die Fotos an 1 von 2 besuchten Spots/);
  });
});

test('homogeneous series from the STAC API of data.geo.admin.ch: stations file and the yearly file of each station', async () => {
  const STAC = 'https://data.geo.admin.ch/api/stac/v1/collections/ch.meteoschweiz.ogd-nbcn';
  const files = {
    'https://data.geo.admin.ch/ch.meteoschweiz.ogd-nbcn/ogd-nbcn_meta_stations.csv': NBCN_STATIONS,
    'https://data.geo.admin.ch/ch.meteoschweiz.ogd-nbcn/sma/ogd-nbcn_sma_y.csv': nbcnYearly('SMA', 8.4),
    'https://data.geo.admin.ch/ch.meteoschweiz.ogd-nbcn/sma/ogd-nbcn_sma_m.csv': 'not read',
  };
  const weatherFetch = async (url) => {
    if (url === STAC) return Response.json({ assets: { stations: { href: Object.keys(files)[0] } } });
    if (url === `${STAC}/items?limit=100`) {
      return Response.json({ features: [{ id: 'sma', assets: { y: { href: Object.keys(files)[1] }, m: { href: Object.keys(files)[2] } } }], links: [] });
    }
    if (files[url]) return new Response(files[url]);
    return new Response('offline', { status: 503 });
  };
  await withServer({ weatherFetch, klimaModels: '' }, async (base) => {
    const r = await fetch(`${base}/api/klima/sync`, { method: 'POST' });
    assert.deepEqual(await r.json(), { stations: 1, years: 162, files: 1 });
    const status = await (await fetch(`${base}/api/klima/status`)).json();
    assert.deepEqual([status.stations, status.stationYears], [1, 162]);
  });
});

/* ---------- Scenarios, forest, map ---------- */

test('warming levels: model change scaled with the global warming, CH2025 values where loaded, altitude shift', () => {
  const observed = klima.yearlyIndicators(synthDaily(1985, 2025, { perDecade: 0.4 }));
  const models = { A: klima.yearlyIndicators(synthDaily(1991, 2050, { perDecade: 0.44 })) };
  const p = klima.projectDelta(observed, models);
  const dT = p.indicators.find((i) => i.key === 'tmean').delta; // the model change 1991–2020 → 2031–2050, ≈ +2 °C globally
  const levels = klima.scenarioLevels(p);
  assert.deepEqual(levels.map((l) => l.level), ['GWL1.5', 'GWL2.0', 'GWL3.0']);
  const t = (l) => l.indicators.find((i) => i.key === 'tmean');
  assert.ok(Math.abs((t(levels[1]).value - t(levels[1]).normal) - dT) < 0.15, 'GWL2.0 is the model window');
  assert.ok(Math.abs((t(levels[0]).value - t(levels[0]).normal) - dT * (0.6 / 1.1)) < 0.15, 'GWL1.5 scaled by (1.5−0.9)/(2.0−0.9)');
  assert.equal(levels[2].shiftM, Math.round(((t(levels[2]).value - t(levels[2]).normal) / 0.55) * 10) * 10);
  assert.ok(levels.every((l) => l.source === 'Modelle' && l.when));
  // CH2025: +17 hot days at +3 °C replaces the scaled value; precipitation as % change.
  const ch = klima.scenarioLevels(p, { 'GWL3.0': [{ key: 'hotDays', value: 17, low: 10, high: 26 }, { key: 'summerP', value: -10, low: -20, high: 0 }] });
  const hot = ch[2].indicators.find((i) => i.key === 'hotDays');
  assert.deepEqual([hot.value - hot.normal, hot.source, ch[2].source], [17, 'CH2025', 'CH2025']);
  const sp = ch[2].indicators.find((i) => i.key === 'summerP');
  assert.equal(sp.value, Math.round(sp.normal * 0.9));
  assert.deepEqual(klima.scenarioLevels(null), []);
});

test('forest: belts move uphill, spruce and drought rated per level, the species of the place named', () => {
  const observed = klima.yearlyIndicators(synthDaily(1985, 2025, { perDecade: 0.4, dry: [2018] }));
  const models = { A: klima.yearlyIndicators(synthDaily(1991, 2050, { perDecade: 0.6 })) };
  const levels = klima.scenarioLevels(klima.projectDelta(observed, models));
  const { treeInfo } = require('../src/trees');
  const species = ['Picea abies', 'Fagus sylvatica', 'Quercus petraea'].map(treeInfo);
  const low = klima.forestImpacts({ elevation: 550, levels, species });
  assert.deepEqual(low.map((t) => t.key), ['hoehenstufen', 'fichte', 'trockenheit', 'winter', 'chancen']);
  const spruce = low.find((t) => t.key === 'fichte');
  assert.equal(spruce.title, 'Fichte und Borkenkäfer: hier betroffen');
  assert.equal(spruce.levels['GWL3.0'], 'hoch', 'spruce in the lowlands');
  assert.match(low.find((t) => t.key === 'trockenheit').text, /Trockenheitsempfindlich am Ort: Rotbuche\./);
  assert.match(low.find((t) => t.key === 'chancen').text, /Schon am Ort: Traubeneiche/);
  assert.match(low[0].text, /auf 550 m dem heutigen Klima auf rund \d+ m/);
  // Up high it is colder: a climate with a mean of 2 °C.
  const cold = klima.scenarioLevels(klima.projectDelta(klima.yearlyIndicators(synthDaily(1985, 2025, { base: 2 })), { A: klima.yearlyIndicators(synthDaily(1991, 2050, { base: 2, perDecade: 0.5 })) }));
  const high = klima.forestImpacts({ elevation: 1900, levels: cold, species: [] });
  assert.equal(high.find((t) => t.key === 'fichte').levels['GWL1.5'], 'gering', 'spruce at 1900 m with little warming');
  assert.equal(high.find((t) => t.key === 'fichte').title, 'Fichte und Borkenkäfer');
  assert.equal(klima.beetleGenerations(1114), 2);
  assert.deepEqual(klima.forestImpacts({ elevation: 500, levels: [] }), []);
});

test('climate map: cells of 0.1° computed in the background within the daily budget; official maps from WMS capabilities', async () => {
  const hosts = [];
  const weatherFetch = async (url) => {
    const u = new URL(url);
    hosts.push(u.hostname);
    const q = u.searchParams;
    if (u.pathname.includes('/elevation')) return Response.json({ elevation: [500 + Math.round(Number(q.get('latitude')) * 10) % 7 * 50] });
    if (u.hostname.endsWith('open-meteo.com')) {
      return Response.json({ daily: synthDaily(Number(q.get('start_date').slice(0, 4)), Number(q.get('end_date').slice(0, 4)), { perDecade: q.get('models') ? 0.5 : 0.4 }) });
    }
    return new Response('offline', { status: 503 });
  };
  const capabilities = `<?xml version="1.0"?><WMS_Capabilities><Capability><Layer><Title>geo.admin</Title>
    <Layer><Name>ch.meteoschweiz.klimanormwerte-temperatur_aktuelle_periode</Name><Title>Klimanormwerte Temperatur</Title></Layer>
    <Layer><Name>ch.bafu.wald-vegetationshoehenstufen_1975</Name><Title>Vegetationshöhenstufen 1975</Title></Layer>
    <Layer><Name>ch.swisstopo.pixelkarte-farbe</Name><Title>Landeskarte</Title></Layer>
  </Layer></Capability></WMS_Capabilities>`;
  // An ArcGIS service of Geneva: layers named 0, 1 …, the service title in front.
  const sitg = `<?xml version="1.0"?><WMS_Capabilities><Service><Title>SIPV_ICA_MNC_2023</Title></Service><Capability><Layer><Title>Layers</Title>
    <Layer><Name>0</Name><Title>Canopée 2023</Title></Layer></Layer></Capability></WMS_Capabilities>`;
  const wmsFetch = async (url) => {
    if (url.startsWith('https://sitg.example/')) return new Response(sitg);
    if (url.startsWith('https://down.example/')) return new Response('', { status: 500 });
    return url.includes('GetCapabilities') ? new Response(capabilities) : new Response('', { status: 404 });
  };
  const pending = [];
  await withServer({ weatherFetch, klimaModels: 'A,B,C,D', klimaOptions: { cellsPerDay: 3, mapModels: 2, wmsUrl: 'https://wms.example/', wmsFetch, wmsGenf: 'https://sitg.example/WMSServer,https://down.example/WMSServer' } }, async (base) => {
    assert.equal((await fetch(`${base}/api/klima/karte?bbox=1,2`)).status, 400);
    assert.equal((await (await fetch(`${base}/api/klima/karte?bbox=5,45,11,48`)).json()).tooLarge, true);
    let d = await (await fetch(`${base}/api/klima/karte?bbox=8.51,47.31,8.69,47.44`)).json();
    assert.deepEqual([d.cells.length, d.pending, d.cell], [0, 4, 0.1], '2 × 2 cells queued');
    for (let i = 0; i < 100 && d.cells.length < 3; i++) {
      await new Promise((r) => setTimeout(r, 50));
      d = await (await fetch(`${base}/api/klima/karte?bbox=8.51,47.31,8.69,47.44`)).json();
    }
    assert.equal(d.cells.length, 3, 'three cells a day');
    assert.equal(d.budgetLeft, 0);
    assert.equal(d.pending, 1);
    const c = d.cells[0];
    assert.ok([8.55, 8.65].includes(c.lon) && [47.35, 47.45].includes(c.lat));
    assert.ok(c.warming > 1 && c.levels['GWL2.0'].dT > 0 && c.levels['GWL3.0'].shiftM > c.levels['GWL1.5'].shiftM);
    assert.equal(hosts.filter((h) => h === 'climate-api.open-meteo.com').length, 2, 'two models for the map, on one 0.5° cell');
    const layers = await (await fetch(`${base}/api/klima/layers`)).json();
    assert.equal(layers.url, 'https://wms.example/');
    assert.deepEqual(layers.layers.map((l) => [l.group, l.title]), [
      ['Klima heute (MeteoSchweiz)', 'Klimanormwerte Temperatur'], ['Wald im Klimawandel (BAFU)', 'Vegetationshöhenstufen 1975'],
      ['Stadtklima und Bäume Genf (SITG)', 'SIPV_ICA_MNC_2023: Canopée 2023']]);
    const geneva = layers.layers[2];
    assert.deepEqual([geneva.url, geneva.name, geneva.attribution, geneva.bbox], ['https://sitg.example/WMSServer', '0', '© SITG / État de Genève', [5.95, 46.12, 6.32, 46.37]]);
    assert.deepEqual(layers.errors, ['down.example: HTTP 500'], 'a service that does not answer is left out');
  });
  await Promise.all(pending);
});

test('dossier API: scenarios and the meaning for the forest, with the trees of the spot', async () => {
  const weatherFetch = async (url) => {
    const u = new URL(url);
    const q = u.searchParams;
    if (u.hostname.endsWith('open-meteo.com') && q.get('start_date')) {
      return Response.json({ daily: synthDaily(Number(q.get('start_date').slice(0, 4)), Number(q.get('end_date').slice(0, 4)), { perDecade: 0.5 }) });
    }
    return new Response('offline', { status: 503 });
  };
  await withServer({ weatherFetch, klimaModels: 'A' }, async (base, dataDir) => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(dataDir, 'myforrest.db'));
    const id = Number(db.prepare('INSERT INTO spots (lat, lon, created_at, elevation) VALUES (47.37, 8.55, 0, 520)').run().lastInsertRowid);
    db.prepare(`INSERT INTO photos (spot_id, file, taken_at, lat, lon, location_source, created_at) VALUES (?, 'a.jpg', ?, 47.37, 8.55, 'exif', 0)`).run(id, Date.UTC(2024, 6, 1));
    db.prepare("INSERT INTO spot_species (spot_id, scientific_name, source, created_at) VALUES (?, 'Picea abies', 'manual', 0)").run(id);
    db.close();
    const d = await (await fetch(`${base}/api/klima?spot=${id}`)).json();
    assert.equal(d.centre.elevation, 520);
    assert.deepEqual(d.levels.map((l) => l.level), ['GWL1.5', 'GWL2.0', 'GWL3.0']);
    assert.deepEqual(d.species, [{ scientificName: 'Picea abies', name: 'Fichte', drought: 'hoch' }]);
    assert.equal(d.forest.find((t) => t.key === 'fichte').title, 'Fichte und Borkenkäfer: hier betroffen');
  });
});
