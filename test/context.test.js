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
        temperature_2m_min: time.map((d) => (d === '2026-05-04' ? 1.2 : d === '2026-05-05' ? 2.4 : 9)),
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
  assert.equal(ctx.last90.coldNightsAfterLeafOut, 0, 'early May is outside the 90 days before 12 Aug');
  assert.equal(ctx.yearToDate.coldNightsAfterLeafOut, 2);
  assert.deepEqual(ctx.yearToDate.coldestAfterLeafOut, { date: '2026-05-04', tmin: 1.2 });
  assert.equal(ctx.yearToDate.frostNights, 0);
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

const { altitudeShift, expectedColourDoy } = require('../src/phenology');

test('autumn colouring starts ~2.5 days earlier per 100 m above the lowlands', () => {
  assert.equal(altitudeShift(400), 0);
  assert.equal(altitudeShift(1000), -15);
  assert.equal(altitudeShift(3000), -35, 'capped');
  assert.equal(altitudeShift(0), 7, 'lowlands below the reference: slightly later, capped');
  assert.equal(altitudeShift(null), 0);
  assert.equal(expectedColourDoy(272, 1000), 257);
  assert.equal(expectedColourDoy(null, 1000), null);
});

test('colouring that is early in the lowlands can be on time in the mountains', () => {
  const change = { summary: [{ class: 'verfaerbung', area: 0.1 }] };
  const sept18 = Date.UTC(2026, 8, 18);
  const beech = [tree('Rotbuche')]; // lowland start ~30 Sept
  assert.ok(assess({ takenAt: sept18, change, species: beech, elevation: 420 }).some((i) => i.type === 'fruehe_verfaerbung'));
  assert.ok(!assess({ takenAt: sept18, change, species: beech, elevation: 1100 }).some((i) => i.type === 'fruehe_verfaerbung'),
    'at 1100 m beech starts ~12 Sept');
  const aug25 = assess({ takenAt: Date.UTC(2026, 7, 25), change, species: beech, elevation: 1100 });
  const early = aug25.find((i) => i.type === 'fruehe_verfaerbung');
  assert.match(early.text, /1100 m ü\. M\. \(17 Tage früher als im Flachland\) typischerweise um den 13\.09\. /);
});

const { slopeAspect } = require('../src/elevation');
const { aspectShift, terrainShift, aspectLabel } = require('../src/phenology');

test('slope and aspect from a 3×3 elevation grid (Horn)', () => {
  // North row first, west column first; 90 m spacing.
  assert.deepEqual(slopeAspect([110, 110, 110, 100, 100, 100, 90, 90, 90], 90), { slope: 6.3, aspect: 180 });
  assert.deepEqual(slopeAspect([110, 100, 90, 110, 100, 90, 110, 100, 90], 90), { slope: 6.3, aspect: 90 });
  assert.deepEqual(slopeAspect([100, 100, 100, 100, 100, 100, 100, 100, 100], 90), { slope: 0, aspect: null });
  assert.equal(aspectLabel(180, 6.3), 'Südhang');
  assert.equal(aspectLabel(315, 10), 'Nordwesthang');
  assert.equal(aspectLabel(180, 1), 'eben');
});

test('south slopes colour a little later, north slopes earlier, scaled by steepness', () => {
  assert.equal(aspectShift(180, 25), 4);
  assert.equal(aspectShift(0, 25), -4);
  assert.equal(aspectShift(180, 10), 2);
  assert.equal(aspectShift(90, 30), 0, 'east and west are neutral');
  assert.equal(aspectShift(180, 2), 0, 'flat ground');
  assert.equal(terrainShift({ elevation: 1000, aspect: 0, slope: 30 }), -19);
});

test('exposition enters the early-colouring rule and the drought text', () => {
  const change = { summary: [{ class: 'verfaerbung', area: 0.1 }] };
  const beech = [tree('Rotbuche')];
  // Rotbuche, lowland ~30 Sept. On a steep north slope it starts ~26 Sept: 27 Sept is on time.
  const sept27 = Date.UTC(2026, 8, 27);
  assert.ok(assess({ takenAt: sept27, change, species: beech }).some((i) => i.type === 'fruehe_verfaerbung'));
  assert.ok(!assess({ takenAt: sept27, change, species: beech, aspect: 0, slope: 25 }).some((i) => i.type === 'fruehe_verfaerbung'));
  const south = assess({ takenAt: Date.UTC(2026, 7, 20), change, species: beech, weather: drought, elevation: 1000, aspect: 190, slope: 22 });
  assert.match(south.find((i) => i.type === 'fruehe_verfaerbung').text, /auf 1000 m ü\. M\. am Südhang \(11 Tage früher als im Flachland\)/);
  assert.match(south.find((i) => i.type === 'trockenheit').text, /Südhang \(22° steil\) trocknet/);
});

const { landform, coldPoolShift } = require('../src/phenology');

