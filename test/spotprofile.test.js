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
