'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  createStorms, detectStorms, likelyStorm, stormText, stormIrregularities, beaufort, compass16,
} = require('../src/storms');
const { nightsFromHourly, estimateNights, frostSummary, hourPotential } = require('../src/nightcool');
const {
  createPhenoRef, parseDwdStations, parseDwdObservations, parseDwdPhases, parseDwdPlants, speciesFromFileName, decodeText,
} = require('../src/phenoref');
const { assess } = require('../src/irregularities');
const { TREES } = require('../src/trees');

const DAY = 86400000;
const tree = (name) => TREES.find((t) => t.de === name);
const dwd = (name) => decodeText(fs.readFileSync(path.join(__dirname, 'fixtures', 'dwd', name)));

/* ---------- Storms ---------- */

test('gust classes follow the Beaufort-based DWD warning scale, directions in 16 German points', () => {
  assert.deepEqual(beaufort(74), { bft: 8, label: 'stürmische Böen' });
  assert.deepEqual(beaufort(75), { bft: 9, label: 'Sturmböen' });
  assert.deepEqual(beaufort(104), { bft: 11, label: 'orkanartige Böen' });
  assert.deepEqual(beaufort(130), { bft: 12, label: 'Orkanböen' });
  assert.equal(compass16(250), 'WSW');
  assert.equal(compass16(0), 'N');
  assert.equal(compass16(359), 'N');
  assert.equal(compass16(70), 'ONO');
});

test('storm days merge into events, and windthrow is linked to the strongest storm in the interval', () => {
  const days = [
    { date: '2026-01-20', gust: 70, dir: 200 },
    { date: '2026-03-12', gust: 104.3, dir: 250 },
    { date: '2026-03-13', gust: 81, dir: 265 },
    { date: '2026-04-02', gust: 77, dir: 300 },
  ];
  const events = detectStorms(days);
  assert.equal(events.length, 2, 'below 75 km/h is no storm; 12/13 March is one event');
  assert.deepEqual(
    { ...events[0] },
    { date: '2026-03-12', from: '2026-03-12', to: '2026-03-13', days: 2, gust: 104, dir: 250, from16: 'WSW', bft: 11, class: 'orkanartige Böen' },
  );
  assert.equal(stormText(events[0]), 'Sturm am 12.03.2026, Böen 104 km/h aus WSW');
  assert.equal(likelyStorm(events, Date.UTC(2026, 2, 20), Date.UTC(2026, 5, 1)).date, '2026-04-02');
  assert.equal(likelyStorm(events, Date.UTC(2026, 1, 1), Date.UTC(2026, 5, 1)).date, '2026-03-12');
  assert.equal(likelyStorm(events, Date.UTC(2026, 4, 1), Date.UTC(2026, 5, 1)), null);

  const interval = { from: '2026-02-01T10:00:00Z', to: '2026-05-20T10:00:00Z' };
  const [linked] = stormIrregularities({ events, interval, windthrow: true, landform: 'kuppe' });
  assert.equal(linked.type, 'sturm_windwurf');
  assert.equal(linked.severity, 'stark');
  assert.equal(linked.suggestedTag, 'sturmschaden');
  assert.match(linked.text, /2 Sturmereignisse/);
  assert.match(linked.text, /Vermutlich Sturm am 12\.03\.2026, Böen 104 km\/h aus WSW \(orkanartige Böen, Beaufort 11\)/);
  assert.match(linked.text, /Richtung ONO/, 'trees fall downwind');
  assert.match(linked.text, /Kuppenlage/);

  const [plain] = stormIrregularities({ events, interval: { from: '2026-03-20T00:00:00Z', to: '2026-05-01T00:00:00Z' } });
  assert.deepEqual([plain.type, plain.severity, plain.title], ['sturm', 'hinweis', 'Sturm vor der Aufnahme']);
  const [none] = stormIrregularities({ events, interval: { from: '2026-04-10T00:00:00Z', to: '2026-05-01T00:00:00Z' }, windthrow: true });
  assert.equal(none.type, 'windwurf_ohne_sturm');
  assert.deepEqual(stormIrregularities({ events, interval: null, windthrow: true }), []);
});

/** Fake Open-Meteo for daily gusts: archive and forecast as asked. */
function gustFetch(gusts) {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const q = new URL(url).searchParams;
    const time = [];
    for (let t = Date.parse(`${q.get('start_date')}T00:00:00Z`); t <= Date.parse(`${q.get('end_date')}T00:00:00Z`); t += DAY) {
      time.push(new Date(t).toISOString().slice(0, 10));
    }
    return new Response(JSON.stringify({ daily: {
      time,
      wind_gusts_10m_max: time.map((d) => gusts[d]?.[0] ?? 30),
      wind_speed_10m_max: time.map((d) => (gusts[d] ? 50 : 15)),
      wind_direction_10m_dominant: time.map((d) => gusts[d]?.[1] ?? 180),
    } }));
  };
  return { fetchImpl, urls };
}