test('landform from the topographic position index', () => {
  assert.equal(landform({ tpi300: -12, tpi600: -30, slope: 3 }), 'senke');
  assert.equal(landform({ tpi300: -12, tpi600: -30, slope: 20 }), 'hang', 'a steep slope drains cold air');
  assert.equal(landform({ tpi300: 9, tpi600: 25, slope: 4 }), 'kuppe');
  assert.equal(landform({ tpi300: 0, tpi600: -2, slope: 2 }), 'ebene');
  assert.equal(landform({}), null);
  assert.equal(coldPoolShift('senke', -40), -5);
  assert.equal(coldPoolShift('senke', -15), -2, 'shallow hollow');
  assert.equal(coldPoolShift('senke', null), -4, 'hand-set hollow');
  assert.equal(coldPoolShift('hang', -40), 0);
});

test('hollows: earlier colouring, late frost after leaf-out; ridges: exposed to wind', () => {
  const normal = { precip: 250, precipNormal: 260, precipRatio: 0.96, tempAnomaly: 0, hotDays: 0, hotDaysNormal: 0, longestDrySpell: 5 };
  const spring = { last90: normal, yearToDate: { ...normal, coldNightsAfterLeafOut: 3, coldestAfterLeafOut: { date: '2026-05-04', tmin: 0.8 } } };
  const browned = { summary: [{ class: 'verfaerbung', area: 0.08 }] };
  const beech = [tree('Rotbuche')];
  const frost = assess({ takenAt: Date.UTC(2026, 4, 20), change: browned, weather: spring, species: beech, landform: 'senke', tpi600: -40 })
    .find((i) => i.type === 'spaetfrost');
  assert.equal(frost.severity, 'auffällig');
  assert.equal(frost.suggestedTag, 'frostschaden');
  const all = assess({ takenAt: Date.UTC(2026, 4, 20), change: browned, weather: spring, species: beech, landform: 'senke', tpi600: -40 });
  assert.ok(!all.some((i) => i.type === 'fruehe_verfaerbung'), 'frost damage is not reported as early autumn colouring');
  assert.match(frost.text, /3 Nächte unter 3 °C \(kälteste: 0\.8 °C am 04\.05\.2026\)/);
  assert.match(frost.text, /Rotbuche/);
  assert.equal(assess({ takenAt: Date.UTC(2026, 4, 20), weather: spring, landform: 'senke' })[0].severity, 'hinweis');
  assert.ok(!assess({ takenAt: Date.UTC(2026, 4, 20), weather: spring, landform: 'hang' }).some((i) => i.type === 'spaetfrost'));

  // Beech in a pronounced hollow starts colouring ~5 days earlier: 26 Sept is on time there.
  const autumn = { summary: [{ class: 'verfaerbung', area: 0.1 }] };
  assert.ok(!assess({ takenAt: Date.UTC(2026, 8, 26), change: autumn, species: beech, landform: 'senke', tpi600: -40 })
    .some((i) => i.type === 'fruehe_verfaerbung'));
  const early = assess({ takenAt: Date.UTC(2026, 8, 1), change: autumn, species: beech, landform: 'senke', tpi600: -40 })
    .find((i) => i.type === 'fruehe_verfaerbung');
  assert.match(early.text, /in einer Senke mit Kaltluftsee \(5 Tage früher als im Flachland\)/);

  const storm = { summary: [{ class: 'windwurf', area: 0.06 }] };
  const ridge = assess({ takenAt: Date.UTC(2026, 1, 10), change: storm, species: [tree('Fichte')], landform: 'kuppe' });
  assert.match(ridge.find((i) => i.type === 'windexponiert').text, /Fichten/);
});

test('a single day: archive in the past, forecast soon, nothing far ahead', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const q = new URL(url).searchParams;
    const d = q.get('start_date');
    const time = Array.from({ length: 24 }, (_, h) => `${d}T${String(h).padStart(2, '0')}:00`);
    return new Response(JSON.stringify({
      timezone: 'Europe/Zurich',
      utc_offset_seconds: 7200,
      hourly: {
        time,
        precipitation: time.map((_, h) => (h >= 14 && h < 17 ? 2.5 : 0)),
        shortwave_radiation: time.map((_, h) => (h >= 6 && h <= 20 ? 400 : 0)),
        cloud_cover: time.map(() => 50),
        temperature_2m: time.map((_, h) => 10 + h / 2),
      },
    }));
  };
  const weather = createWeather({ db: new DatabaseSync(':memory:'), fetchImpl, now: () => Date.UTC(2026, 9, 7, 12) });
  const past = await weather.day(47.36, 8.58, '2026-07-12');
  assert.equal(past.source, 'archive');
  assert.match(urls[0], /archive-api\.open-meteo\.com.*hourly=precipitation,shortwave_radiation/);
  assert.equal(past.hourly[0].t, Date.UTC(2026, 6, 11, 22), 'local midnight CEST = 22:00 UTC the day before');
  assert.deepEqual(past.totals, { precip: 7.5, radiationKwh: 6, cloudMean: 50, tmin: 10, tmax: 21.5 });

  const soon = await weather.day(47.36, 8.58, '2026-10-12');
  assert.equal(soon.source, 'forecast');
  assert.match(urls[1], /api\.open-meteo\.com\/v1\/forecast/);
  assert.equal((await weather.day(47.36, 8.58, '2027-03-01')).source, null);
  await weather.day(47.36, 8.58, '2026-07-12');
  assert.equal(urls.length, 2, 'archive days are cached');
});
