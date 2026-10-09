'use strict';

/**
 * Landscape profiles: what a spot shows decides which observations fit and
 * which satellite measure tells its story. A spot without a profile is forest
 * (`wald`), as all spots were before profiles existed.
 *
 *   wald       the forest: damage, regrowth, leaf colouring, NDVI/NDMI
 *   gletscher  glaciers: retreat of the tongue, lakes, debris, the ice share
 *              of late summer from the Sentinel-2 scene classification
 *   gebirge    mountains above the forest: rockfall, debris flows, avalanches,
 *              shrubs on alpine pastures; NDVI and when the snow melts
 *   trocken    drylands, deserts: moving dunes, erosion, loss of plant cover;
 *              NDVI (chosen at upload or by hand, never guessed)
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
  gebirge: {
    label: 'Gebirge',
    tags: ['felssturz', 'murgang', 'lawine', 'rutschung', 'permafrost', 'verbuschung', 'neophyt', 'wegschaden'],
  },
  trocken: {
    label: 'Trockengebiet',
    tags: ['wanderduene', 'bodenerosion', 'vegetationsverlust', 'ueberweidung', 'versalzung', 'neophyt', 'wegschaden'],
  },
};
const DEFAULT_LANDSCAPE = 'wald';
// Profiles whose satellite scenes are read for the snow and ice share too (glaciers: what ice is left,
// mountains: when the snow melts).
const ICE_LANDSCAPES = new Set(['gletscher', 'gebirge']);
// Above this height (m a.s.l.) a spot without a profile and without signs of forest (tree species, forest
// observations) counts as a mountain spot: above most of the tree line in the Alps (1800–2300 m);
// GEBIRGE_AB_M changes it, 0 turns it off.
const MOUNTAIN_MIN_M = Number(process.env.GEBIRGE_AB_M ?? 2100);
// Observations that only the forest has: a spot with them stays forest.
const FOREST_ONLY_TAGS = LANDSCAPES.wald.tags.filter((t) => !Object.entries(LANDSCAPES).some(([k, l]) => k !== 'wald' && l.tags.includes(t)));

const isLandscape = (v) => Object.prototype.hasOwnProperty.call(LANDSCAPES, v);
/** The profile of a spot (null = not set = forest). */
const landscapeOf = (value) => (isLandscape(value) ? value : DEFAULT_LANDSCAPE);

module.exports = { LANDSCAPES, DEFAULT_LANDSCAPE, ICE_LANDSCAPES, MOUNTAIN_MIN_M, FOREST_ONLY_TAGS, isLandscape, landscapeOf };
