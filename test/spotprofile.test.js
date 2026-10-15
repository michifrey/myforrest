'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Profile = require('../public/spotprofile.js');

const buche = { name: 'Rotbuche', scientificName: 'Fagus sylvatica', group: 'laub', evergreen: false, colourDoy: 272, colourDoyHere: 268 };
const fichte = { name: 'Fichte', scientificName: 'Picea abies', group: 'nadel', evergreen: true };
const tanne = { name: 'Weisstanne', scientificName: 'Abies alba', group: 'nadel', evergreen: true };
const laerche = { name: 'Europäische Lärche', scientificName: 'Larix decidua', group: 'nadel', evergreen: false, colourDoy: 285 };
const robinie = { name: 'Robinie', scientificName: 'Robinia pseudoacacia', group: 'laub', evergreen: false, invasive: true };

test('tree kinds: spruce, fir, larch and broadleaf', () => {
  assert.equal(Profile.treeKind(fichte), 'fichte');
  assert.equal(Profile.treeKind(tanne), 'tanne');
  assert.equal(Profile.treeKind(laerche), 'laerche');
  assert.equal(Profile.treeKind(buche), 'laub');
});

test('conifers stay green, broadleaves follow the year', () => {
  for (const doy of [10, 120, 200, 300, 360]) assert.equal(Profile.season(fichte, doy, 600).label, 'immergrün');
  assert.equal(Profile.season(buche, 15, 600).label, 'kahl');
  assert.equal(Profile.season(buche, 200, 600).label, 'belaubt');
  assert.equal(Profile.season(buche, 345, 600).label, 'kahl');
});

test('colouring starts on the spot\'s own expected day', () => {
  assert.equal(Profile.season(buche, 267, 600).label, 'belaubt');
  assert.equal(Profile.season(buche, 270, 600).label, 'Herbstfärbung');
  assert.equal(Profile.season(buche, 285, 600).label, 'Laubfall');
  // Without a value for the spot, the lowland reference of the species counts.
  assert.equal(Profile.season({ ...buche, colourDoyHere: null }, 270, 600).label, 'belaubt');
  // The larch turns gold, then drops its needles.
  const gold = Profile.season(laerche, 292, 600);
  assert.equal(gold.label, 'Herbstfärbung');
  assert.ok(gold.rgb[0] > gold.rgb[2] * 1.5, 'golden, not green');
  assert.equal(Profile.season(laerche, 330, 600).label, 'kahl');
});

test('leaves come out later uphill, robinia late', () => {
  assert.ok(Profile.leafOutDoy(buche, 1200) > Profile.leafOutDoy(buche, 400) + 15);
  assert.equal(Profile.leafOutDoy(robinie, 400) - Profile.leafOutDoy(buche, 400), 12);
  const out = Profile.leafOutDoy(buche, 400);
  assert.equal(Profile.season(buche, out + 2, 400).label, 'Austrieb');
});

/** An hourly day as /api/weather/day returns it, from 00:00 UTC. */
const dayOf = (rows) => ({ source: 'archive', hourly: rows.map((r, h) => ({ t: Date.UTC(2026, 1, 10, h), precip: 0, cloud: 50, temp: 5, rain: 0, snowfall: 0, snowDepth: 0, ...r })) });
const at = (h) => Date.UTC(2026, 1, 10, h, 30);

test('weather at a moment: rain, snow, snow on the ground', () => {
  const rainy = dayOf(Array.from({ length: 24 }, () => ({ precip: 1.8, rain: 1.8, cloud: 100 })));
  assert.deepEqual(Profile.weatherAt(rainy, at(10)), { temp: 5, cloud: 100, rain: 1.8, snowfall: 0, snowDepth: 0, falling: 'regen', ice: null });

  const snowy = dayOf(Array.from({ length: 24 }, () => ({ temp: -2, precip: 0.5, snowfall: 0.35, snowDepth: 28 })));
  const w = Profile.weatherAt(snowy, at(9));
  assert.equal(w.falling, 'schnee');
  assert.equal(w.snowDepth, 28);
  assert.equal(w.ice, 'Schneeglätte');

  // Outside the day there is no weather to draw.
  assert.equal(Profile.weatherAt(snowy, Date.UTC(2026, 1, 12, 9)), null);
  assert.equal(Profile.weatherAt({ source: null, hourly: [] }, at(9)), null);
});

test('slippery: freezing rain, wet roads freezing over', () => {
  const freezing = dayOf(Array.from({ length: 24 }, () => ({ temp: -1, precip: 1, rain: 1 })));
  assert.equal(Profile.weatherAt(freezing, at(8)).ice, 'Glatteis');
  // Rain in the evening, frost at night: überfrierende Nässe.
  const rows = Array.from({ length: 24 }, (_, h) => (h < 18 ? { temp: 3, precip: h >= 15 ? 1 : 0, rain: h >= 15 ? 1 : 0 } : { temp: -0.5 }));
  assert.equal(Profile.weatherAt(dayOf(rows), at(20)).ice, 'überfrierende Nässe');
  assert.equal(Profile.weatherAt(dayOf(rows), at(12)).ice, null);
});

test('without separate rain and snowfall the temperature splits the precipitation', () => {
  const old = (temp) => ({ source: 'archive', hourly: Array.from({ length: 24 }, (_, h) => ({ t: Date.UTC(2026, 1, 10, h), precip: 1, cloud: 90, temp })) });
  assert.equal(Profile.weatherAt(old(-1), at(10)).falling, 'schnee');
  assert.equal(Profile.weatherAt(old(1.2), at(10)).falling, 'schneeregen');
  assert.equal(Profile.weatherAt(old(6), at(10)).falling, 'regen');
  assert.equal(Profile.weatherAt(old(6), at(10)).snowDepth, null, 'no snow depth is invented');
});
