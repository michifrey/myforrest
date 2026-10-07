'use strict';

/*
 * Central European forest trees with the traits MyForrest reasons about:
 * conifer or broadleaf, whether it sheds its foliage, when autumn colouring
 * typically starts in the lowlands (day of year, approximate; later at
 * altitude), drought sensitivity and the main threats to look out for.
 * Phenology values are rounded from long-term observation networks
 * (e.g. MeteoSchweiz, DWD) and only meant as a reference point.
 */

const TREES = [
  // Conifers
  { sci: 'Picea abies', de: 'Fichte', group: 'nadel', evergreen: true, drought: 'hoch', threats: ['Buchdrucker (Borkenkäfer)', 'Kupferstecher', 'Windwurf (flache Wurzeln)'] },
  { sci: 'Abies alba', de: 'Weisstanne', group: 'nadel', evergreen: true, drought: 'mittel', threats: ['Tannenborkenkäfer', 'Wildverbiss'] },
  { sci: 'Pinus sylvestris', de: 'Waldkiefer', group: 'nadel', evergreen: true, drought: 'gering', threats: ['Kiefernprachtkäfer nach Trockenheit', 'Diplodia-Triebsterben'] },
  { sci: 'Pinus nigra', de: 'Schwarzkiefer', group: 'nadel', evergreen: true, drought: 'gering', threats: ['Diplodia-Triebsterben'] },
  { sci: 'Larix decidua', de: 'Europäische Lärche', group: 'nadel', evergreen: false, colourDoy: 285, drought: 'mittel', threats: ['Lärchenborkenkäfer'] },
  { sci: 'Pseudotsuga menziesii', de: 'Douglasie', group: 'nadel', evergreen: true, drought: 'gering', threats: ['Rußige Douglasienschütte'] },
  { sci: 'Taxus baccata', de: 'Eibe', group: 'nadel', evergreen: true, drought: 'mittel', threats: [] },
  // Broadleaves
  { sci: 'Fagus sylvatica', de: 'Rotbuche', group: 'laub', evergreen: false, colourDoy: 272, drought: 'hoch', threats: ['Trockenschäden mit Kronenverlichtung', 'Buchenprachtkäfer', 'Sonnenbrand an der Rinde'] },
  { sci: 'Quercus robur', de: 'Stieleiche', group: 'laub', evergreen: false, colourDoy: 285, drought: 'mittel', threats: ['Eichenprozessionsspinner', 'Eichenprachtkäfer'] },
  { sci: 'Quercus petraea', de: 'Traubeneiche', group: 'laub', evergreen: false, colourDoy: 285, drought: 'gering', threats: ['Eichenprozessionsspinner'] },
  { sci: 'Acer pseudoplatanus', de: 'Bergahorn', group: 'laub', evergreen: false, colourDoy: 266, drought: 'mittel', threats: ['Rußrindenkrankheit nach Hitze'] },
  { sci: 'Acer platanoides', de: 'Spitzahorn', group: 'laub', evergreen: false, colourDoy: 275, drought: 'mittel', threats: [] },
  { sci: 'Acer campestre', de: 'Feldahorn', group: 'laub', evergreen: false, colourDoy: 278, drought: 'gering', threats: [] },
  { sci: 'Fraxinus excelsior', de: 'Gemeine Esche', group: 'laub', evergreen: false, colourDoy: 280, drought: 'mittel', threats: ['Eschentriebsterben (Pilz)'] },
  { sci: 'Carpinus betulus', de: 'Hainbuche', group: 'laub', evergreen: false, colourDoy: 278, drought: 'mittel', threats: [] },
  { sci: 'Betula pendula', de: 'Hängebirke', group: 'laub', evergreen: false, colourDoy: 258, drought: 'mittel', threats: [] },
  { sci: 'Tilia cordata', de: 'Winterlinde', group: 'laub', evergreen: false, colourDoy: 268, drought: 'mittel', threats: [] },
  { sci: 'Tilia platyphyllos', de: 'Sommerlinde', group: 'laub', evergreen: false, colourDoy: 266, drought: 'mittel', threats: [] },
  { sci: 'Prunus avium', de: 'Vogelkirsche', group: 'laub', evergreen: false, colourDoy: 262, drought: 'mittel', threats: [] },
  { sci: 'Sorbus aucuparia', de: 'Vogelbeere', group: 'laub', evergreen: false, colourDoy: 262, drought: 'mittel', threats: [] },
  { sci: 'Sorbus torminalis', de: 'Elsbeere', group: 'laub', evergreen: false, colourDoy: 280, drought: 'gering', threats: [] },
  { sci: 'Alnus glutinosa', de: 'Schwarzerle', group: 'laub', evergreen: false, colourDoy: 295, drought: 'hoch', threats: ['Erlen-Phytophthora'] },
  { sci: 'Populus tremula', de: 'Zitterpappel', group: 'laub', evergreen: false, colourDoy: 270, drought: 'mittel', threats: [] },
  { sci: 'Salix caprea', de: 'Salweide', group: 'laub', evergreen: false, colourDoy: 280, drought: 'mittel', threats: [] },
  { sci: 'Ulmus glabra', de: 'Bergulme', group: 'laub', evergreen: false, colourDoy: 275, drought: 'mittel', threats: ['Ulmensterben (Pilz)'] },
  { sci: 'Castanea sativa', de: 'Edelkastanie', group: 'laub', evergreen: false, colourDoy: 285, drought: 'gering', threats: ['Kastanienrindenkrebs', 'Esskastanien-Gallwespe'] },
  { sci: 'Aesculus hippocastanum', de: 'Rosskastanie', group: 'laub', evergreen: false, colourDoy: 265, drought: 'mittel', threats: ['Rosskastanien-Miniermotte (frühe Braunfärbung)'] },
  { sci: 'Juglans regia', de: 'Walnuss', group: 'laub', evergreen: false, colourDoy: 280, drought: 'mittel', threats: [] },
  // Invasive trees (also on the neophyte list)
  { sci: 'Robinia pseudoacacia', de: 'Robinie', group: 'laub', evergreen: false, colourDoy: 285, drought: 'gering', threats: [], invasive: true },
  { sci: 'Ailanthus altissima', de: 'Götterbaum', group: 'laub', evergreen: false, colourDoy: 280, drought: 'gering', threats: [], invasive: true },
  { sci: 'Prunus serotina', de: 'Spätblühende Traubenkirsche', group: 'laub', evergreen: false, colourDoy: 275, drought: 'gering', threats: [], invasive: true },
];

const norm = (s) => String(s || '').toLowerCase().replace(/\s+[x×]\s*/g, ' ×').replace(/\s+/g, ' ').trim();
const bySpecies = new Map(TREES.map((t) => [norm(t.sci), t]));

/** Tree info for a scientific name (authors and subspecies tolerated), or null. */
function treeInfo(scientificName) {
  const binomial = norm(scientificName).split(' ').slice(0, 2).join(' ');
  return bySpecies.get(binomial) || null;
}

/** Public shape used by the API and the frontend. */
const treeJson = (t) => ({
  scientificName: t.sci,
  name: t.de,
  group: t.group,
  evergreen: t.evergreen,
  colourDoy: t.colourDoy ?? null,
  drought: t.drought,
  threats: t.threats,
  invasive: Boolean(t.invasive),
});

module.exports = { TREES, treeInfo, treeJson };
