'use strict';

/**
 * Invasive non-native plants (Neophyten) commonly found in and around
 * Central European forests. Based on the Swiss "Schwarze Liste" (Info Flora)
 * and the German BfN list; extend as needed.
 */
const NEOPHYTES = {
  'Impatiens glandulifera': 'Drüsiges Springkraut',
  'Impatiens parviflora': 'Kleinblütiges Springkraut',
  'Reynoutria japonica': 'Japanischer Staudenknöterich',
  'Fallopia japonica': 'Japanischer Staudenknöterich',
  'Reynoutria sachalinensis': 'Sachalin-Staudenknöterich',
  'Reynoutria ×bohemica': 'Bastard-Staudenknöterich',
  'Solidago canadensis': 'Kanadische Goldrute',
  'Solidago gigantea': 'Spätblühende Goldrute',
  'Heracleum mantegazzianum': 'Riesen-Bärenklau',
  'Ailanthus altissima': 'Götterbaum',
  'Robinia pseudoacacia': 'Robinie',
  'Prunus serotina': 'Spätblühende Traubenkirsche',
  'Prunus laurocerasus': 'Kirschlorbeer',
  'Buddleja davidii': 'Sommerflieder',
  'Ambrosia artemisiifolia': 'Beifussblättrige Ambrosie',
  'Lysichiton americanus': 'Amerikanischer Riesenaronstab',
  'Rhus typhina': 'Essigbaum',
  'Erigeron annuus': 'Einjähriges Berufkraut',
  'Senecio inaequidens': 'Schmalblättriges Greiskraut',
  'Phytolacca americana': 'Amerikanische Kermesbeere',
  'Mahonia aquifolium': 'Gewöhnliche Mahonie',
  'Lonicera henryi': 'Henrys Geissblatt',
  'Parthenocissus quinquefolia': 'Fünfblättrige Jungfernrebe',
};

const normalize = (name) =>
  String(name || '').toLowerCase().replace(/\s+[x×]\s*/g, ' ×').replace(/\s+/g, ' ').trim();

const index = new Map(Object.entries(NEOPHYTES).map(([sci, de]) => [normalize(sci), de]));

/** German common name if the scientific name is a known neophyte, else null. */
function neophyteName(scientificName) {
  const n = normalize(scientificName);
  // Match on genus + species so names with subspecies/authors still hit.
  const binomial = n.split(' ').slice(0, 2).join(' ');
  return index.get(n) || index.get(binomial) || null;
}

module.exports = { NEOPHYTES, neophyteName };
