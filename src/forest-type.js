'use strict';

/*
 * Forest type of a spot (Laubwald, Nadelwald, Mischwald) for the satellite
 * calibration: broadleaf and conifer canopies react differently in NDVI and
 * NDMI (deciduous crowns swing with the seasons, conifers stay green while
 * dying from bark beetles), so their thresholds are calibrated separately.
 *
 * Sources, the first one with data wins:
 *   1. arten     the tree species recorded at the spot (trees.js groups)
 *   2. fotos     the needle share the photos show (foliage.js, heuristic)
 *   3. satellit  how far NDVI falls in winter: deciduous canopies lose their
 *                leaves, evergreen conifers stay green
 */

const NEEDLE = 0.6; // conifer share from which a spot counts as Nadelwald
const BROADLEAF = 0.4; // up to which it counts as Laubwald; in between Mischwald
// Summer (Jun–Aug) minus winter (Dec–Feb) NDVI: deciduous forest ≈ 0.3–0.5, evergreen conifers ≈ 0.05–0.15.
const AMPLITUDE_BROADLEAF = 0.25;
const AMPLITUDE_NEEDLE = 0.12;
const MIN_SEASON_MONTHS = 3;

const TYPES = { laub: 'Laubwald', nadel: 'Nadelwald', misch: 'Mischwald' };

const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r2 = (v) => Math.round(v * 100) / 100;
const fromShare = (share) => (share >= NEEDLE ? 'nadel' : share <= BROADLEAF ? 'laub' : 'misch');

/** Summer minus winter NDVI of a monthly series, or null with too few months of either. */
function seasonalAmplitude(monthly) {
  const of = (months) => monthly.filter((m) => months.includes(Number(m.month.slice(5, 7))) && m.ndvi !== null && m.ndvi !== undefined).map((m) => m.ndvi);
  const summer = of([6, 7, 8]);
  const winter = of([12, 1, 2]);
  if (summer.length < MIN_SEASON_MONTHS || winter.length < MIN_SEASON_MONTHS) return null;
  return r2(median(summer) - median(winter));
}

/**
 * The forest type from `species` (trees.js entries recorded at the spot),
 * `needleShares` (per photo, 0–1) and the satellite `monthly` series:
 * { type: 'laub' | 'nadel' | 'misch' | null, label, source, needleShare?, amplitude? }.
 */
function forestType({ species = [], needleShares = [], monthly = [] } = {}) {
  const trees = species.filter((t) => t && (t.group === 'nadel' || t.group === 'laub'));
  if (trees.length) {
    const share = r2(trees.filter((t) => t.group === 'nadel').length / trees.length);
    const type = fromShare(share);
    return { type, label: TYPES[type], source: 'arten', needleShare: share, species: trees.length };
  }
  const shares = needleShares.filter((v) => typeof v === 'number');
  if (shares.length) {
    const share = r2(median(shares));
    const type = fromShare(share);
    return { type, label: TYPES[type], source: 'fotos', needleShare: share, photos: shares.length };
  }
  const amplitude = seasonalAmplitude(monthly);
  if (amplitude !== null) {
    const type = amplitude >= AMPLITUDE_BROADLEAF ? 'laub' : amplitude <= AMPLITUDE_NEEDLE ? 'nadel' : 'misch';
    return { type, label: TYPES[type], source: 'satellit', amplitude };
  }
  return { type: null, label: null, source: null };
}

module.exports = { forestType, seasonalAmplitude, TYPES };
