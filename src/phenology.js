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

/** Expected start of colouring (day of year) for a lowland value at a given elevation. */
const expectedColourDoy = (lowlandDoy, elevation) => (lowlandDoy == null ? null : lowlandDoy + altitudeShift(elevation));

module.exports = { REFERENCE_ELEVATION, DAYS_PER_100M, altitudeShift, expectedColourDoy };
