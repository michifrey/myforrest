'use strict';

// Leaf-out reference (DWD, MeteoSchweiz) and late frost only after the region's leaf-out.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createPhenoRef, parseMeteoSchweiz, doyOfDate } = require('../src/phenoref');
const { assess } = require('../src/irregularities');
const { createApp } = require('../src/app');

// MeteoSchweiz OGD files as described (semicolon CSV, Latin-1 or UTF-8).
const STATIONS = [
  'station_abbr;station_name;station_coordinates_wgs84_lat;station_coordinates_wgs84_lon;station_height_masl',
  'ZUE;Zürich-Fluntern;47.378;8.566;556',
  'EIN;Einsiedeln;47.13;8.75;910',
].join('\n');
const PARAMETERS = [
  'parameter_shortname;parameter_description_de;parameter_description_fr',
  'fagsyl_lu;Buche: Blattentfaltung;Hêtre: déploiement des feuilles',
  'fagsyl_lc;Buche: Blattverfärbung;Hêtre: coloration des feuilles',
  'carbet_lu;Hainbuche: Blattentfaltung;Charme: déploiement des feuilles',
  'corave_fl;Hasel: Blüte;Noisetier: floraison',
].join('\n');
function data() {
  const rows = ['station_abbr;reference_year;param_id;value'];
  for (let y = 2016; y <= 2025; y++) {
    rows.push(`ZUE;${y};fagsyl_lu;${110 + (y % 3)}`); // ~21 April
    rows.push(`ZUE;${y};fagsyl_lc;${280 + (y % 2)}`);
    rows.push(`ZUE;${y};carbet_lu;105`);
    rows.push(`ZUE;${y};corave_fl;40`); // not a phase used here
  }
  rows.push('ZUE;2026;fagsyl_lu;20260428'); // this year, as a date
  rows.push('EIN;2026;fagsyl_lu;01.05.2026');
  rows.push('ZUE;2026;fagsyl_lu;20'); // implausible: dropped
  return rows.join('\n');
}

test('MeteoSchweiz phenology files: species and phase from the German parameter description', () => {
  const { stations, observations } = parseMeteoSchweiz({ stations: STATIONS, parameters: PARAMETERS, data: [data()] });
  assert.deepEqual(stations[0], { source: 'meteoschweiz', id: 'ZUE', name: 'Zürich-Fluntern', lat: 47.378, lon: 8.566, elevation: 556 });
  const kinds = (sci, phase) => observations.filter((o) => o.species === sci && o.phase === phase).length;
  assert.equal(kinds('Fagus sylvatica', 'leafout'), 12);
  assert.equal(kinds('Fagus sylvatica', 'colour'), 10);
  assert.equal(kinds('Carpinus betulus', 'leafout'), 10, 'Hainbuche, not Buche');
  assert.equal(observations.length, 32, 'flowering of hazel is not used');
  assert.deepEqual(observations.filter((o) => o.year === 2026).map((o) => [o.station, o.doy]), [['ZUE', 118], ['EIN', 121]]);
  assert.equal(doyOfDate('2024-03-01'), 61);
});

test('leaf-out: this year once reported nearby, else the ten-year mean, later uphill', () => {
  const ref = createPhenoRef({ db: new DatabaseSync(':memory:'), now: () => Date.UTC(2026, 5, 1) });
  const r = ref.importMeteoSchweiz({ stations: STATIONS, parameters: PARAMETERS, data: [data()] });
  assert.deepEqual([r.observations, r.leafout], [10, 22]);
  const place = { lat: 47.36, lon: 8.58, elevation: 756 }; // 200 m above Fluntern
  const mean = ref.reference('Fagus sylvatica', place, { phase: 'leafout' });
  assert.equal(mean.doy, 111 + 6, 'mean ~111, +3 days per 100 m');
  assert.match(mean.label, /^Referenz: MeteoSchweiz-Station Zürich-Fluntern, 2 km, 556 m, Mittel 2016–2025/);
  const now = ref.leafOut(['Fagus sylvatica'], place, 2026);
  assert.equal(now.year, 2026);
  // Fluntern 118 (+6 for 200 m higher) and Einsiedeln 121 (−5 for 154 m lower, farther away, less weight).
  assert.equal(now.doy, 122);
  assert.equal(now.stations.length, 2);
  assert.match(now.label, /^Beobachtet 2026: MeteoSchweiz-Station Zürich-Fluntern/);
  // A year without reports: the mean.
  assert.equal(ref.leafOut(['Fagus sylvatica'], place, 2027).year, null);
  // Colouring is unchanged: earlier uphill.
  assert.equal(ref.reference('Fagus sylvatica', place).doy, 281 - 5);
  assert.equal(ref.status().leafout, 22);
});