test('storm data: archive plus forecast for the last days, cached per cell and year', async () => {
  const { fetchImpl, urls } = gustFetch({ '2026-02-10': [96, 240], '2026-03-13': [88, 300] });
  let now = Date.UTC(2026, 2, 15, 12);
  const storms = createStorms({ db: new DatabaseSync(':memory:'), fetchImpl, now: () => now });
  const events = await storms.between(47.36, 8.58, Date.UTC(2026, 0, 1), now);
  assert.deepEqual(events.map((e) => [e.date, e.gust, e.from16]), [['2026-02-10', 96, 'WSW'], ['2026-03-13', 88, 'WNW']]);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /archive-api.*start_date=2026-01-01&end_date=2026-03-09.*wind_gusts_10m_max/);
  assert.match(urls[1], /api\.open-meteo\.com\/v1\/forecast.*start_date=2026-03-10&end_date=2026-03-15/);
  await storms.between(47.36, 8.58, Date.UTC(2026, 1, 1), now);
  assert.equal(urls.length, 2, 'served from the cache');
  assert.equal(storms.cachedBetween(47.36, 8.58, Date.UTC(2026, 2, 1), now).length, 1);
  assert.equal(storms.cachedBetween(47.36, 8.58, Date.UTC(2025, 2, 1), now), null, '2025 not loaded yet');
  now += 7 * 3600000; // the current year is refreshed after a few hours
  await storms.between(47.36, 8.58, Date.UTC(2026, 1, 1), now);
  assert.equal(urls.length, 4);
});

/* ---------- Nocturnal cooling ---------- */

