'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createWeather, doy } = require('../src/weather');
const { assess } = require('../src/irregularities');

const DAY = 86400000;

/** Fake Open-Meteo archive: 3 mm/day and 15 °C normally, `dryFrom` onwards no rain and 4 °C warmer. */
function fakeArchive({ dryFrom = Infinity } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const q = new URL(url).searchParams;
    const time = [];
    for (let t = Date.parse(`${q.get('start_date')}T00:00:00Z`); t <= Date.parse(`${q.get('end_date')}T00:00:00Z`); t += DAY) {
      time.push(new Date(t).toISOString().slice(0, 10));
    }
    const dry = (d) => Date.parse(`${d}T00:00:00Z`) >= dryFrom;
    return new Response(JSON.stringify({
      daily: {
        time,
        precipitation_sum: time.map((d) => (dry(d) ? 0 : 3)),
        temperature_2m_mean: time.map((d) => (dry(d) ? 19 : 15)),
        temperature_2m_max: time.map((d) => (dry(d) ? 31 : 21)),
      },
    }), { status: 200 });
  };
  return { fetchImpl, calls };
}

test('day of year ignores Feb 29 so years line up', () => {
  assert.equal(doy(Date.UTC(2023, 2, 1)), doy(Date.UTC(2024, 2, 1)));
  assert.equal(doy(Date.UTC(2024, 0, 1)), 0);
});

test('weather context compares the last 90 days with the 1991–2020 normal and caches it', async () => {
  const photo = Date.UTC(2026, 7, 12, 9, 30); // mid-morning: the window still spans 90 whole days
  const { fetchImpl, calls } = fakeArchive({ dryFrom: Date.UTC(2026, 5, 1) });
  const weather = createWeather({ db: new DatabaseSync(':memory:'), fetchImpl, now: () => Date.UTC(2026, 9, 7) });
  const ctx = await weather.context(47.36, 8.58, photo);
  assert.equal(ctx.last90.to, '2026-08-12');
  assert.equal(ctx.last90.days, 90);
  assert.ok(ctx.last90.precipRatio < 0.25, `ratio ${ctx.last90.precipRatio}`);
  assert.equal(ctx.last90.tempAnomaly, 3.2); // 73 warm days (+4 °C) and 17 normal ones in the window
  assert.ok(ctx.last90.longestDrySpell >= 70);
  assert.equal(ctx.monthly.length, 12);
  assert.ok(calls.some((u) => u.includes('start_date=1991-01-01')));

  await weather.context(47.36, 8.58, photo);
  assert.equal(calls.length, 2, 'second call is served from the cache');
});

test('early leaf colouring in a dry summer is linked to drought', () => {
  const weather = { last90: { precip: 60, precipNormal: 270, precipRatio: 0.22, tempMean: 19, tempNormal: 16.5, tempAnomaly: 2.5, hotDays: 18, hotDaysNormal: 4, longestDrySpell: 41 } };
  const change = { summary: [{ class: 'verfaerbung', area: 0.19 }] };
  const found = assess({ takenAt: Date.UTC(2026, 7, 12), change, weather });
  assert.deepEqual(found.map((i) => i.type), ['trockenheit', 'waerme', 'fruehe_verfaerbung']);
  const early = found.at(-1);
  assert.equal(early.severity, 'stark');
  assert.match(early.text, /Trockenstress/);
  assert.equal(early.suggestedTag, 'fruehverfaerbung');
});

test('colouring in October is normal autumn, and normal weather points to other causes', () => {
  const normal = { last90: { precip: 250, precipNormal: 260, precipRatio: 0.96, tempAnomaly: 0.3, hotDays: 2, hotDaysNormal: 3, longestDrySpell: 6 } };
  const change = { summary: [{ class: 'verfaerbung', area: 0.3 }] };
  assert.deepEqual(assess({ takenAt: Date.UTC(2026, 9, 10), change, weather: normal }), []);
  const summer = assess({ takenAt: Date.UTC(2026, 7, 30), tags: ['fruehverfaerbung'], weather: normal });
  assert.equal(summer.length, 1);
  assert.match(summer[0].text, /Borkenkäfer/);
});

const { TREES, treeInfo } = require('../src/trees');
const tree = (name) => TREES.find((t) => t.de === name);
const drought = { last90: { precip: 70, precipNormal: 280, precipRatio: 0.25, tempMean: 19, tempNormal: 16.6, tempAnomaly: 2.4, hotDays: 9, hotDaysNormal: 3, longestDrySpell: 30 } };

test('tree names resolve with authors and subspecies', () => {
  assert.equal(treeInfo('Fagus sylvatica L.').de, 'Rotbuche');
  assert.equal(treeInfo('Picea abies (L.) H.Karst.').de, 'Fichte');
  assert.equal(treeInfo('Bellis perennis'), null);
});

test('species set the expected start of colouring', () => {
  const change = { summary: [{ class: 'verfaerbung', area: 0.1 }] };
  const sept5 = Date.UTC(2026, 8, 5);
  // Birch colours from mid-September: 5 Sept is early. Oak only from mid-October.
  const birch = assess({ takenAt: Date.UTC(2026, 8, 20), change, species: [tree('Hängebirke')] });
  assert.ok(!birch.some((i) => i.type === 'fruehe_verfaerbung'), 'birch on 20 Sept is on time');
  const oak = assess({ takenAt: Date.UTC(2026, 8, 20), change, species: [tree('Stieleiche')] });
  const early = oak.find((i) => i.type === 'fruehe_verfaerbung');
  assert.ok(early, 'oak colouring on 20 Sept is early');
  assert.match(early.text, /Stieleiche/);
  assert.ok(assess({ takenAt: sept5, change, species: [tree('Hängebirke')] }).some((i) => i.type === 'fruehe_verfaerbung'));
});

test('discolouring spruce stand and drought raise bark beetle warnings', () => {
  const change = { summary: [{ class: 'verfaerbung', area: 0.12 }] };
  const found = assess({ takenAt: Date.UTC(2026, 6, 20), change, weather: drought, species: [tree('Fichte')] });
  const types = found.map((i) => i.type);
  assert.ok(types.includes('borkenkaefer_risiko'));
  const needles = found.find((i) => i.type === 'nadelverfaerbung');
  assert.equal(needles.severity, 'stark');
  assert.equal(needles.suggestedTag, 'borkenkaefer');
  assert.ok(!types.includes('fruehe_verfaerbung'), 'conifers have no autumn colouring to be early');
  assert.match(found.find((i) => i.type === 'trockenheit').text, /Fichte/);

  const mixed = assess({ takenAt: Date.UTC(2026, 6, 20), change, species: [tree('Fichte'), tree('Rotbuche')] });
  assert.equal(mixed.find((i) => i.type === 'nadelverfaerbung').severity, 'hinweis');
  assert.ok(mixed.some((i) => i.type === 'fruehe_verfaerbung'));
});

test('ash at a spot with canopy loss hints at ash dieback', () => {
  const change = { summary: [{ class: 'auflichtung', area: 0.08 }] };
  const found = assess({ takenAt: Date.UTC(2026, 6, 1), change, species: [tree('Gemeine Esche')] });
  assert.deepEqual(found.map((i) => i.type), ['eschentriebsterben']);
});
