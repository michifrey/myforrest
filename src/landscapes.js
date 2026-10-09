'use strict';

/**
 * Landscape profiles: what a spot shows decides which observations fit and
 * which satellite measure tells its story. A spot without a profile is forest
 * (`wald`), as all spots were before profiles existed.
 *
 *   wald       the forest: damage, regrowth, leaf colouring, NDVI/NDMI
 *   gletscher  glaciers: retreat of the tongue, lakes, debris, the ice share
 *              of late summer from the Sentinel-2 scene classification
 *
 * Tags are one vocabulary (src/tags.js); a profile lists the ones offered for
 * its spots. Tags shared by several profiles (paths, rockfall) are listed in each.
 */

const LANDSCAPES = {
  wald: {
    label: 'Wald',
    tags: ['sturmschaden', 'borkenkaefer', 'trockenschaden', 'totholz', 'holzschlag', 'verjuengung', 'fruehverfaerbung',
      'frostschaden', 'neophyt', 'wegschaden'],
  },
  gletscher: {
    label: 'Gletscher',
    tags: ['gletscherzunge', 'gletschersee', 'spalten', 'schuttbedeckung', 'toteis', 'felssturz', 'murgang',
      'pioniervegetation', 'wegschaden'],
  },
};
const DEFAULT_LANDSCAPE = 'wald';
// Profiles whose satellite story is snow and ice rather than green.
const ICE_LANDSCAPES = new Set(['gletscher']);

const isLandscape = (v) => Object.prototype.hasOwnProperty.call(LANDSCAPES, v);
/** The profile of a spot (null = not set = forest). */
const landscapeOf = (value) => (isLandscape(value) ? value : DEFAULT_LANDSCAPE);

module.exports = { LANDSCAPES, DEFAULT_LANDSCAPE, ICE_LANDSCAPES, isLandscape, landscapeOf };