/** Local hourly rows for nights; `calm` mornings are windless and clear. */
function hourlyRows(from, to, { calm = [], tmin = {} }) {
  const rows = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T23:00:00Z`); t += 3600000) {
    const iso = new Date(t).toISOString();
    const hour = new Date(t).getUTCHours();
    const morning = hour >= 18 ? new Date(t + DAY).toISOString().slice(0, 10) : iso.slice(0, 10);
    const still = calm.includes(morning);
    const low = tmin[morning] ?? 4;
    rows.push({
      time: iso.slice(0, 16),
      temp: hour === 5 ? low : low + 6,
      wind: still ? 0.6 : 6,
      cloud: still ? 5 : 90,
    });
  }
  return rows;
}

test('calm, clear nights cool hollows far below the model minimum', () => {
  assert.equal(hourPotential(0.5, 0), 1);
  assert.equal(hourPotential(6, 0), 0);
  assert.equal(hourPotential(1, 95), 0);
  assert.equal(hourPotential(3.25, 50), 0.25);

  const rows = hourlyRows('2026-05-01', '2026-05-07', { calm: ['2026-05-05'], tmin: { '2026-05-05': 2, '2026-05-03': 1.5 } });
  const nights = nightsFromHourly(rows);
  assert.deepEqual(nights.map((n) => n.date), ['2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05', '2026-05-06', '2026-05-07']);
  const may5 = nights.find((n) => n.date === '2026-05-05');
  assert.deepEqual(may5, { date: '2026-05-05', tmin: 2, wind: 0.6, cloud: 5, potential: 1 });

  const deep = estimateNights(nights, { landform: 'senke', tpi600: -40 });
  assert.deepEqual([deep[3].deficit, deep[3].est], [7, -5]);
  assert.equal(deep[1].est, 1.5, 'windy, overcast night: no extra cooling');
  assert.deepEqual(estimateNights(nights, { landform: 'hang' })[3].est, 2, 'slopes drain the cold air');

  const summary = frostSummary(nights, { landform: 'senke' }, Date.UTC(2026, 4, 20));
  assert.equal(summary.strength, 0.7);
  assert.deepEqual(summary.frostNights.map((n) => [n.date, n.est]), [['2026-05-05', -2.9]]);
  assert.equal(summary.hardFrost, 1);
  assert.equal(frostSummary(nights, { landform: 'senke' }, Date.UTC(2026, 4, 4)).frostNights.length, 0, 'only nights before the photo');
});

test('the late-frost rule uses the estimated hollow minimum instead of the 3 °C model rule', () => {
  const normal = { precip: 250, precipNormal: 260, precipRatio: 0.96, tempAnomaly: 0, hotDays: 0, hotDaysNormal: 0, longestDrySpell: 5 };
  const spring = { last90: normal, yearToDate: { ...normal, coldNightsAfterLeafOut: 4, coldestAfterLeafOut: { date: '2026-05-03', tmin: 1.5 } } };
  const browned = { summary: [{ class: 'verfaerbung', area: 0.08 }] };
  const args = { takenAt: Date.UTC(2026, 4, 20), change: browned, weather: spring, species: [tree('Rotbuche')], landform: 'senke' };

  const nightFrost = {
    frostNights: [{ date: '2026-05-05', tmin: 2, est: -2.9, wind: 0.6, cloud: 5, potential: 1 }],
  };
  const frost = assess({ ...args, nightFrost }).find((i) => i.type === 'spaetfrost');
  assert.equal(frost.severity, 'auffällig');
  assert.match(frost.text, /eine Nacht so windstill und klar/);
  assert.match(frost.text, /kälteste: −2\.9 °C in der Nacht auf den 05\.05\.2026; Wettermodell 2\.0 °C, Wind 0\.6 m\/s, 5 % Bewölkung/);

  // Four model nights under 3 °C, but all windy or overcast: no frost in the hollow.
  const windy = assess({ ...args, nightFrost: { frostNights: [] } });
  assert.ok(!windy.some((i) => i.type === 'spaetfrost'));
  assert.ok(windy.some((i) => i.type === 'fruehe_verfaerbung'), 'without frost the browning stays unexplained');
  // Without hourly data the old rule applies.
  assert.match(assess(args).find((i) => i.type === 'spaetfrost').text, /4 Nächte unter 3 °C/);
});

/* ---------- Phenology reference series ---------- */

test('DWD phenology files parse by header names, Latin-1 and padded', () => {
  const stations = parseDwdStations(dwd('PH_Beschreibung_Phaenologie_Stationen_Jahresmelder.txt'));
  assert.equal(stations.length, 5);
  assert.deepEqual(stations[0], { id: '101', name: 'Freiburg-Süd', lat: 47.98, lon: 7.84, elevation: 280 });
  assert.deepEqual([...parseDwdPhases(dwd('PH_Beschreibung_Phase.txt'))], [31]);
  const plants = parseDwdPlants(dwd('PH_Beschreibung_Pflanze.txt'));
  assert.deepEqual([...plants], [[310, 'Fagus sylvatica'], [132, 'Quercus robur']]);
  assert.equal(speciesFromFileName('PH_Jahresmelder_Wildwachsende_Pflanze_Rotbuche_1925_2024_hist.txt'), 'Fagus sylvatica');
  assert.equal(speciesFromFileName('PH_Jahresmelder_Wildwachsende_Pflanze_Stiel-Eiche_akt.txt'), 'Quercus robur');
  const obs = parseDwdObservations(dwd('PH_Jahresmelder_Wildwachsende_Pflanze_Rotbuche_akt.txt'), { plants });
  assert.ok(obs.every((o) => o.species === 'Fagus sylvatica'));
  assert.ok(!obs.some((o) => o.doy === 110), 'leaf unfolding (phase 4) is skipped');
  assert.deepEqual(obs.find((o) => o.station === '103' && o.year === 2019), { station: '103', species: 'Fagus sylvatica', year: 2019, doy: 268 },
    'day of year from the date when Jultag is missing');
});

function loadedRef(now = Date.UTC(2026, 9, 7)) {
  const ref = createPhenoRef({ db: new DatabaseSync(':memory:'), now: () => now });
  ref.importDwd({
    stations: dwd('PH_Beschreibung_Phaenologie_Stationen_Jahresmelder.txt'),
    plants: dwd('PH_Beschreibung_Pflanze.txt'),
    phases: dwd('PH_Beschreibung_Phase.txt'),
    files: [{ name: 'PH_Jahresmelder_Wildwachsende_Pflanze_Rotbuche_akt.txt', text: dwd('PH_Jahresmelder_Wildwachsende_Pflanze_Rotbuche_akt.txt') }],
  });
  return ref;
}

test('nearby stations give an altitude-adjusted reference for the start of colouring', () => {
  const ref = loadedRef();
  const r = ref.reference('Fagus sylvatica', { lat: 47.95, lon: 7.95, elevation: 700 });
  // Hinterzarten (880 m, 268) is closest once altitude counts; Stuttgart is too far, Kirchzarten has too few years.
  assert.deepEqual(r.stations.map((s) => [s.name, s.meanDoy, s.altitudeAdjust]),
    [['Hinterzarten', 268, 5], ['Schauinsland', 262, 8], ['Freiburg-Süd', 280, -10]]);
  assert.equal(r.stations[0].years, 9, 'the 2020 misreport is dropped');
  assert.ok(r.doy >= 270 && r.doy <= 272, `doy ${r.doy}`);
  assert.deepEqual(r.period, [2016, 2025]);
  assert.match(r.label, /^Referenz: DWD-Station Hinterzarten, 12 km, 880 m, Mittel 2016–2025 \(\+2 weitere\)$/);
  assert.equal(ref.reference('Quercus robur', { lat: 47.95, lon: 7.95, elevation: 700 }), null, 'no oak series loaded');
  assert.equal(ref.reference('Fagus sylvatica', { lat: 52.5, lon: 13.4, elevation: 40 }), null, 'Berlin: no station nearby');
  assert.equal(ref.status().observations, 16 * 4 + 3);
});

test('reference series replace the flat gradient in the early-colouring rule', () => {
  const ref = loadedRef();
  const r = ref.reference('Fagus sylvatica', { lat: 47.95, lon: 7.95, elevation: 700 });
  const change = { summary: [{ class: 'verfaerbung', area: 0.1 }] };
  const beech = [tree('Rotbuche')];
  // Gradient: 272 − 7.5 → ~22 Sept at 700 m. Reference: ~28 Sept. 25 Sept is early only with the reference.
  const sept25 = Date.UTC(2026, 8, 25);
  assert.ok(!assess({ takenAt: sept25, change, species: beech, elevation: 700 }).some((i) => i.type === 'fruehe_verfaerbung'));
  const early = assess({ takenAt: sept25, change, species: beech, elevation: 700, phenoRef: { 'Fagus sylvatica': r } })
    .find((i) => i.type === 'fruehe_verfaerbung');
  assert.ok(early);
  assert.match(early.text, /Bei Rotbuche beginnt die Herbstfärbung auf 700 m ü\. M\. typischerweise um den \d\d\.\d\d\. \(Referenz: DWD-Station Hinterzarten/);
});

test('generic CSV import (e.g. converted MeteoSchweiz data)', () => {
  const ref = createPhenoRef({ db: new DatabaseSync(':memory:'), now: () => Date.UTC(2026, 9, 7) });
  const rows = ['source,station_id,station_name,lat,lon,elevation,species,year,doy'];
  for (let y = 2016; y <= 2025; y++) rows.push(`meteoschweiz,SMA,Zürich-Fluntern,47.378,8.566,556,Fagus sylvatica,${y},${y % 2 ? 280 : 282}`);
  assert.deepEqual(ref.importGeneric(rows.join('\n')), { stations: 1, observations: 10 });
  const r = ref.reference('Fagus sylvatica', { lat: 47.36, lon: 8.58, elevation: 556 });
  assert.equal(r.doy, 281);
  assert.equal(r.label, 'Referenz: MeteoSchweiz-Station Zürich-Fluntern, 2 km, 556 m, Mittel 2016–2025');
});

/* ---------- Through the API ---------- */

/** Open-Meteo stand-in for daily weather, gusts and hourly nights. */
function fakeOpenMeteo() {
  return async (url) => {
    if (url.includes('/v1/elevation')) return new Response('offline', { status: 503 });
    const q = new URL(url).searchParams;
    const start = Date.parse(`${q.get('start_date')}T00:00:00Z`);
    const end = Date.parse(`${q.get('end_date')}T00:00:00Z`);
    const days = [];
    for (let t = start; t <= end; t += DAY) days.push(new Date(t).toISOString().slice(0, 10));
    if (q.get('hourly')) {
      const rows = hourlyRows(days[0], days.at(-1), { calm: ['2026-05-05'], tmin: { '2026-05-05': 2, '2026-05-03': 1.5 } });
      return new Response(JSON.stringify({ utc_offset_seconds: 7200, hourly: {
        time: rows.map((r) => r.time),
        temperature_2m: rows.map((r) => r.temp),
        wind_speed_10m: rows.map((r) => r.wind),
        cloud_cover: rows.map((r) => r.cloud),
      } }));
    }
    if (q.get('daily').includes('wind_gusts')) {
      const gusts = { '2026-03-12': [104, 250], '2026-03-13': [81, 265] };
      return new Response(JSON.stringify({ daily: {
        time: days,
        wind_gusts_10m_max: days.map((d) => gusts[d]?.[0] ?? 35),
        wind_speed_10m_max: days.map(() => 20),
        wind_direction_10m_dominant: days.map((d) => gusts[d]?.[1] ?? 200),
      } }));
    }
    return new Response(JSON.stringify({ daily: {
      time: days,
      precipitation_sum: days.map(() => 3),
      temperature_2m_mean: days.map(() => 15),
      temperature_2m_max: days.map(() => 21),
      temperature_2m_min: days.map(() => 8),
    } }));
  };
}

test('API: storms linked to windthrow, frost nights in a hollow, reference series per spot', async () => {
  const { createApp } = require('../src/app');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-climate-'));
  const app = createApp({ dataDir, weatherFetch: fakeOpenMeteo() });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = async (url, opts) => (await fetch(base + url, opts)).json();
  const jpeg = () => new Blob([fs.readFileSync(path.join(__dirname, 'fixtures', 'canopy-a.jpg'))], { type: 'image/jpeg' });
  const upload = async (fields) => {
    const fd = new FormData();
    fd.append('photos', jpeg(), 'x.jpg');
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    return (await (await fetch(`${base}/api/photos`, { method: 'POST', body: fd })).json()).created[0];
  };
  try {
    const a = await upload({ lat: '47.36', lon: '8.58', takenAt: '2026-02-01T10:00:00Z' });
    const b = await upload({ spotId: String(a.spotId), takenAt: '2026-05-20T10:00:00Z', tags: 'sturmschaden' });
    await fetch(`${base}/api/spots/${a.spotId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ landform: 'senke' }),
    });
    await app.locals.idle();

    const ctx = await json(`/api/photos/${b.id}/context`);
    const storm = ctx.irregularities.find((i) => i.type === 'sturm_windwurf');
    assert.ok(storm, ctx.irregularities.map((i) => i.type).join());
    assert.match(storm.text, /Vermutlich Sturm am 12\.03\.2026, Böen 104 km\/h aus WSW/);
    assert.equal(ctx.stormLink.text, 'vermutlich Sturm am 12.03.2026, Böen 104 km/h aus WSW');
    const frost = ctx.irregularities.find((i) => i.type === 'spaetfrost');
    assert.match(frost.text, /−2\.9 °C in der Nacht auf den 05\.05\.2026/);
    assert.deepEqual(ctx.nightFrost.frostNights.map((n) => n.date), ['2026-05-05']);
    const first = await json(`/api/photos/${a.id}/context`);
    assert.ok(!first.irregularities.some((i) => i.type.startsWith('sturm')), 'no storm before the first photo');

    const spotStorms = await json(`/api/spots/${a.spotId}/storms`);
    assert.deepEqual(spotStorms.events.map((e) => [e.date, e.windthrowPhotos]), [['2026-03-12', [b.id]]]);
    const between = await json(`/api/photos/${a.id}/storm?to=${b.id}`);
    assert.equal(between.storm.gust, 104);

    let badges = await json('/api/storms/spots');
    await app.locals.idle();
    badges = await json('/api/storms/spots');
    assert.deepEqual(badges.map((s) => [s.spotId, s.count, s.max.text]), [[a.spotId, 1, 'Sturm am 12.03.2026, Böen 104 km/h aus WSW']]);

    // Reference series: a nearby station makes the source visible on the species.
    await fetch(`${base}/api/spots/${a.spotId}/species`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scientificName: 'Fagus sylvatica' }),
    });
    const year = new Date().getUTCFullYear();
    const rows = ['source;station_id;station_name;lat;lon;elevation;species;year;doy'];
    for (let y = year - 10; y < year; y++) rows.push(`meteoschweiz;SMA;Zürich-Fluntern;47.378;8.566;556;Fagus sylvatica;${y};275`);
    const imported = await json('/api/phenoref/import?format=generic', { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: rows.join('\n') });
    assert.equal(imported.observations, 10);
    const spot = await json(`/api/spots/${a.spotId}`);
    assert.equal(spot.species[0].colourDoyHere, 275 - 4, 'reference plus the hollow’s cold-air shift');
    assert.match(spot.species[0].colourRef, /^Referenz: MeteoSchweiz-Station Zürich-Fluntern, 2 km, 556 m, Mittel/);
    const refs = await json(`/api/spots/${a.spotId}/phenoref`);
    assert.equal(refs[0].species, 'Fagus sylvatica');
    assert.equal((await json('/api/phenoref')).stations, 1);
    assert.equal((await fetch(`${base}/api/phenoref/import`, { method: 'POST', body: 'x' })).status, 400);
  } finally {
    await app.locals.idle();
    server.close();
    app.locals.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
