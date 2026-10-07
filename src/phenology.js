'use strict';

/*
 * Altitude correction for the start of autumn colouring. The species values
 * in trees.js describe the lowlands (~400 m); higher up it gets cool earlier
 * and leaves colour earlier: roughly 2–3 days per 100 m of altitude in
 * Central European observation series. Lower than the reference, colouring
 * is only slightly later (capped).
 */

const REFERENCE_ELEVATION = 400; // m a.s.l. – "Flachland"
const DAYS_PER_100M = 2.5;
const MAX_EARLIER = 35;
const MAX_LATER = 7;

/** Days the colouring starts later (+) or earlier (−) than in the lowlands. */
function altitudeShift(elevation) {
  if (!Number.isFinite(elevation)) return 0;
  const shift = -((elevation - REFERENCE_ELEVATION) / 100) * DAYS_PER_100M;
  return Math.round(Math.max(-MAX_EARLIER, Math.min(MAX_LATER, shift))) + 0; // + 0 turns -0 into 0
}

/*
 * Exposure: a steep south-facing slope gets far more sun and stays warmer
 * into autumn, so leaves colour a few days later; a north-facing slope is
 * cooler and colours earlier. Scaled by steepness (full effect from 20°),
 * none on flat ground. A coarse rule of thumb, deliberately small.
 */
const MAX_ASPECT_DAYS = 4;
const FULL_EFFECT_SLOPE = 20;

function aspectShift(aspect, slope) {
  if (!Number.isFinite(aspect) || !Number.isFinite(slope) || slope < 3) return 0;
  const steep = Math.min(1, slope / FULL_EFFECT_SLOPE);
  // cos(0°) = north → earlier (negative); cos(180°) = south → later.
  return Math.round(-Math.cos((aspect * Math.PI) / 180) * MAX_ASPECT_DAYS * steep) + 0;
}

const COMPASS = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];
const COMPASS_DE = ['Nordhang', 'Nordosthang', 'Osthang', 'Südosthang', 'Südhang', 'Südwesthang', 'Westhang', 'Nordwesthang'];
const compassIndex = (aspect) => Math.round(((aspect % 360) + 360) % 360 / 45) % 8;
const aspectLabel = (aspect, slope) => (!Number.isFinite(aspect) || slope < 3 ? 'eben' : COMPASS_DE[compassIndex(aspect)]);
const aspectFromCompass = (code) => (COMPASS.includes(code) ? COMPASS.indexOf(code) * 45 : null);
/** South-facing (SE–SW) and at least moderately steep: dries out faster. */
const sunnySlope = (aspect, slope) => Number.isFinite(aspect) && slope >= 10 && aspect >= 135 && aspect <= 225;

/*
 * Landform from the topographic position index. In hollows and valley
 * floors cold air drains in on clear nights and pools: nights there are
 * often several degrees colder than the slopes around, leaves colour earlier
 * (up to ~5 days here) and late frosts after leaf-out are more frequent.
 * Knolls and ridges stay out of the cold air but are exposed to wind.
 */
const LANDFORMS = {
  senke: 'Senke / Talboden (Kaltluftsee)',
  hang: 'Hanglage',
  kuppe: 'Kuppe / Rücken',
  ebene: 'Ebene',
};
const MAX_COLD_POOL_DAYS = 5;

function landform({ tpi300 = null, tpi600 = null, slope = null } = {}) {
  if (!Number.isFinite(tpi600) && !Number.isFinite(tpi300)) return null;
  const t600 = tpi600 ?? tpi300;
  const t300 = tpi300 ?? tpi600;
  if ((t600 <= -15 || t300 <= -8) && (slope ?? 0) < 12) return 'senke';
  if (t600 >= 15 || t300 >= 8) return 'kuppe';
  if ((slope ?? 0) >= 6) return 'hang';
  return 'ebene';
}

/** 0..1, how pronounced the cold-air pool is (a hand-set "senke" counts as clear). */
function coldPoolStrength(form, tpi600) {
  if (form !== 'senke') return 0;
  if (!Number.isFinite(tpi600)) return 0.7;
  return Math.max(0.3, Math.min(1, (-tpi600 - 5) / 35));
}

const coldPoolShift = (form, tpi600) => -Math.round(MAX_COLD_POOL_DAYS * coldPoolStrength(form, tpi600)) + 0;

/** Total shift of the colouring start for a spot's terrain. */
const terrainShift = ({ elevation = null, aspect = null, slope = null, landform: form = null, tpi600 = null } = {}) =>
  altitudeShift(elevation) + aspectShift(aspect, slope) + coldPoolShift(form, tpi600);

/** Shift for the spot's microsite only (exposure, cold air): added to regional reference series that already cover altitude. */
const microShift = ({ aspect = null, slope = null, landform: form = null, tpi600 = null } = {}) =>
  aspectShift(aspect, slope) + coldPoolShift(form, tpi600);

/** Expected start of colouring (day of year) for a lowland value on the given terrain. */
function expectedColourDoy(lowlandDoy, terrainOrElevation) {
  if (lowlandDoy == null) return null;
  const terrain = typeof terrainOrElevation === 'object' && terrainOrElevation !== null
    ? terrainOrElevation
    : { elevation: terrainOrElevation };
  return lowlandDoy + terrainShift(terrain);
}

module.exports = {
  REFERENCE_ELEVATION, DAYS_PER_100M, COMPASS,
  altitudeShift, aspectShift, terrainShift, expectedColourDoy, aspectLabel, aspectFromCompass, sunnySlope,
  LANDFORMS, landform, coldPoolStrength, coldPoolShift, microShift,
};