test('late frost in a hollow counts only after the leaves are out', () => {
  const nightFrost = {
    strength: 1, nights: 40, calmClear: 10, hardFrost: 0,
    frostNights: [
      { date: '2026-04-18', tmin: 2.1, est: -2.5, wind: 0.4, cloud: 5, potential: 0.9 },
      { date: '2026-04-22', tmin: 2.4, est: -1.2, wind: 0.6, cloud: 10, potential: 0.8 },
    ],
    coldest: null,
  };
  const at = Date.UTC(2026, 4, 10);
  const leafOutLate = { doy: 118, year: 2026, label: 'Beobachtet 2026: MeteoSchweiz-Station Zürich-Fluntern, 2 km, 556 m' };
  // Leaves out on 28 April: both frost nights came before, no frost risk.
  assert.ok(!assess({ takenAt: at, landform: 'senke', tpi600: -40, nightFrost, leafOut: leafOutLate }).some((i) => i.type === 'spaetfrost'));
  // Leaves out on 20 April: the night of 22 April counts.
  const early = assess({ takenAt: at, landform: 'senke', tpi600: -40, nightFrost, leafOut: { ...leafOutLate, doy: 110 } }).find((i) => i.type === 'spaetfrost');
  assert.ok(early);
  assert.match(early.text, /Das Laub treibt hier um den 2\d\.04\. aus \(Beobachtet 2026: MeteoSchweiz-Station/);
  assert.match(early.text, /war eine Nacht so windstill und klar/);
  // Without a reference: the fixed mid-April date, both nights.
  const fixed = assess({ takenAt: at, landform: 'senke', tpi600: -40, nightFrost }).find((i) => i.type === 'spaetfrost');
  assert.match(fixed.text, /waren 2 Nächte/);
});

test('MeteoSchweiz import through the API (admin), descriptions first', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-pheno-'));
  const app = createApp({ dataDir, routerUrl: '', stormWarnHours: 0, weatherFetch: async () => new Response('', { status: 503 }) });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (q, body) => fetch(`${base}/api/phenoref/import?${q}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body }).then((r) => r.json());
  try {
    assert.deepEqual(await post('format=meteoschweiz&kind=parameters', PARAMETERS), { stored: 'parameters' });
    assert.equal((await post('format=meteoschweiz&kind=stations', STATIONS)).stations, 2);
    const r = await post('format=meteoschweiz&kind=observations', data());
    assert.deepEqual([r.observations, r.leafout], [10, 22]);
    const fd = new FormData();
    fd.append('photos', new Blob([fs.readFileSync(path.join(__dirname, 'fixtures', 'nogps.jpg'))], { type: 'image/jpeg' }), 'foto.jpg');
    fd.append('lat', '47.36'); fd.append('lon', '8.58');
    const up = await (await fetch(`${base}/api/photos`, { method: 'POST', body: fd })).json();
    const lo = await (await fetch(`${base}/api/spots/${up.created[0].spotId}/leafout?year=2025`)).json();
    assert.deepEqual([lo.species, lo.year, lo.phase], ['Fagus sylvatica', 2025, 'leafout'], 'beech without trees at the spot');
    const status = await (await fetch(`${base}/api/phenoref`)).json();
    assert.equal(status.leafout, 22);
    assert.ok(status.imported.meteoschweiz);
  } finally {
    await app.locals.idle();
    server.close();
    app.locals.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
